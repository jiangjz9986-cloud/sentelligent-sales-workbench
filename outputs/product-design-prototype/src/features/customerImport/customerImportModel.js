export const CUSTOMER_IMPORT_ACCEPT = ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CUSTOMER_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export const CUSTOMER_IMPORT_FIELD_LABELS = Object.freeze({
  name: "客户名称",
  region: "区域",
  type: "客户类型",
  level: "客户级别",
  contact: "联系人",
  relation: "关系度",
  stakeholders: "关键人",
  decisionChain: "决策链",
  historyProjects: "历史项目",
  infrastructure: "基础设施",
  syncPreview: "同步预览",
  budget: "预算",
  summary: "客户摘要",
  needs: "客户需求",
  risks: "客户风险",
  opportunities: "商机线索",
  aliases: "客户别名",
  tags: "标签",
});

export const CUSTOMER_IMPORT_ACTION_LABELS = Object.freeze({
  create: "新建客户",
  merge: "合并到现有客户",
  skip: "跳过此行",
  reject: "拒绝此行",
});

export const CUSTOMER_IMPORT_STATUS_LABELS = Object.freeze({
  preview: "待确认",
  confirmed: "正在写入",
  committed: "已导入",
  cancelled: "已取消",
  failed: "导入失败",
  valid: "可导入",
  duplicate: "发现重复",
  error: "需要处理",
  skipped: "已跳过",
  rejected: "已拒绝",
});

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function text(value) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function uniqueTexts(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = text(value).trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeReceipt(receipt) {
  if (!plainObject(receipt)) return null;
  const counts = plainObject(receipt.counts) ? receipt.counts : {};
  return {
    batchId: text(receipt.batchId),
    previewDigest: text(receipt.previewDigest),
    counts: {
      created: numberValue(counts.created),
      merged: numberValue(counts.merged),
      skipped: numberValue(counts.skipped),
      rejected: numberValue(counts.rejected),
    },
    rows: Array.isArray(receipt.rows) ? receipt.rows.map((row) => ({
      rowNumber: numberValue(row?.rowNumber),
      action: text(row?.action),
      status: text(row?.status),
      customerId: text(row?.customerId) || null,
    })) : [],
  };
}

export function normalizeCustomerImportResult(payload) {
  const source = plainObject(payload) ? payload : {};
  const batch = plainObject(source.batch) ? source.batch : plainObject(source.customerImportBatch) ? source.customerImportBatch : {};
  const rawRows = Array.isArray(source.rows) ? source.rows : Array.isArray(source.customerImportRows) ? source.customerImportRows : [];
  const rows = rawRows.map((row, index) => ({
    id: text(row?.id) || `customer-import-row-${index + 1}`,
    batchId: text(row?.batchId ?? batch.id),
    rowNumber: numberValue(row?.rowNumber) || index + 2,
    status: text(row?.status) || "error",
    action: text(row?.action) || "reject",
    canonicalName: text(row?.canonicalName ?? row?.normalized?.name) || "未命名客户",
    customerId: text(row?.customerId) || null,
    normalized: plainObject(row?.normalized) ? row.normalized : {},
    errors: Array.isArray(row?.errors) ? row.errors.map((error) => ({
      field: text(error?.field) || "row",
      code: text(error?.code) || "INVALID_VALUE",
      message: text(error?.message) || "该行无法导入",
    })) : [],
    rowDigest: text(row?.rowDigest),
    matchedBy: text(row?.matchedBy),
    duplicateOfRow: numberValue(row?.duplicateOfRow) || null,
  }));
  const mapping = plainObject(source.mapping) ? source.mapping : {};
  return {
    batch: {
      id: text(batch.id),
      owner: text(batch.owner),
      status: text(batch.status) || "preview",
      fileName: text(batch.fileName),
      mediaType: text(batch.mediaType),
      fileSizeBytes: numberValue(batch.fileSizeBytes),
      fileSha256: text(batch.fileSha256),
      totalRows: numberValue(batch.totalRows) || rows.length,
      validRows: numberValue(batch.validRows),
      errorRows: numberValue(batch.errorRows),
      duplicateRows: numberValue(batch.duplicateRows),
      createdAt: text(batch.createdAt),
      updatedAt: text(batch.updatedAt),
      committedAt: text(batch.committedAt) || null,
    },
    rows,
    previewDigest: text(source.previewDigest),
    mapping: {
      fieldToHeader: plainObject(mapping.fieldToHeader) ? mapping.fieldToHeader : {},
      headerToField: plainObject(mapping.headerToField) ? mapping.headerToField : {},
      ignoredHeaders: Array.isArray(mapping.ignoredHeaders) ? mapping.ignoredHeaders.map(text) : [],
      unmappedHeaders: Array.isArray(mapping.unmappedHeaders) ? mapping.unmappedHeaders.map(text) : [],
      requiredFields: Array.isArray(mapping.requiredFields) ? mapping.requiredFields.map(text) : ["name"],
      digest: text(mapping.digest),
    },
    headers: uniqueTexts([
      ...(Array.isArray(source.headers) ? source.headers : []),
      ...(Array.isArray(mapping.headers) ? mapping.headers : []),
      ...Object.keys(plainObject(mapping.headerToField) ? mapping.headerToField : {}),
      ...Object.values(plainObject(mapping.fieldToHeader) ? mapping.fieldToHeader : {})
        .filter((header) => !Object.hasOwn(CUSTOMER_IMPORT_FIELD_LABELS, text(header))),
      ...(Array.isArray(mapping.ignoredHeaders) ? mapping.ignoredHeaders : []),
      ...(Array.isArray(mapping.unmappedHeaders) ? mapping.unmappedHeaders : []),
    ]),
    receipt: normalizeReceipt(source.receipt),
    replayed: source.replayed === true,
  };
}

export function customerImportSummary(result) {
  const normalized = normalizeCustomerImportResult(result);
  const rows = normalized.rows;
  return {
    total: normalized.batch.totalRows || normalized.rows.length,
    create: rows.filter((row) => row.action === "create").length,
    merge: rows.filter((row) => row.action === "merge").length,
    skip: rows.filter((row) => row.action === "skip").length,
    reject: rows.filter((row) => row.action === "reject").length,
    errors: rows.filter((row) => row.errors.length > 0).length,
    committed: rows.filter((row) => row.status === "committed").length,
  };
}

export function customerImportMappingDraft(result) {
  const normalized = normalizeCustomerImportResult(result);
  return Object.fromEntries(
    Object.keys(CUSTOMER_IMPORT_FIELD_LABELS).map((field) => [field, text(normalized.mapping.fieldToHeader[field])]),
  );
}

export function customerImportHeaders(result) {
  return normalizeCustomerImportResult(result).headers;
}

export function cleanCustomerImportMapping(mapping) {
  const source = plainObject(mapping) ? mapping : {};
  return Object.fromEntries(
    Object.keys(CUSTOMER_IMPORT_FIELD_LABELS)
      .map((field) => [field, text(source[field]).trim()])
      .filter(([, header]) => header),
  );
}

export function customerImportCanConfirm(result) {
  const normalized = normalizeCustomerImportResult(result);
  if (normalized.batch.status !== "preview" || !normalized.batch.id || !normalized.previewDigest || !normalized.batch.fileSha256) return false;
  if (normalized.rows.length === 0) return false;
  return normalized.rows.every((row) => row.errors.length === 0 || row.action === "reject");
}

export function customerImportVerificationItems(result) {
  const normalized = normalizeCustomerImportResult(result);
  return [
    { id: "preview", label: "预览摘要", value: normalized.previewDigest },
    { id: "file", label: "文件摘要", value: normalized.batch.fileSha256 },
    { id: "mapping", label: "映射摘要", value: normalized.mapping.digest },
  ].filter((item) => item.value);
}

export function formatCustomerImportBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatCustomerImportValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!plainObject(item)) return text(item).trim();
      return uniqueTexts([item.name, item.title, item.role, item.department, item.value]).join(" / ");
    }).filter(Boolean).join("、");
  }
  if (plainObject(value)) return uniqueTexts([value.name, value.title, value.value]).join(" / ");
  return text(value).trim();
}

