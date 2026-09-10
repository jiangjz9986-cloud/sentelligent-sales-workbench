import { HttpError } from "../http/errors.js";
import { VisitTemperatureSuggestionError } from "./visitTemperatureSuggestion.js";

const IDENTIFIER_PATTERN = /^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const COLLECTION_PATH = "/api/visit-temperature-suggestions";
const ITEM_PATH_PATTERN = /^\/api\/visit-temperature-suggestions\/([^/]+)(?:\/(confirm|cancel))?$/u;
const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "no-store" });
const MAX_IDENTIFIER = 200;
const MAX_HISTORY = 50;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validation(fields) {
  throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", fields);
}

function identifier(value, field) {
  if (typeof value !== "string" || !value.trim()) validation({ [field]: "required" });
  const normalized = value.trim();
  if (normalized.length > MAX_IDENTIFIER || !IDENTIFIER_PATTERN.test(normalized) || normalized.startsWith("synthetic:")) {
    validation({ [field]: "format" });
  }
  return normalized;
}

function digest(value, field = "suggestionIdentity") {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) validation({ [field]: "format" });
  return value;
}

function integer(value, field, { min, max } = {}) {
  const normalized = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized)
    || (min !== undefined && normalized < min)
    || (max !== undefined && normalized > max)) {
    validation({ [field]: "integer" });
  }
  return normalized;
}

function assertUser(requestIdentity) {
  if (!requestIdentity || requestIdentity.kind !== "user"
    || typeof requestIdentity.account !== "string" || !requestIdentity.account.trim()) {
    throw new HttpError(401, "UNAUTHORIZED", "Authentication is required");
  }
  return identifier(requestIdentity.account, "owner");
}

function assertObject(value, field = "body") {
  if (!isPlainObject(value)) validation({ [field]: "object" });
  return value;
}

function assertAllowedKeys(value, allowed, prefix = "") {
  const fields = {};
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fields[`${prefix}${key}`] = "unknown";
  }
  if (Object.keys(fields).length > 0) validation(fields);
}

function decodeIdentifier(value, field) {
  try {
    return identifier(decodeURIComponent(value), field);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    validation({ [field]: "format" });
  }
}

function parsePath(pathname) {
  if (pathname === COLLECTION_PATH) return Object.freeze({ kind: "collection", action: null });
  if (typeof pathname !== "string") return null;
  const match = ITEM_PATH_PATTERN.exec(pathname);
  if (!match) return null;
  return Object.freeze({
    kind: "item",
    suggestionId: decodeIdentifier(match[1], "suggestionId"),
    action: match[2] ?? null,
  });
}

function queryObject(value) {
  if (value === undefined || value === null) return {};
  if (value instanceof URLSearchParams) return Object.fromEntries(value.entries());
  return assertObject(value, "query");
}

function requestIdInput(requestId) {
  if (requestId === undefined || requestId === null || requestId === "") return null;
  if (typeof requestId !== "string" || !requestId.trim() || requestId.trim().length > MAX_IDENTIFIER) {
    validation({ requestId: "format" });
  }
  return requestId.trim();
}

function mapServiceError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof VisitTemperatureSuggestionError) {
    return new HttpError(
      Number.isInteger(error.status) ? error.status : 400,
      error.code || "VISIT_TEMPERATURE_ERROR",
      error.message,
      isPlainObject(error.details) ? error.details : undefined,
    );
  }
  return error;
}

/**
 * HTTP-facing adapter for visit-temperature suggestions.
 *
 * The authenticated account is the only source of `owner`; bodies and query
 * strings cannot choose it.  The adapter never writes customer temperature by
 * itself: it delegates all preview, optimistic-lock, confirmation, expiry and
 * cancellation behavior to the injected service.
 */
export function createVisitTemperatureSuggestionHttpHandlers({ service } = {}) {
  if (!service
    || typeof service.suggest !== "function"
    || typeof service.get !== "function"
    || typeof service.history !== "function"
    || typeof service.confirm !== "function"
    || typeof service.cancel !== "function") {
    throw new TypeError("visit temperature suggestion service is required");
  }

  function matches(pathname) {
    return parsePath(pathname) !== null;
  }

  async function handle({
    method = "GET",
    pathname,
    query,
    body,
    requestIdentity,
    requestId = null,
  } = {}) {
    const route = parsePath(pathname);
    if (!route) return null;
    const owner = assertUser(requestIdentity);
    const publicRequestId = requestIdInput(requestId);

    try {
      let item;
      if (route.kind === "collection" && method === "POST") {
        const input = assertObject(body);
        assertAllowedKeys(input, new Set(["visitId"]));
        item = await service.suggest({
          owner,
          actor: requestIdentity.account,
          channel: requestIdentity.kind === "machine" ? "worker" : "web",
          visitId: identifier(input.visitId, "visitId"),
        });
      } else if (route.kind === "collection" && method === "GET") {
        const input = queryObject(query);
        assertAllowedKeys(input, new Set(["customerId", "limit"]), "query.");
        item = service.history({
          owner,
          ...(input.customerId === undefined || input.customerId === ""
            ? {}
            : { customerId: identifier(input.customerId, "query.customerId") }),
          limit: input.limit === undefined || input.limit === ""
            ? 20
            : integer(input.limit, "query.limit", { min: 1, max: MAX_HISTORY }),
        });
      } else if (route.kind === "item" && route.action === null && method === "GET") {
        item = service.get({ owner, suggestionId: route.suggestionId });
      } else if (route.kind === "item" && route.action === "confirm" && method === "POST") {
        const input = assertObject(body);
        assertAllowedKeys(input, new Set([
          "suggestionIdentity", "expectedCustomerVersion", "previousValue", "confirm",
        ]));
        if (input.confirm !== true) {
          throw new HttpError(
            409,
            "EXPLICIT_CONFIRMATION_REQUIRED",
            "An explicit confirm=true is required",
          );
        }
        item = service.confirm({
          owner,
          suggestionId: route.suggestionId,
          suggestionIdentity: digest(input.suggestionIdentity),
          expectedCustomerVersion: integer(input.expectedCustomerVersion, "expectedCustomerVersion", { min: 1 }),
          previousValue: integer(input.previousValue, "previousValue", { min: 0, max: 100 }),
          confirm: true,
        });
      } else if (route.kind === "item" && route.action === "cancel" && method === "POST") {
        const input = assertObject(body);
        assertAllowedKeys(input, new Set(["suggestionIdentity", "cancel"]));
        if (input.cancel !== true) {
          throw new HttpError(
            409,
            "EXPLICIT_CANCELLATION_REQUIRED",
            "An explicit cancel=true is required",
          );
        }
        item = service.cancel({
          owner,
          suggestionId: route.suggestionId,
          suggestionIdentity: digest(input.suggestionIdentity),
          cancel: true,
        });
      } else {
        const error = new HttpError(
          405,
          "METHOD_NOT_ALLOWED",
          "Method is not allowed for visit temperature suggestions",
        );
        error.headers = Object.freeze({
          Allow: route.kind === "collection" ? "GET, POST" : route.action ? "POST" : "GET",
        });
        throw error;
      }

      return Object.freeze({
        status: 200,
        headers: NO_STORE_HEADERS,
        body: Object.freeze({ requestId: publicRequestId, item }),
      });
    } catch (error) {
      throw mapServiceError(error);
    }
  }

  return Object.freeze({ matches, handle });
}

export const visitTemperatureSuggestionCollectionPath = COLLECTION_PATH;
export const visitTemperatureSuggestionItemPathPattern = ITEM_PATH_PATTERN;
