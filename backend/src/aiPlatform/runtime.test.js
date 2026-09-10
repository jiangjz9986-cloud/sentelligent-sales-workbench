import assert from "node:assert/strict";
import { test } from "node:test";
import { createAiPlatformRuntime } from "./runtime.js";

test("health probes distinguish configured credentials from a reachable matching platform", async () => {
  const config = { aiPlatformMode: "required", aiPlatformExecutionMode: "external-provider" };
  const unavailable = createAiPlatformRuntime({ config, client: { async health() { throw new Error("offline"); } } });
  assert.equal(unavailable.health().configured, true);
  assert.equal((await unavailable.probeHealth()).ready, false);
  const mock = createAiPlatformRuntime({ config, client: { async health() { return { status: "ok", database: "ready", executionMode: "local-simulated" }; } } });
  assert.equal((await mock.probeHealth()).ready, false);
  let calls = 0;
  const ready = createAiPlatformRuntime({ config, client: { async health() {
    calls++;
    return { status: "ok", database: "ready", executionMode: "external-provider", tasks: {} };
  } } });
  assert.equal((await ready.probeHealth()).ready, true);
  await ready.probeHealth();
  assert.equal(calls, 1);
});

test("long task polling stays bounded while each HTTP wait preserves the 30-second contract", async () => {
  const calls = [];
  const runtime = createAiPlatformRuntime({
    config: { aiPlatformMode: "required", aiPlatformMaxWaitMs: 180_000 },
    client: {
      async runTask(input) {
        calls.push(input);
        return { task: { taskId: "long-task", status: "succeeded" }, result: {
          schemaVersion: "ai-task-result-v1", status: "success", source: "model", metadata: { completion: "{}" },
        } };
      },
    },
  });
  await runtime.runTask({
    taskType: "sales-decision.analyze", feature: "sales-decision", owner: "alice", input: { text: "fixture" },
  });
  assert.equal(calls[0].maxWaitMs, 180_000);
  assert.equal(calls[0].request.requestedWaitMs, 30_000);
  await assert.rejects(runtime.runTask({
    taskType: "sales-decision.analyze", feature: "sales-decision", owner: "alice", input: {}, maxWaitMs: 600_001,
  }), /maxWaitMs/);
  assert.equal(calls.length, 1);
});
