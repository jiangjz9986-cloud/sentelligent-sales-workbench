import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createAssistantBusinessSnapshotAdapter } from "../src/assistant/businessSnapshotAdapter.js";
import { createAssistantSessionRepository } from "../src/assistant/sessionRepository.js";
import { createAssistantToolHandlers } from "../src/assistant/runtimeHandlers.js";
import { openDatabase } from "../src/db.js";

let db;
let tempDir;

function insertFixtures() {
  const insertCustomer = db.prepare("INSERT INTO customers (id, name, region, owner) VALUES ($id, $name, $region, $owner)");
  insertCustomer.run({ $id: "customer-a", $name: "A医院", $region: "山东", $owner: "owner-a" });
  insertCustomer.run({ $id: "customer-b", $name: "B医院", $region: "江苏", $owner: "owner-b" });

  const insertOpportunity = db.prepare(`
    INSERT INTO opportunities (id, customer_id, name, stage, amount, owner, probability)
    VALUES ($id, $customerId, $name, $stage, $amount, $owner, $probability)
  `);
  insertOpportunity.run({ $id: "opportunity-a", $customerId: "customer-a", $name: "A项目", $stage: "proposal", $amount: "120 万", $owner: "owner-a", $probability: 65 });
  insertOpportunity.run({ $id: "opportunity-b", $customerId: "customer-b", $name: "B项目", $stage: "lead", $amount: "50 万", $owner: "owner-b", $probability: 20 });

  db.prepare(`
    INSERT INTO quick_records (id, owner, raw_content, occurred_at, source_channel, customer_id, opportunity_id, status)
    VALUES ('record-a', 'owner-a', '不得出现在助手快照中的原始拜访正文', '2026-08-15T09:00:00+08:00', 'visit', 'customer-a', 'opportunity-a', 'analyzed')
  `).run();
  db.prepare(`
    INSERT INTO action_items (id, customer_id, opportunity_id, title, status, due)
    VALUES ('action-a', 'customer-a', 'opportunity-a', '补齐方案', 'pending', '2026-08-20')
  `).run();
  db.prepare(`
    INSERT INTO risk_items (id, customer_id, opportunity_id, title, target, severity, status, evidence, action)
    VALUES ('risk-a', 'customer-a', 'opportunity-a', '预算未确认', '商机', '高', 'open', '会议纪要', '确认预算')
  `).run();

  const insertItinerary = db.prepare(`
    INSERT INTO visit_itineraries (id, title, visit_date, status, request_json, plan_json, created_by, updated_by)
    VALUES ($id, $title, $visitDate, 'planned', '{}', '{}', $owner, $owner)
  `);
  insertItinerary.run({ $id: "itinerary-a", $title: "拜访 A 医院", $visitDate: "2026-08-18", $owner: "owner-a" });
  insertItinerary.run({ $id: "itinerary-b", $title: "拜访 B 医院", $visitDate: "2026-08-18", $owner: "owner-b" });

  const insertExpense = db.prepare(`
    INSERT INTO travel_expenses (
      id, reference_code, owner, occurred_on, category, purpose, customer_id, invoice_status, created_by, updated_by
    ) VALUES ($id, $referenceCode, $owner, '2026-08-17', 'transport', $purpose, $customerId, 'pending', $owner, $owner)
  `);
  insertExpense.run({ $id: "expense-a", $referenceCode: "EXP-20260817-A001", $owner: "owner-a", $purpose: "A 项目拜访", $customerId: "customer-a" });
  insertExpense.run({ $id: "expense-b", $referenceCode: "EXP-20260817-B001", $owner: "owner-b", $purpose: "B 项目拜访", $customerId: "customer-b" });
  const insertPayment = db.prepare(`
    INSERT INTO travel_expense_payments (
      id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents, funding_source, payment_method
    ) VALUES ($id, $expenseId, 1, '2026-08-17T10:00:00+08:00', $amount, $reimbursement, 'personal', 'wechat')
  `);
  insertPayment.run({ $id: "payment-a", $expenseId: "expense-a", $amount: 8800, $reimbursement: 7000 });
  insertPayment.run({ $id: "payment-b", $expenseId: "expense-b", $amount: 9900, $reimbursement: 9000 });

  db.prepare(`
    INSERT INTO weekly_reports (id, owner, period_start, period_end, status, content)
    VALUES ('report-a', 'owner-a', '2026-08-17', '2026-08-23', 'ready', 'A 周报')
  `).run();
  db.prepare(`
    INSERT INTO knowledge_items (id, title, category, summary, content, source)
    VALUES ('knowledge-a', '医院采购流程', '销售', '采购阶段摘要', '不应直接返回的完整知识正文', '内部知识库')
  `).run();
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "sentelligent-unified-assistant-"));
  db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
  insertFixtures();
});

