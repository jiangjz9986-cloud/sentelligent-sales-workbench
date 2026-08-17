import { createHash, randomBytes, randomUUID } from "node:crypto";

const TOKEN_BYTES = 32;
const TOKEN_PREFIX_LENGTH = 8;

function requiredText(value, name, max) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function optionalText(value, name, max) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, max);
}

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenText(value) {
  const token = requiredText(value, "token", 200);
  if (!/^[A-Za-z0-9_-]{43,200}$/u.test(token)) throw new TypeError("token has invalid format");
  return token;
}

function rowItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    account: row.account,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function createShortcutWebhookTokenRepository(db, {
  idFactory = randomUUID,
  tokenFactory = () => randomBytes(TOKEN_BYTES).toString("base64url"),
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof tokenFactory !== "function") throw new TypeError("tokenFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const findByHash = db.prepare(`
    SELECT id, label, account, token_prefix, created_at, last_used_at, revoked_at
    FROM shortcut_webhook_tokens
    WHERE token_hash = $tokenHash
  `);
  const listByAccount = db.prepare(`
    SELECT id, label, account, token_prefix, created_at, last_used_at, revoked_at
    FROM shortcut_webhook_tokens
    WHERE account = $account
    ORDER BY created_at DESC, id DESC
  `);
  const findById = db.prepare(`
    SELECT id, label, account, token_prefix, created_at, last_used_at, revoked_at
    FROM shortcut_webhook_tokens
    WHERE id = $id AND account = $account
  `);

  function nowIso() {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
    return date.toISOString();
  }

  function create({ account, label = "iOS 快捷指令" } = {}) {
    const normalizedAccount = requiredText(account, "account", 200);
    const normalizedLabel = requiredText(label, "label", 100);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = tokenText(tokenFactory());
      const id = requiredText(idFactory(), "generated token id", 200);
      const createdAt = nowIso();
      try {
        db.prepare(`
          INSERT INTO shortcut_webhook_tokens (
            id, token_hash, token_prefix, label, account, created_at
          ) VALUES ($id, $tokenHash, $tokenPrefix, $label, $account, $createdAt)
        `).run({
          $id: id,
          $tokenHash: tokenHash(token),
          $tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
          $label: normalizedLabel,
          $account: normalizedAccount,
          $createdAt: createdAt,
        });
        return { ...rowItem(findById.get({ $id: id, $account: normalizedAccount })), token };
      } catch (error) {
        if (error?.code !== "SQLITE_CONSTRAINT_UNIQUE" && error?.code !== "SQLITE_CONSTRAINT_PRIMARYKEY") throw error;
      }
    }
    throw new Error("Unable to generate a unique Shortcut webhook token");
  }

  function resolve(token) {
    const normalizedToken = tokenText(token);
    const row = findByHash.get({ $tokenHash: tokenHash(normalizedToken) });
    if (!row || row.revoked_at) return null;
    const lastUsedAt = nowIso();
    db.prepare(`
      UPDATE shortcut_webhook_tokens
      SET last_used_at = $lastUsedAt
      WHERE id = $id AND revoked_at IS NULL
    `).run({ $id: row.id, $lastUsedAt: lastUsedAt });
    return { ...rowItem({ ...row, last_used_at: lastUsedAt }), tokenId: row.id };
  }

  function list({ account } = {}) {
    return listByAccount.all({ $account: requiredText(account, "account", 200) }).map(rowItem);
  }

  function revoke({ account, id } = {}) {
    const normalizedAccount = requiredText(account, "account", 200);
    const normalizedId = requiredText(id, "id", 200);
    const now = nowIso();
    const result = db.prepare(`
      UPDATE shortcut_webhook_tokens
      SET revoked_at = COALESCE(revoked_at, $revokedAt)
      WHERE id = $id AND account = $account
    `).run({ $id: normalizedId, $account: normalizedAccount, $revokedAt: now });
    if (!result.changes) return null;
    return rowItem(findById.get({ $id: normalizedId, $account: normalizedAccount }));
  }

  return { create, resolve, list, revoke };
}

export { tokenHash };
