import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assertApiEntity } from "../../shared/salesWorkbenchApiContract.mjs";
import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

const OWNER_A = "tenderbridgehttpownera";
const OWNER_B = "tenderbridgehttpownerb";
const PASSWORD_A = ["test", "tender", "bridge", "a", "password"].join("-");
const PASSWORD_B = ["test", "tender", "bridge", "b", "password"].join("-");
const SYNC_TOKEN = ["test", "tender", "bridge", "sync", "token"].join("-");
const NOTICE_ID = "hospital-tender-bridge-http-1";
const passwordField = "pass" + "word";

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let sessionA;
let sessionB;
let customerA;
let customerB;

function parseResponseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && typeof options.body === "string" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  return { response, body: parseResponseBody(await response.text()) };
}

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function login(account, password) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: password }),
  });
  assertStatus(result, 200, `login ${account}`);
  return {
    account,
    cookie: cookiePair(result.response),
    csrf: result.body.csrfToken,
  };
}

function asUser(session) {
  return (path, options = {}) => request(path, {
    ...options,
    headers: {
      Cookie: session.cookie,
      ...(options.method && options.method !== "GET"
        ? { "X-CSRF-Token": session.csrf }
        : {}),
      ...(options.headers ?? {}),
    },
  });
}

function assertStatus(result, expected, context) {
  assert.equal(
    result.response.status,
    expected,
    `${context}: expected ${expected}, got ${result.response.status}; ${JSON.stringify(result.body)}`,
  );
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function snapshotPayload({ generatedAt, contentText }) {
  return {
    schemaVersion: "hospital-tender-snapshot-v1",
    generatedAt,
    notices: [{
      id: NOTICE_ID,
      identityKey: "bridge-http-source:item-1",
      sourceId: "bridge-http-source",
      sourceName: "Synthetic Tender Source",
      city: "Qingdao",
      title: "Qingdao hospital PACS expansion tender",
      url: "https://example.test/tenders/bridge-http-1",
      publishedAt: "2026-09-06T00:00:00.000Z",
      noticeType: "tender",
      purchaser: "Synthetic Hospital Consortium",
      projectCode: "BRIDGE-HTTP-2026-01",
      budgetText: "5000000",
      deadlineText: "2026-09-30",
      contentText,
      hospitalNames: ["Synthetic Hospital Consortium"],
      sourceItemId: "bridge-http-item-1",
      contentSha256: sha256(contentText),
      relevance: "high",
    }],
    sources: [{
      sourceId: "bridge-http-source",
      sourceName: "Synthetic Tender Source",
      status: "healthy",
      lastRunAt: generatedAt,
      lastSuccessAt: generatedAt,
      lastItemCount: 1,
      lastUpsertedCount: 1,
      lastRejectedCount: 0,
    }],
  };
}

async function syncNotice({ generatedAt, contentText }) {
  const result = await request("/api/integrations/hospital-tenders/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${SYNC_TOKEN}` },
    body: JSON.stringify(snapshotPayload({ generatedAt, contentText })),
  });
  assertStatus(result, 200, `sync hospital tender at ${generatedAt}`);
  assert.equal(result.body.item.acceptedCount, 1);
  assert.equal(result.body.item.rejectedCount, 0);
  const notice = result.body.item.notices.find((item) => item.id === NOTICE_ID);
  assert.ok(notice, `sync response must contain ${NOTICE_ID}`);
  assertApiEntity("hospitalTenderNotice", notice);
  return notice;
}

function conversionPath(action) {
  return `/api/hospital-tenders/${encodeURIComponent(NOTICE_ID)}/lead-conversion/${action}`;
}

function confirmationBody(preview, customerId) {
  return {
    customerId,
    previewDigest: preview.previewDigest,
    confirmed: true,
    canonicalNoticeId: preview.canonicalNoticeId,
    noticeRevision: preview.canonicalRevision,
    noticeDigest: preview.canonicalDigest,
    matchSnapshotDigest: preview.matchSnapshotDigest,
    customerSnapshotDigest: preview.customerSnapshotDigest,
    customerVersion: preview.customerVersion,
    opportunitySnapshotDigest: preview.opportunitySnapshotDigest,
  };
}

