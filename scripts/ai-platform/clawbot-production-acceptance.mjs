import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { BUSINESS_DATABASE } from "./production-contract.mjs";
import { createDatabaseIdentity } from "../../backend/src/db/databaseIdentity.js";

const ROOT = "/opt/sentelligent-sales-workbench";
const SHA = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,63}$/u;
const SOURCE_PREFIX = "manual-test:clawbot:";
const CODE = /^CLAWBOT_[A-Z0-9_]+$/u;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const safeCode = (error) => CODE.test(error?.code ?? "") ? error.code : "CLAWBOT_CHECK_FAILED";
const iso = (value) => new Date(value).toISOString();

function timestamp(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || iso(parsed) !== value) fail("CLAWBOT_TIMESTAMP_INVALID");
  return parsed;
}

function protectedRead(path, { uid, privateMode = false, maxBytes = 1024 * 1024 } = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes
      || (uid !== undefined && before.uid !== uid)
      || (before.mode & (privateMode ? 0o077 : 0o022)) !== 0
      || realpathSync(path) !== path) fail("CLAWBOT_UNSAFE_INPUT_FILE");
    const content = readFileSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.ino !== after.ino || current.dev !== after.dev) fail("CLAWBOT_INPUT_CHANGED");
    return { content, metadata: after, sha256: hash(content) };
  } finally { closeSync(fd); }
}

function privateDirectory(path, uid) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || realpathSync(path) !== path || stats.uid !== uid
    || (stats.mode & 0o077) !== 0) fail("CLAWBOT_UNSAFE_STATE_DIRECTORY");
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function exclusiveJson(path, value) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

export function createClawbotAcceptanceStore(directory, { uid = process.getuid() } = {}) {
  privateDirectory(directory, uid);
  const pathFor = (runId, suffix) => {
    if (!RUN_ID.test(runId)) fail("CLAWBOT_RUN_ID_INVALID");
    return join(directory, `${runId}.${suffix}.json`);
  };
  return {
    readAttempt(runId) {
      const path = pathFor(runId, "attempt");
      if (!existsSync(path)) return null;
      return JSON.parse(protectedRead(path, { uid, privateMode: true }).content);
    },
    claimAttempt(runId, attempt) {
      try { exclusiveJson(pathFor(runId, "attempt"), attempt); return true; }
      catch (error) { if (error.code === "EEXIST") return false; throw error; }
    },
    writeReport(runId, report) {
      if (report.status === "passed") {
        const passedPath = pathFor(runId, "passed");
        try { exclusiveJson(passedPath, report); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          protectedRead(passedPath, { uid, privateMode: true });
        }
      }
      const path = pathFor(runId, "report");
      if (existsSync(path)) protectedRead(path, { uid, privateMode: true });
      const temporary = join(directory, `.${runId}.${randomUUID()}.tmp`);
      exclusiveJson(temporary, report);
      renameSync(temporary, path);
      syncDirectory(directory);
      return path;
    },
  };
}

export function manualTestPayload(runId, startedAt) {
  if (!RUN_ID.test(runId)) fail("CLAWBOT_RUN_ID_INVALID");
  timestamp(startedAt);
  return {
    source: SOURCE_PREFIX + runId,
    severity: "warning",
    summary: `Clawbot manual-test [${runId}]`,
    detail: "Authorized one-message proactive delivery acceptance. No reply is needed. This is a manual test, not a system failure.",
    eventId: `clawbot-acceptance:${runId}`,
    occurredAt: startedAt,
  };
}

