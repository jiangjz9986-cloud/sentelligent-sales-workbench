// v0.9.3 测试夹具：直插 users + weixin_bindings（绑定表即 sender 白名单）。
// 机器令牌 harness 不登录，password_hash 只需满足表 CHECK 的 scrypt 前缀形态。
export const TEST_USER_HASH = `scrypt$16384$8$1$${"A".repeat(22)}$${"B".repeat(86)}`;

export function seedWeixinBinding(db, {
  account,
  senderId,
  displayName = "测试用户",
  role = "member",
  financialEnabled = true,
  digestEnabled = true,
  now = "2026-08-29T00:00:00.000Z",
} = {}) {
  db.prepare(`
    INSERT INTO users (account, display_name, password_hash, role, status, created_at, updated_at)
    VALUES ($account, $displayName, $hash, $role, 'active', $now, $now)
    ON CONFLICT(account) DO NOTHING
  `).run({ $account: account, $displayName: displayName, $hash: TEST_USER_HASH, $role: role, $now: now });
  db.prepare(`
    INSERT INTO weixin_bindings
      (sender_id, account, display_name, financial_enabled, digest_enabled, status,
       bound_at, bound_by, version, created_at, updated_at)
    VALUES ($senderId, $account, NULL, $financial, $digest, 'active', $now, 'unit-fixture', 1, $now, $now)
    ON CONFLICT(sender_id) DO UPDATE SET
      account = excluded.account,
      financial_enabled = excluded.financial_enabled,
      digest_enabled = excluded.digest_enabled,
      status = 'active',
      version = weixin_bindings.version + 1,
      updated_at = excluded.updated_at
  `).run({
    $senderId: senderId,
    $account: account,
    $financial: financialEnabled ? 1 : 0,
    $digest: digestEnabled ? 1 : 0,
    $now: now,
  });
}
