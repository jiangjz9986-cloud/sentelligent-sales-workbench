import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServiceToken } from "../src/auth/internalAuth.js";
import { loadAiPlatformConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const SECRET = ["test", "ai", "platform", "secret"].join("-");

let server;
let baseUrl;

function token(owner, scopes) {
  return createServiceToken({
    secret: SECRET,
    issuer: "business-backend",
    subject: `service-${owner}`,
    owner,
    actor: owner,
    scopes,
    ttlSeconds: 300,
    now: () => Date.now(),
    jti: `${owner}-${scopes.join("-")}`,
  });
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body };
}

beforeEach(async () => {
  const config = loadAiPlatformConfig({
    nodeEnv: "development",
    databasePath: ":memory:",
    authSecret: SECRET,
    staticDirectory: "outputs/ai-platform-admin",
    taskPollMs: 20,
  });
  server = createServer({ config, autoStart: false, logger: { error() {} } });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (!server) return;
  await new Promise((resolve) => server.closeAiPlatform(resolve));
  server = null;
});

describe("AI platform HTTP server", () => {
  it("exposes health and readiness without credentials", async () => {
    const health = await request("/healthz");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(health.body.database, "ready");
    assert.equal(typeof health.body.requestId, "string");

    const ready = await request("/readyz");
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.status, "ok");
  });

  it("requires task credentials, accepts a task, and serves its result", async () => {
    const missing = await request("/internal/ai/v1/tasks", {
      method: "POST",
      headers: { "Idempotency-Key": "http-1" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.response.status, 401);
    assert.equal(missing.body.error.code, "missing_auth");

    const auth = token("alice", ["ai:task:create", "ai:task:read"]);
    const created = await request("/internal/ai/v1/tasks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth}`,
        "Idempotency-Key": "http-1",
      },
      body: JSON.stringify({
        taskType: "quick-record.analyze",
        feature: "quick-record",
        channel: "web",
        input: { text: "hello" },
      }),
    });
    assert.equal(created.response.status, 202);
    assert.equal(created.body.item.status, "queued");
    assert.match(created.response.headers.get("location"), /\/internal\/ai\/v1\/tasks\/task-/u);

    await server.aiPlatform.taskService.runPending();
    const result = await request(`/internal/ai/v1/tasks/${created.body.item.taskId}/result`, {
      headers: { Authorization: `Bearer ${auth}` },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.item.result.schemaVersion, "ai-task-result-v1");
  });

  it("keeps task access owner-scoped and exposes admin resources only with admin scope", async () => {
    const aliceToken = token("alice", ["ai:task:create", "ai:task:read"]);
    const created = await request("/internal/ai/v1/tasks", {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}`, "Idempotency-Key": "owner-http" },
      body: JSON.stringify({
        taskType: "quick-record.analyze",
        feature: "quick-record",
        channel: "web",
        input: { text: "private" },
      }),
    });
    const bobToken = token("bob", ["ai:task:read"]);
    const hidden = await request(`/internal/ai/v1/tasks/${created.body.item.taskId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    assert.equal(hidden.response.status, 404);

    const regular = await request("/internal/ai/v1/admin/agents", {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    assert.equal(regular.response.status, 403);

    const admin = await request("/internal/ai/v1/admin/agents", {
      headers: { "X-AI-Platform-Dev-Auth": "1" },
    });
    assert.equal(admin.response.status, 200);
    assert.ok(admin.body.items.length >= 1);
  });

  it("exposes management details, task subresources, and filtered costs", async () => {
    const aliceToken = token("alice", ["ai:task:create", "ai:task:read"]);
    const created = await request("/internal/ai/v1/tasks", {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}`, "Idempotency-Key": "admin-detail-http" },
      body: JSON.stringify({
        taskType: "quick-record.analyze",
        feature: "quick-record",
        channel: "web",
        input: { text: "detail" },
      }),
    });
    await server.aiPlatform.taskService.runPending();

    const adminHeaders = { "X-AI-Platform-Dev-Auth": "1" };
    const provider = await request("/internal/ai/v1/admin/providers/provider-mock", { headers: adminHeaders });
    assert.equal(provider.response.status, 200);
    assert.equal(provider.body.item.name, "本地模拟供应商");

    const model = await request("/internal/ai/v1/admin/models/model-mock-standard-v1?providerId=provider-mock&enabled=true", { headers: adminHeaders });
    assert.equal(model.response.status, 200);
    assert.equal(model.body.item.id, "model-mock-standard-v1");

    const enabledModels = await request("/internal/ai/v1/admin/models?providerId=provider-mock&enabled=true", { headers: adminHeaders });
    assert.equal(enabledModels.response.status, 200);
    assert.ok(enabledModels.body.items.every((item) => item.enabled === true));

    const disabledBudgets = await request("/internal/ai/v1/admin/budgets?enabled=false", { headers: adminHeaders });
    assert.equal(disabledBudgets.response.status, 200);
    assert.ok(disabledBudgets.body.items.every((item) => item.enabled === false));

    const invalidEnabled = await request("/internal/ai/v1/admin/schedules?enabled=maybe", { headers: adminHeaders });
    assert.equal(invalidEnabled.response.status, 400);
    assert.equal(invalidEnabled.body.error.code, "invalid_request");

    const detailPath = `/internal/ai/v1/admin/tasks/${created.body.item.taskId}`;
    const detail = await request(detailPath, { headers: adminHeaders });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.item.task.status, "succeeded");
    assert.ok(detail.body.item.attempts.length >= 1);

    const attempts = await request(`${detailPath}/attempts`, { headers: adminHeaders });
    const events = await request(`${detailPath}/events?limit=20`, { headers: adminHeaders });
    const reservations = await request(`${detailPath}/reservations`, { headers: adminHeaders });
    const usage = await request(`${detailPath}/usage`, { headers: adminHeaders });
    assert.equal(attempts.response.status, 200);
    assert.equal(events.response.status, 200);
    assert.equal(reservations.response.status, 200);
    assert.equal(usage.response.status, 200);
    assert.ok(attempts.body.items.length >= 1);
    assert.ok(events.body.items.some((event) => event.eventType === "task.succeeded"));
    assert.ok(reservations.body.items.length >= 1);
    assert.ok(usage.body.items.length >= 1);

    const attemptId = attempts.body.items[0].id;
    const attempt = await request(`${detailPath}/attempts/${attemptId}`, { headers: adminHeaders });
    assert.equal(attempt.response.status, 200);
    assert.equal(attempt.body.item.taskId, created.body.item.taskId);

    const costs = await request("/internal/ai/v1/admin/costs?owner=alice&feature=quick-record&groupBy=model", {
      headers: adminHeaders,
    });
    assert.equal(costs.response.status, 200);
    assert.equal(costs.body.item.groupBy, "model");
    assert.ok(costs.body.item.calls >= 1);
  });

  it("supports administrator cancellation and protects write routes", async () => {
    const aliceToken = token("alice", ["ai:task:create", "ai:task:read"]);
    const created = await request("/internal/ai/v1/tasks", {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}`, "Idempotency-Key": "admin-cancel-http" },
      body: JSON.stringify({
        taskType: "quick-record.analyze",
        feature: "quick-record",
        channel: "web",
        input: { text: "cancel" },
      }),
    });
    const regular = token("bob", ["ai:task:read"]);
    const forbidden = await request(`/internal/ai/v1/admin/tasks/${created.body.item.taskId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${regular}` },
      body: JSON.stringify({}),
    });
    assert.equal(forbidden.response.status, 403);

    const cancelled = await request(`/internal/ai/v1/admin/tasks/${created.body.item.taskId}/cancel`, {
      method: "POST",
      headers: { "X-AI-Platform-Dev-Auth": "1" },
      body: JSON.stringify({}),
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body.item.status, "cancelled");
  });

  it("supports schedule creation, enable/disable, scan, and run inspection", async () => {
    const headers = { "X-AI-Platform-Dev-Auth": "1" };
    const created = await request("/internal/ai/v1/admin/schedules", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "schedule-http-test",
        slug: "http-test",
        name: "HTTP 调度测试",
        taskType: "quick-record.analyze",
        feature: "quick-record",
        intervalSeconds: 60,
        enabled: false,
        inputTemplate: { text: "scheduled" },
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.enabled, false);

    const disabled = await request("/internal/ai/v1/admin/schedules?enabled=false", { headers });
    assert.equal(disabled.response.status, 200);
    assert.ok(disabled.body.items.some((item) => item.id === "schedule-http-test" && item.enabled === false));

    const enabled = await request("/internal/ai/v1/admin/schedules/schedule-http-test/enable", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.body.item.enabled, true);

    // Move only this test schedule into the due window; the service itself
    // computes the next occurrence from the configured interval.
    server.aiPlatform.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), "schedule-http-test");

    const scan = await request("/internal/ai/v1/admin/schedules/scan", {
      method: "POST",
      headers,
      body: JSON.stringify({ limit: 10 }),
    });
    assert.equal(scan.response.status, 200);
    assert.ok(scan.body.item.claimed >= 0);

    const runs = await request("/internal/ai/v1/admin/schedules/runs?scheduleId=schedule-http-test", { headers });
    assert.equal(runs.response.status, 200);
    assert.ok(runs.body.items.length >= 1);
    const runId = runs.body.items[0].id;
    const run = await request(`/internal/ai/v1/admin/schedules/runs/${runId}`, { headers });
    assert.equal(run.response.status, 200);
    assert.equal(run.body.item.id, runId);

    const errors = await request("/internal/ai/v1/admin/schedules/errors?scheduleId=schedule-http-test", { headers });
    assert.equal(errors.response.status, 200);

    const disabledAgain = await request("/internal/ai/v1/admin/schedules/schedule-http-test/disable", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(disabledAgain.response.status, 200);
    assert.equal(disabledAgain.body.item.enabled, false);
  });

  it("serves the isolated management console and rejects path traversal", async () => {
    const page = await request("/ai-platform-admin/");
    assert.equal(page.response.status, 200);
    assert.match(page.response.headers.get("content-type"), /text\/html/u);
    assert.match(page.body, /Sentelligent/u);

    const traversal = await request("/ai-platform-admin/%2e%2e/%2e%2e/package.json");
    assert.equal(traversal.response.status, 404);
  });
});