function noticeFromList(result) {
  return result.body.items.find((item) => item.id === NOTICE_ID);
}

function assertOwnerNotice(item, { owner, customer, bridgeStatus }) {
  assert.ok(item, `notice ${NOTICE_ID} must remain visible to ${owner}`);
  assertApiEntity("hospitalTenderNotice", item);
  assert.deepEqual(item.matchedCustomerIds, [customer.id]);
  assert.deepEqual(item.matchedCustomerNames, [customer.name]);
  assert.equal(item.bridgeStatus, bridgeStatus);
  assert.equal(item.bridgeRefs.length, 1);
  assert.equal(item.bridgeRefs[0].owner, owner);
  assert.equal(item.bridgeRefs[0].customerId, customer.id);
  assert.equal(item.bridgeRefs[0].status, bridgeStatus);
  assert.equal(item.bridgeRefs.some((ref) => ref.owner !== owner), false);
  assert.equal(item.bridgeRefs.some((ref) => ref.customerId !== customer.id), false);
}

function conversionProjection(item) {
  return {
    status: item.status,
    noticeId: item.noticeId,
    customerId: item.customerId,
    conversionIdentity: item.conversionIdentity,
    canonicalNoticeId: item.canonicalNoticeId,
    canonicalRevision: item.canonicalRevision,
    canonicalDigest: item.canonicalDigest,
    previewDigest: item.previewDigest,
    opportunityId: item.opportunity.id,
    actionItemId: item.actionItem.id,
    bridgeId: item.bridge.id,
    bridgeOpportunityId: item.bridge.opportunityId,
    bridgeActionItemId: item.bridge.actionItemId,
  };
}

function rowCounts() {
  const db = createConnection({ databaseUrl });
  try {
    const count = (table, where = "1 = 1", parameters = {}) => Number(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(parameters).count,
    );
    return {
      customers: count("customers", "deleted_at IS NULL"),
      opportunities: count("opportunities", "deleted_at IS NULL"),
      actionItems: count("action_items", "deleted_at IS NULL"),
      bridges: count("hospital_tender_bridges"),
      conversionAudits: count(
        "audit_logs",
        "action = $action",
        { $action: "hospital_tender.lead_conversion.confirm" },
      ),
    };
  } finally {
    db.close();
  }
}

