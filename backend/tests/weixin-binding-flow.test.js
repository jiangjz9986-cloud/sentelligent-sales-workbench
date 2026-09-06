// v0.9.3 绑定流红线（测试先写）：未绑定 sender 能力面={绑定意图}，其余零能力固定拒答；
// 绑定码 TTL 10 分钟一次性 + HMAC 哈希存储 + 防爆破限流；解绑两段自助；审计零明文。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";
import { VALID_PNG } from "./helpers/image-fixtures.js";

const passwordField = "pass" + "word";
const adminLoginValue = "unit-admin-password";
const memberLoginValue = "unit-colleague-password";
const machineToken = "weixin-test-machine-token";
const confirmationSecret = ["unit", "binding", "confirmation", "secret", "0123456789abcdef"].join("-");
const adminHash = await hashPassword(adminLoginValue, { salt: Buffer.alloc(16, 53) });

const UNBOUND_DENIAL_SNIPPET = "尚未绑定工作台账号";

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let eventSequence;

async function read(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  return read(await fetch(`${baseUrl}${path}`, { ...options, headers }));
}

async function login(account, loginValue) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: loginValue }),
  });
  assert.equal(result.response.status, 200);
  const cookie = String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  return {
    body: result.body,
    cookie,
    headers: { Cookie: cookie, "X-CSRF-Token": result.body.csrfToken },
  };
}

