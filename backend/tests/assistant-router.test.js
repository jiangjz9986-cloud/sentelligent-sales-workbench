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

  it("routes request-settlement and multi-refund/top-up phrases to a read-only preview", () => {
    const explicit = router.route({ text: "/advance-settlement.preview 2026-08-17" });
    assert.equal(explicit.status, "planned");
    assert.equal(explicit.toolName, "advance-settlement.preview");
    assert.deepEqual(explicit.arguments, { week: "2026-08-17" });

    const natural = router.route({ text: "多退少补" });
    assert.equal(natural.status, "planned");
    assert.equal(natural.toolName, "advance-settlement.preview");
    assert.deepEqual(natural.arguments, { week: "current" });
  });

  it("does not confuse reimbursement, bookkeeping, proof, or confirmation commands with settlement preview", () => {
    const cases = [
      "报销周汇总",
      "整理报销",
      "快捷记账",
      "付款凭证",
      "确认",
      "修改金额为 2 元",
      "取消",
    ];
    for (const text of cases) {
      assert.notEqual(router.route({ text }).toolName, "advance-settlement.preview", text);
    }
    assert.equal(router.route({ text: "报销周汇总" }).toolName, "reimbursement-report.preview");
    assert.equal(router.route({ text: "快捷记账" }).status, "clarify");
    assert.equal(router.route({ text: "确认" }).status, "clarify");
    assert.equal(router.route({ text: "取消" }).status, "cancelled");
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

  it("parses customer create commands into a confirmation-required plan", () => {
    const plan = router.route({ text: "新建客户 莒县人民医院，区域日照，类型医院，级别B，联系人王科长，标签 信创" });
    assert.equal(plan.status, "confirmation_required");
    assert.equal(plan.toolName, "customer.create");
    assert.equal(plan.risk, "R2");
    assert.equal(plan.confirmation, "explicit_code");
    assert.deepEqual(plan.arguments, {
      name: "莒县人民医院",
      region: "日照",
      type: "医院",
      level: "B",
      contact: "王科长",
      tags: ["信创"],
    });

    const withColon = router.route({ text: "建档：测试医院，区域青岛" });
    assert.equal(withColon.toolName, "customer.create");
    assert.deepEqual(withColon.arguments, { name: "测试医院", region: "青岛" });

    const slash = router.route({ text: "/customer.create 测试医院，区域青岛" });
    assert.equal(slash.toolName, "customer.create");
    assert.deepEqual(slash.arguments, { name: "测试医院", region: "青岛" });
  });

  it("parses keyed, sentence, and array-verb customer update phrasings", () => {
    const keyed = router.route({ text: "修改客户 莒县人民医院，级别A，区域日照" });
    assert.equal(keyed.status, "confirmation_required");
    assert.equal(keyed.toolName, "customer.update");
    assert.deepEqual(keyed.arguments, {
      query: "莒县人民医院",
      changes: { level: "A", region: "日照" },
    });

    const sentence = router.route({ text: "把莒县人民医院的级别改成A，再加个别名 莒县医院" });
    assert.equal(sentence.toolName, "customer.update");
    assert.deepEqual(sentence.arguments, {
      query: "莒县人民医院",
      changes: { level: "A", aliases: { add: ["莒县医院"], remove: [] } },
    });

    const arrayVerb = router.route({ text: "给莒县人民医院加别名 莒县医院、莒县县医院" });
    assert.equal(arrayVerb.toolName, "customer.update");
    assert.deepEqual(arrayVerb.arguments, {
      query: "莒县人民医院",
      changes: { aliases: { add: ["莒县医院", "莒县县医院"], remove: [] } },
    });

    const removal = router.route({ text: "给莒县人民医院移除标签 信创" });
    assert.deepEqual(removal.arguments.changes, { tags: { add: [], remove: ["信创"] } });

    const renamed = router.route({ text: "改档：莒县人民医院，名称 莒县第一人民医院" });
    assert.deepEqual(renamed.arguments.changes, { name: "莒县第一人民医院" });
  });

  it("clarifies unsupported customer fields and missing targets instead of planning", () => {
    const unknownField = router.route({ text: "修改客户 莒县人民医院，决策链 张三" });
    assert.equal(unknownField.status, "clarify");
    assert.match(unknownField.question, /暂不支持修改/);
    assert.match(unknownField.question, /区域\/类型\/级别/);

    const missingChanges = router.route({ text: "修改客户 莒县人民医院" });
    assert.equal(missingChanges.status, "clarify");

    const pronounWithoutContext = router.route({ text: "把它的级别改成A" });
    assert.equal(pronounWithoutContext.status, "clarify");
    assert.match(pronounWithoutContext.question, /客户名称/);
  });

  it("resolves customer-write pronouns from the server-owned context", () => {
    const plan = router.route({
      text: "把它的级别改成A",
      context: { customerId: "customer-ctx-1" },
    });
    assert.equal(plan.toolName, "customer.update");
    assert.deepEqual(plan.arguments, {
      customerId: "customer-ctx-1",
      changes: { level: "A" },
    });

    const deletion = router.route({
      text: "删除客户 它",
      context: { customerId: "customer-ctx-1" },
    });
    assert.equal(deletion.toolName, "customer.delete");
    assert.deepEqual(deletion.arguments, { customerId: "customer-ctx-1" });
  });

  it("parses customer delete commands as an R3 code-confirmed plan", () => {
    const plan = router.route({ text: "删除客户 测试医院" });
    assert.equal(plan.status, "confirmation_required");
    assert.equal(plan.toolName, "customer.delete");
    assert.equal(plan.risk, "R3");
    assert.deepEqual(plan.arguments, { query: "测试医院" });

    const short = router.route({ text: "删档 测试医院" });
    assert.equal(short.toolName, "customer.delete");
  });

  it("routes bare 查询 and profile question phrasings to customer reads", () => {
    const bareSearch = router.route({ text: "查询 人民医院" });
    assert.equal(bareSearch.status, "planned");
    assert.equal(bareSearch.toolName, "customer.search");
    assert.deepEqual(bareSearch.arguments, { query: "人民医院" });

    for (const text of ["日照中医医院什么情况", "日照中医医院的情况如何", "日照中医医院近况", "日照中医医院画像", "日照中医医院的资料", "日照中医医院档案？"]) {
      const plan = router.route({ text });
      assert.equal(plan.status, "planned", text);
      assert.equal(plan.toolName, "customer.detail", text);
      assert.deepEqual(plan.arguments, { customerId: "日照中医医院" }, text);
    }
  });

  it("keeps profile questions away from earlier intents and the visit fallback", () => {
    assert.equal(router.route({ text: "报销什么情况" }).toolName, null);
    assert.equal(router.route({ text: "这个项目什么情况" }).toolName, null);
    assert.equal(router.route({ text: "XX商机什么情况" }).toolName, null);
    assert.equal(router.route({ text: "报销周汇总什么情况" }).toolName, "reimbursement-report.preview");
    const visit = router.route({ text: "今天拜访日照中医医院，客户希望补齐材料。" });
    assert.equal(visit.toolName, "visit-capture.collect");
    const bookkeeping = router.route({ text: "支出 18.50 元 打车" });
    assert.equal(bookkeeping.toolName, "bookkeeping.ingest");
  });
});
