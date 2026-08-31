export const AI_RESULT_CARD_STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  FAILED: "failed",
  HISTORY_READONLY: "history_readonly",
});

const STATUS_META = Object.freeze({
  [AI_RESULT_CARD_STATUS.PENDING]: Object.freeze({
    label: "待人工确认",
    tone: "amber",
    description: "可先修改草稿；只有点击确认后，外层业务流程才会收到确认请求。",
  }),
  [AI_RESULT_CARD_STATUS.CONFIRMED]: Object.freeze({
    label: "已确认",
    tone: "green",
    description: "这份建议已经由人工确认，当前卡片只展示确认结果。",
  }),
  [AI_RESULT_CARD_STATUS.CANCELLED]: Object.freeze({
    label: "已取消",
    tone: "gray",
    description: "这份建议已经取消，没有从卡片自动写入业务数据。",
  }),
  [AI_RESULT_CARD_STATUS.FAILED]: Object.freeze({
    label: "处理失败",
    tone: "red",
    description: "处理没有完成，请检查失败原因后由人工决定下一步。",
  }),
  [AI_RESULT_CARD_STATUS.HISTORY_READONLY]: Object.freeze({
    label: "历史记录",
    tone: "blue",
    description: "这是本地只读快照，不会重新请求模型或业务接口。",
  }),
});

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function displayText(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "—";
}

function confidenceValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.min(100, Math.max(0, number)) * 10) / 10;
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.flatMap((item, index) => {
    if (typeof item === "string") {
      const label = item.trim();
      return label ? [{ id: `evidence-${index + 1}`, label, detail: "" }] : [];
    }
    if (!item || typeof item !== "object") return [];
    const label = text(
      item.label,
      text(item.title, text(item.sourceName, text(item.source))),
    ).trim();
    if (!label) return [];
    return [{
      id: text(item.id, `evidence-${index + 1}`),
      label,
      detail: text(item.detail, text(item.snippet, text(item.quote))),
    }];
  });
}

function normalizeChanges(input) {
  const changes = Array.isArray(input)
    ? input
    : Array.isArray(input?.changes)
      ? input.changes
      : [];
  return changes.flatMap((change, index) => {
    if (!change || typeof change !== "object") return [];
    const field = text(change.field, text(change.label, text(change.name))).trim();
    if (!field) return [];
    return [{
      id: text(change.id, `change-${index + 1}`),
      field,
      before: displayText(change.before ?? change.from),
      after: displayText(change.after ?? change.to),
    }];
  });
}

export function aiResultCardStatusMeta(status) {
  return STATUS_META[status] ?? STATUS_META[AI_RESULT_CARD_STATUS.PENDING];
}

export function normalizeAiResultCard(input = {}, options = {}) {
  const source = input && typeof input === "object" ? input : {};
  const requestedStatus = options.historyReadOnly
    ? AI_RESULT_CARD_STATUS.HISTORY_READONLY
    : source.status;
  const status = STATUS_META[requestedStatus]
    ? requestedStatus
    : AI_RESULT_CARD_STATUS.PENDING;
  const suggestion = text(source.suggestion, text(source.body, text(source.content))).trim();
  const draft = text(source.draft, suggestion);
  const confidence = confidenceValue(source.confidence);
  const evidence = normalizeEvidence(source.evidence ?? source.sources);
  const previewSource = source.confirmationPreview ?? source.writebackPreview ?? source.preview;
  const changes = normalizeChanges(previewSource);
  const editable = status === AI_RESULT_CARD_STATUS.PENDING;

  return {
    id: text(source.id) || null,
    title: text(source.title, "AI 建议"),
    suggestion,
    confidence,
    confidenceLabel: `${confidence}%`,
    evidence,
    draft,
    changes,
    previewTarget: text(previewSource?.target, text(source.previewTarget)),
    status,
    statusMeta: aiResultCardStatusMeta(status),
    errorMessage: text(source.errorMessage, text(source.error)),
    editable,
    readOnly: !editable,
    canConfirm: editable && draft.trim().length > 0,
    requiresHumanConfirmation: true,
  };
}

export function updateAiResultDraft(model, nextDraft) {
  if (!model?.editable || typeof nextDraft !== "string") return model;
  return {
    ...model,
    draft: nextDraft,
    canConfirm: nextDraft.trim().length > 0,
  };
}

export function createAiResultConfirmationRequest(model) {
  if (!model?.canConfirm || model.status !== AI_RESULT_CARD_STATUS.PENDING) return null;
  return {
    action: "confirm",
    id: model.id,
    draft: model.draft,
    suggestion: model.suggestion,
    evidence: model.evidence.map(({ id, label }) => ({ id, label })),
    changes: model.changes.map((change) => ({ ...change })),
    requiresHumanConfirmation: true,
  };
}

export function createAiResultCancellationRequest(model) {
  if (model?.status !== AI_RESULT_CARD_STATUS.PENDING) return null;
  return {
    action: "cancel",
    id: model.id,
    draft: model.draft,
  };
}
