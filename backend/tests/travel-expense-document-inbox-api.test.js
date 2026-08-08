import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";
import { minimalPdf, paddedPng, VALID_PNG } from "./helpers/image-fixtures.js";

const account = "travel-owner";
const loginValue = "travel-document-inbox-login";
const machineToken = "machine-secret";
const passwordField = "pass" + "word";
const passwordHash = await hashPassword(loginValue, { salt: Buffer.alloc(16, 53) });
const sessionSecret = Buffer.alloc(32, 59).toString("base64url");

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

function payment(overrides = {}) {
  return {
    paidAt: "2026-08-04T18:23:00+08:00",
    merchant: "示例餐厅",
    amountCents: 4850,
    reimbursementCents: 4850,
    fundingSource: "personal",
    paymentMethod: "wechat",
    accountLast4: "1234",
    differenceReason: "",
    ...overrides,
  };
}

function expense(overrides = {}) {
  return {
    occurredOn: "2026-08-04",
    category: "dinner",
    purpose: "出差晚餐",
    merchant: "示例餐厅",
    notes: "",
    payments: [payment()],
    ...overrides,
  };
}

function paymentProofBody(overrides = {}) {
  return {
    expenseReferenceCode: null,
    fileName: "付款截图.png",
    mediaType: "image/png",
    contentBase64: VALID_PNG.toString("base64"),
    sourceRef: "wx-payment-message-1",
    textHint: "8月4日 18:23 48.50元",
    amountCents: 4850,
    occurredOn: "2026-08-04",
    paidTime: "18:23",
    matchMode: "candidates_only",
    ...overrides,
  };
}

