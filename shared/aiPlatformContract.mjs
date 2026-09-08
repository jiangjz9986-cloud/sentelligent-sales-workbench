import { createHash } from "node:crypto";

export const AI_TASK_SCHEMA_VERSION = "ai-task-v1";
export const AI_TASK_RESULT_SCHEMA_VERSION = "ai-task-result-v1";
export const AI_ERROR_SCHEMA_VERSION = "ai-error-v1";

export const AI_TASK_STATUSES = Object.freeze([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export const AI_TASK_TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);
export const AI_PRIORITIES = Object.freeze(["interactive", "normal", "background"]);
export const AI_CHANNELS = Object.freeze(["web", "weixin", "worker", "system"]);
export const AI_COST_STATUSES = Object.freeze(["calculated", "estimated", "unknown", "not_applicable"]);
export const AI_SOURCE_TYPES = Object.freeze(["model", "mock", "deterministic", "fallback", "cache"]);
export const AI_TASK_TYPES = Object.freeze([
  "weekly.generate",
  "quick-record.analyze",
  "suggestion.generate",
  "customer.temperature",
  "sales-decision.analyze",
  "itinerary.enhance",
  "assistant.execute",
  "proactive.analyze",
  "payment-proof.recognize",
  "invoice.recognize",
  "bookkeeping.extract",
  "asr.transcribe",
]);

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const TASK_TYPE = /^[a-z][a-z0-9-]{1,63}\.[a-z][a-z0-9-]{1,63}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SAFE_TEXT = /[\u0000-\u001f\u007f-\u009f]/u;

export class AiContractError extends Error {
  constructor(message, code = "invalid_request", details = null) {
    super(message);
    this.name = "AiContractError";
    this.code = code;
    this.details = details;
  }
}

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value, path = "value", depth = 0, seen = new Set()) {
  if (depth > 20) throw new AiContractError(`${path} is too deeply nested`, "input_too_deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AiContractError(`${path} contains a non-finite number`, "invalid_json");
    return value;
  }
  if (value === undefined) return null;
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new AiContractError(`${path} must be JSON data`, "invalid_json");
  }
  if (seen.has(value)) throw new AiContractError(`${path} contains a cycle`, "invalid_json");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => stableValue(item, `${path}[${index}]`, depth + 1, seen));
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      stableValue(value[key], `${path}.${key}`, depth + 1, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  const input = typeof value === "string" || Buffer.isBuffer(value) ? value : stableJson(value);
  return createHash("sha256").update(input).digest("hex");
}

export function requireText(value, name, { max = 500, pattern = null } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AiContractError(`${name} is required`, "invalid_request");
  }
  const normalized = value.trim();
  if (normalized.length > max || SAFE_TEXT.test(normalized)) {
    throw new AiContractError(`${name} is invalid`, "invalid_request");
  }
  if (pattern && !pattern.test(normalized)) {
    throw new AiContractError(`${name} is invalid`, "invalid_request");
  }
  return normalized;
}

export function optionalText(value, name, { max = 500, pattern = null } = {}) {
  if (value === undefined || value === null || value === "") return null;
  return requireText(value, name, { max, pattern });
}

export function identifier(value, name = "identifier") {
  return requireText(value, name, { max: 128, pattern: IDENTIFIER });
}

export function taskType(value, name = "taskType") {
  const normalized = requireText(value, name, { max: 127, pattern: TASK_TYPE });
  if (!AI_TASK_TYPES.includes(normalized)) {
    throw new AiContractError(`${name} is not registered`, "unknown_task_type");
  }
  return normalized;
}

export function digest(value, name = "digest") {
  return requireText(value, name, { max: 64, pattern: DIGEST });
}

export function boundedObject(value, name, { maxBytes = 512 * 1024 } = {}) {
  if (!isPlainObject(value)) throw new AiContractError(`${name} must be an object`, "invalid_request");
  const encoded = stableJson(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new AiContractError(`${name} is too large`, "payload_too_large");
  }
  return JSON.parse(encoded);
}

export function normalizeSubject(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new AiContractError("subject must be an object", "invalid_request");
  return {
    type: identifier(value.type, "subject.type"),
    id: identifier(value.id, "subject.id"),
  };
}

