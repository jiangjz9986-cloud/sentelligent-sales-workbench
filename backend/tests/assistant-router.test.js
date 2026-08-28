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
    // v0.7.6 tech-debt repayment: 商机/项目 subjects now forward to the
    // opportunity detail tool instead of falling to unknown.
    const opportunityQuestion = router.route({ text: "XX商机什么情况" });
    assert.equal(opportunityQuestion.toolName, "opportunity.detail");
    assert.deepEqual(opportunityQuestion.arguments, { opportunityId: "XX" });
    const pronounProject = router.route({ text: "这个项目什么情况" });
    assert.equal(pronounProject.status, "clarify");
    assert.equal(pronounProject.toolName, null);
    const pinnedProject = router.route({ text: "这个项目什么情况", context: { opportunityId: "opportunity-9" } });
    assert.equal(pinnedProject.toolName, "opportunity.detail");
    assert.deepEqual(pinnedProject.arguments, { opportunityId: "opportunity-9" });
    assert.equal(router.route({ text: "报销周汇总什么情况" }).toolName, "reimbursement-report.preview");
    const visit = router.route({ text: "今天拜访日照中医医院，客户希望补齐材料。" });
    assert.equal(visit.toolName, "visit-capture.collect");
    const bookkeeping = router.route({ text: "支出 18.50 元 打车" });
    assert.equal(bookkeeping.toolName, "bookkeeping.ingest");
  });
});

