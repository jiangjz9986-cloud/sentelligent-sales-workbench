import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOMER_IMPORT_ACTION_LABELS,
  buildCustomerImportCancelRequest,
  buildCustomerImportConfirmRequest,
  buildCustomerImportPreviewRequest,
  cleanCustomerImportMapping,
  customerImportCanConfirm,
  customerImportErrorMessage,
  customerImportHeaders,
  customerImportSummary,
  customerImportVerificationItems,
  formatCustomerImportBytes,
  normalizeCustomerImportResult,
  validateCustomerImportFile,
} from "./customerImportModel.js";

const fileDigest = "a".repeat(64);
const previewDigest = "b".repeat(64);

function preview(overrides = {}) {
  return {
    batch: {
      id: "batch-1",
      owner: "owner-a",
      status: "preview",
      fileName: "customers.csv",
      mediaType: "text/csv",
      fileSizeBytes: 2048,
      fileSha256: fileDigest,
      totalRows: 3,
      validRows: 3,
      errorRows: 0,
      duplicateRows: 1,
    },
    previewDigest,
    mapping: {
      fieldToHeader: { name: "客户名称", region: "区域" },
      headerToField: { "客户名称": "name", "区域": "region" },
      ignoredHeaders: ["owner"],
      unmappedHeaders: ["备注"],
      requiredFields: ["name"],
      digest: "c".repeat(64),
    },
    rows: [
      {
        id: "row-1",
        rowNumber: 2,
        status: "valid",
        action: "create",
        canonicalName: "海州医院",
        normalized: { name: "海州医院", region: "连云港" },
      },
      {
        id: "row-2",
        rowNumber: 3,
        status: "duplicate",
        action: "merge",
        canonicalName: "东城医院",
        customerId: "customer-1",
        matchedBy: "alias",
        normalized: { name: "东城医院" },
      },
      {
        id: "row-3",
        rowNumber: 4,
        status: "error",
        action: "reject",
        canonicalName: "未命名客户",
        errors: [{ field: "name", code: "REQUIRED", message: "客户名称不能为空" }],
      },
    ],
    ...overrides,
  };
}

test("normalizes import result aliases and reconstructs available headers", () => {
  const normalized = normalizeCustomerImportResult({ customerImportBatch: preview().batch, customerImportRows: preview().rows, mapping: preview().mapping, previewDigest });
  assert.equal(normalized.batch.id, "batch-1");
  assert.equal(normalized.rows[1].customerId, "customer-1");
  assert.deepEqual(normalized.headers, ["客户名称", "区域", "owner", "备注"]);
  assert.deepEqual(customerImportHeaders(normalized), normalized.headers);
});

test("summary follows only service preview actions without mutating the result", () => {
  const result = preview();
  const before = structuredClone(result);
  const expected = {
    total: 3,
    create: 1,
    merge: 1,
    skip: 0,
    reject: 1,
    errors: 1,
    committed: 0,
  };
  assert.deepEqual(customerImportSummary(result), expected);
  assert.deepEqual(customerImportSummary(result, { "2": "skip", "3": "skip" }), expected);
  assert.deepEqual(result, before);
});

test("normalized rows preserve the service preview action vocabulary", () => {
  assert.deepEqual(normalizeCustomerImportResult(preview()).rows.map((row) => row.action), ["create", "merge", "reject"]);
  assert.deepEqual(Object.keys(CUSTOMER_IMPORT_ACTION_LABELS), ["create", "merge", "skip", "reject"]);
});

test("request builders freeze preview to file and mapping while preserving confirmation digests", () => {
  const result = preview({ rows: preview().rows.slice(0, 2), batch: { ...preview().batch, totalRows: 2, errorRows: 0 } });
  const file = { name: "customers.csv", size: 20 };
  const previewRequest = buildCustomerImportPreviewRequest({
    file,
    mapping: { name: "客户名称", unknown: "不应发送" },
    rowActions: { "2": "skip", bad: "unknown" },
    idempotencyKey: "preview-key",
  });
  assert.deepEqual(previewRequest, {
    file,
    mapping: { name: "客户名称" },
    idempotencyKey: "preview-key",
  });
  assert.equal(Object.hasOwn(previewRequest, "rowActions"), false);
  assert.deepEqual(buildCustomerImportConfirmRequest(result, "confirm-key"), {
    batchId: "batch-1",
    confirmed: true,
    previewDigest,
    fileSha256: fileDigest,
    idempotencyKey: "confirm-key",
  });
  assert.deepEqual(buildCustomerImportCancelRequest(result, { reason: "review_cancelled", idempotencyKey: "cancel-key" }), {
    batchId: "batch-1",
    reason: "review_cancelled",
    idempotencyKey: "cancel-key",
  });
});

test("confirmability requires a complete preview and permits explicitly rejected error rows", () => {
  assert.equal(customerImportCanConfirm(preview()), true);
  const invalid = preview({ rows: preview().rows.map((row) => (row.status === "error" ? { ...row, action: "create" } : row)) });
  assert.equal(customerImportCanConfirm(invalid), false);
  assert.equal(customerImportCanConfirm(preview({ previewDigest: "" })), false);
  assert.equal(customerImportCanConfirm(preview({ batch: { ...preview().batch, status: "committed" } })), false);
});

test("file validation, digest verification, byte formatting, and error copy stay user-facing", () => {
  assert.equal(validateCustomerImportFile(null).code, "FILE_REQUIRED");
  assert.equal(validateCustomerImportFile({ name: "customers.txt", size: 20 }).code, "UNSUPPORTED_FORMAT");
  assert.equal(validateCustomerImportFile({ name: "customers.csv", size: 0 }).code, "EMPTY_FILE");
  assert.equal(validateCustomerImportFile({ name: "customers.xlsx", size: 11 * 1024 * 1024 }).code, "FILE_TOO_LARGE");
  assert.equal(validateCustomerImportFile({ name: "customers.CSV", size: 20 }).valid, true);
  assert.equal(formatCustomerImportBytes(2048), "2.0 KB");
  assert.equal(customerImportErrorMessage({ code: "CUSTOMER_IMPORT_PREVIEW_STALE" }), "客户资料已变化，请重新生成预览。");
  assert.deepEqual(customerImportVerificationItems(preview()).map((item) => item.id), ["preview", "file", "mapping"]);
});
