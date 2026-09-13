import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  createClawbotAcceptanceStore, createProductionClawbotHost, manualTestPayload,
  parseClawbotArguments, projectClawbotJournal, runClawbotAcceptance,
  resolveClawbotBusinessDatabase, assertClawbotDatabaseHealth, readClawbotAdminTargets,
} from "./clawbot-production-acceptance.mjs";
import { BUSINESS_DATABASE } from "./production-contract.mjs";
import { createDatabaseIdentity } from "../../backend/src/db/databaseIdentity.js";
import { readProductionDatabaseIdentity } from "../../backend/scripts/production-smoke-cleanup.mjs";
import { openDatabase } from "../../backend/src/db.js";
import { seedWeixinBinding } from "../../backend/tests/helpers/weixin-binding-fixtures.js";
import { createWeixinBindingsRepository } from "../../backend/src/weixin/bindingsRepository.js";
import { createOpsAlertService } from "../../backend/src/ops/opsAlertService.js";
import { createWeixinConfirmationOutboxRepository } from "../../backend/src/weixin/outboxRepository.js";
import { runWeixinOutboxPump } from "../../backend/src/weixin/outboxWorker.js";
import { apply as migrateOutbox } from "../../backend/src/db/migrations/0019_shortcut_weixin_confirmation.mjs";

const COMMIT = "bd1df151968d0b092de117f873ca7378ed1943a7";
const RUN = "clawbot-fixture-20260913-r1";
const START = Date.parse("2026-09-13T13:15:00.000Z");
const sha = (value) => createHash("sha256").update(value).digest("hex");

function fixture(t, overrides = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "clawbot-acceptance-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let currentTime = START;
  const state = {
    posts: 0, snapshots: 0,
    snapshot: {
      identity: { sourceCommit: COMMIT, manifestSha256: "a".repeat(64), runtime: { worker: { pid: 1234 } } },
      target: { count: 1, ownerSha256: sha("fixture-owner"), senderSha256: sha("fixture-sender") },
      context: { exists: true, sha256: "b".repeat(64), expiresAt: "2026-09-14T10:34:37.596Z", modifiedAtMs: START - 100_000 },
      inbound: { count: 3, lastRow: 3, latestAt: new Date(START - 100_000).toISOString() },
      readiness: { status: "ready", expiresAt: "2026-09-14T10:34:37.596Z", reportedAt: new Date(START).toISOString() },
      backlog: { queued: 0, processing: 0 }, outbox: null, audits: [],
      journalCursor: "fixture-cursor", journalChecked: true, journalInboundCount: 0,
    },
  };
  const store = createClawbotAcceptanceStore(directory);
  const host = {
    evidenceTier: "local-fixture",
    async snapshot(options) {
      state.snapshots += 1;
      await overrides.beforeSnapshot?.(state, options);
      return structuredClone(state.snapshot);
    },
    async submitOnce(payload) {
      state.posts += 1;
      state.payload = payload;
      state.snapshot.outbox = {
        id: "fixture-outbox", status: "sent", attemptCount: 0, sentAt: new Date(currentTime).toISOString(),
        providerMessageIdSha256: sha("fixture-provider-client-id"), providerClientIdMatches: true, lastErrorCode: null,
      };
      state.snapshot.audits = [{ id: "fixture-audit", replayed: false, delivery: "weixin_outbox" }];
      await overrides.afterSubmit?.(state);
      return { status: 200 };
    },
  };
  const options = { command: "send-once", runId: RUN, sourceCommit: COMMIT, timeoutMs: 1000, pollMs: 100, quietMs: 5000 };
  return {
    directory, state, host, store, options,
    run: (changes = {}) => runClawbotAcceptance({ ...options, ...changes }, {
      host, store, now: () => currentTime, sleep: async (ms) => { currentTime += ms; },
    }),
  };
}

test("inspect writes a redacted readiness report without a send claim", async (t) => {
  const f = fixture(t);
  const report = await f.run({ command: "inspect" });
  assert.equal(report.status, "ready");
  assert.equal(f.state.posts, 0);
  assert.equal(f.store.readAttempt(RUN), null);
  assert.equal(report.evidenceTier, "local-fixture");
  assert.equal(statSync(report.reportPath).mode & 0o777, 0o600);
});

