import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword } from "../src/auth/password.js";
import {
  UserNotFoundError,
  UserVersionConflictError,
  countActiveAdmins,
  createUser,
  ensureBootstrapAdmin,
  getUser,
  isValidUserAccount,
  listUsers,
  recordLastLogin,
  updateUserVersioned,
} from "../src/auth/usersStore.js";
import { openDatabase } from "../src/db.js";

const unitHash = await hashPassword("unit-store-password", { salt: Buffer.alloc(16, 21) });
const otherUnitHash = await hashPassword("unit-rotated-password", { salt: Buffer.alloc(16, 22) });

function withDb(testBody) {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    testBody(db);
  } finally {
    db.close();
  }
}

test("users store creates, reads, and lists rows without leaking hashes over list", () => {
  withDb((db) => {
    const created = createUser(db, {
      account: "zhangsan",
      displayName: "张三",
      passwordHash: unitHash,
      role: "member",
      now: "2026-08-29T01:00:00.000Z",
    });
    assert.deepEqual(
      {
        account: created.account,
        displayName: created.displayName,
        role: created.role,
        status: created.status,
        version: created.version,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        lastLoginAt: created.lastLoginAt,
      },
      {
        account: "zhangsan",
        displayName: "张三",
        role: "member",
        status: "active",
        version: 1,
        createdAt: "2026-08-29T01:00:00.000Z",
        updatedAt: "2026-08-29T01:00:00.000Z",
        lastLoginAt: null,
      },
    );
    createUser(db, { account: "aaboss", displayName: "老板", passwordHash: unitHash, role: "admin" });

    const full = getUser(db, "zhangsan");
    assert.equal(full.passwordHash, unitHash);
    assert.equal(getUser(db, "missing"), null);
    assert.equal(getUser(db, ""), null);

    const listed = listUsers(db);
    assert.deepEqual(listed.map((user) => user.account), ["aaboss", "zhangsan"]);
    for (const user of listed) {
      assert.equal("passwordHash" in user, false);
      assert.equal("password_hash" in user, false);
    }

    assert.throws(
      () => createUser(db, { account: "zhangsan", displayName: "重复", passwordHash: unitHash }),
      /UNIQUE constraint failed/i,
    );
  });
});

test("versioned updates enforce optimistic locking and distinguish 404 from conflicts", () => {
  withDb((db) => {
    createUser(db, { account: "zhangsan", displayName: "张三", passwordHash: unitHash });

    const renamed = updateUserVersioned(db, {
      account: "zhangsan",
      expectedVersion: 1,
      set: { displayName: "张三丰", role: "admin" },
      now: "2026-08-29T02:00:00.000Z",
    });
    assert.equal(renamed.displayName, "张三丰");
    assert.equal(renamed.role, "admin");
    assert.equal(renamed.version, 2);
    assert.equal(renamed.updatedAt, "2026-08-29T02:00:00.000Z");

    assert.throws(
      () => updateUserVersioned(db, {
        account: "zhangsan",
        expectedVersion: 1,
        set: { status: "disabled" },
      }),
      (error) => error instanceof UserVersionConflictError && error.currentVersion === 2,
    );
    assert.throws(
      () => updateUserVersioned(db, {
        account: "missing",
        expectedVersion: 1,
        set: { status: "disabled" },
      }),
      (error) => error instanceof UserNotFoundError,
    );
    assert.throws(
      () => updateUserVersioned(db, { account: "zhangsan", expectedVersion: 2, set: {} }),
      /At least one user field/i,
    );

    const rotated = updateUserVersioned(db, {
      account: "zhangsan",
      expectedVersion: 2,
      set: { passwordHash: otherUnitHash },
    });
    assert.equal(rotated.version, 3);
    assert.equal(getUser(db, "zhangsan").passwordHash, otherUnitHash);
  });
});

test("recordLastLogin stamps the login time without bumping the edit version", () => {
  withDb((db) => {
    createUser(db, { account: "zhangsan", displayName: "张三", passwordHash: unitHash });
    const before = getUser(db, "zhangsan");
    recordLastLogin(db, "zhangsan", "2026-08-29T03:00:00.000Z");
    const after = getUser(db, "zhangsan");
    assert.equal(after.lastLoginAt, "2026-08-29T03:00:00.000Z");
    assert.equal(after.version, before.version);
    assert.equal(after.updatedAt, before.updatedAt);
  });
});

