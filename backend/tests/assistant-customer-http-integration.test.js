import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";

const machineToken = "test-machine-token";
let tempDir;
let server;
let baseUrl;
let nowMs;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function eventBody(overrides = {}) {
  return {
    conversationId: "conversation-customer-1",
    text: "帮助",
    sourceMessageId: "message-customer-1",
    senderId: "sender-1",
    chatType: "direct",
    ...overrides,
  };
}

function eventHeaders(sourceMessageId) {
  return {
    Authorization: `Bearer ${machineToken}`,
    "Idempotency-Key": `weixin:${sourceMessageId}`,
  };
}

async function send(sourceMessageId, overrides = {}) {
  return request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: eventHeaders(sourceMessageId),
    body: JSON.stringify(eventBody({ sourceMessageId, ...overrides })),
  });
}

function confirmationCodeFrom(text) {
  const matches = String(text).match(/(?<!\d)\d{6}(?!\d)/gu) ?? [];
  assert.equal(matches.length, 1, "the live confirmation text must contain exactly one code");
  return matches[0];
}

function withDb(work) {
  const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
  try {
    return work(db);
  } finally {
    db.close();
  }
}

async function startServer(overrides = {}) {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = createServer({
    databaseUrl: join(tempDir, "assistant.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: "assistant-owner",
    authPassword: "",
    authPasswordHash: await hashPassword("unit-password", { salt: Buffer.alloc(16, 13) }),
    authSessionSecret: Buffer.alloc(32, 12).toString("base64url"),
    authCookieSecure: false,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: "assistant-owner",
    weixinAllowedSenderIds: "sender-1,sender-2",
    weixinAllowGroups: false,
    weixinBookkeepingOwner: "assistant-owner",
    weixinBookkeepingSenderId: "sender-1",
    weixinBookkeepingConfirmationEnabled: true,
    assistantClock: () => new Date(nowMs),
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-customer-http-"));
  nowMs = Date.parse("2026-08-28T02:00:00.000Z");
  withDb((db) => {
    db.exec(`
      INSERT INTO customers (id, name, region, type, level, owner, aliases, tags)
      VALUES ('customer-seeded-1', '日照市中医医院', '日照', '医院', 'A', 'assistant-owner', '["日照中医院"]', '["十五五"]');
    `);
  });
  await startServer();
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("customer profile agent HTTP boundary", () => {
  it("creates a customer only after the six-digit code and audits the whole chain", async () => {
    const pending = await send("customer-create-request", {
      conversationId: "conversation-create-1",
      text: "新建客户 莒县人民医院，区域日照，类型医院，级别B，联系人王科长，标签 信创",
    });
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "customer.create");
    assert.equal(pending.body.risk, "R2");
    assert.match(pending.body.text, /【客户建档待确认】/);
    assert.match(pending.body.text, /名称：莒县人民医院/);
    const code = confirmationCodeFrom(pending.body.text);

    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers WHERE name = '莒县人民医院'").get().count, 0);
      const persisted = JSON.stringify(db.prepare("SELECT payload_json, response_json FROM assistant_inbound_events").all());
      assert.equal(persisted.includes(code), false);
    });

    const confirmed = await send("customer-create-confirm", {
      conversationId: "conversation-create-1",
      text: code,
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.status, "ok");
    assert.match(confirmed.body.text, /已建档：莒县人民医院/);

    withDb((db) => {
      const row = db.prepare("SELECT * FROM customers WHERE name = '莒县人民医院'").get();
      assert.ok(row);
      assert.equal(row.owner, "assistant-owner");
      assert.equal(row.id, pending.body.actionId);
      assert.deepEqual(JSON.parse(row.tags), ["信创"]);
      const businessAudit = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'customer.create'").all();
      assert.equal(businessAudit.length, 1);
      assert.equal(JSON.parse(businessAudit[0].metadata_json).source, "weixin-assistant");
      for (const action of ["assistant.action.create", "assistant.action.confirm", "assistant.action.execute"]) {
        assert.ok(
          db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = $action").get({ $action: action }).count >= 1,
          action,
        );
      }
    });

    const detail = await send("customer-create-detail", {
      conversationId: "conversation-create-1",
      text: `客户详情 ${pending.body.actionId}`,
    });
    assert.match(detail.body.text, /客户画像：莒县人民医院/);
    assert.match(detail.body.text, /标签：信创/);
  });

  it("updates through alias search with a change preview and executes the pinned plan", async () => {
    const pending = await send("customer-update-request", {
      conversationId: "conversation-update-1",
      text: "把日照中医院的级别改成B",
    });
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "customer.update");
    assert.match(pending.body.text, /【客户改档待确认】日照市中医医院 \[customer-seeded-1\]（当前 v1）/);
    assert.match(pending.body.text, /级别：A → B/);
    const code = confirmationCodeFrom(pending.body.text);

    const confirmed = await send("customer-update-confirm", {
      conversationId: "conversation-update-1",
      text: code,
    });
    assert.equal(confirmed.body.status, "ok");
    assert.match(confirmed.body.text, /已更新：日照市中医医院（v2）/);
    withDb((db) => {
      const row = db.prepare("SELECT level, version FROM customers WHERE id = 'customer-seeded-1'").get();
      assert.equal(row.level, "B");
      assert.equal(row.version, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.update'").get().count, 1);
    });
  });

  it("reports a friendly conflict when the web edits the customer between preview and confirm", async () => {
    const pending = await send("customer-conflict-request", {
      conversationId: "conversation-conflict-1",
      text: "修改客户 日照市中医医院，级别B",
    });
    assert.equal(pending.body.status, "confirmation_required");
    const code = confirmationCodeFrom(pending.body.text);

    withDb((db) => {
      db.prepare("UPDATE customers SET level = 'C', version = version + 1 WHERE id = 'customer-seeded-1'").run();
    });

    const confirmed = await send("customer-conflict-confirm", {
      conversationId: "conversation-conflict-1",
      text: code,
    });
    assert.equal(confirmed.response.status, 200);
    assert.match(confirmed.body.text, /刚在其他端被修改，本次未写入/);
    withDb((db) => {
      const row = db.prepare("SELECT level, version FROM customers WHERE id = 'customer-seeded-1'").get();
      assert.equal(row.level, "C");
      assert.equal(row.version, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.update'").get().count, 0);
    });
  });

  it("locks the action after five wrong codes and frees the conversation for a fresh attempt", async () => {
    const pending = await send("customer-lock-request", {
      conversationId: "conversation-lock-1",
      text: "删除客户 日照市中医医院",
    });
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "customer.delete");
    assert.equal(pending.body.risk, "R3");
    assert.match(pending.body.text, /【客户删档待确认】/);
    const code = confirmationCodeFrom(pending.body.text);
    const wrongCode = code === "111222" ? "222333" : "111222";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await send(`customer-lock-wrong-${attempt}`, {
        conversationId: "conversation-lock-1",
        text: wrongCode,
      });
      assert.equal(failed.response.status, 409);
      assert.equal(failed.body.text, "确认信息无效或已过期，请重新发起操作。");
    }

    const lockedRetry = await send("customer-lock-final", {
      conversationId: "conversation-lock-1",
      text: code,
    });
    assert.equal(lockedRetry.response.status, 409);
    withDb((db) => {
      const action = db.prepare("SELECT status, error_code FROM assistant_pending_actions WHERE id = ?").get(pending.body.actionId);
      assert.equal(action.status, "failed");
      assert.equal(action.error_code, "ASSISTANT_CONFIRMATION_LOCKED");
      assert.equal(db.prepare("SELECT deleted_at FROM customers WHERE id = 'customer-seeded-1'").get().deleted_at, null);
    });

    const fresh = await send("customer-lock-restart", {
      conversationId: "conversation-lock-1",
      text: "删除客户 日照市中医医院",
    });
    assert.equal(fresh.body.status, "confirmation_required");
  });

  it("cancels a pending write and rotates codes on request", async () => {
    const pending = await send("customer-cancel-request", {
      conversationId: "conversation-cancel-1",
      text: "新建客户 取消测试医院，区域青岛",
    });
    const cancelled = await send("customer-cancel-do", {
      conversationId: "conversation-cancel-1",
      text: "取消",
    });
    assert.equal(cancelled.body.status, "cancel");
    assert.equal(cancelled.body.text, "已取消当前操作。");
    withDb((db) => {
      assert.equal(db.prepare("SELECT status FROM assistant_pending_actions WHERE id = ?").get(pending.body.actionId).status, "cancelled");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers WHERE name = '取消测试医院'").get().count, 0);
    });

    const renewedPending = await send("customer-renew-request", {
      conversationId: "conversation-cancel-1",
      text: "新建客户 换码测试医院，区域青岛",
    });
    const firstCode = confirmationCodeFrom(renewedPending.body.text);
    const renewed = await send("customer-renew-do", {
      conversationId: "conversation-cancel-1",
      text: "重发确认码",
    });
    assert.equal(renewed.body.status, "confirmation_required");
    assert.match(renewed.body.text, /【客户建档待确认】/, "renewed message repeats the preview card");
    const secondCode = confirmationCodeFrom(renewed.body.text);
    assert.notEqual(secondCode, firstCode);

    const staleCode = await send("customer-renew-stale", {
      conversationId: "conversation-cancel-1",
      text: firstCode,
    });
    assert.equal(staleCode.response.status, 409);

    const confirmed = await send("customer-renew-confirm", {
      conversationId: "conversation-cancel-1",
      text: secondCode,
    });
    assert.equal(confirmed.body.status, "ok");
    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers WHERE name = '换码测试医院'").get().count, 1);
    });
  });

  it("expires an unconfirmed write after ten minutes", async () => {
    const pending = await send("customer-expire-request", {
      conversationId: "conversation-expire-1",
      text: "新建客户 过期测试医院",
    });
    const code = confirmationCodeFrom(pending.body.text);
    nowMs += 11 * 60 * 1000;
    const expired = await send("customer-expire-confirm", {
      conversationId: "conversation-expire-1",
      text: code,
    });
    // The repository expires the overdue action during the scoped lookup, so
    // the late code is answered by the uniform 409 confirmation failure.
    assert.equal(expired.response.status, 409);
    assert.equal(expired.body.text, "确认信息无效或已过期，请重新发起操作。");
    withDb((db) => {
      assert.equal(
        db.prepare("SELECT status FROM assistant_pending_actions WHERE id = ?").get(pending.body.actionId).status,
        "expired",
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers WHERE name = '过期测试医院'").get().count, 0);
    });
  });

  it("rejects customer writes from group chats while keeping reads available", async () => {
    await startServer({ weixinAllowGroups: true, weixinAllowedGroupIds: "group-writes-1" });
    const groupWrite = await send("customer-group-write", {
      conversationId: "conversation-group-1",
      chatType: "group",
      groupId: "group-writes-1",
      text: "新建客户 群聊医院",
    });
    assert.equal(groupWrite.response.status, 200);
    assert.equal(groupWrite.body.status, "clarify");
    assert.match(groupWrite.body.text, /仅支持与小小的私聊/);
    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assistant_pending_actions").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers WHERE name = '群聊医院'").get().count, 0);
    });

    const groupRead = await send("customer-group-read", {
      conversationId: "conversation-group-1",
      chatType: "group",
      groupId: "group-writes-1",
      text: "客户 日照",
    });
    assert.equal(groupRead.response.status, 200);
    assert.match(groupRead.body.text, /日照市中医医院/);
  });

  it("keeps customer flows working while a delivered bookkeeping draft is active", async () => {
    const draft = await send("bookkeeping-draft-1", {
      conversationId: "conversation-coexist-1",
      text: "支出 18.50 元 打车",
    });
    assert.equal(draft.response.status, 200);
    const draftState = withDb((db) => {
      const entry = db.prepare("SELECT id FROM shortcut_bookkeeping_entries ORDER BY created_at DESC LIMIT 1").get();
      assert.ok(entry, "the bound sender must produce a bookkeeping draft");
      db.prepare(`
        UPDATE weixin_confirmation_outbox
        SET status = 'sent', provider_message_id = 'provider-draft-1'
        WHERE json_extract(payload_json, '$.entryId') = $entryId
      `).run({ $entryId: entry.id });
      return entry;
    });

    const profile = await send("coexist-profile-question", {
      conversationId: "conversation-coexist-1",
      text: "日照市中医医院什么情况",
    });
    assert.equal(profile.response.status, 200);
    assert.match(profile.body.text, /客户画像：日照市中医医院/, "profile questions must not be hijacked by the draft");

    const pending = await send("coexist-update-request", {
      conversationId: "conversation-coexist-1",
      text: "把日照市中医医院的级别改成B",
    });
    assert.equal(pending.body.status, "confirmation_required");
    const code = confirmationCodeFrom(pending.body.text);

    const confirmed = await send("coexist-update-confirm", {
      conversationId: "conversation-coexist-1",
      text: code,
    });
    assert.equal(confirmed.body.status, "ok");
    assert.match(confirmed.body.text, /已更新：日照市中医医院/, "the six-digit code must confirm the customer write, not the draft");
    withDb((db) => {
      assert.equal(db.prepare("SELECT level FROM customers WHERE id = 'customer-seeded-1'").get().level, "B");
      assert.equal(
        db.prepare("SELECT status FROM shortcut_bookkeeping_entries WHERE id = ?").get(draftState.id).status,
        "review_required",
        "the bookkeeping draft must stay untouched",
      );
    });

    const secondPending = await send("coexist-delete-request", {
      conversationId: "conversation-coexist-1",
      text: "删除客户 日照市中医医院",
    });
    assert.equal(secondPending.body.status, "confirmation_required");

    const draftCancel = await send("coexist-quote-cancel", {
      conversationId: "conversation-coexist-1",
      text: "取消",
      quotedMessageId: "provider-draft-1",
      quotedText: "【小小提醒！新增一条待记账信息】",
    });
    assert.equal(draftCancel.response.status, 200);
    withDb((db) => {
      assert.equal(
        db.prepare("SELECT status FROM assistant_pending_actions WHERE id = ?").get(secondPending.body.actionId).status,
        "pending",
        "quoting the draft must cancel the draft, not the customer action",
      );
      assert.notEqual(
        db.prepare("SELECT status FROM shortcut_bookkeeping_entries WHERE id = ?").get(draftState.id).status,
        "review_required",
        "the quoted cancel must settle the bookkeeping draft",
      );
    });

    const genericCancel = await send("coexist-plain-cancel", {
      conversationId: "conversation-coexist-1",
      text: "取消",
    });
    assert.equal(genericCancel.body.status, "cancel");
    withDb((db) => {
      assert.equal(
        db.prepare("SELECT status FROM assistant_pending_actions WHERE id = ?").get(secondPending.body.actionId).status,
        "cancelled",
        "an unquoted cancel targets the generic pending action",
      );
    });
  });
});
