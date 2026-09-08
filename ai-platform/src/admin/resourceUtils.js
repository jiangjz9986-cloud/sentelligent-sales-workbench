import { AI_TASK_TYPES, isPlainObject } from "../../../shared/aiPlatformContract.mjs";
import { AiPlatformError } from "../errors.js";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SLUG = /^[a-z][a-z0-9-]{0,63}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const URL_VALUE = /^(?:https?|ftp|file|data|javascript):/iu;
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|credential|password|secret|private[_-]?key|client[_-]?secret|webhook)/iu;
const EXECUTION_KEY = /^(?:sql|shell|command|script|code|eval|exec|endpoint|url|uri|callback)$/iu;

function invalid(message, details = null) {
  throw new AiPlatformError(message, { code: "invalid_request", status: 400, details });
}

function conflict(message, details = null) {
  throw new AiPlatformError(message, { code: "conflict", status: 409, details });
}

export function adminText(value, name, { max = 500, allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (allowEmpty) return "";
    invalid(`${name} is required`);
  }
  const normalized = String(value).trim();
  if (!allowEmpty && !normalized) invalid(`${name} is required`);
  if (normalized.length > max || CONTROL.test(normalized)) invalid(`${name} is invalid`);
  return normalized;
}

export function optionalAdminText(value, name, options = {}) {
  if (value === undefined || value === null || value === "") return null;
  return adminText(value, name, options);
}

export function adminIdentifier(value, name = "identifier") {
  const normalized = adminText(value, name, { max: 128 });
  if (!IDENTIFIER.test(normalized)) invalid(`${name} is invalid`);
  return normalized;
}

export function adminSlug(value, name = "slug") {
  const normalized = adminText(value, name, { max: 64 });
  if (!SLUG.test(normalized)) invalid(`${name} is invalid`);
  return normalized;
}

export function adminVersion(value, name = "version") {
  const normalized = adminText(value, name, { max: 64 });
  if (!VERSION.test(normalized)) invalid(`${name} is invalid`);
  return normalized;
}

export function adminCurrency(value, name = "currency") {
  const normalized = adminText(value, name, { max: 3 });
  if (!CURRENCY.test(normalized)) invalid(`${name} is invalid`);
  return normalized;
}

export function adminBoolean(value, name) {
  if (typeof value !== "boolean") invalid(`${name} must be a boolean`);
  return value;
}

export function adminInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) invalid(`${name} is invalid`);
  return parsed;
}

export function adminNumber(value, name, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) invalid(`${name} is invalid`);
  return parsed;
}

export function adminDate(value, name = "date") {
  const candidate = adminText(value, name, { max: 80 });
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) invalid(`${name} is invalid`);
  return date.toISOString();
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function parseObject(value, fallback = {}) {
  const parsed = typeof value === "string" ? parseJson(value, fallback) : value;
  return isPlainObject(parsed) ? parsed : fallback;
}

export function parseArray(value, fallback = []) {
  const parsed = typeof value === "string" ? parseJson(value, fallback) : value;
  return Array.isArray(parsed) ? parsed : fallback;
}

function cloneJson(value, path, {
  depth,
  maxDepth,
  maxArrayLength,
  maxObjectKeys,
  maxStringLength,
  rejectExecutionKeys,
  seen,
}) {
  if (depth > maxDepth) invalid(`${path} is too deeply nested`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > maxStringLength || CONTROL.test(value)) invalid(`${path} contains invalid text`);
    if (rejectExecutionKeys && URL_VALUE.test(value.trim())) invalid(`${path} cannot contain an executable URL`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value === "undefined") return null;
  if (!Array.isArray(value) && !isPlainObject(value)) invalid(`${path} must be JSON data`);
  if (seen.has(value)) invalid(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > maxArrayLength) invalid(`${path} has too many items`);
      return value.map((item, index) => cloneJson(item, `${path}[${index}]`, {
        depth: depth + 1,
        maxDepth,
        maxArrayLength,
        maxObjectKeys,
        maxStringLength,
        rejectExecutionKeys,
        seen,
      }));
    }
    const keys = Object.keys(value);
    if (keys.length > maxObjectKeys) invalid(`${path} has too many fields`);
    return Object.fromEntries(keys.map((key) => {
      if (key.length > 128 || CONTROL.test(key)) invalid(`${path} contains an invalid field name`);
      if (rejectExecutionKeys && EXECUTION_KEY.test(key)) invalid(`${path}.${key} is not allowed`);
      return [key, cloneJson(value[key], `${path}.${key}`, {
        depth: depth + 1,
        maxDepth,
        maxArrayLength,
        maxObjectKeys,
        maxStringLength,
        rejectExecutionKeys,
        seen,
      })];
    }));
  } finally {
    seen.delete(value);
  }
}

