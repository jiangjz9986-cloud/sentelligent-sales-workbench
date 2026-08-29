// v0.9.3 L3：weixin_bindings 仓库——绑定表本身即 sender 白名单（D2 裁定），
// 一账号至多一条 active 绑定由 partial UNIQUE 索引强制。全部同步、SQL 收敛本文件。
import { createHash } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { HttpError } from "../http/errors.js";
import { shortcutBookkeepingConversationId } from "./bookkeepingDeliveryScope.js";

const MAX_SENDER_LENGTH = 200;
const MAX_ACCOUNT_LENGTH = 200;

function requiredText(value, name, max) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function iso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
  return date.toISOString();
}

export function weixinSenderHash(senderId) {
  return createHash("sha256").update(String(senderId ?? ""), "utf8").digest("hex").slice(0, 16);
}

function bindingFromRow(row) {
  if (!row) return null;
  return {
    senderId: row.sender_id,
    account: row.account,
    displayName: row.display_name,
    financialEnabled: Number(row.financial_enabled) === 1,
    digestEnabled: Number(row.digest_enabled) === 1,
    status: row.status,
    boundAt: row.bound_at,
    boundBy: row.bound_by,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/iu.test(String(error?.message ?? ""));
}

export function createWeixinBindingsRepository(db, { clock = () => new Date() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");

  function activeBySender(senderId) {
    if (typeof senderId !== "string" || !senderId.trim()) return null;
    return bindingFromRow(db.prepare(
      "SELECT * FROM weixin_bindings WHERE sender_id = $senderId AND status = 'active'",
    ).get({ $senderId: senderId.trim() }));
  }

  function activeByAccount(account) {
    if (typeof account !== "string" || !account.trim()) return null;
    return bindingFromRow(db.prepare(
      "SELECT * FROM weixin_bindings WHERE account = $account AND status = 'active'",
    ).get({ $account: account.trim() }));
  }

  function bySender(senderId) {
    if (typeof senderId !== "string" || !senderId.trim()) return null;
    return bindingFromRow(db.prepare(
      "SELECT * FROM weixin_bindings WHERE sender_id = $senderId",
    ).get({ $senderId: senderId.trim() }));
  }

  function hasActive() {
    return Boolean(db.prepare("SELECT 1 AS present FROM weixin_bindings WHERE status = 'active' LIMIT 1").get());
  }

  function countActive() {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM weixin_bindings WHERE status = 'active'").get().count);
  }

  function listAll() {
    return db.prepare("SELECT * FROM weixin_bindings ORDER BY account ASC, sender_id ASC")
      .all()
      .map(bindingFromRow);
  }

  // 主动推送目标（晨报/周五收尾/待办提醒/招标）：active ∧ digest_enabled=1 总闸。
  function listDigestTargets() {
    return db.prepare(`
      SELECT sender_id, account FROM weixin_bindings
      WHERE status = 'active' AND digest_enabled = 1
      ORDER BY account ASC
    `).all().map((row) => ({
      account: row.account,
      senderId: row.sender_id,
      conversationId: shortcutBookkeepingConversationId(row.account, row.sender_id),
    }));
  }

  // 运维告警目标：active admin 绑定（告警非订阅内容，无视 digest_enabled）。
  function listAdminTargets() {
    return db.prepare(`
      SELECT binding.sender_id, binding.account
      FROM weixin_bindings binding
      JOIN users ON users.account = binding.account
      WHERE binding.status = 'active' AND users.role = 'admin' AND users.status = 'active'
      ORDER BY binding.account ASC
    `).all().map((row) => ({
      account: row.account,
      senderId: row.sender_id,
      conversationId: shortcutBookkeepingConversationId(row.account, row.sender_id),
    }));
  }

  // upsert 支持同 sender 换绑；一账号第二条 active 由 partial index 拒绝 → 409。
  function bind({ senderId, account, displayName = null, boundBy, financialEnabled = false, digestEnabled = true } = {}) {
    const normalizedSender = requiredText(senderId, "senderId", MAX_SENDER_LENGTH);
    const normalizedAccount = requiredText(account, "account", MAX_ACCOUNT_LENGTH);
    const normalizedBoundBy = requiredText(boundBy, "boundBy", MAX_ACCOUNT_LENGTH);
    const normalizedDisplayName = displayName === null || displayName === undefined || displayName === ""
      ? null
      : requiredText(displayName, "displayName", 50);
    const now = iso(clock);
    try {
      db.prepare(`
        INSERT INTO weixin_bindings
          (sender_id, account, display_name, financial_enabled, digest_enabled, status,
           bound_at, bound_by, version, created_at, updated_at)
        VALUES ($senderId, $account, $displayName, $financial, $digest, 'active', $now, $boundBy, 1, $now, $now)
        ON CONFLICT(sender_id) DO UPDATE SET
          account = excluded.account,
          display_name = excluded.display_name,
          financial_enabled = excluded.financial_enabled,
          digest_enabled = excluded.digest_enabled,
          status = 'active',
          bound_at = excluded.bound_at,
          bound_by = excluded.bound_by,
          version = weixin_bindings.version + 1,
          updated_at = excluded.updated_at
      `).run({
        $senderId: normalizedSender,
        $account: normalizedAccount,
        $displayName: normalizedDisplayName,
        $financial: financialEnabled === true ? 1 : 0,
        $digest: digestEnabled === false ? 0 : 1,
        $now: now,
        $boundBy: normalizedBoundBy,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "ACCOUNT_ALREADY_BOUND", "该账号已存在生效中的微信绑定，请先解绑");
      }
      throw error;
    }
    return bySender(normalizedSender);
  }

  function disable(senderId, { by } = {}) {
    const normalizedSender = requiredText(senderId, "senderId", MAX_SENDER_LENGTH);
    const normalizedBy = requiredText(by, "by", MAX_ACCOUNT_LENGTH);
    const now = iso(clock);
    db.prepare(`
      UPDATE weixin_bindings
      SET status = 'disabled', bound_by = $by, version = version + 1, updated_at = $now
      WHERE sender_id = $senderId AND status = 'active'
    `).run({ $senderId: normalizedSender, $by: normalizedBy, $now: now });
    return bySender(normalizedSender);
  }

  // 乐观锁（0030 usersStore 模式）：expectedVersion 不符 → 409 currentVersion 回显。
  function updateVersioned({ senderId, expectedVersion, set = {} } = {}) {
    const normalizedSender = requiredText(senderId, "senderId", MAX_SENDER_LENGTH);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive safe integer");
    }
    const assignments = [];
    const params = {
      $senderId: normalizedSender,
      $expectedVersion: expectedVersion,
      $now: iso(clock),
    };
    if (set.displayName !== undefined) {
      assignments.push("display_name = $displayName");
      params.$displayName = set.displayName === null || set.displayName === ""
        ? null
        : requiredText(set.displayName, "displayName", 50);
    }
    if (set.financialEnabled !== undefined) {
      assignments.push("financial_enabled = $financial");
      params.$financial = set.financialEnabled === true ? 1 : 0;
    }
    if (set.digestEnabled !== undefined) {
      assignments.push("digest_enabled = $digest");
      params.$digest = set.digestEnabled === true ? 1 : 0;
    }
    if (set.status !== undefined) {
      if (!["active", "disabled"].includes(set.status)) throw new TypeError("status is invalid");
      assignments.push("status = $status");
      params.$status = set.status;
    }
    if (assignments.length === 0) throw new TypeError("At least one binding field is required");

    let result;
    try {
      result = db.prepare(`
        UPDATE weixin_bindings
        SET ${assignments.join(", ")},
            version = version + 1,
            updated_at = $now
        WHERE sender_id = $senderId AND version = $expectedVersion
      `).run(params);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "ACCOUNT_ALREADY_BOUND", "该账号已存在生效中的微信绑定，请先解绑");
      }
      throw error;
    }
    if (result.changes !== 1) {
      const current = bySender(normalizedSender);
      if (!current) throw new HttpError(404, "WEIXIN_BINDING_NOT_FOUND", "微信绑定不存在");
      throw new HttpError(409, "VERSION_CONFLICT", "The binding was updated by another request", {
        currentVersion: current.version,
      });
    }
    return bySender(normalizedSender);
  }

  return Object.freeze({
    activeBySender,
    activeByAccount,
    bySender,
    hasActive,
    countActive,
    listAll,
    listDigestTargets,
    listAdminTargets,
    bind,
    disable,
    updateVersioned,
  });
}

