import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCustomerImportResult,
  createSalesWorkbenchApi,
} from "./salesWorkbenchApi.js";

const fileSha256 = "a".repeat(64);
const previewDigest = "b".repeat(64);
const mappingDigest = "c".repeat(64);

function headers(values = {}) {
  const entries = new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), String(value)]));
  return { get: (name) => entries.get(String(name).toLowerCase()) ?? null };
}

function response(item, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(),
    text: async () => JSON.stringify({ item }),
  };
}

function headerValue(options, name) {
  const supplied = options.headers ?? {};
  const key = Object.keys(supplied).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? supplied[key] : undefined;
}

function importResult() {
  return {
    customerImportBatch: {
      id: "batch/1",
      owner: "owner-a",
      status: "preview",
      fileName: "customers.csv",
      mediaType: "text/csv",
      fileSizeBytes: 32,
      fileSha256,
      totalRows: 1,
      validRows: 1,
      errorRows: 0,
      duplicateRows: 0,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      committedAt: null,
    },
    customerImportRows: [{
      id: "row-1",
      batchId: "batch/1",
      rowNumber: 2,
      status: "valid",
      action: "create",
      canonicalName: "合成医院",
      customerId: null,
      normalized: { name: "合成医院" },
      errors: [],
      rowDigest: "d".repeat(64),
    }],
    previewDigest,
    mapping: {
      fieldToHeader: { name: "客户名称" },
      headerToField: { "客户名称": "name" },
      ignoredHeaders: [],
      unmappedHeaders: [],
      requiredFields: ["name"],
      digest: mappingDigest,
    },
    replayed: false,
  };
}

function namedCsvFile() {
  const file = new Blob(["客户名称\n合成医院\n"], { type: "text/csv" });
  Object.defineProperty(file, "name", { value: "customers.csv" });
  return file;
}

test("customer import API preserves multipart, CSRF, digest, and idempotency boundaries", async () => {
  const calls = [];
  const api = createSalesWorkbenchApi({
    baseUrl: "https://example.test/",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return response(importResult(), url.endsWith("/confirm") ? 200 : 201);
    },
  });
  api.setSession({ csrfToken: ["csrf", "customer", "import"].join("-") });

  const preview = await api.previewCustomerImport(namedCsvFile(), {
    mapping: { name: "客户名称" },
    rowActions: { "2": "create" },
    idempotencyKey: "customer-import-preview-1",
  });
  const loaded = await api.getCustomerImport("batch/1");
  const confirmed = await api.confirmCustomerImport("batch/1", {
    confirmed: true,
    previewDigest,
    fileSha256,
    idempotencyKey: "customer-import-confirm-1",
  });
  const cancelled = await api.cancelCustomerImport("batch/1", {
    reason: "operator_cancelled",
    idempotencyKey: "customer-import-cancel-1",
  });

  assert.equal(preview.customerImportBatch.id, "batch/1");
  assert.equal(loaded.customerImportRows[0].rowDigest, "d".repeat(64));
  assert.equal(confirmed.previewDigest, previewDigest);
  assert.equal(cancelled.mapping.digest, mappingDigest);

  const previewCall = calls[0];
  assert.equal(previewCall.url, "https://example.test/api/customer-imports/preview");
  assert.equal(previewCall.options.method, "POST");
  assert.equal(previewCall.options.credentials, "include");
  assert.equal(headerValue(previewCall.options, "Idempotency-Key"), "customer-import-preview-1");
  assert.equal(headerValue(previewCall.options, "X-CSRF-Token"), "csrf-customer-import");
  assert.equal(headerValue(previewCall.options, "Content-Type"), undefined);
  assert.ok(previewCall.options.body instanceof FormData);
  assert.equal(previewCall.options.body.get("file").name, "customers.csv");
  assert.deepEqual(JSON.parse(previewCall.options.body.get("mapping")), { name: "客户名称" });
  assert.equal(previewCall.options.body.get("rowActions"), null);

  assert.equal(calls[1].url, "https://example.test/api/customer-imports/batch%2F1");
  assert.equal(calls[1].options.method ?? "GET", "GET");
  assert.equal(headerValue(calls[1].options, "X-CSRF-Token"), undefined);

  assert.equal(calls[2].url, "https://example.test/api/customer-imports/batch%2F1/confirm");
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    confirmed: true,
    previewDigest,
    fileSha256,
  });
  assert.equal(headerValue(calls[2].options, "Idempotency-Key"), "customer-import-confirm-1");
  assert.equal(headerValue(calls[2].options, "X-CSRF-Token"), "csrf-customer-import");

  assert.equal(calls[3].url, "https://example.test/api/customer-imports/batch%2F1/cancel");
  assert.deepEqual(JSON.parse(calls[3].options.body), { reason: "operator_cancelled" });
  assert.equal(headerValue(calls[3].options, "Idempotency-Key"), "customer-import-cancel-1");
  assert.equal(headerValue(calls[3].options, "X-CSRF-Token"), "csrf-customer-import");
});

test("customer import API rejects incomplete confirmation inputs and malformed result entities", async () => {
  const api = createSalesWorkbenchApi({
    baseUrl: "https://example.test",
    fetchImpl: async () => response(importResult()),
  });

  await assert.rejects(
    () => api.confirmCustomerImport("batch-1", {
      confirmed: false,
      previewDigest,
      fileSha256,
      idempotencyKey: "confirm-key",
    }),
    /confirmed: expected true/u,
  );
  await assert.rejects(
    () => api.confirmCustomerImport("batch-1", {
      confirmed: true,
      previewDigest: "not-a-digest",
      fileSha256,
      idempotencyKey: "confirm-key",
    }),
    /previewDigest: expected SHA-256 digest/u,
  );
  const malformed = importResult();
  delete malformed.customerImportRows[0].rowDigest;
  assert.throws(
    () => assertCustomerImportResult(malformed),
    /customerImportRows\[0\]\.rowDigest/u,
  );
});
