import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const SCHEMA_VERSION = "quick-record-confirmation-v2";
const MAX_ID = 200;
const MAX_TEXT = 2_000;
const MAX_JSON_BYTES = 40_000;
const MAX_ITEMS = 50;
const MAX_EVIDENCE = 50;
const MAX_DEPTH = 8;
const MAX_COLLECTION = 100;
const IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u;
const FIELD_PATH = /^[A-Za-z][A-Za-z0-9_.-]{0,199}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PREVIEW_STATUSES = new Set(["open", "completed", "cancelled"]);
const ITEM_STATUSES = new Set(["pending", "confirmed", "cancelled"]);
const CONFIRMATION_REQUEST_MODES = new Set(["item", "all"]);
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CONFIRMABLE_QUICK_RECORD_STATUS = "analyzed";
const CONFIRMABLE_ANALYSIS_STATUS = "ready_for_confirmation";
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

export class QuickRecordConfirmationError extends Error {
  constructor(code, message, { status = 400, details = null } = {}) {
    super(message);
    this.name = "QuickRecordConfirmationError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

class ConfirmationConflict extends Error {
  constructor(reason, details = null) {
    super(reason);
    this.name = "ConfirmationConflict";
    this.reason = reason;
    this.details = details;
  }
}

function fail(code, message, options) {
  throw new QuickRecordConfirmationError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requiredText(value, name, max = MAX_TEXT, code = "INVALID_INPUT", status = 400) {
  if (typeof value !== "string" || !value.trim()) {
    fail(code, `${name} is required`, { status });
  }
  const normalized = value.trim();
  if (
    normalized.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    fail(code, `${name} is invalid`, { status });
  }
  return normalized;
}

function optionalText(value, name, max = MAX_TEXT, code = "INVALID_INPUT", status = 400) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, max, code, status);
}

function identifier(value, name, code = "INVALID_INPUT", status = 400) {
  const normalized = requiredText(value, name, MAX_ID, code, status);
  if (!IDENTIFIER.test(normalized) || normalized.startsWith("synthetic:")) {
    fail(code, `${name} is invalid`, { status });
  }
  return normalized;
}

function fieldPath(value, name, code = "DRAFT_DATA_INVALID", status = 500) {
  const normalized = requiredText(value, name, MAX_ID, code, status);
  if (!FIELD_PATH.test(normalized)) fail(code, `${name} is invalid`, { status });
  return normalized;
}

function positiveInteger(value, name, code = "INVALID_INPUT", status = 400) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(code, `${name} must be a positive integer`, { status });
  }
  return value;
}

function isoDate(value, name, { required = false, code = "PREVIEW_DATA_INVALID", status = 500 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(code, `${name} is required`, { status });
    return null;
  }
  const parsed = typeof value === "string" || value instanceof Date ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) fail(code, `${name} is invalid`, { status });
  return parsed.toISOString();
}

function clockDate(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return new Date(value);
}

function safeJson(value, name, {
  code = "DRAFT_DATA_INVALID",
  status = 500,
  depth = 0,
  seen = new Set(),
} = {}) {
  if (depth > MAX_DEPTH) fail(code, `${name} is too deeply nested`, { status });
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      fail(code, `${name} contains an invalid number`, { status });
    }
    return value;
  }
  if (typeof value === "string") {
    if (
      value.length > MAX_TEXT
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
    ) {
      fail(code, `${name} contains invalid text`, { status });
    }
    return value;
  }
  if (typeof value !== "object" || value === undefined) {
    fail(code, `${name} must be safe JSON`, { status });
  }
  if (seen.has(value)) fail(code, `${name} must not be cyclic`, { status });
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION) fail(code, `${name} is too large`, { status });
      return value.map((entry, index) => safeJson(entry, `${name}[${index}]`, {
        code, status, depth: depth + 1, seen,
      }));
    }
    if (!isPlainObject(value)) fail(code, `${name} must be a plain JSON object`, { status });
    const keys = Object.keys(value);
    if (keys.length > MAX_COLLECTION) fail(code, `${name} is too large`, { status });
    const result = {};
    for (const key of keys) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) fail(code, `${name} contains a forbidden key`, { status });
      result[key] = safeJson(value[key], `${name}.${key}`, {
        code, status, depth: depth + 1, seen,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  const encoded = JSON.stringify(canonicalValue(value));
  if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) {
    throw new TypeError("confirmation JSON value is not bounded and serializable");
  }
  return encoded;
}