test("countActiveAdmins only counts active admin rows", () => {
  withDb((db) => {
    assert.equal(countActiveAdmins(db), 0);
    createUser(db, { account: "aaboss", displayName: "老板", passwordHash: unitHash, role: "admin" });
    createUser(db, { account: "zhangsan", displayName: "张三", passwordHash: unitHash, role: "member" });
    createUser(db, { account: "libai", displayName: "李白", passwordHash: unitHash, role: "admin" });
    assert.equal(countActiveAdmins(db), 2);
    updateUserVersioned(db, { account: "libai", expectedVersion: 1, set: { status: "disabled" } });
    assert.equal(countActiveAdmins(db), 1);
  });
});

test("ensureBootstrapAdmin seeds an empty table, audits as system:bootstrap, and never overwrites", () => {
  withDb((db) => {
    const seeded = ensureBootstrapAdmin(db, { authAccount: "jiangjz", authPasswordHash: unitHash });
    assert.equal(seeded.account, "jiangjz");
    assert.equal(seeded.displayName, "继振");
    assert.equal(seeded.role, "admin");
    assert.equal(seeded.status, "active");
    const audit = db.prepare(
      "SELECT actor, action, entity_id FROM audit_logs WHERE action = 'user.create'",
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(audit, [{ actor: "system:bootstrap", action: "user.create", entity_id: "jiangjz" }]);

    // 已有行绝不覆盖：UI 改密后的哈希不能被重启还原。
    updateUserVersioned(db, {
      account: "jiangjz",
      expectedVersion: 1,
      set: { passwordHash: otherUnitHash },
    });
    assert.equal(ensureBootstrapAdmin(db, { authAccount: "jiangjz", authPasswordHash: unitHash }), null);
    assert.equal(getUser(db, "jiangjz").passwordHash, otherUnitHash);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'user.create'").get().count,
      1,
    );
  });
});

test("ensureBootstrapAdmin is a no-op for malformed env pairs", () => {
  withDb((db) => {
    for (const config of [
      { authAccount: "", authPasswordHash: unitHash },
      { authAccount: "Upper", authPasswordHash: unitHash },
      { authAccount: "with-dash", authPasswordHash: unitHash },
      { authAccount: "jiangjz", authPasswordHash: "" },
      { authAccount: "jiangjz", authPasswordHash: "not-a-hash" },
      {},
    ]) {
      assert.equal(ensureBootstrapAdmin(db, config), null);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  });
});

test("account validity mirrors the migration seed rule", () => {
  assert.equal(isValidUserAccount("jiangjz"), true);
  assert.equal(isValidUserAccount("ab12"), true);
  assert.equal(isValidUserAccount("a"), false);
  assert.equal(isValidUserAccount("With-Upper"), false);
  assert.equal(isValidUserAccount("has space"), false);
  assert.equal(isValidUserAccount("x".repeat(33)), false);
});

test("users table CHECK constraints reject malformed rows", () => {
  withDb((db) => {
    const insert = (overrides = {}) => {
      const row = {
        account: "checkuser",
        display_name: "校验",
        password_hash: unitHash,
        role: "member",
        status: "active",
        version: 1,
        ...overrides,
      };
      db.prepare(`
        INSERT INTO users (account, display_name, password_hash, role, status, version, created_at, updated_at)
        VALUES ($account, $display_name, $password_hash, $role, $status, $version, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')
      `).run({
        $account: row.account,
        $display_name: row.display_name,
        $password_hash: row.password_hash,
        $role: row.role,
        $status: row.status,
        $version: row.version,
      });
    };

    assert.throws(() => insert({ account: "Upper" }), /CHECK constraint failed/i);
    assert.throws(() => insert({ account: "a" }), /CHECK constraint failed/i);
    assert.throws(() => insert({ password_hash: "not-a-hash" }), /CHECK constraint failed/i);
    assert.throws(() => insert({ role: "owner" }), /CHECK constraint failed/i);
    assert.throws(() => insert({ status: "archived" }), /CHECK constraint failed/i);
    assert.throws(() => insert({ version: 0 }), /CHECK constraint failed/i);
    insert();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  });
});
