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

function temperatureEvidenceDetail(value) {
  if (value === null || value === undefined || value === "") return "已记录";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  return "已记录";
}

export function temperatureSuggestionToAiCard(item, customerName = "") {
  const facts = Array.isArray(item?.facts) ? item.facts.slice(0, 5) : [];
  const inferences = Array.isArray(item?.inferences) ? item.inferences.slice(0, 3) : [];
  const refs = Array.isArray(item?.sourceRefs) ? item.sourceRefs.slice(0, 5) : [];
  const before = temperatureRelation(item?.previousValue);
  const after = temperatureRelation(item?.suggestedValue);
  const delta = temperatureDelta(item?.delta);
  const inferenceLines = inferences
    .map((inference) => String(inference?.claim ?? "").trim())
    .filter(Boolean)
    .map((claim) => `推断：${claim}`);

  return {
    id: item?.id ?? null,
    title: `${String(customerName || item?.customerId || "当前客户").trim()} · 拜访温度建议`,
    status: item?.status,
    suggestion: [
      `建议将客户温度从 ${before} 调整为 ${after}（变化 ${delta}）。`,
      ...inferenceLines,
    ].join("\n"),
    // The temperature proposal is a pinned numeric snapshot. The shared card
    // displays this text but receives draftMode="readonly" from the panel.
    draft: `客户温度 ${before} → ${after}（${delta}）`,
    confidence: item?.confidence,
    evidence: [
      ...facts.map((fact, index) => ({
        id: `fact-${String(fact?.key ?? index)}`,
        label: String(fact?.label ?? fact?.key ?? `事实 ${index + 1}`),
        detail: temperatureEvidenceDetail(fact?.value),
      })),
      ...refs.map((ref, index) => ({
        id: `source-${String(ref?.type ?? "source")}-${String(ref?.id ?? index)}`,
        label: temperatureSourceLabel(ref),
        detail: "拜访温度建议的持久化来源引用",
      })),
    ],
    confirmationPreview: {
      target: "客户档案中的温度值",
      changes: [{
        id: "customer-relation",
        field: "客户温度",
        before,
        after,
      }],
    },
    errorMessage: item?.status === VISIT_TEMPERATURE_STATUS.CONFLICT
      ? "客户或拜访证据已经变化，当前建议已停止写回。"
      : "",
  };
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
