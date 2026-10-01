import assert from "node:assert/strict";
import test from "node:test";

import { filterBookkeepingCategories, getBookkeepingCategoryCounts } from "./bookkeepingCategoryViewModel.js";

const categories = [
  { entryType: "expense", name: "交通", status: "active", subcategories: ["打车"], aliases: ["网约车"] },
  { entryType: "expense", name: "住宿费", status: "active", subcategories: ["酒店"], aliases: [] },
  { entryType: "expense", name: "旧分类", status: "archived", subcategories: [], aliases: ["历史费用"] },
  { entryType: "income", name: "报销款", status: "active", subcategories: [], aliases: [] },
];

test("bookkeeping category filters search names, subcategories, and aliases in the selected ledger type", () => {
  assert.deepEqual(filterBookkeepingCategories(categories, { entryType: "expense", query: "住宿" }).map(({ name }) => name), ["住宿费"]);
  assert.deepEqual(filterBookkeepingCategories(categories, { entryType: "expense", query: "网约车" }).map(({ name }) => name), ["交通"]);
  assert.deepEqual(filterBookkeepingCategories(categories, { entryType: "expense", query: "酒店" }).map(({ name }) => name), ["住宿费"]);
  assert.deepEqual(filterBookkeepingCategories(categories, { entryType: "expense", query: "报销" }), []);
});

test("bookkeeping category status filters and counts include archived recovery candidates", () => {
  assert.deepEqual(filterBookkeepingCategories(categories, { entryType: "expense", status: "active" }).map(({ name }) => name), ["交通", "住宿费"]);
  assert.deepEqual(filterBookkeepingCategories(categories, { entryType: "expense", status: "archived" }).map(({ name }) => name), ["旧分类"]);
  assert.deepEqual(filterBookkeepingCategories(categories, { entryType: "expense", status: "all" }).map(({ name }) => name), ["交通", "住宿费", "旧分类"]);
  assert.deepEqual(getBookkeepingCategoryCounts(categories, "expense"), { all: 3, active: 2, archived: 1 });
});