test("single send binds marker, audit and SDK client receipt and repeated invocation never reposts", async (t) => {
  const f = fixture(t);
  const first = await f.run();
  assert.equal(first.status, "passed");
  assert.equal(first.coverage.independentUpstreamReceipt, "unavailable_in_current_sdk");
  assert.equal(first.coverage.contextExpiryLive, "not_run_requires_real_expiry");
  assert.equal(first.postAttemptsThisInvocation, 1);
  assert.equal(f.state.payload.source, "manual-test:clawbot:" + RUN);
  assert.match(f.state.payload.summary, /manual-test/u);
  assert.equal(f.state.payload.severity, "warning");
  assert.equal(f.state.payload.eventId, "clawbot-acceptance:" + RUN);
  const bytes = readFileSync(join(f.directory, RUN + ".attempt.json"));
  const again = await f.run();
  assert.equal(again.status, "passed");
  assert.equal(again.postAttemptsThisInvocation, 0);
  assert.equal(f.state.posts, 1);
  assert.deepEqual(readFileSync(join(f.directory, RUN + ".attempt.json")), bytes);
  const text = readFileSync(again.reportPath, "utf8");
  assert.doesNotMatch(text, /fixture-owner|fixture-sender|fixture-provider-client-id|fixture-cursor/u);
});

test("lost HTTP response reconciles the already-sent row without a second POST", async (t) => {
  const credentialValue = randomBytes(24).toString("hex");
  const f = fixture(t, { afterSubmit() { throw new Error(["Bearer", credentialValue].join(" ")); } });
  const first = await f.run();
  assert.equal(first.status, "passed");
  assert.equal(first.intake.outcome, "unknown_observe_only_no_resubmit");
  await f.run();
  assert.equal(f.state.posts, 1);
  assert.equal(readFileSync(first.reportPath, "utf8").includes(credentialValue), false);
});

test("later inbound activity cannot overwrite the first successful evidence file", async (t) => {
  const f = fixture(t); await f.run();
  const passedPath = join(f.directory, RUN + ".passed.json");
  const proof = readFileSync(passedPath);
  f.state.snapshot.inbound.count += 1;
  const later = await f.run();
  assert.equal(later.code, "CLAWBOT_NEW_INBOUND_OBSERVED");
  assert.deepEqual(readFileSync(passedPath), proof);
  assert.equal(f.state.posts, 1);
});

test("journal evidence requires the original cursor and rejects gaps or truncated windows", () => {
  const anchor = { __CURSOR: "anchor", MESSAGE: "[weixin] category=inbound status=received" };
  assert.equal(projectClawbotJournal([anchor], "anchor").inboundCount, 0);
  assert.equal(projectClawbotJournal([anchor, { __CURSOR: "next", MESSAGE: "[weixin] category=inbound types=text status=received durationMs=0" }], "anchor").inboundCount, 1);
  assert.throws(() => projectClawbotJournal([], "anchor"), { code: "CLAWBOT_JOURNAL_WINDOW_UNAVAILABLE" });
  assert.throws(() => projectClawbotJournal([{ __CURSOR: "vacuumed-nearby" }], "anchor"));
  assert.throws(() => projectClawbotJournal(Array.from({ length: 2001 }, () => anchor), "anchor"));
});

test("unknown submission with no row is bounded and permanently observe-only", async (t) => {
  const f = fixture(t, { afterSubmit(state) {
    state.snapshot.outbox = null; state.snapshot.audits = [];
    throw new Error("unknown provider result");
  } });
  const first = await f.run();
  assert.equal(first.code, "CLAWBOT_BOUNDED_WAIT_EXPIRED");
  assert.equal(Date.parse(first.finishedAt) - Date.parse(first.startedAt), 1000);
  const second = await f.run();
  assert.equal(second.postAttemptsThisInvocation, 0);
  assert.equal(f.state.posts, 1);
});

