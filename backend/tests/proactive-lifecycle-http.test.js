import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { proactivePreviewDigest } from "../src/assistant/proactiveAssistant.js";
import { createServer } from "../src/server.js";

const accountA = "lifecyclea";
const accountB = "lifecycleb";
const loginSeedA = ["lifecycle", "password", "a"].join("-");
const loginSeedB = ["lifecycle", "password", "b"].join("-");
const machineSeed = ["lifecycle", "machine", "token"].join("-");

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let sessionA;
let sessionB;
let lifecycleSuggestion;
let fieldsSuggestion;
let rollbackSuggestion;

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

async function login(account, password) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  });
  assert.equal(result.response.status, 200);
  return {
    cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    csrf: result.body.csrfToken,
  };
}

function asUser(session) {
  return (path, options = {}) => request(path, {
    ...options,
    headers: {
      Cookie: session.cookie,
      ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": session.csrf } : {}),
      ...(options.headers ?? {}),
    },
  });
}

function makeSuggestion(id, opportunityId = "lifecycle-opportunity") {
  const suggestion = {
    id,
    schemaVersion: "proactive-assistant-v1",
    modelVersion: "rules/proactive-v1",
    subjectType: "opportunity",
    subjectId: opportunityId,
    customerId: "lifecycle-customer",
    opportunityId,
    opportunityVersion: 1,
    customerVersion: 1,
    customerName: "生命周期客户",
    title: "补充下一步",
    conclusion: "建议补充可执行动作。",
    facts: [{ key: "opportunity.next", value: null, sourceRefs: [{ type: "opportunity", id: opportunityId }] }],
    inferences: [],
    unknowns: [],
    risks: [],
    nextActions: [],
    evidenceRefs: [{ type: "opportunity", id: opportunityId }],
    sourceRefs: [{ type: "opportunity", id: opportunityId }],
    confidence: null,
    confidenceLevel: "unverified",
    confidenceCalibrated: false,
    priority: null,
    priorityCalibrated: false,
    trigger: { type: "missing_next_step", reason: "next 为空", detectedAt: "2026-09-05T04:00:00.000Z" },
    source: "deterministic",
    fallbackReason: null,
    writebackPreview: {
      requiresHumanConfirmation: true,
      automaticWriteAllowed: false,
      action: {
        title: "联系客户补充下一步",
        reason: "商机没有下一步记录。",
        customerId: "lifecycle-customer",
        opportunityId,
        assignee: accountA,
        due: "2099-01-01",
        priority: "中",
        expectedResult: "确认下一次沟通时间",
        requiresHumanConfirmation: true,
      },
    },
    writebackAllowed: false,
  };
  const digest = proactivePreviewDigest(suggestion, "action");
  suggestion.previewDigests = { action: digest };
  suggestion.previewDigest = digest;
  suggestion.writebackPreview.previewDigest = digest;
  return suggestion;
}

async function createPreview(asA, suggestion, key) {
  const result = await asA(`/api/assistant/proactive/${suggestion.id}/previews`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ target: "action" }),
  });
  assert.equal(result.response.status, 201);
  return result.body.item;
}

