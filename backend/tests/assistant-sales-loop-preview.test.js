import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createSalesLoopContextRepository } from "../src/assistant/salesLoopContextRepository.js";
import { createSalesLoopPreviewService } from "../src/assistant/salesLoopPreview.js";
import { openDatabase } from "../src/db.js";

function fixtureDb() {
  const db = openDatabase({ databaseUrl: ":memory:" });
  db.exec(`
    INSERT INTO customers (id, name, type, owner, budget, summary, needs, risks, stakeholders, decision_chain)
    VALUES (
      'customer-a', 'A医院', '医院', 'owner-a', '待立项', '评估基础设施升级',
      '["稳定性"]', '["预算未确认"]', '[]', '["信息科", "分管院长"]'
    );
    INSERT INTO customers (id, name, type, owner, summary)
    VALUES ('customer-b', 'B医院', '医院', 'owner-b', '其他账号资料');
    INSERT INTO opportunities (id, customer_id, name, stage, amount, owner, requirements, next)
    VALUES ('opportunity-a', 'customer-a', 'A升级项目', '初步发现', '1200000', 'owner-a', '["总体规划"]', '安排技术交流');
    INSERT INTO opportunities (id, customer_id, name, stage, owner)
    VALUES ('opportunity-b', 'customer-b', 'B升级项目', '初步发现', 'owner-b');
    INSERT INTO quick_records (id, owner, raw_content, occurred_at, source_channel, customer_id, opportunity_id, status)
    VALUES ('record-a', 'owner-a', '客户确认平台稳定性需要提升。', '2026-08-19T10:00:00+08:00', '微信助手', 'customer-a', 'opportunity-a', 'analyzed');
    INSERT INTO quick_records (id, owner, raw_content, occurred_at, source_channel, customer_id, opportunity_id, status)
    VALUES ('record-b', 'owner-b', '越权内容不应出现。', '2026-08-19T10:00:00+08:00', '微信助手', 'customer-b', 'opportunity-b', 'analyzed');
    INSERT INTO action_items (id, customer_id, opportunity_id, title, status, due, assignee)
    VALUES ('action-a', 'customer-a', 'opportunity-a', '补充技术资料', 'pending', '2026-08-21', '销售负责人');
    INSERT INTO risk_items (id, customer_id, opportunity_id, title, target, severity, status, evidence, action)
    VALUES ('risk-a', 'customer-a', 'opportunity-a', '预算未确认', '商机', '高', 'open', '会议纪要', '确认预算');
    INSERT INTO knowledge_items (id, title, category, summary, content, source)
    VALUES ('knowledge-a', '医院采购流程', '销售', '需要核对采购路径。', '不应把完整正文直接暴露给预览。', '内部知识库');
    INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
    VALUES ('insight-a', 'record-a', 'mock', 80, '{"customer":{"value":"A医院"},"opportunity":{"value":"A升级项目"},"summary":{"action":{"text":"安排技术交流"},"risk":{"text":"预算未确认"}}}');
    INSERT INTO weekly_reports (id, owner, period_start, period_end, status, content, source_refs)
    VALUES ('report-a', 'owner-a', '2026-08-17', '2026-08-23', 'ready', '已保存周报', '[{"type":"quick_record","id":"record-a"}]');
  `);
  return db;
}

function createService(db, { contextRepository = null, decisionAdapter = null } = {}) {
  const runs = createAssistantAgentRunRepository(db, { idFactory: () => "run-preview-1" });
  const adapter = decisionAdapter ?? undefined;
  const context = contextRepository ?? createSalesLoopContextRepository(db, {
    idFactory: () => "context-preview-1",
    clock: () => new Date("2026-08-20T10:00:00.000Z"),
    resolveEntities: ({ owner, customerId, opportunityId }) => ({
      customer: owner === "owner-a" && (!customerId || customerId === "customer-a") ? { id: "customer-a" } : null,
      opportunity: owner === "owner-a" && (!opportunityId || opportunityId === "opportunity-a")
        ? { id: "opportunity-a", customerId: "customer-a" }
        : null,
    }),
  });
  return {
    service: createSalesLoopPreviewService({
      db,
      contextRepository: context,
      ...(adapter ? { salesDecisionAdapter: adapter } : {}),
      ...(adapter ? {} : { runRepository: runs, config: { aiAnalysisMode: "mock" } }),
      clock: () => new Date("2026-08-20T10:00:00.000Z"),
    }),
    runs,
    context,
  };
}

