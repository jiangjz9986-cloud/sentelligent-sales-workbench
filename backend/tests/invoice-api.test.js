import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  assertApiCollection,
  assertApiEntity,
} from "../../shared/salesWorkbenchApiContract.mjs";
import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import { minimalPdf, VALID_PDF } from "./helpers/image-fixtures.js";

const account = "invoice-owner";
const loginPassword = "fixture-password-for-tests";
const passwordHash = await hashPassword(loginPassword, { salt: Buffer.alloc(16, 59) });
const sessionSecret = Buffer.alloc(32, 61).toString("base64url");
const PDF = VALID_PDF;

let server;
let tempDir;
let baseUrl;
let cookie;
let csrf;

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function read(response) {
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body };
}

function recognized(overrides = {}) {
  return {
    status: "unmatched",
    extractedText: "电子发票 2026-08-04 100.00元",
    ocr: null,
    model: null,
    conflicts: [],
    warnings: [],
    fields: {
      invoiceCode: "044002100111",
      invoiceNumber: "12345678",
      issuedOn: "2026-08-04",
      sellerName: "示例酒店",
      buyerName: "森特公司",
      amountExTaxCents: 9434,
      taxCents: 566,
      totalCents: 10000,
      suggestedCategory: "lodging",
    },
    ...overrides,
  };
}

async function startHarness(overrides = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-invoice-api-"));
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret: sessionSecret,
    authCookieSecure: false,
    corsAllowedOrigins: [],
    aiAnalysisMode: "mock",
    modelApiKey: "",
    invoiceRecognizer: async () => recognized(),
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await read(await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, password: loginPassword }),
  }));
  assert.equal(login.response.status, 200);
  cookie = cookiePair(login.response);
  csrf = login.body.csrfToken;
}

async function request(path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const headers = { Cookie: cookie, ...(options.headers ?? {}) };
  if (["POST", "PATCH", "DELETE"].includes(method)) headers["X-CSRF-Token"] ??= csrf;
  if (options.body !== undefined && !(options.body instanceof Buffer)) headers["Content-Type"] ??= "application/json";
  return read(await fetch(`${baseUrl}${path}`, { ...options, method, headers }));
}

function uploadBody(label = "住宿发票") {
  return {
    fileName: `${label}.pdf`,
    mediaType: "application/pdf",
    contentBase64: PDF.toString("base64"),
    sourceRef: null,
  };
}

function expenseBody(overrides = {}) {
  return {
    occurredOn: "2026-08-04",
    category: "lodging",
    purpose: "济宁出差住宿",
    merchant: "示例酒店",
    notes: "",
    payments: [{
      paidAt: "2026-08-04T18:00:00+08:00",
      merchant: "示例酒店",
      amountCents: 10000,
      reimbursementCents: 10000,
      fundingSource: "personal",
      paymentMethod: "alipay",
      accountLast4: "",
      differenceReason: "",
    }],
    ...overrides,
  };
}

async function createExpense(overrides = {}) {
  const result = await request("/api/travel-expenses", {
    method: "POST",
    body: JSON.stringify(expenseBody(overrides)),
  });
  assert.equal(result.response.status, 201);
  return result.body.item;
}