// 启动兜底种子（0030 ensureBootstrapAdmin 同构）：表无 active 行 ∧ env sender/owner 合法
// ∧ users 有该账号 ∧ 该 sender 从无行 → 只插不改；admin 显式停用过的行绝不复活。
export function ensureBootstrapBinding(db, config, { now = Date.now() } = {}) {
  const senderId = String(config?.weixinBookkeepingSenderId ?? "").trim();
  const account = String(config?.weixinBookkeepingOwner ?? config?.authAccount ?? "").trim();
  if (!senderId || senderId.length > MAX_SENDER_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(senderId)) return null;
  if (!account || account.length > MAX_ACCOUNT_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(account)) return null;
  const hasActiveRow = db.prepare("SELECT 1 AS present FROM weixin_bindings WHERE status = 'active' LIMIT 1").get();
  if (hasActiveRow) return null;
  const hasUser = db.prepare("SELECT 1 AS present FROM users WHERE account = $account").get({ $account: account });
  if (!hasUser) return null;
  const existing = db.prepare("SELECT 1 AS present FROM weixin_bindings WHERE sender_id = $senderId").get({ $senderId: senderId });
  if (existing) return null;

  const nowIso = new Date(now).toISOString();
  db.prepare(`
    INSERT INTO weixin_bindings
      (sender_id, account, display_name, financial_enabled, digest_enabled, status,
       bound_at, bound_by, version, created_at, updated_at)
    VALUES ($senderId, $account, NULL, 1, 1, 'active', $now, 'system:bootstrap', 1, $now, $now)
  `).run({ $senderId: senderId, $account: account, $now: nowIso });
  insertAudit(db, {
    action: "weixin.binding.bound",
    entityType: "weixin_binding",
    entityId: weixinSenderHash(senderId),
    actor: "system:bootstrap",
    before: null,
    after: { account, financialEnabled: true, digestEnabled: true, status: "active" },
    metadata: { senderHash: weixinSenderHash(senderId), via: "bootstrap" },
  });
  console.warn(
    `category=weixin bootstrap binding seeded account=${account} (weixin_bindings had no active row for the configured sender)`,
  );
  return bindingFromRow(db.prepare("SELECT * FROM weixin_bindings WHERE sender_id = $senderId").get({ $senderId: senderId }));
}
