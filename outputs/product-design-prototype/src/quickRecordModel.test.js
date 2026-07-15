import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildQuickRecordAnalysis,
  getQuickRecordFlow,
  getSyncTargets,
} from "./quickRecordModel.js";

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
});
