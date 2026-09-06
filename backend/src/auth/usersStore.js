import { insertAudit } from "../audit/auditRepository.js";
import { validatePasswordHashEncoding } from "./password.js";

// 与迁移 0030 的种子校验语义保持一致：改其一必改另一。
const ACCOUNT_RE = /^[a-z0-9]{2,32}$/;

export class UserNotFoundError extends Error {
  constructor(account) {
    super(`User ${account} was not found`);
    this.name = "UserNotFoundError";
  }
}

export class UserVersionConflictError extends Error {
  constructor(account, currentVersion) {
    super(`User ${account} was updated by another request`);
    this.name = "UserVersionConflictError";
    this.currentVersion = currentVersion;
  }
}

export function isValidUserAccount(account) {
  return typeof account === "string" && ACCOUNT_RE.test(account);
}

function userFromRow(row, { includePasswordHash = false } = {}) {
  if (!row) return null;
  const user = {
    account: row.account,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
  // password_hash 仅供进程内比对使用，HTTP 层与审计永不序列化。
  if (includePasswordHash) user.passwordHash = row.password_hash;
  return user;
}

export function getUser(db, account) {
  if (typeof account !== "string" || !account) return null;
  const row = db.prepare(`
    SELECT account, display_name, password_hash, role, status, version,
           created_at, updated_at, last_login_at
    FROM users
    WHERE account = $account
  `).get({ $account: account });
  return userFromRow(row, { includePasswordHash: true });
}

export function listUsers(db) {
  return db.prepare(`
    SELECT account, display_name, role, status, version,
           created_at, updated_at, last_login_at
    FROM users
    ORDER BY account ASC
  `).all().map((row) => userFromRow(row));
}

export function createUser(db, { account, displayName, passwordHash, role = "member", now }) {
  const createdAt = typeof now === "string" ? now : new Date(now ?? Date.now()).toISOString();
  db.prepare(`
    INSERT INTO users (account, display_name, password_hash, role, status, created_at, updated_at)
    VALUES ($account, $displayName, $passwordHash, $role, 'active', $now, $now)
  `).run({
    $account: account,
    $displayName: displayName,
    $passwordHash: passwordHash,
    $role: role,
    $now: createdAt,
  });
  return getUser(db, account);
}

// users 的主键是 account（非 id），不复用 server.js 的 runVersionedUpdate。
export function updateUserVersioned(db, { account, expectedVersion, set, now }) {
  const updatedAt = typeof now === "string" ? now : new Date(now ?? Date.now()).toISOString();
  const assignments = [];
  const params = {
    $account: account,
    $expectedVersion: expectedVersion,
    $updatedAt: updatedAt,
  };
  if (set.displayName !== undefined) {
    assignments.push("display_name = $displayName");
    params.$displayName = set.displayName;
  }
  if (set.role !== undefined) {
    assignments.push("role = $role");
    params.$role = set.role;
  }
  if (set.status !== undefined) {
    assignments.push("status = $status");
    params.$status = set.status;
  }
  if (set.passwordHash !== undefined) {
    assignments.push("password_hash = $passwordHash");
    params.$passwordHash = set.passwordHash;
  }
  if (assignments.length === 0) throw new Error("At least one user field is required");

  const result = db.prepare(`
    UPDATE users
    SET ${assignments.join(", ")},
        version = version + 1,
        updated_at = $updatedAt
    WHERE account = $account
      AND version = $expectedVersion
  `).run(params);
  if (result.changes !== 1) {
    const current = getUser(db, account);
    if (!current) throw new UserNotFoundError(account);
    throw new UserVersionConflictError(account, current.version);
  }
  return getUser(db, account);
}

export function recordLastLogin(db, account, nowIso) {
  return db.prepare(`
    UPDATE users SET last_login_at = $now WHERE account = $account
  `).run({ $account: account, $now: nowIso });
}

export function countActiveAdmins(db) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'
  `).get().count);
}

// 启动兜底种子：只插不改——绝不覆盖已有行的密码，否则 UI 改密会被每次重启还原。
export function ensureBootstrapAdmin(db, config, { now = Date.now() } = {}) {
  const account = String(config?.authAccount ?? "").trim();
  const passwordHash = String(config?.authPasswordHash ?? "").trim();
  if (!ACCOUNT_RE.test(account)) return null;
  if (!validatePasswordHashEncoding(passwordHash)) return null;
  if (getUser(db, account)) return null;

  const user = createUser(db, {
    account,
    displayName: "继振",
    passwordHash,
    role: "admin",
    now,
  });
  insertAudit(db, {
    action: "user.create",
    entityType: "user",
    entityId: account,
    actor: "system:bootstrap",
    before: null,
    after: {
      account: user.account,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
    },
    metadata: { reason: "bootstrap_seed" },
  });
  console.warn(
    `category=auth bootstrap admin seeded account=${account} (users table had no row for the configured AUTH_ACCOUNT)`,
  );
  return user;
}
