import { weixinCard, weixinClip, weixinShortId } from "../assistant/weixinCard.js";

// Deterministic WeChat body for a queued action-reminder outbox payload.
// Fails closed on malformed payloads so the delivery worker never sends an
// empty or unbounded message (same contract as the tender notice renderer).

const MAX_MESSAGE_CHARS = 3500;

export function renderActionReminderMessage(payload) {
  if (!payload || typeof payload !== "object" || payload.kind !== "action_reminder") {
    throw new TypeError("action reminder payload is invalid");
  }
  const title = String(payload.title ?? "").trim().slice(0, 200);
  const remindAtDisplay = String(payload.remindAtDisplay ?? "").trim().slice(0, 60);
  const idSuffix = String(payload.idSuffix ?? "").trim().slice(0, 12);
  if (!title || !remindAtDisplay || !idSuffix) {
    throw new Error("action reminder payload is incomplete");
  }
  const priority = String(payload.priority ?? "").trim().slice(0, 4);
  const customerName = payload.customerName == null ? "" : String(payload.customerName).trim().slice(0, 200);
  const reasonExcerpt = payload.reasonExcerpt == null ? "" : String(payload.reasonExcerpt).trim();
  const late = payload.late === true;
  const message = weixinCard(late ? "小小提醒！过期待办" : "小小提醒！待办到点", [
    ["待办", title],
    ["时间", remindAtDisplay],
    ...(priority ? [["优先级", priority]] : []),
    ...(customerName ? [["客户", customerName]] : []),
    ...(reasonExcerpt ? [["备注", weixinClip(reasonExcerpt, 60)]] : []),
    ...(late ? [["说明", "该提醒因系统离线迟到"]] : []),
    ["编号", weixinShortId(idSuffix)],
  ], `回复“完成待办 ${idSuffix}”标记完成，或“待办 ${idSuffix} 推迟到明天上午”。`);
  if (message.length > MAX_MESSAGE_CHARS) throw new Error("action reminder content too large");
  return message;
}
