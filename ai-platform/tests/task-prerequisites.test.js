import assert from "node:assert/strict";
import { test } from "node:test";

import * as priceVersionPinning from "../src/db/migrations/0010_price_version_pinning.mjs";
import { openAiPlatformDatabase } from "../src/db/index.js";
import { loadAiPlatformConfig } from "../src/config.js";
import { createProviderRegistry, mockProvider } from "../src/providers/mockProvider.js";
import { createTaskService } from "../src/tasks/taskService.js";

const BASE_TIME = "2026-09-07T10:00:00.000Z";
const IDENTITY = { issuer: "test-service", owner: "alice", actor: "alice" };

function validRequest() {
  return {
    taskType: "quick-record.analyze",
    feature: "quick-record",
    channel: "web",
    priority: "interactive",
    input: { text: "hello" },
  };
}

function successfulResponse(taskId = "task-test") {
  return {
    externalRequestId: `external-${taskId}`,
    result: {
      schemaVersion: "ai-task-result-v1",
      status: "success",
      source: "test",
      facts: [],
      inferences: [],
      unknowns: [],
      suggestions: [],
      sourceRefs: [{ type: "test", id: taskId }],
      writebackPreview: { requiresHumanConfirmation: true, actions: [] },
      metadata: {},
    },
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 0,
      audioSeconds: 0,
      imagePages: 0,
    },
  };
}

function activeAgentVersionId(db) {
  return db.prepare(`
    SELECT av.id
      FROM agent_versions av
      JOIN agent_releases ar ON ar.agent_version_id = av.id
      JOIN agents a ON a.id = av.agent_id
     WHERE a.slug = 'quick-record' AND ar.status = 'active'
  `).get().id;
}

