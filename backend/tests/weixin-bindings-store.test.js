// v0.9.3：bindingsRepository CRUD/乐观锁/one-active 冲突/换绑 upsert；
// bindingCodes 生成-过期-一次性-撞库重试-同账号旧码作废；ensureBootstrapBinding 只插不改。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { openDatabase } from "../src/db.js";
import {
  hashBindingCode,
  issueBindingCode,
  pruneExpiredBindingCodes,
  redeemBindingCode,
} from "../src/weixin/bindingCodes.js";
import {
  createWeixinBindingsRepository,
  ensureBootstrapBinding,
  weixinSenderHash,
} from "../src/weixin/bindingsRepository.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";

const seedHash = await hashPassword("unit-store-password", { salt: Buffer.alloc(16, 57) });
const codeSecret = ["unit", "binding", "codes", "secret"].join("-");

let dir;
let db;
let repository;
let fixedNow;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sent-weixin-bindings-store-"));
  db = openDatabase({ databaseUrl: join(dir, "bindings.sqlite") });
  fixedNow = Date.parse("2026-08-29T04:00:00.000Z");
  const insertUser = db.prepare(`
    INSERT INTO users (account, display_name, password_hash, role, status, created_at, updated_at)
    VALUES ($account, $displayName, $hash, $role, $status, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')
  `);
  insertUser.run({ $account: "jiangjz", $displayName: "继振", $hash: seedHash, $role: "admin", $status: "active" });
  insertUser.run({ $account: "testb", $displayName: "同事乙", $hash: seedHash, $role: "member", $status: "active" });
  insertUser.run({ $account: "gonecolleague", $displayName: "离职同事", $hash: seedHash, $role: "member", $status: "disabled" });
  repository = createWeixinBindingsRepository(db, { clock: () => new Date(fixedNow) });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("weixin bindings repository", () => {
  it("binds, resolves by sender/account, and enforces one active binding per account", () => {
    const bound = repository.bind({ senderId: "sender-1", account: "jiangjz", boundBy: "jiangjz", financialEnabled: true });
    assert.equal(bound.status, "active");
    assert.equal(bound.financialEnabled, true);
    assert.equal(bound.digestEnabled, true);
    assert.equal(bound.version, 1);
    assert.deepEqual(repository.activeBySender("sender-1").account, "jiangjz");
    assert.deepEqual(repository.activeByAccount("jiangjz").senderId, "sender-1");
    assert.equal(repository.hasActive(), true);
    assert.equal(repository.countActive(), 1);

    assert.throws(
      () => repository.bind({ senderId: "sender-2", account: "jiangjz", boundBy: "jiangjz" }),
      (error) => error?.code === "ACCOUNT_ALREADY_BOUND" && error?.status === 409,
    );

    // 同 sender 换绑 upsert：换 account、版本递增、旧账号释放。
    repository.bind({ senderId: "sender-1", account: "testb", boundBy: "jiangjz" });
    const rebound = repository.activeBySender("sender-1");
    assert.equal(rebound.account, "testb");
    assert.equal(rebound.financialEnabled, false, "rebinding resets financial to the closed default");
    assert.equal(rebound.version, 2);
    assert.equal(repository.activeByAccount("jiangjz"), null);
  });

  it("disables bindings, releases the account slot, and supports versioned updates", () => {
    repository.bind({ senderId: "sender-1", account: "jiangjz", boundBy: "jiangjz" });
    const disabled = repository.disable("sender-1", { by: "jiangjz" });
    assert.equal(disabled.status, "disabled");
    assert.equal(repository.activeBySender("sender-1"), null);
    assert.equal(repository.hasActive(), false);

    // 解绑后同账号可绑新 sender。
    repository.bind({ senderId: "sender-1b", account: "jiangjz", boundBy: "jiangjz" });
    assert.equal(repository.activeByAccount("jiangjz").senderId, "sender-1b");

    // 乐观锁：错误版本 409 currentVersion 回显；正确版本更新开关。
    const current = repository.bySender("sender-1b");
    assert.throws(
      () => repository.updateVersioned({ senderId: "sender-1b", expectedVersion: current.version + 5, set: { financialEnabled: true } }),
      (error) => error?.code === "VERSION_CONFLICT" && error?.fields?.currentVersion === current.version,
    );
    const updated = repository.updateVersioned({
      senderId: "sender-1b",
      expectedVersion: current.version,
      set: { financialEnabled: true, digestEnabled: false, displayName: "老蒋" },
    });
    assert.equal(updated.financialEnabled, true);
    assert.equal(updated.digestEnabled, false);
    assert.equal(updated.displayName, "老蒋");
    assert.equal(updated.version, current.version + 1);
    assert.throws(
      () => repository.updateVersioned({ senderId: "ghost-sender", expectedVersion: 1, set: { status: "disabled" } }),
      (error) => error?.code === "WEIXIN_BINDING_NOT_FOUND",
    );

    // 重新激活被停用行受 one-active 索引约束：账号已有 active → 409。
    const staleDisabled = repository.bySender("sender-1");
    assert.throws(
      () => repository.updateVersioned({ senderId: "sender-1", expectedVersion: staleDisabled.version, set: { status: "active" } }),
      (error) => error?.code === "ACCOUNT_ALREADY_BOUND",
    );
  });

  it("lists digest and admin targets with the delivery-scope conversation id", () => {
    repository.bind({ senderId: "sender-1", account: "jiangjz", boundBy: "jiangjz" });
    repository.bind({ senderId: "sender-2", account: "testb", boundBy: "jiangjz" });
    assert.deepEqual(repository.listDigestTargets(), [
      { account: "jiangjz", senderId: "sender-1", conversationId: shortcutBookkeepingConversationId("jiangjz", "sender-1") },
      { account: "testb", senderId: "sender-2", conversationId: shortcutBookkeepingConversationId("testb", "sender-2") },
    ]);
    assert.deepEqual(repository.listAdminTargets().map((target) => target.account), ["jiangjz"]);

    // digest_enabled=0 退出主动推送目标，但 admin 告警目标不受 digest 总闸影响。
    const binding = repository.activeBySender("sender-1");
    repository.updateVersioned({ senderId: "sender-1", expectedVersion: binding.version, set: { digestEnabled: false } });
    assert.deepEqual(repository.listDigestTargets().map((target) => target.account), ["testb"]);
    assert.deepEqual(repository.listAdminTargets().map((target) => target.account), ["jiangjz"]);
    assert.equal(repository.listAll().length, 2);
  });
});