describe("opportunity intents (v0.7.6)", () => {
  const router = createAssistantRouter({ clock: () => new Date("2026-08-28T02:00:00.000Z") });

  it("routes stage moves to the affirm-confirmed update-stage tool with normalized targets", () => {
    const advance = router.route({ text: "把日照的商机推进到投标" });
    assert.equal(advance.status, "confirmation_required");
    assert.equal(advance.toolName, "opportunity.update-stage");
    assert.equal(advance.risk, "R1");
    assert.equal(advance.confirmation, "affirm_language");
    assert.deepEqual(advance.arguments, { query: "日照", stage: "投标" });

    const set = router.route({ text: "黄岛商机阶段改成方案输出" });
    assert.equal(set.toolName, "opportunity.update-stage");
    assert.deepEqual(set.arguments, { query: "黄岛", stage: "方案输出" });

    const back = router.route({ text: "把黄岛的商机回退到调研机会" });
    assert.equal(back.toolName, "opportunity.update-stage");
    assert.deepEqual(back.arguments, { query: "黄岛", stage: "调研机会" });

    const suffix = router.route({ text: "把 f3a9c1 推进到预算确认" });
    assert.deepEqual(suffix.arguments, { query: "f3a9c1", stage: "预算确认" });

    const narrative = router.route({ text: "黄岛商机推进到投标了" });
    assert.equal(narrative.toolName, "opportunity.update-stage");
    assert.deepEqual(narrative.arguments, { query: "黄岛", stage: "投标" }, "the mood particle is stripped");

    const contextual = router.route({ text: "推进到方案交流", context: { opportunityId: "opportunity-7" } });
    assert.deepEqual(contextual.arguments, { opportunityId: "opportunity-7", stage: "方案交流" });
    const noContext = router.route({ text: "推进到方案交流" });
    assert.equal(noContext.status, "clarify");
    const relative = router.route({ text: "把日照的商机推进到下一阶段" });
    assert.equal(relative.status, "clarify");
    assert.match(relative.question, /线索 → 初步沟通/u);
  });

  it("routes next-step edits to the affirm-confirmed update-next tool", () => {
    const verb = router.route({ text: "把日照商机的下一步改成 下周带售前调研" });
    assert.equal(verb.status, "confirmation_required");
    assert.equal(verb.toolName, "opportunity.update-next");
    assert.equal(verb.confirmation, "affirm_language");
    assert.deepEqual(verb.arguments, { query: "日照", next: "下周带售前调研" });

    const colon = router.route({ text: "日照商机的下一步：补齐规划材料" });
    assert.equal(colon.toolName, "opportunity.update-next");
    assert.deepEqual(colon.arguments, { query: "日照", next: "补齐规划材料" });
  });

  it("routes amount/name/risk edits, creation, and deletion on the code-confirmed ladder", () => {
    const amount = router.route({ text: "把日照商机的金额改成 3000 万" });
    assert.equal(amount.toolName, "opportunity.update");
    assert.equal(amount.risk, "R2");
    assert.equal(amount.confirmation, "explicit_code");
    assert.deepEqual(amount.arguments, { query: "日照", changes: { amount: "3000 万" } });

    const rename = router.route({ text: "把日照商机的名称改成 十五五算力规划" });
    assert.deepEqual(rename.arguments, { query: "日照", changes: { name: "十五五算力规划" } });
    const risk = router.route({ text: "把日照商机的风险改成 移动云竞争加剧" });
    assert.deepEqual(risk.arguments, { query: "日照", changes: { risk: "移动云竞争加剧" } });

    const create = router.route({ text: "新建商机 黄岛人民医院AI算力项目，客户 黄岛人民医院，阶段 线索，金额 500 万" });
    assert.equal(create.toolName, "opportunity.create");
    assert.equal(create.risk, "R2");
    assert.deepEqual(create.arguments, {
      name: "黄岛人民医院AI算力项目",
      customerQuery: "黄岛人民医院",
      stage: "线索",
      amount: "500 万",
    });
    const createWithoutCustomer = router.route({ text: "新建商机 无主商机" });
    assert.equal(createWithoutCustomer.status, "clarify");
    assert.match(createWithoutCustomer.question, /请注明客户/u);

    const remove = router.route({ text: "删除商机 a1b2c3" });
    assert.equal(remove.toolName, "opportunity.delete");
    assert.equal(remove.risk, "R3");
    assert.deepEqual(remove.arguments, { query: "a1b2c3" });
    const removeByName = router.route({ text: "删掉商机 日照中医医院十五五规划" });
    assert.deepEqual(removeByName.arguments, { query: "日照中医医院十五五规划" });
  });

  it("routes progress questions and list phrasings to the confirmation-free reads", () => {
    for (const text of ["日照医院的商机什么进展", "日照医院的商机情况", "日照医院商机状态"]) {
      const plan = router.route({ text });
      assert.equal(plan.status, "planned", text);
      assert.equal(plan.toolName, "opportunity.detail", text);
      assert.deepEqual(plan.arguments, { opportunityId: "日照医院" }, text);
    }
    const scoped = router.route({ text: "日照医院有哪些商机" });
    assert.equal(scoped.toolName, "opportunity.list");
    assert.deepEqual(scoped.arguments, { query: "日照医院" });
    const bareSubject = router.route({ text: "日照的商机" });
    assert.equal(bareSubject.toolName, "opportunity.list");
    assert.deepEqual(bareSubject.arguments, { query: "日照" });
    const listAll = router.route({ text: "商机列表" });
    assert.equal(listAll.toolName, "opportunity.list");
    assert.deepEqual(listAll.arguments, {});
    const queried = router.route({ text: "查询日照的商机" });
    assert.equal(queried.toolName, "opportunity.list", "查询X的商机 must not fall into the bare customer search");
    assert.deepEqual(queried.arguments, { query: "日照" });
    const bare = router.route({ text: "商机" });
    assert.equal(bare.status, "clarify");
    assert.match(bare.question, /日照医院有哪些商机/u);
  });

  it("stays disjoint from the bookkeeping, customer, quick-record, and todo intents", () => {
    // Bookkeeping group.
    assert.equal(router.route({ text: "支出 500 元 打车" }).toolName, "bookkeeping.ingest");
    const amount = router.route({ text: "把商机金额改成 5000 万", context: { opportunityId: "opportunity-7" } });
    assert.equal(amount.toolName, "opportunity.update", "amount edits never fall into bookkeeping");
    assert.deepEqual(amount.arguments, { opportunityId: "opportunity-7", changes: { amount: "5000 万" } });

    // Customer group.
    assert.equal(router.route({ text: "把示例医院的名称改成新医院" }).toolName, "customer.update");
    assert.equal(router.route({ text: "把示例医院商机的名称改成新名字" }).toolName, "opportunity.update");
    assert.equal(router.route({ text: "示例医院什么情况" }).toolName, "customer.detail");
    assert.equal(router.route({ text: "示例医院的商机什么情况" }).toolName, "opportunity.detail");
    assert.equal(router.route({ text: "上周报销什么情况" }).toolName, null, "excluded subjects still fall through");

    // Quick-record group.
    assert.equal(router.route({ text: "记一下:黄岛商机推进到投标了" }).toolName, "visit-capture.capture");
    assert.equal(router.route({ text: "日照的商机记录" }).toolName, "visit-capture.search");
    assert.equal(router.route({ text: "把记录 abc123 的商机改成黄岛项目" }).toolName, "visit-capture.update");
    const narrative = router.route({ text: "今天上午拜访了黄岛区中医院聊了聊商机" });
    assert.equal(narrative.toolName, "visit-capture.collect", "visit narratives ending in 商机 keep the collector");

    // Todo group (v0.7.5 prefixes win).
    assert.equal(router.route({ text: "提醒我跟进黄岛商机" }).toolName, "action-risk.create");
    assert.equal(router.route({ text: "待办：黄岛商机方案评审" }).toolName, "action-risk.create");

    // Wide 推进到 boundary: non-opportunity subjects still parse but the
    // provider blocks them with a self-clarifying not-found card
    // (behavior change from the visit fallback, noted in release notes).
    const meeting = router.route({ text: "会议推进到下周" });
    assert.equal(meeting.toolName, "opportunity.update-stage");
    assert.deepEqual(meeting.arguments, { query: "会议", stage: "下周" });
    const itinerary = router.route({ text: "把行程推进到下周" });
    assert.equal(itinerary.toolName, "opportunity.update-stage");
  });
});

