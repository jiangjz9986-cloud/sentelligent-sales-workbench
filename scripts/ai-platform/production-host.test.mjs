import assert from "node:assert/strict";
import { test } from "node:test";
import {
  observationReportIdentity,
  migrationInventoriesMatch,
  migrationInventoryDigest,
  phaseRecoveryPlan,
  pollPostflightHealth,
  postflightHealthMatchesRollout,
  postflightHealthResponseMatchesRollout,
  validateObservationBinding,
  validateObservationRuntime,
} from "./production-host.mjs";
import { PRODUCTION_ROOT, transitionIdentityDigest, hashBytes } from "./production-contract.mjs";

const evidence = PRODUCTION_ROOT + "/evidence/observation-test";
const manifest = {
  schemaVersion: 1, id: "observation-test", hostname: "test-host", machineId: "a".repeat(32),
  oldRelease: PRODUCTION_ROOT + "/releases/old", oldCommit: "b".repeat(40),
  newRelease: PRODUCTION_ROOT + "/releases/new", newCommit: "c".repeat(40),
  evidenceDir: evidence, backupDir: PRODUCTION_ROOT + "/backups/observation-test",
  platformEnvCandidate: evidence + "/platform.env", backendEnvCandidate: evidence + "/backend.env",
  platformEnvSha256: "d".repeat(64), backendEnvSha256: "e".repeat(64),
  corePreflight: evidence + "/core.json", corePreflightSha256: "f".repeat(64),
  policyFile: evidence + "/policy.json", policySha256: "1".repeat(64),
  qualityReport: evidence + "/quality.json", qualityReportSha256: "2".repeat(64),
  newArchive: evidence + "/release.tar.gz", newArchiveSha256: "3".repeat(64),
  p2AcceptanceReport: evidence + "/p2.json", p2AcceptanceReportSha256: "4".repeat(64),
  phase: "canary", rolloutPhase: "P3",
};

test("observation report identity binds the manifest and candidate release", () => {
  const identity = observationReportIdentity(manifest);
  assert.deepEqual(identity, {
    transitionId: manifest.id,
    manifestDigest: hashBytes(JSON.stringify(manifest)),
    transitionIdentityDigest: transitionIdentityDigest(manifest),
    newRelease: manifest.newRelease,
    newCommit: manifest.newCommit,
    phase: manifest.phase,
    rolloutPhase: manifest.rolloutPhase,
    currentRelease: manifest.newRelease,
    expectedPaused: false,
    expectedAdmissionOpen: true,
    expectedExecutionMode: "external-provider",
    expectedExternalProvidersEnabled: true,
  });
  assert.notEqual(
    observationReportIdentity({ ...manifest, policySha256: "5".repeat(64) }).transitionIdentityDigest,
    identity.transitionIdentityDigest,
  );
});

function observationState(value) {
  const identity = observationReportIdentity(value);
  return {
    transitionId: identity.transitionId,
    manifestDigest: identity.manifestDigest,
    transitionIdentityDigest: identity.transitionIdentityDigest,
    newRelease: identity.newRelease,
    newCommit: identity.newCommit,
    rolloutPhase: identity.rolloutPhase,
    currentRelease: identity.newRelease,
  };
}

test("observation binding rejects a state or current release from another transition", () => {
  const state = observationState(manifest);
  assert.equal(validateObservationBinding(manifest, state, manifest.newRelease).newCommit, manifest.newCommit);
  assert.throws(
    () => validateObservationBinding(manifest, { ...state, transitionId: "other-transition" }, manifest.newRelease),
    { code: "OBSERVE_STATE_MISMATCH" },
  );
  assert.throws(
    () => validateObservationBinding(manifest, { ...state, manifestDigest: "0".repeat(64) }, manifest.newRelease),
    { code: "OBSERVE_STATE_MISMATCH" },
  );
  assert.throws(
    () => validateObservationBinding(manifest, state, manifest.oldRelease),
    { code: "OBSERVE_CURRENT_RELEASE_MISMATCH" },
  );
});

test("P1 observation binding requires paused, closed admission, and local simulation", () => {
  const p1 = { ...manifest, phase: "legacy", rolloutPhase: "P1" };
  const identity = observationReportIdentity(p1);
  const good = {
    currentRelease: p1.newRelease,
    operations: { paused: true, executor: { admissionOpen: false }, queue: { running: 0, queued: 0 } },
    aiHealth: {
      status: 200,
      body: { database: "ready", executionMode: "local-simulated", externalProvidersEnabled: false, executor: { admissionOpen: false } },
    },
    backend: { status: 200, body: { database: "ready", aiPlatform: { routing: { phase: "legacy" } } } },
  };
  assert.equal(validateObservationRuntime(identity, good), true);
  assert.throws(() => validateObservationRuntime(identity, {
    ...good, operations: { ...good.operations, paused: false, executor: { admissionOpen: true } },
  }), { code: "P1_ADMISSION_MUST_BE_CLOSED" });
  assert.throws(() => validateObservationRuntime(identity, {
    ...good, aiHealth: { ...good.aiHealth, body: { ...good.aiHealth.body, executionMode: "external-provider", externalProvidersEnabled: true } },
  }), { code: "OBSERVE_EXECUTION_MODE_MISMATCH" });
});

