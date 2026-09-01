import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";
import { documentBlobId } from "../src/travelExpense/documentBlobCodec.js";
import { seedWeixinBinding } from "./helpers/weixin-binding-fixtures.js";

const OWNER_A = "invoiceownera";
const OWNER_B = "invoiceownerb";
const SENDER_A = "invoice-sender-a";
const SENDER_B = "invoice-sender-b";
const MACHINE_TOKEN = "weixin-machine-test-token";

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let nowMs;

function withDb(work) {
  const db = openDatabase({ databaseUrl });
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function seedExpense(db, {
  id,
  owner,
  occurredOn = "2026-08-25",
  reimbursementCents = 12_800,
} = {}) {
  db.prepare(`
    INSERT INTO travel_expenses (
      id, reference_code, owner, occurred_on, category, purpose, invoice_status,
      created_by, updated_by, created_at, updated_at
    ) VALUES (
      $id, $referenceCode, $owner, $occurredOn, 'lodging', '测试差旅费用', 'pending',
      $owner, $owner, $createdAt, $createdAt
    )
  `).run({
    $id: id,
    $referenceCode: `EXP-${occurredOn.replaceAll("-", "")}-${id.toUpperCase()}`,
    $owner: owner,
    $occurredOn: occurredOn,
    $createdAt: `${occurredOn}T02:00:00.000Z`,
  });
  db.prepare(`
    INSERT INTO travel_expense_payments (
      id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents,
      funding_source, payment_method, created_at, updated_at
    ) VALUES (
      $paymentId, $expenseId, 1, $paidAt, $amountCents, $reimbursementCents,
      'personal', 'card', $createdAt, $createdAt
    )
  `).run({
    $paymentId: `${id}-payment`,
    $expenseId: id,
    $paidAt: `${occurredOn}T10:00:00+08:00`,
    $amountCents: reimbursementCents,
    $reimbursementCents: reimbursementCents,
    $createdAt: `${occurredOn}T02:00:00.000Z`,
  });
}

function coverExpense(db, { id, owner, cents = 12_800 } = {}) {
  const invoiceId = `${id}-invoice`;
  const matchId = `${id}-match`;
  const content = Buffer.from("invoice-fixture", "utf8");
  const sha256 = "24e572df92e457781358c7fadb924b01bafe339c6334e75d7d5f1176cbf26143";
  const blobId = documentBlobId(owner, sha256);
  db.prepare(`
    INSERT INTO document_blobs (
      id, owner, sha256, encoding, original_size_bytes, stored_size_bytes,
      content_blob, created_at
    ) VALUES (
      $id, $owner, $sha256, 'identity', $sizeBytes, $sizeBytes,
      $content, $now
    )
  `).run({
    $id: blobId,
    $owner: owner,
    $sha256: sha256,
    $sizeBytes: content.length,
    $content: content,
    $now: new Date(nowMs).toISOString(),
  });
  db.prepare(`
    INSERT INTO invoice_documents (
      id, owner, source, file_name, media_type, size_bytes, sha256, document_blob_id,
      status, total_cents, created_by, updated_by, created_at, updated_at
    ) VALUES (
      $id, $owner, 'manual', 'invoice.png', 'image/png', $sizeBytes, $sha256, $blobId,
      'matched', $cents, $owner, $owner, $now, $now
    )
  `).run({
    $id: invoiceId,
    $owner: owner,
    $sizeBytes: content.length,
    $sha256: sha256,
    $blobId: blobId,
    $cents: cents,
    $now: new Date(nowMs).toISOString(),
  });
  db.prepare(`
    INSERT INTO invoice_matches (
      id, owner, invoice_id, expense_id, allocated_cents, match_method, state,
      confirmed_by, confirmed_at, created_by, created_at, updated_at
    ) VALUES (
      $id, $owner, $invoiceId, $expenseId, $cents, 'manual_selection', 'confirmed',
      $owner, $now, $owner, $now, $now
    )
  `).run({
    $id: matchId,
    $owner: owner,
    $invoiceId: invoiceId,
    $expenseId: id,
    $cents: cents,
    $now: new Date(nowMs).toISOString(),
  });
  db.prepare(`
    UPDATE travel_expenses
    SET invoice_status = 'covered', version = version + 1, updated_at = $now, updated_by = $owner
    WHERE id = $id AND owner = $owner
  `).run({ $id: id, $owner: owner, $now: new Date(nowMs).toISOString() });
}

function confirmNoInvoice(db, { id, owner, cents = 12_800 } = {}) {
  db.prepare(`
    INSERT INTO travel_expense_no_invoice_confirmations (
      id, owner, expense_id, payment_id, amount_snapshot_cents, reason,
      confirmed_by, confirmed_at, created_at, updated_at
    ) VALUES (
      $confirmationId, $owner, $expenseId, $paymentId, $cents, '测试明确无票',
      $owner, $now, $now, $now
    )
  `).run({
    $confirmationId: `${id}-no-invoice`,
    $owner: owner,
    $expenseId: id,
    $paymentId: `${id}-payment`,
    $cents: cents,
    $now: new Date(nowMs).toISOString(),
  });
  db.prepare(`
    UPDATE travel_expenses
    SET invoice_status = 'missing', version = version + 1, updated_at = $now, updated_by = $owner
    WHERE id = $id AND owner = $owner
  `).run({ $id: id, $owner: owner, $now: new Date(nowMs).toISOString() });
}

function outboxRows() {
  return withDb((db) => db.prepare(`
    SELECT owner, conversation_id, payload_json, status, last_error_code
    FROM weixin_confirmation_outbox
    ORDER BY created_at, id
  `).all().map((row) => ({
    ...row,
    payload: JSON.parse(row.payload_json),
  })));
}

function financialSnapshot() {
  return withDb((db) => ({
    expenses: db.prepare(`
      SELECT id, version, owner, invoice_status, updated_at, updated_by
      FROM travel_expenses ORDER BY id
    `).all(),
    payments: db.prepare(`
      SELECT id, expense_id, reimbursement_cents, updated_at
      FROM travel_expense_payments ORDER BY id
    `).all(),
    matches: db.prepare(`
      SELECT id, owner, invoice_id, expense_id, allocated_cents, state
      FROM invoice_matches ORDER BY id
    `).all(),
    noInvoice: db.prepare(`
      SELECT id, owner, expense_id, amount_snapshot_cents, revoked_at
      FROM travel_expense_no_invoice_confirmations ORDER BY id
    `).all(),
  }));
}

async function startServer(overrides = {}) {
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    authSessionSecret: Buffer.alloc(32, 41).toString("base64url"),
    weixinAgentApiToken: MACHINE_TOKEN,
    weixinAgentOwner: OWNER_A,
    weixinAllowedSenderIds: [SENDER_A, SENDER_B],
    weixinAllowGroups: false,
    weixinBookkeepingOwner: OWNER_A,
    weixinBookkeepingSenderId: SENDER_A,
    weixinBookkeepingConfirmationEnabled: true,
    assistantConfirmationSecret: Buffer.alloc(32, 42),
    hospitalTenderAutoRun: false,
    actionReminderAutoRun: false,
    dailyDigestAutoRun: false,
    invoiceEscalationSchedulerClock: () => new Date(nowMs),
    weixinConfirmationOutboxClock: () => new Date(nowMs),
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return server;
}

async function closeServer() {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = null;
  baseUrl = null;
}

async function leaseFromWorker() {
  const response = await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
    headers: {
      Authorization: `Bearer ${MACHINE_TOKEN}`,
      "X-Weixin-Worker-Id": "invoice-escalation-worker",
      "X-Weixin-Delivery-Status": "ready",
      "X-Weixin-Delivery-Scope": "weixin:multi:v1",
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function login(account, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, password }),
  });
  const body = await response.json();
  return {
    response,
    body,
    cookie: String(response.headers.get("set-cookie") ?? "").split(";", 1)[0],
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-invoice-escalation-server-"));
  databaseUrl = join(tempDir, "invoice-escalation.sqlite");
  nowMs = Date.parse("2026-08-28T01:00:00.000Z"); // Asia/Shanghai day three.
  withDb((db) => {
    seedWeixinBinding(db, { account: OWNER_A, senderId: SENDER_A, digestEnabled: true });
    seedWeixinBinding(db, { account: OWNER_B, senderId: SENDER_B, digestEnabled: true });
  });
});

