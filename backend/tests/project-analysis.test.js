import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { analyzeProjectSnapshot } from "../src/assistant/projectAnalysis.js";

const PROJECT_ANALYSIS_MODULE_URL = new URL("../src/assistant/projectAnalysis.js", import.meta.url).href;

function completeSnapshot() {
  return {
    customer: {
      id: "customer-1",
      name: "示例医院",
    },
    opportunity: {
      id: "opportunity-1",
      name: "数据中心升级",
      stage: "proposal",
      amount: "120 万",
      probability: 65,
    },
    quickRecord: [{
      id: "quick-record-1",
      occurredAt: "2026-08-11T09:00:00+08:00",
      sourceChannel: "visit",
    }],
    action: [{
      id: "action-1",
      title: "补齐技术方案",
      status: "pending",
      due: "2026-08-16",
    }],
    risk: [{
      id: "risk-1",
      title: "预算尚未确认",
      status: "open",
      severity: "高",
    }],
    itinerary: [{
      id: "itinerary-1",
      visitDate: "2026-08-15",
      status: "planned",
    }],
    expense: [{
      id: "expense-1",
      actualPaidCents: 8_800,
      reimbursementCents: 7_000,
      invoiceStatus: "pending",
      occurredOn: "2026-08-12",
    }],
    report: [{
      id: "report-1",
      periodStart: "2026-08-10",
      periodEnd: "2026-08-16",
      status: "draft",
    }],
  };
}

function fact(result, key) {
  return result.facts.find((item) => item.key === key);
}

function hasUnknown(result, key) {
  return result.unknowns.some((item) => item.key === key);
}

function sourceRefKey(ref) {
  return `${ref.type}:${ref.id}`;
}

function collectOutputSourceRefs(result) {
  const refs = [];
  for (const item of [...result.facts, ...result.risks, ...result.nextActions, ...result.inferences]) {
    if (item.sourceType && item.sourceId) refs.push({ type: item.sourceType, id: item.sourceId });
    for (const ref of item.sourceRefs ?? []) refs.push(ref);
  }
  return refs;
}