describe("proactive assistant lifecycle HTTP contract", () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sentelligent-proactive-lifecycle-http-"));
    databaseUrl = join(tempDir, "lifecycle.sqlite");
    server = createServer({
      databaseUrl,
      seed: false,
      nodeEnv: "test",
      authRequired: true,
      authAccount: accountA,
      authPassword: "",
      authPasswordHash: await hashPassword(loginSeedA, { salt: Buffer.alloc(16, 61) }),
      authSessionSecret: Buffer.alloc(32, 62).toString("base64url"),
      authCookieSecure: false,
      proactiveAssistantAutoRun: false,
      weixinAgentApiToken: machineSeed,
      weixinAgentOwner: accountA,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const db = createConnection({ databaseUrl });
    try {
      const now = "2026-09-05T04:00:00.000Z";
      db.prepare(`
        INSERT INTO users (account, display_name, password_hash, role, status, created_at, updated_at)
        VALUES ($account, 'B', $passwordHash, 'member', 'active', $now, $now)
      `).run({ account: accountB, passwordHash: await hashPassword(loginSeedB, { salt: Buffer.alloc(16, 63) }), now });
      db.prepare(`
        INSERT INTO customers (id, name, owner, version, created_at, updated_at)
        VALUES ('lifecycle-customer', '生命周期客户', $owner, 1, $now, $now)
      `).run({ owner: accountA, now });
      db.prepare(`
        INSERT INTO opportunities (id, customer_id, name, stage, owner, version, days, next, created_at, updated_at)
        VALUES ('lifecycle-opportunity', 'lifecycle-customer', '生命周期商机', '方案输出', $owner, 1, 40, NULL, $now, $now)
      `).run({ owner: accountA, now });
    } finally {
      db.close();
    }
    sessionA = await login(accountA, loginSeedA);
    sessionB = await login(accountB, loginSeedB);
    const repository = server.proactiveSuggestionRepository;
    lifecycleSuggestion = repository.save({ owner: accountA, suggestion: makeSuggestion("lifecycle-suggestion"), dedupeKey: "lifecycle:state" }).item;
    fieldsSuggestion = repository.save({ owner: accountA, suggestion: makeSuggestion("fields-suggestion"), dedupeKey: "lifecycle:fields" }).item;
    rollbackSuggestion = repository.save({ owner: accountA, suggestion: makeSuggestion("rollback-suggestion"), dedupeKey: "lifecycle:rollback" }).item;
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  it("enforces user ownership, idempotency, version checks, and lifecycle transitions", async () => {
    const asA = asUser(sessionA);
    const asB = asUser(sessionB);
    const missingKey = await asA(`/api/assistant/proactive/${lifecycleSuggestion.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "snoozed", snoozedUntil: "2099-01-01T00:00:00.000Z" }),
    });
    assert.equal(missingKey.response.status, 428);

    const machine = await request(`/api/assistant/proactive/${lifecycleSuggestion.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${machineSeed}`, "Idempotency-Key": "life-machine" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    assert.equal(machine.response.status, 403);

    const crossOwner = await asB(`/api/assistant/proactive/${lifecycleSuggestion.id}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "life-cross-owner" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    assert.equal(crossOwner.response.status, 404);

    const patchBody = { status: "snoozed", snoozedUntil: "2099-01-01T00:00:00.000Z", expectedVersion: 1 };
    const changed = await asA(`/api/assistant/proactive/${lifecycleSuggestion.id}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "life-snooze" },
      body: JSON.stringify(patchBody),
    });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.body.item.proactiveStatus, "snoozed");
    assert.equal(changed.body.item.version, 2);
    const replay = await asA(`/api/assistant/proactive/${lifecycleSuggestion.id}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "life-snooze" },
      body: JSON.stringify(patchBody),
    });
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, changed.body);

    const reused = await asA(`/api/assistant/proactive/${lifecycleSuggestion.id}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "life-snooze" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    assert.equal(reused.response.status, 409);
    assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");

    const stale = await asA(`/api/assistant/proactive/${lifecycleSuggestion.id}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "life-stale" },
      body: JSON.stringify({ status: "dismissed", expectedVersion: 1 }),
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, "PROACTIVE_SUGGESTION_VERSION_CONFLICT");

    const dismissed = await asA(`/api/assistant/proactive/${lifecycleSuggestion.id}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "life-dismiss" },
      body: JSON.stringify({ status: "dismissed", expectedVersion: 2, dismissReason: "人工判断暂不处理" }),
    });
    assert.equal(dismissed.response.status, 200);
    const invalidTransition = await asA(`/api/assistant/proactive/${lifecycleSuggestion.id}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "life-invalid-transition" },
      body: JSON.stringify({ status: "snoozed", snoozedUntil: "2099-01-01T00:00:00.000Z", expectedVersion: 3 }),
    });
    assert.equal(invalidTransition.response.status, 409);
    assert.equal(invalidTransition.body.error.code, "PROACTIVE_SUGGESTION_STATE");
  });

  it("edits fields, invalidates old previews, and creates a new revision", async () => {
    const asA = asUser(sessionA);
    const oldPreview = await createPreview(asA, fieldsSuggestion, "life-fields-preview-1");
    const edited = await asA(`/api/assistant/proactive/${fieldsSuggestion.id}/fields`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "life-fields-edit" },
      body: JSON.stringify({
        assignee: "lifecycle-owner",
        dueDate: "2099-02-01",
        priority: "高",
        expectedResult: "完成客户确认并记录结果 secret-value",
        expectedVersion: 1,
      }),
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.body.item.version, 2);
    assert.equal(edited.body.item.reviewFields.assignee, "lifecycle-owner");
    assert.equal(edited.body.item.writebackPreview.action.priority, "高");
    const old = await asA(`/api/assistant/proactive/${fieldsSuggestion.id}/previews/${oldPreview.id}`);
    assert.equal(old.response.status, 200);
    assert.equal(old.body.item.status, "cancelled");
    const fresh = await createPreview(asA, edited.body.item, "life-fields-preview-2");
    assert.equal(fresh.revision, 2);
    assert.notEqual(fresh.previewDigest, oldPreview.previewDigest);

    const db = createConnection({ databaseUrl });
    try {
      const audits = db.prepare("SELECT action, before_json, after_json, metadata_json FROM audit_logs WHERE entity_id = $id").all({ $id: fieldsSuggestion.id });
      assert.ok(audits.length >= 1);
      assert.equal(JSON.stringify(audits).includes("secret-value"), false);
      assert.equal(JSON.stringify(audits).includes("lifecycle-customer"), false);
    } finally {
      db.close();
    }
  });

  it("rolls back lifecycle and field changes when the audit insert fails", async () => {
    const asA = asUser(sessionA);
    const db = createConnection({ databaseUrl });
    try {
      db.exec(`
        CREATE TRIGGER lifecycle_audit_failure
        BEFORE INSERT ON audit_logs
        WHEN NEW.action IN ('proactive_assistant.lifecycle.update', 'proactive_assistant.fields.update')
        BEGIN
          SELECT RAISE(ABORT, 'lifecycle audit failure');
        END;
      `);
    } finally {
      db.close();
    }
    const failedLifecycle = await asA(`/api/assistant/proactive/${rollbackSuggestion.id}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "life-rollback-lifecycle" },
      body: JSON.stringify({ status: "dismissed", expectedVersion: 1 }),
    });
    assert.equal(failedLifecycle.response.status, 500);

    const failedFields = await asA(`/api/assistant/proactive/${rollbackSuggestion.id}/fields`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "life-rollback-fields" },
      body: JSON.stringify({ assignee: "should-not-persist", expectedVersion: 1 }),
    });
    assert.equal(failedFields.response.status, 500);

    const verify = createConnection({ databaseUrl });
    try {
      const row = verify.prepare("SELECT proactive_status, version, content FROM ai_suggestions WHERE id = $id").get({ $id: rollbackSuggestion.id });
      assert.equal(row.proactive_status, "pending");
      assert.equal(row.version, 1);
      assert.equal(row.content.includes("should-not-persist"), false);
      assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key IN ('life-rollback-lifecycle', 'life-rollback-fields')").get().count, 0);
      verify.exec("DROP TRIGGER lifecycle_audit_failure");
    } finally {
      verify.close();
    }
  });
});
