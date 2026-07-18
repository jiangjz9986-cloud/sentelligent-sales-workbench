import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildQuickRecordAnalysis,
  confirmQuickRecordTarget,
  createExclusiveAsyncGate,
  getQuickRecordFlow,
  getSyncTargets,
  mergeEntityByVersion,
} from "./quickRecordModel.js";
import * as quickRecordModelModule from "./quickRecordModel.js";
import { createConfirmationAttemptTracker } from "./api/salesWorkbenchApi.js";

describe("quick record model", () => {
  it("blocks analysis when the record input is empty", () => {
    assert.equal(buildQuickRecordAnalysis("   "), null);
  });

  it("creates a structured mock analysis for the Rizhao hospital record", () => {
    const analysis = buildQuickRecordAnalysis(
      "周三现场拜访日照中医医院，客户反馈移动云资源计费、平台封闭、数据导出和后台管理权存在问题，需要输出十五五规划材料。",
    );

    assert.equal(analysis.customer.value, "日照中医医院");
    assert.equal(analysis.opportunity.value, "日照中医医院十五五规划");
    assert.equal(analysis.weekly.value, "周三 / 06-03");
    assert.equal(analysis.summary.risk.title, "风险点");
    assert.match(analysis.summary.action.text, /周三周报/);
  });

  it("falls back to a generic customer-intake mock when no known account is found", () => {
    const analysis = buildQuickRecordAnalysis("客户电话沟通，预算还没有确认，下周继续补充方案。");

    assert.equal(analysis.customer.value, "待匹配客户");
    assert.equal(analysis.opportunity.value, "待确认商机");
    assert.equal(analysis.weekly.value, "本周待归档");
    assert.match(analysis.summary.request.text, /预算|方案/);
  });

  it("marks the flow as completed only after all manual confirmations", () => {
    assert.deepEqual(getQuickRecordFlow({ hasInput: true, hasAnalysis: false, confirmedTargets: [] }), [
      "done",
      "active",
      "idle",
      "idle",
    ]);

    assert.deepEqual(
      getQuickRecordFlow({
        hasInput: true,
        hasAnalysis: true,
        confirmedTargets: ["customer", "opportunity", "weekly"],
      }),
      ["done", "done", "done", "done"],
    );
  });

  it("exposes the three manual sync targets required by the workflow", () => {
    assert.deepEqual(
      getSyncTargets().map((item) => item.id),
      ["customer", "opportunity", "weekly"],
    );
  });

  it("keeps confirmed selections null when no real customer or opportunity id is returned", () => {
    assert.equal(typeof quickRecordModelModule.resolveConfirmedSelectionId, "function");
    const resolveConfirmedSelectionId = quickRecordModelModule.resolveConfirmedSelectionId;

    assert.equal(resolveConfirmedSelectionId("customer", {
      result: { customer: { id: "customer-from-result" } },
      analysis: { customer: { id: "customer-from-analysis" } },
      quickRecord: { customerId: "customer-from-record" },
    }), "customer-from-result");
    assert.equal(resolveConfirmedSelectionId("opportunity", {
      result: { quickRecord: { opportunityId: "opportunity-from-result-record" } },
      analysis: { opportunity: { id: "opportunity-from-analysis" } },
      quickRecord: { opportunityId: "opportunity-from-record" },
    }), "opportunity-from-result-record");
    assert.equal(resolveConfirmedSelectionId("customer", {
      result: {},
      analysis: { customer: { id: "customer-from-analysis" } },
      quickRecord: { customerId: "customer-from-record" },
    }), "customer-from-analysis");
    assert.equal(resolveConfirmedSelectionId("opportunity", {
      result: {},
      analysis: {},
      quickRecord: { opportunityId: "opportunity-from-record" },
    }), "opportunity-from-record");
    assert.equal(resolveConfirmedSelectionId("customer", { result: {}, analysis: {}, quickRecord: {} }), null);
    assert.equal(resolveConfirmedSelectionId("opportunity", { result: {}, analysis: {}, quickRecord: {} }), null);
  });

  it("refreshes versions after conflict and reuses the same confirmation key on manual retry", async () => {
    const confirmations = [];
    let refreshCalls = 0;
    const conflictError = Object.assign(new Error("stale versions"), {
      status: 409,
      code: "VERSION_CONFLICT",
      currentVersion: 6,
    });
    const refreshed = {
      quickRecord: { id: "qr-1", version: 6 },
      customers: [{ id: "customer-1", version: 8 }],
      opportunities: [{ id: "opportunity-1", version: 10 }],
    };
    const apiClient = {
      async confirmQuickRecord(quickRecordId, targets, options) {
        confirmations.push({ quickRecordId, targets, options });
        if (confirmations.length === 1) throw conflictError;
        return {
          quickRecord: { id: quickRecordId, version: 7 },
          confirmations: [{ id: "confirmation-1", target: targets[0] }],
        };
      },
      async refreshQuickRecordConfirmationState(quickRecordId) {
        refreshCalls += 1;
        assert.equal(quickRecordId, "qr-1");
        return refreshed;
      },
    };
    const attemptTracker = createConfirmationAttemptTracker({
      createId: () => "stable-conflict-attempt",
    });
    const analysis = {
      id: "analysis-1",
      customer: { id: "customer-1" },
      opportunity: { id: "opportunity-1" },
    };
    const target = { id: "opportunity", label: "Sync opportunity", status: "confirmed" };
    const originalAnalysis = structuredClone(analysis);
    const originalTarget = { ...target };

    const conflict = await confirmQuickRecordTarget({
      apiClient,
      attemptTracker,
      quickRecord: { id: "qr-1", version: 4 },
      analysis,
      target,
      customers: [{ id: "customer-1", version: 7 }],
      opportunities: [{ id: "opportunity-1", version: 9 }],
      confirmedBy: "Task 9 tester",
    });

    assert.equal(conflict.status, "conflict");
    assert.strictEqual(conflict.error, conflictError);
    assert.strictEqual(conflict.refreshed, refreshed);
    assert.equal(refreshCalls, 1);
    assert.deepEqual(analysis, originalAnalysis);
    assert.deepEqual(target, originalTarget);

    const retried = await confirmQuickRecordTarget({
      apiClient,
      attemptTracker,
      quickRecord: conflict.refreshed.quickRecord,
      analysis,
      target,
      customers: conflict.refreshed.customers,
      opportunities: conflict.refreshed.opportunities,
      confirmedBy: "Task 9 tester",
    });

    assert.equal(retried.status, "confirmed");
    assert.equal(refreshCalls, 1);
    assert.equal(confirmations.length, 2);
    assert.deepEqual(confirmations.map((call) => call.targets), [["opportunity"], ["opportunity"]]);
    assert.deepEqual(confirmations.map((call) => call.options.idempotencyKey), [
      "stable-conflict-attempt",
      "stable-conflict-attempt",
    ]);
    assert.deepEqual(confirmations.map((call) => call.options.quickRecordVersion), [4, 6]);
    assert.deepEqual(confirmations.map((call) => call.options.targetVersions), [
      { opportunity: 9 },
      { opportunity: 10 },
    ]);
    assert.deepEqual(confirmations.map((call) => call.options.analysisVersionId), [
      "analysis-1",
      "analysis-1",
    ]);
  });

  it("propagates non-conflict confirmation errors without refreshing", async () => {
    const expected = Object.assign(new Error("offline"), { code: "NETWORK_ERROR" });
    let refreshCalls = 0;
    const apiClient = {
      async confirmQuickRecord() {
        throw expected;
      },
      async refreshQuickRecordConfirmationState() {
        refreshCalls += 1;
        return null;
      },
    };

    await assert.rejects(
      () => confirmQuickRecordTarget({
        apiClient,
        attemptTracker: createConfirmationAttemptTracker({ createId: () => "failed-attempt" }),
        quickRecord: { id: "qr-1", version: 4 },
        analysis: { id: "analysis-1" },
        target: { id: "weekly", label: "Weekly", status: "confirmed" },
        customers: [],
        opportunities: [],
      }),
      (error) => error === expected,
    );
    assert.equal(refreshCalls, 0);
  });

  it("serializes same-tick confirmation work and releases the gate after failures", async () => {
    const gate = createExclusiveAsyncGate();
    let releaseFirst;
    let firstStarted;
    const started = new Promise((resolve) => { firstStarted = resolve; });
    const blocker = new Promise((resolve) => { releaseFirst = resolve; });
    const calls = [];

    const first = gate.run(async () => {
      calls.push("first");
      firstStarted();
      await blocker;
      return { status: "confirmed" };
    });
    await started;
    const busy = await gate.run(async () => {
      calls.push("second");
      return { status: "confirmed" };
    });

    assert.deepEqual(busy, { status: "busy" });
    assert.deepEqual(calls, ["first"]);
    releaseFirst();
    assert.deepEqual(await first, { status: "confirmed" });

    const expected = new Error("refresh failed");
    await assert.rejects(
      () => gate.run(async () => { throw expected; }),
      (error) => error === expected,
    );
    assert.equal(await gate.run(async () => "released"), "released");
  });

  it("keeps newer entity versions when refreshed data arrives out of order", () => {
    const current = [
      { id: "customer-1", version: 7, name: "newest" },
      { id: "customer-2", version: 2, name: "other" },
    ];

    assert.deepEqual(
      mergeEntityByVersion(current, { id: "customer-1", version: 6, name: "stale" }),
      current,
    );
    assert.deepEqual(
      mergeEntityByVersion(current, { id: "customer-1", version: 7, name: "equal refresh" }),
      [
        { id: "customer-1", version: 7, name: "equal refresh" },
        current[1],
      ],
    );
    assert.deepEqual(
      mergeEntityByVersion(current, { id: "customer-1", version: 8, name: "newer" }),
      [
        { id: "customer-1", version: 8, name: "newer" },
        current[1],
      ],
    );
    assert.deepEqual(
      mergeEntityByVersion(current, { id: "customer-3", version: 1, name: "created" }),
      [
        { id: "customer-3", version: 1, name: "created" },
        ...current,
      ],
    );
  });
});
