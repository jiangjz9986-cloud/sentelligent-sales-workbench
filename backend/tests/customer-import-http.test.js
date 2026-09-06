import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

const OWNER_A = "customerimportownera";
const OWNER_B = "customerimportownerb";
const PASSWORD_A = "test-customer-import-a-password";
const PASSWORD_B = "test-customer-import-b-password";
const passwordField = "pass" + "word";

let tempDir;
let server;
let baseUrl;
let databaseUrl;
let sessionA;
let sessionB;

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
  if (
    options.body !== undefined
    && typeof options.body === "string"
    && !headers["Content-Type"]
  ) {
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

function assertStatus(result, expected, context) {
  const actual = result.response.status;
  const detail = actual === 404
    ? "target customer-import route is not mounted in server.js"
    : JSON.stringify(result.body);
  assert.equal(actual, expected, `${context}: expected ${expected}, got ${actual}; ${detail}`);
}

function importCsv({ name = "HTTP Import Hospital", region = "Qingdao", owner = "forged-owner" } = {}) {
  return [
    "name,region,owner",
    `${name},${region},${owner}`,
    "",
  ].join("\n");
}

function importForm({ csv = importCsv(), mapping, ownerField } = {}) {
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "customers.csv");
  if (mapping !== undefined) form.append("mapping", JSON.stringify(mapping));
  if (ownerField !== undefined) form.append("owner", ownerField);
  return form;
}

function previewPath() {
  return "/api/customer-imports/preview";
}

function batchPath(batchId, action = null) {
  const base = `/api/customer-imports/${encodeURIComponent(batchId)}`;
  return action ? `${base}/${action}` : base;
}

function responseItem(result) {
  return result.body?.item ?? null;
}

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-customer-import-http-"));
  databaseUrl = join(tempDir, "customer-import.sqlite");
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: OWNER_A,
    authPassword: "",
    authPasswordHash: await hashPassword(PASSWORD_A, { salt: Buffer.alloc(16, 81) }),
    authSessionSecret: Buffer.alloc(32, 82).toString("base64url"),
    authCookieSecure: false,
    proactiveAssistantAutoRun: false,
    hospitalTenderAutoRun: false,
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
      $displayName: "Customer Import Owner B",
      $passwordHash: await hashPassword(PASSWORD_B, { salt: Buffer.alloc(16, 83) }),
      $now: now,
    });
  } finally {
    db.close();
  }

  sessionA = await login(OWNER_A, PASSWORD_A);
  sessionB = await login(OWNER_B, PASSWORD_B);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  server = null;
  tempDir = null;
  sessionA = null;
  sessionB = null;
  databaseUrl = null;
});

