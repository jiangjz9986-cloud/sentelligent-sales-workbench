import assert from "node:assert/strict";
import { test } from "node:test";
import { createAiPlatformRuntime } from "../src/server.js";
import { createProviderRegistry, mockProvider } from "../src/providers/mockProvider.js";

function deferredRuntime(overrides = {}) {
  let finish;
  const provider = {
    ...mockProvider,
    async execute(input) {
      await new Promise((resolve) => { finish = resolve; });
      return mockProvider.execute(input);
    },
  };
  const runtime = createAiPlatformRuntime({
    config: { databasePath: ":memory:", taskLeaseMs: 2_000, ...overrides },
    providerRegistry: createProviderRegistry({ providers: [provider] }),
    autoStart: false,
  });
  const identity = { issuer: "shutdown-test", owner: "owner", actor: "owner" };
  runtime.taskService.createTask({
    identity,
    idempotencyKey: "shutdown",
    request: { taskType: "quick-record.analyze", feature: "quick-record", channel: "web", input: { text: "fixture" } },
  });
  const pending = runtime.taskService.runPending();
  return { runtime, pending, finish: () => finish() };
}

test("runtime closes its database only after active attempts settle", async () => {
  const { runtime, pending, finish } = deferredRuntime();
  const closing = runtime.close();
  try {
    assert.equal(runtime.taskService.status().admissionOpen, false);
    assert.equal(runtime.db.prepare("SELECT count(*) n FROM task_attempts WHERE status = 'running'").get().n, 1);
    assert.equal(runtime.close(), closing);
  } finally {
    finish();
    await pending;
    await closing;
  }
  assert.throws(() => runtime.db.prepare("SELECT 1"), /not open|closed/i);
});

test("a timed-out close keeps the database available for settlement and can retry", async () => {
  const { runtime, pending, finish } = deferredRuntime({ drainTimeoutMs: 10 });
  try {
    await assert.rejects(runtime.close(), (error) => error.code === "drain_timeout");
    assert.equal(runtime.taskService.status().paused, true);
    assert.equal(runtime.db.prepare("SELECT count(*) n FROM task_attempts WHERE status = 'running'").get().n, 1);
  } finally {
    finish();
    await pending;
    assert.equal(runtime.db.prepare("SELECT count(*) n FROM usage_ledger").get().n, 1);
    await runtime.close();
  }
  assert.throws(() => runtime.db.prepare("SELECT 1"), /not open|closed/i);
});
