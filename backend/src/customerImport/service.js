import { randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { get, all, run } from "../db.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { createCustomer, customerFromRow, getActiveCustomer, updateCustomer } from "../customers/customerStore.js";
import { CUSTOMER_IMPORT_ACTIONS, CUSTOMER_IMPORT_FIELDS, CUSTOMER_IMPORT_LIMITS } from "./constants.js";
import { importError } from "./errors.js";
import { parseCustomerImportFile, parseCustomerImportFileAsync, readCustomerImportBytes } from "./parser.js";
import {
  buildCustomerNameIndex,
  canonicalizeCustomerName,
  customerImportStableJson,
  customerImportPlanConflicts,
  customerSnapshotDigest,
  mergeCustomerImportShape,
  normalizeCustomerImportRows,
} from "./normalizer.js";
import { importDigest, stableImportJson } from "./stable.js";

const IMPORT_META_KEY = "__customerImport";
const IMPORT_PREVIEW_AUDIT = "customer_import.preview";
const IMPORT_ROW_PREVIEW_AUDIT = "customer_import.row.preview";
const IMPORT_CONFIRM_AUDIT = "customer_import.confirm";
const IMPORT_ROW_COMMIT_AUDIT = "customer_import.row.commit";
const IMPORT_CANCEL_AUDIT = "customer_import.cancel";
const IMPORT_IDEMPOTENCY_BIND_AUDIT = "customer_import.idempotency.bind";

function isDatabase(value) {
  return Boolean(value && typeof value.prepare === "function" && typeof value.exec === "function");
}

function transaction(db, work) {
  return db.isTransaction ? work() : withImmediateTransaction(db, work);
}

function requiredText(value, field, max = 200) {
  if (typeof value !== "string") {
    throw importError("CUSTOMER_IMPORT_INVALID_REQUEST", `${field} must be a string`, { [field]: "type" });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw importError("CUSTOMER_IMPORT_INVALID_REQUEST", `${field} is invalid`, { [field]: "value" });
  }
  return normalized;
}

function optionalText(value, field, max = 200) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, max);
}

function requireHexDigest(value, field) {
  const normalized = requiredText(value, field, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw importError("CUSTOMER_IMPORT_INVALID_REQUEST", `${field} must be a SHA-256 digest`, { [field]: "digest" });
  }
  return normalized;
}

function normalizeIdempotencyKey(value, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw importError("CUSTOMER_IMPORT_IDEMPOTENCY_REQUIRED", "An idempotency key is required", null, 428);
  }
  return requiredText(value, "idempotencyKey", 200);
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : now ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Customer import clock must return a valid date");
  return date.toISOString();
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function compactErrorList(errors) {
  return (Array.isArray(errors) ? errors : []).slice(0, 50).map((error) => ({
    field: String(error?.field ?? "row").slice(0, 200),
    code: String(error?.code ?? "INVALID_VALUE").slice(0, 80),
    message: String(error?.message ?? "导入行无效").slice(0, 500),
  }));
}

function storedNormalized(rowPlan) {
  return {
    ...(rowPlan.normalized ?? {}),
    [IMPORT_META_KEY]: {
      providedFields: [...(rowPlan.providedFields ?? [])],
      duplicateOfRow: rowPlan.duplicateOfRow ?? null,
      matchedBy: rowPlan.matchedBy ?? null,
      matchVersion: rowPlan.matchVersion ?? null,
      customerSnapshotDigest: rowPlan.customerSnapshotDigest ?? null,
      customerId: rowPlan.customerId ?? null,
    },
  };
}

function unpackNormalized(value) {
  const parsed = typeof value === "string" ? parseJson(value, {}) : value ?? {};
  const metadata = parsed?.[IMPORT_META_KEY] && typeof parsed[IMPORT_META_KEY] === "object"
    ? parsed[IMPORT_META_KEY]
    : {};
  const normalized = {};
  for (const field of CUSTOMER_IMPORT_FIELDS) if (Object.hasOwn(parsed, field)) normalized[field] = parsed[field];
  return { normalized, metadata };
}

function batchEntity(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    status: row.status,
    fileName: row.file_name,
    mediaType: row.media_type,
    fileSizeBytes: Number(row.file_size_bytes),
    fileSha256: row.file_sha256,
    totalRows: Number(row.total_rows),
    validRows: Number(row.valid_rows),
    errorRows: Number(row.error_rows),
    duplicateRows: Number(row.duplicate_rows),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    committedAt: row.committed_at ?? null,
  };
}

function rowEntity(row) {
  if (!row) return null;
  const unpacked = unpackNormalized(row.normalized_json);
  return {
    id: row.id,
    batchId: row.batch_id,
    rowNumber: Number(row.row_number),
    status: row.status,
    action: row.action,
    canonicalName: row.canonical_name,
    customerId: row.customer_id ?? unpacked.metadata.customerId ?? null,
    normalized: unpacked.normalized,
    errors: parseJson(row.errors_json, []),
    rowDigest: row.row_digest,
    ...(unpacked.metadata.matchedBy ? { matchedBy: unpacked.metadata.matchedBy } : {}),
    ...(unpacked.metadata.duplicateOfRow ? { duplicateOfRow: Number(unpacked.metadata.duplicateOfRow) } : {}),
  };
}

