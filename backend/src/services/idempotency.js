import { createHash } from "node:crypto";

import { HttpError } from "../http/errors.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function invalidJsonValue() {
  throw new TypeError("stableJson only accepts validated JSON values");
}

function stableJsonValue(value, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalidJsonValue();
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return invalidJsonValue();
  if (ancestors.has(value)) return invalidJsonValue();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableJsonValue(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidJsonValue();
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonValue(value[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function stableJson(value) {
  return stableJsonValue(value, new Set());
}

export function requestHash(body) {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

function preconditionRequired() {
  throw new HttpError(
    428,
    "PRECONDITION_REQUIRED",
    "One valid Idempotency-Key header is required",
  );
}

export function parseIdempotencyKey(request) {
  const rawHeaderCount = Array.isArray(request?.rawHeaders)
    ? request.rawHeaders.filter(
      (value, index) => index % 2 === 0 && String(value).toLowerCase() === "idempotency-key",
    ).length
    : 0;
  const rawValue = request?.headers?.["idempotency-key"];
  if (rawHeaderCount !== 1 || typeof rawValue !== "string") return preconditionRequired();
  if (
    rawValue.length < 1 ||
    rawValue.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    rawValue.trim() !== rawValue ||
    /[\u0000-\u001f\u007f-\u009f,]/u.test(rawValue)
  ) {
    return preconditionRequired();
  }
  return rawValue;
}

function scopeParams(scope) {
  return {
    $actor: scope.actor,
    $method: String(scope.method).toUpperCase(),
    $requestPath: scope.path,
    $key: scope.key,
  };
}

function nowDate(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Idempotency time must be valid");
  return date;
}

export function claimIdempotency(db, scope) {
  const params = scopeParams(scope);
  const now = nowDate(scope.now);
  const nowIso = now.toISOString();
  db.prepare(`
    DELETE FROM idempotency_keys
    WHERE rowid IN (
      SELECT rowid
      FROM idempotency_keys INDEXED BY idx_idempotency_expiry
      WHERE expires_at <= $now
      ORDER BY expires_at ASC, rowid ASC
      LIMIT 100
    )
  `).run({ $now: nowIso });
  const existing = db.prepare(`
    SELECT * FROM idempotency_keys
    WHERE actor = $actor
      AND method = $method
      AND request_path = $requestPath
      AND key = $key
  `).get(params);

  if (existing) {
    const expiry = Date.parse(existing.expires_at);
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
      db.prepare(`
        DELETE FROM idempotency_keys
        WHERE actor = $actor
          AND method = $method
          AND request_path = $requestPath
          AND key = $key
      `).run(params);
    } else {
      if (existing.request_hash !== scope.hash) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "The Idempotency-Key was already used for different request content",
        );
      }
      if (existing.state === "completed") {
        return {
          replay: true,
          status: existing.response_status,
          body: JSON.parse(existing.response_json),
        };
      }
      throw new HttpError(409, "REQUEST_IN_PROGRESS", "The same request is already being processed");
    }
  }

  const expiresIso = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO idempotency_keys (
      actor, method, request_path, key, request_hash, state,
      response_status, response_json, created_at, expires_at
    ) VALUES (
      $actor, $method, $requestPath, $key, $requestHash, 'processing',
      NULL, NULL, $createdAt, $expiresAt
    )
  `).run({
    ...params,
    $requestHash: scope.hash,
    $createdAt: nowIso,
    $expiresAt: expiresIso,
  });
  return { replay: false };
}

export function completeIdempotency(db, scope) {
  if (!Number.isInteger(scope.status) || scope.status < 100 || scope.status > 599) {
    throw new TypeError("Idempotency response status must be a valid HTTP status");
  }
  stableJson(scope.body);
  const result = db.prepare(`
    UPDATE idempotency_keys
    SET state = 'completed',
        response_status = $responseStatus,
        response_json = $responseJson
    WHERE actor = $actor
      AND method = $method
      AND request_path = $requestPath
      AND key = $key
      AND request_hash = $requestHash
      AND state = 'processing'
  `).run({
    ...scopeParams(scope),
    $requestHash: scope.hash,
    $responseStatus: scope.status,
    $responseJson: JSON.stringify(scope.body),
  });
  if (result.changes !== 1) {
    throw new Error("The idempotency claim could not be completed");
  }
}
