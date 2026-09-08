import assert from "node:assert/strict";
import test from "node:test";

import { openAiPlatformDatabase } from "../db/index.js";
import { createAdminService } from "./adminService.js";

const ADMIN = Object.freeze({
  issuer: "admin-test",
  subject: "admin-user",
  actor: "admin-user",
  owner: "admin-owner",
  scopes: ["ai:admin:*"],
  isAdmin: true,
});

const READ_ONLY = Object.freeze({
  issuer: "admin-test",
  subject: "reader",
  actor: "reader",
  owner: "reader-owner",
  scopes: ["ai:admin:read"],
  isAdmin: true,
});

function fixedClock() {
  return new Date("2026-09-07T00:00:00.000Z");
}

function fixture() {
  const db = openAiPlatformDatabase(":memory:", { clock: fixedClock });
  const service = createAdminService({ db, clock: fixedClock });
  return { db, service };
}

function agentDraft(standardId, overrides = {}) {
  return {
    slug: "review-agent",
    name: "Review Agent",
    description: "Agent used by the admin service test",
    taskTypes: ["suggestion.generate"],
    systemPrompt: "Use only the supplied facts.",
    instructions: { factsFirst: true, noDirectWrite: true },
    tools: [],
    modelPolicy: { modelId: "model-mock-standard-v1", providerId: "provider-mock", externalAllowed: false },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    standardIds: [standardId],
    limits: { maxTokens: 500, timeoutMs: 1_000, maxSteps: 4, maxAttempts: 1 },
    ...overrides,
  };
}

test("admin reads all resource families and never echoes provider secrets", () => {
  const { db, service } = fixture();
  try {
    db.prepare("UPDATE providers SET config_json = $config WHERE id = $id").run({
      $config: JSON.stringify({ apiKey: "test-provider-api-key", endpoint: "https://provider.invalid" }),
      $id: "provider-mock",
    });
    const overview = service.getOverview({ identity: ADMIN });
    assert.equal(overview.tasks.queueDepth, 0);
    assert.equal(overview.providers.total, 1);
    assert.equal(overview.providers.items[0].credentialConfigured, true);

    assert.equal(service.listAgents({ identity: ADMIN }).total, 12);
    assert.equal(service.listStandards({ identity: ADMIN }).total, 1);
    const models = service.listModels({ identity: ADMIN });
    assert.equal(models.total, 1);
    assert.equal(models.items[0].credentialConfigured, true);
    assert.equal(Object.hasOwn(models.items[0], "config"), false);
    assert.equal(JSON.stringify(models).includes("test-provider-api-key"), false);
    assert.equal(service.listPrices({ identity: ADMIN }).total, 1);
    assert.equal(service.listBudgetPolicies({ identity: ADMIN }).total, 1);
    assert.equal(service.listSchedules({ identity: ADMIN }).total, 1);
    assert.equal(service.listTasks({ identity: ADMIN }).total, 0);
    assert.equal(service.listAudit({ identity: ADMIN }).total, 0);
  } finally {
    db.close();
  }
});

