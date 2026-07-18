import { HttpError } from "../http/errors.js";

const MAX_NESTED_DEPTH = 5;
const MAX_NESTED_STRING_LENGTH = 2048;
const MAX_NESTED_ARRAY_ITEMS = 100;
const MAX_NESTED_OBJECT_KEYS = 50;

function fail(field, rule) {
  throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { [field]: rule });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function safeJson(value, depth = 0, maxKeys = MAX_NESTED_OBJECT_KEYS) {
  if (depth > MAX_NESTED_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= MAX_NESTED_STRING_LENGTH;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= MAX_NESTED_ARRAY_ITEMS && value.every((item) => safeJson(item, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= maxKeys && entries.every(([, item]) => safeJson(item, depth + 1));
}

function requiresNonEmptyString(rule) {
  return rule.nonEmpty ?? Boolean(rule.required);
}

function objectRuleViolation(value, rule) {
  if (!isPlainObject(value)) return "object";
  const entries = Object.entries(value);
  if (rule.maxKeys !== undefined && entries.length > rule.maxKeys) return "maxKeys";
  if (rule.allowedKeys && entries.some(([key]) => !rule.allowedKeys.includes(key))) return "key";
  if (rule.value && entries.some(([, item]) => !safeRuleValue(item, rule.value))) return "value";
  if (!safeJson(value, 0, rule.maxKeys)) return "object";
  return null;
}

function validateRule(field, value, rule) {
  if (value === null) {
    if (rule.nullable) return;
    fail(field, "type");
  }

  if (rule.type === "string") {
    if (typeof value !== "string") fail(field, "string");
    if (requiresNonEmptyString(rule) && !value.trim()) fail(field, "required");
    if (value.length > rule.max) fail(field, "max");
    return;
  }

  if (rule.type === "integer") {
    if (!Number.isSafeInteger(value)) fail(field, "integer");
    if (rule.min !== undefined && value < rule.min) fail(field, "min");
    if (rule.max !== undefined && value > rule.max) fail(field, "max");
    return;
  }

  if (rule.type === "enum") {
    if (!rule.values.includes(value)) fail(field, "enum");
    return;
  }

  if (rule.type === "array") {
    if (!Array.isArray(value)) fail(field, "array");
    if (rule.minItems !== undefined && value.length < rule.minItems) fail(field, "minItems");
    if (value.length > rule.maxItems) fail(field, "maxItems");
    for (const item of value) {
      if (rule.values && !rule.values.includes(item)) fail(field, "item");
      if (rule.item && !safeRuleValue(item, rule.item)) fail(field, "item");
      if (!rule.item && !rule.values && !safeJson(item)) fail(field, "item");
    }
    return;
  }

  if (rule.type === "object") {
    const violation = objectRuleViolation(value, rule);
    if (violation) fail(field, violation);
    return;
  }

  fail(field, "rule");
}

function safeRuleValue(value, rule) {
  if (value === null) return Boolean(rule.nullable);
  if (rule.type === "string") {
    return typeof value === "string"
      && value.length <= rule.max
      && (!requiresNonEmptyString(rule) || Boolean(value.trim()));
  }
  if (rule.type === "integer") {
    return Number.isSafeInteger(value)
      && (rule.min === undefined || value >= rule.min)
      && (rule.max === undefined || value <= rule.max);
  }
  if (rule.type === "enum") return rule.values.includes(value);
  if (rule.type === "array") {
    return Array.isArray(value)
      && (rule.minItems === undefined || value.length >= rule.minItems)
      && value.length <= rule.maxItems
      && value.every((item) => (!rule.values || rule.values.includes(item)) && (!rule.item || safeRuleValue(item, rule.item)));
  }
  if (rule.type === "object") {
    return objectRuleViolation(value, rule) === null;
  }
  return false;
}

export function validateObject(schema, body, { allowEmpty = false } = {}) {
  if (!isPlainObject(body)) fail("body", "object");

  const errors = new Map();
  for (const field of Object.keys(body)) {
    if (!Object.hasOwn(schema, field)) errors.set(field, "unknown");
  }

  for (const [field, rule] of Object.entries(schema)) {
    if (!Object.hasOwn(body, field)) {
      if (rule.required) errors.set(field, "required");
      continue;
    }
    try {
      validateRule(field, body[field], rule);
    } catch (error) {
      if (!(error instanceof HttpError) || !error.fields?.[field]) throw error;
      errors.set(field, error.fields[field]);
    }
  }

  if (!allowEmpty && Object.keys(body).length === 0) errors.set("body", "empty");
  if (errors.size > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", Object.fromEntries(errors));
  }
  return body;
}

export function partialSchema(schema) {
  return Object.fromEntries(Object.entries(schema).map(([field, rule]) => {
    const partialRule = { ...rule, required: false };
    if (rule.type === "string" && requiresNonEmptyString(rule)) partialRule.nonEmpty = true;
    return [field, partialRule];
  }));
}

function freezeSchema(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSchema(child);
    Object.freeze(value);
  }
  return value;
}

const text = (max, options = {}) => ({ type: "string", max, ...options });
const safeObject = (options = {}) => ({ type: "object", maxKeys: 30, ...options });
const safeArray = (options = {}) => ({ type: "array", maxItems: 100, ...options });
const stringArray = (maxItems, itemMax = 200, options = {}) => ({
  type: "array",
  maxItems,
  item: text(itemMax),
  ...options,
});

export const requestSchemas = freezeSchema({
  login: {
    account: text(100, { required: true }),
    password: text(1000, { required: true }),
  },
  customerCreate: {
    name: text(200, { required: true }), region: text(100, { nullable: true }), type: text(100, { nullable: true }),
    level: text(50, { nullable: true }), owner: text(100, { nullable: true }), contact: text(500, { nullable: true }),
    relation: { type: "integer", min: 0, max: 100 }, stakeholders: safeArray(),
    decisionChain: safeArray(), historyProjects: safeArray(), infrastructure: safeArray(),
    syncPreview: safeArray(), budget: text(500, { nullable: true }), summary: text(5000, { nullable: true }),
    needs: safeArray(), risks: safeArray(), opportunities: safeArray(),
  },
  opportunityCreate: {
    customerId: text(200, { required: true }), name: text(200, { required: true }), customer: text(200, { nullable: true }),
    stage: text(100, { nullable: true }), amount: text(100, { nullable: true }), owner: text(100, { nullable: true }),
    probability: { type: "integer", min: 0, max: 100 }, days: { type: "integer", min: 0, max: 10000 },
    requirements: safeArray(), competitors: safeArray(), solutionDirection: safeArray(),
    sourceRecord: text(200, { nullable: true }), risk: text(5000, { nullable: true }), next: text(5000, { nullable: true }), tone: text(50, { nullable: true }),
  },
  quickRecordCreate: {
    rawContent: text(50000, { required: true }), occurredAt: text(50, { nullable: true }), sourceChannel: text(100, { nullable: true }),
    customerId: text(200, { nullable: true, nonEmpty: true }), opportunityId: text(200, { nullable: true, nonEmpty: true }),
  },
  quickRecordPreview: { rawContent: text(50000, { required: true }) },
  quickRecordAnalysisPatch: {
    summary: {
      type: "object",
      required: true,
      maxKeys: 4,
      allowedKeys: ["request", "feedback", "risk", "action"],
      value: text(5000),
    },
  },
  confirmation: {
    targets: { type: "array", minItems: 1, maxItems: 3, required: true, values: ["customer", "opportunity", "weekly"] },
    confirmedBy: text(100, { nullable: true }), note: text(5000, { nullable: true }), analysisVersionId: text(200, { nullable: true }),
    targetVersions: {
      type: "object",
      maxKeys: 2,
      allowedKeys: ["customer", "opportunity"],
      value: { type: "integer", min: 1 },
    },
  },
  actionPatch: {
    title: text(500), reason: text(5000, { nullable: true }), due: text(50, { nullable: true }),
    assignee: text(100, { nullable: true }), priority: { type: "enum", values: ["高", "中", "低"] },
    status: { type: "enum", values: ["pending", "in_progress", "done", "deferred"] }, tone: text(50, { nullable: true }),
  },
  riskPatch: {
    action: text(5000), assignee: text(100, { nullable: true }), due: text(50, { nullable: true }),
    score: { type: "integer", min: 0, max: 100 }, severity: { type: "enum", values: ["高", "中", "低"] },
    status: { type: "enum", values: ["open", "accepted", "in_progress", "deferred", "closed"] }, tone: text(50),
  },
  weeklyPatch: {
    content: text(100000), status: { type: "enum", values: ["draft", "saved", "ready"] },
  },
  knowledgeCreate: {
    title: text(500, { required: true }), category: text(100, { nullable: true }), tags: stringArray(50, 100),
    summary: text(5000, { nullable: true }), content: text(100000, { nullable: true }), source: text(1000, { nullable: true }),
  },
  knowledgeSearch: { query: text(5000, { nullable: true }), tags: stringArray(50, 100), limit: { type: "integer", min: 1, max: 20 } },
  weeklyDraft: {
    owner: text(100, { required: true }), periodStart: text(50, { required: true }), periodEnd: text(50, { required: true }),
    knowledgeIds: stringArray(100, 200),
  },
  aiSuggestion: { type: text(100, { required: true }), title: text(500, { required: true }), context: safeObject() },
  solutionDraft: {
    owner: text(100, { required: true }), customerId: text(200, { required: true }), opportunityId: text(200, { required: true }),
    artifactType: { type: "enum", values: ["solution_framework", "communication_outline", "presales_questions", "report_outline", "competitive_talk"] },
    knowledgeIds: stringArray(100, 200),
  },
  solutionPatch: {
    title: text(500), content: text(100000),
    status: { type: "enum", values: ["draft", "saved", "ready"] },
  },
  riskDiagnose: { sourceType: text(100, { nullable: true }), sourceId: text(200, { nullable: true }) },
});
