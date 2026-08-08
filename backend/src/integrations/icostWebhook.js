import { HttpError } from "../http/errors.js";
import { constantTimeEqual } from "../http/security.js";

const ICOST_ROUTE = "/api/integrations/icost/expenses";
const MAX_TEXT_LENGTH = 12_000;
const MAX_SOURCE_ID_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const DEFAULT_LEDGER_NAME = "出差报销";
const SHORTCUT_SOURCE = "icost-shortcut";

function validationError(fields) {
  throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", fields);
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function normalizedToken(config) {
  const token = config?.icostWebhookToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function authenticateIcostWebhook(header, config = {}) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  const expected = normalizedToken(config);
  if (!match || !expected || !constantTimeEqual(match[1], expected)) return null;

  const account = String(config.icostWebhookOwner ?? config.authAccount ?? "icost").trim();
  if (!account) return null;
  return {
    account,
    integration: "icost",
    kind: "integration",
  };
}

export function isIcostWebhookRouteAllowed(method, path) {
  return String(method ?? "").toUpperCase() === "POST" && path === ICOST_ROUTE;
}

export function validateIcostTextPayload(body, options = {}) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return validationError({ body: "object" });
  }
  const allowed = new Set([
    "text",
    "ledger_name",
    "idempotency_key",
    "source",
    "captured_at",
    "source_id",
  ]);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) return validationError({ [unknown]: "unknown" });

  if (typeof body.text !== "string") return validationError({ text: "required" });
  const text = body.text.trim();
  if (!text || text.length > MAX_TEXT_LENGTH) {
    return validationError({ text: text ? "maxLength" : "required" });
  }

  const expectedLedgerName = String(options.ledgerName ?? DEFAULT_LEDGER_NAME);
  if (body.ledger_name !== expectedLedgerName) {
    return validationError({ ledger_name: "notAllowed" });
  }
  if (body.source !== SHORTCUT_SOURCE) {
    return validationError({ source: "notAllowed" });
  }
  if (
    typeof body.idempotency_key !== "string"
    || body.idempotency_key.length < 1
    || body.idempotency_key.length > MAX_IDEMPOTENCY_KEY_LENGTH
    || body.idempotency_key.trim() !== body.idempotency_key
    || /[\u0000-\u001f\u007f-\u009f,]/u.test(body.idempotency_key)
  ) {
    return validationError({ idempotency_key: "format" });
  }

  let capturedAt;
  if (body.captured_at !== undefined && body.captured_at !== null && body.captured_at !== "") {
    if (typeof body.captured_at !== "string" || !Number.isFinite(Date.parse(body.captured_at))) {
      return validationError({ captured_at: "dateTime" });
    }
    capturedAt = body.captured_at;
  }

  let sourceId;
  if (body.source_id !== undefined && body.source_id !== null && body.source_id !== "") {
    if (
      typeof body.source_id !== "string" ||
      body.source_id.trim() !== body.source_id ||
      body.source_id.length > MAX_SOURCE_ID_LENGTH ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(body.source_id)
    ) {
      return validationError({ source_id: "format" });
    }
    sourceId = body.source_id;
  }

  return {
    text,
    ledgerName: expectedLedgerName,
    idempotencyKey: body.idempotency_key,
    source: SHORTCUT_SOURCE,
    ...(capturedAt ? { capturedAt } : {}),
    ...(sourceId ? { sourceId } : {}),
  };
}

export function createFixedWindowLimiter({
  limit,
  windowMs,
  clock = Date.now,
  maxKeys = 1_000,
} = {}) {
  positiveSafeInteger(limit, "limit");
  positiveSafeInteger(windowMs, "windowMs");
  positiveSafeInteger(maxKeys, "maxKeys");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const windows = new Map();

  function prune(now) {
    for (const [key, state] of windows) {
      if (now - state.startedAt >= windowMs) windows.delete(key);
    }
  }

  return {
    consume(key) {
      if (typeof key !== "string" || !key) throw new TypeError("rate-limit key is required");
      const now = Number(clock());
      if (!Number.isFinite(now)) throw new TypeError("clock must return a finite timestamp");
      prune(now);

      let state = windows.get(key);
      if (!state || now - state.startedAt >= windowMs) {
        while (windows.size >= maxKeys) {
          const oldestKey = windows.keys().next().value;
          windows.delete(oldestKey);
        }
        state = { count: 0, startedAt: now };
        windows.set(key, state);
      }

      if (state.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(1, state.startedAt + windowMs - now),
        };
      }

      state.count += 1;
      return {
        allowed: true,
        remaining: limit - state.count,
        retryAfterMs: 0,
      };
    },
  };
}
