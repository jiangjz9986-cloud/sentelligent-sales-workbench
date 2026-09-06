/**
 * View-model helpers for the global proactive-assistant queue.
 *
 * The queue is deliberately allowed to consume additive server fields.  The
 * v0.11 proactive snapshot only has `confirmationStatus` and durable preview
 * metadata; the global review surface may additionally provide
 * `lifecycleStatus`, `status`, or a nested `lifecycle` object.  Keeping the
 * translation here means the card can render one stable lifecycle vocabulary
 * while a backend contract is rolled out incrementally.
 */

export const PROACTIVE_LIFECYCLE = Object.freeze({
  PENDING: "pending",
  DEFERRED: "deferred",
  IGNORED: "ignored",
  RESOLVED: "resolved",
  CONFIRMED: "confirmed",
  EXECUTED: "executed",
  CONFLICT: "conflict",
  FAILED: "failed",
});

export const PROACTIVE_LIFECYCLE_ORDER = Object.freeze([
  PROACTIVE_LIFECYCLE.PENDING,
  PROACTIVE_LIFECYCLE.DEFERRED,
  PROACTIVE_LIFECYCLE.IGNORED,
  PROACTIVE_LIFECYCLE.RESOLVED,
  PROACTIVE_LIFECYCLE.CONFIRMED,
  PROACTIVE_LIFECYCLE.EXECUTED,
  PROACTIVE_LIFECYCLE.CONFLICT,
  PROACTIVE_LIFECYCLE.FAILED,
]);

export const PROACTIVE_LIFECYCLE_META = Object.freeze({
  [PROACTIVE_LIFECYCLE.PENDING]: Object.freeze({
    label: "待处理",
    tone: "amber",
    description: "等待人工判断，可编辑确认信息。",
  }),
  [PROACTIVE_LIFECYCLE.DEFERRED]: Object.freeze({
    label: "稍后",
    tone: "blue",
    description: "已暂缓处理，保留在全局建议历史中。",
  }),
  [PROACTIVE_LIFECYCLE.IGNORED]: Object.freeze({
    label: "忽略",
    tone: "gray",
    description: "已忽略，不会自动写入业务数据。",
  }),
  [PROACTIVE_LIFECYCLE.RESOLVED]: Object.freeze({
    label: "已解决",
    tone: "teal",
    description: "问题已解决，保留处理结果和来源。",
  }),
  [PROACTIVE_LIFECYCLE.CONFIRMED]: Object.freeze({
    label: "已确认",
    tone: "green",
    description: "已完成人工确认，等待执行或业务回写结果。",
  }),
  [PROACTIVE_LIFECYCLE.EXECUTED]: Object.freeze({
    label: "已执行",
    tone: "green",
    description: "确认后的动作已经执行并回读。",
  }),
  [PROACTIVE_LIFECYCLE.CONFLICT]: Object.freeze({
    label: "冲突",
    tone: "red",
    description: "状态或版本发生变化，请刷新后核对。",
  }),
  [PROACTIVE_LIFECYCLE.FAILED]: Object.freeze({
    label: "失败",
    tone: "red",
    description: "处理未完成，保留失败结果以便重试或人工处理。",
  }),
});

