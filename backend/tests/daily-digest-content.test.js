import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createActionItemStore } from "../src/actionItems/actionItemStore.js";
import { createAssistantBusinessSnapshotAdapter } from "../src/assistant/businessSnapshotAdapter.js";
import { createBusinessOwnerResolver } from "../src/assistant/businessOwnerResolver.js";
import { createHospitalTenderRepository } from "../src/hospitalTender/repository.js";
import {
  addDays,
  createDigestContentBuilder,
  fridayOfWeek,
  shanghaiDateParts,
  weekStartOf,
} from "../src/dailyDigest/digestContent.js";

const OWNER = "digest-owner";
// Friday 2026-08-28 10:00 Asia/Shanghai.
const NOW = "2026-08-28T02:00:00.000Z";

let dir;
let db;
let tenderNow;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentelligent-daily-digest-"));
  db = openDatabase({ databaseUrl: join(dir, "digest.sqlite") });
  tenderNow = NOW;
  db.exec(`
    INSERT INTO customers (id, name, owner) VALUES ('customer-digest-1', '日照中医医院', '${OWNER}');
  `);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeBuilder(overrides = {}) {
  const clock = () => new Date(NOW);
  // v0.9.3：resolver 改查绑定表——桩以"仅 OWNER 有 active 绑定"复现闭合语义。
  const resolveBusinessOwner = createBusinessOwnerResolver({
    hasActiveBinding: (account) => account === OWNER,
  });
  return createDigestContentBuilder({
    db,
    snapshotAdapter: createAssistantBusinessSnapshotAdapter({ db, clock, resolveBusinessOwner }),
    actionItemStore: createActionItemStore(db, { clock }),
    tenderRepository: createHospitalTenderRepository(db, { clock: () => new Date(tenderNow) }),
    resolveBusinessOwner,
    clock,
    dailyTime: { hour: 9, minute: 0 },
    ...overrides,
  });
}

function seedItinerary(id, visitDate, { status = "planned", plan = null, title = "日照两院拜访" } = {}) {
  const planJson = plan ?? JSON.stringify({
    title,
    stops: [
      { id: "stop-1", customerName: "日照中医医院" },
      { id: "stop-2", customerName: "日照人民医院" },
    ],
    orderedStopIds: ["stop-1", "stop-2"],
  });
  db.prepare(`
    INSERT INTO visit_itineraries (id, title, visit_date, status, request_json, plan_json, created_by, updated_by, owner)
    VALUES ($id, $title, $visitDate, $status, '{}', $planJson, $owner, $owner, $owner)
  `).run({ $id: id, $title: title, $visitDate: visitDate, $status: status, $planJson: planJson, $owner: OWNER });
}

function seedTodo(id, remindAt, { title = "给王工送方案", priority = "中", status = "pending", remindedAt = null } = {}) {
  db.prepare(`
    INSERT INTO action_items (id, title, owner, remind_at, reminded_at, priority, status)
    VALUES ($id, $title, $owner, $remindAt, $remindedAt, $priority, $status)
  `).run({ $id: id, $title: title, $owner: OWNER, $remindAt: remindAt, $remindedAt: remindedAt, $priority: priority, $status: status });
}

function seedRisk(id, { score = 82, severity = "高", title = "数据自主权分歧", due = "本周五" } = {}) {
  db.prepare(`
    INSERT INTO risk_items (id, customer_id, title, target, severity, status, score, due, evidence, action, owner)
    VALUES ($id, 'customer-digest-1', $title, '商机', $severity, 'open', $score, $due, '会议纪要', '尽快对齐', $owner)
  `).run({ $id: id, $title: title, $severity: severity, $score: score, $due: due, $owner: OWNER });
}