async function startHarness(serverOptions = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-document-inbox-api-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  const server = createServer({
    databaseUrl,
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
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: account,
    ...serverOptions,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const read = async (response) => {
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  };
  const raw = async (path, options = {}) => {
    const headers = { ...(options.headers ?? {}) };
    if (options.body !== undefined) headers["Content-Type"] ??= "application/json";
    return read(await fetch(`${baseUrl}${path}`, { ...options, headers }));
  };
  const login = await raw("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: loginValue }),
  });
  assert.equal(login.response.status, 200);
  const cookie = cookiePair(login.response);
  const csrf = login.body.csrfToken;

  const userFetch = (path, options = {}) => {
    const method = String(options.method ?? "GET").toUpperCase();
    return fetch(`${baseUrl}${path}`, {
      ...options,
      method,
      headers: {
        Cookie: cookie,
        ...(["POST", "PATCH", "DELETE"].includes(method) ? { "X-CSRF-Token": csrf } : {}),
        ...(options.headers ?? {}),
      },
    });
  };
  const userRequest = async (path, options = {}) => read(await userFetch(path, options));
  const machineRequest = (path, options = {}) => raw(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${machineToken}`,
      ...(options.headers ?? {}),
    },
  });

  return { databaseUrl, machineRequest, server, tempDir, userFetch, userRequest };
}

async function withHarness(work, serverOptions = {}) {
  const harness = await startHarness(serverOptions);
  try {
    await work(harness);
  } finally {
    await new Promise((resolve) => harness.server.close(resolve));
    await rm(harness.tempDir, { recursive: true, force: true });
  }
}

async function withOtherOwnerMachine(databaseUrl, work) {
  const otherOwner = "other-owner";
  const otherMachineToken = "machine-secret";
  const server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: otherOwner,
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret: sessionSecret,
    authCookieSecure: false,
    corsAllowedOrigins: [],
    aiAnalysisMode: "mock",
    modelApiKey: "",
    weixinAgentApiToken: otherMachineToken,
    weixinAgentOwner: otherOwner,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${otherMachineToken}`,
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  };
  try {
    await work(request);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function createExpense(userRequest, overrides = {}) {
  const created = await userRequest("/api/travel-expenses", {
    method: "POST",
    body: JSON.stringify(expense(overrides)),
  });
  assert.equal(created.response.status, 201);
  return created.body.item;
}

async function waitForProcessingClaim(db, key, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare(`
      SELECT state FROM idempotency_keys
      WHERE actor = $actor
        AND method = 'POST'
        AND request_path = '/api/travel-expense-document-inbox'
        AND key = $key
    `).get({ $actor: account, $key: key });
    if (row?.state === "processing") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for document inbox idempotency claim");
}

describe("WeChat travel expense document inbox API", () => {
  it("returns candidates without attaching a candidates-only payment proof", async () => {
    await withHarness(async ({ machineRequest, userRequest }) => {
      const created = await createExpense(userRequest);
      const received = await machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-candidates-1" },
        body: JSON.stringify(paymentProofBody()),
      });

      assert.equal(received.response.status, 202);
      assert.equal(received.body.item.owner, account);
      assert.equal(received.body.item.source, "weixin");
      assert.equal(received.body.item.status, "review_required");
      assert.equal(received.body.item.matchedExpenseId, null);
      assert.equal(received.body.item.matchedPaymentId, null);
      assert.equal(received.body.item.attachmentId, null);
      assert.deepEqual(received.body.item.candidates.map((item) => item.paymentId), [created.payments[0].id]);

      const loaded = await userRequest(`/api/travel-expenses/${encodeURIComponent(created.id)}`);
      assert.deepEqual(loaded.body.item.attachments, [], "candidate discovery must never write an attachment");
    });
  });

  it("retains the original and stores bounded review evidence when extracted text exceeds the inbox limit", async () => {
    const extractedText = `${"识".repeat(200_000)}overflow`;
    await withHarness(async ({ machineRequest, userFetch, userRequest }) => {
      const created = await createExpense(userRequest);
      const received = await machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-oversized-text-1" },
        body: JSON.stringify(paymentProofBody({
          sourceRef: "wx-payment-oversized-text-1",
          expenseReferenceCode: created.referenceCode,
          matchMode: "expense_reference",
        })),
      });

      assert.equal(received.response.status, 202);
      assert.equal(received.body.item.status, "review_required");
      assert.equal(received.body.item.extractedText, extractedText.slice(0, 200_000));
      assert.deepEqual(received.body.item.recognition.warnings, ["EXTRACTED_TEXT_TRUNCATED"]);
      assert.equal(received.body.item.errorCode, "EXTRACTED_TEXT_TRUNCATED");

      const content = await userFetch(`/api/travel-expense-document-inbox/${encodeURIComponent(received.body.item.id)}/content`);
      assert.equal(content.status, 200);
      assert.equal(content.headers.get("cache-control"), "no-store");
      assert.deepEqual(Buffer.from(await content.arrayBuffer()), VALID_PNG);

      const expenseAfterReview = await userRequest(`/api/travel-expenses/${encodeURIComponent(created.id)}`);
      assert.deepEqual(expenseAfterReview.body.item.attachments, []);
    }, {
      paymentProofRecognizer: async () => ({
        extractedText,
        evidence: null,
        typedEvidence: { amountCents: null, occurredOn: null, paidTime: null },
        conflicts: [],
        confidence: null,
        warnings: [],
        source: { provider: "deepseek", model: "test-model" },
      }),
    });
  });

  it("attaches only the uniquely matching payment when an exact EXP reference is supplied", async () => {
    await withHarness(async ({ machineRequest, userRequest }) => {
      const created = await createExpense(userRequest, {
        payments: [
          payment({ paidAt: "2026-08-04T12:10:00+08:00", amountCents: 3200, reimbursementCents: 3200 }),
          payment(),
        ],
      });
      const targetPayment = created.payments[1];
      const options = {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-expense-1" },
        body: JSON.stringify(paymentProofBody({
          expenseReferenceCode: created.referenceCode,
          matchMode: "expense_reference",
          sourceRef: "wx-payment-message-2",
        })),
      };
      const received = await machineRequest("/api/travel-expense-document-inbox", options);
      const replayed = await machineRequest("/api/travel-expense-document-inbox", options);

      assert.equal(received.response.status, 201);
      assert.equal(replayed.response.status, 201);
      assert.equal(replayed.body.item.id, received.body.item.id);
      assert.equal(replayed.body.item.attachmentId, received.body.item.attachmentId);
      assert.equal(received.body.item.status, "matched");
      assert.equal(received.body.item.matchedExpenseId, created.id);
      assert.equal(received.body.item.matchedPaymentId, targetPayment.id);
      assert.equal(typeof received.body.item.attachmentId, "string");
      assert.deepEqual(received.body.item.candidates.map((item) => item.paymentId), [targetPayment.id]);

      const loaded = await userRequest(`/api/travel-expenses/${encodeURIComponent(created.id)}`);
      assert.equal(loaded.body.item.attachments.length, 1);
      assert.equal(loaded.body.item.attachments[0].kind, "payment_proof");
      assert.deepEqual(loaded.body.item.attachments[0].paymentIds, [targetPayment.id]);
      assert.equal(loaded.body.item.attachments[0].fileName, "付款截图.png");
    });
  });

  it("matches UTC payment timestamps using the Asia/Shanghai business date and time", async () => {
    await withHarness(async ({ machineRequest, userRequest }) => {
      const created = await createExpense(userRequest, {
        payments: [payment({ paidAt: "2026-08-04T10:23:00.000Z" })],
      });
      const received = await machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-time-zone-1" },
        body: JSON.stringify(paymentProofBody({
          expenseReferenceCode: created.referenceCode,
          matchMode: "expense_reference",
          sourceRef: "wx-payment-time-zone-1",
        })),
      });

      assert.equal(received.response.status, 201);
      assert.equal(received.body.item.status, "matched");
      assert.equal(received.body.item.matchedPaymentId, created.payments[0].id);
    });
  });

  it("keeps an exact EXP upload in review when amount, date, or time evidence is incomplete", async () => {
    await withHarness(async ({ machineRequest, userRequest }) => {
      const created = await createExpense(userRequest);
      const received = await machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-missing-evidence-1" },
        body: JSON.stringify(paymentProofBody({
          expenseReferenceCode: created.referenceCode,
          matchMode: "expense_reference",
          sourceRef: "wx-payment-missing-evidence-1",
          amountCents: null,
          occurredOn: null,
          paidTime: null,
          textHint: null,
        })),
      });

      assert.equal(received.response.status, 202);
      assert.equal(received.body.item.status, "review_required");
      assert.equal(received.body.item.attachmentId, null);
      assert.deepEqual(received.body.item.candidates.map((item) => item.paymentId), [created.payments[0].id]);
    });
  });

  it("replays the stored response before consulting a subsequently deleted expense", async () => {
    await withHarness(async ({ databaseUrl, machineRequest, userRequest }) => {
      const created = await createExpense(userRequest);
      const options = {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-replay-before-query-1" },
        body: JSON.stringify(paymentProofBody({
          expenseReferenceCode: created.referenceCode,
          matchMode: "expense_reference",
          sourceRef: "wx-payment-replay-before-query-1",
        })),
      };
      const received = await machineRequest("/api/travel-expense-document-inbox", options);
      assert.equal(received.response.status, 201);

      const db = openDatabase({ databaseUrl });
      try {
        db.prepare(`
          UPDATE travel_expenses
          SET deleted_at = '2026-08-05T00:00:00.000Z', deleted_by = $owner
          WHERE id = $id
        `).run({ $id: created.id, $owner: account });
      } finally {
        db.close();
      }

      const replayed = await machineRequest("/api/travel-expense-document-inbox", options);
      assert.equal(replayed.response.status, 201);
      assert.deepEqual(replayed.body, received.body);
    });
  });

  it("rechecks uniqueness inside the write transaction after asynchronous document preparation", async () => {
    await withHarness(async ({ databaseUrl, machineRequest, userRequest }) => {
      const created = await createExpense(userRequest);
      const idempotencyKey = "weixin-payment-concurrent-candidate-1";
      const largePng = paddedPng(12 * 1024 * 1024);
      const upload = machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(paymentProofBody({
          expenseReferenceCode: created.referenceCode,
          matchMode: "expense_reference",
          sourceRef: "wx-payment-concurrent-candidate-1",
          contentBase64: largePng.toString("base64"),
        })),
      });

      const db = openDatabase({ databaseUrl });
      try {
        await waitForProcessingClaim(db, idempotencyKey);
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(`
            INSERT INTO travel_expense_payments (
              id, expense_id, sequence, paid_at, merchant, amount_cents,
              reimbursement_cents, funding_source, payment_method,
              account_last4, difference_reason
            ) VALUES (
              $id, $expenseId, 2, $paidAt, $merchant, $amountCents,
              $reimbursementCents, 'personal', 'wechat', '5678', ''
            )
          `).run({
            $id: randomUUID(),
            $expenseId: created.id,
            $paidAt: "2026-08-04T18:23:00+08:00",
            $merchant: "并发新增付款",
            $amountCents: 4850,
            $reimbursementCents: 4850,
          });
          db.prepare(`
            UPDATE travel_expenses
            SET version = version + 1, updated_at = '2026-08-05T00:00:00.000Z'
            WHERE id = $id
          `).run({ $id: created.id });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        db.close();
      }

      const received = await upload;
      assert.equal(received.response.status, 202);
      assert.equal(received.body.item.status, "review_required");
      assert.equal(received.body.item.attachmentId, null);
      assert.equal(received.body.item.candidates.length, 2);
    });
  });

  it("rejects ambiguous modes and never broadens an unknown EXP reference into a global search", async () => {
    await withHarness(async ({ machineRequest, userRequest }) => {
      const created = await createExpense(userRequest);
      const missingReference = await machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-invalid-1" },
        body: JSON.stringify(paymentProofBody({ matchMode: "expense_reference" })),
      });
      assert.equal(missingReference.response.status, 422);
      assert.equal(missingReference.body.error.fields.expenseReferenceCode, "required");

      const unknownReference = await machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-invalid-2" },
        body: JSON.stringify(paymentProofBody({
          expenseReferenceCode: "EXP-20990101-UNKNOWN",
          matchMode: "expense_reference",
          sourceRef: "wx-payment-message-unknown",
        })),
      });
      assert.equal(unknownReference.response.status, 404);

      const loaded = await userRequest(`/api/travel-expenses/${encodeURIComponent(created.id)}`);
      assert.deepEqual(loaded.body.item.attachments, []);
    });
  });

  it("uses OCR/model evidence to suggest a candidate but never auto-attaches it", async () => {
    let recognizerCalls = 0;
    await withHarness(async ({ machineRequest, userRequest }) => {
      const created = await createExpense(userRequest);
      const received = await machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-recognized-1" },
        body: JSON.stringify(paymentProofBody({
          amountCents: null,
          occurredOn: null,
          paidTime: null,
          textHint: null,
        })),
      });

      assert.equal(received.response.status, 202);
      assert.equal(received.body.item.status, "review_required");
      assert.equal(received.body.item.attachmentId, null);
      assert.deepEqual(received.body.item.candidates.map((item) => item.paymentId), [created.payments[0].id]);
      assert.equal(received.body.item.recognition.evidence.amountCents, 4850);

      const loaded = await userRequest(`/api/travel-expenses/${encodeURIComponent(created.id)}`);
      assert.deepEqual(loaded.body.item.attachments, []);
      assert.equal(recognizerCalls, 1);
    }, {
      async paymentProofRecognizer() {
        recognizerCalls += 1;
        return {
          extractedText: "支付时间 2026-08-04 18:23 金额 48.50 元",
          evidence: {
            amountCents: 4850,
            occurredOn: "2026-08-04",
            paidTime: "18:23",
            merchant: "示例餐厅",
            paymentMethod: "wechat",
          },
          typedEvidence: { amountCents: null, occurredOn: null, paidTime: null },
          conflicts: [],
          confidence: 0.94,
          warnings: [],
          source: { provider: "deepseek", model: "test-model" },
        };
      },
    });
  });

  it("fails closed on typed-versus-recognized conflicts", async () => {
    await withHarness(async ({ machineRequest, userRequest }) => {
      const created = await createExpense(userRequest);
      const received = await machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-conflict-1" },
        body: JSON.stringify(paymentProofBody({
          expenseReferenceCode: created.referenceCode,
          matchMode: "expense_reference",
        })),
      });

      assert.equal(received.response.status, 202);
      assert.equal(received.body.item.status, "review_required");
      assert.equal(received.body.item.attachmentId, null);
      assert.deepEqual(received.body.item.recognition.conflicts, [{
        field: "amountCents",
        typedValue: 4850,
        recognizedValue: 4950,
      }]);
    }, {
      async paymentProofRecognizer() {
        return {
          extractedText: "支付金额 49.50 元",
          evidence: {
            amountCents: 4950,
            occurredOn: "2026-08-04",
            paidTime: "18:23",
            merchant: null,
            paymentMethod: null,
          },
          typedEvidence: { amountCents: 4850, occurredOn: "2026-08-04", paidTime: "18:23" },
          conflicts: [{ field: "amountCents", typedValue: 4850, recognizedValue: 4950 }],
          confidence: 0.88,
          warnings: ["EVIDENCE_CONFLICT"],
          source: { provider: "deepseek", model: "test-model" },
        };
      },
    });
  });

  it("replays a recognized upload without invoking OCR or the model twice", async () => {
    let recognizerCalls = 0;
    await withHarness(async ({ machineRequest }) => {
      const options = {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-recognition-replay-1" },
        body: JSON.stringify(paymentProofBody()),
      };
      const received = await machineRequest("/api/travel-expense-document-inbox", options);
      const replayed = await machineRequest("/api/travel-expense-document-inbox", options);

      assert.equal(received.response.status, 202);
      assert.deepEqual(replayed.body, received.body);
      assert.equal(recognizerCalls, 1);
    }, {
      async paymentProofRecognizer() {
        recognizerCalls += 1;
        return {
          extractedText: null,
          evidence: null,
          typedEvidence: { amountCents: 4850, occurredOn: "2026-08-04", paidTime: "18:23" },
          conflicts: [],
          confidence: null,
          warnings: ["OCR_UNAVAILABLE"],
          source: { provider: "deepseek", model: "test-model" },
        };
      },
    });
  });

  it("lists, opens, confirms, and rejects pending payment proofs with optimistic versions", async () => {
    await withHarness(async ({ machineRequest, userFetch, userRequest }) => {
      const created = await createExpense(userRequest);
      const received = await machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-review-1" },
        body: JSON.stringify(paymentProofBody()),
      });
      assert.equal(received.response.status, 202);

      const listed = await userRequest("/api/travel-expense-document-inbox?status=review_required&documentKind=payment_proof");
      assert.equal(listed.response.status, 200);
      assert.deepEqual(listed.body.items.map((item) => item.id), [received.body.item.id]);
      assert.equal(listed.body.items[0].recognition.candidates[0].paymentId, created.payments[0].id);

      const detail = await userRequest(`/api/travel-expense-document-inbox/${encodeURIComponent(received.body.item.id)}`);
      assert.equal(detail.response.status, 200);
      assert.equal(detail.body.item.version, 1);

      const content = await userFetch(`/api/travel-expense-document-inbox/${encodeURIComponent(received.body.item.id)}/content`);
      assert.equal(content.status, 200);
      assert.equal(content.headers.get("content-type"), "image/png");
      assert.equal(content.headers.get("cache-control"), "no-store");
      assert.deepEqual(Buffer.from(await content.arrayBuffer()), VALID_PNG);

      const confirmed = await userRequest(`/api/travel-expense-document-inbox/${encodeURIComponent(received.body.item.id)}/confirm`, {
        method: "POST",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify({
          expenseReferenceCode: created.referenceCode,
          paymentId: created.payments[0].id,
        }),
      });
      assert.equal(confirmed.response.status, 200);
      assert.equal(confirmed.body.item.status, "matched");
      assert.equal(confirmed.body.item.version, 2);
      assert.equal(typeof confirmed.body.item.attachmentId, "string");

      const loaded = await userRequest(`/api/travel-expenses/${encodeURIComponent(created.id)}`);
      assert.equal(loaded.body.item.attachments.length, 1);
      assert.deepEqual(loaded.body.item.attachments[0].paymentIds, [created.payments[0].id]);

      const staleReject = await userRequest(`/api/travel-expense-document-inbox/${encodeURIComponent(received.body.item.id)}/reject`, {
        method: "POST",
        headers: { "If-Match": '"1"' },
        body: "{}",
      });
      assert.equal(staleReject.response.status, 409);

      const second = await machineRequest("/api/travel-expense-document-inbox", {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-payment-review-2" },
        body: JSON.stringify(paymentProofBody({
          sourceRef: "wx-payment-review-2",
          contentBase64: paddedPng(1024).toString("base64"),
        })),
      });
      assert.equal(second.response.status, 202);
      const rejected = await userRequest(`/api/travel-expense-document-inbox/${encodeURIComponent(second.body.item.id)}/reject`, {
        method: "POST",
        headers: { "If-Match": '"1"' },
        body: "{}",
      });
      assert.equal(rejected.response.status, 200);
      assert.equal(rejected.body.item.status, "rejected");
      assert.equal(rejected.body.item.version, 2);
    });
  });

  it("does not reveal or mutate another owner's inbox item through any review endpoint", async () => {
    await withHarness(async ({ databaseUrl, userRequest }) => {
      let received;
      await withOtherOwnerMachine(databaseUrl, async (otherOwnerRequest) => {
        received = await otherOwnerRequest("/api/travel-expense-document-inbox", {
          method: "POST",
          headers: { "Idempotency-Key": "weixin-payment-cross-owner-1" },
          body: JSON.stringify(paymentProofBody({ sourceRef: "wx-payment-cross-owner-1" })),
        });
      });
      assert.equal(received.response.status, 202);

      const documentId = received.body.item.id;
      const listed = await userRequest("/api/travel-expense-document-inbox?status=review_required");
      const detail = await userRequest(`/api/travel-expense-document-inbox/${encodeURIComponent(documentId)}`);
      const content = await userRequest(`/api/travel-expense-document-inbox/${encodeURIComponent(documentId)}/content`);
      const confirmed = await userRequest(`/api/travel-expense-document-inbox/${encodeURIComponent(documentId)}/confirm`, {
        method: "POST",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify({
          expenseReferenceCode: "EXP-20260804-OTHER",
          paymentId: "other-payment",
        }),
      });
      const rejected = await userRequest(`/api/travel-expense-document-inbox/${encodeURIComponent(documentId)}/reject`, {
        method: "POST",
        headers: { "If-Match": '"1"' },
        body: "{}",
      });

      assert.deepEqual(listed.body.items, []);
      for (const denied of [detail, content, confirmed, rejected]) {
        assert.equal(denied.response.status, 404);
        assert.equal(denied.body.error.code, "NOT_FOUND");
      }

      const verificationDb = openDatabase({ databaseUrl });
      try {
        const stored = verificationDb.prepare(`
          SELECT owner, status, version, matched_expense_id, matched_payment_id
          FROM travel_expense_document_inbox
          WHERE id = $id
        `).get({ $id: documentId });
        assert.deepEqual({ ...stored }, {
          owner: "other-owner",
          status: "review_required",
          version: 1,
          matched_expense_id: null,
          matched_payment_id: null,
        });
      } finally {
        verificationDb.close();
      }
    });
  });

  it("stores machine-uploaded invoices under the configured personal owner and WeChat source", async () => {
    await withHarness(async ({ machineRequest, userRequest }) => {
      const pdf = minimalPdf("machine-owned-invoice");
      const body = {
        fileName: "住宿发票.pdf",
        mediaType: "application/pdf",
        contentBase64: pdf.toString("base64"),
        sourceRef: "wx-invoice-message-1",
      };
      const options = {
        method: "POST",
        headers: { "Idempotency-Key": "weixin-invoice-source-1" },
        body: JSON.stringify(body),
      };

      const missingIdempotency = await machineRequest("/api/invoices", {
        method: "POST",
        body: JSON.stringify(body),
      });
      assert.equal(missingIdempotency.response.status, 428);
      assert.equal(missingIdempotency.body.error.code, "PRECONDITION_REQUIRED");

      const created = await machineRequest("/api/invoices", options);
      const replayed = await machineRequest("/api/invoices", options);
      assert.equal(created.response.status, 201);
      assert.equal(replayed.response.status, 201);
      assert.equal(replayed.body.item.id, created.body.item.id);
      assert.equal(created.body.item.owner, account);
      assert.equal(created.body.item.source, "weixin");
      assert.equal(created.body.item.sourceRef, "wx-invoice-message-1");

      const listed = await userRequest("/api/invoices");
      assert.deepEqual(listed.body.items.map((item) => item.id), [created.body.item.id]);

      const denied = await machineRequest("/api/invoices");
      assert.equal(denied.response.status, 403);
      assert.equal(denied.body.error.code, "MACHINE_SCOPE_DENIED");
    });
  });
});