function selectBatch(db, { owner, batchId }) {
  return get(
    db,
    "SELECT * FROM customer_import_batches WHERE id = $id AND owner = $owner",
    { $id: batchId, $owner: owner },
  );
}

function selectRows(db, batchId) {
  return all(
    db,
    "SELECT * FROM customer_import_rows WHERE batch_id = $batchId ORDER BY row_number ASC",
    { $batchId: batchId },
  );
}

function activeCustomers(db, owner) {
  return all(
    db,
    "SELECT * FROM customers WHERE owner = $owner AND deleted_at IS NULL ORDER BY id ASC",
    { $owner: owner },
  ).map(customerFromRow);
}

function auditRows(db, { action, owner, entityId = null }) {
  const clauses = ["action = $action", "actor = $owner"];
  const params = { $action: action, $owner: owner };
  if (entityId !== null) {
    clauses.push("entity_id = $entityId");
    params.$entityId = entityId;
  }
  return all(
    db,
    `SELECT * FROM audit_logs WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, id ASC`,
    params,
  );
}

function latestPreviewMetadata(db, owner, batchId) {
  const rows = auditRows(db, { action: IMPORT_PREVIEW_AUDIT, owner, entityId: batchId });
  const row = rows.at(-1);
  if (!row) return null;
  const metadata = parseJson(row.metadata_json, {});
  return metadata && typeof metadata === "object" ? metadata : null;
}

function metadataString(metadata, key) {
  return typeof metadata?.[key] === "string" ? metadata[key] : null;
}

function mappingFromMetadata(metadata) {
  const raw = metadataString(metadata, "mappingJson");
  if (!raw) return null;
  const mapping = parseJson(raw, null);
  return mapping && typeof mapping === "object" ? mapping : null;
}

function responseReceiptFromMetadata(row) {
  const metadata = parseJson(row.metadata_json, {});
  const raw = metadataString(metadata, "receiptJson");
  return raw ? parseJson(raw, null) : null;
}

function batchResult(db, batchRow, { previewDigest = null, mapping = null, replayed = false, receipt = null } = {}) {
  const rows = selectRows(db, batchRow.id).map(rowEntity);
  return {
    batch: batchEntity(batchRow),
    customerImportBatch: batchEntity(batchRow),
    rows,
    customerImportRows: rows,
    previewDigest,
    mapping,
    replayed,
    ...(receipt ? { receipt } : {}),
  };
}

function requestFile(input) {
  const file = input?.file ?? input?.upload ?? null;
  const source = file && typeof file === "object" ? file : input;
  return {
    bytes: source?.bytes ?? source?.buffer ?? source?.data,
    file,
    fileName: source?.fileName ?? source?.name ?? input?.fileName,
    mediaType: source?.mediaType ?? source?.type ?? input?.mediaType,
  };
}

function requestMapping(input) {
  return input?.mapping ?? input?.fieldMapping ?? null;
}

function requestRowActions(input) {
  return input?.rowActions ?? input?.actions ?? null;
}

function previewInput(input) {
  return {
    owner: requiredText(input?.owner, "owner"),
    idempotencyKey: normalizeIdempotencyKey(input?.idempotencyKey ?? input?.idempotency_key),
    requestId: optionalText(input?.requestId, "requestId"),
    file: requestFile(input),
    mapping: requestMapping(input),
    rowActions: requestRowActions(input),
    hasHeader: input?.hasHeader !== false,
    limits: input?.limits ?? {},
  };
}

function confirmInput(input, positionalBatchId = null, positionalOptions = null) {
  const source = typeof input === "string"
    ? { ...(positionalOptions ?? {}), batchId: input }
    : { ...(input ?? {}), ...(positionalOptions ?? {}) };
  if (positionalBatchId && typeof input !== "string") source.batchId ??= positionalBatchId;
  return {
    owner: requiredText(source.owner, "owner"),
    batchId: requiredText(source.batchId ?? source.id, "batchId"),
    confirmed: source.confirmed === true,
    previewDigest: requireHexDigest(source.previewDigest, "previewDigest"),
    fileSha256: requireHexDigest(source.fileSha256, "fileSha256"),
    idempotencyKey: normalizeIdempotencyKey(source.idempotencyKey ?? source.idempotency_key),
    requestId: optionalText(source.requestId, "requestId"),
  };
}

function cancelInput(input, positionalBatchId = null, positionalOptions = null) {
  const source = typeof input === "string"
    ? { ...(positionalOptions ?? {}), batchId: input }
    : { ...(input ?? {}), ...(positionalOptions ?? {}) };
  if (positionalBatchId && typeof input !== "string") source.batchId ??= positionalBatchId;
  return {
    owner: requiredText(source.owner, "owner"),
    batchId: requiredText(source.batchId ?? source.id, "batchId"),
    reason: optionalText(source.reason, "reason", 500),
    idempotencyKey: normalizeIdempotencyKey(source.idempotencyKey ?? source.idempotency_key),
    requestId: optionalText(source.requestId, "requestId"),
  };
}

function mappingDigest(mapping) {
  return mapping?.digest ?? importDigest({
    fieldToHeader: mapping?.fieldToHeader ?? {},
    ignoredHeaders: mapping?.ignoredHeaders ?? [],
    unmappedHeaders: mapping?.unmappedHeaders ?? [],
  });
}

