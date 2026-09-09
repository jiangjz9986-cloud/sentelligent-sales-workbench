import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServiceToken } from "../../ai-platform/src/auth/internalAuth.js";
import { loadAiPlatformConfig } from "../../ai-platform/src/config.js";
import { createServer as createAiPlatformServer } from "../../ai-platform/src/server.js";
import { hashPassword } from "../src/auth/password.js";
import { createServer as createBackendServer } from "../src/server.js";

const PLATFORM_SECRET = Buffer.alloc(32, 71).toString("base64url");
const SESSION_SECRET = Buffer.alloc(32, 72).toString("base64url");
const LOGIN_ACCOUNT = "owner-a";
const LOGIN_PASSWORD = "unit-secret";
const LOGIN_PASSWORD_HASH = await hashPassword(LOGIN_PASSWORD, {
  salt: Buffer.alloc(16, 73),
});

let tempDir;
let aiPlatformServer;
let backendServer;
let aiPlatformBaseUrl;
let backendBaseUrl;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server, method = "close") {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server[method]((error) => (error ? reject(error) : resolve()));
  });
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  return { response, body: await readResponse(response) };
}

function platformToken({ owner, actor = owner, scopes }) {
  return createServiceToken({
    secret: PLATFORM_SECRET,
    issuer: "integration-test",
    subject: `service-${actor}`,
    owner,
    actor,
    scopes,
    ttlSeconds: 300,
    jti: `${owner}-${actor}-${scopes.join("-")}`,
  });
}

function createAmapFixture() {
  const points = new Map([
    ["青岛市黄岛区秀兰禧悦山", { lng: 120.149201, lat: 35.987754 }],
    ["济南市历下区经十路", { lng: 117.120128, lat: 36.652069 }],
    ["济宁市任城区济宁市第二人民医院", { lng: 116.608817, lat: 35.415405 }],
  ]);
  return {
    async geocode({ address }) {
      const location = points.get(address);
      if (!location) throw new Error("AMAP_NO_RESULT");
      return { formattedAddress: `山东省${address}`, location };
    },
    async drivingMatrix({ locations }) {
      const size = locations.length;
      const durations = Array.from({ length: size }, (_, from) => (
        Array.from({ length: size }, (_, to) => from === to ? 0 : (Math.abs(from - to) + 1) * 600)
      ));
      return {
        durations,
        distances: durations.map((row) => row.map((duration) => duration * 12)),
      };
    },
    async drivingRoute({ origin, waypoints, destination }) {
      return {
        distanceMeters: 379100,
        durationSeconds: 15360,
        tollsCny: 146,
        trafficLights: 25,
        polyline: [origin, ...waypoints, destination],
        steps: [],
      };
    },
  };
}

function itineraryPayload() {
  return {
    title: "济宁客户拜访",
    visitDate: "2026-07-28",
    status: "planned",
    departureAddress: "青岛市黄岛区秀兰禧悦山",
    departureCity: "青岛",
    departureAt: "2026-07-28T08:00:00+08:00",
    stops: [
      {
        id: "customer-a",
        customerId: "customer-a",
        customerName: "济南示例客户",
        address: "济南市历下区经十路",
        city: "济南",
        priority: "normal",
        visitMinutes: 45,
      },
      {
        id: "customer-b",
        customerId: "customer-b",
        customerName: "济宁第二人民医院",
        address: "济宁市任城区济宁市第二人民医院",
        city: "济宁",
        priority: "high",
        visitMinutes: 60,
        appointmentAt: "2026-07-28T11:00:00+08:00",
      },
    ],
  };
}

async function login() {
  const result = await request(backendBaseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account: LOGIN_ACCOUNT, password: LOGIN_PASSWORD }),
  });
  assert.equal(result.response.status, 200);
  return {
    cookie: result.response.headers.get("set-cookie").split(";", 1)[0],
    csrfToken: result.body.csrfToken,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-ai-platform-integration-"));

  const aiConfig = loadAiPlatformConfig({
    nodeEnv: "test",
    databasePath: join(tempDir, "ai-platform.sqlite"),
    authSecret: PLATFORM_SECRET,
    taskPollMs: 5,
    taskLeaseMs: 5_000,
    taskConcurrency: 2,
    taskOwnerConcurrency: 2,
    executionMode: "local-simulated",
    staticDirectory: "outputs/ai-platform-admin",
  });
  aiPlatformServer = createAiPlatformServer({
    config: aiConfig,
    autoStart: true,
    logger: { error() {} },
  });
  await listen(aiPlatformServer);
  aiPlatformBaseUrl = `http://127.0.0.1:${aiPlatformServer.address().port}`;

  backendServer = createBackendServer({
    nodeEnv: "test",
    databaseUrl: join(tempDir, "backend.sqlite"),
    seed: true,
      authRequired: true,
      authAccount: LOGIN_ACCOUNT,
      authPasswordHash: LOGIN_PASSWORD_HASH,
      authSessionSecret: SESSION_SECRET,
    aiAnalysisMode: "model",
    aiPlatformMode: "required",
    aiPlatformBaseUrl,
    aiPlatformAuthSecret: PLATFORM_SECRET,
    aiPlatformTargetModel: "gpt-5.6-luna",
    aiPlatformTargetReasoningEffort: "max",
    aiPlatformExecutionMode: "local-simulated",
    aiPlatformMaxWaitMs: 5_000,
    aiPlatformPollMs: 10,
    aiPlatformRequestTimeoutMs: 5_000,
    modelApiKey: "test-model-key-must-not-be-used",
    amapClient: createAmapFixture(),
    allowAiPlatformTestLoopbackHttp: true,
    proactiveAssistantAutoRun: false,
    hospitalTenderAutoRun: false,
    dailyDigestAutoRun: false,
    actionReminderAutoRun: false,
    invoiceEscalationAutoRun: false,
    proactiveNotificationAutoRun: false,
  });
  await listen(backendServer);
  backendBaseUrl = `http://127.0.0.1:${backendServer.address().port}`;
});

