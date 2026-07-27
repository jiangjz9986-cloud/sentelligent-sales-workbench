export const SALES_DECISION_SCHEMA_VERSION = "sales-decision-v1";

export const SALES_DECISION_TYPES = Object.freeze([
  "opportunity_diagnosis",
  "customer_analysis",
  "meeting_preparation",
  "next_step_decision",
]);

export const SALES_DECISION_CODES = Object.freeze([
  "advance",
  "advance_with_conditions",
  "validate",
  "nurture",
  "pause",
  "disqualify",
  "escalate_review",
]);

export const SALES_DECISION_STAGES = Object.freeze([
  "lead",
  "initial_discovery",
  "deep_discovery",
  "solution_validation",
  "commercial_progress",
  "decision_commitment",
  "won",
  "lost",
  "paused",
]);

const STAKEHOLDER_ROLES = new Set([
  "economic_buyer",
  "business_decision_maker",
  "technical_decision_maker",
  "user",
  "procurement",
  "legal_finance",
  "champion",
  "coach",
  "blocker",
  "unknown",
]);
const STANCE_VALUES = new Set(["supportive", "neutral", "opposed", "unknown"]);
const INFLUENCE_VALUES = new Set(["high", "medium", "low", "unknown"]);
const PRIORITY_VALUES = new Set(["high", "medium", "low"]);
const SEVERITY_VALUES = new Set(["high", "medium", "low"]);
const COMPLIANCE_VALUES = new Set(["clear", "review_required"]);

function fail(path, message = "is invalid") {
  throw new TypeError(`Sales decision response ${path} ${message}`);
}

function plainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value;
}

function text(value, path, { nullable = false, max = 2000 } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    fail(path, "must be a non-empty bounded string");
  }
  return value.trim();
}

