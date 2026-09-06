import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeTemperatureOutcome,
  temperatureCanAct,
  temperatureErrorMessage,
  temperatureIsReadOnly,
  temperatureSuggestionToAiCard,
} from "./visitTemperatureSuggestionModel.js";
import {
  AI_RESULT_CARD_STATUS,
  normalizeAiResultCard,
} from "../../components/ai/aiResultCardModel.js";

const pending = {
  id: "s-1",
  status: "pending",
  identity: "identity",
  customerVersion: 4,
  previousValue: 40,
  suggestedValue: 46,
  requiresHumanConfirmation: true,
  writebackAllowed: false,
  facts: [{ key: "fact", value: "evidence" }],
  sourceRefs: [{ type: "quick_record", id: "visit-1" }],
};

describe("visit temperature suggestion view model", () => {
  it("only allows an explicit pending suggestion to be acted on", () => {
    assert.equal(temperatureCanAct(pending), true);
    assert.equal(temperatureCanAct({ ...pending, writebackAllowed: true }), false);
    assert.equal(temperatureCanAct({ ...pending, status: "confirmed" }), false);
    assert.equal(temperatureIsReadOnly({ ...pending, status: "confirmed" }), true);
    assert.equal(temperatureIsReadOnly({ ...pending, status: "cancelled" }), true);
    assert.equal(temperatureIsReadOnly({ ...pending, status: "expired" }), true);
  });

  it("keeps conflict and terminal outcomes read-only and server-derived", () => {
    const conflict = mergeTemperatureOutcome(pending, {
      status: "conflict",
      suggestion: { ...pending, status: "pending" },
      currentCustomer: { id: "c-1", version: 5, relation: 55 },
      writeback: false,
    });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.currentCustomer.relation, 55);
    assert.equal(temperatureIsReadOnly(conflict), true);

    const confirmed = mergeTemperatureOutcome(pending, {
      status: "confirmed",
      suggestion: { ...pending, status: "confirmed", confirmedAt: "2026-09-02T00:00:00.000Z" },
      writeback: true,
    });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.writeback, true);
    assert.equal(temperatureIsReadOnly(confirmed), true);
  });

  it("maps transport states to safe user-facing copy without server body", () => {
    assert.match(temperatureErrorMessage({ status: 401 }), /登录状态已失效/);
    assert.match(temperatureErrorMessage({ status: 409 }), /数据已变化/);
    assert.match(temperatureErrorMessage({ code: "TIMEOUT" }), /超时/);
    assert.match(temperatureErrorMessage({ status: 500 }), /暂时不可用/);
    assert.match(temperatureErrorMessage({ message: "stack trace from service" }), /失败/);
    assert.doesNotMatch(temperatureErrorMessage({ message: "stack trace from service" }), /stack trace/);
  });

  it("adapts the pinned numeric proposal to the shared AI card without making the draft editable", () => {
    const mapped = temperatureSuggestionToAiCard({
      ...pending,
      confidence: 82,
      delta: 6,
      inferences: [{ claim: "建议小幅上调" }],
    }, "测试客户");
    const card = normalizeAiResultCard(mapped, { draftMode: "readonly" });
    assert.equal(card.status, AI_RESULT_CARD_STATUS.PENDING);
    assert.equal(card.editable, false);
    assert.equal(card.readOnly, true);
    assert.equal(card.canConfirm, true);
    assert.match(card.title, /测试客户/u);
    assert.match(card.draft, /40 \/ 100.*46 \/ 100/u);
    assert.equal(card.changes[0].field, "客户温度");
    assert.ok(card.evidence.some((item) => item.label.includes("quick_record")));
  });
});