const STATUS_ALIASES = Object.freeze({
  pending: PROACTIVE_LIFECYCLE.PENDING,
  open: PROACTIVE_LIFECYCLE.PENDING,
  active: PROACTIVE_LIFECYCLE.PENDING,
  not_started: PROACTIVE_LIFECYCLE.PENDING,
  todo: PROACTIVE_LIFECYCLE.PENDING,
  to_do: PROACTIVE_LIFECYCLE.PENDING,
  waiting: PROACTIVE_LIFECYCLE.PENDING,
  deferred: PROACTIVE_LIFECYCLE.DEFERRED,
  defer: PROACTIVE_LIFECYCLE.DEFERRED,
  snoozed: PROACTIVE_LIFECYCLE.DEFERRED,
  later: PROACTIVE_LIFECYCLE.DEFERRED,
  postponed: PROACTIVE_LIFECYCLE.DEFERRED,
  ignored: PROACTIVE_LIFECYCLE.IGNORED,
  ignore: PROACTIVE_LIFECYCLE.IGNORED,
  dismissed: PROACTIVE_LIFECYCLE.IGNORED,
  cancelled: PROACTIVE_LIFECYCLE.IGNORED,
  canceled: PROACTIVE_LIFECYCLE.IGNORED,
  rejected: PROACTIVE_LIFECYCLE.IGNORED,
  resolved: PROACTIVE_LIFECYCLE.RESOLVED,
  resolve: PROACTIVE_LIFECYCLE.RESOLVED,
  closed: PROACTIVE_LIFECYCLE.RESOLVED,
  done: PROACTIVE_LIFECYCLE.RESOLVED,
  solved: PROACTIVE_LIFECYCLE.RESOLVED,
  confirmed: PROACTIVE_LIFECYCLE.CONFIRMED,
  confirm: PROACTIVE_LIFECYCLE.CONFIRMED,
  accepted: PROACTIVE_LIFECYCLE.CONFIRMED,
  approved: PROACTIVE_LIFECYCLE.CONFIRMED,
  executed: PROACTIVE_LIFECYCLE.EXECUTED,
  execute: PROACTIVE_LIFECYCLE.EXECUTED,
  completed: PROACTIVE_LIFECYCLE.EXECUTED,
  complete: PROACTIVE_LIFECYCLE.EXECUTED,
  succeeded: PROACTIVE_LIFECYCLE.EXECUTED,
  success: PROACTIVE_LIFECYCLE.EXECUTED,
  conflict: PROACTIVE_LIFECYCLE.CONFLICT,
  stale: PROACTIVE_LIFECYCLE.CONFLICT,
  version_conflict: PROACTIVE_LIFECYCLE.CONFLICT,
  versionConflict: PROACTIVE_LIFECYCLE.CONFLICT,
  failed: PROACTIVE_LIFECYCLE.FAILED,
  failure: PROACTIVE_LIFECYCLE.FAILED,
  error: PROACTIVE_LIFECYCLE.FAILED,
  errored: PROACTIVE_LIFECYCLE.FAILED,
});

const DISPLAY_ALIASES = Object.freeze({
  "待处理": PROACTIVE_LIFECYCLE.PENDING,
  "待人工确认": PROACTIVE_LIFECYCLE.PENDING,
  "稍后": PROACTIVE_LIFECYCLE.DEFERRED,
  "已延期": PROACTIVE_LIFECYCLE.DEFERRED,
  "忽略": PROACTIVE_LIFECYCLE.IGNORED,
  "已忽略": PROACTIVE_LIFECYCLE.IGNORED,
  "已取消": PROACTIVE_LIFECYCLE.IGNORED,
  "已解决": PROACTIVE_LIFECYCLE.RESOLVED,
  "已关闭": PROACTIVE_LIFECYCLE.RESOLVED,
  "已确认": PROACTIVE_LIFECYCLE.CONFIRMED,
  "已执行": PROACTIVE_LIFECYCLE.EXECUTED,
  "冲突": PROACTIVE_LIFECYCLE.CONFLICT,
  "状态冲突": PROACTIVE_LIFECYCLE.CONFLICT,
  "失败": PROACTIVE_LIFECYCLE.FAILED,
  "处理失败": PROACTIVE_LIFECYCLE.FAILED,
});

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Render only a calibrated confidence percentage.  Rule-based proactive
 * suggestions deliberately publish `confidence: null` until a calibration
 * dataset exists; treating that value as 0 (or appending a percent sign to a
 * placeholder) would turn an unknown into a false measurement.
 */
