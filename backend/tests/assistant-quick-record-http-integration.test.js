import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import { createAssistantBusinessSnapshotAdapter } from "../src/assistant/businessSnapshotAdapter.js";

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
    conversationId: "conversation-record-1",
    text: "帮助",
    sourceMessageId: "message-record-1",
    senderId: "sender-1",
    chatType: "direct",
    ...overrides,
  };
}

async function send(sourceMessageId, overrides = {}) {
  return request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineToken}`,
      "Idempotency-Key": `weixin:${sourceMessageId}`,
    },
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
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-quick-record-http-"));
  // Friday 2026-08-28 10:00 Asia/Shanghai.
  nowMs = Date.parse("2026-08-28T02:00:00.000Z");
  withDb((db) => {
    db.exec(`
      INSERT INTO customers (id, name, region, type, level, owner)
      VALUES ('customer-seeded-1', '日照中医医院', '日照', '医院', 'A', 'assistant-owner');
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

function seedRecord(db, id, {
  rawContent = "上周拜访了日照中医医院，谈了十五五规划预算",
  occurredAt = "2026-08-27T04:00:00.000Z",
  customerId = "customer-seeded-1",
  status = "analyzed",
} = {}) {
  db.prepare(`
    INSERT INTO quick_records (id, owner, raw_content, occurred_at, source_channel, customer_id, status)
    VALUES ($id, 'assistant-owner', $rawContent, $occurredAt, '微信助手', $customerId, $status)
  `).run({ $id: id, $rawContent: rawContent, $occurredAt: occurredAt, $customerId: customerId, $status: status });
  db.prepare(`
    INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
    VALUES ($insightId, $id, 'mock', 70, $analysisJson)
  `).run({
    $insightId: `insight-${id}`,
    $id: id,
    $analysisJson: JSON.stringify({
      source: "mock",
      summary: {
        request: { title: "客户诉求", text: "原始诉求" },
        feedback: { title: "客户反馈", text: "原始反馈" },
        risk: { title: "风险点", text: "原始风险" },
        action: { title: "建议动作", text: "原始建议" },
      },
    }),
  });
}