describe("quick-record intents (v0.7.3)", () => {
  // 2026-08-28 is a Friday in Asia/Shanghai.
  const router = createAssistantRouter({ clock: () => new Date("2026-08-28T02:00:00.000Z") });

  it("captures a one-step record with the spoken date pinned as occurredAt", () => {
    const plan = router.route({ text: "记一下：今天拜访了日照中医医院，张主任说预算大概300万" });
    assert.equal(plan.status, "confirmation_required");
    assert.equal(plan.toolName, "visit-capture.capture");
    assert.equal(plan.risk, "R1");
    assert.equal(plan.confirmation, "affirm_language");
    assert.deepEqual(plan.arguments, {
      rawContent: "今天拜访了日照中医医院，张主任说预算大概300万",
      occurredAt: "2026-08-28T04:00:00.000Z",
    });
  });

  it("accepts every capture prefix and leaves occurredAt out when no date word exists", () => {
    for (const text of ["记录一下和王主任的电话沟通", "帮我记一下 现场会议纪要", "帮我记录 现场会议纪要", "快速记录：客户现场走访", "记拜访：走访了莒县人民医院"]) {
      const plan = router.route({ text });
      assert.equal(plan.toolName, "visit-capture.capture", text);
      assert.equal(plan.arguments.occurredAt, undefined, text);
    }
    const slash = router.route({ text: "/记一下 昨天拜访了日照中医医院" });
    assert.equal(slash.toolName, "visit-capture.capture");
    assert.equal(slash.arguments.occurredAt, "2026-08-27T04:00:00.000Z");
  });

  it("clarifies bookkeeping-like capture bodies and honors the 记拜访 escape prefix", () => {
    const bookkeepingLike = router.route({ text: "记一下：打车50元" });
    assert.equal(bookkeepingLike.status, "clarify");
    assert.match(bookkeepingLike.question, /更像记账内容/);
    assert.match(bookkeepingLike.question, /记拜访/);

    const visitException = router.route({ text: "记一下：今天拜访了日照中医医院，谈了预算 300 元的耗材" });
    assert.equal(visitException.toolName, "visit-capture.capture");

    const escape = router.route({ text: "记拜访：打车50元去了客户那边" });
    assert.equal(escape.toolName, "visit-capture.capture");
    assert.equal(escape.arguments.rawContent, "打车50元去了客户那边");
  });

  it("clarifies an empty capture body with the friendly hint", () => {
    for (const text of ["记一下：", "记一下", "快速记录"]) {
      const plan = router.route({ text });
      assert.equal(plan.status, "clarify", text);
      assert.match(plan.question, /跟在“记一下：”后面/, text);
    }
  });

  it("does not swallow bare weekly-report or legacy record phrases", () => {
    assert.equal(router.route({ text: "销售周报" }).toolName, "sales-report.preview");
    // With an explicit capture prefix the strongest user intent wins.
    assert.equal(router.route({ text: "记一下：本周销售周报要点已同步" }).toolName, "visit-capture.capture");
    assert.equal(router.route({ text: "记账 支出50元" }).toolName, "bookkeeping.ingest");
    assert.equal(router.route({ text: "记录" }).toolName, "visit-capture.preview");
    assert.equal(router.route({ text: "录入" }).toolName, "visit-capture.confirm");
    assert.equal(router.route({ text: "会议记录" }).toolName, "visit-capture.collect");
    assert.equal(router.route({ text: "拜访记录" }).toolName, "visit-capture.collect");
  });

  it("routes history searches with period and subject arguments", () => {
    const withBoth = router.route({ text: "查一下上周去日照的记录" });
    assert.equal(withBoth.status, "planned");
    assert.equal(withBoth.toolName, "visit-capture.search");
    assert.deepEqual(withBoth.arguments, { query: "日照", dateStart: "2026-08-17", dateEnd: "2026-08-23" });

    const recent = router.route({ text: "最近的拜访记录" });
    assert.equal(recent.toolName, "visit-capture.search");
    assert.deepEqual(recent.arguments, { dateStart: "2026-08-15", dateEnd: "2026-08-28" });

    const subjectOnly = router.route({ text: "日照中医医院的记录" });
    assert.equal(subjectOnly.toolName, "visit-capture.search");
    assert.deepEqual(subjectOnly.arguments, { query: "日照中医医院", dateStart: "2026-08-15", dateEnd: "2026-08-28" });

    const monthRange = router.route({ text: "查询上个月的快速记录" });
    assert.equal(monthRange.toolName, "visit-capture.search");
    assert.deepEqual(monthRange.arguments, { dateStart: "2026-07-01", dateEnd: "2026-07-31" });

    // Bare 查询 without the 记录 stem keeps the v0.7.2 customer search.
    assert.equal(router.route({ text: "查询 人民医院" }).toolName, "customer.search");
  });

  it("maps every update field label onto the normalized field name", () => {
    const cases = [
      ["把那条记录的发生时间改成昨天", null, "occurredAt", "昨天"],
      ["把记录 abc123 的时间改成昨天", "abc123", "occurredAt", "昨天"],
      ["把最近一条记录的日期设为8月20日", null, "occurredAt", "8月20日"],
      ["把那条记录的客户改成日照中医医院", null, "customerQuery", "日照中医医院"],
      ["把记录 abc123 的商机改成十五五规划", "abc123", "opportunityQuery", "十五五规划"],
      ["把这条记录的诉求改为补齐本地数据中心", null, "summary.request", "补齐本地数据中心"],
      ["把那条记录的反馈更新为张主任已确认", null, "summary.feedback", "张主任已确认"],
      ["把那条记录的风险改成预算路径未确认", null, "summary.risk", "预算路径未确认"],
      ["把那条记录的建议改成输出对比材料", null, "summary.action", "输出对比材料"],
      ["把那条记录的下一步改成周三前发对比材料给张主任", null, "summary.action", "周三前发对比材料给张主任"],
      ["把上一条记录的待办换成催合同", null, "summary.action", "催合同"],
    ];
    for (const [text, quickRecordId, field, value] of cases) {
      const plan = router.route({ text });
      assert.equal(plan.status, "confirmation_required", text);
      assert.equal(plan.toolName, "visit-capture.update", text);
      assert.equal(plan.confirmation, "explicit_code", text);
      assert.deepEqual(plan.arguments, {
        ...(quickRecordId ? { quickRecordId } : {}),
        field,
        value,
      }, text);
    }
  });

  it("routes void phrasings as an R3 code-confirmed plan", () => {
    const bare = router.route({ text: "作废那条记录" });
    assert.equal(bare.status, "confirmation_required");
    assert.equal(bare.toolName, "visit-capture.void");
    assert.equal(bare.risk, "R3");
    assert.deepEqual(bare.arguments, {});

    const withId = router.route({ text: "删除记录 9d2c4a" });
    assert.equal(withId.toolName, "visit-capture.void");
    assert.deepEqual(withId.arguments, { quickRecordId: "9d2c4a" });

    assert.equal(router.route({ text: "撤销这条记录" }).toolName, "visit-capture.void");
  });

  it("stays disjoint from the v0.7.2 customer-write regexes", () => {
    // Customer field vocabulary does not collide with record field vocabulary.
    assert.equal(router.route({ text: "把日照中医医院的名称改成日照市中医医院" }).toolName, "customer.update");
    assert.equal(router.route({ text: "把那条记录的时间改成昨天" }).toolName, "visit-capture.update");
    assert.equal(router.route({ text: "删除客户 测试医院" }).toolName, "customer.delete");
    assert.equal(router.route({ text: "删除记录 abc123" }).toolName, "visit-capture.void");
    assert.equal(router.route({ text: "修改客户 莒县人民医院，级别A" }).toolName, "customer.update");
    // A profile question about a customer whose name ends with 记录 is
    // impossible vocabulary; the customer read phrasings stay reachable.
    assert.equal(router.route({ text: "日照中医医院什么情况" }).toolName, "customer.detail");
  });
});