export function formatProactiveConfidence(item = {}) {
  const value = item?.confidence;
  if (item?.confidenceCalibrated === true && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) {
    return `置信度 ${value}%`;
  }
  return "置信度未校准";
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function statusKey(value) {
  const normalized = text(value);
  if (!normalized) return null;
  const lower = normalized.toLowerCase().replace(/[\s-]+/gu, "_");
  return STATUS_ALIASES[normalized] ?? STATUS_ALIASES[lower] ?? DISPLAY_ALIASES[normalized] ?? null;
}

function previewLifecycleStatus(item) {
  const previews = item?.confirmationPreviews;
  if (!previews || typeof previews !== "object" || Array.isArray(previews)) return null;
  const values = Object.values(previews).filter((value) => value && typeof value === "object");
  if (values.some((preview) => preview.status === "completed" && preview.resultItemId)) {
    return PROACTIVE_LIFECYCLE.EXECUTED;
  }
  if (values.some((preview) => preview.status === "completed")) {
    return PROACTIVE_LIFECYCLE.CONFIRMED;
  }
  if (values.some((preview) => preview.status === "expired")) {
    return PROACTIVE_LIFECYCLE.FAILED;
  }
  if (values.some((preview) => preview.status === "cancelled")) {
    return PROACTIVE_LIFECYCLE.IGNORED;
  }
  return null;
}

/**
 * Resolve every known server spelling to the eight global lifecycle states.
 * Explicit lifecycle fields take precedence over compatibility metadata.
 */
export function normalizeProactiveLifecycleStatus(itemOrStatus) {
  if (typeof itemOrStatus === "string") {
    return statusKey(itemOrStatus) ?? PROACTIVE_LIFECYCLE.PENDING;
  }
  const item = itemOrStatus && typeof itemOrStatus === "object" ? itemOrStatus : {};
  const derivedPreviewStatus = previewLifecycleStatus(item);
  const explicit = [
    [item.lifecycleStatus, true],
    [item.lifecycle?.status, true],
    [item.suggestionStatus, true],
    [item.reviewStatus, true],
    [item.status, false],
    [item.state, false],
    [item.executionStatus, false],
    [item.writebackStatus, false],
    [item.confirmationStatus, false],
  ];
  for (const [value, authoritative] of explicit) {
    const resolved = statusKey(value);
    // The v0.11 API keeps `confirmationStatus: not_started` on the original
    // suggestion even after a durable confirmation preview has completed.
    // Prefer the stronger preview result over that compatibility placeholder,
    // while retaining any explicit non-pending lifecycle decision.
    if (resolved && (authoritative || resolved !== PROACTIVE_LIFECYCLE.PENDING || !derivedPreviewStatus)) return resolved;
  }
  return derivedPreviewStatus ?? PROACTIVE_LIFECYCLE.PENDING;
}

export function proactiveLifecycleMeta(status) {
  return PROACTIVE_LIFECYCLE_META[normalizeProactiveLifecycleStatus(status)]
    ?? PROACTIVE_LIFECYCLE_META[PROACTIVE_LIFECYCLE.PENDING];
}

function nestedValue(item, paths) {
  for (const path of paths) {
    let current = item;
    for (const key of path) current = current?.[key];
    const value = firstPresent(current);
    if (value !== null) return value;
  }
  return null;
}

function dateOnly(value) {
  const normalized = text(value);
  if (!normalized) return "";
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(normalized);
  return match ? match[1] : "";
}

function normalizePriority(value) {
  const normalized = text(value);
  if (!normalized) return "中";
  const lower = normalized.toLowerCase();
  if (["high", "urgent", "p0", "p1", "高", "紧急"].includes(lower) || ["高", "紧急"].includes(normalized)) return "高";
  if (["low", "p3", "低"].includes(lower) || normalized === "低") return "低";
  return "中";
}

/** Return the four editable values shown in the review form. */
export function normalizeProactiveEditableFields(item = {}) {
  const reviewFields = item?.reviewFields
    && typeof item.reviewFields === "object"
    && !Array.isArray(item.reviewFields)
    ? item.reviewFields
    : null;
  const reviewField = (names) => {
    for (const name of names) {
      if (reviewFields && Object.hasOwn(reviewFields, name) && reviewFields[name] !== undefined) {
        return { found: true, value: reviewFields[name] };
      }
    }
    return { found: false, value: null };
  };
  const reviewOwner = reviewField(["assignee", "owner"]);
  const reviewDueDate = reviewField(["dueDate", "due"]);
  const reviewPriority = reviewField(["priority"]);
  const reviewExpectedResult = reviewField(["expectedResult", "result"]);
  const owner = reviewOwner.found ? reviewOwner.value : nestedValue(item, [
    ["assignee"], ["assigneeName"], ["responsible"], ["responsibleName"],
    ["ownerName"], ["owner"], ["lifecycle", "assignee"], ["lifecycle", "owner"],
  ]);
  const ownerText = owner && typeof owner === "object"
    ? text(firstPresent(owner.name, owner.displayName, owner.account, owner.id))
    : text(owner);
  const dateValue = reviewDueDate.found ? reviewDueDate.value : nestedValue(item, [
    ["dueDate"], ["targetDate"], ["followUpDate"], ["followUpAt"], ["due"], ["nextDate"],
    ["lifecycle", "dueDate"], ["lifecycle", "targetDate"], ["lifecycle", "followUpDate"],
    ["writebackPreview", "action", "due"], ["writebackPreview", "action", "dueDate"],
    ["writebackPreview", "action", "followUpDate"],
  ]);
  const priorityValue = reviewPriority.found ? reviewPriority.value : nestedValue(item, [
    ["priority"], ["priorityLabel"], ["urgency"], ["lifecycle", "priority"],
    ["writebackPreview", "action", "priority"],
  ]);
  const expectedResult = reviewExpectedResult.found ? reviewExpectedResult.value : nestedValue(item, [
    ["expectedResult"], ["expectedOutcome"], ["outcome"], ["lifecycle", "expectedResult"],
    ["writebackPreview", "action", "expectedResult"], ["writebackPreview", "action", "expectedOutcome"],
  ]);
  return {
    owner: ownerText,
    dueDate: dateOnly(dateValue),
    priority: normalizePriority(priorityValue),
    expectedResult: text(expectedResult),
  };
}

export function sameProactiveEditableFields(left, right) {
  const a = normalizeProactiveEditableFields(left);
  const b = normalizeProactiveEditableFields(right);
  return a.owner === b.owner
    && a.dueDate === b.dueDate
    && a.priority === b.priority
    && a.expectedResult === b.expectedResult;
}

/**
 * Build a non-mutating confirmation preview from the current card and the
 * edited values.  The preview is display-only until the host supplies the
 * persistence callbacks; it never silently changes business records.
 */
export function buildProactiveReviewPreview(item = {}, fields = {}) {
  const normalizedFields = {
    ...normalizeProactiveEditableFields(item),
    ...fields,
  };
  const action = item?.writebackPreview?.action ?? item?.preview?.action ?? {};
  const risk = item?.writebackPreview?.risk ?? item?.preview?.risk ?? null;
  return {
    suggestionId: item?.id ?? null,
    status: normalizeProactiveLifecycleStatus(item),
    statusLabel: proactiveLifecycleMeta(item).label,
    title: firstPresent(action.title, item?.title, "主动跟进建议"),
    reason: firstPresent(action.reason, item?.conclusion, "依据已保存事实生成的建议。"),
    owner: normalizedFields.owner,
    dueDate: normalizedFields.dueDate,
    priority: normalizePriority(normalizedFields.priority),
    expectedResult: text(normalizedFields.expectedResult),
    target: firstPresent(action.opportunityId, item?.opportunityId, item?.subjectId),
    customerId: firstPresent(action.customerId, item?.customerId),
    risk: risk ? {
      title: firstPresent(risk.title, "待确认风险"),
      action: firstPresent(risk.action, "待补充处理动作"),
    } : null,
    requiresHumanConfirmation: true,
  };
}

function countValue(counts, status) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return null;
  const aliases = [
    status,
    `${status}Count`,
    status === PROACTIVE_LIFECYCLE.PENDING ? "not_started" : null,
    status === PROACTIVE_LIFECYCLE.PENDING ? "notStarted" : null,
    status === PROACTIVE_LIFECYCLE.PENDING ? "open" : null,
    status === PROACTIVE_LIFECYCLE.DEFERRED ? "later" : null,
    status === PROACTIVE_LIFECYCLE.IGNORED ? "dismissed" : null,
    status === PROACTIVE_LIFECYCLE.RESOLVED ? "closed" : null,
    status === PROACTIVE_LIFECYCLE.CONFIRMED ? "accepted" : null,
    status === PROACTIVE_LIFECYCLE.EXECUTED ? "completed" : null,
  ].filter(Boolean);
  for (const key of aliases) {
    const value = counts[key];
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

/**
 * Preserve authoritative server counts when available, and fill only missing
 * buckets from the rows currently present in the response.  This prevents a
 * limited page from making historical statuses disappear after refresh.
 */
export function buildProactiveLifecycleCounts(assistant = {}, items = []) {
  const countSources = [
    assistant?.lifecycleCounts,
    assistant?.statusCounts,
    assistant?.counts?.lifecycle,
    assistant?.counts,
  ];
  const result = {};
  for (const status of PROACTIVE_LIFECYCLE_ORDER) {
    const authoritative = countSources
      .map((source) => countValue(source, status))
      .find((value) => value !== null);
    result[status] = authoritative ?? items.filter((item) => normalizeProactiveLifecycleStatus(item) === status).length;
  }
  const totalCount = countSources
    .map((source) => countValue(source, "total"))
    .find((value) => value !== null);
  result.total = totalCount ?? PROACTIVE_LIFECYCLE_ORDER.reduce((sum, status) => sum + result[status], 0);
  return result;
}

export function mergeProactiveSuggestionItems(assistant = {}) {
  const sources = [assistant?.items, assistant?.history, assistant?.lifecycleItems, assistant?.suggestions];
  const seen = new Map();
  const items = [];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      if (!item || typeof item !== "object") continue;
      const id = text(firstPresent(item.id, item.suggestionId, item.proactiveId, item.key));
      if (!id) continue;
      const normalizedItem = item.id ? item : { ...item, id };
      const previousIndex = seen.get(id);
      if (previousIndex === undefined) {
        seen.set(id, items.length);
        items.push(normalizedItem);
        continue;
      }
      // Additive history/lifecycle payloads frequently contain only the
      // fields that changed.  Fill gaps without allowing an older sparse row
      // to replace the current card's identity or writeback payload.
      const previous = items[previousIndex];
      const merged = { ...previous, ...normalizedItem };
      for (const [key, value] of Object.entries(previous)) {
        if (merged[key] === null || merged[key] === undefined || merged[key] === "") merged[key] = value;
      }
      items[previousIndex] = merged;
    }
  }
  return items;
}