function baselineOf(snapshot) {
  return {
    identity: snapshot.identity,
    target: snapshot.target,
    context: snapshot.context,
    inbound: snapshot.inbound,
    journalCursor: snapshot.journalCursor,
  };
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function assertStable(baseline, snapshot, { requireContext = true } = {}) {
  if (!same(baseline.identity, snapshot.identity)) fail("CLAWBOT_RUNTIME_BINDING_CHANGED");
  if (!same(baseline.target, snapshot.target)) fail("CLAWBOT_TARGET_CHANGED");
  if (!same(baseline.inbound, snapshot.inbound) || snapshot.journalInboundCount > 0) fail("CLAWBOT_NEW_INBOUND_OBSERVED");
  if (requireContext && !same(baseline.context, snapshot.context)) fail("CLAWBOT_CONTEXT_CHANGED");
}

function assertReady(snapshot, now, quietMs, timeoutMs) {
  if (snapshot.target.count !== 1) fail("CLAWBOT_REQUIRES_SINGLE_ADMIN_TARGET");
  if (snapshot.context?.exists !== true) fail("CLAWBOT_CONTEXT_MISSING");
  if (timestamp(snapshot.context.expiresAt) <= now + timeoutMs + 5000) fail("CLAWBOT_CONTEXT_EXPIRING");
  if (snapshot.readiness?.status !== "ready") fail("CLAWBOT_WORKER_NOT_READY");
  if (snapshot.readiness.expiresAt !== snapshot.context.expiresAt
    || now - timestamp(snapshot.readiness.reportedAt) > 30_000
    || timestamp(snapshot.readiness.reportedAt) > now + 1000) fail("CLAWBOT_READINESS_STALE");
  if (now - snapshot.context.modifiedAtMs < quietMs
    || (snapshot.inbound.latestAt && now - Date.parse(snapshot.inbound.latestAt) < quietMs)) fail("CLAWBOT_QUIET_WINDOW_NOT_MET");
  if (snapshot.backlog.queued !== 0 || snapshot.backlog.processing !== 0) fail("CLAWBOT_EXISTING_BACKLOG");
}

function publicSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    identity: snapshot.identity, target: snapshot.target, context: snapshot.context,
    inbound: snapshot.inbound, readiness: snapshot.readiness, backlog: snapshot.backlog,
    outbox: snapshot.outbox, audits: snapshot.audits,
    journal: { checked: snapshot.journalChecked === true, inboundCount: snapshot.journalInboundCount ?? 0 },
  };
}

