import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createShortcutBookkeepingRepository } from "../src/integrations/shortcutBookkeepingRepository.js";

const REQUEST_HASH = "a".repeat(64);

function repositoryHarness() {
  const db = openDatabase({ databaseUrl: ":memory:" });
  let sequence = 0;
  const repository = createShortcutBookkeepingRepository(db, {
    idFactory: () => `generated-${++sequence}`,
    clock: () => new Date("2026-08-17T08:00:00.000Z"),
  });
  return { db, repository };
}

function receiveQingyang(repository, suffix) {
  const received = repository.receive({
    owner: "owner-a",
    actor: "actor-a",
    ledgerName: "biubiu",
    entryType: "income",
    category: "营收",
    subcategory: "美团",
    idempotencyKey: `remote-${suffix}`,
    requestHash: REQUEST_HASH,
    rawText: "synthetic bookkeeping text",
  });
  return repository.claim(received.item.id);
}

describe("Shortcut bookkeeping repository invariants", () => {
  it("rejects an internally corrupted Sentelligent income entry before accepting it", () => {
    const { db, repository } = repositoryHarness();
    try {
      const received = repository.receive({
        owner: "owner-a",
        actor: "actor-a",
        ledgerName: "出差报销",
        entryType: "expense",
        category: "交通",
        subcategory: "打车",
        idempotencyKey: "local-corruption-probe",
        requestHash: REQUEST_HASH,
        rawText: "synthetic bookkeeping text",
      });
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.prepare(`
        UPDATE shortcut_bookkeeping_entries SET entry_type = 'income' WHERE id = $id
      `).run({ $id: received.item.id });
      db.exec("PRAGMA ignore_check_constraints = OFF");
      const claimed = repository.claim(received.item.id);

      assert.throws(
        () => repository.completeLocal(received.item.id, {
          leaseToken: claimed.leaseToken,
          analysis: {
            status: "ready",
            confidence: 1,
            expense: {
              occurredOn: "2026-08-17",
              amountCents: 1280,
              reimbursementCents: 1280,
              purpose: "synthetic purpose",
            },
            warnings: [],
            source: { provider: "test" },
          },
        }),
        /only supports 出差报销 expense entries/u,
      );
      const row = db.prepare(`
        SELECT status, expense_id, payment_id FROM shortcut_bookkeeping_entries WHERE id = $id
      `).get({ $id: received.item.id });
      assert.equal(row.status, "processing");
      assert.equal(row.expense_id, null);
      assert.equal(row.payment_id, null);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 0);
    } finally {
      db.close();
    }
  });

  it("keeps failed remote results retryable instead of completing them", () => {
    const { db, repository } = repositoryHarness();
    try {
      const claimed = receiveQingyang(repository, "failed");
      assert.throws(
        () => repository.completeRemote(claimed.item.id, {
          leaseToken: claimed.leaseToken,
          remote: { id: "remote-failed", reference: "reference-failed", status: "failed" },
        }),
        /failed must be released/u,
      );
      assert.equal(repository.release(claimed.item.id, {
        leaseToken: claimed.leaseToken,
        errorCode: "QINGYANG_REMOTE_RETRYABLE_FAILURE",
      }), true);
      const retried = repository.claim(claimed.item.id);
      assert.equal(retried.item.status, "processing");
      assert.equal(retried.item.attemptCount, 1);
    } finally {
      db.close();
    }
  });

  it("provides owner-scoped review list/detail and idempotent manual reject", () => {
    const { db, repository } = repositoryHarness();
    try {
      const received = repository.receive({
        owner: "owner-a", actor: "owner-a", ledgerName: "出差报销", entryType: "expense",
        category: "交通", subcategory: "打车", idempotencyKey: "manual-review-owner-a",
        requestHash: REQUEST_HASH, rawText: "缺少金额的差旅记录",
      });
      const claimed = repository.claim(received.item.id);
      const reviewed = repository.completeLocal(received.item.id, {
        leaseToken: claimed.leaseToken,
        analysis: { status: "review_required", confidence: 0, expense: null, warnings: ["missing_amount"], source: { provider: "test" } },
      });
      assert.equal(reviewed.item.status, "review_required");
      assert.equal(repository.listReview({ owner: "owner-a" }).length, 1);
      assert.equal(repository.listReview({ owner: "owner-b" }).length, 0);
      assert.equal(repository.getReview(received.item.id, { owner: "owner-b" }), null);
      const rejected = repository.rejectReview(received.item.id, { owner: "owner-a", actor: "owner-a", reason: "无法核实金额" });
      assert.equal(rejected.item.status, "rejected");
      const replayed = repository.rejectReview(received.item.id, { owner: "owner-a", actor: "owner-a", reason: "重复点击" });
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.item.errorCode, "MANUAL_REJECTED");
    } finally {
      db.close();
    }
  });

  it("confirms a review with a lease and creates exactly one expense/payment pair", () => {
    const { db, repository } = repositoryHarness();
    try {
      const received = repository.receive({
        owner: "owner-a", actor: "owner-a", ledgerName: "出差报销", entryType: "expense",
        category: "交通", subcategory: "打车", idempotencyKey: "manual-review-confirm",
        requestHash: REQUEST_HASH, rawText: "请人工补齐金额",
      });
      const claimed = repository.claim(received.item.id);
      repository.completeLocal(received.item.id, {
        leaseToken: claimed.leaseToken,
        analysis: { status: "review_required", confidence: 0, expense: null, warnings: ["missing_amount"], source: { provider: "test" } },
      });
      const reviewClaim = repository.claimReview(received.item.id, { owner: "owner-a" });
      const completed = repository.completeLocal(received.item.id, {
        leaseToken: reviewClaim.leaseToken,
        analysis: {
          status: "ready", confidence: 1,
          expense: { occurredOn: "2026-08-17", amountCents: 1280, reimbursementCents: 1280, purpose: "人工确认打车", merchant: "示例商户" },
          warnings: [], source: { provider: "manual" },
        },
      });
      assert.equal(completed.item.status, "accepted");
      assert.ok(completed.item.expenseId);
      assert.ok(completed.item.paymentId);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 1);
      const replay = repository.claimReview(received.item.id, { owner: "owner-a" });
      assert.equal(replay.replayed, true);
      assert.equal(replay.item.expenseId, completed.item.expenseId);
    } finally {
      db.close();
    }
  });

  it("retries a review through received without allowing a rejected terminal item back in", () => {
    const { db, repository } = repositoryHarness();
    try {
      const received = repository.receive({
        owner: "owner-a", actor: "owner-a", ledgerName: "出差报销", entryType: "expense",
        category: "交通", subcategory: "打车", idempotencyKey: "manual-review-retry",
        requestHash: REQUEST_HASH, rawText: "待重试差旅记录",
      });
      const claimed = repository.claim(received.item.id);
      repository.completeLocal(received.item.id, {
        leaseToken: claimed.leaseToken,
        analysis: { status: "review_required", confidence: 0, expense: null, warnings: ["model_error"], source: { provider: "test" } },
      });
      const retried = repository.retryReview(received.item.id, { owner: "owner-a" });
      assert.equal(retried.item.status, "received");
      const retryClaim = repository.claim(received.item.id);
      repository.completeLocal(received.item.id, {
        leaseToken: retryClaim.leaseToken,
        analysis: { status: "review_required", confidence: 0, expense: null, warnings: ["still_missing"], source: { provider: "test" } },
      });
      repository.rejectReview(received.item.id, { owner: "owner-a", reason: "终态" });
      assert.throws(() => repository.retryReview(received.item.id, { owner: "owner-a" }), /cannot be retried/u);
    } finally {
      db.close();
    }
  });

  for (const terminalStatus of ["rejected", "voided"]) {
    it(`requires ${terminalStatus} remote results to use the terminal completion path`, () => {
      const { db, repository } = repositoryHarness();
      try {
        const claimed = receiveQingyang(repository, terminalStatus);
        const remote = {
          id: `remote-${terminalStatus}`,
          reference: `reference-${terminalStatus}`,
          status: terminalStatus,
        };
        assert.throws(
          () => repository.completeRemote(claimed.item.id, {
            leaseToken: claimed.leaseToken,
            remote,
          }),
          /must use completeRemoteTerminal/u,
        );
        const completed = repository.completeRemoteTerminal(claimed.item.id, {
          leaseToken: claimed.leaseToken,
          remote,
        });
        assert.equal(completed.item.status, "rejected");
        assert.equal(completed.item.remoteStatus, terminalStatus);
        assert.equal(completed.item.errorCode, "QINGYANG_REMOTE_TERMINAL");
      } finally {
        db.close();
      }
    });
  }
});