describe("sales loop preview service", () => {
  it("builds an owner-scoped sales snapshot with bounded fields and complete source refs", () => {
    const db = fixtureDb();
    const { service } = createService(db);
    const result = service.buildSnapshot({
      owner: "owner-a",
      channel: "desktop",
      conversationId: "conversation-a",
      opportunityId: "opportunity-a",
      knowledgeQuery: "采购",
      sourceRefs: [{ type: "forged", id: "forged-source" }],
    });
    assert.equal(result.status, "ok");
    assert.equal(result.snapshot.customer.id, "customer-a");
    assert.equal(result.snapshot.opportunity.id, "opportunity-a");
    assert.equal(result.snapshot.quickRecord.id, "record-a");
    assert.deepEqual(result.snapshot.actions.map((item) => item.id), ["action-a"]);
    assert.deepEqual(result.snapshot.risks.map((item) => item.id), ["risk-a"]);
    assert.ok(result.evidence.sourceRefs.some((item) => item.type === "customer" && item.id === "customer-a"));
    assert.ok(result.evidence.sourceRefs.some((item) => item.type === "quick_record" && item.id === "record-a"));
    assert.equal(result.evidence.sourceRefs.some((item) => item.id === "forged-source"), false);
    assert.equal(JSON.stringify(result).includes("越权内容"), false);
    assert.equal(JSON.stringify(result).includes("完整正文"), false);
    db.close();
  });

  it("uses the existing sales-decision-v1 adapter, persists an auditable run, and never writes business rows", async () => {
    const db = fixtureDb();
    const before = db.prepare("SELECT COUNT(*) AS count FROM customers").get().count;
    const { service, runs } = createService(db);
    const result = await service.previewSalesDecision({
      owner: "owner-a",
      channel: "desktop",
      conversationId: "conversation-a",
      eventId: "event-a",
      opportunityId: "opportunity-a",
      analysisType: "opportunity_diagnosis",
      industry: "medical",
    });
    assert.equal(result.status, "preview");
    assert.equal(result.writebackAllowed, false);
    assert.equal(result.analysis.schemaVersion, "sales-decision-v1");
    assert.equal(result.analysis.writebackPreview.requiresHumanConfirmation, true);
    assert.equal(result.runId, "run-preview-1");
    assert.equal(runs.get(result.runId, { owner: "owner-a" }).item.status, "succeeded");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers").get().count, before);
    db.close();
  });

  it("remembers only verified context and rejects missing or cross-owner targets", () => {
    const db = fixtureDb();
    const { service, context } = createService(db);
    const saved = service.rememberContext({
      owner: "owner-a",
      channel: "desktop",
      conversationId: "conversation-a",
      customerId: "customer-a",
      opportunityId: "opportunity-a",
    });
    assert.equal(saved.status, "ok");
    assert.equal(context.get({ owner: "owner-a", channel: "desktop", conversationId: "conversation-a" }).opportunityId, "opportunity-a");
    assert.equal(service.buildSnapshot({ owner: "owner-a", channel: "desktop", conversationId: "conversation-a" }).context.opportunityId, "opportunity-a");
    assert.equal(service.buildSnapshot({ owner: "owner-a", channel: "desktop", conversationId: "empty" }).status, "clarify");
    assert.equal(service.buildSnapshot({ owner: "owner-a", channel: "desktop", conversationId: "hidden", opportunityId: "opportunity-b" }).status, "not_found");
    db.close();
  });

  it("creates a source-backed weekly report preview from confirmed records without saving it", () => {
    const db = fixtureDb();
    const { service } = createService(db);
    const before = db.prepare("SELECT COUNT(*) AS count FROM weekly_reports").get().count;
    const result = service.previewSalesReport({ owner: "owner-a", weekStart: "2026-08-17" });
    assert.equal(result.status, "preview");
    assert.equal(result.writebackAllowed, false);
    assert.equal(result.reportCount, 1);
    assert.equal(result.preview.sourceRecordCount, 1);
    assert.match(result.preview.content, /A医院/);
    assert.ok(result.preview.sourceRefs.some((item) => item.type === "quick_record" && item.id === "record-a"));
    assert.equal(result.preview.persisted, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weekly_reports").get().count, before);
    db.close();
  });

  it("exposes a bounded owner-scoped sales-report snapshot without trusting caller source refs", () => {
    const db = fixtureDb();
    const { service } = createService(db);
    const snapshot = service.buildSalesReportSnapshot({
      owner: "owner-a",
      weekStart: "2026-08-17",
      knowledgeQuery: "采购",
      sourceRefs: [{ type: "forged", id: "forged-source" }],
    });
    assert.equal(snapshot.status, "ok");
    assert.deepEqual(snapshot.period, { start: "2026-08-17", end: "2026-08-23" });
    assert.equal(snapshot.sourceRecords.length, 1);
    assert.equal(snapshot.sourceRecords[0].id, "record-a");
    assert.equal(snapshot.sourceRecords[0].rawContent, "客户确认平台稳定性需要提升。");
    assert.ok(snapshot.sourceRefs.some((item) => item.type === "quick_record" && item.id === "record-a"));
    assert.ok(snapshot.sourceRefs.some((item) => item.type === "knowledge" && item.id === "knowledge-a"));
    assert.equal(snapshot.sourceRefs.some((item) => item.id === "forged-source"), false);
    assert.equal(JSON.stringify(snapshot).includes("owner-a"), false);
    db.close();
  });

  it("returns a bounded review result when sales decision evidence is incomplete", async () => {
    const db = fixtureDb();
    const fake = {
      analyze: async () => {
        const error = new Error("evidence missing");
        error.name = "AssistantContractError";
        error.code = "missing_sales_decision_evidence";
        throw error;
      },
    };
    const { service } = createService(db, { decisionAdapter: fake });
    const result = await service.previewSalesDecision({
      owner: "owner-a",
      channel: "desktop",
      conversationId: "conversation-a",
      customerId: "customer-a",
      analysisType: "customer_analysis",
    });
    assert.equal(result.status, "review_required");
    assert.deepEqual(result.blockers, ["missing_sales_decision_evidence"]);
    db.close();
  });

  it("keeps authenticated-account to business-owner mapping consistent across every read", () => {
    const db = fixtureDb();
    const mapped = createSalesLoopPreviewService({
      db,
      resolveBusinessOwner: (account) => ({ "account-a": "owner-a" })[account] ?? null,
      clock: () => new Date("2026-08-20T10:00:00.000Z"),
    });
    const result = mapped.buildSnapshot({
      owner: "account-a",
      channel: "desktop",
      conversationId: "mapped-conversation",
      opportunityId: "opportunity-a",
      sourceRefs: [{ type: "forged", id: "forged-source" }],
    });
    assert.equal(result.status, "ok");
    assert.equal(result.snapshot.quickRecord.id, "record-a");
    assert.deepEqual(result.snapshot.actions.map((item) => item.id), ["action-a"]);
    db.close();
  });

  it("preserves multiline evidence while rejecting control characters", () => {
    const db = fixtureDb();
    db.prepare("UPDATE quick_records SET raw_content = $content WHERE id = 'record-a'")
      .run({ $content: "第一行\n第二行\t保留" });
    const { service } = createService(db);
    const result = service.buildSnapshot({ owner: "owner-a", opportunityId: "opportunity-a" });
    assert.equal(result.snapshot.quickRecord.rawContent, "第一行\n第二行\t保留");
    db.prepare("UPDATE quick_records SET raw_content = $content WHERE id = 'record-a'")
      .run({ $content: "不可见\u0000内容" });
    const next = service.buildSnapshot({ owner: "owner-a", opportunityId: "opportunity-a" });
    assert.equal(next.snapshot.quickRecord.rawContent, "");
    db.close();
  });
});