// The attempt is committed and fsynced before the only POST. A crash or an
// uncertain HTTP result permanently turns this run into read-only observation.
export async function runClawbotAcceptance({
  command = "inspect", runId, sourceCommit, timeoutMs = 90_000, pollMs = 2000, quietMs = 15_000,
}, { host, store, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  if (!["inspect", "send-once", "observe"].includes(command) || !RUN_ID.test(runId ?? "")
    || !COMMIT.test(sourceCommit ?? "") || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000
    || !Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 5000
    || !Number.isSafeInteger(quietMs) || quietMs < 1000 || quietMs > 300_000) fail("CLAWBOT_OPTIONS_INVALID");
  const started = now();
  const deadline = started + timeoutMs;
  const report = {
    schemaVersion: 1, kind: "clawbot-production-acceptance", runId, sourceCommit,
    command, startedAt: iso(started), evidenceTier: host.evidenceTier,
    status: "pending", postAttemptsThisInvocation: 0,
    coverage: {
      oneOutboxDeliveryWithoutNewInbound: "pending",
      independentUpstreamReceipt: "unavailable_in_current_sdk",
      recipientReadReceipt: "not_observed",
      contextExpiryLive: "not_run_requires_real_expiry",
      retryAndRateLimitLive: "not_run_use_local_fixture_evidence",
      automaticContextRenewal: "unsupported",
    },
    receiptSemantics: "provider_message_id is the SDK client ID returned after a successful send API call; it is not an independent upstream delivery or read receipt",
  };
  let snapshot;
  let attempt;
  try {
    attempt = store.readAttempt(runId);
    if (attempt && (attempt.schemaVersion !== 1 || attempt.runId !== runId || attempt.sourceCommit !== sourceCommit
      || !attempt.baseline || !attempt.startedAt)) fail("CLAWBOT_ATTEMPT_BINDING_MISMATCH");
    snapshot = await host.snapshot({ runId, baseline: attempt?.baseline, deadline });
    if (snapshot.identity.sourceCommit !== sourceCommit) fail("CLAWBOT_RELEASE_COMMIT_MISMATCH");
    report.before = publicSnapshot(snapshot);
    if (attempt) assertStable(attempt.baseline, snapshot, { requireContext: snapshot.outbox?.status !== "sent" });
    if (command === "inspect") {
      assertReady(snapshot, now(), quietMs, timeoutMs);
      report.status = "ready";
    } else {
      if (!attempt) {
        if (snapshot.outbox || snapshot.audits.length) fail("CLAWBOT_EXISTING_EVENT_WITHOUT_CHECKPOINT");
        if (command !== "send-once") fail("CLAWBOT_ATTEMPT_NOT_FOUND");
        assertReady(snapshot, now(), quietMs, timeoutMs);
        const attemptStartedAt = iso(now());
        const proposed = {
          schemaVersion: 1, runId, sourceCommit, startedAt: attemptStartedAt,
          baseline: baselineOf(snapshot), payloadSha256: hash(JSON.stringify(manualTestPayload(runId, attemptStartedAt))),
          policy: "one_post_only_unknown_outcome_never_resubmit",
        };
        // Recheck immediately before taking the exclusive, durable send claim.
        snapshot = await host.snapshot({ runId, baseline: proposed.baseline, deadline });
        assertStable(proposed.baseline, snapshot);
        assertReady(snapshot, now(), quietMs, timeoutMs);
        if (snapshot.outbox || snapshot.audits.length) fail("CLAWBOT_EXISTING_EVENT_WITHOUT_CHECKPOINT");
        if (now() >= deadline) fail("CLAWBOT_TIMEOUT_BEFORE_SEND");
        if (store.claimAttempt(runId, proposed)) {
          attempt = proposed;
          report.postAttemptsThisInvocation = 1;
          try {
            const response = await host.submitOnce(manualTestPayload(runId, attempt.startedAt), deadline);
            report.intake = { httpStatus: response.status, accepted: response.status === 200 };
          } catch {
            report.intake = { accepted: null, outcome: "unknown_observe_only_no_resubmit" };
          }
        } else {
          attempt = store.readAttempt(runId);
          if (!attempt || attempt.sourceCommit !== sourceCommit || attempt.runId !== runId) fail("CLAWBOT_ATTEMPT_BINDING_MISMATCH");
        }
      }
      report.attemptStartedAt = attempt.startedAt;
      report.attemptEvidence = {
        sha256: hash(JSON.stringify(attempt, null, 2) + "\n"),
        identity: attempt.baseline.identity, target: attempt.baseline.target,
        context: attempt.baseline.context, inbound: attempt.baseline.inbound,
        journalCursorSha256: hash(attempt.baseline.journalCursor),
      };
      while (now() < deadline) {
        snapshot = await host.snapshot({ runId, baseline: attempt.baseline, deadline });
        assertStable(attempt.baseline, snapshot);
        const row = snapshot.outbox;
        if (row?.status === "sent") {
          if (!row.providerMessageIdSha256 || row.providerClientIdMatches !== true || !row.sentAt
            || timestamp(row.sentAt) < timestamp(attempt.startedAt)
            || timestamp(row.sentAt) > now() + 1000
            || timestamp(row.sentAt) >= timestamp(attempt.baseline.context.expiresAt)
            || row.attemptCount !== 0) fail("CLAWBOT_SEND_PROOF_INCOMPLETE");
          if (snapshot.journalChecked !== true) fail("CLAWBOT_JOURNAL_PROOF_MISSING");
          if (snapshot.audits.length !== 1 || snapshot.audits[0].replayed !== false
            || snapshot.audits[0].delivery !== "weixin_outbox") fail("CLAWBOT_INTAKE_AUDIT_INCOMPLETE");
          report.status = "passed";
          report.coverage.oneOutboxDeliveryWithoutNewInbound = "passed";
          break;
        }
        if (row?.status === "failed" || row?.attemptCount > 0 || row?.lastErrorCode) fail("CLAWBOT_WORKER_FAILURE_OBSERVED");
        if (snapshot.context.exists !== true || timestamp(snapshot.context.expiresAt) <= now()
          || snapshot.readiness.status !== "ready") fail("CLAWBOT_DELIVERY_NOT_READY");
        await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      }
      if (report.status === "pending") report.code = "CLAWBOT_BOUNDED_WAIT_EXPIRED";
    }
  } catch (error) {
    report.status = "pending";
    report.code = safeCode(error);
  }
  report.after = publicSnapshot(snapshot);
  report.finishedAt = iso(now());
  report.reportPath = store.writeReport(runId, report);
  return report;
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
    });
  } catch { fail("CLAWBOT_LOCAL_COMMAND_FAILED"); }
}

