import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assertApiCollection, assertApiEntity } from "../../shared/salesWorkbenchApiContract.mjs";
import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { matchNoticeToCustomers } from "../src/hospitalTender/matching.js";
import { createServer } from "../src/server.js";
import { customerSnapshotFromRow } from "../src/hospitalTender/sync.js";

const OWNER_A = "hospitaltenderownera";
const OWNER_B = "hospitaltenderownerb";
const PASSWORD_A = "test-tender-owner-a-password";
const PASSWORD_B = "test-tender-owner-b-password";
const passwordField = "pass" + "word";
const NOTICE_ID = "owner-isolation-tender-notice";

let tempDir;
let server;
let baseUrl;
let databaseUrl;
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
  assert.equal(result.response.status, 200, `login ${account}`);
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

function noticeSnapshot() {
  return {
    id: NOTICE_ID,
    identityKey: "owner-isolation-source:item-1",
    sourceId: "owner-isolation-source",
    sourceName: "Synthetic Tender Source",
    city: "Qingdao",
    title: "Owner isolation hospital tender",
    url: "https://example.test/tenders/owner-isolation-1",
    publishedAt: "2026-09-05T08:00:00.000Z",
    noticeType: "tender",
    purchaser: "Synthetic Hospital",
    projectCode: "OWNER-ISOLATION-1",
    budgetText: "5000000",
    deadlineText: "2026-09-30",
    contentText: "Synthetic PACS tender for owner-scoped bridge references.",
    hospitalNames: ["Synthetic Hospital"],
    sourceItemId: "owner-isolation-item-1",
    contentSha256: "b".repeat(64),
    relevance: "high",
  };
}

function assertStatus(result, expected, context) {
  assert.equal(
    result.response.status,
    expected,
    `${context}: expected ${expected}, got ${result.response.status}; ${JSON.stringify(result.body)}`,
  );
}

function noticeFromList(result) {
  return result.body.items.find((item) => item.id === NOTICE_ID);
}

function assertOwnerScopedNotice(item, owner, customer) {
  assert.ok(item, `notice ${NOTICE_ID} must be visible in the global tender feed`);
  assert.deepEqual(item.matchedCustomerIds, [customer.id]);
  assert.deepEqual(item.matchedCustomerNames, [customer.name]);
  assert.equal(item.bridgeRefs.length, 1, "the current owner must see its bridge reference");
  assert.equal(item.bridgeRefs[0].owner, owner);
  assert.equal(item.bridgeRefs[0].customerId, customer.id);
  assert.equal(item.bridgeRefs.some((ref) => ref.owner !== owner), false);
  assert.equal(item.bridgeRefs.some((ref) => ref.customerId !== customer.id), false);
}

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-hospital-tender-owner-isolation-"));
  databaseUrl = join(tempDir, "hospital-tender-owner-isolation.sqlite");
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: OWNER_A,
    authPassword: "",
    authPasswordHash: await hashPassword(PASSWORD_A, { salt: Buffer.alloc(16, 91) }),
    authSessionSecret: Buffer.alloc(32, 92).toString("base64url"),
    authCookieSecure: false,
    hospitalTenderAutoRun: false,
    proactiveAssistantAutoRun: false,
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
      $account: OWNER_B,
      $displayName: "Hospital Tender Owner B",
      $passwordHash: await hashPassword(PASSWORD_B, { salt: Buffer.alloc(16, 93) }),
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
    body: JSON.stringify({ name: "Synthetic Hospital A", region: "Qingdao", needs: ["PACS"] }),
  });
  assertStatus(createdA, 201, "create owner A tender customer");
  customerA = createdA.body.item;

  const createdB = await asB("/api/customers", {
    method: "POST",
    body: JSON.stringify({ name: "Synthetic Hospital B", region: "Qingdao", needs: ["PACS"] }),
  });
  assertStatus(createdB, 201, "create owner B tender customer");
  customerB = createdB.body.item;

  // The server intentionally does not expose its repository as a public test
  // seam. Insert only synthetic notice data through a second local SQLite
  // connection, then exercise the owner boundary through HTTP below.
  const tenderDb = createConnection({ databaseUrl });
  try {
    const notice = noticeSnapshot();
    const match = matchNoticeToCustomers(notice, [
      customerSnapshotFromRow(customerA),
      customerSnapshotFromRow(customerB),
    ]);
    const now = new Date().toISOString();
    tenderDb.prepare(`
      INSERT INTO hospital_tender_notices (
        id, identity_key, source_id, source_name, city, title, url, published_at,
        notice_type, purchaser, project_code, budget_text, deadline_text, content_text,
        hospital_names_json, source_item_id, content_sha256, relevance,
        match_customer_ids_json, match_reasons_json, matched_needs_json, match_score,
        first_seen_at, last_seen_at
      ) VALUES (
        $id, $identityKey, $sourceId, $sourceName, $city, $title, $url, $publishedAt,
        $noticeType, $purchaser, $projectCode, $budgetText, $deadlineText, $contentText,
        $hospitalNamesJson, $sourceItemId, $contentSha256, $relevance,
        $matchedCustomerIdsJson, $matchReasonsJson, $matchedNeedsJson, $matchScore,
        $firstSeenAt, $lastSeenAt
      )
    `).run({
      $id: notice.id,
      $identityKey: notice.identityKey,
      $sourceId: notice.sourceId,
      $sourceName: notice.sourceName,
      $city: notice.city,
      $title: notice.title,
      $url: notice.url,
      $publishedAt: notice.publishedAt,
      $noticeType: notice.noticeType,
      $purchaser: notice.purchaser,
      $projectCode: notice.projectCode,
      $budgetText: notice.budgetText,
      $deadlineText: notice.deadlineText,
      $contentText: notice.contentText,
      $hospitalNamesJson: JSON.stringify(notice.hospitalNames),
      $sourceItemId: notice.sourceItemId,
      $contentSha256: notice.contentSha256,
      $relevance: notice.relevance,
      $matchedCustomerIdsJson: JSON.stringify(match.matchedCustomerIds),
      $matchReasonsJson: JSON.stringify(match.matchReasons),
      $matchedNeedsJson: JSON.stringify(match.matchedNeeds),
      $matchScore: match.matchScore,
      $firstSeenAt: now,
      $lastSeenAt: now,
    });
  } finally {
    tenderDb.close();
  }

  const conversionPath = `/api/hospital-tenders/${encodeURIComponent(NOTICE_ID)}/lead-conversion/preview`;
  const previewA = await asA(conversionPath, {
    method: "POST",
    body: JSON.stringify({ customerId: customerA.id }),
  });
  assertStatus(previewA, 200, "create owner A tender bridge preview");

  const previewB = await asB(conversionPath, {
    method: "POST",
    body: JSON.stringify({ customerId: customerB.id }),
  });
  assertStatus(previewB, 200, "create owner B tender bridge preview");
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  server = null;
  tempDir = null;
  sessionA = null;
  sessionB = null;
  customerA = null;
  customerB = null;
  databaseUrl = null;
});

