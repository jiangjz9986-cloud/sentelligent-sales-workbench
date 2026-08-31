export const QUICK_RECORD_DIFF_STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  CONFLICT: "conflict",
  HISTORY_READONLY: "history_readonly",
});

const READ_ONLY_STATUSES = new Set([
  QUICK_RECORD_DIFF_STATUS.CONFIRMED,
  QUICK_RECORD_DIFF_STATUS.CANCELLED,
  QUICK_RECORD_DIFF_STATUS.EXPIRED,
  QUICK_RECORD_DIFF_STATUS.CONFLICT,
  QUICK_RECORD_DIFF_STATUS.HISTORY_READONLY,
]);

const BATCH_TARGETS = new Set(["customer", "opportunity", "weekly"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 2_000;
const MAX_ITEMS = 100;
const MAX_VALUE_DEPTH = 6;
const MAX_VALUE_ITEMS = 100;

const STATUS_ALIASES = Object.freeze({
  pending: QUICK_RECORD_DIFF_STATUS.PENDING,
  preview: QUICK_RECORD_DIFF_STATUS.PENDING,
  analyzed: QUICK_RECORD_DIFF_STATUS.PENDING,
  confirmed: QUICK_RECORD_DIFF_STATUS.CONFIRMED,
  completed: QUICK_RECORD_DIFF_STATUS.CONFIRMED,
  cancelled: QUICK_RECORD_DIFF_STATUS.CANCELLED,
  canceled: QUICK_RECORD_DIFF_STATUS.CANCELLED,
  voided: QUICK_RECORD_DIFF_STATUS.CANCELLED,
  expired: QUICK_RECORD_DIFF_STATUS.EXPIRED,
  conflict: QUICK_RECORD_DIFF_STATUS.CONFLICT,
  stale: QUICK_RECORD_DIFF_STATUS.CONFLICT,
  history: QUICK_RECORD_DIFF_STATUS.HISTORY_READONLY,
  history_readonly: QUICK_RECORD_DIFF_STATUS.HISTORY_READONLY,
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, fallback = "", max = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) return fallback;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return fallback;
  return normalized;
}

function positiveInteger(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function clonePreviewValue(value, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, MAX_TEXT_LENGTH);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_VALUE_ITEMS).map((item) => clonePreviewValue(item, depth + 1));
  }
  if (!isPlainObject(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_VALUE_ITEMS)
      .map(([key, item]) => [text(key, "", MAX_ID_LENGTH), clonePreviewValue(item, depth + 1)])
      .filter(([key]) => Boolean(key)),
  );
}

function firstOwn(source, names) {
  for (const name of names) {
    if (Object.hasOwn(source, name)) return source[name];
  }
  return undefined;
}

function normalizedStatus(value, fallback = QUICK_RECORD_DIFF_STATUS.PENDING) {
  return STATUS_ALIASES[text(value).toLowerCase()] ?? fallback;
}

function previewContainer(source) {
  for (const candidate of [
    source.confirmationPreview,
    source.writebackPreview,
    source.preview,
    source,
  ]) {
    if (isPlainObject(candidate)) return candidate;
  }
  return {};
}

function previewItems(source, container) {
  for (const candidate of [
    container.changes,
    container.items,
    container.previews,
    source.changes,
    source.items,
  ]) {
    if (Array.isArray(candidate)) return candidate.slice(0, MAX_ITEMS);
  }
  return [];
}

function normalizedTargetSet(values) {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map((value) => {
    if (typeof value === "string") return text(value, "", MAX_ID_LENGTH);
    if (isPlainObject(value)) return text(value.target ?? value.targetId, "", MAX_ID_LENGTH);
    return "";
  }).filter(Boolean));
}

function confirmedTargets(source) {
  return normalizedTargetSet([
    ...(Array.isArray(source.confirmedTargets) ? source.confirmedTargets : []),
    ...(Array.isArray(source.confirmations) ? source.confirmations : []),
  ]);
}

function temperatureSuggestion(raw, target, field, label) {
  const markers = [
    raw.kind,
    raw.type,
    raw.suggestionType,
    raw.targetType,
    raw.category,
    target,
    field,
    label,
  ].map((value) => text(value).toLowerCase()).filter(Boolean).join(" ");
  return /temperature|温度/u.test(markers)
    || target === "customer_temperature"
    || field === "relation";
}

function requestedBatchPermission(raw) {
  const value = firstOwn(raw, ["batchConfirmable", "canBatchConfirm", "bulkConfirmable"]);
  return value === undefined ? true : value === true;
}