function processIdentity(unit, release, entrypoint) {
  const properties = Object.fromEntries(commandOutput("/bin/systemctl", ["show", unit,
    "-p", "ActiveState", "-p", "MainPID", "-p", "WorkingDirectory", "-p", "ExecStart",
  ]).split("\n").filter((line) => line.includes("=")).map((line) => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
  const pid = Number(properties.MainPID);
  if (properties.ActiveState !== "active" || !Number.isSafeInteger(pid) || pid < 2
    || properties.WorkingDirectory !== join(release, "backend")
    || !properties.ExecStart.includes(join(release, entrypoint))) fail("CLAWBOT_SERVICE_RELEASE_MISMATCH");
  if (realpathSync(`/proc/${pid}/cwd`) !== join(release, "backend")) fail("CLAWBOT_PROCESS_RELEASE_MISMATCH");
  const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  if (!argv.includes(join(release, entrypoint))) fail("CLAWBOT_PROCESS_RELEASE_MISMATCH");
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return { pid, startTicks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] };
}

export function projectClawbotJournal(rows, cursor) {
  if ((!cursor && rows.length !== 1) || rows.length >= 2001
    || (cursor && rows[0]?.__CURSOR !== cursor)
    || rows.some((row) => typeof row.__CURSOR !== "string" || !row.__CURSOR)) fail("CLAWBOT_JOURNAL_WINDOW_UNAVAILABLE");
  return {
    cursor: rows.at(-1).__CURSOR,
    inboundCount: (cursor ? rows.slice(1) : []).filter((row) => typeof row.MESSAGE === "string" && /category=inbound\b.*status=received\b/u.test(row.MESSAGE)).length,
  };
}

function journalSnapshot(cursor) {
  const args = ["-u", "sentelligent-weixin-agent.service", "--no-pager", "-o", "json", "-n", cursor ? "2001" : "1"];
  // Include and verify the anchor entry. journalctl can seek past a missing
  // cursor after vacuuming; accepting that would hide a gap in the evidence.
  if (cursor) args.push(`--cursor=${cursor}`);
  const rows = commandOutput("/bin/journalctl", args).split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  return projectClawbotJournal(rows, cursor);
}

async function boundedJson(url, { token, method = "GET", body, deadline }) {
  const remaining = Math.min(5000, deadline - Date.now());
  if (remaining <= 0) fail("CLAWBOT_HTTP_TIMEOUT");
  const response = await fetch(url, {
    method, redirect: "error", signal: AbortSignal.timeout(remaining),
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const reader = response.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) fail("CLAWBOT_HTTP_RESPONSE_TOO_LARGE");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  return { status: response.status, body: size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null };
}

export function resolveClawbotBusinessDatabase({ databasePath, databaseUrl } = {}, { realpath = realpathSync } = {}) {
  const exactPath = (value) => {
    let path = value ?? BUSINESS_DATABASE;
    if (typeof path !== "string") fail("CLAWBOT_DATABASE_PATH_INVALID");
    if (path.startsWith("file:")) {
      const url = new URL(path);
      if (url.search || url.hash) fail("CLAWBOT_DATABASE_PATH_INVALID");
      path = fileURLToPath(url);
    }
    if (path !== BUSINESS_DATABASE) fail("CLAWBOT_DATABASE_PATH_INVALID");
    return path;
  };
  const configured = exactPath(databaseUrl);
  const selected = exactPath(databasePath ?? configured);
  // Reject the lexical path before touching disk, then reject symlink escapes.
  if (realpath(selected) !== BUSINESS_DATABASE) fail("CLAWBOT_DATABASE_PATH_INVALID");
  return BUSINESS_DATABASE;
}

export function assertClawbotDatabaseHealth(health, databaseIdentity) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(databaseIdentity ?? "") || health?.status !== 200
    || health.body?.status !== "ok" || health.body.database !== "ready"
    || health.body.databaseIdentity !== databaseIdentity) fail("CLAWBOT_DATABASE_HEALTH_BINDING_MISMATCH");
}

export function readClawbotAdminTargets(db) {
  return db.prepare(`SELECT b.sender_id, b.account FROM weixin_bindings b JOIN users u ON u.account = b.account
    WHERE b.status = 'active' AND u.role = 'admin' AND u.status = 'active' ORDER BY b.account LIMIT 3`).all();
}

