import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";

const ACCOUNT = "jiangjz";
const PASSWORD = "unit-test-password";
const SYNC_TOKEN = "fixture-hospital-sync-token-placeholder";
const SESSION_SECRET = "fixture-session-secret-placeholder-value";

let tempDir;
let server;
let baseUrl;
let cookie;
let csrfToken;

function snapshotPayload({ contentText = "采购 PACS 双活存储和灾备服务。" } = {}) {
  return {
    schemaVersion: "hospital-tender-snapshot-v1",
    generatedAt: "2026-09-01T01:00:00.000Z",
    notices: [{
      identityKey: "source-http:item-1",
      sourceId: "source-http",
      sourceName: "示例采购平台",
      city: "日照市",
      title: "日照中医医院 PACS 存储扩容中标公告",
      url: "https://example.com/notices/http-1",
      publishedAt: "2026-09-01T00:00:00.000Z",
      noticeType: "result",
      purchaser: "日照中医医院",
      projectCode: "RZ-HTTP-01",
      budgetText: "500 万元",
      deadlineText: "2026-09-10",
      contentText,
      hospitalNames: ["日照中医医院"],
      sourceItemId: "item-1",
      contentSha256: "a".repeat(64),
      relevance: "high",
    }],
    sources: [{
      sourceId: "source-http",
      sourceName: "示例采购平台",
      status: "healthy",
      lastRunAt: "2026-09-01T00:00:00.000Z",
      lastSuccessAt: "2026-09-01T00:00:00.000Z",
      lastItemCount: 1,
      lastUpsertedCount: 1,
      lastRejectedCount: 0,
    }],
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function login() {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account: ACCOUNT, password: PASSWORD }),
  });
  assert.equal(result.response.status, 200);
  cookie = result.response.headers.get("set-cookie").split(";", 1)[0];
  csrfToken = result.body.csrfToken;
}

async function syncNotice() {
  const result = await request("/api/integrations/hospital-tenders/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${SYNC_TOKEN}` },
    body: JSON.stringify(snapshotPayload()),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.item.acceptedCount, 1);
}

function userHeaders() {
  return { Cookie: cookie, "X-CSRF-Token": csrfToken };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-tender-conversion-api-"));
  const authPasswordHash = await hashPassword(PASSWORD, { salt: Buffer.alloc(16, 7) });
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: true,
    nodeEnv: "test",
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: true,
    authAccount: ACCOUNT,
    authPassword: "",
    authPasswordHash,
    authSessionSecret: SESSION_SECRET,
    authCookieSecure: false,
    hospitalTenderSyncToken: SYNC_TOKEN,
    hospitalTenderAutoRun: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await syncNotice();
  await login();
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  server = null;
  tempDir = null;
  cookie = null;
  csrfToken = null;
});

describe("hospital tender lead conversion HTTP integration", () => {
  it("previews, confirms, and replays one owner-scoped conversion", async () => {
    const list = await request("/api/hospital-tenders", { headers: userHeaders() });
    assert.equal(list.response.status, 200);
    const noticeId = list.body.items[0].id;
    const route = `/api/hospital-tenders/${encodeURIComponent(noticeId)}/lead-conversion`;

    const preview = await request(`${route}/preview`, {
      method: "POST",
      headers: userHeaders(),
      body: JSON.stringify({ customerId: "rizhao" }),
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.response.headers.get("cache-control"), "no-store");
    assert.equal(preview.body.item.status, "preview");
    assert.equal(preview.body.item.requiresHumanConfirmation, true);

    const confirm = await request(`${route}/confirm`, {
      method: "POST",
      headers: userHeaders(),
      body: JSON.stringify({
        customerId: "rizhao",
        previewDigest: preview.body.item.previewDigest,
        confirmed: true,
      }),
    });
    assert.equal(confirm.response.status, 200);
    assert.equal(confirm.body.item.status, "confirmed");
    assert.equal(confirm.body.item.replayed, false);

    const replay = await request(`${route}/confirm`, {
      method: "POST",
      headers: userHeaders(),
      body: JSON.stringify({
        customerId: "rizhao",
        previewDigest: preview.body.item.previewDigest,
        confirmed: true,
      }),
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.replayed, true);

    const opportunities = await request("/api/opportunities", { headers: userHeaders() });
    const actions = await request("/api/actions", { headers: userHeaders() });
    assert.equal(opportunities.body.items.filter((item) => item.sourceRecord?.startsWith("hospital_tender:")).length, 1);
    assert.equal(actions.body.items.filter((item) => item.opportunityId === confirm.body.item.opportunity.id).length, 1);
  });

  it("requires an explicit confirmation and keeps the route owner-bound", async () => {
    const noticeId = (await request("/api/hospital-tenders", { headers: userHeaders() })).body.items[0].id;
    const route = `/api/hospital-tenders/${encodeURIComponent(noticeId)}/lead-conversion`;
    const missingAuth = await request(`${route}/preview`, {
      method: "POST",
      body: JSON.stringify({ customerId: "rizhao" }),
    });
    assert.equal(missingAuth.response.status, 401);

    const preview = await request(`${route}/preview`, {
      method: "POST",
      headers: userHeaders(),
      body: JSON.stringify({ customerId: "rizhao" }),
    });
    assert.equal(preview.response.status, 200);

    const forged = await request(`${route}/confirm`, {
      method: "POST",
      headers: userHeaders(),
      body: JSON.stringify({
        customerId: "rizhao",
        owner: "another-account",
        previewDigest: preview.body.item.previewDigest,
        confirmed: true,
      }),
    });
    assert.equal(forged.response.status, 422);
    assert.equal(forged.body.error.code, "VALIDATION_ERROR");

    const notConfirmed = await request(`${route}/confirm`, {
      method: "POST",
      headers: userHeaders(),
      body: JSON.stringify({
        customerId: "rizhao",
        previewDigest: preview.body.item.previewDigest,
        confirmed: false,
      }),
    });
    assert.equal(notConfirmed.response.status, 422);
    assert.equal(notConfirmed.body.error.code, "CONFIRMATION_REQUIRED");
  });
});