test("concurrent invocations take one durable send claim", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.run(), f.run()]);
  assert.equal(f.state.posts, 1);
  assert.equal(results.reduce((count, report) => count + report.postAttemptsThisInvocation, 0), 1);
  assert.ok(f.store.readAttempt(RUN));
});

test("observe without a checkpoint never submits", async (t) => {
  const f = fixture(t);
  const report = await f.run({ command: "observe" });
  assert.equal(report.code, "CLAWBOT_ATTEMPT_NOT_FOUND");
  assert.equal(f.state.posts, 0);
});

for (const [name, mutate, expected] of [
  ["wrong release", (s) => { s.identity.sourceCommit = "c".repeat(40); }, "CLAWBOT_RELEASE_COMMIT_MISMATCH"],
  ["multiple admins", (s) => { s.target.count = 2; }, "CLAWBOT_REQUIRES_SINGLE_ADMIN_TARGET"],
  ["no admin", (s) => { s.target.count = 0; }, "CLAWBOT_REQUIRES_SINGLE_ADMIN_TARGET"],
  ["context missing", (s) => { s.context = { exists: false }; }, "CLAWBOT_CONTEXT_MISSING"],
  ["context expired", (s) => { s.context.expiresAt = new Date(START - 1).toISOString(); }, "CLAWBOT_CONTEXT_EXPIRING"],
  ["context expires during observation", (s) => { s.context.expiresAt = new Date(START + 5000).toISOString(); }, "CLAWBOT_CONTEXT_EXPIRING"],
  ["worker not ready", (s) => { s.readiness.status = "not_ready"; }, "CLAWBOT_WORKER_NOT_READY"],
  ["stale worker", (s) => { s.readiness.reportedAt = new Date(START - 31_000).toISOString(); }, "CLAWBOT_READINESS_STALE"],
  ["fresh context", (s) => { s.context.modifiedAtMs = START; }, "CLAWBOT_QUIET_WINDOW_NOT_MET"],
  ["historical queued backlog", (s) => { s.backlog.queued = 2; }, "CLAWBOT_EXISTING_BACKLOG"],
  ["active worker lease", (s) => { s.backlog.processing = 1; }, "CLAWBOT_EXISTING_BACKLOG"],
]) {
  test(`pre-send fails closed: ${name}`, async (t) => {
    const f = fixture(t); mutate(f.state.snapshot);
    const report = await f.run();
    assert.equal(report.code, expected);
    assert.equal(f.state.posts, 0);
    assert.equal(f.store.readAttempt(RUN), null);
  });
}

for (const [name, mutate, expected] of [
  ["new inbound event", (s) => { s.inbound.count += 1; }, "CLAWBOT_NEW_INBOUND_OBSERVED"],
  ["inbound journal entry", (s) => { s.journalInboundCount = 1; }, "CLAWBOT_NEW_INBOUND_OBSERVED"],
  ["context rotation", (s) => { s.context.sha256 = "c".repeat(64); }, "CLAWBOT_CONTEXT_CHANGED"],
  ["worker restart", (s) => { s.identity.runtime.worker.pid += 1; }, "CLAWBOT_RUNTIME_BINDING_CHANGED"],
  ["missing provider ID", (s) => { s.outbox.providerMessageIdSha256 = null; }, "CLAWBOT_SEND_PROOF_INCOMPLETE"],
  ["wrong provider ID", (s) => { s.outbox.providerClientIdMatches = false; }, "CLAWBOT_SEND_PROOF_INCOMPLETE"],
  ["retry occurred", (s) => { s.outbox.attemptCount = 1; }, "CLAWBOT_SEND_PROOF_INCOMPLETE"],
  ["missing audit", (s) => { s.audits = []; }, "CLAWBOT_INTAKE_AUDIT_INCOMPLETE"],
  ["missing journal", (s) => { s.journalChecked = false; }, "CLAWBOT_JOURNAL_PROOF_MISSING"],
]) {
  test(`post-send cannot overclaim: ${name}`, async (t) => {
    const f = fixture(t, { afterSubmit(state) { mutate(state.snapshot); } });
    const report = await f.run();
    assert.equal(report.status, "pending"); assert.equal(report.code, expected);
    assert.equal(f.state.posts, 1);
    await f.run(); assert.equal(f.state.posts, 1);
  });
}

