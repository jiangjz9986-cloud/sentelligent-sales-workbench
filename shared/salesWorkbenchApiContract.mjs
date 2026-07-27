export const SALES_WORKBENCH_API_CONTRACT_VERSION = "2026-07-27";

export const SALES_WORKBENCH_API_SCHEMAS = {
  customer: {
    id: "string",
    version: "positiveInteger",
    name: "string",
    region: "nullableString",
    type: "nullableString",
    level: "nullableString",
    owner: "nullableString",
    contact: "nullableString",
    relation: "number",
    stakeholders: "array",
    decisionChain: "array",
    historyProjects: "array",
    infrastructure: "array",
    syncPreview: "array",
    budget: "nullableString",
    summary: "nullableString",
    needs: "array",
    risks: "array",
    opportunities: "array",
  },
  opportunity: {
    id: "string",
    version: "positiveInteger",
    customerId: "string",
    name: "string",
    customer: "nullableString",
    stage: "nullableString",
    amount: "nullableString",
    owner: "nullableString",
    probability: "number",
    days: "number",
    requirements: "array",
    competitors: "array",
    solutionDirection: "array",
    sourceRecord: "nullableString",
    risk: "nullableString",
    next: "nullableString",
    tone: "nullableString",
  },
  actionItem: {
    id: "string",
    version: "positiveInteger",
    customerId: "nullableString",
    opportunityId: "nullableString",
    title: "string",
    customer: "nullableString",
    reason: "nullableString",
    due: "nullableString",
    assignee: "nullableString",
    priority: "string",
    status: "string",
    sourceRecordId: "nullableString",
    tone: "nullableString",
    createdAt: "string",
    updatedAt: "string",
  },
  riskItem: {
    id: "string",
    version: "positiveInteger",
    customerId: "nullableString",
    opportunityId: "nullableString",
    title: "string",
    target: "string",
    score: "number",
    severity: "string",
    status: "string",
    evidence: "string",
    action: "string",
    assignee: "nullableString",
    due: "nullableString",
    sourceType: "string",
    sourceId: "nullableString",
    tone: "string",
    createdAt: "string",
    updatedAt: "string",
  },
  knowledgeItem: {
    id: "string",
    version: "positiveInteger",
    title: "string",
    category: "nullableString",
    tags: "array",
    summary: "nullableString",
    content: "nullableString",
    source: "nullableString",
    createdAt: "string",
    updatedAt: "string",
  },
  quickRecord: {
    id: "string",
    version: "positiveInteger",
    rawContent: "string",
    occurredAt: "nullableString",
    sourceChannel: "nullableString",
    customerId: "nullableString",
    opportunityId: "nullableString",
    status: "string",
  },
  quickRecordHistory: {
    id: "string",
    version: "positiveInteger",
    rawContent: "string",
    occurredAt: "nullableString",
    sourceChannel: "nullableString",
    customerId: "nullableString",
    opportunityId: "nullableString",
    status: "string",
    analysis: "nullableObject",
    confirmations: "array",
    confirmedTargets: "array",
    syncLog: "array",
  },
  aiInsight: {
    id: "string",
    quickRecordId: "string",
    source: "string",
    confidence: "number",
    customer: "object",
    opportunity: "object",
    weekly: "object",
    summary: "object",
  },
  manualConfirmation: {
    id: "string",
    quickRecordId: "string",
    target: "string",
    confirmedBy: "nullableString",
    note: "nullableString",
    createdAt: "string",
  },
  weeklyReport: {
    id: "string",
    version: "positiveInteger",
    owner: "string",
    periodStart: "string",
    periodEnd: "string",
    status: "string",
    content: "string",
    sourceRefs: "array",
  },
  solutionDraft: {
    id: "string",
    version: "positiveInteger",
    owner: "string",
    artifactType: "string",
    title: "string",
    customerId: "string",
    opportunityId: "string",
    status: "string",
    content: "string",
    sourceRefs: "array",
    createdAt: "string",
    updatedAt: "string",
  },
  aiSuggestion: {
    id: "string",
    type: "string",
    title: "string",
    status: "string",
    content: "string",
    sourceRefs: "array",
    createdAt: "string",
  },
  salesDecisionAnalysis: {
    id: "string",
    version: "positiveInteger",
    analysisType: "string",
    industry: "string",
    customerId: "nullableString",
    opportunityId: "nullableString",
    quickRecordId: "nullableString",
    input: "object",
    analysis: "object",
    source: "string",
    createdBy: "string",
    createdAt: "string",
  },
  dashboardSummary: {
    metrics: "object",
    priorityActions: "array",
    customerHeat: "array",
    recentRecords: "array",
    opportunities: "array",
    rhythm: "array",
    stageCounts: "array",
    generatedAt: "string",
  },
  visitItinerary: {
    id: "string",
    version: "positiveInteger",
    title: "string",
    visitDate: "string",
    status: "string",
    request: "object",
    plan: "object",
    createdBy: "string",
    updatedBy: "string",
    createdAt: "string",
    updatedAt: "string",
  },
};

function describeValue(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function isExpectedType(value, descriptor) {
  if (descriptor === "array") return Array.isArray(value);
  if (descriptor === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (descriptor === "nullableObject") return value === null || (typeof value === "object" && !Array.isArray(value));
  if (descriptor === "string") return typeof value === "string";
  if (descriptor === "number") return typeof value === "number" && Number.isFinite(value);
  if (descriptor === "positiveInteger") return Number.isSafeInteger(value) && value > 0;
  if (descriptor === "nullableString") return value === null || typeof value === "string";
  if (descriptor === "nullableNumber") return value === null || (typeof value === "number" && Number.isFinite(value));
  throw new Error(`Unknown API contract descriptor: ${descriptor}`);
}

export function collectApiEntityErrors(entityName, value, path = entityName) {
  const schema = SALES_WORKBENCH_API_SCHEMAS[entityName];
  if (!schema) return [`${path}: unknown API contract entity "${entityName}"`];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`${path}: expected object, received ${describeValue(value)}`];
  }

  const errors = [];
  for (const [field, descriptor] of Object.entries(schema)) {
    if (!(field in value)) {
      errors.push(`${path}.${field}: missing required field`);
      continue;
    }
    if (!isExpectedType(value[field], descriptor)) {
      errors.push(`${path}.${field}: expected ${descriptor}, received ${describeValue(value[field])}`);
    }
  }
  return errors;
}

export function assertApiEntity(entityName, value, path = entityName) {
  const errors = collectApiEntityErrors(entityName, value, path);
  if (errors.length > 0) {
    throw new TypeError(`Sales workbench API contract violation:\n${errors.join("\n")}`);
  }
  return value;
}

export function assertApiCollection(entityName, values, path = `${entityName}[]`) {
  if (!Array.isArray(values)) {
    throw new TypeError(`Sales workbench API contract violation:\n${path}: expected array, received ${describeValue(values)}`);
  }

  values.forEach((value, index) => assertApiEntity(entityName, value, `${path}[${index}]`));
  return values;
}
