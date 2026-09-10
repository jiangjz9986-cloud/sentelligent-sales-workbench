import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { test } from "node:test";
import { createAiPlatformRuntime } from "../src/server.js";
import { createOpenAiCompatibleProvider, normalizeProviderPolicies } from "../src/providers/openAiCompatible.js";

const POLICY = {
  id: "provider-text-test", baseUrl: "https://api.deepseek.com", credentialEnv: "AI_PROVIDER_TEST_KEY",
  models: [{ name: "deepseek-v4-flash", taskTypes: ["quick-record.analyze", "weekly.generate"], reasoning: "deepseek-thinking", maxOutputTokens: 4000 }],
};
const ENV = { AI_PROVIDER_TEST_KEY: ["synthetic", "provider", "credential"].join("-") };
const requestInput = {
  protocol: "chat.completions.v1",
  request: { model: "body-must-not-select-model", max_tokens: 12_000, messages: [{ role: "user", content: "fixture JSON" }], apiKey: "test-credential", thinking: { type: "enabled" } },
};
function providerInput(taskType = "quick-record.analyze") {
  return {
    task: { id: "task-provider", taskType, input: requestInput },
    model: { providerId: POLICY.id, name: POLICY.models[0].name },
    agent: { versionId: "agent-v1", systemPrompt: "Return JSON.", limits: { maxTokens: 3200 } },
    limits: { maxTokens: 3200 },
  };
}
function completion(extra = {}) {
  return {
    id: "request-vendor-1", model: "deepseek-v4-flash",
    choices: [{ message: { content: '{"value":1}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, completion_tokens: 20 }, ...extra,
  };
}
function configured(fetchImpl) {
  const [policy] = normalizeProviderPolicies([POLICY], { allowedOrigins: ["https://api.deepseek.com"] });
  return createOpenAiCompatibleProvider(policy, { env: ENV, fetchImpl });
}

test("registered model and token limits control the request, cached input is counted once", async () => {
  const calls = [];
  const provider = configured(async (url, options) => {
    calls.push({ url, ...options });
    return Response.json(completion());
  });
  const result = await provider.execute(providerInput());
  const sent = JSON.parse(calls[0].body);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].redirect, "error");
  assert.equal(sent.model, "deepseek-v4-flash");
  assert.equal(sent.max_tokens, 3200);
  assert.deepEqual(sent.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(sent, "apiKey"), false);
  assert.equal(sent.messages[0].content, "Return JSON.");
  assert.deepEqual(result.usage, { inputTokens: 60, outputTokens: 20, cachedInputTokens: 40, audioSeconds: 0, imagePages: 0 });
  assert.equal(result.result.metadata.actualModel, "deepseek-v4-flash");
  assert.equal(result.externalRequestId, "request-vendor-1");
  await provider.execute(providerInput("weekly.generate"));
  assert.equal(Object.hasOwn(JSON.parse(calls[1].body), "thinking"), false);
});

test("invalid completion and model mismatch retain usage and vendor request identity", async () => {
  for (const body of [
    completion({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
    completion({ model: "wrong-model" }),
    completion({ choices: [{ message: { content: "{}" }, finish_reason: "length" }] }),
  ]) {
    await assert.rejects(configured(async () => Response.json(body)).execute(providerInput()), (error) => {
      assert.equal(error.usage.outputTokens, 20);
      assert.equal(error.externalRequestId, "request-vendor-1");
      assert.equal(error.message.includes(ENV.AI_PROVIDER_TEST_KEY), false);
      return true;
    });
  }
  const unknown = await configured(async () => Response.json(completion({ usage: {} }))).execute(providerInput());
  assert.equal(unknown.usage, null);
});

test("released standard contents and instruction versions reach the actual provider prompt", async () => {
  let body;
  const provider = configured(async (_url, options) => {
    body = JSON.parse(options.body);
    return Response.json(completion());
  });
  const input = providerInput();
  input.agent.standards = [{ version: "2.0.0", content: "Only documented facts.", rules: { noGuessing: true } }];
  input.agent.instructions = { noDirectWrite: true };
  await provider.execute(input);
  assert.match(body.messages[0].content, /Only documented facts/);
  assert.match(body.messages[0].content, /2\.0\.0/);
  assert.match(body.messages[0].content, /noDirectWrite/);
});

test("provider policy rejects unapproved origins, raw credentials, unsupported capabilities and oversized responses", async () => {
  for (const policy of [
    { ...POLICY, baseUrl: "http://api.deepseek.com" },
    { ...POLICY, baseUrl: "https://api.deepseek.com@127.0.0.1" },
    { ...POLICY, baseUrl: "https://api.deepseek.com?key=forged" },
    { ...POLICY, apiKey: "test-credential" },
    { ...POLICY, models: [{ ...POLICY.models[0], taskTypes: ["asr.transcribe"] }] },
  ]) {
    assert.throws(() => normalizeProviderPolicies([policy], { allowedOrigins: ["https://api.deepseek.com"] }), (error) => error.code === "provider_configuration_invalid");
  }
  let fetches = 0;
  const provider = configured(async () => { fetches++; return new Response("{}", { headers: { "content-length": String(1024 * 1024) } }); });
  await assert.rejects(provider.execute({ ...providerInput(), model: { providerId: POLICY.id, name: "unregistered" } }), /not registered/);
  assert.equal(fetches, 0);
  await assert.rejects(provider.execute(providerInput()), (error) => error.code === "provider_response_too_large");
});

test("default runtime registers configured text providers and persists real HTTP attempts and usage", async () => {
  let calls = 0;
  const supplier = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    assert.equal(req.url, "/chat/completions");
    assert.equal(payload.model, "deepseek-v4-flash");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(completion()));
  });
  await new Promise((resolve) => supplier.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${supplier.address().port}`;
  const runtime = createAiPlatformRuntime({
    config: {
      nodeEnv: "test", databasePath: ":memory:", executionMode: "external-provider",
      externalProvidersEnabled: true, providerPolicies: [{ ...POLICY, baseUrl }], allowProviderTestLoopback: true,
    },
    env: ENV, autoStart: false,
  });
  try {
    const db = runtime.db;
    db.prepare("INSERT INTO providers VALUES (?, ?, 'openai_compatible', 1, '{}', ?, ?)").run(POLICY.id, "HTTP fixture", "2026-01-01", "2026-01-01");
    db.prepare("INSERT INTO models VALUES ('model-text-test', ?, 'deepseek-v4-flash', '{\"text\":true}', 1, ?, ?)").run(POLICY.id, "2026-01-01", "2026-01-01");
    db.prepare("UPDATE agent_versions SET model_policy_json = ? WHERE id = (SELECT agent_version_id FROM agent_releases WHERE agent_id = (SELECT id FROM agents WHERE slug = 'quick-record'))")
      .run(JSON.stringify({ providerId: POLICY.id, modelId: "model-text-test", externalAllowed: true }));
    db.prepare("INSERT INTO price_versions SELECT 'price-text-test', 'model-text-test', 'test-v1', 'USD', 1000, 1000, 100, 0, 0, 0, effective_from, effective_to, created_at FROM price_versions WHERE id = 'price-mock-zero-v1'").run();
    const identity = { issuer: "backend", owner: "alice", actor: "alice" };
    const task = runtime.taskService.createTask({ identity, idempotencyKey: "live-http", request: { taskType: "quick-record.analyze", feature: "quick-record", channel: "web", input: requestInput } });
    await runtime.taskService.runPending();
    assert.equal(runtime.taskService.readTask({ identity, taskId: task.taskId }).status, "succeeded");
    assert.equal(calls, 1);
    const row = db.prepare("SELECT cost_micro, cost_status FROM usage_ledger WHERE task_id = ?").get(task.taskId);
    assert.equal(row.cost_micro, 60 + 20 + 4);
    assert.equal(row.cost_status, "calculated");
    assert.equal(db.prepare("SELECT external_request_id FROM task_attempts WHERE task_id = ?").get(task.taskId).external_request_id, "request-vendor-1");
  } finally {
    await runtime.close();
    await new Promise((resolve) => supplier.close(resolve));
  }
});
