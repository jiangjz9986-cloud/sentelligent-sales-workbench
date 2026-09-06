export const QUICK_RECORD_DIFF_STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  CONFLICT: "conflict",
  HISTORY_READONLY: "history_readonly",
  INVALID: "invalid",
});

const CONFIRMATION_SCHEMA_VERSION = "quick-record-confirmation-v2";
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u;
const FIELD_PATH = /^[A-Za-z][A-Za-z0-9_.-]{0,199}$/u;
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 2_000;
const MAX_ITEMS = 50;
const MAX_JSON_BYTES = 40_000;
const MAX_EVIDENCE = 50;
const MAX_VALUE_DEPTH = 8;
const MAX_VALUE_ITEMS = 100;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const INVALID_PREVIEW_VALUE = Symbol("INVALID_PREVIEW_VALUE");

const TARGET_POLICIES = Object.freeze({
  customer: Object.freeze({
    confirmationMode: "explicit",
    bulkEligible: true,
    fields: Object.freeze(["needs"]),
  }),
  opportunity: Object.freeze({
    confirmationMode: "explicit",
    bulkEligible: true,
    fields: Object.freeze(["requirements"]),
  }),
  weekly: Object.freeze({
    confirmationMode: "explicit",
    bulkEligible: true,
    fields: Object.freeze(["entries"]),
  }),
  customer_temperature: Object.freeze({
    confirmationMode: "independent",
    bulkEligible: false,
    fields: Object.freeze(["relation"]),
  }),
  action: Object.freeze({
    confirmationMode: "unsupported",
    bulkEligible: false,
    fields: Object.freeze(["title"]),
  }),
  financial: Object.freeze({
    confirmationMode: "unsupported",
    bulkEligible: false,
    fields: Object.freeze(["amountCents"]),
  }),
});

const READ_ONLY_STATUSES = new Set([
  QUICK_RECORD_DIFF_STATUS.CONFIRMED,
  QUICK_RECORD_DIFF_STATUS.CANCELLED,
  QUICK_RECORD_DIFF_STATUS.EXPIRED,
  QUICK_RECORD_DIFF_STATUS.CONFLICT,
  QUICK_RECORD_DIFF_STATUS.HISTORY_READONLY,
  QUICK_RECORD_DIFF_STATUS.INVALID,
]);

const PREVIEW_STATUS_ALIASES = Object.freeze({
  open: QUICK_RECORD_DIFF_STATUS.PENDING,
  pending: QUICK_RECORD_DIFF_STATUS.PENDING,
  preview: QUICK_RECORD_DIFF_STATUS.PENDING,
  analyzed: QUICK_RECORD_DIFF_STATUS.PENDING,
  completed: QUICK_RECORD_DIFF_STATUS.CONFIRMED,
  confirmed: QUICK_RECORD_DIFF_STATUS.CONFIRMED,
  cancelled: QUICK_RECORD_DIFF_STATUS.CANCELLED,
  canceled: QUICK_RECORD_DIFF_STATUS.CANCELLED,
  voided: QUICK_RECORD_DIFF_STATUS.CANCELLED,
  expired: QUICK_RECORD_DIFF_STATUS.EXPIRED,
  conflict: QUICK_RECORD_DIFF_STATUS.CONFLICT,
  stale: QUICK_RECORD_DIFF_STATUS.CONFLICT,
  history: QUICK_RECORD_DIFF_STATUS.HISTORY_READONLY,
  history_readonly: QUICK_RECORD_DIFF_STATUS.HISTORY_READONLY,
});

