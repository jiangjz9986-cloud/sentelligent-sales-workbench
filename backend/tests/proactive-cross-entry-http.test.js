import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

const account = "crossentry";
const loginValue = "cross-entry-login-value";

let tempDir;
let server;
let baseUrl;
let session;

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function login() {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, password: loginValue }),
  });
  assert.equal(result.response.status, 200);
  return {
    cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    csrf: result.body.csrfToken,
  };
}

function asUser(currentSession) {
  return (path, options = {}) => request(path, {
    ...options,
    headers: {
      Cookie: currentSession.cookie,
      ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": currentSession.csrf } : {}),
      ...(options.headers ?? {}),
    },
  });
}

function suggestion(id, {
  customerId = "cross-customer",
  opportunityId = "cross-opportunity",
  subjectId = opportunityId,
  title = `跨入口建议 ${id}`,
} = {}) {
  return {
    id,
    schemaVersion: "proactive-assistant-v1",
    modelVersion: "rules/proactive-v1",
    subjectType: "opportunity",
    subjectId,
    customerId,
    opportunityId,
    opportunityVersion: 1,
    customerVersion: 1,
    title,
    conclusion: "跨入口必须读取同一条持久建议。",
    facts: [],
    inferences: [],
    unknowns: [],
    risks: [],
    nextActions: [],
    evidenceRefs: [],
    sourceRefs: [],
    confidence: null,
    confidenceLevel: "unverified",
    confidenceCalibrated: false,
    priority: null,
    priorityCalibrated: false,
    trigger: {
      type: "missing_next_step",
      reason: "next 为空",
      detectedAt: "2026-09-05T06:00:00.000Z",
    },
    source: "deterministic",
    fallbackReason: null,
    confirmationStatus: "not_started",
    writebackPreview: {
      requiresHumanConfirmation: true,
      automaticWriteAllowed: false,
      action: null,
      risk: null,
    },
    previewDigests: {},
    writebackAllowed: false,
  };
}

function byId(snapshot, id) {
  return snapshot?.items?.find((item) => item.id === id) ?? null;
}

