// v0.9.3：6 位绑定码——HMAC-SHA256 哈希存储（明文只出现在 issue 响应一次），
// TTL 10 分钟、一次性原子兑换、一账号一活跃码。复用 assistantConfirmationSecret
// 独立密钥（不加 env 键），域分隔前缀防跨用途碰撞。
import { createHmac, randomInt } from "node:crypto";

const CODE_NAMESPACE = "sentelligent/weixin-binding-code/v1";
const CODE_RE = /^[0-9]{6}$/u;
const DEFAULT_TTL_MS = 10 * 60_000;
const PRUNE_AGE_MS = 24 * 60 * 60_000;
const MAX_ISSUE_RETRIES = 5;

function secretBuffer(secret) {
  if (secret instanceof Buffer) {
    if (secret.byteLength === 0) throw new TypeError("binding code secret is required");
    return secret;
  }
  if (typeof secret === "string" && secret.trim()) return Buffer.from(secret, "utf8");
  throw new TypeError("binding code secret is required");
}

function nowMs(value) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms)) throw new TypeError("now must be a valid time");
  return ms;
}

export function hashBindingCode(secret, code) {
  const normalized = String(code ?? "");
  if (!CODE_RE.test(normalized)) throw new TypeError("binding code must be six digits");
  return createHmac("sha256", secretBuffer(secret))
    .update(`${CODE_NAMESPACE}\u0000${normalized}`, "utf8")
    .digest("hex");
}

// 先作废该账号未用码（一账号一活跃码），随机 6 位入库；PK 撞历史行则重试 ≤5。
// 返回值中的 code 明文是它在系统里唯一一次出现。
export function issueBindingCode(db, {
  account,
  createdBy,
  secret,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  codeFactory = null,
} = {}) {
  if (typeof account !== "string" || !account.trim()) throw new TypeError("account is required");
  if (typeof createdBy !== "string" || !createdBy.trim()) throw new TypeError("createdBy is required");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) throw new TypeError("ttlMs is invalid");
  const issuedAtMs = nowMs(now);
  const createdAt = new Date(issuedAtMs).toISOString();
  const expiresAt = new Date(issuedAtMs + ttlMs).toISOString();

  db.prepare("DELETE FROM weixin_binding_codes WHERE account = $account AND used_at IS NULL")
    .run({ $account: account.trim() });

  for (let attempt = 0; attempt < MAX_ISSUE_RETRIES; attempt += 1) {
    const code = typeof codeFactory === "function"
      ? String(codeFactory())
      : String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!CODE_RE.test(code)) throw new TypeError("codeFactory must produce six digits");
    try {
      db.prepare(`
        INSERT INTO weixin_binding_codes (code_hash, account, expires_at, used_at, created_by, created_at)
        VALUES ($codeHash, $account, $expiresAt, NULL, $createdBy, $createdAt)
      `).run({
        $codeHash: hashBindingCode(secret, code),
        $account: account.trim(),
        $expiresAt: expiresAt,
        $createdBy: createdBy.trim(),
        $createdAt: createdAt,
      });
      return { code, expiresAt };
    } catch (error) {
      if (/UNIQUE constraint failed/iu.test(String(error?.message ?? ""))) continue;
      throw error;
    }
  }
  throw new Error("Unable to issue a unique binding code after retries");
}

// 一次性原子兑换：UPDATE 命中即消耗；失败时按剩余行区分 invalid/expired/used。
// 调用方将本函数与后续 bind 包在同一事务里，绑定失败即回滚码消耗。
export function redeemBindingCode(db, { code, secret, now = Date.now() } = {}) {
  const normalized = String(code ?? "");
  if (!CODE_RE.test(normalized)) return { account: null, error: "invalid" };
  const codeHash = hashBindingCode(secret, normalized);
  const nowIso = new Date(nowMs(now)).toISOString();
  const consumed = db.prepare(`
    UPDATE weixin_binding_codes
    SET used_at = $now
    WHERE code_hash = $codeHash AND used_at IS NULL AND expires_at > $now
  `).run({ $codeHash: codeHash, $now: nowIso });
  if (consumed.changes === 1) {
    const row = db.prepare("SELECT account FROM weixin_binding_codes WHERE code_hash = $codeHash")
      .get({ $codeHash: codeHash });
    return { account: row.account, error: null };
  }
  const row = db.prepare("SELECT used_at, expires_at FROM weixin_binding_codes WHERE code_hash = $codeHash")
    .get({ $codeHash: codeHash });
  if (!row) return { account: null, error: "invalid" };
  if (row.used_at) return { account: null, error: "used" };
  return { account: null, error: "expired" };
}

export function pruneExpiredBindingCodes(db, { now = Date.now() } = {}) {
  const cutoff = new Date(nowMs(now) - PRUNE_AGE_MS).toISOString();
  return db.prepare("DELETE FROM weixin_binding_codes WHERE expires_at <= $cutoff")
    .run({ $cutoff: cutoff });
}
