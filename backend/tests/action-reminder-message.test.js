import assert from "node:assert/strict";
import test from "node:test";

import { renderActionReminderMessage } from "../src/actionReminders/reminderMessage.js";

function payload(overrides = {}) {
  return {
    kind: "action_reminder",
    actionItemId: "todo-abc123",
    title: "给王工送方案",
    remindAtDisplay: "08-29（周六）09:00",
    priority: "高",
    customerName: "日照中医医院",
    reasonExcerpt: "存在竞标风险",
    idSuffix: "abc123",
    late: false,
    ...overrides,
  };
}

test("renders the full reminder card with the reply guidance", () => {
  const message = renderActionReminderMessage(payload());
  assert.equal(message, [
    "【小小提醒！待办到点】",
    "待办：给王工送方案",
    "时间：08-29（周六）09:00",
    "优先级：高",
    "客户：日照中医医院",
    "备注：存在竞标风险",
    "编号：abc123",
    "",
    "回复“完成待办 abc123”标记完成，或“待办 abc123 推迟到明天上午”。",
  ].join("\n"));
});

test("omits optional fields and marks late reminders", () => {
  const message = renderActionReminderMessage(payload({
    customerName: null,
    reasonExcerpt: null,
    priority: "",
    late: true,
  }));
  assert.match(message, /^【小小提醒！过期待办】/u);
  assert.match(message, /说明：该提醒因系统离线迟到/u);
  assert.doesNotMatch(message, /客户：/u);
  assert.doesNotMatch(message, /备注：/u);
});

test("fails closed on malformed payloads", () => {
  assert.throws(() => renderActionReminderMessage({ kind: "other" }), /invalid/u);
  assert.throws(() => renderActionReminderMessage(payload({ title: " " })), /incomplete/u);
  assert.throws(() => renderActionReminderMessage(payload({ idSuffix: "" })), /incomplete/u);
});