export function createProductionClawbotHost({ release, sourceCommit, contextFile, databasePath, backendOrigin }) {
  if (process.platform !== "linux" || process.getuid() !== 0 || Number(process.versions.node.split(".")[0]) < 24) fail("CLAWBOT_REQUIRES_LINUX_ROOT_NODE24");
  const releases = join(ROOT, "releases");
  if (dirname(release) !== releases || !/^[A-Za-z0-9._-]+$/u.test(relative(releases, release))) fail("CLAWBOT_RELEASE_PATH_INVALID");
  if (!contextFile.startsWith(ROOT + "/weixin-session/") || !contextFile.endsWith(".context.json")) fail("CLAWBOT_CONTEXT_PATH_INVALID");
  const envPath = ROOT + "/config/backend.env";
  const envRecord = protectedRead(envPath, { uid: 0, privateMode: true, maxBytes: 128 * 1024 });
  const env = parseEnv(envRecord.content.toString("utf8"));
  for (const key of ["OPS_ALERT_TOKEN", "WEIXIN_AGENT_API_TOKEN", "AUTH_SESSION_SECRET"]) {
    if (typeof env[key] !== "string" || env[key].length < 16) fail("CLAWBOT_REQUIRED_ENV_MISSING");
  }
  if (env.AUTH_SESSION_SECRET.length < 32) fail("CLAWBOT_REQUIRED_ENV_MISSING");
  const dbPath = resolveClawbotBusinessDatabase({ databasePath, databaseUrl: env.DATABASE_URL });
  const origin = new URL(backendOrigin ?? "http://127.0.0.1:8897");
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) fail("CLAWBOT_LOOPBACK_REQUIRED");
  const deliveryKey = createHmac("sha256", env.WEIXIN_AGENT_API_TOKEN).update("sentelligent/weixin-delivery-key/v1").digest();
  return {
    evidenceTier: "server-local-live",
    async snapshot({ runId, baseline, deadline }) {
      if (realpathSync(ROOT + "/current") !== release || realpathSync(release) !== release) fail("CLAWBOT_CURRENT_RELEASE_MISMATCH");
      if (protectedRead(envPath, { uid: 0, privateMode: true }).sha256 !== envRecord.sha256) fail("CLAWBOT_ENV_CHANGED");
      const manifestFile = protectedRead(join(release, "release-manifest.json"), { uid: 0, maxBytes: 8 * 1024 * 1024 });
      const manifest = JSON.parse(manifestFile.content);
      if (manifest.schemaVersion !== 3 || manifest.source?.commit !== sourceCommit || manifest.source?.clean !== true) fail("CLAWBOT_RELEASE_COMMIT_MISMATCH");
      const sources = manifest.sourceHashes?.files ?? {};
      const dependencies = manifest.productionDependencyHashes?.files ?? {};
      const required = ["backend/src/server.js", "backend/src/ops/opsAlertService.js", "backend/src/weixin/outboxWorker.js", "backend/src/weixin/worker.js", "backend/src/weixin/outboxRepository.js"];
      if (required.some((path) => !SHA.test(sources[path] ?? ""))) fail("CLAWBOT_RELEASE_HASH_MISSING");
      for (const [path, digest] of Object.entries({ ...sources, ...dependencies })) {
        if (!path.startsWith("backend/src/") && !path.startsWith("backend/node_modules/weixin-agent-sdk/")) continue;
        if (path.split("/").includes("..") || !SHA.test(digest)) fail("CLAWBOT_RELEASE_HASH_INVALID");
        if (protectedRead(join(release, path), { uid: 0, maxBytes: 4 * 1024 * 1024 }).sha256 !== digest) fail("CLAWBOT_RELEASE_FILE_MISMATCH");
      }
      if (!SHA.test(dependencies["backend/node_modules/weixin-agent-sdk/dist/index.mjs"] ?? "")) fail("CLAWBOT_SDK_BINDING_MISSING");
      const runtime = {
        backend: processIdentity("sentelligent-backend.service", release, "backend/src/server.js"),
        worker: processIdentity("sentelligent-weixin-agent.service", release, "backend/src/weixin/worker.js"),
      };
      resolveClawbotBusinessDatabase({ databasePath: dbPath, databaseUrl: env.DATABASE_URL });
      const dbStats = statSync(dbPath);
      if (!dbStats.isFile()) fail("CLAWBOT_DATABASE_PATH_INVALID");
      const databaseIdentity = createDatabaseIdentity({ databaseUrl: dbPath, secret: env.AUTH_SESSION_SECRET });
      const health = await boundedJson(origin.origin + "/api/health", { token: env.OPS_ALERT_TOKEN, deadline });
      assertClawbotDatabaseHealth(health, databaseIdentity);
      const status = await boundedJson(origin.origin + "/api/integrations/ops-alerts/status", { token: env.OPS_ALERT_TOKEN, deadline });
      if (status.status !== 200 || !status.body?.item?.weixinDelivery) fail("CLAWBOT_STATUS_UNAVAILABLE");
      let context = { exists: false };
      if (existsSync(contextFile)) {
        const record = protectedRead(contextFile, { privateMode: true, maxBytes: 64 * 1024 });
        const data = JSON.parse(record.content);
        if (data.version !== 1 || !data.iv || !data.authTag || !data.ciphertext) fail("CLAWBOT_CONTEXT_FORMAT_INVALID");
        timestamp(data.expiresAt);
        context = { exists: true, sha256: record.sha256, expiresAt: data.expiresAt, modifiedAtMs: record.metadata.mtimeMs };
      }
      const db = new DatabaseSync(dbPath, { readOnly: true });
      let target, inbound, outbox, audits, backlog;
      try {
        db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN");
        const targets = readClawbotAdminTargets(db);
        target = { count: targets.length };
        if (targets.length === 1) {
          target.ownerSha256 = hash(targets[0].account);
          target.senderSha256 = hash(targets[0].sender_id);
        }
        const counts = db.prepare("SELECT status, COUNT(*) AS n FROM weixin_confirmation_outbox WHERE status IN ('queued','processing') GROUP BY status").all();
        backlog = { queued: 0, processing: 0 };
        for (const row of counts) backlog[row.status] = row.n;
        const events = db.prepare("SELECT COUNT(*) AS n, MAX(rowid) AS lastRow, MAX(created_at) AS latestAt FROM assistant_inbound_events WHERE channel = 'weixin'").get();
        inbound = { count: events.n, lastRow: events.lastRow, latestAt: events.latestAt };
        const payload = manualTestPayload(runId, iso(Date.now()));
        const rows = db.prepare(`SELECT id, owner, conversation_id, idempotency_key_hash, payload_json, status, attempt_count,
          provider_message_id, sent_at, last_error_code FROM weixin_confirmation_outbox
          WHERE json_extract(payload_json, '$.origin') = ? LIMIT 3`).all(payload.source);
        if (rows.length > 1) fail("CLAWBOT_MULTIPLE_OUTBOX_ROWS");
        outbox = null;
        if (rows.length) {
          const row = rows[0];
          const content = JSON.parse(row.payload_json);
          if (targets.length !== 1 || row.owner !== targets[0].account
            || row.conversation_id !== "weixin:shortcut:v1:" + hash(row.owner + "\0" + targets[0].sender_id)
            || row.idempotency_key_hash !== hash(`ops-alert:event:${payload.eventId}:${row.owner}`)
            || content.kind !== "ops_alert" || content.summary !== payload.summary || content.detail !== payload.detail
            || content.severity !== payload.severity) fail("CLAWBOT_OUTBOX_BINDING_MISMATCH");
          const expectedId = "sentelligent:" + createHmac("sha256", deliveryKey)
            .update("sentelligent/weixin-provider-client-id/v1\0").update(row.id).digest("hex");
          outbox = { id: row.id, status: row.status, attemptCount: row.attempt_count,
            sentAt: row.sent_at, lastErrorCode: /^[A-Z0-9_]{1,100}$/u.test(row.last_error_code ?? "") ? row.last_error_code : row.last_error_code ? "UNRECOGNIZED" : null,
            providerMessageIdSha256: row.provider_message_id ? hash(row.provider_message_id) : null,
            providerClientIdMatches: row.provider_message_id === expectedId };
        }
        audits = db.prepare("SELECT id, metadata_json FROM audit_logs WHERE action = 'ops_alert.receive' AND entity_type = 'ops_alert' AND entity_id = ? LIMIT 3")
          .all(`ops-alert:event:${payload.eventId}`).map((row) => {
            const meta = JSON.parse(row.metadata_json);
            return { id: row.id, replayed: meta.replayed === true ? true : meta.replayed === false ? false : null,
              delivery: meta.delivery === "weixin_outbox" ? "weixin_outbox" : "unrecognized" };
          });
        db.exec("ROLLBACK");
      } finally { db.close(); }
      const journal = journalSnapshot(baseline?.journalCursor);
      return {
        identity: { sourceCommit, release, manifestSha256: manifestFile.sha256, databaseIdentitySha256: hash(databaseIdentity),
          contextPathSha256: hash(contextFile), runtime, runnerSha256: hash(readFileSync(SCRIPT_PATH)) },
        target, context, inbound, outbox, audits, backlog,
        readiness: {
          status: status.body.item.weixinDelivery.status === "ready" ? "ready" : "not_ready",
          reportedAt: status.body.item.weixinDelivery.reportedAt ?? null,
          expiresAt: status.body.item.weixinDelivery.expiresAt ?? null,
        },
        journalCursor: baseline?.journalCursor ?? journal.cursor,
        journalChecked: Boolean(baseline?.journalCursor), journalInboundCount: baseline ? journal.inboundCount : 0,
      };
    },
    submitOnce(payload, deadline) {
      return boundedJson(origin.origin + "/api/integrations/ops-alerts", { token: env.OPS_ALERT_TOKEN, method: "POST", body: payload, deadline });
    },
  };
}

