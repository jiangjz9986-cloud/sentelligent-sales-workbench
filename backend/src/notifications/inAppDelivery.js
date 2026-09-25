const CATEGORY_BY_KIND = Object.freeze({
  daily_digest: "daily_digest",
  friday_closeout: "daily_digest",
  action_reminder: "action_reminder",
  invoice_gap_escalation: "invoice_escalation",
  ops_alert: "ops_alert",
});

function notificationCopy(payload) {
  switch (payload.kind) {
    case "daily_digest":
      return { title: `工作晨报 ${payload.digestDate}`, href: "/weekly-reports", priority: 30 };
    case "friday_closeout":
      return { title: `本周工作收尾 ${payload.weekStart}`, href: "/weekly-reports", priority: 35 };
    case "action_reminder":
      return {
        title: `${payload.late === true ? "逾期待办" : "待办提醒"}：${String(payload.title ?? "").slice(0, 160)}`,
        href: "/opportunities/actions",
        priority: payload.late === true ? 70 : 50,
      };
    case "invoice_gap_escalation":
      return { title: "差旅发票缺口提醒", href: "/travel-expenses", priority: 60 };
    case "ops_alert":
      return {
        title: `${payload.severity === "critical" ? "严重告警" : "运维告警"}：${String(payload.summary ?? "").slice(0, 160)}`,
        href: "/settings/notifications",
        priority: payload.severity === "critical" ? 100 : 80,
      };
    default:
      throw new TypeError("unsupported in-app notification kind");
  }
}

export function createInAppDeliveryAdapter({ repository, renderMessage } = {}) {
  if (!repository || typeof repository.ensure !== "function" || typeof repository.getByKey !== "function") {
    throw new TypeError("in-app notification repository is required");
  }
  if (typeof renderMessage !== "function") throw new TypeError("renderMessage is required");

  function details(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.kind !== "string" || !CATEGORY_BY_KIND[payload.kind]) {
      throw new TypeError("unsupported in-app notification payload");
    }
    const copy = notificationCopy(payload);
    return {
      category: CATEGORY_BY_KIND[payload.kind],
      ...copy,
      body: renderMessage(payload),
    };
  }

  return Object.freeze({
    hasKey({ owner, idempotencyKey } = {}) {
      return Boolean(repository.getByKey({ owner, idempotencyKey }));
    },
    enqueue({ owner, idempotencyKey, payload } = {}) {
      const content = details(payload);
      const result = repository.ensure({ owner, idempotencyKey, ...content });
      return { id: result.item.id, status: "sent", replayed: result.replayed };
    },
  });
}
