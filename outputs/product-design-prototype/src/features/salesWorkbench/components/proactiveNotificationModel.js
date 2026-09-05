export const PROACTIVE_NOTIFICATION_STATUS_META = Object.freeze({
  queued: Object.freeze({ label: "待发送", tone: "amber", description: "通知已进入发送队列，仍为未读。" }),
  processing: Object.freeze({ label: "发送中", tone: "blue", description: "外部通道正在发送，仍为未读。" }),
  sent: Object.freeze({ label: "已送达", tone: "green", description: "通知已送达，等待人工阅读。" }),
  failed: Object.freeze({ label: "发送失败", tone: "red", description: "外部发送失败，站内通知仍保留且未读。" }),
  read: Object.freeze({ label: "已读", tone: "gray", description: "用户已经明确标记为已读。" }),
});

const CHANNEL_LABELS = Object.freeze({
  in_app: "站内",
  weixin: "微信",
  pushplus: "PushPlus",
});

export function normalizeProactiveNotificationStatus(notification) {
  const status = notification?.status;
  return Object.hasOwn(PROACTIVE_NOTIFICATION_STATUS_META, status) ? status : "failed";
}

export function proactiveNotificationIsUnread(notification) {
  return normalizeProactiveNotificationStatus(notification) !== "read" && !notification?.readAt;
}

export function proactiveNotificationStatusMeta(notification) {
  const status = normalizeProactiveNotificationStatus(notification);
  return {
    ...PROACTIVE_NOTIFICATION_STATUS_META[status],
    status,
    channelLabel: CHANNEL_LABELS[notification?.channel] ?? "站内",
    unread: proactiveNotificationIsUnread(notification),
  };
}

export function proactiveNotificationCounts(items = []) {
  const result = { total: 0, unread: 0, queued: 0, processing: 0, sent: 0, failed: 0, read: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    const status = normalizeProactiveNotificationStatus(item);
    result.total += 1;
    result[status] += 1;
    if (proactiveNotificationIsUnread(item)) result.unread += 1;
  }
  return result;
}

function revision(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function latestNotificationForSuggestion(items, suggestion) {
  const suggestionId = typeof suggestion?.id === "string" ? suggestion.id : "";
  if (!suggestionId) return null;
  const suggestionVersion = revision(suggestion?.version ?? suggestion?.lifecycleVersion);
  const matches = (Array.isArray(items) ? items : [])
    .filter((item) => item?.suggestionId === suggestionId)
    .sort((left, right) => (
      revision(right?.suggestionVersion) - revision(left?.suggestionVersion)
      || timestamp(right?.updatedAt) - timestamp(left?.updatedAt)
      || String(right?.id ?? "").localeCompare(String(left?.id ?? ""))
    ));
  if (matches.length === 0) return null;
  const exact = matches.find((item) => revision(item?.suggestionVersion) === suggestionVersion);
  const item = exact ?? matches[0];
  return {
    item,
    currentRevision: suggestionVersion > 0 && revision(item?.suggestionVersion) === suggestionVersion,
  };
}

export function replaceProactiveNotification(items, replacement) {
  if (!replacement?.id) return Array.isArray(items) ? items : [];
  let found = false;
  const next = (Array.isArray(items) ? items : []).map((item) => {
    if (item?.id !== replacement.id) return item;
    found = true;
    return replacement;
  });
  return found ? next : [replacement, ...next];
}
