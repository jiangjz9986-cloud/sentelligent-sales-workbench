import { createHmac, randomBytes, randomUUID } from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * DAY_MS;

function sessionSecret(config) {
  const secret = String(config?.authSessionSecret ?? "");
  if (!secret.trim()) throw new Error("Auth session secret is required");
  return secret;
}

function digest(config, purpose, value) {
  return createHmac("sha256", sessionSecret(config))
    .update(`${purpose}:${value}`)
    .digest("base64url");
}

export function createCsrfToken(config, sessionId) {
  return digest(config, "csrf:v1", String(sessionId));
}

export function createSession(db, config, { account, now = Date.now() } = {}) {
  const normalizedAccount = String(account ?? "").trim();
  if (!normalizedAccount) throw new Error("Session account is required");

  const id = randomUUID();
  const cookieValue = randomBytes(32).toString("base64url");
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO auth_sessions (id, token_hash, account, expires_at, created_at)
    VALUES (:id, :tokenHash, :account, :expiresAt, :createdAt)
  `).run({
    id,
    tokenHash: digest(config, "session-store:v1", cookieValue),
    account: normalizedAccount,
    expiresAt,
    createdAt,
  });

  const session = {
    id,
    account: normalizedAccount,
    expiresAt,
    csrfToken: createCsrfToken(config, id),
  };
  Object.defineProperty(session, "cookieValue", {
    value: cookieValue,
    enumerable: false,
  });
  return session;
}

export function getActiveSession(db, config, cookieValue, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(cookieValue ?? ""))) return null;
  const row = db.prepare(`
    SELECT id, account, expires_at AS expiresAt
    FROM auth_sessions
    WHERE token_hash = :tokenHash
      AND revoked_at IS NULL
      AND expires_at > :now
  `).get({
    tokenHash: digest(config, "session-store:v1", String(cookieValue)),
    now: new Date(now).toISOString(),
  });
  if (!row) return null;
  return {
    id: row.id,
    account: row.account,
    expiresAt: row.expiresAt,
  };
}

// 按 account 列直查吊销（无需 token 哈希故不收 config）。改密/停用场景使用；
// exceptSessionId 保留操作者当前会话，防改密后被自己踢出。
export function revokeSessionsForAccount(db, account, { exceptSessionId, now = Date.now() } = {}) {
  const normalizedAccount = String(account ?? "").trim();
  if (!normalizedAccount) return { changes: 0 };
  const params = {
    account: normalizedAccount,
    revokedAt: new Date(now).toISOString(),
  };
  let exceptClause = "";
  if (exceptSessionId) {
    exceptClause = "AND id != :exceptSessionId";
    params.exceptSessionId = exceptSessionId;
  }
  return db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = :revokedAt
    WHERE account = :account
      AND revoked_at IS NULL
      ${exceptClause}
  `).run(params);
}

export function revokeSession(db, config, cookieValue, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(cookieValue ?? ""))) return { changes: 0 };
  return db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = :revokedAt
    WHERE token_hash = :tokenHash
      AND revoked_at IS NULL
  `).run({
    revokedAt: new Date(now).toISOString(),
    tokenHash: digest(config, "session-store:v1", String(cookieValue)),
  });
}