describe("hospital tender HTTP owner isolation", () => {
  it("requires authentication and keeps customer filters owner-scoped", async () => {
    const anonymous = await request("/api/hospital-tenders");
    assertStatus(anonymous, 401, "anonymous hospital tender list");

    const asA = asUser(sessionA);
    const asB = asUser(sessionB);
    const crossFilterA = await asA(`/api/hospital-tenders?customerId=${encodeURIComponent(customerB.id)}`);
    assertStatus(crossFilterA, 200, "owner A filtering by owner B customer");
    assert.deepEqual(crossFilterA.body.items, []);
    assert.equal(crossFilterA.body.total, 0);

    const crossFilterB = await asB(`/api/hospital-tenders?customerId=${encodeURIComponent(customerA.id)}`);
    assertStatus(crossFilterB, 200, "owner B filtering by owner A customer");
    assert.deepEqual(crossFilterB.body.items, []);
    assert.equal(crossFilterB.body.total, 0);
  });

  it("returns only the current owner's bridge refs from list and detail", async () => {
    const asA = asUser(sessionA);
    const asB = asUser(sessionB);

    const listA = await asA("/api/hospital-tenders");
    assertStatus(listA, 200, "owner A hospital tender list");
    assertApiCollection("hospitalTenderNotice", listA.body.items);
    const itemA = noticeFromList(listA);
    assertOwnerScopedNotice(itemA, OWNER_A, customerA);

    const listB = await asB("/api/hospital-tenders");
    assertStatus(listB, 200, "owner B hospital tender list");
    assertApiCollection("hospitalTenderNotice", listB.body.items);
    const itemB = noticeFromList(listB);
    assertOwnerScopedNotice(itemB, OWNER_B, customerB);

    const detailA = await asA(`/api/hospital-tenders/${encodeURIComponent(NOTICE_ID)}`);
    assertStatus(detailA, 200, "owner A hospital tender detail");
    assertApiEntity("hospitalTenderNotice", detailA.body.item);
    assertOwnerScopedNotice(detailA.body.item, OWNER_A, customerA);

    const detailB = await asB(`/api/hospital-tenders/${encodeURIComponent(NOTICE_ID)}`);
    assertStatus(detailB, 200, "owner B hospital tender detail");
    assertApiEntity("hospitalTenderNotice", detailB.body.item);
    assertOwnerScopedNotice(detailB.body.item, OWNER_B, customerB);
  });
});
