import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

import { apply } from "../src/db/migrations/0055_bookkeeping_category_reference.mjs";
import { createBookkeepingCategoryRepository } from "../src/bookkeeping/categoryRepository.js";
import { createShortcutBookkeepingRepository } from "../src/integrations/shortcutBookkeepingRepository.js";

it("adds nullable category references and backfills only unambiguous owner-scoped drafts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE bookkeeping_categories (
        id TEXT PRIMARY KEY, owner TEXT, ledger_name TEXT, entry_type TEXT,
        name TEXT, subcategories_json TEXT, version INTEGER
      );
      CREATE TABLE shortcut_bookkeeping_entries (
        id TEXT PRIMARY KEY, owner TEXT, target_system TEXT, ledger_name TEXT,
        entry_type TEXT, category TEXT, subcategory TEXT, status TEXT
      );
      INSERT INTO bookkeeping_categories VALUES
        ('a', 'owner-a', '出差报销', 'expense', '通讯费', '["电话"]', 2),
        ('b', 'owner-b', '出差报销', 'expense', '通讯费', '["流量"]', 1),
        ('duplicate-1', 'owner-a', '出差报销', 'expense', '歧义', '[]', 1),
        ('duplicate-2', 'owner-a', '出差报销', 'expense', '歧义', '[]', 1);
      INSERT INTO shortcut_bookkeeping_entries VALUES
        ('draft', 'owner-a', 'sentelligent', '出差报销', 'expense', '通讯费', '电话', 'review_required'),
        ('other-owner', 'owner-c', 'sentelligent', '出差报销', 'expense', '通讯费', '电话', 'received'),
        ('removed-subcategory', 'owner-a', 'sentelligent', '出差报销', 'expense', '通讯费', '流量', 'processing'),
        ('renamed', 'owner-a', 'sentelligent', '出差报销', 'expense', '旧分类', NULL, 'review_required'),
        ('ambiguous', 'owner-a', 'sentelligent', '出差报销', 'expense', '歧义', NULL, 'received'),
        ('accepted', 'owner-a', 'sentelligent', '出差报销', 'expense', '通讯费', '电话', 'accepted');
    `);
    apply(db);
    const row = db.prepare("SELECT * FROM shortcut_bookkeeping_entries WHERE id = 'draft'").get();
    assert.equal(row.category_id, "a");
    assert.deepEqual(JSON.parse(row.category_snapshot_json), {
      version: 1, owner: "owner-a", categoryId: "a", categoryVersion: 2,
      ledgerName: "出差报销", entryType: "expense", category: "通讯费", subcategory: "电话",
    });
    for (const id of ["other-owner", "removed-subcategory", "renamed", "ambiguous", "accepted"]) {
      const untouched = db.prepare("SELECT * FROM shortcut_bookkeeping_entries WHERE id = ?").get(id);
      assert.equal(untouched.category_id, null, id);
      assert.equal(untouched.category_snapshot_json, null, id);
    }
    assert.equal(db.prepare("SELECT category FROM shortcut_bookkeeping_entries WHERE id = 'accepted'").get().category, "通讯费");
    apply(db);
    assert.equal(db.prepare("SELECT category_snapshot_json FROM shortcut_bookkeeping_entries WHERE id = 'draft'").get().category_snapshot_json, row.category_snapshot_json);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    db.close();
  }
});

it("upgrades the complete 0054 schema without rewriting history and confirms a backfilled draft after rename", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../src/db/migrations/", import.meta.url);
    const migrations = readdirSync(directory)
      .filter((name) => /^\d{4}_.*\.(?:sql|mjs)$/u.test(name) && name.slice(0, 4) <= "0054")
      .sort();
    for (const name of migrations) {
      const url = new URL(name, directory);
      if (name.endsWith(".sql")) db.exec(readFileSync(url, "utf8"));
      else (await import(url)).apply(db);
    }
    assert.equal(db.prepare("PRAGMA table_info(shortcut_bookkeeping_entries)").all().some((column) => column.name === "category_id"), false);
    const categories = createBookkeepingCategoryRepository(db);
    const category = categories.create({ owner: "owner-a", entryType: "expense", name: "通讯费", subcategories: ["电话"] });
    db.prepare(`
      INSERT INTO shortcut_bookkeeping_entries (
        id, owner, actor, target_system, ledger_name, entry_type, category, subcategory,
        idempotency_key_hash, request_hash, raw_text, status
      ) VALUES
        ('legacy-draft', 'owner-a', 'owner-a', 'sentelligent', '出差报销', 'expense', '通讯费', '电话', $firstHash, $requestHash, '合成待确认费用', 'review_required'),
        ('history', 'owner-a', 'owner-a', 'sentelligent', '出差报销', 'income', '工资', NULL, $secondHash, $requestHash, '合成历史收入', 'accepted')
    `).run({ $firstHash: "a".repeat(64), $secondHash: "b".repeat(64), $requestHash: "c".repeat(64) });
    const before = db.prepare("SELECT * FROM shortcut_bookkeeping_entries ORDER BY id").all();
    db.exec("BEGIN IMMEDIATE");
    apply(db);
    db.exec("COMMIT");
    const after = db.prepare("SELECT * FROM shortcut_bookkeeping_entries ORDER BY id").all();
    for (let index = 0; index < before.length; index += 1) {
      for (const key of Object.keys(before[index])) assert.deepEqual(after[index][key], before[index][key], key);
    }
    assert.equal(after.find((row) => row.id === "legacy-draft").category_id, category.id);
    assert.equal(after.find((row) => row.id === "history").category_snapshot_json, null);
    categories.update(category.id, { owner: "owner-a", expectedVersion: 1, name: "办公通讯", subcategories: [] });
    const repository = createShortcutBookkeepingRepository(db, { categoryRepository: categories });
    const claimed = repository.claimReview("legacy-draft", { owner: "owner-a" });
    const result = repository.completeLocal("legacy-draft", {
      leaseToken: claimed.leaseToken,
      analysis: {
        status: "ready", confidence: 1,
        expense: { occurredOn: "2026-10-24", amountCents: 2000, purpose: "合成费用" },
        warnings: [], source: { provider: "test" },
      },
    });
    assert.equal(result.item.status, "accepted");
    assert.equal(result.item.category, "通讯费");
    assert.equal(result.item.subcategory, "电话");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    db.close();
  }
});
