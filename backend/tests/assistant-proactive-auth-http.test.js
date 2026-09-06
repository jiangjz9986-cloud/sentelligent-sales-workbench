import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";
import { createProactiveAssistantSnapshotFromDb } from "../src/assistant/proactiveAssistant.js";

const passwordField = "pass" + "word";
const accountA = "jiangjz";
const accountB = "testb";
const loginA = ["proactive", "auth", "a"].join("-");
const loginB = ["proactive", "auth", "b"].join("-");
const machineToken = ["proactive", "machine", "token"].join("-");

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let sessionA;
let sessionB;

async function rawRequest(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function login(account, password) {
  const result = await rawRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: password }),
  });
  assert.equal(result.response.status, 200, `login ${account}`);
  return {
    cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    csrf: result.body.csrfToken,
  };
}

function authenticatedRequest(session) {
  return (path, options = {}) => rawRequest(path, {
    ...options,
    headers: {
      Cookie: session.cookie,
      ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": session.csrf } : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function createPreview(asA, suggestion, target, key) {
  const result = await asA(`/api/assistant/proactive/${suggestion.id}/previews`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ target }),
  });
  assert.ok([200, 201].includes(result.response.status));
  assert.equal(result.body.item.target, target);
  assert.equal(result.body.item.suggestionId, suggestion.id);
  assert.equal(result.body.item.status, "open");
  return result.body.item;
}