function seedNotice(repository, id, { relevance = "high", title = "日照市中医医院信息化设备采购", deadlineText = "2026-09-05" } = {}) {
  repository.upsertNotice({
    id,
    identityKey: `source-a:${id}`,
    sourceId: "source-a",
    sourceName: "山东政采",
    city: "日照市",
    title,
    url: `https://example.com/${id}`,
    publishedAt: "2026-08-27T06:00:00.000Z",
    noticeType: "tender",
    hospitalNames: ["日照中医医院"],
    sourceItemId: id,
    contentSha256: "a".repeat(64),
    relevance,
    deadlineText,
  });
}

function seedExpense(id, occurredOn, { reimbursementCents = 12000, actualPaidCents = 12000, purpose = "打车去日照", category = "transport" } = {}) {
  db.prepare(`
    INSERT INTO travel_expenses (id, reference_code, owner, occurred_on, category, purpose, invoice_status, created_by, updated_by)
    VALUES ($id, $ref, $owner, $occurredOn, $category, $purpose, 'pending', $owner, $owner)
  `).run({ $id: id, $ref: `EXP-${id}`.toUpperCase().slice(0, 24), $owner: OWNER, $occurredOn: occurredOn, $category: category, $purpose: purpose });
  db.prepare(`
    INSERT INTO travel_expense_payments (id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents, funding_source, payment_method)
    VALUES ($paymentId, $id, 1, $paidAt, $amount, $reimbursement, 'personal', 'wechat')
  `).run({ $paymentId: `${id}-pay-1`, $id: id, $paidAt: `${occurredOn}T10:00:00+08:00`, $amount: actualPaidCents, $reimbursement: reimbursementCents });
}

function seedAttachment(expenseId, kind) {
  const sha = "b".repeat(64);
  db.prepare(`
    INSERT OR IGNORE INTO document_blobs (id, owner, sha256, encoding, original_size_bytes, stored_size_bytes, content_blob)
    VALUES ($id, $owner, $sha, 'identity', 5, 5, $content)
  `).run({ $id: sha, $owner: OWNER, $sha: sha, $content: Buffer.from("proof") });
  db.prepare(`
    INSERT INTO travel_expense_attachments (id, expense_id, sequence, kind, file_name, media_type, size_bytes, document_blob_id, covered_cents, created_by)
    VALUES ($id, $expenseId, $sequence, $kind, 'file.png', 'image/png', 5, $blobId, 0, $owner)
  `).run({
    $id: `${expenseId}-${kind}`,
    $expenseId: expenseId,
    $sequence: kind === "payment_proof" ? 1 : 2,
    $kind: kind,
    $blobId: sha,
    $owner: OWNER,
  });
}

describe("shanghai date helpers", () => {
  it("derives the business date, week start, and Friday across the +08 day boundary", () => {
    assert.deepEqual(shanghaiDateParts(new Date("2026-08-27T15:59:00.000Z")), { date: "2026-08-27", hour: 23, minute: 59, weekday: 4 });
    assert.deepEqual(shanghaiDateParts(new Date("2026-08-27T16:00:00.000Z")), { date: "2026-08-28", hour: 0, minute: 0, weekday: 5 });
    assert.equal(addDays("2026-08-28", -1), "2026-08-27");
    assert.equal(weekStartOf("2026-08-28"), "2026-08-24");
    assert.equal(weekStartOf("2026-08-24"), "2026-08-24");
    assert.equal(fridayOfWeek("2026-08-30"), "2026-08-28");
    assert.equal(fridayOfWeek("2026-08-24"), "2026-08-28");
  });
});