function configureExternalModel(db, { providerId, modelId, modelName = "fixture-model", limits = {} }) {
  const at = "2026-09-07T00:00:00.000Z";
  db.prepare(`
    INSERT INTO providers (id, name, kind, enabled, config_json, created_at, updated_at)
    VALUES (?, ?, 'openai_compatible', 1, '{}', ?, ?)
  `).run(providerId, "External fixture", at, at);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, capabilities_json, enabled, created_at, updated_at)
    VALUES (?, ?, ?, '{"text":true}', 1, ?, ?)
  `).run(modelId, providerId, modelName, at, at);
  db.prepare(`
    INSERT INTO price_versions (
      id, model_id, version, currency, input_micro_per_1k, output_micro_per_1k,
      cached_input_micro_per_1k, audio_micro_per_minute, image_micro_per_page,
      function_fee_micro, effective_from, effective_to, created_at
    ) VALUES (?, ?, 'fixture-v1', 'USD', 1000, 1000, 0, 0, 0, 0, ?, NULL, ?)
  `).run(`price-${modelId}`, modelId, at, "2026-09-07T00:00:01.000Z");
  db.prepare("UPDATE agent_versions SET model_policy_json = ?, limits_json = ? WHERE id = ?").run(
    JSON.stringify({ providerId, modelId, externalAllowed: true }),
    JSON.stringify({ maxTokens: 3200, maxAttempts: 3, ...limits }),
    activeAgentVersionId(db),
  );
}

function externalHarness(provider, { nodeEnv = "test", config: configOverrides = {} } = {}) {
  const currentTime = new Date(BASE_TIME);
  const db = openAiPlatformDatabase(":memory:", { clock: () => currentTime });
  const config = loadAiPlatformConfig({
    nodeEnv,
    databasePath: ":memory:",
    executionMode: "external-provider",
    externalProvidersEnabled: true,
    taskAdmissionEnabled: true,
    ...(nodeEnv === "production" ? { authSecret: Buffer.alloc(32, 97).toString("base64url") } : {}),
    ...configOverrides,
  });
  configureExternalModel(db, { providerId: provider.id, modelId: "model-external-fixture" });
  const service = createTaskService({
    db,
    config,
    providerRegistry: createProviderRegistry({ providers: [provider] }),
    clock: () => currentTime,
    logger: { error() {}, warn() {} },
  });
  return { db, service };
}

test("0010 adds a rerunnable task price pin and backfills legacy nulls by requested_at", () => {
  const db = openAiPlatformDatabase(":memory:");
  try {
    const columns = db.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name);
    assert.ok(columns.includes("price_version_id"));

    const taskId = "task-legacy-price-pin";
    const agentVersionId = activeAgentVersionId(db);
    db.prepare(`
      INSERT INTO tasks (
        id, request_id, issuer, owner, actor, channel, feature, task_type, priority,
        input_json, request_hash, idempotency_key, agent_version_id, model_id,
        standard_digest, status, source, requested_at, updated_at
      ) VALUES (?, ?, 'legacy', 'alice', 'alice', 'web', 'quick-record',
        'quick-record.analyze', 'interactive', '{}', ?, ?, ?,
        'model-mock-standard-v1', 'legacy-digest', 'queued', 'model', ?, ?)
    `).run(taskId, `request-${taskId}`, `hash-${taskId}`, `key-${taskId}`, agentVersionId, BASE_TIME, BASE_TIME);
    db.prepare(`
      INSERT INTO price_versions (
        id, model_id, version, currency, input_micro_per_1k, output_micro_per_1k,
        cached_input_micro_per_1k, audio_micro_per_minute, image_micro_per_page,
        function_fee_micro, effective_from, effective_to, created_at
      ) VALUES ('price-mock-retroactive-v1', 'model-mock-standard-v1', 'retroactive-v1',
        'CNY', 10, 20, 0, 0, 0, 0, '2026-09-07T00:00:00.000Z', NULL,
        '2026-09-11T00:00:00.000Z')
    `).run();

    priceVersionPinning.apply(db);
    assert.equal(
      db.prepare("SELECT price_version_id FROM tasks WHERE id = ?").get(taskId).price_version_id,
      "price-mock-retroactive-v1",
    );

    db.prepare("UPDATE tasks SET price_version_id = 'price-mock-zero-v1' WHERE id = ?").run(taskId);
    priceVersionPinning.apply(db);
    assert.equal(
      db.prepare("SELECT price_version_id FROM tasks WHERE id = ?").get(taskId).price_version_id,
      "price-mock-zero-v1",
    );
  } finally {
    db.close();
  }
});

test("createTask pins its selected price and claim never reselects a retroactive version", async () => {
  const currentTime = new Date(BASE_TIME);
  const db = openAiPlatformDatabase(":memory:", { clock: () => currentTime });
  const service = createTaskService({
    db,
    config: loadAiPlatformConfig({ databasePath: ":memory:" }),
    providerRegistry: createProviderRegistry({ providers: [mockProvider] }),
    clock: () => currentTime,
    logger: { error() {}, warn() {} },
  });
  try {
    const created = service.createTask({ identity: IDENTITY, idempotencyKey: "price-pin", request: validRequest() });
    assert.equal(
      db.prepare("SELECT price_version_id FROM tasks WHERE id = ?").get(created.taskId).price_version_id,
      "price-mock-zero-v1",
    );
    db.prepare(`
      INSERT INTO price_versions (
        id, model_id, version, currency, input_micro_per_1k, output_micro_per_1k,
        cached_input_micro_per_1k, audio_micro_per_minute, image_micro_per_page,
        function_fee_micro, effective_from, effective_to, created_at
      ) VALUES ('price-mock-retroactive-v2', 'model-mock-standard-v1', 'retroactive-v2',
        'CNY', 5000, 5000, 0, 0, 0, 0, '2026-09-07T00:00:00.000Z', NULL,
        '2026-09-11T00:00:00.000Z')
    `).run();

    await service.runPending();
    assert.equal(
      db.prepare("SELECT price_version_id FROM task_attempts WHERE task_id = ?").get(created.taskId).price_version_id,
      "price-mock-zero-v1",
    );
    assert.equal(
      db.prepare("SELECT price_version_id FROM usage_ledger WHERE task_id = ?").get(created.taskId).price_version_id,
      "price-mock-zero-v1",
    );
  } finally {
    await service.close();
    db.close();
  }
});

test("task admission rejects a provider missing from providerRegistry", async () => {
  const currentTime = new Date(BASE_TIME);
  const db = openAiPlatformDatabase(":memory:");
  const service = createTaskService({
    db,
    config: loadAiPlatformConfig({ databasePath: ":memory:", taskAdmissionEnabled: true }),
    providerRegistry: createProviderRegistry({ providers: [] }),
    clock: () => currentTime,
  });
  try {
    assert.throws(
      () => service.createTask({ identity: IDENTITY, idempotencyKey: "provider-missing", request: validRequest() }),
      (error) => error.code === "provider_unavailable" && error.status === 503,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  } finally {
    await service.close();
    db.close();
  }
});

test("task admission rejects an external provider that does not support the task capability", async () => {
  const provider = {
    id: "provider-external-capability",
    kind: "openai_compatible",
    supports: () => false,
    readiness: () => ({ configured: true, ready: true, liveReady: true }),
    async execute() { return successfulResponse(); },
  };
  const { db, service } = externalHarness(provider);
  try {
    assert.throws(
      () => service.createTask({ identity: IDENTITY, idempotencyKey: "capability-missing", request: validRequest() }),
      (error) => error.code === "provider_capability_unsupported" && error.status === 503,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  } finally {
    await service.close();
    db.close();
  }
});

test("task admission rejects an external provider without credential/readiness", async () => {
  const provider = {
    id: "provider-external-not-ready",
    kind: "openai_compatible",
    supports: () => true,
    readiness: () => ({ configured: false, ready: false, liveReady: false }),
    async execute() { return successfulResponse(); },
  };
  const { db, service } = externalHarness(provider);
  try {
    assert.throws(
      () => service.createTask({ identity: IDENTITY, idempotencyKey: "provider-not-ready", request: validRequest() }),
      (error) => error.code === "provider_not_ready" && error.status === 503,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  } finally {
    await service.close();
    db.close();
  }
});

test("production external admission requires liveReady and forces maxAttempts to one", async () => {
  let calls = 0;
  const provider = {
    id: "provider-external-production",
    kind: "openai_compatible",
    supports: () => true,
    readiness: () => ({ configured: true, probeReady: true, ready: true, liveReady: false }),
    async execute() {
      calls += 1;
      return successfulResponse("production-live-ready");
    },
  };
  const blocked = externalHarness(provider, { nodeEnv: "production" });
  try {
    const readiness = blocked.service.configurationReadiness()["quick-record.analyze"];
    assert.equal(readiness.configured, true);
    assert.equal(readiness.liveReady, false);
    assert.equal(readiness.ready, false);
    assert.throws(
      () => blocked.service.createTask({ identity: IDENTITY, idempotencyKey: "production-not-live", request: validRequest() }),
      (error) => error.code === "provider_live_not_ready" && error.status === 503,
    );
  } finally {
    await blocked.service.close();
    blocked.db.close();
  }

  const liveProvider = {
    ...provider,
    id: "provider-external-production-live",
    readiness: () => ({ configured: true, probeReady: true, ready: true, liveReady: true }),
    async execute() {
      calls += 1;
      const error = new Error("one attempt fixture");
      error.code = "temporary_failure";
      error.retryable = true;
      throw error;
    },
  };
  const live = externalHarness(liveProvider, { nodeEnv: "production" });
  try {
    const created = live.service.createTask({ identity: IDENTITY, idempotencyKey: "production-live", request: validRequest() });
    const event = live.db.prepare(`
      SELECT payload_json FROM task_events WHERE task_id = ? AND event_type = 'task.created'
    `).get(created.taskId);
    assert.equal(JSON.parse(event.payload_json).maxAttempts, 1);
    const result = await live.service.runPending();
    assert.equal(result.results[0].retry, false);
    assert.equal(calls, 1);
    assert.equal(live.service.readTask({ identity: IDENTITY, taskId: created.taskId }).status, "failed");
  } finally {
    await live.service.close();
    live.db.close();
  }
});