export function parseClawbotArguments(argv) {
  if (argv.includes("--help")) return { help: true };
  const command = argv[0] ?? "inspect";
  const allowed = new Set(["release", "source-commit", "context-file", "run-id", "database", "backend-origin", "timeout-seconds", "quiet-seconds"]);
  const values = {};
  for (const entry of argv.slice(1)) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(entry);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(values, match[1])) fail("CLAWBOT_ARGUMENT_INVALID");
    values[match[1]] = match[2];
  }
  if (!["inspect", "send-once", "observe"].includes(command) || !COMMIT.test(values["source-commit"] ?? "")
    || !RUN_ID.test(values["run-id"] ?? "") || !isAbsolute(values.release ?? "") || !isAbsolute(values["context-file"] ?? "")) fail("CLAWBOT_ARGUMENT_REQUIRED");
  const timeoutMs = Number(values["timeout-seconds"] ?? 90) * 1000;
  const quietMs = Number(values["quiet-seconds"] ?? 15) * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000
    || !Number.isSafeInteger(quietMs) || quietMs < 5000 || quietMs > 300_000) fail("CLAWBOT_ARGUMENT_INVALID");
  return { command, runId: values["run-id"], sourceCommit: values["source-commit"], release: values.release,
    contextFile: values["context-file"], databasePath: values.database, backendOrigin: values["backend-origin"], timeoutMs, quietMs };
}

