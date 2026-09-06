import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  AI_RESULT_CARD_STATUS,
  aiResultCardStatusMeta,
  createAiResultCancellationRequest,
  createAiResultConfirmationRequest,
  normalizeAiResultCard,
  updateAiResultDraft,
} from "./aiResultCardModel.js";

const componentSource = readFileSync(resolve("src/components/ai/AiResultCard.jsx"), "utf8");

function result(overrides = {}) {
  return {
    id: "advice-1",
    title: "推进建议",
    suggestion: "先确认预算，再安排方案评审。",
    confidence: 78.24,
    evidence: [
      "8 月 29 日拜访纪要",
      { id: "e-2", sourceName: "客户档案", snippet: "预算负责人尚未确认" },
    ],
    confirmationPreview: {
      target: "商机档案",
      changes: [
        { field: "下一步动作", before: "—", after: "确认预算负责人" },
      ],
    },
    status: AI_RESULT_CARD_STATUS.PENDING,
    ...overrides,
  };
}

describe("ai result card model", () => {
  it("normalizes the suggestion, confidence, evidence, editable draft, and change preview", () => {
    const model = normalizeAiResultCard(result());
    assert.equal(model.suggestion, "先确认预算，再安排方案评审。");
    assert.equal(model.confidence, 78.2);
    assert.equal(model.confidenceLabel, "78.2%");
    assert.deepEqual(model.evidence, [
      { id: "evidence-1", label: "8 月 29 日拜访纪要", detail: "" },
      { id: "e-2", label: "客户档案", detail: "预算负责人尚未确认" },
    ]);
    assert.equal(model.draft, model.suggestion);
    assert.deepEqual(model.changes, [
      { id: "change-1", field: "下一步动作", before: "—", after: "确认预算负责人" },
    ]);
    assert.equal(model.previewTarget, "商机档案");
    assert.equal(model.editable, true);
    assert.equal(model.requiresHumanConfirmation, true);
  });

  it("supports every delivery status with a stable readable label", () => {
    const expected = new Map([
      [AI_RESULT_CARD_STATUS.PENDING, "待人工确认"],
      [AI_RESULT_CARD_STATUS.CONFIRMED, "已确认"],
      [AI_RESULT_CARD_STATUS.CANCELLED, "已取消"],
      [AI_RESULT_CARD_STATUS.FAILED, "处理失败"],
      [AI_RESULT_CARD_STATUS.EXPIRED, "已过期"],
      [AI_RESULT_CARD_STATUS.CONFLICT, "状态冲突"],
      [AI_RESULT_CARD_STATUS.UNSUPPORTED, "状态异常"],
      [AI_RESULT_CARD_STATUS.HISTORY_READONLY, "历史记录"],
    ]);
    for (const [status, label] of expected) {
      assert.equal(aiResultCardStatusMeta(status).label, label);
      assert.equal(normalizeAiResultCard(result({ status })).status, status);
    }
  });

  it("edits a pending draft immutably and blocks empty confirmation", () => {
    const original = normalizeAiResultCard(result());
    const edited = updateAiResultDraft(original, "  人工调整后的建议  ");
    assert.notEqual(edited, original);
    assert.equal(original.draft, "先确认预算，再安排方案评审。");
    assert.equal(edited.draft, "  人工调整后的建议  ");
    assert.equal(edited.canConfirm, true);
    assert.equal(updateAiResultDraft(edited, " \n ").canConfirm, false);
  });

  it("creates a write request only for an explicit pending confirmation", () => {
    const pending = updateAiResultDraft(normalizeAiResultCard(result()), "人工最终草稿");
    assert.deepEqual(createAiResultConfirmationRequest(pending), {
      action: "confirm",
      id: "advice-1",
      draft: "人工最终草稿",
      suggestion: "先确认预算，再安排方案评审。",
      evidence: [
        { id: "evidence-1", label: "8 月 29 日拜访纪要" },
        { id: "e-2", label: "客户档案" },
      ],
      changes: [
        { id: "change-1", field: "下一步动作", before: "—", after: "确认预算负责人" },
      ],
      requiresHumanConfirmation: true,
    });
    assert.deepEqual(createAiResultCancellationRequest(pending), {
      action: "cancel",
      id: "advice-1",
      draft: "人工最终草稿",
    });
  });

  it("forces historical snapshots to stay local and read only", () => {
    const history = normalizeAiResultCard(result(), { historyReadOnly: true });
    assert.equal(history.status, AI_RESULT_CARD_STATUS.HISTORY_READONLY);
    assert.equal(history.editable, false);
    assert.equal(history.readOnly, true);
    assert.equal(history.canConfirm, false);
    assert.equal(updateAiResultDraft(history, "不应生效"), history);
    assert.equal(createAiResultConfirmationRequest(history), null);
    assert.equal(createAiResultCancellationRequest(history), null);
  });

  it("preserves an authoritative terminal status in a read-only history view", () => {
    for (const status of [
      AI_RESULT_CARD_STATUS.CONFIRMED,
      AI_RESULT_CARD_STATUS.CANCELLED,
      AI_RESULT_CARD_STATUS.FAILED,
      AI_RESULT_CARD_STATUS.EXPIRED,
      AI_RESULT_CARD_STATUS.CONFLICT,
    ]) {
      const history = normalizeAiResultCard(result({ status }), { historyReadOnly: true });
      assert.equal(history.status, status);
      assert.equal(history.readOnly, true);
      assert.equal(history.canConfirm, false);
      assert.equal(createAiResultConfirmationRequest(history), null);
      assert.equal(createAiResultCancellationRequest(history), null);
    }
  });

  it("keeps pending actions available when only the draft is read only", () => {
    const pending = normalizeAiResultCard(result(), { draftMode: "readonly" });
    assert.equal(pending.status, AI_RESULT_CARD_STATUS.PENDING);
    assert.equal(pending.editable, false);
    assert.equal(pending.readOnly, true);
    assert.equal(pending.canConfirm, true);
    assert.equal(updateAiResultDraft(pending, "不应改写数值快照"), pending);
    assert.deepEqual(createAiResultConfirmationRequest(pending), {
      action: "confirm",
      id: "advice-1",
      draft: "先确认预算，再安排方案评审。",
      suggestion: "先确认预算，再安排方案评审。",
      evidence: [
        { id: "evidence-1", label: "8 月 29 日拜访纪要" },
        { id: "e-2", label: "客户档案" },
      ],
      changes: [
        { id: "change-1", field: "下一步动作", before: "—", after: "确认预算负责人" },
      ],
      requiresHumanConfirmation: true,
    });
    assert.equal(createAiResultCancellationRequest(pending)?.action, "cancel");
  });

  it("keeps every terminal result non-actionable", () => {
    for (const status of [
      AI_RESULT_CARD_STATUS.CONFIRMED,
      AI_RESULT_CARD_STATUS.CANCELLED,
      AI_RESULT_CARD_STATUS.FAILED,
      AI_RESULT_CARD_STATUS.EXPIRED,
      AI_RESULT_CARD_STATUS.CONFLICT,
      AI_RESULT_CARD_STATUS.UNSUPPORTED,
    ]) {
      const model = normalizeAiResultCard(result({ status }));
      assert.equal(model.readOnly, true);
      assert.equal(model.canConfirm, false);
      assert.equal(createAiResultConfirmationRequest(model), null);
      assert.equal(createAiResultCancellationRequest(model), null);
    }
  });

  it("fails closed when a service returns a missing or unrecognized status", () => {
    for (const model of [
      normalizeAiResultCard(result({ status: undefined })),
      normalizeAiResultCard(result({ status: "future_or_misspelled_status" })),
    ]) {
      assert.equal(model.status, AI_RESULT_CARD_STATUS.UNSUPPORTED);
      assert.equal(model.statusMeta.label, "状态异常");
      assert.equal(model.editable, false);
      assert.equal(model.readOnly, true);
      assert.equal(model.canConfirm, false);
      assert.equal(createAiResultConfirmationRequest(model), null);
      assert.equal(createAiResultCancellationRequest(model), null);
    }
    assert.equal(aiResultCardStatusMeta("future_or_misspelled_status").label, "状态异常");
  });

  it("renders an empty pending model when no result is available", () => {
    for (const input of [undefined, null]) {
      const model = normalizeAiResultCard(input);
      assert.equal(model.status, AI_RESULT_CARD_STATUS.PENDING);
      assert.equal(model.suggestion, "");
      assert.equal(model.canConfirm, false);
    }
  });
});