afterEach(() => {
  db?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("assistant bounded business snapshot adapter", () => {
  it("scopes dashboard and entity reads to the authenticated owner", () => {
    const adapter = createAssistantBusinessSnapshotAdapter({ db, clock: () => new Date("2026-08-17T12:00:00Z") });
    const dashboard = adapter.dashboardSummary({ owner: "owner-a" });
    assert.deepEqual(dashboard.counts, {
      customers: 1,
      opportunities: 1,
      openActions: 1,
      activeRisks: 1,
      upcomingItineraries: 1,
      currentWeekExpenses: 1,
    });
    assert.equal(adapter.customerDetail({ owner: "owner-a", customerId: "customer-a" }).name, "A医院");
    assert.equal(adapter.customerDetail({ owner: "owner-a", customerId: "customer-b" }), null);
    assert.equal(adapter.opportunityDetail({ owner: "owner-a", opportunityId: "opportunity-a" }).name, "A项目");
    assert.equal(adapter.opportunityDetail({ owner: "owner-a", opportunityId: "opportunity-b" }), null);
  });

  it("supports an explicit authenticated-account to business-owner mapping", () => {
    const adapter = createAssistantBusinessSnapshotAdapter({
      db,
      clock: () => new Date("2026-08-17T12:00:00Z"),
      resolveBusinessOwner: (account) => ({ "account-a": "owner-a" })[account] ?? null,
    });
    assert.equal(adapter.customerDetail({ owner: "account-a", customerId: "customer-a" }).name, "A医院");
    assert.equal(adapter.customerDetail({ owner: "account-b", customerId: "customer-a" }), null);
  });

  it("fails closed for mismatched ownership while preserving opportunity customer fallback", () => {
    db.prepare(`
      INSERT INTO opportunities (id, customer_id, name, stage, amount, owner, probability)
      VALUES ('opportunity-fallback', 'customer-a', '回退归属项目', 'lead', '20 万', NULL, 30)
    `).run();
    db.prepare(`
      INSERT INTO action_items (id, customer_id, opportunity_id, title, status)
      VALUES ('action-fallback', NULL, 'opportunity-fallback', '按商机关联跟进', 'pending')
    `).run();
    db.prepare(`
      INSERT INTO action_items (id, customer_id, opportunity_id, title, status)
      VALUES ('action-owner-mismatch', 'customer-a', 'opportunity-b', '错误双归属动作', 'pending')
    `).run();
    db.prepare(`
      INSERT INTO risk_items (id, customer_id, opportunity_id, title, target, severity, status, evidence, action)
      VALUES ('risk-owner-mismatch', 'customer-a', 'opportunity-b', '错误双归属风险', '商机', '高', 'open', '测试', '忽略')
    `).run();

    const adapter = createAssistantBusinessSnapshotAdapter({ db, clock: () => new Date("2026-08-17T12:00:00Z") });
    const ownerA = adapter.actionRiskSummary({ owner: "owner-a" });
    const ownerB = adapter.actionRiskSummary({ owner: "owner-b" });

    assert.ok(ownerA.actions.some((item) => item.id === "action-fallback"));
    assert.equal(ownerA.actions.some((item) => item.id === "action-owner-mismatch"), false);
    assert.equal(ownerB.actions.some((item) => item.id === "action-owner-mismatch"), false);
    assert.equal(ownerA.risks.some((item) => item.id === "risk-owner-mismatch"), false);
    assert.equal(ownerB.risks.some((item) => item.id === "risk-owner-mismatch"), false);

    db.prepare("INSERT INTO action_items (id, customer_id, title, status) VALUES ('action-done', 'customer-a', '已完成动作', 'done')").run();
    db.prepare("INSERT INTO action_items (id, customer_id, title, status) VALUES ('action-cancelled', 'customer-a', '已取消动作', 'cancelled')").run();
    db.prepare("INSERT INTO risk_items (id, customer_id, title, target, severity, status, evidence, action) VALUES ('risk-closed', 'customer-a', '已关闭风险', '客户', '中', 'closed', '测试', '忽略')").run();
    db.prepare("INSERT INTO risk_items (id, customer_id, title, target, severity, status, evidence, action) VALUES ('risk-resolved', 'customer-a', '已解决风险', '客户', '中', 'resolved', '测试', '忽略')").run();
    const filtered = adapter.actionRiskSummary({ owner: "owner-a" });
    assert.equal(filtered.actions.some((item) => item.id === "action-done" || item.id === "action-cancelled"), false);
    assert.equal(filtered.risks.some((item) => item.id === "risk-closed" || item.id === "risk-resolved"), false);
  });

  it("normalizes trusted database timestamps without weakening strict project date parsing", () => {
    db.exec(`
      DELETE FROM quick_records;
      DELETE FROM action_items;
      DELETE FROM risk_items;
      DELETE FROM travel_expense_payments;
      DELETE FROM travel_expenses;
      UPDATE customers SET updated_at = '2026-08-09 00:00:00' WHERE id = 'customer-a';
      UPDATE opportunities SET updated_at = '2026-08-10 00:00:00' WHERE id = 'opportunity-a';
    `);
    const adapter = createAssistantBusinessSnapshotAdapter({ db, clock: () => new Date("2026-08-17T12:00:00Z") });
    const result = adapter.projectAnalysis({ owner: "owner-a", opportunityId: "opportunity-a" });

    assert.equal(result.metrics.evidenceFreshness.latestAt, "2026-08-10T00:00:00Z");
    assert.equal(result.metrics.evidenceFreshness.status, "aging");
  });

  it("uses the Shanghai business date for current-week summaries", () => {
    const adapter = createAssistantBusinessSnapshotAdapter({
      db,
      clock: () => new Date("2026-08-16T16:30:00Z"),
    });
    const dashboard = adapter.dashboardSummary({ owner: "owner-a" });
    const expenses = adapter.travelExpenseSummary({ owner: "owner-a", weekStart: "current" });

    assert.equal(dashboard.weekStart, "2026-08-17");
    assert.equal(dashboard.counts.currentWeekExpenses, 1);
    assert.equal(expenses.weekStart, "2026-08-17");
    assert.equal(expenses.summary.count, 1);
  });

  it("assembles a bounded project analysis without raw business text or cross-owner evidence", () => {
    const adapter = createAssistantBusinessSnapshotAdapter({ db, clock: () => new Date("2026-08-17T12:00:00Z") });
    const result = adapter.projectAnalysis({ owner: "owner-a", opportunityId: "opportunity-a" });
    assert.equal(result.schemaVersion, "project-analysis-v1");
    assert.ok(result.facts.some((item) => item.key === "opportunity.amount" && item.value === "120 万"));
    assert.ok(result.nextActions.some((item) => item.sourceId === "action-a"));
    assert.ok(result.risks.some((item) => item.sourceId === "risk-a"));
    assert.equal(result.metrics.expense.actualPaidCents, 8800);
    assert.equal(result.metrics.expense.reimbursementCents, 7000);
    assert.equal(JSON.stringify(result).includes("原始拜访正文"), false);
    assert.equal(JSON.stringify(result).includes("opportunity-b"), false);
    assert.equal(adapter.projectAnalysis({ owner: "owner-a", opportunityId: "opportunity-b" }), null);
  });

  it("returns bounded action, itinerary, expense, and knowledge summaries without writes", () => {
    const adapter = createAssistantBusinessSnapshotAdapter({ db, clock: () => new Date("2026-08-17T12:00:00Z") });
    const before = db.prepare("SELECT total_changes() AS count").get().count;
    const actionRisk = adapter.actionRiskSummary({ owner: "owner-a" });
    const itineraries = adapter.itinerarySummary({ owner: "owner-a" });
    const expenses = adapter.travelExpenseSummary({ owner: "owner-a", weekStart: "2026-08-17" });
    const knowledge = adapter.knowledgeSearch({ query: "采购" });
    const after = db.prepare("SELECT total_changes() AS count").get().count;

    assert.deepEqual(actionRisk.actions.map((item) => item.id), ["action-a"]);
    assert.deepEqual(actionRisk.risks.map((item) => item.id), ["risk-a"]);
    assert.deepEqual(itineraries.items.map((item) => item.id), ["itinerary-a"]);
    assert.deepEqual(expenses.summary, {
      count: 1,
      actualPaidCents: 8800,
      reimbursementCents: 7000,
      confirmedCoverageCents: 0,
      missingInvoiceCents: 7000,
      noInvoiceConfirmedCents: 0,
      unacknowledgedMissingCents: 7000,
      missingInvoiceCount: 1,
      invalidAmountCount: 0,
    });
    assert.deepEqual(knowledge.items.map((item) => item.id), ["knowledge-a"]);
    assert.equal(JSON.stringify(knowledge).includes("完整知识正文"), false);
    assert.equal(after, before);
  });

  it("keeps reimbursement readiness truthful when invoices are missing", () => {
    const adapter = createAssistantBusinessSnapshotAdapter({ db, clock: () => new Date("2026-08-17T12:00:00Z") });
    const expenses = adapter.travelExpenseSummary({ owner: "owner-a", weekStart: "2026-08-17" });

    assert.equal(expenses.summary.reimbursementCents, 7000);
    assert.equal(expenses.summary.confirmedCoverageCents, 0);
    assert.equal(expenses.summary.missingInvoiceCents, 7000);
    assert.equal(expenses.summary.unacknowledgedMissingCents, 7000);
    assert.equal(expenses.summary.missingInvoiceCount, 1);
    assert.equal(expenses.items[0].missingInvoiceCents, 7000);
    assert.equal(expenses.items[0].confirmedCoverageCents, 0);
    assert.equal(expenses.preparation.ready, false);
    assert.ok(expenses.preparation.blockers.includes("missing_invoice"));
  });

  it("marks bounded expense and weekly-report snapshots as partial", () => {
    const insertExpense = db.prepare(`
      INSERT INTO travel_expenses (
        id, reference_code, owner, occurred_on, category, purpose, customer_id, invoice_status, created_by, updated_by
      ) VALUES ($id, $referenceCode, 'owner-a', '2026-08-17', 'transport', 'extra expense', 'customer-a', 'pending', 'owner-a', 'owner-a')
    `);
    const insertPayment = db.prepare(`
      INSERT INTO travel_expense_payments (
        id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents, funding_source, payment_method
      ) VALUES ($id, $expenseId, 1, '2026-08-17T10:00:00+08:00', 100, 100, 'personal', 'wechat')
    `);
    for (let index = 0; index < 101; index += 1) {
      const id = `expense-extra-${index}`;
      insertExpense.run({ $id: id, $referenceCode: `EXP-EXTRA-${String(index).padStart(3, "0")}` });
      insertPayment.run({ $id: `payment-extra-${index}`, $expenseId: id });
    }
    const insertReport = db.prepare(`
      INSERT INTO weekly_reports (id, owner, period_start, period_end, status, content, source_refs)
      VALUES ($id, 'owner-a', '2026-08-17', '2026-08-23', 'ready', 'report', '[]')
    `);
    for (let index = 0; index < 101; index += 1) insertReport.run({ $id: `report-extra-${index}` });

    const adapter = createAssistantBusinessSnapshotAdapter({ db, clock: () => new Date("2026-08-17T12:00:00Z") });
    const expenses = adapter.travelExpenseSummary({ owner: "owner-a", weekStart: "2026-08-17" });
    const reports = adapter.salesReportSummary({ owner: "owner-a", weekStart: "2026-08-17" });

    assert.equal(expenses.truncated, true);
    assert.equal(expenses.partial, true);
    assert.equal(reports.truncated, true);
    assert.equal(reports.partial, true);
  });

  it("counts only real weekly report rows and keeps report previews separate from expenses", async () => {
    db.prepare("UPDATE weekly_reports SET status = 'archived' WHERE id = 'report-a'").run();
    db.prepare(`
      INSERT INTO weekly_reports (id, owner, period_start, period_end, status, content, source_refs)
      VALUES ('report-draft', 'owner-a', '2026-08-17', '2026-08-23', 'draft', '草稿正文', '[{"type":"quick_record","id":"record-a"}]')
    `).run();
    db.prepare(`
      INSERT INTO quick_records (id, owner, raw_content, occurred_at, source_channel, status)
      VALUES ('record-outside-report', 'owner-a', '未形成周报的记录', '2026-08-17T10:00:00Z', 'test', 'analyzed')
    `).run();

    const adapter = createAssistantBusinessSnapshotAdapter({ db, clock: () => new Date("2026-08-17T12:00:00Z") });
    const reports = adapter.salesReportSummary({ owner: "owner-a", weekStart: "2026-08-17" });
    assert.equal(reports.reportCount, 1);
    assert.equal(reports.statusCounts.draft, 1);
    assert.equal(reports.statusCounts.ready, 0);
    assert.equal(reports.items[0].id, "report-draft");
    assert.equal("content" in reports.items[0], false);

    const sessions = createAssistantSessionRepository(db, { clock: () => new Date("2026-08-17T12:00:00Z") });
    const handlers = createAssistantToolHandlers({
      db,
      config: { aiAnalysisMode: "mock" },
      sessionRepository: sessions,
      clock: () => new Date("2026-08-17T12:00:00Z"),
    });
    const context = { owner: "owner-a", channel: "weixin", conversation: "conversation-report", requestId: "request-report" };
    const output = await handlers["sales-report.preview"]({ week: "2026-08-17" }, context, {});
    assert.match(output.text, /销售周报预览/);
    assert.match(output.text, /已保存周报 1 条/);
    assert.doesNotMatch(output.text, /报销|费用|实付/);
    assert.equal(output.summary.reportCount, 1);

    const reimbursement = await handlers["reimbursement-report.preview"]({ week: "2026-08-17" }, context, {});
    assert.match(reimbursement.text, /登记可报销 70\.00 元/);
    assert.match(reimbursement.text, /缺票 70\.00 元/);
    assert.match(reimbursement.text, /确认前待处理/);
    assert.doesNotMatch(reimbursement.text, /可报销 70\.00 元，/);
  });

  it("exposes the adapter through registered read-only runtime handlers", async () => {
    const sessions = createAssistantSessionRepository(db, { clock: () => new Date("2026-08-17T12:00:00Z") });
    const handlers = createAssistantToolHandlers({
      db,
      config: { aiAnalysisMode: "mock" },
      sessionRepository: sessions,
      clock: () => new Date("2026-08-17T12:00:00Z"),
    });
    const context = { owner: "owner-a", channel: "weixin", conversation: "conversation-a", requestId: "request-a" };
    const before = db.prepare("SELECT total_changes() AS count").get().count;
    for (const [toolName, args] of [
      ["dashboard.summary", {}],
      ["customer.detail", { customerId: "customer-a" }],
      ["opportunity.detail", { opportunityId: "opportunity-a" }],
      ["sales-decision.preview", { opportunityId: "opportunity-a" }],
      ["action-risk.summary", {}],
      ["itinerary.summary", {}],
      ["travel-expense.summary", { week: "current" }],
      ["knowledge.search", { query: "采购" }],
    ]) {
      assert.equal(typeof handlers[toolName], "function", toolName);
      const output = await handlers[toolName](args, context, {});
      assert.equal(typeof output.text, "string", toolName);
      assert.ok(output.text.length > 0, toolName);
    }
    const denied = await handlers["customer.detail"]({ customerId: "customer-b" }, context, {});
    assert.equal(denied.status, "not_found");
    assert.equal((await handlers["customer.detail"]({ customerId: "A医院" }, context, {})).customer.name, "A医院");
    assert.equal((await handlers["opportunity.detail"]({ opportunityId: "A项目" }, context, {})).opportunity.name, "A项目");
    assert.equal((await handlers["sales-decision.preview"]({ opportunityId: "A项目" }, context, {})).status, "preview");
    assert.equal(db.prepare("SELECT total_changes() AS count").get().count, before);
  });

  it("clarifies ambiguous names instead of guessing an entity", async () => {
    db.prepare("INSERT INTO customers (id, name, region, owner) VALUES ('customer-a2', 'A医院', '山东', 'owner-a')").run();
    const sessions = createAssistantSessionRepository(db, { clock: () => new Date("2026-08-17T12:00:00Z") });
    const handlers = createAssistantToolHandlers({
      db,
      config: { aiAnalysisMode: "mock" },
      sessionRepository: sessions,
      clock: () => new Date("2026-08-17T12:00:00Z"),
    });
    const result = await handlers["customer.detail"]({ customerId: "A医院" }, { owner: "owner-a", channel: "weixin", conversation: "conversation-a", requestId: "request-a" }, {});
    assert.equal(result.status, "clarify");
    assert.match(result.question, /客户/);
  });

  it("uses the same owner resolver and safe identifiers for customer search", async () => {
    const sessions = createAssistantSessionRepository(db, { clock: () => new Date("2026-08-17T12:00:00Z") });
    const handlers = createAssistantToolHandlers({
      db,
      config: { aiAnalysisMode: "mock" },
      sessionRepository: sessions,
      resolveBusinessOwner: (account) => ({ "account-a": "owner-a" })[account] ?? null,
      clock: () => new Date("2026-08-17T12:00:00Z"),
    });
    const result = await handlers["customer.search"](
      { query: "A医院" },
      { owner: "account-a", channel: "weixin", conversation: "conversation-search", requestId: "request-search" },
      {},
    );
    assert.equal(result.items[0].id, "customer-a");
    assert.match(result.text, /customer-a/);
    assert.equal(result.items.some((item) => item.owner), false);
  });

  it("rejects out-of-contract opportunity probability in direct detail output", () => {
    db.prepare("UPDATE opportunities SET probability = 101 WHERE id = 'opportunity-a'").run();
    const adapter = createAssistantBusinessSnapshotAdapter({ db, clock: () => new Date("2026-08-17T12:00:00Z") });
    assert.equal(adapter.opportunityDetail({ owner: "owner-a", opportunityId: "opportunity-a" }).probability, null);
  });
});