export function boundedAdminJson(value, name, {
  fallback = {},
  maxBytes = 256 * 1024,
  maxDepth = 12,
  maxArrayLength = 100,
  maxObjectKeys = 100,
  maxStringLength = 100_000,
  rejectExecutionKeys = false,
} = {}) {
  const candidate = value === undefined || value === null ? fallback : value;
  const normalized = cloneJson(candidate, name, {
    depth: 0,
    maxDepth,
    maxArrayLength,
    maxObjectKeys,
    maxStringLength,
    rejectExecutionKeys,
    seen: new Set(),
  });
  let encoded;
  try {
    encoded = JSON.stringify(normalized);
  } catch {
    invalid(`${name} is invalid`);
  }
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) invalid(`${name} is too large`);
  return normalized;
}

export function normalizeTaskTypes(value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) invalid("taskTypes is required");
    return undefined;
  }
  if (!Array.isArray(value) || value.length < (required ? 1 : 0) || value.length > 50) {
    invalid("taskTypes is invalid");
  }
  const normalized = [...new Set(value.map((item) => adminText(item, "taskType", { max: 127 })))];
  for (const item of normalized) {
    if (!AI_TASK_TYPES.includes(item)) invalid("taskTypes contains an unregistered task type");
  }
  return normalized;
}

export function normalizeStandardIds(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) invalid("standardIds is required");
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 50) invalid("standardIds is invalid");
  return [...new Set(value.map((item) => adminIdentifier(item, "standardId")))];
}

export function normalizeTools(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) invalid("tools is required");
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 50) invalid("tools is invalid");
  return value.map((tool, index) => {
    if (typeof tool === "string") return adminIdentifier(tool, `tools[${index}]`);
    if (!isPlainObject(tool)) invalid(`tools[${index}] is invalid`);
    const allowed = new Set(["name", "version", "readOnly", "scopes"]);
    for (const key of Object.keys(tool)) if (!allowed.has(key)) invalid(`tools[${index}].${key} is not allowed`);
    const normalized = {
      name: adminIdentifier(tool.name, `tools[${index}].name`),
    };
    if (tool.version !== undefined) normalized.version = adminVersion(tool.version, `tools[${index}].version`);
    if (tool.readOnly !== undefined) normalized.readOnly = adminBoolean(tool.readOnly, `tools[${index}].readOnly`);
    if (tool.scopes !== undefined) {
      if (!Array.isArray(tool.scopes) || tool.scopes.length > 20) invalid(`tools[${index}].scopes is invalid`);
      normalized.scopes = [...new Set(tool.scopes.map((scope) => adminIdentifier(scope, `tools[${index}].scope`)))];
    }
    return normalized;
  });
}