test("send failure preserves queued work and never asks the runner to retry", async (t) => {
  const f = fixture(t, { afterSubmit(state) {
    state.snapshot.outbox.status = "queued";
    state.snapshot.outbox.sentAt = null;
    state.snapshot.outbox.attemptCount = 1;
    state.snapshot.outbox.lastErrorCode = "WEIXIN_SEND_FAILED";
  } });
  const report = await f.run();
  assert.equal(report.code, "CLAWBOT_WORKER_FAILURE_OBSERVED");
  assert.equal(report.after.outbox.status, "queued");
  await f.run(); assert.equal(f.state.posts, 1);
});

test("pre-send recheck rejects context rotation before claiming any side effect", async (t) => {
  const f = fixture(t, { beforeSnapshot(state) {
    if (state.snapshots === 2) state.snapshot.context.sha256 = "d".repeat(64);
  } });
  const report = await f.run();
  assert.equal(report.code, "CLAWBOT_CONTEXT_CHANGED");
  assert.equal(f.state.posts, 0);
  assert.equal(f.store.readAttempt(RUN), null);
});

test("an existing marker without original evidence is observed, never sent again", async (t) => {
  const f = fixture(t); f.state.snapshot.outbox = { id: "history", status: "sent" };
  const report = await f.run();
  assert.equal(report.code, "CLAWBOT_EXISTING_EVENT_WITHOUT_CHECKPOINT");
  assert.equal(f.state.posts, 0);
});

test("a previous release's checkpoint cannot be rebound to another commit", async (t) => {
  const f = fixture(t); await f.run();
  const report = await f.run({ sourceCommit: "e".repeat(40) });
  assert.equal(report.code, "CLAWBOT_ATTEMPT_BINDING_MISMATCH");
  assert.equal(f.state.posts, 1);
});

test("store rejects symlink and non-private checkpoint files", (t) => {
  const f = fixture(t);
  const target = join(f.directory, "elsewhere.json");
  writeFileSync(target, "{}", { mode: 0o600 });
  const attempt = join(f.directory, RUN + ".attempt.json");
  symlinkSync(target, attempt);
  assert.throws(() => f.store.readAttempt(RUN));
  rmSync(attempt);
  writeFileSync(attempt, "{}", { mode: 0o600 }); chmodSync(attempt, 0o644);
  assert.throws(() => f.store.readAttempt(RUN), { code: "CLAWBOT_UNSAFE_INPUT_FILE" });
});

test("CLI requires explicit binding, refuses shell-style --emit and secret flags", () => {
  const args = ["send-once", "--release=/opt/sentelligent-sales-workbench/releases/candidate", "--source-commit=" + COMMIT,
    "--context-file=/opt/sentelligent-sales-workbench/weixin-session/account.context.json", "--run-id=" + RUN];
  assert.equal(parseClawbotArguments(args).timeoutMs, 90_000);
  for (const extra of ["--emit", "--token=secret", "--timeout-seconds=0", "--timeout-seconds=301", "--run-id=other-run"]) {
    assert.throws(() => parseClawbotArguments([...args, extra]));
  }
  assert.throws(() => parseClawbotArguments(["--emit"]));
  assert.deepEqual(parseClawbotArguments(["--help"]), { help: true });
});

test("production adapter cannot execute on a developer Mac", { skip: process.platform === "linux" }, () => {
  assert.throws(() => createProductionClawbotHost({}), { code: "CLAWBOT_REQUIRES_LINUX_ROOT_NODE24" });
});