describe("customer import HTTP contract", () => {
  it("rejects an unauthenticated multipart preview before reading customer data", async () => {
    const result = await request(previewPath(), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-anonymous-preview" },
      body: importForm(),
    });
    assertStatus(result, 401, "anonymous customer import preview");
    assert.equal(result.body?.error?.code, "UNAUTHORIZED");
  });

  it("previews, reads, confirms, and replays a customer batch with session-owned data", async () => {
    const asA = asUser(sessionA);
    const previewResult = await asA(previewPath(), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-preview-http-1" },
      body: importForm({
        mapping: { name: "name", region: "region" },
      }),
    });
    assertStatus(previewResult, 201, "customer import preview");

    const preview = responseItem(previewResult);
    assert.ok(preview, "preview response must contain item");
    assert.equal(preview.customerImportBatch.owner, OWNER_A);
    assert.equal(preview.customerImportBatch.status, "preview");
    assert.equal(preview.customerImportRows.length, 1);
    assert.equal(preview.customerImportRows[0].normalized.name, "HTTP Import Hospital");
    assert.equal(Object.hasOwn(preview.customerImportRows[0].normalized, "owner"), false);
    assert.equal(preview.mapping.fieldToHeader.name, "name");
    assert.match(preview.previewDigest, /^[0-9a-f]{64}$/u);
    assert.match(preview.customerImportBatch.fileSha256, /^[0-9a-f]{64}$/u);

    const previewReplay = await asA(previewPath(), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-preview-http-1" },
      body: importForm({
        mapping: { name: "name", region: "region" },
      }),
    });
    assertStatus(previewReplay, 200, "customer import preview replay");
    assert.equal(responseItem(previewReplay).replayed, true);
    assert.equal(responseItem(previewReplay).customerImportBatch.id, preview.customerImportBatch.id);

    const loaded = await asA(batchPath(preview.customerImportBatch.id));
    assertStatus(loaded, 200, "customer import batch read");
    assert.equal(responseItem(loaded).customerImportBatch.id, preview.customerImportBatch.id);
    assert.equal(responseItem(loaded).previewDigest, preview.previewDigest);

    const confirmBody = {
      confirmed: true,
      previewDigest: preview.previewDigest,
      fileSha256: preview.customerImportBatch.fileSha256,
    };
    const confirmed = await asA(batchPath(preview.customerImportBatch.id, "confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-confirm-http-1" },
      body: JSON.stringify(confirmBody),
    });
    assert.ok([200, 201].includes(confirmed.response.status), `customer import confirm: ${JSON.stringify(confirmed.body)}`);
    const confirmedItem = responseItem(confirmed);
    assert.equal(confirmedItem.customerImportBatch.status, "committed");
    assert.equal(confirmedItem.customerImportRows[0].status, "committed");
    assert.equal(confirmedItem.replayed, false);
    assert.equal(confirmedItem.receipt.batchId, preview.customerImportBatch.id);
    assert.equal(confirmedItem.receipt.previewDigest, preview.previewDigest);
    assert.deepEqual(confirmedItem.receipt.counts, { created: 1, merged: 0, skipped: 0, rejected: 0 });
    assert.deepEqual(confirmedItem.receipt.rows, [{
      rowNumber: confirmedItem.customerImportRows[0].rowNumber,
      action: "create",
      status: "committed",
      customerId: confirmedItem.customerImportRows[0].customerId,
    }]);

    const replay = await asA(batchPath(preview.customerImportBatch.id, "confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-confirm-http-1" },
      body: JSON.stringify(confirmBody),
    });
    assert.ok([200, 201].includes(replay.response.status), `customer import confirm replay: ${JSON.stringify(replay.body)}`);
    assert.equal(responseItem(replay).replayed, true);
    assert.equal(responseItem(replay).customerImportBatch.status, "committed");
    assert.deepEqual(responseItem(replay).receipt, confirmedItem.receipt);

    const replayWithNewKey = await asA(batchPath(preview.customerImportBatch.id, "confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-confirm-http-2" },
      body: JSON.stringify(confirmBody),
    });
    assert.ok([200, 201].includes(replayWithNewKey.response.status), `customer import durable replay: ${JSON.stringify(replayWithNewKey.body)}`);
    assert.equal(responseItem(replayWithNewKey).replayed, true);
    assert.deepEqual(responseItem(replayWithNewKey).receipt, confirmedItem.receipt);

    const stableNewKeyReplay = await asA(batchPath(preview.customerImportBatch.id, "confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-confirm-http-2" },
      body: JSON.stringify(confirmBody),
    });
    assertStatus(stableNewKeyReplay, 200, "customer import durable replay with bound key");
    assert.deepEqual(responseItem(stableNewKeyReplay).receipt, confirmedItem.receipt);

    const customers = await asA("/api/customers");
    assertStatus(customers, 200, "customer import committed customer readback");
    const imported = customers.body.items.find((item) => item.name === "HTTP Import Hospital");
    assert.ok(imported, "confirmed import must create the customer");
    assert.equal(imported.owner, OWNER_A);

    const db = createConnection({ databaseUrl });
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM customer_import_batches WHERE owner = $owner AND idempotency_key = $key")
          .get({ $owner: OWNER_A, $key: "customer-import-preview-http-1" }).count,
        1,
      );
      const confirmAudits = db.prepare(`
        SELECT actor FROM audit_logs
         WHERE action = 'customer_import.confirm'
           AND entity_id = $batchId
      `).all({ $batchId: preview.customerImportBatch.id });
      assert.deepEqual(confirmAudits.map((row) => row.actor), [OWNER_A]);
      assert.equal(
        db.prepare(`
          SELECT COUNT(*) AS count FROM audit_logs
           WHERE action = 'customer_import.idempotency.bind'
             AND entity_id = $batchId
        `).get({ $batchId: preview.customerImportBatch.id }).count,
        1,
      );
    } finally {
      db.close();
    }
  });

  it("cancels a preview and replays cancellation without creating a customer", async () => {
    const asA = asUser(sessionA);
    const previewResult = await asA(previewPath(), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-preview-cancel-1" },
      body: importForm({ csv: importCsv({ name: "Cancelled HTTP Hospital" }) }),
    });
    assertStatus(previewResult, 201, "customer import cancel preview");
    const preview = responseItem(previewResult);

    const cancelled = await asA(batchPath(preview.customerImportBatch.id, "cancel"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-cancel-http-1" },
      body: JSON.stringify({ reason: "operator_cancelled" }),
    });
    assertStatus(cancelled, 200, "customer import cancel");
    assert.equal(responseItem(cancelled).customerImportBatch.status, "cancelled");
    assert.equal(responseItem(cancelled).customerImportRows[0].status, "rejected");
    assert.deepEqual(responseItem(cancelled).receipt.counts, { created: 0, merged: 0, skipped: 0, rejected: 1 });

    const replay = await asA(batchPath(preview.customerImportBatch.id, "cancel"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-cancel-http-2" },
      body: JSON.stringify({ reason: "operator_cancelled" }),
    });
    assertStatus(replay, 200, "customer import cancel replay");
    assert.equal(responseItem(replay).replayed, true);
    assert.deepEqual(responseItem(replay).receipt, responseItem(cancelled).receipt);

    const stableReplay = await asA(batchPath(preview.customerImportBatch.id, "cancel"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-cancel-http-2" },
      body: JSON.stringify({ reason: "operator_cancelled" }),
    });
    assertStatus(stableReplay, 200, "customer import cancel replay with bound key");
    assert.deepEqual(responseItem(stableReplay).receipt, responseItem(cancelled).receipt);

    const customers = await asA("/api/customers");
    assert.equal(customers.body.items.some((item) => item.name === "Cancelled HTTP Hospital"), false);

    const db = createConnection({ databaseUrl });
    try {
      const cancelAudits = db.prepare(`
        SELECT actor FROM audit_logs
         WHERE action = 'customer_import.cancel'
           AND entity_id = $batchId
      `).all({ $batchId: preview.customerImportBatch.id });
      assert.deepEqual(cancelAudits.map((row) => row.actor), [OWNER_A]);
      assert.equal(
        db.prepare(`
          SELECT COUNT(*) AS count FROM audit_logs
           WHERE action = 'customer_import.idempotency.bind'
             AND entity_id = $batchId
        `).get({ $batchId: preview.customerImportBatch.id }).count,
        1,
      );
    } finally {
      db.close();
    }
  });

  it("rejects owner and mapping overrides and hides another owner's batch", async () => {
    const asA = asUser(sessionA);
    const asB = asUser(sessionB);

    const mappingOwner = await asA(previewPath(), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-mapping-owner-1" },
      body: importForm({ mapping: { name: "name", owner: "owner" } }),
    });
    assertStatus(mappingOwner, 422, "owner selected through customer import mapping");
    assert.equal(mappingOwner.body?.error?.code, "CUSTOMER_IMPORT_OWNER_NOT_ALLOWED");

    const formOwner = await asA(previewPath(), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-form-owner-1" },
      body: importForm({ ownerField: OWNER_B }),
    });
    assertStatus(formOwner, 422, "owner supplied as multipart field");
    assert.equal(formOwner.body?.error?.code, "CUSTOMER_IMPORT_OWNER_NOT_ALLOWED");

    const previewResult = await asA(previewPath(), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-cross-owner-preview-1" },
      body: importForm({ csv: importCsv({ name: "Owner Scoped HTTP Hospital" }) }),
    });
    assertStatus(previewResult, 201, "owner-scoped customer import preview");
    const preview = responseItem(previewResult);
    const batchId = preview.customerImportBatch.id;

    const foreignRead = await asB(batchPath(batchId));
    assertStatus(foreignRead, 404, "cross-owner customer import batch read");
    assert.equal(foreignRead.body?.error?.code, "CUSTOMER_IMPORT_BATCH_NOT_FOUND");

    const foreignConfirm = await asB(batchPath(batchId, "confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-cross-owner-confirm-1" },
      body: JSON.stringify({
        confirmed: true,
        previewDigest: preview.previewDigest,
        fileSha256: preview.customerImportBatch.fileSha256,
      }),
    });
    assertStatus(foreignConfirm, 404, "cross-owner customer import confirm");
    assert.equal(foreignConfirm.body?.error?.code, "CUSTOMER_IMPORT_BATCH_NOT_FOUND");

    const foreignCancel = await asB(batchPath(batchId, "cancel"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-cross-owner-cancel-1" },
      body: JSON.stringify({ reason: "forged_cross_owner_cancel" }),
    });
    assertStatus(foreignCancel, 404, "cross-owner customer import cancel");
    assert.equal(foreignCancel.body?.error?.code, "CUSTOMER_IMPORT_BATCH_NOT_FOUND");

    const forgedConfirm = await asA(batchPath(batchId, "confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-forged-owner-confirm-1" },
      body: JSON.stringify({
        owner: OWNER_B,
        confirmed: true,
        previewDigest: preview.previewDigest,
        fileSha256: preview.customerImportBatch.fileSha256,
      }),
    });
    assertStatus(forgedConfirm, 422, "owner supplied in confirm body");
    assert.equal(forgedConfirm.body?.error?.code, "CUSTOMER_IMPORT_OWNER_NOT_ALLOWED");
  });

  it("requires confirmation file digests and reserves idempotency keys across import actions", async () => {
    const asA = asUser(sessionA);
    const firstPreviewResult = await asA(previewPath(), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-global-key-preview" },
      body: importForm({ csv: importCsv({ name: "Global Key HTTP Hospital A" }) }),
    });
    assertStatus(firstPreviewResult, 201, "global key first preview");
    const firstPreview = responseItem(firstPreviewResult);

    const missingDigest = await asA(batchPath(firstPreview.customerImportBatch.id, "confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-missing-digest-confirm" },
      body: JSON.stringify({ confirmed: true, previewDigest: firstPreview.previewDigest }),
    });
    assertStatus(missingDigest, 422, "customer import missing confirmation file digest");
    assert.equal(missingDigest.body?.error?.code, "CUSTOMER_IMPORT_INVALID_REQUEST");

    const crossActionPreviewKey = await asA(batchPath(firstPreview.customerImportBatch.id, "cancel"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-global-key-preview" },
      body: JSON.stringify({ reason: "operator_cancelled" }),
    });
    assertStatus(crossActionPreviewKey, 409, "preview key reused for cancel");
    assert.equal(crossActionPreviewKey.body?.error?.code, "CUSTOMER_IMPORT_IDEMPOTENCY_KEY_REUSED");

    const cancelled = await asA(batchPath(firstPreview.customerImportBatch.id, "cancel"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-global-key-cancel" },
      body: JSON.stringify({ reason: "operator_cancelled" }),
    });
    assertStatus(cancelled, 200, "global key cancel");

    const secondPreviewResult = await asA(previewPath(), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-global-key-preview-2" },
      body: importForm({ csv: importCsv({ name: "Global Key HTTP Hospital B" }) }),
    });
    assertStatus(secondPreviewResult, 201, "global key second preview");
    const secondPreview = responseItem(secondPreviewResult);

    const crossBatchAction = await asA(batchPath(secondPreview.customerImportBatch.id, "confirm"), {
      method: "POST",
      headers: { "Idempotency-Key": "customer-import-global-key-cancel" },
      body: JSON.stringify({
        confirmed: true,
        previewDigest: secondPreview.previewDigest,
        fileSha256: secondPreview.customerImportBatch.fileSha256,
      }),
    });
    assertStatus(crossBatchAction, 409, "cancel key reused for another batch confirm");
    assert.equal(crossBatchAction.body?.error?.code, "CUSTOMER_IMPORT_IDEMPOTENCY_KEY_REUSED");

    const missingCancelKey = await asA(batchPath(secondPreview.customerImportBatch.id, "cancel"), {
      method: "POST",
      body: JSON.stringify({ reason: "operator_cancelled" }),
    });
    assertStatus(missingCancelKey, 428, "customer import missing cancel idempotency key");
    assert.equal(missingCancelKey.body?.error?.code, "PRECONDITION_REQUIRED");
  });
});