function previewPlanDigest({ owner, parsed, normalized, mapping, rowActions }) {
  return importDigest({
    release: "v0.12.0",
    owner,
    format: parsed.format,
    fileSha256: parsed.fileSha256,
    mappingDigest: mappingDigest(mapping),
    rowActions: rowActions ?? null,
    rows: normalized.rows.map((row) => ({
      rowNumber: row.rowNumber,
      rowDigest: row.rowDigest,
      action: row.action,
      status: row.status,
      customerId: row.customerId ?? null,
      customerSnapshotDigest: row.customerSnapshotDigest ?? null,
      matchVersion: row.matchVersion ?? null,
    })),
  });
}

function previewRequestDigest({ owner, parsed, mapping, rowActions, hasHeader }) {
  return importDigest({
    owner,
    format: parsed.format,
    fileName: parsed.fileName,
    mediaType: parsed.mediaType,
    fileSha256: parsed.fileSha256,
    mappingDigest: mappingDigest(mapping),
    mapping: mapping?.fieldToHeader ?? null,
    rowActions: rowActions ?? null,
    hasHeader,
  });
}

function canonicalNameForRow(row, rowNumber) {
  const candidate = String(row?.normalized?.name ?? "").trim();
  if (candidate) return candidate.slice(0, 200);
  return `未命名第${rowNumber}行`.slice(0, 200);
}

function rowPreviewMetadata(rowPlan) {
  return {
    rowNumber: rowPlan.rowNumber,
    status: rowPlan.status,
    action: rowPlan.action,
    customerId: rowPlan.customerId ?? null,
    matchedBy: rowPlan.matchedBy ?? null,
    duplicateOfRow: rowPlan.duplicateOfRow ?? null,
    rowDigest: rowPlan.rowDigest,
    errors: compactErrorList(rowPlan.errors),
  };
}

function customerAuditSnapshot(customer) {
  if (!customer) return null;
  return {
    id: customer.id,
    version: customer.version,
    name: customer.name,
    owner: customer.owner,
    region: customer.region,
    type: customer.type,
    level: customer.level,
    relation: customer.relation,
    aliases: customer.aliases,
    tags: customer.tags,
  };
}

function customerForWrite(customer) {
  const result = {};
  for (const field of CUSTOMER_IMPORT_FIELDS) if (Object.hasOwn(customer ?? {}, field)) result[field] = customer[field];
  return result;
}

function mergeCustomerPatch(current, rowPlan) {
  return customerForWrite(mergeCustomerImportShape(current, rowPlan));
}

function rowMetadata(row) {
  const unpacked = unpackNormalized(row.normalized_json);
  return { ...unpacked.metadata, normalized: unpacked.normalized, errors: parseJson(row.errors_json, []) };
}

function assertConfirmableRows(rows) {
  const invalid = rows.filter((row) => {
    const metadata = rowMetadata(row);
    return (metadata.errors.length > 0 || row.status === "error") && row.action !== "reject";
  });
  if (invalid.length > 0) {
    throw importError("CUSTOMER_IMPORT_ROWS_INVALID", "导入批次仍包含错误行，不能确认", {
      rowNumbers: invalid.map((row) => Number(row.row_number)),
    });
  }
}

function currentCustomerById(db, owner, customerId) {
  return getActiveCustomer(db, customerId, { owner });
}

function revalidatePreviewRows(db, owner, rows) {
  const customers = activeCustomers(db, owner);
  const index = buildCustomerNameIndex(customers);
  for (const row of rows) {
    const metadata = rowMetadata(row);
    if (row.action === "skip" || row.action === "reject") continue;
    if (row.action === "merge") {
      const customerId = metadata.customerId ?? row.customer_id;
      const current = customerId ? currentCustomerById(db, owner, customerId) : null;
      if (!current || Number(current.version) !== Number(metadata.matchVersion)
        || customerSnapshotDigest(current) !== metadata.customerSnapshotDigest) {
        throw importError("CUSTOMER_IMPORT_PREVIEW_STALE", "客户资料已变化，请重新生成导入预览", {
          rowNumber: Number(row.row_number),
          customerId: customerId ?? null,
        }, 409);
      }
    } else if (row.action === "create") {
      const values = [metadata.normalized.name, ...(metadata.normalized.aliases ?? [])].filter(Boolean);
      const matches = new Set();
      for (const value of values) for (const match of index.get(canonicalizeCustomerName(value)) ?? []) matches.add(match.customer.id);
      if (matches.size > 0) {
        throw importError("CUSTOMER_IMPORT_PREVIEW_STALE", "新的同账号重复客户已出现，请重新生成导入预览", {
          rowNumber: Number(row.row_number),
        }, 409);
      }
    }
  }
}

function receiptForResult(batch, rows, counts, previewDigest) {
  return {
    batchId: batch.id,
    previewDigest,
    counts,
    rows: rows.map((row) => ({
      rowNumber: row.rowNumber,
      action: row.action,
      status: row.status,
      customerId: row.customerId ?? null,
    })),
  };
}

function confirmRequestDigest(input) {
  return importDigest({
    operation: "confirm",
    batchId: input.batchId,
    confirmed: true,
    previewDigest: input.previewDigest,
    fileSha256: input.fileSha256,
  });
}

function cancelRequestDigest(input) {
  return importDigest({
    operation: "cancel",
    batchId: input.batchId,
    reason: input.reason ?? null,
  });
}

