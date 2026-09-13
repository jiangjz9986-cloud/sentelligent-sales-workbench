import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { test } from "node:test";

import { createServiceToken } from "../src/auth/internalAuth.js";
import { createServer } from "../src/server.js";
import { providerCanaryIdempotencyKey } from "../../shared/aiPlatformCanaryContract.mjs";

const HARNESS_TEXT = "provider-canary-test-secret-0123456789";
const POLICY = {
  id: "provider-canary-test",
  kind: "openai_compatible",
  credentialEnv: "AI_PROVIDER_CANARY_TEST_KEY",
  models: [{
    name: "deepseek-flash",
    taskTypes: ["quick-record.analyze"],
    reasoning: "deepseek-thinking",
    maxOutputTokens: 4_000,
  }],
};

function authToken(scopes) {
  return createServiceToken({
    secret: HARNESS_TEXT,
    issuer: "canary-runner",
    subject: "canary-runner",
    owner: "canary-runner",
    actor: "canary-runner",
    scopes,
    ttlSeconds: 300,
    jti: `canary-${scopes.join("-")}`,
  });
}

async function readResponse(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

test("provider canary endpoint enforces fixed scope/body and settles evidence idempotently", async () => {
  let completionCalls = 0;
  const supplier = createHttpServer(async (request, response) => {
    if (request.url === "/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "deepseek-flash" }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.url, "/chat/completions");
    assert.equal(payload.model, "deepseek-flash");
    completionCalls += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      id: `provider-request-${completionCalls}`,
      model: "deepseek-flash",
      choices: [{ message: { content: '{"value":1}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }));
  });
  await new Promise((resolve) => supplier.listen(0, "127.0.0.1", resolve));

  const baseUrl = `http://127.0.0.1:${supplier.address().port}`;
  const server = createServer({
    config: {
      nodeEnv: "test",
      databasePath: ":memory:",
      authSecret: HARNESS_TEXT,
      executionMode: "external-provider",
      externalProvidersEnabled: true,
      providerPolicies: [{ ...POLICY, baseUrl }],
      allowProviderTestLoopback: true,
      taskPollMs: 10,
    },
    env: { AI_PROVIDER_CANARY_TEST_KEY: "synthetic-canary-credential" },
    autoStart: false,
    logger: { error() {} },
  });

  try {
    const db = server.aiPlatform.db;
    db.prepare("INSERT INTO providers VALUES (?, ?, 'openai_compatible', 1, '{}', ?, ?)").run(
      POLICY.id, "Canary fixture", "2026-01-01", "2026-01-01",
    );
    db.prepare("INSERT INTO models VALUES (?, ?, 'deepseek-flash', '{\"text\":true}', 1, ?, ?)").run(
      "model-provider-canary-test", POLICY.id, "2026-01-01", "2026-01-01",
    );
    db.prepare(`UPDATE agent_versions SET model_policy_json = ? WHERE id = (
      SELECT agent_version_id FROM agent_releases
       WHERE agent_id = (SELECT id FROM agents WHERE slug = 'quick-record')
         AND status = 'active'
    )`).run(JSON.stringify({
      providerId: POLICY.id,
      modelId: "model-provider-canary-test",
      externalAllowed: true,
    }));
    db.prepare("INSERT INTO price_versions SELECT 'price-provider-canary-test', 'model-provider-canary-test', 'canary-v1', 'USD', 1000, 1000, 0, 0, 0, 0, effective_from, effective_to, created_at FROM price_versions WHERE id = 'price-mock-zero-v1'").run();
    await server.aiPlatform.providerRegistry.refreshReadiness({ providerId: POLICY.id });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = `http://127.0.0.1:${server.address().port}/internal/ai/v1/provider-canaries`;
    const runId = "canary-http-run";
    const sampleIndex = 1;
    const idempotencyKey = providerCanaryIdempotencyKey(runId, sampleIndex);
    const headers = {
      Authorization: `Bearer ${authToken(["ai:provider:canary"])}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    };

    const unauthorized = await readResponse(await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${authToken(["ai:task:create"])}` },
      body: JSON.stringify({ runId, sampleIndex }),
    }));
    assert.equal(unauthorized.response.status, 403);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);

    const invalid = await readResponse(await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId, sampleIndex, extra: true }),
    }));
    assert.equal(invalid.response.status, 422);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);

    const first = await readResponse(await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify({ runId, sampleIndex }),
    }));
    assert.equal(first.response.status, 202);
    assert.equal(first.body.item.ready, false);
    assert.equal(first.body.item.task.status, "queued");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provider_readiness_evidence").get().count, 0);
    assert.equal(completionCalls, 0);

    await server.aiPlatform.taskService.runPending({ limit: 1 });
    assert.equal(completionCalls, 1);

    const settled = await readResponse(await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify({ runId, sampleIndex }),
    }));
    assert.equal(settled.response.status, 200);
    assert.equal(settled.body.item.ready, true);
    assert.equal(settled.body.item.task.status, "succeeded");
    assert.equal(settled.body.item.evidence.settledStatus, "settled");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provider_readiness_evidence").get().count, 1);
    assert.equal(server.aiPlatform.providerRegistry.get(POLICY.id).readiness({ modelName: "deepseek-flash", taskType: "quick-record.analyze" }).liveReady, true);

    const replay = await readResponse(await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify({ runId, sampleIndex }),
    }));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.replayed, true);
    assert.equal(replay.body.item.evidence.replayed, true);
    assert.equal(completionCalls, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provider_readiness_evidence").get().count, 1);
  } finally {
    await server.closeAiPlatform();
    await new Promise((resolve) => supplier.close(resolve));
  }
});
