import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canSaveRegionProfileForWeek,
  defaultExpenseOccurredOn,
  expenseWeekLoadConflictMessage,
  expenseWeekSyncLabel,
} from "./travelExpensePageState.js";

describe("travel expense page week-scoped state", () => {
  it("distinguishes a failed initial load from an active sync", () => {
    assert.equal(expenseWeekSyncLabel({ status: "loading", loaded: false, readyLabel: "已同步" }), "正在同步");
    assert.equal(expenseWeekSyncLabel({ status: "error", loaded: false, readyLabel: "已同步" }), "同步失败");
    assert.equal(expenseWeekSyncLabel({ status: "error", loaded: true, readyLabel: "济宁、东营" }), "济宁、东营");
  });

  it("labels workbench 409 responses as read conflicts and exposes their request id", () => {
    assert.equal(
      expenseWeekLoadConflictMessage({
        status: 409,
        code: "SHORTCUT_LEDGER_RECEIPT_INCOMPLETE",
        requestId: "request-123",
      }),
      "本周账本读取冲突（HTTP 409），数据未加载，请重新加载后再试。SHORTCUT_LEDGER_RECEIPT_INCOMPLETE；请求编号：request-123",
    );
    assert.equal(expenseWeekLoadConflictMessage({ status: 500, requestId: "request-456" }), null);
  });

  it("blocks an old-week region draft before and during a new-week load", () => {
    assert.equal(canSaveRegionProfileForWeek({
      loadedWeekStart: "2026-08-17",
      selectedWeekStart: "2026-08-24",
      draftWeekStart: "2026-08-17",
    }), false);
    assert.equal(canSaveRegionProfileForWeek({
      loadedWeekStart: null,
      selectedWeekStart: "2026-08-24",
      draftWeekStart: "2026-08-24",
    }), false);
    assert.equal(canSaveRegionProfileForWeek({
      loadedWeekStart: "2026-08-24",
      selectedWeekStart: "2026-08-24",
      draftWeekStart: "2026-08-24",
    }), true);
  });

  it("uses the selected ledger day for a new manual expense within the week", () => {
    assert.equal(defaultExpenseOccurredOn({
      weekStart: "2026-09-14",
      weekEnd: "2026-09-20",
      selectedDate: "2026-09-15",
      today: new Date("2026-09-15T09:00:00+08:00"),
    }), "2026-09-15");
  });

  it("uses local today when no ledger day is selected and falls back to Monday outside the week", () => {
    assert.equal(defaultExpenseOccurredOn({
      weekStart: "2026-09-14",
      weekEnd: "2026-09-20",
      today: new Date("2026-09-16T09:00:00+08:00"),
    }), "2026-09-16");
    assert.equal(defaultExpenseOccurredOn({
      weekStart: "2026-09-14",
      weekEnd: "2026-09-20",
      today: new Date("2026-09-28T09:00:00+08:00"),
    }), "2026-09-14");
  });
});