test("provider, model, and price details are read-only and keep secrets masked", () => {
  const { db, service } = fixture();
  try {
    db.prepare("UPDATE providers SET config_json = $config WHERE id = $id").run({
      $config: JSON.stringify({
        apiKey: "test-provider-detail-secret",
        endpoint: "https://provider-detail.invalid/v1",
      }),
      $id: "provider-mock",
    });
    db.prepare("UPDATE models SET capabilities_json = $capabilities WHERE id = $id").run({
      $capabilities: JSON.stringify({
        text: true,
        credential: "model-detail-secret",
        endpoint: "https://model-detail.invalid",
      }),
      $id: "model-mock-standard-v1",
    });
    const auditBefore = db.prepare("SELECT COUNT(*) AS count FROM admin_audit").get().count;

    const provider = service.getProvider({ identity: ADMIN, providerId: "provider-mock" });
    assert.equal(provider.id, "provider-mock");
    assert.equal(provider.credentialConfigured, true);
    assert.equal(Object.hasOwn(provider, "config"), false);
    assert.equal(JSON.stringify(provider).includes("test-provider-detail-secret"), false);
    assert.equal(JSON.stringify(provider).includes("provider-detail.invalid"), false);
    assert.equal(service.readProvider, service.getProvider);

    const model = service.getModel({ identity: ADMIN, id: "model-mock-standard-v1" });
    assert.equal(model.providerId, "provider-mock");
    assert.equal(model.capabilities.text, true);
    assert.equal(model.capabilities.credential, "[redacted]");
    assert.equal(model.capabilities.endpoint, "[redacted]");
    assert.equal(model.credentialConfigured, true);
    assert.equal(JSON.stringify(model).includes("model-detail-secret"), false);
    assert.equal(service.readModel, service.getModel);

    const price = service.getPrice({ identity: ADMIN, priceVersionId: "price-mock-zero-v1" });
    assert.equal(price.id, "price-mock-zero-v1");
    assert.equal(price.modelId, "model-mock-standard-v1");
    assert.equal(price.providerId, "provider-mock");
    assert.equal(service.readPrice, service.getPrice);

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM admin_audit").get().count, auditBefore);
    assert.throws(
      () => service.getProvider({ identity: ADMIN, providerId: "provider-does-not-exist" }),
      (error) => error.code === "not_found",
    );
    assert.throws(
      () => service.getModel({ identity: ADMIN, modelId: "model-does-not-exist" }),
      (error) => error.code === "not_found",
    );
    assert.throws(
      () => service.getPrice({ identity: ADMIN, priceId: "price-does-not-exist" }),
      (error) => error.code === "not_found",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM admin_audit").get().count, auditBefore);
  } finally {
    db.close();
  }
});

test("agent and standard drafts are immutable-versioned and publish/rollback is optimistic", () => {
  const { db, service } = fixture();
  try {
    const standard = service.createStandardDraft({
      identity: ADMIN,
      requestId: "standard-create",
      standardId: "standard-review",
      draft: {
        slug: "review-standard",
        name: "Review Standard",
        content: "Separate facts from inferences.",
        rules: { requireUnknowns: true },
      },
    });
    assert.equal(standard.lifecycle, "draft");
    assert.equal(standard.versions.length, 1);

    const agent = service.createAgentDraft({
      identity: ADMIN,
      requestId: "agent-create",
      agentId: "agent-review",
      draft: agentDraft(standard.draftVersionId),
    });
    const originalUpdatedAt = agent.updatedAt;
    const updated = service.updateAgentDraft({
      identity: ADMIN,
      requestId: "agent-update",
      agentId: agent.id,
      expectedUpdatedAt: originalUpdatedAt,
      draft: { systemPrompt: "Use only current, supplied facts." },
    });
    assert.equal(updated.versions.length, 2);
    assert.notEqual(updated.updatedAt, originalUpdatedAt);
    assert.throws(
      () => service.updateAgentDraft({
        identity: ADMIN,
        agentId: agent.id,
        expectedUpdatedAt: originalUpdatedAt,
        draft: { description: "stale update" },
      }),
      (error) => error.code === "conflict",
    );

    const seedAgent = service.getAgent({ identity: ADMIN, agentId: "agent-suggestion" });
    service.updateAgentDraft({
      identity: ADMIN,
      requestId: "disable-seed-agent",
      agentId: seedAgent.id,
      expectedUpdatedAt: seedAgent.updatedAt,
      draft: { lifecycle: "disabled" },
    });
    assert.throws(
      () => service.publishAgent({
        identity: ADMIN,
        agentId: agent.id,
        expectedUpdatedAt: updated.updatedAt,
        versionId: updated.draftVersionId,
      }),
      (error) => error.code === "invalid_request",
    );
    const published = service.publishAgent({
      identity: ADMIN,
      requestId: "agent-publish",
      agentId: agent.id,
      expectedUpdatedAt: updated.updatedAt,
      versionId: updated.draftVersionId,
      testRunId: "offline-case-1",
    });
    assert.equal(published.activeVersion.id, updated.draftVersionId);
    assert.equal(published.activeRelease.testRunId, "offline-case-1");

    const rolledBack = service.rollbackAgent({
      identity: ADMIN,
      requestId: "agent-rollback",
      agentId: agent.id,
      expectedUpdatedAt: published.updatedAt,
      targetVersionId: agent.latestVersion.id,
    });
    assert.equal(rolledBack.activeVersion.id, agent.latestVersion.id);
    assert.equal(rolledBack.releases.filter((release) => release.status === "active").length, 1);
    assert.equal(rolledBack.versions.length, 2);

    const standardUpdated = service.updateStandardDraft({
      identity: ADMIN,
      requestId: "standard-update",
      standardId: standard.id,
      expectedVersionId: standard.latestVersion.id,
      draft: { content: "Separate facts, inferences, unknowns, and suggestions." },
    });
    assert.equal(standardUpdated.versions.length, 2);
    assert.throws(
      () => service.updateStandardDraft({
        identity: ADMIN,
        standardId: standard.id,
        expectedVersionId: standard.latestVersion.id,
        draft: { content: "stale" },
      }),
      (error) => error.code === "conflict",
    );

    const audit = service.listAudit({ identity: ADMIN });
    assert.equal(audit.total, 7);
    assert.equal(audit.items.some((entry) => entry.action === "agent.publish"), true);
    assert.equal(JSON.stringify(audit).includes("offline-case-1"), true);
  } finally {
    db.close();
  }
});

test("budget and schedule writes require a fresh condition and are audited", () => {
  const { db, service } = fixture();
  try {
    const budget = service.getBudgetPolicy({ identity: ADMIN, policyId: "budget-global-daily" });
    const disabled = service.setBudgetEnabled({
      identity: ADMIN,
      requestId: "budget-disable",
      policyId: budget.id,
      expectedUpdatedAt: budget.updatedAt,
      enabled: false,
    });
    assert.equal(disabled.enabled, false);
    assert.throws(
      () => service.setBudgetEnabled({
        identity: ADMIN,
        policyId: budget.id,
        expectedUpdatedAt: budget.updatedAt,
        enabled: true,
      }),
      (error) => error.code === "conflict",
    );

    const schedule = service.getSchedule({ identity: ADMIN, scheduleId: "schedule-proactive" });
    const enabled = service.setScheduleEnabled({
      identity: ADMIN,
      requestId: "schedule-enable",
      scheduleId: schedule.id,
      expectedUpdatedAt: schedule.updatedAt,
      enabled: true,
    });
    assert.equal(enabled.enabled, true);
    assert.ok(enabled.nextRunAt);
    const stopped = service.updateSchedule({
      identity: ADMIN,
      requestId: "schedule-disable",
      scheduleId: schedule.id,
      expectedUpdatedAt: enabled.updatedAt,
      patch: { enabled: false, intervalSeconds: 7200 },
    });
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.nextRunAt, null);
    assert.equal(stopped.intervalSeconds, 7200);

    const audit = service.listAudit({ identity: ADMIN });
    assert.equal(audit.total, 3);
    assert.deepEqual(audit.items.map((entry) => entry.action).sort(), ["budget.update", "schedule.update", "schedule.update"]);
  } finally {
    db.close();
  }
});