const ITEM_STATUS_ALIASES = Object.freeze({
  pending: QUICK_RECORD_DIFF_STATUS.PENDING,
  confirmed: QUICK_RECORD_DIFF_STATUS.CONFIRMED,
  cancelled: QUICK_RECORD_DIFF_STATUS.CANCELLED,
  canceled: QUICK_RECORD_DIFF_STATUS.CANCELLED,
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

function identifier(value) {
  const normalized = text(value, "", MAX_ID_LENGTH);
  if (!IDENTIFIER.test(normalized) || normalized.startsWith("synthetic:")) return null;
  return normalized;
}

function fieldPath(value) {
  const normalized = text(value, "", MAX_ID_LENGTH);
  return FIELD_PATH.test(normalized) ? normalized : null;
}

function digest(value) {
  const normalized = text(value, "", 64);
  return SHA256.test(normalized) ? normalized : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isoTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function optionalText(value, max = MAX_TEXT_LENGTH) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, "", max) || null;
}

function clonePreviewValue(value, depth = 0, seen = new Set()) {
  if (depth > MAX_VALUE_DEPTH) return INVALID_PREVIEW_VALUE;
  if (value === null) return null;
  if (value === undefined) return INVALID_PREVIEW_VALUE;
  if (typeof value === "string") {
    if (
      value.length > MAX_TEXT_LENGTH
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
    ) {
      return INVALID_PREVIEW_VALUE;
    }
    return value;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : INVALID_PREVIEW_VALUE;
  }
  if (typeof value === "boolean") return value;
  if (typeof value !== "object" || seen.has(value)) return INVALID_PREVIEW_VALUE;
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (value.length > MAX_VALUE_ITEMS) result = INVALID_PREVIEW_VALUE;
    else {
      const items = value.map((item) => clonePreviewValue(item, depth + 1, seen));
      result = items.includes(INVALID_PREVIEW_VALUE) ? INVALID_PREVIEW_VALUE : items;
    }
  } else if (!isPlainObject(value)) result = INVALID_PREVIEW_VALUE;
  else {
    const entries = Object.entries(value);
    if (
      entries.length > MAX_VALUE_ITEMS
      || entries.some(([key]) => FORBIDDEN_OBJECT_KEYS.has(key))
    ) {
      result = INVALID_PREVIEW_VALUE;
    } else {
      const clonedEntries = entries.map(([key, item]) => [
        key,
        clonePreviewValue(item, depth + 1, seen),
      ]);
      result = clonedEntries.some(([, item]) => item === INVALID_PREVIEW_VALUE)
        ? INVALID_PREVIEW_VALUE
        : Object.fromEntries(clonedEntries);
    }
  }
  seen.delete(value);
  return result;
}

function previewValue(value) {
  const cloned = clonePreviewValue(value);
  if (cloned === INVALID_PREVIEW_VALUE) return { value: null, valid: false };
  let encoded;
  try {
    encoded = JSON.stringify(cloned);
  } catch {
    return { value: null, valid: false };
  }
  if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_JSON_BYTES) {
    return { value: null, valid: false };
  }
  return { value: cloned, valid: true };
}

function confirmationReceipt(value, { entityId, field, entityVersion }) {
  if (value === null) return { value: null, valid: true };
  if (!isPlainObject(value)) return { value: null, valid: false };
  const keys = Object.keys(value);
  const receiptEntityId = identifier(value.entityId);
  const receiptField = fieldPath(value.field);
  const receiptVersion = positiveInteger(value.version);
  const valid = keys.length === 3
    && keys.every((key) => ["entityId", "field", "version"].includes(key))
    && receiptEntityId === entityId
    && receiptField === field
    && receiptVersion !== null
    && entityVersion !== null
    && receiptVersion > entityVersion;
  return {
    value: valid
      ? { entityId: receiptEntityId, field: receiptField, version: receiptVersion }
      : null,
    valid,
  };
}

function firstOwn(source, names) {
  for (const name of names) {
    if (Object.hasOwn(source, name)) return source[name];
  }
  return undefined;
}

function normalizePreviewStatus(value) {
  return PREVIEW_STATUS_ALIASES[text(value).toLowerCase()] ?? QUICK_RECORD_DIFF_STATUS.INVALID;
}

function normalizeItemStatus(value) {
  return ITEM_STATUS_ALIASES[text(value).toLowerCase()] ?? QUICK_RECORD_DIFF_STATUS.INVALID;
}

function previewContainer(source) {
  if (isPlainObject(source.item)) return source.item;
  if (isPlainObject(source.preview)) return source.preview;
  for (const candidate of [source.confirmationPreview, source.writebackPreview, source]) {
    if (isPlainObject(candidate)) return candidate;
  }
  return {};
}

