import assert from "node:assert/strict";
import { test } from "node:test";
import { createAiPlatformRuntime } from "./runtime.js";

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
