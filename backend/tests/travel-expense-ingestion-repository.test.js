import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { HttpError } from "../src/http/errors.js";
import { createTravelExpenseRepository } from "../src/travelExpense/repository.js";
import { createTravelExpenseIngestionRepository } from "../src/travelExpense/ingestionRepository.js";

let db;
let idCounter;
let repository;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function receiveInput(overrides = {}) {
  return {
    owner: "owner-a",
    actor: "icost-webhook",
    source: "icost",
    idempotencyKey: "opaque-idempotency-material-20260804",
    requestHash: sha256("canonical request body"),
    sourceId: "shortcut-run-1",
    rawText: "2026-08-04 午餐 客户招待 支付宝 128.50元",
    capturedAt: "2026-08-04T12:30:00+08:00",
    ...overrides,
  };
}

function readyAnalysis(overrides = {}) {
  return {
    status: "ready",
    confidence: 0.96,
    expense: {
      occurredOn: "2026-08-04",
      category: "hospitality",
      purpose: "客户午餐",
      merchant: "示例餐厅",
      amountCents: 12850,
      reimbursementCents: 12850,
      paidAt: "2026-08-04T12:30:00+08:00",
      fundingSource: "personal",
      paymentMethod: "alipay",
      ...(overrides.expense ?? {}),
    },
    warnings: [],
    source: {
      provider: "deepseek",
      model: "deepseek-chat",
      ...(overrides.source ?? {}),
    },
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  idCounter = 0;
  repository = createTravelExpenseIngestionRepository(db, {
    idFactory: () => `ingestion-generated-${++idCounter}`,
    clock: () => new Date("2026-08-04T05:00:00.000Z"),
  });
});

afterEach(() => db.close());

