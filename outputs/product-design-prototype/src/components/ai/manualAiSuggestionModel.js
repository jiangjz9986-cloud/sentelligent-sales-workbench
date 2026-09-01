import { AI_RESULT_CARD_STATUS } from "./aiResultCardModel.js";

const LEGACY_STATUS = Object.freeze({
  generated: AI_RESULT_CARD_STATUS.PENDING,
});

const HISTORY_STATUS_LABEL = Object.freeze({
  pending: "待确认",
  confirmed: "已确认",
  cancelled: "已取消",
  failed: "失败",
  expired: "已过期",
  conflict: "冲突",
});

function sourceLabel(ref, index) {
  if (typeof ref === "string") return ref;
  if (!ref || typeof ref !== "object") return `证据 ${index + 1}`;
  return ref.title ?? ref.label ?? ref.sourceName ?? ref.type ?? `证据 ${index + 1}`;
}

export function aiSuggestionToCardResult(item) {
  if (!item || typeof item !== "object") return item;
  const status = LEGACY_STATUS[item.status] ?? item.status;
  const refs = Array.isArray(item.sourceRefs) ? item.sourceRefs : [];
  return {
    id: item.id ?? null,
    title: item.title ?? "AI 建议",
    suggestion: typeof item.content === "string" ? item.content : "",
    draft: typeof item.draft === "string" ? item.draft : item.content ?? "",
    confidence: item.confidence,
    evidence: refs.map((ref, index) => ({
      id: typeof ref === "object" && ref?.id ? String(ref.id) : `source-${index + 1}`,
      label: sourceLabel(ref, index),
      detail: typeof ref === "object" && ref?.detail ? String(ref.detail) : "",
    })),
    confirmationPreview: item.confirmationPreview,
    status,
  };
}

export function aiSuggestionHistoryLabel(item) {
  const date = item?.createdAt ? new Date(item.createdAt) : null;
  const dateLabel = date && !Number.isNaN(date.getTime())
    ? `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : "时间未知";
  return `${dateLabel} · ${HISTORY_STATUS_LABEL[item?.status] ?? "状态异常"}`;
}

export function aiSuggestionHistoryIsReadOnly(item) {
  return (LEGACY_STATUS[item?.status] ?? item?.status) !== AI_RESULT_CARD_STATUS.PENDING;
}

export function upsertAiSuggestion(items, next) {
  if (!next?.id) return Array.isArray(items) ? items : [];
  return [next, ...(Array.isArray(items) ? items : []).filter((item) => item.id !== next.id)];
}
