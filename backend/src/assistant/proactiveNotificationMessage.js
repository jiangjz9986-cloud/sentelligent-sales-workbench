function bounded(value, max) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, max);
}

export function proactiveNotificationPayload(suggestion) {
  if (!suggestion || typeof suggestion !== "object") throw new TypeError("suggestion is required");
  const title = bounded(suggestion.title, 200);
  const trigger = bounded(suggestion.trigger, 100);
  if (!title || !trigger) throw new TypeError("suggestion title and trigger are required");
  // Deliberately derive the bounded summary only from the assistant's title.
  // Raw customer/quick-record/contact text and evidence never enter outbox.
  return Object.freeze({
    kind: "proactive_suggestion",
    suggestionId: bounded(suggestion.id, 500),
    title,
    trigger,
    status: bounded(suggestion.status ?? "pending", 20),
    priority: Number.isSafeInteger(suggestion.priority) ? suggestion.priority : 0,
    summary: title,
  });
}

export function renderProactiveNotificationMessage(outboxItem) {
  const payload = outboxItem?.payload;
  if (!payload || payload.kind !== "proactive_suggestion") throw new TypeError("proactive notification payload is required");
  const priority = Number(payload.priority) >= 80 ? "高" : Number(payload.priority) >= 50 ? "中" : "普通";
  return [
    "【森特智行主动建议】",
    bounded(payload.title, 200),
    `优先级：${priority}`,
    `触发：${bounded(payload.trigger, 100)}`,
    `建议编号：${bounded(payload.suggestionId, 500)}`,
    "请在森特智行中查看详情并确认后再执行。",
  ].join("\n");
}
