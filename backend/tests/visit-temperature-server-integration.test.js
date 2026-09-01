import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createUser } from "../src/auth/usersStore.js";
import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";

const passwordField = "pass" + "word";
const LOGIN_A_VALUE = "temperature-owner-a";
const LOGIN_B_VALUE = "temperature-owner-b";
const MACHINE_VALUE = "temperature-machine-token";

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let db;
let sequence = 0;
let generatorCalls = 0;

async function rawRequest(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] ??= "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function userRequest(session, path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  return rawRequest(path, {
    ...options,
    headers: {
      Cookie: session.cookie,
      ...(method !== "GET" ? { "X-CSRF-Token": session.csrf } : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function login(account, password) {
  const result = await rawRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: password }),
  });
  assert.equal(result.response.status, 200);
  return {
    cookie: String(result.response.headers.get("set-cookie")).split(";", 1)[0],
    csrf: result.body.csrfToken,
  };
}

function seedVisit({ id, owner, customerId, status = "confirmed", confirmationPreviewStatus = null, content }) {
  db.prepare(`
    INSERT INTO quick_records (
      id, owner, raw_content, occurred_at, customer_id, status, confirmation_preview_status, version,
      created_at, updated_at
    ) VALUES (
      $id, $owner, $content, '2026-08-30T02:00:00.000Z', $customerId, $status, $confirmationPreviewStatus, 3,
      '2026-08-30T03:00:00.000Z', '2026-08-30T03:00:00.000Z'
    )
  `).run({ $id: id, $owner: owner, $customerId: customerId, $content: content, $status: status, $confirmationPreviewStatus: confirmationPreviewStatus });
  db.prepare(`
    INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json, created_at)
    VALUES ($id, $visitId, 'test', 88, $analysis, '2026-08-30T03:00:00.000Z')
  `).run({
    $id: `insight-${id}`,
    $visitId: id,
    $analysis: JSON.stringify({
      evidence: [{
        key: "customer_feedback",
        label: "客户反馈",
        value: "认可下一步交流",
        sourceType: "quick_record",
        sourceId: id,
        confidence: 100,
      }],
    }),
  });
  db.prepare(`
    INSERT INTO manual_confirmations (id, quick_record_id, target, confirmed_by, created_at)
    VALUES ($id, $visitId, 'customer', $owner, '2026-08-30T03:30:00.000Z')
  `).run({ $id: `confirmation-${id}`, $visitId: id, $owner: owner });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-temperature-server-"));
  databaseUrl = join(tempDir, "temperature.sqlite");
  sequence = 0;
  generatorCalls = 0;
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: "ownera",
    authPassword: "",
    authPasswordHash: await hashPassword(LOGIN_A_VALUE, { salt: Buffer.alloc(16, 21) }),
    authSessionSecret: Buffer.alloc(32, 22).toString("base64url"),
    authCookieSecure: false,
    weixinAgentApiToken: MACHINE_VALUE,
    weixinAgentOwner: "ownera",
    hospitalTenderAutoRun: false,
    actionReminderAutoRun: false,
    dailyDigestAutoRun: false,
    visitTemperatureSuggestionClock: () => new Date("2026-08-31T04:00:00.000Z"),
    visitTemperatureSuggestionIdFactory: () => `temperature-suggestion-${++sequence}`,
    visitTemperatureSuggestionGenerator: (snapshot) => {
      generatorCalls += 1;
      return {
        suggestedValue: snapshot.customer.relation + 26,
        confidence: 84,
        inferences: [{
          claim: "客户愿意安排下一次技术交流",
          basisKeys: ["customer_feedback"],
          confidence: 84,
        }],
      };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = openDatabase({ databaseUrl });
  createUser(db, {
    account: "ownerb",
    displayName: "Owner B",
    passwordHash: await hashPassword(LOGIN_B_VALUE, { salt: Buffer.alloc(16, 23) }),
    role: "member",
    now: "2026-08-30T00:00:00.000Z",
  });
  db.exec(`
    INSERT INTO customers (id, name, owner, relation, version)
    VALUES ('customer-a', '客户甲', 'ownera', 42, 1),
           ('customer-b', '客户乙', 'ownerb', 31, 1);
  `);
  seedVisit({ id: "visit-a", owner: "ownera", customerId: "customer-a", content: "客户甲认可下一次交流" });
  seedVisit({ id: "visit-a-stale", owner: "ownera", customerId: "customer-a", content: "客户甲确认排期" });
  seedVisit({ id: "visit-a-cancel", owner: "ownera", customerId: "customer-a", content: "客户甲等待方案" });
  seedVisit({ id: "visit-a-v2", owner: "ownera", customerId: "customer-a", status: "analyzed", confirmationPreviewStatus: "completed", content: "客户甲完成确认预览" });
  seedVisit({ id: "visit-a-analyzed", owner: "ownera", customerId: "customer-a", status: "analyzed", content: "客户甲仅完成分析" });
  seedVisit({ id: "visit-a-draft-completed", owner: "ownera", customerId: "customer-a", status: "draft", confirmationPreviewStatus: "completed", content: "客户甲草稿状态异常完成预览" });
  seedVisit({ id: "visit-b", owner: "ownerb", customerId: "customer-b", content: "客户乙确认交流" });
});

