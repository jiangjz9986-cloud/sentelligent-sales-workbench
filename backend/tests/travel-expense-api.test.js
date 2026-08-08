import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import {
  SHORT_JPEG_ENVELOPE,
  SHORT_PNG_SIGNATURE,
  SHORT_WEBP_CONTAINER,
  VALID_PDF,
  VALID_PNG,
  paddedPng,
} from "./helpers/image-fixtures.js";

const loginValue = "travel-expense-login-value";
const passwordField = "pass" + "word";
const passwordHash = await hashPassword(loginValue, { salt: Buffer.alloc(16, 31) });
const sessionSecret = Buffer.alloc(32, 41).toString("base64url");

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

function payment(overrides = {}) {
  return {
    paidAt: "2026-08-04T12:30:00+08:00",
    merchant: "Example restaurant",
    amountCents: 4800,
    reimbursementCents: 4500,
    fundingSource: "personal",
    paymentMethod: "wechat",
    accountLast4: "1234",
    differenceReason: "Personal drink excluded",
    ...overrides,
  };
}

function expense(overrides = {}) {
  return {
    occurredOn: "2026-08-04",
    category: "lunch",
    purpose: "Business trip lunch",
    merchant: "Example restaurant",
    notes: "Manual entry",
    payments: [payment()],
    ...overrides,
  };
}

function advance(overrides = {}) {
  return {
    weekStart: "2026-08-03",
    status: "received",
    requestedCents: 100000,
    receivedCents: 80000,
    requestedOn: "2026-08-01",
    receivedOn: "2026-08-02",
    purpose: "Weekly travel advance",
    notes: "Manual entry",
    ...overrides,
  };
}

function attachment(content = VALID_PNG, overrides = {}) {
  return {
    paymentIds: [],
    kind: "payment_proof",
    fileName: "payment.png",
    mediaType: "image/png",
    contentBase64: content.toString("base64"),
    coveredCents: 4500,
    notes: "First screenshot",
    ...overrides,
  };
}

async function startServer(databaseUrl, account, overrides = {}) {
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
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const rawFetch = (path, options = {}) => {
    const headers = { ...(options.headers ?? {}) };
    if (options.body !== undefined) headers["Content-Type"] ??= "application/json";
    return fetch(`${baseUrl}${path}`, { ...options, headers });
  };
  const read = async (response) => {
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  };
  const raw = async (path, options = {}) => read(await rawFetch(path, options));
  const login = await raw("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: loginValue }),
  });
  assert.equal(login.response.status, 200);
  const cookie = cookiePair(login.response);
  const csrf = login.body.csrfToken;
  const authenticatedFetch = (path, options = {}) => {
    const method = String(options.method ?? "GET").toUpperCase();
    return rawFetch(path, {
      ...options,
      headers: {
        Cookie: cookie,
        ...(method === "POST" || method === "PATCH" || method === "DELETE"
          ? { "X-CSRF-Token": csrf }
          : {}),
        ...(options.headers ?? {}),
      },
    });
  };
  const request = async (path, options = {}) => read(await authenticatedFetch(path, options));

  return { authenticatedFetch, baseUrl, cookie, csrf, raw, request, server };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function withHarness(work, overrides = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-travel-expense-api-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  const harness = await startServer(databaseUrl, overrides.account ?? "travel-owner", overrides);
  try {
    await work({ ...harness, databaseUrl });
  } finally {
    await closeServer(harness.server);
    await rm(tempDir, { recursive: true, force: true });
  }
}

function assertValidation(result, field) {
  assert.equal(result.response.status, 422);
  assert.equal(result.body.error.code, "VALIDATION_ERROR");
  assert.equal(typeof result.body.error.fields?.[field], "string");
}

async function createExpense(request, overrides = {}) {
  const created = await request("/api/travel-expenses", {
    method: "POST",
    body: JSON.stringify(expense(overrides)),
  });
  assert.equal(created.response.status, 201);
  return created.body.item;
}