function previewItems(source, container) {
  for (const candidate of [
    container.items,
    container.changes,
    container.previews,
    source.items,
    source.changes,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizedTargetSet(values) {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map((value) => {
    if (typeof value === "string") return identifier(value);
    if (isPlainObject(value)) return identifier(value.target ?? value.targetId);
    return null;
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

function legacyBatchPermission(raw) {
  const value = firstOwn(raw, ["bulkEligible", "batchConfirmable", "canBatchConfirm", "bulkConfirmable"]);
  return value === true;
}

function rawEntityVersion(raw, target, targetVersions) {
  return positiveInteger(
    raw.entityVersion
      ?? raw.expectedVersion
      ?? raw.targetVersion
      ?? raw.beforeVersion
      ?? raw.before?.version
      ?? targetVersions?.[target],
  );
}

function normalizeItem(raw, index, context) {
  if (!isPlainObject(raw)) return null;
  const target = identifier(raw.target ?? raw.targetId ?? raw.entity ?? raw.entityType);
  if (!target) return null;
  const rawField = fieldPath(raw.field ?? raw.name ?? raw.key);
  const field = rawField ?? target;
  const label = text(raw.label ?? raw.title ?? raw.fieldLabel, field, MAX_TEXT_LENGTH);
  const rawId = identifier(raw.id ?? raw.changeId ?? raw.previewId);
  const fallbackId = `${target}:${field}`.slice(0, MAX_ID_LENGTH);
  const id = rawId ?? fallbackId;
  const status = !context.strictSchema && context.confirmed.has(target)
    ? QUICK_RECORD_DIFF_STATUS.CONFIRMED
    : normalizeItemStatus(raw.status);
  const policy = TARGET_POLICIES[target] ?? null;
  const rawMode = identifier(raw.confirmationMode);
  const confirmationMode = rawMode ?? policy?.confirmationMode ?? null;
  const bulkEligible = typeof raw.bulkEligible === "boolean"
    ? raw.bulkEligible
    : legacyBatchPermission(raw);
  const identity = digest(raw.identity);
  const entityId = identifier(raw.entityId);
  const entityVersion = rawEntityVersion(raw, target, context.targetVersions);
  const before = previewValue(firstOwn(raw, ["before", "from", "previous", "current"]));
  const after = previewValue(firstOwn(raw, ["after", "to", "next", "proposed"]));
  const rawEvidenceKeys = Array.isArray(raw.evidenceKeys) ? raw.evidenceKeys : [];
  const evidenceKeys = rawEvidenceKeys.map((key) => identifier(key));
  const evidenceKeysValid = rawEvidenceKeys.length > 0
    && rawEvidenceKeys.length <= MAX_EVIDENCE
    && evidenceKeys.every(Boolean)
    && new Set(evidenceKeys).size === evidenceKeys.length;
  const rawSourceRefs = Array.isArray(raw.sourceRefs) ? raw.sourceRefs : [];
  const projectedSourceRefs = rawSourceRefs.map((ref) => (
    isPlainObject(ref) && identifier(ref.type) && identifier(ref.id)
      ? { type: identifier(ref.type), id: identifier(ref.id) }
      : null
  ));
  const sourceRefKeys = projectedSourceRefs.map((ref) => (
    ref ? `${ref.type}\u0000${ref.id}` : null
  ));
  const sourceRefsValid = rawSourceRefs.length > 0
    && rawSourceRefs.length <= MAX_EVIDENCE
    && rawSourceRefs.every((ref) => (
      isPlainObject(ref)
      && Object.keys(ref).length === 2
      && Object.hasOwn(ref, "type")
      && Object.hasOwn(ref, "id")
    ))
    && sourceRefKeys.every(Boolean)
    && new Set(sourceRefKeys).size === sourceRefKeys.length;
  const confirmedAt = isoTimestamp(raw.confirmedAt);
  const confirmedByText = optionalText(raw.confirmedBy, MAX_ID_LENGTH);
  const confirmedBy = confirmedByText === null ? null : identifier(confirmedByText);
  const receiptResult = confirmationReceipt(raw.receipt, {
    entityId,
    field,
    entityVersion,
  });
  const receipt = receiptResult.value;
  const confirmationEvidenceAbsent = [raw.confirmedAt, raw.confirmedBy, raw.receipt]
    .every((value) => value === undefined || value === null || value === "");
  const confirmationEvidenceValid = raw.status === "confirmed"
    ? confirmedAt !== null
      && confirmedBy !== null
      && receipt !== null
    : confirmationEvidenceAbsent;
  const statusPolicyValid = rawMode === "explicit"
    || (["open", "completed"].includes(context.previewStatus) && raw.status === "pending")
    || (context.previewStatus === "cancelled" && raw.status === "cancelled");
  const contractValid = context.strictSchema
    && rawId !== null
    && identity !== null
    && entityId !== null
    && rawField !== null
    && text(raw.label, "", MAX_ID_LENGTH) !== ""
    && entityVersion !== null
    && policy !== null
    && policy.fields.includes(rawField)
    && rawMode === policy.confirmationMode
    && raw.bulkEligible === policy.bulkEligible
    && ["pending", "confirmed", "cancelled"].includes(raw.status)
    && statusPolicyValid
    && confirmationEvidenceValid
    && receiptResult.valid
    && before.valid
    && after.valid
    && evidenceKeysValid
    && sourceRefsValid;
  const isTemperature = temperatureSuggestion(raw, target, field, label);
  const confirmableCandidate = contractValid
    && status === QUICK_RECORD_DIFF_STATUS.PENDING
    && confirmationMode === "explicit";
  const batchCandidate = confirmableCandidate && bulkEligible === true && !isTemperature;
  return {
    id,
    identity,
    target,
    entityId,
    field,
    label,
    before: before.value,
    after: after.value,
    status,
    confirmedAt,
    confirmedBy,
    receipt,
    confirmationMode,
    bulkEligible,
    entityVersion,
    targetVersion: entityVersion,
    evidenceKeys: evidenceKeys.filter(Boolean),
    sourceRefs: projectedSourceRefs.filter(Boolean),
    temperatureSuggestion: isTemperature,
    requiresIndividualConfirmation: status === QUICK_RECORD_DIFF_STATUS.PENDING
      && confirmationMode === "independent",
    sourceIndex: index,
    _contractValid: contractValid,
    _confirmableCandidate: confirmableCandidate,
    _batchCandidate: batchCandidate,
  };
}

function hasDuplicateIds(items) {
  const ids = items.map((item) => item.id);
  return new Set(ids).size !== ids.length;
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
    canConfirmSelected: selectedIds.length === 1,
  };
}

export function normalizeQuickRecordDiffPreview(input = {}, options = {}) {
  const source = isPlainObject(input) ? input : {};
  const container = previewContainer(source);
  const strictSchema = container.schemaVersion === CONFIRMATION_SCHEMA_VERSION;
  const historyReadOnly = options.historyReadOnly === true;
  const rawStatus = Object.hasOwn(container, "status") ? container.status : source.status;
  const status = historyReadOnly
    ? QUICK_RECORD_DIFF_STATUS.HISTORY_READONLY
    : normalizePreviewStatus(rawStatus);
  const quickRecord = isPlainObject(source.quickRecord) ? source.quickRecord : {};
  const analysis = isPlainObject(source.analysis) ? source.analysis : {};
  const targetVersions = isPlainObject(source.targetVersions)
    ? source.targetVersions
    : isPlainObject(container.targetVersions)
      ? container.targetVersions
      : {};
  const context = {
    confirmed: confirmedTargets(source),
    previewStatus: rawStatus,
    strictSchema,
    targetVersions,
  };
  const sourceItems = previewItems(source, container);
  const rawItems = sourceItems.slice(0, MAX_ITEMS);
  const normalizedItems = rawItems
    .map((item, index) => normalizeItem(item, index, context))
    .filter(Boolean);

  const previewId = identifier(container.id ?? container.previewId);
  const suggestionIdentity = digest(container.identity ?? container.suggestionIdentity);
  const quickRecordId = identifier(
    container.quickRecordId ?? source.quickRecordId ?? quickRecord.id ?? source.id,
  );
  const quickRecordVersion = positiveInteger(
    container.quickRecordVersion ?? source.quickRecordVersion ?? quickRecord.version ?? source.version,
  );
  const quickRecordStatus = identifier(container.quickRecordStatus);
  const analysisVersionId = identifier(
    container.analysisVersionId ?? source.analysisVersionId ?? analysis.id,
  );
  const analysisStatus = identifier(container.analysisStatus);
  const revision = positiveInteger(container.revision);
  const summaryHash = digest(container.summaryHash ?? source.summaryHash);
  const evidenceHash = digest(container.evidenceHash ?? source.evidenceHash);
  const draftHash = digest(container.draftHash);
  const createdAt = isoTimestamp(container.createdAt);
  const updatedAt = isoTimestamp(container.updatedAt);
  const completedAt = isoTimestamp(container.completedAt);
  const cancelledAt = isoTimestamp(container.cancelledAt);
  const cancelledBy = container.cancelledBy === null ? null : identifier(container.cancelledBy);
  const rawDigest = text(source.previewDigest ?? container.previewDigest ?? source.digest, "", 64).toLowerCase();
  const previewDigest = SHA256.test(rawDigest) ? rawDigest : null;
  const terminalStateValid = rawStatus === "open"
    ? container.completedAt === null
      && container.cancelledAt === null
      && container.cancelledBy === null
      && normalizedItems.every((item) => item.status !== QUICK_RECORD_DIFF_STATUS.CANCELLED)
    : rawStatus === "completed"
      ? completedAt !== null
        && container.cancelledAt === null
        && container.cancelledBy === null
        && normalizedItems.every((item) => (
          item.status !== QUICK_RECORD_DIFF_STATUS.CANCELLED
          && !(item.confirmationMode === "explicit" && item.status === QUICK_RECORD_DIFF_STATUS.PENDING)
        ))
      : rawStatus === "cancelled"
        ? cancelledAt !== null
          && container.completedAt === null
          && cancelledBy !== null
          && normalizedItems.every((item) => item.status !== QUICK_RECORD_DIFF_STATUS.PENDING)
        : false;

  const confirmationContractValid = strictSchema
    && ["open", "completed", "cancelled"].includes(rawStatus)
    && previewId !== null
    && suggestionIdentity !== null
    && quickRecordId !== null
    && quickRecordVersion !== null
    && quickRecordStatus === "analyzed"
    && analysisVersionId !== null
    && analysisStatus === "ready_for_confirmation"
    && revision !== null
    && summaryHash !== null
    && evidenceHash !== null
    && draftHash !== null
    && createdAt !== null
    && updatedAt !== null
    && terminalStateValid
    && sourceItems.length <= MAX_ITEMS
    && rawItems.length > 0
    && normalizedItems.length === rawItems.length
    && normalizedItems.every((item) => item._contractValid)
    && !hasDuplicateIds(normalizedItems)
    && container.requiresHumanConfirmation === true
    && container.automaticWriteAllowed === false
    && typeof container.createdWithUnsavedChanges === "boolean"
    && typeof container.confirmationBlocked === "boolean"
    && container.confirmationBlocked === container.createdWithUnsavedChanges;

  const hasUnsavedDraftChanges = options.hasUnsavedDraftChanges === true
    || source.hasUnsavedDraftChanges === true
    || source.analysisDirty === true
    || source.createdWithUnsavedChanges === true
    || source.confirmationBlocked === true
    || container.hasUnsavedDraftChanges === true
    || container.analysisDirty === true
    || container.createdWithUnsavedChanges === true
    || container.confirmationBlocked === true;
  const blocker = hasUnsavedDraftChanges
    ? {
      code: "UNSAVED_DRAFT_CHANGES",
      message: "请先保存快速记录分析修改，再确认写入业务数据",
    }
    : !confirmationContractValid
      ? {
        code: "INVALID_CONFIRMATION_PREVIEW",
        message: "确认预览数据不完整，请重新生成后再操作",
      }
      : null;
  const blocked = blocker !== null;
  const readOnly = historyReadOnly
    || READ_ONLY_STATUSES.has(status)
    || !confirmationContractValid;
  const actionAllowed = !readOnly && !blocked;
  const requestedSelection = new Set(
    Array.isArray(options.selectedIds)
      ? options.selectedIds.map((id) => identifier(id)).filter(Boolean)
      : [],
  );
  const items = normalizedItems.map((item) => {
    const {
      _contractValid,
      _confirmableCandidate,
      _batchCandidate,
      ...visible
    } = item;
    const confirmable = actionAllowed && _confirmableCandidate;
    const batchConfirmable = actionAllowed && _batchCandidate;
    const selectable = confirmable;
    return {
      ...visible,
      confirmable,
      batchConfirmable,
      selectable,
      selected: selectable && requestedSelection.has(item.id),
    };
  });
  const selectedIds = items.filter((item) => item.selected).map((item) => item.id);
  const batchConfirmableIds = items.filter((item) => item.batchConfirmable).map((item) => item.id);

  return {
    schemaVersion: identifier(container.schemaVersion),
    previewId,
    suggestionIdentity,
    quickRecordId,
    quickRecordVersion,
    quickRecordStatus,
    analysisVersionId,
    analysisStatus,
    revision,
    summaryHash,
    evidenceHash,
    draftHash,
    createdAt,
    updatedAt,
    completedAt,
    cancelledAt,
    cancelledBy,
    previewDigest,
    status,
    readOnly,
    blocked,
    blocker,
    hasUnsavedDraftChanges,
    confirmationContractValid,
    requiresHumanConfirmation: true,
    items,
    selectedIds,
    batchConfirmableIds,
    canConfirmSelected: selectedIds.length === 1,
    canConfirmAll: batchConfirmableIds.length > 0,
  };
}

export function toggleQuickRecordDiffSelection(model, itemId) {
  if (!model || model.readOnly || model.blocked || !Array.isArray(model.items)) return model;
  const normalizedId = identifier(itemId);
  const item = model.items.find((candidate) => candidate.id === normalizedId);
  if (!item?.selectable) return model;
  const next = new Set(model.selectedIds);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  return selectedModel(model, next);
}

export function cancelQuickRecordDiffSelection(model, itemId) {
  if (!model || model.readOnly || model.blocked || !Array.isArray(model.selectedIds)) return model;
  const normalizedId = identifier(itemId);
  if (!normalizedId || !model.selectedIds.includes(normalizedId)) return model;
  return selectedModel(model, model.selectedIds.filter((id) => id !== normalizedId));
}

export function selectAllQuickRecordDiffItems(model) {
  if (!model || model.readOnly || model.blocked || !Array.isArray(model.items)) return model;
  return selectedModel(
    model,
    model.items.filter((item) => item.batchConfirmable).map((item) => item.id),
  );
}

export function clearQuickRecordDiffSelection(model) {
  if (!model || !Array.isArray(model.selectedIds) || model.selectedIds.length === 0) return model;
  return selectedModel(model, []);
}

function confirmationPins(model) {
  if (
    !model?.confirmationContractValid
    || model.readOnly
    || model.blocked
    || model.status !== QUICK_RECORD_DIFF_STATUS.PENDING
    || !identifier(model.previewId)
    || !digest(model.suggestionIdentity)
    || positiveInteger(model.quickRecordVersion) === null
    || !identifier(model.analysisVersionId)
    || !digest(model.summaryHash)
    || !digest(model.evidenceHash)
  ) {
    return null;
  }
  return {
    confirm: true,
    previewId: model.previewId,
    suggestionIdentity: model.suggestionIdentity,
    expectedQuickRecordVersion: model.quickRecordVersion,
    analysisVersionId: model.analysisVersionId,
    summaryHash: model.summaryHash,
    evidenceHash: model.evidenceHash,
  };
}

export function createQuickRecordDiffConfirmationPayload(
  model,
  { confirmAll = false, itemId = null } = {},
) {
  const pins = confirmationPins(model);
  if (!pins || !Array.isArray(model.items)) return null;
  if (confirmAll === true) {
    return model.items.some((item) => item.batchConfirmable) ? pins : null;
  }

  let normalizedItemId = identifier(itemId);
  if (!normalizedItemId) {
    if (!Array.isArray(model.selectedIds) || model.selectedIds.length !== 1) return null;
    [normalizedItemId] = model.selectedIds;
  }
  const item = model.items.find((candidate) => candidate.id === normalizedItemId);
  if (
    !item?.confirmable
    || item.status !== QUICK_RECORD_DIFF_STATUS.PENDING
    || item.confirmationMode !== "explicit"
    || !digest(item.identity)
  ) {
    return null;
  }
  return {
    ...pins,
    itemId: item.id,
    itemIdentity: item.identity,
  };
}

export function createQuickRecordDiffCancellationPayload(model) {
  if (
    !model?.confirmationContractValid
    || model.readOnly
    || model.status !== QUICK_RECORD_DIFF_STATUS.PENDING
    || !identifier(model.previewId)
    || !digest(model.suggestionIdentity)
  ) {
    return null;
  }
  return {
    cancel: true,
    previewId: model.previewId,
    suggestionIdentity: model.suggestionIdentity,
  };
}
