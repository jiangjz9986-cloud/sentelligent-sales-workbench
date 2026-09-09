import assert from "node:assert/strict";
import { test } from "node:test";
import { createExecutionDrain } from "../src/services/executionDrain.js";

test("background drain rejects new work while awaiting all writes and reports timeout without clearing work", async () => {
  const gate = createExecutionDrain();
  let finish;
  const work = gate.run(() => new Promise((resolve) => { finish = resolve; }));
  try {
    await assert.rejects(gate.drain({ timeoutMs: 10 }), (error) => error.code === "BACKGROUND_DRAIN_TIMEOUT");
    assert.deepEqual(gate.status(), { paused: true, pending: 1 });
    await assert.rejects(gate.run(() => assert.fail("must not execute")), (error) => error.code === "BACKGROUND_DRAINING");
  } finally {
    finish();
    await work;
    await gate.drain();
  }
  assert.deepEqual(gate.status(), { paused: true, pending: 0 });
});