function assertPersistedOwnerIsolation(confirmed) {
  const db = createConnection({ databaseUrl });
  try {
    const customers = db.prepare(`
      SELECT id, owner FROM customers
      WHERE deleted_at IS NULL
      ORDER BY owner ASC
    `).all().map((row) => ({ id: row.id, owner: row.owner }));
    assert.deepEqual(customers, [
      { id: customerA.id, owner: OWNER_A },
      { id: customerB.id, owner: OWNER_B },
    ]);

    const bridges = db.prepare(`
      SELECT owner, customer_id, status, opportunity_id, action_item_id
      FROM hospital_tender_bridges
      ORDER BY owner ASC
    `).all().map((row) => ({
      owner: row.owner,
      customer_id: row.customer_id,
      status: row.status,
      opportunity_id: row.opportunity_id,
      action_item_id: row.action_item_id,
    }));
    assert.deepEqual(bridges, [
      {
        owner: OWNER_A,
        customer_id: customerA.id,
        status: "confirmed",
        opportunity_id: confirmed.opportunity.id,
        action_item_id: confirmed.actionItem.id,
      },
      {
        owner: OWNER_B,
        customer_id: customerB.id,
        status: "conflict",
        opportunity_id: null,
        action_item_id: null,
      },
    ]);

    const opportunities = db.prepare(`
      SELECT id, customer_id, owner FROM opportunities
      WHERE deleted_at IS NULL
    `).all().map((row) => ({
      id: row.id,
      customer_id: row.customer_id,
      owner: row.owner,
    }));
    assert.deepEqual(opportunities, [{
      id: confirmed.opportunity.id,
      customer_id: customerA.id,
      owner: OWNER_A,
    }]);

    const actionItems = db.prepare(`
      SELECT id, customer_id, opportunity_id, owner FROM action_items
      WHERE deleted_at IS NULL
    `).all().map((row) => ({
      id: row.id,
      customer_id: row.customer_id,
      opportunity_id: row.opportunity_id,
      owner: row.owner,
    }));
    assert.deepEqual(actionItems, [{
      id: confirmed.actionItem.id,
      customer_id: customerA.id,
      opportunity_id: confirmed.opportunity.id,
      owner: OWNER_A,
    }]);
  } finally {
    db.close();
  }
}

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-hospital-tender-bridge-http-"));
  databaseUrl = join(tempDir, "hospital-tender-bridge-http.sqlite");
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: true,
    authAccount: OWNER_A,
    authPassword: "",
    authPasswordHash: await hashPassword(PASSWORD_A, { salt: Buffer.alloc(16, 101) }),
    authSessionSecret: Buffer.alloc(32, 102).toString("base64url"),
    authCookieSecure: false,
    hospitalTenderSyncToken: SYNC_TOKEN,
    hospitalTenderAutoRun: false,
    proactiveAssistantAutoRun: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const db = createConnection({ databaseUrl });
  try {
    const now = "2026-09-06T00:10:00.000Z";
    db.prepare(`
      INSERT INTO users (account, display_name, password_hash, role, status, created_at, updated_at)
      VALUES ($account, $displayName, $passwordHash, 'member', 'active', $now, $now)
    `).run({
      $account: OWNER_B,
      $displayName: "Hospital Tender Bridge Owner B",
      $passwordHash: await hashPassword(PASSWORD_B, { salt: Buffer.alloc(16, 103) }),
      $now: now,
    });
  } finally {
    db.close();
  }

  sessionA = await login(OWNER_A, PASSWORD_A);
  sessionB = await login(OWNER_B, PASSWORD_B);
  const asA = asUser(sessionA);
  const asB = asUser(sessionB);

  const createdA = await asA("/api/customers", {
    method: "POST",
    body: JSON.stringify({
      name: "Synthetic Bridge Hospital A",
      region: "Qingdao",
      needs: ["PACS"],
    }),
  });
  assertStatus(createdA, 201, "create owner A customer");
  customerA = createdA.body.item;

  const createdB = await asB("/api/customers", {
    method: "POST",
    body: JSON.stringify({
      name: "Synthetic Bridge Hospital B",
      region: "Qingdao",
      needs: ["PACS"],
    }),
  });
  assertStatus(createdB, 201, "create owner B customer");
  customerB = createdB.body.item;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  server = null;
  tempDir = null;
  databaseUrl = null;
  sessionA = null;
  sessionB = null;
  customerA = null;
  customerB = null;
});

