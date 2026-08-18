import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAssistantRouter } from "../src/assistant/router.js";

describe("assistant deterministic router", () => {
  const router = createAssistantRouter();

  it("gives explicit commands priority and returns a controlled read-only plan", () => {
    const plan = router.route({ text: "/customer.search 医院", confidence: 0.1 });
    assert.equal(plan.status, "planned");
    assert.equal(plan.toolName, "customer.search");
    assert.deepEqual(plan.arguments, { query: "医院" });
    assert.equal(plan.risk, "R0");
  });

  it("asks for required arguments instead of creating an incomplete plan", () => {
    const plan = router.route({ text: "/customer.search" });
    assert.equal(plan.status, "clarify");
    assert.match(plan.question, /query|关键词/);
  });

  it("handles help, cancel, and confirmation without executing a tool", () => {
    assert.equal(router.route({ text: "/help" }).status, "help");
    assert.equal(router.route({ text: "/cancel" }).status, "cancelled");
    assert.equal(router.route({ text: "帮助" }).status, "help");
    assert.equal(router.route({ text: "取消" }).status, "cancelled");
    const pending = router.route({ text: "/visit-capture.confirm draft-1" });
    assert.equal(pending.status, "confirmation_required");
    const confirmed = router.route({ text: "确认", pendingPlan: pending });
    assert.equal(confirmed.status, "planned");
    assert.equal(confirmed.confirmed, true);
  });

  it("clarifies ambiguous weekly report requests", () => {
    const plan = router.route({ text: "帮我做周报" });
    assert.equal(plan.status, "clarify");
    assert.match(plan.question, /销售|报销/);
  });

  it("routes explicitly named weekly reports and defaults to the current natural week", () => {
    const sales = router.route({ text: "销售周报" });
    const reimbursement = router.route({ text: "报销周汇总" });
    assert.equal(sales.toolName, "sales-report.preview");
    assert.deepEqual(sales.arguments, { week: "current" });
    assert.equal(reimbursement.toolName, "reimbursement-report.preview");
    assert.deepEqual(reimbursement.arguments, { week: "current" });
  });

  it("keeps payment-proof and invoice inbox uploads compatible without confirmation", () => {
    assert.equal(router.route({ text: "/invoice.ingest invoice-ref-1" }).status, "planned");
    assert.equal(router.route({ text: "/payment-proof.ingest proof-ref-1" }).status, "planned");
    assert.equal(router.route({ text: "/发票", mediaRef: "media-ref-1" }).status, "planned");
    assert.equal(router.route({ text: "/付款凭证", mediaRef: "media-ref-2" }).status, "planned");
  });

  it("maps the existing Clawbot visit commands to persistent assistant tools", () => {
    const collected = router.route({ text: "今天拜访日照中医医院，客户希望补齐材料。" });
    assert.equal(collected.toolName, "visit-capture.collect");
    assert.deepEqual(collected.arguments, { text: "今天拜访日照中医医院，客户希望补齐材料。" });

    const preview = router.route({ text: "记录" });
    assert.equal(preview.toolName, "visit-capture.preview");
    assert.equal(preview.arguments.draftId, "current");

    const confirm = router.route({ text: "录入" });
    assert.equal(confirm.toolName, "visit-capture.confirm");
    assert.equal(confirm.status, "confirmation_required");
  });

  it("does not call tools for unknown or low-confidence natural language", () => {
    assert.equal(router.route({ text: "随便看看最近情况" }).status, "unknown");
    assert.equal(router.route({ text: "客户 医院", confidence: 0.2 }).status, "clarify");
    assert.equal(router.route({ text: "客户 医院", confidence: 0.9 }).toolName, "customer.search");
  });

  it("continues a customer or project conversation from the server-owned context", () => {
    const customer = router.route({
      text: "客户详情",
      context: { customerId: "customer-a" },
    });
    assert.equal(customer.status, "planned");
    assert.deepEqual(customer.arguments, { customerId: "customer-a" });

    const project = router.route({
      text: "项目分析",
      context: { opportunityId: "opportunity-a" },
    });
    assert.equal(project.status, "planned");
    assert.deepEqual(project.arguments, { opportunityId: "opportunity-a" });

    const followUp = router.route({
      text: "还有哪些跟进动作？",
      context: { opportunityId: "opportunity-a" },
    });
    assert.equal(followUp.status, "planned");
    assert.equal(followUp.toolName, "action-risk.summary");
    assert.deepEqual(followUp.arguments, { opportunityId: "opportunity-a" });
  });

  it("does not guess a project when context only identifies a customer", () => {
    const plan = router.route({
      text: "项目分析",
      context: { customerId: "customer-a" },
    });
    assert.equal(plan.status, "clarify");
    assert.match(plan.question, /商机|项目/);
  });
});
