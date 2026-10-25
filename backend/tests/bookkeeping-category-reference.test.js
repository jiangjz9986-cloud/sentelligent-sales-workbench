import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { apply } from "../src/db/migrations/0055_bookkeeping_category_reference.mjs";
import { createBookkeepingCategoryRepository } from "../src/bookkeeping/categoryRepository.js";
import { createShortcutBookkeepingRepository } from "../src/integrations/shortcutBookkeepingRepository.js";

function harness(t, { withCategories = true } = {}) {
  const db = openDatabase({ databaseUrl: ":memory:" });
  let sequence = 0;
  const options = {
    idFactory: () => `reference-${++sequence}`,
    clock: () => new Date("2026-10-24T08:00:00.000Z"),
  };
  const categories = createBookkeepingCategoryRepository(db, options);
  const repository = createShortcutBookkeepingRepository(db, {
    ...options, ...(withCategories ? { categoryRepository: categories } : {}),
  });
  t.after(() => {
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    db.close();
  });
  return { db, categories, repository };
}

function analysis(overrides = {}) {
  return {
    status: "ready", confidence: 1,
    expense: { occurredOn: "2026-10-24", amountCents: 2000, purpose: "合成费用" },
    warnings: [], source: { provider: "test" }, ...overrides,
  };
}

function receive(repository, overrides = {}) {
  return repository.receive({
    owner: "owner-a", actor: "owner-a", ledgerName: "出差报销", entryType: "expense",
    category: "通讯费", subcategory: "电话", idempotencyKey: "category-reference",
    requestHash: "a".repeat(64), rawText: "合成电话费20元", ...overrides,
  }).item;
}

function draft(repository, overrides = {}) {
  const item = receive(repository, overrides);
  const claimed = repository.claim(item.id);
  return repository.completeLocal(item.id, {
    leaseToken: claimed.leaseToken,
    analysis: analysis({ status: "review_required", warnings: ["manual_review"] }),
  }).item;
}

function confirm(repository, item, overrides = {}) {
  const claimed = repository.claimReview(item.id, { owner: item.owner });
  return repository.completeLocal(item.id, {
    leaseToken: claimed.leaseToken, analysis: analysis(), ...overrides,
  });
}

function reference(db, id) {
  const row = db.prepare("SELECT category_id, category_snapshot_json FROM shortcut_bookkeeping_entries WHERE id = ?").get(id);
  return { id: row.category_id, snapshot: JSON.parse(row.category_snapshot_json) };
}

function custom(categories, overrides = {}) {
  return categories.create({ owner: "owner-a", entryType: "expense", name: "通讯费", subcategories: ["电话", "流量"], ...overrides });
}

const invalidSelection = (error) => error.code === "VALIDATION_ERROR"
  && (error.fields.category === "notAllowed" || error.fields.subcategory === "notAllowed");

