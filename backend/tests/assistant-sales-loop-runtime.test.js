import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";

const owner = "sales-loop-owner";
const machineToken = "sales-loop-machine-token";
const senderId = "sales-loop-sender";
const conversationId = "sales-loop-conversation";
const fixedNow = new Date("2026-08-20T10:00:00+08:00");

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let sequence;

function insertFixture() {
  const db = openDatabase({ databaseUrl });
  db.exec(`
    INSERT INTO customers (id, name, type, owner, budget, summary, needs, risks, stakeholders, decision_chain)
    VALUES ('customer-runtime', '运行时医院', '医院', '${owner}', '待立项', '评估平台稳定性升级', '["稳定性"]', '["预算待确认"]', '[]', '["信息科"]');
    INSERT INTO opportunities (id, customer_id, name, stage, amount, owner, requirements, next)
    VALUES ('opportunity-runtime', 'customer-runtime', '运行时升级项目', '初步发现', '1200000', '${owner}', '["总体规划"]', '安排技术交流');
    INSERT INTO quick_records (id, owner, raw_content, occurred_at, source_channel, customer_id, opportunity_id, status)
    VALUES ('record-runtime', '${owner}', '客户确认现有平台稳定性需要提升，预算路径尚未确认。', '2026-08-19T10:00:00+08:00', '微信助手', 'customer-runtime', 'opportunity-runtime', 'analyzed');
    INSERT INTO action_items (id, customer_id, opportunity_id, title, status, due, assignee)
    VALUES ('action-runtime', 'customer-runtime', 'opportunity-runtime', '补充技术资料', 'pending', '2026-08-21', '销售负责人');
    INSERT INTO risk_items (id, customer_id, opportunity_id, title, target, severity, status, evidence, action)
    VALUES ('risk-runtime', 'customer-runtime', 'opportunity-runtime', '预算未确认', '商机', '高', 'open', '会议纪要', '确认预算');
    INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
    VALUES ('insight-runtime', 'record-runtime', 'mock', 80, '{"customer":{"value":"运行时医院"},"opportunity":{"value":"运行时升级项目"},"summary":{"action":{"text":"安排技术交流"},"risk":{"text":"预算路径尚未确认"}}}');
  `);
  db.close();
}

async function event(text, sourceMessageId) {
  const response = await fetch(`${baseUrl}/api/integrations/weixin-agent/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineToken}`,
      "Idempotency-Key": `weixin:${sourceMessageId}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversationId,
      text,
      sourceMessageId,
      senderId,
      chatType: "direct",
    }),
  });
  return { response, body: await response.json() };
}

function businessCounts(db) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM customers) AS customers,
      (SELECT COUNT(*) FROM opportunities) AS opportunities,
      (SELECT COUNT(*) FROM quick_records) AS quick_records,
      (SELECT COUNT(*) FROM action_items) AS actions,
      (SELECT COUNT(*) FROM risk_items) AS risks
  `).get();
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-sales-loop-runtime-"));
  databaseUrl = join(tempDir, "runtime.sqlite");
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    aiAnalysisMode: "mock",
    modelApiKey: "",
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: owner,
    weixinAllowedSenderIds: senderId,
    weixinAllowGroups: false,
    assistantClock: () => fixedNow,
    now: () => fixedNow,
  });
  insertFixture();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  sequence = 0;
});

