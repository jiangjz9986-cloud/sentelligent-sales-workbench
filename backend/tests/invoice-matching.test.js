import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import {
  InvoiceMatchConflictError,
  InvoiceNotFoundError,
  InvoiceVersionConflictError,
  createInvoiceRepository,
} from "../src/travelExpense/invoiceRepository.js";
import { createTravelExpenseRepository } from "../src/travelExpense/repository.js";
import { minimalPdf } from "./helpers/image-fixtures.js";

let db;
let invoiceRepository;
let expenseRepository;
let invoiceIdCounter;
let expenseIdCounter;
let matchIdCounter;
let confirmationIdCounter;
let candidateIdCounter;
let now;

function pdf(label) {
  return minimalPdf(label);
}

function payment(overrides = {}) {
  return {
    paidAt: "2026-08-04T12:30:00+08:00",
    merchant: "示例商户",
    amountCents: 10000,
    reimbursementCents: 10000,
    fundingSource: "personal",
    paymentMethod: "alipay",
    differenceReason: "",
    ...overrides,
  };
}

function paymentInputFrom(item, overrides = {}) {
  return payment({
    id: item.id,
    paidAt: item.paidAt,
    merchant: item.merchant,
    amountCents: item.amountCents,
    reimbursementCents: item.reimbursementCents,
    fundingSource: item.fundingSource,
    paymentMethod: item.paymentMethod,
    accountLast4: item.accountLast4 ?? "",
    differenceReason: item.differenceReason ?? "",
    ...overrides,
  });
}

function createExpense(overrides = {}) {
  return expenseRepository.createExpense({
    owner: "owner-a",
    actor: "owner-a",
    occurredOn: "2026-08-04",
    category: "lodging",
    purpose: "济宁出差住宿",
    merchant: "示例酒店",
    notes: "",
    payments: [payment()],
    ...overrides,
  });
}

function invoiceRecognition(overrides = {}) {
  return {
    status: "unmatched",
    extractedText: "电子发票",
    ocr: null,
    model: null,
    conflicts: [],
    fields: {
      invoiceCode: null,
      invoiceNumber: null,
      issuedOn: "2026-08-04",
      sellerName: "示例酒店",
      buyerName: "森特公司",
      amountExTaxCents: 9434,
      taxCents: 566,
      totalCents: 10000,
      suggestedCategory: "lodging",
      ...overrides,
    },
    warnings: [],
  };
}

function createInvoice(label, overrides = {}) {
  return invoiceRepository.createInvoice({
    owner: "owner-a",
    actor: "owner-a",
    source: "manual",
    fileName: `${label}.pdf`,
    mediaType: "application/pdf",
    content: pdf(label),
    recognition: invoiceRecognition(overrides),
  });
}

function confirmMatch(input) {
  const invoice = invoiceRepository.getInvoice(input.invoiceId, { owner: input.owner });
  assert.ok(invoice, "invoice must exist before confirming a match");
  return invoiceRepository.createConfirmedMatch({
    ...input,
    expectedInvoiceVersion: invoice.version,
  });
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  invoiceIdCounter = 0;
  expenseIdCounter = 0;
  matchIdCounter = 0;
  confirmationIdCounter = 0;
  candidateIdCounter = 0;
  now = "2026-08-04T10:00:00.000Z";
  invoiceRepository = createInvoiceRepository(db, {
    idFactory: () => `invoice-${++invoiceIdCounter}`,
    matchIdFactory: () => `match-${++matchIdCounter}`,
    confirmationIdFactory: () => `no-invoice-${++confirmationIdCounter}`,
    candidateIdFactory: () => `candidate-${++candidateIdCounter}`,
    clock: () => new Date(now),
  });
  expenseRepository = createTravelExpenseRepository(db, {
    idFactory: () => `expense-${++expenseIdCounter}`,
    clock: () => new Date(now),
  });
});

afterEach(() => db.close());