test("production DB boundary accepts only contract BUSINESS_DATABASE, including its file URL", () => {
  assert.equal(BUSINESS_DATABASE, "/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite");
  const touched = [];
  const realpath = (path) => { touched.push(path); return path; };
  assert.equal(resolveClawbotBusinessDatabase({}, { realpath }), BUSINESS_DATABASE);
  assert.equal(resolveClawbotBusinessDatabase({ databaseUrl: BUSINESS_DATABASE }, { realpath }), BUSINESS_DATABASE);
  assert.equal(resolveClawbotBusinessDatabase({ databasePath: BUSINESS_DATABASE, databaseUrl: "file://" + BUSINESS_DATABASE }, { realpath }), BUSINESS_DATABASE);
  assert.deepEqual(touched, [BUSINESS_DATABASE, BUSINESS_DATABASE, BUSINESS_DATABASE]);
  for (const path of [
    "/opt/sentelligent-sales-workbench/data/sales-workbench.sqlite",
    "/var/lib/sentelligent-ai-platform/ai-platform.sqlite",
    BUSINESS_DATABASE + ".backup", BUSINESS_DATABASE + "/other",
    "/var/lib/sentelligent-sales-workbench/other.sqlite", "./sales-workbench.sqlite", ":memory:",
    "/var/lib/sentelligent-sales-workbench/../sales-workbench.sqlite",
  ]) {
    assert.throws(() => resolveClawbotBusinessDatabase({ databasePath: path }, { realpath }), { code: "CLAWBOT_DATABASE_PATH_INVALID" });
    assert.throws(() => resolveClawbotBusinessDatabase({ databaseUrl: path, databasePath: BUSINESS_DATABASE }, { realpath }), { code: "CLAWBOT_DATABASE_PATH_INVALID" });
  }
  assert.equal(touched.length, 3, "invalid lexical paths must not be read");
  assert.throws(() => resolveClawbotBusinessDatabase({}, { realpath: () => "/tmp/redirect.sqlite" }), { code: "CLAWBOT_DATABASE_PATH_INVALID" });
});

test("mock host preflight reaches ready with the actual production DB path", async (t) => {
  const f = fixture(t, { beforeSnapshot(state) {
    state.snapshot.identity.businessDatabase = resolveClawbotBusinessDatabase({ databaseUrl: BUSINESS_DATABASE }, { realpath: (path) => path });
  } });
  const report = await f.run({ command: "inspect" });
  assert.equal(report.status, "ready");
  assert.equal(report.before.identity.businessDatabase, BUSINESS_DATABASE);
  assert.equal(f.state.posts, 0);
});

test("DB identity and top-level health contract match production-smoke-cleanup", (t) => {
  const f = fixture(t);
  const databaseUrl = join(f.directory, "identity.sqlite");
  const db = new DatabaseSync(databaseUrl); db.close();
  const secret = randomBytes(32).toString("hex");
  const identity = createDatabaseIdentity({ databaseUrl, secret });
  const existing = readProductionDatabaseIdentity({ databaseUrl, authSessionSecret: secret });
  assert.equal(existing.databaseIdentity, identity);
  assert.equal(existing.databasePath, databaseUrl);
  assert.match(identity, /^[A-Za-z0-9_-]{43}$/u);
  const health = { status: 200, body: { status: "ok", database: "ready", databaseIdentity: identity } };
  assert.doesNotThrow(() => assertClawbotDatabaseHealth(health, existing.databaseIdentity));
  for (const bad of [
    { status: 200, body: { item: health.body } },
    { status: 200, body: { ...health.body, databaseIdentity: "x".repeat(43) } },
    { status: 200, body: { ...health.body, database: "not_ready" } },
    { status: 503, body: health.body },
  ]) assert.throws(() => assertClawbotDatabaseHealth(bad, identity), { code: "CLAWBOT_DATABASE_HEALTH_BINDING_MISMATCH" });
  assert.throws(() => createDatabaseIdentity({ databaseUrl, secret: randomBytes(5).toString("hex") }));
});

