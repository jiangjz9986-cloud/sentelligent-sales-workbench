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

  it("applies only a catalog-validated category, subcategory, and note review patch", () => {
    const { db, repository } = repositoryHarness();
    try {
      const received = repository.receive({
        owner: "owner-a", actor: "owner-a", ledgerName: "出差报销", entryType: "expense",
        category: "交通", subcategory: "打车", idempotencyKey: "review-patch-fields",
        requestHash: REQUEST_HASH, note: "原始备注", rawText: "待复核差旅记录",
      });
      const claimed = repository.claim(received.item.id);
      const reviewed = repository.completeLocal(received.item.id, {
        leaseToken: claimed.leaseToken,
        reviewPatch: { category: "餐饮", subcategory: "午餐", note: "修改后的备注" },
        analysis: { status: "review_required", confidence: 0, expense: null, warnings: ["model_review"], source: { provider: "test" } },
      });
      assert.equal(reviewed.item.status, "review_required");
      assert.equal(reviewed.item.category, "餐饮");
      assert.equal(reviewed.item.subcategory, "午餐");
      assert.equal(reviewed.item.note, "修改后的备注");

      const reviewClaim = repository.claimReview(received.item.id, { owner: "owner-a" });
      const completed = repository.completeLocal(received.item.id, {
        leaseToken: reviewClaim.leaseToken,
        reviewPatch: { category: "餐饮", subcategory: "午餐", note: "最终备注" },
        analysis: {
          status: "ready", confidence: 1,
          expense: { occurredOn: "2026-08-17", amountCents: 1280, reimbursementCents: 1280, purpose: "午餐" },
          warnings: [], source: { provider: "manual" },
        },
      });
      assert.equal(completed.item.status, "accepted");
      assert.equal(completed.item.category, "餐饮");
      assert.equal(completed.item.subcategory, "午餐");
      assert.equal(completed.item.note, "最终备注");
      assert.equal(db.prepare("SELECT category, notes FROM travel_expenses").get().category, "lunch");
      assert.equal(db.prepare("SELECT notes FROM travel_expenses").get().notes, "最终备注");
    } finally {
      db.close();
    }
  });

  it("rejects unknown, identity, invalid-category, and invalid-subcategory review patches before mutation", () => {
    const { db, repository } = repositoryHarness();
    try {
      const received = repository.receive({
        owner: "owner-a", actor: "owner-a", ledgerName: "出差报销", entryType: "expense",
        category: "交通", subcategory: "打车", idempotencyKey: "review-patch-reject",
        requestHash: REQUEST_HASH, rawText: "待复核差旅记录",
      });
      const claimed = repository.claim(received.item.id);
      repository.completeLocal(received.item.id, {
        leaseToken: claimed.leaseToken,
        analysis: { status: "review_required", confidence: 0, expense: null, warnings: ["model_review"], source: { provider: "test" } },
      });
      const reviewClaim = repository.claimReview(received.item.id, { owner: "owner-a" });
      for (const reviewPatch of [
        { owner: "owner-b" },
        { paymentId: "payment-forged" },
        { category: "不存在" },
        { category: "交通", subcategory: "午餐" },
      ]) {
        assert.throws(
          () => repository.completeLocal(received.item.id, {
            leaseToken: reviewClaim.leaseToken,
            reviewPatch,
            analysis: { status: "review_required", confidence: 0, expense: null, warnings: ["still_review"], source: { provider: "test" } },
          }),
          /reviewPatch|notAllowed|not allowed|validation failed/u,
        );
        const row = db.prepare("SELECT status, category, subcategory, note FROM shortcut_bookkeeping_entries WHERE id = ?").get(received.item.id);
        assert.deepEqual({ ...row }, { status: "processing", category: "交通", subcategory: "打车", note: null });
      }
      repository.release(received.item.id, { leaseToken: reviewClaim.leaseToken, errorCode: "TEST_REVIEW_PATCH_REJECTED" });
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

});