describe("travel expense ingestion repository", () => {
  it("hashes the idempotency key, replays the same request, and rejects a changed request hash", () => {
    const input = receiveInput();
    const firstResult = repository.receive(input);
    const replayResult = repository.receive(input);
    const received = firstResult.item;
    const replayed = replayResult.item;

    assert.equal(received.id, "ingestion-generated-1");
    assert.equal(received.status, "received");
    assert.equal(firstResult.replayed, false);
    assert.equal(replayed.id, received.id);
    assert.equal(replayed.status, received.status);
    assert.equal(replayResult.replayed, true);
    assert.equal(db.isTransaction, false);

    const stored = db.prepare("SELECT * FROM travel_expense_ingestions WHERE id = $id")
      .get({ $id: received.id });
    assert.equal(stored.idempotency_key_hash, sha256(input.idempotencyKey));
    assert.equal(stored.request_hash, input.requestHash);
    assert.equal(JSON.stringify(stored).includes(input.idempotencyKey), false);
    assert.equal(Object.hasOwn(received, "idempotencyKey"), false);
    assert.equal(Object.hasOwn(received, "idempotencyKeyHash"), false);
    assert.equal(Object.hasOwn(received, "requestHash"), false);
    assert.equal(Object.hasOwn(received, "rawText"), false);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM travel_expense_ingestions").get().count,
      1,
    );

    assert.throws(
      () => repository.receive(receiveInput({ requestHash: sha256("changed request body") })),
      (error) => error instanceof HttpError
        && error.status === 409
        && error.code === "IDEMPOTENCY_KEY_REUSED"
        && error.fields?.existingId === received.id,
    );

    const audits = db.prepare(`
      SELECT action, entity_id, before_json, after_json, metadata_json
      FROM audit_logs
      WHERE entity_type = 'travel_expense_ingestion'
      ORDER BY created_at, id
    `).all();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "travel_expense.ingestion.receive");
    assert.equal(audits[0].entity_id, received.id);
    assert.equal(JSON.stringify(audits).includes(input.idempotencyKey), false);
    assert.equal(JSON.stringify(audits).includes(input.rawText), false);
  });

  it("stores review-required analysis without creating a formal expense", () => {
    const received = repository.receive(receiveInput()).item;
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);

    const analysis = {
      status: "review_required",
      confidence: 0.41,
      expense: {
        occurredOn: null,
        category: "lunch",
        purpose: "待确认日期的午餐",
        merchant: null,
        amountCents: 2850,
        reimbursementCents: 2850,
      },
      warnings: ["missing_date", "low_confidence"],
      source: { provider: "rules", model: null },
    };

    const leaseToken = repository.claim(received.id).leaseToken;
    const firstResult = repository.complete(received.id, { analysis, leaseToken });
    const replayResult = repository.complete(received.id, { analysis, leaseToken });
    const completed = firstResult.item;
    const replayed = replayResult.item;

    assert.equal(completed.status, "review_required");
    assert.equal(firstResult.replayed, false);
    assert.equal(completed.expenseId, null);
    assert.equal(completed.paymentId, null);
    assert.deepEqual(completed.warnings, analysis.warnings);
    assert.equal(replayed.id, completed.id);
    assert.equal(replayed.status, "review_required");
    assert.equal(replayResult.replayed, true);
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 0);

    const stored = db.prepare(`
      SELECT status, analysis_json, warnings_json, expense_id, payment_id
      FROM travel_expense_ingestions
      WHERE id = $id
    `).get({ $id: received.id });
    assert.equal(stored.status, "review_required");
    assert.deepEqual(JSON.parse(stored.analysis_json), {
      status: analysis.status,
      confidence: analysis.confidence,
      expense: analysis.expense,
      source: analysis.source,
    });
    assert.deepEqual(JSON.parse(stored.warnings_json), analysis.warnings);
    assert.equal(stored.expense_id, null);
    assert.equal(stored.payment_id, null);
  });

  it("claims one processing lease, rejects an active competitor, and reclaims a stale lease", () => {
    let leaseNow = new Date("2026-08-04T05:00:00.000Z");
    const leaseRepository = createTravelExpenseIngestionRepository(db, {
      idFactory: () => `lease-${++idCounter}`,
      clock: () => new Date(leaseNow),
    });
    const received = leaseRepository.receive(receiveInput({ idempotencyKey: "lease-key" })).item;

    const claimed = leaseRepository.claim(received.id, { leaseMs: 60_000 });
    assert.equal(claimed.replayed, false);
    assert.equal(claimed.item.status, "processing");

    assert.throws(
      () => leaseRepository.claim(received.id, { leaseMs: 60_000 }),
      (error) => error instanceof HttpError
        && error.status === 409
        && error.code === "REQUEST_IN_PROGRESS",
    );

    leaseNow = new Date("2026-08-04T05:01:01.000Z");
    const reclaimed = leaseRepository.claim(received.id, { leaseMs: 60_000 });
    assert.equal(reclaimed.replayed, false);
    assert.equal(reclaimed.item.status, "processing");
    assert.equal(db.prepare(`
      SELECT lease_started_at FROM travel_expense_ingestions WHERE id = $id
    `).get({ $id: received.id }).lease_started_at, leaseNow.toISOString());
  });

  it("fences stale and unclaimed completions after a processing lease is reclaimed", () => {
    let leaseNow = new Date("2026-08-04T05:00:00.000Z");
    const leaseRepository = createTravelExpenseIngestionRepository(db, {
      idFactory: () => `fenced-${++idCounter}`,
      clock: () => new Date(leaseNow),
    });
    const received = leaseRepository.receive(receiveInput({ idempotencyKey: "fenced-key" })).item;
    leaseRepository.claim(received.id, { leaseMs: 60_000 });
    const firstLeaseToken = db.prepare(`
      SELECT lease_started_at FROM travel_expense_ingestions WHERE id = $id
    `).get({ $id: received.id }).lease_started_at;

    leaseNow = new Date("2026-08-04T05:01:01.000Z");
    leaseRepository.claim(received.id, { leaseMs: 60_000 });
    const secondLeaseToken = db.prepare(`
      SELECT lease_started_at FROM travel_expense_ingestions WHERE id = $id
    `).get({ $id: received.id }).lease_started_at;
    assert.notEqual(secondLeaseToken, firstLeaseToken);

    assert.throws(
      () => leaseRepository.complete(received.id, {
        analysis: readyAnalysis(),
        leaseToken: firstLeaseToken,
      }),
      (error) => error instanceof HttpError
        && error.status === 409
        && error.code === "INGESTION_LEASE_LOST",
    );

    const unclaimed = leaseRepository.receive(receiveInput({ idempotencyKey: "unclaimed-key" })).item;
    assert.throws(
      () => leaseRepository.complete(unclaimed.id, {
        analysis: readyAnalysis(),
        leaseToken: secondLeaseToken,
      }),
      (error) => error instanceof HttpError
        && error.status === 409
        && error.code === "INGESTION_LEASE_LOST",
    );

    const completed = leaseRepository.complete(received.id, {
      analysis: readyAnalysis(),
      leaseToken: secondLeaseToken,
    });
    assert.equal(completed.item.status, "accepted");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 1);
  });

  it("normalizes analysis before the short transaction and atomically accepts one expense and payment", () => {
    const received = repository.receive(receiveInput()).item;
    const publicRepository = createTravelExpenseRepository(db, { idFactory: () => "public-expense-id" });
    assert.throws(() => publicRepository.createExpense({
      owner: "owner-a",
      actor: "icost-webhook",
      occurredOn: "2026-08-04",
      category: "hospitality",
      purpose: "不应通过公共入口创建",
      payments: [{
        paidAt: "2026-08-04T12:30:00+08:00",
        amountCents: 12850,
        reimbursementCents: 12850,
        fundingSource: "personal",
      }],
    }), /owner must match actor/);

    let transactionObservedWhileReadingAnalysis = null;
    const baseAnalysis = readyAnalysis();
    const analysis = {
      ...baseAnalysis,
      get expense() {
        transactionObservedWhileReadingAnalysis = db.isTransaction;
        return baseAnalysis.expense;
      },
    };

    const leaseToken = repository.claim(received.id).leaseToken;
    const firstResult = repository.complete(received.id, { analysis, leaseToken });
    const completed = firstResult.item;

    assert.equal(transactionObservedWhileReadingAnalysis, false);
    assert.equal(db.isTransaction, false);
    assert.equal(completed.status, "accepted");
    assert.equal(firstResult.replayed, false);
    assert.equal(completed.expenseId, "ingestion-generated-2");
    assert.equal(completed.paymentId, "ingestion-generated-3");
    assert.match(completed.expenseReferenceCode, /^EXP-20260804-[A-F0-9]{8}$/);

    const expense = db.prepare("SELECT * FROM travel_expenses WHERE id = $id")
      .get({ $id: completed.expenseId });
    const payment = db.prepare("SELECT * FROM travel_expense_payments WHERE id = $id")
      .get({ $id: completed.paymentId });
    assert.equal(expense.owner, "owner-a");
    assert.equal(expense.created_by, "icost-webhook");
    assert.equal(expense.updated_by, "icost-webhook");
    assert.equal(expense.category, "hospitality");
    assert.equal(expense.purpose, "客户午餐");
    assert.match(expense.reference_code, /^EXP-20260804-[A-F0-9]{8}$/);
    assert.equal(payment.expense_id, expense.id);
    assert.equal(payment.sequence, 1);
    assert.equal(payment.amount_cents, 12850);
    assert.equal(payment.reimbursement_cents, 12850);
    assert.equal(payment.funding_source, "personal");
    assert.equal(payment.payment_method, "alipay");

    const competingRepository = createTravelExpenseIngestionRepository(db, {
      idFactory: () => {
        throw new Error("duplicate completion must not allocate another id");
      },
      clock: () => new Date("2026-08-04T06:00:00.000Z"),
    });
    const replayResult = competingRepository.complete(received.id, { analysis: readyAnalysis() });
    const replayed = replayResult.item;
    assert.equal(replayResult.replayed, true);
    assert.equal(replayed.expenseId, completed.expenseId);
    assert.equal(replayed.paymentId, completed.paymentId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 1);

    const acceptedAudits = db.prepare(`
      SELECT before_json, after_json, metadata_json
      FROM audit_logs
      WHERE action = 'travel_expense.ingestion.accept'
    `).all();
    assert.equal(acceptedAudits.length, 1);
    assert.equal(JSON.stringify(acceptedAudits).includes(receiveInput().idempotencyKey), false);
    assert.equal(JSON.stringify(acceptedAudits).includes(receiveInput().rawText), false);
    assert.deepEqual(JSON.parse(acceptedAudits[0].after_json), {
      status: "accepted",
      expenseId: completed.expenseId,
      paymentId: completed.paymentId,
      amountCents: 12850,
      reimbursementCents: 12850,
    });
  });

  it("rolls back the expense, payment, ingestion state, and audit when acceptance fails", () => {
    const received = repository.receive(receiveInput()).item;
    const leaseToken = repository.claim(received.id).leaseToken;
    db.exec(`
      CREATE TRIGGER fail_ingestion_payment
      BEFORE INSERT ON travel_expense_payments
      BEGIN
        SELECT RAISE(ABORT, 'forced payment failure');
      END
    `);

    assert.throws(
      () => repository.complete(received.id, { analysis: readyAnalysis(), leaseToken }),
      /forced payment failure/,
    );
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 0);
    assert.deepEqual(
      { ...db.prepare(`
        SELECT status, attempt_count, expense_id, payment_id
        FROM travel_expense_ingestions
        WHERE id = $id
      `).get({ $id: received.id }) },
      { status: "processing", attempt_count: 0, expense_id: null, payment_id: null },
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'travel_expense.ingestion.accept'").get().count,
      0,
    );
  });

  it("rejects non-integer money before opening a transaction", () => {
    const received = repository.receive(receiveInput()).item;
    const leaseToken = repository.claim(received.id).leaseToken;
    let transactionObservedWhileReadingAmount = null;
    const expense = readyAnalysis().expense;
    Object.defineProperty(expense, "amountCents", {
      enumerable: true,
      get() {
        transactionObservedWhileReadingAmount = db.isTransaction;
        return 128.5;
      },
    });

    assert.throws(
      () => repository.complete(received.id, {
        analysis: readyAnalysis({ expense }),
        leaseToken,
      }),
      /amountCents must be a non-negative safe integer number of cents/,
    );
    assert.equal(transactionObservedWhileReadingAmount, false);
    assert.equal(db.isTransaction, false);
    assert.equal(
      db.prepare("SELECT status FROM travel_expense_ingestions WHERE id = $id").get({ $id: received.id }).status,
      "processing",
    );
  });
});
