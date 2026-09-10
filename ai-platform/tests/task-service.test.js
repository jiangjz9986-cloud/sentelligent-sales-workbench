import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openAiPlatformDatabase } from "../src/db/index.js";
import { loadAiPlatformConfig } from "../src/config.js";
import { createProviderRegistry, mockProvider } from "../src/providers/mockProvider.js";
import { createTaskService } from "../src/tasks/taskService.js";

const BASE_TIME = "2026-09-07T10:00:00.000Z";

function identity(owner, extra = {}) {
  return {
    issuer: "test-service",
    owner,
    actor: owner,
    ...extra,
  };
}

function validRequest(input = { text: "hello" }, overrides = {}) {
  return {
    taskType: "quick-record.analyze",
    feature: "quick-record",
    channel: "web",
    priority: "interactive",
    input,
    ...overrides,
  };
}

function successfulResponse(taskId = "task-test") {
  return {
    externalRequestId: `external-${taskId}`,
    result: {
      schemaVersion: "ai-task-result-v1",
      status: "success",
      source: "model",
      facts: [{ key: "ok", value: true, confidence: 100 }],
      inferences: [],
      unknowns: [],
      suggestions: [],
      sourceRefs: [{ type: "test", id: taskId }],
      writebackPreview: { requiresHumanConfirmation: true, actions: [] },
      metadata: {},
    },
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 0,
      audioSeconds: 0,
      imagePages: 0,
    },
  };
}

let db;
let service;
let currentTime;

function createService(provider = mockProvider, overrides = {}) {
  currentTime = new Date(BASE_TIME);
  db = openAiPlatformDatabase(":memory:", { clock: () => currentTime });
  const config = loadAiPlatformConfig({
    databasePath: ":memory:",
    taskLeaseMs: 2_000,
    taskPollMs: 20,
    taskConcurrency: 2,
    ...overrides,
  });
  service = createTaskService({
    db,
    config,
    providerRegistry: createProviderRegistry({ providers: [provider] }),
    clock: () => currentTime,
    logger: { error() {}, warn() {} },
  });
  return service;
}

async function closeService() {
  await service?.close();
  service = null;
  db?.close();
  db = null;
}

afterEach(async () => {
  await closeService();
});

