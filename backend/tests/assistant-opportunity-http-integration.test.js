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
    conversationId: "conversation-opp-1",
    text: "帮助",
    sourceMessageId: "message-opp-1",
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
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-opportunity-http-"));
  // Friday 2026-08-28 10:00 Asia/Shanghai.
  nowMs = Date.parse("2026-08-28T02:00:00.000Z");
  withDb((db) => {
    db.exec(`
      INSERT INTO customers (id, name, region, type, level, owner) VALUES
        ('customer-seeded-1', '日照中医医院', '日照', '医院', 'A', 'assistant-owner'),
        ('customer-seeded-2', '黄岛区中医院', '青岛', '医院', 'B', 'assistant-owner'),
        ('customer-seeded-3', '胜利油田中心医院', '东营', '医院', 'A', 'assistant-owner'),
        ('customer-seeded-4', '黄岛人民医院', '青岛', '医院', 'B', 'assistant-owner'),
        ('customer-seeded-5', '黄岛中心医院', '青岛', '医院', 'B', 'assistant-owner');
      INSERT INTO opportunities (id, customer_id, name, customer, stage, amount, next, owner) VALUES
        ('opp-rizhao-plan001', 'customer-seeded-1', '日照中医医院十五五规划', '日照中医医院', '方案输出', '规划类', '补齐规划材料', 'assistant-owner'),
        ('opp-victory-pacs99', 'customer-seeded-3', '胜利油田 PACS 双活', '胜利油田中心医院', '方案交流', NULL, NULL, 'assistant-owner'),
        ('opp-victory-srv888', 'customer-seeded-3', '服务器采购计划', '胜利油田中心医院', '预算确认', NULL, NULL, 'assistant-owner'),
        ('opp-huangdao-tcm077', 'customer-seeded-2', '双活机房建设', '黄岛区中医院', '调研机会', '3000 万', NULL, 'assistant-owner');
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

describe("opportunity agent HTTP boundary", () => {
  it("moves a stage forward through the affirm card and attaches the stage review on 确认", async () => {
    const pending = await send("opp-stage-1", {
      conversationId: "conversation-stage-1",
      text: "把日照的商机推进到方案交流",
    });
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "opportunity.update-stage");
    assert.equal(pending.body.risk, "R1");
    assert.equal(Object.hasOwn(pending.body, "confirmationCode"), false);
    assert.match(pending.body.text, /【小小提醒！修改商机阶段】/u);
    assert.match(pending.body.text, /名称：日照中医医院十五五规划/u);
    assert.match(pending.body.text, /阶段：方案输出 → 方案交流/u);
    assert.match(pending.body.text, /联动：确认后将自动运行阶段升级检查（销售决策分析）/u);
    assert.match(pending.body.text, /请回复“确认”或“取消”。/u);
    assert.equal(/(?<!\d)\d{6}(?!\d)/u.test(pending.body.text), false, "no six-digit code in the affirm card");

    withDb((db) => {
      assert.equal(
        db.prepare("SELECT stage FROM opportunities WHERE id = 'opp-rizhao-plan001'").get().stage,
        "方案输出",
        "nothing before 确认",
      );
    });

    const confirmed = await send("opp-stage-2", { conversationId: "conversation-stage-1", text: "确认" });
    assert.equal(confirmed.response.status, 200);
    assert.match(confirmed.body.text, /【商机阶段已更新】/u);
    assert.match(confirmed.body.text, /阶段：方案输出 → 方案交流/u);
    assert.match(confirmed.body.text, /阶段升级检查（销售决策 agent）/u);
    assert.match(confirmed.body.text, /完整分析发送「项目分析 日照中医医院十五五规划」查看。/u);

    withDb((db) => {
      const row = db.prepare("SELECT stage, version FROM opportunities WHERE id = 'opp-rizhao-plan001'").get();
      assert.equal(row.stage, "方案交流");
      assert.equal(row.version, 2);
      const audit = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'opportunity.update'").all();
      assert.equal(audit.length, 1);
      const metadata = JSON.parse(audit[0].metadata_json);
      assert.deepEqual(metadata.changedFields, ["stage"]);
      assert.equal(metadata.source, "weixin-assistant");
      assert.equal(metadata.stageReview, "triggered");
      assert.equal(metadata.actionId, pending.body.actionId);
      const review = db.prepare("SELECT id FROM assistant_agent_runs WHERE agent_id = 'sales-decision'").all();
      assert.equal(review.length, 1, "the stage review persisted a sales-decision agent run");
      for (const action of ["assistant.action.create", "assistant.action.confirm", "assistant.action.execute"]) {
        assert.ok(
          db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = $action").get({ $action: action }).count >= 1,
          action,
        );
      }
    });
  });

  it("disambiguates multiple matches with the stage/amount/suffix card and accepts a suffix retry", async () => {
    const clarify = await send("opp-multi-1", {
      conversationId: "conversation-multi-1",
      text: "把胜利油田的商机推进到预算确认",
    });
    assert.equal(clarify.response.status, 200);
    assert.equal(clarify.body.status, "clarify");
    const clarifyText = clarify.body.text ?? clarify.body.message ?? clarify.body.question;
    assert.match(clarifyText, /【找到多个商机】/u);
    assert.match(clarifyText, /胜利油田 PACS 双活 …pacs99 ｜ 方案交流 ｜ 金额待确认/u);
    assert.match(clarifyText, /服务器采购计划 …srv888 ｜ 预算确认 ｜ 金额待确认/u);
    assert.equal(clarify.body.actionId, undefined, "a block never creates a pending action");

    const pending = await send("opp-multi-2", {
      conversationId: "conversation-multi-1",
      text: "把 pacs99 推进到预算确认",
    });
    assert.equal(pending.body.status, "confirmation_required");
    assert.match(pending.body.text, /名称：胜利油田 PACS 双活/u);
    assert.match(pending.body.text, /阶段：方案交流 → 预算确认/u);

    const cancelled = await send("opp-multi-3", { conversationId: "conversation-multi-1", text: "取消" });
    assert.equal(cancelled.body.status, "cancel");
    withDb((db) => {
      assert.equal(
        db.prepare("SELECT stage FROM opportunities WHERE id = 'opp-victory-pacs99'").get().stage,
        "方案交流",
      );
    });
  });

  it("hints an off-vocabulary stage, strips the mood particle, and skips the review", async () => {
    const pending = await send("opp-unknown-1", {
      conversationId: "conversation-unknown-1",
      text: "把日照的商机推进到投标了",
    });
    assert.equal(pending.body.status, "confirmation_required");
    assert.match(pending.body.text, /阶段：方案输出 → 投标/u);
    assert.match(pending.body.text, /「投标」不在看板已知阶段/u);
    assert.doesNotMatch(pending.body.text, /投标了/u);

    const confirmed = await send("opp-unknown-2", { conversationId: "conversation-unknown-1", text: "确认" });
    assert.match(confirmed.body.text, /【商机阶段已更新】/u);
    assert.match(confirmed.body.text, /如需分析可发送「项目分析 日照中医医院十五五规划」。/u);
    assert.doesNotMatch(confirmed.body.text, /阶段升级检查/u);
    withDb((db) => {
      assert.equal(db.prepare("SELECT stage FROM opportunities WHERE id = 'opp-rizhao-plan001'").get().stage, "投标");
      const metadata = JSON.parse(db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'opportunity.update'").get().metadata_json);
      assert.equal(metadata.stageReview, "skipped_unknown_stage");
    });
  });

  it("changes the amount behind the six-digit code with resend rotation", async () => {
    const pending = await send("opp-amount-1", {
      conversationId: "conversation-amount-1",
      text: "把黄岛区中医院的商机金额改成 5000 万",
    });
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "opportunity.update");
    assert.equal(pending.body.risk, "R2");
    assert.match(pending.body.text, /【小小提醒！修改商机】/u);
    assert.match(pending.body.text, /名称：双活机房建设/u);
    assert.match(pending.body.text, /金额：3000 万 → 5000 万/u);
    const firstCode = confirmationCodeFrom(pending.body.text);

    const resent = await send("opp-amount-2", { conversationId: "conversation-amount-1", text: "重发确认码" });
    assert.equal(resent.body.status, "confirmation_required");
    const secondCode = confirmationCodeFrom(resent.body.text);
    assert.match(resent.body.text, /金额：3000 万 → 5000 万/u, "the preview travels with the resent code");

    const confirmed = await send("opp-amount-3", { conversationId: "conversation-amount-1", text: secondCode });
    assert.equal(confirmed.response.status, 200);
    assert.match(confirmed.body.text, /【商机已更新】/u);
    assert.match(confirmed.body.text, /金额：3000 万 → 5000 万/u);
    withDb((db) => {
      const row = db.prepare("SELECT amount, version FROM opportunities WHERE id = 'opp-huangdao-tcm077'").get();
      assert.equal(row.amount, "5000 万");
      assert.equal(row.version, 2);
      const metadata = JSON.parse(db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'opportunity.update'").get().metadata_json);
      assert.deepEqual(metadata.changedFields, ["amount"]);
      assert.equal(metadata.source, "weixin-assistant");
    });
    assert.notEqual(firstCode, undefined);
  });

  it("locks the pending action after five wrong codes and never writes", async () => {
    const pending = await send("opp-lock-1", {
      conversationId: "conversation-lock-1",
      text: "把黄岛区中医院的商机金额改成 9999 万",
    });
    assert.equal(pending.body.status, "confirmation_required");
    const code = confirmationCodeFrom(pending.body.text);
    const wrongCode = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await send(`opp-lock-wrong-${attempt}`, { conversationId: "conversation-lock-1", text: wrongCode });
      assert.equal(failed.response.status, 409, `attempt ${attempt}`);
    }
    const afterLock = await send("opp-lock-final", { conversationId: "conversation-lock-1", text: code });
    assert.equal(afterLock.response.status, 409, "the correct code is dead after the lockout");
    withDb((db) => {
      assert.equal(
        db.prepare("SELECT amount FROM opportunities WHERE id = 'opp-huangdao-tcm077'").get().amount,
        "3000 万",
      );
    });
  });

  it("creates an opportunity behind the code with customer disambiguation and duplicate guard", async () => {
    const ambiguous = await send("opp-create-1", {
      conversationId: "conversation-create-1",
      text: "新建商机 黄岛AI算力项目，客户 黄岛",
    });
    assert.equal(ambiguous.body.status, "clarify");
    assert.match(ambiguous.body.text ?? ambiguous.body.message ?? ambiguous.body.question, /【找到多个客户】/u);
    assert.equal(ambiguous.body.actionId, undefined);

    const pending = await send("opp-create-2", {
      conversationId: "conversation-create-1",
      text: "新建商机 黄岛人民医院AI算力项目，客户 黄岛人民医院，阶段 线索，金额 500 万",
    });
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "opportunity.create");
    assert.equal(pending.body.risk, "R2");
    assert.match(pending.body.text, /【小小提醒！新建商机】/u);
    assert.match(pending.body.text, /客户：黄岛人民医院（已核验）/u);
    assert.match(pending.body.text, /阶段：线索/u);
    assert.match(pending.body.text, /金额：500 万/u);
    const code = confirmationCodeFrom(pending.body.text);

    const confirmed = await send("opp-create-3", { conversationId: "conversation-create-1", text: code });
    assert.match(confirmed.body.text, /【商机已建档】/u);
    assert.match(confirmed.body.text, /发送「商机详情 黄岛人民医院AI算力项目」可查看。/u);
    withDb((db) => {
      const row = db.prepare("SELECT * FROM opportunities WHERE id = $id").get({ $id: pending.body.actionId });
      assert.ok(row, "the pending action id is the durable opportunity key");
      assert.equal(row.owner, "assistant-owner");
      assert.equal(row.customer_id, "customer-seeded-4");
      assert.equal(row.customer, "黄岛人民医院");
      assert.equal(row.stage, "线索");
      assert.equal(row.amount, "500 万");
      const metadata = JSON.parse(db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'opportunity.create'").get().metadata_json);
      assert.equal(metadata.source, "weixin-assistant");
    });

    const duplicate = await send("opp-create-4", {
      conversationId: "conversation-create-2",
      text: "新建商机 黄岛人民医院AI算力项目，客户 黄岛人民医院",
    });
    assert.equal(duplicate.body.status, "clarify");
    assert.match(duplicate.body.text ?? duplicate.body.message ?? duplicate.body.question, /已存在同名商机/u);
  });

  it("deletes behind the R3 code with the reference-count warning", async () => {
    withDb((db) => {
      db.exec(`
        INSERT INTO action_items (id, opportunity_id, title, owner) VALUES
          ('act-del-1', 'opp-huangdao-tcm077', '行动一', 'jiangjz'),
          ('act-del-2', 'opp-huangdao-tcm077', '行动二', 'jiangjz');
        INSERT INTO risk_items (id, opportunity_id, title, target, evidence, action, owner) VALUES
          ('risk-del-1', 'opp-huangdao-tcm077', '风险一', '目标', '证据', '处理', 'jiangjz');
        INSERT INTO quick_records (id, raw_content, opportunity_id, owner) VALUES
          ('qr-del-1', '记录一', 'opp-huangdao-tcm077', 'jiangjz');
      `);
    });
    const pending = await send("opp-delete-1", {
      conversationId: "conversation-delete-1",
      text: "删除商机 tcm077",
    });
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "opportunity.delete");
    assert.equal(pending.body.risk, "R3");
    assert.match(pending.body.text, /【小小提醒！删除商机】/u);
    assert.match(pending.body.text, /名称：双活机房建设/u);
    assert.match(pending.body.text, /关联引用：行动 2 条、风险 1 条、快速记录 1 条、方案草稿 0 条/u);
    assert.match(pending.body.text, /请确认这不是误操作。/u);
    const code = confirmationCodeFrom(pending.body.text);

    const deleted = await send("opp-delete-2", { conversationId: "conversation-delete-1", text: code });
    assert.match(deleted.body.text, /【商机已删除（归档）】/u);
    withDb((db) => {
      assert.ok(db.prepare("SELECT deleted_at FROM opportunities WHERE id = 'opp-huangdao-tcm077'").get().deleted_at);
      const metadata = JSON.parse(db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'opportunity.delete'").get().metadata_json);
      assert.equal(metadata.source, "weixin-assistant");
      assert.equal(metadata.name, "双活机房建设");
    });
  });

  it("answers reads confirmation-free: progress question, scoped list, and the full list", async () => {
    const detail = await send("opp-read-1", {
      conversationId: "conversation-read-1",
      text: "日照的商机什么进展",
    });
    assert.equal(detail.body.status, "ok");
    assert.match(detail.body.text, /【商机】/u);
    assert.match(detail.body.text, /名称：日照中医医院十五五规划/u);
    assert.match(detail.body.text, /阶段：方案输出/u);
    assert.match(detail.body.text, /下一步：补齐规划材料/u);

    const scoped = await send("opp-read-2", {
      conversationId: "conversation-read-2",
      text: "黄岛区中医院有哪些商机",
    });
    assert.equal(scoped.body.status, "ok");
    assert.match(scoped.body.text, /【黄岛区中医院 的商机】/u);
    assert.match(scoped.body.text, /双活机房建设 …tcm077 ｜ 调研机会 ｜ 3000 万/u);

    const full = await send("opp-read-3", { conversationId: "conversation-read-3", text: "商机列表" });
    assert.equal(full.body.status, "ok");
    assert.match(full.body.text, /【商机列表】/u);
    assert.match(full.body.text, /数量：4 个/u);

    const contextual = await send("opp-read-4", { conversationId: "conversation-read-1", text: "项目分析" });
    assert.equal(contextual.response.status, 200, "the detail pinned the opportunity for follow-up analysis");
  });

  it("rejects group chats for opportunity writes at the HTTP boundary", async () => {
    const grouped = await send("opp-group-1", {
      conversationId: "conversation-group-1",
      chatType: "group",
      groupId: "group-1",
      text: "把日照的商机推进到方案交流",
    });
    // weixinAllowGroups=false fails closed before the router; the provider
    // write gate stays as defense in depth behind it.
    assert.equal(grouped.response.status, 403);
    withDb((db) => {
      assert.equal(
        db.prepare("SELECT stage FROM opportunities WHERE id = 'opp-rizhao-plan001'").get().stage,
        "方案输出",
      );
    });
  });

  it("expires an unconfirmed stage move after the pending TTL", async () => {
    const pending = await send("opp-ttl-1", {
      conversationId: "conversation-ttl-1",
      text: "把日照的商机推进到方案交流",
    });
    assert.equal(pending.body.status, "confirmation_required");
    nowMs += 11 * 60 * 1000;
    const late = await send("opp-ttl-2", { conversationId: "conversation-ttl-1", text: "确认" });
    // The expired action either fails closed (409/410) or the bare 确认 finds
    // no live pending action (clarify); it must never execute the write.
    assert.doesNotMatch(String(late.body.text ?? late.body.message ?? ""), /商机阶段已更新/u);
    withDb((db) => {
      assert.equal(
        db.prepare("SELECT stage FROM opportunities WHERE id = 'opp-rizhao-plan001'").get().stage,
        "方案输出",
      );
    });
  });

  it("keeps a bookkeeping draft and an opportunity affirm pending disjoint on 确认", async () => {
    const draft = await send("opp-bk-1", { conversationId: "conversation-bk-1", text: "支出 50 元 打车" });
    assert.equal(draft.response.status, 200);
    const pending = await send("opp-bk-2", { conversationId: "conversation-bk-1", text: "把日照的商机推进到方案交流" });
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "opportunity.update-stage");
    const confirmed = await send("opp-bk-3", { conversationId: "conversation-bk-1", text: "确认" });
    assert.match(confirmed.body.text, /【商机阶段已更新】/u, "确认 must confirm the opportunity, not the bookkeeping draft");
    withDb((db) => {
      assert.equal(db.prepare("SELECT stage FROM opportunities WHERE id = 'opp-rizhao-plan001'").get().stage, "方案交流");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0, "the draft stays unconfirmed");
    });
  });
});
