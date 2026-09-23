import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createBookkeepingCategoryRepository } from "../src/bookkeeping/categoryRepository.js";
import { createShortcutBookkeepingRepository } from "../src/integrations/shortcutBookkeepingRepository.js";

const REQUEST_HASH = "a".repeat(64);

function categoryHarness() {
  const db = openDatabase({ databaseUrl: ":memory:" });
  let sequence = 0;
  const repository = createBookkeepingCategoryRepository(db, {
    idFactory: () => `category-${++sequence}`,
    clock: () => new Date("2026-09-24T08:00:00.000Z"),
  });
  return { db, repository };
}

describe("bookkeeping category dictionary", () => {
  it("seeds defaults per owner and supports owner-isolated create, update, archive, and restore", () => {
    const { db, repository } = categoryHarness();
    try {
      const defaults = repository.list({ owner: "owner-a", entryType: "expense" });
      assert.deepEqual(defaults.map((item) => item.name).sort(), ["餐饮", "住宿费", "交通", "汽车维保", "招待/礼品", "其他"].sort());
      assert.equal(repository.list({ owner: "owner-b", entryType: "expense" }).length, 6);

      const created = repository.create({
        owner: "owner-a",
        entryType: "expense",
        name: "通讯费",
        subcategories: ["电话", "流量"],
      });
      assert.equal(created.isSystem, false);
      assert.equal(created.version, 1);
      assert.deepEqual(created.subcategories, ["电话", "流量"]);
      assert.equal(repository.list({ owner: "owner-b", includeArchived: true }).some((item) => item.name === "通讯费"), false);

      const updated = repository.update(created.id, {
        owner: "owner-a",
        expectedVersion: created.version,
        name: "通信费",
        subcategories: ["电话"],
      });
      assert.equal(updated.name, "通信费");
      assert.equal(updated.version, 2);

      const archived = repository.remove(updated.id, { owner: "owner-a", expectedVersion: updated.version });
      assert.equal(archived.status, "archived");
      assert.equal(repository.list({ owner: "owner-a" }).some((item) => item.id === created.id), false);
      assert.equal(repository.list({ owner: "owner-a", includeArchived: true }).find((item) => item.id === created.id).status, "archived");
      assert.throws(
        () => repository.resolve({
          owner: "owner-a",
          ledgerName: "出差报销",
          entryType: "expense",
          category: "通信费",
          subcategory: "电话",
        }),
        (error) => error.code === "VALIDATION_ERROR" && error.fields.category === "notAllowed",
      );

      const restored = repository.update(archived.id, {
        owner: "owner-a",
        expectedVersion: archived.version,
        status: "active",
      });
      assert.equal(restored.status, "active");
      assert.equal(restored.version, 4);
      assert.throws(
        () => repository.remove(defaults[0].id, { owner: "owner-a", expectedVersion: defaults[0].version }),
        (error) => error.code === "SYSTEM_CATEGORY_READ_ONLY" && error.status === 409,
      );
      assert.throws(
        () => repository.update(restored.id, { owner: "owner-a", expectedVersion: 1, name: "冲突" }),
        (error) => error.code === "VERSION_CONFLICT" && error.fields.currentVersion === restored.version,
      );
    } finally {
      db.close();
    }
  });

  it("feeds custom categories into WeChat bookkeeping receive and review validation", () => {
    const { db, repository: categoryRepository } = categoryHarness();
    let sequence = 0;
    const bookkeepingRepository = createShortcutBookkeepingRepository(db, {
      categoryRepository,
      idFactory: () => `entry-${++sequence}`,
      clock: () => new Date("2026-09-24T08:00:00.000Z"),
    });
    try {
      const custom = categoryRepository.create({
        owner: "owner-a",
        entryType: "expense",
        name: "通讯费",
        subcategories: ["电话"],
      });
      const received = bookkeepingRepository.receive({
        owner: "owner-a",
        actor: "owner-a",
        ledgerName: "出差报销",
        entryType: "expense",
        category: custom.name,
        subcategory: "电话",
        idempotencyKey: "custom-category-entry",
        requestHash: REQUEST_HASH,
        rawText: "电话费 20 元",
      });
      assert.equal(received.item.category, "通讯费");

      const claimed = bookkeepingRepository.claim(received.item.id);
      const completed = bookkeepingRepository.completeLocal(received.item.id, {
        leaseToken: claimed.leaseToken,
        reviewPatch: { category: "通讯费", subcategory: "电话", note: "补充说明" },
        analysis: {
          status: "review_required",
          confidence: 1,
          category: "通讯费",
          subcategory: "电话",
          expense: null,
          warnings: ["manual_review"],
          source: { provider: "test" },
        },
      });
      assert.equal(completed.item.category, "通讯费");
      assert.equal(completed.item.subcategory, "电话");
      assert.equal(completed.item.status, "review_required");
    } finally {
      db.close();
    }
  });
});
