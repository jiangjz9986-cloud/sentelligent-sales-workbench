import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { withImmediateTransaction } from "../db/transaction.js";

/**
 * v0.12.0 action/risk writeback boundary.
 *
 * The builder is deliberately independent from HTTP.  Callers can validate a
 * draft before opening a transaction, or pass the result to the service below
 * while already inside the caller's BEGIN IMMEDIATE block.
 */

export const WRITEBACK_SCHEMA_VERSION = "action-risk-writeback-v1";

export const ACTION_WRITEBACK_DEFAULTS = Object.freeze({
  assignee: "owner",
  due: null,
  priority: "中",
  status: "pending",
  expectedResult: null,
  sourceType: null,
  sourceId: null,
  sourceProactiveId: null,
  sourceRecordId: null,
  tone: "priority-derived",
  remindAt: null,
});

export const RISK_WRITEBACK_DEFAULTS = Object.freeze({
  assignee: "owner",
  due: null,
  severity: "中",
  score: 60,
  status: "open",
  expectedResult: null,
  sourceType: "opportunity",
  sourceId: null,
  sourceProactiveId: null,
  tone: "amber",
});

export const ACTION_WRITEBACK_COLUMN_MAP = Object.freeze({
  id: "id",
  customerId: "customer_id",
  opportunityId: "opportunity_id",
  title: "title",
  customer: "customer",
  reason: "reason",
  due: "due",
  assignee: "assignee",
  priority: "priority",
  status: "status",
  sourceRecordId: "source_record_id",
  tone: "tone",
  owner: "owner",
  remindAt: "remind_at",
  expectedResult: "expected_result",
  sourceType: "source_type",
  sourceId: "source_id",
  sourceProactiveId: "source_proactive_id",
  writebackDigest: "writeback_digest",
});

export const RISK_WRITEBACK_COLUMN_MAP = Object.freeze({
  id: "id",
  customerId: "customer_id",
  opportunityId: "opportunity_id",
  title: "title",
  target: "target",
  score: "score",
  severity: "severity",
  status: "status",
  evidence: "evidence",
  action: "action",
  assignee: "assignee",
  due: "due",
  sourceType: "source_type",
  sourceId: "source_id",
  tone: "tone",
  owner: "owner",
  expectedResult: "expected_result",
  sourceProactiveId: "source_proactive_id",
  writebackDigest: "writeback_digest",
});

const ACTION_CANONICAL_KEYS = Object.freeze(Object.keys(ACTION_WRITEBACK_COLUMN_MAP)
  .filter((key) => key !== "writebackDigest"));
const RISK_CANONICAL_KEYS = Object.freeze(Object.keys(RISK_WRITEBACK_COLUMN_MAP)
  .filter((key) => key !== "writebackDigest"));

const ACTION_STATUS_VALUES = new Set(["pending", "in_progress", "done", "deferred"]);
const RISK_STATUS_VALUES = new Set(["open", "accepted", "in_progress", "deferred", "closed"]);
const PRIORITY_ALIASES = new Map([
  ["高", "高"], ["中", "中"], ["低", "低"],
  ["high", "高"], ["medium", "中"], ["low", "低"],
]);
const SEVERITY_ALIASES = new Map([
  ["高", "高"], ["中", "中"], ["低", "低"],
  ["high", "高"], ["medium", "中"], ["low", "低"],
]);

const LIMITS = Object.freeze({
  id: 200,
  owner: 200,
  customerId: 200,
  opportunityId: 200,
  title: 500,
  actionTitle: 80,
  customer: 200,
  reason: 5_000,
  target: 500,
  evidence: 5_000,
  action: 5_000,
  due: 80,
  assignee: 200,
  priority: 20,
  severity: 20,
  status: 30,
  tone: 50,
  remindAt: 50,
  expectedResult: 500,
  sourceType: 100,
  sourceId: 200,
  sourceRecordId: 200,
  sourceProactiveId: 200,
});

export const ACTION_RISK_WRITEBACK_LIMITS = LIMITS;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const IDENTIFIER_CHARACTERS = /^[^\s\u0000-\u001f\u007f-\u009f]+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UNSET = Symbol("writeback-unset");

const RELATION_ALIASES = Object.freeze({
  owner: ["owner"],
  customerId: ["customerId", "customer_id"],
  opportunityId: ["opportunityId", "opportunity_id"],
});

const COMMON_FIELD_ALIASES = Object.freeze({
  id: ["id"],
  title: ["title"],
  due: ["due", "dueDate", "due_date"],
  assignee: ["assignee", "assigneeName", "assignee_name"],
  status: ["status"],
  expectedResult: ["expectedResult", "expectedOutcome", "result", "expected_result"],
  sourceType: ["sourceType", "source_type"],
  sourceId: ["sourceId", "source_id"],
  sourceProactiveId: ["sourceProactiveId", "source_proactive_id"],
  writebackDigest: ["writebackDigest", "writeback_digest"],
});

const ACTION_FIELD_ALIASES = Object.freeze({
  ...COMMON_FIELD_ALIASES,
  customer: ["customer", "customerName", "customer_name"],
  reason: ["reason"],
  priority: ["priority"],
  tone: ["tone"],
  remindAt: ["remindAt", "remind_at"],
  sourceRecordId: ["sourceRecordId", "source_record_id"],
});

const RISK_FIELD_ALIASES = Object.freeze({
  ...COMMON_FIELD_ALIASES,
  target: ["target"],
  score: ["score"],
  severity: ["severity"],
  evidence: ["evidence"],
  action: ["action"],
  tone: ["tone"],
});

const ENVELOPE_KEYS = new Set([
  "fields",
  "payload",
  "relationships",
  "relationship",
  "context",
  "existing",
  "current",
  "row",
  "mode",
  "expectedVersion",
  "expectedDigest",
  "expectedWritebackDigest",
  "withinTransaction",
  "requestId",
  "actor",
  "idempotencyKey",
  "kind",
]);