function runAnalysisInTimezone(timeZone, snapshot) {
  const script = `
    const { analyzeProjectSnapshot } = await import(${JSON.stringify(PROJECT_ANALYSIS_MODULE_URL)});
    const result = analyzeProjectSnapshot(${JSON.stringify(snapshot)});
    console.log(JSON.stringify({
      overdue: result.metrics.actions.overdue,
      due: result.nextActions[0]?.due ?? null,
      freshness: result.metrics.evidenceFreshness,
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: timeZone },
  }));
}

describe("pure project analysis", () => {
  it("separates evidence, inferences, unknowns, risks, actions, metrics, and sources", () => {
    const snapshot = completeSnapshot();
    const before = structuredClone(snapshot);
    const result = analyzeProjectSnapshot(snapshot);

    assert.deepEqual(Object.keys(result).sort(), [
      "facts",
      "inferences",
      "metrics",
      "nextActions",
      "projectCard",
      "risks",
      "schemaVersion",
      "sourceRefs",
      "unknowns",
    ]);
    assert.equal(result.schemaVersion, "project-analysis-v1");
    assert.deepEqual(result.projectCard, {
      schemaVersion: "project-card-v1",
      projectId: "opportunity-1",
      projectName: "数据中心升级",
      customerId: "customer-1",
      customerName: "示例医院",
      stage: "proposal",
      amount: "120 万",
      probability: 65,
      openActionCount: 1,
      overdueActionCount: 0,
      activeRiskCount: 1,
      nextActionId: "action-1",
      topRiskId: "risk-1",
      evidenceFreshnessStatus: "unknown_reference",
    });
    assert.ok(result.facts.some((item) => item.key === "opportunity.stage" && item.value === "proposal"));
    assert.deepEqual(fact(result, "opportunity.amount"), {
      key: "opportunity.amount",
      value: "120 万",
      label: "商机金额",
      sourceType: "opportunity",
      sourceId: "opportunity-1",
    });
    assert.ok(result.facts.some((item) => item.key === "opportunity.probability" && item.value === 65));
    assert.ok(result.facts.some((item) => item.key === "quickRecord.latest" && item.sourceId === "quick-record-1"));
    assert.ok(result.inferences.some((item) => typeof item.statement === "string" && item.statement.length > 0));
    assert.ok(result.risks.some((item) => item.sourceId === "risk-1"));
    assert.ok(result.nextActions.some((item) => item.sourceId === "action-1"));
    assert.deepEqual(result.metrics.opportunity, {
      stage: "proposal",
      amount: "120 万",
      probability: 65,
    });
    assert.equal(result.metrics.expense.actualPaidCents, 8_800);
    assert.equal(result.metrics.expense.reimbursementCents, 7_000);
    assert.equal(result.metrics.actions.open, 1);
    assert.ok(result.metrics.evidenceFreshness);
    assert.ok(result.sourceRefs.some((item) => item.type === "opportunity" && item.id === "opportunity-1"));
    assert.ok(result.sourceRefs.some((item) => item.type === "quickRecord" && item.id === "quick-record-1"));
    assert.deepEqual(snapshot, before);
    assert.deepEqual(analyzeProjectSnapshot(snapshot), result);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });

  it("reports unknowns instead of inventing missing commercial evidence", () => {
    const result = analyzeProjectSnapshot({
      customer: { id: "customer-2", name: "待确认客户" },
      opportunity: { id: "opportunity-2", stage: null, amount: null, probability: null },
      quickRecord: [],
      action: [],
      risk: [],
      itinerary: [],
      expense: [],
      report: [],
    });

    assert.ok(result.unknowns.some((item) => item.key === "opportunity.stage"));
    assert.ok(result.unknowns.some((item) => item.key === "opportunity.amount"));
    assert.ok(result.unknowns.some((item) => item.key === "opportunity.probability"));
    assert.ok(result.unknowns.some((item) => item.key === "quickRecord.latest"));
    assert.equal(result.facts.some((item) => item.key === "opportunity.amount"), false);
    assert.equal(result.inferences.some((item) => /预算|金额|概率/.test(item.statement)), false);
    assert.deepEqual(result.metrics.actions, { open: 0, overdue: 0 });
  });

  it("keeps unsafe numeric evidence out of facts and metrics", () => {
    const result = analyzeProjectSnapshot({
      asOf: "2026-08-14T00:00:00Z",
      customer: { id: "customer-1", name: "示例医院" },
      opportunity: {
        id: "opportunity-unsafe",
        stage: "proposal",
        amount: "120 万",
        probability: 0.65,
      },
      expense: [
        { id: "expense-negative", actualPaidCents: -100, reimbursementCents: 1_000 },
        { id: "expense-decimal", actualPaidCents: 10.5, reimbursementCents: 1.5 },
        { id: "expense-infinite", actualPaidCents: Infinity, reimbursementCents: Number.MAX_SAFE_INTEGER + 1 },
        { id: "expense-valid", actualPaidCents: 200, reimbursementCents: 150 },
      ],
    });

    assert.equal(fact(result, "opportunity.probability"), undefined);
    assert.ok(hasUnknown(result, "opportunity.probability"));
    assert.equal(result.metrics.opportunity.probability, null);
    assert.equal("amountCents" in result.metrics.opportunity, false);
    assert.equal(result.metrics.expense.actualPaidCents, 200);
    assert.equal(result.metrics.expense.reimbursementCents, 150);
    assert.ok(result.facts.every((item) => !String(item.key).startsWith("expense.") || Number.isSafeInteger(item.value)));
    assert.ok(hasUnknown(result, "expense.actualPaidCents"));
    assert.ok(hasUnknown(result, "expense.reimbursementCents"));

    for (const probability of [-1, 10.5, 101, Number.MAX_SAFE_INTEGER + 1]) {
      const invalidProbability = analyzeProjectSnapshot({
        opportunity: { id: "opportunity-probability", amount: "120 万", probability },
      });
      assert.equal(fact(invalidProbability, "opportunity.probability"), undefined);
      assert.equal(invalidProbability.metrics.opportunity.probability, null);
      assert.ok(hasUnknown(invalidProbability, "opportunity.probability"));
    }

    for (const probability of [0, 100]) {
      const validProbability = analyzeProjectSnapshot({
        opportunity: { id: "opportunity-probability", amount: "120 万", probability },
      });
      assert.equal(fact(validProbability, "opportunity.probability")?.value, probability);
      assert.equal(validProbability.metrics.opportunity.probability, probability);
    }

    const overflow = analyzeProjectSnapshot({
      expense: [
        { id: "expense-max", actualPaidCents: Number.MAX_SAFE_INTEGER, reimbursementCents: Number.MAX_SAFE_INTEGER },
        { id: "expense-overflow", actualPaidCents: 1, reimbursementCents: 1 },
      ],
    });
    assert.equal(Number.isSafeInteger(overflow.metrics.expense.actualPaidCents), true);
    assert.equal(Number.isSafeInteger(overflow.metrics.expense.reimbursementCents), true);
    assert.ok(hasUnknown(overflow, "expense.actualPaidCents"));
    assert.ok(hasUnknown(overflow, "expense.reimbursementCents"));
  });

  it("treats deferred actions, accepted risks, and ready reports as active planning evidence", () => {
    const result = analyzeProjectSnapshot({
      asOf: "2026-08-14T00:00:00Z",
      action: [{ id: "action-deferred", title: "等待客户确认", status: "deferred" }],
      risk: [
        { id: "risk-accepted", title: "预算口径需复核", status: "accepted", severity: "中" },
        { id: "risk-open", title: "竞争方提前进入", status: "open", severity: "高" },
        { id: "risk-closed", title: "历史风险", status: "closed", severity: "低" },
      ],
      report: [
        { id: "report-draft", status: "draft" },
        { id: "report-saved", status: "saved" },
        { id: "report-ready", status: "ready" },
      ],
    });

    assert.equal(result.metrics.actions.open, 1);
    assert.ok(result.nextActions.some((item) => item.sourceId === "action-deferred" && item.status === "deferred"));
    assert.equal(result.metrics.risks.active, 2);
    assert.ok(result.risks.some((item) => item.sourceId === "risk-accepted" && item.status === "accepted"));
    assert.equal(result.risks.some((item) => item.sourceId === "risk-closed"), false);
    assert.equal(result.metrics.report.draft, 1);
    assert.equal(result.metrics.report.saved, 1);
    assert.equal(result.metrics.report.ready, 1);
  });

  it("does not turn fallback source identifiers into customer or opportunity facts", () => {
    const result = analyzeProjectSnapshot({
      customer: { name: "缺少真实ID客户" },
      opportunity: { name: "缺少真实ID商机", stage: "proposal", amount: "120 万", probability: 65 },
    });

    assert.deepEqual(result.sourceRefs.find((item) => item.type === "customer"), {
      type: "customer",
      id: "synthetic:customer:1",
      synthetic: true,
    });
    assert.deepEqual(result.sourceRefs.find((item) => item.type === "opportunity"), {
      type: "opportunity",
      id: "synthetic:opportunity:1",
      synthetic: true,
    });
    assert.equal(fact(result, "customer.id"), undefined);
    assert.equal(fact(result, "opportunity.id"), undefined);
    assert.ok(hasUnknown(result, "customer.id"));
    assert.ok(hasUnknown(result, "opportunity.id"));
  });

  it("rejects oversized or reserved identifiers without merging synthetic evidence", () => {
    const oversizedId = "x".repeat(201);
    const oversized = analyzeProjectSnapshot({
      customer: { id: oversizedId, name: "超长客户" },
      opportunity: { id: oversizedId, name: "超长商机", amount: "120 万", probability: 65 },
    });

    assert.equal(fact(oversized, "customer.id"), undefined);
    assert.equal(fact(oversized, "opportunity.id"), undefined);
    assert.ok(hasUnknown(oversized, "customer.id"));
    assert.ok(hasUnknown(oversized, "opportunity.id"));
    assert.deepEqual(oversized.sourceRefs.find((item) => item.type === "customer"), {
      type: "customer",
      id: "synthetic:customer:1",
      synthetic: true,
    });
    assert.deepEqual(oversized.sourceRefs.find((item) => item.type === "opportunity"), {
      type: "opportunity",
      id: "synthetic:opportunity:1",
      synthetic: true,
    });

    const actionCollision = analyzeProjectSnapshot({
      action: [
        { title: "没有真实 ID", status: "pending" },
        { id: "synthetic:action:1", title: "保留前缀不是业务 ID", status: "pending" },
      ],
    });
    assert.deepEqual(actionCollision.nextActions.map((item) => item.sourceId), [
      "synthetic:action:1",
      "synthetic:action:2",
    ]);
    assert.deepEqual(actionCollision.sourceRefs, [
      { type: "action", id: "synthetic:action:1", synthetic: true },
      { type: "action", id: "synthetic:action:2", synthetic: true },
    ]);
  });

  it("marks freshness reference as unknown when dated evidence has no analysis reference time", () => {
    const result = analyzeProjectSnapshot({
      quickRecord: [{ id: "quick-record-1", occurredAt: "2026-08-11" }],
    });

    assert.equal(result.metrics.evidenceFreshness.status, "unknown_reference");
    assert.ok(hasUnknown(result, "evidenceFreshness.referenceAt"));
  });

  it("keeps top-level sourceRefs complete for every emitted output reference", () => {
    const actions = Array.from({ length: 100 }, (_, index) => ({
      id: `action-${index + 1}`,
      title: `行动 ${index + 1}`,
      status: index % 2 === 0 ? "pending" : "deferred",
    }));
    const risks = Array.from({ length: 100 }, (_, index) => ({
      id: `risk-${index + 1}`,
      title: `风险 ${index + 1}`,
      status: index % 2 === 0 ? "open" : "accepted",
      severity: index % 2 === 0 ? "高" : "中",
    }));
    const result = analyzeProjectSnapshot({ asOf: "2026-08-14", action: actions, risk: risks });

    const indexed = new Set(result.sourceRefs.map(sourceRefKey));
    const dangling = collectOutputSourceRefs(result)
      .filter((ref) => !indexed.has(sourceRefKey(ref)))
      .map(sourceRefKey);

    assert.deepEqual(dangling, []);
    assert.equal(result.metrics.actions.open, 100);
    assert.equal(result.metrics.risks.active, 100);
    assert.equal(result.nextActions.length, 100);
    assert.equal(result.risks.length, 100);
    assert.equal(result.sourceRefs.length, 200);
    assert.ok(result.sourceRefs.length <= 602);
  });

  it("rejects timezone-less datetimes and keeps overdue analysis deterministic across timezones", () => {
    const snapshot = {
      asOf: "2026-08-14T18:00:00Z",
      quickRecord: [{ id: "quick-record-date", occurredAt: "2026-08-14" }],
      action: [{
        id: "action-without-timezone",
        title: "无时区时间证据",
        status: "pending",
        due: "2026-08-14T23:30:00",
      }],
    };

    const utc = runAnalysisInTimezone("UTC", snapshot);
    const shanghai = runAnalysisInTimezone("Asia/Shanghai", snapshot);

    assert.deepEqual(utc, shanghai);
    assert.equal(utc.overdue, 0);
    assert.equal(utc.due, null);
    assert.equal(utc.freshness.latestAt, "2026-08-14");
    assert.ok(hasUnknown(analyzeProjectSnapshot(snapshot), "action.due"));

    const missingDue = analyzeProjectSnapshot({ action: [{ id: "action-no-due", status: "pending" }] });
    assert.equal(hasUnknown(missingDue, "action.due"), false);
  });

  it("counts only real status enumerations", () => {
    const result = analyzeProjectSnapshot({
      action: [
        { id: "pending", status: "pending" },
        { id: "progress", status: "in_progress" },
        { id: "deferred", status: "deferred" },
        { id: "done", status: "done" },
      ],
      risk: [
        { id: "open", status: "open", severity: "高" },
        { id: "accepted", status: "accepted", severity: "中" },
        { id: "progress", status: "in_progress", severity: "中" },
        { id: "deferred", status: "deferred", severity: "低" },
        { id: "closed", status: "closed", severity: "低" },
      ],
      itinerary: [
        { id: "planned", status: "planned" },
        { id: "completed", status: "completed" },
        { id: "cancelled", status: "cancelled" },
      ],
      report: [
        { id: "draft", status: "draft" },
        { id: "saved", status: "saved" },
        { id: "ready", status: "ready" },
      ],
    });

    assert.equal(result.metrics.actions.open, 3);
    assert.equal(result.nextActions.length, 3);
    assert.equal(result.metrics.risks.active, 4);
    assert.equal(result.risks.length, 4);
    assert.deepEqual(result.metrics.itinerary, { count: 3, planned: 1 });
    assert.deepEqual(result.metrics.report, { count: 3, draft: 1, saved: 1, ready: 1 });
  });

  for (const status of ["completed", "closed", "cancelled", "resolved", "other"]) {
    it(`fails closed for action status ${status}`, () => {
      const result = analyzeProjectSnapshot({ action: [{ id: `action-${status}`, status }] });
      assert.ok(hasUnknown(result, "action.status"));
      assert.equal(result.metrics.actions.open, 0);
      assert.deepEqual(result.nextActions, []);
    });
  }

  for (const status of ["resolved", "cancelled", "other"]) {
    it(`fails closed for risk status ${status}`, () => {
      const result = analyzeProjectSnapshot({ risk: [{ id: `risk-${status}`, status, severity: "低" }] });
      assert.ok(hasUnknown(result, "risk.status"));
      assert.equal(result.metrics.risks.active, 0);
      assert.deepEqual(result.risks, []);
    });
  }

  for (const status of ["draft", "confirmed", "other"]) {
    it(`fails closed for itinerary status ${status}`, () => {
      const result = analyzeProjectSnapshot({ itinerary: [{ id: `itinerary-${status}`, status }] });
      assert.ok(hasUnknown(result, "itinerary.status"));
      assert.deepEqual(result.metrics.itinerary, { count: 0, planned: 0 });
    });
  }

  for (const status of ["published", "other"]) {
    it(`fails closed for report status ${status}`, () => {
      const result = analyzeProjectSnapshot({ report: [{ id: `report-${status}`, status }] });
      assert.ok(hasUnknown(result, "report.status"));
      assert.deepEqual(result.metrics.report, { count: 0, draft: 0, saved: 0, ready: 0 });
    });
  }

  it("excludes planned and future evidence from freshness instead of treating it as current", () => {
    const plannedFuture = analyzeProjectSnapshot({
      asOf: "2026-08-14",
      customer: { id: "customer-1", updatedAt: "2025-01-01" },
      itinerary: [{ id: "itinerary-future", status: "planned", visitDate: "2026-12-01" }],
      report: [{ id: "report-future", status: "ready", periodEnd: "2026-12-01" }],
    });
    assert.equal(plannedFuture.metrics.evidenceFreshness.status, "stale");
    assert.equal(plannedFuture.metrics.evidenceFreshness.latestAt, "2025-01-01");

    const futureOccurrence = analyzeProjectSnapshot({
      asOf: "2026-08-14",
      customer: { id: "customer-1", updatedAt: "2025-01-01" },
      quickRecord: [{ id: "future-visit", occurredAt: "2026-12-01" }],
    });
    assert.equal(futureOccurrence.metrics.evidenceFreshness.status, "stale");
    assert.equal(futureOccurrence.metrics.evidenceFreshness.latestAt, "2025-01-01");
    assert.equal(futureOccurrence.metrics.evidenceFreshness.futureSourceCount, 1);
    assert.ok(hasUnknown(futureOccurrence, "evidenceFreshness.futureEvidence"));
  });

  it("rejects opportunity amounts beyond the real schema bound instead of truncating them", () => {
    const result = analyzeProjectSnapshot({
      opportunity: { id: "opportunity-1", amount: "x".repeat(101), probability: 65 },
    });

    assert.equal(fact(result, "opportunity.amount"), undefined);
    assert.equal(result.metrics.opportunity.amount, null);
    assert.ok(hasUnknown(result, "opportunity.amount"));
  });
});