test("phase recovery fails closed after policy application and otherwise restores prior admission", () => {
  const open = { paused: false, executor: { admissionOpen: true } };
  assert.deepEqual(phaseRecoveryPlan({ policyApplied: false, backendRestored: true, beforeOperations: open }), {
    mode: "restore", policy: "unchanged", paused: false, admissionOpen: true,
  });
  assert.deepEqual(phaseRecoveryPlan({ policyApplied: true, backendRestored: true, beforeOperations: open }), {
    mode: "fail-closed", policy: "unrestored", paused: true, admissionOpen: false,
  });
  assert.deepEqual(phaseRecoveryPlan({ policyApplied: false, backendRestored: false, beforeOperations: open }), {
    mode: "fail-closed", policy: "unchanged", paused: true, admissionOpen: false,
  });
});

test("automatic rollback preserves old migrations and allows only appended versions", () => {
  const oldRelease = { migrationChecksums: { files: { "0042.mjs": "a".repeat(64), "0043.mjs": "b".repeat(64) } } };
  const sameRelease = { migrationChecksums: { files: { "0043.mjs": "b".repeat(64), "0042.mjs": "a".repeat(64) } } };
  const appendedRelease = { migrationChecksums: { files: { "0042.mjs": "a".repeat(64), "0043.mjs": "b".repeat(64), "0044.mjs": "c".repeat(64) } } };
  const insertedRelease = { migrationChecksums: { files: { "0041.mjs": "c".repeat(64), "0042.mjs": "a".repeat(64), "0043.mjs": "b".repeat(64) } } };
  const changedRelease = { migrationChecksums: { files: { "0042.mjs": "z".repeat(64), "0043.mjs": "b".repeat(64) } } };
  const removedRelease = { migrationChecksums: { files: { "0042.mjs": "a".repeat(64) } } };
  assert.equal(migrationInventoryDigest(oldRelease), migrationInventoryDigest(sameRelease));
  assert.equal(migrationInventoriesMatch(oldRelease, sameRelease), true);
  assert.equal(migrationInventoriesMatch(oldRelease, appendedRelease), true);
  assert.equal(migrationInventoriesMatch(oldRelease, insertedRelease), false);
  assert.equal(migrationInventoriesMatch(oldRelease, changedRelease), false);
  assert.equal(migrationInventoriesMatch(oldRelease, removedRelease), false);
  assert.equal(migrationInventoriesMatch(oldRelease, {}), false);
});

test("P1 postflight accepts a disabled, local-simulated platform that is healthy", () => {
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "disabled", ready: true, executionMode: "local-simulated" },
  }, "P1"), true);
});

test("P1 postflight rejects an open or externally executing platform", () => {
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "required", ready: true, executionMode: "external-provider" },
  }, "P1"), false);
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "disabled", ready: false, executionMode: "local-simulated" },
  }, "P1"), false);
});

test("postflight health accepts a ready response only after transient startup failures settle", async () => {
  let calls = 0;
  const result = await pollPostflightHealth("P1", {
    attempts: 3,
    retryMs: 0,
    sleepFn: async () => {},
    fetcher: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      if (calls === 2) return { status: 503, json: async () => ({ database: "starting" }) };
      return {
        status: 200,
        json: async () => ({
          database: "ready",
          aiPlatform: { mode: "disabled", ready: true, executionMode: "local-simulated" },
        }),
      };
    },
  });
  assert.equal(calls, 3);
  assert.equal(postflightHealthResponseMatchesRollout(result.status, result.health, "P1"), true);
});

test("postflight health response keeps the database and rollout checks strict", () => {
  assert.equal(postflightHealthResponseMatchesRollout(503, { database: "starting" }, "P1"), false);
  assert.equal(postflightHealthResponseMatchesRollout(200, {
    database: "ready",
    aiPlatform: { mode: "required", ready: true, executionMode: "external-provider" },
  }, "P1"), false);
});

test("postflight requires platform readiness after P1", () => {
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "required", ready: true, executionMode: "external-provider" },
  }, "P3"), true);
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "required", ready: false, executionMode: "external-provider" },
  }, "P3"), false);
});