test("bindings query executes against actual migrations and matches listAdminTargets", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    for (const [account, role] of [["admina", "admin"], ["adminb", "admin"], ["inactiveuser", "admin"], ["disabledbinding", "admin"], ["member", "member"]]) {
      seedWeixinBinding(db, { account, senderId: "sender-" + account, role, digestEnabled: false });
    }
    db.prepare("UPDATE users SET status = 'disabled' WHERE account = 'inactiveuser'").run();
    db.prepare("UPDATE weixin_bindings SET status = 'disabled' WHERE account = 'disabledbinding'").run();
    const actual = readClawbotAdminTargets(db).map((row) => ({ account: row.account, senderId: row.sender_id }));
    const expected = createWeixinBindingsRepository(db).listAdminTargets().map(({ account, senderId }) => ({ account, senderId }));
    assert.deepEqual(actual, expected);
    assert.deepEqual(actual.map((row) => row.account), ["admina", "adminb"]);
  } finally { db.close(); }
});

test("real outbox and intake fixture dedupe the unique manual marker across an hour boundary", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateOutbox(db);
    let time = START;
    const clock = () => new Date(time);
    const repository = createWeixinConfirmationOutboxRepository(db, { clock });
    const audits = [];
    const service = createOpsAlertService({ outboxRepository: repository,
      resolveDeliveries: () => [{ account: "fixture", conversationId: "fixture-conversation" }],
      recordAudit: (audit) => audits.push(audit), clock });
    const body = manualTestPayload(RUN, new Date(START).toISOString());
    const first = await service.receive(body, { actor: "fixture-ops" });
    time += 3600_000;
    const again = await service.receive(body, { actor: "fixture-ops" });
    assert.equal(first.item.id, again.item.id);
    assert.equal(again.item.replayed, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM weixin_confirmation_outbox").get().n, 1);
    assert.equal(audits[0].metadata.delivery, "weixin_outbox");
  } finally { db.close(); }
});

test("real worker fixture defers expired context without sending or charging an attempt", { timeout: 3000 }, async () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateOutbox(db);
    const repository = createWeixinConfirmationOutboxRepository(db, { clock: () => new Date(START) });
    repository.enqueue({ id: "expired-fixture", owner: "fixture", conversationId: "conversation",
      idempotencyKey: "expiry", payload: { kind: "ops_alert", origin: "manual-test", severity: "warning", summary: "fixture" } });
    const controller = new AbortController();
    let sends = 0;
    await runWeixinOutboxPump({
      client: {
        async lease() { return repository.leaseNext({ workerId: "fixture-worker", renderMessage: () => "fixture" }); },
        async ack() { assert.fail("ordinary ack must not run on expiry"); },
        async isCurrent() { return true; },
        async releaseLeaseWithoutAttempt({ id, leaseToken }) {
          repository.releaseLeaseWithoutAttempt(id, { leaseToken }); controller.abort();
        },
      },
      bot: { getDeliveryStatus() { return { ready: false, status: "not_ready", reason: "context_token_expired", expiresAt: new Date(START - 1).toISOString() }; },
        async sendMessage() { sends += 1; } },
      abortSignal: controller.signal, clock: () => START, pollMs: 500,
    });
    const row = db.prepare("SELECT status, attempt_count, last_error_code FROM weixin_confirmation_outbox").get();
    assert.deepEqual({ ...row }, { status: "queued", attempt_count: 0, last_error_code: "WEIXIN_CONTEXT_EXPIRED" });
    assert.equal(sends, 0);
  } finally { db.close(); }
});

test("real worker fixture paces two messages and preserves the provider IDs it actually receives", async () => {
  const controller = new AbortController();
  const delays = [], acknowledgements = [];
  let index = 0;
  await runWeixinOutboxPump({
    client: {
      async lease() { index += 1; return { item: { id: String(index), message: "fixture" }, leaseToken: randomBytes(16).toString("hex") }; },
      async isCurrent() { return true; },
      async ack(value) { acknowledgements.push(value); if (acknowledgements.length === 2) controller.abort(); },
    },
    bot: { getDeliveryStatus() { return { ready: true, status: "ready" }; },
      async sendMessage(_message, id) { return { messageId: "fixture-client:" + id }; } },
    pollMs: 500, sendDelayMs: 1000, sleepImpl: async (ms) => delays.push(ms), abortSignal: controller.signal,
  });
  assert.deepEqual(delays, [1000]);
  assert.deepEqual(acknowledgements.map((item) => item.providerMessageId), ["fixture-client:1", "fixture-client:2"]);
});