describe("todo intents (v0.7.5)", () => {
  // 2026-08-28 is a Friday 10:00 in Asia/Shanghai.
  const router = createAssistantRouter({ clock: () => new Date("2026-08-28T02:00:00.000Z") });

  it("parses schedule, priority, and customer hints out of a reminder prefix", () => {
    const plan = router.route({ text: "提醒我明天上午十点给王工送方案 紧急" });
    assert.equal(plan.status, "confirmation_required");
    assert.equal(plan.toolName, "action-risk.create");
    assert.equal(plan.risk, "R1");
    assert.equal(plan.confirmation, "affirm_language");
    assert.deepEqual(plan.arguments, {
      title: "给王工送方案",
      remindAt: "2026-08-29T02:00:00.000Z",
      due: "明天上午十点",
      priority: "高",
      customerQuery: "王工送方案",
    });
  });

  it("keeps deadline phrases and bare-colon prefixes as todos without a time", () => {
    const deadline = router.route({ text: "待办：周五前交周报" });
    assert.equal(deadline.toolName, "action-risk.create");
    assert.equal(deadline.arguments.due, "周五前");
    const noTime = router.route({ text: "记待办 整理拜访材料" });
    assert.equal(noTime.toolName, "action-risk.create");
    assert.equal(noTime.arguments.remindAt, undefined);
  });

  it("wins over the visit fallback and the bookkeeping regex for reminder bodies", () => {
    assert.equal(router.route({ text: "提醒我明天拜访日照医院" }).toolName, "action-risk.create");
    assert.equal(router.route({ text: "提醒我明天报销打车 50 元" }).toolName, "action-risk.create");
    assert.equal(router.route({ text: "记账支出 50 元" }).toolName, "bookkeeping.ingest");
    const lead = router.route({ text: "待办：记账 50 元打车" });
    assert.equal(lead.status, "clarify");
  });

  it("keeps the capture prefixes away from 帮我记待办 through the lookahead", () => {
    const plan = router.route({ text: "帮我记待办 明天交材料" });
    assert.notEqual(plan.toolName, "visit-capture.capture");
  });

  it("routes scoped todo queries to the list and bare ones to the summary", () => {
    const today = router.route({ text: "今天有什么待办" });
    assert.equal(today.toolName, "action-risk.list");
    assert.deepEqual(today.arguments, { dateStart: "2026-08-28", dateEnd: "2026-08-28", rangeLabel: "今天" });
    const week = router.route({ text: "本周待办" });
    assert.deepEqual(week.arguments, { dateStart: "2026-08-24", dateEnd: "2026-08-30", rangeLabel: "本周" });
    const mine = router.route({ text: "我的待办" });
    assert.deepEqual(mine.arguments, { rangeLabel: "全部" });
    assert.equal(router.route({ text: "待办" }).toolName, "action-risk.summary");
    assert.equal(router.route({ text: "有什么待办" }).toolName, "action-risk.summary");
  });

  it("requires the 待办 stem for status verbs and captures the target text", () => {
    const complete = router.route({ text: "完成待办 abc123" });
    assert.equal(complete.toolName, "action-risk.complete");
    assert.deepEqual(complete.arguments, { query: "abc123" });
    const defer = router.route({ text: "把待办 送方案 推迟到明天上午" });
    assert.equal(defer.toolName, "action-risk.defer");
    assert.deepEqual(defer.arguments, { query: "送方案", newTime: "明天上午" });
    const remove = router.route({ text: "删除待办 abc123" });
    assert.equal(remove.toolName, "action-risk.delete");
    assert.equal(remove.confirmation, "explicit_code");
    assert.notEqual(router.route({ text: "完成了拜访张主任" }).toolName, "action-risk.complete");
  });
});
