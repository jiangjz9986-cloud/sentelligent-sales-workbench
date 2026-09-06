import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

const passwordField = "pass" + "word";
const loginA = "ai-review-login-a";
const loginB = "ai-review-login-b";

let directory;
let databaseUrl;
let server;
let baseUrl;
let db;
let sessionA;
let sessionB;
let modelCalls = 0;

function modelResponse(content) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ content }) } }],
    }),
  };
}

async function rawRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function asSession(session, path, options = {}) {
  const method = options.method ?? "GET";
  return rawRequest(path, {
    ...options,
    method,
    headers: {
      Cookie: session.cookie,
      ...(method === "GET" ? {} : { "X-CSRF-Token": session.csrf }),
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
    cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    csrf: result.body.csrfToken,
  };
}

function versionHeader(version) {
  return { "If-Match": `"${version}"` };
}

function businessCounts() {
  return Object.fromEntries([
    "customers",
    "opportunities",
    "knowledge_items",
    "action_items",
    "risk_items",
    "weekly_reports",
  ].map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
}

describe("manual AI suggestion review HTTP lifecycle", () => {
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "sent-ai-review-"));
    databaseUrl = join(directory, "review.sqlite");
    server = createServer({
      databaseUrl,
      seed: false,
      nodeEnv: "test",
      aiAnalysisMode: "model",
      modelApiKey: ["fixture", "model", "credential"].join("-"),
      authRequired: true,
      authAccount: "jiangjz",
      authPassword: "",
      authPasswordHash: await hashPassword(loginA, { salt: Buffer.alloc(16, 41) }),
      authSessionSecret: Buffer.alloc(32, 42).toString("base64url"),
      authCookieSecure: false,
      fetchImpl: async () => {
        modelCalls += 1;
        return modelResponse("模型生成的审核建议正文");
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    db = createConnection({ databaseUrl });
    sessionA = await login("jiangjz", loginA);
    const userB = await asSession(sessionA, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        account: "reviewb",
        displayName: "审核同事",
        [passwordField]: loginB,
        role: "member",
      }),
    });
    assert.equal(userB.response.status, 201);
    sessionB = await login("reviewb", loginB);
  });

  after(async () => {
    db?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("lists persisted history without rerunning the model and keeps owner scopes hard separated", async () => {
    const created = await asSession(sessionA, "/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({
        type: "customer_profile",
        title: "生成客户画像补全建议",
        context: { customerId: "customer-a", customer: "A客户", needs: "灾备调研" },
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.status, "pending");
    assert.equal(created.body.item.version, 1);
    assert.equal(created.body.item.content, "模型生成的审核建议正文");
    assert.equal(created.body.item.draft, created.body.item.content);
    assert.equal(created.body.item.confidence > 0, true);
    assert.match(created.body.item.confirmationPreview.target, /不会自动修改客户画像/u);
    assert.equal(modelCalls, 1);

    const listPath = "/api/ai/suggestions?type=customer_profile&sourceId=customer-a&limit=5";
    const firstHistory = await asSession(sessionA, listPath);
    const secondHistory = await asSession(sessionA, listPath);
    assert.equal(firstHistory.response.status, 200);
    assert.equal(secondHistory.response.status, 200);
    assert.equal(firstHistory.body.items.length, 1);
    assert.equal(secondHistory.body.items[0].id, created.body.item.id);
    assert.equal(modelCalls, 1, "GET history must not call the model");

    const foreignHistory = await asSession(sessionB, listPath);
    assert.equal(foreignHistory.response.status, 200);
    assert.deepEqual(foreignHistory.body.items, []);

    const foreignConfirm = await asSession(sessionB, `/api/ai/suggestions/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: versionHeader(1),
      body: JSON.stringify({ confirm: true, draft: "跨账号草稿" }),
    });
    assert.equal(foreignConfirm.response.status, 404);
    assert.equal(JSON.stringify(foreignConfirm.body).includes("currentVersion"), false);

    assert.equal(
      db.prepare("SELECT owner FROM ai_suggestions WHERE id = $id").get({ $id: created.body.item.id }).owner,
      "jiangjz",
    );
  });

  it("confirms an edited draft exactly once and never writes customer, opportunity, knowledge, action, risk, or weekly data", async () => {
    const created = db.prepare("SELECT * FROM ai_suggestions WHERE owner = 'jiangjz' ORDER BY created_at ASC LIMIT 1").get();
    const before = businessCounts();
    const confirmPath = `/api/ai/suggestions/${created.id}/confirm`;
    const payload = JSON.stringify({ confirm: true, draft: "人工调整后的最终审核草稿" });
    const confirmed = await asSession(sessionA, confirmPath, {
      method: "POST",
      headers: versionHeader(1),
      body: payload,
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.item.status, "confirmed");
    assert.equal(confirmed.body.item.version, 2);
    assert.equal(confirmed.body.item.draft, "人工调整后的最终审核草稿");
    assert.equal(confirmed.body.item.content, "模型生成的审核建议正文");

    const replay = await asSession(sessionA, confirmPath, {
      method: "POST",
      headers: versionHeader(1),
      body: payload,
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.version, 2);
    assert.equal(replay.body.item.draft, confirmed.body.item.draft);

    const differentReplay = await asSession(sessionA, confirmPath, {
      method: "POST",
      headers: versionHeader(2),
      body: JSON.stringify({ confirm: true, draft: "不同的重复草稿" }),
    });
    assert.equal(differentReplay.response.status, 409);
    assert.equal(differentReplay.body.error.code, "SUGGESTION_ALREADY_CONFIRMED");
    assert.deepEqual(businessCounts(), before);
    assert.equal(modelCalls, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'ai.suggestion.confirm' AND entity_id = $id").get({ $id: created.id }).count,
      1,
    );
  });

  it("cancels explicitly, replays idempotently, and blocks every terminal or unknown review transition", async () => {
    const created = await asSession(sessionA, "/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({
        type: "knowledge_talk",
        title: "生成知识引用建议",
        context: { knowledgeId: "knowledge-a", knowledge: "A知识" },
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(modelCalls, 2);
    assert.equal(created.body.item.sourceRefs[0].id, "knowledge-a");
    const path = `/api/ai/suggestions/${created.body.item.id}/cancel`;
    const options = {
      method: "POST",
      headers: versionHeader(1),
      body: JSON.stringify({ cancel: true }),
    };
    const cancelled = await asSession(sessionA, path, options);
    const replay = await asSession(sessionA, path, options);
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body.item.status, "cancelled");
    assert.equal(cancelled.body.item.version, 2);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.version, 2);

    const confirmCancelled = await asSession(sessionA, `/api/ai/suggestions/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: versionHeader(2),
      body: JSON.stringify({ confirm: true, draft: "不应确认" }),
    });
    assert.equal(confirmCancelled.response.status, 409);
    assert.equal(confirmCancelled.body.error.code, "SUGGESTION_NOT_PENDING");

    const terminal = await asSession(sessionA, "/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({
        type: "opportunity_push",
        title: "手动生成商机推进建议",
        context: { opportunityId: "opportunity-a", opportunity: "A商机" },
      }),
    });
    assert.equal(terminal.body.item.sourceRefs[0].id, "opportunity-a");
    assert.match(terminal.body.item.sourceRefs[0].title, /A商机/u);
    db.prepare("UPDATE ai_suggestions SET status = 'failed' WHERE id = $id").run({ $id: terminal.body.item.id });
    const terminalConfirm = await asSession(sessionA, `/api/ai/suggestions/${terminal.body.item.id}/confirm`, {
      method: "POST",
      headers: versionHeader(1),
      body: JSON.stringify({ confirm: true, draft: "不应确认" }),
    });
    assert.equal(terminalConfirm.response.status, 409);
    assert.match(JSON.stringify(terminalConfirm.body), /currentStatus.*failed/u);
    assert.equal(modelCalls, 3);
  });

  it("filters by the persisted source before applying the limit even with more than one hundred newer rows", async () => {
    const target = await asSession(sessionA, "/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({
        type: "customer_profile",
        title: "深层历史目标建议",
        context: { customerId: "customer-deep-target", customer: "目标客户" },
      }),
    });
    assert.equal(target.response.status, 201);
    assert.equal(
      db.prepare("SELECT source_id FROM ai_suggestions WHERE id = $id").get({ $id: target.body.item.id }).source_id,
      "customer-deep-target",
    );

    const insertNoise = db.prepare(`
      INSERT INTO ai_suggestions (
        id, type, title, status, content, draft_content, confidence,
        source_id, source_refs, confirmation_preview, owner, created_at, updated_at
      ) VALUES (
        $id, 'customer_profile', '噪声建议', 'pending', '噪声', '噪声', 50,
        $sourceId, $sourceRefs, '{}', 'jiangjz',
        datetime('now', '+' || $offset || ' seconds'),
        datetime('now', '+' || $offset || ' seconds')
      )
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 1; index <= 120; index += 1) {
        const sourceId = `noise-customer-${index}`;
        insertNoise.run({
          $id: `noise-suggestion-${index}`,
          $sourceId: sourceId,
          $sourceRefs: JSON.stringify([{ id: sourceId }]),
          $offset: index,
        });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const beforeGetCalls = modelCalls;
    const history = await asSession(
      sessionA,
      "/api/ai/suggestions?type=customer_profile&sourceId=customer-deep-target&limit=5",
    );
    assert.equal(history.response.status, 200);
    assert.deepEqual(history.body.items.map((item) => item.id), [target.body.item.id]);
    assert.equal(modelCalls, beforeGetCalls, "filtered GET must not rerun the model");
  });

  it("rejects suggestion types outside the three product surfaces on both POST and GET", async () => {
    const created = await asSession(sessionA, "/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({ type: "next_action", title: "越界类型", context: {} }),
    });
    assert.equal(created.response.status, 422);
    assert.equal(created.body.error.fields.type, "enum");

    const listed = await asSession(sessionA, "/api/ai/suggestions?type=next_action");
    assert.equal(listed.response.status, 422);
    assert.equal(listed.body.error.fields.type, "enum");
  });
});