describe("AiResultCard interaction boundary", () => {
  it("exposes all required content and states", () => {
    assert.match(componentSource, /建议正文/u);
    assert.match(componentSource, /置信度/u);
    assert.match(componentSource, /证据来源/u);
    assert.match(componentSource, /确认前可编辑草稿/u);
    assert.match(componentSource, /确认后改动预览/u);
    assert.match(componentSource, /historyReadOnly/u);
    assert.match(componentSource, /draftMode/u);
    assert.match(componentSource, /data-readonly/u);
  });

  it("calls external handlers only from explicit edit, confirm, and cancel events", () => {
    assert.match(componentSource, /onDraftChange\?\.\(nextDraft/u);
    assert.match(componentSource, /onConfirm\?\.\(request\)/u);
    assert.match(componentSource, /onCancel\?\.\(request\)/u);
    assert.match(componentSource, /onClick=\{handleConfirm\}/u);
    assert.match(componentSource, /onClick=\{handleCancel\}/u);
  });

  it("contains no model, API, transport, or business-write dependency", () => {
    assert.doesNotMatch(
      componentSource,
      /\bfetch\b|XMLHttpRequest|axios|apiClient|createSalesDecisionAnalysis|salesWorkbenchApi|\/api\//u,
    );
    assert.doesNotMatch(
      componentSource,
      /customer\.update|opportunity\.update|action_items|risk_items|writeback/u,
    );
  });
});