afterEach(async () => {
  db?.close();
  db = null;
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("visit temperature server integration", () => {
  it("wires authenticated owner scope, durable preview, confirmation, conflict and cancellation", async () => {
    const sessionA = await login("ownera", LOGIN_A_VALUE);
    const sessionB = await login("ownerb", LOGIN_B_VALUE);

    const machine = await rawRequest("/api/visit-temperature-suggestions", {
    headers: { Authorization: `Bearer ${MACHINE_VALUE}` },
    });
    assert.equal(machine.response.status, 403);

    const forged = await userRequest(sessionA, "/api/visit-temperature-suggestions", {
      method: "POST",
      body: JSON.stringify({ visitId: "visit-a", owner: "ownerb" }),
    });
    assert.equal(forged.response.status, 422);

    const pending = await userRequest(sessionA, "/api/visit-temperature-suggestions", {
      method: "POST",
      body: JSON.stringify({ visitId: "visit-a" }),
    });
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.item.status, "pending");
    assert.equal(pending.body.item.owner, "ownera");
    assert.equal(pending.body.item.requiresHumanConfirmation, true);
    assert.equal(pending.body.item.writebackAllowed, false);

    const hidden = await userRequest(sessionB, `/api/visit-temperature-suggestions/${pending.body.item.id}`);
    assert.equal(hidden.response.status, 404);
    const ownerBHistory = await userRequest(sessionB, "/api/visit-temperature-suggestions");
    assert.deepEqual(ownerBHistory.body.item.items, []);

    const notConfirmed = await userRequest(sessionA, `/api/visit-temperature-suggestions/${pending.body.item.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({
        suggestionIdentity: pending.body.item.identity,
        expectedCustomerVersion: pending.body.item.customerVersion,
        previousValue: pending.body.item.previousValue,
      }),
    });
    assert.equal(notConfirmed.response.status, 409);

    const confirmed = await userRequest(sessionA, `/api/visit-temperature-suggestions/${pending.body.item.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({
        suggestionIdentity: pending.body.item.identity,
        expectedCustomerVersion: pending.body.item.customerVersion,
        previousValue: pending.body.item.previousValue,
        confirm: true,
      }),
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.item.status, "confirmed");
    assert.equal(confirmed.body.item.writeback, true);
    assert.equal(confirmed.body.item.customer.relation, 68);
    assert.equal(db.prepare("SELECT relation, version FROM customers WHERE id = 'customer-a'").get().version, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.relation.update'").get().count, 1);

    const replay = await userRequest(sessionA, `/api/visit-temperature-suggestions/${pending.body.item.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({
        suggestionIdentity: pending.body.item.identity,
        expectedCustomerVersion: pending.body.item.customerVersion,
        previousValue: pending.body.item.previousValue,
        confirm: true,
      }),
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.replayed, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.relation.update'").get().count, 1);

    const stale = await userRequest(sessionA, "/api/visit-temperature-suggestions", {
      method: "POST",
      body: JSON.stringify({ visitId: "visit-a-stale" }),
    });
    db.prepare("UPDATE customers SET relation = 55, version = 3 WHERE id = 'customer-a'").run();
    const conflict = await userRequest(sessionA, `/api/visit-temperature-suggestions/${stale.body.item.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({
        suggestionIdentity: stale.body.item.identity,
        expectedCustomerVersion: stale.body.item.customerVersion,
        previousValue: stale.body.item.previousValue,
        confirm: true,
      }),
    });
    assert.equal(conflict.response.status, 200);
    assert.equal(conflict.body.item.status, "conflict");
    assert.equal(conflict.body.item.writeback, false);
    assert.equal(db.prepare("SELECT status FROM visit_temperature_suggestions WHERE id = $id").get({ $id: stale.body.item.id }).status, "pending");

    const cancellation = await userRequest(sessionA, "/api/visit-temperature-suggestions", {
      method: "POST",
      body: JSON.stringify({ visitId: "visit-a-cancel" }),
    });
    const cancelWithoutFlag = await userRequest(sessionA, `/api/visit-temperature-suggestions/${cancellation.body.item.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ suggestionIdentity: cancellation.body.item.identity }),
    });
    assert.equal(cancelWithoutFlag.response.status, 409);
    const cancelled = await userRequest(sessionA, `/api/visit-temperature-suggestions/${cancellation.body.item.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ suggestionIdentity: cancellation.body.item.identity, cancel: true }),
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body.item.status, "cancelled");
    assert.equal(db.prepare("SELECT status FROM visit_temperature_suggestions WHERE id = $id").get({ $id: cancellation.body.item.id }).status, "cancelled");

    assert.ok(server.visitTemperatureSuggestionService);
    assert.ok(server.visitTemperatureSuggestionHttp);
    assert.ok(server.visitTemperatureSuggestionRepositories);
  });

  it("accepts completed V2 previews while rejecting analyzed-only and cross-owner records", async () => {
    const sessionA = await login("ownera", LOGIN_A_VALUE);
    const sessionB = await login("ownerb", LOGIN_B_VALUE);

    const v2 = await userRequest(sessionA, "/api/visit-temperature-suggestions", {
      method: "POST",
      body: JSON.stringify({ visitId: "visit-a-v2" }),
    });
    assert.equal(v2.response.status, 200);
    assert.equal(v2.body.item.status, "pending");
    assert.equal(generatorCalls, 1);
    const v2Record = db.prepare("SELECT status, confirmation_preview_status FROM quick_records WHERE id = 'visit-a-v2'").get();
    assert.equal(v2Record.status, "analyzed");
    assert.equal(v2Record.confirmation_preview_status, "completed");

    const analyzedOnly = await userRequest(sessionA, "/api/visit-temperature-suggestions", {
      method: "POST",
      body: JSON.stringify({ visitId: "visit-a-analyzed" }),
    });
    assert.equal(analyzedOnly.response.status, 404);
    assert.equal(generatorCalls, 1);

    const draftCompleted = await userRequest(sessionA, "/api/visit-temperature-suggestions", {
      method: "POST",
      body: JSON.stringify({ visitId: "visit-a-draft-completed" }),
    });
    assert.equal(draftCompleted.response.status, 404);
    assert.equal(generatorCalls, 1);

    const crossOwner = await userRequest(sessionB, "/api/visit-temperature-suggestions", {
      method: "POST",
      body: JSON.stringify({ visitId: "visit-a-v2" }),
    });
    assert.equal(crossOwner.response.status, 404);
    assert.equal(generatorCalls, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM visit_temperature_suggestions").get().count, 1);
  });
});