describe("proactive assistant authenticated owner isolation", () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sentelligent-proactive-auth-http-"));
    databaseUrl = join(tempDir, "assistant-auth.sqlite");
    server = createServer({
      databaseUrl,
      seed: true,
      nodeEnv: "test",
      authRequired: true,
      authAccount: accountA,
      authPassword: "",
      authPasswordHash: await hashPassword(loginA, { salt: Buffer.alloc(16, 31) }),
      authSessionSecret: Buffer.alloc(32, 32).toString("base64url"),
      authCookieSecure: false,
      weixinAgentApiToken: machineToken,
      weixinAgentOwner: accountA,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const db = createConnection({ databaseUrl });
    try {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO users (account, display_name, password_hash, role, status, created_at, updated_at)
        VALUES ($account, $displayName, $passwordHash, 'member', 'active', $now, $now)
      `).run({
        $account: accountB,
        $displayName: "测试账号",
        $passwordHash: await hashPassword(loginB, { salt: Buffer.alloc(16, 33) }),
        $now: now,
      });
      db.prepare(`
        INSERT INTO customers (id, name, owner, created_at, updated_at)
        VALUES ('proactive-customer-a', 'A 客户', $owner, $now, $now),
               ('proactive-customer-b', 'B 客户', $ownerB, $now, $now)
      `).run({ $owner: accountA, $ownerB: accountB, $now: now });
      db.prepare(`
        INSERT INTO opportunities (id, customer_id, name, stage, owner, days, next, created_at, updated_at)
        VALUES ('proactive-opportunity-a', 'proactive-customer-a', 'A 商机', '方案输出', $owner, 40, NULL, $now, $now),
               ('proactive-opportunity-b', 'proactive-customer-b', 'B 商机', '方案输出', $ownerB, 40, NULL, $now, $now)
      `).run({ $owner: accountA, $ownerB: accountB, $now: now });
    } finally {
      db.close();
    }

    sessionA = await login(accountA, loginA);
    sessionB = await login(accountB, loginB);
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  it("requires a user session and scopes snapshots to the session owner", async () => {
    const anonymous = await rawRequest("/api/assistant/proactive");
    assert.equal(anonymous.response.status, 401);

    const asA = authenticatedRequest(sessionA);
    const asB = authenticatedRequest(sessionB);
    const snapshotA = await asA("/api/assistant/proactive?owner=testb");
    const snapshotB = await asB("/api/assistant/proactive?owner=jiangjz");
    assert.equal(snapshotA.response.status, 200);
    assert.equal(snapshotB.response.status, 200);
    assert.ok(snapshotA.body.item.items.some((item) => item.opportunityId === "proactive-opportunity-a"));
    assert.ok(snapshotB.body.item.items.some((item) => item.opportunityId === "proactive-opportunity-b"));
    assert.ok(snapshotA.body.item.items.every((item) => item.customerId !== "proactive-customer-b"));
    assert.ok(snapshotB.body.item.items.every((item) => item.customerId !== "proactive-customer-a"));
  });

  it("rejects machine identities from the web proactive assistant route", async () => {
    const machine = await rawRequest("/api/assistant/proactive", {
      headers: { Authorization: `Bearer ${machineToken}` },
    });
    assert.equal(machine.response.status, 403);
    assert.equal(machine.body.error.code, "MACHINE_SCOPE_DENIED");
  });

  it("writes a confirmed action and risk exactly once with owner, relation, version, and digest gates", async () => {
    const asA = authenticatedRequest(sessionA);
    const snapshot = await asA("/api/assistant/proactive");
    // Keep the action and risk fixtures on different cards.  A stage-evidence
    // card exposes both targets; selecting the action-only card leaves the
    // second test's fresh action-preview path independent after the first
    // confirmation completes its writeback.
    const actionSuggestion = snapshot.body.item.items.find((item) => (
      item.writebackPreview.action && !item.writebackPreview.risk
    ));
    const riskSuggestion = snapshot.body.item.items.find((item) => item.writebackPreview.risk);
    assert.ok(actionSuggestion);
    assert.ok(riskSuggestion);

    const actionPreview = await createPreview(asA, actionSuggestion, "action", "proactive-action-preview-1");
    const riskPreview = await createPreview(asA, riskSuggestion, "risk", "proactive-risk-preview-1");
    const fetchedPreview = await asA(`/api/assistant/proactive/${actionSuggestion.id}/previews/${actionPreview.id}`);
    assert.equal(fetchedPreview.response.status, 200);
    assert.equal(fetchedPreview.body.item.previewDigest, actionPreview.previewDigest);
    assert.deepEqual(fetchedPreview.body.item.preview, actionPreview.preview);

    const confirm = async (suggestion, durablePreview, key, overrides = {}) => asA(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({
        confirmationPreviewId: durablePreview.id,
        target: durablePreview.target,
        customerId: durablePreview.customerId,
        opportunityId: durablePreview.opportunityId,
        expectedOpportunityVersion: durablePreview.opportunityVersion,
        expectedCustomerVersion: durablePreview.customerVersion,
        previewDigest: durablePreview.previewDigest,
        preview: durablePreview.preview,
        ...overrides,
      }),
    });

    const action = await confirm(actionSuggestion, actionPreview, "proactive-action-confirm-1");
    assert.equal(action.response.status, 201);
    assert.equal(action.body.item.suggestionId, actionSuggestion.id);
    assert.equal(action.body.item.action.opportunityId, actionSuggestion.opportunityId);
    assert.equal(action.body.item.action.customerId, actionSuggestion.customerId);
    assert.equal(action.body.item.action.owner, accountA);
    assert.equal(action.body.item.replayed, false);

    const replay = await confirm(actionSuggestion, actionPreview, "proactive-action-confirm-1");
    assert.equal(replay.response.status, 201);
    assert.equal(replay.body.item.action.id, action.body.item.action.id);

    const sameKeyDifferentContent = await confirm(
      actionSuggestion,
      actionPreview,
      "proactive-action-confirm-1",
      { preview: { ...actionPreview.preview, title: "客户端篡改" } },
    );
    assert.equal(sameKeyDifferentContent.response.status, 409);
    assert.equal(sameKeyDifferentContent.body.error.code, "IDEMPOTENCY_KEY_REUSED");

    const duplicate = await confirm(actionSuggestion, actionPreview, "proactive-action-confirm-2");
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.item.replayed, true);

    const risk = await confirm(riskSuggestion, riskPreview, "proactive-risk-confirm-1");
    assert.equal(risk.response.status, 201);
    assert.equal(risk.body.item.risk.sourceType, "proactive_assistant");
    assert.equal(risk.body.item.risk.sourceId, riskSuggestion.id);

    const riskReplayWithNewKey = await confirm(riskSuggestion, riskPreview, "proactive-risk-confirm-2");
    assert.equal(riskReplayWithNewKey.response.status, 200);
    assert.equal(riskReplayWithNewKey.body.item.replayed, true);
    assert.equal(riskReplayWithNewKey.body.item.risk.id, risk.body.item.risk.id);

    const db = createConnection({ databaseUrl });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM action_items WHERE id = $id").get({ $id: action.body.item.action.id }).count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM risk_items WHERE id = $id").get({ $id: risk.body.item.risk.id }).count, 1);
      assert.equal(db.prepare("SELECT status FROM proactive_confirmation_previews WHERE id = $id").get({ $id: actionPreview.id }).status, "completed");
      assert.equal(db.prepare("SELECT status FROM proactive_confirmation_previews WHERE id = $id").get({ $id: riskPreview.id }).status, "completed");
      for (const auditAction of ["action.create", "risk.create", "proactive_assistant.confirm"]) {
        assert.ok(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = $action").get({ $action: auditAction }).count >= 1, auditAction);
      }
    } finally {
      db.close();
    }
  });

  it("rejects stale previews, bad digests, cross-owner targets, and machine writes", async () => {
    const asA = authenticatedRequest(sessionA);
    const asB = authenticatedRequest(sessionB);
    const snapshot = await asA("/api/assistant/proactive");
    const suggestion = snapshot.body.item.items.find((item) => item.writebackPreview.action);
    assert.ok(suggestion);
    const durablePreview = await createPreview(asA, suggestion, "action", "proactive-stale-preview-1");

    const badDigest = await asA(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-bad-digest" },
      body: JSON.stringify({
        confirmationPreviewId: durablePreview.id,
        target: "action",
        customerId: suggestion.customerId,
        opportunityId: suggestion.opportunityId,
        expectedOpportunityVersion: suggestion.opportunityVersion,
        expectedCustomerVersion: suggestion.customerVersion,
        previewDigest: "0".repeat(64),
        preview: durablePreview.preview,
      }),
    });
    assert.equal(badDigest.response.status, 422);
    assert.equal(badDigest.body.item, undefined);
    assert.equal(badDigest.body.error.fields.confirmationPreviewId, "mismatch");

    const crossOwner = await asB(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-cross-owner" },
      body: JSON.stringify({
        confirmationPreviewId: durablePreview.id,
        target: "action",
        customerId: suggestion.customerId,
        opportunityId: suggestion.opportunityId,
        expectedOpportunityVersion: suggestion.opportunityVersion,
        expectedCustomerVersion: suggestion.customerVersion,
        previewDigest: durablePreview.previewDigest,
        preview: durablePreview.preview,
      }),
    });
    assert.equal(crossOwner.response.status, 404);

    const db = createConnection({ databaseUrl });
    try {
      db.prepare("UPDATE opportunities SET version = version + 1 WHERE id = $id").run({ $id: suggestion.opportunityId });
    } finally {
      db.close();
    }
    const stale = await asA(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-stale-version" },
      body: JSON.stringify({
        confirmationPreviewId: durablePreview.id,
        target: "action",
        customerId: suggestion.customerId,
        opportunityId: suggestion.opportunityId,
        expectedOpportunityVersion: suggestion.opportunityVersion,
        expectedCustomerVersion: suggestion.customerVersion,
        previewDigest: durablePreview.previewDigest,
        preview: durablePreview.preview,
      }),
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, "PROACTIVE_PREVIEW_STALE");

    const machine = await rawRequest(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${machineToken}`,
        "Idempotency-Key": "proactive-machine-write",
      },
      body: JSON.stringify({
        confirmationPreviewId: durablePreview.id,
        target: "action",
        customerId: suggestion.customerId,
        opportunityId: suggestion.opportunityId,
        expectedOpportunityVersion: suggestion.opportunityVersion,
        expectedCustomerVersion: suggestion.customerVersion,
        previewDigest: durablePreview.previewDigest,
        preview: durablePreview.preview,
      }),
    });
    assert.equal(machine.response.status, 403);
  });

  it("rejects missing previews, customer-version conflicts, relationship mismatches, and unknown entities", async () => {
    const asA = authenticatedRequest(sessionA);
    const now = new Date().toISOString();
    const db = createConnection({ databaseUrl });
    try {
      db.prepare(`
        INSERT INTO customers (id, name, owner, created_at, updated_at)
        VALUES ('proactive-customer-c', 'C 客户', $owner, $now, $now)
      `).run({ $owner: accountA, $now: now });
      db.prepare(`
        INSERT INTO opportunities (id, customer_id, name, stage, owner, days, next, created_at, updated_at)
        VALUES ('proactive-opportunity-c', 'proactive-customer-c', 'C 商机', '方案输出', $owner, 40, NULL, $now, $now)
      `).run({ $owner: accountA, $now: now });
    } finally {
      db.close();
    }

    const snapshot = await asA("/api/assistant/proactive");
    const suggestion = snapshot.body.item.items.find((item) => item.opportunityId === "proactive-opportunity-c" && item.writebackPreview.action);
    assert.ok(suggestion);
    const durablePreview = await createPreview(asA, suggestion, "action", "proactive-c-preview-1");

    const missingPreview = await asA(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-missing-preview" },
      body: JSON.stringify({
        target: "action",
        customerId: suggestion.customerId,
        opportunityId: suggestion.opportunityId,
        expectedOpportunityVersion: suggestion.opportunityVersion,
        expectedCustomerVersion: suggestion.customerVersion,
        previewDigest: suggestion.previewDigests.action,
      }),
    });
    assert.equal(missingPreview.response.status, 422);
    assert.equal(missingPreview.body.error.fields.confirmationPreviewId, "required");

    const dbForCustomerConflict = createConnection({ databaseUrl });
    try {
      dbForCustomerConflict.prepare("UPDATE customers SET version = version + 1 WHERE id = $id").run({ $id: suggestion.customerId });
    } finally {
      dbForCustomerConflict.close();
    }
    const customerConflict = await asA(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-customer-stale" },
      body: JSON.stringify({
        confirmationPreviewId: durablePreview.id,
        target: "action",
        customerId: suggestion.customerId,
        opportunityId: suggestion.opportunityId,
        expectedOpportunityVersion: suggestion.opportunityVersion,
        expectedCustomerVersion: suggestion.customerVersion,
        previewDigest: durablePreview.previewDigest,
        preview: durablePreview.preview,
      }),
    });
    assert.equal(customerConflict.response.status, 409);
    assert.equal(customerConflict.body.error.code, "PROACTIVE_PREVIEW_STALE");

    const relationshipMismatch = await asA(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-relationship-mismatch" },
      body: JSON.stringify({
        confirmationPreviewId: durablePreview.id,
        target: "action",
        customerId: "proactive-customer-a",
        opportunityId: suggestion.opportunityId,
        expectedOpportunityVersion: suggestion.opportunityVersion,
        expectedCustomerVersion: 1,
        previewDigest: durablePreview.previewDigest,
        preview: durablePreview.preview,
      }),
    });
    assert.equal(relationshipMismatch.response.status, 422);
    assert.equal(relationshipMismatch.body.error.fields.confirmationPreviewId, "mismatch");

    const missingCustomer = await asA(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-missing-customer" },
      body: JSON.stringify({
        confirmationPreviewId: durablePreview.id,
        target: "action",
        customerId: "proactive-customer-missing",
        opportunityId: suggestion.opportunityId,
        expectedOpportunityVersion: suggestion.opportunityVersion,
        expectedCustomerVersion: 1,
        previewDigest: durablePreview.previewDigest,
        preview: durablePreview.preview,
      }),
    });
    assert.equal(missingCustomer.response.status, 422);
    assert.equal(missingCustomer.body.error.fields.confirmationPreviewId, "mismatch");

    const missingOpportunity = await asA(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-missing-opportunity" },
      body: JSON.stringify({
        confirmationPreviewId: durablePreview.id,
        target: "action",
        customerId: suggestion.customerId,
        opportunityId: "proactive-opportunity-missing",
        expectedOpportunityVersion: suggestion.opportunityVersion,
        expectedCustomerVersion: suggestion.customerVersion + 1,
        previewDigest: durablePreview.previewDigest,
        preview: durablePreview.preview,
      }),
    });
    assert.equal(missingOpportunity.response.status, 422);
    assert.equal(missingOpportunity.body.error.fields.confirmationPreviewId, "mismatch");

    const cancelled = await asA(`/api/assistant/proactive/${suggestion.id}/previews/${durablePreview.id}/cancel`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-c-preview-cancel" },
      body: JSON.stringify({ cancel: true }),
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body.item.status, "cancelled");
  });

  it("rolls back the action, audit rows, and idempotency claim when confirmation audit fails", async () => {
    const asA = authenticatedRequest(sessionA);
    const now = new Date().toISOString();
    const setup = createConnection({ databaseUrl });
    try {
      setup.prepare(`
        INSERT INTO customers (id, name, owner, created_at, updated_at)
        VALUES ('proactive-customer-d', 'D 客户', $owner, $now, $now)
      `).run({ $owner: accountA, $now: now });
      setup.prepare(`
        INSERT INTO opportunities (id, customer_id, name, stage, owner, days, next, created_at, updated_at)
        VALUES ('proactive-opportunity-d', 'proactive-customer-d', 'D 商机', '方案输出', $owner, 40, NULL, $now, $now)
      `).run({ $owner: accountA, $now: now });
    } finally {
      setup.close();
    }

    const snapshot = await asA("/api/assistant/proactive");
    const suggestion = snapshot.body.item.items.find((item) => item.opportunityId === "proactive-opportunity-d" && item.writebackPreview.action);
    assert.ok(suggestion);
    const durablePreview = await createPreview(asA, suggestion, "action", "proactive-rollback-preview-1");

    const db = createConnection({ databaseUrl });
    try {
      db.exec(`
        CREATE TRIGGER proactive_confirm_audit_failure
        BEFORE INSERT ON audit_logs
        WHEN NEW.action = 'proactive_assistant.confirm'
        BEGIN
          SELECT RAISE(ABORT, 'proactive confirmation audit failure');
        END;
      `);
    } finally {
      db.close();
    }

    const failed = await asA(`/api/assistant/proactive/${suggestion.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-rollback-audit" },
      body: JSON.stringify({
        confirmationPreviewId: durablePreview.id,
        target: "action",
        customerId: suggestion.customerId,
        opportunityId: suggestion.opportunityId,
        expectedOpportunityVersion: suggestion.opportunityVersion,
        expectedCustomerVersion: suggestion.customerVersion,
        previewDigest: durablePreview.previewDigest,
        preview: durablePreview.preview,
      }),
    });
    assert.equal(failed.response.status, 500);
    assert.equal(JSON.stringify(failed.body).includes("proactive confirmation audit failure"), false);

    const verify = createConnection({ databaseUrl });
    try {
      assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM action_items WHERE id = $id").get({ $id: `proactive-action-${suggestion.id}` }).count, 0);
      assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = $id").get({ $id: suggestion.id }).count, 0);
      assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = $key").get({ $key: "proactive-rollback-audit" }).count, 0);
      verify.exec("DROP TRIGGER proactive_confirm_audit_failure");
    } finally {
      verify.close();
    }
  });

  it("rejects anonymous confirmation before parsing or writing", async () => {
    const response = await rawRequest("/api/assistant/proactive/unknown/confirm", {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-anonymous" },
      body: JSON.stringify({}),
    });
    assert.equal(response.response.status, 401);
  });

  it("resolves preview and confirmation targets beyond the bounded list page", async () => {
    const asA = authenticatedRequest(sessionA);
    const now = new Date().toISOString();
    const setup = createConnection({ databaseUrl });
    try {
      setup.prepare(`
        INSERT INTO customers (id, name, owner, created_at, updated_at)
        VALUES ('proactive-page-customer', '分页客户', $owner, $now, $now)
      `).run({ $owner: accountA, $now: now });
      const insertOpportunity = setup.prepare(`
        INSERT INTO opportunities (
          id, customer_id, name, stage, owner, days, next, created_at, updated_at
        ) VALUES ($id, 'proactive-page-customer', $name, '方案输出', $owner, 40, NULL, $now, $now)
      `);
      for (let index = 0; index < 60; index += 1) {
        insertOpportunity.run({
          $id: `proactive-page-opportunity-${String(index).padStart(2, "0")}`,
          $name: `分页商机 ${index}`,
          $owner: accountA,
          $now: now,
        });
      }
    } finally {
      setup.close();
    }

    const bounded = await asA("/api/assistant/proactive?limit=1");
    assert.equal(bounded.response.status, 200);
    assert.equal(bounded.body.item.items.length, 1);
    assert.equal(bounded.body.item.truncated, true);
    assert.ok(bounded.body.item.counts.total > bounded.body.item.items.length);

    const db = createConnection({ databaseUrl });
    let target;
    try {
      const complete = createProactiveAssistantSnapshotFromDb({ db, owner: accountA, includeAll: true });
      const listedIds = new Set(bounded.body.item.items.map((item) => item.id));
      target = complete.items.find((item) => !listedIds.has(item.id) && item.writebackPreview.action);
      assert.ok(target, "expected a suggestion after the bounded page");
    } finally {
      db.close();
    }

    const preview = await createPreview(asA, target, "action", "proactive-page-preview");
    const confirmed = await asA(`/api/assistant/proactive/${target.id}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": "proactive-page-confirm" },
      body: JSON.stringify({
        confirmationPreviewId: preview.id,
        target: preview.target,
        customerId: preview.customerId,
        opportunityId: preview.opportunityId,
        expectedOpportunityVersion: preview.opportunityVersion,
        expectedCustomerVersion: preview.customerVersion,
        previewDigest: preview.previewDigest,
        preview: preview.preview,
      }),
    });
    assert.equal(confirmed.response.status, 201);
    assert.equal(confirmed.body.item.suggestionId, target.id);
    assert.equal(confirmed.body.item.action.opportunityId, target.opportunityId);
  });
});