describe("invoice matching and weekly coverage", () => {
  it("rejects removing a payment referenced by invoice workflow evidence", () => {
    const expense = createExpense({
      payments: [
        payment({ amountCents: 1000, reimbursementCents: 1000 }),
        payment({ paidAt: "2026-08-04T13:30:00+08:00" }),
      ],
    });
    const matchedInvoice = createInvoice("payment-dependency-match", {
      amountExTaxCents: 2830,
      taxCents: 170,
      totalCents: 3000,
    });
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: matchedInvoice.id,
      expenseReferenceCode: expense.referenceCode,
      paymentId: expense.payments[1].id,
      allocatedCents: 3000,
      matchMethod: "manual_selection",
    });
    invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: expense.id,
      paymentId: expense.payments[1].id,
      reason: "剩余金额暂未取得发票",
    });
    createInvoice("payment-dependency-candidate", {
      amountExTaxCents: 6604,
      taxCents: 396,
      totalCents: 7000,
    });
    const candidates = invoiceRepository.generateMatchCandidates({
      owner: "owner-a",
      actor: "owner-a",
      weekStart: "2026-08-03",
    });
    assert.equal(candidates.length, 1);

    db.prepare(`
      INSERT INTO travel_expense_ingestions (
        id, owner, actor, source, idempotency_key_hash, request_hash,
        source_id, raw_text, captured_at, status, expense_id, payment_id
      ) VALUES (
        'ingestion-payment-dependency', 'owner-a', 'owner-a', 'manual',
        $idempotencyHash, $requestHash, 'manual-payment-dependency', 'fixture',
        '2026-08-04T10:00:00.000Z', 'accepted', $expenseId, $paymentId
      )
    `).run({
      $idempotencyHash: "1".repeat(64),
      $requestHash: "2".repeat(64),
      $expenseId: expense.id,
      $paymentId: expense.payments[1].id,
    });
    const document = db.prepare(`
      SELECT size_bytes, sha256, document_blob_id
      FROM invoice_documents
      WHERE id = $id
    `).get({ $id: matchedInvoice.id });
    db.prepare(`
      INSERT INTO travel_expense_document_inbox (
        id, owner, actor, source, source_message_id, document_kind,
        file_name, media_type, size_bytes, sha256, document_blob_id,
        status, matched_expense_id, matched_payment_id
      ) VALUES (
        'inbox-payment-dependency', 'owner-a', 'owner-a', 'manual',
        'message-payment-dependency', 'payment_proof', 'proof.pdf',
        'application/pdf', $sizeBytes, $sha256, $documentBlobId,
        'matched', $expenseId, $paymentId
      )
    `).run({
      $sizeBytes: document.size_bytes,
      $sha256: document.sha256,
      $documentBlobId: document.document_blob_id,
      $expenseId: expense.id,
      $paymentId: expense.payments[1].id,
    });

    const current = expenseRepository.getExpense(expense.id, { owner: "owner-a" });
    assert.throws(
      () => expenseRepository.updateExpense(expense.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: current.version,
        occurredOn: current.occurredOn,
        category: current.category,
        purpose: current.purpose,
        merchant: current.merchant,
        notes: current.notes,
        payments: [paymentInputFrom(current.payments[0])],
      }),
      (error) => error?.code === "PAYMENT_HAS_DEPENDENCIES",
    );

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments WHERE expense_id = $id").get({ $id: expense.id }).count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_matches WHERE expense_id = $id").get({ $id: expense.id }).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_no_invoice_confirmations WHERE expense_id = $id").get({ $id: expense.id }).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_match_candidates WHERE expense_id = $id").get({ $id: expense.id }).count, 1);
    assert.equal(db.prepare("SELECT payment_id FROM travel_expense_ingestions WHERE id = 'ingestion-payment-dependency'").get().payment_id, expense.payments[1].id);
    assert.equal(db.prepare("SELECT matched_payment_id FROM travel_expense_document_inbox WHERE id = 'inbox-payment-dependency'").get().matched_payment_id, expense.payments[1].id);
  });

  it("rejects reducing reimbursement below confirmed invoice coverage", () => {
    const expense = createExpense();
    const invoice = createInvoice("payment-allocation", {
      amountExTaxCents: 7547,
      taxCents: 453,
      totalCents: 8000,
    });
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: invoice.id,
      expenseReferenceCode: expense.referenceCode,
      paymentId: expense.payments[0].id,
      allocatedCents: 8000,
      matchMethod: "manual_selection",
    });
    const current = expenseRepository.getExpense(expense.id, { owner: "owner-a" });

    assert.throws(
      () => expenseRepository.updateExpense(expense.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: current.version,
        occurredOn: current.occurredOn,
        category: current.category,
        purpose: current.purpose,
        merchant: current.merchant,
        notes: current.notes,
        payments: [paymentInputFrom(current.payments[0], {
          reimbursementCents: 7000,
          differenceReason: "部分金额不报销",
        })],
      }),
      (error) => error?.code === "REIMBURSEMENT_BELOW_CONFIRMED_COVERAGE",
    );
    assert.equal(expenseRepository.getExpense(expense.id, { owner: "owner-a" }).reimbursementCents, 10000);
  });

  it("recomputes expense invoice status after reimbursement increases", () => {
    const expense = createExpense();
    const invoice = createInvoice("payment-status-refresh");
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: invoice.id,
      expenseReferenceCode: expense.referenceCode,
      paymentId: expense.payments[0].id,
      allocatedCents: 10000,
      matchMethod: "manual_selection",
    });
    const current = expenseRepository.getExpense(expense.id, { owner: "owner-a" });
    assert.equal(current.invoiceStatus, "covered");

    const updated = expenseRepository.updateExpense(expense.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: current.version,
      occurredOn: current.occurredOn,
      category: current.category,
      purpose: current.purpose,
      merchant: current.merchant,
      notes: current.notes,
      payments: [paymentInputFrom(current.payments[0], {
        amountCents: 20000,
        reimbursementCents: 20000,
      })],
    });

    assert.equal(updated.invoiceStatus, "partial");
    assert.deepEqual(invoiceRepository.getWeekInvoiceCoverage({
      owner: "owner-a",
      weekStart: "2026-08-03",
    }), {
      weekStart: "2026-08-03",
      reimbursementCents: 20000,
      confirmedCoverageCents: 10000,
      electronicInvoiceCoverageCents: 10000,
      substituteInvoiceCoverageCents: 0,
      missingInvoiceCents: 10000,
      noInvoiceConfirmedCents: 0,
      unacknowledgedMissingCents: 10000,
      invoiceWarehouseAvailableCents: 0,
      expenseCount: 1,
    });
  });

  it("rejects soft-deleting an expense with active invoice coverage", () => {
    const expense = createExpense();
    const invoice = createInvoice("expense-delete-active-match");
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: invoice.id,
      expenseReferenceCode: expense.referenceCode,
      paymentId: expense.payments[0].id,
      allocatedCents: 10000,
      matchMethod: "manual_selection",
    });
    const current = expenseRepository.getExpense(expense.id, { owner: "owner-a" });

    assert.throws(
      () => expenseRepository.softDeleteExpense(expense.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: current.version,
      }),
      (error) => error?.code === "EXPENSE_HAS_ACTIVE_INVOICE_STATE",
    );
    assert.ok(expenseRepository.getExpense(expense.id, { owner: "owner-a" }));
  });

  it("separates electronic and substitute coverage and reports unused warehouse value", () => {
    const expense = createExpense({
      purpose: "电子票与替票混合住宿",
      payments: [payment({ amountCents: 10000, reimbursementCents: 10000 })],
    });
    const electronic = createInvoice("coverage-electronic", { totalCents: 3000 });
    const substitute = createInvoice("coverage-substitute", { totalCents: 2000 });
    createInvoice("coverage-warehouse", { totalCents: 8000 });

    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: electronic.id,
      expenseReferenceCode: expense.referenceCode,
      paymentId: expense.payments[0].id,
      allocatedCents: 3000,
      matchMethod: "manual_selection",
    });
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: substitute.id,
      expenseReferenceCode: expense.referenceCode,
      paymentId: expense.payments[0].id,
      allocatedCents: 2000,
      matchMethod: "rule_candidate",
    });

    assert.deepEqual(invoiceRepository.getWeekInvoiceCoverage({
      owner: "owner-a",
      weekStart: "2026-08-03",
    }), {
      weekStart: "2026-08-03",
      reimbursementCents: 10000,
      confirmedCoverageCents: 5000,
      electronicInvoiceCoverageCents: 3000,
      substituteInvoiceCoverageCents: 2000,
      missingInvoiceCents: 5000,
      noInvoiceConfirmedCents: 0,
      unacknowledgedMissingCents: 5000,
      invoiceWarehouseAvailableCents: 8000,
      expenseCount: 1,
    });
  });

  it("rejects review and deletion of an invoice with confirmed matches", () => {
    const expense = createExpense();
    const invoice = createInvoice("invoice-active-match-mutation");
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: invoice.id,
      expenseReferenceCode: expense.referenceCode,
      paymentId: expense.payments[0].id,
      allocatedCents: 10000,
      matchMethod: "manual_selection",
    });
    const current = invoiceRepository.getInvoice(invoice.id, { owner: "owner-a" });

    assert.throws(
      () => invoiceRepository.finalizeReview(invoice.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: current.version,
        fields: {
          invoiceCode: current.invoiceCode,
          invoiceNumber: current.invoiceNumber,
          issuedOn: current.issuedOn,
          sellerName: current.sellerName,
          buyerName: current.buyerName,
          amountExTaxCents: 4717,
          taxCents: 283,
          totalCents: 5000,
          suggestedCategory: current.suggestedCategory,
        },
      }),
      (error) => error?.code === "INVOICE_HAS_ACTIVE_MATCHES",
    );
    assert.throws(
      () => invoiceRepository.softDeleteInvoice(invoice.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: current.version,
      }),
      (error) => error?.code === "INVOICE_HAS_ACTIVE_MATCHES",
    );
    assert.equal(invoiceRepository.getInvoice(invoice.id, { owner: "owner-a" }).status, "matched");
  });

  it("restores an unmatched deleted invoice when the same original file is uploaded again", () => {
    const invoice = createInvoice("invoice-restore-after-delete");
    const deleted = invoiceRepository.softDeleteInvoice(invoice.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: invoice.version,
    });
    assert.ok(deleted.deletedAt);

    now = "2026-08-04T11:00:00.000Z";
    const restored = createInvoice("invoice-restore-after-delete", {
      amountExTaxCents: 11321,
      taxCents: 679,
      totalCents: 12000,
    });

    assert.equal(restored.id, invoice.id);
    assert.equal(restored.version, deleted.version + 1);
    assert.equal(restored.deletedAt, undefined);
    assert.equal(restored.status, "unmatched");
    assert.equal(restored.totalCents, 12000);
    assert.equal(invoiceRepository.listInvoices({ owner: "owner-a" }).length, 1);
  });

  it("excludes deleted invoices and expenses from active coverage and match lists", () => {
    const expense = createExpense();
    const invoice = createInvoice("deleted-coverage-defense");
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: invoice.id,
      expenseReferenceCode: expense.referenceCode,
      paymentId: expense.payments[0].id,
      allocatedCents: 10000,
      matchMethod: "manual_selection",
    });
    db.prepare(`
      UPDATE invoice_documents
      SET status = 'rejected', deleted_at = '2026-08-04T11:00:00.000Z', deleted_by = 'owner-a'
      WHERE id = $id
    `).run({ $id: invoice.id });

    assert.equal(invoiceRepository.listMatches({ owner: "owner-a" }).length, 0);
    assert.equal(
      invoiceRepository.getWeekInvoiceCoverage({ owner: "owner-a", weekStart: "2026-08-03" }).confirmedCoverageCents,
      0,
    );
  });

  it("matches by stable expense code and enforces invoice and expense remaining amounts", () => {
    const expense = createExpense();
    const invoice = createInvoice("hotel-80", { amountExTaxCents: 7547, taxCents: 453, totalCents: 8000 });

    const match = confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: invoice.id,
      expenseReferenceCode: expense.referenceCode,
      paymentId: expense.payments[0].id,
      allocatedCents: 8000,
      matchMethod: "manual_code",
    });

    assert.equal(match.state, "confirmed");
    assert.equal(match.expenseId, expense.id);
    assert.equal(match.paymentId, expense.payments[0].id);
    assert.equal(match.allocatedCents, 8000);
    assert.equal(invoiceRepository.getInvoice(invoice.id, { owner: "owner-a" }).status, "matched");
    assert.equal(expenseRepository.getExpense(expense.id, { owner: "owner-a" }).invoiceStatus, "partial");

    assert.throws(
      () => confirmMatch({
        owner: "owner-a",
        actor: "owner-a",
        invoiceId: invoice.id,
        expenseReferenceCode: expense.referenceCode,
        paymentId: expense.payments[0].id,
        allocatedCents: 1,
        matchMethod: "manual_code",
      }),
      InvoiceMatchConflictError,
    );

    const secondInvoice = createInvoice("hotel-50", { amountExTaxCents: 4717, taxCents: 283, totalCents: 5000 });
    assert.throws(
      () => confirmMatch({
        owner: "owner-a",
        actor: "owner-a",
        invoiceId: secondInvoice.id,
        expenseReferenceCode: expense.referenceCode,
        paymentId: expense.payments[0].id,
        allocatedCents: 3000,
        matchMethod: "manual_code",
      }),
      (error) => error instanceof InvoiceMatchConflictError && error.code === "EXPENSE_COVERAGE_EXCEEDED",
    );
    assert.throws(
      () => confirmMatch({
        owner: "owner-a",
        actor: "owner-a",
        invoiceId: secondInvoice.id,
        expenseReferenceCode: "EXP-20990101-NOTFOUND",
        allocatedCents: 1000,
        matchMethod: "manual_code",
      }),
      InvoiceNotFoundError,
    );
  });

  it("confirms and revokes no-invoice status while weekly missing amount remains financial", () => {
    const firstExpense = createExpense();
    const secondExpense = createExpense({
      occurredOn: "2026-08-05",
      category: "transport",
      purpose: "济宁出差交通",
      payments: [payment({ paidAt: "2026-08-05T08:30:00+08:00", amountCents: 5000, reimbursementCents: 5000 })],
    });
    const partialInvoice = createInvoice("partial-30", {
      issuedOn: "2026-08-04",
      amountExTaxCents: 2830,
      taxCents: 170,
      totalCents: 3000,
    });
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: partialInvoice.id,
      expenseReferenceCode: firstExpense.referenceCode,
      allocatedCents: 3000,
      matchMethod: "manual_code",
    });

    const confirmation = invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: secondExpense.id,
      paymentId: secondExpense.payments[0].id,
      reason: "出租车未提供发票",
    });
    assert.equal(confirmation.amountSnapshotCents, 5000);
    assert.equal(confirmation.revokedAt, null);

    const summary = invoiceRepository.getWeekInvoiceCoverage({ owner: "owner-a", weekStart: "2026-08-03" });
    assert.deepEqual(summary, {
      weekStart: "2026-08-03",
      reimbursementCents: 15000,
      confirmedCoverageCents: 3000,
      electronicInvoiceCoverageCents: 3000,
      substituteInvoiceCoverageCents: 0,
      missingInvoiceCents: 12000,
      noInvoiceConfirmedCents: 5000,
      unacknowledgedMissingCents: 7000,
      invoiceWarehouseAvailableCents: 0,
      expenseCount: 2,
    });

    const revoked = invoiceRepository.revokeNoInvoice(confirmation.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
    });
    assert.equal(revoked.version, 2);
    assert.equal(revoked.revokedBy, "owner-a");
    assert.equal(invoiceRepository.getWeekInvoiceCoverage({ owner: "owner-a", weekStart: "2026-08-03" }).noInvoiceConfirmedCents, 0);
  });

  it("rejects overlapping expense-wide and payment-specific no-invoice confirmations", () => {
    const paymentScopedExpense = createExpense({
      payments: [
        payment({ amountCents: 6000, reimbursementCents: 6000 }),
        payment({ paidAt: "2026-08-04T19:00:00+08:00", amountCents: 4000, reimbursementCents: 4000 }),
      ],
    });
    invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: paymentScopedExpense.id,
      paymentId: paymentScopedExpense.payments[0].id,
      reason: "第一笔付款无票",
    });
    assert.throws(
      () => invoiceRepository.confirmNoInvoice({
        owner: "owner-a",
        actor: "owner-a",
        expenseId: paymentScopedExpense.id,
        reason: "整笔费用无票",
      }),
      (error) => error instanceof InvoiceMatchConflictError
        && error.code === "NO_INVOICE_SCOPE_OVERLAP",
    );

    const expenseScopedExpense = createExpense({
      occurredOn: "2026-08-05",
      payments: [payment({ paidAt: "2026-08-05T18:00:00+08:00" })],
    });
    invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: expenseScopedExpense.id,
      reason: "整笔费用无票",
    });
    assert.throws(
      () => invoiceRepository.confirmNoInvoice({
        owner: "owner-a",
        actor: "owner-a",
        expenseId: expenseScopedExpense.id,
        paymentId: expenseScopedExpense.payments[0].id,
        reason: "付款行无票",
      }),
      (error) => error instanceof InvoiceMatchConflictError
        && error.code === "NO_INVOICE_SCOPE_OVERLAP",
    );
  });

  it("caps generated candidates at the expense remainder across payment confirmations", () => {
    const expense = createExpense({
      payments: [
        payment({ amountCents: 6000, reimbursementCents: 6000 }),
        payment({ paidAt: "2026-08-04T19:00:00+08:00", amountCents: 4000, reimbursementCents: 4000 }),
      ],
    });
    const partialInvoice = createInvoice("candidate-existing-coverage", {
      amountExTaxCents: 2830,
      taxCents: 170,
      totalCents: 3000,
    });
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: partialInvoice.id,
      expenseReferenceCode: expense.referenceCode,
      allocatedCents: 3000,
      matchMethod: "manual_selection",
    });
    for (const item of expense.payments) {
      invoiceRepository.confirmNoInvoice({
        owner: "owner-a",
        actor: "owner-a",
        expenseId: expense.id,
        paymentId: item.id,
        reason: "付款行缺少发票",
      });
    }
    createInvoice("candidate-payment-60", {
      amountExTaxCents: 5660,
      taxCents: 340,
      totalCents: 6000,
    });
    createInvoice("candidate-payment-40", {
      amountExTaxCents: 3774,
      taxCents: 226,
      totalCents: 4000,
    });

    const candidates = invoiceRepository.generateMatchCandidates({
      owner: "owner-a",
      actor: "owner-a",
      weekStart: "2026-08-03",
    });
    assert.equal(
      candidates.reduce((sum, candidate) => sum + candidate.proposedCents, 0),
      7000,
    );
  });

  it("blocks invoice edits while an active rule candidate exists", () => {
    const expense = createExpense();
    invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: expense.id,
      paymentId: expense.payments[0].id,
      reason: "等待候选发票",
    });
    const invoice = createInvoice("candidate-edit-guard");
    const [candidate] = invoiceRepository.generateMatchCandidates({
      owner: "owner-a",
      actor: "owner-a",
      weekStart: "2026-08-03",
    });
    assert.equal(candidate.invoiceId, invoice.id);

    assert.throws(
      () => invoiceRepository.finalizeReview(invoice.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: 1,
        fields: {
          issuedOn: "2026-01-01",
          suggestedCategory: "transport",
        },
      }),
      (error) => error instanceof InvoiceMatchConflictError
        && error.code === "INVOICE_HAS_ACTIVE_CANDIDATES",
    );
  });

  it("revalidates rule candidates against current invoice facts before acceptance", () => {
    const expense = createExpense();
    invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: expense.id,
      paymentId: expense.payments[0].id,
      reason: "等待候选发票",
    });
    const invoice = createInvoice("candidate-revalidate");
    const [candidate] = invoiceRepository.generateMatchCandidates({
      owner: "owner-a",
      actor: "owner-a",
      weekStart: "2026-08-03",
    });
    assert.equal(candidate.invoiceId, invoice.id);
    db.prepare(`
      UPDATE invoice_documents
      SET issued_on = '2026-01-01', suggested_category = 'transport', version = version + 1
      WHERE id = $id
    `).run({ $id: invoice.id });

    assert.throws(
      () => invoiceRepository.acceptMatchCandidate(candidate.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: candidate.version,
      }),
      (error) => error instanceof InvoiceMatchConflictError
        && error.code === "CANDIDATE_STALE",
    );
    assert.equal(invoiceRepository.listMatches({ owner: "owner-a" }).length, 0);
  });

  it("generates date- and category-compatible suggestions without confirming or overfilling", () => {
    const expense = createExpense();
    invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: expense.id,
      paymentId: expense.payments[0].id,
      reason: "酒店未及时开票",
    });
    const suitableLarge = createInvoice("suitable-80", {
      issuedOn: "2026-08-05",
      amountExTaxCents: 7547,
      taxCents: 453,
      totalCents: 8000,
      suggestedCategory: "lodging",
    });
    const suitableSmall = createInvoice("suitable-50", {
      issuedOn: "2026-08-06",
      amountExTaxCents: 4717,
      taxCents: 283,
      totalCents: 5000,
      suggestedCategory: "lodging",
    });
    createInvoice("wrong-category", {
      issuedOn: "2026-08-04",
      totalCents: 10000,
      suggestedCategory: "transport",
    });
    createInvoice("far-date", {
      issuedOn: "2026-05-01",
      totalCents: 10000,
      suggestedCategory: "lodging",
    });
    const occupied = createInvoice("occupied", {
      issuedOn: "2026-08-04",
      totalCents: 1000,
      suggestedCategory: "lodging",
    });
    const otherExpense = createExpense({
      occurredOn: "2026-08-06",
      purpose: "其他住宿",
      payments: [payment({ paidAt: "2026-08-06T18:00:00+08:00", amountCents: 1000, reimbursementCents: 1000 })],
    });
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: occupied.id,
      expenseReferenceCode: otherExpense.referenceCode,
      allocatedCents: 1000,
      matchMethod: "manual_selection",
    });

    const candidates = invoiceRepository.generateMatchCandidates({
      owner: "owner-a",
      actor: "owner-a",
      weekStart: "2026-08-03",
    });

    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((item) => item.invoiceId), [suitableLarge.id, suitableSmall.id]);
    assert.deepEqual(candidates.map((item) => item.proposedCents), [8000, 2000]);
    assert.ok(candidates.every((item) => item.status === "suggested"));
    assert.ok(candidates.every((item) => item.score >= 1 && item.score <= 100));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_matches WHERE state = 'confirmed'").get().count, 1);
    assert.equal(invoiceRepository.getInvoice(suitableLarge.id, { owner: "owner-a" }).status, "unmatched");
    assert.equal(invoiceRepository.getInvoice(suitableSmall.id, { owner: "owner-a" }).status, "unmatched");
  });

  it("lists matches, no-invoice confirmations, and candidates with week and entity filters", () => {
    const firstExpense = createExpense();
    const secondExpense = createExpense({
      occurredOn: "2026-08-11",
      purpose: "次周住宿",
      payments: [payment({ paidAt: "2026-08-11T18:00:00+08:00" })],
    });
    const firstInvoice = createInvoice("first-week-invoice");
    const secondInvoice = createInvoice("second-week-invoice", { issuedOn: "2026-08-11" });
    const firstMatch = confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: firstInvoice.id,
      expenseReferenceCode: firstExpense.referenceCode,
      allocatedCents: 10000,
      matchMethod: "manual_selection",
    });
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: secondInvoice.id,
      expenseReferenceCode: secondExpense.referenceCode,
      allocatedCents: 10000,
      matchMethod: "manual_selection",
    });

    const noInvoiceExpense = createExpense({
      occurredOn: "2026-08-06",
      purpose: "无票住宿",
      payments: [payment({ paidAt: "2026-08-06T18:00:00+08:00" })],
    });
    const confirmation = invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: noInvoiceExpense.id,
      paymentId: noInvoiceExpense.payments[0].id,
      reason: "酒店未提供发票",
    });
    const candidateInvoice = createInvoice("candidate-filter", { issuedOn: "2026-08-06" });
    const [candidate] = invoiceRepository.generateMatchCandidates({
      owner: "owner-a",
      actor: "owner-a",
      weekStart: "2026-08-03",
    });

    assert.deepEqual(invoiceRepository.listMatches({
      owner: "owner-a",
      weekStart: "2026-08-03",
      invoiceId: firstInvoice.id,
      expenseId: firstExpense.id,
    }).map((item) => item.id), [firstMatch.id]);
    assert.deepEqual(invoiceRepository.listNoInvoiceConfirmations({
      owner: "owner-a",
      weekStart: "2026-08-03",
      expenseId: noInvoiceExpense.id,
    }).map((item) => item.id), [confirmation.id]);
    assert.deepEqual(invoiceRepository.listMatchCandidates({
      owner: "owner-a",
      weekStart: "2026-08-03",
      invoiceId: candidateInvoice.id,
      expenseId: noInvoiceExpense.id,
    }).map((item) => item.id), [candidate.id]);
  });

  it("accepts or rejects a suggested candidate with optimistic versioning", () => {
    const acceptedExpense = createExpense();
    invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: acceptedExpense.id,
      paymentId: acceptedExpense.payments[0].id,
      reason: "待仓库候选覆盖",
    });
    const acceptedInvoice = createInvoice("candidate-accept");
    const [acceptedCandidate] = invoiceRepository.generateMatchCandidates({
      owner: "owner-a",
      actor: "owner-a",
      weekStart: "2026-08-03",
    });

    const accepted = invoiceRepository.acceptMatchCandidate(acceptedCandidate.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
    });
    assert.equal(accepted.candidate.status, "accepted");
    assert.equal(accepted.candidate.version, 2);
    assert.equal(accepted.candidate.acceptedMatchId, accepted.match.id);
    assert.equal(accepted.match.state, "confirmed");
    assert.equal(accepted.match.invoiceId, acceptedInvoice.id);
    assert.equal(invoiceRepository.getInvoice(acceptedInvoice.id, { owner: "owner-a" }).status, "matched");
    assert.throws(
      () => invoiceRepository.acceptMatchCandidate(acceptedCandidate.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: 1,
      }),
      InvoiceVersionConflictError,
    );

    const rejectedExpense = createExpense({
      occurredOn: "2026-08-05",
      purpose: "拒绝候选住宿",
      payments: [payment({ paidAt: "2026-08-05T18:00:00+08:00" })],
    });
    invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: rejectedExpense.id,
      paymentId: rejectedExpense.payments[0].id,
      reason: "等待其他发票",
    });
    createInvoice("candidate-reject", { issuedOn: "2026-08-05" });
    const rejectedCandidate = invoiceRepository.generateMatchCandidates({
      owner: "owner-a",
      actor: "owner-a",
      weekStart: "2026-08-03",
    }).find((item) => item.expenseId === rejectedExpense.id);

    const rejected = invoiceRepository.rejectMatchCandidate(rejectedCandidate.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.version, 2);
    assert.equal(rejected.acceptedMatchId, null);
  });

  it("suggests only the remaining invoice amount and reserves active suggestions across weeks", () => {
    const alreadyCoveredExpense = createExpense({
      purpose: "部分使用发票的原账单",
      payments: [payment({ amountCents: 3000, reimbursementCents: 3000 })],
    });
    const partialInvoice = createInvoice("partial-remainder", {
      amountExTaxCents: 9434,
      taxCents: 566,
      totalCents: 10000,
    });
    confirmMatch({
      owner: "owner-a",
      actor: "owner-a",
      invoiceId: partialInvoice.id,
      expenseReferenceCode: alreadyCoveredExpense.referenceCode,
      allocatedCents: 3000,
      matchMethod: "manual_selection",
    });

    const firstWeekExpense = createExpense({
      occurredOn: "2026-08-06",
      purpose: "第一周缺票住宿",
      payments: [payment({
        paidAt: "2026-08-06T18:00:00+08:00",
        amountCents: 7000,
        reimbursementCents: 7000,
      })],
    });
    invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: firstWeekExpense.id,
      paymentId: firstWeekExpense.payments[0].id,
      reason: "第一周缺票",
    });

    const firstWeek = invoiceRepository.generateMatchCandidates({
      owner: "owner-a",
      actor: "owner-a",
      weekStart: "2026-08-03",
    });
    assert.deepEqual(firstWeek.map((item) => [item.invoiceId, item.proposedCents]), [[partialInvoice.id, 7000]]);

    const secondWeekExpense = createExpense({
      occurredOn: "2026-08-11",
      purpose: "第二周缺票住宿",
      payments: [payment({
        paidAt: "2026-08-11T18:00:00+08:00",
        amountCents: 7000,
        reimbursementCents: 7000,
      })],
    });
    invoiceRepository.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: secondWeekExpense.id,
      paymentId: secondWeekExpense.payments[0].id,
      reason: "第二周缺票",
    });
    const secondWeek = invoiceRepository.generateMatchCandidates({
      owner: "owner-a",
      actor: "owner-a",
      weekStart: "2026-08-10",
    });
    assert.equal(secondWeek.some((item) => item.invoiceId === partialInvoice.id), false);
  });
});