export class ActionRiskWritebackValidationError extends TypeError {
  constructor(message, fields = {}) {
    super(message);
    this.name = "ActionRiskWritebackValidationError";
    this.code = "ACTION_RISK_WRITEBACK_INVALID";
    this.status = 422;
    this.fields = fields;
  }
}

export class ActionRiskWritebackConflictError extends Error {
  constructor(code, message, fields = {}) {
    super(message);
    this.name = "ActionRiskWritebackConflictError";
    this.code = code;
    this.status = 409;
    this.fields = fields;
  }
}

export class ActionRiskWritebackNotFoundError extends Error {
  constructor(message = "The action or risk item was not found") {
    super(message);
    this.name = "ActionRiskWritebackNotFoundError";
    this.code = "ACTION_RISK_WRITEBACK_NOT_FOUND";
    this.status = 404;
  }
}

export class ActionRiskWritebackSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "ActionRiskWritebackSchemaError";
    this.code = "ACTION_RISK_WRITEBACK_SCHEMA_REQUIRED";
    this.status = 500;
  }
}

function failValidation(field, rule, message = "Action/risk writeback is invalid") {
  throw new ActionRiskWritebackValidationError(message, { [field]: rule });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function equivalentInputValue(left, right) {
  if ((left === undefined || left === null || left === "")
    && (right === undefined || right === null || right === "")) return true;
  return Object.is(left, right);
}

function stableJsonValue(value, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical writeback payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") {
    throw new TypeError("canonical writeback payload contains an unsupported value");
  }
  if (ancestors.has(value)) throw new TypeError("canonical writeback payload contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableJsonValue(item, ancestors)).join(",")}]`;
    }
    if (!isPlainObject(value)) throw new TypeError("canonical writeback payload must use plain objects");
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJsonValue(value[key], ancestors)}`
    )).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function stableWritebackJson(value) {
  return stableJsonValue(value, new Set());
}

function kindKeys(kind) {
  if (kind === "action") return ACTION_CANONICAL_KEYS;
  if (kind === "risk") return RISK_CANONICAL_KEYS;
  throw new TypeError("kind must be action or risk");
}

function columnMap(kind) {
  if (kind === "action") return ACTION_WRITEBACK_COLUMN_MAP;
  if (kind === "risk") return RISK_WRITEBACK_COLUMN_MAP;
  throw new TypeError("kind must be action or risk");
}

/**
 * Build the exact digest material.  `writebackDigest` is intentionally not
 * included: including the digest would make the hash recursive.  All other
 * final persisted business fields, including owner and relationships, are.
 */
export function canonicalizeWritebackPayload(kind, payload) {
  if (!isPlainObject(payload)) throw new TypeError("writeback payload must be an object");
  const normalized = {};
  for (const key of kindKeys(kind)) {
    normalized[key] = payload[key] === undefined ? null : payload[key];
  }
  return {
    schemaVersion: WRITEBACK_SCHEMA_VERSION,
    kind,
    payload: normalized,
  };
}

export function canonicalWritebackJson(kind, payload) {
  return stableWritebackJson(canonicalizeWritebackPayload(kind, payload));
}

export function computeWritebackDigest(kind, payload) {
  return createHash("sha256").update(canonicalWritebackJson(kind, payload), "utf8").digest("hex");
}

export const writebackDigest = computeWritebackDigest;

export function isWritebackDigest(value) {
  return typeof value === "string" && SHA256.test(value);
}

export function writebackDigestMatches(kind, payload, presented) {
  if (!isWritebackDigest(presented)) return false;
  const expected = computeWritebackDigest(kind, payload);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(presented, "hex"));
}

export function mapWritebackToColumns(kind, payload, digest = null) {
  if (!isPlainObject(payload)) throw new TypeError("writeback payload must be an object");
  const expectedDigest = digest ?? computeWritebackDigest(kind, payload);
  if (!isWritebackDigest(expectedDigest)) throw new TypeError("writebackDigest must be a SHA-256 digest");
  if (!writebackDigestMatches(kind, payload, expectedDigest)) {
    throw new TypeError("writebackDigest does not match the canonical writeback payload");
  }
  const columns = {};
  for (const [camel, snake] of Object.entries(columnMap(kind))) {
    columns[snake] = camel === "writebackDigest" ? expectedDigest : (payload[camel] ?? null);
  }
  return columns;
}

function normalizeText(value, field, max, { required = false, identifier = false } = {}) {
  if (value === UNSET) return UNSET;
  if (value === undefined) failValidation(field, "string", `${field} must be a string or null`);
  if (value === null || value === "") {
    if (required) failValidation(field, "required", `${field} is required`);
    return null;
  }
  if (typeof value !== "string") failValidation(field, "string", `${field} must be a string`);
  if (CONTROL_CHARACTERS.test(value)) failValidation(field, "control", `${field} contains control characters`);
  const normalized = value.trim();
  if (!normalized) {
    if (required) failValidation(field, "required", `${field} is required`);
    return null;
  }
  if (normalized.length > max) failValidation(field, "max", `${field} is too long`);
  if (identifier && !IDENTIFIER_CHARACTERS.test(normalized)) {
    failValidation(field, "identifier", `${field} must not contain whitespace`);
  }
  return normalized;
}

function normalizeRequiredText(value, field, max) {
  return normalizeText(value, field, max, { required: true });
}

function normalizeOptionalText(value, field, max) {
  return normalizeText(value, field, max);
}

function normalizeIdentifier(value, field, max) {
  return normalizeText(value, field, max, { identifier: true });
}

function normalizeRequiredIdentifier(value, field, max) {
  return normalizeText(value, field, max, { required: true, identifier: true });
}

function normalizeEnum(value, field, aliases, defaultValue = UNSET) {
  if (value === UNSET) {
    if (defaultValue === UNSET) failValidation(field, "required", `${field} is required`);
    return defaultValue;
  }
  if (typeof value !== "string") failValidation(field, "enum", `${field} is invalid`);
  if (CONTROL_CHARACTERS.test(value)) failValidation(field, "control", `${field} contains control characters`);
  const normalized = value.trim();
  const mapped = aliases.get(normalized) ?? aliases.get(normalized.toLowerCase());
  if (!mapped) failValidation(field, "enum", `${field} is invalid`);
  return mapped;
}

function normalizeStatus(value, field, values, defaultValue) {
  if (value === UNSET) return defaultValue;
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) {
    failValidation(field, "enum", `${field} is invalid`);
  }
  const normalized = value.trim();
  if (!values.has(normalized)) failValidation(field, "enum", `${field} is invalid`);
  return normalized;
}

function normalizeScore(value, field, defaultValue) {
  if (value === UNSET) return defaultValue;
  if (!Number.isSafeInteger(value)) failValidation(field, "integer", `${field} must be an integer`);
  if (value < 0 || value > 100) failValidation(field, "range", `${field} must be between 0 and 100`);
  return value;
}

function normalizeVersion(value) {
  if (value === UNSET || value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    failValidation("expectedVersion", "positive_integer", "expectedVersion must be a positive integer");
  }
  return value;
}

function normalizeMode(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value !== "create" && value !== "update") failValidation("mode", "enum", "mode must be create or update");
  return value;
}

function normalizeDigest(value, field = "writebackDigest") {
  if (!isWritebackDigest(value)) failValidation(field, "digest", `${field} must be a SHA-256 digest`);
  return value;
}

function aliasMap(kind) {
  const fields = kind === "action" ? ACTION_FIELD_ALIASES : RISK_FIELD_ALIASES;
  const result = new Map();
  for (const [canonical, aliases] of Object.entries(fields)) {
    for (const alias of aliases) result.set(alias, canonical);
  }
  return result;
}

const ACTION_ALIAS_MAP = aliasMap("action");
const RISK_ALIAS_MAP = aliasMap("risk");
const RELATION_ALIAS_MAP = new Map(
  Object.entries(RELATION_ALIASES).flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical])),
);

function addCandidate(map, key, value, path) {
  const current = map.get(key);
  if (current && !equivalentInputValue(current.value, value)) {
    failValidation(path, "conflict", `${path} was supplied more than once with different values`);
  }
  if (!current) map.set(key, { value, path });
}

function parseEnvelope(kind, input) {
  if (!isPlainObject(input)) failValidation("body", "object", "writeback input must be an object");

  const aliasLookup = kind === "action" ? ACTION_ALIAS_MAP : RISK_ALIAS_MAP;
  const nestedKeys = ["fields", "payload"].filter((key) => Object.hasOwn(input, key));
  if (nestedKeys.length > 1) failValidation("fields", "conflict", "fields and payload cannot both be supplied");
  const nestedKey = nestedKeys[0] ?? null;
  const nested = nestedKey ? input[nestedKey] : null;
  if (nestedKey && !isPlainObject(nested)) failValidation(nestedKey, "object", `${nestedKey} must be an object`);

  const provided = new Map();
  const relations = new Map();
  const unknown = {};
  const expectedDigest = new Map();

  const consume = (source, prefix, allowEnvelope) => {
    for (const [key, value] of Object.entries(source)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const relationKey = RELATION_ALIAS_MAP.get(key);
      if (relationKey) {
        addCandidate(relations, relationKey, value, path);
        continue;
      }
      const canonical = aliasLookup.get(key);
      if (canonical) {
        if (canonical === "writebackDigest") {
          addCandidate(expectedDigest, "writebackDigest", value, path);
        } else {
          addCandidate(provided, canonical, value, path);
        }
        continue;
      }
      if (allowEnvelope && ENVELOPE_KEYS.has(key)) continue;
      unknown[path] = "unknown";
    }
  };

  if (nestedKey) {
    consume(nested, nestedKey, false);
    // Permit a relation or an explicitly named field alongside fields/payload
    // for callers that keep identity in the envelope and edits in fields.
    consume(input, "", true);
  } else {
    consume(input, "", true);
  }

  for (const key of ["relationships", "relationship", "context"]) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (!isPlainObject(value)) failValidation(key, "object", `${key} must be an object`);
    for (const [relationKey, relationValue] of Object.entries(value)) {
      const canonical = RELATION_ALIAS_MAP.get(relationKey);
      if (!canonical) {
        unknown[`${key}.${relationKey}`] = "unknown";
        continue;
      }
      addCandidate(relations, canonical, relationValue, `${key}.${relationKey}`);
    }
  }

  for (const key of ["expectedDigest", "expectedWritebackDigest"]) {
    if (Object.hasOwn(input, key)) addCandidate(expectedDigest, "writebackDigest", input[key], key);
  }

  if (Object.keys(unknown).length > 0) {
    throw new ActionRiskWritebackValidationError("Unknown action/risk writeback field", unknown);
  }

  let existing = null;
  const rowCandidates = ["existing", "current", "row"].filter((key) => Object.hasOwn(input, key));
  if (rowCandidates.length > 1) failValidation("existing", "conflict", "only one existing row may be supplied");
  if (rowCandidates.length === 1) {
    existing = input[rowCandidates[0]];
    if (!isPlainObject(existing)) failValidation(rowCandidates[0], "object", `${rowCandidates[0]} must be an object`);
  }

  return {
    provided,
    relations,
    expectedDigest: expectedDigest.get("writebackDigest")?.value ?? UNSET,
    existing,
    mode: input.mode ?? null,
    expectedVersion: Object.hasOwn(input, "expectedVersion") ? input.expectedVersion : UNSET,
  };
}

function rowValue(row, camel, snake) {
  if (Object.hasOwn(row, camel)) return row[camel];
  if (snake && Object.hasOwn(row, snake)) return row[snake];
  return null;
}

export function actionWritebackFromRow(row) {
  if (!row) return null;
  const sourceRecordId = rowValue(row, "sourceRecordId", "source_record_id");
  const sourceType = rowValue(row, "sourceType", "source_type")
    ?? (sourceRecordId ? "quick_record" : null);
  const sourceId = rowValue(row, "sourceId", "source_id") ?? sourceRecordId;
  return {
    id: rowValue(row, "id"),
    owner: rowValue(row, "owner"),
    customerId: rowValue(row, "customerId", "customer_id"),
    opportunityId: rowValue(row, "opportunityId", "opportunity_id"),
    title: rowValue(row, "title"),
    customer: rowValue(row, "customer"),
    reason: rowValue(row, "reason"),
    due: rowValue(row, "due"),
    assignee: rowValue(row, "assignee"),
    priority: rowValue(row, "priority") ?? "中",
    status: rowValue(row, "status") ?? "pending",
    sourceRecordId,
    tone: rowValue(row, "tone"),
    remindAt: rowValue(row, "remindAt", "remind_at"),
    expectedResult: rowValue(row, "expectedResult", "expected_result"),
    sourceType,
    sourceId,
    sourceProactiveId: rowValue(row, "sourceProactiveId", "source_proactive_id"),
    writebackDigest: rowValue(row, "writebackDigest", "writeback_digest"),
  };
}

export function riskWritebackFromRow(row) {
  if (!row) return null;
  return {
    id: rowValue(row, "id"),
    owner: rowValue(row, "owner"),
    customerId: rowValue(row, "customerId", "customer_id"),
    opportunityId: rowValue(row, "opportunityId", "opportunity_id"),
    title: rowValue(row, "title"),
    target: rowValue(row, "target"),
    score: rowValue(row, "score") ?? 60,
    severity: rowValue(row, "severity") ?? "中",
    status: rowValue(row, "status") ?? "open",
    evidence: rowValue(row, "evidence"),
    action: rowValue(row, "action"),
    assignee: rowValue(row, "assignee"),
    due: rowValue(row, "due"),
    sourceType: rowValue(row, "sourceType", "source_type") ?? "opportunity",
    sourceId: rowValue(row, "sourceId", "source_id"),
    tone: rowValue(row, "tone") ?? "amber",
    expectedResult: rowValue(row, "expectedResult", "expected_result"),
    sourceProactiveId: rowValue(row, "sourceProactiveId", "source_proactive_id"),
    writebackDigest: rowValue(row, "writebackDigest", "writeback_digest"),
  };
}

function rowPayload(kind, row) {
  return kind === "action" ? actionWritebackFromRow(row) : riskWritebackFromRow(row);
}

function resolveRelationships(kind, parsed, base, { requireOwner = true } = {}) {
  const relation = {};
  for (const key of ["owner", "customerId", "opportunityId"]) {
    const candidate = parsed.relations.get(key);
    if (candidate) relation[key] = candidate.value;
    else if (base && Object.hasOwn(base, key)) relation[key] = base[key];
    else relation[key] = UNSET;
  }

  const normalizedOwner = relation.owner === UNSET
    ? (requireOwner ? normalizeRequiredIdentifier(null, "owner", LIMITS.owner) : null)
    : (requireOwner
      ? normalizeRequiredIdentifier(relation.owner, "owner", LIMITS.owner)
      : normalizeIdentifier(relation.owner, "owner", LIMITS.owner));
  const customerId = relation.customerId === UNSET
    ? null
    : normalizeIdentifier(relation.customerId, "customerId", LIMITS.customerId);
  const opportunityId = relation.opportunityId === UNSET
    ? null
    : normalizeIdentifier(relation.opportunityId, "opportunityId", LIMITS.opportunityId);
  return { owner: normalizedOwner, customerId, opportunityId };
}

function rawField(parsed, base, key) {
  if (parsed.provided.has(key)) return parsed.provided.get(key).value;
  if (base && Object.hasOwn(base, key)) return base[key];
  return UNSET;
}

function normalizeSource(kind, parsed, base, sourceDefaults, defaultsApplied) {
  const sourceTypeExplicit = parsed.provided.has("sourceType");
  const sourceIdExplicit = parsed.provided.has("sourceId");
  let sourceProactiveId = normalizeOptionalText(
    rawField(parsed, base, "sourceProactiveId"),
    "sourceProactiveId",
    LIMITS.sourceProactiveId,
  );
  if (sourceProactiveId === UNSET) {
    sourceProactiveId = null;
    defaultsApplied.push("sourceProactiveId");
  }

  let sourceType = normalizeOptionalText(
    rawField(parsed, base, "sourceType"),
    "sourceType",
    LIMITS.sourceType,
  );
  if (sourceType === UNSET) {
    sourceType = sourceProactiveId ? "proactive_assistant" : sourceDefaults.sourceType;
    defaultsApplied.push("sourceType");
  } else if (sourceType === null && sourceProactiveId !== null && sourceTypeExplicit) {
    failValidation("sourceType", "relationship", "sourceType cannot be cleared while sourceProactiveId is present");
  } else if (sourceType === null && sourceProactiveId !== null) {
    sourceType = "proactive_assistant";
  }

  let sourceId = normalizeOptionalText(
    rawField(parsed, base, "sourceId"),
    "sourceId",
    LIMITS.sourceId,
  );
  if (sourceId === UNSET) {
    sourceId = sourceType === "proactive_assistant" && sourceProactiveId
      ? sourceProactiveId
      : sourceDefaults.sourceId;
    defaultsApplied.push("sourceId");
  } else if (sourceId === null && sourceType === "proactive_assistant"
    && sourceProactiveId !== null && !sourceIdExplicit) {
    sourceId = sourceProactiveId;
  }

  if (sourceId !== null && sourceType === null) {
    failValidation("sourceType", "required_for_source_id", "sourceType is required when sourceId is present");
  }
  if (["quick_record", "proactive_assistant"].includes(sourceType) && sourceId === null) {
    failValidation("sourceId", "required", `sourceId is required for ${sourceType}`);
  }

  let sourceRecordId = null;
  if (kind === "action") {
    const sourceRecordExplicit = parsed.provided.has("sourceRecordId");
    sourceRecordId = normalizeOptionalText(
      rawField(parsed, base, "sourceRecordId"),
      "sourceRecordId",
      LIMITS.sourceRecordId,
    );
    if (sourceRecordId === UNSET) {
      sourceRecordId = null;
      defaultsApplied.push("sourceRecordId");
    }
    if (sourceRecordId !== null) {
      if (sourceType === null) {
        if (sourceTypeExplicit) {
          failValidation("sourceType", "relationship", "sourceType cannot be null when sourceRecordId is present");
        }
        sourceType = "quick_record";
      }
      if (sourceType !== "quick_record") {
        failValidation("sourceRecordId", "relationship", "sourceRecordId requires sourceType=quick_record");
      }
      if (sourceId === null) {
        if (sourceIdExplicit) {
          failValidation("sourceId", "relationship", "sourceId cannot be null when sourceRecordId is present");
        }
        sourceId = sourceRecordId;
      }
      if (sourceId !== sourceRecordId) {
        failValidation("sourceId", "relationship", "sourceId must match sourceRecordId for legacy quick-record writes");
      }
    } else if (sourceType === "quick_record" && sourceId !== null) {
      if (sourceRecordExplicit) {
        failValidation(
          "sourceRecordId",
          "relationship",
          "sourceRecordId must match sourceId when sourceType=quick_record",
        );
      }
      // New action writes keep the legacy unique/FK column in sync whenever a
      // quick-record source is supplied through the canonical pair.
      sourceRecordId = sourceId;
    }
  }

  if (sourceProactiveId !== null && sourceType === "proactive_assistant" && sourceId === null) {
    sourceId = sourceProactiveId;
  }
  return { sourceRecordId, sourceType, sourceId, sourceProactiveId };
}

function buildFromParsed(kind, parsed, options = {}) {
  const base = parsed.existing ? rowPayload(kind, parsed.existing) : null;
  const relationships = resolveRelationships(kind, parsed, base, {
    requireOwner: options.requireRelationships !== false,
  });
  const defaultsApplied = [];
  const mode = normalizeMode(parsed.mode, base ? "update" : "create");
  const idRaw = rawField(parsed, base, "id");
  const id = idRaw === UNSET ? null : normalizeIdentifier(idRaw, "id", LIMITS.id);

  if (kind === "action") {
    const titleRaw = rawField(parsed, base, "title");
    const title = normalizeRequiredText(titleRaw, "title", LIMITS.actionTitle);
    const customerRaw = rawField(parsed, base, "customer");
    const customer = customerRaw === UNSET
      ? (defaultsApplied.push("customer"), null)
      : normalizeOptionalText(customerRaw, "customer", LIMITS.customer);
    const reasonRaw = rawField(parsed, base, "reason");
    const reason = reasonRaw === UNSET
      ? (defaultsApplied.push("reason"), null)
      : normalizeOptionalText(reasonRaw, "reason", LIMITS.reason);
    const dueRaw = rawField(parsed, base, "due");
    const due = dueRaw === UNSET
      ? (defaultsApplied.push("due"), null)
      : normalizeOptionalText(dueRaw, "due", LIMITS.due);
    const assigneeRaw = rawField(parsed, base, "assignee");
    const assignee = assigneeRaw === UNSET
      ? (defaultsApplied.push("assignee"), relationships.owner)
      : normalizeOptionalText(assigneeRaw, "assignee", LIMITS.assignee);
    const priorityRaw = rawField(parsed, base, "priority");
    const priority = priorityRaw === UNSET
      ? (defaultsApplied.push("priority"), "中")
      : normalizeEnum(priorityRaw, "priority", PRIORITY_ALIASES);
    const statusRaw = rawField(parsed, base, "status");
    const status = statusRaw === UNSET
      ? (defaultsApplied.push("status"), "pending")
      : normalizeStatus(statusRaw, "status", ACTION_STATUS_VALUES, "pending");
    const expectedResultRaw = rawField(parsed, base, "expectedResult");
    const expectedResult = expectedResultRaw === UNSET
      ? (defaultsApplied.push("expectedResult"), null)
      : normalizeOptionalText(expectedResultRaw, "expectedResult", LIMITS.expectedResult);
    const remindAtRaw = rawField(parsed, base, "remindAt");
    const remindAt = remindAtRaw === UNSET
      ? (defaultsApplied.push("remindAt"), null)
      : normalizeOptionalText(remindAtRaw, "remindAt", LIMITS.remindAt);
    const source = normalizeSource(kind, parsed, base, ACTION_WRITEBACK_DEFAULTS, defaultsApplied);
    const toneRaw = rawField(parsed, base, "tone");
    const tone = toneRaw === UNSET
      ? (defaultsApplied.push("tone"), priority === "高" ? "red" : "blue")
      : normalizeOptionalText(toneRaw, "tone", LIMITS.tone);
    const payload = {
      id,
      owner: relationships.owner,
      customerId: relationships.customerId,
      opportunityId: relationships.opportunityId,
      title,
      customer,
      reason,
      due,
      assignee,
      priority,
      status,
      sourceRecordId: source.sourceRecordId,
      tone,
      remindAt,
      expectedResult,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceProactiveId: source.sourceProactiveId,
    };
    return finalizeBuild(kind, payload, relationships, mode, parsed, defaultsApplied, options);
  }

  const title = normalizeRequiredText(rawField(parsed, base, "title"), "title", LIMITS.title);
  const target = normalizeRequiredText(rawField(parsed, base, "target"), "target", LIMITS.target);
  const evidence = normalizeRequiredText(rawField(parsed, base, "evidence"), "evidence", LIMITS.evidence);
  const action = normalizeRequiredText(rawField(parsed, base, "action"), "action", LIMITS.action);
  const scoreRaw = rawField(parsed, base, "score");
  const score = scoreRaw === UNSET
    ? (defaultsApplied.push("score"), 60)
    : normalizeScore(scoreRaw, "score", 60);
  const severityRaw = rawField(parsed, base, "severity");
  const severity = severityRaw === UNSET
    ? (defaultsApplied.push("severity"), "中")
    : normalizeEnum(severityRaw, "severity", SEVERITY_ALIASES);
  const statusRaw = rawField(parsed, base, "status");
  const status = statusRaw === UNSET
    ? (defaultsApplied.push("status"), "open")
    : normalizeStatus(statusRaw, "status", RISK_STATUS_VALUES, "open");
  const assigneeRaw = rawField(parsed, base, "assignee");
  const assignee = assigneeRaw === UNSET
    ? (defaultsApplied.push("assignee"), relationships.owner)
    : normalizeOptionalText(assigneeRaw, "assignee", LIMITS.assignee);
  const dueRaw = rawField(parsed, base, "due");
  const due = dueRaw === UNSET
    ? (defaultsApplied.push("due"), null)
    : normalizeOptionalText(dueRaw, "due", LIMITS.due);
  const expectedResultRaw = rawField(parsed, base, "expectedResult");
  const expectedResult = expectedResultRaw === UNSET
    ? (defaultsApplied.push("expectedResult"), null)
    : normalizeOptionalText(expectedResultRaw, "expectedResult", LIMITS.expectedResult);
  const source = normalizeSource(kind, parsed, base, RISK_WRITEBACK_DEFAULTS, defaultsApplied);
  const toneRaw = rawField(parsed, base, "tone");
  const tone = toneRaw === UNSET
    ? (defaultsApplied.push("tone"), "amber")
    : normalizeOptionalText(toneRaw, "tone", LIMITS.tone);
  const payload = {
    id,
    owner: relationships.owner,
    customerId: relationships.customerId,
    opportunityId: relationships.opportunityId,
    title,
    target,
    score,
    severity,
    status,
    evidence,
    action,
    assignee,
    due,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    tone,
    expectedResult,
    sourceProactiveId: source.sourceProactiveId,
  };
  return finalizeBuild(kind, payload, relationships, mode, parsed, defaultsApplied, options);
}

function finalizeBuild(kind, payload, relationships, mode, parsed, defaultsApplied, options) {
  const canonicalPayload = canonicalizeWritebackPayload(kind, payload);
  const digest = computeWritebackDigest(kind, payload);
  if (parsed.expectedDigest !== UNSET) {
    const presented = normalizeDigest(parsed.expectedDigest);
    if (!writebackDigestMatches(kind, payload, presented)) {
      throw new ActionRiskWritebackValidationError("writebackDigest does not match the final writeback payload", {
        writebackDigest: "mismatch",
      });
    }
  }
  if (typeof options.relationshipValidator === "function") {
    const result = options.relationshipValidator(relationships, payload);
    if (result && typeof result.then === "function") {
      throw new TypeError("relationshipValidator must be synchronous");
    }
  }
  const payloadWithDigest = { ...payload, writebackDigest: digest };
  return Object.freeze({
    kind,
    mode,
    payload: Object.freeze(payloadWithDigest),
    canonicalPayload,
    canonicalJson: stableWritebackJson(canonicalPayload),
    writebackDigest: digest,
    columns: Object.freeze(mapWritebackToColumns(kind, payload, digest)),
    relationships: Object.freeze({ ...relationships }),
    defaultsApplied: Object.freeze([...new Set(defaultsApplied)]),
    defaults: kind === "action" ? ACTION_WRITEBACK_DEFAULTS : RISK_WRITEBACK_DEFAULTS,
  });
}

export function buildWriteback(kind, input = {}, options = {}) {
  const parsed = parseEnvelope(kind, input);
  return buildFromParsed(kind, parsed, options);
}

export function buildActionWriteback(input = {}, options = {}) {
  return buildWriteback("action", input, options);
}

export function buildRiskWriteback(input = {}, options = {}) {
  return buildWriteback("risk", input, options);
}

export function validateActionWriteback(input = {}, options = {}) {
  return buildActionWriteback(input, options);
}

export function validateRiskWriteback(input = {}, options = {}) {
  return buildRiskWriteback(input, options);
}

export function validateActionFields(input = {}, options = {}) {
  return buildActionWriteback(input, { ...options, requireRelationships: false });
}

export function validateRiskFields(input = {}, options = {}) {
  return buildRiskWriteback(input, { ...options, requireRelationships: false });
}

function normalizeRelationshipInput(value) {
  if (!isPlainObject(value)) failValidation("relationships", "object", "relationships must be an object");
  const relationMap = new Map();
  for (const [key, item] of Object.entries(value)) {
    const canonical = RELATION_ALIAS_MAP.get(key);
    if (!canonical) failValidation(`relationships.${key}`, "unknown", "unknown relationship field");
    addCandidate(relationMap, canonical, item, `relationships.${key}`);
  }
  const parsed = { relations: relationMap };
  return resolveRelationships("action", parsed, null, { requireOwner: true });
}

/**
 * Validate owner/customer/opportunity existence.  Supported call forms are
 * `validateWritebackRelationships(db, relationships)` and
 * `validateWritebackRelationships({ db, ...relationships })`.
 */
export function validateWritebackRelationships(dbOrInput, maybeRelationships) {
  let db = null;
  let value = dbOrInput;
  if (maybeRelationships !== undefined) {
    db = dbOrInput;
    value = maybeRelationships;
  } else if (isPlainObject(dbOrInput) && Object.hasOwn(dbOrInput, "db")) {
    db = dbOrInput.db;
    value = { ...dbOrInput };
    delete value.db;
  }
  const relationships = normalizeRelationshipInput(value);
  if (!db) return relationships;
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");

  if (relationships.customerId) {
    const customer = db.prepare(`
      SELECT id
      FROM customers
      WHERE id = $id AND owner = $owner AND deleted_at IS NULL
    `).get({ $id: relationships.customerId, $owner: relationships.owner });
    if (!customer) {
      throw new ActionRiskWritebackValidationError("customerId is not owned by the writeback owner", {
        customerId: "not_found_or_foreign",
      });
    }
  }
  if (relationships.opportunityId) {
    const opportunity = db.prepare(`
      SELECT opportunity.id, opportunity.customer_id
      FROM opportunities opportunity
      INNER JOIN customers customer
        ON customer.id = opportunity.customer_id
       AND customer.deleted_at IS NULL
       AND customer.owner = $owner
      WHERE opportunity.id = $id
        AND opportunity.owner = $owner
        AND opportunity.deleted_at IS NULL
    `).get({ $id: relationships.opportunityId, $owner: relationships.owner });
    if (!opportunity) {
      throw new ActionRiskWritebackValidationError("opportunityId is not owned by the writeback owner", {
        opportunityId: "not_found_or_foreign",
      });
    }
    if (relationships.customerId && opportunity.customer_id !== relationships.customerId) {
      throw new ActionRiskWritebackValidationError("customerId and opportunityId do not belong together", {
        opportunityId: "relationship",
      });
    }
  }
  return relationships;
}

export const assertWritebackRelationships = validateWritebackRelationships;

function tableFor(kind) {
  return kind === "action" ? "action_items" : "risk_items";
}

function assertDatabase(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
}

function assertSchema(db, kind) {
  const table = tableFor(kind);
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
  const required = [
    ...Object.values(columnMap(kind)),
    "version",
    "created_at",
    "updated_at",
    "deleted_at",
  ];
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new ActionRiskWritebackSchemaError(
      `${table} is missing v0.12.0 writeback columns: ${missing.join(", ")}`,
    );
  }
}

function readRow(db, kind, id) {
  return db.prepare(`SELECT * FROM ${tableFor(kind)} WHERE id = $id`).get({ $id: id });
}

function rowVersion(row) {
  const version = Number(row?.version ?? 1);
  return Number.isSafeInteger(version) && version >= 1 ? version : 1;
}

function itemFromRow(kind, row) {
  const payload = rowPayload(kind, row);
  const digest = isWritebackDigest(row?.writeback_digest)
    ? row.writeback_digest
    : computeWritebackDigest(kind, payload);
  return {
    ...payload,
    writebackDigest: digest,
    version: rowVersion(row),
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
    deletedAt: row?.deleted_at ?? null,
  };
}

function currentDigest(kind, row) {
  return computeWritebackDigest(kind, rowPayload(kind, row));
}

function assertPersistedDigest(kind, row, expectedDigest = null) {
  if (!row) throw new ActionRiskWritebackNotFoundError();
  const actualDigest = currentDigest(kind, row);
  if (!isWritebackDigest(row.writeback_digest) || row.writeback_digest !== actualDigest) {
    throw new ActionRiskWritebackSchemaError(
      `${tableFor(kind)} persisted writeback_digest does not match its canonical payload`,
    );
  }
  if (expectedDigest !== null && actualDigest !== expectedDigest) {
    throw new ActionRiskWritebackSchemaError(
      `${tableFor(kind)} persisted payload differs from the requested writeback`,
    );
  }
  return actualDigest;
}

function sourceQuickRecordOwnerCheck(db, payload) {
  const sourceId = payload.sourceRecordId
    ?? (payload.sourceType === "quick_record" ? payload.sourceId : null);
  if (!sourceId) return;
  const row = db.prepare(`
    SELECT id, owner, voided_at
    FROM quick_records
    WHERE id = $id
  `).get({ $id: sourceId });
  if (!row || row.voided_at || row.owner !== payload.owner) {
    const field = payload.sourceRecordId ? "sourceRecordId" : "sourceId";
    throw new ActionRiskWritebackValidationError("quick-record provenance is not available to the writeback owner", {
      [field]: "not_found_or_foreign",
    });
  }
}

function paramsFromColumns(columns) {
  return Object.fromEntries(Object.entries(columns).map(([key, value]) => [`$${key}`, value]));
}

function insertSql(kind) {
  const columns = Object.values(columnMap(kind));
  return `INSERT INTO ${tableFor(kind)} (${columns.join(", ")}) VALUES (${columns.map((column) => `$${column}`).join(", ")})`;
}

function updateSql(kind) {
  const columns = Object.values(columnMap(kind)).filter((column) => !["id", "writeback_digest"].includes(column));
  const assignments = columns.map((column) => `${column} = $${column}`);
  assignments.push("writeback_digest = $writeback_digest");
  return `UPDATE ${tableFor(kind)}
     SET ${assignments.join(", ")}, version = version + 1, updated_at = CURRENT_TIMESTAMP
   WHERE id = $id AND owner = $owner AND version = $expectedVersion AND deleted_at IS NULL`;
}

function replayConflict(kind, id, current, candidate) {
  throw new ActionRiskWritebackConflictError(
    "ACTION_RISK_WRITEBACK_REPLAY_CONFLICT",
    `The ${kind} writeback id ${id} already contains different content`,
    {
      id,
      currentDigest: currentDigest(kind, current),
      requestedDigest: candidate.writebackDigest,
    },
  );
}

function versionConflict(kind, current) {
  throw new ActionRiskWritebackConflictError(
    "ACTION_RISK_WRITEBACK_VERSION_CONFLICT",
    `The ${kind} item was updated by another request`,
    { currentVersion: rowVersion(current) },
  );
}

function resultFromRow(kind, status, row, built) {
  const digest = assertPersistedDigest(kind, row, built.writebackDigest);
  const item = itemFromRow(kind, row);
  const payload = rowPayload(kind, row);
  const canonicalPayload = canonicalizeWritebackPayload(kind, payload);
  return {
    kind,
    status,
    replayed: status === "replayed",
    id: item.id,
    version: item.version,
    item,
    payload: { ...payload, writebackDigest: digest },
    columns: mapWritebackToColumns(kind, payload, digest),
    canonicalPayload,
    canonicalJson: stableWritebackJson(canonicalPayload),
    writebackDigest: digest,
    defaultsApplied: built.defaultsApplied,
  };
}

function writeKind(db, kind, input, options = {}, serviceOptions = {}) {
  assertDatabase(db);
  const execute = () => {
    assertSchema(db, kind);
    const parsed = parseEnvelope(kind, input);
    const explicitOwner = parsed.relations.get("owner")?.value;
    if (explicitOwner === undefined) {
      failValidation("owner", "required", "owner must be supplied by the caller");
    }
    const owner = normalizeRequiredIdentifier(explicitOwner, "owner", LIMITS.owner);
    const requestedIdRaw = parsed.provided.get("id")?.value
      ?? (parsed.existing ? rowPayload(kind, parsed.existing).id : null);
    const requestedId = requestedIdRaw === null || requestedIdRaw === undefined || requestedIdRaw === ""
      ? null
      : normalizeIdentifier(requestedIdRaw, "id", LIMITS.id);
    const existing = requestedId ? readRow(db, kind, requestedId) : null;
    if (existing && existing.owner !== owner) throw new ActionRiskWritebackNotFoundError();
    if (existing?.deleted_at) throw new ActionRiskWritebackNotFoundError();

    const mode = normalizeMode(parsed.mode, parsed.expectedVersion !== UNSET ? "update" : "create");
    if (mode === "update" && !existing) throw new ActionRiskWritebackNotFoundError();
    if (mode === "create" && parsed.expectedVersion !== UNSET) {
      failValidation("expectedVersion", "unexpected", "expectedVersion is only valid for update writebacks");
    }

    const id = requestedId ?? normalizeRequiredIdentifier(
      serviceOptions.idFactory(),
      "id",
      LIMITS.id,
    );
    const effectiveParsed = {
      ...parsed,
      existing: mode === "update" ? existing : null,
      provided: new Map(parsed.provided),
    };
    addCandidate(effectiveParsed.provided, "id", id, "id");
    const built = buildFromParsed(kind, effectiveParsed, {
      requireRelationships: true,
      relationshipValidator: serviceOptions.relationshipValidator,
    });

    if (built.payload.owner !== owner) {
      throw new ActionRiskWritebackValidationError("owner does not match the caller relationship", { owner: "mismatch" });
    }
    validateWritebackRelationships(db, built.relationships);
    sourceQuickRecordOwnerCheck(db, built.payload);

    if (existing) {
      const candidateDigest = built.writebackDigest;
      const existingDigest = currentDigest(kind, existing);
      const storedDigestMatches = existing.writeback_digest === candidateDigest;
      if (existingDigest === candidateDigest && storedDigestMatches) {
        return resultFromRow(kind, "replayed", existing, built);
      }
      if (mode === "create") replayConflict(kind, id, existing, built);
      const expectedVersion = normalizeVersion(parsed.expectedVersion);
      if (expectedVersion === null) {
        failValidation("expectedVersion", "required", "expectedVersion is required for a changed update writeback");
      }
      if (rowVersion(existing) !== expectedVersion) {
        versionConflict(kind, existing);
      }
      const updateResult = db.prepare(updateSql(kind)).run({
        ...paramsFromColumns(built.columns),
        $id: id,
        $owner: owner,
        $expectedVersion: expectedVersion,
      });
      if (updateResult.changes !== 1) {
        const current = readRow(db, kind, id);
        if (!current || current.deleted_at || current.owner !== owner) throw new ActionRiskWritebackNotFoundError();
        if (currentDigest(kind, current) === candidateDigest && current.writeback_digest === candidateDigest) {
          return resultFromRow(kind, "replayed", current, built);
        }
        versionConflict(kind, current);
      }
      return resultFromRow(kind, "updated", readRow(db, kind, id), built);
    }

    db.prepare(insertSql(kind)).run(paramsFromColumns(built.columns));
    return resultFromRow(kind, "created", readRow(db, kind, id), built);
  };
  if (options.withinTransaction === true || db.isTransaction === true) return execute();
  return withImmediateTransaction(db, execute);
}

export function createActionRiskWritebackService({
  db,
  idFactory = randomUUID,
  relationshipValidator = null,
} = {}) {
  assertDatabase(db);
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (relationshipValidator !== null && typeof relationshipValidator !== "function") {
    throw new TypeError("relationshipValidator must be a function");
  }
  const options = { idFactory, relationshipValidator };
  const service = {
    buildWriteback: (kind, input, buildOptions = {}) => buildWriteback(kind, input, buildOptions),
    buildActionWriteback: (input, buildOptions = {}) => buildActionWriteback(input, buildOptions),
    buildRiskWriteback: (input, buildOptions = {}) => buildRiskWriteback(input, buildOptions),
    validateActionWriteback: (input, buildOptions = {}) => validateActionWriteback(input, buildOptions),
    validateRiskWriteback: (input, buildOptions = {}) => validateRiskWriteback(input, buildOptions),
    validateRelationships: (relationships) => validateWritebackRelationships(db, relationships),
    write: (kind, input, writeOptions = {}) => writeKind(db, kind, input, writeOptions, options),
    writeAction: (input, writeOptions = {}) => writeKind(db, "action", input, writeOptions, options),
    writeRisk: (input, writeOptions = {}) => writeKind(db, "risk", input, writeOptions, options),
  };
  return Object.freeze(service);
}

export function applyActionWriteback(db, input, options = {}) {
  return createActionRiskWritebackService({
    db,
    idFactory: options.idFactory ?? randomUUID,
    relationshipValidator: options.relationshipValidator ?? null,
  })
    .writeAction(input, options);
}

export function applyRiskWriteback(db, input, options = {}) {
  return createActionRiskWritebackService({
    db,
    idFactory: options.idFactory ?? randomUUID,
    relationshipValidator: options.relationshipValidator ?? null,
  })
    .writeRisk(input, options);
}

export const writeActionWriteback = applyActionWriteback;
export const writeRiskWriteback = applyRiskWriteback;