beforeEach(() => {
  server = null;
  tempDir = null;
  baseUrl = null;
  cookie = null;
  csrf = null;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("authenticated invoice API", () => {
  it("reports local invoice extraction readiness without command paths or tool output", async () => {
    await startHarness({
      invoiceTextTools: {
        ocr: { configured: true, available: true },
        pdfText: { configured: true, available: false },
      },
    });

    const health = await request("/api/health");
    assert.deepEqual(health.body.invoiceTextTools, {
      ocr: { configured: true, available: true },
      pdfText: { configured: true, available: false },
    });
    assert.doesNotMatch(JSON.stringify(health.body), /tesseract|pdftotext|secret-version-output/i);
  });

  it("uses local extracted text with the configured model without sending the original document", async () => {
    let modelRequest;
    await startHarness({
      invoiceRecognizer: undefined,
      invoiceTextExtractor: {
        async extract(mediaType, buffer) {
          assert.equal(mediaType, "application/pdf");
          assert.deepEqual(buffer, PDF);
          return "发票日期 2026-08-04 合计 100.00 元";
        },
      },
      aiAnalysisMode: "model",
      modelApiKey: "test-provider-key",
      modelName: "deepseek-chat",
      fetchImpl: async (_url, options) => {
        modelRequest = JSON.parse(options.body);
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              choices: [{ message: { content: JSON.stringify(recognized().fields) } }],
            });
          },
        };
      },
    });

    const uploaded = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "local-text-model" },
      body: JSON.stringify(uploadBody("本地提取")),
    });
    assert.equal(uploaded.response.status, 201);
    assert.equal(uploaded.body.item.status, "unmatched");
    assert.equal(uploaded.body.item.totalCents, 10000);
    assert.equal(modelRequest.messages[1].content, "发票日期 2026-08-04 合计 100.00 元");
    assert.doesNotMatch(JSON.stringify(modelRequest), new RegExp(PDF.toString("base64")));
  });

  it("uploads, lists, loads, and streams an invoice without exposing its blob in JSON", async () => {
    await startHarness();

    assert.equal((await read(await fetch(`${baseUrl}/api/invoices`))).response.status, 401);
    const missingCsrf = await read(await fetch(`${baseUrl}/api/invoices`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": "invoice-1" },
      body: JSON.stringify(uploadBody()),
    }));
    assert.equal(missingCsrf.response.status, 403);

    const created = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "invoice-upload-1" },
      body: JSON.stringify(uploadBody()),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.status, "unmatched");
    assert.equal(created.body.item.content, undefined);
    assert.equal(created.body.item.contentBlob, undefined);

    const listed = await request("/api/invoices?status=unmatched");
    const loaded = await request(`/api/invoices/${encodeURIComponent(created.body.item.id)}`);
    assert.deepEqual(listed.body.items, [created.body.item]);
    assert.deepEqual(loaded.body.item, created.body.item);
    assert.equal(JSON.stringify(listed.body).includes(PDF.toString("base64")), false);

    const content = await fetch(`${baseUrl}/api/invoices/${encodeURIComponent(created.body.item.id)}/content`, {
      headers: { Cookie: cookie },
    });
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-type"), "application/pdf");
    assert.equal(content.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), PDF);

    const duplicate = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "invoice-upload-2" },
      body: JSON.stringify(uploadBody("重复发票")),
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.error.code, "DUPLICATE_INVOICE");
  });

  it("preserves the invoice filename and emits an RFC 5987 content disposition", async () => {
    await startHarness();
    const originalFileName = "  invoice's (proof) 甲.pdf  ";
    const created = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "invoice-filename-1" },
      body: JSON.stringify({
        ...uploadBody("filename"),
        fileName: originalFileName,
        contentBase64: minimalPdf("filename").toString("base64"),
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.fileName, originalFileName);

    const content = await fetch(`${baseUrl}/api/invoices/${encodeURIComponent(created.body.item.id)}/content`, {
      headers: { Cookie: cookie },
    });
    assert.equal(content.status, 200);
    assert.equal(
      content.headers.get("content-disposition"),
      "inline; filename*=UTF-8''%20%20invoice%27s%20%28proof%29%20%E7%94%B2.pdf%20%20",
    );
  });

  it("resolves recognition conflicts and confirms then revokes a match", async () => {
    await startHarness({
      invoiceRecognizer: async () => recognized({
        status: "review_required",
        conflicts: [
          { field: "issuedOn", ocrValue: "2026-08-03", modelValue: "2026-08-04" },
          { field: "totalCents", ocrValue: 9900, modelValue: 10000 },
        ],
        fields: { ...recognized().fields, issuedOn: null, totalCents: null },
      }),
    });
    const expense = await createExpense();
    const uploaded = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "conflict-upload" },
      body: JSON.stringify(uploadBody("待复核发票")),
    });
    assert.equal(uploaded.body.item.status, "review_required");

    const reviewed = await request(`/api/invoices/${encodeURIComponent(uploaded.body.item.id)}/review`, {
      method: "PATCH",
      headers: { "If-Match": '"1"' },
      body: JSON.stringify(recognized().fields),
    });
    assert.equal(reviewed.response.status, 200);
    assert.equal(reviewed.body.item.version, 2);
    assert.equal(reviewed.body.item.status, "unmatched");
    assert.deepEqual(reviewed.body.item.conflicts, []);

    const matched = await request(`/api/invoices/${encodeURIComponent(reviewed.body.item.id)}/matches`, {
      method: "POST",
      headers: { "If-Match": '"2"', "Idempotency-Key": "match-1" },
      body: JSON.stringify({
        expenseReferenceCode: expense.referenceCode,
        paymentId: expense.payments[0].id,
        allocatedCents: 10000,
        matchMethod: "manual_code",
      }),
    });
    assert.equal(matched.response.status, 201);
    assert.equal(matched.body.item.state, "confirmed");
    assert.equal((await request(`/api/invoices/${encodeURIComponent(reviewed.body.item.id)}`)).body.item.status, "matched");

    const revoked = await request(`/api/invoice-matches/${encodeURIComponent(matched.body.item.id)}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    assert.equal(revoked.response.status, 200);
    assert.equal(revoked.body.item.state, "revoked");
  });

  it("advances the invoice aggregate version for every partial match", async () => {
    await startHarness({
      invoiceRecognizer: async () => recognized({
        fields: {
          ...recognized().fields,
          amountExTaxCents: 18868,
          taxCents: 1132,
          totalCents: 20000,
        },
      }),
    });
    const firstExpense = await createExpense({
      purpose: "第一笔部分匹配",
      payments: [{
        ...expenseBody().payments[0],
        amountCents: 5000,
        reimbursementCents: 5000,
      }],
    });
    const secondExpense = await createExpense({
      purpose: "第二笔部分匹配",
      payments: [{
        ...expenseBody().payments[0],
        paidAt: "2026-08-04T19:00:00+08:00",
        amountCents: 5000,
        reimbursementCents: 5000,
      }],
    });
    const uploaded = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "partial-version-upload" },
      body: JSON.stringify(uploadBody("部分匹配版本发票")),
    });
    assert.equal(uploaded.body.item.version, 1);

    const firstMatch = await request(`/api/invoices/${encodeURIComponent(uploaded.body.item.id)}/matches`, {
      method: "POST",
      headers: { "If-Match": '"1"', "Idempotency-Key": "partial-version-match-1" },
      body: JSON.stringify({
        expenseReferenceCode: firstExpense.referenceCode,
        paymentId: firstExpense.payments[0].id,
        allocatedCents: 5000,
        matchMethod: "manual_selection",
      }),
    });
    assert.equal(firstMatch.response.status, 201);
    const afterFirst = await request(`/api/invoices/${encodeURIComponent(uploaded.body.item.id)}`);
    assert.equal(afterFirst.body.item.status, "unmatched");
    assert.equal(afterFirst.body.item.version, 2);

    const staleSecondMatch = await request(`/api/invoices/${encodeURIComponent(uploaded.body.item.id)}/matches`, {
      method: "POST",
      headers: { "If-Match": '"1"', "Idempotency-Key": "partial-version-match-2" },
      body: JSON.stringify({
        expenseReferenceCode: secondExpense.referenceCode,
        paymentId: secondExpense.payments[0].id,
        allocatedCents: 5000,
        matchMethod: "manual_selection",
      }),
    });
    assert.equal(staleSecondMatch.response.status, 409);
    assert.equal(staleSecondMatch.body.error.code, "VERSION_CONFLICT");
  });

  it("returns a conflict instead of discarding invoice evidence during expense edits", async () => {
    await startHarness();
    const expense = await createExpense({
      payments: [
        expenseBody().payments[0],
        {
          ...expenseBody().payments[0],
          paidAt: "2026-08-04T19:00:00+08:00",
          amountCents: 12000,
          reimbursementCents: 12000,
        },
      ],
    });
    const invoice = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "expense-evidence-upload" },
      body: JSON.stringify(uploadBody("expense-evidence")),
    });
    assert.equal(invoice.response.status, 201);
    const matched = await request(`/api/invoices/${encodeURIComponent(invoice.body.item.id)}/matches`, {
      method: "POST",
      headers: { "If-Match": '"1"', "Idempotency-Key": "expense-evidence-match" },
      body: JSON.stringify({
        expenseReferenceCode: expense.referenceCode,
        paymentId: expense.payments[1].id,
        allocatedCents: 10000,
        matchMethod: "manual_selection",
      }),
    });
    assert.equal(matched.response.status, 201);

    const current = await request(`/api/travel-expenses/${encodeURIComponent(expense.id)}`);
    const keptPayment = current.body.item.payments[0];
    const rejected = await request(`/api/travel-expenses/${encodeURIComponent(expense.id)}`, {
      method: "PATCH",
      headers: { "If-Match": `"${current.body.item.version}"` },
      body: JSON.stringify({
        occurredOn: current.body.item.occurredOn,
        category: current.body.item.category,
        purpose: current.body.item.purpose,
        merchant: current.body.item.merchant,
        itineraryId: current.body.item.itineraryId,
        customerId: current.body.item.customerId,
        notes: current.body.item.notes,
        payments: [{
          id: keptPayment.id,
          paidAt: keptPayment.paidAt,
          merchant: keptPayment.merchant,
          amountCents: keptPayment.amountCents,
          reimbursementCents: keptPayment.reimbursementCents,
          fundingSource: keptPayment.fundingSource,
          paymentMethod: keptPayment.paymentMethod,
          accountLast4: keptPayment.accountLast4,
          differenceReason: keptPayment.differenceReason,
        }],
      }),
    });

    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.error.code, "PAYMENT_HAS_DEPENDENCIES");
  });

  it("confirms no-invoice status and generates suggestions without auto-confirming", async () => {
    await startHarness();
    const expense = await createExpense();
    const otherExpense = await createExpense({
      occurredOn: "2026-08-12",
      purpose: "Another trip expense",
    });
    const confirmation = await request(`/api/travel-expenses/${encodeURIComponent(expense.id)}/no-invoice`, {
      method: "POST",
      headers: { "If-Match": '"1"', "Idempotency-Key": "no-invoice-1" },
      body: JSON.stringify({ paymentId: expense.payments[0].id, reason: "酒店未及时开票" }),
    });
    assert.equal(confirmation.response.status, 201);
    assert.equal(confirmation.body.item.amountSnapshotCents, 10000);

    const uploaded = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "candidate-upload" },
      body: JSON.stringify(uploadBody("候选发票")),
    });
    assert.equal(uploaded.response.status, 201);

    const generated = await request("/api/travel-expense-weeks/2026-08-03/invoice-suggestions", {
      method: "POST",
      headers: { "Idempotency-Key": "suggestions-1" },
      body: JSON.stringify({}),
    });
    assert.equal(generated.response.status, 201);
    assert.equal(generated.body.items.length, 1);
    assert.equal(generated.body.items[0].status, "suggested");
    assert.equal(generated.body.items[0].invoiceId, uploaded.body.item.id);

    const coverage = await request("/api/travel-expense-weeks/2026-08-03/invoice-coverage");
    assert.equal(coverage.response.status, 200);
    assert.equal(coverage.body.item.missingInvoiceCents, 10000);
    assert.equal(coverage.body.item.noInvoiceConfirmedCents, 10000);
    assert.equal((await request(`/api/invoices/${encodeURIComponent(uploaded.body.item.id)}`)).body.item.status, "unmatched");

    const foreignExpenseRevoke = await request(`/api/travel-expenses/${encodeURIComponent(otherExpense.id)}/no-invoice`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
      body: JSON.stringify({ confirmationId: confirmation.body.item.id }),
    });
    assert.equal(
      foreignExpenseRevoke.response.status,
      404,
      "a confirmation must not be revoked through a different expense URL",
    );

    const revoked = await request(`/api/travel-expenses/${encodeURIComponent(expense.id)}/no-invoice`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
      body: JSON.stringify({ confirmationId: confirmation.body.item.id }),
    });
    assert.equal(revoked.response.status, 200);
    assert.ok(revoked.body.item.revokedAt);
  });

  it("lists invoice matches, no-invoice confirmations, and candidates after refresh", async () => {
    await startHarness();
    const matchedExpense = await createExpense();
    const invoice = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "refresh-invoice" },
      body: JSON.stringify(uploadBody("刷新状态发票")),
    });
    const matched = await request(`/api/invoices/${encodeURIComponent(invoice.body.item.id)}/matches`, {
      method: "POST",
      headers: { "If-Match": '"1"', "Idempotency-Key": "refresh-match" },
      body: JSON.stringify({
        expenseReferenceCode: matchedExpense.referenceCode,
        paymentId: matchedExpense.payments[0].id,
        allocatedCents: 10000,
        matchMethod: "manual_selection",
      }),
    });
    assert.equal(matched.response.status, 201);

    const noInvoiceExpense = await createExpense({
      occurredOn: "2026-08-05",
      purpose: "刷新无票状态",
      payments: [{
        ...expenseBody().payments[0],
        paidAt: "2026-08-05T18:00:00+08:00",
      }],
    });
    const confirmation = await request(`/api/travel-expenses/${encodeURIComponent(noInvoiceExpense.id)}/no-invoice`, {
      method: "POST",
      headers: { "If-Match": '"1"', "Idempotency-Key": "refresh-no-invoice" },
      body: JSON.stringify({ paymentId: noInvoiceExpense.payments[0].id, reason: "整笔金额无票" }),
    });
    assert.equal(confirmation.response.status, 201);
    const candidateInvoice = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "refresh-candidate-invoice" },
      body: JSON.stringify({
        ...uploadBody("刷新候选发票"),
        contentBase64: minimalPdf("refresh-candidate").toString("base64"),
      }),
    });
    const generated = await request("/api/travel-expense-weeks/2026-08-03/invoice-suggestions", {
      method: "POST",
      headers: { "Idempotency-Key": "refresh-candidates" },
      body: JSON.stringify({}),
    });
    assert.equal(generated.response.status, 201);

    const matches = await request(
      `/api/invoice-matches?weekStart=2026-08-03&invoiceId=${encodeURIComponent(invoice.body.item.id)}&expenseId=${encodeURIComponent(matchedExpense.id)}`,
    );
    assertApiCollection("invoiceMatch", matches.body.items);
    assert.deepEqual(matches.body.items.map((item) => item.id), [matched.body.item.id]);

    const confirmations = await request(
      `/api/travel-expense-no-invoice-confirmations?weekStart=2026-08-03&expenseId=${encodeURIComponent(noInvoiceExpense.id)}&active=true`,
    );
    assertApiCollection("travelExpenseNoInvoiceConfirmation", confirmations.body.items);
    assert.deepEqual(confirmations.body.items.map((item) => item.id), [confirmation.body.item.id]);

    const candidates = await request(
      `/api/travel-expense-weeks/2026-08-03/invoice-suggestions?invoiceId=${encodeURIComponent(candidateInvoice.body.item.id)}&expenseId=${encodeURIComponent(noInvoiceExpense.id)}&status=suggested`,
    );
    assertApiCollection("invoiceMatchCandidate", candidates.body.items);
    assert.deepEqual(candidates.body.items.map((item) => item.id), generated.body.items.map((item) => item.id));
  });

  it("accepts and rejects candidates with versioned idempotent audit records", async () => {
    await startHarness();
    const acceptedExpense = await createExpense();
    await request(`/api/travel-expenses/${encodeURIComponent(acceptedExpense.id)}/no-invoice`, {
      method: "POST",
      headers: { "If-Match": '"1"', "Idempotency-Key": "candidate-accept-no-invoice" },
      body: JSON.stringify({ paymentId: acceptedExpense.payments[0].id, reason: "等待候选" }),
    });
    const acceptedInvoice = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "candidate-accept-invoice" },
      body: JSON.stringify(uploadBody("采纳候选发票")),
    });
    const acceptedGenerated = await request("/api/travel-expense-weeks/2026-08-03/invoice-suggestions", {
      method: "POST",
      headers: { "Idempotency-Key": "candidate-accept-generate" },
      body: JSON.stringify({}),
    });
    const acceptedCandidate = acceptedGenerated.body.items.find(
      (item) => item.invoiceId === acceptedInvoice.body.item.id,
    );

    const acceptOptions = {
      method: "POST",
      headers: { "If-Match": '"1"', "Idempotency-Key": "candidate-accept" },
      body: JSON.stringify({}),
    };
    const accepted = await request(
      `/api/invoice-match-candidates/${encodeURIComponent(acceptedCandidate.id)}/accept`,
      acceptOptions,
    );
    const acceptedReplay = await request(
      `/api/invoice-match-candidates/${encodeURIComponent(acceptedCandidate.id)}/accept`,
      acceptOptions,
    );
    assert.equal(accepted.response.status, 201);
    assert.deepEqual(acceptedReplay.body, accepted.body);
    assert.equal(accepted.body.item.status, "accepted");
    assert.equal(accepted.body.item.version, 2);
    assert.equal(accepted.body.item.acceptedMatchId, accepted.body.match.id);
    assert.equal(accepted.body.match.state, "confirmed");
    assertApiEntity("invoiceMatchCandidate", accepted.body.item);
    assertApiEntity("invoiceMatch", accepted.body.match);

    const rejectedExpense = await createExpense({
      occurredOn: "2026-08-05",
      purpose: "拒绝候选住宿",
      payments: [{
        ...expenseBody().payments[0],
        paidAt: "2026-08-05T18:00:00+08:00",
      }],
    });
    await request(`/api/travel-expenses/${encodeURIComponent(rejectedExpense.id)}/no-invoice`, {
      method: "POST",
      headers: { "If-Match": '"1"', "Idempotency-Key": "candidate-reject-no-invoice" },
      body: JSON.stringify({ paymentId: rejectedExpense.payments[0].id, reason: "等待其他发票" }),
    });
    const rejectedInvoice = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "candidate-reject-invoice" },
      body: JSON.stringify({
        ...uploadBody("拒绝候选发票"),
        contentBase64: minimalPdf("candidate-reject").toString("base64"),
      }),
    });
    const rejectedGenerated = await request("/api/travel-expense-weeks/2026-08-03/invoice-suggestions", {
      method: "POST",
      headers: { "Idempotency-Key": "candidate-reject-generate" },
      body: JSON.stringify({}),
    });
    const rejectedCandidate = rejectedGenerated.body.items.find(
      (item) => item.invoiceId === rejectedInvoice.body.item.id,
    );
    const rejected = await request(
      `/api/invoice-match-candidates/${encodeURIComponent(rejectedCandidate.id)}/reject`,
      {
        method: "POST",
        headers: { "If-Match": '"1"', "Idempotency-Key": "candidate-reject" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.item.status, "rejected");
    assert.equal(rejected.body.item.version, 2);
    assertApiEntity("invoiceMatchCandidate", rejected.body.item);

    const stale = await request(
      `/api/invoice-match-candidates/${encodeURIComponent(rejectedCandidate.id)}/reject`,
      {
        method: "POST",
        headers: { "If-Match": '"1"', "Idempotency-Key": "candidate-reject-stale" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, "VERSION_CONFLICT");

    const audits = await request("/api/audit-logs?entityType=invoice_match_candidate");
    assert.deepEqual(
      audits.body.items.map((item) => item.action).sort(),
      ["invoice.candidate_accept", "invoice.candidate_reject"],
    );
  });

  it("soft-deletes an unmatched invoice with optimistic locking and audit", async () => {
    await startHarness();
    const uploaded = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": "invoice-delete-upload" },
      body: JSON.stringify(uploadBody("待删除发票")),
    });
    const deleted = await request(`/api/invoices/${encodeURIComponent(uploaded.body.item.id)}`, {
      method: "DELETE",
      headers: { "If-Match": '"1"' },
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.deleted.id, uploaded.body.item.id);
    assert.equal(deleted.body.deleted.status, "rejected");
    assert.ok(deleted.body.deleted.deletedAt);
    assertApiEntity("invoiceDocument", uploaded.body.item);
    assert.equal((await request(`/api/invoices/${encodeURIComponent(uploaded.body.item.id)}`)).response.status, 404);

    const audits = await request(`/api/audit-logs?entityType=invoice&entityId=${encodeURIComponent(uploaded.body.item.id)}`);
    assert.deepEqual(
      audits.body.items.map((item) => item.action).sort(),
      ["invoice.create", "invoice.delete"],
    );
  });
});