export function normalizeTaskCreate(input = {}) {
  if (!isPlainObject(input)) throw new AiContractError("request body must be an object", "invalid_request");
  const schemaVersion = requireText(input.schemaVersion ?? AI_TASK_SCHEMA_VERSION, "schemaVersion", { max: 64 });
  if (schemaVersion !== AI_TASK_SCHEMA_VERSION) throw new AiContractError("unsupported schemaVersion", "unsupported_schema");
  const normalized = {
    schemaVersion,
    taskType: taskType(input.taskType),
    feature: identifier(input.feature, "feature"),
    channel: requireText(input.channel, "channel", { max: 40 }),
    subject: normalizeSubject(input.subject),
    input: boundedObject(input.input ?? {}, "input"),
    evidenceDigest: input.evidenceDigest === undefined || input.evidenceDigest === null
      ? null
      : digest(input.evidenceDigest, "evidenceDigest"),
    priority: input.priority === undefined ? "normal" : requireText(input.priority, "priority", { max: 20 }),
    requestedWaitMs: input.requestedWaitMs === undefined || input.requestedWaitMs === null
      ? 0
      : Number(input.requestedWaitMs),
  };
  if (!AI_CHANNELS.includes(normalized.channel)) throw new AiContractError("channel is invalid", "invalid_request");
  if (!AI_PRIORITIES.includes(normalized.priority)) throw new AiContractError("priority is invalid", "invalid_request");
  if (!Number.isSafeInteger(normalized.requestedWaitMs) || normalized.requestedWaitMs < 0 || normalized.requestedWaitMs > 30_000) {
    throw new AiContractError("requestedWaitMs is invalid", "invalid_request");
  }
  return normalized;
}

export function normalizeTaskResult(value = {}) {
  if (!isPlainObject(value)) throw new AiContractError("result must be an object", "invalid_result");
  const normalized = {
    schemaVersion: value.schemaVersion ?? AI_TASK_RESULT_SCHEMA_VERSION,
    status: requireText(value.status, "result.status", { max: 32 }),
    source: requireText(value.source ?? "model", "result.source", { max: 32 }),
    facts: Array.isArray(value.facts) ? value.facts.slice(0, 100) : [],
    inferences: Array.isArray(value.inferences) ? value.inferences.slice(0, 100) : [],
    unknowns: Array.isArray(value.unknowns) ? value.unknowns.slice(0, 100) : [],
    suggestions: Array.isArray(value.suggestions) ? value.suggestions.slice(0, 100) : [],
    sourceRefs: Array.isArray(value.sourceRefs) ? value.sourceRefs.slice(0, 100) : [],
    writebackPreview: value.writebackPreview && isPlainObject(value.writebackPreview)
      ? boundedObject(value.writebackPreview, "result.writebackPreview", { maxBytes: 64 * 1024 })
      : null,
    metadata: value.metadata && isPlainObject(value.metadata)
      ? boundedObject(value.metadata, "result.metadata", { maxBytes: 64 * 1024 })
      : {},
  };
  if (normalized.schemaVersion !== AI_TASK_RESULT_SCHEMA_VERSION) {
    throw new AiContractError("unsupported result schemaVersion", "unsupported_schema");
  }
  if (!AI_SOURCE_TYPES.includes(normalized.source)) throw new AiContractError("result.source is invalid", "invalid_result");
  return normalized;
}

export function publicTaskShape(row) {
  if (!row) return null;
  const parseJson = (value, fallback) => {
    if (value === null || value === undefined || value === "") return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  };
  return {
    schemaVersion: AI_TASK_RESULT_SCHEMA_VERSION,
    requestId: row.request_id,
    taskId: row.id,
    status: row.status,
    owner: row.owner,
    feature: row.feature,
    taskType: row.task_type,
    channel: row.channel,
    priority: row.priority,
    subject: row.subject_type ? { type: row.subject_type, id: row.subject_id } : null,
    agentVersion: row.agent_version_id,
    model: row.model_id,
    source: row.source,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    result: parseJson(row.output_json, null),
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    currentAttempt: Number(row.current_attempt ?? 0),
    cancelRequestedAt: row.cancel_requested_at,
  };
}