export function validateCustomerImportFile(file, { maxFileBytes = CUSTOMER_IMPORT_MAX_FILE_BYTES } = {}) {
  if (!file) return { valid: false, code: "FILE_REQUIRED", message: "请选择 CSV 或 XLSX 文件。" };
  const name = text(file.name).trim();
  const lowerName = name.toLocaleLowerCase();
  if (!lowerName.endsWith(".csv") && !lowerName.endsWith(".xlsx")) {
    return { valid: false, code: "UNSUPPORTED_FORMAT", message: "仅支持 CSV 和 XLSX 文件。" };
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return { valid: false, code: "EMPTY_FILE", message: "文件为空，无法生成预览。" };
  if (size > maxFileBytes) {
    return { valid: false, code: "FILE_TOO_LARGE", message: `文件不能超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB。` };
  }
  return { valid: true, code: null, message: "" };
}

export function createCustomerImportIdempotencyKey(scope = "request") {
  const safeScope = text(scope).replace(/[^a-z0-9_-]/giu, "-").slice(0, 40) || "request";
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `customer-import:${safeScope}:${random}`;
}

export function customerImportFileIdentity(file) {
  if (!file) return "";
  return [file.name, file.size, file.lastModified, file.type].map(text).join(":");
}

export function customerImportPreviewIdentity({ file, mapping = null } = {}) {
  return JSON.stringify({
    file: customerImportFileIdentity(file),
    mapping: Object.entries(cleanCustomerImportMapping(mapping)).sort(([left], [right]) => left.localeCompare(right)),
  });
}

export function customerImportBatchIdentity(result) {
  const normalized = normalizeCustomerImportResult(result);
  return [normalized.batch.id, normalized.previewDigest, normalized.batch.fileSha256].join(":");
}

export function createCustomerImportIdempotencyKeyStore({ createKey = createCustomerImportIdempotencyKey } = {}) {
  const entries = new Map();
  return Object.freeze({
    keyFor(operation, identity) {
      const safeOperation = text(operation).trim();
      const safeIdentity = text(identity);
      if (!safeOperation || !safeIdentity) throw new TypeError("Customer import idempotency identity is required");
      const current = entries.get(safeOperation);
      if (current?.identity === safeIdentity) return current.key;
      const key = createKey(safeOperation);
      entries.set(safeOperation, { identity: safeIdentity, key });
      return key;
    },
    clear(operation) {
      entries.delete(text(operation).trim());
    },
    reset() {
      entries.clear();
    },
  });
}

export function buildCustomerImportPreviewRequest({ file, mapping = null, idempotencyKey = null } = {}) {
  const normalizedMapping = cleanCustomerImportMapping(mapping);
  return {
    file,
    ...(Object.keys(normalizedMapping).length > 0 ? { mapping: normalizedMapping } : {}),
    idempotencyKey: idempotencyKey || createCustomerImportIdempotencyKey("preview"),
  };
}

export function buildCustomerImportConfirmRequest(result, idempotencyKey = null) {
  const normalized = normalizeCustomerImportResult(result);
  if (!normalized.batch.id || !normalized.previewDigest || !normalized.batch.fileSha256) {
    throw new TypeError("A complete customer import preview is required");
  }
  return {
    batchId: normalized.batch.id,
    confirmed: true,
    previewDigest: normalized.previewDigest,
    fileSha256: normalized.batch.fileSha256,
    idempotencyKey: idempotencyKey || createCustomerImportIdempotencyKey("confirm"),
  };
}

export function buildCustomerImportCancelRequest(result, { reason = "operator_cancelled", idempotencyKey = null } = {}) {
  const normalized = normalizeCustomerImportResult(result);
  if (!normalized.batch.id) throw new TypeError("A customer import batch is required");
  return {
    batchId: normalized.batch.id,
    reason: text(reason).trim() || "operator_cancelled",
    idempotencyKey: idempotencyKey || createCustomerImportIdempotencyKey("cancel"),
  };
}

export function customerImportErrorMessage(error) {
  const code = text(error?.code ?? error?.error?.code);
  const messages = {
    CUSTOMER_IMPORT_FILE_TOO_LARGE: "文件超过导入大小限制。",
    CUSTOMER_IMPORT_TOO_MANY_ROWS: "文件行数超过导入限制。",
    CUSTOMER_IMPORT_FIELD_TOO_LARGE: "文件中有字段超过长度限制。",
    CUSTOMER_IMPORT_INVALID_UTF8: "CSV 不是有效的 UTF-8 文件。",
    CUSTOMER_IMPORT_INVALID_CSV: "CSV 格式无法解析，请检查引号和换行。",
    CUSTOMER_IMPORT_INVALID_XLSX: "XLSX 文件损坏或包含不支持的工作簿结构。",
    CUSTOMER_IMPORT_MAPPING_INVALID: "字段映射无效，请重新选择表头。",
    CUSTOMER_IMPORT_MISSING_HEADER: "文件缺少可识别的表头。",
    CUSTOMER_IMPORT_HEADER_REQUIRED: "客户导入文件必须包含表头。",
    CUSTOMER_IMPORT_PREVIEW_STALE: "客户资料已变化，请重新生成预览。",
    CUSTOMER_IMPORT_PREVIEW_DIGEST_MISMATCH: "预览校验信息已变化，请重新生成预览。",
    CUSTOMER_IMPORT_FILE_DIGEST_MISMATCH: "当前文件与预览文件不一致，请重新生成预览。",
    CUSTOMER_IMPORT_ROWS_INVALID: "仍有错误行未设为拒绝，请更新处理计划。",
    CUSTOMER_IMPORT_STATE_CONFLICT: "当前导入批次状态已变化，请刷新后重试。",
    CUSTOMER_IMPORT_IDEMPOTENCY_KEY_REUSED: "该导入请求标识已用于其他内容，请重新提交。",
    CUSTOMER_IMPORT_BATCH_NOT_FOUND: "导入批次不存在或已不可访问。",
    CUSTOMER_IMPORT_AUTH_REQUIRED: "当前登录状态无法执行客户导入。",
    CUSTOMER_IMPORT_OWNER_NOT_ALLOWED: "客户归属由当前账号确定，不能从文件或映射指定。",
  };
  return messages[code] ?? "客户导入操作未完成，请检查文件和预览后重试。";
}
