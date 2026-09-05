import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SALES_WORKBENCH_API_CONTRACT_VERSION,
  assertApiCollection,
  assertApiEntity,
} from "../../../../shared/salesWorkbenchApiContract.mjs";
import {
  createConfirmationAttemptTracker,
  createSalesWorkbenchApi,
  createStrongUuid,
  resolveApiBaseUrl,
} from "./salesWorkbenchApi.js";
import * as salesWorkbenchApiModule from "./salesWorkbenchApi.js";

const syntheticToken = "synthetic-token";
const syntheticKey = "synthetic-deepseek-key";

function responseHeaders(values = {}) {
  const entries = new Map(
    Object.entries(values).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  return {
    get(name) {
      return entries.get(String(name).toLowerCase()) ?? null;
    },
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders(headers),
    text: async () => body == null ? "" : JSON.stringify(body),
  };
}

function blobResponse(blob, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders(headers),
    text: async () => blob.text(),
    blob: async () => blob,
  };
}

function headerValue(options, name) {
  const headers = options.headers ?? {};
  if (typeof headers.get === "function") return headers.get(name);
  const matchedName = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === String(name).toLowerCase(),
  );
  return matchedName ? headers[matchedName] : undefined;
}

function apiFetchProbe(calls) {
  return async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse(null, 204);
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sampleCustomer(overrides = {}) {
  return {
    id: "rizhao",
    version: 1,
    name: "Rizhao TCM Hospital",
    region: "Rizhao",
    type: "hospital",
    level: "A",
    owner: "Jizhen",
    contact: "Liang Bin",
    relation: 82,
    stakeholders: [],
    decisionChain: [],
    historyProjects: [],
    infrastructure: [],
    syncPreview: [],
    budget: "TBD",
    summary: "Local data center planning account.",
    needs: [],
    risks: [],
    opportunities: [],
    ...overrides,
  };
}

function sampleOpportunity(overrides = {}) {
  return {
    id: "op-rizhao-plan",
    version: 1,
    customerId: "rizhao",
    name: "Rizhao TCM five-year plan",
    customer: "Rizhao TCM Hospital",
    stage: "planning",
    amount: "680",
    owner: "Jizhen",
    probability: 72,
    days: 21,
    requirements: [],
    competitors: [],
    solutionDirection: [],
    sourceRecord: "quick-record",
    risk: "budget path",
    next: "prepare planning material",
    tone: "green",
    ...overrides,
  };
}

function sampleAction(overrides = {}) {
  return {
    id: "act-1",
    version: 1,
    customerId: "rizhao",
    opportunityId: "op-rizhao-plan",
    title: "Prepare planning material",
    customer: "Rizhao TCM Hospital",
    reason: "Confirmed from quick record.",
    due: "today",
    assignee: "Jizhen",
    priority: "high",
    status: "pending",
    sourceRecordId: "qr-1",
    tone: "blue",
    createdAt: "2026-06-05 10:30:00",
    updatedAt: "2026-06-05 10:30:00",
    ...overrides,
  };
}

function sampleRisk(overrides = {}) {
  return {
    id: "risk-1",
    version: 1,
    customerId: "rizhao",
    opportunityId: "op-rizhao-plan",
    title: "Budget path unclear",
    target: "Rizhao TCM Hospital / five-year plan",
    score: 86,
    severity: "高",
    status: "open",
    evidence: "Budget path and cloud ownership still need confirmation.",
    action: "Confirm budget owner and approval window.",
    assignee: "Jizhen",
    due: "Wednesday 18:00",
    sourceType: "opportunity",
    sourceId: "op-rizhao-plan",
    tone: "red",
    createdAt: "2026-06-05 10:30:00",
    updatedAt: "2026-06-05 10:30:00",
    ...overrides,
  };
}

function sampleKnowledgeItem(overrides = {}) {
  return {
    id: "k-mobile-cloud",
    version: 1,
    title: "移动云灾备对比清单",
    category: "话术材料",
    tags: ["移动云", "灾备", "数据自主权"],
    summary: "用于回应平台封闭、资源计费和后台管理权问题。",
    content: "围绕计费、导出、自主权和运维边界形成对比。",
    source: "知识库沉淀",
    createdAt: "2026-06-05 10:30:00",
    updatedAt: "2026-06-05 10:30:00",
    ...overrides,
  };
}

function sampleAiSuggestion(overrides = {}) {
  return {
    id: "suggestion-1",
    version: 1,
    type: "customer_profile",
    title: "生成客户画像补全建议",
    status: "pending",
    content: "## 建议\n补齐关键人、预算窗口和下一步问题。",
    draft: "## 建议\n补齐关键人、预算窗口和下一步问题。",
    confidence: 78,
    sourceRefs: [{ type: "customer_profile", id: "customer-1", title: "客户档案：日照中医医院" }],
    confirmationPreview: {
      target: "人工审核记录（不会自动修改客户画像）",
      changes: [{ field: "建议状态", before: "待人工确认", after: "已人工确认" }],
    },
    source: "mock",
    fallbackReason: null,
    createdAt: "2026-06-05T10:00:00.000Z",
    updatedAt: "2026-06-05T10:00:00.000Z",
    confirmedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function sampleDashboardSummary(overrides = {}) {
  return {
    metrics: {
      quickRecords: { value: 1, badge: "1 pending", tone: "blue" },
      opportunities: { value: 2, badge: "1 needs manager", tone: "amber" },
      forecast: { value: "3000 万", badge: "monthly forecast", tone: "green" },
      risks: { value: 1, badge: "budget risk", tone: "red" },
    },
    priorityActions: [sampleAction()],
    customerHeat: [{ customerId: "rizhao", name: "Rizhao TCM Hospital", label: "relationship", value: 82, tone: "green" }],
    recentRecords: [{ id: "qr-1", date: "06-03", customer: "Rizhao TCM Hospital", title: "site visit", status: "confirmed", tone: "blue" }],
    opportunities: [sampleOpportunity()],
    rhythm: [{ id: "rhythm-action", time: "18:00", title: "Prepare planning material", type: "下一步动作", target: "actions" }],
    stageCounts: [{ stage: "planning", count: 1, amount: "共 120 万" }],
    todayFocus: {
      date: "2026-06-06",
      itineraries: { count: 0, items: [] },
      todos: { overdueCount: 0, todayCount: 0, items: [] },
      risks: { count: 0, items: [] },
      tenders: { highCount: 0, items: [] },
    },
    weeklyTrend: {
      weekStart: "2026-06-01",
      previousWeekStart: "2026-05-25",
      quickRecords: { current: 1, previous: 0 },
      expenseCents: { current: 0, previous: 0 },
      completedTodos: { current: 0, previous: 0 },
    },
    generatedAt: "2026-06-06T00:00:00.000Z",
    ...overrides,
  };
}

function sampleProactiveAssistant(overrides = {}) {
  return {
    schemaVersion: "proactive-assistant-v1",
    modelVersion: "rules/proactive-v1",
    source: "deterministic",
    generatedAt: "2026-09-05T00:00:00.000Z",
    staleDays: 21,
    limit: 50,
    items: [{
      id: "proactive-missing-next-step-1",
      schemaVersion: "proactive-assistant-v1",
      subjectType: "opportunity",
      subjectId: "op-rizhao-plan",
      customerId: "rizhao",
      opportunityId: "op-rizhao-plan",
      opportunityVersion: 1,
      customerVersion: 1,
      title: "商机缺少下一步动作",
      conclusion: "需要补充下一步",
      facts: [],
      inferences: [],
      unknowns: [],
      risks: [],
      nextActions: [],
      evidenceRefs: [],
      sourceRefs: [],
      confidence: null,
      confidenceLevel: "unverified",
      confidenceCalibrated: false,
      priority: null,
      priorityCalibrated: false,
      trigger: { type: "missing_next_step", reason: "next 为空", detectedAt: "2026-09-05T00:00:00.000Z" },
      modelVersion: "rules/proactive-v1",
      source: "deterministic",
      fallbackReason: null,
      confirmationStatus: "not_started",
      writebackPreview: { requiresHumanConfirmation: true, automaticWriteAllowed: false, action: null, risk: null, note: "preview" },
      previewDigest: "a".repeat(64),
      previewDigests: { action: "a".repeat(64) },
      writebackAllowed: false,
    }],
    counts: { total: 1, missingNextStep: 1, staleOpportunity: 0, stageEvidenceMismatch: 0 },
    truncated: false,
    writebackPolicy: { requiresHumanConfirmation: true, automaticWriteAllowed: false },
    ...overrides,
  };
}

function sampleProactiveWritebackOutcome(overrides = {}) {
  return {
    status: "created",
    target: "action",
    replayed: false,
    proactiveId: "proactive-missing-next-step-1",
    suggestionId: "proactive-missing-next-step-1",
    confirmationPreviewId: "preview-proactive-1",
    action: sampleAction({ id: "act-proactive" }),
    risk: null,
    ...overrides,
  };
}

function sampleProactiveConfirmationPreview(overrides = {}) {
  return {
    schemaVersion: "proactive-confirmation-preview-v1",
    id: "preview-proactive-1",
    owner: "jiangjz",
    suggestionId: "proactive-missing-next-step-1",
    target: "action",
    revision: 1,
    status: "open",
    customerId: "rizhao",
    opportunityId: "op-rizhao-plan",
    opportunityVersion: 4,
    customerVersion: 2,
    previewDigest: "a".repeat(64),
    preview: { title: "重新联系客户", reason: "长期没有互动" },
    snapshot: { suggestionId: "proactive-missing-next-step-1", target: "action", previewDigest: "a".repeat(64) },
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    expiresAt: "2026-09-05T00:30:00.000Z",
    confirmedAt: null,
    confirmedBy: null,
    resultItemId: null,
    replayed: false,
    ...overrides,
  };
}

function sampleQuickRecord(overrides = {}) {
  return {
    id: "qr-1",
    version: 1,
    rawContent: "Rizhao record",
    occurredAt: "2026-06-03T09:00:00+08:00",
    sourceChannel: "field visit",
    customerId: null,
    opportunityId: null,
    status: "recorded",
    confirmationPreviewId: null,
    confirmationPreviewStatus: null,
    ...overrides,
  };
}

function sampleVisitItinerary(overrides = {}) {
  return {
    id: "itinerary-1",
    version: 1,
    title: "济宁客户拜访",
    visitDate: "2026-07-28",
    status: "planned",
    request: {
      title: "济宁客户拜访",
      visitDate: "2026-07-28",
      status: "planned",
      departureAddress: "青岛市黄岛区秀兰禧悦山",
      departureCity: "青岛",
      departureAt: "2026-07-28T00:00:00.000Z",
      stops: [{
        id: "customer-b",
        customerId: "customer-b",
        customerName: "济宁第二人民医院",
        address: "济宁市任城区济宁市第二人民医院",
        city: "济宁",
        priority: "high",
        visitMinutes: 60,
        appointmentAt: null,
        notes: null,
      }],
    },
    plan: {
      orderedStopIds: ["customer-b"],
      stops: [{ id: "customer-b", location: { lng: 116.608817, lat: 35.415405 } }],
      schedule: [{ stopId: "customer-b", sequence: 1 }],
      route: { distanceMeters: 379100, durationSeconds: 15360 },
      summary: "前往济宁第二人民医院。",
      advice: [],
      optimization: { source: "deterministic" },
    },
    createdBy: "jiangjz",
    updatedBy: "jiangjz",
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: "2026-07-27T12:00:00.000Z",
    ...overrides,
  };
}

function sampleTravelExpensePayment(overrides = {}) {
  return {
    id: "payment-1",
    expenseId: "expense-1",
    sequence: 1,
    paidAt: "2026-08-04T12:30:00+08:00",
    merchant: "差旅餐厅",
    amountCents: 6800,
    reimbursementCents: 6800,
    fundingSource: "personal",
    paymentMethod: "wechat",
    accountLast4: "1234",
    differenceReason: null,
    createdAt: "2026-08-04T12:31:00.000Z",
    updatedAt: "2026-08-04T12:31:00.000Z",
    ...overrides,
  };
}

function sampleTravelExpenseAttachment(overrides = {}) {
  return {
    id: "attachment-1",
    expenseId: "expense-1",
    paymentIds: ["payment-1"],
    sequence: 1,
    kind: "payment_proof",
    fileName: "付款截图.png",
    mediaType: "image/png",
    sizeBytes: 1024,
    coveredCents: 6800,
    notes: null,
    createdBy: "jiangjz",
    createdAt: "2026-08-04T12:32:00.000Z",
    contentUrl: "/api/travel-expense-attachments/attachment-1/content",
    ...overrides,
  };
}

function sampleTravelExpense(overrides = {}) {
  return {
    id: "expense-1",
    version: 1,
    owner: "jiangjz",
    referenceCode: "EXP-20260804-ABC12345",
    occurredOn: "2026-08-04",
    category: "lunch",
    purpose: "客户拜访午餐",
    merchant: "差旅餐厅",
    itineraryId: "itinerary-1",
    customerId: "customer-1",
    invoiceStatus: "covered",
    notes: null,
    tripRegion: null,
    tripRegionSource: null,
    payments: [sampleTravelExpensePayment()],
    attachments: [sampleTravelExpenseAttachment()],
    createdBy: "jiangjz",
    updatedBy: "jiangjz",
    createdAt: "2026-08-04T12:31:00.000Z",
    updatedAt: "2026-08-04T12:32:00.000Z",
    ...overrides,
  };
}

function sampleTravelExpenseAdvance(overrides = {}) {
  return {
    id: "advance-1",
    version: 1,
    owner: "jiangjz",
    weekStart: "2026-08-03",
    status: "received",
    requestedCents: 200000,
    receivedCents: 180000,
    requestedOn: "2026-08-01",
    receivedOn: "2026-08-03",
    purpose: "本周差旅备用金",
    notes: null,
    createdBy: "jiangjz",
    updatedBy: "jiangjz",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-03T08:00:00.000Z",
    ...overrides,
  };
}

function sampleShortcutBookkeepingLedgerReceipt(overrides = {}) {
  return {
    entryId: "entry-1",
    expenseId: "expense-1",
    paymentId: "payment-1",
    referenceCode: "EXP-20260804-ABC12345",
    occurredOn: "2026-08-04",
    weekStart: "2026-08-03",
    amountCents: 6800,
    reimbursementCents: 6800,
    attachmentStatus: "matched",
    ...overrides,
  };
}

function sampleShortcutBookkeepingReview(overrides = {}) {
  const status = overrides.status ?? "review_required";
  return {
    id: "entry-1",
    status,
    targetSystem: "sentelligent",
    ledgerName: "出差报销",
    entryType: "expense",
    category: "餐饮",
    subcategory: "午餐",
    note: null,
    warnings: [],
    expenseId: status === "accepted" ? "expense-1" : null,
    paymentId: status === "accepted" ? "payment-1" : null,
    expenseReferenceCode: status === "accepted" ? "EXP-20260804-ABC12345" : null,
    remoteId: null,
    remoteReference: null,
    remoteStatus: null,
    replayed: false,
    ledgerReceipt: status === "accepted" ? sampleShortcutBookkeepingLedgerReceipt() : null,
    rawText: "支付 68 元",
    analysis: { status: "review_required", expense: null },
    analysisProvider: "rules",
    analysisModel: null,
    errorCode: null,
    attemptCount: 1,
    createdAt: "2026-08-04T12:31:00.000Z",
    updatedAt: "2026-08-04T12:31:00.000Z",
    ...overrides,
  };
}

function sampleTravelExpenseWorkbench(overrides = {}) {
  return {
    weekStart: "2026-08-03",
    expenses: [sampleTravelExpense()],
    advances: [sampleTravelExpenseAdvance()],
    bookkeepingReviews: [sampleShortcutBookkeepingReview()],
    regionProfile: {
      weekStart: "2026-08-03",
      weekEnd: "2026-08-09",
      version: 0,
      cities: [],
      defaultCity: null,
      dateOverrides: [],
      createdAt: null,
      updatedAt: null,
    },
    recentLedgerReceipts: [sampleShortcutBookkeepingLedgerReceipt({
      acceptedAt: "2026-08-04T12:32:30.000Z",
    })],
    generatedAt: "2026-08-04T12:33:00.000Z",
    ...overrides,
  };
}

function sampleInvoice(overrides = {}) {
  return {
    id: "invoice-1",
    version: 1,
    source: "manual",
    sourceRef: null,
    fileName: "客户招待发票.pdf",
    mediaType: "application/pdf",
    sizeBytes: 4096,
    sha256: "a".repeat(64),
    status: "review_required",
    extractedText: "发票日期 2026-08-04 合计 100.00 元",
    ocr: { issuedOn: "2026-08-03", totalCents: 9900 },
    model: { issuedOn: "2026-08-04", totalCents: 10000 },
    conflicts: [{ field: "issuedOn", ocrValue: "2026-08-03", modelValue: "2026-08-04" }],
    invoiceCode: null,
    invoiceNumber: "INV-20260804",
    issuedOn: null,
    sellerName: "示例商户",
    buyerName: "森特公司",
    amountExTaxCents: 9434,
    taxCents: 566,
    totalCents: null,
    suggestedCategory: "hospitality",
    createdAt: "2026-08-05T01:00:00.000Z",
    updatedAt: "2026-08-05T01:00:00.000Z",
    contentUrl: "/api/invoices/invoice-1/content",
    ...overrides,
  };
}

function sampleTravelExpenseDocumentCandidate(overrides = {}) {
  return {
    expenseId: "expense-1",
    expenseReferenceCode: "EXP-20260804-ABC12345",
    expenseVersion: 1,
    expenseOccurredOn: "2026-08-04",
    category: "lunch",
    purpose: "客户拜访午餐",
    paymentId: "payment-1",
    paidAt: "2026-08-04T12:30:00+08:00",
    merchant: "差旅餐厅",
    amountCents: 6800,
    reimbursementCents: 6800,
    ...overrides,
  };
}

function sampleTravelExpenseDocumentInbox(overrides = {}) {
  return {
    id: "inbox-1",
    version: 1,
    owner: "jiangjz",
    source: "weixin",
    sourceRef: "wx-message-1",
    documentKind: "payment_proof",
    fileName: "付款截图.png",
    mediaType: "image/png",
    sizeBytes: 1024,
    sha256: "a".repeat(64),
    status: "review_required",
    extractedText: "支付时间 2026-08-04 18:23 金额 48.50 元",
    recognition: {
      evidence: { amountCents: 4850, occurredOn: "2026-08-04", paidTime: "18:23" },
      typedEvidence: { amountCents: null, occurredOn: null, paidTime: null },
      conflicts: [],
      warnings: [],
    },
    matchedExpenseId: null,
    matchedPaymentId: null,
    errorCode: null,
    candidates: [sampleTravelExpenseDocumentCandidate()],
    attachmentId: null,
    createdAt: "2026-08-05T01:00:00.000Z",
    updatedAt: "2026-08-05T01:00:00.000Z",
    ...overrides,
  };
}

function sampleInvoiceMatch(overrides = {}) {
  return {
    id: "match-1",
    version: 1,
    invoiceId: "invoice-1",
    expenseId: "expense-1",
    paymentId: "payment-1",
    allocatedCents: 10000,
    matchMethod: "manual_code",
    state: "confirmed",
    score: null,
    rationale: [],
    createdAt: "2026-08-05T01:10:00.000Z",
    updatedAt: "2026-08-05T01:10:00.000Z",
    ...overrides,
  };
}

function sampleNoInvoiceConfirmation(overrides = {}) {
  return {
    id: "no-invoice-1",
    version: 1,
    expenseId: "expense-1",
    paymentId: "payment-1",
    amountSnapshotCents: 6800,
    reason: "商户暂时无法开票",
    confirmedAt: "2026-08-05T01:20:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function sampleInvoiceCandidate(overrides = {}) {
  return {
    id: "candidate-1",
    version: 1,
    weekStart: "2026-08-03",
    invoiceId: "invoice-1",
    expenseId: "expense-1",
    paymentId: "payment-1",
    proposedCents: 6800,
    score: 0.92,
    rationale: ["金额接近", "日期在本周"],
    status: "suggested",
    createdAt: "2026-08-05T01:30:00.000Z",
    updatedAt: "2026-08-05T01:30:00.000Z",
    ...overrides,
  };
}

it("rejects invoice candidate responses without a concurrency version", async () => {
  const api = createSalesWorkbenchApi({
    baseUrl: "https://example.test",
    fetchImpl: async () => jsonResponse({
      items: [sampleInvoiceCandidate({ version: undefined })],
    }),
  });

  await assert.rejects(
    () => api.listInvoiceCandidates({ weekStart: "2026-08-03" }),
    /invoiceCandidates\.items\[0\]\.version: expected positive integer/,
  );
});

describe("ASR transcription API client", () => {
  const sampleSuccess = (overrides = {}) => ({
    requestId: "asr-request-1",
    item: {
      transcript: "服务端转写文字",
      language: "zh-CN",
      durationMs: 860,
      source: "server_asr",
      replayed: false,
      ...overrides,
    },
  });

  it("parses Retry-After only as a single decimal integer in the inclusive 1..300 range", () => {
    for (const [input, expected] of [["1", 1], ["017", 17], ["300", 300]]) {
      assert.equal(salesWorkbenchApiModule.parseRetryAfterSeconds(input), expected);
    }
    for (const input of [null, undefined, "", "0", "-1", "301", "1.5", "Wed, 30 Aug 2026 10:00:00 GMT", "1, 2", " 1 ", "+1"]) {
      assert.equal(salesWorkbenchApiModule.parseRetryAfterSeconds(input), null, String(input));
    }
  });

  it("posts the raw Blob with Cookie, CSRF, fixed language, duration, key, and AbortSignal", async () => {
    const calls = [];
    const blob = new Blob(["synthetic-audio"], { type: "audio/webm;codecs=opus" });
    const controller = new AbortController();
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse(sampleSuccess());
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    const result = await api.transcribeAudio({
      blob,
      purpose: "quick_record",
      durationMs: 860,
      idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
      signal: controller.signal,
    });

    assert.deepEqual(result, sampleSuccess());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.test/api/asr/transcriptions?purpose=quick_record");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.credentials, "include");
    assert.strictEqual(calls[0].options.body, blob);
    assert.strictEqual(calls[0].options.signal, controller.signal);
    assert.equal(headerValue(calls[0].options, "Content-Type"), "audio/webm;codecs=opus");
    assert.equal(headerValue(calls[0].options, "Idempotency-Key"), "asr:12345678-1234-4234-9234-123456789abc");
    assert.equal(headerValue(calls[0].options, "X-Audio-Duration-Ms"), "860");
    assert.equal(headerValue(calls[0].options, "X-ASR-Language"), "zh-CN");
    assert.equal(headerValue(calls[0].options, "X-CSRF-Token"), "fixture-csrf-token");
    assert.equal(headerValue(calls[0].options, "Authorization"), undefined);
  });

  it("accepts replayed success and enforces the response schema and purpose text limit", async () => {
    const validApi = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => jsonResponse(sampleSuccess({ replayed: true })),
    });
    validApi.setSession({ csrfToken: "fixture-csrf-token" });
    assert.equal((await validApi.transcribeAudio({
      blob: new Blob(["a"], { type: "audio/mp4" }),
      purpose: "assistant_chat",
      durationMs: 860,
      idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
    })).item.replayed, true);

    const allowedControlBoundary = "第一行\n\t第二行\u007F\u0085";
    const boundaryApi = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => jsonResponse(sampleSuccess({ transcript: allowedControlBoundary })),
    });
    boundaryApi.setSession({ csrfToken: "fixture-csrf-token" });
    assert.equal((await boundaryApi.transcribeAudio({
      blob: new Blob(["a"], { type: "audio/mp4" }),
      purpose: "assistant_chat",
      durationMs: 860,
      idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
    })).item.transcript, allowedControlBoundary);

    for (const invalidResponse of [
      { item: sampleSuccess().item },
      sampleSuccess({ source: "browser_speech" }),
      sampleSuccess({ language: "en" }),
      sampleSuccess({ replayed: "false" }),
      sampleSuccess({ transcript: "x".repeat(2_001) }),
      sampleSuccess({ transcript: "" }),
      sampleSuccess({ transcript: "含\u0000控制字符" }),
      sampleSuccess({ transcript: "含\r裸回车" }),
    ]) {
      const api = createSalesWorkbenchApi({
        baseUrl: "https://example.test",
        fetchImpl: async () => jsonResponse(invalidResponse),
      });
      api.setSession({ csrfToken: "fixture-csrf-token" });
      await assert.rejects(() => api.transcribeAudio({
        blob: new Blob(["a"], { type: "audio/mp4" }),
        purpose: "assistant_chat",
        durationMs: 860,
        idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
      }), (error) => {
        assert.equal(error.code, "ASR_PROVIDER_BAD_RESPONSE");
        assert.equal(error.lifecycle, "same_blob_retryable");
        assert.equal(Object.hasOwn(error, "body"), false);
        assert.doesNotMatch(error.message, /provider|secret|nested/i);
        return true;
      });
    }

    const sensitiveFixture = "must-not-cross-client-contract";
    const sanitizedApi = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => jsonResponse({
        ...sampleSuccess({
          replayed: true,
          providerRaw: sensitiveFixture,
          model: sensitiveFixture,
          headers: { authorization: sensitiveFixture },
        }),
        providerResponse: sensitiveFixture,
        internalPath: sensitiveFixture,
      }),
    });
    sanitizedApi.setSession({ csrfToken: "fixture-csrf-token" });
    const sanitized = await sanitizedApi.transcribeAudio({
      blob: new Blob(["a"], { type: "audio/mp4" }),
      purpose: "assistant_chat",
      durationMs: 860,
      idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
    });
    assert.deepEqual(sanitized, sampleSuccess({ replayed: true }));
    assert.doesNotMatch(JSON.stringify(sanitized), /must-not-cross-client-contract/u);
  });

  it("publishes the exact lifecycle whitelist and bounded Retry-After without leaking error bodies", async () => {
    const cases = [
      [409, "ASR_IN_PROGRESS", "same_blob_retryable", 1],
      [429, "ASR_CAPACITY_EXCEEDED", "same_blob_retryable", 2],
      [502, "ASR_PROVIDER_BAD_RESPONSE", "same_blob_retryable", null],
      [504, "ASR_TIMEOUT", "same_blob_retryable", 300],
      [429, "ASR_RATE_LIMITED", "rate_limited", null],
      [400, "INVALID_IDEMPOTENCY_KEY", "release_and_rerecord", null],
      [422, "ASR_TRANSCRIPT_EMPTY", "release_and_rerecord", null],
      [409, "IDEMPOTENCY_CONFLICT", "release_and_rerecord", null],
      [503, "ASR_NOT_CONFIGURED", "release_and_rerecord", null],
    ];
    for (const [status, code, lifecycle, retryAfterSeconds] of cases) {
      const api = createSalesWorkbenchApi({
        baseUrl: "https://example.test",
        fetchImpl: async () => jsonResponse({
          error: { code, message: "sensitive provider detail", requestId: "request-error" },
        }, status, { "Retry-After": retryAfterSeconds ?? "invalid" }),
      });
      api.setSession({ csrfToken: "fixture-csrf-token" });
      await assert.rejects(
        () => api.transcribeAudio({
          blob: new Blob(["a"], { type: "audio/webm" }),
          purpose: "quick_record",
          durationMs: 860,
          idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
        }),
        (error) => {
          assert.equal(error.code, code);
          assert.equal(error.lifecycle, lifecycle);
          assert.equal(error.retryAfterSeconds, retryAfterSeconds);
          assert.equal(Object.hasOwn(error, "body"), false);
          assert.doesNotMatch(error.message, /sensitive provider detail/i);
          return true;
        },
      );
    }
  });

  it("maps network failure to same-Blob retry and abort to release without global unauthorized", async () => {
    const networkApi = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => { throw new TypeError("Failed to fetch sensitive URL"); },
    });
    networkApi.setSession({ csrfToken: "fixture-csrf-token" });
    await assert.rejects(
      () => networkApi.transcribeAudio({
        blob: new Blob(["a"], { type: "audio/webm" }),
        purpose: "quick_record",
        durationMs: 860,
        idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
      }),
      (error) => error.code === "ASR_NETWORK_ERROR" && error.lifecycle === "same_blob_retryable",
    );

    let unauthorizedCalls = 0;
    const abortController = new AbortController();
    abortController.abort("user_cancel");
    const abortApi = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized() { unauthorizedCalls += 1; },
      fetchImpl: async () => {
        const error = new DOMException("Aborted", "AbortError");
        throw error;
      },
    });
    abortApi.setSession({ csrfToken: "fixture-csrf-token" });
    await assert.rejects(() => abortApi.transcribeAudio({
      blob: new Blob(["a"], { type: "audio/webm" }),
      purpose: "quick_record",
      durationMs: 860,
      idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
      signal: abortController.signal,
    }), (error) => error.code === "ASR_ABORTED" && error.lifecycle === "release_and_rerecord");
    assert.equal(unauthorizedCalls, 0);
  });

  it("invalidates once for a non-aborted ASR 401 while returning only the sanitized caller error", async () => {
    let unauthorizedCalls = 0;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized() { unauthorizedCalls += 1; },
      fetchImpl: async () => jsonResponse({
        error: {
          code: "UNAUTHORIZED",
          message: "sensitive session/provider detail",
          requestId: "asr-request-401",
        },
      }, 401),
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });
    await assert.rejects(() => api.transcribeAudio({
      blob: new Blob(["a"], { type: "audio/webm" }),
      purpose: "quick_record",
      durationMs: 860,
      idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
    }), (error) => {
      assert.equal(error.code, "UNAUTHORIZED");
      assert.equal(error.lifecycle, "release_and_rerecord");
      assert.equal(error.status, 401);
      assert.equal(error.requestId, "asr-request-401");
      assert.equal(Object.hasOwn(error, "body"), false);
      assert.doesNotMatch(error.message, /sensitive|provider detail/u);
      return true;
    });
    assert.equal(unauthorizedCalls, 1);
  });

  it("defaults unknown HTTP errors to release instead of misclassifying them as a network interruption", async () => {
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => jsonResponse({ error: { message: "untrusted gateway body" } }, 500),
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });
    await assert.rejects(() => api.transcribeAudio({
      blob: new Blob(["a"], { type: "audio/webm" }),
      purpose: "quick_record",
      durationMs: 860,
      idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
    }), (error) => {
      assert.equal(error.code, "ASR_UNKNOWN_ERROR");
      assert.equal(error.lifecycle, "release_and_rerecord");
      assert.doesNotMatch(error.message, /gateway|untrusted/i);
      return true;
    });
  });

  it("rejects invalid purpose, duration, key, Blob size, and media type before fetch", async () => {
    let fetchCalls = 0;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => { fetchCalls += 1; return jsonResponse(sampleSuccess()); },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });
    const valid = {
      blob: new Blob(["a"], { type: "audio/webm" }),
      purpose: "quick_record",
      durationMs: 860,
      idempotencyKey: "asr:12345678-1234-4234-9234-123456789abc",
    };
    for (const input of [
      { ...valid, purpose: "other" },
      { ...valid, durationMs: 0 },
      { ...valid, durationMs: 120_001 },
      { ...valid, idempotencyKey: "short" },
      { ...valid, blob: new Blob([], { type: "audio/webm" }) },
      { ...valid, blob: new Blob(["a"], { type: "video/webm" }) },
    ]) {
      await assert.rejects(() => api.transcribeAudio(input), TypeError);
    }
    assert.equal(fetchCalls, 0);
  });
});

