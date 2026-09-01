export const VISIT_TEMPERATURE_STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  CONFLICT: "conflict",
});

const TERMINAL = new Set([
  VISIT_TEMPERATURE_STATUS.CONFIRMED,
  VISIT_TEMPERATURE_STATUS.CANCELLED,
  VISIT_TEMPERATURE_STATUS.EXPIRED,
]);

export function temperatureStatusLabel(status) {
  return {
    pending: "待人工确认",
    confirmed: "已确认写回",
    cancelled: "已取消",
    expired: "已过期",
    conflict: "数据已变化",
  }[status] ?? "状态待刷新";
}

export function temperatureStatusTone(status) {
  return {
    pending: "amber",
    confirmed: "green",
    cancelled: "gray",
    expired: "gray",
    conflict: "red",
  }[status] ?? "gray";
}

export function temperatureRelation(value) {
  return Number.isSafeInteger(Number(value)) ? `${Number(value)} / 100` : "暂无";
}

export function temperatureDelta(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return "暂无变化";
  return number > 0 ? `+${number}` : String(number);
}

export function temperatureSourceLabel(ref) {
  if (!ref || typeof ref !== "object") return "已验证来源";
  return `${ref.type ?? "来源"} · ${ref.id ?? "已记录"}`;
}

export function temperatureCanAct(item) {
  return item?.status === VISIT_TEMPERATURE_STATUS.PENDING
    && item?.requiresHumanConfirmation === true
    && item?.writebackAllowed === false
    && Array.isArray(item?.facts)
    && item.facts.length > 0
    && Array.isArray(item?.sourceRefs)
    && item.sourceRefs.length > 0;
}

export function temperatureIsReadOnly(item) {
  return !temperatureCanAct(item) || TERMINAL.has(item?.status) || item?.status === VISIT_TEMPERATURE_STATUS.CONFLICT;
}

export function temperatureErrorMessage(error, action = "操作") {
  if (error?.status === 401) return "登录状态已失效，请重新登录后重试";
  if (error?.status === 409) return "数据已变化，请重新获取最新建议后再操作";
  if (error?.name === "AbortError" || error?.code === "TIMEOUT" || error?.code === "ABORT_ERR") {
    return `${action}超时，请检查连接后重试`;
  }
  if (error?.status >= 500 || error?.code === "INTERNAL_ERROR") return `${action}暂时不可用，请稍后重试`;
  return `${action}失败，请稍后重试`;
}

export function mergeTemperatureOutcome(current, outcome) {
  const suggestion = outcome?.suggestion;
  if (!suggestion) return current;
  return {
    ...suggestion,
    status: outcome.status === VISIT_TEMPERATURE_STATUS.CONFLICT
      ? VISIT_TEMPERATURE_STATUS.CONFLICT
      : outcome.status ?? suggestion.status,
    writeback: outcome.writeback === true,
    currentCustomer: outcome.currentCustomer ?? null,
  };
}