test("task and attempt details support cost aggregation without exposing lease tokens", () => {
  const { db, service } = fixture();
  try {
    const taskId = "task-admin-detail";
    const timestamp = "2026-09-07T00:00:00.000Z";
    db.prepare(`
      INSERT INTO tasks (
        id, request_id, issuer, owner, actor, channel, feature, task_type,
        priority, input_json, request_hash, idempotency_key, agent_version_id,
        model_id, standard_digest, status, source, output_json, output_digest,
        current_attempt, requested_at, started_at, completed_at, updated_at
      ) VALUES (
        $id, 'request-admin-detail', 'business-test', 'owner-1', 'actor-1', 'web',
        'admin-test', 'quick-record.analyze', 'normal', $input, $requestHash,
        'task-admin-detail', 'agent-quick-record-v1', 'model-mock-standard-v1',
        $standardDigest, 'succeeded', 'mock', $output, $outputDigest, 1,
        $at, $at, $at, $at
      )
    `).run({
      $id: taskId,
      $input: JSON.stringify({ note: "test input" }),
      $requestHash: "a".repeat(64),
      $standardDigest: "b".repeat(64),
      $output: JSON.stringify({ schemaVersion: "ai-task-result-v1", status: "success", source: "mock" }),
      $outputDigest: "c".repeat(64),
      $at: timestamp,
    });
    db.prepare(`
      INSERT INTO task_attempts (
        id, task_id, attempt_no, provider_id, model_id, status, lease_token,
        request_meta_json, response_meta_json, input_tokens, output_tokens,
        cost_micro, cost_status, price_version_id, external_request_id,
        started_at, completed_at
      ) VALUES (
        'attempt-admin-detail', $taskId, 1, 'provider-mock', 'model-mock-standard-v1',
        'succeeded', 'secret-lease-token', '{}', '{}', 10, 20, 0,
        'calculated', 'price-mock-zero-v1', 'mock-request-1', $at, $at
      )
    `).run({ $taskId: taskId, $at: timestamp });
    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload_json, created_at)
      VALUES ($taskId, 'task.created', '{}', $at)
    `).run({ $taskId: taskId, $at: timestamp });
    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload_json, created_at)
      VALUES ($taskId, 'task.succeeded', '{}', $at)
    `).run({ $taskId: taskId, $at: timestamp });
    db.prepare(`
      INSERT INTO budget_reservations (
        id, task_id, attempt_id, policy_id, period_key, reserved_micro,
        actual_micro, status, created_at, settled_at
      ) VALUES ('reservation-admin-detail', $taskId, 'attempt-admin-detail',
        'budget-global-daily', '2026-09-07', 0, 0, 'settled', $at, $at)
    `).run({ $taskId: taskId, $at: timestamp });
    db.prepare(`
      INSERT INTO usage_ledger (
        task_id, attempt_id, owner, feature, task_type, agent_version_id,
        provider_id, model_id, price_version_id, usage_json, cost_micro,
        cost_status, currency, function_fee_micro, fee_status, occurred_at
      ) VALUES ($taskId, 'attempt-admin-detail', 'owner-1', 'admin-test',
        'quick-record.analyze', 'agent-quick-record-v1', 'provider-mock',
        'model-mock-standard-v1', 'price-mock-zero-v1', $usage, 0,
        'calculated', 'USD', 0, 'not_configured', $at)
    `).run({ $taskId: taskId, $usage: JSON.stringify({ inputTokens: 10, outputTokens: 20 }), $at: timestamp });

    const detail = service.getTaskDetail({ identity: ADMIN, taskId });
    assert.equal(detail.task.id, taskId);
    assert.equal(detail.task.status, "succeeded");
    assert.equal(detail.attempts.length, 1);
    assert.equal(Object.hasOwn(detail.attempts[0], "leaseToken"), false);
    assert.equal(detail.events.length >= 2, true);
    assert.equal(detail.usageLedger.length, 1);

    const tasks = service.listTasks({ identity: ADMIN, owner: "owner-1", includeInput: true });
    assert.equal(tasks.total, 1);
    assert.deepEqual(tasks.items[0].input, { note: "test input" });
    const costs = service.getCostSummary({ identity: ADMIN, groupBy: "feature" });
    assert.equal(costs.calls, 1);
    assert.equal(costs.groups[0].feature, "admin-test");
    assert.equal(costs.groups[0].totalMicro >= 0, true);
    assert.equal(service.getOverview({ identity: ADMIN }).tasks.byStatus.succeeded, 1);
  } finally {
    db.close();
  }
});