function operationForAudit(action, metadata) {
  if (action === IMPORT_CONFIRM_AUDIT) return "confirm";
  if (action === IMPORT_CANCEL_AUDIT) return "cancel";
  if (action === IMPORT_IDEMPOTENCY_BIND_AUDIT) return metadata?.operation ?? null;
  return null;
}

function bindingRequestDigest(db, owner, operation, metadata, batchId) {
  if (typeof metadata?.requestDigest === "string" && metadata.requestDigest) return metadata.requestDigest;
  const batch = selectBatch(db, { owner, batchId });
  if (!batch) return null;
  if (operation === "confirm") {
    const previewDigest = metadataString(metadata, "previewDigest");
    if (!previewDigest) return null;
    return confirmRequestDigest({
      batchId,
      confirmed: true,
      previewDigest,
      fileSha256: batch.file_sha256,
    });
  }
  if (operation === "cancel") return cancelRequestDigest({ batchId, reason: metadata?.reason ?? null });
  return null;
}

function idempotencyBindingsForKey(db, owner, idempotencyKey) {
  const bindings = [];
  const previewBatch = get(
    db,
    "SELECT * FROM customer_import_batches WHERE owner = $owner AND idempotency_key = $key",
    { $owner: owner, $key: idempotencyKey },
  );
  if (previewBatch) {
    const metadata = latestPreviewMetadata(db, owner, previewBatch.id) ?? {};
    bindings.push({
      operation: "preview",
      batchId: previewBatch.id,
      requestDigest: metadataString(metadata, "requestDigest"),
      row: null,
      metadata,
      receipt: null,
    });
  }

  for (const action of [IMPORT_CONFIRM_AUDIT, IMPORT_CANCEL_AUDIT, IMPORT_IDEMPOTENCY_BIND_AUDIT]) {
    for (const row of auditRows(db, { action, owner })) {
      const metadata = parseJson(row.metadata_json, {});
      if (metadata?.idempotencyKey !== idempotencyKey) continue;
      const operation = operationForAudit(action, metadata);
      const batchId = String(metadata?.batchId ?? row.entity_id ?? "");
      if (!operation || !batchId) continue;
      bindings.push({
        operation,
        batchId,
        requestDigest: bindingRequestDigest(db, owner, operation, metadata, batchId),
        row,
        metadata,
        receipt: responseReceiptFromMetadata(row),
      });
    }
  }
  return bindings;
}

function findMatchingIdempotencyBinding(db, { owner, idempotencyKey, operation, batchId, requestDigest }) {
  const bindings = idempotencyBindingsForKey(db, owner, idempotencyKey);
  if (bindings.length === 0) return null;
  const matching = bindings.filter((binding) => (
    binding.operation === operation
    && (batchId === null || binding.batchId === batchId)
    && binding.requestDigest === requestDigest
  ));
  if (matching.length !== bindings.length || matching.length === 0) {
    throw importError("CUSTOMER_IMPORT_IDEMPOTENCY_KEY_REUSED", "导入幂等键已用于其他批次、动作或请求内容", null, 409);
  }
  return matching[0];
}

function terminalReceipt(db, owner, batch, operation, previewDigest) {
  for (const action of operation === "confirm" ? [IMPORT_CONFIRM_AUDIT, IMPORT_IDEMPOTENCY_BIND_AUDIT] : [IMPORT_CANCEL_AUDIT, IMPORT_IDEMPOTENCY_BIND_AUDIT]) {
    for (const row of auditRows(db, { action, owner, entityId: batch.id }).reverse()) {
      const metadata = parseJson(row.metadata_json, {});
      if (action === IMPORT_IDEMPOTENCY_BIND_AUDIT && metadata.operation !== operation) continue;
      const receipt = responseReceiptFromMetadata(row);
      if (receipt) return receipt;
    }
  }
  const rows = selectRows(db, batch.id).map(rowEntity);
  return receiptForResult(batch, rows, countCommittedRows(rows), previewDigest);
}

function bindTerminalIdempotencyKey(db, { owner, batch, operation, idempotencyKey, requestDigest, receipt, requestId }) {
  insertAudit(db, {
    action: IMPORT_IDEMPOTENCY_BIND_AUDIT,
    entityType: "customer_import_batch",
    entityId: batch.id,
    actor: owner,
    requestId,
    metadata: {
      operation,
      batchId: batch.id,
      idempotencyKey,
      requestDigest,
      receiptJson: stableImportJson(receipt),
    },
    before: { status: batch.status },
    after: { status: batch.status, operation },
  });
}

function markRow(db, rowId, { status, action, customerId = null, now }) {
  run(
    db,
    `UPDATE customer_import_rows
        SET status = $status,
            action = $action,
            customer_id = $customerId,
            updated_at = $updatedAt
      WHERE id = $id`,
    { $status: status, $action: action, $customerId: customerId, $updatedAt: now, $id: rowId },
  );
}

function countCommittedRows(rows) {
  return {
    created: rows.filter((row) => row.action === "create" && row.status === "committed").length,
    merged: rows.filter((row) => row.action === "merge" && row.status === "committed").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
    rejected: rows.filter((row) => row.status === "rejected").length,
  };
}