afterEach(async () => {
  await close(backendServer);
  backendServer = null;
  await close(aiPlatformServer, "closeAiPlatform");
  aiPlatformServer = null;
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("backend and AI platform HTTP integration", () => {
  it("routes a real backend analysis through the platform and preserves server identity", async () => {
    const session = await login();
    const forged = await request(backendBaseUrl, "/api/quick-records", {
      method: "POST",
      headers: {
        Cookie: session.cookie,
        "X-CSRF-Token": session.csrfToken,
      },
      body: JSON.stringify({
        rawContent: "客户希望推进智慧医院项目",
        owner: "forged-owner",
      }),
    });
    assert.equal(forged.response.status, 422);

    const created = await request(backendBaseUrl, "/api/quick-records", {
      method: "POST",
      headers: {
        Cookie: session.cookie,
        "X-CSRF-Token": session.csrfToken,
      },
      body: JSON.stringify({
        rawContent: "客户希望推进智慧医院项目，下一步确认预算和决策链。",
        sourceChannel: "integration-test",
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.owner, LOGIN_ACCOUNT);

    const analyzed = await request(
      backendBaseUrl,
      `/api/quick-records/${created.body.item.id}/analyze`,
      {
        method: "POST",
        headers: {
          Cookie: session.cookie,
          "X-CSRF-Token": session.csrfToken,
        },
      },
    );
    assert.equal(analyzed.response.status, 201);
    assert.equal(analyzed.body.item.source, "mock_model_fallback");

    const admin = platformToken({
      owner: "platform-admin",
      actor: "platform-admin",
      scopes: ["ai:admin:read"],
    });
    const tasks = await request(
      aiPlatformBaseUrl,
      "/internal/ai/v1/admin/tasks?feature=quick_record_analysis&includeInput=true",
      { headers: { Authorization: `Bearer ${admin}` } },
    );
    assert.equal(tasks.response.status, 200);
    assert.equal(tasks.body.items.length, 1);
    const task = tasks.body.items[0];
    assert.equal(task.owner, LOGIN_ACCOUNT);
    assert.equal(task.actor, LOGIN_ACCOUNT);
    assert.equal(task.channel, "web");
    assert.equal(task.taskType, "quick-record.analyze");
    assert.equal(task.status, "succeeded");
    assert.equal(task.input.model, "gpt-5.6-luna");
    assert.equal(task.input.reasoningEffort, "max");
    assert.equal(task.input.request.model, "gpt-5.6-luna");
    assert.equal(task.input.request.reasoningEffort, "max");

    const detail = await request(
      aiPlatformBaseUrl,
      `/internal/ai/v1/admin/tasks/${task.id}`,
      { headers: { Authorization: `Bearer ${admin}` } },
    );
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.item.task.output.metadata.executionMode, "local-simulated");
    assert.equal(detail.body.item.task.output.metadata.logicalTargetModel, "gpt-5.6-luna");
    assert.equal(detail.body.item.task.output.metadata.targetReasoningEffort, "max");
    assert.ok(detail.body.item.usageLedger.length >= 1);
  });

  it("enforces platform owner isolation and ignores task-body identity fields", async () => {
    const ownerA = platformToken({
      owner: "owner-a",
      actor: "actor-a",
      scopes: ["ai:task:create", "ai:task:read"],
    });
    const ownerB = platformToken({
      owner: "owner-b",
      actor: "actor-b",
      scopes: ["ai:task:read"],
    });
    const created = await request(aiPlatformBaseUrl, "/internal/ai/v1/tasks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerA}`,
        "Idempotency-Key": "owner-isolation-integration",
      },
      body: JSON.stringify({
        taskType: "quick-record.analyze",
        feature: "owner-isolation-integration",
        channel: "web",
        owner: "forged-owner",
        actor: "forged-actor",
        input: { text: "owner A private task" },
      }),
    });
    assert.equal(created.response.status, 202);

    await aiPlatformServer.aiPlatform.taskService.runPending();

    const hidden = await request(
      aiPlatformBaseUrl,
      `/internal/ai/v1/tasks/${created.body.item.taskId}`,
      { headers: { Authorization: `Bearer ${ownerB}` } },
    );
    assert.equal(hidden.response.status, 404);

    const admin = platformToken({
      owner: "platform-admin",
      actor: "platform-admin",
      scopes: ["ai:admin:read"],
    });
    const detail = await request(
      aiPlatformBaseUrl,
      `/internal/ai/v1/admin/tasks/${created.body.item.taskId}`,
      { headers: { Authorization: `Bearer ${admin}` } },
    );
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.item.task.owner, "owner-a");
    assert.equal(detail.body.item.task.actor, "actor-a");
    assert.equal(detail.body.item.task.input.owner, undefined);
    assert.equal(detail.body.item.task.input.actor, undefined);
  });

  it("routes an authenticated itinerary plan through the platform with a stable subject", async () => {
    const session = await login();
    const created = await request(backendBaseUrl, "/api/itineraries", {
      method: "POST",
      headers: {
        Cookie: session.cookie,
        "X-CSRF-Token": session.csrfToken,
      },
      body: JSON.stringify(itineraryPayload()),
    });
    assert.equal(created.response.status, 201);

    const admin = platformToken({
      owner: "platform-admin",
      actor: "platform-admin",
      scopes: ["ai:admin:read"],
    });
    const tasks = await request(
      aiPlatformBaseUrl,
      "/internal/ai/v1/admin/tasks?feature=itinerary_order&includeInput=true",
      { headers: { Authorization: `Bearer ${admin}` } },
    );
    assert.equal(tasks.response.status, 200);
    assert.equal(tasks.body.items.length, 1);
    const task = tasks.body.items[0];
    assert.equal(task.owner, LOGIN_ACCOUNT);
    assert.equal(task.actor, LOGIN_ACCOUNT);
    assert.equal(task.channel, "web");
    assert.equal(task.taskType, "itinerary.enhance");
    assert.deepEqual(task.subject, {
      type: "itinerary",
      id: `itinerary-${created.body.item.id}`,
    });
    assert.equal(task.input.model, "gpt-5.6-luna");
    assert.equal(task.input.reasoningEffort, "max");
    assert.equal(task.input.request.model, "gpt-5.6-luna");
    assert.equal(task.input.request.reasoningEffort, "max");
  });

  it("keeps health responses free of platform and legacy credentials", async () => {
    const health = await request(backendBaseUrl, "/api/health");
    assert.equal(health.response.status, 200);
    const serialized = JSON.stringify(health.body);
    assert.doesNotMatch(serialized, new RegExp(PLATFORM_SECRET, "u"));
    assert.doesNotMatch(serialized, /test-model-key-must-not-be-used/u);
    assert.doesNotMatch(serialized, /authPassword|authSessionSecret|apiKey|secret|token/iu);
    assert.equal(health.body.aiPlatform.targetModel, "gpt-5.6-luna");
    assert.equal(health.body.aiPlatform.targetReasoningEffort, "max");
    assert.equal(health.body.aiPlatform.executionMode, "local-simulated");
  });

  it("fails closed without a platform instead of calling the legacy provider", async () => {
    await close(backendServer);
    const legacyCalls = [];
    backendServer = createBackendServer({
      nodeEnv: "test",
      databaseUrl: join(tempDir, "backend-no-platform.sqlite"),
      seed: true,
      authRequired: false,
      aiAnalysisMode: "model",
      aiPlatformMode: "required",
      aiPlatformBaseUrl: "",
      aiPlatformAuthSecret: PLATFORM_SECRET,
      modelApiKey: "test-model-key-must-not-be-used",
      fetchImpl: async (url, options) => {
        legacyCalls.push({ url: String(url), options });
        throw new Error("legacy provider must not be called");
      },
      allowAiPlatformTestLoopbackHttp: true,
      proactiveAssistantAutoRun: false,
      hospitalTenderAutoRun: false,
      dailyDigestAutoRun: false,
      actionReminderAutoRun: false,
      invoiceEscalationAutoRun: false,
      proactiveNotificationAutoRun: false,
    });
    await listen(backendServer);
    backendBaseUrl = `http://127.0.0.1:${backendServer.address().port}`;

    const originalFetch = globalThis.fetch;
    const preview = await request(backendBaseUrl, "/api/quick-records/preview", {
      method: "POST",
      body: JSON.stringify({ rawContent: "不应调用旧模型供应商" }),
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.item.source, "mock_model_fallback");
    assert.equal(legacyCalls.length, 0);
    assert.equal(originalFetch, globalThis.fetch);
  });
});