export function normalizeModelPolicy(value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) invalid("modelPolicy is required");
    return undefined;
  }
  if (!isPlainObject(value)) invalid("modelPolicy must be an object");
  const allowed = new Set([
    "modelId",
    "providerId",
    "fallbackModelId",
    "externalAllowed",
    "temperature",
    "maxTokens",
    "timeoutMs",
    "responseFormat",
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`modelPolicy.${key} is not allowed`);
  const normalized = {};
  if (value.modelId !== undefined) normalized.modelId = adminIdentifier(value.modelId, "modelPolicy.modelId");
  if (required && !normalized.modelId) invalid("modelPolicy.modelId is required");
  if (value.providerId !== undefined) normalized.providerId = adminIdentifier(value.providerId, "modelPolicy.providerId");
  if (value.fallbackModelId !== undefined && value.fallbackModelId !== null) {
    normalized.fallbackModelId = adminIdentifier(value.fallbackModelId, "modelPolicy.fallbackModelId");
  }
  if (value.externalAllowed !== undefined) normalized.externalAllowed = adminBoolean(value.externalAllowed, "modelPolicy.externalAllowed");
  if (value.temperature !== undefined) normalized.temperature = adminNumber(value.temperature, "modelPolicy.temperature", { min: 0, max: 2 });
  if (value.maxTokens !== undefined) normalized.maxTokens = adminInteger(value.maxTokens, "modelPolicy.maxTokens", { min: 1, max: 100_000 });
  if (value.timeoutMs !== undefined) normalized.timeoutMs = adminInteger(value.timeoutMs, "modelPolicy.timeoutMs", { min: 100, max: 600_000 });
  if (value.responseFormat !== undefined) {
    const format = adminText(value.responseFormat, "modelPolicy.responseFormat", { max: 32 });
    if (!["text", "json"].includes(format)) invalid("modelPolicy.responseFormat is invalid");
    normalized.responseFormat = format;
  }
  return normalized;
}

export function normalizeLimits(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) invalid("limits is required");
    return undefined;
  }
  if (!isPlainObject(value)) invalid("limits must be an object");
  const allowed = new Set(["maxTokens", "timeoutMs", "maxSteps", "maxAttempts"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`limits.${key} is not allowed`);
  const normalized = {};
  if (value.maxTokens !== undefined) normalized.maxTokens = adminInteger(value.maxTokens, "limits.maxTokens", { min: 1, max: 100_000 });
  if (value.timeoutMs !== undefined) normalized.timeoutMs = adminInteger(value.timeoutMs, "limits.timeoutMs", { min: 100, max: 600_000 });
  if (value.maxSteps !== undefined) normalized.maxSteps = adminInteger(value.maxSteps, "limits.maxSteps", { min: 1, max: 100 });
  if (value.maxAttempts !== undefined) normalized.maxAttempts = adminInteger(value.maxAttempts, "limits.maxAttempts", { min: 1, max: 3 });
  return normalized;
}

function normalizePrompt(value, name, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) invalid(`${name} is required`);
    return undefined;
  }
  const normalized = String(value).trim();
  if ((required && !normalized) || normalized.length > 100_000 || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
    invalid(`${name} is invalid`);
  }
  return normalized;
}