function previewService(db, options = {}) {
  const input = previewInput(options);
  const limits = { ...CUSTOMER_IMPORT_LIMITS, ...input.limits };
  const parsed = parseCustomerImportFile({
    ...input.file,
    bytes: input.file.bytes,
  }, { limits });
  if (input.hasHeader === false) {
    throw importError("CUSTOMER_IMPORT_HEADER_REQUIRED", "客户导入必须包含表头");
  }
  const normalized = normalizeCustomerImportRows(parsed, {
    requestedMapping: input.mapping,
    customers: activeCustomers(db, input.owner),
    rowActions: input.rowActions,
    limits,
  });
  const previewDigest = previewPlanDigest({
    owner: input.owner,
    parsed,
    normalized,
    mapping: normalized.mapping,
    rowActions: input.rowActions,
  });
  const requestDigest = previewRequestDigest({
    owner: input.owner,
    parsed,
    mapping: normalized.mapping,
    rowActions: input.rowActions,
    hasHeader: input.hasHeader,
  });
  const createdAt = nowIso(options.now);
  const idFactory = options.idFactory ?? randomUUID;

  const result = transaction(db, () => {
    const existingBinding = findMatchingIdempotencyBinding(db, {
      owner: input.owner,
      idempotencyKey: input.idempotencyKey,
      operation: "preview",
      batchId: null,
      requestDigest,
    });
    if (existingBinding) {
      const existing = selectBatch(db, { owner: input.owner, batchId: existingBinding.batchId });
      if (!existing) throw importError("CUSTOMER_IMPORT_BATCH_NOT_FOUND", "导入批次不存在", null, 404);
      const metadata = latestPreviewMetadata(db, input.owner, existing.id);
      return batchResult(db, existing, {
        previewDigest: metadataString(metadata, "previewDigest") ?? previewDigest,
        mapping: mappingFromMetadata(metadata) ?? normalized.mapping,
        replayed: true,
      });
    }

    const batchId = idFactory();
    if (typeof batchId !== "string" || !batchId.trim()) throw new TypeError("Customer import idFactory must return a string");
    run(
      db,
      `INSERT INTO customer_import_batches (
        id, owner, idempotency_key, status, file_name, media_type,
        file_size_bytes, file_sha256, total_rows, valid_rows, error_rows,
        duplicate_rows, created_at, updated_at, committed_at
      ) VALUES (
        $id, $owner, $idempotencyKey, 'preview', $fileName, $mediaType,
        $fileSizeBytes, $fileSha256, $totalRows, $validRows, $errorRows,
        $duplicateRows, $createdAt, $updatedAt, NULL
      )`,
      {
        $id: batchId,
        $owner: input.owner,
        $idempotencyKey: input.idempotencyKey,
        $fileName: parsed.fileName,
        $mediaType: parsed.mediaType,
        $fileSizeBytes: parsed.fileSizeBytes,
        $fileSha256: parsed.fileSha256,
        $totalRows: normalized.counts.totalRows,
        $validRows: normalized.counts.validRows,
        $errorRows: normalized.counts.errorRows,
        $duplicateRows: normalized.counts.duplicateRows,
        $createdAt: createdAt,
        $updatedAt: createdAt,
      },
    );

    const insertRow = db.prepare(`
      INSERT INTO customer_import_rows (
        id, batch_id, owner, row_number, status, action, canonical_name,
        customer_id, normalized_json, errors_json, row_digest, created_at, updated_at
      ) VALUES (
        $id, $batchId, $owner, $rowNumber, $status, $action, $canonicalName,
        $customerId, $normalizedJson, $errorsJson, $rowDigest, $createdAt, $updatedAt
      )
    `);
    for (const rowPlan of normalized.rows) {
      const rowId = idFactory();
      insertRow.run({
        $id: rowId,
        $batchId: batchId,
        $owner: input.owner,
        $rowNumber: rowPlan.rowNumber,
        $status: rowPlan.status,
        $action: rowPlan.action,
        $canonicalName: canonicalNameForRow(rowPlan, rowPlan.rowNumber),
        $customerId: rowPlan.customerId ?? null,
        $normalizedJson: JSON.stringify(storedNormalized(rowPlan)),
        $errorsJson: JSON.stringify(compactErrorList(rowPlan.errors)),
        $rowDigest: rowPlan.rowDigest,
        $createdAt: createdAt,
        $updatedAt: createdAt,
      });
      insertAudit(db, {
        action: IMPORT_ROW_PREVIEW_AUDIT,
        entityType: "customer_import_row",
        entityId: rowId,
        actor: input.owner,
        requestId: input.requestId,
        metadata: { batchId, ...rowPreviewMetadata(rowPlan) },
        after: { batchId, ...rowPreviewMetadata(rowPlan) },
      });
    }

    insertAudit(db, {
      action: IMPORT_PREVIEW_AUDIT,
      entityType: "customer_import_batch",
      entityId: batchId,
      actor: input.owner,
      requestId: input.requestId,
      metadata: {
        requestDigest,
        previewDigest,
        mappingJson: stableImportJson(normalized.mapping),
        rowActionsJson: input.rowActions === null || input.rowActions === undefined ? null : stableImportJson(input.rowActions),
        format: parsed.format,
        fileSha256: parsed.fileSha256,
        counts: normalized.counts,
      },
      after: {
        id: batchId,
        status: "preview",
        fileSha256: parsed.fileSha256,
        previewDigest,
        counts: normalized.counts,
      },
    });
    return batchResult(db, get(db, "SELECT * FROM customer_import_batches WHERE id = $id", { $id: batchId }), {
      previewDigest,
      mapping: normalized.mapping,
      replayed: false,
    });
  });
  return result;
}