describe("weixin binding codes", () => {
  it("hashes with the domain-separated HMAC and never stores plaintext", () => {
    const issued = issueBindingCode(db, { account: "testb", createdBy: "jiangjz", secret: codeSecret, now: fixedNow });
    assert.match(issued.code, /^[0-9]{6}$/);
    assert.equal(issued.expiresAt, new Date(fixedNow + 10 * 60_000).toISOString());
    const row = db.prepare("SELECT code_hash, account, created_by FROM weixin_binding_codes").get();
    assert.equal(row.code_hash, hashBindingCode(codeSecret, issued.code));
    assert.notEqual(row.code_hash, issued.code);
    assert.equal(row.account, "testb");
    assert.equal(row.created_by, "jiangjz");
  });

  it("keeps one live code per account and retries hash collisions", () => {
    const first = issueBindingCode(db, { account: "testb", createdBy: "jiangjz", secret: codeSecret, now: fixedNow });
    const second = issueBindingCode(db, { account: "testb", createdBy: "jiangjz", secret: codeSecret, now: fixedNow });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_binding_codes").get().count, 1);
    assert.deepEqual(redeemBindingCode(db, { code: first.code, secret: codeSecret, now: fixedNow }), {
      account: null,
      error: first.code === second.code ? null : "invalid",
    });

    // PK 撞历史行（重复 codeFactory 输出）→ 自动重试到不同码。
    let calls = 0;
    const collided = issueBindingCode(db, {
      account: "jiangjz",
      createdBy: "jiangjz",
      secret: codeSecret,
      now: fixedNow,
      codeFactory: () => {
        calls += 1;
        return calls === 1 ? second.code : "424242";
      },
    });
    assert.equal(collided.code, "424242");
    assert.equal(calls, 2);
  });

  it("redeems exactly once and distinguishes invalid, expired, and used codes", () => {
    const issued = issueBindingCode(db, { account: "testb", createdBy: "jiangjz", secret: codeSecret, now: fixedNow });
    assert.deepEqual(redeemBindingCode(db, { code: "999999" === issued.code ? "999998" : "999999", secret: codeSecret, now: fixedNow }), {
      account: null,
      error: "invalid",
    });
    assert.deepEqual(redeemBindingCode(db, { code: "not-a-code", secret: codeSecret, now: fixedNow }), {
      account: null,
      error: "invalid",
    });
    const redeemed = redeemBindingCode(db, { code: issued.code, secret: codeSecret, now: fixedNow + 1_000 });
    assert.deepEqual(redeemed, { account: "testb", error: null });
    assert.deepEqual(redeemBindingCode(db, { code: issued.code, secret: codeSecret, now: fixedNow + 2_000 }), {
      account: null,
      error: "used",
    });

    const expiring = issueBindingCode(db, { account: "jiangjz", createdBy: "jiangjz", secret: codeSecret, now: fixedNow });
    assert.deepEqual(
      redeemBindingCode(db, { code: expiring.code, secret: codeSecret, now: fixedNow + 10 * 60_000 + 1 }),
      { account: null, error: "expired" },
    );

    // >24h 陈行顺手清理；已用行同样随过期时间离场。
    pruneExpiredBindingCodes(db, { now: fixedNow + 25 * 60 * 60_000 });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_binding_codes").get().count, 0);
  });
});

describe("ensureBootstrapBinding", () => {
  it("seeds once from env config, never resurrects disabled rows, and stays insert-only", () => {
    const config = { weixinBookkeepingSenderId: "seed-sender", weixinBookkeepingOwner: "jiangjz" };
    const seeded = ensureBootstrapBinding(db, config, { now: fixedNow });
    assert.equal(seeded.account, "jiangjz");
    assert.equal(seeded.financialEnabled, true);
    assert.equal(seeded.digestEnabled, true);
    assert.equal(seeded.boundBy, "system:bootstrap");
    const audit = db.prepare("SELECT actor, entity_id, metadata_json FROM audit_logs WHERE action = 'weixin.binding.bound'").get();
    assert.equal(audit.actor, "system:bootstrap");
    assert.equal(audit.entity_id, weixinSenderHash("seed-sender"));
    assert.doesNotMatch(JSON.stringify({ ...audit }), /seed-sender/);

    // 已有 active 行 → no-op（只插不改）。
    assert.equal(ensureBootstrapBinding(db, config, { now: fixedNow }), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_bindings").get().count, 1);

    // admin 显式停用后不复活。
    repository.disable("seed-sender", { by: "jiangjz" });
    assert.equal(ensureBootstrapBinding(db, config, { now: fixedNow }), null);
    assert.equal(repository.hasActive(), false);

    // env 缺失/幽灵账号 → no-op。
    assert.equal(ensureBootstrapBinding(db, {}, { now: fixedNow }), null);
    assert.equal(
      ensureBootstrapBinding(db, { weixinBookkeepingSenderId: "x", weixinBookkeepingOwner: "ghostacct" }, { now: fixedNow }),
      null,
    );
  });
});