afterEach(async () => {
  await closeServer();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
  databaseUrl = null;
});

describe("invoice escalation real server wiring", () => {
  it("reads real owner-scoped gaps, enqueues each owner's row once, and never changes financial state", async () => {
    withDb((db) => {
      seedExpense(db, { id: "expense-a", owner: OWNER_A });
      seedExpense(db, { id: "expense-b", owner: OWNER_B, reimbursementCents: 8_800 });
    });
    await startServer();

    assert.equal(server.invoiceEscalationGapRepository.getInvoiceGap({ owner: OWNER_A, expenseId: "expense-b" }), null);
    assert.deepEqual(
      server.invoiceEscalationGapRepository.listInvoiceGaps({ owner: OWNER_A, limit: 10 }).map((gap) => gap.expenseId),
      ["expense-a"],
    );
    const before = financialSnapshot();
    const first = await server.invoiceEscalationScheduler.runOnce();
    const repeated = await server.invoiceEscalationScheduler.runOnce();

    assert.equal(first.status, "success");
    assert.equal(first.enqueuedCount, 2);
    assert.equal(repeated.alreadyEnqueuedCount, 2);
    assert.deepEqual(outboxRows()
      .map((row) => [row.owner, row.payload.expenseId, row.payload.level])
      .toSorted((left, right) => left[0].localeCompare(right[0])), [
      [OWNER_A, "expense-a", 1],
      [OWNER_B, "expense-b", 1],
    ]);
    assert.deepEqual(financialSnapshot(), before);
    assert.equal(server.invoiceEscalationScheduler.status().running, false);
    server.invoiceEscalationScheduler.start();
    assert.equal(server.invoiceEscalationScheduler.status().running, true);
    server.invoiceEscalationScheduler.stop();
    assert.equal(server.invoiceEscalationScheduler.status().running, false);
  });

  it("uses the durable outbox across a real server restart", async () => {
    withDb((db) => seedExpense(db, { id: "expense-restart", owner: OWNER_A }));
    await startServer();
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    await closeServer();

    await startServer();
    const restarted = await server.invoiceEscalationScheduler.runOnce();
    assert.equal(restarted.alreadyEnqueuedCount, 1);
    assert.equal(outboxRows().length, 1);
  });

  it("emits only the current highest 3, 7, and 14 day level with no catch-up burst", async () => {
    withDb((db) => seedExpense(db, { id: "expense-levels", owner: OWNER_A }));
    await startServer();
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    nowMs = Date.parse("2026-09-01T01:00:00.000Z");
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    nowMs = Date.parse("2026-09-08T01:00:00.000Z");
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    nowMs = Date.parse("2026-09-20T01:00:00.000Z");
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).alreadyEnqueuedCount, 1);
    assert.deepEqual(outboxRows().map((row) => row.payload.level), [1, 2, 3]);

    await closeServer();
    withDb((db) => {
      db.prepare("DELETE FROM weixin_confirmation_outbox").run();
      db.prepare("DELETE FROM travel_expense_payments WHERE expense_id = 'expense-levels'").run();
      db.prepare("DELETE FROM travel_expenses WHERE id = 'expense-levels'").run();
      seedExpense(db, { id: "expense-offline", owner: OWNER_A });
    });
    await startServer();
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    assert.deepEqual(outboxRows().map((row) => row.payload.level), [3]);
  });

  it("anchors aging to the expense occurrence date across first enablement, partial coverage, full coverage, and reopen", async () => {
    nowMs = Date.parse("2026-09-02T01:00:00.000Z");
    withDb((db) => seedExpense(db, {
      id: "expense-old-gap",
      owner: OWNER_A,
      occurredOn: "2026-07-01",
    }));
    await startServer();

    const firstGap = server.invoiceEscalationGapRepository.getInvoiceGap({
      owner: OWNER_A,
      expenseId: "expense-old-gap",
    });
    assert.equal(firstGap.startedOn, "2026-07-01");
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    assert.deepEqual(outboxRows().map((row) => row.payload.level), [3]);

    withDb((db) => coverExpense(db, { id: "expense-old-gap", owner: OWNER_A, cents: 5_000 }));
    const partialGap = server.invoiceEscalationGapRepository.getInvoiceGap({
      owner: OWNER_A,
      expenseId: "expense-old-gap",
    });
    assert.equal(partialGap.startedOn, "2026-07-01", "partial coverage must not reset the aging clock");
    assert.equal(partialGap.missingCents, 7_800);
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);

    withDb((db) => {
      db.prepare(`
        UPDATE invoice_matches
        SET allocated_cents = 12800, version = version + 1, updated_at = $now
        WHERE expense_id = 'expense-old-gap' AND owner = $owner
      `).run({ $owner: OWNER_A, $now: new Date(nowMs).toISOString() });
      db.prepare(`
        UPDATE invoice_documents
        SET total_cents = 12800, version = version + 1, updated_at = $now
        WHERE owner = $owner
      `).run({ $owner: OWNER_A, $now: new Date(nowMs).toISOString() });
      db.prepare(`
        UPDATE travel_expenses
        SET invoice_status = 'covered', version = version + 1, updated_at = $now
        WHERE id = 'expense-old-gap' AND owner = $owner
      `).run({ $owner: OWNER_A, $now: new Date(nowMs).toISOString() });
    });
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).resolvedCount, 1);

    withDb((db) => {
      db.prepare(`
        UPDATE invoice_matches
        SET state = 'revoked', revoked_by = $owner, revoked_at = $now,
            version = version + 1, updated_at = $now
        WHERE expense_id = 'expense-old-gap' AND owner = $owner
      `).run({ $owner: OWNER_A, $now: new Date(nowMs).toISOString() });
      db.prepare(`
        UPDATE travel_expenses
        SET invoice_status = 'pending', version = version + 1, updated_at = $now
        WHERE id = 'expense-old-gap' AND owner = $owner
      `).run({ $owner: OWNER_A, $now: new Date(nowMs).toISOString() });
    });
    const reopenedGap = server.invoiceEscalationGapRepository.getInvoiceGap({
      owner: OWNER_A,
      expenseId: "expense-old-gap",
    });
    assert.equal(reopenedGap.startedOn, "2026-07-01", "revocation must restore the original aging clock, not day zero");
    assert.equal(reopenedGap.missingCents, 12_800);
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    assert.deepEqual(outboxRows().map((row) => row.payload.level), [3, 3, 3]);
  });

  it("ignores cross-owner match rows and unrelated or orphan payment rows when aggregating a gap", async () => {
    withDb((db) => {
      seedExpense(db, { id: "expense-scope-a", owner: OWNER_A, reimbursementCents: 12_800 });
      seedExpense(db, { id: "expense-scope-b", owner: OWNER_B, reimbursementCents: 99_900 });
      // Simulate a legacy-corrupt match whose envelope owner does not own the
      // target expense. The adapter's owner predicates must ignore it.
      coverExpense(db, { id: "expense-scope-a", owner: OWNER_B, cents: 12_800 });
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare(`
        INSERT INTO travel_expense_payments (
          id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents,
          funding_source, payment_method
        ) VALUES (
          'orphan-payment', 'missing-expense', 1, '2026-08-25T10:00:00+08:00',
          77700, 77700, 'personal', 'card'
        )
      `).run();
      db.exec("PRAGMA foreign_keys = ON");
    });
    await startServer();

    const gap = server.invoiceEscalationGapRepository.getInvoiceGap({
      owner: OWNER_A,
      expenseId: "expense-scope-a",
    });
    assert.equal(gap.missingCents, 12_800);
    assert.equal(gap.noInvoiceConfirmed, false);
    assert.equal(server.invoiceEscalationGapRepository.getInvoiceGap({
      owner: OWNER_B,
      expenseId: "expense-scope-a",
    }), null);
  });

  it("stops before enqueue when the real gap is fully covered or explicitly acknowledged as no-invoice", async () => {
    withDb((db) => {
      seedExpense(db, { id: "expense-covered", owner: OWNER_A });
      seedExpense(db, { id: "expense-no-invoice", owner: OWNER_A });
      coverExpense(db, { id: "expense-covered", owner: OWNER_A });
      confirmNoInvoice(db, { id: "expense-no-invoice", owner: OWNER_A });
    });
    await startServer();
    const result = await server.invoiceEscalationScheduler.runOnce();
    assert.equal(result.resolvedCount, 2);
    assert.equal(result.enqueuedCount, 0);
    assert.equal(outboxRows().length, 0);
  });

  it("rechecks the live gap before worker delivery and terminally discards a repaired queued row", async () => {
    withDb((db) => seedExpense(db, { id: "expense-stale", owner: OWNER_A }));
    await startServer();
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    withDb((db) => coverExpense(db, { id: "expense-stale", owner: OWNER_A }));

    const leased = await leaseFromWorker();
    assert.equal(leased.response.status, 204);
    assert.equal(leased.body, null);
    const [row] = outboxRows();
    assert.equal(row.status, "failed");
    assert.equal(row.last_error_code, "WEIXIN_OUTBOX_STALE");
  });

  it("rechecks a queued row and discards it after the owner explicitly confirms no-invoice", async () => {
    withDb((db) => seedExpense(db, { id: "expense-stale-no-invoice", owner: OWNER_A }));
    await startServer();
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    withDb((db) => confirmNoInvoice(db, { id: "expense-stale-no-invoice", owner: OWNER_A }));

    const leased = await leaseFromWorker();
    assert.equal(leased.response.status, 204);
    const [row] = outboxRows();
    assert.equal(row.status, "failed");
    assert.equal(row.last_error_code, "WEIXIN_OUTBOX_STALE");
  });

  it("discards a lower queued level after the live clock advances and delivers only the new highest level", async () => {
    withDb((db) => seedExpense(db, { id: "expense-level-stale", owner: OWNER_A }));
    await startServer();
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);

    nowMs = Date.parse("2026-09-01T01:00:00.000Z"); // day seven
    const staleLease = await leaseFromWorker();
    assert.equal(staleLease.response.status, 204);
    assert.deepEqual(outboxRows().map((row) => [row.payload.level, row.status, row.last_error_code]), [
      [1, "failed", "WEIXIN_OUTBOX_STALE"],
    ]);

    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    const currentLease = await leaseFromWorker();
    assert.equal(currentLease.response.status, 200);
    assert.equal(currentLease.body.item.owner, OWNER_A);
    assert.match(currentLease.body.item.message, /第 2 级/u);
    assert.match(currentLease.body.item.message, /持续 7 天/u);
  });

  it("terminally discards a queued row after its owner binding is removed", async () => {
    withDb((db) => seedExpense(db, { id: "expense-unbound", owner: OWNER_A }));
    await startServer();
    assert.equal((await server.invoiceEscalationScheduler.runOnce()).enqueuedCount, 1);
    withDb((db) => db.prepare(`
      UPDATE weixin_bindings SET status = 'disabled', version = version + 1
      WHERE account = $owner AND status = 'active'
    `).run({ $owner: OWNER_A }));

    const leased = await leaseFromWorker();
    assert.equal(leased.response.status, 204);
    const [row] = outboxRows();
    assert.equal(row.status, "failed");
    assert.equal(row.last_error_code, "WEIXIN_DELIVERY_SCOPE_MISMATCH");
  });

  it("keeps the scheduler status admin-only and rejects anonymous, machine, and member identities", async () => {
    const adminPassword = "test-admin-password";
    const memberPassword = "test-account-password";
    const [adminHash, memberHash] = await Promise.all([
      hashPassword(adminPassword, { salt: Buffer.alloc(16, 51) }),
      hashPassword(memberPassword, { salt: Buffer.alloc(16, 52) }),
    ]);
    withDb((db) => {
      db.prepare(`
        UPDATE users SET role = 'admin', password_hash = $hash WHERE account = $account
      `).run({ $hash: adminHash, $account: OWNER_A });
      db.prepare(`
        UPDATE users SET role = 'member', password_hash = $hash WHERE account = $account
      `).run({ $hash: memberHash, $account: OWNER_B });
    });
    await startServer({
      authRequired: true,
      authAccount: OWNER_A,
      authPassword: "",
      authPasswordHash: adminHash,
      authCookieSecure: false,
    });

    assert.equal((await fetch(`${baseUrl}/api/invoices/escalation/status`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/invoices/escalation/status`, {
      headers: { Authorization: `Bearer ${MACHINE_TOKEN}` },
    })).status, 403);
    const member = await login(OWNER_B, memberPassword);
    assert.equal(member.response.status, 200);
    const memberStatus = await fetch(`${baseUrl}/api/invoices/escalation/status`, {
      headers: { Cookie: member.cookie },
    });
    assert.equal(memberStatus.status, 403);
    assert.equal((await memberStatus.json()).error.code, "ADMIN_ROLE_REQUIRED");

    const admin = await login(OWNER_A, adminPassword);
    assert.equal(admin.response.status, 200);
    const adminStatus = await fetch(`${baseUrl}/api/invoices/escalation/status`, {
      headers: { Cookie: admin.cookie },
    });
    assert.equal(adminStatus.status, 200);
    assert.equal(adminStatus.headers.get("cache-control"), "no-store");
    const body = await adminStatus.json();
    assert.equal(body.item.running, false);
    assert.equal(body.item.businessTimeZone, "Asia/Shanghai");
  });

  it("starts only after an explicit opt-in and always stops the injected scheduler on close", async () => {
    let started = 0;
    let stopped = 0;
    let running = false;
    const injected = {
      start() { started += 1; running = true; },
      stop() { stopped += 1; running = false; },
      runOnce: async () => ({ status: "success" }),
      status: () => ({ running, injected: true }),
    };

    await startServer({ invoiceEscalationScheduler: injected });
    assert.equal(started, 0, "the scheduler must remain off when no explicit switch is present");
    assert.deepEqual(server.invoiceEscalationScheduler.status(), { running: false, injected: true });
    await closeServer();
    assert.equal(stopped, 1, "close must stop even a scheduler that was never auto-started");

    await startServer({ invoiceEscalationScheduler: injected, invoiceEscalationAutoRun: true });
    assert.equal(started, 1);
    assert.deepEqual(server.invoiceEscalationScheduler.status(), { running: true, injected: true });
    await closeServer();
    assert.equal(stopped, 2);
  });
});