describe("hospital tender canonical bridge server HTTP", () => {
  it("rejects stale confirmation, confirms a fresh preview, replays stably, and preserves owner isolation", async () => {
    const asA = asUser(sessionA);
    const asB = asUser(sessionB);
    const initialNotice = await syncNotice({
      generatedAt: "2026-09-06T01:00:00.000Z",
      contentText: "Synthetic PACS tender scope version one.",
    });
    assert.equal(initialNotice.canonicalRevision, 1);
    assert.match(initialNotice.canonicalDigest, /^[0-9a-f]{64}$/u);

    const previewAResult = await asA(conversionPath("preview"), {
      method: "POST",
      headers: { "Idempotency-Key": "hospital-tender-preview-a-v1" },
      body: JSON.stringify({ customerId: customerA.id }),
    });
    assertStatus(previewAResult, 200, "owner A initial bridge preview");
    assert.equal(previewAResult.response.headers.get("cache-control"), "no-store");
    const previewA = previewAResult.body.item;
    assert.equal(previewA.status, "preview");
    assert.equal(previewA.requiresHumanConfirmation, true);
    assert.equal(previewA.canonicalRevision, initialNotice.canonicalRevision);
    assert.equal(previewA.canonicalDigest, initialNotice.canonicalDigest);
    assert.equal(previewA.bridge.owner, OWNER_A);
    assert.equal(previewA.bridge.customerId, customerA.id);
    assert.equal(previewA.bridge.status, "previewed");

    const crossOwnerPreview = await asA(conversionPath("preview"), {
      method: "POST",
      headers: { "Idempotency-Key": "hospital-tender-cross-owner-preview" },
      body: JSON.stringify({ customerId: customerB.id }),
    });
    assertStatus(crossOwnerPreview, 404, "owner A cannot preview owner B customer");
    assert.equal(crossOwnerPreview.body.error.code, "NOT_FOUND");

    const previewBResult = await asB(conversionPath("preview"), {
      method: "POST",
      headers: { "Idempotency-Key": "hospital-tender-preview-b-v1" },
      body: JSON.stringify({ customerId: customerB.id }),
    });
    assertStatus(previewBResult, 200, "owner B initial bridge preview");
    const previewB = previewBResult.body.item;
    assert.equal(previewB.bridge.owner, OWNER_B);
    assert.equal(previewB.bridge.customerId, customerB.id);
    assert.equal(previewB.bridge.status, "previewed");
    assert.notEqual(previewB.bridge.id, previewA.bridge.id);
    assert.deepEqual(rowCounts(), {
      customers: 2,
      opportunities: 0,
      actionItems: 0,
      bridges: 2,
      conversionAudits: 0,
    });

    const changedNotice = await syncNotice({
      generatedAt: "2026-09-06T02:00:00.000Z",
      contentText: "Synthetic PACS tender scope version two with archive nodes.",
    });
    assert.equal(changedNotice.canonicalNoticeId, initialNotice.canonicalNoticeId);
    assert.equal(changedNotice.canonicalRevision, initialNotice.canonicalRevision + 1);
    assert.notEqual(changedNotice.canonicalDigest, initialNotice.canonicalDigest);

    const staleConfirm = await asA(conversionPath("confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": "hospital-tender-confirm-a-stale" },
      body: JSON.stringify(confirmationBody(previewA, customerA.id)),
    });
    assertStatus(staleConfirm, 409, "stale bridge confirmation after notice revision change");
    assert.equal(staleConfirm.body.error.code, "PREVIEW_STALE");
    assert.deepEqual(rowCounts(), {
      customers: 2,
      opportunities: 0,
      actionItems: 0,
      bridges: 2,
      conversionAudits: 0,
    });

    const freshPreviewResult = await asA(conversionPath("preview"), {
      method: "POST",
      headers: { "Idempotency-Key": "hospital-tender-preview-a-v2" },
      body: JSON.stringify({ customerId: customerA.id }),
    });
    assertStatus(freshPreviewResult, 200, "owner A fresh bridge preview");
    const freshPreview = freshPreviewResult.body.item;
    assert.equal(freshPreview.canonicalNoticeId, changedNotice.canonicalNoticeId);
    assert.equal(freshPreview.canonicalRevision, changedNotice.canonicalRevision);
    assert.equal(freshPreview.canonicalDigest, changedNotice.canonicalDigest);
    assert.notEqual(freshPreview.previewDigest, previewA.previewDigest);
    assert.equal(freshPreview.bridge.id, previewA.bridge.id);
    assert.equal(freshPreview.bridge.status, "previewed");

    const confirmBody = confirmationBody(freshPreview, customerA.id);
    const confirmKey = "hospital-tender-confirm-a-v2";
    const confirmedResult = await asA(conversionPath("confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": confirmKey },
      body: JSON.stringify(confirmBody),
    });
    assertStatus(confirmedResult, 200, "fresh bridge confirmation");
    const confirmed = confirmedResult.body.item;
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.replayed, false);
    assert.equal(confirmed.bridge.status, "confirmed");
    assert.deepEqual(rowCounts(), {
      customers: 2,
      opportunities: 1,
      actionItems: 1,
      bridges: 2,
      conversionAudits: 1,
    });

    const exactReplayResult = await asA(conversionPath("confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": confirmKey },
      body: JSON.stringify(confirmBody),
    });
    assertStatus(exactReplayResult, 200, "exact confirmation replay with the same idempotency key");
    const exactReplay = exactReplayResult.body.item;
    assert.equal(exactReplay.replayed, true);
    assert.deepEqual(conversionProjection(exactReplay), conversionProjection(confirmed));
    assert.deepEqual(rowCounts(), {
      customers: 2,
      opportunities: 1,
      actionItems: 1,
      bridges: 2,
      conversionAudits: 1,
    });

    const stableReplayResult = await asA(conversionPath("confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": "hospital-tender-confirm-a-v2-new-key" },
      body: JSON.stringify(confirmBody),
    });
    assertStatus(stableReplayResult, 200, "stable confirmation replay with a new idempotency key");
    const stableReplay = stableReplayResult.body.item;
    assert.equal(stableReplay.replayed, true);
    assert.deepEqual(conversionProjection(stableReplay), conversionProjection(confirmed));
    assert.deepEqual(rowCounts(), {
      customers: 2,
      opportunities: 1,
      actionItems: 1,
      bridges: 2,
      conversionAudits: 1,
    });

    const listA = await asA("/api/hospital-tenders");
    assertStatus(listA, 200, "owner A tender list after confirmation replay");
    assertOwnerNotice(noticeFromList(listA), {
      owner: OWNER_A,
      customer: customerA,
      bridgeStatus: "confirmed",
    });

    const listB = await asB("/api/hospital-tenders");
    assertStatus(listB, 200, "owner B tender list after owner A confirmation replay");
    assertOwnerNotice(noticeFromList(listB), {
      owner: OWNER_B,
      customer: customerB,
      bridgeStatus: "conflict",
    });

    const detailA = await asA(`/api/hospital-tenders/${encodeURIComponent(NOTICE_ID)}`);
    assertStatus(detailA, 200, "owner A tender detail after confirmation replay");
    assertOwnerNotice(detailA.body.item, {
      owner: OWNER_A,
      customer: customerA,
      bridgeStatus: "confirmed",
    });

    const detailB = await asB(`/api/hospital-tenders/${encodeURIComponent(NOTICE_ID)}`);
    assertStatus(detailB, 200, "owner B tender detail after owner A confirmation replay");
    assertOwnerNotice(detailB.body.item, {
      owner: OWNER_B,
      customer: customerB,
      bridgeStatus: "conflict",
    });

    const crossFilterA = await asA(`/api/hospital-tenders?customerId=${encodeURIComponent(customerB.id)}`);
    assertStatus(crossFilterA, 200, "owner A filtering by owner B customer");
    assert.deepEqual(crossFilterA.body.items, []);
    assert.equal(crossFilterA.body.total, 0);

    const crossFilterB = await asB(`/api/hospital-tenders?customerId=${encodeURIComponent(customerA.id)}`);
    assertStatus(crossFilterB, 200, "owner B filtering by owner A customer");
    assert.deepEqual(crossFilterB.body.items, []);
    assert.equal(crossFilterB.body.total, 0);

    const opportunitiesA = await asA("/api/opportunities");
    const opportunitiesB = await asB("/api/opportunities");
    assertStatus(opportunitiesA, 200, "owner A opportunity readback");
    assertStatus(opportunitiesB, 200, "owner B opportunity isolation");
    assert.equal(opportunitiesA.body.items.some((item) => item.id === confirmed.opportunity.id), true);
    assert.equal(opportunitiesB.body.items.some((item) => item.id === confirmed.opportunity.id), false);

    const actionsA = await asA("/api/actions");
    const actionsB = await asB("/api/actions");
    assertStatus(actionsA, 200, "owner A action readback");
    assertStatus(actionsB, 200, "owner B action isolation");
    assert.equal(actionsA.body.items.some((item) => item.id === confirmed.actionItem.id), true);
    assert.equal(actionsB.body.items.some((item) => item.id === confirmed.actionItem.id), false);

    assertPersistedOwnerIsolation(confirmed);
  });
});
