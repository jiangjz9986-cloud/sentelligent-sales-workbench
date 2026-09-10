import assert from "node:assert/strict";
import { test } from "node:test";
import { createAiPlatformRuntime } from "../src/server.js";
import { createTaskPayloadCodec } from "../src/tasks/payloadCodec.js";

test("task inputs and outputs are encrypted at rest and retention does not remove costs or idempotency", async () => {
  let now = new Date("2026-09-10T00:00:00.000Z");
  const runtime = createAiPlatformRuntime({
    config: { databasePath: ":memory:", taskEncryptionKey: Buffer.alloc(32, 108).toString("base64url"), taskRetentionDays: 1 },
    clock: () => now, autoStart: false,
  });
  const identity = { issuer: "backend", owner: "alice", actor: "alice" };
  const input = { identity, idempotencyKey: "encrypted-task", request: { taskType: "quick-record.analyze", feature: "quick-record", channel: "web", input: { text: "private customer phrase" } } };
  try {
    const task = runtime.taskService.createTask(input);
    let row = runtime.db.prepare("SELECT * FROM tasks WHERE id=?").get(task.taskId);
    assert.match(row.input_json, /^aipayload1:/);
    assert.equal(row.input_json.includes("private customer phrase"), false);
    await runtime.taskService.runPending();
    row = runtime.db.prepare("SELECT * FROM tasks WHERE id=?").get(task.taskId);
    assert.match(row.output_json, /^aipayload1:/);
    const result = runtime.taskService.readTaskResult({ identity, taskId: task.taskId });
    assert.equal(result.result.source, "mock");
    const admin = { issuer: "admin", owner: "admin", actor: "admin", scopes: ["ai:admin:*"], isAdmin: true };
    const detail = runtime.adminService.getTaskDetail({ identity: admin, taskId: task.taskId });
    assert.equal(detail.task.input.text, "private customer phrase");
    assert.equal(detail.task.output.source, "mock");
    now = new Date("2026-09-12T00:00:00.000Z");
    assert.equal(runtime.taskService.prunePayloads({ force: true }), 1);
    assert.throws(() => runtime.taskService.readTaskResult({ identity, taskId: task.taskId }), (error) => error.code === "result_expired");
    assert.equal(runtime.taskService.createTask(input).replayed, true);
    assert.equal(runtime.db.prepare("SELECT count(*) n FROM usage_ledger WHERE task_id=?").get(task.taskId).n, 1);
    assert.equal(runtime.db.prepare("SELECT input_json FROM tasks WHERE id=?").get(task.taskId).input_json, "{}");
  } finally { await runtime.close(); }
});

test("payload authentication binds owner, task and field and rejects plaintext in required mode", () => {
  const codec = createTaskPayloadCodec({ encryptionKey: Buffer.alloc(32, 109).toString("base64url"), required: true });
  const row = { id: "task-a", owner: "alice" };
  const input_json = codec.encode('{"text":"private"}', row, "input");
  assert.equal(codec.decodeRow({ ...row, input_json }).input_json, '{"text":"private"}');
  assert.throws(() => codec.decodeRow({ ...row, owner: "bob", input_json }), (error) => error.code === "payload_integrity_failed");
  assert.throws(() => codec.decodeRow({ ...row, id: "task-b", input_json }), (error) => error.code === "payload_integrity_failed");
  assert.throws(() => codec.decodeRow({ ...row, output_json: input_json }), (error) => error.code === "payload_integrity_failed");
  assert.throws(() => codec.decodeRow({ ...row, input_json: "{}" }), (error) => error.code === "payload_integrity_failed");
});
