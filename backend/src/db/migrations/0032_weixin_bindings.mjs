// v0.9.3 L3：weixin_bindings（绑定表=sender 白名单）+ weixin_binding_codes（6 位码 HMAC 哈希）。
// 种子读 env（生产 cutover 后首启 EnvironmentFile 在位）；env-less 彩排跳过种子，
// 由 server.js 启动期 ensureBootstrapBinding 兜底——两处校验语义保持一致（0030 先例）。
export function apply(db) {
  db.exec(`
    CREATE TABLE weixin_bindings (
      sender_id TEXT PRIMARY KEY NOT NULL CHECK (length(sender_id) BETWEEN 1 AND 200),
      account TEXT NOT NULL REFERENCES users(account),
      display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 50),
      financial_enabled INTEGER NOT NULL DEFAULT 0 CHECK (financial_enabled IN (0, 1)),
      digest_enabled INTEGER NOT NULL DEFAULT 1 CHECK (digest_enabled IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      bound_at TEXT NOT NULL,
      bound_by TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_weixin_bindings_one_active_per_account
      ON weixin_bindings(account) WHERE status = 'active';
    CREATE TABLE weixin_binding_codes (
      code_hash TEXT PRIMARY KEY NOT NULL,
      account TEXT NOT NULL REFERENCES users(account),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const senderId = String(process.env.WEIXIN_BOOKKEEPING_SENDER_ID ?? "").trim();
  const account = String(process.env.WEIXIN_BOOKKEEPING_OWNER ?? process.env.AUTH_ACCOUNT ?? "").trim();
  const hasUser = account && db.prepare("SELECT 1 FROM users WHERE account = ?").get(account);
  if (senderId && senderId.length <= 200 && hasUser) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO weixin_bindings
        (sender_id, account, display_name, financial_enabled, digest_enabled, status,
         bound_at, bound_by, created_at, updated_at)
      VALUES ($senderId, $account, NULL, 1, 1, 'active', $now, 'system:bootstrap', $now, $now)
    `).run({ $senderId: senderId, $account: account, $now: now });
  }
}