describe("quick-record agent HTTP boundary", () => {
  it("captures a record through the affirm card, writes it on 确认, and feeds the weekly report pool", async () => {
    const pending = await send("capture-request", {
      conversationId: "conversation-capture-1",
      text: "记一下：今天拜访了日照中医医院，张主任说十五五规划预算大概300万，下周要出架构对比材料",
    });
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "visit-capture.capture");
    assert.equal(pending.body.risk, "R1");
    assert.equal(Object.hasOwn(pending.body, "confirmationCode"), false, "no confirmationCode key for affirm actions");
    assert.match(pending.body.text, /【拜访记录待确认】/);
    assert.match(pending.body.text, /回复“确认”写入，回复“取消”放弃；10 分钟内有效。/);
    assert.equal(/(?<!\d)\d{6}(?!\d)/u.test(pending.body.text), false, "no six-digit code in the affirm card");
    assert.match(pending.body.text, /客户：日照中医医院/);
    assert.match(pending.body.text, /时间：2026-08-28/);

    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM quick_records").get().count, 0, "nothing is written before 确认");
    });

    const confirmed = await send("capture-confirm", {
      conversationId: "conversation-capture-1",
      text: "确认",
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.status, "ok");
    assert.match(confirmed.body.text, /已录入，记录 ID：…/);
    assert.match(confirmed.body.text, /已挂接客户：日照中医医院/);

    withDb((db) => {
      const row = db.prepare("SELECT * FROM quick_records WHERE id = $id").get({ $id: pending.body.actionId });
      assert.ok(row, "the pending action id is the durable record key");
      assert.equal(row.owner, "assistant-owner");
      assert.equal(row.source_channel, "微信助手");
      assert.equal(row.customer_id, "customer-seeded-1");
      assert.equal(row.status, "analyzed");
      assert.equal(row.occurred_at, "2026-08-28T04:00:00.000Z", "the spoken 今天 pins noon Asia/Shanghai");
      for (const action of ["quick_record.create", "quick_record.analyze", "assistant.action.create", "assistant.action.confirm", "assistant.action.execute"]) {
        assert.ok(
          db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = $action").get({ $action: action }).count >= 1,
          action,
        );
      }
      // source_channel='微信助手' analyzed records flow into the weekly report
      // preview pool without a manual weekly confirmation.
      const snapshot = createAssistantBusinessSnapshotAdapter({ db, clock: () => new Date(nowMs) });
      const summary = snapshot.salesReportSummary({ owner: "assistant-owner", weekStart: "2026-08-24" });
      assert.equal(summary.preview.sourceRecordCount, 1, "the captured record enters the weekly preview pool");
    });
  });

  it("cancels an affirm pending capture without writing", async () => {
    const pending = await send("capture-cancel-request", {
      conversationId: "conversation-cancel-1",
      text: "记一下：电话沟通了灾备方案报价",
    });
    assert.equal(pending.body.status, "confirmation_required");
    const cancelled = await send("capture-cancel-do", {
      conversationId: "conversation-cancel-1",
      text: "取消",
    });
    assert.equal(cancelled.body.status, "cancel");
    withDb((db) => {
      assert.equal(db.prepare("SELECT status FROM assistant_pending_actions WHERE id = ?").get(pending.body.actionId).status, "cancelled");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM quick_records").get().count, 0);
    });
  });

  it("expires an affirm capture after ten minutes", async () => {
    const pending = await send("capture-expire-request", {
      conversationId: "conversation-expire-1",
      text: "记一下：电话沟通了灾备方案报价",
    });
    assert.equal(pending.body.status, "confirmation_required");
    nowMs += 11 * 60 * 1000;
    const expired = await send("capture-expire-confirm", {
      conversationId: "conversation-expire-1",
      text: "确认",
    });
    // The overdue action is expired during the scoped lookup; the bare 确认
    // then falls through to the router's uniform no-pending clarify.
    assert.equal(expired.response.status, 200);
    assert.equal(expired.body.status, "clarify");
    assert.equal(expired.body.text, "当前没有待确认的操作。");
    withDb((db) => {
      assert.equal(db.prepare("SELECT status FROM assistant_pending_actions WHERE id = ?").get(pending.body.actionId).status, "expired");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM quick_records").get().count, 0);
    });
  });

  it("guides six-digit replies on an affirm capture without locking, then still accepts 确认", async () => {
    const pending = await send("capture-guide-request", {
      conversationId: "conversation-guide-1",
      text: "记一下：电话沟通了灾备方案报价",
    });
    assert.equal(pending.body.status, "confirmation_required");

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const guided = await send(`capture-guide-code-${attempt}`, {
        conversationId: "conversation-guide-1",
        text: "123456",
      });
      assert.equal(guided.response.status, 200);
      assert.match(guided.body.text, /本操作无需确认码/, `attempt ${attempt}`);
    }
    const resent = await send("capture-guide-resend", {
      conversationId: "conversation-guide-1",
      text: "重发确认码",
    });
    assert.equal(resent.body.status, "confirmation_required");
    assert.match(resent.body.text, /【拜访记录待确认】/);
    assert.equal(Object.hasOwn(resent.body, "confirmationCode"), false);

    const confirmed = await send("capture-guide-confirm", {
      conversationId: "conversation-guide-1",
      text: "确认",
    });
    assert.equal(confirmed.body.status, "ok", "six-digit texts never lock an affirm action");
    withDb((db) => {
      assert.equal(db.prepare("SELECT status FROM assistant_pending_actions WHERE id = ?").get(pending.body.actionId).status, "executed");
    });
  });

  it("searches records without confirmation", async () => {
    withDb((db) => seedRecord(db, "record-search-aaa111"));
    const result = await send("search-request", {
      conversationId: "conversation-search-1",
      text: "查一下本周去日照的记录",
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, "ok");
    assert.match(result.body.text, /找到 1 条记录/);
    assert.match(result.body.text, /日照中医医院/);
    assert.match(result.body.text, /…aaa111/);
    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assistant_pending_actions").get().count, 0, "search never creates a pending action");
    });
  });

  it("updates history through the six-digit preview card and locks after five wrong codes", async () => {
    withDb((db) => seedRecord(db, "record-update-bbb222"));
    const pending = await send("update-request", {
      conversationId: "conversation-update-1",
      text: "把记录 bbb222 的下一步改成 周三前发对比材料给张主任",
    });
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "visit-capture.update");
    assert.match(pending.body.text, /【拜访记录修改待确认】/);
    assert.match(pending.body.text, /原始建议/);
    assert.match(pending.body.text, /周三前发对比材料给张主任/);
    const code = confirmationCodeFrom(pending.body.text);

    const confirmed = await send("update-confirm", {
      conversationId: "conversation-update-1",
      text: code,
    });
    assert.equal(confirmed.body.status, "ok");
    assert.match(confirmed.body.text, /已更新记录 …bbb222（v2）：建议动作已修改/);
    withDb((db) => {
      const analysis = JSON.parse(db.prepare("SELECT analysis_json FROM ai_insights WHERE id = 'insight-record-update-bbb222'").get().analysis_json);
      assert.equal(analysis.summary.action.text, "周三前发对比材料给张主任");
      assert.equal(db.prepare("SELECT version FROM quick_records WHERE id = 'record-update-bbb222'").get().version, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'quick_record.analysis.update'").get().count, 1);
    });

    // Wrong-code lockout still protects the code-confirmed history writes.
    const second = await send("update-lock-request", {
      conversationId: "conversation-update-1",
      text: "把记录 bbb222 的风险改成 预算路径已确认",
    });
    assert.equal(second.body.status, "confirmation_required");
    const rightCode = confirmationCodeFrom(second.body.text);
    const wrongCode = rightCode === "111222" ? "222333" : "111222";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await send(`update-lock-wrong-${attempt}`, {
        conversationId: "conversation-update-1",
        text: wrongCode,
      });
      assert.equal(failed.response.status, 409);
    }
    const locked = await send("update-lock-final", {
      conversationId: "conversation-update-1",
      text: rightCode,
    });
    assert.equal(locked.response.status, 409);
    withDb((db) => {
      const action = db.prepare("SELECT status, error_code FROM assistant_pending_actions WHERE id = ?").get(second.body.actionId);
      assert.equal(action.status, "failed");
      assert.equal(action.error_code, "ASSISTANT_CONFIRMATION_LOCKED");
    });
  });

  it("rotates the update confirmation code on request", async () => {
    withDb((db) => seedRecord(db, "record-renew-ccc333"));
    const pending = await send("renew-request", {
      conversationId: "conversation-renew-1",
      text: "把记录 ccc333 的诉求改成 新的诉求描述",
    });
    const firstCode = confirmationCodeFrom(pending.body.text);
    const renewed = await send("renew-do", {
      conversationId: "conversation-renew-1",
      text: "重发确认码",
    });
    assert.equal(renewed.body.status, "confirmation_required");
    assert.match(renewed.body.text, /【拜访记录修改待确认】/, "resend repeats the stored preview");
    const secondCode = confirmationCodeFrom(renewed.body.text);
    assert.notEqual(secondCode, firstCode);
    const stale = await send("renew-stale", {
      conversationId: "conversation-renew-1",
      text: firstCode,
    });
    assert.equal(stale.response.status, 409);
    const confirmed = await send("renew-confirm", {
      conversationId: "conversation-renew-1",
      text: secondCode,
    });
    assert.equal(confirmed.body.status, "ok");
  });

  it("voids a record through the R3 code card and hides it from search", async () => {
    withDb((db) => seedRecord(db, "record-void-ddd444"));
    const pending = await send("void-request", {
      conversationId: "conversation-void-1",
      text: "作废记录 ddd444",
    });
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "visit-capture.void");
    assert.equal(pending.body.risk, "R3");
    assert.match(pending.body.text, /【拜访记录作废待确认】/);
    assert.match(pending.body.text, /不再出现在记录列表、周报素材与项目分析中/);
    const code = confirmationCodeFrom(pending.body.text);

    const confirmed = await send("void-confirm", {
      conversationId: "conversation-void-1",
      text: code,
    });
    assert.equal(confirmed.body.status, "ok");
    assert.match(confirmed.body.text, /已作废记录 …ddd444/);
    withDb((db) => {
      const row = db.prepare("SELECT voided_at, voided_by, void_reason, version FROM quick_records WHERE id = 'record-void-ddd444'").get();
      assert.ok(row.voided_at, "voided_at is finally written");
      assert.equal(row.voided_by, "assistant-owner");
      assert.equal(row.void_reason, "weixin-assistant-void");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'quick_record.void'").get().count, 1);
    });

    const search = await send("void-search", {
      conversationId: "conversation-void-1",
      text: "最近的拜访记录",
    });
    assert.match(search.body.text, /没有找到/, "the voided record is invisible to search");
  });

  it("rejects quick-record writes from group chats", async () => {
    await startServer({ weixinAllowGroups: true, weixinAllowedGroupIds: "group-records-1" });
    const groupCapture = await send("group-capture", {
      conversationId: "conversation-group-1",
      chatType: "group",
      groupId: "group-records-1",
      text: "记一下：今天拜访了日照中医医院",
    });
    assert.equal(groupCapture.response.status, 200);
    assert.equal(groupCapture.body.status, "clarify");
    assert.match(groupCapture.body.text ?? groupCapture.body.message, /仅支持与小小的私聊/);
    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assistant_pending_actions").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM quick_records").get().count, 0);
    });
  });

  it("T-BK-1/2/3: keeps 确认 ownership correct while a delivered bookkeeping draft coexists", async () => {
    // Arrange: assign the trip region first so the bookkeeping draft is
    // complete and confirmable, then deliver it in the same conversation.
    const region = await send("bookkeeping-region-1", {
      conversationId: "conversation-coexist-1",
      text: "本周区域是济南",
    });
    assert.equal(region.response.status, 200);
    const draft = await send("bookkeeping-draft-1", {
      conversationId: "conversation-coexist-1",
      text: "支出 18.50 元 打车 2026-08-28",
    });
    assert.equal(draft.response.status, 200);
    const draftEntry = withDb((db) => {
      const entry = db.prepare("SELECT id, status FROM shortcut_bookkeeping_entries ORDER BY created_at DESC LIMIT 1").get();
      assert.ok(entry, "the bound sender must produce a bookkeeping draft");
      assert.equal(entry.status, "review_required");
      db.prepare(`
        UPDATE weixin_confirmation_outbox
        SET status = 'sent', provider_message_id = 'provider-draft-1'
        WHERE json_extract(payload_json, '$.entryId') = $entryId
      `).run({ $entryId: entry.id });
      return entry;
    });

    // T-BK-3: the capture text is not hijacked by the implicit draft selector.
    const pending = await send("coexist-capture-request", {
      conversationId: "conversation-coexist-1",
      text: "记一下：今天拜访了日照中医医院，谈了十五五规划",
    });
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "visit-capture.capture");
    assert.match(pending.body.text, /【拜访记录待确认】/, "capture text must reach the router, not the draft clarify");

    // T-BK-1: an unquoted 确认 confirms the capture (the non-bookkeeping
    // pending action), not the bookkeeping draft.
    const confirmed = await send("coexist-capture-confirm", {
      conversationId: "conversation-coexist-1",
      text: "确认",
    });
    assert.equal(confirmed.body.status, "ok");
    assert.match(confirmed.body.text, /已录入，记录 ID：…/);
    withDb((db) => {
      assert.ok(db.prepare("SELECT id FROM quick_records WHERE id = $id").get({ $id: pending.body.actionId }));
      assert.equal(
        db.prepare("SELECT status FROM shortcut_bookkeeping_entries WHERE id = ?").get(draftEntry.id).status,
        "review_required",
        "the bookkeeping draft stays untouched by the unquoted 确认",
      );
    });

    // T-BK-2: a 确认 quoting the bookkeeping draft still settles the draft,
    // even while another capture pending action exists.
    const secondPending = await send("coexist-second-capture", {
      conversationId: "conversation-coexist-1",
      text: "记一下：电话回访了日照中医医院，确认材料已送达",
    });
    assert.equal(secondPending.body.status, "confirmation_required");
    const quotedConfirm = await send("coexist-quoted-confirm", {
      conversationId: "conversation-coexist-1",
      text: "确认",
      quotedMessageId: "provider-draft-1",
      quotedText: "【小小提醒！新增一条待记账信息】",
    });
    assert.equal(quotedConfirm.response.status, 200);
    withDb((db) => {
      assert.equal(
        db.prepare("SELECT status FROM shortcut_bookkeeping_entries WHERE id = ?").get(draftEntry.id).status,
        "accepted",
        "the quoted 确认 settles the bookkeeping draft into the ledger",
      );
      assert.equal(
        db.prepare("SELECT status FROM assistant_pending_actions WHERE id = ?").get(secondPending.body.actionId).status,
        "pending",
        "the coexisting capture pending action is untouched by the quoted confirm",
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM quick_records").get().count,
        1,
        "the second capture is not written by the quoted bookkeeping confirm",
      );
    });

    // The coexisting capture still completes afterwards.
    const secondConfirm = await send("coexist-second-confirm", {
      conversationId: "conversation-coexist-1",
      text: "确认",
    });
    assert.equal(secondConfirm.body.status, "ok");
    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM quick_records").get().count, 2);
    });
  });
});