function sampleAnalysis(overrides = {}) {
  return {
    id: "ai-1",
    quickRecordId: "qr-1",
    source: "mock",
    confidence: 88,
    customer: { id: "rizhao", value: "Rizhao TCM Hospital" },
    opportunity: { id: "op-rizhao-plan", value: "Rizhao TCM five-year plan" },
    weekly: { value: "Wednesday", meta: "weekly draft" },
    summary: {
      request: { title: "request", text: "planning material" },
      feedback: { title: "feedback", text: "cloud concerns" },
      risk: { title: "risk", text: "budget path" },
      action: { title: "action", text: "sync manually" },
    },
    ...overrides,
  };
}

function sampleConfirmation(overrides = {}) {
  return {
    id: "mc-1",
    quickRecordId: "qr-1",
    target: "weekly",
    confirmedBy: "Jizhen",
    note: "manual confirmation",
    createdAt: "2026-06-05 10:30:00",
    ...overrides,
  };
}

function sampleQuickRecordConfirmationPreview(overrides = {}) {
  return {
    schemaVersion: "quick-record-confirmation-v2", id: "preview-1", identity: "a".repeat(64), owner: "Jizhen",
    status: "open", revision: 1, quickRecordId: "qr-1", quickRecordVersion: 4,
    quickRecordStatus: "analyzed", analysisVersionId: "ai-1", analysisStatus: "ready_for_confirmation",
    summary: { title: "确认写入" }, evidence: [], summaryHash: "b".repeat(64), evidenceHash: "c".repeat(64),
    draftHash: "d".repeat(64), items: [], requiresHumanConfirmation: true, automaticWriteAllowed: false,
    createdWithUnsavedChanges: false, createdAt: "2026-06-05T10:30:00.000Z", updatedAt: "2026-06-05T10:30:00.000Z",
    completedAt: null, cancelledAt: null, cancelledBy: null, replayed: false, confirmationBlocked: false,
    bulkEligibleItemIds: [], ...overrides,
  };
}

function sampleQuickRecordConfirmationOutcome(overrides = {}) {
  return {
    status: "confirmed", preview: sampleQuickRecordConfirmationPreview(), confirmedItems: [], excludedItems: [],
    writeback: true, replayed: false, reason: null, details: null, ...overrides,
  };
}

function sampleWeeklyReport(overrides = {}) {
  return {
    id: "wr-1",
    version: 1,
    owner: "Jizhen",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-07",
    status: "draft",
    content: "# weekly draft",
    entries: [],
    sourceRefs: [{ type: "quick_record", id: "qr-1" }],
    source: "mock",
    fallbackReason: null,
    ...overrides,
  };
}

function sampleSolutionDraft(overrides = {}) {
  return {
    id: "sd-1",
    version: 1,
    owner: "Jizhen",
    artifactType: "solution_framework",
    title: "Rizhao solution draft",
    customerId: "rizhao",
    opportunityId: "op-rizhao-plan",
    status: "draft",
    content: "# solution draft",
    sourceRefs: [
      { type: "customer", id: "rizhao" },
      { type: "opportunity", id: "op-rizhao-plan" },
      { type: "action", id: "act-1" },
    ],
    source: "mock",
    fallbackReason: null,
    createdAt: "2026-06-05 10:30:00",
    updatedAt: "2026-06-05 10:30:00",
    ...overrides,
  };
}

function sampleQuickRecordHistory(overrides = {}) {
  const analysis = sampleAnalysis();
  const confirmations = [sampleConfirmation()];
  return sampleQuickRecord({
    status: "confirmed",
    analysis,
    confirmations,
    confirmedTargets: confirmations.map((item) => item.target),
    syncLog: confirmations,
    ...overrides,
  });
}

function bootstrapResponse(url) {
  if (url.endsWith("/api/customers")) return jsonResponse({ items: [sampleCustomer()] });
  if (url.endsWith("/api/opportunities")) return jsonResponse({ items: [sampleOpportunity()] });
  if (url.endsWith("/api/actions")) return jsonResponse({ items: [sampleAction()] });
  if (url.endsWith("/api/risks")) return jsonResponse({ items: [sampleRisk()] });
  if (url.endsWith("/api/knowledge")) return jsonResponse({ items: [sampleKnowledgeItem()] });
  if (url.endsWith("/api/quick-records")) return jsonResponse({ items: [sampleQuickRecordHistory()] });
  if (url.endsWith("/api/solutions")) return jsonResponse({ items: [sampleSolutionDraft()] });
  if (url.endsWith("/api/itineraries")) return jsonResponse({ items: [sampleVisitItinerary()] });
  if (url.endsWith("/api/dashboard/summary")) return jsonResponse({ item: sampleDashboardSummary() });
  if (url.includes("/api/assistant/proactive")) return jsonResponse({ item: sampleProactiveAssistant() });
  return jsonResponse({ error: "not_found" }, 404);
}