export function previewCustomerImport(db, input, options = {}) {
  if (!isDatabase(db)) throw new TypeError("previewCustomerImport requires a SQLite database as its first argument");
  return previewService(db, { ...(input ?? {}), ...(options ?? {}) });
}

export async function previewCustomerImportAsync(db, input, options = {}) {
  if (!isDatabase(db)) throw new TypeError("previewCustomerImportAsync requires a SQLite database as its first argument");
  const source = { ...(input ?? {}) };
  const file = requestFile(source);
  if (file.bytes === undefined && file.file) source.file = {
    bytes: await readCustomerImportBytes(file.file),
    fileName: file.file.name ?? file.file.fileName ?? file.fileName,
    mediaType: file.file.type ?? file.file.mediaType ?? file.mediaType,
  };
  else if (file.bytes === undefined) source.bytes = await readCustomerImportBytes(source);
  return previewService(db, { ...source, ...(options ?? {}) });
}

function confirmService(db, options = {}) {
  const input = confirmInput(options);
  if (!input.confirmed) throw importError("CUSTOMER_IMPORT_CONFIRM_REQUIRED", "必须显式传入 confirmed: true");
  const now = nowIso(options.now);
  const idFactory = options.idFactory ?? randomUUID;

  return transaction(db, () => {
    const batch = selectBatch(db, input);
    if (!batch) throw importError("CUSTOMER_IMPORT_BATCH_NOT_FOUND", "导入批次不存在", null, 404);
    if (input.fileSha256 !== batch.file_sha256) {
      throw importError("CUSTOMER_IMPORT_FILE_DIGEST_MISMATCH", "导入文件摘要与预览不一致", null, 409);
    }
    const requestDigest = confirmRequestDigest(input);
    const previewMetadata = latestPreviewMetadata(db, input.owner, input.batchId);
    const storedPreviewDigest = metadataString(previewMetadata, "previewDigest");
    if (!storedPreviewDigest || storedPreviewDigest !== input.previewDigest) {
      throw importError("CUSTOMER_IMPORT_PREVIEW_DIGEST_MISMATCH", "预览摘要不一致，请重新生成预览", null, 409);
    }

    const priorByKey = findMatchingIdempotencyBinding(db, {
      owner: input.owner,
      idempotencyKey: input.idempotencyKey,
      operation: "confirm",
      batchId: input.batchId,
      requestDigest,
    });
    if (priorByKey) {
      const receipt = priorByKey.receipt ?? terminalReceipt(db, input.owner, batch, "confirm", input.previewDigest);
      return batchResult(db, selectBatch(db, input), {
        previewDigest: input.previewDigest,
        mapping: mappingFromMetadata(previewMetadata),
        replayed: true,
        ...(receipt ? { receipt } : {}),
      });
    }

    if (batch.status === "committed") {
      const receipt = terminalReceipt(db, input.owner, batch, "confirm", input.previewDigest);
      bindTerminalIdempotencyKey(db, {
        owner: input.owner,
        batch,
        operation: "confirm",
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        receipt,
        requestId: input.requestId,
      });
      return batchResult(db, batch, {
        previewDigest: input.previewDigest,
        mapping: mappingFromMetadata(previewMetadata),
        replayed: true,
        receipt,
      });
    }
    if (batch.status === "cancelled") throw importError("CUSTOMER_IMPORT_STATE_CONFLICT", "已取消的批次不能确认", null, 409);
    if (batch.status === "failed") throw importError("CUSTOMER_IMPORT_STATE_CONFLICT", "失败批次不能确认，请重新预览", null, 409);
    if (! ["preview", "confirmed"].includes(batch.status)) {
      throw importError("CUSTOMER_IMPORT_STATE_CONFLICT", "当前批次状态不允许确认", null, 409);
    }

    const rows = selectRows(db, input.batchId);
    assertConfirmableRows(rows);
    revalidatePreviewRows(db, input.owner, rows);
    const identityConflicts = customerImportPlanConflicts(
      activeCustomers(db, input.owner),
      rows.map((row) => {
        const metadata = rowMetadata(row);
        return {
          rowNumber: Number(row.row_number),
          action: row.action,
          customerId: metadata.customerId ?? row.customer_id ?? null,
          normalized: metadata.normalized,
          providedFields: metadata.providedFields ?? [],
          errors: metadata.errors ?? [],
        };
      }),
    );
    if (identityConflicts.length > 0) {
      throw importError("CUSTOMER_IMPORT_PREVIEW_STALE", "导入后的客户名称或别名会产生同账号冲突，请重新生成预览", {
        rowNumbers: identityConflicts.map((item) => item.rowNumber),
      }, 409);
    }

    run(db, "UPDATE customer_import_batches SET status = 'confirmed', updated_at = $updatedAt WHERE id = $id AND owner = $owner", {
      $updatedAt: now,
      $id: input.batchId,
      $owner: input.owner,
    });

    const committedCustomerIds = [];
    for (const storedRow of rows) {
      const metadata = rowMetadata(storedRow);
      const normalized = metadata.normalized;
      let customerId = storedRow.customer_id ?? metadata.customerId ?? null;
      let before = null;
      let after = null;

      if (storedRow.action === "skip") {
        markRow(db, storedRow.id, { status: "skipped", action: "skip", customerId, now });
      } else if (storedRow.action === "reject") {
        markRow(db, storedRow.id, { status: "rejected", action: "reject", customerId: null, now });
      } else if (storedRow.action === "create") {
        const created = createCustomer(db, { ...normalized, owner: input.owner }, { id: idFactory() });
        customerId = created.id;
        after = created;
        committedCustomerIds.push(customerId);
        insertAudit(db, {
          action: "customer_import.customer.create",
          entityType: "customer",
          entityId: customerId,
          actor: input.owner,
          requestId: input.requestId,
          entityVersion: created.version,
          before: null,
          after: customerAuditSnapshot(created),
          metadata: { batchId: input.batchId, rowNumber: Number(storedRow.row_number), rowDigest: storedRow.row_digest },
        });
        markRow(db, storedRow.id, { status: "committed", action: "create", customerId, now });
      } else if (storedRow.action === "merge") {
        const current = currentCustomerById(db, input.owner, customerId);
        if (!current) throw importError("CUSTOMER_IMPORT_PREVIEW_STALE", "merge 目标客户已不存在", { rowNumber: Number(storedRow.row_number) }, 409);
        before = current;
        const merged = mergeCustomerPatch(current, {
          normalized,
          providedFields: metadata.providedFields ?? [],
          matchedBy: metadata.matchedBy,
        });
        after = updateCustomer(db, customerId, merged, current.version, { owner: input.owner });
        if (!after) throw importError("CUSTOMER_IMPORT_PREVIEW_STALE", "merge 目标客户已变化", { rowNumber: Number(storedRow.row_number) }, 409);
        committedCustomerIds.push(customerId);
        insertAudit(db, {
          action: "customer_import.customer.merge",
          entityType: "customer",
          entityId: customerId,
          actor: input.owner,
          requestId: input.requestId,
          entityVersion: after.version,
          before: customerAuditSnapshot(before),
          after: customerAuditSnapshot(after),
          metadata: { batchId: input.batchId, rowNumber: Number(storedRow.row_number), rowDigest: storedRow.row_digest },
        });
        markRow(db, storedRow.id, { status: "committed", action: "merge", customerId, now });
      } else {
        throw importError("CUSTOMER_IMPORT_INVALID_ACTION", "导入行动作无效", { rowNumber: Number(storedRow.row_number) });
      }

      const finalRow = get(db, "SELECT * FROM customer_import_rows WHERE id = $id", { $id: storedRow.id });
      insertAudit(db, {
        action: IMPORT_ROW_COMMIT_AUDIT,
        entityType: "customer_import_row",
        entityId: storedRow.id,
        actor: input.owner,
        requestId: input.requestId,
        before: { status: storedRow.status, action: storedRow.action, customerId: storedRow.customer_id ?? null },
        after: { status: finalRow.status, action: finalRow.action, customerId: finalRow.customer_id ?? null },
        metadata: {
          batchId: input.batchId,
          rowNumber: Number(storedRow.row_number),
          rowDigest: storedRow.row_digest,
          customerId: finalRow.customer_id ?? null,
        },
      });
    }

    const finalRows = selectRows(db, input.batchId).map(rowEntity);
    const counts = countCommittedRows(finalRows);
    const committedAt = now;
    run(
      db,
      `UPDATE customer_import_batches
          SET status = 'committed', updated_at = $updatedAt, committed_at = $committedAt
        WHERE id = $id AND owner = $owner`,
      { $updatedAt: now, $committedAt: committedAt, $id: input.batchId, $owner: input.owner },
    );
    const finalBatch = selectBatch(db, input);
    const receipt = receiptForResult(finalBatch, finalRows, counts, input.previewDigest);
    insertAudit(db, {
      action: IMPORT_CONFIRM_AUDIT,
      entityType: "customer_import_batch",
      entityId: input.batchId,
      actor: input.owner,
      requestId: input.requestId,
      metadata: {
        batchId: input.batchId,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        previewDigest: input.previewDigest,
        receiptJson: stableImportJson(receipt),
        committedCustomerIds,
        counts,
      },
      before: { status: batch.status },
      after: { status: "committed", counts, committedCustomerIds },
    });
    return batchResult(db, finalBatch, {
      previewDigest: input.previewDigest,
      mapping: mappingFromMetadata(previewMetadata),
      replayed: false,
      receipt,
    });
  });
}