async function main() {
  try {
    const options = parseClawbotArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: node clawbot-production-acceptance.mjs inspect|send-once|observe --release=/opt/sentelligent-sales-workbench/releases/RELEASE --source-commit=FULL_SHA --context-file=/opt/sentelligent-sales-workbench/weixin-session/.../ACCOUNT.context.json --run-id=UNIQUE_STABLE_RUN_ID [--database=ABSOLUTE_PATH] [--timeout-seconds=90] [--quiet-seconds=15]\n\nLinux root / Node 24. Reads OPS_ALERT_TOKEN, WEIXIN_AGENT_API_TOKEN, AUTH_SESSION_SECRET from the protected backend.env. Never pass secrets on the command line. inspect is read-only except for its report; send-once enqueues at most one manual test; observe and every repeat are read-only. State is fixed under evidence/clawbot-acceptance; do not delete attempt files. A timeout does not cancel the existing worker or its queued message. No ops-alert shell, direct SDK send, context renewal, or history cleanup is used.\n");
      return;
    }
    const host = createProductionClawbotHost(options);
    const store = createClawbotAcceptanceStore(ROOT + "/evidence/clawbot-acceptance");
    const report = await runClawbotAcceptance(options, { host, store });
    process.stdout.write(JSON.stringify({ status: report.status, code: report.code ?? null, runId: report.runId,
      sourceCommit: report.sourceCommit, postAttempts: report.postAttemptsThisInvocation, report: report.reportPath }) + "\n");
    process.exitCode = ["ready", "passed"].includes(report.status) ? 0 : 2;
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: "pending", code: safeCode(error) }) + "\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) await main();