describe("AI platform task service", () => {
  it("enforces global concurrency across two executors and different owners", async () => {
    let finish;
    createService({
      ...mockProvider,
      async execute() {
        await new Promise((resolve) => { finish = resolve; });
        return successfulResponse("global-concurrency");
      },
    }, { taskConcurrency: 1 });
    service.createTask({ identity: identity("alice"), idempotencyKey: "concurrency-a", request: validRequest() });
    service.createTask({ identity: identity("bob"), idempotencyKey: "concurrency-b", request: validRequest() });
    const pending = service.runPending();
    const other = createTaskService({
      db, config: loadAiPlatformConfig({ databasePath: ":memory:", taskConcurrency: 1 }),
      providerRegistry: createProviderRegistry(), clock: () => currentTime,
    });
    try {
      assert.equal((await other.runPending()).claimed, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM tasks WHERE status='running'").get().n, 1);
    } finally {
      finish();
      await pending;
    }
    assert.equal((await other.runPending()).claimed, 1);
    await other.close();
  });

  it("preserves the price currency and reservation when a paid lease expires", async () => {
    let finish;
    let calls = 0;
    createService({
      ...mockProvider, kind: "openai_compatible",
      async execute() {
        calls += 1;
        await new Promise((resolve) => { finish = resolve; });
        return successfulResponse("lost-paid-lease");
      },
    }, { executionMode: "external-provider", externalProvidersEnabled: true });
    db.prepare("UPDATE providers SET kind = 'openai_compatible' WHERE id = 'provider-mock'").run();
    db.prepare("UPDATE agent_versions SET model_policy_json = json_set(model_policy_json, '$.externalAllowed', json('true'))").run();
    db.prepare("UPDATE price_versions SET currency = 'CNY', input_micro_per_1k = 1000, output_micro_per_1k = 1000").run();
    db.prepare("UPDATE budget_policies SET currency = 'CNY'").run();
    const owner = identity("alice");
    const task = service.createTask({ identity: owner, idempotencyKey: "lost-paid-lease", request: validRequest() });
    const pending = service.runPending();
    try {
      currentTime = new Date(new Date(BASE_TIME).getTime() + 3_000);
      const recovered = service.recoverExpiredLeases();
      assert.equal(recovered[0].status, "expired");
      const usage = db.prepare("SELECT currency, cost_status FROM usage_ledger WHERE task_id = ?").get(task.taskId);
      assert.equal(usage.currency, "CNY");
      assert.equal(usage.cost_status, "unknown");
      const budget = db.prepare("SELECT status, actual_micro, reserved_micro FROM budget_reservations WHERE task_id = ?").get(task.taskId);
      assert.equal(budget.status, "unknown");
      assert.equal(budget.actual_micro, budget.reserved_micro);
    } finally {
      finish();
      await pending;
    }
    await service.runPending();
    assert.equal(calls, 1);
    assert.equal(service.readTask({ identity: owner, taskId: task.taskId }).status, "expired");
  });

  it("does not retry an external request with unknown charges", async () => {
    let calls = 0;
    createService({
      ...mockProvider, kind: "openai_compatible",
      async execute() {
        calls += 1;
        throw Object.assign(new Error("response lost"), { code: "network_error", retryable: true });
      },
    }, { executionMode: "external-provider", externalProvidersEnabled: true });
    db.prepare("UPDATE providers SET kind = 'openai_compatible' WHERE id = 'provider-mock'").run();
    db.prepare("UPDATE agent_versions SET model_policy_json = json_set(model_policy_json, '$.externalAllowed', json('true'))").run();
    db.prepare("UPDATE price_versions SET input_micro_per_1k = 1000, output_micro_per_1k = 1000").run();
    const owner = identity("alice");
    const task = service.createTask({ identity: owner, idempotencyKey: "unknown-external", request: validRequest() });
    await service.runPending();
    await service.runPending();
    assert.equal(calls, 1);
    assert.equal(service.readTask({ identity: owner, taskId: task.taskId }).status, "failed");
    const reservation = db.prepare("SELECT status, reserved_micro, actual_micro FROM budget_reservations WHERE task_id = ?").get(task.taskId);
    assert.equal(reservation.status, "unknown");
    assert.equal(reservation.actual_micro, reservation.reserved_micro);
    assert.ok(reservation.actual_micro > 0);
  });

  it("rejects external calls without a matching finite budget before task acceptance", () => {
    createService({ ...mockProvider, kind: "openai_compatible" }, { executionMode: "external-provider", externalProvidersEnabled: true });
    db.prepare("UPDATE providers SET kind = 'openai_compatible' WHERE id = 'provider-mock'").run();
    db.prepare("UPDATE agent_versions SET model_policy_json = json_set(model_policy_json, '$.externalAllowed', json('true'))").run();
    db.prepare("UPDATE price_versions SET currency = 'CNY'").run();
    const input = { identity: identity("alice"), idempotencyKey: "currency", request: validRequest() };
    assert.throws(() => service.createTask(input), (error) => error.code === "budget_currency_mismatch");
    db.prepare("UPDATE budget_policies SET currency = 'CNY', amount_micro = 0").run();
    assert.throws(() => service.createTask(input), (error) => error.code === "budget_not_configured");
    assert.equal(db.prepare("SELECT count(*) n FROM tasks").get().n, 0);
  });

  it("drains in-flight usage before stopping and leaves queued reservations intact", async () => {
    let finish;
    let calls = 0;
    createService({
      ...mockProvider,
      async execute() {
        calls += 1;
        await new Promise((resolve) => { finish = resolve; });
        return successfulResponse("drained");
      },
    }, { taskConcurrency: 1 });
    const owner = identity("alice");
    const first = service.createTask({ identity: owner, idempotencyKey: "drain-running", request: validRequest() });
    const queued = service.createTask({ identity: owner, idempotencyKey: "drain-queued", request: validRequest() });
    const pending = service.runPending();
    const draining = service.drain();
    assert.equal(service.status().admissionOpen, false);
    assert.equal(service.status().activeExecutions, 1);
    assert.throws(
      () => service.createTask({ identity: owner, idempotencyKey: "drain-new", request: validRequest() }),
      (error) => error.code === "service_draining" && error.status === 503,
    );
    assert.equal(service.createTask({ identity: owner, idempotencyKey: "drain-running", request: validRequest() }).replayed, true);
    finish();
    await Promise.all([pending, draining]);
    assert.equal(service.readTask({ identity: owner, taskId: first.taskId }).status, "succeeded");
    assert.equal(db.prepare("SELECT output_tokens FROM task_attempts WHERE task_id = ?").get(first.taskId).output_tokens, 20);
    assert.equal(db.prepare("SELECT status FROM budget_reservations WHERE task_id = ?").get(first.taskId).status, "settled");
    assert.equal(db.prepare("SELECT status FROM budget_reservations WHERE task_id = ?").get(queued.taskId).status, "reserved");
    assert.equal((await service.runPending()).claimed, 0);
    assert.equal(calls, 1);
  });

  it("keeps a timed-out drain paused and preserves late supplier usage", async () => {
    let finish;
    createService({
      ...mockProvider,
      async execute() {
        await new Promise((resolve) => { finish = resolve; });
        return successfulResponse("late-drain");
      },
    });
    const owner = identity("alice");
    const task = service.createTask({ identity: owner, idempotencyKey: "late-drain", request: validRequest() });
    const pending = service.runPending();
    await assert.rejects(service.drain({ timeoutMs: 10 }), (error) => error.code === "drain_timeout");
    assert.equal(service.status().paused, true);
    assert.equal(service.readTask({ identity: owner, taskId: task.taskId }).status, "running");
    assert.equal(db.prepare("SELECT status FROM budget_reservations WHERE task_id = ?").get(task.taskId).status, "reserved");
    finish();
    await pending;
    await service.drain();
    assert.equal(service.readTask({ identity: owner, taskId: task.taskId }).status, "succeeded");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_ledger WHERE task_id = ?").get(task.taskId).n, 1);
  });

  it("records usage received after abort instead of treating it as unknown", async () => {
    let finish;
    createService({
      ...mockProvider,
      async execute() {
        await new Promise((resolve) => { finish = resolve; });
        return successfulResponse("abort-usage");
      },
    });
    const owner = identity("alice");
    const task = service.createTask({ identity: owner, idempotencyKey: "abort-usage", request: validRequest() });
    const pending = service.runPending();
    const closing = service.close();
    finish();
    await Promise.all([pending, closing]);
    assert.equal(service.readTask({ identity: owner, taskId: task.taskId }).status, "cancelled");
    assert.equal(db.prepare("SELECT output_tokens FROM task_attempts WHERE task_id = ?").get(task.taskId).output_tokens, 20);
    assert.notEqual(db.prepare("SELECT cost_status FROM usage_ledger WHERE task_id = ?").get(task.taskId).cost_status, "unknown");
  });

  it("passes the persisted provider name to the provider execution context", async () => {
    let receivedModel;
    const provider = {
      ...mockProvider,
      async execute(args) {
        receivedModel = args.model;
        return successfulResponse("provider-metadata");
      },
    };
    createService(provider);
    const owner = identity("alice");
    service.createTask({ identity: owner, idempotencyKey: "provider-metadata", request: validRequest() });

    await service.runPending();

    assert.equal(receivedModel.providerName, "本地模拟供应商");
    assert.equal(receivedModel.providerKind, "mock");
  });

  it("creates, executes, persists, and replays a task idempotently", async () => {
    createService();
    const owner = identity("alice");
    const created = service.createTask({
      identity: owner,
      idempotencyKey: "quick-1",
      request: validRequest(),
    });

    assert.equal(created.status, "queued");
    assert.equal(created.replayed, false);
    const run = await service.runPending();
    assert.equal(run.claimed, 1);
    assert.equal(service.readTask({ identity: owner, taskId: created.taskId }).status, "succeeded");
    const result = service.readTaskResult({ identity: owner, taskId: created.taskId });
    assert.equal(result.result.schemaVersion, "ai-task-result-v1");
    assert.equal(result.result.source, "mock");

    const replay = service.createTask({
      identity: owner,
      idempotencyKey: "quick-1",
      request: validRequest(),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.taskId, created.taskId);
    assert.throws(
      () => service.createTask({
        identity: owner,
        idempotencyKey: "quick-1",
        request: validRequest({ text: "different" }),
      }),
      (error) => error.code === "idempotency_conflict" && error.status === 409,
    );

    const ledger = db.prepare("SELECT COUNT(*) AS count, MAX(cost_status) AS status FROM usage_ledger").get();
    assert.equal(Number(ledger.count), 1);
    assert.equal(ledger.status, "calculated");
  });

  it("hides another owner's task and does not allow cross-owner cancellation", () => {
    createService();
    const alice = identity("alice");
    const bob = identity("bob");
    const created = service.createTask({ identity: alice, idempotencyKey: "owner-1", request: validRequest() });

    assert.throws(
      () => service.readTask({ identity: bob, taskId: created.taskId }),
      (error) => error.code === "not_found" && error.status === 404,
    );
    assert.throws(
      () => service.cancelTask({ identity: bob, taskId: created.taskId }),
      (error) => error.code === "not_found" && error.status === 404,
    );
    assert.equal(service.listTasks({ identity: bob }).length, 0);
  });

  it("cancels a queued task without calling the provider and releases its reservation", async () => {
    let calls = 0;
    const provider = {
      ...mockProvider,
      async execute(args) {
        calls += 1;
        return mockProvider.execute(args);
      },
    };
    createService(provider);
    const owner = identity("alice");
    const created = service.createTask({ identity: owner, idempotencyKey: "cancel-queued", request: validRequest() });

    const cancelled = service.cancelTask({ identity: owner, taskId: created.taskId });
    assert.equal(cancelled.status, "cancelled");
    await service.runPending();
    assert.equal(calls, 0);
    const reservation = db.prepare("SELECT status FROM budget_reservations WHERE task_id = ?").get(created.taskId);
    assert.equal(reservation.status, "released");
  });

  it("retries a retryable provider failure and records every attempt", async () => {
    let calls = 0;
    const provider = {
      id: "provider-mock",
      kind: "mock",
      async execute() {
        calls += 1;
        if (calls === 1) {
          const error = new Error("temporary");
          error.code = "temporary_failure";
          error.retryable = true;
          throw error;
        }
        return successfulResponse("retry");
      },
    };
    createService(provider);
    const owner = identity("alice");
    const created = service.createTask({ identity: owner, idempotencyKey: "retry-1", request: validRequest() });

    const first = await service.runPending();
    assert.equal(first.results[0].retry, true);
    assert.equal(service.readTask({ identity: owner, taskId: created.taskId }).status, "queued");
    const second = await service.runPending();
    assert.equal(second.results[0].task.status, "succeeded");
    assert.equal(calls, 2);
    const attempts = db.prepare("SELECT attempt_no, status FROM task_attempts WHERE task_id = ? ORDER BY attempt_no").all(created.taskId);
    assert.deepEqual(attempts.map((row) => [Number(row.attempt_no), row.status]), [[1, "failed"], [2, "succeeded"]]);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM usage_ledger WHERE task_id = ?").get(created.taskId).count), 2);
  });

  it("marks a provider-started cancellation as unknown cost", async () => {
    let release;
    const started = new Promise((resolve) => { release = resolve; });
    const provider = {
      id: "provider-mock",
      kind: "mock",
      async execute({ signal }) {
        await started;
        if (signal.aborted) {
          const error = new Error("cancelled");
          error.code = "cancelled";
          throw error;
        }
        return successfulResponse("cancel");
      },
    };
    createService(provider);
    const owner = identity("alice");
    const created = service.createTask({ identity: owner, idempotencyKey: "cancel-running", request: validRequest() });
    const pending = service.runPending();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.readTask({ identity: owner, taskId: created.taskId }).status, "running");
    service.cancelTask({ identity: owner, taskId: created.taskId });
    release();
    await pending;

    const task = service.readTask({ identity: owner, taskId: created.taskId });
    assert.equal(task.status, "cancelled");
    const ledger = db.prepare("SELECT cost_status FROM usage_ledger WHERE task_id = ?").get(created.taskId);
    assert.equal(ledger.cost_status, "unknown");
  });

  it("treats an empty usage object as unknown rather than zero-cost usage", async () => {
    const provider = {
      ...mockProvider,
      async execute() {
        const response = successfulResponse("missing-usage");
        return { ...response, usage: {} };
      },
    };
    createService(provider);
    const owner = identity("alice");
    const created = service.createTask({ identity: owner, idempotencyKey: "missing-usage", request: validRequest() });

    await service.runPending();

    const attempt = db.prepare("SELECT cost_status FROM task_attempts WHERE task_id = ?").get(created.taskId);
    const ledger = db.prepare("SELECT cost_status FROM usage_ledger WHERE task_id = ?").get(created.taskId);
    assert.equal(attempt.cost_status, "unknown");
    assert.equal(ledger.cost_status, "unknown");
  });

  it("does not wait beyond the caller's bounded wait window", async () => {
    createService();
    const owner = identity("alice");
    const created = service.createTask({ identity: owner, idempotencyKey: "bounded-wait", request: validRequest() });
    const started = performance.now();

    const result = await service.waitForTask({ identity: owner, taskId: created.taskId, waitMs: 220 });
    const elapsed = performance.now() - started;

    assert.equal(result.status, "queued");
    assert.ok(elapsed >= 180, `wait returned too early: ${elapsed}ms`);
    assert.ok(elapsed < 285, `wait exceeded bound: ${elapsed}ms`);
  });

  it("blocks an external model when the execution mode is local simulation", () => {
    const provider = { ...mockProvider, kind: "openai_compatible" };
    createService(provider);
    db.prepare("UPDATE providers SET kind = 'openai_compatible' WHERE id = 'provider-mock'").run();

    assert.throws(
      () => service.createTask({ identity: identity("alice"), idempotencyKey: "external-local", request: validRequest() }),
      (error) => error.code === "provider_policy_blocked" && error.status === 503,
    );
  });

  it("requires explicit Agent permission before enabling external execution", () => {
    const provider = { ...mockProvider, kind: "openai_compatible" };
    createService(provider, { executionMode: "external-provider", externalProvidersEnabled: true });
    db.prepare("UPDATE providers SET kind = 'openai_compatible' WHERE id = 'provider-mock'").run();

    assert.throws(
      () => service.createTask({ identity: identity("alice"), idempotencyKey: "external-policy", request: validRequest() }),
      (error) => error.code === "provider_policy_blocked" && error.status === 503,
    );
  });

  it("rejects a task before execution when the atomic budget reservation would exceed the limit", () => {
    createService();
    db.prepare(`
      UPDATE price_versions
         SET input_micro_per_1k = 10_000, output_micro_per_1k = 10_000
       WHERE id = 'price-mock-zero-v1'
    `).run();
    db.prepare("UPDATE budget_policies SET amount_micro = 1 WHERE id = 'budget-global-daily'").run();
    const owner = identity("alice");

    assert.throws(
      () => service.createTask({ identity: owner, idempotencyKey: "over-budget", request: validRequest() }),
      (error) => error.code === "budget_exceeded" && error.status === 429,
    );
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM budget_reservations").get().count), 0);
  });

  it("recovers an expired lease without allowing the old worker to complete it", async () => {
    let resolveProvider;
    const providerDone = new Promise((resolve) => { resolveProvider = resolve; });
    const provider = {
      id: "provider-mock",
      kind: "mock",
      async execute() {
        await providerDone;
        return successfulResponse("stale");
      },
    };
    createService(provider);
    const owner = identity("alice");
    const created = service.createTask({ identity: owner, idempotencyKey: "lease-1", request: validRequest() });
    const pending = service.runPending();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.readTask({ identity: owner, taskId: created.taskId }).status, "running");

    currentTime = new Date(new Date(BASE_TIME).getTime() + 3_000);
    const recovered = service.recoverExpiredLeases();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "queued");
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM usage_ledger WHERE task_id = ?").get(created.taskId).count), 1);

    resolveProvider();
    await pending;
    assert.equal(service.readTask({ identity: owner, taskId: created.taskId }).status, "queued");
    const attemptStatuses = db.prepare("SELECT status FROM task_attempts WHERE task_id = ? ORDER BY attempt_no").all(created.taskId);
    assert.equal(attemptStatuses[0].status, "unknown");
  });
});
