import { readFileSync, existsSync, unlinkSync, rmSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createProductionServicePlan } from "../production-service-plan.mjs";
import { runProductionPreflight, validateReleaseIdentity } from "../production-preflight.mjs";
import { loadAiPlatformConfig } from "../../ai-platform/src/config.js";
import { loadConfig } from "../../backend/src/config.js";
import { createProviderCredentials } from "../../ai-platform/src/providers/credentials.js";
import { normalizeDeploymentPolicy, registeredProviderPolicy } from "../../ai-platform/src/operations/deploymentPolicy.js";
import { sha256 } from "../../shared/aiPlatformContract.mjs";
import { socketFetch, PRODUCTION_AI_SOCKET } from "../../shared/aiPlatformSocketTransport.mjs";
import {
  PRODUCTION_ROOT, PROJECT_NODE, PLATFORM_SERVICE, PLATFORM_DATABASE, PLATFORM_USER,
  PLATFORM_ENV, BUSINESS_ENV, BUSINESS_DATABASE, PROTECTED_UNITS, WEIXIN_SESSION,
  hashBytes, renderPlatformUnit, normalizeRolloutPhase, rolloutPhaseForManifest, transitionIdentityDigest,
  routingPhaseForRollout, compareRolloutPhase,
  AI_PREFLIGHT_CHECKS,
} from "./production-contract.mjs";
import { assertHost, privateFile, privateDirectory, writeExclusive, writeOnceOrVerify, replacePrivateJson, atomicReplace, inspectUnit, parseEnvironment, platformRequest, backupSqlite, runCommand } from "./production-io.mjs";
import { validateAiComponentManifest } from "./component-manifest.mjs";
import { validateReleaseArchiveBinding } from "../release-package.mjs";

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function jsonFile(path, digest) { return JSON.parse(privateFile(path, digest).content.toString("utf8")); }
function optionalJsonFile(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(privateFile(path).content.toString("utf8"));
}
function unitEnabled(unit) {
  try { return runCommand("/bin/systemctl", ["is-enabled", unit]).trim() === "enabled"; }
  catch { return false; }
}
export function platformUnitMatchesRelease(content, release) {
  try {
    const expected = renderPlatformUnit(
      readFileSync(join(release, "scripts/ai-platform/systemd/sentelligent-ai-platform.service.template"), "utf8"),
      release,
    );
    return content === expected;
  } catch {
    return false;
  }
}
function fileDigest(path, options = {}) {
  return existsSync(path) ? privateFile(path, null, options).sha256 : null;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
function memorySnapshot() {
  const output = runCommand("/usr/bin/free", ["-m"]);
  const line = output.split("\n").find((value) => /^Mem:\s+/u.test(value));
  const fields = line?.trim().split(/\s+/u) ?? [];
  return { totalMiB: Number(fields[1]), availableMiB: Number(fields[6] ?? fields[3]) };
}
function readHealth(url, fetcher = fetch) {
  return fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: "error" })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))
    .catch((error) => ({ status: 0, errorCode: error?.code ?? "HEALTH_REQUEST_FAILED" }));
}
function protectedSnapshot() {
  return {
    units: PROTECTED_UNITS.map((unit) => {
      const value = inspectUnit(unit);
      check(value.ActiveState === "active" && Number(value.MainPID) > 1, "PROTECTED_SERVICE_UNAVAILABLE");
      return { name: unit, pid: value.MainPID, executable: value.ExecStart };
    }),
    caddySha256: hashBytes(readFileSync("/etc/caddy/Caddyfile")),
  };
}
function assertCoreProof(proof, manifest, release, commit) {
  check(proof.schemaVersion === 2 && proof.status === "passed" && proof.summary?.total === 25
    && proof.summary.passed === 25 && proof.summary.failed === 0
    && proof.scope?.expectedCommit === commit && proof.scope.releasePath === release
    && proof.scope.databasePath === BUSINESS_DATABASE && proof.scope.hostname === manifest.hostname
    && proof.scope.machineIdSha256 === hashBytes(manifest.machineId)
    && Date.now() - Date.parse(proof.generatedAt) >= -30_000
    && Date.now() - Date.parse(proof.generatedAt) < 15 * 60_000, "CORE_PREFLIGHT_INVALID");
}

function verifyNewReleaseArchive(manifest) {
  const archive = privateFile(manifest.newArchive, manifest.newArchiveSha256);
  const releaseManifest = JSON.parse(
    readFileSync(join(manifest.newRelease, "release-manifest.json"), "utf8"),
  );
  const binding = validateReleaseArchiveBinding({
    archiveContent: archive.content,
    releaseDirectoryPath: manifest.newRelease,
    manifest: releaseManifest,
    enforcePosix: true,
  });
  check(binding.valid, "RELEASE_ARCHIVE_BINDING_INVALID");
  check(releaseManifest.source?.commit === manifest.newCommit, "RELEASE_ARCHIVE_COMMIT_INVALID");
  return binding;
}

export function validateCandidateConfiguration(manifest) {
  const platformRaw = privateFile(manifest.platformEnvCandidate, manifest.platformEnvSha256, { maxBytes: 128 * 1024 }).content.toString("utf8");
  const backendRaw = privateFile(manifest.backendEnvCandidate, manifest.backendEnvSha256, { maxBytes: 128 * 1024 }).content.toString("utf8");
  const platformEnv = parseEnv(platformRaw);
  const backendEnv = parseEnv(backendRaw);
  const platform = loadAiPlatformConfig({}, platformEnv);
  const backend = loadConfig({ ...backendEnv, envFile: manifest.backendEnvCandidate });
  check(platform.nodeEnv === "production" && backend.nodeEnv === "production", "PRODUCTION_MODE_REQUIRED");
  check(platform.host === "127.0.0.1" && platform.port === 18997 && platform.databasePath === PLATFORM_DATABASE
    && platform.mediaDirectory === "/var/lib/sentelligent-ai-platform/media", "PLATFORM_STATE_BINDING_INVALID");
  check(platform.authSecret === backend.aiPlatformAuthSecret && platform.authSecret.length >= 32
    && backend.aiPlatformBaseUrl === "http://127.0.0.1:18997"
    && backend.aiPlatformSocketPath === PRODUCTION_AI_SOCKET && platform.socketPath === PRODUCTION_AI_SOCKET, "PLATFORM_AUTH_BINDING_INVALID");
  for (const value of [platform.mediaEncryptionKey, platform.credentialEncryptionKey, platform.taskEncryptionKey]) {
    check(typeof value === "string" && Buffer.from(value, "base64url").length === 32
      && Buffer.from(value, "base64url").toString("base64url") === value, "PLATFORM_ENCRYPTION_KEY_INVALID");
  }
  check(new Set([platform.authSecret, platform.mediaEncryptionKey, platform.credentialEncryptionKey, platform.taskEncryptionKey, backend.authSessionSecret, backend.settingsEncryptionKey, backend.weixinAgentApiToken]).size === 7, "PLATFORM_KEY_ISOLATION_INVALID");
  check(backend.aiPlatformRoutingPolicy?.phase === manifest.phase, "ROUTING_PHASE_MISMATCH");
  const rolloutPhase = rolloutPhaseForManifest(manifest);
  check(routingPhaseForRollout(rolloutPhase) === manifest.phase, "ROLLOUT_PHASE_MISMATCH");
  if (rolloutPhase === "P1" || rolloutPhase === "P2") {
    check(platform.executionMode === "local-simulated" && platform.externalProvidersEnabled === false, "INITIAL_PLATFORM_MUST_BE_SIMULATED");
  } else {
    check(platform.executionMode === "external-provider" && platform.externalProvidersEnabled === true, "EXTERNAL_PLATFORM_REQUIRED");
  }
  check(backend.aiPlatformProactiveScheduleOwner === "backend" && platform.proactiveScheduleOwner === "backend", "PROACTIVE_OWNER_INVALID");
  check(backend.databaseUrl === BUSINESS_DATABASE && backend.weixinAgentSessionHome === WEIXIN_SESSION, "BUSINESS_STATE_BINDING_INVALID");
  check(platform.taskConcurrency === 1 && platform.taskOwnerConcurrency === 1, "INITIAL_CONCURRENCY_INVALID");
  if (manifest.phase !== "platform") check(!backend.proactiveAssistantAutoRun && !backend.proactiveNotificationAutoRun, "BACKGROUND_CANARY_MUST_BE_PAUSED");
  const policy = normalizeDeploymentPolicy(jsonFile(manifest.policyFile, manifest.policySha256), platform);
  check(policy.sourceCommit === manifest.newCommit, "POLICY_SOURCE_MISMATCH");
  return { platformRaw, backendRaw, platformEnv, backendEnv, platform, backend, policy };
}