describe("daily digest content", () => {
  it("returns no_business_owner when the account does not map to the configured owner", () => {
    const builder = makeBuilder();
    assert.deepEqual(builder.buildDailyDigest({ owner: "someone-else" }), { empty: true, reason: "no_business_owner" });
  });

  it("is empty when all four sections have nothing to say", () => {
    const builder = makeBuilder();
    assert.deepEqual(builder.buildDailyDigest({ owner: OWNER }), { empty: true, reason: "empty" });
  });

  it("lists only today's planned itineraries and fails open on a corrupted plan", () => {
    seedItinerary("itinerary-today", "2026-08-28");
    seedItinerary("itinerary-tomorrow", "2026-08-29");
    seedItinerary("itinerary-cancelled", "2026-08-28", { status: "cancelled" });
    seedItinerary("itinerary-broken", "2026-08-28", { plan: "{}", title: "损坏行程" });
    const built = makeBuilder().buildDailyDigest({ owner: OWNER });
    assert.equal(built.empty, false);
    const section = built.payload.sections.find((item) => item.heading.startsWith("今日行程"));
    assert.ok(section);
    assert.equal(section.heading, "今日行程（2 站）");
    assert.equal(section.lines.length, 2);
    assert.ok(section.lines.some((line) => line.includes("日照两院拜访") && line.includes("2 站") && line.includes("首站 日照中医医院")));
    assert.ok(section.lines.some((line) => line === "· 损坏行程"));
    assert.equal(built.payload.headline, "焦点：今天有 2 站拜访，首站 日照中医医院。");
    assert.equal(built.stats.itineraryCount, 2);
  });

  it("windows todos on the Shanghai day boundary, keeps reminded rows, and counts unscheduled ones", () => {
    seedTodo("todo-overdue-2359", "2026-08-27T15:59:00.000Z", { remindedAt: "2026-08-27T16:01:00.000Z", title: "昨日深夜到期" });
    seedTodo("todo-today-0000", "2026-08-27T16:00:00.000Z", { title: "今日零点到期" });
    seedTodo("todo-today-2359", "2026-08-28T15:59:00.000Z", { title: "今日深夜到期" });
    seedTodo("todo-tomorrow", "2026-08-28T16:00:00.000Z", { title: "明日待办" });
    seedTodo("todo-unscheduled", null, { title: "未排期待办" });
    seedTodo("todo-unscheduled-deferred", null, { title: "顺延未排期", status: "deferred" });
    const built = makeBuilder().buildDailyDigest({ owner: OWNER });
    const section = built.payload.sections.find((item) => item.heading.startsWith("待办"));
    assert.ok(section);
    assert.equal(section.heading, "待办（逾期 1 ｜ 今日 2）");
    assert.ok(section.lines.includes("逾期："));
    assert.ok(section.lines.some((line) => line.includes("昨日深夜到期") && line.includes("08-27 23:59") && line.includes("e-2359")));
    assert.ok(section.lines.includes("今日："));
    assert.ok(section.lines.some((line) => line.includes("今日零点到期") && line.includes("00:00")));
    assert.ok(section.lines.some((line) => line.includes("今日深夜到期") && line.includes("23:59")));
    assert.ok(!section.lines.some((line) => line.includes("明日待办")));
    assert.ok(section.lines.includes("另有未排期待办 1 条。"));
    assert.deepEqual(
      [built.stats.overdueCount, built.stats.todayTodoCount, built.stats.unscheduledTodoCount],
      [1, 2, 1],
    );
  });

  it("prefers the overdue high-priority todo as the headline with day arithmetic", () => {
    seedItinerary("itinerary-today", "2026-08-28");
    seedTodo("todo-overdue-high", "2026-08-26T01:00:00.000Z", { priority: "高", title: "给王工送方案" });
    const built = makeBuilder().buildDailyDigest({ owner: OWNER });
    assert.equal(built.payload.headline, "焦点：逾期待办「给王工送方案」已过期 2 天，建议今天处理。");
  });

  it("filters risks to high severity or score >= 80 and falls back to a count line", () => {
    seedRisk("risk-high", { score: 82, severity: "高" });
    seedRisk("risk-low", { score: 40, severity: "中", title: "低分风险" });
    let built = makeBuilder().buildDailyDigest({ owner: OWNER });
    let section = built.payload.sections.find((item) => item.heading.startsWith("活跃风险"));
    assert.equal(section.heading, "活跃风险（共 2 条，高危 1）");
    assert.ok(section.lines.some((line) => line.includes("[高·82分]") && line.includes("数据自主权分歧") && line.includes("截止 本周五")));
    assert.ok(!section.lines.some((line) => line.includes("低分风险")));
    assert.equal(built.payload.headline, "焦点：风险「数据自主权分歧」（82 分）待处理。");

    db.exec("DELETE FROM risk_items WHERE id = 'risk-high'");
    built = makeBuilder().buildDailyDigest({ owner: OWNER });
    section = built.payload.sections.find((item) => item.heading.startsWith("活跃风险"));
    assert.deepEqual(section.lines, ["活跃风险 1 条，无高危。"]);
    assert.equal(built.payload.headline, null);
  });

  it("anchors new tenders at yesterday's digest time, lists high, counts medium, and truncates at five", () => {
    const builder = makeBuilder();
    const repository = createHospitalTenderRepository(db, { clock: () => new Date(tenderNow) });
    tenderNow = "2026-08-27T00:30:00.000Z"; // 昨日 08:30+08 —— 窗口外
    seedNotice(repository, "notice-outside", { title: "窗口外公告" });
    tenderNow = "2026-08-27T01:30:00.000Z"; // 昨日 09:30+08 —— 窗口内
    for (let index = 1; index <= 6; index += 1) {
      seedNotice(repository, `notice-in-${index}`, { title: `窗口内公告${index}` });
    }
    seedNotice(repository, "notice-medium", { relevance: "medium", title: "中相关公告" });
    const built = builder.buildDailyDigest({ owner: OWNER });
    const section = built.payload.sections.find((item) => item.heading.startsWith("新招标"));
    assert.equal(section.heading, "新招标（昨日以来 高相关 6 条）");
    const noticeLines = section.lines.filter((line) => line.startsWith("· "));
    assert.equal(noticeLines.length, 5);
    assert.ok(noticeLines.every((line) => line.includes("山东政采") && line.includes("截止 2026-09-05")));
    assert.ok(!section.lines.some((line) => line.includes("窗口外公告")));
    assert.ok(section.lines.includes("另有 1 条高相关见系统招标页。"));
    assert.ok(!section.lines.some((line) => line.includes("中相关新公告")));
    assert.deepEqual([built.stats.tenderHighCount, built.stats.tenderMediumCount], [6, 1]);
    assert.equal(built.payload.headline, "焦点：新招标「窗口内公告1」值得关注。");
  });

  it("shows a medium-only count line when no high-relevance notice is new", () => {
    const repository = createHospitalTenderRepository(db, { clock: () => new Date(tenderNow) });
    seedNotice(repository, "notice-medium-only", { relevance: "medium", title: "中相关公告" });
    const built = makeBuilder().buildDailyDigest({ owner: OWNER });
    const section = built.payload.sections.find((item) => item.heading.startsWith("新招标"));
    assert.deepEqual(section.lines, ["中相关新公告 1 条（未匹配重点客户）。"]);
    assert.equal(built.payload.headline, null);
  });
});

