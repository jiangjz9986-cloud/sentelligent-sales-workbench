import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAiPlatformDatabase } from "../src/db/index.js";
import { createScheduleService } from "../src/schedules/scheduleService.js";

const BASE_TIME = "2026-09-07T10:00:00.000Z";
const INTERVAL_SECONDS = 60;
const LEASE_MS = 2_000;

const resources = [];

function makeClock(initial = BASE_TIME) {
  let value = new Date(initial);
  return {
    now() {
      return new Date(value);
    },
    set(next) {
      value = new Date(next);
    },
    advance(milliseconds) {
      value = new Date(value.getTime() + milliseconds);
    },
  };
}

function systemIdentity() {
  return {
    issuer: "schedule-test",
    owner: "__system__",
    actor: "schedule-test",
  };
}

function registerResource({ db, service, directory = null }) {
  resources.push(() => {
    service?.close();
    db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
}

afterEach(() => {
  while (resources.length) resources.pop()();
});

function openHarness({
  clock = makeClock(),
  dbPath = ":memory:",
  createTask = null,
  readTask = null,
  identityFactory = () => systemIdentity(),
  leaseMs = LEASE_MS,
  schedulerId = "schedule-test",
  directory = null,
} = {}) {
  const db = openAiPlatformDatabase(dbPath, { clock: clock.now });
  const service = createScheduleService({
    db,
    clock: clock.now,
    createTask,
    readTask,
    identityFactory,
    leaseMs,
    pollMs: 10,
    dispatchConcurrency: 2,
    schedulerId,
    logger: { error() {}, warn() {} },
  });
  registerResource({ db, service, directory });
  return { db, service, clock };
}

function createSchedule(service, clock, overrides = {}) {
  return service.createSchedule({
    id: overrides.id ?? "schedule-test",
    slug: overrides.slug ?? "schedule-test",
    name: overrides.name ?? "Schedule test",
    taskType: overrides.taskType ?? "weekly.generate",
    feature: overrides.feature ?? "proactive-assistant",
    intervalSeconds: overrides.intervalSeconds ?? INTERVAL_SECONDS,
    enabled: overrides.enabled ?? true,
    inputTemplate: overrides.inputTemplate ?? { source: "test" },
    nextRunAt: overrides.nextRunAt ?? clock.now().toISOString(),
  });
}

function insertTask(db, taskId, {
  status = "queued",
  feature = "proactive-assistant",
  taskType = "weekly.generate",
} = {}) {
  const at = BASE_TIME;
  db.prepare(`
    INSERT INTO tasks (
      id, request_id, issuer, owner, actor, channel, feature, task_type,
      subject_type, subject_id, priority, input_json, evidence_digest,
      request_hash, idempotency_key, agent_version_id, model_id,
      standard_digest, status, source, requested_at, updated_at
    ) VALUES (
      $id, $requestId, 'schedule-test', '__system__', 'schedule-test', 'worker',
      $feature, $taskType, 'schedule', 'schedule-test', 'background',
      '{}', NULL, $requestHash, $idempotencyKey, 'agent-proactive-v1',
      'model-mock-standard-v1', 'standard-digest', $status, 'model', $at, $at
    )
  `).run({
    $id: taskId,
    $requestId: `request-${taskId}`,
    $feature: feature,
    $taskType: taskType,
    $requestHash: `hash-${taskId}`,
    $idempotencyKey: `key-${taskId}`,
    $status: status,
    $at: at,
  });
  return taskId;
}

function taskCreatorFor(db, { prefix = "scheduled", status = "queued", calls = [], beforeCreate = null } = {}) {
  const getDb = typeof db === "function" ? db : () => db;
  return async (args) => {
    calls.push(args);
    if (beforeCreate) await beforeCreate(args);
    const taskId = `${prefix}-${calls.length}`;
    insertTask(getDb(), taskId);
    return { taskId, status, replayed: false };
  };
}

describe("AI platform schedule service", () => {
  it("keeps proactive scheduling disabled because backend owns proactive analysis", () => {
    const clock = makeClock();
    const harness = openHarness({ clock });

    assert.throws(
      () => createSchedule(harness.service, clock, {
        id: "proactive-enabled",
        slug: "proactive-enabled",
        taskType: "proactive.analyze",
        enabled: true,
      }),
      (error) => error?.code === "proactive_schedule_owned_by_backend" && error?.status === 409,
    );

    const disabled = createSchedule(harness.service, clock, {
      id: "proactive-disabled",
      slug: "proactive-disabled",
      taskType: "proactive.analyze",
      enabled: false,
    });
    assert.equal(disabled.enabled, false);
    assert.throws(
      () => harness.service.enableSchedule({ scheduleId: disabled.id }),
      (error) => error?.code === "proactive_schedule_owned_by_backend" && error?.status === 409,
    );
  });

  it("quarantines a manually enabled proactive schedule before task creation", async () => {
    const clock = makeClock();
    const calls = [];
    const harness = openHarness({
      clock,
      createTask: async (args) => {
        calls.push(args);
        throw new Error("must not create a proactive platform task");
      },
    });
    const schedule = createSchedule(harness.service, clock, {
      id: "proactive-quarantine",
      slug: "proactive-quarantine",
      taskType: "proactive.analyze",
      enabled: false,
    });
    harness.db.prepare(`
      UPDATE schedules
         SET enabled = 1, next_run_at = $nextRunAt
       WHERE id = $id
    `).run({ $nextRunAt: BASE_TIME, $id: schedule.id });

    const result = await harness.service.scanDue();
    assert.equal(calls.length, 0);
    assert.equal(result.claimed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.skippedRuns[0].reason, "proactive_schedule_owned_by_backend");
    assert.equal(harness.service.readSchedule(schedule.id).enabled, false);
    assert.equal(
      harness.db.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action = 'schedule.proactive_owner_blocked'").get().count,
      1,
    );
  });

  it("keeps queued and running non-terminal, then reconciles to a terminal state", async () => {
    const clock = makeClock();
    const calls = [];
    const responses = new Map();
    let harness;
    const creator = taskCreatorFor(() => harness.db, { calls, prefix: "lifecycle" });
    harness = openHarness({
      clock,
      createTask: creator,
      readTask: async ({ taskId }) => ({
        taskId,
        status: responses.get(taskId) ?? "queued",
      }),
    });
    createSchedule(harness.service, clock);
    const first = await harness.service.scanDue();
    assert.equal(first.claimed, 1);
    assert.equal(first.dispatched, 1);
    assert.equal(calls.length, 1);

    const taskId = "lifecycle-1";
    const runId = harness.db.prepare("SELECT id FROM schedule_runs LIMIT 1").get().id;
    let row = harness.db.prepare("SELECT * FROM schedule_runs WHERE id = $id").get({ $id: runId });
    assert.equal(row.task_id, taskId);
    assert.equal(row.status, "queued");
    assert.equal(row.completed_at, null);

    responses.set(taskId, "running");
    const running = await harness.service.reconcileRuns();
    assert.equal(running.reconciled, 1);
    row = harness.db.prepare("SELECT * FROM schedule_runs WHERE id = $id").get({ $id: runId });
    assert.equal(row.status, "running");
    assert.equal(row.completed_at, null);

    responses.set(taskId, "succeeded");
    const succeeded = await harness.service.reconcileRuns();
    assert.equal(succeeded.reconciled, 1);
    row = harness.db.prepare("SELECT * FROM schedule_runs WHERE id = $id").get({ $id: runId });
    assert.equal(row.status, "succeeded");
    assert.equal(row.completed_at, BASE_TIME);

    responses.set(taskId, "failed");
    const terminalReplay = await harness.service.reconcileRuns();
    assert.equal(terminalReplay.reconciled, 0);
    row = harness.db.prepare("SELECT * FROM schedule_runs WHERE id = $id").get({ $id: runId });
    assert.equal(row.status, "succeeded");
    assert.equal(
      harness.db.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE resource_id = $id AND action IN ('schedule.run_queued', 'schedule.run_running', 'schedule.run_succeeded')").get({ $id: runId }).count,
      3,
    );
  });

  it("deduplicates the same schedule occurrence by schedule_id and dedupe_key", () => {
    const clock = makeClock();
    const harness = openHarness({ clock });
    createSchedule(harness.service, clock);

    const first = harness.service.claimDueOccurrences({ at: BASE_TIME });
    assert.equal(first.claims.length, 1);
    const runId = first.claims[0].runId;
    harness.db.prepare("UPDATE schedules SET next_run_at = $nextRunAt WHERE id = $id").run({
      $nextRunAt: BASE_TIME,
      $id: "schedule-test",
    });

    const second = harness.service.claimDueOccurrences({ at: BASE_TIME });
    assert.equal(second.claims.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.skipped[0].reason, "duplicate");
    assert.equal(second.skipped[0].runId, runId);
    assert.equal(
      Number(harness.db.prepare("SELECT COUNT(*) AS count FROM schedule_runs WHERE schedule_id = ? AND dedupe_key = ?").get("schedule-test", "interval:" + BASE_TIME).count),
      1,
    );
    assert.equal(
      Number(harness.db.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action = 'schedule.run_deduplicated'").get().count),
      1,
    );
  });

  it("accepts a direct running task response without marking the run complete", async () => {
    const clock = makeClock();
    const calls = [];
    let harness;
    const creator = taskCreatorFor(() => harness.db, { calls, prefix: "direct-running", status: "running" });
    harness = openHarness({
      clock,
      createTask: creator,
    });
    createSchedule(harness.service, clock);

    await harness.service.scanDue();
    const run = harness.db.prepare("SELECT * FROM schedule_runs LIMIT 1").get();
    assert.equal(run.status, "running");
    assert.equal(run.task_id, "direct-running-1");
    assert.equal(run.completed_at, null);
  });

  it("does not regress an attached running run from an older queued reconciliation", async () => {
    const clock = makeClock();
    let releaseQueued;
    let queuedStarted;
    const queuedGate = new Promise((resolve) => { releaseQueued = resolve; });
    const started = new Promise((resolve) => { queuedStarted = resolve; });
    let reads = 0;
    const harness = openHarness({
      clock,
      readTask: async ({ taskId }) => {
        reads += 1;
        if (reads === 1) {
          queuedStarted();
          await queuedGate;
          return { taskId, status: "queued" };
        }
        return { taskId, status: "running" };
      },
    });
    createSchedule(harness.service, clock);
    const claim = harness.service.claimDueOccurrences({ at: BASE_TIME }).claims[0];
    insertTask(harness.db, "attached-running-task");
    harness.db.prepare("UPDATE schedule_runs SET task_id = $taskId WHERE id = $id").run({
      $taskId: "attached-running-task",
      $id: claim.runId,
    });

    const olderQueued = harness.service.reconcileRuns();
    await started;
    const running = await harness.service.reconcileRuns();
    releaseQueued();
    const queuedResult = await olderQueued;

    assert.equal(running.reconciled, 0);
    assert.equal(queuedResult.reconciled, 0);
    const row = harness.db.prepare("SELECT * FROM schedule_runs WHERE id = $id").get({ $id: claim.runId });
    assert.equal(row.status, "running");
    assert.equal(row.completed_at, null);
  });

  it("does not create a task when a schedule is paused during async dispatch setup", async () => {
    const clock = makeClock();
    let resolveEntered;
    const entered = new Promise((resolve) => { resolveEntered = resolve; });
    let releaseIdentity;
    const identityGate = new Promise((resolve) => { releaseIdentity = resolve; });
    const calls = [];
    const harness = openHarness({
      clock,
      identityFactory: async () => {
        resolveEntered();
        await identityGate;
        return systemIdentity();
      },
      createTask: async () => {
        calls.push("created");
        throw new Error("creator should not run while paused");
      },
      schedulerId: "schedule-paused",
    });
    createSchedule(harness.service, clock);

    const scanPromise = harness.service.scanDue();
    await entered;
    harness.service.disableSchedule({ scheduleId: "schedule-test" });
    releaseIdentity();
    const result = await scanPromise;

    assert.equal(calls.length, 0);
    assert.equal(result.skipped, 1);
    const run = harness.db.prepare("SELECT * FROM schedule_runs LIMIT 1").get();
    assert.equal(run.status, "skipped");
    assert.equal(run.task_id, null);
    assert.ok(run.completed_at);
    assert.equal(harness.service.readSchedule("schedule-test").enabled, false);
  });

  it("records a safe failed run and audit when task creation fails", async () => {
    const clock = makeClock();
    const rawMessage = "provider secret and internal path must not escape";
    const harness = openHarness({
      clock,
      createTask: async () => {
        throw new Error(rawMessage);
      },
    });
    createSchedule(harness.service, clock);

    await harness.service.scanDue();
    const run = harness.db.prepare("SELECT * FROM schedule_runs LIMIT 1").get();
    assert.equal(run.status, "failed");
    assert.equal(run.error_code, "schedule_dispatch_failed");
    assert.equal(run.task_id, null);
    assert.ok(run.completed_at);
    const audit = harness.db.prepare(`
      SELECT after_json
        FROM admin_audit
       WHERE resource_type = 'schedule_run'
         AND resource_id = $resourceId
         AND action = 'schedule.run_failed'
       ORDER BY id DESC
       LIMIT 1
    `).get({ $resourceId: run.id });
    assert.ok(audit);
    assert.match(audit.after_json, /scheduled task dispatch failed/);
    assert.equal(audit.after_json.includes(rawMessage), false);
    assert.equal(harness.service.readSchedule("schedule-test").lastError, "scheduled task dispatch failed");
  });

  it("reclaims a stale run and fences the old lease from completing it", async () => {
    const clock = makeClock();
    let releaseReader;
    let readerStarted;
    const readerGate = new Promise((resolve) => { releaseReader = resolve; });
    const started = new Promise((resolve) => { readerStarted = resolve; });
    let reads = 0;
    const harness = openHarness({
      clock,
      readTask: async ({ taskId }) => {
        reads += 1;
        if (reads === 1) {
          readerStarted();
          await readerGate;
        }
        return { taskId, status: "succeeded" };
      },
    });
    createSchedule(harness.service, clock);
    const claim = harness.service.claimDueOccurrences({ at: BASE_TIME }).claims[0];
    insertTask(harness.db, "stale-task");
    harness.db.prepare("UPDATE schedule_runs SET task_id = $taskId WHERE id = $id").run({
      $taskId: "stale-task",
      $id: claim.runId,
    });

    const oldReconcile = harness.service.reconcileRuns();
    await started;
    clock.advance(LEASE_MS + 1);
    const recovered = harness.service.recoverStaleRuns({ at: clock.now().toISOString() });
    assert.equal(recovered.claims.length, 1);
    assert.equal(recovered.claims[0].runId, claim.runId);
    assert.notEqual(recovered.claims[0].leaseStartedAt, claim.leaseStartedAt);

    releaseReader();
    const oldResult = await oldReconcile;
    assert.equal(oldResult.reconciled, 0);
    assert.equal(oldResult.runs.length, 0);
    let row = harness.db.prepare("SELECT * FROM schedule_runs WHERE id = $id").get({ $id: claim.runId });
    assert.equal(row.status, "running");
    assert.equal(row.started_at, recovered.claims[0].leaseStartedAt);
    assert.equal(row.completed_at, null);

    const newResult = await harness.service.reconcileRuns();
    assert.equal(newResult.reconciled, 1);
    row = harness.db.prepare("SELECT * FROM schedule_runs WHERE id = $id").get({ $id: claim.runId });
    assert.equal(row.status, "succeeded");
    assert.equal(row.completed_at, clock.now().toISOString());
    assert.equal(Number(harness.db.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action = 'schedule.run_reclaimed'").get().count), 1);
  });

  it("fences an old dispatch completion after a no-task stale reclaim", async () => {
    const clock = makeClock();
    let releaseCreator;
    let creatorStarted;
    const creatorGate = new Promise((resolve) => { releaseCreator = resolve; });
    const started = new Promise((resolve) => { creatorStarted = resolve; });
    const calls = [];
    let harness;
    harness = openHarness({
      clock,
      createTask: async ({ run }) => {
        calls.push(run.id);
        creatorStarted();
        await creatorGate;
        insertTask(harness.db, "late-task");
        return { taskId: "late-task", status: "queued" };
      },
      identityFactory: () => systemIdentity(),
    });
    createSchedule(harness.service, clock);

    const oldScan = harness.service.scanDue();
    await started;
    clock.advance(LEASE_MS + 1);
    const recovered = harness.service.recoverStaleRuns({ at: clock.now().toISOString() });
    assert.equal(recovered.claims.length, 1);
    releaseCreator();
    await oldScan;

    const run = harness.db.prepare("SELECT * FROM schedule_runs LIMIT 1").get();
    assert.equal(calls.length, 1);
    assert.equal(run.status, "running");
    assert.equal(run.task_id, null);
    assert.equal(run.started_at, recovered.claims[0].leaseStartedAt);
  });

  it("allows only one claim when two scheduler instances scan concurrently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-schedule-race-"));
    const dbPath = join(directory, "schedule.sqlite");
    const clock = makeClock();
    const db1 = openAiPlatformDatabase(dbPath, { clock: clock.now });
    const db2 = openAiPlatformDatabase(dbPath, { clock: clock.now });
    const calls = [];
    const service1 = createScheduleService({
      db: db1,
      clock: clock.now,
      createTask: taskCreatorFor(db1, { calls, prefix: "race-one" }),
      identityFactory: () => systemIdentity(),
      leaseMs: LEASE_MS,
      pollMs: 10,
      schedulerId: "race-one",
      logger: { error() {}, warn() {} },
    });
    const service2 = createScheduleService({
      db: db2,
      clock: clock.now,
      createTask: taskCreatorFor(db2, { calls, prefix: "race-two" }),
      identityFactory: () => systemIdentity(),
      leaseMs: LEASE_MS,
      pollMs: 10,
      schedulerId: "race-two",
      logger: { error() {}, warn() {} },
    });
    registerResource({ db: db1, service: service1 });
    registerResource({ db: db2, service: service2, directory });
    createSchedule(service1, clock);

    const [first, second] = await Promise.all([service1.scanDue(), service2.scanDue()]);
    const runCount = Number(db1.prepare("SELECT COUNT(*) AS count FROM schedule_runs").get().count);
    assert.equal(runCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(first.claimed + second.claimed, 1);
    assert.equal(first.dispatched + second.dispatched, 1);
    assert.equal(Number(db1.prepare("SELECT COUNT(DISTINCT dedupe_key) AS count FROM schedule_runs").get().count), 1);
  });
});