export function createProductionHostAdapter(manifest, { proofPath, proofSha256 } = {}) {
  assertHost(manifest);
  const lockPath = PRODUCTION_ROOT + "/.ai-platform-transition.lock";
  const statePath = join(manifest.evidenceDir, "transition-state.json");
  const backendUnit = "/etc/systemd/system/sentelligent-backend.service";
  let state;
  let stateSha256;
  let lockContent;
  const manifestDigest = hashBytes(JSON.stringify(manifest));
  const transitionKey = transitionIdentityDigest(manifest);
  function loadState() {
    if (!state) {
      state = jsonFile(statePath);
      stateSha256 = privateFile(statePath).sha256;
      check(state.transitionIdentityDigest === transitionKey && state.transitionId === manifest.id, "TRANSITION_STATE_MISMATCH");
    }
    return state;
  }
  function writeState() {
    stateSha256 = replacePrivateJson(statePath, state, stateSha256);
  }
  function markState(patch) {
    loadState();
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    writeState();
  }
  function assertProtected() {
    if (state?.protected) check(JSON.stringify(protectedSnapshot()) === JSON.stringify(state.protected), "PROTECTED_STATE_CHANGED");
  }
  async function corePreflight(release, commit, prefix) {
    const backupPath = join(manifest.backupDir, prefix + "-business.sqlite");
    const snapshot = await backupSqlite(BUSINESS_DATABASE, backupPath);
    const servicePlanPath = join(manifest.evidenceDir, prefix + "-services.json");
    writeExclusive(servicePlanPath, JSON.stringify(createProductionServicePlan(), null, 2) + "\n");
    const proof = await runProductionPreflight({
      envFile: BUSINESS_ENV, databasePath: BUSINESS_DATABASE, backupPath,
      expectedBackupSha256: snapshot.sha256, expectedOrigins: ["https://82.156.210.199"],
      servicePlanPath, releaseManifestPath: join(release, "release-manifest.json"), expectedCommit: commit,
      expectedHostIdentity: { hostname: manifest.hostname, machineId: manifest.machineId },
    });
    const path = join(manifest.evidenceDir, prefix + "-core-preflight.json");
    const digest = writeExclusive(path, JSON.stringify(proof, null, 2) + "\n");
    assertCoreProof(proof, manifest, release, commit);
    return { path, sha256: digest };
  }
  async function invokeCore(release, commit, proof, suffix) {
    const backupDir = join(manifest.backupDir, suffix);
    const evidenceDir = join(manifest.evidenceDir, suffix);
    runCommand("/bin/bash", [
      join(manifest.newRelease, "scripts/production-cutover.sh"),
      "--new-release=" + release, "--expected-commit=" + commit,
      "--database=" + BUSINESS_DATABASE, "--backup-dir=" + backupDir, "--evidence-dir=" + evidenceDir,
      "--weixin-session-dir=" + WEIXIN_SESSION, "--preflight-report=" + proof.path,
      "--preflight-report-sha256=" + proof.sha256, "--node=" + PROJECT_NODE,
    ], { timeout: 10 * 60_000 });
  }
  function runBusiness(command, input = {}) {
    const account = runCommand("/usr/bin/getent", ["passwd", "sentzx"]).trim().split(":");
    check(account[0] === "sentzx" && Number(account[2]) > 0 && Number(account[3]) > 0, "BUSINESS_SERVICE_ACCOUNT_INVALID");
    return JSON.parse(runCommand(PROJECT_NODE, [
      join(manifest.newRelease, "scripts/ai-platform/reconcile-business-state.mjs"), command,
    ], { uid: Number(account[2]), gid: Number(account[3]), input: JSON.stringify(input), timeout: 30_000 }));
  }
  return {
    acquireLock() {
      privateDirectory(manifest.evidenceDir);
      privateDirectory(manifest.backupDir);
      if (existsSync(lockPath)) {
        const existing = JSON.parse(privateFile(lockPath).content.toString("utf8"));
        check(existing.id === manifest.id, "TRANSITION_LOCK_HELD");
        if (processExists(Number(existing.pid)) && Number(existing.pid) !== process.pid) throw Object.assign(new Error("transition lock is active"), { code: "TRANSITION_LOCK_HELD" });
        unlinkSync(lockPath);
      }
      lockContent = JSON.stringify({ id: manifest.id, pid: process.pid });
      writeExclusive(lockPath, lockContent);
    },
    releaseLock() {
      check(privateFile(lockPath).content.toString() === lockContent, "TRANSITION_LOCK_CHANGED");
      unlinkSync(lockPath);
    },
    inspect(_input, identity) {
      const release = identity === "new" ? manifest.newRelease : manifest.oldRelease;
      const commit = identity === "new" ? manifest.newCommit : manifest.oldCommit;
      check(realpathSync(PRODUCTION_ROOT + "/current") === release, "CURRENT_RELEASE_CHANGED");
      const releaseManifest = JSON.parse(readFileSync(join(release, "release-manifest.json"), "utf8"));
      const servicePlan = createProductionServicePlan();
      const result = validateReleaseIdentity({
        manifest: releaseManifest, manifestPath: join(release, "release-manifest.json"),
        releaseDirectoryPath: release, expectedCommit: commit, servicePlan,
      });
      check(result.valid, "RELEASE_IDENTITY_INVALID");
      assertProtected();
      return { release, commit };
    },
    verifyPreflight() {
      validateCandidateConfiguration(manifest);
      verifyNewReleaseArchive(manifest);
      const core = jsonFile(manifest.corePreflight, manifest.corePreflightSha256);
      assertCoreProof(core, manifest, manifest.oldRelease, manifest.oldCommit);
      check(Boolean(proofPath && proofSha256), "AI_PREFLIGHT_REQUIRED");
      const proof = jsonFile(proofPath, proofSha256);
      check(proof.status === "passed" && proof.manifestDigest === hashBytes(JSON.stringify(manifest))
        && Date.now() - Date.parse(proof.generatedAt) >= -30_000 && Date.now() - Date.parse(proof.generatedAt) < 15 * 60_000
        && Array.isArray(proof.checks) && proof.checks.length === AI_PREFLIGHT_CHECKS.length
        && JSON.stringify(proof.checks.map((item) => item.id)) === JSON.stringify(AI_PREFLIGHT_CHECKS)
        && proof.checks.every((item) => item.status === "passed"), "AI_PREFLIGHT_INVALID");
      runCommand("/bin/bash", [
        "-c", 'source "$1"; NEW_RELEASE="$2"; EXPECTED_COMMIT="$3"; NODE_BIN="$4"; assert_candidate_release_frozen; verify_release_manifest',
        "verify-release", join(manifest.newRelease, "scripts/production-cutover.sh"), manifest.newRelease, manifest.newCommit, PROJECT_NODE,
      ], { timeout: 120_000 });
    },
    captureState() {
      if (existsSync(statePath)) {
        loadState();
        assertProtected();
        return state;
      }
      const platformPreparationPath = join(manifest.evidenceDir, "platform-preparation-state.json");
      const platformPreparation = jsonFile(platformPreparationPath);
      check(platformPreparation.status === "prepared", "PLATFORM_NOT_PREPARED");
      const platformState = {
        adoptedExisting: Boolean(platformPreparation.adoptedExisting),
        previousPlatformActive: Boolean(platformPreparation.previousPlatformActive),
        previousPlatformEnabled: Boolean(platformPreparation.previousPlatformEnabled),
      };
      if (platformState.adoptedExisting) {
        privateFile(platformPreparation.platformUnitBackup, platformPreparation.platformUnitBackupSha256, { requirePrivate: false });
        privateFile(platformPreparation.platformEnvironmentBackup, platformPreparation.platformEnvironmentBackupSha256);
        Object.assign(platformState, {
          platformUnitBackup: platformPreparation.platformUnitBackup,
          platformUnitBackupSha256: platformPreparation.platformUnitBackupSha256,
          platformEnvironmentBackup: platformPreparation.platformEnvironmentBackup,
          platformEnvironmentBackupSha256: platformPreparation.platformEnvironmentBackupSha256,
        });
      }
      const env = privateFile(BUSINESS_ENV);
      const unit = privateFile(backendUnit, null, { requirePrivate: false });
      const envBackup = join(manifest.backupDir, "backend-before.env");
      const unitBackup = join(manifest.backupDir, "backend-before.service");
      writeOnceOrVerify(envBackup, env.content, { expectedSha: env.sha256 });
      writeOnceOrVerify(unitBackup, unit.content, { expectedSha: unit.sha256, requirePrivate: false });
      state = {
        schemaVersion: 1, transitionId: manifest.id, manifestDigest, transitionIdentityDigest: transitionKey, rolloutPhase: manifest.rolloutPhase,
        status: "captured", protected: protectedSnapshot(), backendEnvBackup: envBackup,
        backendEnvSha256: env.sha256, backendUnitBackup: unitBackup, backendUnitSha256: unit.sha256,
        platformPreparation: platformState,
        phaseHistory: [],
      };
      writeState();
      return state;
    },
    async drainPlatform() {
      const current = await platformRequest("/operations");
      if (current.paused && current.queue.running === 0 && current.queue.queued === 0) return current;
      const result = await platformRequest("/operations/drain", { method: "POST", body: { expectedGeneration: current.generation } });
      check(result.paused && result.queue.running === 0, "PLATFORM_DRAIN_INCOMPLETE");
      if (result.queue.queued !== 0) throw Object.assign(new Error("queued work must be classified before cutover"), { code: "PLATFORM_QUEUE_NOT_EMPTY" });
    },
    async backupPlatform() {
      const destination = join(manifest.backupDir, "platform-before.sqlite");
      let snapshot;
      if (existsSync(destination)) {
        const file = privateFile(destination);
        const db = new DatabaseSync(destination, { readOnly: true });
        try { check(db.prepare("PRAGMA quick_check").get().quick_check === "ok" && db.prepare("PRAGMA foreign_key_check").all().length === 0, "PLATFORM_BACKUP_INVALID"); }
        finally { db.close(); }
        snapshot = { path: destination, sha256: file.sha256 };
      } else snapshot = await backupSqlite(PLATFORM_DATABASE, destination);
      writeOnceOrVerify(join(manifest.evidenceDir, "platform-backup.json"), JSON.stringify(snapshot) + "\n");
      markState({ platformBackup: snapshot, status: "platform-backed-up" });
    },
    stageBackendConfig() {
      loadState();
      const candidate = privateFile(manifest.backendEnvCandidate, manifest.backendEnvSha256).content;
      atomicReplace(BUSINESS_ENV, candidate, state.backendEnvSha256);
      const oldUnit = privateFile(state.backendUnitBackup, state.backendUnitSha256).content.toString();
      const replacements = oldUnit.match(/^TimeoutStopSec=.*$/gmu) ?? [];
      check(replacements.length <= 1, "BACKEND_STOP_TIMEOUT_AMBIGUOUS");
      const unit = replacements.length ? oldUnit.replace(/^TimeoutStopSec=.*$/gmu, "TimeoutStopSec=210") : oldUnit.replace("[Service]", "[Service]\nTimeoutStopSec=210");
      atomicReplace(backendUnit, unit, state.backendUnitSha256, { requirePrivate: false });
      runCommand("/bin/systemctl", ["daemon-reload"]);
      markState({ backendStaged: true, status: "backend-staged" });
    },
    async resumePlatform() {
      const rolloutPhase = rolloutPhaseForManifest(manifest);
      if (["P1", "P2"].includes(rolloutPhase)) {
        const current = await platformRequest("/operations");
        check(current.paused && current.executor.admissionOpen === false, "PLATFORM_MUST_REMAIN_PAUSED");
        return current;
      }
      const current = await platformRequest("/operations");
      const result = current.paused
        ? await platformRequest("/operations/resume", { method: "POST", body: { expectedGeneration: current.generation } })
        : current;
      check(!result.paused && result.executor.admissionOpen, "PLATFORM_RESUME_FAILED");
      const health = await socketFetch(PRODUCTION_AI_SOCKET)("http://127.0.0.1:18997/readyz", { signal: AbortSignal.timeout(5000) });
      check(health.status === 200, "PLATFORM_NOT_READY");
      await health.body?.cancel?.();
    },
    cutoverCore() {
      const result = invokeCore(manifest.newRelease, manifest.newCommit, { path: manifest.corePreflight, sha256: manifest.corePreflightSha256 }, "core-cutover");
      markState({ coreCutover: true, status: "core-cut-over" });
      return result;
    },
    reconcileProactiveEvents() {
      const preview = runBusiness("events-preview");
      writeOnceOrVerify(join(manifest.evidenceDir, "proactive-reconciliation-preview.json"), JSON.stringify(preview) + "\n");
      const result = runBusiness("events-apply", { expectedDigest: preview.digest, transitionId: manifest.id });
      writeOnceOrVerify(join(manifest.evidenceDir, "proactive-reconciliation.json"), JSON.stringify(result) + "\n");
      markState({ proactiveReconciled: true });
    },
    async verifyPostflight() {
      await corePreflight(manifest.newRelease, manifest.newCommit, "postflight");
      const unit = inspectUnit(PLATFORM_SERVICE);
      check(unit.ActiveState === "active" && unit.User === PLATFORM_USER && unit.WorkingDirectory === manifest.newRelease, "PLATFORM_UNIT_IDENTITY_INVALID");
      const response = await fetch("http://127.0.0.1:8897/api/health", { signal: AbortSignal.timeout(10000) });
      const health = await response.json();
      check(response.status === 200 && health.database === "ready"
        && (manifest.phase === "legacy" || health.aiPlatform?.ready === true), "BUSINESS_POSTFLIGHT_FAILED");
      assertProtected();
      markState({ status: "cutover-passed", currentRelease: manifest.newRelease });
    },
    reconcileCredentials() {
      const env = parseEnvironment(PLATFORM_ENV);
      const config = loadAiPlatformConfig({}, env);
      const db = new DatabaseSync(PLATFORM_DATABASE, { readOnly: true });
      try {
        const vault = createProviderCredentials({ db, encryptionKey: config.credentialEncryptionKey, policies: config.providerPolicies, env });
        const changes = [];
        for (const [providerId, setting] of [["provider-deepseek", "deepseek_api_key"], ["provider-asr", "asr_api_key"]]) {
          const provider = config.providerPolicies.find((item) => item.id === providerId);
          if (!provider) continue;
          const metadata = vault.metadata(provider.credentialEnv);
          if (!["active", "cleared"].includes(metadata.status)) continue;
          changes.push({ setting, status: metadata.status, revision: metadata.revision, ...(metadata.status === "active" ? { value: vault.resolve(provider.credentialEnv) } : {}) });
        }
        const legacy = parseEnv(privateFile(loadState().backendEnvBackup).content.toString());
        const result = runBusiness("credentials", { encryptionKey: legacy.SETTINGS_ENCRYPTION_KEY, transitionId: manifest.id, changes });
        writeOnceOrVerify(join(manifest.evidenceDir, "rollback-credential-reconciliation.json"), JSON.stringify(result) + "\n");
        markState({ credentialsReconciled: true });
      } finally { db.close(); }
    },
    restoreBackendConfig() {
      loadState();
      const current = privateFile(BUSINESS_ENV);
      if (current.sha256 !== state.backendEnvSha256) {
        atomicReplace(BUSINESS_ENV, privateFile(state.backendEnvBackup, state.backendEnvSha256).content, current.sha256);
      }
      markState({ status: "backend-restored" });
    },
    async rollbackCore() {
      loadState();
      const current = realpathSync(PRODUCTION_ROOT + "/current");
      check([manifest.oldRelease, manifest.newRelease].includes(current), "ROLLBACK_CURRENT_UNKNOWN");
      if (current === manifest.newRelease) {
        const proof = await corePreflight(manifest.newRelease, manifest.newCommit, "rollback");
        await invokeCore(manifest.oldRelease, manifest.oldCommit, proof, "core-rollback");
      }
      const currentUnit = privateFile(backendUnit, null, { requirePrivate: false });
      atomicReplace(backendUnit, privateFile(state.backendUnitBackup, state.backendUnitSha256).content, currentUnit.sha256, { requirePrivate: false });
      runCommand("/bin/systemctl", ["daemon-reload"]);
      runCommand("/bin/systemctl", ["restart", "sentelligent-backend.service"], { timeout: 240_000 });
      markState({ currentRelease: manifest.oldRelease, status: "core-rolled-back" });
    },
    rollbackPlatform() {
      loadState();
      const unitPath = "/etc/systemd/system/" + PLATFORM_SERVICE;
      const platformState = state.platformPreparation;
      if (platformState?.adoptedExisting) {
        runCommand("/bin/systemctl", ["stop", PLATFORM_SERVICE], { timeout: 240_000 });
        const currentEnvironment = privateFile(PLATFORM_ENV);
        if (currentEnvironment.sha256 !== platformState.platformEnvironmentBackupSha256) {
          const backup = privateFile(platformState.platformEnvironmentBackup, platformState.platformEnvironmentBackupSha256);
          atomicReplace(PLATFORM_ENV, backup.content, currentEnvironment.sha256);
        }
        const currentUnit = privateFile(unitPath, null, { requirePrivate: false });
        if (currentUnit.sha256 !== platformState.platformUnitBackupSha256) {
          const backup = privateFile(platformState.platformUnitBackup, platformState.platformUnitBackupSha256, { requirePrivate: false });
          atomicReplace(unitPath, backup.content, currentUnit.sha256, { requirePrivate: false });
        }
        runCommand("/bin/systemctl", ["daemon-reload"]);
        if (platformState.previousPlatformEnabled) runCommand("/bin/systemctl", ["enable", PLATFORM_SERVICE]);
        else runCommand("/bin/systemctl", ["disable", PLATFORM_SERVICE]);
        if (platformState.previousPlatformActive) runCommand("/bin/systemctl", ["start", PLATFORM_SERVICE], { timeout: 90_000 });
      } else if (existsSync(unitPath)) {
        runCommand("/bin/systemctl", ["stop", PLATFORM_SERVICE], { timeout: 240_000 });
        runCommand("/bin/systemctl", ["disable", PLATFORM_SERVICE]);
      }
      markState({ status: "platform-rolled-back", platformAdmission: "closed" });
    },
    verifyRollbackState() {
      loadState();
      check(["captured", "platform-backed-up", "backend-staged", "core-cut-over", "cutover-passed", "phase-set", "backend-restored", "core-rolled-back", "platform-rolled-back"].includes(state.status), "ROLLBACK_STATE_INVALID");
      privateFile(state.backendEnvBackup, state.backendEnvSha256);
      privateFile(state.backendUnitBackup, state.backendUnitSha256, { requirePrivate: false });
      check([manifest.oldRelease, manifest.newRelease].includes(realpathSync(PRODUCTION_ROOT + "/current")), "ROLLBACK_CURRENT_UNKNOWN");
      assertProtected();
      return state;
    },
    async verifyRollback() {
      loadState();
      check(realpathSync(PRODUCTION_ROOT + "/current") === manifest.oldRelease, "ROLLBACK_RELEASE_INVALID");
      const unit = inspectUnit("sentelligent-backend.service");
      check(unit.ActiveState === "active" && unit.ExecStart.includes(manifest.oldRelease), "ROLLBACK_BACKEND_INVALID");
      const platformState = state.platformPreparation;
      if (platformState?.adoptedExisting) {
        const platform = inspectUnit(PLATFORM_SERVICE);
        if (platformState.previousPlatformActive) check(platform.ActiveState === "active", "ROLLBACK_PLATFORM_NOT_ACTIVE");
        else check(platform.ActiveState !== "active", "ROLLBACK_PLATFORM_STILL_ACTIVE");
        check(platformUnitMatchesRelease(privateFile("/etc/systemd/system/" + PLATFORM_SERVICE, null, { requirePrivate: false }).content.toString(), manifest.oldRelease), "ROLLBACK_PLATFORM_UNIT_INVALID");
        check(privateFile(PLATFORM_ENV).sha256 === platformState.platformEnvironmentBackupSha256, "ROLLBACK_PLATFORM_ENV_INVALID");
      } else if (existsSync("/etc/systemd/system/" + PLATFORM_SERVICE)) {
        const platform = inspectUnit(PLATFORM_SERVICE);
        check(platform.ActiveState !== "active", "ROLLBACK_PLATFORM_STILL_ACTIVE");
      }
      assertProtected();
      return { status: "passed", release: manifest.oldRelease };
    },
    async setPhase(_input, targetPhase) {
      const target = normalizeRolloutPhase(targetPhase);
      check(["P3", "P4", "P5", "P6"].includes(target), "PHASE_NOT_CHANGEABLE");
      check(manifest.rolloutPhase === target, "MANIFEST_PHASE_MISMATCH");
      check(routingPhaseForRollout(target) === manifest.phase, "ROUTING_PHASE_MISMATCH");
      loadState();
      check(compareRolloutPhase(target, state.rolloutPhase) >= 0, "PHASE_REGRESSION_REQUIRES_ROLLBACK");
      check(realpathSync(PRODUCTION_ROOT + "/current") === manifest.newRelease, "CURRENT_RELEASE_CHANGED");
      const candidate = validateCandidateConfiguration(manifest);
      const operations = await platformRequest("/operations");
      if (!operations.paused || operations.queue.running !== 0 || operations.queue.queued !== 0) await this.drainPlatform(manifest);
      const before = privateFile(BUSINESS_ENV);
      const backupPath = join(manifest.backupDir, `backend-before-${target}.env`);
      writeOnceOrVerify(backupPath, before.content, { expectedSha: before.sha256 });
      let policyApplied = false;
      try {
        atomicReplace(BUSINESS_ENV, candidate.backendRaw, before.sha256);
        runCommand("/bin/systemctl", ["daemon-reload"]);
        runCommand("/bin/systemctl", ["restart", "sentelligent-backend.service"], { timeout: 240_000 });
        const backend = await readHealth("http://127.0.0.1:8897/api/health");
        check(backend.status === 200 && backend.body?.database === "ready"
          && backend.body?.aiPlatform?.routing?.phase === candidate.backend.aiPlatformRoutingPolicy.phase, "PHASE_BACKEND_NOT_READY");
        const preview = await platformRequest("/operations/policy-preview", { method: "POST", body: { policy: candidate.policy } });
        check(preview.digest === sha256(candidate.policy), "PHASE_POLICY_DIGEST_INVALID");
        const applied = await platformRequest("/operations/policy", {
          method: "POST",
          body: { policy: candidate.policy, expectedDigest: preview.digest, expectedGeneration: (await platformRequest("/operations")).generation },
        });
        policyApplied = true;
        const resumed = await this.resumePlatform(manifest);
        const history = [...(state.phaseHistory ?? []), {
          phase: target, manifestDigest: hashBytes(JSON.stringify(manifest)), policyId: candidate.policy.id, policyDigest: applied.digest,
          backendEnvSha256: hashBytes(candidate.backendRaw), startedAt: new Date().toISOString(),
        }];
        markState({ rolloutPhase: target, status: "phase-set", phaseHistory: history, platformAdmission: resumed.paused ? "closed" : "open" });
        return { status: "passed", phase: target, routingPhase: manifest.phase, policy: applied, backendEnvSha256: hashBytes(candidate.backendRaw), policyApplied };
      } catch (error) {
        const current = privateFile(BUSINESS_ENV);
        if (current.sha256 !== before.sha256) {
          atomicReplace(BUSINESS_ENV, before.content, current.sha256);
          runCommand("/bin/systemctl", ["daemon-reload"]);
          runCommand("/bin/systemctl", ["restart", "sentelligent-backend.service"], { timeout: 240_000 });
        }
        if (policyApplied) error.code = error.code ?? "PHASE_POLICY_APPLIED_RECOVERY_REQUIRED";
        throw error;
      }
    },
    async observe(_input, { durationSeconds, sampleIntervalSeconds = 30 } = {}) {
      if (!state && existsSync(statePath)) loadState();
      const startedAt = new Date().toISOString();
      const deadline = Date.now() + durationSeconds * 1000;
      const samples = [];
      const failures = [];
      let consecutiveHealthFailures = 0;
      let lastQueueDepth = null;
      let queueGrowthSamples = 0;
      while (Date.now() <= deadline || samples.length === 0) {
        const at = new Date().toISOString();
        let operations;
        let aiHealth;
        let protectedState;
        try { operations = await platformRequest("/operations"); } catch (error) { operations = { errorCode: error?.code ?? "OPERATIONS_UNAVAILABLE" }; }
        try {
          const response = await socketFetch(PRODUCTION_AI_SOCKET)("http://127.0.0.1:18997/healthz", { signal: AbortSignal.timeout(10_000) });
          aiHealth = { status: response.status, body: await response.json().catch(() => null) };
        } catch (error) { aiHealth = { status: 0, errorCode: error?.code ?? "PLATFORM_HEALTH_UNAVAILABLE" }; }
        const backend = await readHealth("http://127.0.0.1:8897/api/health");
        try { protectedState = protectedSnapshot(); } catch (error) { protectedState = { errorCode: error?.code ?? "PROTECTED_STATE_UNAVAILABLE" }; }
        let memory;
        try { memory = memorySnapshot(); } catch (error) { memory = { errorCode: error?.code ?? "MEMORY_UNAVAILABLE" }; }
        const sample = { at, operations, aiHealth, backend, protected: protectedState, memory };
        samples.push(sample);
        const healthy = aiHealth.status === 200 && backend.status === 200 && backend.body?.database === "ready"
          && operations?.errorCode === undefined && protectedState?.errorCode === undefined;
        consecutiveHealthFailures = healthy ? 0 : consecutiveHealthFailures + 1;
        if (!healthy) failures.push({ at, code: "HEALTH_THRESHOLD_SAMPLE_FAILED" });
        const depth = Number(operations?.queue?.depth);
        if (Number.isSafeInteger(depth) && lastQueueDepth !== null && depth > lastQueueDepth) queueGrowthSamples += 1;
        else if (Number.isSafeInteger(depth)) queueGrowthSamples = 0;
        if (Number.isSafeInteger(depth)) lastQueueDepth = depth;
        if (JSON.stringify(protectedState) !== JSON.stringify(state?.protected ?? protectedState)) failures.push({ at, code: "PROTECTED_STATE_CHANGED" });
        if (Number.isFinite(memory.availableMiB) && memory.availableMiB < 1024) failures.push({ at, code: "AVAILABLE_MEMORY_LOW" });
        if (consecutiveHealthFailures >= 3 || queueGrowthSamples >= 10 || failures.some((item) => ["PROTECTED_STATE_CHANGED", "AVAILABLE_MEMORY_LOW"].includes(item.code))) break;
        if (Date.now() >= deadline) break;
        await sleep(Math.min(sampleIntervalSeconds * 1000, Math.max(50, deadline - Date.now())));
      }
      const thresholdFailures = failures.filter((item, index, list) => index === list.findIndex((other) => other.code === item.code));
      return {
        schemaVersion: 1, status: thresholdFailures.length ? "failed" : "passed", startedAt,
        finishedAt: new Date().toISOString(), durationSeconds, sampleCount: samples.length,
        thresholdFailures, samples,
      };
    },
  };
}