function rawTargetVersion(raw, target, targetVersions) {
  return positiveInteger(
    raw.expectedVersion
      ?? raw.targetVersion
      ?? raw.beforeVersion
      ?? raw.before?.version
      ?? targetVersions?.[target],
  );
}

function normalizeItem(raw, index, context) {
  if (!isPlainObject(raw)) return null;
  const target = text(
    raw.target ?? raw.targetId ?? raw.entity ?? raw.entityType,
    "",
    MAX_ID_LENGTH,
  );
  if (!target) return null;
  const field = text(raw.field ?? raw.name ?? raw.key, target, MAX_ID_LENGTH);
  const label = text(raw.label ?? raw.title ?? raw.fieldLabel, field, MAX_TEXT_LENGTH);
  const fallbackId = `${target}:${field}`.slice(0, MAX_ID_LENGTH);
  const id = text(raw.id ?? raw.changeId ?? raw.previewId, fallbackId, MAX_ID_LENGTH);
  if (!id) return null;
  const isTemperature = temperatureSuggestion(raw, target, field, label);
  const status = context.confirmed.has(target)
    ? QUICK_RECORD_DIFF_STATUS.CONFIRMED
    : normalizedStatus(raw.status);
  const batchConfirmable = status === QUICK_RECORD_DIFF_STATUS.PENDING
    && BATCH_TARGETS.has(target)
    && requestedBatchPermission(raw)
    && !isTemperature;
  return {
    id,
    target,
    field,
    label,
    before: clonePreviewValue(firstOwn(raw, ["before", "from", "previous", "current"])),
    after: clonePreviewValue(firstOwn(raw, ["after", "to", "next", "proposed"])),
    status,
    batchConfirmable,
    temperatureSuggestion: isTemperature,
    requiresIndividualConfirmation: status === QUICK_RECORD_DIFF_STATUS.PENDING && !batchConfirmable,
    targetVersion: rawTargetVersion(raw, target, context.targetVersions),
    sourceIndex: index,
  };
}

function uniqueItemIds(items) {
  const seen = new Map();
  return items.map((item) => {
    const count = (seen.get(item.id) ?? 0) + 1;
    seen.set(item.id, count);
    return count === 1 ? item : { ...item, id: `${item.id}:${count}`.slice(0, MAX_ID_LENGTH) };
  });
}

function selectedModel(model, requestedIds) {
  const nextSet = new Set(requestedIds);
  const items = model.items.map((item) => ({
    ...item,
    selected: item.selectable && nextSet.has(item.id),
  }));
  const selectedIds = items.filter((item) => item.selected).map((item) => item.id);
  const unchanged = selectedIds.length === model.selectedIds.length
    && selectedIds.every((id, index) => id === model.selectedIds[index]);
  if (unchanged) return model;
  return {
    ...model,
    items,
    selectedIds,
    canConfirmSelected: selectedIds.length > 0,
  };
}