describe("sales workbench API client", () => {
  it("creates cryptographically strong UUIDs with a getRandomValues fallback", () => {
    assert.equal(createStrongUuid({ randomUUID: () => "native-uuid" }), "native-uuid");

    let calls = 0;
    const fallback = createStrongUuid({
      getRandomValues(bytes) {
        calls += 1;
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return bytes;
      },
    });
    assert.equal(calls, 1);
    assert.equal(fallback, "00010203-0405-4607-8809-0a0b0c0d0e0f");
    assert.throws(() => createStrongUuid({}), /cryptographic/i);
  });

  it("reuses one in-memory confirmation attempt until identity inputs change or it resets", () => {
    const generated = [];
    const tracker = createConfirmationAttemptTracker({
      createId: () => {
        const id = `attempt-${generated.length + 1}`;
        generated.push(id);
        return id;
      },
    });
    const base = {
      quickRecordId: "qr-1",
      quickRecordVersion: 4,
      analysisVersionId: "ai-1",
      targets: ["customer"],
      targetVersions: { customer: 7 },
    };

    const first = tracker.keyFor(base);
    assert.equal(tracker.keyFor({ ...base, targets: [...base.targets] }), first);
    assert.equal(tracker.keyFor({ ...base, quickRecordVersion: 5 }), first);
    assert.equal(tracker.keyFor({ ...base, targetVersions: { customer: 8 } }), first);
    assert.equal(generated.length, 1);
    assert.notEqual(tracker.keyFor({ ...base, targets: ["opportunity"] }), first);
    assert.notEqual(tracker.keyFor({ ...base, analysisVersionId: "ai-2" }), "attempt-2");
    assert.notEqual(tracker.keyFor({ ...base, quickRecordId: "qr-2" }), "attempt-3");

    const current = tracker.keyFor(base);
    tracker.complete(current);
    assert.notEqual(tracker.keyFor(base), current);
    tracker.reset();
    assert.notEqual(tracker.keyFor(base), generated.at(-2));
  });

  it("resolves an empty API base when no runtime value is configured", () => {
    assert.equal(resolveApiBaseUrl({}), "");
    assert.equal(resolveApiBaseUrl({ VITE_API_BASE_URL: "  " }), "");
    assert.equal(resolveApiBaseUrl({ VITE_API_BASE_URL: "http://127.0.0.1:8787/" }), "http://127.0.0.1:8787");
  });

  it("uses the runtime API base injected by the production static server", () => {
    assert.equal(
      resolveApiBaseUrl({}, { __SENTELLIGENT_API_BASE_URL__: "https://82.156.210.199/" }),
      "https://82.156.210.199",
    );
    assert.equal(
      resolveApiBaseUrl({ VITE_API_BASE_URL: "https://build.example.test" }, { __SENTELLIGENT_API_BASE_URL__: "https://runtime.example.test" }),
      "https://build.example.test",
    );
  });

  it("logs in with Cookie credentials, keeps CSRF in memory, and returns display-only session data", async () => {
    const passwordField = ["pass", "word"].join("");
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/auth/login")) {
          return jsonResponse({
            account: "jiangjz",
            displayName: "姜继振",
            expiresAt: "2026-07-22T00:00:00.000Z",
            csrfToken: "csrf-login",
          });
        }
        return jsonResponse({
          item: {
            status: "waiting_scan",
            qrSvg: "<svg role=\"img\"></svg>",
            message: "二维码已生成",
          },
        });
      },
    });
    api.setSession({ csrfToken: "stale-csrf" });

    const session = await api.login({ account: "jiangjz", [passwordField]: "unit-secret" });
    await api.startWeixinBinding();

    assert.deepEqual(session, {
      account: "jiangjz",
      displayName: "姜继振",
      role: "member",
      expiresAt: "2026-07-22T00:00:00.000Z",
    });
    assert.equal(session.token, undefined);
    assert.equal(session.csrfToken, undefined);
    assert.equal(calls[0].url, "https://example.test/api/auth/login");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(headerValue(calls[0].options, "Authorization"), undefined);
    assert.equal(headerValue(calls[0].options, "X-CSRF-Token"), undefined);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      account: "jiangjz",
      [passwordField]: "unit-secret",
    });
    assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), "csrf-login");
  });

  it("restores a Cookie session without exposing CSRF in the returned display state", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/auth/session")) {
          return jsonResponse({
            account: "jiangjz",
            displayName: "姜继振",
            expiresAt: "2026-07-22T00:00:00.000Z",
            csrfToken: "csrf-restored",
          });
        }
        return jsonResponse({ item: sampleAction({ status: "done" }) });
      },
    });

    const session = await api.restoreSession();
    await api.updateActionStatus("act-1", { status: "done" }, 1);

    assert.deepEqual(session, {
      account: "jiangjz",
      displayName: "姜继振",
      role: "member",
      expiresAt: "2026-07-22T00:00:00.000Z",
    });
    assert.equal(session.token, undefined);
    assert.equal(session.csrfToken, undefined);
    assert.equal(calls[0].url, "https://example.test/api/auth/session");
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(headerValue(calls[0].options, "Authorization"), undefined);
    assert.equal(headerValue(calls[0].options, "X-CSRF-Token"), undefined);
    assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), "csrf-restored");
  });

  it("uses Cookie credentials and CSRF only for authenticated write methods", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (options.method === "PATCH") {
          return jsonResponse({ item: sampleWeeklyReport({ status: "ready" }) });
        }
        return jsonResponse({
          item: {
            status: "waiting_scan",
            qrSvg: "<svg role=\"img\"></svg>",
            message: "二维码已生成",
          },
        });
      },
    });
    api.setSession({ csrfToken: "csrf-methods" });

    await api.startWeixinBinding();
    await api.saveWeeklyReport("wr-1", { status: "ready" }, 1);
    await api.stopWeixinBinding();
    await api.getWeixinBindingStatus();
    await salesWorkbenchApiModule.requestJson(
      apiFetchProbe(calls),
      "https://example.test/api/write-probe",
      {
        method: "POST",
        headers: {
          Authorization: "blocked",
          "X-CSRF-Token": "blocked",
        },
      },
      "csrf-methods",
    );
    await salesWorkbenchApiModule.requestJson(
      apiFetchProbe(calls),
      "https://example.test/api/probe",
      { method: "HEAD" },
      "csrf-methods",
    );

    assert.deepEqual(calls.map(({ options }) => options.method ?? "GET"), [
      "POST",
      "PATCH",
      "DELETE",
      "GET",
      "POST",
      "HEAD",
    ]);
    for (const { options } of calls) {
      assert.equal(options.credentials, "include");
      assert.equal(headerValue(options, "Authorization"), undefined);
    }
    assert.deepEqual(calls.map(({ options }) => headerValue(options, "X-CSRF-Token")), [
      "csrf-methods",
      "csrf-methods",
      "csrf-methods",
      undefined,
      "csrf-methods",
      undefined,
    ]);
  });

  it("does not invalidate an existing session or notify globally for a login 401", async () => {
    const calls = [];
    let unauthorizedCalls = 0;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/auth/login")) {
          return jsonResponse({
            error: {
              code: "INVALID_CREDENTIALS",
              message: "Account or password is incorrect",
              fields: null,
              requestId: "req-login-401",
            },
          }, 401);
        }
        return jsonResponse({
          item: { status: "waiting_scan", message: "二维码已生成" },
        });
      },
    });
    api.setSession({ csrfToken: "csrf-existing" });

    await assert.rejects(
      () => api.login({ account: "jiangjz", password: "wrong" }),
      (error) => error.status === 401 && error.code === "INVALID_CREDENTIALS",
    );
    await api.startWeixinBinding();

    assert.equal(unauthorizedCalls, 0);
    assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), "csrf-existing");
  });

  it("invalidates restored session state on 401 and preserves the structured API error", async () => {
    const calls = [];
    const unauthorizedErrors = [];
    const body = {
      error: {
        code: "UNAUTHORIZED",
        message: "Session expired",
        fields: { session: "expired" },
        requestId: "req-session-401",
      },
    };
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized: (error) => unauthorizedErrors.push(error),
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/auth/session")) return jsonResponse(body, 401);
        return jsonResponse({
          item: { status: "waiting_scan", message: "二维码已生成" },
        });
      },
    });
    api.setSession({ csrfToken: "csrf-expired" });

    let rejectedError;
    await assert.rejects(
      () => api.restoreSession(),
      (error) => {
        rejectedError = error;
        assert.equal(error.status, 401);
        assert.equal(error.code, "UNAUTHORIZED");
        assert.equal(error.message, "Session expired");
        assert.deepEqual(error.fields, { session: "expired" });
        assert.equal(error.requestId, "req-session-401");
        assert.deepEqual(error.body, body);
        return true;
      },
    );
    await api.startWeixinBinding();

    assert.deepEqual(unauthorizedErrors, [rejectedError]);
    assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), undefined);
  });

  it("preserves CSRF state and skips unauthorized notification for 409 responses", async () => {
    const calls = [];
    let unauthorizedCalls = 0;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (calls.length === 1) {
          return jsonResponse({
            error: {
              code: "VERSION_CONFLICT",
              message: "Record changed",
              fields: { currentVersion: 7 },
              requestId: "req-conflict-409",
            },
          }, 409);
        }
        return jsonResponse({
          item: { status: "waiting_scan", message: "二维码已生成" },
        });
      },
    });
    api.setSession({ csrfToken: "csrf-conflict" });

    const patch = { status: "closed" };
    await assert.rejects(
      () => api.updateRiskStatus("risk-1", patch, 6),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "VERSION_CONFLICT");
        assert.deepEqual(error.fields, { currentVersion: 7 });
        assert.equal(error.currentVersion, 7);
        return true;
      },
    );
    await api.startWeixinBinding();

    assert.deepEqual(patch, { status: "closed" });
    assert.equal(headerValue(calls[0].options, "If-Match"), '"6"');
    assert.equal(unauthorizedCalls, 0);
    assert.deepEqual(calls.map(({ options }) => headerValue(options, "X-CSRF-Token")), [
      "csrf-conflict",
      "csrf-conflict",
    ]);
  });

  it("ignores stale restore success after a newer restore failure and session replacement", async () => {
    const firstRestore = deferred();
    const secondRestore = deferred();
    const calls = [];
    let restoreCalls = 0;
    let unauthorizedCalls = 0;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/auth/session")) {
          restoreCalls += 1;
          return restoreCalls === 1 ? firstRestore.promise : secondRestore.promise;
        }
        return jsonResponse({ item: { status: "waiting_scan", message: "二维码已生成" } });
      },
    });

    const staleRestore = api.restoreSession();
    const latestRestore = api.restoreSession();
    secondRestore.resolve(jsonResponse({
      error: {
        code: "UNAUTHORIZED",
        message: "No session",
        requestId: "restore-latest-401",
      },
    }, 401));
    await assert.rejects(() => latestRestore, (error) => error.status === 401);
    api.setSession({ csrfToken: "csrf-new-session" });
    firstRestore.resolve(jsonResponse({
      account: "stale-account",
      displayName: "Stale",
      expiresAt: "2026-07-22T00:00:00.000Z",
      csrfToken: "csrf-stale-restore",
    }));

    await assert.rejects(
      () => staleRestore,
      (error) => error.code === "STALE_SESSION_RESPONSE",
    );
    await api.startWeixinBinding();

    assert.equal(unauthorizedCalls, 1);
    assert.equal(headerValue(calls.at(-1).options, "X-CSRF-Token"), "csrf-new-session");
  });

  it("does not let a stale business 401 clear a newer session", async () => {
    const oldResponse = deferred();
    const calls = [];
    let unauthorizedCalls = 0;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (calls.length === 1) return oldResponse.promise;
        return jsonResponse({ item: { status: "waiting_scan", message: "二维码已生成" } });
      },
    });
    api.setSession({ csrfToken: "csrf-old-session" });

    const oldRequest = api.updateRiskStatus("risk-1", { status: "closed" }, 1);
    api.setSession({ csrfToken: "csrf-new-session" });
    oldResponse.resolve(jsonResponse({
      error: { code: "UNAUTHORIZED", message: "Old request expired", requestId: "old-401" },
    }, 401));
    await assert.rejects(() => oldRequest, (error) => error.status === 401);
    await api.startWeixinBinding();

    assert.equal(unauthorizedCalls, 0);
    assert.equal(headerValue(calls.at(-1).options, "X-CSRF-Token"), "csrf-new-session");
  });

  it("notifies once when concurrent requests fail with 401 in the same session generation", async () => {
    const firstResponse = deferred();
    const secondResponse = deferred();
    let callCount = 0;
    let unauthorizedCalls = 0;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
      fetchImpl: async () => {
        callCount += 1;
        return callCount === 1 ? firstResponse.promise : secondResponse.promise;
      },
    });
    api.setSession({ csrfToken: "csrf-shared" });

    const firstRequest = api.updateRiskStatus("risk-1", { status: "closed" }, 1);
    const secondRequest = api.updateActionStatus("action-1", { status: "done" }, 1);
    firstResponse.resolve(jsonResponse({ error: { code: "UNAUTHORIZED", message: "Expired" } }, 401));
    secondResponse.resolve(jsonResponse({ error: { code: "UNAUTHORIZED", message: "Expired" } }, 401));
    const results = await Promise.allSettled([firstRequest, secondRequest]);

    assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
    assert.equal(unauthorizedCalls, 1);
  });

  it("logs out with Cookie credentials and CSRF, then clears in-memory session state", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/auth/logout")) return jsonResponse(null, 204);
        return jsonResponse({
          item: { status: "waiting_scan", message: "二维码已生成" },
        });
      },
    });
    api.setSession({ csrfToken: "csrf-logout" });

    await api.logout();
    await api.startWeixinBinding();

    assert.equal(calls[0].url, "https://example.test/api/auth/logout");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.body, "{}");
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(headerValue(calls[0].options, "Authorization"), undefined);
    assert.equal(headerValue(calls[0].options, "X-CSRF-Token"), "csrf-logout");
    assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), undefined);
  });

  it("clears in-memory session state after logout network or API failures", async () => {
    for (const failure of [
      new TypeError("offline"),
      jsonResponse({
        error: {
          code: "LOGOUT_FAILED",
          message: "Logout failed",
          fields: null,
          requestId: "req-logout-500",
        },
      }, 500),
    ]) {
      const calls = [];
      const api = createSalesWorkbenchApi({
        baseUrl: "https://example.test",
        fetchImpl: async (url, options = {}) => {
          calls.push({ url, options });
          if (calls.length === 1) {
            if (failure instanceof Error) throw failure;
            return failure;
          }
          return jsonResponse({
            item: { status: "waiting_scan", message: "二维码已生成" },
          });
        },
      });
      api.setSession({ csrfToken: "csrf-logout-failure" });

      await assert.rejects(() => api.logout());
      await api.startWeixinBinding();

      assert.equal(headerValue(calls[0].options, "X-CSRF-Token"), "csrf-logout-failure");
      assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), undefined);
    }
  });

  it("passes the admin role through login responses", async () => {
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => jsonResponse({
        account: "jiangjz",
        displayName: "继振",
        role: "admin",
        expiresAt: "2026-07-22T00:00:00.000Z",
        csrfToken: "csrf-admin-login",
      }),
    });
    const passwordInput = ["pass", "word"].join("");
    const session = await api.login({ account: "jiangjz", [passwordInput]: "unit-login-value" });
    assert.equal(session.role, "admin");
    assert.equal(session.displayName, "继振");
  });

  it("manages users through the admin endpoints with CSRF and expectedVersion in the body", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (String(options.method ?? "GET") === "GET") {
          return jsonResponse({
            items: [{
              account: "jiangjz",
              displayName: "继振",
              role: "admin",
              status: "active",
              createdAt: "2026-08-29T00:00:00.000Z",
              updatedAt: "2026-08-29T00:00:00.000Z",
              lastLoginAt: null,
              version: 1,
            }],
          });
        }
        return jsonResponse({ item: { account: "colleague", version: 2 } });
      },
    });
    api.setSession({ csrfToken: "csrf-admin-login" });

    const users = await api.listUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].account, "jiangjz");
    assert.equal(calls[0].url, "https://example.test/api/admin/users");
    assert.equal(headerValue(calls[0].options, "X-CSRF-Token"), undefined);

    const passwordInput = ["pass", "word"].join("");
    await api.createUser({ account: "colleague", displayName: "同事", role: "member", [passwordInput]: "unit-colleague-value" });
    assert.equal(calls[1].url, "https://example.test/api/admin/users");
    assert.equal(calls[1].options.method, "POST");
    assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), "csrf-admin-login");
    assert.equal(JSON.parse(calls[1].options.body).account, "colleague");

    await api.updateUser("colleague", { expectedVersion: 1, status: "disabled" });
    assert.equal(calls[2].url, "https://example.test/api/admin/users/colleague");
    assert.equal(calls[2].options.method, "PATCH");
    assert.equal(headerValue(calls[2].options, "X-CSRF-Token"), "csrf-admin-login");
    assert.equal(headerValue(calls[2].options, "If-Match"), undefined);
    assert.deepEqual(JSON.parse(calls[2].options.body), { expectedVersion: 1, status: "disabled" });

    const currentField = ["current", "Pass", "word"].join("");
    const nextField = ["new", "Pass", "word"].join("");
    await api.changePassword({ [currentField]: "unit-old-value", [nextField]: "unit-new-value" });
    assert.equal(calls[3].url, "https://example.test/api/auth/change-password");
    assert.equal(calls[3].options.method, "POST");
    assert.equal(headerValue(calls[3].options, "X-CSRF-Token"), "csrf-admin-login");
    assert.deepEqual(Object.keys(JSON.parse(calls[3].options.body)).sort(), [currentField, nextField].sort());
  });

  it("loads bootstrap records and dashboard summary from the configured backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787/",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET" });
        return bootstrapResponse(url);
      },
    });

    const result = await api.loadBootstrap();

    assertApiCollection("customer", result.customers);
    assertApiCollection("opportunity", result.opportunities);
    assertApiCollection("knowledgeItem", result.knowledge);
    assertApiCollection("quickRecord", result.quickRecords);
    assertApiCollection("solutionDraft", result.solutionDocs);
    assertApiCollection("visitItinerary", result.itineraries);
    assert.equal(result.actions[0].sourceRecordId, "qr-1");
    assert.equal(result.risks[0].sourceId, "op-rizhao-plan");
    assertApiEntity("dashboardSummary", result.summary);
    assert.equal(result.summary.metrics.opportunities.value, 2);
    assert.equal(result.quickRecords[0].analysis.id, "ai-1");
    assert.deepEqual(result.quickRecords[0].confirmedTargets, ["weekly"]);
    assert.deepEqual(result.quickRecords[0].syncLog, result.quickRecords[0].confirmations);
    assert.equal(result.knowledge[0].title, "移动云灾备对比清单");
    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:8787/api/customers", method: "GET" },
      { url: "http://127.0.0.1:8787/api/opportunities", method: "GET" },
      { url: "http://127.0.0.1:8787/api/actions", method: "GET" },
      { url: "http://127.0.0.1:8787/api/risks", method: "GET" },
      { url: "http://127.0.0.1:8787/api/knowledge", method: "GET" },
      { url: "http://127.0.0.1:8787/api/quick-records", method: "GET" },
      { url: "http://127.0.0.1:8787/api/solutions", method: "GET" },
      { url: "http://127.0.0.1:8787/api/itineraries", method: "GET" },
      { url: "http://127.0.0.1:8787/api/dashboard/summary", method: "GET" },
    ]);
    assert.equal(result.customers[0].id, "rizhao");
    assert.equal(result.opportunities[0].id, "op-rizhao-plan");
  });

  it("loads the owner-scoped proactive assistant snapshot without opening a write path", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET" });
        return bootstrapResponse(url);
      },
    });
    const result = await api.getProactiveAssistant({ limit: 10 });
    assert.equal(result.schemaVersion, "proactive-assistant-v1");
    assert.equal(result.items[0].trigger.type, "missing_next_step");
    assert.equal(result.items[0].opportunityVersion, 1);
    assert.equal(result.items[0].customerVersion, 1);
    assert.equal(result.items[0].writebackAllowed, false);
    assert.equal(result.items[0].writebackPreview.requiresHumanConfirmation, true);
    assert.deepEqual(result.items[0].previewDigests, { action: "a".repeat(64) });
    assert.deepEqual(calls, [{ url: "https://example.test/api/assistant/proactive?limit=10", method: "GET" }]);
  });

  it("creates, reads, and cancels a durable proactive confirmation preview", async () => {
    const calls = [];
    const preview = sampleProactiveConfirmationPreview();
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body, options });
        if (url.endsWith("/cancel")) {
          return jsonResponse({ item: { ...preview, status: "cancelled", replayed: false } });
        }
        if (options.method === "POST") return jsonResponse({ item: preview }, 201);
        return jsonResponse({ item: preview });
      },
    });
    const created = await api.createProactiveConfirmationPreview(
      preview.suggestionId,
      preview.target,
      "proactive-preview-attempt-0001",
    );
    const fetched = await api.getProactiveConfirmationPreview(preview.suggestionId, preview.id);
    const cancelled = await api.cancelProactiveConfirmationPreview(
      preview.suggestionId,
      preview.id,
      "proactive-preview-cancel-0001",
    );
    assert.equal(created.id, preview.id);
    assert.equal(fetched.status, "open");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(created.suggestionId, preview.suggestionId);
    assert.equal(created.target, "action");
    assert.equal(created.opportunityVersion, 4);
    assert.equal(created.customerVersion, 2);
    assert.equal(created.previewDigest, "a".repeat(64));
    assert.deepEqual(created.preview, preview.preview);
    assert.deepEqual(created.snapshot, preview.snapshot);
    assert.deepEqual(calls.map(({ url, method, body }) => ({ url, method, body })), [
      {
        url: "http://127.0.0.1:8787/api/assistant/proactive/proactive-missing-next-step-1/previews",
        method: "POST",
        body: { target: "action" },
      },
      {
        url: "http://127.0.0.1:8787/api/assistant/proactive/proactive-missing-next-step-1/previews/preview-proactive-1",
        method: "GET",
        body: null,
      },
      {
        url: "http://127.0.0.1:8787/api/assistant/proactive/proactive-missing-next-step-1/previews/preview-proactive-1/cancel",
        method: "POST",
        body: { cancel: true },
      },
    ]);
    assert.equal(headerValue(calls[0].options, "Idempotency-Key"), "proactive-preview-attempt-0001");
    assert.equal(headerValue(calls[2].options, "Idempotency-Key"), "proactive-preview-cancel-0001");
  });

  it("rejects successful bootstrap collection responses that omit an explicit items array", async () => {
    const collections = [
      ["/api/customers", "customers.items"],
      ["/api/opportunities", "opportunities.items"],
      ["/api/actions", "actions.items"],
      ["/api/risks", "risks.items"],
      ["/api/knowledge", "knowledge.items"],
      ["/api/quick-records", "quickRecords.items"],
      ["/api/solutions", "solutions.items"],
      ["/api/itineraries", "itineraries.items"],
    ];

    for (const [malformedPath, expectedPath] of collections) {
      const api = createSalesWorkbenchApi({
        baseUrl: "https://example.test",
        fetchImpl: async (url) => url.endsWith(malformedPath)
          ? jsonResponse({})
          : bootstrapResponse(url),
      });

      await assert.rejects(
        () => api.loadBootstrap(),
        (error) => error instanceof TypeError
          && error.message.includes(expectedPath)
          && /expected array/i.test(error.message),
      );
    }
  });

  it("rejects quick-record bootstrap items that omit persisted analysis and confirmation state", async () => {
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url) => url.endsWith("/api/quick-records")
        ? jsonResponse({ items: [sampleQuickRecord()] })
        : bootstrapResponse(url),
    });

    await assert.rejects(
      () => api.loadBootstrap(),
      (error) => error instanceof TypeError
        && /quickRecords\.items\[0\]\.(analysis|confirmations|confirmedTargets|syncLog)/.test(error.message),
    );
  });

  it("aborts stale bootstrap requests without globally invalidating a successful retry", async () => {
    const staleResponses = [];
    const staleCalls = [];
    let servingStaleBootstrap = true;
    let unauthorizedCalls = 0;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
      fetchImpl: async (url, options = {}) => {
        if (!servingStaleBootstrap) return bootstrapResponse(url);
        const pending = deferred();
        staleResponses.push(pending);
        staleCalls.push({ url, options });
        return pending.promise;
      },
    });
    api.setSession({ csrfToken: "csrf-current-session" });
    const controller = new AbortController();

    const staleBootstrap = api.loadBootstrap({ signal: controller.signal });
    await Promise.resolve();
    servingStaleBootstrap = false;
    controller.abort();
    const latestBootstrap = await api.loadBootstrap();
    assert.equal(latestBootstrap.customers[0].id, "rizhao");

    for (const pending of staleResponses) {
      pending.resolve(jsonResponse({
        error: { code: "UNAUTHORIZED", message: "Stale bootstrap expired" },
      }, 401));
    }
    await assert.rejects(() => staleBootstrap, (error) => error.status === 401);

    assert.equal(staleCalls.length, 9);
    assert.equal(staleCalls.every(({ options }) => options.signal === controller.signal), true);
    assert.equal(unauthorizedCalls, 0);
  });

  it("loads the current quick record and business versions for conflict recovery", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET" });
        if (url.endsWith("/api/quick-records")) {
          return jsonResponse({
            items: [
              sampleQuickRecordHistory({ id: "qr-other", version: 2 }),
              sampleQuickRecordHistory({ id: "qr-1", version: 6 }),
            ],
          });
        }
        if (url.endsWith("/api/customers")) {
          return jsonResponse({ items: [sampleCustomer({ version: 8 })] });
        }
        if (url.endsWith("/api/opportunities")) {
          return jsonResponse({ items: [sampleOpportunity({ version: 10 })] });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const refreshed = await api.refreshQuickRecordConfirmationState("qr-1");

    assert.equal(refreshed.quickRecord.id, "qr-1");
    assert.equal(refreshed.quickRecord.version, 6);
    assert.equal(refreshed.customers[0].version, 8);
    assert.equal(refreshed.opportunities[0].version, 10);
    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:8787/api/quick-records", method: "GET" },
      { url: "http://127.0.0.1:8787/api/customers", method: "GET" },
      { url: "http://127.0.0.1:8787/api/opportunities", method: "GET" },
    ]);
  });

  it("creates a quick record without triggering analysis", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET", body: JSON.parse(options.body) });
        if (url.endsWith("/api/quick-records")) return jsonResponse({ item: sampleQuickRecord({ sourceChannel: "voice" }) }, 201);
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const result = await api.createQuickRecord("Rizhao voice note", {
      occurredAt: "2026-06-03T09:00:00+08:00",
      sourceChannel: "voice",
    });

    assertApiEntity("quickRecord", result);
    assert.equal(result.sourceChannel, "voice");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/quick-records",
        method: "POST",
        body: {
          rawContent: "Rizhao voice note",
          occurredAt: "2026-06-03T09:00:00+08:00",
          sourceChannel: "voice",
          customerId: null,
          opportunityId: null,
        },
      },
    ]);
  });

  it("creates a quick record and then asks the backend to analyze it", async () => {
    const bodies = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        bodies.push({ url, body: options.body ? JSON.parse(options.body) : null });
        if (url.endsWith("/api/quick-records")) return jsonResponse({ item: sampleQuickRecord() }, 201);
        if (url.endsWith("/api/quick-records/qr-1/analyze")) {
          return jsonResponse({
            item: sampleAnalysis(),
            quickRecord: sampleQuickRecord({ status: "analyzed" }),
          }, 201);
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const result = await api.analyzeQuickRecord("Rizhao record", {
      occurredAt: "2026-06-03T09:00:00+08:00",
      sourceChannel: "field visit",
    });

    assert.equal(result.quickRecord.id, "qr-1");
    assertApiEntity("quickRecord", result.quickRecord);
    assertApiEntity("aiInsight", result.analysis);
    assert.equal(result.analysis.customer.value, "Rizhao TCM Hospital");
    assert.equal(result.quickRecord.status, "analyzed");
    assert.deepEqual(bodies.map((item) => item.url), [
      "http://127.0.0.1:8787/api/quick-records",
      "http://127.0.0.1:8787/api/quick-records/qr-1/analyze",
    ]);
    assert.equal(bodies[0].body.rawContent, "Rizhao record");
    assert.equal(bodies[0].body.sourceChannel, "field visit");
  });

  it("saves editable quick-record analysis with CSRF and a quoted entity version", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return jsonResponse({
          quickRecord: sampleQuickRecord({ version: 5, status: "confirmed" }),
          analysis: sampleAnalysis({
            summary: {
              ...sampleAnalysis().summary,
              request: { title: "request", text: "manually saved request" },
            },
          }),
        });
      },
    });
    api.setSession({ csrfToken: "analysis-csrf" });

    const result = await api.saveQuickRecordAnalysis("qr-1", {
      request: { title: "request", text: "manually saved request" },
      feedback: { title: "feedback", text: "saved feedback" },
      risk: { title: "risk", text: "saved risk" },
      action: { title: "action", text: "saved action" },
    }, 4);

    assert.equal(result.quickRecord.version, 5);
    assert.equal(result.analysis.summary.request.text, "manually saved request");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:8787/api/quick-records/qr-1/analysis");
    assert.equal(calls[0].options.method, "PATCH");
    assert.equal(headerValue(calls[0].options, "If-Match"), '"4"');
    assert.equal(headerValue(calls[0].options, "X-CSRF-Token"), "analysis-csrf");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      summary: {
        request: "manually saved request",
        feedback: "saved feedback",
        risk: "saved risk",
        action: "saved action",
      },
    });
  });

  it("creates and updates customer and opportunity records through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body });
        if (url.endsWith("/api/customers") && options.method === "POST") {
          return jsonResponse({ item: sampleCustomer({ id: "jiaozhou", name: body.name, level: body.level }) }, 201);
        }
        if (url.endsWith("/api/customers/jiaozhou") && options.method === "PATCH") {
          return jsonResponse({ item: sampleCustomer({ id: "jiaozhou", name: "胶州中医医院", level: body.level, relation: body.relation }) });
        }
        if (url.endsWith("/api/opportunities") && options.method === "POST") {
          return jsonResponse({ item: sampleOpportunity({ id: "op-jiaozhou-plan", customerId: body.customerId, name: body.name }) }, 201);
        }
        if (url.endsWith("/api/opportunities/op-jiaozhou-plan") && options.method === "PATCH") {
          return jsonResponse({ item: sampleOpportunity({ id: "op-jiaozhou-plan", stage: body.stage, probability: body.probability }) });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const createdCustomer = await api.saveCustomer({
      name: "胶州中医医院",
      level: "新建线索",
      relation: 35,
    });
    const updatedCustomer = await api.saveCustomer({
      id: "jiaozhou",
      version: createdCustomer.version,
      level: "重点培育",
      relation: 52,
    });
    const createdOpportunity = await api.saveOpportunity({
      customerId: "jiaozhou",
      name: "胶州中医医院规划调研",
      stage: "线索",
    });
    const updatedOpportunity = await api.saveOpportunity({
      id: "op-jiaozhou-plan",
      version: createdOpportunity.version,
      stage: "初步沟通",
      probability: 45,
    });

    assertApiEntity("customer", createdCustomer);
    assertApiEntity("customer", updatedCustomer);
    assertApiEntity("opportunity", createdOpportunity);
    assertApiEntity("opportunity", updatedOpportunity);
    assert.equal(updatedCustomer.level, "重点培育");
    assert.equal(updatedOpportunity.stage, "初步沟通");
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ["POST", "http://127.0.0.1:8787/api/customers"],
      ["PATCH", "http://127.0.0.1:8787/api/customers/jiaozhou"],
      ["POST", "http://127.0.0.1:8787/api/opportunities"],
      ["PATCH", "http://127.0.0.1:8787/api/opportunities/op-jiaozhou-plan"],
    ]);
    assert.deepEqual(calls[1].body, {
      level: "重点培育",
      relation: 52,
    });
    assert.deepEqual(calls[3].body, {
      stage: "初步沟通",
      probability: 45,
    });
  });

  it("creates, updates, and searches knowledge items through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body });
        if (url.endsWith("/api/knowledge") && options.method === "POST") {
          return jsonResponse({ item: sampleKnowledgeItem({ id: "k-rizhao-plan", title: body.title, tags: body.tags }) }, 201);
        }
        if (url.endsWith("/api/knowledge/k-rizhao-plan") && options.method === "PATCH") {
          return jsonResponse({ item: sampleKnowledgeItem({ id: "k-rizhao-plan", summary: body.summary }) });
        }
        if (url.endsWith("/api/knowledge/search") && options.method === "POST") {
          return jsonResponse({ items: [sampleKnowledgeItem({ id: "k-rizhao-plan", title: "日照十五五规划知识卡" })] });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const created = await api.saveKnowledgeItem({
      title: "日照十五五规划知识卡",
      category: "方案材料",
      tags: ["日照", "移动云"],
      summary: "用于方案材料。",
      content: "移动云灾备对比。",
    });
    const updated = await api.saveKnowledgeItem({
      id: "k-rizhao-plan",
      version: created.version,
      summary: "已更新为领导汇报口径。",
    });
    const searched = await api.searchKnowledge({
      query: "日照 移动云",
      tags: ["移动云"],
    });

    assertApiEntity("knowledgeItem", created);
    assertApiEntity("knowledgeItem", updated);
    assertApiCollection("knowledgeItem", searched);
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ["POST", "http://127.0.0.1:8787/api/knowledge"],
      ["PATCH", "http://127.0.0.1:8787/api/knowledge/k-rizhao-plan"],
      ["POST", "http://127.0.0.1:8787/api/knowledge/search"],
    ]);
    assert.deepEqual(calls[1].body, {
      summary: "已更新为领导汇报口径。",
    });
    assert.deepEqual(calls[2].body, { query: "日照 移动云", tags: ["移动云"] });
  });

  it("sends only writable fields when saving full customer, opportunity, and knowledge entities", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method, body: JSON.parse(options.body) });
        if (url.includes("/api/customers/")) return jsonResponse({ item: sampleCustomer() });
        if (url.includes("/api/opportunities/")) return jsonResponse({ item: sampleOpportunity() });
        return jsonResponse({ item: sampleKnowledgeItem() });
      },
    });

    const customer = sampleCustomer({
      createdAt: "2026-07-15T08:00:00.000Z",
      updatedAt: "2026-07-15T09:00:00.000Z",
      version: 7,
      deletedAt: null,
      serverComputed: "readonly",
    });
    const opportunity = sampleOpportunity({
      createdAt: "2026-07-15T08:00:00.000Z",
      updatedAt: "2026-07-15T09:00:00.000Z",
      version: 8,
      deletedAt: null,
      serverComputed: "readonly",
    });
    const knowledge = sampleKnowledgeItem({
      version: 9,
      deletedAt: null,
      serverComputed: "readonly",
    });

    await api.saveCustomer(customer);
    await api.saveOpportunity(opportunity);
    await api.saveKnowledgeItem(knowledge);

    assert.deepEqual(calls[0], {
      url: "http://127.0.0.1:8787/api/customers/rizhao",
      method: "PATCH",
      body: {
        name: customer.name,
        region: customer.region,
        type: customer.type,
        level: customer.level,
        contact: customer.contact,
        relation: customer.relation,
        stakeholders: customer.stakeholders,
        decisionChain: customer.decisionChain,
        historyProjects: customer.historyProjects,
        infrastructure: customer.infrastructure,
        syncPreview: customer.syncPreview,
        budget: customer.budget,
        summary: customer.summary,
        needs: customer.needs,
        risks: customer.risks,
        opportunities: customer.opportunities,
      },
    });
    assert.deepEqual(calls[1], {
      url: "http://127.0.0.1:8787/api/opportunities/op-rizhao-plan",
      method: "PATCH",
      body: {
        customerId: opportunity.customerId,
        name: opportunity.name,
        customer: opportunity.customer,
        stage: opportunity.stage,
        amount: opportunity.amount,
        probability: opportunity.probability,
        days: opportunity.days,
        requirements: opportunity.requirements,
        competitors: opportunity.competitors,
        solutionDirection: opportunity.solutionDirection,
        sourceRecord: opportunity.sourceRecord,
        risk: opportunity.risk,
        next: opportunity.next,
        tone: opportunity.tone,
      },
    });
    assert.deepEqual(calls[2], {
      url: "http://127.0.0.1:8787/api/knowledge/k-mobile-cloud",
      method: "PATCH",
      body: {
        title: knowledge.title,
        category: knowledge.category,
        tags: knowledge.tags,
        summary: knowledge.summary,
        content: knowledge.content,
        source: knowledge.source,
      },
    });
  });

  it("uses the same writable field allowlists for customer, opportunity, and knowledge creates", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = JSON.parse(options.body);
        calls.push({ url, method: options.method, body });
        if (url.endsWith("/api/customers")) return jsonResponse({ item: sampleCustomer({ name: body.name }) }, 201);
        if (url.endsWith("/api/opportunities")) return jsonResponse({ item: sampleOpportunity({ name: body.name }) }, 201);
        return jsonResponse({ item: sampleKnowledgeItem({ title: body.title }) }, 201);
      },
    });

    const readonly = {
      createdAt: "2026-07-15T08:00:00.000Z",
      updatedAt: "2026-07-15T09:00:00.000Z",
      version: 1,
      deletedAt: null,
      serverComputed: "readonly",
    };
    await api.saveCustomer({ name: "New customer", region: "East", ...readonly });
    await api.saveOpportunity({ customerId: "rizhao", name: "New opportunity", probability: 50, ...readonly });
    await api.saveKnowledgeItem({ title: "New knowledge", tags: ["tag"], ...readonly });

    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/customers",
        method: "POST",
        body: { name: "New customer", region: "East" },
      },
      {
        url: "http://127.0.0.1:8787/api/opportunities",
        method: "POST",
        body: { customerId: "rizhao", name: "New opportunity", probability: 50 },
      },
      {
        url: "http://127.0.0.1:8787/api/knowledge",
        method: "POST",
        body: { title: "New knowledge", tags: ["tag"] },
      },
    ]);
  });

  it("requires positive integer versions in all mutable public entity contracts", () => {
    const cases = [
      ["customer", sampleCustomer({ version: 0 })],
      ["opportunity", sampleOpportunity({ version: 0 })],
      ["quickRecord", sampleQuickRecord({ version: 0 })],
      ["weeklyReport", sampleWeeklyReport({ version: 0 })],
      ["solutionDraft", sampleSolutionDraft({ version: 0 })],
      ["actionItem", sampleAction({ version: 0 })],
      ["riskItem", sampleRisk({ version: 0 })],
      ["knowledgeItem", sampleKnowledgeItem({ version: 0 })],
    ];

    for (const [entityName, entity] of cases) {
      assert.throws(
        () => assertApiEntity(entityName, entity),
        /positiveInteger/,
        entityName,
      );
    }
  });

  it("sends quoted If-Match versions for PATCH and DELETE methods", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (options.method === "DELETE") {
          if (url.includes("/reports/weekly/")) return jsonResponse({ deleted: sampleWeeklyReport({ version: 3 }) });
          if (url.includes("/customers/")) return jsonResponse({ deleted: sampleCustomer({ version: 3 }) });
          if (url.includes("/opportunities/")) return jsonResponse({ deleted: sampleOpportunity({ version: 3 }) });
          if (url.includes("/knowledge/")) return jsonResponse({ deleted: sampleKnowledgeItem({ version: 3 }) });
          if (url.includes("/actions/")) return jsonResponse({ deleted: sampleAction({ version: 3 }) });
          return jsonResponse({ deleted: sampleRisk({ version: 3 }) });
        }
        if (url.includes("/customers/")) return jsonResponse({ item: sampleCustomer({ version: 3 }) });
        if (url.includes("/opportunities/")) return jsonResponse({ item: sampleOpportunity({ version: 3 }) });
        if (url.includes("/knowledge/")) return jsonResponse({ item: sampleKnowledgeItem({ version: 3 }) });
        if (url.includes("/actions/")) return jsonResponse({ item: sampleAction({ version: 3 }) });
        if (url.includes("/risks/")) return jsonResponse({ item: sampleRisk({ version: 3 }) });
        if (url.includes("/reports/weekly/")) return jsonResponse({ item: sampleWeeklyReport({ version: 3 }) });
        return jsonResponse({ item: sampleSolutionDraft({ version: 3 }) });
      },
    });

    await api.saveCustomer(sampleCustomer({ version: 2 }));
    await api.saveOpportunity(sampleOpportunity({ version: 2 }));
    await api.saveKnowledgeItem(sampleKnowledgeItem({ version: 2 }));
    await api.updateActionStatus("act-1", { status: "done" }, 2);
    await api.updateRiskStatus("risk-1", { status: "closed" }, 2);
    await api.saveWeeklyReport("wr-1", { status: "saved" }, 2);
    await api.saveSolutionDraft("sd-1", { status: "saved" }, 2);
    await api.deleteCustomer("rizhao", 2);
    await api.deleteOpportunity("op-rizhao-plan", 2);
    await api.deleteKnowledgeItem("k-mobile-cloud", 2);
    await api.deleteAction("act-1", 2);
    await api.deleteRisk("risk-1", 2);
    await api.deleteWeeklyReport("wr-1", 2);

    assert.equal(calls.length, 13);
    for (const call of calls) {
      assert.equal(headerValue(call.options, "If-Match"), '"2"', call.url);
    }
  });

  it("updates risk status through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body });
        if (url.endsWith("/api/risks/risk-1") && options.method === "PATCH") {
          return jsonResponse({ item: sampleRisk({ status: body.status, action: body.action, assignee: body.assignee, due: body.due }) });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const updated = await api.updateRiskStatus("risk-1", {
      status: "in_progress",
      assignee: "Presales Li",
      due: "Friday 17:00",
      action: "已安排售前确认预算路径。",
    }, 1);

    assertApiEntity("riskItem", updated);
    assert.equal(updated.status, "in_progress");
    assert.equal(updated.assignee, "Presales Li");
    assert.equal(updated.due, "Friday 17:00");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/risks/risk-1",
        method: "PATCH",
        body: {
          status: "in_progress",
          assignee: "Presales Li",
          due: "Friday 17:00",
          action: "已安排售前确认预算路径。",
        },
      },
    ]);
  });

  it("updates action status, assignee, and due date through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body });
        if (url.endsWith("/api/actions/act-1") && options.method === "PATCH") {
          return jsonResponse({
            item: sampleAction({
              status: body.status,
              due: body.due,
              assignee: body.assignee,
            }),
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const updated = await api.updateActionStatus("act-1", {
      status: "deferred",
      due: "Friday 17:00",
      assignee: "Presales Li",
    }, 1);

    assertApiEntity("actionItem", updated);
    assert.equal(updated.status, "deferred");
    assert.equal(updated.assignee, "Presales Li");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/actions/act-1",
        method: "PATCH",
        body: {
          status: "deferred",
          due: "Friday 17:00",
          assignee: "Presales Li",
        },
      },
    ]);
  });

  it("deletes business records through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET" });
        if (url.endsWith("/api/customers/customer-1")) return jsonResponse({ deleted: sampleCustomer({ id: "customer-1" }) });
        if (url.endsWith("/api/opportunities/opportunity-1")) {
          return jsonResponse({ deleted: sampleOpportunity({ id: "opportunity-1" }) });
        }
        if (url.endsWith("/api/knowledge/knowledge-1")) return jsonResponse({ deleted: sampleKnowledgeItem({ id: "knowledge-1" }) });
        if (url.endsWith("/api/actions/action-1")) return jsonResponse({ deleted: sampleAction({ id: "action-1" }) });
        if (url.endsWith("/api/risks/risk-1")) return jsonResponse({ deleted: sampleRisk({ id: "risk-1" }) });
        return jsonResponse({ deleted: { id: url.split("/").at(-1) } });
      },
    });

    await api.deleteCustomer("customer-1", 1);
    await api.deleteOpportunity("opportunity-1", 1);
    await api.deleteKnowledgeItem("knowledge-1", 1);
    await api.deleteAction("action-1", 1);
    await api.deleteRisk("risk-1", 1);

    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:8787/api/customers/customer-1", method: "DELETE" },
      { url: "http://127.0.0.1:8787/api/opportunities/opportunity-1", method: "DELETE" },
      { url: "http://127.0.0.1:8787/api/knowledge/knowledge-1", method: "DELETE" },
      { url: "http://127.0.0.1:8787/api/actions/action-1", method: "DELETE" },
      { url: "http://127.0.0.1:8787/api/risks/risk-1", method: "DELETE" },
    ]);
  });

  it("creates an action through the backend with only writable create fields", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body });
        return jsonResponse({
          item: sampleAction({
            id: "act-created",
            title: body.title,
            remindAt: body.remindAt,
            priority: body.priority,
          }),
        }, 201);
      },
    });

    const created = await api.createAction({
      title: "整理灾备对比表",
      customerId: "rizhao",
      priority: "高",
      due: "周五 17:00",
      remindAt: "2026-09-01T02:30:00.000Z",
      owner: "someone-else",
      id: "client-forged-id",
      version: 99,
    });

    assertApiEntity("actionItem", created);
    assert.equal(created.id, "act-created");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/actions",
        method: "POST",
        body: {
          title: "整理灾备对比表",
          customerId: "rizhao",
          priority: "高",
          due: "周五 17:00",
          remindAt: "2026-09-01T02:30:00.000Z",
        },
      },
    ]);
  });

  it("confirms proactive writeback with an idempotency key and sanitized preview", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body, options });
        return jsonResponse({ item: sampleProactiveWritebackOutcome() }, 201);
      },
    });

    const outcome = await api.confirmProactiveWriteback(
      "proactive-missing-next-step-1",
      {
        target: "action",
        customerId: "rizhao",
        opportunityId: "op-rizhao-plan",
        confirmationPreviewId: "preview-proactive-1",
      expectedOpportunityVersion: 4,
        expectedCustomerVersion: 2,
        previewDigest: "a".repeat(64),
        preview: {
          title: "重新联系客户",
          reason: "长期没有互动",
          customerId: "rizhao",
          opportunityId: "op-rizhao-plan",
          owner: "forged-owner",
          actor: "forged-actor",
        },
      },
      "proactive-attempt-0001",
    );

    assert.equal(outcome.status, "created");
    assert.equal(outcome.action.id, "act-proactive");
    assert.deepEqual(calls.map(({ url, method, body }) => ({ url, method, body })), [
      {
        url: "http://127.0.0.1:8787/api/assistant/proactive/proactive-missing-next-step-1/confirm",
        method: "POST",
        body: {
          confirmationPreviewId: "preview-proactive-1",
          target: "action",
          customerId: "rizhao",
          opportunityId: "op-rizhao-plan",
          expectedOpportunityVersion: 4,
          expectedCustomerVersion: 2,
          previewDigest: "a".repeat(64),
          preview: {
            title: "重新联系客户",
            reason: "长期没有互动",
            customerId: "rizhao",
            opportunityId: "op-rizhao-plan",
          },
        },
      },
    ]);
    assert.equal(headerValue(calls[0].options, "Idempotency-Key"), "proactive-attempt-0001");
  });

  it("accepts replayed proactive writeback outcomes without treating them as errors", async () => {
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async () => jsonResponse({
        item: sampleProactiveWritebackOutcome({ status: "replayed", replayed: true }),
      }),
    });
    const outcome = await api.confirmProactiveWriteback(
      "proactive-missing-next-step-1",
      {
        target: "action",
        customerId: "rizhao",
        opportunityId: "op-rizhao-plan",
        confirmationPreviewId: "preview-proactive-1",
        expectedOpportunityVersion: 1,
        expectedCustomerVersion: 1,
        previewDigest: "a".repeat(64),
        preview: { title: "重新联系客户" },
      },
      "proactive-attempt-0002",
    );
    assert.equal(outcome.status, "replayed");
    assert.equal(outcome.replayed, true);
  });

  it("rejects a proactive writeback response missing the confirmed target entity", async () => {
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async () => jsonResponse({
        item: sampleProactiveWritebackOutcome({ action: null }),
      }),
    });
    await assert.rejects(
      () => api.confirmProactiveWriteback(
        "proactive-missing-next-step-1",
        {
          target: "action",
          customerId: "rizhao",
          opportunityId: "op-rizhao-plan",
          confirmationPreviewId: "preview-proactive-1",
          expectedOpportunityVersion: 1,
          expectedCustomerVersion: 1,
          previewDigest: "a".repeat(64),
          preview: { title: "重新联系客户" },
        },
        "proactive-attempt-0003",
      ),
      /expected action item/u,
    );
  });

  it("uses the five durable quick-record confirmation preview APIs without caller identity fields", async () => {
    const calls = [];
    const preview = sampleQuickRecordConfirmationPreview();
    const outcome = sampleQuickRecordConfirmationOutcome({ preview });
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body });
        if (url.endsWith("/api/quick-records/qr-1/confirmation-previews")) return jsonResponse({ item: preview }, 201);
        if (url.endsWith("/api/quick-record-confirmation-previews/preview-1")) return jsonResponse({ item: preview });
        if (url.endsWith("/confirm-item") || url.endsWith("/confirm-all")) return jsonResponse({ item: outcome });
        if (url.endsWith("/cancel")) return jsonResponse({ item: preview });
        return jsonResponse({ error: "not_found" }, 404);
      },
    });
    const pins = { confirm: true, suggestionIdentity: "a".repeat(64), expectedQuickRecordVersion: 4, analysisVersionId: "ai-1", summaryHash: "b".repeat(64), evidenceHash: "c".repeat(64) };
    assert.equal((await api.createQuickRecordConfirmationPreview("qr-1")).id, "preview-1");
    assert.equal((await api.getQuickRecordConfirmationPreview("preview-1")).id, "preview-1");
    await api.confirmQuickRecordConfirmationItem("preview-1", { ...pins, itemId: "customer-needs", itemIdentity: "e".repeat(64), owner: "forged", actor: "forged", confirmedBy: "forged", cancelledBy: "forged" });
    await api.confirmAllQuickRecordConfirmationItems("preview-1", { ...pins, owner: "forged", actor: "forged", confirmedBy: "forged", cancelledBy: "forged" });
    await api.cancelQuickRecordConfirmationPreview("preview-1", { cancel: true, suggestionIdentity: "a".repeat(64), owner: "forged", actor: "forged", confirmedBy: "forged", cancelledBy: "forged" });
    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:8787/api/quick-records/qr-1/confirmation-previews", method: "POST", body: {} },
      { url: "http://127.0.0.1:8787/api/quick-record-confirmation-previews/preview-1", method: "GET", body: null },
      { url: "http://127.0.0.1:8787/api/quick-record-confirmation-previews/preview-1/confirm-item", method: "POST", body: { ...pins, itemId: "customer-needs", itemIdentity: "e".repeat(64) } },
      { url: "http://127.0.0.1:8787/api/quick-record-confirmation-previews/preview-1/confirm-all", method: "POST", body: pins },
      { url: "http://127.0.0.1:8787/api/quick-record-confirmation-previews/preview-1/cancel", method: "POST", body: { cancel: true, suggestionIdentity: "a".repeat(64) } },
    ]);
  });

  it("rejects malformed durable quick-record confirmation outcomes", async () => {
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async () => jsonResponse({ item: sampleQuickRecordConfirmationOutcome({ confirmedItems: "not-an-array" }) }),
    });
    await assert.rejects(
      () => api.confirmAllQuickRecordConfirmationItems("preview-1", { confirm: true, suggestionIdentity: "a".repeat(64), expectedQuickRecordVersion: 4, analysisVersionId: "ai-1", summaryHash: "b".repeat(64), evidenceHash: "c".repeat(64) }),
      /confirmedItems: expected array/,
    );
  });


  it("generates weekly and solution drafts through explicit backend calls", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url.endsWith("/api/reports/weekly/draft")) return jsonResponse({ item: sampleWeeklyReport() }, 201);
        if (url.endsWith("/api/solutions/draft")) return jsonResponse({ item: sampleSolutionDraft() }, 201);
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const weekly = await api.generateWeeklyDraft({
      owner: "Jizhen",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-07",
      knowledgeIds: ["k-mobile-cloud"],
    });
    const solution = await api.generateSolutionDraft({
      owner: "Jizhen",
      customerId: "rizhao",
      opportunityId: "op-rizhao-plan",
      artifactType: "communication_outline",
      knowledgeIds: ["k-mobile-cloud"],
    });
    // v0.9.2：即使调用方仍传 owner，客户端也不再发送——owner 由服务端按会话注入。

    assertApiEntity("weeklyReport", weekly);
    assertApiEntity("solutionDraft", solution);
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/reports/weekly/draft",
        body: { periodStart: "2026-06-01", periodEnd: "2026-06-07", knowledgeIds: ["k-mobile-cloud"] },
      },
      {
        url: "http://127.0.0.1:8787/api/solutions/draft",
        body: {
          customerId: "rizhao",
          opportunityId: "op-rizhao-plan",
          artifactType: "communication_outline",
          knowledgeIds: ["k-mobile-cloud"],
        },
      },
    ]);
    assert.equal(solution.artifactType, "solution_framework");
    assert.equal(solution.sourceRefs.length, 3);
  });

  it("saves weekly report edits and downloads the authenticated Word Blob", async () => {
    const calls = [];
    const wordBlob = new Blob(["weekly report"], { type: "application/msword" });
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/reports/weekly/wr-1")) {
          return jsonResponse({
            item: sampleWeeklyReport({
              content: "# edited weekly report",
              status: "ready",
            }),
          });
        }
        if (url.endsWith("/api/reports/weekly/wr-1/export?format=word")) {
          return blobResponse(wordBlob, 200, {
            "Content-Type": "application/msword",
            "Content-Disposition": "attachment; filename=\"weekly-report-2026-06-01-2026-06-07.doc\"",
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });
    api.setSession({ csrfToken: "csrf-export" });

    const saved = await api.saveWeeklyReport("wr-1", {
      content: "# edited weekly report",
      status: "ready",
    }, 1);
    const downloaded = await api.downloadWeeklyReport("wr-1", "word");

    assertApiEntity("weeklyReport", saved);
    assert.equal(saved.status, "ready");
    assert.equal(saved.content, "# edited weekly report");
    assert.equal(api.getWeeklyReportExportUrl, undefined);
    assert.equal(downloaded.blob, wordBlob);
    assert.equal(downloaded.blob instanceof Blob, true);
    assert.equal(downloaded.blob.type, "application/msword");
    assert.equal(downloaded.filename, "weekly-report-2026-06-01-2026-06-07.doc");
    assert.equal(calls[0].url, "http://127.0.0.1:8787/api/reports/weekly/wr-1");
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(headerValue(calls[0].options, "X-CSRF-Token"), "csrf-export");
    assert.equal(calls[1].url, "http://127.0.0.1:8787/api/reports/weekly/wr-1/export?format=word");
    assert.equal(calls[1].url.includes(["tok", "en="].join("")), false);
    assert.equal(calls[1].options.method, "GET");
    assert.equal(calls[1].options.credentials, "include");
    assert.equal(headerValue(calls[1].options, "Authorization"), undefined);
    assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), undefined);
  });

  it("uses a .doc fallback filename when the export response has no headers mock", async () => {
    const wordBlob = new Blob(["weekly report"], { type: "application/msword" });
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        blob: async () => wordBlob,
      }),
    });

    const downloaded = await api.downloadWeeklyReport("wr-1");

    assert.equal(downloaded.blob, wordBlob);
    assert.equal(downloaded.filename, "weekly-report.doc");
  });

  it("reuses structured API errors and invalidates the session for export 401", async () => {
    const calls = [];
    let unauthorizedCalls = 0;
    const body = {
      error: {
        code: "UNAUTHORIZED",
        message: "Session expired during export",
        fields: null,
        requestId: "req-export-401",
      },
    };
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.includes("/export?")) return jsonResponse(body, 401);
        return jsonResponse({ item: { status: "waiting_scan", message: "二维码已生成" } });
      },
    });
    api.setSession({ csrfToken: "csrf-export-expired" });

    await assert.rejects(
      () => api.downloadWeeklyReport("wr-1", "word"),
      (error) => {
        assert.equal(error.status, 401);
        assert.equal(error.code, "UNAUTHORIZED");
        assert.equal(error.fields, null);
        assert.equal(error.requestId, "req-export-401");
        assert.deepEqual(error.body, body);
        return true;
      },
    );
    await api.startWeixinBinding();

    assert.equal(unauthorizedCalls, 1);
    assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), undefined);
  });

  it("saves solution draft edits through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET", body: JSON.parse(options.body ?? "{}") });
        if (url.endsWith("/api/solutions/sd-1") && options.method === "PATCH") {
          return jsonResponse({
            item: sampleSolutionDraft({
              content: "# edited solution artifact",
              status: "saved",
            }),
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const saved = await api.saveSolutionDraft("sd-1", {
      content: "# edited solution artifact",
      status: "saved",
    }, 1);

    assertApiEntity("solutionDraft", saved);
    assert.equal(saved.status, "saved");
    assert.equal(saved.content, "# edited solution artifact");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/solutions/sd-1",
        method: "PATCH",
        body: { content: "# edited solution artifact", status: "saved" },
      },
    ]);
  });

  it("generates manual AI suggestions through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url.endsWith("/api/ai/suggestions")) {
          return jsonResponse({
            item: sampleAiSuggestion(),
          }, 201);
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const suggestion = await api.generateAiSuggestion({
      type: "customer_profile",
      title: "生成客户画像补全建议",
      context: { customer: "日照中医医院" },
    });

    assertApiEntity("aiSuggestion", suggestion);
    assert.equal(suggestion.status, "pending");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/ai/suggestions",
        body: {
          type: "customer_profile",
          title: "生成客户画像补全建议",
          context: { customer: "日照中医医院" },
        },
      },
    ]);
  });

  it("lists history without a model POST and explicitly confirms or cancels one suggestion with CSRF and versions", async () => {
    const calls = [];
    const signals = [];
    const controller = new AbortController();
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        signals.push(options.signal);
        calls.push({
          url,
          method: options.method ?? "GET",
          body: options.body ? JSON.parse(options.body) : null,
          csrf: headerValue(options, "X-CSRF-Token"),
          ifMatch: headerValue(options, "If-Match"),
        });
        if (url.includes("/api/ai/suggestions?") && (options.method ?? "GET") === "GET") {
          return jsonResponse({ items: [sampleAiSuggestion()] });
        }
        if (url.endsWith("/api/ai/suggestions/suggestion-1/confirm")) {
          return jsonResponse({
            item: sampleAiSuggestion({
              version: 2,
              status: "confirmed",
              draft: "人工调整后的建议",
              confirmedAt: "2026-06-05T10:05:00.000Z",
            }),
          });
        }
        if (url.endsWith("/api/ai/suggestions/suggestion-2/cancel")) {
          return jsonResponse({
            item: sampleAiSuggestion({
              id: "suggestion-2",
              version: 2,
              status: "cancelled",
              cancelledAt: "2026-06-05T10:06:00.000Z",
            }),
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    const history = await api.listAiSuggestions({
      type: "customer_profile",
      sourceId: "customer 1",
      limit: 5,
    }, { signal: controller.signal });
    const confirmed = await api.confirmAiSuggestion("suggestion-1", {
      draft: "人工调整后的建议",
      version: 1,
    }, { signal: controller.signal });
    const cancelled = await api.cancelAiSuggestion("suggestion-2", { version: 1 }, { signal: controller.signal });

    assert.equal(history.items.length, 1);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(signals, [controller.signal, controller.signal, controller.signal]);
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/ai/suggestions?type=customer_profile&sourceId=customer+1&limit=5",
        method: "GET",
        body: null,
        csrf: undefined,
        ifMatch: undefined,
      },
      {
        url: "http://127.0.0.1:8787/api/ai/suggestions/suggestion-1/confirm",
        method: "POST",
        body: { confirm: true, draft: "人工调整后的建议" },
        csrf: "fixture-csrf-token",
        ifMatch: '"1"',
      },
      {
        url: "http://127.0.0.1:8787/api/ai/suggestions/suggestion-2/cancel",
        method: "POST",
        body: { cancel: true },
        csrf: "fixture-csrf-token",
        ifMatch: '"1"',
      },
    ]);
  });

  it("loads and writes visit itineraries with strict versions and CSRF", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({
          url,
          method: options.method ?? "GET",
          body: options.body ? JSON.parse(options.body) : null,
          csrf: headerValue(options, "X-CSRF-Token"),
          ifMatch: headerValue(options, "If-Match"),
        });
        if (url.endsWith("/api/itineraries?status=planned")) {
          return jsonResponse({ items: [sampleVisitItinerary()] });
        }
        if (url.endsWith("/api/itineraries/itinerary-1") && (options.method ?? "GET") === "GET") {
          return jsonResponse({ item: sampleVisitItinerary() });
        }
        if (url.endsWith("/api/itineraries") && options.method === "POST") {
          return jsonResponse({ item: sampleVisitItinerary() }, 201);
        }
        if (url.endsWith("/api/itineraries/itinerary-1") && options.method === "PATCH") {
          return jsonResponse({ item: sampleVisitItinerary({ version: 2, title: "调整后的拜访" }) });
        }
        if (url.endsWith("/api/itineraries/itinerary-1") && options.method === "DELETE") {
          return jsonResponse({ deleted: sampleVisitItinerary({ version: 3 }) });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });
    api.setSession({ csrfToken: "csrf-test" });
    const input = {
      title: "济宁客户拜访",
      visitDate: "2026-07-28",
      status: "planned",
      departureAddress: "青岛市黄岛区秀兰禧悦山",
      departureCity: "青岛",
      departureLocation: { lng: 120.149201, lat: 35.987754 },
      departureAt: "2026-07-28T00:00:00.000Z",
      stops: sampleVisitItinerary().request.stops.map((stop) => ({
        ...stop,
        location: { lng: 116.608817, lat: 35.415405 },
      })),
      unexpected: "must not be sent",
    };

    const listed = await api.listVisitItineraries({ status: "planned" });
    const loaded = await api.getVisitItinerary("itinerary-1");
    const created = await api.saveVisitItinerary(input);
    const updated = await api.saveVisitItinerary({ ...input, id: "itinerary-1", version: 1, title: "调整后的拜访" });
    const deleted = await api.deleteVisitItinerary("itinerary-1", 2);

    assertApiCollection("visitItinerary", listed);
    assertApiEntity("visitItinerary", loaded);
    assertApiEntity("visitItinerary", created);
    assertApiEntity("visitItinerary", updated);
    assertApiEntity("visitItinerary", deleted);
    assert.equal(calls[0].url, "http://127.0.0.1:8787/api/itineraries?status=planned");
    assert.equal(calls[0].csrf, undefined);
    assert.equal(calls[1].url, "http://127.0.0.1:8787/api/itineraries/itinerary-1");
    assert.equal(calls[2].method, "POST");
    assert.equal(calls[2].csrf, "csrf-test");
    assert.equal(Object.hasOwn(calls[2].body, "unexpected"), false);
    assert.equal(Object.hasOwn(calls[2].body, "id"), false);
    assert.deepEqual(calls[2].body.departureLocation, input.departureLocation);
    assert.deepEqual(calls[2].body.stops[0].location, input.stops[0].location);
    assert.equal(calls[3].method, "PATCH");
    assert.equal(calls[3].ifMatch, '"1"');
    assert.equal(calls[3].csrf, "csrf-test");
    assert.equal(calls[4].method, "DELETE");
    assert.equal(calls[4].ifMatch, '"2"');
    assert.equal(calls[4].csrf, "csrf-test");
  });

  it("publishes strict travel-expense response contracts with integer-cent amounts", () => {
    assert.equal(SALES_WORKBENCH_API_CONTRACT_VERSION, "2026-09-02");
    assertApiEntity("travelExpensePayment", sampleTravelExpensePayment());
    assertApiEntity("travelExpenseAttachment", sampleTravelExpenseAttachment());
    assertApiEntity("travelExpense", sampleTravelExpense());
    assertApiEntity("travelExpenseAdvance", sampleTravelExpenseAdvance());
    assertApiEntity("shortcutBookkeepingLedgerReceipt", sampleShortcutBookkeepingLedgerReceipt());
    assertApiEntity("shortcutBookkeepingReview", sampleShortcutBookkeepingReview());
    assertApiEntity("travelExpenseWorkbench", sampleTravelExpenseWorkbench());

    assert.throws(
      () => assertApiEntity("travelExpensePayment", sampleTravelExpensePayment({ amountCents: 68.5 })),
      /nonNegativeInteger/,
    );
    assert.throws(
      () => assertApiEntity("travelExpenseAttachment", sampleTravelExpenseAttachment({ sizeBytes: 0 })),
      /positiveInteger/,
    );
    assert.throws(
      () => assertApiEntity("travelExpense", sampleTravelExpense({ referenceCode: undefined })),
      /referenceCode: expected string/,
    );
    assert.throws(
      () => assertApiEntity(
        "shortcutBookkeepingLedgerReceipt",
        sampleShortcutBookkeepingLedgerReceipt({ amountCents: 68.5 }),
      ),
      /amountCents: expected nonNegativeInteger/,
    );
  });

  it("directly rejects malformed document inbox and candidate structures in the shared contract", () => {
    assertApiEntity("travelExpenseDocumentInbox", sampleTravelExpenseDocumentInbox());
    assertApiEntity("travelExpenseDocumentCandidate", sampleTravelExpenseDocumentCandidate());

    assert.throws(
      () => assertApiEntity(
        "travelExpenseDocumentInbox",
        sampleTravelExpenseDocumentInbox({ recognition: [] }),
      ),
      /travelExpenseDocumentInbox\.recognition: expected nullableObject, received array/,
    );
    assert.throws(
      () => assertApiEntity(
        "travelExpenseDocumentCandidate",
        sampleTravelExpenseDocumentCandidate({ expenseVersion: "1" }),
      ),
      /travelExpenseDocumentCandidate\.expenseVersion: expected positiveInteger, received string/,
    );
  });

  it("loads and writes travel expenses with encoded URLs, CSRF, versions, and writable fields only", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({
          url,
          method: options.method ?? "GET",
          body: options.body ? JSON.parse(options.body) : null,
          csrf: headerValue(options, "X-CSRF-Token"),
          ifMatch: headerValue(options, "If-Match"),
          signal: options.signal,
        });
        if (url.endsWith("/api/travel-expenses?weekStart=2026-08-03")) {
          return jsonResponse({ items: [sampleTravelExpense()] });
        }
        if (url.endsWith("/api/travel-expenses/expense%2F%E4%B8%80%E5%8F%B7") && (options.method ?? "GET") === "GET") {
          return jsonResponse({ item: sampleTravelExpense({ id: "expense/一号" }) });
        }
        if (url.endsWith("/api/travel-expenses") && options.method === "POST") {
          return jsonResponse({ item: sampleTravelExpense() }, 201);
        }
        if (url.endsWith("/api/travel-expenses/expense%2F%E4%B8%80%E5%8F%B7") && options.method === "PATCH") {
          return jsonResponse({ item: sampleTravelExpense({ id: "expense/一号", version: 2 }) });
        }
        if (url.endsWith("/api/travel-expenses/expense%2F%E4%B8%80%E5%8F%B7") && options.method === "DELETE") {
          return jsonResponse({ deleted: sampleTravelExpense({ id: "expense/一号", version: 3 }) });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });
    api.setSession({ csrfToken: "csrf-test" });
    const controller = new AbortController();
    const expenseInput = {
      occurredOn: "2026-08-04",
      category: "lunch",
      purpose: "客户拜访午餐",
      merchant: "差旅餐厅",
      itineraryId: "itinerary-1",
      customerId: "customer-1",
      invoiceStatus: "covered",
      notes: "人工录入",
      payments: [{
        id: "payment-1",
        paidAt: "2026-08-04T12:30:00+08:00",
        merchant: "差旅餐厅",
        amountCents: 6800,
        reimbursementCents: 6800,
        fundingSource: "personal",
        paymentMethod: "wechat",
        accountLast4: "1234",
        differenceReason: null,
        owner: "forged-owner",
        createdAt: "must-not-be-sent",
      }],
      owner: "forged-owner",
      unexpected: "must-not-be-sent",
    };

    const listed = await api.listTravelExpenses({ weekStart: "2026-08-03", signal: controller.signal });
    const loaded = await api.getTravelExpense("expense/一号");
    const created = await api.saveTravelExpense(expenseInput);
    const updated = await api.saveTravelExpense({
      ...expenseInput,
      id: "expense/一号",
      version: 1,
      createdAt: "must-not-be-sent",
    });
    const deleted = await api.deleteTravelExpense("expense/一号", 2);

    assertApiCollection("travelExpense", listed);
    assertApiEntity("travelExpense", loaded);
    assertApiEntity("travelExpense", created);
    assert.equal(updated.version, 2);
    assert.equal(deleted.version, 3);
    assert.equal(calls[0].signal, controller.signal);
    assert.equal(calls[1].url, "http://127.0.0.1:8787/api/travel-expenses/expense%2F%E4%B8%80%E5%8F%B7");
    assert.equal(calls[2].method, "POST");
    assert.equal(calls[2].csrf, "csrf-test");
    assert.deepEqual(calls[2].body, {
      occurredOn: "2026-08-04",
      category: "lunch",
      purpose: "客户拜访午餐",
      merchant: "差旅餐厅",
      itineraryId: "itinerary-1",
      customerId: "customer-1",
      notes: "人工录入",
      payments: [{
        id: "payment-1",
        paidAt: "2026-08-04T12:30:00+08:00",
        merchant: "差旅餐厅",
        amountCents: 6800,
        reimbursementCents: 6800,
        fundingSource: "personal",
        paymentMethod: "wechat",
        accountLast4: "1234",
        differenceReason: null,
      }],
    });
    assert.equal(calls[3].method, "PATCH");
    assert.equal(calls[3].ifMatch, '"1"');
    assert.equal(calls[3].csrf, "csrf-test");
    assert.deepEqual(calls[3].body, calls[2].body);
    assert.equal(calls[4].method, "DELETE");
    assert.equal(calls[4].ifMatch, '"2"');
    assert.equal(calls[4].csrf, "csrf-test");
    assert.deepEqual(calls[4].body, {});
  });

  it("loads one strict owner-scoped ledger workbench projection for the selected natural week", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return jsonResponse({ item: sampleTravelExpenseWorkbench() });
      },
    });
    const controller = new AbortController();
    const workbench = await api.getTravelExpenseWorkbench({
      weekStart: "2026-08-03",
      signal: controller.signal,
    });

    assert.equal(workbench.weekStart, "2026-08-03");
    assert.equal(workbench.expenses[0].referenceCode, "EXP-20260804-ABC12345");
    assert.equal(workbench.advances[0].receivedCents, 180000);
    assert.equal(workbench.bookkeepingReviews[0].ledgerReceipt, null);
    assert.equal(calls[0].url, "https://example.test/api/travel-expense-workbench?weekStart=2026-08-03");
    assert.equal(calls[0].options.signal, controller.signal);

    const invalidApi = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => jsonResponse({
        item: sampleTravelExpenseWorkbench({
          bookkeepingReviews: [sampleShortcutBookkeepingReview({
            status: "accepted",
            ledgerReceipt: sampleShortcutBookkeepingLedgerReceipt({ attachmentStatus: "unknown" }),
          })],
        }),
      }),
    });
    await assert.rejects(
      () => invalidApi.getTravelExpenseWorkbench({ weekStart: "2026-08-03" }),
      /attachmentStatus: expected matched, pending, or not_available/,
    );
  });

  it("loads and saves the owner-scoped weekly region profile with first-write optimistic locking", async () => {
    const calls = [];
    const empty = sampleTravelExpenseWorkbench().regionProfile;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({
          url,
          method: options.method ?? "GET",
          ifMatch: headerValue(options, "If-Match"),
          csrf: headerValue(options, "X-CSRF-Token"),
          body: options.body ? JSON.parse(options.body) : null,
        });
        return jsonResponse({
          item: options.method === "PUT"
            ? { ...empty, version: 1, cities: ["济宁"], defaultCity: "济宁", updatedAt: "2026-08-04T12:34:00.000Z" }
            : empty,
        });
      },
    });
    api.setSession({ csrfToken: "csrf-test" });

    const loaded = await api.getTravelExpenseRegionProfile({ weekStart: "2026-08-03" });
    const saved = await api.saveTravelExpenseRegionProfile({
      version: loaded.version,
      weekStart: loaded.weekStart,
      cities: ["济宁"],
      defaultCity: "济宁",
      dateOverrides: [],
      owner: "must-not-be-sent",
    });

    assert.equal(loaded.version, 0);
    assert.equal(saved.version, 1);
    assert.equal(calls[0].url, "https://example.test/api/travel-expense-region-profile?weekStart=2026-08-03");
    assert.equal(calls[1].method, "PUT");
    assert.equal(calls[1].ifMatch, '"0"');
    assert.equal(calls[1].csrf, "csrf-test");
    assert.deepEqual(calls[1].body, {
      weekStart: "2026-08-03",
      cities: ["济宁"],
      defaultCity: "济宁",
      dateOverrides: [],
    });
  });

  it("adds and deletes expense attachments and builds an authenticated encoded content URL", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({
          url,
          method: options.method ?? "GET",
          body: options.body ? JSON.parse(options.body) : null,
          csrf: headerValue(options, "X-CSRF-Token"),
          ifMatch: headerValue(options, "If-Match"),
        });
        return jsonResponse({
          item: sampleTravelExpense({ version: options.method === "POST" ? 2 : 3 }),
        }, options.method === "POST" ? 201 : 200);
      },
    });
    api.setSession({ csrfToken: "csrf-test" });

    const withAttachment = await api.addTravelExpenseAttachment("expense/一号", {
      paymentIds: ["payment/一号", "payment-2"],
      kind: "payment_proof",
      fileName: "付款 截图.png",
      mediaType: "image/png",
      contentBase64: "aW1hZ2U=",
      coveredCents: 6800,
      notes: "同一截图关联两笔付款",
      owner: "forged-owner",
      content: "must-not-be-sent",
    }, 1);
    const contentUrl = api.getTravelExpenseAttachmentContentUrl("attachment/一号");
    const withoutAttachment = await api.deleteTravelExpenseAttachment("attachment/一号", 2);

    assert.equal(withAttachment.version, 2);
    assert.equal(withoutAttachment.version, 3);
    assert.equal(
      contentUrl,
      "https://example.test/api/travel-expense-attachments/attachment%2F%E4%B8%80%E5%8F%B7/content",
    );
    assert.deepEqual(calls, [
      {
        url: "https://example.test/api/travel-expenses/expense%2F%E4%B8%80%E5%8F%B7/attachments",
        method: "POST",
        body: {
          paymentIds: ["payment/一号", "payment-2"],
          kind: "payment_proof",
          fileName: "付款 截图.png",
          mediaType: "image/png",
          contentBase64: "aW1hZ2U=",
          coveredCents: 6800,
          notes: "同一截图关联两笔付款",
        },
        csrf: "csrf-test",
        ifMatch: '"1"',
      },
      {
        url: "https://example.test/api/travel-expense-attachments/attachment%2F%E4%B8%80%E5%8F%B7",
        method: "DELETE",
        body: {},
        csrf: "csrf-test",
        ifMatch: '"2"',
      },
    ]);
  });

  it("loads protected travel-expense attachment PDF or image content with Cookie credentials", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return new Response("%PDF-1.4\n%%EOF", {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    const response = await api.getTravelExpenseAttachmentContentResponse("attachment/一号");

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://example.test/api/travel-expense-attachments/attachment%2F%E4%B8%80%E5%8F%B7/content");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(calls[0].options.redirect, "error");
    assert.equal(headerValue(calls[0].options, "Accept"), "application/pdf,image/*");
    assert.equal(headerValue(calls[0].options, "Content-Type"), undefined);
    assert.equal(headerValue(calls[0].options, "X-CSRF-Token"), undefined);

    await api.getInvoiceContentResponse("invoice-image-1", { accept: "application/pdf,image/*" });
    assert.equal(headerValue(calls[1].options, "Accept"), "application/pdf,image/*");
  });

  it("lists, reads, confirms, and rejects the protected payment-proof review inbox", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/content")) {
          return new Response("image-bytes", { status: 200, headers: { "Content-Type": "image/png" } });
        }
        if (url.includes("?")) return jsonResponse({ items: [sampleTravelExpenseDocumentInbox()] });
        if (url.endsWith("/confirm")) {
          return jsonResponse({ item: sampleTravelExpenseDocumentInbox({
            version: 2,
            status: "matched",
            matchedExpenseId: "expense-1",
            matchedPaymentId: "payment-1",
            attachmentId: "attachment-1",
          }) });
        }
        if (url.endsWith("/reject")) {
          return jsonResponse({ item: sampleTravelExpenseDocumentInbox({ version: 2, status: "rejected" }) });
        }
        return jsonResponse({ item: sampleTravelExpenseDocumentInbox() });
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    const listed = await api.listTravelExpenseDocumentInbox({ status: "review_required", documentKind: "payment_proof" });
    const detail = await api.getTravelExpenseDocumentInbox("inbox/一号");
    const content = await api.getTravelExpenseDocumentInboxContentResponse("inbox/一号");
    const confirmed = await api.confirmTravelExpenseDocumentInbox("inbox/一号", {
      expenseReferenceCode: "EXP-20260804-ABC12345",
      paymentId: "payment-1",
      ignored: "must-not-be-sent",
    }, 1);
    const rejected = await api.rejectTravelExpenseDocumentInbox("inbox/二号", 1);

    assert.equal(listed.length, 1);
    assert.equal(detail.id, "inbox-1");
    assert.equal(content.status, 200);
    assert.equal(confirmed.attachmentId, "attachment-1");
    assert.equal(rejected.status, "rejected");
    assert.match(calls[0].url, /status=review_required/);
    assert.match(calls[0].url, /documentKind=payment_proof/);
    assert.equal(calls[1].url, "https://example.test/api/travel-expense-document-inbox/inbox%2F%E4%B8%80%E5%8F%B7");
    assert.equal(calls[2].options.credentials, "include");
    assert.equal(calls[2].options.redirect, "error");
    assert.equal(headerValue(calls[2].options, "Accept"), "application/pdf,image/*");
    assert.deepEqual(JSON.parse(calls[3].options.body), {
      expenseReferenceCode: "EXP-20260804-ABC12345",
      paymentId: "payment-1",
    });
    assert.equal(headerValue(calls[3].options, "If-Match"), '"1"');
    assert.equal(headerValue(calls[3].options, "X-CSRF-Token"), "fixture-csrf-token");
    assert.equal(headerValue(calls[4].options, "If-Match"), '"1"');
    assert.equal(headerValue(calls[4].options, "X-CSRF-Token"), "fixture-csrf-token");
  });

  it("loads and writes travel expense advances with week queries and optimistic locking", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({
          url,
          method: options.method ?? "GET",
          body: options.body ? JSON.parse(options.body) : null,
          csrf: headerValue(options, "X-CSRF-Token"),
          ifMatch: headerValue(options, "If-Match"),
        });
        if (url.endsWith("?weekStart=2026-08-03")) return jsonResponse({ items: [sampleTravelExpenseAdvance()] });
        if (options.method === "POST") return jsonResponse({ item: sampleTravelExpenseAdvance() }, 201);
        if (options.method === "PATCH") return jsonResponse({ item: sampleTravelExpenseAdvance({ version: 2 }) });
        return jsonResponse({ deleted: sampleTravelExpenseAdvance({ version: 3 }) });
      },
    });
    api.setSession({ csrfToken: "csrf-test" });
    const advanceInput = {
      weekStart: "2026-08-03",
      status: "received",
      requestedCents: 200000,
      receivedCents: 180000,
      requestedOn: "2026-08-01",
      receivedOn: "2026-08-03",
      purpose: "本周差旅备用金",
      notes: "第一版人工录入",
      owner: "forged-owner",
      unexpected: "must-not-be-sent",
    };

    const listed = await api.listTravelExpenseAdvances({ weekStart: "2026-08-03" });
    const created = await api.saveTravelExpenseAdvance(advanceInput);
    const updated = await api.saveTravelExpenseAdvance({ ...advanceInput, id: "advance/一号", version: 1 });
    const deleted = await api.deleteTravelExpenseAdvance("advance/一号", 2);

    assertApiCollection("travelExpenseAdvance", listed);
    assertApiEntity("travelExpenseAdvance", created);
    assert.equal(updated.version, 2);
    assert.equal(deleted.version, 3);
    assert.equal(calls[0].url, "http://127.0.0.1:8787/api/travel-expense-advances?weekStart=2026-08-03");
    assert.deepEqual(calls[1].body, {
      weekStart: "2026-08-03",
      status: "received",
      requestedCents: 200000,
      receivedCents: 180000,
      requestedOn: "2026-08-01",
      receivedOn: "2026-08-03",
      purpose: "本周差旅备用金",
      notes: "第一版人工录入",
    });
    assert.equal(calls[1].csrf, "csrf-test");
    assert.equal(calls[2].url, "http://127.0.0.1:8787/api/travel-expense-advances/advance%2F%E4%B8%80%E5%8F%B7");
    assert.equal(calls[2].ifMatch, '"1"');
    assert.equal(calls[2].csrf, "csrf-test");
    assert.deepEqual(calls[2].body, calls[1].body);
    assert.equal(calls[3].ifMatch, '"2"');
    assert.equal(calls[3].csrf, "csrf-test");
    assert.deepEqual(calls[3].body, {});
  });

  it("loads, uploads, reviews, and deletes invoices with encoded URLs and strict write headers", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({
          url,
          method: options.method ?? "GET",
          body: options.body ? JSON.parse(options.body) : null,
          csrf: headerValue(options, "X-CSRF-Token"),
          ifMatch: headerValue(options, "If-Match"),
          idempotencyKey: headerValue(options, "Idempotency-Key"),
        });
        if (url.endsWith("/api/invoices?status=review_required")) {
          return jsonResponse({ items: [sampleInvoice()] });
        }
        if (url.endsWith("/api/invoices") && options.method === "POST") {
          return jsonResponse({ item: sampleInvoice() }, 201);
        }
        if (url.endsWith("/api/invoices/invoice%2F%E4%B8%80%E5%8F%B7") && (options.method ?? "GET") === "GET") {
          return jsonResponse({ item: sampleInvoice({ id: "invoice/一号" }) });
        }
        if (url.endsWith("/api/invoices/invoice%2F%E4%B8%80%E5%8F%B7/review")) {
          return jsonResponse({ item: sampleInvoice({ id: "invoice/一号", version: 2, status: "unmatched", conflicts: [], issuedOn: "2026-08-04", totalCents: 10000 }) });
        }
        if (url.endsWith("/api/invoices/invoice%2F%E4%B8%80%E5%8F%B7") && options.method === "DELETE") {
          return jsonResponse({ deleted: sampleInvoice({ id: "invoice/一号", version: 3, status: "deleted" }) });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    const listed = await api.listInvoices({ status: "review_required" });
    const uploaded = await api.uploadInvoice({
      fileName: "客户招待发票.pdf",
      mediaType: "application/pdf",
      contentBase64: "JVBERi0xLjQ=",
      sourceRef: "manual-upload",
      owner: "must-not-be-sent",
    }, { idempotencyKey: "invoice-upload-1" });
    const loaded = await api.getInvoice("invoice/一号");
    const contentUrl = api.getInvoiceContentUrl("invoice/一号");
    const reviewed = await api.reviewInvoice("invoice/一号", {
      invoiceNumber: "INV-20260804",
      issuedOn: "2026-08-04",
      sellerName: "示例商户",
      buyerName: "森特公司",
      amountExTaxCents: 9434,
      taxCents: 566,
      totalCents: 10000,
      suggestedCategory: "hospitality",
      unexpected: "must-not-be-sent",
    }, 1);
    const deleted = await api.deleteInvoice("invoice/一号", 2);

    assert.equal(listed.length, 1);
    assert.equal(uploaded.id, "invoice-1");
    assert.equal(loaded.id, "invoice/一号");
    assert.equal(reviewed.version, 2);
    assert.equal(deleted.version, 3);
    assert.equal(contentUrl, "https://example.test/api/invoices/invoice%2F%E4%B8%80%E5%8F%B7/content");
    assert.equal(calls[1].idempotencyKey, "invoice-upload-1");
    assert.equal(calls[1].csrf, "fixture-csrf-token");
    assert.deepEqual(calls[1].body, {
      fileName: "客户招待发票.pdf",
      mediaType: "application/pdf",
      contentBase64: "JVBERi0xLjQ=",
      sourceRef: "manual-upload",
    });
    assert.equal(calls[3].ifMatch, '"1"');
    assert.equal(calls[3].csrf, "fixture-csrf-token");
    assert.equal(Object.hasOwn(calls[3].body, "unexpected"), false);
    assert.equal(calls[4].ifMatch, '"2"');
    assert.equal(calls[4].method, "DELETE");
  });

  it("loads protected invoice content through the API client with Cookie credentials", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return new Response("%PDF-1.4\n%%EOF", {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    const response = await api.getInvoiceContentResponse("invoice/一号");

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://example.test/api/invoices/invoice%2F%E4%B8%80%E5%8F%B7/content");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(calls[0].options.redirect, "error");
    assert.equal(headerValue(calls[0].options, "Accept"), "application/pdf");
    assert.equal(headerValue(calls[0].options, "Content-Type"), undefined);
    assert.equal(headerValue(calls[0].options, "X-CSRF-Token"), undefined);
  });

  it("invalidates the active session when protected invoice content returns 401", async () => {
    const calls = [];
    let unauthorizedCalls = 0;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (calls.length === 1) {
          return jsonResponse({
            error: { code: "UNAUTHORIZED", message: "Session expired", requestId: "invoice-pdf-401" },
          }, 401);
        }
        return jsonResponse({ item: { status: "waiting_scan", message: "waiting" } });
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    await assert.rejects(
      () => api.getInvoiceContentResponse("invoice-1"),
      (error) => error.status === 401 && error.code === "UNAUTHORIZED",
    );
    await api.startWeixinBinding();

    assert.equal(unauthorizedCalls, 1);
    assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), undefined);
  });

  it("supports invoice matches, no-invoice confirmations, weekly coverage, and candidate decisions", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({
          url,
          method: options.method ?? "GET",
          body: options.body ? JSON.parse(options.body) : null,
          csrf: headerValue(options, "X-CSRF-Token"),
          ifMatch: headerValue(options, "If-Match"),
          idempotencyKey: headerValue(options, "Idempotency-Key"),
        });
        if (url.includes("/api/invoice-matches?") && (options.method ?? "GET") === "GET") return jsonResponse({ items: [sampleInvoiceMatch()] });
        if (url.endsWith("/api/invoices/invoice-1/matches")) return jsonResponse({ item: sampleInvoiceMatch() }, 201);
        if (url.endsWith("/api/invoice-matches/match-1")) return jsonResponse({ item: sampleInvoiceMatch({ version: 2, state: "revoked" }) });
        if (url.includes("/api/travel-expense-no-invoice-confirmations?")) return jsonResponse({ items: [sampleNoInvoiceConfirmation()] });
        if (url.endsWith("/api/travel-expenses/expense-1/no-invoice") && options.method === "POST") return jsonResponse({ item: sampleNoInvoiceConfirmation() }, 201);
        if (url.endsWith("/api/travel-expenses/expense-1/no-invoice") && options.method === "DELETE") return jsonResponse({ item: sampleNoInvoiceConfirmation({ version: 2, revokedAt: "2026-08-05T02:00:00.000Z" }) });
        if (url.endsWith("/api/travel-expense-weeks/2026-08-03/invoice-coverage")) return jsonResponse({ item: { weekStart: "2026-08-03", reimbursementCents: 10000, confirmedCoverageCents: 0, electronicInvoiceCoverageCents: 0, substituteInvoiceCoverageCents: 0, noInvoiceConfirmedCents: 6800, missingInvoiceCents: 10000, invoiceWarehouseAvailableCents: 24000 } });
        if (url.includes("/api/travel-expense-weeks/2026-08-03/invoice-suggestions?")) return jsonResponse({ items: [sampleInvoiceCandidate()] });
        if (url.endsWith("/api/travel-expense-weeks/2026-08-03/invoice-suggestions")) return jsonResponse({ items: [sampleInvoiceCandidate()] }, 201);
        if (url.endsWith("/api/invoice-match-candidates/candidate-1/accept")) return jsonResponse({ item: sampleInvoiceCandidate({ status: "accepted" }) });
        if (url.endsWith("/api/invoice-match-candidates/candidate-1/reject")) return jsonResponse({ item: sampleInvoiceCandidate({ status: "rejected" }) });
        return jsonResponse({ error: "not_found" }, 404);
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    const matches = await api.listInvoiceMatches({ invoiceId: "invoice-1", state: "confirmed" });
    const matched = await api.createInvoiceMatch("invoice-1", {
      expenseReferenceCode: "EXP-20260804-0001",
      paymentId: "payment-1",
      allocatedCents: 10000,
      matchMethod: "manual_code",
    }, 1, { idempotencyKey: "match-create-1" });
    const revokedMatch = await api.revokeInvoiceMatch("match-1", 1);
    const confirmations = await api.listNoInvoiceConfirmations({ weekStart: "2026-08-03" });
    const confirmedNoInvoice = await api.confirmNoInvoice("expense-1", {
      paymentId: "payment-1",
      reason: "商户暂时无法开票",
    }, 1, { idempotencyKey: "no-invoice-1" });
    const revokedNoInvoice = await api.revokeNoInvoice("expense-1", "no-invoice-1", 1);
    const coverage = await api.getWeekInvoiceCoverage("2026-08-03");
    const candidates = await api.listInvoiceCandidates({ weekStart: "2026-08-03", status: "suggested" });
    const generated = await api.generateInvoiceCandidates("2026-08-03", { idempotencyKey: "candidate-generate-1" });
    const accepted = await api.acceptInvoiceCandidate("candidate-1", 1, { idempotencyKey: "candidate-accept-1" });
    const rejected = await api.rejectInvoiceCandidate("candidate-1", 1, { idempotencyKey: "candidate-reject-1" });

    assert.equal(matches[0].state, "confirmed");
    assert.equal(matched.invoiceId, "invoice-1");
    assert.equal(revokedMatch.state, "revoked");
    assert.equal(confirmations[0].id, "no-invoice-1");
    assert.equal(confirmedNoInvoice.expenseId, "expense-1");
    assert.ok(revokedNoInvoice.revokedAt);
    assert.equal(coverage.missingInvoiceCents, 10000);
    assert.equal(coverage.invoiceWarehouseAvailableCents, 24000);
    assert.equal(candidates[0].status, "suggested");
    assert.equal(generated.length, 1);
    assert.equal(accepted.status, "accepted");
    assert.equal(rejected.status, "rejected");
    assert.equal(calls[1].ifMatch, '"1"');
    assert.equal(calls[1].idempotencyKey, "match-create-1");
    assert.equal(calls[4].idempotencyKey, "no-invoice-1");
    assert.deepEqual(calls[5].body, { confirmationId: "no-invoice-1" });
    assert.match(calls[7].url, /\/api\/travel-expense-weeks\/2026-08-03\/invoice-suggestions\?status=suggested$/);
    assert.equal(calls[8].idempotencyKey, "candidate-generate-1");
    assert.equal(calls[9].idempotencyKey, "candidate-accept-1");
    assert.equal(calls[9].ifMatch, '"1"');
    assert.equal(calls[10].idempotencyKey, "candidate-reject-1");
    assert.equal(calls[10].ifMatch, '"1"');
  });

  it("rejects malformed nested travel-expense responses", async () => {
    const malformed = sampleTravelExpense({
      payments: [sampleTravelExpensePayment({ amountCents: "6800" })],
    });
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => jsonResponse({ items: [malformed] }),
    });

    await assert.rejects(
      () => api.listTravelExpenses({ weekStart: "2026-08-03" }),
      /travelExpenses\.items\[0\]\.payments\[0\]\.amountCents: expected nonNegativeInteger/,
    );
  });

  it("invalidates the active session when a travel-expense request is unauthorized", async () => {
    const calls = [];
    let unauthorizedCalls = 0;
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (calls.length === 1) {
          return jsonResponse({
            error: { code: "UNAUTHORIZED", message: "Session expired", requestId: "travel-401" },
          }, 401);
        }
        return jsonResponse({ item: { status: "waiting_scan", message: "waiting" } });
      },
    });
    api.setSession({ csrfToken: "csrf-test" });

    await assert.rejects(
      () => api.listTravelExpenses({ weekStart: "2026-08-03" }),
      (error) => error.status === 401 && error.code === "UNAUTHORIZED",
    );
    await api.startWeixinBinding();

    assert.equal(unauthorizedCalls, 1);
    assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), undefined);
  });

  it("starts, reads, and stops WeChat robot binding through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({
          url,
          method: options.method ?? "GET",
          credentials: options.credentials,
          authorization: headerValue(options, "Authorization"),
          csrf: headerValue(options, "X-CSRF-Token"),
        });
        return jsonResponse({
          item: {
            status: "waiting_scan",
            qrSvg: "<svg role=\"img\"></svg>",
            message: "二维码已生成",
          },
        });
      },
    });
    api.setSession({ csrfToken: "csrf-weixin" });

    const started = await api.startWeixinBinding();
    const status = await api.getWeixinBindingStatus();
    const stopped = await api.stopWeixinBinding();

    assert.equal(started.status, "waiting_scan");
    assert.equal(status.qrSvg, "<svg role=\"img\"></svg>");
    assert.equal(stopped.message, "二维码已生成");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/integrations/weixin-agent/login",
        method: "POST",
        credentials: "include",
        authorization: undefined,
        csrf: "csrf-weixin",
      },
      {
        url: "http://127.0.0.1:8787/api/integrations/weixin-agent/login",
        method: "GET",
        credentials: "include",
        authorization: undefined,
        csrf: undefined,
      },
      {
        url: "http://127.0.0.1:8787/api/integrations/weixin-agent/login",
        method: "DELETE",
        credentials: "include",
        authorization: undefined,
        csrf: "csrf-weixin",
      },
    ]);
  });

  it("loads hospital tender notices, summary, sources, and health through read-only calls", async () => {
    const notice = {
      id: "notice-1",
      identityKey: "source-a:item-1",
      sourceId: "source-a",
      sourceName: "公开采购平台",
      city: "日照市",
      title: "日照中医医院信息化采购",
      url: "https://example.test/notices/1",
      publishedAt: "2026-08-16T08:00:00.000Z",
      noticeType: "tender",
      purchaser: "日照中医医院",
      projectCode: "",
      budgetText: "",
      deadlineText: "",
      contentText: "",
      hospitalNames: ["日照中医医院"],
      sourceItemId: "item-1",
      contentSha256: "a".repeat(64),
      relevance: "high",
      matchedCustomerIds: ["rizhao"],
      matchedCustomerNames: ["日照中医医院"],
      matchReasons: { rizhao: ["hospital_name"] },
      matchedNeeds: { rizhao: ["PACS"] },
      matchScore: 85,
      revision: 1,
      firstSeenAt: "2026-08-16T10:00:00.000Z",
      lastSeenAt: "2026-08-16T10:00:00.000Z",
    };
    const source = {
      sourceId: "source-a",
      sourceName: "公开采购平台",
      city: "",
      status: "healthy",
      lastRunAt: "2026-08-16T09:00:00.000Z",
      lastSuccessAt: "2026-08-16T09:00:00.000Z",
      itemCount: 1,
      lastUpsertedCount: 1,
      lastRejectedCount: 0,
      lastError: null,
      updatedAt: "2026-08-16T10:00:00.000Z",
    };
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.includes("/api/hospital-tenders?") || url.endsWith("/api/hospital-tenders")) return jsonResponse({ items: [notice], total: 1, limit: 100, offset: 0, hasMore: false });
        if (url.endsWith("/api/hospital-tenders/summary")) return jsonResponse({ item: { totalNotices: 1, matchedNotices: 1, highRelevanceCount: 1, deadlineSoonCount: 0, todayNewCount: 0, byNoticeType: { tender: 1 }, byRelevance: { high: 1 }, latestRun: null } });
        if (url.endsWith("/api/hospital-tenders/sources")) return jsonResponse({ items: [source] });
        if (url.endsWith("/api/hospital-tenders/health")) return jsonResponse({ item: { status: "healthy", sourceCount: 1, staleCount: 0, latestRun: null } });
        if (url.endsWith("/api/hospital-tenders/scheduler") && options.method === "PATCH") return jsonResponse({ item: { enabled: false, intervalMinutes: 60, batchSize: 10, lastStatus: "waiting" }, runs: [] });
        if (url.endsWith("/api/hospital-tenders/scheduler")) return jsonResponse({ item: { enabled: true, intervalMinutes: 60, batchSize: 10, lastStatus: "waiting" }, runs: [] });
        if (url.endsWith("/api/hospital-tenders/scheduler/run-next")) return jsonResponse({ item: { status: "success", state: { lastStatus: "success" } } });
        if (url.endsWith("/api/hospital-tenders/run")) return jsonResponse({ item: { acceptedCount: 1, rejectedCount: 0 } });
        return jsonResponse({ error: "not_found" }, 404);
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    const notices = await api.listHospitalTenders({ customerId: "rizhao" });
    const noticePage = await api.listHospitalTenderPage({ customerId: "rizhao", limit: 100 });
    const summary = await api.getHospitalTenderSummary();
    const sources = await api.listHospitalTenderSources();
    const health = await api.getHospitalTenderHealth();
    const run = await api.runHospitalTenderMonitor();
    const scheduler = await api.getHospitalTenderScheduler();
    const schedulerUpdate = await api.updateHospitalTenderScheduler({ enabled: false });
    const schedulerRun = await api.runHospitalTenderScheduler();
    assert.equal(notices[0].matchedCustomerIds[0], "rizhao");
    assert.equal(noticePage.total, 1);
    assert.equal(noticePage.hasMore, false);
    assert.equal(noticePage.items[0].id, notice.id);
    assert.match(calls.find((call) => call.url.includes("limit=100"))?.url ?? "", /customerId=rizhao/);
    assert.equal(summary.totalNotices, 1);
    assert.equal(sources[0].status, "healthy");
    assert.equal(health.staleCount, 0);
    assert.equal(run.acceptedCount, 1);
    assert.equal(scheduler.item.batchSize, 10);
    assert.equal(schedulerUpdate.item.enabled, false);
    const schedulerUpdateCall = calls.find((call) => call.url.endsWith("/api/hospital-tenders/scheduler") && call.options.method === "PATCH");
    assert.deepEqual(JSON.parse(schedulerUpdateCall.options.body), { enabled: false });
    assert.equal(schedulerUpdateCall.options.headers["X-CSRF-Token"], "fixture-csrf-token");
    assert.equal(schedulerRun.status, "success");
    assert.match(calls[0].url, /customerId=rizhao/);
    assert.equal(calls.at(-1).options.method, "POST");
    assert.equal(calls.at(-1).options.headers["X-CSRF-Token"], "fixture-csrf-token");
  });

  it("previews, explicitly confirms, and explicitly cancels a hospital tender lead conversion", async () => {
    const digest = "a".repeat(64);
    const preview = {
      status: "preview",
      requiresHumanConfirmation: true,
      notice: { id: "notice-1", title: "医院信息化采购" },
      customer: { id: "customer-1", version: 2, name: "示例医院" },
      conversionIdentity: "conversion-1",
      noticeSnapshotDigest: "b".repeat(64),
      match: { score: 85, reasons: ["hospital_name"], needs: ["PACS"] },
      drafts: {
        opportunity: { id: "opportunity-1", name: "招标线索：医院信息化采购", stage: "线索", next: "核验公告" },
        actionItem: { id: "action-1", title: "跟进招标：医院信息化采购", priority: "高", due: "2026-09-10" },
      },
      diff: {
        opportunity: { before: null, after: { id: "opportunity-1" } },
        actionItem: { before: null, after: { id: "action-1" } },
      },
      previewDigest: digest,
    };
    const confirmation = {
      status: "confirmed",
      requiresHumanConfirmation: false,
      replayed: false,
      noticeId: "notice-1",
      customerId: "customer-1",
      conversionIdentity: "conversion-1",
      noticeSnapshotDigest: "b".repeat(64),
      previewDigest: digest,
      opportunity: { id: "opportunity-1" },
      actionItem: { id: "action-1" },
    };
    const cancellation = {
      status: "cancelled",
      requiresHumanConfirmation: false,
      noticeId: "notice-1",
      customerId: "customer-1",
      conversionIdentity: "conversion-1",
      noticeSnapshotDigest: "b".repeat(64),
      previewDigest: digest,
    };
    const calls = [];
    const controller = new AbortController();
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/lead-conversion/preview")) return jsonResponse({ item: preview });
        if (url.endsWith("/lead-conversion/confirm")) return jsonResponse({ item: confirmation });
        if (url.endsWith("/lead-conversion/cancel")) return jsonResponse({ item: cancellation });
        return jsonResponse({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    const previewResult = await api.previewHospitalTenderLeadConversion("notice / 1", { customerId: "customer-1" }, { signal: controller.signal });
    const confirmationResult = await api.confirmHospitalTenderLeadConversion("notice / 1", { customerId: "customer-1", previewDigest: digest }, { signal: controller.signal });
    const cancellationResult = await api.cancelHospitalTenderLeadConversion("notice / 1", { customerId: "customer-1", previewDigest: digest }, { signal: controller.signal });

    assert.equal(previewResult.status, "preview");
    assert.equal(confirmationResult.status, "confirmed");
    assert.equal(cancellationResult.status, "cancelled");
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.options.method === "POST"));
    assert.ok(calls.every((call) => call.options.signal === controller.signal));
    assert.ok(calls.every((call) => call.options.headers["X-CSRF-Token"] === "fixture-csrf-token"));
    assert.ok(calls.every((call) => call.url.includes("/api/hospital-tenders/notice%20%2F%201/lead-conversion/")));
    assert.deepEqual(JSON.parse(calls[0].options.body), { customerId: "customer-1" });
    assert.deepEqual(JSON.parse(calls[1].options.body), { customerId: "customer-1", previewDigest: digest, confirmed: true });
    assert.deepEqual(JSON.parse(calls[2].options.body), { customerId: "customer-1", previewDigest: digest, cancel: true });
  });

  it("keeps the Xiaoxiao WeChat review API read-only and reports client events", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.includes("/api/audit-logs")) {
          return jsonResponse({ items: [{ id: "audit-1", action: "travel_expense.create" }] });
        }
        if (url.includes("/api/bookkeeping/client-events")) {
          return jsonResponse({ recorded: true }, 201);
        }
        if (url.includes("/api/integrations/weixin/bookkeeping/review?")) {
          return jsonResponse({ items: [sampleShortcutBookkeepingReview()] });
        }
        return jsonResponse({ item: sampleShortcutBookkeepingReview() });
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });
    const items = await api.listWeixinBookkeepingReviews({ status: "review_required" });
    const item = await api.getWeixinBookkeepingReview("entry-1");
    assert.equal(items[0].id, "entry-1");
    assert.equal(item.id, "entry-1");
    assert.equal(api.confirmWeixinBookkeepingReview, undefined);
    assert.equal(api.rejectWeixinBookkeepingReview, undefined);
    assert.equal(api.retryWeixinBookkeepingReview, undefined);

    const logs = await api.listBookkeepingAuditLogs({ limit: 50 });
    assert.equal(logs[0].id, "audit-1");
    assert.match(calls.at(-1).url, /\/api\/audit-logs\?scope=bookkeeping&limit=50/u);

    await api.recordBookkeepingClientEvent("print_expense_list", { weekStart: "2026-08-24", itemCount: 6 });
    const eventCall = calls.at(-1);
    assert.match(eventCall.url, /\/api\/bookkeeping\/client-events/u);
    assert.equal(eventCall.options.method, "POST");
    assert.equal(eventCall.options.headers["X-CSRF-Token"], "fixture-csrf-token");
    assert.deepEqual(JSON.parse(eventCall.options.body), {
      event: "print_expense_list",
      weekStart: "2026-08-24",
      itemCount: 6,
    });
  });

  it("enforces formal ledger receipts only for accepted Xiaoxiao expense reviews", async () => {
    const acceptedIncome = sampleShortcutBookkeepingReview({
      id: "income-entry-1",
      status: "accepted",
      entryType: "income",
      category: "借款到账",
      subcategory: null,
      expenseId: null,
      paymentId: null,
      expenseReferenceCode: null,
      ledgerReceipt: null,
    });
    const acceptedIncomeApi = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => jsonResponse({ item: acceptedIncome }),
    });
    const loadedIncome = await acceptedIncomeApi.getWeixinBookkeepingReview("income-entry-1");
    assert.equal(loadedIncome.status, "accepted");
    assert.equal(loadedIncome.entryType, "income");
    assert.equal(loadedIncome.ledgerReceipt, null);

    const acceptedExpenseWithoutReceiptApi = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => jsonResponse({
        item: sampleShortcutBookkeepingReview({ status: "accepted", ledgerReceipt: null }),
      }),
    });
    await assert.rejects(
      () => acceptedExpenseWithoutReceiptApi.getWeixinBookkeepingReview("entry-1"),
      /ledgerReceipt: expected object/u,
    );

    const unacceptedWithReceiptApi = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => jsonResponse({
        item: sampleShortcutBookkeepingReview({
          status: "review_required",
          ledgerReceipt: sampleShortcutBookkeepingLedgerReceipt(),
        }),
      }),
    });
    await assert.rejects(
      () => unacceptedWithReceiptApi.getWeixinBookkeepingReview("entry-1"),
      /only accepted expense records may expose a formal ledger receipt/u,
    );
  });

  it("keeps secure settings writes on the authenticated CSRF boundary and never normalizes secrets into storage", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/settings/security")) {
          return jsonResponse({ item: { deepseek: { configured: false } } });
        }
        if (url.endsWith("/api/settings/deepseek-key") && options.method === "PUT") {
          return jsonResponse({ item: { configured: true, masked: "synt••••test", status: "active" } });
        }
        if (url.endsWith("/api/settings/deepseek-key") && options.method === "DELETE") {
          return jsonResponse({ item: { configured: false, masked: null, status: "cleared" } });
        }
        if (url.endsWith("/api/settings/pushplus-token") && options.method === "PUT") {
          return jsonResponse({ item: { configured: true, masked: "push••••test", status: "active", source: "settings" } });
        }
        if (url.endsWith("/api/settings/pushplus-token") && options.method === "DELETE") {
          return jsonResponse({ item: { configured: false, masked: null, status: "cleared", source: "settings" } });
        }
        if (url.endsWith("/api/settings/pushplus/test")) {
          return jsonResponse({ item: { status: "sent", notificationCount: 1, testedAt: "2026-08-20T00:00:00.000Z" } });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });
    api.setSession({ csrfToken: "fixture-csrf-token" });

    assert.equal((await api.getSecuritySettings()).deepseek.configured, false);
    await api.saveDeepSeekApiKey(syntheticKey);
    await api.clearDeepSeekApiKey();
    await api.savePushplusToken(syntheticToken);
    await api.testPushplusToken();
    await api.clearPushplusToken();
    assert.equal(calls.length, 6);
    assert.equal(calls[1].options.body, JSON.stringify({ apiKey: syntheticKey }));
    assert.equal(calls[1].options.headers["X-CSRF-Token"], "fixture-csrf-token");
    assert.equal(calls[2].options.body, JSON.stringify({ confirmation: "CLEAR" }));
    assert.equal(calls[3].options.body, JSON.stringify({ token: syntheticToken }));
    assert.equal(calls[4].options.method, "POST");
    assert.equal(calls[4].options.headers["X-CSRF-Token"], "fixture-csrf-token");
    assert.equal(calls[5].options.body, JSON.stringify({ confirmation: "CLEAR" }));
  });
});