describe("friday closeout content", () => {
  it("reports the existing weekly report branch", () => {
    db.exec(`
      INSERT INTO weekly_reports (id, owner, period_start, period_end, status, content, source_refs)
      VALUES ('report-week', '${OWNER}', '2026-08-24', '2026-08-30', 'ready', '内容', '[]')
    `);
    const built = makeBuilder().buildFridayCloseout({ owner: OWNER });
    assert.equal(built.empty, false);
    assert.equal(built.payload.kind, "friday_closeout");
    assert.equal(built.payload.digestDate, "2026-08-28");
    assert.equal(built.payload.weekStart, "2026-08-24");
    const report = built.payload.sections.find((item) => item.heading === "周报");
    assert.deepEqual(report.lines, ["本周已有周报 1 份（最新：就绪）。发送“销售周报”可查看预览。"]);
  });

  it("reports confirmed weekly material when no report exists yet", () => {
    db.exec(`
      INSERT INTO quick_records (id, owner, raw_content, occurred_at, source_channel, customer_id, status)
      VALUES ('record-week', '${OWNER}', '客户确认扩容计划。', '2026-08-26T10:00:00+08:00', '微信助手', 'customer-digest-1', 'analyzed')
    `);
    const built = makeBuilder().buildFridayCloseout({ owner: OWNER });
    const report = built.payload.sections.find((item) => item.heading === "周报");
    assert.deepEqual(report.lines, ["本周还没有周报。已确认素材 1 条，Web 周报页可一键生成草稿，或发送“销售周报”先看预览。"]);
  });

  it("reports the no-material branch and the all-clear line when nothing is missing", () => {
    const built = makeBuilder().buildFridayCloseout({ owner: OWNER });
    const report = built.payload.sections.find((item) => item.heading === "周报");
    assert.deepEqual(report.lines, ["本周暂无已确认的周报素材——快速记录确认后会自动进入周报。"]);
    const clear = built.payload.sections.find((item) => item.heading === "凭证与发票");
    assert.deepEqual(clear.lines, ["本周凭证与发票已齐 ✓"]);
    assert.equal(built.payload.sections.length, 2);
  });

  it("lists proof-missing expenses by the payment_proof attachment rule", () => {
    seedExpense("expense-no-proof", "2026-08-26");
    seedExpense("expense-with-proof", "2026-08-25", { purpose: "已有凭证" });
    seedAttachment("expense-with-proof", "payment_proof");
    seedExpense("expense-invoice-only", "2026-08-27", { purpose: "只有发票" });
    seedAttachment("expense-invoice-only", "invoice");
    seedExpense("expense-out-of-week", "2026-08-20", { purpose: "上周费用" });
    const built = makeBuilder().buildFridayCloseout({ owner: OWNER });
    const proof = built.payload.sections.find((item) => item.heading.startsWith("凭证缺失"));
    assert.equal(proof.heading, "凭证缺失（2 笔）");
    assert.ok(proof.lines.some((line) => line.includes("08-26 交通 打车去日照") && line.includes("缺支付凭证")));
    assert.ok(proof.lines.some((line) => line.includes("只有发票")));
    assert.ok(!proof.lines.some((line) => line.includes("已有凭证") || line.includes("上周费用")));
  });

  it("lists invoice gaps by the unacknowledged-missing rule and skips confirmed no-invoice expenses", () => {
    seedExpense("expense-missing-invoice", "2026-08-25", { reimbursementCents: 12000, purpose: "如家日照店", category: "lodging" });
    seedExpense("expense-acknowledged", "2026-08-26", { reimbursementCents: 8000, purpose: "已确认无票" });
    db.prepare(`
      INSERT INTO travel_expense_no_invoice_confirmations (
        id, owner, expense_id, payment_id, amount_snapshot_cents,
        reason, confirmed_by, confirmed_at, created_at, updated_at
      ) VALUES (
        'no-invoice-1', $owner, 'expense-acknowledged', 'expense-acknowledged-pay-1', 8000,
        '小额无票', $owner, '2026-08-26T08:00:00.000Z', '2026-08-26T08:00:00.000Z', '2026-08-26T08:00:00.000Z'
      )
    `).run({ $owner: OWNER });
    const built = makeBuilder().buildFridayCloseout({ owner: OWNER });
    const invoice = built.payload.sections.find((item) => item.heading.startsWith("发票缺失"));
    assert.equal(invoice.heading, "发票缺失（1 笔 ｜ 合计 120.00 元）");
    assert.deepEqual(invoice.lines, ["· 08-25 住宿 如家日照店 ｜ 可报销 120.00 元 ｜ 缺票 120.00 元"]);
    assert.deepEqual(
      [built.stats.invoiceMissingCount, built.stats.invoiceMissingCents, built.stats.proofMissingCount],
      [1, 12000, 2],
    );
  });

  it("returns no_business_owner for an unmapped account", () => {
    assert.deepEqual(makeBuilder().buildFridayCloseout({ owner: "other" }), { empty: true, reason: "no_business_owner" });
  });
});
