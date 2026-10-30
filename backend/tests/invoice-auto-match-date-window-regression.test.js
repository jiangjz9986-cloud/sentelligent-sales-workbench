import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";
import { createInvoiceRepository } from "../src/travelExpense/invoiceRepository.js";
import { createTravelExpenseRepository } from "../src/travelExpense/repository.js";
import { minimalPdf } from "./helpers/image-fixtures.js";

const owner = "invoice-window-owner";
const invoiceDate = "2026-10-01";
const boundaries = [
  { days: 31, occurredOn: "2026-08-31", weekStart: "2026-08-31" },
  { days: 32, occurredOn: "2026-08-30", weekStart: "2026-08-24" },
  { days: 58, occurredOn: "2026-08-04", weekStart: "2026-08-03" },
];

function recognition(fields = {}) {
  return {
    status: "unmatched",
    conflicts: [],
    fields: {
      issuedOn: invoiceDate,
      totalCents: 10000,
      suggestedCategory: "lodging",
      ...fields,
    },
  };
}

function expenseInput(occurredOn, overrides = {}) {
  return {
    occurredOn,
    category: "lodging",
    purpose: "Invoice date window regression",
    merchant: "Fixture hotel",
    notes: "",
    payments: [{
      paidAt: `${occurredOn}T18:00:00+08:00`,
      merchant: "Fixture hotel",
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

describe("autoMatchExpense priority week date window regression", () => {
  let db;
  let invoices;
  let expenses;
  let nextInvoice;

  beforeEach(() => {
    db = openDatabase({ databaseUrl: ":memory:" });
    invoices = createInvoiceRepository(db);
    expenses = createTravelExpenseRepository(db);
    nextInvoice = 0;
  });

  afterEach(() => db.close());

  function addInvoice(fields = {}) {
    const label = `date-window-${++nextInvoice}`;
    return invoices.createInvoice({
      owner,
      actor: owner,
      source: "manual",
      fileName: `${label}.pdf`,
      mediaType: "application/pdf",
      content: minimalPdf(label),
      recognition: recognition(fields),
    });
  }

  function addExpense(occurredOn, overrides = {}) {
    return expenses.createExpense({ owner, actor: owner, ...expenseInput(occurredOn, overrides) });
  }

  function match(expense, priorityWeekStart = "2026-08-03") {
    return invoices.autoMatchExpense({ owner, actor: owner, expenseId: expense.id, priorityWeekStart });
  }

  for (const { days, occurredOn, weekStart } of boundaries) {
    it(`enforces the ${days}-day boundary even when the expense is in the priority week`, () => {
      const invoice = addInvoice();
      const expense = addExpense(occurredOn);
      const result = match(expense, weekStart);

      assert.equal(result.status, days === 31 ? "matched" : "review_required");
      const candidate = days === 31 ? result.selected : result.candidates[0];
      assert.equal(candidate.weekPriority, true);
      assert.equal(candidate.dayDistance, days);
      assert.equal(candidate.dateOrderEligible, true);
      assert.equal(candidate.dateWindowEligible, days === 31);
      const confirmed = invoices.listMatches({ owner, expenseId: expense.id, state: "confirmed" });
      if (days === 31) {
        assert.equal(confirmed.length, 1);
        assert.equal(confirmed[0].invoiceId, invoice.id);
        assert.equal(confirmed[0].allocatedCents, 10000);
      } else {
        assert.equal(result.reason, "exact_amount_outside_date_window");
        assert.deepEqual(confirmed, []);
        assert.equal(invoices.getInvoice(invoice.id, { owner }).status, "unmatched");
      }
    });
  }

  it("rejects an invoice before the Shanghai payment date even inside the window", () => {
    addInvoice({ issuedOn: "2026-08-05" });
    const expense = addExpense("2026-08-04", {
      payments: [{ ...expenseInput("2026-08-04").payments[0], paidAt: "2026-08-05T16:30:00Z" }],
    });
    const result = match(expense);

    assert.equal(result.status, "review_required");
    assert.equal(result.reason, "invoice_before_payment_date");
    assert.equal(result.candidates[0].weekPriority, true);
    assert.equal(result.candidates[0].dateWindowEligible, true);
    assert.equal(result.candidates[0].dateOrderEligible, false);
    assert.deepEqual(invoices.listMatches({ owner, expenseId: expense.id }), []);
  });

  it("does not resolve two eligible exact invoices using date proximity or priority week", () => {
    addInvoice({ issuedOn: "2026-08-05" });
    addInvoice({ issuedOn: "2026-08-06" });
    const expense = addExpense("2026-08-04");

    for (const weekStart of ["2026-08-03", "2026-09-28"]) {
      const result = match(expense, weekStart);
      assert.equal(result.status, "review_required");
      assert.equal(result.reason, "multiple_exact_amounts");
      assert.equal(result.candidates.length, 2);
      assert.deepEqual(invoices.listMatches({ owner, expenseId: expense.id }), []);
    }
  });

  it("excludes an out-of-window exact invoice before checking uniqueness", () => {
    addInvoice();
    const eligible = addInvoice({ issuedOn: "2026-09-04" });
    const expense = addExpense("2026-08-04");
    const result = match(expense);

    assert.equal(result.status, "matched");
    assert.equal(result.match.invoiceId, eligible.id);
    assert.equal(result.selected.dayDistance, 31);
    assert.equal(invoices.listMatches({ owner, expenseId: expense.id }).length, 1);
  });

  it("keeps a non-exact invoice in review despite eligible dates and priority week", () => {
    addInvoice({ issuedOn: "2026-08-05", totalCents: 9999 });
    const expense = addExpense("2026-08-04");
    const result = match(expense);

    assert.equal(result.status, "review_required");
    assert.equal(result.reason, "no_unique_exact_amount");
    assert.equal(result.candidates[0].exactAmount, false);
    assert.deepEqual(invoices.listMatches({ owner, expenseId: expense.id }), []);
  });

  it("keeps two exact payment candidates in review for a single invoice", () => {
    addInvoice({ issuedOn: "2026-08-05" });
    const payment = expenseInput("2026-08-04").payments[0];
    const expense = addExpense("2026-08-04", {
      payments: [payment, { ...payment, paidAt: "2026-08-04T19:00:00+08:00" }],
    });
    const result = match(expense);

    assert.equal(result.status, "review_required");
    assert.equal(result.reason, "multiple_exact_amounts");
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(invoices.listMatches({ owner, expenseId: expense.id }), []);
  });
});

describe("expense HTTP write entry date window regression", () => {
  const password = "test-fixture-password";
  let passwordHash;
  let server;
  let tempDir;
  let baseUrl;
  let cookie;
  let csrf;
  let invoiceFields;
  let nextUpload;

  beforeEach(async () => {
    passwordHash ??= await hashPassword(password, { salt: Buffer.alloc(16, 73) });
    invoiceFields = {};
    nextUpload = 0;
    tempDir = await mkdtemp(join(tmpdir(), "sentelligent-invoice-window-"));
    server = createServer({
      databaseUrl: join(tempDir, "test.sqlite"),
      envFile: "/dev/null",
      seed: false,
      nodeEnv: "test",
      authRequired: true,
      authAccount: owner,
      authPassword: "",
      authPasswordHash: passwordHash,
      authSessionSecret: Buffer.alloc(32, 79).toString("base64url"),
      authCookieSecure: false,
      corsAllowedOrigins: [],
      aiAnalysisMode: "mock",
      aiPlatformMode: "disabled",
      modelApiKey: "",
      hospitalTenderSchedulerEnabled: false,
      actionReminderSchedulerEnabled: false,
      invoiceEscalationSchedulerEnabled: false,
      dailyDigestSchedulerEnabled: false,
      proactiveAssistantWorkerEnabled: false,
      proactiveNotificationSchedulerEnabled: false,
      invoiceRecognizer: async () => recognition(invoiceFields),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: owner, password }),
    });
    assert.equal(login.status, 200);
    cookie = String(login.headers.get("set-cookie")).split(";", 1)[0];
    csrf = (await login.json()).csrfToken;
  });

  afterEach(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server = null;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function request(path, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, method === "POST" ? 201 : 200);
    return response.json();
  }

  async function upload(fields = {}) {
    invoiceFields = fields;
    const label = `http-window-${++nextUpload}`;
    const body = await request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": label },
      body: {
        fileName: `${label}.pdf`,
        mediaType: "application/pdf",
        contentBase64: minimalPdf(label).toString("base64"),
      },
    });
    assert.equal(body.item.status, "unmatched");
    return body.item;
  }

  async function confirmedMatches(expenseId) {
    const body = await request(`/api/invoice-matches?expenseId=${encodeURIComponent(expenseId)}&state=confirmed`);
    return body.items;
  }

  for (const { days, occurredOn } of boundaries) {
    it(`uses the actual expense-create priority week and enforces ${days} days`, async () => {
      const invoice = await upload();
      const { item } = await request("/api/travel-expenses", { method: "POST", body: expenseInput(occurredOn) });
      const matches = await confirmedMatches(item.id);

      assert.equal(matches.length, days === 31 ? 1 : 0);
      assert.equal(item.invoiceStatus === "covered", days === 31);
      const storedInvoice = (await request(`/api/invoices/${encodeURIComponent(invoice.id)}`)).item;
      assert.equal(storedInvoice.status, days === 31 ? "matched" : "unmatched");
      if (days === 31) {
        assert.equal(matches[0].invoiceId, invoice.id);
        assert.equal(matches[0].allocatedCents, 10000);
      }
    });
  }

  it("does not bind an invoice before payment through the expense-create entry", async () => {
    await upload({ issuedOn: "2026-08-03" });
    const { item } = await request("/api/travel-expenses", { method: "POST", body: expenseInput("2026-08-04") });

    assert.deepEqual(await confirmedMatches(item.id), []);
    assert.notEqual(item.invoiceStatus, "covered");
  });

  it("does not choose between ambiguous invoices through the expense-create entry", async () => {
    await upload({ issuedOn: "2026-08-05" });
    await upload({ issuedOn: "2026-08-06" });
    const { item } = await request("/api/travel-expenses", { method: "POST", body: expenseInput("2026-08-04") });

    assert.deepEqual(await confirmedMatches(item.id), []);
    assert.notEqual(item.invoiceStatus, "covered");
  });

  it("enforces the same date window when the expense is updated", async () => {
    await upload();
    const input = expenseInput("2026-08-04");
    const { item } = await request("/api/travel-expenses", {
      method: "POST",
      body: { ...input, payments: [{ ...input.payments[0], amountCents: 9900, reimbursementCents: 9900 }] },
    });
    assert.deepEqual(await confirmedMatches(item.id), []);
    const updated = await request(`/api/travel-expenses/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      headers: { "If-Match": `"${item.version}"` },
      body: { ...input, payments: [{ ...input.payments[0], id: item.payments[0].id }] },
    });

    assert.deepEqual(await confirmedMatches(item.id), []);
    assert.notEqual(updated.item.invoiceStatus, "covered");
  });
});