/**
 * Project the single server-owned proactive ledger snapshot onto one business
 * object.  Detail pages must not re-run rules locally: they receive the same
 * persisted rows and only apply an owner-safe subject filter.  Counts are
 * recomputed from the projected rows so a customer/opportunity badge cannot
 * accidentally show the overview's global totals.
 */
export function scopeProactiveAssistant(assistant = {}, { customerId = null, opportunityId = null } = {}) {
  const allItems = mergeProactiveSuggestionItems(assistant);
  const hasOpportunityScope = typeof opportunityId === "string" && opportunityId.trim();
  const hasCustomerScope = typeof customerId === "string" && customerId.trim();
  const items = allItems.filter((item) => (
    hasOpportunityScope
      ? item?.opportunityId === opportunityId
      : hasCustomerScope
        ? item?.customerId === customerId
        : true
  ));
  const triggerCounts = {
    total: items.length,
    missingNextStep: items.filter((item) => item?.trigger?.type === "missing_next_step").length,
    staleOpportunity: items.filter((item) => item?.trigger?.type === "stale_opportunity").length,
    stageEvidenceMismatch: items.filter((item) => item?.trigger?.type === "stage_evidence_mismatch").length,
    budgetUnknown: items.filter((item) => item?.trigger?.type === "budget_unknown").length,
    decisionChainUnknown: items.filter((item) => item?.trigger?.type === "decision_chain_unknown").length,
    purchaseTimingUnknown: items.filter((item) => item?.trigger?.type === "purchase_timing_unknown").length,
    actionDue: items.filter((item) => item?.trigger?.type === "action_due").length,
    riskOpen: items.filter((item) => item?.trigger?.type === "risk_open").length,
    visitFollowUp: items.filter((item) => item?.trigger?.type === "visit_follow_up").length,
    tenderChange: items.filter((item) => item?.trigger?.type === "tender_change").length,
  };
  const lifecycleCounts = { total: items.length };
  for (const status of PROACTIVE_LIFECYCLE_ORDER) {
    lifecycleCounts[status] = items.filter((item) => normalizeProactiveLifecycleStatus(item) === status).length;
  }
  return {
    ...assistant,
    items,
    counts: {
      ...(assistant?.counts && typeof assistant.counts === "object" ? assistant.counts : {}),
      ...triggerCounts,
      lifecycle: lifecycleCounts,
    },
    lifecycleCounts,
    truncated: false,
    scope: {
      ...(hasOpportunityScope ? { opportunityId } : {}),
      ...(hasCustomerScope && !hasOpportunityScope ? { customerId } : {}),
    },
  };
}