export function platformDatabaseIsEmpty(path) {
  if (!existsSync(path)) return true;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    for (const table of ["tasks", "task_attempts", "usage_ledger", "budget_reservations", "result_deliveries"]) {
      if (db.prepare(`SELECT count(*) n FROM ${table}`).get().n !== 0) return false;
    }
    return db.prepare("PRAGMA quick_check").get().quick_check === "ok"
      && db.prepare("PRAGMA foreign_key_check").all().length === 0;
  } finally { db.close(); }
}

function platformDataDirectoryIsSafe(path, account) {
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  return info.isDirectory() && !info.isSymbolicLink() && realpathSync(path) === path
    && info.uid === Number(account.uid) && info.gid === Number(account.gid) && (info.mode & 0o077) === 0;
}

export async function preparePlatformService(manifest) {
  assertHost(manifest);
  const candidate = validateCandidateConfiguration(manifest);
  privateDirectory(manifest.evidenceDir); privateDirectory(manifest.backupDir);
  verifyNewReleaseArchive(manifest);
  runCommand("/bin/bash", [
    "-c", 'source "$1"; NEW_RELEASE="$2"; EXPECTED_COMMIT="$3"; NODE_BIN="$4"; assert_candidate_release_frozen; verify_release_manifest',
    "verify-release", join(manifest.newRelease, "scripts/production-cutover.sh"), manifest.newRelease, manifest.newCommit, PROJECT_NODE,
  ], { timeout: 120_000 });
  check(realpathSync(PRODUCTION_ROOT + "/current") === manifest.oldRelease, "CURRENT_RELEASE_CHANGED");

  const unitPath = "/etc/systemd/system/" + PLATFORM_SERVICE;
  const dataDirectory = "/var/lib/sentelligent-ai-platform";
  const preparationStatePath = join(manifest.evidenceDir, "platform-preparation-state.json");
  const manifestDigest = hashBytes(JSON.stringify(manifest));
  const template = readFileSync(join(manifest.newRelease, "scripts/ai-platform/systemd/sentelligent-ai-platform.service.template"), "utf8");
  const unit = renderPlatformUnit(template, manifest.newRelease);
  const unitDigest = hashBytes(unit);
  let accountLine;
  try { accountLine = runCommand("/usr/bin/getent", ["passwd", PLATFORM_USER]).trim(); } catch { accountLine = ""; }
  let account = null;
  if (accountLine) {
    const fields = accountLine.split(":");
    account = { uid: Number(fields[2]), gid: Number(fields[3]) };
  }
  const platformUnitBackup = join(manifest.evidenceDir, "platform-before.service");
  const platformEnvironmentBackup = join(manifest.evidenceDir, "platform-before.env");
  const existingPlatformPaths = [unitPath, PLATFORM_ENV, PLATFORM_DATABASE, dataDirectory].filter((path) => existsSync(path));
  const hasExistingPlatformState = existingPlatformPaths.length > 0 || Boolean(account);
  let existingPlatformUnit = null;
  let existingPlatformEnvironment = null;
  let previousPlatformActive = false;
  let previousPlatformEnabled = false;
  if (hasExistingPlatformState) {
    check(account && existingPlatformPaths.length === 4, "PLATFORM_PARTIAL_STATE_UNOWNED");
    check(platformDataDirectoryIsSafe(dataDirectory, account), "PLATFORM_DATA_PERMISSIONS_INVALID");
    const database = lstatSync(PLATFORM_DATABASE);
    check(database.isFile() && !database.isSymbolicLink() && database.nlink === 1
      && database.uid === account.uid && database.gid === account.gid && (database.mode & 0o077) === 0,
    "PLATFORM_DATABASE_PERMISSIONS_INVALID");
    existingPlatformUnit = privateFile(unitPath, null, { requirePrivate: false });
    existingPlatformEnvironment = privateFile(PLATFORM_ENV);
    check(platformUnitMatchesRelease(existingPlatformUnit.content.toString(), manifest.oldRelease), "PLATFORM_UNIT_NOT_ADOPTABLE");
    const currentUnit = inspectUnit(PLATFORM_SERVICE);
    previousPlatformActive = currentUnit.ActiveState === "active";
    previousPlatformEnabled = unitEnabled(PLATFORM_SERVICE);
    if (previousPlatformActive) {
      const existingPlatformOperations = await platformRequest("/operations");
      check(existingPlatformOperations.paused && existingPlatformOperations.queue.running === 0
        && existingPlatformOperations.queue.queued === 0, "PLATFORM_MUST_BE_PAUSED_FOR_UPGRADE");
    }
  }
  let preparation = optionalJsonFile(preparationStatePath);
  let preparationSha = preparation ? privateFile(preparationStatePath).sha256 : null;
  if (preparation) {
    check(preparation.manifestDigest === manifestDigest && preparation.transitionId === manifest.id, "PLATFORM_PREPARATION_STATE_MISMATCH");
    if (preparation.status === "cleanup-complete") {
      preparation = {
        ...preparation, status: "preparing", createdUser: false, createdDataDirectory: false,
        createdEnvironment: false, createdUnit: false, platformServiceStopped: false,
        platformEnvironmentChanged: false, platformUnitChanged: false,
      };
      preparationSha = replacePrivateJson(preparationStatePath, preparation, preparationSha);
    }
  } else {
    preparation = {
      schemaVersion: 1, transitionId: manifest.id, manifestDigest, status: "preparing",
      createdUser: false, createdDataDirectory: false, createdEnvironment: false, createdUnit: false,
      unitSha256: unitDigest, environmentSha256: hashBytes(candidate.platformRaw), startedAt: new Date().toISOString(),
      adoptedExisting: hasExistingPlatformState,
      ...(hasExistingPlatformState ? {
        platformUnitBackup,
        platformUnitBackupSha256: existingPlatformUnit.sha256,
        platformEnvironmentBackup,
        platformEnvironmentBackupSha256: existingPlatformEnvironment.sha256,
        previousPlatformActive,
        previousPlatformEnabled,
      } : {}),
    };
    if (hasExistingPlatformState) {
      writeOnceOrVerify(platformUnitBackup, existingPlatformUnit.content, { expectedSha: existingPlatformUnit.sha256, requirePrivate: false });
      writeOnceOrVerify(platformEnvironmentBackup, existingPlatformEnvironment.content, { expectedSha: existingPlatformEnvironment.sha256 });
    }
    preparationSha = writeExclusive(preparationStatePath, JSON.stringify(preparation, null, 2) + "\n");
  }
  const persist = (patch) => {
    preparation = { ...preparation, ...patch, updatedAt: new Date().toISOString() };
    preparationSha = replacePrivateJson(preparationStatePath, preparation, preparationSha);
  };
  const before = protectedSnapshot();
  const cleanUp = () => {
    let incomplete = false;
    try {
      if (preparation.adoptedExisting && (preparation.platformServiceStopped
        || preparation.platformEnvironmentChanged || preparation.platformUnitChanged)) {
        try { runCommand("/bin/systemctl", ["stop", PLATFORM_SERVICE], { timeout: 30_000 }); } catch {}
        if (preparation.platformEnvironmentBackup && existsSync(preparation.platformEnvironmentBackup)) {
          const current = privateFile(PLATFORM_ENV);
          if (current.sha256 !== preparation.platformEnvironmentBackupSha256) {
            const backup = privateFile(preparation.platformEnvironmentBackup, preparation.platformEnvironmentBackupSha256);
            atomicReplace(PLATFORM_ENV, backup.content, current.sha256);
          }
        }
        if (preparation.platformUnitBackup && existsSync(preparation.platformUnitBackup)) {
          const current = privateFile(unitPath, null, { requirePrivate: false });
          if (current.sha256 !== preparation.platformUnitBackupSha256) {
            const backup = privateFile(preparation.platformUnitBackup, preparation.platformUnitBackupSha256, { requirePrivate: false });
            atomicReplace(unitPath, backup.content, current.sha256, { requirePrivate: false });
          }
        }
        runCommand("/bin/systemctl", ["daemon-reload"]);
        if (preparation.previousPlatformEnabled) runCommand("/bin/systemctl", ["enable", PLATFORM_SERVICE]);
        else try { runCommand("/bin/systemctl", ["disable", PLATFORM_SERVICE]); } catch {}
        if (preparation.previousPlatformActive) runCommand("/bin/systemctl", ["start", PLATFORM_SERVICE], { timeout: 90_000 });
        else try { runCommand("/bin/systemctl", ["stop", PLATFORM_SERVICE], { timeout: 30_000 }); } catch {}
      }
      if (preparation.createdUnit && existsSync(unitPath)) {
        const installed = privateFile(unitPath, null, { requirePrivate: false }).content.toString();
        check(installed === unit, "PREPARE_CLEANUP_UNIT_DRIFT");
        try { runCommand("/bin/systemctl", ["stop", PLATFORM_SERVICE], { timeout: 30_000 }); } catch {}
        try { runCommand("/bin/systemctl", ["disable", PLATFORM_SERVICE]); } catch {}
        unlinkSync(unitPath);
        try { runCommand("/bin/systemctl", ["daemon-reload"]); } catch {}
      }
      if (preparation.createdEnvironment && existsSync(PLATFORM_ENV)) {
        check(privateFile(PLATFORM_ENV).sha256 === preparation.environmentSha256, "PREPARE_CLEANUP_ENV_DRIFT");
        unlinkSync(PLATFORM_ENV);
      }
      if (preparation.createdDataDirectory && existsSync(dataDirectory)) {
        check(account && platformDataDirectoryIsSafe(dataDirectory, account), "PREPARE_CLEANUP_DATA_DRIFT");
        check(platformDatabaseIsEmpty(PLATFORM_DATABASE), "PREPARE_CLEANUP_DATA_NOT_EMPTY");
        rmSync(dataDirectory, { recursive: true, force: false });
      }
      if (preparation.createdUser) {
        let currentAccount = "";
        try { currentAccount = runCommand("/usr/bin/getent", ["passwd", PLATFORM_USER]).trim(); } catch {}
        if (currentAccount) runCommand("/usr/sbin/userdel", [PLATFORM_USER]);
      }
    } catch { incomplete = true; }
    persist({ status: incomplete ? "cleanup-incomplete" : "cleanup-complete", cleanupAt: new Date().toISOString() });
    return !incomplete;
  };

  try {
    if (!account) {
      runCommand("/usr/sbin/useradd", ["--system", "--user-group", "--no-create-home", "--home-dir", dataDirectory, "--shell", "/sbin/nologin", PLATFORM_USER]);
      accountLine = runCommand("/usr/bin/getent", ["passwd", PLATFORM_USER]).trim();
      const fields = accountLine.split(":");
      account = { uid: Number(fields[2]), gid: Number(fields[3]) };
      persist({ createdUser: true });
    } else if (!preparation.adoptedExisting) {
      check(preparation.createdUser, "PLATFORM_ACCOUNT_ALREADY_EXISTS");
    }
    if (!existsSync(dataDirectory)) {
      runCommand("/usr/bin/install", ["-d", "-o", PLATFORM_USER, "-g", PLATFORM_USER, "-m", "0700", dataDirectory]);
      persist({ createdDataDirectory: true });
    }
    check(platformDataDirectoryIsSafe(dataDirectory, account), "PLATFORM_DATA_PERMISSIONS_INVALID");
    const expectedEnvironmentSha256 = hashBytes(candidate.platformRaw);
    const currentEnvironment = existsSync(PLATFORM_ENV) ? privateFile(PLATFORM_ENV) : null;
    const currentUnit = existsSync(unitPath) ? privateFile(unitPath, null, { requirePrivate: false }) : null;
    const environmentChanged = Boolean(currentEnvironment && currentEnvironment.sha256 !== expectedEnvironmentSha256);
    const unitChanged = Boolean(currentUnit && currentUnit.content.toString() !== unit);
    if (preparation.adoptedExisting && (environmentChanged || unitChanged)) {
      runCommand("/bin/systemctl", ["stop", PLATFORM_SERVICE], { timeout: 30_000 });
      persist({ platformServiceStopped: true });
    }
    if (!currentEnvironment) {
      writeExclusive(PLATFORM_ENV, candidate.platformRaw);
      persist({ createdEnvironment: true });
    } else if (environmentChanged) {
      check(preparation.adoptedExisting && currentEnvironment.sha256 === preparation.platformEnvironmentBackupSha256, "PLATFORM_ENV_DRIFT");
      atomicReplace(PLATFORM_ENV, candidate.platformRaw, currentEnvironment.sha256);
      persist({ platformEnvironmentChanged: true });
    }
    if (!existsSync(unitPath)) {
      writeExclusive(unitPath, unit);
      persist({ createdUnit: true });
    } else if (unitChanged) {
      check(preparation.adoptedExisting && currentUnit.sha256 === preparation.platformUnitBackupSha256, "PLATFORM_UNIT_DRIFT");
      atomicReplace(unitPath, unit, currentUnit.sha256, { requirePrivate: false });
      persist({ platformUnitChanged: true });
    }
    runCommand("/usr/bin/systemd-analyze", ["verify", unitPath]);
    runCommand("/bin/systemctl", ["daemon-reload"]);
    runCommand("/bin/systemctl", ["enable", PLATFORM_SERVICE]);
    runCommand("/bin/systemctl", ["start", PLATFORM_SERVICE], { timeout: 90_000 });
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await socketFetch(PRODUCTION_AI_SOCKET)("http://127.0.0.1:18997/healthz", { signal: AbortSignal.timeout(1000) });
        const value = await response.json();
        if (response.status === 200 && value.database === "ready" && value.executor?.admissionOpen === false) {
          ready = true;
          break;
        }
      } catch {}
      await sleep(1000);
    }
    check(ready, "PREPARED_PLATFORM_NOT_PAUSED");
    check(JSON.stringify(before) === JSON.stringify(protectedSnapshot()), "PROTECTED_STATE_CHANGED");
    const result = {
      status: "prepared", newCommit: manifest.newCommit, platformUnitSha256: unitDigest,
      adoptedExisting: Boolean(preparation.adoptedExisting), protected: before, manifestDigest,
    };
    writeOnceOrVerify(join(manifest.evidenceDir, "platform-preparation.json"), JSON.stringify(result, null, 2) + "\n");
    persist({ status: "prepared", preparedAt: new Date().toISOString(), result });
    return result;
  } catch (error) {
    if (!cleanUp()) error.code = "PREPARE_CLEANUP_INCOMPLETE";
    throw error;
  }
}

