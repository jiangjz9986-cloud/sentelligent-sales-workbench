import { createHmac, randomUUID } from "node:crypto";
import { constantTimeEqual } from "../utils.js";
import { AiPlatformError } from "../errors.js";

const TOKEN_PREFIX = "aip1";
const MAX_TTL_SECONDS = 15 * 60;

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid token payload");
    return parsed;
  } catch {
    throw new AiPlatformError("authentication failed", { code: "invalid_auth", status: 401 });
  }
}

function signature(secret, unsigned) {
  return createHmac("sha256", String(secret)).update(unsigned, "utf8").digest("hex");
}

export function createServiceToken({
  secret,
  issuer,
  subject,
  owner,
  actor = subject,
  scopes = [],
  ttlSeconds = 300,
  now = () => Date.now(),
  jti = randomUUID(),
} = {}) {
  if (!secret || !issuer || !subject || !owner || !Array.isArray(scopes)) throw new TypeError("token fields are required");
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) throw new TypeError("ttlSeconds is invalid");
  const issuedAt = Math.floor(Number(now()) / 1000);
  if (!Number.isSafeInteger(issuedAt)) throw new TypeError("now must return milliseconds");
  const payload = {
    ver: 1,
    iss: String(issuer),
    sub: String(subject),
    owner: String(owner),
    actor: String(actor),
    scopes: [...new Set(scopes.map(String))].sort(),
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: String(jti),
  };
  const encodedPayload = encode(payload);
  const unsigned = `${TOKEN_PREFIX}.${encodedPayload}`;
  return `${unsigned}.${signature(secret, unsigned)}`;
}

export function verifyServiceToken(token, {
  secret,
  now = () => Date.now(),
  clockSkewSeconds = 15,
  requiredScopes = [],
  expectedIssuer = null,
} = {}) {
  const value = String(token ?? "");
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !secret) {
    throw new AiPlatformError("authentication failed", { code: "invalid_auth", status: 401 });
  }
  const unsigned = `${parts[0]}.${parts[1]}`;
  if (!constantTimeEqual(signature(secret, unsigned), parts[2])) {
    throw new AiPlatformError("authentication failed", { code: "invalid_auth", status: 401 });
  }
  const payload = decode(parts[1]);
  const current = Math.floor(Number(now()) / 1000);
  if (
    payload.ver !== 1
    || typeof payload.iss !== "string"
    || typeof payload.sub !== "string"
    || typeof payload.owner !== "string"
    || typeof payload.actor !== "string"
    || !Array.isArray(payload.scopes)
    || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp)
    || !payload.jti
    || payload.exp <= payload.iat
    || payload.exp - payload.iat > MAX_TTL_SECONDS
    || current < payload.iat - clockSkewSeconds
    || current > payload.exp + clockSkewSeconds
  ) {
    throw new AiPlatformError("authentication failed", { code: "expired_auth", status: 401 });
  }
  if (expectedIssuer && payload.iss !== expectedIssuer) {
    throw new AiPlatformError("authentication failed", { code: "invalid_auth", status: 401 });
  }
  const scopes = new Set(payload.scopes.map(String));
  for (const required of requiredScopes) {
    if (!scopes.has(required) && !scopes.has("ai:admin:*")) {
      throw new AiPlatformError("permission denied", { code: "forbidden", status: 403 });
    }
  }
  return Object.freeze({
    issuer: payload.iss,
    subject: payload.sub,
    owner: payload.owner,
    actor: payload.actor,
    scopes: [...scopes].sort(),
    jti: payload.jti,
    issuedAt: new Date(payload.iat * 1000).toISOString(),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    isAdmin: scopes.has("ai:admin:*") || scopes.has("ai:admin:read") || scopes.has("ai:admin:write"),
  });
}

export function authenticateRequest(request, config, { requiredScopes = [], allowDevAdmin = false } = {}) {
  const devAuth = request.headers["x-ai-platform-dev-auth"];
  const remoteAddress = request.socket?.remoteAddress ?? "";
  if (
    allowDevAdmin
    && config.nodeEnv === "development"
    && devAuth === "1"
    && (remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1")
  ) {
    return Object.freeze({
      issuer: "local-development",
      subject: "local-admin",
      owner: "local-admin",
      actor: "local-admin",
      scopes: ["ai:admin:*"],
      jti: "local-development",
      isAdmin: true,
    });
  }
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
  if (!match) throw new AiPlatformError("authentication required", { code: "missing_auth", status: 401 });
  return verifyServiceToken(match[1], { secret: config.authSecret, requiredScopes });
}