export function proactiveSourceLabel(item = {}) {
  if (item?.source === "model") {
    const provider = text(item?.modelProvider || item?.modelVersion || "模型");
    return provider ? `模型生成 · ${provider}` : "模型生成";
  }
  if (item?.fallbackReason) return `规则降级 · ${item.fallbackReason}`;
  if (item?.source === "persisted") return "服务端回读";
  return "规则判断";
}

/**
 * Return the revision used by the panel to fence optimistic local edits.
 * `generatedAt` is the current v0.11 snapshot marker; newer hosts can expose
 * an explicit revision or updatedAt without changing the component API.
 */
export function proactiveAssistantRevision(assistant = {}) {
  return firstPresent(
    assistant?.revision,
    assistant?.snapshotRevision,
    assistant?.generatedAt,
    assistant?.updatedAt,
    assistant?.lifecycleUpdatedAt,
  );
}

export function proactiveSuggestionRevision(item = {}) {
  return firstPresent(
    item.lifecycleVersion,
    item.version,
    item.lifecycle?.version,
    item.updatedAt,
    item.lifecycleUpdatedAt,
    item.statusUpdatedAt,
    item.id,
  );
}

export function proactiveLifecycleFingerprint(item = {}) {
  const status = normalizeProactiveLifecycleStatus(item);
  const fields = normalizeProactiveEditableFields(item);
  return JSON.stringify({
    id: item?.id ?? null,
    revision: proactiveSuggestionRevision(item),
    status,
    fields,
  });
}

export function lifecycleActionTargets(status) {
  const current = normalizeProactiveLifecycleStatus(status);
  if (current === PROACTIVE_LIFECYCLE.PENDING) {
    return [PROACTIVE_LIFECYCLE.DEFERRED, PROACTIVE_LIFECYCLE.IGNORED, PROACTIVE_LIFECYCLE.CONFIRMED];
  }
  if (current === PROACTIVE_LIFECYCLE.DEFERRED) {
    return [PROACTIVE_LIFECYCLE.PENDING, PROACTIVE_LIFECYCLE.IGNORED];
  }
  if (current === PROACTIVE_LIFECYCLE.IGNORED || current === PROACTIVE_LIFECYCLE.RESOLVED) {
    return [PROACTIVE_LIFECYCLE.PENDING];
  }
  if (current === PROACTIVE_LIFECYCLE.CONFIRMED) {
    return [PROACTIVE_LIFECYCLE.EXECUTED, PROACTIVE_LIFECYCLE.RESOLVED];
  }
  if (current === PROACTIVE_LIFECYCLE.EXECUTED) {
    return [PROACTIVE_LIFECYCLE.RESOLVED];
  }
  return [PROACTIVE_LIFECYCLE.PENDING];
}