export async function runAiProductionPreflight(manifest) {
  const checks = [];
  let candidate;
  let quality;
  const rolloutPhase = rolloutPhaseForManifest(manifest);
  async function verify(id, operation) {
    try {
      await operation();
      checks.push({ id, status: "passed" });
    } catch (error) {
      checks.push({ id, status: "failed", errorCode: /^[A-Za-z0-9_.:-]{1,100}$/u.test(error?.code ?? "") ? error.code : "CHECK_FAILED" });
    }
  }
  await verify("host.identity", () => assertHost(manifest));
  await verify("release.archive", () => {
    verifyNewReleaseArchive(manifest);
    check(validateAiComponentManifest(JSON.parse(readFileSync(join(manifest.newRelease, "release-manifest.json"), "utf8"))), "AI_COMPONENT_MANIFEST_INVALID");
    runCommand("/bin/bash", [
      "-c", 'source "$1"; NEW_RELEASE="$2"; EXPECTED_COMMIT="$3"; NODE_BIN="$4"; assert_candidate_release_frozen; verify_release_manifest',
      "verify-release", join(manifest.newRelease, "scripts/production-cutover.sh"), manifest.newRelease, manifest.newCommit, PROJECT_NODE,
    ], { timeout: 120_000 });
  });
  await verify("environment.binding", () => {
    candidate = validateCandidateConfiguration(manifest);
    privateFile(PLATFORM_ENV, manifest.platformEnvSha256);
  });
  await verify("supplier.acceptance", () => {
    quality = jsonFile(manifest.qualityReport, manifest.qualityReportSha256);
    check(quality.status === "passed" && quality.sourceCommit === manifest.newCommit
      && quality.executionMode === (rolloutPhase === "P1" ? "local-simulated" : "external-provider")
      && quality.currency === candidate.policy.currency
      && quality.summary?.failed === 0 && Array.isArray(quality.models), "SUPPLIER_ACCEPTANCE_MISSING");
    if (rolloutPhase !== "P1") for (const model of candidate.policy.models) {
      check(quality.models.some((item) => item.name === model.name && item.providerId === model.providerId
        && item.status === "passed" && item.source === "model" && item.usageRecorded === true), "SUPPLIER_MODEL_NOT_VALIDATED");
    }
    check(Date.now() - Date.parse(quality.generatedAt) < 24 * 60 * 60_000 && Date.now() - Date.parse(quality.generatedAt) >= -30_000, "SUPPLIER_ACCEPTANCE_STALE");
  });
  await verify("resources.acceptance", () => {
    check(quality?.resources?.status === "passed" && quality.resources.durationSeconds >= 1800
      && quality.resources.machineIdSha256 === hashBytes(manifest.machineId)
      && quality.resources.minimumAvailableMemoryMiB >= 1024
      && quality.resources.platformPeakRssMiB <= 768
      && quality.resources.cleanup === "clean", "RESOURCE_ACCEPTANCE_MISSING");
  });
  await verify("platform.service", () => {
    const unit = inspectUnit(PLATFORM_SERVICE);
    check(unit.ActiveState === "active" && Number(unit.MainPID) > 1 && unit.User === PLATFORM_USER
      && unit.WorkingDirectory === manifest.newRelease && unit.ExecStart.includes(manifest.newRelease + "/ai-platform/src/cli.js serve"), "PLATFORM_UNIT_IDENTITY_INVALID");
    const file = privateFile("/etc/systemd/system/" + PLATFORM_SERVICE, null, { requirePrivate: false }).content.toString();
    const expected = renderPlatformUnit(readFileSync(join(manifest.newRelease, "scripts/ai-platform/systemd/sentelligent-ai-platform.service.template"), "utf8"), manifest.newRelease);
    check(file === expected, "PLATFORM_UNIT_DRIFT");
    const account = runCommand("/usr/bin/getent", ["passwd", PLATFORM_USER]).trim().split(":");
    const directory = lstatSync("/var/lib/sentelligent-ai-platform");
    check(directory.uid === Number(account[2]) && (directory.mode & 0o077) === 0, "PLATFORM_DATA_PERMISSIONS_INVALID");
  });
  await verify("platform.database", () => {
    const db = new DatabaseSync(PLATFORM_DATABASE, { readOnly: true });
    try {
      check(db.prepare("PRAGMA quick_check").get().quick_check === "ok" && db.prepare("PRAGMA foreign_key_check").all().length === 0, "PLATFORM_DATABASE_INVALID");
      const release = db.prepare("SELECT policy_digest FROM deployment_policy_releases WHERE id=?").get(candidate.policy.id);
      if (rolloutPhase !== "P1") check(release?.policy_digest === sha256(candidate.policy), "PLATFORM_POLICY_NOT_PUBLISHED");
      check(db.prepare("SELECT count(*) n FROM tasks WHERE status IN ('queued','running')").get().n === 0, "PLATFORM_QUEUE_NOT_EMPTY");
    } finally { db.close(); }
  });
  await verify("platform.runtime", async () => {
    const response = await socketFetch(PRODUCTION_AI_SOCKET)("http://127.0.0.1:18997/healthz", { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    check(response.status === 200 && health.database === "ready" && health.proactiveScheduleOwner === "backend"
      && health.executionMode === (rolloutPhase === "P1" ? "local-simulated" : "external-provider"), "PLATFORM_RUNTIME_INVALID");
    if (rolloutPhase === "P1") check(health.executor?.admissionOpen === false, "P1_ADMISSION_MUST_BE_CLOSED");
    for (const binding of candidate.policy.agents) {
      const model = candidate.policy.models.find((item) => item.id === binding.modelId);
      const registered = registeredProviderPolicy(candidate.platform, model.providerId)?.models.find((item) => item.name === model.name);
      check(registered && Object.values(health.tasks ?? {}).some((item) => item.ready && item.model === model.name && item.provider === model.providerId), "PLATFORM_MODEL_NOT_READY");
    }
  });
  await verify("core.preflight", () => {
    const core = jsonFile(manifest.corePreflight, manifest.corePreflightSha256);
    assertCoreProof(core, manifest, manifest.oldRelease, manifest.oldCommit);
  });
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    manifestDigest: hashBytes(JSON.stringify(manifest)), sourceCommit: manifest.newCommit,
    status: checks.every((item) => item.status === "passed") ? "passed" : "failed", checks,
  };
}