test("task attempts and events are paginated, masked, and strictly read-only", () => {
  const { db, service } = fixture();
  try {
    const taskId = "task-admin-activity-pagination";
    const timestamp = "2026-09-07T00:00:00.000Z";
    db.prepare(`
      INSERT INTO tasks (
        id, request_id, issuer, owner, actor, channel, feature, task_type,
        priority, input_json, request_hash, idempotency_key, agent_version_id,
        model_id, standard_digest, status, source, current_attempt,
        requested_at, updated_at
      ) VALUES (
        $id, 'request-admin-activity-pagination', 'test-issuer', 'owner-activity',
        'test-actor', 'web', 'admin-activity', 'quick-record.analyze', 'normal',
        '{}', $requestHash, 'idempotency-admin-activity-pagination',
        'agent-quick-record-v1', 'model-mock-standard-v1', $standardDigest,
        'running', 'mock', 3, $at, $at
      )
    `).run({
      $id: taskId,
      $requestHash: "d".repeat(64),
      $standardDigest: "e".repeat(64),
      $at: timestamp,
    });
    for (const attemptNo of [1, 2, 3]) {
      db.prepare(`
        INSERT INTO task_attempts (
          id, task_id, attempt_no, provider_id, model_id, status, lease_token,
          request_meta_json, response_meta_json, input_tokens, output_tokens,
          cost_micro, cost_status, external_request_id, started_at
        ) VALUES (
          $id, $taskId, $attemptNo, 'provider-mock', 'model-mock-standard-v1',
          'running', $leaseToken, $requestMeta, $responseMeta, 1, 2, 0,
          'not_applicable', $externalRequestId, $at
        )
      `).run({
        $id: `attempt-admin-activity-${attemptNo}`,
        $taskId: taskId,
        $attemptNo: attemptNo,
        $leaseToken: `lease-secret-${attemptNo}`,
        $requestMeta: JSON.stringify({ apiKey: `attempt-api-key-${attemptNo}`, phase: attemptNo }),
        $responseMeta: JSON.stringify({ authorization: `Bearer attempt-token-${attemptNo}` }),
        $externalRequestId: `https://attempt-detail.invalid/${attemptNo}?token=secret`,
        $at: timestamp,
      });
      db.prepare(`
        INSERT INTO task_events (task_id, event_type, payload_json, created_at)
        VALUES ($taskId, $eventType, $payload, $at)
      `).run({
        $taskId: taskId,
        $eventType: `task.activity.${attemptNo}`,
        $payload: JSON.stringify({ apiKey: `event-api-key-${attemptNo}`, url: "https://event-detail.invalid" }),
        $at: timestamp,
      });
    }
    const auditBefore = db.prepare("SELECT COUNT(*) AS count FROM admin_audit").get().count;

    const attempts = service.listTaskAttempts({ identity: ADMIN, taskId, limit: 2, offset: 1 });
    assert.equal(Array.isArray(attempts), false);
    assert.equal(attempts.items.length, 2);
    assert.equal(attempts.rows, attempts.items);
    assert.equal(attempts.total, 3);
    assert.deepEqual(attempts.pagination, { limit: 2, offset: 1, total: 3, hasMore: false });
    assert.deepEqual(attempts.items.map((item) => item.attemptNo), [2, 3]);
    assert.equal(Object.hasOwn(attempts.items[0], "leaseToken"), false);
    assert.equal(attempts.items[0].requestMeta.apiKey, "[redacted]");
    assert.equal(attempts.items[0].responseMeta.authorization, "[redacted]");
    assert.equal(attempts.items[0].externalRequestId, "[redacted]");
    assert.equal(JSON.stringify(attempts).includes("lease-secret"), false);
    assert.equal(JSON.stringify(attempts).includes("attempt-api-key"), false);

    const events = service.listTaskEvents({ identity: ADMIN, taskId, limit: 2, offset: 1 });
    assert.equal(events.items.length, 2);
    assert.equal(events.rows, events.items);
    assert.equal(events.total, 3);
    assert.deepEqual(events.pagination, { limit: 2, offset: 1, total: 3, hasMore: false });
    assert.deepEqual(events.items.map((item) => item.eventType), ["task.activity.2", "task.activity.3"]);
    assert.equal(events.items[0].payload.apiKey, "[redacted]");
    assert.equal(events.items[0].payload.url, "[redacted]");
    assert.equal(JSON.stringify(events).includes("event-api-key"), false);
    assert.equal(JSON.stringify(events).includes("event-detail.invalid"), false);

    const attempt = service.getTaskAttempt({ identity: ADMIN, id: "attempt-admin-activity-1" });
    assert.equal(attempt.attemptNo, 1);
    assert.equal(Object.hasOwn(attempt, "leaseToken"), false);
    assert.throws(
      () => service.listTaskEvents({ identity: ADMIN, taskId: "task-does-not-exist" }),
      (error) => error.code === "not_found",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM admin_audit").get().count, auditBefore);
  } finally {
    db.close();
  }
});

test("read-only administrators cannot mutate and unsafe configuration is rejected", () => {
  const { db, service } = fixture();
  try {
    assert.equal(service.listAgents({ identity: READ_ONLY }).total, 12);
    assert.throws(
      () => service.createStandardDraft({
        identity: READ_ONLY,
        standardId: "standard-nope",
        draft: { slug: "nope", name: "Nope", content: "Nope" },
      }),
      (error) => error.code === "forbidden",
    );
    assert.throws(
      () => service.createAgentDraft({
        identity: ADMIN,
        agentId: "agent-unsafe",
        draft: agentDraft("standard-grounding-v1", { instructions: { sql: "DROP TABLE tasks" } }),
      }),
      (error) => error.code === "invalid_request",
    );
    assert.throws(
      () => service.createAgentDraft({
        identity: ADMIN,
        agentId: "agent-unsafe-url",
        draft: agentDraft("standard-grounding-v1", { tools: ["https://evil.invalid/tool"] }),
      }),
      (error) => error.code === "invalid_request",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agents WHERE id LIKE 'agent-unsafe%'").get().count, 0);
    assert.equal(service.listAudit({ identity: ADMIN }).total, 0);
  } finally {
    db.close();
  }
});

test("matches the current server method surface and request body shape", () => {
  const { db, service } = fixture();
  try {
    const requiredMethods = [
      "getOverview",
      "listProviders",
      "listModels",
      "listPrices",
      "listAgents",
      "getAgent",
      "createAgent",
      "updateAgent",
      "publishAgent",
      "rollbackAgent",
      "listStandards",
      "getStandard",
      "createStandard",
      "updateStandard",
      "listBudgets",
      "getBudgetPolicy",
      "updateBudget",
      "setBudgetEnabled",
      "listSchedules",
      "getSchedule",
      "updateSchedule",
      "setScheduleEnabled",
      "listTasks",
      "getTaskDetail",
      "listTaskAttempts",
      "getTaskAttempt",
      "getCostSummary",
      "listAudit",
    ];
    for (const method of requiredMethods) assert.equal(typeof service[method], "function", method);
    assert.equal(service.getTask, service.getTaskDetail);
    assert.equal(service.getCosts, service.getCostSummary);

    const agents = service.listAgents({ identity: ADMIN, limit: 2, offset: 1 });
    assert.equal(agents.items.length, 2);
    assert.equal(agents.rows, agents.items);
    assert.equal(agents.total, 12);
    assert.deepEqual(agents.pagination, { limit: 2, offset: 1, total: 12, hasMore: true });

    const standard = service.createStandard({
      identity: ADMIN,
      requestId: "server-shaped-standard-create",
      draft: {
        slug: "server-shaped-standard",
        name: "Server-shaped standard",
        content: "Keep facts and inferences separate.",
      },
    });
    const updatedStandard = service.updateStandard({
      identity: ADMIN,
      requestId: "server-shaped-standard-update",
      standardId: standard.id,
      patch: {
        expectedVersionId: standard.latestVersion.id,
        content: "Keep facts, inferences, unknowns, and suggestions separate.",
      },
      expectedVersionId: standard.latestVersion.id,
    });
    assert.equal(updatedStandard.versions.length, 2);

    const agent = service.createAgent({
      identity: ADMIN,
      requestId: "server-shaped-agent-create",
      agentId: "agent-server-shaped",
      draft: agentDraft(standard.draftVersionId, {
        slug: "server-shaped-agent",
        name: "Server-shaped agent",
      }),
    });
    const updatedAgent = service.updateAgent({
      identity: ADMIN,
      requestId: "server-shaped-agent-update",
      agentId: agent.id,
      draft: {
        expectedUpdatedAt: agent.updatedAt,
        systemPrompt: "Use only the supplied, current facts.",
      },
      expectedUpdatedAt: agent.updatedAt,
    });
    assert.equal(updatedAgent.versions.length, 2);

    const budget = service.getBudgetPolicy({ identity: ADMIN, policyId: "budget-global-daily" });
    const updatedBudget = service.updateBudget({
      identity: ADMIN,
      requestId: "server-shaped-budget-update",
      policyId: budget.id,
      patch: { expectedUpdatedAt: budget.updatedAt, enabled: false },
      expectedUpdatedAt: budget.updatedAt,
    });
    assert.equal(updatedBudget.enabled, false);

    const schedule = service.getSchedule({ identity: ADMIN, scheduleId: "schedule-proactive" });
    const updatedSchedule = service.updateSchedule({
      identity: ADMIN,
      requestId: "server-shaped-schedule-update",
      scheduleId: schedule.id,
      patch: { expectedUpdatedAt: schedule.updatedAt, enabled: true },
      expectedUpdatedAt: schedule.updatedAt,
    });
    assert.equal(updatedSchedule.enabled, true);
  } finally {
    db.close();
  }
});

test("publish scope, optimistic failures, and audit redaction stay bounded", () => {
  const { db, service } = fixture();
  try {
    const publishOnly = {
      issuer: "admin-test",
      actor: "publisher",
      owner: "admin-owner",
      scopes: ["ai:admin:publish"],
    };
    const activeAgent = service.getAgent({ identity: ADMIN, agentId: "agent-suggestion" });
    const beforeReleaseCount = db.prepare("SELECT COUNT(*) AS count FROM agent_releases WHERE agent_id = $id").get({ $id: activeAgent.id }).count;
    const beforeAuditCount = service.listAudit({ identity: ADMIN }).total;
    assert.throws(
      () => service.publishAgent({
        identity: publishOnly,
        agentId: activeAgent.id,
        expectedUpdatedAt: "stale-updated-at",
        versionId: activeAgent.activeVersion.id,
        testRunId: "offline-stale",
      }),
      (error) => error.code === "conflict",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_releases WHERE agent_id = $id").get({ $id: activeAgent.id }).count, beforeReleaseCount);
    assert.equal(service.listAudit({ identity: ADMIN }).total, beforeAuditCount);

    const standard = service.getStandard({ identity: ADMIN, standardId: "standard-grounding" });
    assert.throws(
      () => service.createAgent({
        identity: ADMIN,
        agentId: "agent-rejected-url",
        draft: agentDraft(standard.latestVersion.id, {
          slug: "rejected-url-agent",
          name: "Rejected URL agent",
          instructions: { noDirectWrite: true, webhook: "https://secret.invalid/hook" },
        }),
      }),
      (error) => error.code === "invalid_request",
    );
    const secretAgent = service.createAgent({
      identity: ADMIN,
      requestId: "secret-redaction-agent",
      agentId: "agent-secret-redaction",
      draft: agentDraft(standard.latestVersion.id, {
        slug: "secret-redaction-agent",
        name: "Secret redaction agent",
        instructions: { noDirectWrite: true, apiKey: "test-agent-api-key" },
      }),
    });
    const serialized = JSON.stringify(secretAgent);
    assert.equal(serialized.includes("test-agent-api-key"), false);
    const audit = service.listAudit({ identity: ADMIN });
    assert.equal(JSON.stringify(audit).includes("test-agent-api-key"), false);
  } finally {
    db.close();
  }
});
