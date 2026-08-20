import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createSalesReportAssistantAdapter } from "../src/assistant/salesReportAssistantAdapter.js";

function snapshot(overrides = {}) {
  return {
    status: "ok",
    period: { start: "2026-08-17", end: "2026-08-23" },
    asOf: "2026-08-20T10:00:00.000Z",
    sourceRecords: [{
      id: "record-1",
      occurredAt: "2026-08-19T09:00:00+08:00",
      sourceChannel: "微信助手",
      analysis: {
        customer: { id: "customer-1", value: "示例医院" },
        opportunity: { id: "opportunity-1", value: "升级项目" },
        summary: {
          request: { title: "诉求", text: "确认升级范围。" },
          feedback: { title: "反馈", text: "希望下周沟通。" },
          action: { title: "动作", text: "安排技术交流。" },
          risk: { title: "风险", text: "预算路径未确认。" },
        },
      },
    }],
    knowledge: [{ id: "knowledge-1", title: "采购流程", summary: "核对采购路径。" }],
    reports: [{ id: "report-1", status: "ready", periodStart: "2026-08-17", periodEnd: "2026-08-23" }],
    candidateRecordCount: 1,
    statusCounts: { draft: 0, saved: 0, ready: 1 },
    preparation: { ready: true, blockers: [] },
    deterministicDraft: {
      content: "# 销售周报\n\n## 本周重点进展\n示例医院完成一次确认沟通。",
    },
    ...overrides,
  };
}

function modelResponse(content) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ content }) } }] }),
  };
}

describe("sales-report assistant adapter", () => {
  it("composes a source-backed preview with the fixed contract and persists an auditable run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "sales-report-run-1" });
    let calls = 0;
    const adapter = createSalesReportAssistantAdapter({
      snapshotProvider: async (input) => {
        assert.equal(input.owner, "owner-1");
        return snapshot();
      },
      config: { aiAnalysisMode: "model", modelProvider: "deepseek", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async (_url, options) => {
        calls += 1;
        const body = JSON.parse(options.body);
        assert.match(body.messages[0].content, /销售周报 Agent/);
        assert.doesNotMatch(JSON.stringify(body.messages), /owner-1/);
        assert.match(body.messages[1].content, /record-1/);
        return modelResponse("# 模型周报\n\n## 本周重点进展\n基于已确认记录整理。\n");
      },
      runRepository: runs,
    });

    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-1",
      eventId: "event-1",
      taskType: "weekly_preview",
      weekStart: "2026-08-17",
    });

    assert.equal(calls, 1);
    assert.equal(result.schemaVersion, "sales-report-v1");
    assert.equal(result.agentId, "sales-report");
    assert.equal(result.contractVersion, "sales-report-v1");
    assert.equal(result.status, "preview");
    assert.equal(result.content.includes("模型周报"), true);
    assert.equal(result.writebackAllowed, false);
    assert.equal(result.writebackPreview.requiresHumanConfirmation, true);
    assert.ok(result.sourceRefs.some((item) => item.type === "quick_record" && item.id === "record-1"));
    assert.ok(result.sourceRefs.some((item) => item.type === "knowledge" && item.id === "knowledge-1"));
    assert.ok(result.persistedReportRefs.some((item) => item.id === "report-1"));
    assert.equal(result.sourceRefs.some((item) => item.id === "forged"), false);

    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.source, "model");
    assert.equal(stored.confirmationStatus, "preview");
    assert.equal(stored.input.owner, undefined);
    db.close();
  });

  it("uses the deterministic draft when the model is unavailable and exposes blockers instead of inventing progress", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "sales-report-run-fallback" });
    const adapter = createSalesReportAssistantAdapter({
      snapshotProvider: () => snapshot({
        sourceRecords: [],
        candidateRecordCount: 2,
        preparation: { ready: false, blockers: ["no_confirmed_records", "truncated"] },
        deterministicDraft: { content: "暂无已确认进入周报的快速记录。" },
      }),
      config: { aiAnalysisMode: "model", modelApiKey: "" },
      fetchImpl: async () => { throw new Error("must not call model"); },
      runRepository: runs,
    });

    const result = await adapter.analyze({ owner: "owner-1", eventId: "event-fallback", taskType: "source_review" });
    assert.equal(result.source, "deterministic");
    assert.equal(result.content, "暂无已确认进入周报的快速记录。");
    assert.equal(result.preparation.ready, false);
    assert.ok(result.unknowns.some((item) => item.key === "no_confirmed_records"));
    assert.equal(result.executiveSummary.includes("本周完成"), false);
    assert.equal(runs.get(result.runId, { owner: "owner-1" }).item.source, "deterministic");
    db.close();
  });

  it("records model failures as fallback without losing deterministic source references", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "sales-report-run-error" });
    const adapter = createSalesReportAssistantAdapter({
      snapshotProvider: () => snapshot(),
      config: { aiAnalysisMode: "model", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async () => { throw new Error("provider unavailable"); },
      runRepository: runs,
    });
    const result = await adapter.analyze({ owner: "owner-1", eventId: "event-error", taskType: "meeting_digest" });
    assert.equal(result.source, "fallback");
    assert.equal(result.content.includes("示例医院"), true);
    assert.ok(result.sourceRefs.some((item) => item.type === "quick_record" && item.id === "record-1"));
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.status, "fallback");
    assert.equal(stored.fallbackReason, "weekly_draft_model_failure");
    db.close();
  });

  it("rejects model prose that falsely claims the report was saved or published", async () => {
    const adapter = createSalesReportAssistantAdapter({
      snapshotProvider: () => snapshot(),
      config: { aiAnalysisMode: "model", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async () => modelResponse("周报已保存并发布到系统。"),
    });
    const result = await adapter.analyze({ owner: "owner-1", taskType: "weekly_preview" });
    assert.equal(result.source, "fallback");
    assert.doesNotMatch(result.content, /已保存并发布/);
    assert.match(result.content, /销售周报/);
    assert.equal(result.writebackPreview.save, false);
    assert.equal(result.writebackPreview.publish, false);
  });

  it("rejects citation tokens that are not present in the server snapshot", async () => {
    const adapter = createSalesReportAssistantAdapter({
      snapshotProvider: () => snapshot(),
      config: { aiAnalysisMode: "model", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async () => modelResponse("本周进展见[来源:quick_record/forged-record]。"),
    });
    const result = await adapter.analyze({ owner: "owner-1", taskType: "source_review" });
    assert.equal(result.source, "fallback");
    assert.doesNotMatch(result.content, /forged-record/);
    assert.ok(result.sourceRefs.some((item) => item.id === "record-1"));
  });

  it("replays a completed event without invoking the model twice", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, {
      idFactory: (() => {
        let count = 0;
        return () => `sales-report-run-${++count}`;
      })(),
    });
    let calls = 0;
    const adapter = createSalesReportAssistantAdapter({
      snapshotProvider: () => snapshot(),
      config: { aiAnalysisMode: "model", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async () => {
        calls += 1;
        return modelResponse("# 周报");
      },
      runRepository: runs,
    });
    const input = { owner: "owner-1", channel: "desktop", conversationId: "conversation-replay", eventId: "event-replay" };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);
    assert.equal(calls, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    assert.deepEqual(replay.sourceRefs, first.sourceRefs);
    db.close();
  });
});
