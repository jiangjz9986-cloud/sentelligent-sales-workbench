import assert from "node:assert/strict";
import { test } from "node:test";
import { compileAgentSchema, assertAgentSchema } from "../src/tasks/schemaValidation.js";
import { openAiPlatformDatabase } from "../src/db/index.js";
import { createTaskService } from "../src/tasks/taskService.js";
import { loadAiPlatformConfig } from "../src/config.js";
import { createProviderRegistry } from "../src/providers/mockProvider.js";

test("Agent schemas reject remote/executable features and validate without coercion", () => {
  for (const schema of [{ $ref: "https://example.test/schema" }, { type: "string", pattern: "(a+)+$" }, { $async: true }]) {
    assert.throws(() => compileAgentSchema(schema), (error) => error.code === "agent_schema_invalid");
  }
  const schema = { type: "object", properties: { amount: { type: "integer", minimum: 1 } }, required: ["amount"], additionalProperties: false };
  const input = { amount: "12" };
  assert.throws(() => assertAgentSchema(input, schema, "input"), (error) => error.code === "task_input_invalid");
  assert.equal(input.amount, "12");
  assertAgentSchema({ amount: 12 }, schema, "input");
});

test("invalid input never reserves money and invalid paid output preserves attempt usage", async () => {
  const db = openAiPlatformDatabase(":memory:");
  const service = createTaskService({ db, config: loadAiPlatformConfig({ databasePath: ":memory:" }), providerRegistry: createProviderRegistry() });
  const identity = { issuer: "backend", owner: "alice", actor: "alice" };
  const request = { taskType: "quick-record.analyze", feature: "quick-record", channel: "web", input: {} };
  try {
    db.prepare("UPDATE agent_versions SET input_schema_json=?").run(JSON.stringify({ type: "object", required: ["requiredField"] }));
    assert.throws(() => service.createTask({ identity, idempotencyKey: "schema-input", request }), (error) => error.code === "task_input_invalid");
    assert.equal(db.prepare("SELECT count(*) n FROM budget_reservations").get().n, 0);
    db.prepare("UPDATE agent_versions SET input_schema_json='{}',output_schema_json=?").run(JSON.stringify({ type: "object", required: ["impossibleResult"] }));
    db.prepare("UPDATE price_versions SET input_micro_per_1k=1000,output_micro_per_1k=1000").run();
    const created = service.createTask({ identity, idempotencyKey: "schema-output", request });
    await service.runPending();
    assert.equal(service.readTask({ identity, taskId: created.taskId }).status, "failed");
    const usage = db.prepare("SELECT cost_micro,cost_status FROM usage_ledger WHERE task_id=?").get(created.taskId);
    assert.ok(usage.cost_micro > 0);
    assert.equal(usage.cost_status, "calculated");
  } finally { await service.close(); db.close(); }
});