export function normalizeQuickRecordDiffPreview(input = {}, options = {}) {
  const source = isPlainObject(input) ? input : {};
  const container = previewContainer(source);
  const historyReadOnly = options.historyReadOnly === true;
  const status = historyReadOnly
    ? QUICK_RECORD_DIFF_STATUS.HISTORY_READONLY
    : normalizedStatus(container.status ?? source.status);
  const readOnly = READ_ONLY_STATUSES.has(status);
  const hasUnsavedDraftChanges = options.hasUnsavedDraftChanges === true
    || source.hasUnsavedDraftChanges === true
    || source.analysisDirty === true;
  const blocker = hasUnsavedDraftChanges
    ? {
      code: "UNSAVED_DRAFT_CHANGES",
      message: "请先保存快速记录分析修改，再确认写入业务数据",
    }
    : null;
  const blocked = Boolean(blocker);
  const actionAllowed = !readOnly && !blocked;
  const targetVersions = isPlainObject(source.targetVersions)
    ? source.targetVersions
    : isPlainObject(container.targetVersions)
      ? container.targetVersions
      : {};
  const context = {
    confirmed: confirmedTargets(source),
    targetVersions,
  };
  const normalizedItems = uniqueItemIds(
    previewItems(source, container)
      .map((item, index) => normalizeItem(item, index, context))
      .filter(Boolean),
  );
  const requestedSelection = new Set(
    Array.isArray(options.selectedIds)
      ? options.selectedIds.map((id) => text(id, "", MAX_ID_LENGTH)).filter(Boolean)
      : [],
  );
  const items = normalizedItems.map((item) => {
    const selectable = actionAllowed && item.batchConfirmable;
    return {
      ...item,
      selectable,
      selected: selectable && requestedSelection.has(item.id),
    };
  });
  const selectedIds = items.filter((item) => item.selected).map((item) => item.id);
  const batchConfirmableIds = items.filter((item) => item.selectable).map((item) => item.id);
  const quickRecord = isPlainObject(source.quickRecord) ? source.quickRecord : {};
  const analysis = isPlainObject(source.analysis) ? source.analysis : {};
  const quickRecordId = text(
    source.quickRecordId ?? quickRecord.id ?? container.quickRecordId ?? source.id,
    "",
    MAX_ID_LENGTH,
  ) || null;
  const analysisVersionId = text(
    source.analysisVersionId ?? analysis.id ?? container.analysisVersionId,
    "",
    MAX_ID_LENGTH,
  ) || null;
  const rawDigest = text(source.previewDigest ?? container.previewDigest ?? source.digest, "", 64);

  return {
    quickRecordId,
    quickRecordVersion: positiveInteger(
      source.quickRecordVersion ?? quickRecord.version ?? container.quickRecordVersion ?? source.version,
    ),
    analysisVersionId,
    previewDigest: SHA256.test(rawDigest) ? rawDigest : null,
    status,
    readOnly,
    blocked,
    blocker,
    hasUnsavedDraftChanges,
    requiresHumanConfirmation: true,
    items,
    selectedIds,
    batchConfirmableIds,
    canConfirmSelected: selectedIds.length > 0,
    canConfirmAll: batchConfirmableIds.length > 0,
  };
}

export function toggleQuickRecordDiffSelection(model, itemId) {
  if (!model || model.readOnly || model.blocked || !Array.isArray(model.items)) return model;
  const normalizedId = text(itemId, "", MAX_ID_LENGTH);
  const item = model.items.find((candidate) => candidate.id === normalizedId);
  if (!item?.selectable) return model;
  const next = new Set(model.selectedIds);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  return selectedModel(model, next);
}

export function cancelQuickRecordDiffSelection(model, itemId) {
  if (!model || model.readOnly || model.blocked || !Array.isArray(model.selectedIds)) return model;
  const normalizedId = text(itemId, "", MAX_ID_LENGTH);
  if (!model.selectedIds.includes(normalizedId)) return model;
  return selectedModel(model, model.selectedIds.filter((id) => id !== normalizedId));
}

export function selectAllQuickRecordDiffItems(model) {
  if (!model || model.readOnly || model.blocked || !Array.isArray(model.items)) return model;
  return selectedModel(
    model,
    model.items.filter((item) => item.selectable).map((item) => item.id),
  );
}

export function clearQuickRecordDiffSelection(model) {
  if (!model || !Array.isArray(model.selectedIds) || model.selectedIds.length === 0) return model;
  return selectedModel(model, []);
}

function confirmationItems(model, confirmAll) {
  if (!model || model.readOnly || model.blocked || !Array.isArray(model.items)) return [];
  const selected = new Set(model.selectedIds ?? []);
  return model.items.filter((item) => (
    item.selectable
    && item.status === QUICK_RECORD_DIFF_STATUS.PENDING
    && (confirmAll || selected.has(item.id))
  ));
}

export function createQuickRecordDiffConfirmationPayload(model, { confirmAll = false } = {}) {
  if (!model?.quickRecordId) return null;
  const items = confirmationItems(model, confirmAll === true);
  if (items.length === 0) return null;
  const targets = [];
  const versions = new Map();
  for (const item of items) {
    if (!targets.includes(item.target)) targets.push(item.target);
    if (item.targetVersion !== null) {
      const current = versions.get(item.target);
      if (current !== undefined && current !== item.targetVersion) return null;
      versions.set(item.target, item.targetVersion);
    }
  }
  const payload = { quickRecordId: model.quickRecordId };
  if (model.quickRecordVersion !== null) payload.quickRecordVersion = model.quickRecordVersion;
  if (model.analysisVersionId !== null) payload.analysisVersionId = model.analysisVersionId;
  if (model.previewDigest !== null) payload.previewDigest = model.previewDigest;
  payload.targets = targets;
  if (versions.size > 0) {
    payload.targetVersions = Object.fromEntries(
      targets.filter((target) => versions.has(target)).map((target) => [target, versions.get(target)]),
    );
  }
  return payload;
}
