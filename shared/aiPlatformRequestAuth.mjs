import { createHash } from "node:crypto";

export function normalizeRequestBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["method", "path", "bodySha256", "idempotencyKey"].includes(key))
    || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(value.method)
    || typeof value.path !== "string" || !value.path.startsWith("/") || value.path.startsWith("//")
    || value.path.length > 4096 || /[\u0000-\u0020\u007f#]/u.test(value.path)
    || typeof value.bodySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.bodySha256)
    || (value.idempotencyKey !== null && (typeof value.idempotencyKey !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value.idempotencyKey)))) {
    throw new TypeError("invalid AI request binding");
  }
  return { method: value.method, path: value.path, bodySha256: value.bodySha256, idempotencyKey: value.idempotencyKey };
}

export function createRequestBinding({ method, path, body = "", idempotencyKey = null }) {
  if (typeof body !== "string" && !Buffer.isBuffer(body)) throw new TypeError("request body must be bytes or text");
  return normalizeRequestBinding({
    method, path, idempotencyKey,
    bodySha256: createHash("sha256").update(body).digest("hex"),
  });
}