function integer(value, path, { min = 0, max = 100 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(path, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function enumValue(value, path, values) {
  if (!values.includes(value)) fail(path, `must be one of ${values.join(", ")}`);
  return value;
}

function textArray(value, path, maxItems = 8, maxLength = 1000) {
  if (!Array.isArray(value) || value.length > maxItems) fail(path, "must be a bounded array");
  return value.map((item, index) => text(item, `${path}[${index}]`, { max: maxLength }));
}

function normalizeFacts(value, path) {
  if (!Array.isArray(value) || value.length > 50) fail(path, "must be an array");
  return value.map((item, index) => {
    const entry = plainObject(item, `${path}[${index}]`);
    return {
      claim: text(entry.claim, `${path}[${index}].claim`),
      sourceType: text(entry.sourceType, `${path}[${index}].sourceType`, { max: 100 }),
      sourceId: text(entry.sourceId, `${path}[${index}].sourceId`, { nullable: true, max: 256 }),
      occurredAt: text(entry.occurredAt, `${path}[${index}].occurredAt`, { nullable: true, max: 100 }),
      confidence: integer(entry.confidence, `${path}[${index}].confidence`),
    };
  });
}

function normalizeInferences(value, path) {
  if (!Array.isArray(value) || value.length > 30) fail(path, "must be an array");
  return value.map((item, index) => {
    const entry = plainObject(item, `${path}[${index}]`);
    return {
      claim: text(entry.claim, `${path}[${index}].claim`),
      basis: textArray(entry.basis, `${path}[${index}].basis`, 5),
      confidence: integer(entry.confidence, `${path}[${index}].confidence`),
    };
  });
}

function normalizeUnknowns(value, path) {
  if (!Array.isArray(value) || value.length > 30) fail(path, "must be an array");
  return value.map((item, index) => {
    const entry = plainObject(item, `${path}[${index}]`);
    return {
      question: text(entry.question, `${path}[${index}].question`),
      impact: text(entry.impact, `${path}[${index}].impact`),
      priority: enumValue(entry.priority, `${path}[${index}].priority`, [...PRIORITY_VALUES]),
    };
  });
}

function normalizeStakeholders(value, path) {
  if (!Array.isArray(value) || value.length > 30) fail(path, "must be an array");
  return value.map((item, index) => {
    const entry = plainObject(item, `${path}[${index}]`);
    return {
      name: text(entry.name, `${path}[${index}].name`),
      title: text(entry.title, `${path}[${index}].title`, { nullable: true, max: 300 }),
      role: enumValue(entry.role, `${path}[${index}].role`, [...STAKEHOLDER_ROLES]),
      stance: enumValue(entry.stance, `${path}[${index}].stance`, [...STANCE_VALUES]),
      influence: enumValue(entry.influence, `${path}[${index}].influence`, [...INFLUENCE_VALUES]),
      confidence: integer(entry.confidence, `${path}[${index}].confidence`),
      evidence: text(entry.evidence, `${path}[${index}].evidence`),
    };
  });
}

function normalizeRisks(value, path) {
  if (!Array.isArray(value) || value.length > 30) fail(path, "must be an array");
  return value.map((item, index) => {
    const entry = plainObject(item, `${path}[${index}]`);
    return {
      id: text(entry.id, `${path}[${index}].id`, { max: 100 }),
      summary: text(entry.summary, `${path}[${index}].summary`),
      severity: enumValue(entry.severity, `${path}[${index}].severity`, [...SEVERITY_VALUES]),
      likelihood: enumValue(entry.likelihood, `${path}[${index}].likelihood`, [...SEVERITY_VALUES]),
      confidence: integer(entry.confidence, `${path}[${index}].confidence`),
      mitigation: text(entry.mitigation, `${path}[${index}].mitigation`),
    };
  });
}

function normalizeNextActions(value, path) {
  if (!Array.isArray(value) || value.length > 5) fail(path, "must be an array of at most five items");
  return value.map((item, index) => {
    const entry = plainObject(item, `${path}[${index}]`);
    return {
      priority: integer(entry.priority, `${path}[${index}].priority`, { min: 1, max: 5 }),
      action: text(entry.action, `${path}[${index}].action`),
      owner: text(entry.owner, `${path}[${index}].owner`, { max: 200 }),
      due: text(entry.due, `${path}[${index}].due`, { max: 100 }),
      targetStakeholders: textArray(entry.targetStakeholders, `${path}[${index}].targetStakeholders`, 10, 300),
      expectedOutcome: text(entry.expectedOutcome, `${path}[${index}].expectedOutcome`),
      completionEvidence: text(entry.completionEvidence, `${path}[${index}].completionEvidence`),
    };
  });
}

function normalizeScore(value, path) {
  const score = plainObject(value, path);
  if (!Array.isArray(score.dimensions) || score.dimensions.length === 0 || score.dimensions.length > 12) {
    fail(`${path}.dimensions`, "must be a non-empty bounded array");
  }
  const dimensions = score.dimensions.map((item, index) => {
    const entry = plainObject(item, `${path}.dimensions[${index}]`);
    const max = integer(entry.max, `${path}.dimensions[${index}].max`, { min: 1, max: 100 });
    const valueScore = integer(entry.score, `${path}.dimensions[${index}].score`, { min: 0, max });
    return {
      name: text(entry.name, `${path}.dimensions[${index}].name`, { max: 100 }),
      score: valueScore,
      max,
      reason: text(entry.reason, `${path}.dimensions[${index}].reason`),
    };
  });
  const declaredTotal = integer(score.total, `${path}.total`);
  const dimensionTotal = dimensions.reduce((sum, item) => sum + item.score, 0);
  return {
    total: Math.min(declaredTotal, dimensionTotal, 100),
    dimensions,
  };
}

export function normalizeSalesDecisionAnalysis(value, { source = null } = {}) {
  const input = plainObject(value, "root");
  if (input.schemaVersion !== SALES_DECISION_SCHEMA_VERSION) {
    fail("schemaVersion", `must equal ${SALES_DECISION_SCHEMA_VERSION}`);
  }
  const decision = plainObject(input.decision, "decision");
  const stage = plainObject(input.stage, "stage");
  const writebackPreview = plainObject(input.writebackPreview, "writebackPreview");
  const compliance = plainObject(input.compliance, "compliance");
  const normalizedFlags = textArray(compliance.flags, "compliance.flags", 20, 300);
  const normalizedComplianceStatus = enumValue(
    compliance.status,
    "compliance.status",
    [...COMPLIANCE_VALUES],
  );
  const requiresComplianceEscalation =
    normalizedComplianceStatus === "review_required" ||
    compliance.requiresEscalation === true ||
    normalizedFlags.length > 0;

  return {
    schemaVersion: SALES_DECISION_SCHEMA_VERSION,
    analysisType: enumValue(input.analysisType, "analysisType", SALES_DECISION_TYPES),
    headline: text(input.headline, "headline", { max: 1200 }),
    decision: {
      code: enumValue(decision.code, "decision.code", SALES_DECISION_CODES),
      confidence: integer(decision.confidence, "decision.confidence"),
      reason: text(decision.reason, "decision.reason"),
      counterEvidence: textArray(decision.counterEvidence, "decision.counterEvidence", 8),
      evidenceNeededToChange: textArray(decision.evidenceNeededToChange, "decision.evidenceNeededToChange", 8),
    },
    stage: {
      current: enumValue(stage.current, "stage.current", SALES_DECISION_STAGES),
      recommended: enumValue(stage.recommended, "stage.recommended", SALES_DECISION_STAGES),
      gatePassed: stage.gatePassed === true,
      missingGateEvidence: textArray(stage.missingGateEvidence, "stage.missingGateEvidence", 12),
    },
    score: normalizeScore(input.score, "score"),
    facts: normalizeFacts(input.facts, "facts"),
    inferences: normalizeInferences(input.inferences, "inferences"),
    unknowns: normalizeUnknowns(input.unknowns, "unknowns"),
    stakeholders: normalizeStakeholders(input.stakeholders, "stakeholders"),
    risks: normalizeRisks(input.risks, "risks"),
    nextActions: normalizeNextActions(input.nextActions, "nextActions"),
    suggestedQuestions: textArray(input.suggestedQuestions, "suggestedQuestions", 12),
    writebackPreview: {
      requiresHumanConfirmation: true,
      customerFields: textArray(writebackPreview.customerFields, "writebackPreview.customerFields", 20, 200),
      opportunityFields: textArray(writebackPreview.opportunityFields, "writebackPreview.opportunityFields", 20, 200),
      actions: textArray(writebackPreview.actions, "writebackPreview.actions", 20, 200),
      risks: textArray(writebackPreview.risks, "writebackPreview.risks", 20, 200),
    },
    compliance: {
      status: requiresComplianceEscalation ? "review_required" : "clear",
      flags: normalizedFlags,
      requiresEscalation: requiresComplianceEscalation,
    },
    source: String(source ?? input.source ?? "model").trim().slice(0, 100),
  };
}

export const SALES_DECISION_OUTPUT_SHAPE = Object.freeze({
  schemaVersion: SALES_DECISION_SCHEMA_VERSION,
  analysisType: "opportunity_diagnosis",
  headline: "一句话判断",
  decision: {
    code: "validate",
    confidence: 0,
    reason: "依据",
    counterEvidence: [],
    evidenceNeededToChange: [],
  },
  stage: {
    current: "initial_discovery",
    recommended: "initial_discovery",
    gatePassed: false,
    missingGateEvidence: [],
  },
  score: {
    total: 0,
    dimensions: [
      { name: "pain_and_impact", score: 0, max: 20, reason: "证据说明" },
      { name: "value_and_metrics", score: 0, max: 10, reason: "证据说明" },
      { name: "decision_chain", score: 0, max: 15, reason: "证据说明" },
      { name: "champion", score: 0, max: 10, reason: "证据说明" },
      { name: "decision_and_purchase_process", score: 0, max: 15, reason: "证据说明" },
      { name: "time_and_commitment", score: 0, max: 10, reason: "证据说明" },
      { name: "competition_and_differentiation", score: 0, max: 10, reason: "证据说明" },
      { name: "delivery_payment_compliance", score: 0, max: 10, reason: "证据说明" },
    ],
  },
  facts: [{
    claim: "已确认事实",
    sourceType: "customer",
    sourceId: null,
    occurredAt: null,
    confidence: 0,
  }],
  inferences: [{ claim: "推断", basis: ["事实依据"], confidence: 0 }],
  unknowns: [{ question: "待确认问题", impact: "对判断的影响", priority: "high" }],
  stakeholders: [{
    name: "上下文中已有姓名",
    title: null,
    role: "unknown",
    stance: "unknown",
    influence: "unknown",
    confidence: 0,
    evidence: "上下文证据",
  }],
  risks: [{
    id: "R1",
    summary: "风险说明",
    severity: "medium",
    likelihood: "medium",
    confidence: 0,
    mitigation: "验证或缓解动作",
  }],
  nextActions: [{
    priority: 1,
    action: "验证动作",
    owner: "销售负责人",
    due: "待确认",
    targetStakeholders: ["上下文中已有角色"],
    expectedOutcome: "预期结果",
    completionEvidence: "完成证据",
  }],
  suggestedQuestions: ["待确认问题"],
  writebackPreview: {
    requiresHumanConfirmation: true,
    customerFields: [],
    opportunityFields: [],
    actions: [],
    risks: [],
  },
  compliance: { status: "clear", flags: [], requiresEscalation: false },
});
