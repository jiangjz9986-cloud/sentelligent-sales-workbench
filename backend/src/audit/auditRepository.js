import { randomUUID } from "node:crypto";

const sensitiveKeyPattern = /api.?key|secret|token|authorization|password|contact|phone|mobile|email|cookie|csrf|credential|session|wechat|provider.?key/i;

function sanitizeString(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\b(?:\+?86[-\s]?)?1[3-9]\d{9}\b/g, "[REDACTED]")
    .replace(
      /\b(?:password|secret|token|authorization|api.?key|cookie|csrf(?:token)?|session(?:id|token|cookie)?|credential|wechat(?:secret|token)?|provider(?:api)?key)\s*[:=]\s*[^\s,;]+/gi,
      "[REDACTED]",
    );
}

function sanitizeValue(value, depth, ancestors) {
  if (depth > 5) return null;
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value !== "object") return null;
  if (ancestors.has(value)) return null;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1, ancestors));
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();

    const sanitized = {};
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveKeyPattern.test(key)) continue;
      sanitized[key] = sanitizeValue(item, depth + 1, ancestors);
    }
    return sanitized;
  } finally {
    ancestors.delete(value);
  }
}

export function sanitizeAuditValue(value, depth = 0) {
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new TypeError("Audit sanitization depth must be a non-negative integer");
  }
  return sanitizeValue(value, depth, new Set());
}

export function insertAudit(db, {
  action,
  entityType,
  entityId = null,
  actor,
  requestId = null,
  before = null,
  after = null,
  entityVersion = null,
  metadata = {},
}) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
  if (typeof action !== "string" || !action.trim()) {
    throw new TypeError("Audit action is required");
  }
  if (typeof entityType !== "string" || !entityType.trim()) {
    throw new TypeError("Audit entity type is required");
  }
  if (typeof actor !== "string" || !actor.trim()) {
    throw new TypeError("An authenticated audit actor is required");
  }

  const record = {
    id: randomUUID(),
    action,
    entityType,
    entityId,
    actor,
    requestId,
    before: sanitizeAuditValue(before),
    after: sanitizeAuditValue(after),
    metadata: sanitizeAuditValue(metadata) ?? {},
    entityVersion,
  };
  db.prepare(`
    INSERT INTO audit_logs (
      id, action, entity_type, entity_id, actor, metadata_json,
      request_id, before_json, after_json, entity_version
    ) VALUES (
      $id, $action, $entityType, $entityId, $actor, $metadataJson,
      $requestId, $beforeJson, $afterJson, $entityVersion
    )
  `).run({
    $id: record.id,
    $action: record.action,
    $entityType: record.entityType,
    $entityId: record.entityId,
    $actor: record.actor,
    $metadataJson: JSON.stringify(record.metadata),
    $requestId: record.requestId,
    $beforeJson: JSON.stringify(record.before),
    $afterJson: JSON.stringify(record.after),
    $entityVersion: record.entityVersion,
  });
  return record;
}