describe("proactive durable ledger cross-entry HTTP contract", () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sentelligent-proactive-cross-entry-"));
    const databaseUrl = join(tempDir, "cross-entry.sqlite");
    server = createServer({
      databaseUrl,
      seed: false,
      nodeEnv: "test",
      authRequired: true,
      authAccount: account,
      authPassword: "",
      authPasswordHash: await hashPassword(loginValue, { salt: Buffer.alloc(16, 71) }),
      authSessionSecret: Buffer.alloc(32, 72).toString("base64url"),
      authCookieSecure: false,
      proactiveAssistantAutoRun: false,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const now = "2026-09-05T06:00:00.000Z";
    const db = createConnection({ databaseUrl });
    try {
      db.prepare(`
        INSERT INTO customers (id, name, owner, version, created_at, updated_at)
        VALUES ('cross-customer', '跨入口客户', $owner, 1, $now, $now),
               ('other-customer', '其他客户', $owner, 1, $now, $now)
      `).run({ owner: account, now });
      db.prepare(`
        INSERT INTO opportunities (id, customer_id, name, stage, owner, version, days, next, created_at, updated_at)
        VALUES ('cross-opportunity', 'cross-customer', '跨入口商机', '方案输出', $owner, 1, 40, NULL, $now, $now),
               ('other-opportunity', 'other-customer', '其他商机', '接洽', $owner, 1, 10, NULL, $now, $now)
      `).run({ owner: account, now });
    } finally {
      db.close();
    }

    const repository = server.proactiveSuggestionRepository;
    repository.save({
      owner: account,
      suggestion: suggestion("shared-suggestion"),
      dedupeKey: "cross-entry:shared",
      priority: 100,
    });
    for (let index = 0; index < 4; index += 1) {
      repository.save({
        owner: account,
        suggestion: suggestion(`customer-suggestion-${index}`, { subjectId: `cross-subject-${index}` }),
        dedupeKey: `cross-entry:customer:${index}`,
        priority: 10 - index,
      });
    }
    repository.save({
      owner: account,
      suggestion: suggestion("other-suggestion", {
        customerId: "other-customer",
        opportunityId: "other-opportunity",
      }),
      dedupeKey: "cross-entry:other",
      priority: 50,
    });
    session = await login();
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps one suggestion id and version across Overview, customer, opportunity, pagination, refresh, and a new login", async () => {
    let user = asUser(session);

    const overview = await user("/api/dashboard/summary");
    assert.equal(overview.response.status, 200);
    assert.deepEqual(
      { id: byId(overview.body.item.proactiveAssistant, "shared-suggestion")?.id, version: byId(overview.body.item.proactiveAssistant, "shared-suggestion")?.version },
      { id: "shared-suggestion", version: 1 },
    );

    const global = await user("/api/assistant/proactive?limit=2&offset=0&includeHistory=true");
    assert.equal(global.response.status, 200);
    assert.equal(global.body.item.counts.total, 6);
    assert.equal(global.body.item.truncated, true);
    assert.deepEqual(
      { id: byId(global.body.item, "shared-suggestion")?.id, version: byId(global.body.item, "shared-suggestion")?.version },
      { id: "shared-suggestion", version: 1 },
    );

    const customerFirst = await user("/api/assistant/proactive?customerId=cross-customer&limit=2&offset=0&includeHistory=true");
    const customerSecond = await user("/api/assistant/proactive?customerId=cross-customer&limit=2&offset=2&includeHistory=true");
    const customerThird = await user("/api/assistant/proactive?customerId=cross-customer&limit=2&offset=4&includeHistory=true");
    const customerRows = [customerFirst, customerSecond, customerThird].flatMap((result) => result.body.item.items);
    assert.equal(customerFirst.body.item.counts.total, 5);
    assert.equal(customerFirst.body.item.truncated, true);
    assert.equal(customerSecond.body.item.truncated, true);
    assert.equal(customerThird.body.item.truncated, false);
    assert.equal(new Set(customerRows.map((item) => item.id)).size, 5);
    assert.ok(customerRows.every((item) => item.customerId === "cross-customer"));

    const opportunity = await user("/api/assistant/proactive?opportunityId=cross-opportunity&includeHistory=true&limit=100&offset=0");
    assert.equal(opportunity.response.status, 200);
    assert.equal(opportunity.body.item.counts.total, 5);
    assert.ok(opportunity.body.item.items.every((item) => item.opportunityId === "cross-opportunity"));

    const combined = await user("/api/assistant/proactive?customerId=cross-customer&opportunityId=cross-opportunity&subjectId=cross-opportunity&trigger=missing_next_step&status=pending&includeHistory=true");
    assert.equal(combined.response.status, 200);
    assert.deepEqual(combined.body.item.items.map((item) => ({ id: item.id, version: item.version })), [
      { id: "shared-suggestion", version: 1 },
    ]);
    assert.equal(combined.body.item.counts.total, 1);
    assert.equal(combined.body.item.lifecycleCounts.pending, 1);

    const updated = await user("/api/assistant/proactive/shared-suggestion", {
      method: "PATCH",
      headers: { "Idempotency-Key": "cross-entry-defer-0001" },
      body: JSON.stringify({ status: "deferred", expectedVersion: 1 }),
    });
    assert.equal(updated.response.status, 200);
    assert.deepEqual(
      { id: updated.body.item.id, version: updated.body.item.version, status: updated.body.item.proactiveStatus },
      { id: "shared-suggestion", version: 2, status: "deferred" },
    );

    for (const path of [
      "/api/dashboard/summary",
      "/api/assistant/proactive?customerId=cross-customer&includeHistory=true",
      "/api/assistant/proactive?opportunityId=cross-opportunity&includeHistory=true",
    ]) {
      const readback = await user(path);
      const snapshot = path === "/api/dashboard/summary" ? readback.body.item.proactiveAssistant : readback.body.item;
      const item = byId(snapshot, "shared-suggestion");
      assert.deepEqual({ id: item?.id, version: item?.version, status: item?.proactiveStatus }, {
        id: "shared-suggestion",
        version: 2,
        status: "deferred",
      });
    }

    const logout = await user("/api/auth/logout", { method: "POST", body: "{}" });
    assert.equal(logout.response.status, 204);
    session = await login();
    user = asUser(session);
    const afterLogin = await user("/api/assistant/proactive?opportunityId=cross-opportunity&includeHistory=true");
    assert.equal(afterLogin.response.status, 200);
    const persisted = byId(afterLogin.body.item, "shared-suggestion");
    assert.deepEqual({ id: persisted?.id, version: persisted?.version, status: persisted?.proactiveStatus }, {
      id: "shared-suggestion",
      version: 2,
      status: "deferred",
    });
  });
});