export function confirmCustomerImport(db, input, options = {}) {
  if (!isDatabase(db)) throw new TypeError("confirmCustomerImport requires a SQLite database as its first argument");
  if (typeof input === "string") return confirmService(db, { ...(options ?? {}), batchId: input });
  return confirmService(db, { ...(input ?? {}), ...(options ?? {}) });
}

function cancelService(db, options = {}) {
  const input = cancelInput(options);
  const now = nowIso(options.now);
  return transaction(db, () => {
    const batch = selectBatch(db, input);
    if (!batch) throw importError("CUSTOMER_IMPORT_BATCH_NOT_FOUND", "导入批次不存在", null, 404);
    const requestDigest = cancelRequestDigest(input);
    const priorByKey = findMatchingIdempotencyBinding(db, {
      owner: input.owner,
      idempotencyKey: input.idempotencyKey,
      operation: "cancel",
      batchId: input.batchId,
      requestDigest,
    });
    if (priorByKey) {
      const previewMetadata = latestPreviewMetadata(db, input.owner, input.batchId);
      return batchResult(db, selectBatch(db, input), {
        previewDigest: metadataString(previewMetadata, "previewDigest"),
        mapping: mappingFromMetadata(previewMetadata),
        replayed: true,
        ...(priorByKey.receipt ? { receipt: priorByKey.receipt } : {}),
      });
    }
    if (batch.status === "cancelled") {
      const metadata = latestPreviewMetadata(db, input.owner, input.batchId);
      const receipt = terminalReceipt(db, input.owner, batch, "cancel", metadataString(metadata, "previewDigest"));
      bindTerminalIdempotencyKey(db, {
        owner: input.owner,
        batch,
        operation: "cancel",
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        receipt,
        requestId: input.requestId,
      });
      return batchResult(db, batch, {
        previewDigest: metadataString(metadata, "previewDigest"),
        mapping: mappingFromMetadata(metadata),
        replayed: true,
        receipt,
      });
    }
    if (batch.status === "committed") throw importError("CUSTOMER_IMPORT_STATE_CONFLICT", "已提交的批次不能取消", null, 409);
    run(db, "UPDATE customer_import_batches SET status = 'cancelled', updated_at = $updatedAt WHERE id = $id AND owner = $owner", {
      $updatedAt: now,
      $id: input.batchId,
      $owner: input.owner,
    });
    for (const row of selectRows(db, input.batchId)) {
      markRow(db, row.id, { status: "rejected", action: "reject", customerId: null, now });
      insertAudit(db, {
        action: IMPORT_ROW_COMMIT_AUDIT,
        entityType: "customer_import_row",
        entityId: row.id,
        actor: input.owner,
        requestId: input.requestId,
        before: { status: row.status, action: row.action },
        after: { status: "rejected", action: "reject" },
        metadata: { batchId: input.batchId, rowNumber: Number(row.row_number), reason: input.reason ?? "cancelled" },
      });
    }
    const finalBatch = selectBatch(db, input);
    const metadata = latestPreviewMetadata(db, input.owner, input.batchId);
    const finalRows = selectRows(db, input.batchId).map(rowEntity);
    const receipt = receiptForResult(finalBatch, finalRows, countCommittedRows(finalRows), metadataString(metadata, "previewDigest"));
    insertAudit(db, {
      action: IMPORT_CANCEL_AUDIT,
      entityType: "customer_import_batch",
      entityId: input.batchId,
      actor: input.owner,
      requestId: input.requestId,
      metadata: {
        batchId: input.batchId,
        reason: input.reason ?? null,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        receiptJson: stableImportJson(receipt),
      },
      before: { status: batch.status },
      after: { status: "cancelled" },
    });
    return batchResult(db, finalBatch, {
      previewDigest: metadataString(metadata, "previewDigest"),
      mapping: mappingFromMetadata(metadata),
      replayed: false,
      receipt,
    });
  });
}