describe("stable bookkeeping draft category references", () => {
  it("confirms the original category after rename and name reuse, preserving historical text", (t) => {
    const { db, categories, repository } = harness(t);
    const category = custom(categories);
    const item = draft(repository);
    const before = reference(db, item.id);
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, name: "办公通讯" });
    const replacement = custom(categories);
    const restarted = createShortcutBookkeepingRepository(db, { categoryRepository: categories });
    const result = confirm(restarted, item, {
      reviewPatch: { category: "通讯费", subcategory: "电话", note: "仅补充备注" },
      analysis: analysis({ category: "通讯费", subcategory: "电话" }),
    });
    assert.equal(result.item.status, "accepted");
    assert.equal(result.item.category, "通讯费");
    assert.equal(result.item.subcategory, "电话");
    assert.equal(before.id, category.id);
    assert.notEqual(before.id, replacement.id);
    assert.deepEqual(reference(db, item.id), before);
    categories.update(category.id, { owner: "owner-a", expectedVersion: 2, name: "通讯历史" });
    assert.equal(repository.getReview(item.id, { owner: "owner-a" }).category, "通讯费");
    assert.equal(repository.claimReview(item.id, { owner: "owner-a" }).replayed, true);
    assert.equal(db.prepare("SELECT count(*) AS count FROM travel_expenses").get().count, 1);
  });

  it("confirms an archived selection but rejects new drafts using that archived category", (t) => {
    const { db, categories, repository } = harness(t);
    const category = custom(categories);
    const item = draft(repository);
    categories.remove(category.id, { owner: "owner-a", expectedVersion: 1 });
    assert.equal(confirm(repository, item).item.status, "accepted");
    assert.equal(reference(db, item.id).id, category.id);
    assert.throws(() => receive(repository, { idempotencyKey: "new-archived" }), invalidSelection);
  });

  it("keeps a removed subcategory for confirmation and note-only edits", (t) => {
    const { db, categories, repository } = harness(t);
    const category = custom(categories);
    const item = draft(repository);
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, subcategories: ["流量"] });
    const result = confirm(repository, item, { reviewPatch: { note: "原始电话费用" } });
    assert.equal(result.item.status, "accepted");
    assert.equal(result.item.subcategory, "电话");
    assert.equal(reference(db, item.id).snapshot.subcategory, "电话");
    assert.throws(() => receive(repository, { idempotencyKey: "new-removed" }), invalidSelection);
  });

  it("captures system category IDs and retains removed default subcategories", (t) => {
    const { db, categories, repository } = harness(t);
    const category = categories.list({ owner: "owner-a", entryType: "expense" }).find((item) => item.name === "餐饮");
    const item = draft(repository, { category: "餐饮", subcategory: "早餐" });
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, subcategories: ["午餐", "晚餐"] });
    assert.equal(confirm(repository, item).item.status, "accepted");
    assert.equal(reference(db, item.id).id, category.id);
    assert.equal(db.prepare("SELECT category FROM travel_expenses").get().category, "breakfast");
  });

  it("captures the selection before analysis so rename does not block creating a draft", (t) => {
    const { db, categories, repository } = harness(t);
    const category = custom(categories);
    const item = receive(repository);
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, name: "办公通讯", subcategories: [] });
    const claimed = repository.claim(item.id);
    const reviewed = repository.completeLocal(item.id, {
      leaseToken: claimed.leaseToken, analysis: analysis({ status: "review_required" }),
    }).item;
    assert.equal(reference(db, item.id).id, category.id);
    assert.equal(confirm(repository, reviewed).item.status, "accepted");
  });

  it("validates deliberate category/subcategory changes against the active dictionary and rolls back failures", (t) => {
    const { db, categories, repository } = harness(t);
    const category = custom(categories);
    const archived = custom(categories, { name: "旧业务", subcategories: [] });
    categories.remove(archived.id, { owner: "owner-a", expectedVersion: 1 });
    const item = draft(repository);
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, subcategories: [] });
    const claimed = repository.claimReview(item.id, { owner: "owner-a" });
    const before = reference(db, item.id);
    for (const patch of [
      { category: "旧业务", subcategory: null },
      { category: "通讯费", subcategory: "流量" },
      { category: "其他", subcategory: "电话" },
    ]) {
      assert.throws(() => repository.completeLocal(item.id, {
        leaseToken: claimed.leaseToken, reviewPatch: patch, analysis: analysis(),
      }), invalidSelection);
      assert.deepEqual(reference(db, item.id), before);
      assert.equal(db.prepare("SELECT count(*) AS count FROM travel_expenses").get().count, 0);
    }
    const completed = repository.completeLocal(item.id, {
      leaseToken: claimed.leaseToken,
      reviewPatch: { category: "通讯费", subcategory: null }, analysis: analysis(),
    });
    assert.equal(completed.item.status, "accepted");
    assert.equal(completed.item.subcategory, null);
    assert.equal(reference(db, item.id).snapshot.subcategory, null);
    assert.equal(reference(db, item.id).snapshot.categoryVersion, 2);
  });

  it("does not let a subcategory correction reuse a snapshot from an archived category", (t) => {
    const { categories, repository } = harness(t);
    const category = custom(categories);
    const item = draft(repository);
    categories.remove(category.id, { owner: "owner-a", expectedVersion: 1 });
    const claimed = repository.claimReview(item.id, { owner: "owner-a" });
    assert.throws(() => repository.completeLocal(item.id, {
      leaseToken: claimed.leaseToken, reviewPatch: { subcategory: "流量" }, analysis: analysis(),
    }), invalidSelection);
    assert.throws(() => repository.completeLocal(item.id, {
      leaseToken: claimed.leaseToken, analysis: analysis({ subcategory: "流量" }),
    }), invalidSelection);
  });

  it("updates the stable reference when analysis selects a different current category", (t) => {
    const { db, categories, repository } = harness(t);
    custom(categories);
    const corrected = custom(categories, { name: "办公网络", subcategories: ["宽带"] });
    const item = draft(repository);
    const result = confirm(repository, item, { analysis: analysis({ category: "办公网络", subcategory: "宽带" }) });
    assert.equal(result.item.category, "办公网络");
    assert.equal(result.item.subcategory, "宽带");
    assert.equal(reference(db, item.id).id, corrected.id);
    assert.equal(reference(db, item.id).snapshot.category, "办公网络");
  });

  it("captures a newly analyzed custom selection before later dictionary edits", (t) => {
    const { db, categories, repository } = harness(t);
    const category = custom(categories);
    const item = receive(repository, { category: "其他", subcategory: null });
    const claimed = repository.claim(item.id);
    const reviewed = repository.completeLocal(item.id, {
      leaseToken: claimed.leaseToken,
      analysis: analysis({ status: "review_required", category: "通讯费", subcategory: "电话" }),
    }).item;
    assert.equal(reviewed.category, "通讯费");
    assert.equal(reference(db, item.id).id, category.id);
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, name: "办公通讯", subcategories: [] });
    assert.equal(confirm(repository, reviewed).item.status, "accepted");
    assert.equal(reference(db, item.id).snapshot.category, "通讯费");
  });

  it("retains renamed income categories and supports the nullable implicit income catch-all", (t) => {
    const { db, categories, repository } = harness(t);
    const category = custom(categories, { entryType: "income", name: "项目收入", subcategories: [] });
    const item = draft(repository, { entryType: "income", category: "项目收入", subcategory: null });
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, name: "项目回款", status: "archived" });
    const completed = confirm(repository, item);
    assert.equal(completed.item.status, "accepted");
    assert.equal(completed.item.category, "项目收入");
    assert.equal(reference(db, item.id).id, category.id);
    const catchAll = draft(repository, {
      entryType: "income", category: "其他", subcategory: "无", idempotencyKey: "income-catch-all",
    });
    assert.equal(confirm(repository, catchAll).item.status, "accepted");
    assert.equal(reference(db, catchAll.id).id, null);
    assert.equal(reference(db, catchAll.id).snapshot.entryType, "income");
    assert.equal(reference(db, catchAll.id).snapshot.subcategory, null);
    assert.equal(db.prepare("SELECT count(*) AS count FROM travel_expenses").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM travel_expense_payments").get().count, 0);
  });

  it("keeps an explicit classification correction when the submitted analysis still has the old selection", (t) => {
    const { db, categories, repository } = harness(t);
    custom(categories);
    const corrected = custom(categories, { name: "办公网络", subcategories: [] });
    const item = draft(repository);
    const result = confirm(repository, item, {
      reviewPatch: { category: "办公网络", subcategory: null },
      analysis: analysis({ category: "通讯费", subcategory: "电话" }),
    });
    assert.equal(result.item.category, "办公网络");
    assert.equal(result.item.subcategory, null);
    assert.equal(result.item.analysis.category, "办公网络");
    assert.equal(reference(db, item.id).id, corrected.id);
  });

  it("can explicitly clear a subcategory in analysis while the dictionary validates the new selection", (t) => {
    const { db, categories, repository } = harness(t);
    custom(categories);
    const item = draft(repository);
    const result = confirm(repository, item, { analysis: analysis({ subcategory: null }) });
    assert.equal(result.item.subcategory, null);
    assert.equal(reference(db, item.id).snapshot.subcategory, null);
  });

  it("backfills a legacy draft before rename and requires correction when its original name is already lost", (t) => {
    const { db, categories, repository } = harness(t);
    const category = custom(categories);
    const first = draft(repository);
    const second = draft(repository, { idempotencyKey: "legacy-unresolved" });
    db.exec("UPDATE shortcut_bookkeeping_entries SET category_id = NULL, category_snapshot_json = NULL");
    apply(db);
    assert.equal(reference(db, first.id).id, category.id);
    db.prepare("UPDATE shortcut_bookkeeping_entries SET category_id = NULL, category_snapshot_json = NULL WHERE id = ?").run(second.id);
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, name: "办公通讯" });
    assert.equal(confirm(repository, first).item.status, "accepted");
    apply(db);
    assert.equal(reference(db, second.id).id, null);
    const claimed = repository.claimReview(second.id, { owner: "owner-a" });
    assert.throws(() => repository.completeLocal(second.id, {
      leaseToken: claimed.leaseToken, analysis: analysis(),
    }), invalidSelection);
    const corrected = repository.completeLocal(second.id, {
      leaseToken: claimed.leaseToken, analysis: analysis(),
      reviewPatch: { category: "办公通讯", subcategory: "电话" },
    });
    assert.equal(corrected.item.status, "accepted");
    assert.equal(reference(db, second.id).id, category.id);
  });

  it("replays an identical receive request after rename without resolving its old name again", (t) => {
    const { db, categories, repository } = harness(t);
    const category = custom(categories);
    const item = receive(repository);
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, name: "办公通讯" });
    assert.equal(receive(repository).id, item.id);
    assert.equal(db.prepare("SELECT count(*) AS count FROM shortcut_bookkeeping_entries").get().count, 1);
    assert.equal(reference(db, item.id).id, category.id);
  });

  it("cannot resolve another owner's category or trust another owner's stored reference", (t) => {
    const { db, categories, repository } = harness(t);
    const category = custom(categories);
    custom(categories, { owner: "owner-b", name: "仅B可用", subcategories: [] });
    assert.throws(() => receive(repository, { category: "仅B可用", subcategory: null }), invalidSelection);
    const first = draft(repository);
    const secondCategory = custom(categories, { owner: "owner-b" });
    const second = draft(repository, { owner: "owner-b", actor: "owner-b" });
    assert.notEqual(reference(db, first.id).id, reference(db, second.id).id);
    assert.equal(reference(db, second.id).id, secondCategory.id);
    assert.equal(repository.getReview(first.id, { owner: "owner-b" }), null);
    assert.throws(() => repository.claimReview(first.id, { owner: "owner-b" }), (error) => error.status === 404);
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, name: "办公通讯" });
    assert.equal(confirm(repository, second).item.status, "accepted");
    const stolen = db.prepare("SELECT category_id, category_snapshot_json FROM shortcut_bookkeeping_entries WHERE id = ?").get(second.id);
    db.prepare("UPDATE shortcut_bookkeeping_entries SET category_id = ?, category_snapshot_json = ? WHERE id = ?")
      .run(stolen.category_id, stolen.category_snapshot_json, first.id);
    const claimed = repository.claimReview(first.id, { owner: "owner-a" });
    const attempt = () => repository.completeLocal(first.id, { leaseToken: claimed.leaseToken, analysis: analysis() });
    assert.throws(attempt, invalidSelection);
    const forgedSnapshot = { ...JSON.parse(stolen.category_snapshot_json), owner: "owner-a" };
    db.prepare("UPDATE shortcut_bookkeeping_entries SET category_snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify(forgedSnapshot), first.id);
    assert.throws(attempt, invalidSelection);
  });

  it("continues to support the static catalog without an injected category repository", (t) => {
    const { db, repository } = harness(t, { withCategories: false });
    const item = draft(repository, { category: "交通", subcategory: "打车" });
    assert.equal(confirm(repository, item).item.status, "accepted");
    assert.equal(reference(db, item.id).snapshot.category, "交通");
    assert.equal(reference(db, item.id).id, null);
  });
});