describe("authenticated travel expense API", () => {
  it("requires authentication, CSRF, and server-derived ownership", async () => {
    await withHarness(async ({ cookie, raw }) => {
      assert.equal((await raw("/api/travel-expenses?weekStart=2026-08-03")).response.status, 401);

      const missingCsrf = await raw("/api/travel-expenses", {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify(expense()),
      });
      assert.equal(missingCsrf.response.status, 403);
      assert.equal(missingCsrf.body.error.code, "CSRF_INVALID");

      const forgedOwner = await raw("/api/travel-expenses", {
        method: "POST",
        headers: { Cookie: cookie, "X-CSRF-Token": "invalid" },
        body: JSON.stringify(expense({ owner: "other-user" })),
      });
      assert.equal(forgedOwner.response.status, 403, "CSRF must fail before request validation");
    });
  });

  it("rejects client-controlled invoice status on create and update", async () => {
    await withHarness(async ({ request }) => {
      const rejectedCreate = await request("/api/travel-expenses", {
        method: "POST",
        body: JSON.stringify(expense({ invoiceStatus: "covered" })),
      });
      assertValidation(rejectedCreate, "invoiceStatus");

      const created = await createExpense(request);
      const rejectedUpdate = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}`, {
        method: "PATCH",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify(expense({ invoiceStatus: "missing" })),
      });
      assertValidation(rejectedUpdate, "invoiceStatus");
    });
  });

  it("creates, lists, loads, updates, and soft-deletes an expense with audit history", async () => {
    await withHarness(async ({ request }) => {
      const created = await createExpense(request);
      assert.equal(created.version, 1);
      assert.equal(created.owner, "travel-owner");
      assert.equal(created.actualPaidCents, 4800);

      const listed = await request("/api/travel-expenses?weekStart=2026-08-03");
      const loaded = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}`);
      assert.equal(listed.response.status, 200);
      assert.deepEqual(listed.body.items, [created]);
      assert.deepEqual(loaded.body.item, created);

      const missingPrecondition = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}`, {
        method: "PATCH",
        body: JSON.stringify(expense({ purpose: "Updated lunch" })),
      });
      assert.equal(missingPrecondition.response.status, 428);

      const updated = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}`, {
        method: "PATCH",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify(expense({ purpose: "Updated lunch" })),
      });
      assert.equal(updated.response.status, 200);
      assert.equal(updated.body.item.version, 2);
      assert.equal(updated.body.item.purpose, "Updated lunch");

      const stale = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}`, {
        method: "PATCH",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify(expense({ purpose: "Stale lunch" })),
      });
      assert.equal(stale.response.status, 409);
      assert.equal(stale.body.error.code, "VERSION_CONFLICT");
      assert.equal(stale.body.error.fields.currentVersion, 2);

      const deleted = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}`, {
        method: "DELETE",
        headers: { "If-Match": '"2"' },
        body: "{}",
      });
      assert.equal(deleted.response.status, 200);
      assert.equal(deleted.body.deleted.version, 3);
      assert.equal((await request(`/api/travel-expenses/${encodeURIComponent(created.id)}`)).response.status, 404);
      assert.deepEqual((await request("/api/travel-expenses?weekStart=2026-08-03")).body.items, []);

      const audits = await request(`/api/audit-logs?entityType=travel_expense&entityId=${encodeURIComponent(created.id)}`);
      assert.deepEqual(
        audits.body.items.map((item) => item.action).sort(),
        ["travel_expense.create", "travel_expense.delete", "travel_expense.update"],
      );
      assert.equal(audits.body.items.every((item) => item.actor === "travel-owner"), true);
    });
  });

  it("strictly rejects unknown fields, invalid dates, and invalid integer-cent values without writes", async () => {
    await withHarness(async ({ request }) => {
      for (const [body, field] of [
        [expense({ unexpected: true }), "unexpected"],
        [expense({ owner: "other-user" }), "owner"],
        [expense({ occurredOn: "2026-02-30" }), "occurredOn"],
        [expense({ payments: [payment({ paidAt: "2026-02-30T12:30:00+08:00" })] }), "payments[0].paidAt"],
        [expense({ payments: [payment({ amountCents: -1 })] }), "payments[0].amountCents"],
        [expense({ payments: [payment({ reimbursementCents: 1.5 })] }), "payments[0].reimbursementCents"],
      ]) {
        const result = await request("/api/travel-expenses", {
          method: "POST",
          body: JSON.stringify(body),
        });
        assertValidation(result, field);
      }
      assert.deepEqual((await request("/api/travel-expenses?weekStart=2026-08-03")).body.items, []);
    });
  });

  it("uploads authenticated image content, returns exact binary headers, and deletes by expense version", async () => {
    await withHarness(async ({ authenticatedFetch, request }) => {
      const created = await createExpense(request);
      const uploadBody = attachment(VALID_PNG, { paymentIds: [created.payments[0].id] });

      const missingPrecondition = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}/attachments`, {
        method: "POST",
        body: JSON.stringify(uploadBody),
      });
      assert.equal(missingPrecondition.response.status, 428);

      const uploaded = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}/attachments`, {
        method: "POST",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify(uploadBody),
      });
      assert.equal(uploaded.response.status, 201);
      assert.equal(uploaded.body.item.version, 2);
      assert.equal(uploaded.body.item.attachments.length, 1);
      const storedAttachment = uploaded.body.item.attachments[0];
      assert.deepEqual(storedAttachment.paymentIds, [created.payments[0].id]);

      const contentResponse = await authenticatedFetch(storedAttachment.contentUrl);
      assert.equal(contentResponse.status, 200);
      assert.equal(contentResponse.headers.get("content-type"), "image/png");
      assert.equal(contentResponse.headers.get("content-length"), String(VALID_PNG.length));
      assert.equal(contentResponse.headers.get("cache-control"), "no-store");
      assert.equal(contentResponse.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await contentResponse.arrayBuffer()), VALID_PNG);

      const missingDeleteVersion = await request(`/api/travel-expense-attachments/${encodeURIComponent(storedAttachment.id)}`, {
        method: "DELETE",
        body: "{}",
      });
      assert.equal(missingDeleteVersion.response.status, 428);

      const removed = await request(`/api/travel-expense-attachments/${encodeURIComponent(storedAttachment.id)}`, {
        method: "DELETE",
        headers: { "If-Match": '"2"' },
        body: "{}",
      });
      assert.equal(removed.response.status, 200);
      assert.equal(removed.body.item.version, 3);
      assert.deepEqual(removed.body.item.attachments, []);
      assert.equal((await authenticatedFetch(storedAttachment.contentUrl)).status, 404);

      const audits = await request("/api/audit-logs?entityType=travel_expense_attachment");
      assert.deepEqual(
        audits.body.items.map((item) => item.action).sort(),
        ["travel_expense.attachment_add", "travel_expense.attachment_delete"],
      );
      assert.doesNotMatch(JSON.stringify(audits.body), new RegExp(uploadBody.contentBase64.slice(0, 12)));
    });
  });

  it("uploads a PDF payment proof and returns the exact original PDF bytes", async () => {
    await withHarness(async ({ authenticatedFetch, request }) => {
      const created = await createExpense(request);
      const originalFileName = "  payment's (proof) 甲.pdf  ";
      const uploadBody = attachment(VALID_PDF, {
        paymentIds: [created.payments[0].id],
        fileName: originalFileName,
        mediaType: "application/pdf",
      });

      const uploaded = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}/attachments`, {
        method: "POST",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify(uploadBody),
      });
      assert.equal(uploaded.response.status, 201);
      const storedAttachment = uploaded.body.item.attachments[0];
      assert.equal(storedAttachment.mediaType, "application/pdf");
      assert.equal(storedAttachment.fileName, originalFileName);
      assert.equal(storedAttachment.sizeBytes, VALID_PDF.length);

      const contentResponse = await authenticatedFetch(storedAttachment.contentUrl);
      assert.equal(contentResponse.status, 200);
      assert.equal(contentResponse.headers.get("content-type"), "application/pdf");
      assert.equal(contentResponse.headers.get("content-length"), String(VALID_PDF.length));
      assert.equal(contentResponse.headers.get("cache-control"), "no-store");
      assert.equal(
        contentResponse.headers.get("content-disposition"),
        "inline; filename*=UTF-8''%20%20payment%27s%20%28proof%29%20%E7%94%B2.pdf%20%20",
      );
      assert.equal(contentResponse.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await contentResponse.arrayBuffer()), VALID_PDF);
    });
  });

  it("uses a 17-MiB JSON ceiling while enforcing a 12-MiB decoded document ceiling and magic bytes", async () => {
    await withHarness(async ({ request }) => {
      const created = await createExpense(request);
      const acceptedContent = paddedPng(12 * 1024 * 1024);
      const accepted = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}/attachments`, {
        method: "POST",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify(attachment(acceptedContent, { kind: "invoice", paymentIds: [] })),
      });
      assert.equal(accepted.response.status, 201, "attachment JSON may exceed the default one-MiB limit");

      const tooLargeContent = paddedPng(12 * 1024 * 1024 + 1);
      const tooLarge = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}/attachments`, {
        method: "POST",
        headers: { "If-Match": '"2"' },
        body: JSON.stringify(attachment(tooLargeContent, { kind: "invoice", paymentIds: [] })),
      });
      assertValidation(tooLarge, "contentBase64");

      const fakeImage = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}/attachments`, {
        method: "POST",
        headers: { "If-Match": '"2"' },
        body: JSON.stringify(attachment(Buffer.from("not a png"))),
      });
      assertValidation(fakeImage, "contentBase64");

      const truncatedJpeg = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}/attachments`, {
        method: "POST",
        headers: { "If-Match": '"2"' },
        body: JSON.stringify(attachment(SHORT_JPEG_ENVELOPE, {
          fileName: "truncated.jpg",
          mediaType: "image/jpeg",
        })),
      });
      assertValidation(truncatedJpeg, "contentBase64");

      for (const [fileName, mediaType, content] of [
        ["signature-only.png", "image/png", SHORT_PNG_SIGNATURE],
        ["container-only.webp", "image/webp", SHORT_WEBP_CONTAINER],
      ]) {
        const invalidImage = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}/attachments`, {
          method: "POST",
          headers: { "If-Match": '"2"' },
          body: JSON.stringify(attachment(content, { fileName, mediaType })),
        });
        assertValidation(invalidImage, "contentBase64");
      }

      const requestTooLarge = await request(`/api/travel-expenses/${encodeURIComponent(created.id)}/attachments`, {
        method: "POST",
        headers: { "If-Match": '"2"' },
        body: JSON.stringify({ ...attachment(), padding: "x".repeat(17 * 1024 * 1024) }),
      });
      assert.equal(requestTooLarge.response.status, 413);
      assert.equal(requestTooLarge.body.error.code, "PAYLOAD_TOO_LARGE");
    });
  });

  it("creates, lists, version-updates, and soft-deletes advances with audit history", async () => {
    await withHarness(async ({ request }) => {
      const created = await request("/api/travel-expense-advances", {
        method: "POST",
        body: JSON.stringify(advance()),
      });
      assert.equal(created.response.status, 201);
      assert.equal(created.body.item.owner, "travel-owner");
      assert.deepEqual(
        (await request("/api/travel-expense-advances?weekStart=2026-08-03")).body.items,
        [created.body.item],
      );

      const missingPrecondition = await request(`/api/travel-expense-advances/${encodeURIComponent(created.body.item.id)}`, {
        method: "PATCH",
        body: JSON.stringify(advance({ status: "closed" })),
      });
      assert.equal(missingPrecondition.response.status, 428);

      const updated = await request(`/api/travel-expense-advances/${encodeURIComponent(created.body.item.id)}`, {
        method: "PATCH",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify(advance({ status: "closed" })),
      });
      assert.equal(updated.response.status, 200);
      assert.equal(updated.body.item.version, 2);
      assert.equal(updated.body.item.status, "closed");

      const deleted = await request(`/api/travel-expense-advances/${encodeURIComponent(created.body.item.id)}`, {
        method: "DELETE",
        headers: { "If-Match": '"2"' },
        body: "{}",
      });
      assert.equal(deleted.response.status, 200);
      assert.equal(deleted.body.deleted.version, 3);
      assert.deepEqual((await request("/api/travel-expense-advances?weekStart=2026-08-03")).body.items, []);

      const audits = await request(`/api/audit-logs?entityType=travel_expense_advance&entityId=${encodeURIComponent(created.body.item.id)}`);
      assert.deepEqual(
        audits.body.items.map((item) => item.action).sort(),
        ["travel_expense_advance.create", "travel_expense_advance.delete", "travel_expense_advance.update"],
      );
    });
  });

  it("isolates expenses, attachment content, and advances by authenticated account", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-travel-expense-owner-api-"));
    const databaseUrl = join(tempDir, "owner.sqlite");
    let first;
    let second;
    try {
      first = await startServer(databaseUrl, "owner-a");
      const createdExpense = await createExpense(first.request);
      const uploaded = await first.request(`/api/travel-expenses/${encodeURIComponent(createdExpense.id)}/attachments`, {
        method: "POST",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify(attachment(VALID_PNG, { paymentIds: [createdExpense.payments[0].id] })),
      });
      assert.equal(uploaded.response.status, 201);
      const contentUrl = uploaded.body.item.attachments[0].contentUrl;
      const createdAdvance = await first.request("/api/travel-expense-advances", {
        method: "POST",
        body: JSON.stringify(advance()),
      });
      assert.equal(createdAdvance.response.status, 201);
      await closeServer(first.server);
      first = null;

      second = await startServer(databaseUrl, "owner-b");
      assert.deepEqual((await second.request("/api/travel-expenses?weekStart=2026-08-03")).body.items, []);
      assert.deepEqual(
        (await second.request("/api/audit-logs?entityType=travel_expense")).body.items,
        [],
        "an authenticated account must not read another owner's audit history",
      );
      assert.equal((await second.request(`/api/travel-expenses/${encodeURIComponent(createdExpense.id)}`)).response.status, 404);
      assert.equal((await second.authenticatedFetch(contentUrl)).status, 404);
      assert.deepEqual((await second.request("/api/travel-expense-advances?weekStart=2026-08-03")).body.items, []);
      const foreignPatch = await second.request(`/api/travel-expenses/${encodeURIComponent(createdExpense.id)}`, {
        method: "PATCH",
        headers: { "If-Match": '"2"' },
        body: JSON.stringify(expense()),
      });
      assert.equal(foreignPatch.response.status, 404);
    } finally {
      if (first) await closeServer(first.server);
      if (second) await closeServer(second.server);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rolls back a created expense when audit persistence fails", async () => {
    await withHarness(async ({ request }) => {
      const failed = await request("/api/travel-expenses", {
        method: "POST",
        body: JSON.stringify(expense()),
      });
      assert.equal(failed.response.status, 500);
      assert.equal(failed.body.error.code, "INTERNAL_ERROR");
      assert.deepEqual((await request("/api/travel-expenses?weekStart=2026-08-03")).body.items, []);
      assert.deepEqual((await request("/api/audit-logs?entityType=travel_expense")).body.items, []);
    }, { failpoints: new Set(["travelExpense.create.afterWrite"]) });
  });
});
