import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AI_RESULT_CARD_STATUS,
  normalizeAiResultCard,
} from "./aiResultCardModel.js";
import {
  aiSuggestionHistoryLabel,
  aiSuggestionHistoryIsReadOnly,
  aiSuggestionToCardResult,
  upsertAiSuggestion,
} from "./manualAiSuggestionModel.js";

function suggestion(overrides = {}) {
  return {
    id: "suggestion-1",
    version: 1,
    title: "生成客户画像补全建议",
    type: "customer_profile",
    status: "pending",
    content: "先确认预算负责人。",
    draft: "先确认预算负责人。",
    confidence: 78,
    sourceRefs: [{ id: "customer-1", title: "客户档案：日照中医医院", detail: "生成时快照" }],
    confirmationPreview: {
      target: "人工审核记录（不会自动修改客户画像）",
      changes: [{ field: "建议状态", before: "待人工确认", after: "已人工确认" }],
    },
    createdAt: "2026-09-02T01:02:00.000Z",
    ...overrides,
  };
}

describe("manual AI suggestion card adapter", () => {
  it("maps a persisted suggestion into the unified card without losing evidence or preview boundaries", () => {
    const result = aiSuggestionToCardResult(suggestion());
    const card = normalizeAiResultCard(result);
    assert.equal(card.status, AI_RESULT_CARD_STATUS.PENDING);
    assert.equal(card.suggestion, "先确认预算负责人。");
    assert.equal(card.draft, "先确认预算负责人。");
    assert.equal(card.confidence, 78);
    assert.deepEqual(card.evidence, [{
      id: "customer-1",
      label: "客户档案：日照中医医院",
      detail: "生成时快照",
    }]);
    assert.equal(card.previewTarget, "人工审核记录（不会自动修改客户画像）");
    assert.equal(card.changes[0].field, "建议状态");
  });

  it("accepts the one legacy generated status but keeps unknown and terminal states fail closed", () => {
    assert.equal(
      normalizeAiResultCard(aiSuggestionToCardResult(suggestion({ status: "generated" }))).status,
      AI_RESULT_CARD_STATUS.PENDING,
    );
    assert.equal(
      normalizeAiResultCard(aiSuggestionToCardResult(suggestion({ status: "future_status" }))).status,
      AI_RESULT_CARD_STATUS.UNSUPPORTED,
    );
    for (const status of ["confirmed", "cancelled", "failed", "expired", "conflict"]) {
      const card = normalizeAiResultCard(aiSuggestionToCardResult(suggestion({ status })));
      assert.equal(card.status, status);
      assert.equal(card.readOnly, true);
      assert.equal(card.canConfirm, false);
    }
  });

  it("labels and replaces local history snapshots without creating a model request", () => {
    assert.match(aiSuggestionHistoryLabel(suggestion()), /09-02/u);
    assert.match(aiSuggestionHistoryLabel(suggestion()), /待确认/u);
    const original = [suggestion(), suggestion({ id: "suggestion-2" })];
    const updated = upsertAiSuggestion(original, suggestion({ status: "confirmed", version: 2 }));
    assert.equal(updated.length, 2);
    assert.equal(updated[0].status, "confirmed");
    assert.equal(original[0].status, "pending");
  });

  it("restores persisted pending history as actionable and locks every terminal or unknown status", () => {
    assert.equal(aiSuggestionHistoryIsReadOnly(suggestion()), false);
    assert.equal(aiSuggestionHistoryIsReadOnly(suggestion({ status: "generated" })), false);
    for (const status of ["confirmed", "cancelled", "failed", "expired", "conflict", "future_status"]) {
      assert.equal(aiSuggestionHistoryIsReadOnly(suggestion({ status })), true, status);
    }
  });
});