export function cancelCustomerImport(db, input, options = {}) {
  if (!isDatabase(db)) throw new TypeError("cancelCustomerImport requires a SQLite database as its first argument");
  if (typeof input === "string") return cancelService(db, { ...(options ?? {}), batchId: input });
  return cancelService(db, { ...(input ?? {}), ...(options ?? {}) });
}

export function getCustomerImportBatch(db, input, options = {}) {
  if (!isDatabase(db)) throw new TypeError("getCustomerImportBatch requires a SQLite database as its first argument");
  const source = typeof input === "string" ? { ...(options ?? {}), batchId: input } : { ...(input ?? {}), ...(options ?? {}) };
  const owner = requiredText(source.owner, "owner");
  const batchId = requiredText(source.batchId ?? source.id, "batchId");
  const batch = selectBatch(db, { owner, batchId });
  if (!batch) throw importError("CUSTOMER_IMPORT_BATCH_NOT_FOUND", "导入批次不存在", null, 404);
  const metadata = latestPreviewMetadata(db, owner, batchId);
  return batchResult(db, batch, {
    previewDigest: metadataString(metadata, "previewDigest"),
    mapping: mappingFromMetadata(metadata),
    replayed: false,
  });
}

/** Construct a service whose methods are already bound to one SQLite connection. */
export function createCustomerImportService({ db, now, idFactory, limits } = {}) {
  if (!isDatabase(db)) throw new TypeError("createCustomerImportService requires a SQLite database");
  const defaults = { ...(now ? { now } : {}), ...(idFactory ? { idFactory } : {}), ...(limits ? { limits } : {}) };
  return Object.freeze({
    preview: (input, options = {}) => previewCustomerImport(db, input, { ...defaults, ...options }),
    previewAsync: (input, options = {}) => previewCustomerImportAsync(db, input, { ...defaults, ...options }),
    confirm: (input, options = {}) => confirmCustomerImport(db, input, { ...defaults, ...options }),
    cancel: (input, options = {}) => cancelCustomerImport(db, input, { ...defaults, ...options }),
    get: (input, options = {}) => getCustomerImportBatch(db, input, { ...defaults, ...options }),
    limits: { ...CUSTOMER_IMPORT_LIMITS, ...(limits ?? {}) },
  });
}

export const preview = previewCustomerImport;
export const confirm = confirmCustomerImport;
export const cancel = cancelCustomerImport;
export const getBatch = getCustomerImportBatch;
