import { CUSTOMER_IMPORT_ACTIONS, CUSTOMER_IMPORT_FIELDS, CUSTOMER_IMPORT_FIELD_DEFINITIONS, CUSTOMER_IMPORT_LIMITS, CUSTOMER_IMPORT_OWNER_HEADERS } from "./constants.js";
import { importError } from "./errors.js";
import { importDigest, stableImportJson } from "./stable.js";

const ARRAY_FIELDS = new Set(CUSTOMER_IMPORT_FIELDS.filter((field) => CUSTOMER_IMPORT_FIELD_DEFINITIONS[field].type === "list"));
const TEXT_FIELDS = new Set(CUSTOMER_IMPORT_FIELDS.filter((field) => CUSTOMER_IMPORT_FIELD_DEFINITIONS[field].type === "text"));
const OWNER_HEADER_KEYS = new Set(CUSTOMER_IMPORT_OWNER_HEADERS.map(normalizeHeaderKey));

function normalizeHeaderKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_\-./\\:：，,;；|()（）[\]{}<>《》]+/gu, "");
}

function textValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value).trim();
  return String(value).trim();
}

function isBlankSourceValue(value) {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertBoundedJson(value, { depth = 0, limits = CUSTOMER_IMPORT_LIMITS, field = "value" } = {}) {
  if (depth > limits.maxArrayDepth) throw new Error(`${field} exceeds nested depth limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > limits.maxArrayStringLength) {
      throw new Error(`${field} contains an item that is too long`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) throw new Error(`${field} contains too many items`);
    value.forEach((item, index) => assertBoundedJson(item, { depth: depth + 1, limits, field: `${field}[${index}]` }));
    return;
  }
  if (!plainObject(value)) throw new Error(`${field} contains an unsupported object`);
  const entries = Object.entries(value);
  if (entries.length > limits.maxArrayObjectKeys) throw new Error(`${field} contains too many object keys`);
  for (const [key, item] of entries) {
    if (key.length > 200) throw new Error(`${field} contains an object key that is too long`);
    assertBoundedJson(item, { depth: depth + 1, limits, field: `${field}.${key}` });
  }
}

function jsonFromString(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function splitList(value) {
  return value
    .split(/[;,，；|\n\r]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function fieldError(field, code, message) {
  return { field, code, message };
}

function normalizeTextField(value, field, definition, errors) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    errors.push(fieldError(field, "INVALID_TYPE", "字段必须是文本"));
    return null;
  }
  const normalized = textValue(value);
  if (normalized.length > definition.max) {
    errors.push(fieldError(field, "FIELD_TOO_LONG", `字段长度不能超过 ${definition.max}`));
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    errors.push(fieldError(field, "INVALID_CONTROL_CHARACTER", "字段包含不可用控制字符"));
  }
  return normalized || null;
}

function normalizeRelation(value, field, errors) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return 0;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
      errors.push(fieldError(field, "INVALID_RELATION", "关系度必须是 0 到 100 的整数"));
      return 0;
    }
    return value;
  }
  if (typeof value !== "string") {
    errors.push(fieldError(field, "INVALID_TYPE", "关系度必须是整数"));
    return 0;
  }
  const match = value.trim().match(/^(\d{1,3})\s*%?$/u);
  const relation = match ? Number.parseInt(match[1], 10) : NaN;
  if (!Number.isSafeInteger(relation) || relation < 0 || relation > 100) {
    errors.push(fieldError(field, "INVALID_RELATION", "关系度必须是 0 到 100 的整数"));
    return 0;
  }
  return relation;
}

function normalizeListField(value, field, definition, errors, limits) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return [];
  let list;
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    const parsed = (trimmed.startsWith("[") || trimmed.startsWith("{")) ? jsonFromString(trimmed) : undefined;
    if (parsed !== undefined) list = Array.isArray(parsed) ? parsed : [parsed];
    else if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      errors.push(fieldError(field, "INVALID_JSON", "数组字段必须是有效 JSON 数组或分隔文本"));
      return [];
    } else list = splitList(trimmed);
  } else {
    errors.push(fieldError(field, "INVALID_TYPE", "字段必须是数组或分隔文本"));
    return [];
  }

  const maxItems = definition.maxItems ?? limits.maxArrayItems;
  if (list.length > maxItems) errors.push(fieldError(field, "TOO_MANY_ITEMS", `最多允许 ${maxItems} 项`));
  const normalized = list.slice(0, maxItems).map((item, index) => {
    if (typeof item === "string") {
      const valueText = item.trim();
      const itemMax = definition.itemMax ?? limits.maxArrayStringLength;
      if (valueText.length > itemMax) errors.push(fieldError(`${field}[${index}]`, "ITEM_TOO_LONG", `单项长度不能超过 ${itemMax}`));
      return valueText;
    }
    if (typeof item === "number" || typeof item === "boolean" || item === null || plainObject(item) || Array.isArray(item)) return item;
    errors.push(fieldError(`${field}[${index}]`, "INVALID_TYPE", "数组项类型不受支持"));
    return null;
  });
  try {
    assertBoundedJson(normalized, { limits, field });
  } catch (error) {
    errors.push(fieldError(field, "INVALID_VALUE", error.message));
  }
  return normalized;
}

function defaultCustomerShape() {
  return {
    name: null,
    region: null,
    type: null,
    level: null,
    contact: null,
    relation: 0,
    stakeholders: [],
    decisionChain: [],
    historyProjects: [],
    infrastructure: [],
    syncPreview: [],
    budget: null,
    summary: null,
    needs: [],
    risks: [],
    opportunities: [],
    aliases: [],
    tags: [],
  };
}

function isCanonicalField(value) {
  return typeof value === "string" && CUSTOMER_IMPORT_FIELDS.includes(value);
}

function requestedMappingEntries(requestedMapping) {
  if (!requestedMapping) return [];
  if (Array.isArray(requestedMapping)) {
    return requestedMapping.map((item) => {
      if (!plainObject(item)) throw importError("CUSTOMER_IMPORT_MAPPING_INVALID", "字段 mapping 项必须是对象");
      return [item.field ?? item.target ?? item.destination, item.header ?? item.source ?? item.column];
    });
  }
  if (!plainObject(requestedMapping)) throw importError("CUSTOMER_IMPORT_MAPPING_INVALID", "字段 mapping 必须是对象或数组");
  const nested = requestedMapping.fields ?? requestedMapping.columns;
  if (nested !== undefined) return requestedMappingEntries(nested);
  return Object.entries(requestedMapping);
}

function resolveHeader(headers, candidate) {
  if (Number.isInteger(candidate)) return headers[candidate] ?? null;
  const value = String(candidate ?? "").trim();
  if (!value) return null;
  const exact = headers.find((header) => header === value);
  if (exact) return exact;
  const normalized = normalizeHeaderKey(value);
  return headers.find((header) => normalizeHeaderKey(header) === normalized) ?? null;
}

function aliasMap() {
  const result = new Map();
  for (const field of CUSTOMER_IMPORT_FIELDS) {
    const definition = CUSTOMER_IMPORT_FIELD_DEFINITIONS[field];
    for (const alias of [field, ...definition.aliases]) {
      const key = normalizeHeaderKey(alias);
      if (key && !result.has(key)) result.set(key, field);
    }
  }
  return result;
}

/** Resolve explicit or automatic source-header to customer-field mapping. */
export function resolveCustomerImportMapping(headers, requestedMapping = null) {
  if (!Array.isArray(headers) || headers.length === 0) {
    throw importError("CUSTOMER_IMPORT_MISSING_HEADER", "导入文件缺少表头");
  }
  const fieldToHeader = Object.fromEntries(CUSTOMER_IMPORT_FIELDS.map((field) => [field, null]));
  const headerToField = {};
  const ignoredHeaders = [];
  const errors = [];
  const aliases = aliasMap();

  for (const header of headers) {
    if (OWNER_HEADER_KEYS.has(normalizeHeaderKey(header))) ignoredHeaders.push(header);
  }

  const assign = (field, header, explicit = false) => {
    if (!isCanonicalField(field)) {
      if (normalizeHeaderKey(field) === "owner") {
        errors.push({ code: "OWNER_FIELD_NOT_ALLOWED", field: String(field), message: "owner 由服务端注入，不能通过文件 mapping 指定" });
      } else {
        errors.push({ code: "UNKNOWN_FIELD", field: String(field), message: "mapping 目标字段不受支持" });
      }
      return;
    }
    const resolved = resolveHeader(headers, header);
    if (!resolved) {
      errors.push({ code: "MAPPING_HEADER_NOT_FOUND", field, header: String(header), message: "mapping 指定的表头不存在" });
      return;
    }
    if (OWNER_HEADER_KEYS.has(normalizeHeaderKey(resolved))) {
      errors.push({ code: "OWNER_FIELD_NOT_ALLOWED", field, header: resolved, message: "owner 由服务端注入，不能通过文件 mapping 指定" });
      return;
    }
    if (fieldToHeader[field] && fieldToHeader[field] !== resolved) {
      errors.push({ code: "MAPPING_FIELD_DUPLICATE", field, message: "同一目标字段不能映射多个表头" });
      return;
    }
    const prior = headerToField[resolved];
    if (prior && prior !== field) {
      errors.push({ code: "MAPPING_HEADER_DUPLICATE", field, header: resolved, message: "同一表头不能映射多个目标字段" });
      return;
    }
    fieldToHeader[field] = resolved;
    headerToField[resolved] = field;
    if (explicit && ignoredHeaders.includes(resolved)) ignoredHeaders.splice(ignoredHeaders.indexOf(resolved), 1);
  };

  for (const [left, right] of requestedMappingEntries(requestedMapping)) {
    const leftIsField = isCanonicalField(left) || normalizeHeaderKey(left) === "owner";
    const rightIsField = isCanonicalField(right) || normalizeHeaderKey(right) === "owner";
    if (leftIsField) assign(left, right, true);
    else if (rightIsField) assign(right, left, true);
    else errors.push({ code: "UNKNOWN_FIELD", field: String(left), message: "mapping 必须指定客户字段" });
  }

  for (const header of headers) {
    if (headerToField[header] || ignoredHeaders.includes(header)) continue;
    const candidate = aliases.get(normalizeHeaderKey(header));
    if (candidate && !fieldToHeader[candidate]) assign(candidate, header);
  }

  if (errors.length > 0) throw importError("CUSTOMER_IMPORT_MAPPING_INVALID", "字段 mapping 无法使用", { errors });
  const unmappedHeaders = headers.filter((header) => !headerToField[header] && !ignoredHeaders.includes(header));
  return {
    fieldToHeader,
    headerToField,
    ignoredHeaders,
    unmappedHeaders,
    requiredFields: ["name"],
    digest: importDigest({ fieldToHeader, ignoredHeaders, unmappedHeaders }),
  };
}

function sourceRowObject(headers, row) {
  if (Array.isArray(row?.values)) {
    return Object.fromEntries(headers.map((header, index) => [header, row.values[index] ?? ""]));
  }
  if (plainObject(row)) return row;
  const values = Array.isArray(row) ? row : [];
  return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
}

/** Normalize one mapped source row into the customer write shape. */
export function normalizeCustomerImportRow(row, mapping, { rowNumber = row?.rowNumber ?? 1, limits = CUSTOMER_IMPORT_LIMITS } = {}) {
  const source = sourceRowObject(mapping.headers ?? [], row);
  const errors = [];
  const normalized = defaultCustomerShape();
  const providedFields = [];

  for (const field of CUSTOMER_IMPORT_FIELDS) {
    const header = mapping.fieldToHeader[field];
    if (!header) continue;
    const raw = source[header];
    if (!isBlankSourceValue(raw)) providedFields.push(field);
    const definition = CUSTOMER_IMPORT_FIELD_DEFINITIONS[field];
    if (definition.type === "text") normalized[field] = normalizeTextField(raw, field, definition, errors);
    else if (definition.type === "relation") normalized[field] = normalizeRelation(raw, field, errors);
    else normalized[field] = normalizeListField(raw, field, definition, errors, limits);
  }

  if (!normalized.name) errors.push(fieldError("name", "REQUIRED_FIELD", "客户名称不能为空"));
  if (normalized.name && normalized.name.length > CUSTOMER_IMPORT_FIELD_DEFINITIONS.name.max) {
    errors.push(fieldError("name", "FIELD_TOO_LONG", "客户名称过长"));
  }
  const rowDigest = importDigest({ rowNumber, normalized, providedFields, errors });
  return { rowNumber, normalized, providedFields, errors, rowDigest };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function customerShapeFromSnapshot(raw) {
  const row = raw ?? {};
  return {
    id: String(row.id ?? ""),
    owner: row.owner ?? null,
    version: Number(row.version ?? 1),
    name: textValue(row.name),
    aliases: parseJsonArray(row.aliases),
    tags: parseJsonArray(row.tags),
    region: row.region ?? null,
    type: row.type ?? null,
    level: row.level ?? null,
    contact: row.contact ?? null,
    relation: row.relation ?? 0,
    stakeholders: parseJsonArray(row.stakeholders),
    decisionChain: parseJsonArray(row.decisionChain ?? row.decision_chain),
    historyProjects: parseJsonArray(row.historyProjects ?? row.history_projects),
    infrastructure: parseJsonArray(row.infrastructure),
    syncPreview: parseJsonArray(row.syncPreview ?? row.sync_preview),
    budget: row.budget ?? null,
    summary: row.summary ?? null,
    needs: parseJsonArray(row.needs),
    risks: parseJsonArray(row.risks),
    opportunities: parseJsonArray(row.opportunities),
  };
}

export function customerSnapshotDigest(customer) {
  const snapshot = customerShapeFromSnapshot(customer);
  return importDigest(snapshot);
}

function valuesEqual(left, right) {
  return stableImportJson(left) === stableImportJson(right);
}

function unionValues(existing, incoming) {
  const result = Array.isArray(existing) ? [...existing] : [];
  for (const value of Array.isArray(incoming) ? incoming : []) {
    if (!result.some((candidate) => valuesEqual(candidate, value))) result.push(value);
  }
  return result;
}

const MERGE_LIST_FIELDS = new Set([
  "aliases",
  "tags",
  "stakeholders",
  "decisionChain",
  "historyProjects",
  "infrastructure",
  "syncPreview",
  "needs",
  "risks",
  "opportunities",
]);

/** Apply the same non-destructive merge semantics used by the commit service. */
export function mergeCustomerImportShape(current, rowPlan) {
  const normalized = rowPlan?.normalized ?? {};
  const base = customerShapeFromSnapshot(current);
  const patch = {};
  for (const field of rowPlan?.providedFields ?? []) {
    if (!CUSTOMER_IMPORT_FIELDS.includes(field)) continue;
    if (field === "name" && canonicalizeCustomerName(normalized.name) !== canonicalizeCustomerName(base.name)) continue;
    if (MERGE_LIST_FIELDS.has(field)) patch[field] = unionValues(base[field], normalized[field]);
    else patch[field] = normalized[field];
  }
  if (normalized.name && canonicalizeCustomerName(normalized.name) !== canonicalizeCustomerName(base.name)) {
    patch.aliases = unionValues(patch.aliases ?? base.aliases, [normalized.name]);
  }
  return { ...base, ...patch };
}

export function canonicalizeCustomerName(value) {
  return textValue(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function buildCustomerNameIndex(customers = []) {
  const index = new Map();
  for (const rawCustomer of customers) {
    const customer = customerShapeFromSnapshot(rawCustomer);
    if (!customer.id || rawCustomer?.deleted_at || rawCustomer?.deletedAt) continue;
    for (const [value, matchedBy] of [
      [customer.name, "name"],
      ...customer.aliases.map((alias) => [alias, "alias"]),
    ]) {
      const key = canonicalizeCustomerName(value);
      if (!key) continue;
      const matches = index.get(key) ?? [];
      if (!matches.some((item) => item.customer.id === customer.id)) matches.push({ customer, matchedBy });
      index.set(key, matches);
    }
  }
  return index;
}

function rowActionOverride(rowActions, rowNumber) {
  if (!rowActions) return null;
  if (Array.isArray(rowActions)) {
    const item = rowActions.find((entry) => Number(entry?.rowNumber) === Number(rowNumber));
    return item?.action ?? null;
  }
  if (plainObject(rowActions)) return rowActions[rowNumber] ?? rowActions[String(rowNumber)] ?? null;
  return null;
}

function mergeError(errors, field, code, message) {
  errors.push(fieldError(field, code, message));
}

function customerIdentityKeys(customer) {
  return [...new Set(
    [customer?.name, ...(Array.isArray(customer?.aliases) ? customer.aliases : [])]
      .map(canonicalizeCustomerName)
      .filter(Boolean),
  )];
}

function createCustomerIdentityPlanner(customers = []) {
  const working = new Map();
  const owners = new Map();
  const plannedRows = new Map();

  const add = (customerId, customer, rowNumber = null) => {
    working.set(customerId, customer);
    if (rowNumber !== null) plannedRows.set(customerId, rowNumber);
    for (const key of customerIdentityKeys(customer)) {
      const ids = owners.get(key) ?? new Set();
      ids.add(customerId);
      owners.set(key, ids);
    }
  };

  const remove = (customerId, customer) => {
    for (const key of customerIdentityKeys(customer)) {
      const ids = owners.get(key);
      if (!ids) continue;
      ids.delete(customerId);
      if (ids.size === 0) owners.delete(key);
    }
    working.delete(customerId);
    plannedRows.delete(customerId);
  };

  for (const rawCustomer of customers) {
    const customer = customerShapeFromSnapshot(rawCustomer);
    if (customer.id) add(customer.id, customer);
  }

  return {
    plan(rowPlan) {
      if (rowPlan.errors?.length > 0 || !["create", "merge"].includes(rowPlan.action)) return null;

      let customerId = rowPlan.customerId ?? null;
      let current = customerId ? working.get(customerId) : null;
      if (rowPlan.action === "merge" && !current) return null;
      if (rowPlan.action === "create") {
        customerId = `__customer_import_row_${rowPlan.rowNumber}`;
        current = null;
      }

      const proposed = rowPlan.action === "merge"
        ? mergeCustomerImportShape(current, rowPlan)
        : customerImportWriteShape(rowPlan.normalized);
      const conflictingKeys = [];
      for (const key of customerIdentityKeys(proposed)) {
        const ids = owners.get(key);
        if (ids && [...ids].some((id) => id !== customerId)) conflictingKeys.push({ key, ids: [...ids].filter((id) => id !== customerId) });
      }
      if (conflictingKeys.length > 0) {
        const conflict = conflictingKeys[0];
        const conflictingId = conflict.ids[0];
        return {
          code: "FINAL_IDENTITY_CONFLICT",
          key: conflict.key,
          conflictingCustomerId: conflictingId.startsWith("__customer_import_row_") ? null : conflictingId,
          conflictingRowNumber: plannedRows.get(conflictingId) ?? null,
        };
      }

      if (current) remove(customerId, current);
      add(customerId, { ...proposed, id: customerId }, rowPlan.action === "create" ? rowPlan.rowNumber : null);
      return null;
    },
  };
}

/**
 * Check the final name/alias identity set in row order. Rejected and skipped
 * rows never reserve an identity, so a bad row cannot suppress a later valid
 * row and a merge cannot introduce a collision with an earlier create/merge.
 */
export function customerImportPlanConflicts(customers, rowPlans) {
  const planner = createCustomerIdentityPlanner(customers);
  const conflicts = [];
  for (const rowPlan of rowPlans ?? []) {
    const conflict = planner.plan(rowPlan);
    if (conflict) conflicts.push({ rowNumber: rowPlan.rowNumber, ...conflict });
  }
  return conflicts;
}

/**
 * Normalize all parsed rows, add owner-scoped duplicate evidence, and select a
 * safe default action. No database access occurs in this function.
 */
export function normalizeCustomerImportRows(parsed, {
  requestedMapping = null,
  mapping = null,
  customers = [],
  rowActions = null,
  limits = CUSTOMER_IMPORT_LIMITS,
} = {}) {
  if (!parsed || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
    throw new TypeError("Parsed customer import data is required");
  }
  const resolvedMapping = mapping ?? resolveCustomerImportMapping(parsed.headers, requestedMapping);
  const mappingWithHeaders = { ...resolvedMapping, headers: parsed.headers };
  const customerIndex = buildCustomerNameIndex(customers);
  const seenInFile = new Map();
  const identityPlanner = createCustomerIdentityPlanner(customers);
  const rows = [];

  for (const parsedRow of parsed.rows) {
    const normalizedRow = normalizeCustomerImportRow(parsedRow, mappingWithHeaders, {
      rowNumber: parsedRow.rowNumber,
      limits,
    });
    const errors = [...normalizedRow.errors];
    const lookupValues = [normalizedRow.normalized.name, ...normalizedRow.normalized.aliases].filter(Boolean);
    const matches = new Map();
    for (const value of lookupValues) {
      const key = canonicalizeCustomerName(value);
      for (const match of customerIndex.get(key) ?? []) {
        const current = matches.get(match.customer.id);
        if (!current || current.matchedBy !== "name") matches.set(match.customer.id, match);
      }
    }

    let duplicate = null;
    if (matches.size > 1) {
      mergeError(errors, "name", "AMBIGUOUS_DUPLICATE", "客户名称或别名匹配到多个同账号客户");
    } else if (matches.size === 1) {
      const match = [...matches.values()][0];
      duplicate = {
        customerId: match.customer.id,
        matchedBy: match.matchedBy,
        matchVersion: match.customer.version,
        customerSnapshotDigest: customerSnapshotDigest(match.customer),
      };
    }

    const fileKeys = lookupValues.map(canonicalizeCustomerName).filter(Boolean);
    const priorRows = new Set();
    for (const key of fileKeys) for (const prior of seenInFile.get(key) ?? []) priorRows.add(prior.rowNumber);
    const duplicateOfRow = priorRows.size > 0 ? Math.min(...priorRows) : null;
    if (!duplicate && duplicateOfRow !== null) {
      duplicate = { duplicateOfRow, matchedBy: "batch" };
    }

    const requestedAction = rowActionOverride(rowActions, parsedRow.rowNumber);
    let action = errors.length > 0 ? "reject" : duplicate ? (duplicate.matchedBy === "batch" ? "skip" : "merge") : "create";
    if (requestedAction !== null && requestedAction !== undefined && requestedAction !== "") {
      if (!CUSTOMER_IMPORT_ACTIONS.includes(requestedAction)) {
        mergeError(errors, "action", "INVALID_ACTION", "动作必须是 create、merge、skip 或 reject");
        action = "reject";
      } else {
        action = requestedAction;
        if (requestedAction === "create" && duplicate) mergeError(errors, "action", "CREATE_WOULD_DUPLICATE", "重复客户不能直接 create");
        if (requestedAction === "merge" && !duplicate?.customerId) mergeError(errors, "action", "MERGE_TARGET_NOT_FOUND", "merge 没有可用的同账号客户");
      }
    }

    const status = errors.length > 0 ? "error" : duplicate ? "duplicate" : "valid";
    const rowPlan = {
      ...normalizedRow,
      errors,
      action,
      status,
      ...(duplicate ?? {}),
    };
    const identityConflict = identityPlanner.plan(rowPlan);
    if (identityConflict) {
      const detail = identityConflict.conflictingRowNumber
        ? `导入后会与第 ${identityConflict.conflictingRowNumber} 行产生同账号名称或别名冲突`
        : "导入后会与同账号已有客户产生名称或别名冲突";
      mergeError(rowPlan.errors, "name", identityConflict.code, detail);
      rowPlan.action = "reject";
      rowPlan.status = "error";
    }
    rowPlan.rowDigest = importDigest({
      rowNumber: rowPlan.rowNumber,
      normalized: rowPlan.normalized,
      providedFields: rowPlan.providedFields,
      errors: rowPlan.errors,
      action: rowPlan.action,
      status: rowPlan.status,
      duplicate: duplicate ?? null,
    });
    rows.push(rowPlan);
    if (rowPlan.errors.length === 0 && ["create", "merge"].includes(rowPlan.action)) {
      for (const key of fileKeys) {
        const prior = seenInFile.get(key) ?? [];
        prior.push({ rowNumber: parsedRow.rowNumber });
        seenInFile.set(key, prior);
      }
    }
  }

  return {
    mapping: resolvedMapping,
    rows,
    counts: {
      totalRows: rows.length,
      validRows: rows.filter((row) => row.errors.length === 0).length,
      errorRows: rows.filter((row) => row.errors.length > 0).length,
      duplicateRows: rows.filter((row) => row.duplicateOfRow !== undefined || row.customerId).length,
    },
  };
}

export function customerImportWriteShape(value) {
  const shape = defaultCustomerShape();
  for (const field of CUSTOMER_IMPORT_FIELDS) if (Object.hasOwn(value ?? {}, field)) shape[field] = value[field];
  return shape;
}

export function customerImportStableJson(value) {
  return stableImportJson(value);
}

export { normalizeHeaderKey };