function digest(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function sameDigest(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !SHA256.test(left) || !SHA256.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function digestInput(value, name) {
  const normalized = requiredText(value, name, 64);
  if (!SHA256.test(normalized)) fail("INVALID_INPUT", `${name} must be a SHA-256 digest`);
  return normalized;
}

function sourceRef(raw, name, code = "DRAFT_DATA_INVALID", status = 500) {
  if (!isPlainObject(raw)) fail(code, `${name} is invalid`, { status });
  return {
    type: identifier(raw.type, `${name}.type`, code, status),
    id: identifier(raw.id, `${name}.id`, code, status),
  };
}

function normalizeEvidence(rawEvidence, code = "DRAFT_DATA_INVALID") {
  if (!Array.isArray(rawEvidence) || rawEvidence.length < 1 || rawEvidence.length > MAX_EVIDENCE) {
    fail(code, "analysis.evidence must contain bounded saved evidence", { status: 500 });
  }
  const keys = new Set();
  return rawEvidence.map((raw, index) => {
    if (!isPlainObject(raw)) fail(code, `analysis.evidence[${index}] is invalid`, { status: 500 });
    const key = identifier(raw.key, `analysis.evidence[${index}].key`, code, 500);
    if (keys.has(key)) fail(code, `analysis.evidence[${index}].key is duplicated`, { status: 500 });
    keys.add(key);
    return {
      key,
      label: optionalText(raw.label, `analysis.evidence[${index}].label`, 200, code, 500) ?? key,
      value: safeJson(raw.value, `analysis.evidence[${index}].value`, { code, status: 500 }),
      sourceRef: sourceRef(raw.sourceRef, `analysis.evidence[${index}].sourceRef`, code, 500),
    };
  });
}

function policyFor(target, field, code = "DRAFT_DATA_INVALID") {
  const policy = TARGET_POLICIES[target];
  if (!policy) fail(code, `Unsupported confirmation target: ${target}`, { status: 500 });
  if (!policy.fields.includes(field)) {
    fail(code, `Unsupported confirmation field: ${target}.${field}`, { status: 500 });
  }
  return policy;
}

function changeSeed(item) {
  return {
    id: item.id,
    target: item.target,
    entityId: item.entityId,
    field: item.field,
    label: item.label,
    before: item.before,
    after: item.after,
    entityVersion: item.entityVersion,
    evidenceKeys: item.evidenceKeys,
  };
}

function normalizeChanges(rawChanges, evidence, code = "DRAFT_DATA_INVALID") {
  if (!Array.isArray(rawChanges) || rawChanges.length < 1 || rawChanges.length > MAX_ITEMS) {
    fail(code, "analysis.changes must contain bounded preview items", { status: 500 });
  }
  const evidenceByKey = new Map(evidence.map((item) => [item.key, item]));
  const ids = new Set();
  const locations = new Set();
  return rawChanges.map((raw, index) => {
    if (!isPlainObject(raw)) fail(code, `analysis.changes[${index}] is invalid`, { status: 500 });
    const id = identifier(raw.id, `analysis.changes[${index}].id`, code, 500);
    if (ids.has(id)) fail(code, `analysis.changes[${index}].id is duplicated`, { status: 500 });
    ids.add(id);
    const target = identifier(raw.target, `analysis.changes[${index}].target`, code, 500);
    const entityId = identifier(raw.entityId, `analysis.changes[${index}].entityId`, code, 500);
    const field = fieldPath(raw.field, `analysis.changes[${index}].field`, code, 500);
    const policy = policyFor(target, field, code);
    const location = `${target}\u0000${entityId}\u0000${field}`;
    if (locations.has(location)) fail(code, `analysis.changes[${index}] duplicates a target field`, { status: 500 });
    locations.add(location);
    const before = safeJson(raw.before, `analysis.changes[${index}].before`, { code, status: 500 });
    const after = safeJson(raw.after, `analysis.changes[${index}].after`, { code, status: 500 });
    if (digest(before) === digest(after)) fail(code, `analysis.changes[${index}] is a no-op`, { status: 500 });
    if (!Array.isArray(raw.evidenceKeys) || raw.evidenceKeys.length < 1 || raw.evidenceKeys.length > MAX_EVIDENCE) {
      fail(code, `analysis.changes[${index}].evidenceKeys is invalid`, { status: 500 });
    }
    const evidenceKeys = [...new Set(raw.evidenceKeys.map((key, evidenceIndex) => (
      identifier(key, `analysis.changes[${index}].evidenceKeys[${evidenceIndex}]`, code, 500)
    )))];
    if (evidenceKeys.some((key) => !evidenceByKey.has(key))) {
      fail(code, `analysis.changes[${index}] references unknown evidence`, { status: 500 });
    }
    const sourceRefs = [];
    const seenRefs = new Set();
    for (const key of evidenceKeys) {
      const ref = evidenceByKey.get(key).sourceRef;
      const refKey = `${ref.type}\u0000${ref.id}`;
      if (seenRefs.has(refKey)) continue;
      seenRefs.add(refKey);
      sourceRefs.push(clone(ref));
    }
    return {
      id,
      target,
      entityId,
      field,
      label: optionalText(raw.label, `analysis.changes[${index}].label`, 200, code, 500) ?? field,
      before,
      after,
      entityVersion: positiveInteger(raw.entityVersion, `analysis.changes[${index}].entityVersion`, code, 500),
      evidenceKeys,
      sourceRefs,
      confirmationMode: policy.confirmationMode,
      bulkEligible: policy.bulkEligible,
    };
  });
}

function draftPayload(draft) {
  return {
    quickRecordId: draft.quickRecord.id,
    quickRecordVersion: draft.quickRecord.version,
    quickRecordStatus: draft.quickRecord.status,
    analysisVersionId: draft.analysis.id,
    analysisStatus: draft.analysis.status,
    summaryHash: draft.summaryHash,
    evidenceHash: draft.evidenceHash,
    changes: draft.changes.map(changeSeed),
  };
}

function normalizeDraft(raw, { owner, quickRecordId } = {}) {
  if (!isPlainObject(raw) || raw.owner !== owner) return null;
  if (typeof raw.hasUnsavedChanges !== "boolean") {
    fail("DRAFT_DATA_INVALID", "hasUnsavedChanges must be a boolean", { status: 500 });
  }
  if (!isPlainObject(raw.quickRecord) || raw.quickRecord.owner !== owner) return null;
  const recordId = identifier(raw.quickRecord.id, "quickRecord.id", "DRAFT_DATA_INVALID", 500);
  if (recordId !== quickRecordId || raw.quickRecord.voidedAt) return null;
  const quickRecord = {
    id: recordId,
    owner,
    version: positiveInteger(raw.quickRecord.version, "quickRecord.version", "DRAFT_DATA_INVALID", 500),
    status: identifier(raw.quickRecord.status, "quickRecord.status", "DRAFT_DATA_INVALID", 500),
  };
  if (!isPlainObject(raw.analysis)) {
    fail("DRAFT_DATA_INVALID", "A saved analysis is required", { status: 500 });
  }
  const analysisId = identifier(raw.analysis.id, "analysis.id", "DRAFT_DATA_INVALID", 500);
  const analysisStatus = identifier(raw.analysis.status, "analysis.status", "DRAFT_DATA_INVALID", 500);
  const summary = safeJson(raw.analysis.summary, "analysis.summary", {
    code: "DRAFT_DATA_INVALID",
    status: 500,
  });
  if (!isPlainObject(summary) || Object.keys(summary).length < 1) {
    fail("DRAFT_DATA_INVALID", "analysis.summary must be a non-empty object", { status: 500 });
  }
  const evidence = normalizeEvidence(raw.analysis.evidence);
  const changes = normalizeChanges(raw.analysis.changes, evidence);
  const draft = {
    owner,
    hasUnsavedChanges: raw.hasUnsavedChanges,
    quickRecord,
    analysis: { id: analysisId, status: analysisStatus },
    summary,
    evidence,
    changes,
    summaryHash: digest(summary),
    evidenceHash: digest(evidence),
    draftHash: null,
  };
  draft.draftHash = digest(draftPayload(draft));
  return draft;
}

function assertDraftConfirmable(draft) {
  if (draft.quickRecord.status !== CONFIRMABLE_QUICK_RECORD_STATUS) {
    fail("QUICK_RECORD_NOT_CONFIRMABLE", "The quick record is not in a confirmable state", {
      status: 409,
      details: { currentStatus: draft.quickRecord.status },
    });
  }
  if (draft.analysis.status !== CONFIRMABLE_ANALYSIS_STATUS) {
    fail("ANALYSIS_NOT_CONFIRMABLE", "The analysis is not in a confirmable state", {
      status: 409,
      details: { currentStatus: draft.analysis.status },
    });
  }
}

function draftStateConflict(draft) {
  if (draft.quickRecord.status !== CONFIRMABLE_QUICK_RECORD_STATUS) {
    return {
      conflict: "quick_record_not_confirmable",
      details: { currentStatus: draft.quickRecord.status },
    };
  }
  if (draft.analysis.status !== CONFIRMABLE_ANALYSIS_STATUS) {
    return {
      conflict: "analysis_not_confirmable",
      details: { currentStatus: draft.analysis.status },
    };
  }
  return null;
}

function itemIdentityPayload(item, context) {
  return {
    schemaVersion: SCHEMA_VERSION,
    previewId: context.previewId,
    owner: context.owner,
    quickRecordId: context.quickRecordId,
    analysisVersionId: context.analysisVersionId,
    ...changeSeed(item),
    confirmationMode: item.confirmationMode,
    bulkEligible: item.bulkEligible,
    status: item.status,
    confirmedAt: item.confirmedAt,
    confirmedBy: item.confirmedBy,
    receipt: item.receipt,
    confirmationRequest: item.confirmationRequest,
  };
}

function previewIdentityPayload(preview) {
  return {
    schemaVersion: preview.schemaVersion,
    id: preview.id,
    owner: preview.owner,
    quickRecordId: preview.quickRecordId,
    quickRecordVersion: preview.quickRecordVersion,
    quickRecordStatus: preview.quickRecordStatus,
    analysisVersionId: preview.analysisVersionId,
    analysisStatus: preview.analysisStatus,
    summaryHash: preview.summaryHash,
    evidenceHash: preview.evidenceHash,
    draftHash: preview.draftHash,
    status: preview.status,
    revision: preview.revision,
    itemIdentities: preview.items.map((item) => item.identity),
    requiresHumanConfirmation: preview.requiresHumanConfirmation,
    automaticWriteAllowed: preview.automaticWriteAllowed,
    createdWithUnsavedChanges: preview.createdWithUnsavedChanges,
    createdAt: preview.createdAt,
    updatedAt: preview.updatedAt,
    completedAt: preview.completedAt,
    cancelledAt: preview.cancelledAt,
    cancelledBy: preview.cancelledBy,
    cancellationRequestIdentity: preview.cancellationRequestIdentity,
  };
}

function refreshIdentities(preview) {
  for (const item of preview.items) {
    item.identity = digest(itemIdentityPayload(item, {
      previewId: preview.id,
      owner: preview.owner,
      quickRecordId: preview.quickRecordId,
      analysisVersionId: preview.analysisVersionId,
    }));
  }
  preview.identity = digest(previewIdentityPayload(preview));
  return preview;
}

function previewDraftHash(preview) {
  return digest({
    quickRecordId: preview.quickRecordId,
    quickRecordVersion: preview.quickRecordVersion,
    quickRecordStatus: preview.quickRecordStatus,
    analysisVersionId: preview.analysisVersionId,
    analysisStatus: preview.analysisStatus,
    summaryHash: preview.summaryHash,
    evidenceHash: preview.evidenceHash,
    changes: preview.items.map(changeSeed),
  });
}

function normalizeStoredReceipt(raw, item, index) {
  if (!isPlainObject(raw)) {
    fail("PREVIEW_DATA_INVALID", "Stored confirmation receipt is invalid", { status: 500 });
  }
  const keys = Object.keys(raw).sort();
  if (keys.length !== 3 || keys[0] !== "entityId" || keys[1] !== "field" || keys[2] !== "version") {
    fail("PREVIEW_DATA_INVALID", "Stored confirmation receipt shape is invalid", { status: 500 });
  }
  const receipt = {
    entityId: identifier(
      raw.entityId,
      `preview.items[${index}].receipt.entityId`,
      "PREVIEW_DATA_INVALID",
      500,
    ),
    field: fieldPath(
      raw.field,
      `preview.items[${index}].receipt.field`,
      "PREVIEW_DATA_INVALID",
      500,
    ),
    version: positiveInteger(
      raw.version,
      `preview.items[${index}].receipt.version`,
      "PREVIEW_DATA_INVALID",
      500,
    ),
  };
  if (
    receipt.entityId !== item.entityId
    || receipt.field !== item.field
    || receipt.version <= item.entityVersion
  ) {
    fail("PREVIEW_DATA_INVALID", "Stored confirmation receipt does not match its item", { status: 500 });
  }
  return receipt;
}

function normalizeStoredPreview(raw, { owner = null } = {}) {
  if (!isPlainObject(raw)) fail("PREVIEW_DATA_INVALID", "Stored confirmation preview is invalid", { status: 500 });
  if (owner !== null && raw.owner !== owner) return null;
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    fail("PREVIEW_DATA_INVALID", "Stored confirmation preview schema is invalid", { status: 500 });
  }
  const preview = clone(raw);
  preview.id = identifier(preview.id, "preview.id", "PREVIEW_DATA_INVALID", 500);
  preview.owner = identifier(preview.owner, "preview.owner", "PREVIEW_DATA_INVALID", 500);
  preview.quickRecordId = identifier(preview.quickRecordId, "preview.quickRecordId", "PREVIEW_DATA_INVALID", 500);
  preview.quickRecordVersion = positiveInteger(
    preview.quickRecordVersion,
    "preview.quickRecordVersion",
    "PREVIEW_DATA_INVALID",
    500,
  );
  preview.quickRecordStatus = identifier(
    preview.quickRecordStatus,
    "preview.quickRecordStatus",
    "PREVIEW_DATA_INVALID",
    500,
  );
  if (preview.quickRecordStatus !== CONFIRMABLE_QUICK_RECORD_STATUS) {
    fail("PREVIEW_DATA_INVALID", "Stored quick-record state is not confirmable", { status: 500 });
  }
  preview.analysisVersionId = identifier(
    preview.analysisVersionId,
    "preview.analysisVersionId",
    "PREVIEW_DATA_INVALID",
    500,
  );
  preview.analysisStatus = identifier(
    preview.analysisStatus,
    "preview.analysisStatus",
    "PREVIEW_DATA_INVALID",
    500,
  );
  if (preview.analysisStatus !== CONFIRMABLE_ANALYSIS_STATUS) {
    fail("PREVIEW_DATA_INVALID", "Stored analysis state is not confirmable", { status: 500 });
  }
  preview.revision = positiveInteger(preview.revision, "preview.revision", "PREVIEW_DATA_INVALID", 500);
  preview.createdAt = isoDate(preview.createdAt, "preview.createdAt", { required: true });
  preview.updatedAt = isoDate(preview.updatedAt, "preview.updatedAt", { required: true });
  preview.cancelledAt = isoDate(preview.cancelledAt, "preview.cancelledAt");
  preview.completedAt = isoDate(preview.completedAt, "preview.completedAt");
  preview.cancelledBy = optionalText(
    preview.cancelledBy,
    "preview.cancelledBy",
    MAX_ID,
    "PREVIEW_DATA_INVALID",
    500,
  );
  if (preview.cancelledBy !== null) {
    preview.cancelledBy = identifier(
      preview.cancelledBy,
      "preview.cancelledBy",
      "PREVIEW_DATA_INVALID",
      500,
    );
  }
  preview.cancellationRequestIdentity = preview.cancellationRequestIdentity === null
    || preview.cancellationRequestIdentity === undefined
    ? null
    : String(preview.cancellationRequestIdentity);
  if (
    preview.cancellationRequestIdentity !== null
    && !SHA256.test(preview.cancellationRequestIdentity)
  ) {
    fail("PREVIEW_DATA_INVALID", "Stored cancellation request identity is invalid", { status: 500 });
  }
  if (!PREVIEW_STATUSES.has(preview.status)) {
    fail("PREVIEW_DATA_INVALID", "Stored confirmation preview status is invalid", { status: 500 });
  }
  if (typeof preview.createdWithUnsavedChanges !== "boolean") {
    fail("PREVIEW_DATA_INVALID", "Stored draft-state marker is invalid", { status: 500 });
  }
  if (preview.requiresHumanConfirmation !== true || preview.automaticWriteAllowed !== false) {
    fail("PREVIEW_DATA_INVALID", "Stored confirmation safety markers are invalid", { status: 500 });
  }
  preview.summary = safeJson(preview.summary, "preview.summary", {
    code: "PREVIEW_DATA_INVALID",
    status: 500,
  });
  preview.evidence = normalizeEvidence(preview.evidence, "PREVIEW_DATA_INVALID");
  for (const field of ["summaryHash", "evidenceHash", "draftHash", "identity"]) {
    if (!SHA256.test(String(preview[field] ?? ""))) {
      fail("PREVIEW_DATA_INVALID", `Stored ${field} is invalid`, { status: 500 });
    }
  }
  if (digest(preview.summary) !== preview.summaryHash || digest(preview.evidence) !== preview.evidenceHash) {
    fail("PREVIEW_DATA_INVALID", "Stored preview content hash is invalid", { status: 500 });
  }
  if (!Array.isArray(preview.items) || preview.items.length < 1 || preview.items.length > MAX_ITEMS) {
    fail("PREVIEW_DATA_INVALID", "Stored preview items are invalid", { status: 500 });
  }
  const evidenceByKey = new Map(preview.evidence.map((item) => [item.key, item]));
  const itemIds = new Set();
  preview.items = preview.items.map((rawItem, index) => {
    if (!isPlainObject(rawItem)) fail("PREVIEW_DATA_INVALID", `preview.items[${index}] is invalid`, { status: 500 });
    const item = clone(rawItem);
    item.id = identifier(item.id, `preview.items[${index}].id`, "PREVIEW_DATA_INVALID", 500);
    if (itemIds.has(item.id)) fail("PREVIEW_DATA_INVALID", "Stored preview item id is duplicated", { status: 500 });
    itemIds.add(item.id);
    item.target = identifier(item.target, `preview.items[${index}].target`, "PREVIEW_DATA_INVALID", 500);
    item.entityId = identifier(item.entityId, `preview.items[${index}].entityId`, "PREVIEW_DATA_INVALID", 500);
    item.field = fieldPath(item.field, `preview.items[${index}].field`, "PREVIEW_DATA_INVALID", 500);
    const policy = policyFor(item.target, item.field, "PREVIEW_DATA_INVALID");
    item.label = requiredText(item.label, `preview.items[${index}].label`, 200, "PREVIEW_DATA_INVALID", 500);
    item.before = safeJson(item.before, `preview.items[${index}].before`, {
      code: "PREVIEW_DATA_INVALID",
      status: 500,
    });
    item.after = safeJson(item.after, `preview.items[${index}].after`, {
      code: "PREVIEW_DATA_INVALID",
      status: 500,
    });
    item.entityVersion = positiveInteger(
      item.entityVersion,
      `preview.items[${index}].entityVersion`,
      "PREVIEW_DATA_INVALID",
      500,
    );
    if (
      !Array.isArray(item.evidenceKeys)
      || item.evidenceKeys.length < 1
      || item.evidenceKeys.length > MAX_EVIDENCE
    ) {
      fail("PREVIEW_DATA_INVALID", "Stored preview evidence keys are invalid", { status: 500 });
    }
    const evidenceKeys = item.evidenceKeys.map((key, keyIndex) => (
      identifier(key, `preview.items[${index}].evidenceKeys[${keyIndex}]`, "PREVIEW_DATA_INVALID", 500)
    ));
    if (new Set(evidenceKeys).size !== evidenceKeys.length) {
      fail("PREVIEW_DATA_INVALID", "Stored preview evidence keys are duplicated", { status: 500 });
    }
    item.evidenceKeys = evidenceKeys;
    if (item.evidenceKeys.some((key) => !evidenceByKey.has(key))) {
      fail("PREVIEW_DATA_INVALID", "Stored preview item references unknown evidence", { status: 500 });
    }
    const expectedSourceRefs = [];
    const seen = new Set();
    for (const key of item.evidenceKeys) {
      const ref = evidenceByKey.get(key).sourceRef;
      const refKey = `${ref.type}\u0000${ref.id}`;
      if (!seen.has(refKey)) {
        seen.add(refKey);
        expectedSourceRefs.push(clone(ref));
      }
    }
    const storedSourceRefs = safeJson(item.sourceRefs, `preview.items[${index}].sourceRefs`, {
      code: "PREVIEW_DATA_INVALID",
      status: 500,
    });
    if (
      !Array.isArray(storedSourceRefs)
      || storedSourceRefs.length > MAX_EVIDENCE
      || digest(storedSourceRefs) !== digest(expectedSourceRefs)
    ) {
      fail("PREVIEW_DATA_INVALID", "Stored preview source references are invalid", { status: 500 });
    }
    item.sourceRefs = expectedSourceRefs;
    if (item.confirmationMode !== policy.confirmationMode || item.bulkEligible !== policy.bulkEligible) {
      fail("PREVIEW_DATA_INVALID", "Stored preview target policy is invalid", { status: 500 });
    }
    if (!ITEM_STATUSES.has(item.status)) {
      fail("PREVIEW_DATA_INVALID", "Stored preview item status is invalid", { status: 500 });
    }
    item.confirmedAt = isoDate(item.confirmedAt, `preview.items[${index}].confirmedAt`);
    item.confirmedBy = optionalText(
      item.confirmedBy,
      `preview.items[${index}].confirmedBy`,
      MAX_ID,
      "PREVIEW_DATA_INVALID",
      500,
    );
    if (item.confirmedBy !== null) {
      item.confirmedBy = identifier(
        item.confirmedBy,
        `preview.items[${index}].confirmedBy`,
        "PREVIEW_DATA_INVALID",
        500,
      );
    }
    item.receipt = item.receipt === null || item.receipt === undefined
      ? null
      : normalizeStoredReceipt(item.receipt, item, index);
    if (item.confirmationRequest === null || item.confirmationRequest === undefined) {
      item.confirmationRequest = null;
    } else {
      if (!isPlainObject(item.confirmationRequest)) {
        fail("PREVIEW_DATA_INVALID", "Stored confirmation request is invalid", { status: 500 });
      }
      const requestMode = requiredText(
        item.confirmationRequest.mode,
        `preview.items[${index}].confirmationRequest.mode`,
        20,
        "PREVIEW_DATA_INVALID",
        500,
      );
      if (!CONFIRMATION_REQUEST_MODES.has(requestMode)) {
        fail("PREVIEW_DATA_INVALID", "Stored confirmation request mode is invalid", { status: 500 });
      }
      const requestSuggestionIdentity = String(item.confirmationRequest.suggestionIdentity ?? "");
      const requestItemIdentity = String(item.confirmationRequest.itemIdentity ?? "");
      if (!SHA256.test(requestSuggestionIdentity) || !SHA256.test(requestItemIdentity)) {
        fail("PREVIEW_DATA_INVALID", "Stored confirmation request identity is invalid", { status: 500 });
      }
      item.confirmationRequest = {
        mode: requestMode,
        suggestionIdentity: requestSuggestionIdentity,
        itemIdentity: requestItemIdentity,
      };
    }
    if (item.status === "confirmed") {
      if (!item.confirmedAt || !item.confirmedBy || item.receipt === null || !item.confirmationRequest) {
        fail("PREVIEW_DATA_INVALID", "Confirmed preview item lacks confirmation evidence", { status: 500 });
      }
      if (item.confirmationMode !== "explicit") {
        fail("PREVIEW_DATA_INVALID", "Only explicit preview items can be confirmed", { status: 500 });
      }
      if (item.confirmationRequest.mode === "all" && item.bulkEligible !== true) {
        fail("PREVIEW_DATA_INVALID", "Stored bulk confirmation item is not eligible", { status: 500 });
      }
    } else if (
      item.confirmedAt !== null
      || item.confirmedBy !== null
      || item.receipt !== null
      || item.confirmationRequest !== null
    ) {
      fail("PREVIEW_DATA_INVALID", "Unconfirmed preview item has confirmation evidence", { status: 500 });
    }
    if (!SHA256.test(String(item.identity ?? ""))) {
      fail("PREVIEW_DATA_INVALID", "Stored preview item identity is invalid", { status: 500 });
    }
    const expectedIdentity = digest(itemIdentityPayload(item, {
      previewId: preview.id,
      owner: preview.owner,
      quickRecordId: preview.quickRecordId,
      analysisVersionId: preview.analysisVersionId,
    }));
    if (!sameDigest(item.identity, expectedIdentity)) {
      fail("PREVIEW_DATA_INVALID", "Stored preview item identity does not match", { status: 500 });
    }
    return item;
  });
  const bulkConfirmationItems = preview.items.filter((item) => item.confirmationRequest?.mode === "all");
  if (bulkConfirmationItems.length > 0) {
    const [firstBulkItem] = bulkConfirmationItems;
    if (
      preview.status !== "completed"
      || bulkConfirmationItems.some((item) => (
        !sameDigest(
          item.confirmationRequest.suggestionIdentity,
          firstBulkItem.confirmationRequest.suggestionIdentity,
        )
        || item.confirmedBy !== firstBulkItem.confirmedBy
        || item.confirmedAt !== firstBulkItem.confirmedAt
      ))
    ) {
      fail("PREVIEW_DATA_INVALID", "Stored bulk confirmation cohort is invalid", { status: 500 });
    }
  }
  if (preview.status === "open") {
    if (
      preview.completedAt !== null
      || preview.cancelledAt !== null
      || preview.cancelledBy !== null
      || preview.cancellationRequestIdentity !== null
    ) {
      fail("PREVIEW_DATA_INVALID", "Open confirmation preview has a terminal timestamp", { status: 500 });
    }
    if (preview.items.some((item) => item.status === "cancelled")) {
      fail("PREVIEW_DATA_INVALID", "Open confirmation preview has a cancelled item", { status: 500 });
    }
  }
  if (preview.status === "completed") {
    if (
      !preview.completedAt
      || preview.cancelledAt !== null
      || preview.cancelledBy !== null
      || preview.cancellationRequestIdentity !== null
    ) {
      fail("PREVIEW_DATA_INVALID", "Completed confirmation preview has invalid terminal state", { status: 500 });
    }
    if (preview.items.some((item) => item.status === "cancelled")) {
      fail("PREVIEW_DATA_INVALID", "Completed confirmation preview has a cancelled item", { status: 500 });
    }
    if (preview.items.some((item) => item.confirmationMode === "explicit" && item.status === "pending")) {
      fail("PREVIEW_DATA_INVALID", "Completed confirmation preview still has pending items", { status: 500 });
    }
  }
  if (preview.status === "cancelled") {
    if (
      !preview.cancelledAt
      || preview.completedAt !== null
      || !preview.cancelledBy
      || !preview.cancellationRequestIdentity
    ) {
      fail("PREVIEW_DATA_INVALID", "Cancelled confirmation preview has invalid terminal state", { status: 500 });
    }
    if (preview.items.some((item) => item.status === "pending")) {
      fail("PREVIEW_DATA_INVALID", "Cancelled confirmation preview still has pending items", { status: 500 });
    }
  }
  if (previewDraftHash(preview) !== preview.draftHash) {
    fail("PREVIEW_DATA_INVALID", "Stored preview draft hash is invalid", { status: 500 });
  }
  if (!sameDigest(preview.identity, digest(previewIdentityPayload(preview)))) {
    fail("PREVIEW_DATA_INVALID", "Stored preview identity does not match", { status: 500 });
  }
  return preview;
}

function effectivePreview(preview, { replayed = false } = {}) {
  const result = clone(preview);
  delete result.cancellationRequestIdentity;
  for (const item of result.items) delete item.confirmationRequest;
  result.replayed = replayed;
  result.confirmationBlocked = result.createdWithUnsavedChanges;
  result.bulkEligibleItemIds = result.items
    .filter((item) => item.bulkEligible && item.status === "pending")
    .map((item) => item.id);
  return result;
}

function unwrapItem(value) {
  return value?.item ?? value;
}

function assertRepository(repository, name, methods) {
  if (!repository || typeof repository !== "object") throw new TypeError(`${name} is required`);
  for (const method of methods) {
    if (typeof repository[method] !== "function") throw new TypeError(`${name}.${method} must be a function`);
  }
}

function assertSynchronous(value) {
  if (value && typeof value.then === "function") {
    throw new TypeError("runInTransaction must execute synchronous work");
  }
  return value;
}

function notFound() {
  fail("NOT_FOUND", "The quick-record confirmation preview was not found", { status: 404 });
}

function exclusionFor(item) {
  if (item.confirmationMode === "independent") {
    return { id: item.id, target: item.target, reason: "independent_confirmation_required" };
  }
  if (item.confirmationMode === "unsupported") {
    return { id: item.id, target: item.target, reason: "target_not_confirmable" };
  }
  return null;
}

function normalizeCurrent(raw, { owner, item }) {
  if (!isPlainObject(raw) || raw.owner !== owner) return null;
  const entityId = identifier(raw.entityId, "current.entityId", "WRITE_RESULT_INVALID", 500);
  const field = fieldPath(raw.field, "current.field", "WRITE_RESULT_INVALID", 500);
  if (entityId !== item.entityId || field !== item.field) return null;
  return {
    owner,
    entityId,
    field,
    version: positiveInteger(raw.version, "current.version", "WRITE_RESULT_INVALID", 500),
    value: safeJson(raw.value, "current.value", { code: "WRITE_RESULT_INVALID", status: 500 }),
  };
}

function redactedConflictDetails(rawCurrent, { owner, item }) {
  const details = { itemId: item.id };
  if (
    isPlainObject(rawCurrent)
    && rawCurrent.owner === owner
    && rawCurrent.entityId === item.entityId
    && rawCurrent.field === item.field
    && Number.isSafeInteger(rawCurrent.version)
    && rawCurrent.version > 0
  ) {
    details.currentVersion = rawCurrent.version;
  }
  return details;
}

function conflictResult(preview, reason, details = null) {
  return {
    status: "conflict",
    reason,
    details: details ? clone(details) : null,
    preview: effectivePreview(preview),
    confirmedItems: [],
    excludedItems: preview.items.map(exclusionFor).filter(Boolean),
    writeback: false,
    replayed: false,
  };
}

function assertAuditAcknowledgement(raw, message) {
  if (!isPlainObject(raw)) {
    fail("AUDIT_WRITE_INVALID", message, { status: 500 });
  }
  identifier(raw.id, "audit.id", "AUDIT_WRITE_INVALID", 500);
}

export function createQuickRecordConfirmationService({
  draftRepository,
  previewRepository,
  writeRepository,
  auditRepository,
  runInTransaction,
  resolveAuthenticatedActor,
  idFactory = randomUUID,
  clock = () => new Date(),
} = {}) {
  assertRepository(draftRepository, "draftRepository", ["get"]);
  assertRepository(previewRepository, "previewRepository", ["findByDraft", "create", "get", "replace"]);
  assertRepository(writeRepository, "writeRepository", ["read", "apply"]);
  assertRepository(auditRepository, "auditRepository", ["append"]);
  if (typeof runInTransaction !== "function") throw new TypeError("runInTransaction must be a function");
  if (typeof resolveAuthenticatedActor !== "function") {
    throw new TypeError("resolveAuthenticatedActor must be a function");
  }
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const transaction = (work) => assertSynchronous(runInTransaction(work));

  function loadPreview(ownerValue, previewIdValue) {
    const owner = identifier(ownerValue, "owner");
    const previewId = identifier(previewIdValue, "previewId");
    const raw = previewRepository.get({ owner, previewId });
    if (!raw) notFound();
    const preview = normalizeStoredPreview(unwrapItem(raw), { owner });
    if (!preview) notFound();
    return { owner, previewId, preview };
  }

  function preview({ owner: ownerValue, quickRecordId: quickRecordIdValue } = {}) {
    const owner = identifier(ownerValue, "owner");
    const quickRecordId = identifier(quickRecordIdValue, "quickRecordId");
    return transaction(() => {
      const rawDraft = draftRepository.get({ owner, quickRecordId });
      if (!rawDraft) notFound();
      const draft = normalizeDraft(rawDraft, { owner, quickRecordId });
      if (!draft) notFound();
      assertDraftConfirmable(draft);
      const existingRaw = previewRepository.findByDraft({
        owner,
        quickRecordId,
        draftHash: draft.draftHash,
      });
      if (existingRaw) {
        const existing = normalizeStoredPreview(unwrapItem(existingRaw), { owner });
        if (!existing || existing.draftHash !== draft.draftHash) {
          fail("PREVIEW_DATA_INVALID", "Stored preview replay is invalid", { status: 500 });
        }
        return effectivePreview(existing, { replayed: true });
      }
      const now = clockDate(clock).toISOString();
      const id = identifier(idFactory(), "generated preview id");
      const items = draft.changes.map((change) => {
        const item = {
          ...clone(change),
          identity: null,
          status: "pending",
          confirmedAt: null,
          confirmedBy: null,
          receipt: null,
          confirmationRequest: null,
        };
        item.identity = digest(itemIdentityPayload(item, {
          previewId: id,
          owner,
          quickRecordId,
          analysisVersionId: draft.analysis.id,
        }));
        return item;
      });
      const stored = {
        schemaVersion: SCHEMA_VERSION,
        id,
        identity: null,
        owner,
        status: "open",
        revision: 1,
        quickRecordId,
        quickRecordVersion: draft.quickRecord.version,
        quickRecordStatus: draft.quickRecord.status,
        analysisVersionId: draft.analysis.id,
        analysisStatus: draft.analysis.status,
        summary: clone(draft.summary),
        evidence: clone(draft.evidence),
        summaryHash: draft.summaryHash,
        evidenceHash: draft.evidenceHash,
        draftHash: draft.draftHash,
        items,
        requiresHumanConfirmation: true,
        automaticWriteAllowed: false,
        createdWithUnsavedChanges: draft.hasUnsavedChanges,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        cancelledAt: null,
        cancelledBy: null,
        cancellationRequestIdentity: null,
      };
      refreshIdentities(stored);
      const createdRaw = previewRepository.create(clone(stored));
      const created = normalizeStoredPreview(unwrapItem(createdRaw), { owner });
      if (!created || created.draftHash !== draft.draftHash) {
        fail("PREVIEW_DATA_INVALID", "Created confirmation preview is invalid", { status: 500 });
      }
      return effectivePreview(created, { replayed: createdRaw?.replayed === true });
    });
  }

  function get({ owner, previewId } = {}) {
    return effectivePreview(loadPreview(owner, previewId).preview);
  }

  function authenticatedActor(input, owner, code) {
    if (["confirmedBy", "cancelledBy"].some((field) => Object.hasOwn(input, field))) {
      fail(
        code,
        "Actor identity must be derived from authenticated context",
        { status: 403 },
      );
    }
    const resolvedActor = resolveAuthenticatedActor({ owner, actor: input.actor });
    if (resolvedActor && typeof resolvedActor.then === "function") {
      throw new TypeError("resolveAuthenticatedActor must execute synchronously");
    }
    if (
      !isPlainObject(resolvedActor)
      || resolvedActor.authenticated !== true
      || resolvedActor.owner !== owner
    ) {
      fail(code, "Authenticated actor is required", { status: 403 });
    }
    return {
      id: identifier(resolvedActor.id, "authenticatedActor.id", code, 403),
      owner,
    };
  }

  function parsePins(input) {
    const owner = identifier(input.owner, "owner");
    const actor = authenticatedActor(input, owner, "UNTRUSTED_CONFIRMATION_ACTOR");
    return {
      owner,
      previewId: identifier(input.previewId, "previewId"),
      suggestionIdentity: digestInput(input.suggestionIdentity, "suggestionIdentity"),
      expectedQuickRecordVersion: positiveInteger(
        input.expectedQuickRecordVersion,
        "expectedQuickRecordVersion",
      ),
      analysisVersionId: identifier(input.analysisVersionId, "analysisVersionId"),
      summaryHash: digestInput(input.summaryHash, "summaryHash"),
      evidenceHash: digestInput(input.evidenceHash, "evidenceHash"),
      actor,
    };
  }

  function assertPinnedInputs(preview, pins) {
    if (
      pins.expectedQuickRecordVersion !== preview.quickRecordVersion
      || pins.analysisVersionId !== preview.analysisVersionId
      || !sameDigest(pins.summaryHash, preview.summaryHash)
      || !sameDigest(pins.evidenceHash, preview.evidenceHash)
    ) {
      fail("PREVIEW_INPUT_MISMATCH", "The pinned preview inputs do not match", { status: 409 });
    }
  }

  function assertPins(preview, pins) {
    if (!sameDigest(preview.identity, pins.suggestionIdentity)) {
      fail("SUGGESTION_IDENTITY_MISMATCH", "The preview suggestion identity does not match", { status: 409 });
    }
    assertPinnedInputs(preview, pins);
  }

  function matchesConfirmationReplay(item, pins, { mode, itemIdentity = null } = {}) {
    const request = item.confirmationRequest;
    if (
      item.status !== "confirmed"
      || !request
      || request.mode !== mode
      || item.confirmedBy !== pins.actor.id
      || !sameDigest(request.suggestionIdentity, pins.suggestionIdentity)
    ) return false;
    return mode !== "item" || sameDigest(request.itemIdentity, itemIdentity);
  }

  function matchesBulkConfirmationReplay(preview, pins) {
    if (
      preview.status !== "completed"
      || preview.items.some((item) => (
        item.confirmationMode === "explicit" && item.bulkEligible && item.status === "pending"
      ))
    ) return false;
    const cohort = preview.items.filter((item) => item.confirmationRequest?.mode === "all");
    return cohort.length > 0 && cohort.every((item) => (
      item.status === "confirmed"
      && item.confirmedBy === pins.actor.id
      && sameDigest(item.confirmationRequest.suggestionIdentity, pins.suggestionIdentity)
    ));
  }

  function revalidateDraft(preview, owner) {
    const raw = draftRepository.get({ owner, quickRecordId: preview.quickRecordId });
    if (!raw) return { conflict: "quick_record_unavailable" };
    const draft = normalizeDraft(raw, { owner, quickRecordId: preview.quickRecordId });
    if (!draft) return { conflict: "quick_record_unavailable" };
    const stateConflict = draftStateConflict(draft);
    if (stateConflict) return stateConflict;
    if (draft.hasUnsavedChanges) {
      fail("UNSAVED_DRAFT_CHANGES", "Save or discard analysis draft edits before confirmation", { status: 409 });
    }
    if (draft.quickRecord.version !== preview.quickRecordVersion) {
      return { conflict: "quick_record_changed", details: { currentVersion: draft.quickRecord.version } };
    }
    if (draft.analysis.id !== preview.analysisVersionId) {
      return { conflict: "analysis_changed", details: { currentAnalysisVersionId: draft.analysis.id } };
    }
    if (
      !sameDigest(draft.summaryHash, preview.summaryHash)
      || !sameDigest(draft.evidenceHash, preview.evidenceHash)
      || !sameDigest(draft.draftHash, preview.draftHash)
    ) {
      return { conflict: "draft_changed" };
    }
    return { draft };
  }

  function execute(preview, owner, items, { mode, actor }) {
    for (const item of items) {
      const current = normalizeCurrent(writeRepository.read({ owner, item: clone(item) }), { owner, item });
      if (!current) throw new ConfirmationConflict("target_unavailable", { itemId: item.id });
      if (current.version !== item.entityVersion || digest(current.value) !== digest(item.before)) {
        throw new ConfirmationConflict("target_changed", {
          itemId: item.id,
          currentVersion: current.version,
        });
      }
    }

    const now = clockDate(clock).toISOString();
    const outcomes = [];
    const next = clone(preview);
    for (const item of items) {
      let rawResult;
      try {
        rawResult = writeRepository.apply({
          owner,
          item: clone(item),
          expectedVersion: item.entityVersion,
          expectedValue: clone(item.before),
          value: clone(item.after),
          previewId: preview.id,
          quickRecordId: preview.quickRecordId,
        });
      } catch (error) {
        if (error?.code === "VERSION_CONFLICT" || error?.code === "NOT_FOUND") {
          throw new ConfirmationConflict(
            error.code === "VERSION_CONFLICT" ? "target_changed" : "target_unavailable",
            { itemId: item.id },
          );
        }
        throw error;
      }
      if (rawResult?.conflict || rawResult?.notFound) {
        throw new ConfirmationConflict(
          rawResult.conflict ? "target_changed" : "target_unavailable",
          redactedConflictDetails(rawResult.current, { owner, item }),
        );
      }
      const updated = normalizeCurrent(unwrapItem(rawResult), { owner, item });
      if (
        !updated
        || updated.version <= item.entityVersion
        || digest(updated.value) !== digest(item.after)
      ) {
        fail("WRITE_RESULT_INVALID", "The confirmed write result is invalid", { status: 500 });
      }
      const receipt = {
        entityId: updated.entityId,
        field: updated.field,
        version: updated.version,
      };
      const nextItem = next.items.find((candidate) => candidate.id === item.id);
      nextItem.status = "confirmed";
      nextItem.confirmedAt = now;
      nextItem.confirmedBy = actor.id;
      nextItem.receipt = clone(receipt);
      nextItem.confirmationRequest = {
        mode,
        suggestionIdentity: preview.identity,
        itemIdentity: item.identity,
      };
      outcomes.push({
        id: item.id,
        target: item.target,
        before: clone(item.before),
        after: clone(item.after),
        entityVersionBefore: item.entityVersion,
        entityVersionAfter: updated.version,
        receipt: clone(receipt),
      });
    }
    next.updatedAt = now;
    if (!next.items.some((item) => item.confirmationMode === "explicit" && item.status === "pending")) {
      next.status = "completed";
      next.completedAt = now;
    }
    next.revision = preview.revision + 1;
    refreshIdentities(next);
    const replacedRaw = previewRepository.replace({
      owner,
      previewId: preview.id,
      identity: preview.identity,
      expectedRevision: preview.revision,
      item: clone(next),
    });
    if (!replacedRaw) {
      fail("PREVIEW_STATE_CONFLICT", "The confirmation preview changed during confirmation", { status: 409 });
    }
    const replaced = normalizeStoredPreview(unwrapItem(replacedRaw), { owner });
    if (
      !replaced
      || replaced.id !== next.id
      || replaced.revision !== next.revision
      || !sameDigest(replaced.identity, next.identity)
    ) {
      fail("PREVIEW_DATA_INVALID", "Updated confirmation preview is invalid", { status: 500 });
    }
    const excludedItems = replaced.items.map(exclusionFor).filter(Boolean);
    const auditRaw = auditRepository.append({
      action: "quick_record.confirmation",
      owner,
      quickRecordId: replaced.quickRecordId,
      quickRecordVersion: replaced.quickRecordVersion,
      analysisVersionId: replaced.analysisVersionId,
      previewId: replaced.id,
      previousSuggestionIdentity: preview.identity,
      suggestionIdentity: replaced.identity,
      mode,
      confirmedBy: actor.id,
      confirmedAt: now,
      itemIds: outcomes.map((item) => item.id),
      before: outcomes.map((item) => ({ id: item.id, value: clone(item.before), version: item.entityVersionBefore })),
      after: outcomes.map((item) => ({ id: item.id, value: clone(item.after), version: item.entityVersionAfter })),
      excludedTargets: excludedItems.map((item) => item.target),
    });
    assertAuditAcknowledgement(auditRaw, "Confirmation audit persistence failed");
    return {
      status: "confirmed",
      preview: effectivePreview(replaced),
      confirmedItems: outcomes,
      excludedItems,
      writeback: true,
      replayed: false,
    };
  }

  function confirmItem(input = {}) {
    if (input.confirm !== true) {
      fail("EXPLICIT_CONFIRMATION_REQUIRED", "An explicit confirm=true is required", { status: 409 });
    }
    const pins = parsePins(input);
    const itemId = identifier(input.itemId, "itemId");
    const itemIdentity = digestInput(input.itemIdentity, "itemIdentity");
    try {
      return transaction(() => {
        const loaded = loadPreview(pins.owner, pins.previewId);
        const preview = loaded.preview;
        const item = preview.items.find((candidate) => candidate.id === itemId);
        if (!item) notFound();
        if (matchesConfirmationReplay(item, pins, { mode: "item", itemIdentity })) {
          assertPinnedInputs(preview, pins);
          return {
            status: "confirmed",
            preview: effectivePreview(preview, { replayed: true }),
            confirmedItems: [],
            excludedItems: preview.items.map(exclusionFor).filter(Boolean),
            writeback: false,
            replayed: true,
          };
        }
        assertPins(preview, pins);
        if (!sameDigest(item.identity, itemIdentity)) {
          fail("ITEM_IDENTITY_MISMATCH", "The preview item identity does not match", { status: 409 });
        }
        if (item.status === "confirmed") {
          return {
            status: "confirmed",
            preview: effectivePreview(preview, { replayed: true }),
            confirmedItems: [],
            excludedItems: preview.items.map(exclusionFor).filter(Boolean),
            writeback: false,
            replayed: true,
          };
        }
        if (item.status === "cancelled" || preview.status === "cancelled") {
          return {
            status: "cancelled",
            preview: effectivePreview(preview, { replayed: true }),
            confirmedItems: [],
            excludedItems: preview.items.map(exclusionFor).filter(Boolean),
            writeback: false,
            replayed: true,
          };
        }
        if (item.confirmationMode === "independent") {
          fail(
            "INDEPENDENT_CONFIRMATION_REQUIRED",
            "Customer temperature must be confirmed through its independent confirmation flow",
            { status: 409 },
          );
        }
        if (item.confirmationMode !== "explicit") {
          fail("TARGET_NOT_CONFIRMABLE", "This preview target cannot be confirmed here", { status: 409 });
        }
        const currentDraft = revalidateDraft(preview, pins.owner);
        if (currentDraft.conflict) {
          return conflictResult(preview, currentDraft.conflict, currentDraft.details);
        }
        return execute(preview, pins.owner, [item], {
          mode: "item",
          actor: pins.actor,
        });
      });
    } catch (error) {
      if (!(error instanceof ConfirmationConflict)) throw error;
      const loaded = loadPreview(pins.owner, pins.previewId);
      return conflictResult(loaded.preview, error.reason, error.details);
    }
  }

  function confirmAll(input = {}) {
    if (input.confirm !== true) {
      fail("EXPLICIT_CONFIRMATION_REQUIRED", "An explicit confirm=true is required", { status: 409 });
    }
    const pins = parsePins(input);
    try {
      return transaction(() => {
        const loaded = loadPreview(pins.owner, pins.previewId);
        const preview = loaded.preview;
        if (matchesBulkConfirmationReplay(preview, pins)) {
          assertPinnedInputs(preview, pins);
          return {
            status: "confirmed",
            preview: effectivePreview(preview, { replayed: true }),
            confirmedItems: [],
            excludedItems: preview.items.map(exclusionFor).filter(Boolean),
            writeback: false,
            replayed: true,
          };
        }
        assertPins(preview, pins);
        if (preview.status === "cancelled") {
          return {
            status: "cancelled",
            preview: effectivePreview(preview, { replayed: true }),
            confirmedItems: [],
            excludedItems: preview.items.map(exclusionFor).filter(Boolean),
            writeback: false,
            replayed: true,
          };
        }
        const candidates = preview.items.filter((item) => (
          item.confirmationMode === "explicit" && item.bulkEligible && item.status === "pending"
        ));
        if (candidates.length === 0) {
          if (preview.status !== "completed") {
            fail("NO_BULK_CONFIRMABLE_ITEMS", "This open preview has no bulk-confirmable items", { status: 409 });
          }
          return {
            status: "confirmed",
            preview: effectivePreview(preview, { replayed: true }),
            confirmedItems: [],
            excludedItems: preview.items.map(exclusionFor).filter(Boolean),
            writeback: false,
            replayed: true,
          };
        }
        const currentDraft = revalidateDraft(preview, pins.owner);
        if (currentDraft.conflict) {
          return conflictResult(preview, currentDraft.conflict, currentDraft.details);
        }
        return execute(preview, pins.owner, candidates, {
          mode: "all",
          actor: pins.actor,
        });
      });
    } catch (error) {
      if (!(error instanceof ConfirmationConflict)) throw error;
      const loaded = loadPreview(pins.owner, pins.previewId);
      return conflictResult(loaded.preview, error.reason, error.details);
    }
  }

  function cancel(input = {}) {
    if (input.cancel !== true) {
      fail("EXPLICIT_CANCELLATION_REQUIRED", "An explicit cancel=true is required", { status: 409 });
    }
    const owner = identifier(input.owner, "owner");
    const actor = authenticatedActor(input, owner, "UNTRUSTED_CANCELLATION_ACTOR");
    const previewId = identifier(input.previewId, "previewId");
    const identity = digestInput(input.suggestionIdentity, "suggestionIdentity");
    return transaction(() => {
      const loaded = loadPreview(owner, previewId);
      const preview = loaded.preview;
      if (
        preview.status === "cancelled"
        && sameDigest(preview.cancellationRequestIdentity, identity)
      ) {
        if (preview.cancelledBy !== actor.id) {
          fail("CANCELLATION_ACTOR_MISMATCH", "The cancellation actor does not match", { status: 409 });
        }
        return effectivePreview(preview, { replayed: true });
      }
      if (!sameDigest(preview.identity, identity)) {
        fail("SUGGESTION_IDENTITY_MISMATCH", "The preview suggestion identity does not match", { status: 409 });
      }
      if (preview.status === "cancelled") {
        if (preview.cancelledBy !== actor.id) {
          fail("CANCELLATION_ACTOR_MISMATCH", "The cancellation actor does not match", { status: 409 });
        }
        return effectivePreview(preview, { replayed: true });
      }
      if (preview.status === "completed") return effectivePreview(preview, { replayed: true });
      const now = clockDate(clock).toISOString();
      const next = clone(preview);
      for (const item of next.items) {
        if (item.status === "pending") item.status = "cancelled";
      }
      next.status = "cancelled";
      next.cancelledAt = now;
      next.cancelledBy = actor.id;
      next.updatedAt = now;
      next.cancellationRequestIdentity = preview.identity;
      next.revision = preview.revision + 1;
      refreshIdentities(next);
      const replacedRaw = previewRepository.replace({
        owner,
        previewId,
        identity: preview.identity,
        expectedRevision: preview.revision,
        item: clone(next),
      });
      if (!replacedRaw) {
        fail("PREVIEW_STATE_CONFLICT", "The confirmation preview changed during cancellation", { status: 409 });
      }
      const replaced = normalizeStoredPreview(unwrapItem(replacedRaw), { owner });
      if (
        !replaced
        || replaced.id !== next.id
        || replaced.revision !== next.revision
        || !sameDigest(replaced.identity, next.identity)
      ) {
        fail("PREVIEW_DATA_INVALID", "Cancelled confirmation preview is invalid", { status: 500 });
      }
      const auditRaw = auditRepository.append({
        action: "quick_record.confirmation.cancelled",
        owner,
        quickRecordId: replaced.quickRecordId,
        quickRecordVersion: replaced.quickRecordVersion,
        analysisVersionId: replaced.analysisVersionId,
        previewId: replaced.id,
        previousSuggestionIdentity: preview.identity,
        suggestionIdentity: replaced.identity,
        cancelledBy: actor.id,
        cancelledAt: now,
        itemIds: preview.items.filter((item) => item.status === "pending").map((item) => item.id),
      });
      assertAuditAcknowledgement(auditRaw, "Cancellation audit persistence failed");
      return effectivePreview(replaced);
    });
  }

  return Object.freeze({ preview, get, confirmItem, confirmAll, cancel });
}

export { SCHEMA_VERSION as QUICK_RECORD_CONFIRMATION_SCHEMA_VERSION };