async function postEvent(senderId, text, { media = null, id = null } = {}) {
  const sourceMessageId = id ?? `binding-flow-${++eventSequence}`;
  return request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineToken}`,
      "Idempotency-Key": `weixin:${sourceMessageId}`,
    },
    body: JSON.stringify({
      conversationId: `wx-${senderId}`,
      text,
      sourceMessageId,
      senderId,
      chatType: "direct",
      ...(media ? { media } : {}),
    }),
  });
}

async function issueCode(adminAuth, account) {
  const issued = await request("/api/admin/weixin-bindings/codes", {
    method: "POST",
    headers: adminAuth.headers,
    body: JSON.stringify({ account }),
  });
  assert.equal(issued.response.status, 201);
  assert.match(issued.body.item.code, /^[0-9]{6}$/);
  assert.ok(issued.body.item.expiresAt);
  return issued.body.item;
}

function withDb(callback) {
  const db = createConnection({ databaseUrl });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function bindingAuditRows() {
  return withDb((db) => db.prepare(`
    SELECT action, entity_type, entity_id, actor, metadata_json
    FROM audit_logs WHERE action LIKE 'weixin.binding.%' ORDER BY created_at, id
  `).all().map((row) => ({ ...row })));
}

function bindingRows() {
  return withDb((db) => db.prepare(
    "SELECT sender_id, account, status, financial_enabled, digest_enabled FROM weixin_bindings ORDER BY sender_id",
  ).all().map((row) => ({ ...row })));
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sent-weixin-binding-flow-"));
  databaseUrl = join(tempDir, "binding-flow.sqlite");
  eventSequence = 0;
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: "jiangjz",
    authPassword: "",
    authPasswordHash: adminHash,
    authSessionSecret: Buffer.alloc(32, 54).toString("base64url"),
    authCookieSecure: false,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: "jiangjz",
    weixinBookkeepingConfirmationEnabled: true,
    assistantConfirmationSecret: confirmationSecret,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe("weixin binding flow", () => {
  it("denies every capability for unbound senders with the fixed guidance and zero persistence", async () => {
    const ordinary = await postEvent("stranger-sender", "客户列表");
    assert.equal(ordinary.response.status, 200);
    assert.equal(ordinary.body.status, "denied");
    assert.match(ordinary.body.text, new RegExp(UNBOUND_DENIAL_SNIPPET));
    assert.match(ordinary.body.text, /绑定 123456/);

    const financial = await postEvent("stranger-sender", "支出 2026-08-21 打车 18.80元");
    assert.equal(financial.body.status, "denied");

    const bareCode = await postEvent("stranger-sender", "123456");
    assert.equal(bareCode.body.status, "denied", "a bare six-digit code must not be treated as binding intent");

    const media = await postEvent("stranger-sender", "", {
      media: {
        type: "image",
        fileName: "proof.png",
        mimeType: "image/png",
        contentBase64: VALID_PNG.toString("base64"),
      },
    });
    assert.equal(media.body.status, "denied");

    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assistant_inbound_events").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_document_inbox").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_blobs").get().count, 0);
    });
    const denials = bindingAuditRows().filter((row) => row.action === "weixin.binding.denied");
    assert.ok(denials.length >= 4);
    assert.doesNotMatch(JSON.stringify(denials), /stranger-sender/);
  });

  it("binds through an admin-issued one-time code, welcomes the colleague, and audits without plaintext", async () => {
    const admin = await login("jiangjz", adminLoginValue);
    await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb", displayName: "同事乙", [passwordField]: memberLoginValue }),
    });
    const issued = await issueCode(admin, "testb");
    const issuedAudit = bindingAuditRows().filter((row) => row.action === "weixin.binding.code_issued");
    assert.equal(issuedAudit.length, 1);
    assert.equal(issuedAudit[0].actor, "jiangjz");
    assert.equal(JSON.parse(issuedAudit[0].metadata_json).account, "testb");

    const wrong = await postEvent("colleague-sender", `绑定 ${issued.code === "000000" ? "000001" : "000000"}`);
    assert.equal(wrong.body.status, "denied");
    assert.match(wrong.body.text, /绑定码无效/);

    const bound = await postEvent("colleague-sender", `绑定 ${issued.code}`);
    assert.equal(bound.response.status, 200);
    assert.equal(bound.body.status, "ok");
    assert.match(bound.body.text, /绑定成功/);
    assert.match(bound.body.text, /同事乙/);
    assert.match(bound.body.text, /解绑/);
    assert.deepEqual(bindingRows(), [{
      sender_id: "colleague-sender",
      account: "testb",
      status: "active",
      financial_enabled: 0,
      digest_enabled: 1,
    }]);

    // 已绑定者重发绑定码：不消耗、提示先解绑。
    const second = await issueCode(admin, "jiangjz");
    const rebindAttempt = await postEvent("colleague-sender", `绑定 ${second.code}`);
    assert.match(rebindAttempt.body.text, /已绑定/);
    withDb((db) => {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM weixin_binding_codes WHERE used_at IS NOT NULL").get().count,
        1,
        "a bound sender must not consume another account's binding code",
      );
    });

    // 正常能力面开放（不再是固定拒答）。
    const capability = await postEvent("colleague-sender", "今天待办");
    assert.equal(capability.response.status, 200);
    assert.notEqual(capability.body.status, "denied");
    assert.doesNotMatch(String(capability.body.text ?? ""), new RegExp(UNBOUND_DENIAL_SNIPPET));

    // financial_enabled=0：记账文本被财务闸拒绝，且不入 outbox。
    const financial = await postEvent("colleague-sender", "支出 2026-08-21 打车 18.80元 测试");
    assert.doesNotMatch(String(financial.body.text ?? ""), /已记录待确认/);
    withDb((db) => {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox WHERE owner = 'testb'").get().count,
        0,
      );
    });

    const audits = bindingAuditRows();
    const boundAudit = audits.filter((row) => row.action === "weixin.binding.bound");
    assert.equal(boundAudit.length, 1);
    assert.equal(boundAudit[0].actor, "testb");
    assert.match(JSON.parse(boundAudit[0].metadata_json).senderHash, /^[0-9a-f]{16}$/);
    const rejectedAudit = audits.filter((row) => row.action === "weixin.binding.code_rejected");
    assert.ok(rejectedAudit.length >= 1);
    assert.equal(JSON.parse(rejectedAudit[0].metadata_json).reason, "invalid");
    const serialized = JSON.stringify(audits);
    assert.doesNotMatch(serialized, /colleague-sender/);
    assert.doesNotMatch(serialized, new RegExp(issued.code));
    assert.doesNotMatch(serialized, new RegExp(second.code));
    withDb((db) => {
      const codeRows = db.prepare("SELECT code_hash FROM weixin_binding_codes").all();
      for (const row of codeRows) {
        assert.doesNotMatch(row.code_hash, new RegExp(`^(?:${issued.code}|${second.code})$`));
        assert.match(row.code_hash, /^[0-9a-f]{64}$/);
      }
    });
  });

  it("rejects expired and used codes with distinct reasons", async () => {
    const admin = await login("jiangjz", adminLoginValue);
    await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb", displayName: "同事乙", [passwordField]: memberLoginValue }),
    });

    const expired = await issueCode(admin, "testb");
    withDb((db) => {
      // 刚过期 1 分钟（仍在 24h prune 窗内）→ 应得“已过期”而非“无效”。
      db.prepare("UPDATE weixin_binding_codes SET expires_at = $expiresAt")
        .run({ $expiresAt: new Date(Date.now() - 60_000).toISOString() });
    });
    const expiredReply = await postEvent("expired-sender", `绑定 ${expired.code}`);
    assert.equal(expiredReply.body.status, "denied");
    assert.match(expiredReply.body.text, /已过期/);

    const used = await issueCode(admin, "testb");
    const first = await postEvent("used-sender", `绑定 ${used.code}`);
    assert.equal(first.body.status, "ok");
    // 解绑后重放同一枚码：一次性语义。
    await postEvent("used-sender", "解绑");
    await postEvent("used-sender", "确认解绑");
    const replayed = await postEvent("used-sender-2", `绑定 ${used.code}`);
    assert.equal(replayed.body.status, "denied");
    assert.match(replayed.body.text, /已被使用/);

    const reasons = bindingAuditRows()
      .filter((row) => row.action === "weixin.binding.code_rejected")
      .map((row) => JSON.parse(row.metadata_json).reason);
    assert.ok(reasons.includes("expired"));
    assert.ok(reasons.includes("used"));
  });

  it("rate-limits brute-force binding attempts per sender", async () => {
    const admin = await login("jiangjz", adminLoginValue);
    await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb", displayName: "同事乙", [passwordField]: memberLoginValue }),
    });
    const issued = await issueCode(admin, "testb");
    const wrongCode = issued.code === "111111" ? "111112" : "111111";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const denied = await postEvent("brute-sender", `绑定 ${wrongCode}`);
      assert.equal(denied.body.status, "denied");
    }
    const locked = await postEvent("brute-sender", `绑定 ${issued.code}`);
    assert.equal(locked.body.status, "denied");
    assert.match(locked.body.text, /频繁/);
    assert.equal(bindingRows().length, 0, "a locked sender must not bind even with the correct code");
    const reasons = bindingAuditRows()
      .filter((row) => row.action === "weixin.binding.code_rejected")
      .map((row) => JSON.parse(row.metadata_json).reason);
    assert.ok(reasons.includes("rate_limited"));

    // 其他 sender 不受该限流影响。
    const other = await postEvent("calm-sender", `绑定 ${issued.code}`);
    assert.equal(other.body.status, "ok");
  });

  it("supports two-step self unbind, silences the sender afterwards, and allows re-binding", async () => {
    const admin = await login("jiangjz", adminLoginValue);
    await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb", displayName: "同事乙", [passwordField]: memberLoginValue }),
    });
    const issued = await issueCode(admin, "testb");
    const bound = await postEvent("cycle-sender", `绑定 ${issued.code}`);
    assert.equal(bound.body.status, "ok");

    // 「解绑」只做轻确认，不改状态。
    const prompt = await postEvent("cycle-sender", "解绑");
    assert.match(prompt.body.text, /确认解绑/);
    assert.equal(bindingRows()[0].status, "active");
    const still = await postEvent("cycle-sender", "今天待办");
    assert.notEqual(still.body.status, "denied");

    // 「确认解绑」两段完成，解绑后固定拒答。
    const confirmed = await postEvent("cycle-sender", "确认解绑");
    assert.match(confirmed.body.text, /已解绑/);
    assert.equal(bindingRows()[0].status, "disabled");
    const afterUnbind = await postEvent("cycle-sender", "今天待办");
    assert.equal(afterUnbind.body.status, "denied");
    const unboundAudit = bindingAuditRows().filter((row) => row.action === "weixin.binding.unbound");
    assert.equal(unboundAudit.length, 1);
    assert.equal(JSON.parse(unboundAudit[0].metadata_json).via, "weixin_self");

    // 重新生成码即可重绑（恢复路径）。
    const again = await issueCode(admin, "testb");
    const rebound = await postEvent("cycle-sender", `绑定 ${again.code}`);
    assert.equal(rebound.body.status, "ok");
    assert.equal(bindingRows()[0].status, "active");

    // 幂等重放绑定消息：已绑定态回提示、不产生第二行绑定。
    const replay = await postEvent("cycle-sender", `绑定 ${again.code}`);
    assert.match(replay.body.text, /已绑定/);
    assert.equal(bindingRows().length, 1);
  });
});