afterEach(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("wired sales loop assistant runtime", () => {
  it("routes visit capture through its fixed adapter, reuses the preview run at confirmation, and keeps writes gated", async () => {
    const collected = await event("拜访运行时医院，讨论升级项目。", `runtime-${++sequence}-visit`);
    assert.equal(collected.response.status, 200);
    assert.match(collected.body.text, /已暂存/);

    const preview = await event("记录", `runtime-${++sequence}-visit-preview`);
    assert.equal(preview.response.status, 200);
    assert.match(preview.body.text, /待确认记录/);

    let db = openDatabase({ databaseUrl });
    let runs = db.prepare(`
      SELECT agent_id, task_type, status, source, confirmation_status, input_json
      FROM assistant_agent_runs WHERE owner = $owner ORDER BY created_at, id
    `).all({ $owner: owner });
    assert.equal(runs.length, 1);
    assert.deepEqual({
      agentId: runs[0].agent_id,
      taskType: runs[0].task_type,
      status: runs[0].status,
      source: runs[0].source,
      confirmationStatus: runs[0].confirmation_status,
    }, {
      agentId: "visit-capture",
      taskType: "preview",
      status: "succeeded",
      source: "mock",
      confirmationStatus: "preview",
    });
    assert.equal(runs[0].input_json.includes("weixin:conversation"), false);
    db.close();

    const pending = await event("录入", `runtime-${++sequence}-visit-confirm-request`);
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    const code = pending.body.text.match(/确认码：(\d{6})/)?.[1];
    assert.match(code ?? "", /^\d{6}$/);

    const confirmed = await event(code, `runtime-${++sequence}-visit-confirm-code`);
    assert.equal(confirmed.response.status, 200);
    assert.match(confirmed.body.text, /已录入系统/);

    db = openDatabase({ databaseUrl });
    runs = db.prepare(`
      SELECT agent_id, task_type, status, source, confirmation_status
      FROM assistant_agent_runs WHERE owner = $owner ORDER BY created_at, id
    `).all({ $owner: owner });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].agent_id, "visit-capture");
    assert.equal(runs[0].task_type, "preview");
    assert.equal(runs[0].status, "succeeded");
    assert.equal(runs[0].confirmation_status, "preview");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM quick_records WHERE owner = $owner").get({ $owner: owner }).count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM action_items WHERE source_record_id IS NOT NULL").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM risk_items WHERE source_type = 'quick_record'").get().count, 0);
    db.close();

    // If the user skips the explicit preview command, confirmation still
    // creates one capture run and does not silently bypass the adapter.
    const direct = await event("电话运行时医院，确认下周回访。", `runtime-${++sequence}-visit-direct`);
    assert.equal(direct.response.status, 200);
    const directPending = await event("录入", `runtime-${++sequence}-visit-direct-request`);
    const directCode = directPending.body.text.match(/确认码：(\d{6})/)?.[1];
    assert.match(directCode ?? "", /^\d{6}$/);
    const directConfirmed = await event(directCode, `runtime-${++sequence}-visit-direct-code`);
    assert.equal(directConfirmed.response.status, 200);
    db = openDatabase({ databaseUrl });
    const taskTypes = db.prepare(
      "SELECT task_type FROM assistant_agent_runs WHERE owner = $owner ORDER BY created_at, id",
    ).all({ $owner: owner }).map((item) => item.task_type);
    assert.equal(taskTypes.filter((item) => item === "preview").length, 1);
    assert.equal(taskTypes.filter((item) => item === "capture").length, 1);
    db.close();
  });

  it("persists verified context, routes an implicit project analysis to sales-decision-v1, and keeps business rows read-only", async () => {
    const detail = await event("/opportunity.detail opportunity-runtime", `runtime-${++sequence}-detail`);
    assert.equal(detail.response.status, 200);
    assert.match(detail.body.text, /运行时升级项目/);

    const db = openDatabase({ databaseUrl });
    const before = businessCounts(db);
    const contextAfterDetail = db.prepare(`
      SELECT customer_id, opportunity_id, version, source
      FROM assistant_business_contexts
      WHERE owner = $owner AND channel = 'weixin'
    `).get({ $owner: owner });
    assert.deepEqual({
      customerId: contextAfterDetail.customer_id,
      opportunityId: contextAfterDetail.opportunity_id,
      source: contextAfterDetail.source,
    }, {
      customerId: "customer-runtime",
      opportunityId: "opportunity-runtime",
      source: "verified_entity",
    });

    const analyzed = await event("项目分析", `runtime-${++sequence}-analysis`);
    assert.equal(analyzed.response.status, 200);
    assert.match(analyzed.body.text, /sales-decision-v1/);
    assert.match(analyzed.body.text, /销售决策预览/);
    assert.match(analyzed.body.text, /未写回/);

    const run = db.prepare(`
      SELECT agent_id, task_type, status, source, confirmation_status
      FROM assistant_agent_runs
      WHERE owner = $owner
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get({ $owner: owner });
    assert.deepEqual({
      agentId: run.agent_id,
      taskType: run.task_type,
      status: run.status,
      confirmationStatus: run.confirmation_status,
    }, {
      agentId: "sales-decision",
      taskType: "opportunity_diagnosis",
      status: "succeeded",
      confirmationStatus: "preview",
    });
    const contextAfterAnalysis = db.prepare(`
      SELECT customer_id, opportunity_id, version, source
      FROM assistant_business_contexts
      WHERE owner = $owner AND channel = 'weixin'
    `).get({ $owner: owner });
    assert.equal(contextAfterAnalysis.source, "analysis");
    assert.ok(contextAfterAnalysis.version >= contextAfterDetail.version);
    assert.deepEqual(businessCounts(db), before);
    db.close();
  });

  it("replays the same analysis event without a second model run or context version bump", async () => {
    await event("项目分析 opportunity-runtime", `runtime-${++sequence}-warmup`);
    const first = await event("项目分析", "runtime-replay-analysis");
    assert.equal(first.response.status, 200);
    const db = openDatabase({ databaseUrl });
    const before = db.prepare("SELECT COUNT(*) AS count FROM assistant_agent_runs").get().count;
    const beforeVersion = db.prepare("SELECT version FROM assistant_business_contexts WHERE owner = $owner AND channel = 'weixin'").get({ $owner: owner }).version;
    db.close();
    const replay = await event("项目分析", "runtime-replay-analysis");
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, first.body);
    const afterDb = openDatabase({ databaseUrl });
    assert.equal(afterDb.prepare("SELECT COUNT(*) AS count FROM assistant_agent_runs").get().count, before);
    assert.equal(afterDb.prepare("SELECT version FROM assistant_business_contexts WHERE owner = $owner AND channel = 'weixin'").get({ $owner: owner }).version, beforeVersion);
    afterDb.close();
  });

  it("keeps sales weekly preview separate from reimbursement and exposes only owner-scoped confirmed evidence", async () => {
    const report = await event("销售周报", `runtime-${++sequence}-report`);
    assert.equal(report.response.status, 200);
    assert.match(report.body.text, /销售周报预览/);
    assert.match(report.body.text, /尚未写入周报/);
    assert.match(report.body.text, /运行时医院/);
    assert.doesNotMatch(report.body.text, /报销周汇总/);
    const db = openDatabase({ databaseUrl });
    const run = db.prepare(`
      SELECT agent_id, task_type, status, source, confirmation_status, input_json
      FROM assistant_agent_runs WHERE owner = $owner ORDER BY created_at DESC, id DESC LIMIT 1
    `).get({ $owner: owner });
    assert.deepEqual({
      agentId: run.agent_id,
      taskType: run.task_type,
      status: run.status,
      source: run.source,
      confirmationStatus: run.confirmation_status,
    }, {
      agentId: "sales-report",
      taskType: "weekly_preview",
      status: "succeeded",
      source: "deterministic",
      confirmationStatus: "preview",
    });
    assert.equal(run.input_json.includes(`"owner"`), false);
    db.close();
  });
});