export function normalizeAgentDraft(value, { partial = false } = {}) {
  if (!isPlainObject(value)) invalid("agent draft must be an object");
  const allowed = new Set([
    "slug",
    "name",
    "description",
    "lifecycle",
    "version",
    "taskTypes",
    "systemPrompt",
    "instructions",
    "tools",
    "modelPolicy",
    "inputSchema",
    "outputSchema",
    "standardIds",
    "limits",
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`agent draft.${key} is not allowed`);
  const output = {};
  if (value.slug !== undefined || !partial) output.slug = adminSlug(value.slug, "slug");
  if (value.name !== undefined || !partial) output.name = adminText(value.name, "name", { max: 200 });
  if (value.description !== undefined || !partial) output.description = adminText(value.description ?? "", "description", { max: 2_000, allowEmpty: true });
  if (value.lifecycle !== undefined || !partial) {
    const lifecycle = adminText(value.lifecycle ?? "draft", "lifecycle", { max: 20 });
    if (!["active", "draft", "disabled"].includes(lifecycle)) invalid("lifecycle is invalid");
    output.lifecycle = lifecycle;
  }
  if (value.version !== undefined) output.version = adminVersion(value.version);
  if (value.taskTypes !== undefined || !partial) output.taskTypes = normalizeTaskTypes(value.taskTypes, { required: true });
  if (value.systemPrompt !== undefined || !partial) output.systemPrompt = normalizePrompt(value.systemPrompt, "systemPrompt");
  if (value.instructions !== undefined || !partial) {
    output.instructions = boundedAdminJson(value.instructions, "instructions", { fallback: {}, rejectExecutionKeys: true });
  }
  if (value.tools !== undefined || !partial) output.tools = normalizeTools(value.tools ?? [], { required: true });
  if (value.modelPolicy !== undefined || !partial) output.modelPolicy = normalizeModelPolicy(value.modelPolicy, { required: true });
  if (value.inputSchema !== undefined || !partial) {
    output.inputSchema = boundedAdminJson(value.inputSchema, "inputSchema", { fallback: {}, rejectExecutionKeys: false });
    if (!isPlainObject(output.inputSchema)) invalid("inputSchema must be an object");
  }
  if (value.outputSchema !== undefined || !partial) {
    output.outputSchema = boundedAdminJson(value.outputSchema, "outputSchema", { fallback: {}, rejectExecutionKeys: false });
    if (!isPlainObject(output.outputSchema)) invalid("outputSchema must be an object");
  }
  if (value.standardIds !== undefined || !partial) output.standardIds = normalizeStandardIds(value.standardIds ?? [], { required: true });
  if (value.limits !== undefined || !partial) output.limits = normalizeLimits(value.limits ?? {}, { required: true });
  return output;
}

export function normalizeStandardDraft(value, { partial = false } = {}) {
  if (!isPlainObject(value)) invalid("standard draft must be an object");
  const allowed = new Set(["slug", "name", "description", "lifecycle", "version", "content", "rules"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`standard draft.${key} is not allowed`);
  const output = {};
  if (value.slug !== undefined || !partial) output.slug = adminSlug(value.slug, "slug");
  if (value.name !== undefined || !partial) output.name = adminText(value.name, "name", { max: 200 });
  if (value.description !== undefined || !partial) output.description = adminText(value.description ?? "", "description", { max: 2_000, allowEmpty: true });
  if (value.lifecycle !== undefined || !partial) {
    const lifecycle = adminText(value.lifecycle ?? "draft", "lifecycle", { max: 20 });
    if (!["active", "draft", "disabled"].includes(lifecycle)) invalid("lifecycle is invalid");
    output.lifecycle = lifecycle;
  }
  if (value.version !== undefined) output.version = adminVersion(value.version);
  if (value.content !== undefined || !partial) output.content = normalizePrompt(value.content, "content");
  if (value.rules !== undefined || !partial) output.rules = boundedAdminJson(value.rules, "rules", { fallback: {}, rejectExecutionKeys: true });
  return output;
}

export function normalizeBudgetPatch(value) {
  if (!isPlainObject(value)) invalid("budget patch must be an object");
  const allowed = new Set(["amountMicro", "callLimit", "warningPercent", "enabled"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`budget patch.${key} is not allowed`);
  const output = {};
  if (value.amountMicro !== undefined) output.amountMicro = adminInteger(value.amountMicro, "amountMicro", { min: 0, max: 9_000_000_000_000_000 });
  if (value.callLimit !== undefined) output.callLimit = adminInteger(value.callLimit, "callLimit", { min: 0, max: 2_000_000_000 });
  if (value.warningPercent !== undefined) output.warningPercent = adminInteger(value.warningPercent, "warningPercent", { min: 1, max: 100 });
  if (value.enabled !== undefined) output.enabled = adminBoolean(value.enabled, "enabled");
  if (!Object.keys(output).length) invalid("budget patch is empty");
  return output;
}

export function normalizeSchedulePatch(value) {
  if (!isPlainObject(value)) invalid("schedule patch must be an object");
  const allowed = new Set(["name", "taskType", "feature", "intervalSeconds", "inputTemplate", "enabled"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`schedule patch.${key} is not allowed`);
  const output = {};
  if (value.name !== undefined) output.name = adminText(value.name, "name", { max: 200 });
  if (value.taskType !== undefined) {
    const taskTypes = normalizeTaskTypes([value.taskType]);
    output.taskType = taskTypes[0];
  }
  if (value.feature !== undefined) output.feature = adminIdentifier(value.feature, "feature");
  if (value.intervalSeconds !== undefined) output.intervalSeconds = adminInteger(value.intervalSeconds, "intervalSeconds", { min: 30, max: 2_592_000 });
  if (value.inputTemplate !== undefined) output.inputTemplate = boundedAdminJson(value.inputTemplate, "inputTemplate", { fallback: {}, rejectExecutionKeys: true });
  if (value.enabled !== undefined) output.enabled = adminBoolean(value.enabled, "enabled");
  if (!Object.keys(output).length) invalid("schedule patch is empty");
  return output;
}

export function normalizePage(value, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = value?.limit === undefined || value?.limit === null || value?.limit === ""
    ? defaultLimit
    : adminInteger(value.limit, "limit", { min: 1, max: maxLimit });
  const offset = value?.offset === undefined || value?.offset === null || value?.offset === ""
    ? 0
    : adminInteger(value.offset, "offset", { min: 0, max: 100_000 });
  return { limit, offset };
}

export function normalizeFilter(value, name, max = 200) {
  if (value === undefined || value === null || value === "") return null;
  return adminText(value, name, { max });
}

export function nextPatchVersion(rows, fallback = "0.1.0") {
  let best = null;
  for (const row of rows ?? []) {
    const match = String(row?.version ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
    if (!match) continue;
    const candidate = match.slice(1, 4).map(Number);
    if (!best || candidate[0] > best[0] || (candidate[0] === best[0] && candidate[1] > best[1]) || (candidate[0] === best[0] && candidate[1] === best[1] && candidate[2] > best[2])) {
      best = candidate;
    }
  }
  if (!best) return fallback;
  return `${best[0]}.${best[1]}.${best[2] + 1}`;
}

export function assertNoDuplicateVersion(rows, version, name = "version") {
  if ((rows ?? []).some((row) => row.version === version)) conflict(`${name} already exists`);
}

function redactValue(value, depth, seen) {
  if (depth > 10) return "[redacted-depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (URL_VALUE.test(value.trim()) || /(?:bearer\s+|sk-[A-Za-z0-9]{12,}|-----BEGIN [A-Z ]+ KEY-----)/u.test(value)) return "[redacted]";
    return value.length > 20_000 ? `${value.slice(0, 20_000)}...[redacted]` : value;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) return "[redacted]";
  if (seen.has(value)) return "[redacted-cycle]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1, seen));
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) || EXECUTION_KEY.test(key) ? "[redacted]" : redactValue(item, depth + 1, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

export function redactSecrets(value) {
  return redactValue(value, 0, new Set());
}

export function safeJsonView(value, fallback = {}) {
  return redactSecrets(parseJson(value, fallback));
}

export function safeObjectView(value, fallback = {}) {
  return redactSecrets(isPlainObject(value) ? value : fallback);
}

export function hasConfiguredSecret(configJson) {
  const config = parseObject(configJson, {});
  return Object.entries(config).some(([key, value]) => SECRET_KEY.test(key) && value !== null && value !== undefined && String(value).trim() !== "");
}

export function safeErrorMessage(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  return text.length > 1_000 ? `${text.slice(0, 1_000)}...` : text;
}

export function safeTextView(value, fallback = "", max = 100_000) {
  if (value === null || value === undefined || value === "") return fallback;
  const text = String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[redacted]")
    .replace(/-----BEGIN [A-Z ]+ KEY-----[\s\S]*?-----END [A-Z ]+ KEY-----/gu, "[redacted]")
    .trim();
  return text.length > max ? `${text.slice(0, max)}...[redacted]` : text;
}

export { conflict, invalid, EXECUTION_KEY, SECRET_KEY };
