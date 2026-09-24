import test from "node:test";
import assert from "node:assert/strict";
import { parseShortcutBookkeepingIntent } from "../src/integrations/shortcutBookkeepingIntent.js";

test("accepts explicit confirmation and cancellation only", () => {
  assert.equal(parseShortcutBookkeepingIntent("确认这笔").intent, "confirm");
  assert.equal(parseShortcutBookkeepingIntent("好的，确认入账").intent, "confirm");
  assert.equal(parseShortcutBookkeepingIntent("取消这笔记账").intent, "cancel");
  assert.equal(parseShortcutBookkeepingIntent("可以吗？").status, "review_required");
  assert.equal(parseShortcutBookkeepingIntent("好的").status, "review_required");
});

test("parses safe field corrections", () => {
  const result = parseShortcutBookkeepingIntent("金额改为 12.50 元");
  assert.equal(result.intent, "correction");
  assert.equal(result.changes.amountCents, 1250);
  assert.equal(parseShortcutBookkeepingIntent("确认吗").status, "review_required");
  assert.equal(parseShortcutBookkeepingIntent("修改时间为 2026-02-30T10:00:00+08:00").status, "review_required");
});

test("parses loan assignment without resolving identity", () => {
  assert.deepEqual(parseShortcutBookkeepingIntent("这笔借款归属张三").assignment, { owner: "张三" });
  assert.deepEqual(parseShortcutBookkeepingIntent("借款算我").assignment, { owner: "self" });
  assert.equal(parseShortcutBookkeepingIntent("借款分配给谁？").status, "review_required");
  const scoped = parseShortcutBookkeepingIntent("这笔借款用于本周", { now: new Date("2026-08-26T10:00:00+08:00") });
  assert.deepEqual(scoped.assignment, { scope: "week", weekStart: "2026-08-24", owner: "self" });
  assert.deepEqual(parseShortcutBookkeepingIntent("本周", { now: new Date("2026-08-26T10:00:00+08:00") }).assignment, { scope: "week", weekStart: "2026-08-24", owner: "self" });
  assert.deepEqual(parseShortcutBookkeepingIntent("用于这笔").assignment, { scope: "expense", reference: null, owner: "self" });
  assert.equal(parseShortcutBookkeepingIntent("这笔借款用于 2026-02-30 至 2026-03-08").status, "review_required");
});

test("parses explicit owner-scoped bookkeeping category commands", () => {
  assert.deepEqual(parseShortcutBookkeepingIntent("查看支出费用分类").command, { action: "list", entryType: "expense" });
  assert.deepEqual(parseShortcutBookkeepingIntent("新增费用分类：办公费，关键词：办公用品、文具采购").command, {
    action: "create",
    entryType: "expense",
    name: "办公费",
    aliases: ["办公用品", "文具采购"],
  });
  assert.deepEqual(parseShortcutBookkeepingIntent("修改分类办公费改名为通信费").command, {
    action: "rename",
    name: "办公费",
    nextName: "通信费",
  });
  assert.deepEqual(parseShortcutBookkeepingIntent("修改分类关键词：办公费，关键词：办公用品").command, {
    action: "aliases",
    name: "办公费",
    aliases: ["办公用品"],
  });
  assert.equal(parseShortcutBookkeepingIntent("删除费用分类：办公费").command.action, "archive");
  assert.equal(parseShortcutBookkeepingIntent("新增费用分类").intent, "category_management");
  assert.equal(parseShortcutBookkeepingIntent("新增费用分类").status, "review_required");
});
