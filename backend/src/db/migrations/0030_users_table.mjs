// v0.9.1 L1 认证层：users 表 + env 种子（首个 admin）+ action_items.assignee 显示名回填。
// 种子读 process.env（生产=cutover 后 backend 首启应用迁移，EnvironmentFile 在位）；
// env 缺失/非法（如 /dev/shm 彩排的 env-less 语境）时跳过种子，由 server.js 启动期
// ensureBootstrapAdmin 兜底补种——两处校验语义必须保持一致，改其一必改另一。
const ACCOUNT_RE = /^[a-z0-9]{2,32}$/;
const SCRYPT_RE = /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/;

export function apply(db) {
  db.exec(`
    CREATE TABLE users (
      account TEXT PRIMARY KEY NOT NULL
        CHECK (length(account) BETWEEN 2 AND 32 AND account NOT GLOB '*[^a-z0-9]*'),
      display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 50),
      password_hash TEXT NOT NULL CHECK (password_hash GLOB 'scrypt$16384$8$1$*'),
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
  `);
  const account = String(process.env.AUTH_ACCOUNT ?? "").trim();
  const envHash = String(process.env.AUTH_PASSWORD_HASH ?? "").trim();
  if (ACCOUNT_RE.test(account) && SCRYPT_RE.test(envHash)) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (account, display_name, password_hash, role, status, created_at, updated_at)
      VALUES ($account, '继振', $envHash, 'admin', 'active', $now, $now)
    `).run({ $account: account, $envHash: envHash, $now: now });
  }
  // 0029 已把 owner/assignee 统一为账号 id；有 display_name 后把展示列换回人名。
  // 子查询以 assignee∈users.account 为闸：种子缺席时空转、二跑幂等（'继振'∉account）。
  db.exec(`
    UPDATE action_items
       SET assignee = (SELECT display_name FROM users WHERE users.account = action_items.assignee)
     WHERE assignee IN (SELECT account FROM users)
  `);
}
