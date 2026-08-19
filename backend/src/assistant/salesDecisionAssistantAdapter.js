import { analyzeSalesDecision, buildSalesDecisionInputSnapshot } from "../ai/agents/salesDecisionAgent.js";
import { SALES_DECISION_TYPES } from "../ai/agents/salesDecisionSchema.js";
import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "sales-decision";
const MAX_TEXT = 5000;
const MAX_SOURCE_REFS = 100;
const DATE_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = MAX_TEXT) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssistantContractError(name + " is required", "invalid_sales_decision_input");
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new AssistantContractError(name + " is too long", "invalid_sales_decision_input");
  }
  return normalized;
}

function optionalText(value, name, max = MAX_TEXT) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, max);
}

function identifier(value, name) {
  const normalized = optionalText(value, name, 200);
  if (normalized && /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new AssistantContractError(name + " contains control characters", "invalid_sales_decision_input");
  }
  return normalized;
}

function boundedArray(value, name, max = 100) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new AssistantContractError(name + " must be a bounded array", "invalid_sales_decision_input");
  }
  return value;
}

function validAnalysisAt(value) {
  const normalized = text(value, "analysisAt", 100);
  if (!DATE_WITH_ZONE.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new AssistantContractError("analysisAt must include a timezone", "invalid_sales_decision_input");
  }
  return new Date(normalized).toISOString();
}

function sourceRef(type, id) {
  const normalizedId = identifier(id, "sourceRef.id");
  if (!normalizedId) return null;
  return { type: text(type, "sourceRef.type", 80), id: normalizedId };
}

function collectSourceRefs(snapshot) {
  const refs = [];
  const add = (type, id) => {
    const ref = sourceRef(type, id);
    if (!ref || refs.some((item) => item.type === ref.type && item.id === ref.id)) return;
    if (refs.length < MAX_SOURCE_REFS) refs.push(ref);
  };
  for (const item of boundedArray(snapshot.sourceRefs, "sourceRefs")) {
    if (isPlainObject(item)) add(item.type, item.id);
  }
  add("customer", snapshot.customer?.id);
  add("opportunity", snapshot.opportunity?.id);
  add("quick_record", snapshot.quickRecord?.id);
  for (const item of boundedArray(snapshot.quickRecords, "quickRecords")) add("quick_record", item?.id);
  for (const item of boundedArray(snapshot.actions, "actions")) add("action", item?.id);
  for (const item of boundedArray(snapshot.risks, "risks")) add("risk", item?.id);
  for (const item of boundedArray(snapshot.knowledge, "knowledge", 20)) add("knowledge", item?.id);
  return refs;
}

function normalizeCustomer(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new AssistantContractError("customer must be an object", "invalid_sales_decision_input");
  return {
    id: identifier(value.id, "customer.id"),
    name: optionalText(value.name, "customer.name", 300) ?? "",
    type: optionalText(value.type, "customer.type", 100) ?? "",
    budget: optionalText(value.budget, "customer.budget", 300) ?? "",
    summary: optionalText(value.summary, "customer.summary", 1200) ?? "",
    needs: boundedArray(value.needs, "customer.needs", 30).map((item) => text(item, "customer.needs[]", 500)),
    risks: boundedArray(value.risks, "customer.risks", 30).map((item) => text(item, "customer.risks[]", 500)),
    stakeholders: boundedArray(value.stakeholders, "customer.stakeholders", 20).map((item) => isPlainObject(item) ? {
      name: optionalText(item.name, "customer.stakeholders[].name", 300) ?? "",
      title: optionalText(item.title, "customer.stakeholders[].title", 300),
      role: optionalText(item.role, "customer.stakeholders[].role", 100) ?? "unknown",
      stance: optionalText(item.stance, "customer.stakeholders[].stance", 50) ?? "unknown",
      influence: optionalText(item.influence, "customer.stakeholders[].influence", 50) ?? "unknown",
      confidence: Number.isSafeInteger(item.confidence) ? item.confidence : 40,
      evidence: optionalText(item.evidence, "customer.stakeholders[].evidence", 800) ?? "",
    } : { name: text(item, "customer.stakeholders[]", 300) }),
    decisionChain: boundedArray(value.decisionChain, "customer.decisionChain", 30).map((item) => text(item, "customer.decisionChain[]", 500)),
  };
}

function normalizeOpportunity(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new AssistantContractError("opportunity must be an object", "invalid_sales_decision_input");
  return {
    id: identifier(value.id, "opportunity.id"),
    customerId: identifier(value.customerId, "opportunity.customerId"),
    name: optionalText(value.name, "opportunity.name", 300) ?? "",
    stage: optionalText(value.stage, "opportunity.stage", 100) ?? "",
    amount: optionalText(value.amount, "opportunity.amount", 100) ?? "",
    requirements: boundedArray(value.requirements, "opportunity.requirements", 30).map((item) => text(item, "opportunity.requirements[]", 500)),
    competitors: boundedArray(value.competitors, "opportunity.competitors", 30).map((item) => text(item, "opportunity.competitors[]", 500)),
    solutionDirection: boundedArray(value.solutionDirection, "opportunity.solutionDirection", 30).map((item) => text(item, "opportunity.solutionDirection[]", 500)),
    risk: optionalText(value.risk, "opportunity.risk", 1200) ?? "",
    next: optionalText(value.next, "opportunity.next", 1200) ?? "",
    sourceRecord: optionalText(value.sourceRecord, "opportunity.sourceRecord", 1800) ?? "",
  };
}

function normalizeQuickRecord(value, name = "quickRecord") {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new AssistantContractError(name + " must be an object", "invalid_sales_decision_input");
  return {
    id: identifier(value.id, name + ".id"),
    rawContent: optionalText(value.rawContent, name + ".rawContent", 5000) ?? "",
    occurredAt: optionalText(value.occurredAt, name + ".occurredAt", 100),
    sourceChannel: optionalText(value.sourceChannel, name + ".sourceChannel", 100) ?? "",
  };
}

function normalizeContext(snapshot, { analysisType, industry, analysisAt }) {
  if (!isPlainObject(snapshot)) {
    throw new AssistantContractError("businessSnapshot must be a plain object", "invalid_sales_decision_input");
  }
  const customer = normalizeCustomer(snapshot.customer);
  const opportunity = normalizeOpportunity(snapshot.opportunity);
  if (analysisType === "opportunity_diagnosis" && !opportunity) {
    throw new AssistantContractError("opportunity evidence is required", "missing_sales_decision_evidence");
  }
  if (analysisType === "customer_analysis" && !customer) {
    throw new AssistantContractError("customer evidence is required", "missing_sales_decision_evidence");
  }
  if (["meeting_preparation", "next_step_decision"].includes(analysisType) && !customer && !opportunity) {
    throw new AssistantContractError("customer or opportunity evidence is required", "missing_sales_decision_evidence");
  }
  if (customer && opportunity && opportunity.customerId && customer.id && opportunity.customerId !== customer.id) {
    throw new AssistantContractError("customer and opportunity relationship is inconsistent", "relationship_conflict");
  }
  const quickRecord = normalizeQuickRecord(snapshot.quickRecord);
  const rawContent = optionalText(snapshot.rawContent, "rawContent", 5000) ?? quickRecord?.rawContent ?? "";
  const actions = boundedArray(snapshot.actions, "actions", 20).map((item) => isPlainObject(item) ? {
    id: identifier(item.id, "actions[].id"),
    title: optionalText(item.title ?? item.action ?? item.name, "actions[].title", 400) ?? "",
    due: optionalText(item.due, "actions[].due", 100) ?? "",
    status: optionalText(item.status, "actions[].status", 50) ?? "",
    assignee: optionalText(item.assignee, "actions[].assignee", 100) ?? "",
  } : { title: text(item, "actions[]", 400) });
  const risks = boundedArray(snapshot.risks, "risks", 20).map((item) => isPlainObject(item) ? {
    id: identifier(item.id, "risks[].id"),
    title: optionalText(item.title ?? item.summary, "risks[].title", 400) ?? "",
    severity: optionalText(item.severity, "risks[].severity", 50) ?? "",
    status: optionalText(item.status, "risks[].status", 50) ?? "",
    evidence: optionalText(item.evidence ?? item.description, "risks[].evidence", 800) ?? "",
  } : { title: text(item, "risks[]", 400) });
  const knowledge = boundedArray(snapshot.knowledge, "knowledge", 8).map((item) => isPlainObject(item) ? {
    id: identifier(item.id, "knowledge[].id"),
    title: optionalText(item.title, "knowledge[].title", 300) ?? "",
    summary: optionalText(item.summary, "knowledge[].summary", 800) ?? "",
  } : { title: text(item, "knowledge[]", 300), summary: "" });
  const context = {
    analysisType,
    industry: optionalText(industry, "industry", 100) ?? "general",
    rawContent,
    customer,
    opportunity,
    quickRecord,
    actions,
    risks,
    knowledge,
  };
  const normalized = buildSalesDecisionInputSnapshot(context);
  return {
    context: normalized,
    inputSnapshot: {
      ...normalized,
      analysisAt,
      sourceRefs: collectSourceRefs({ ...snapshot, customer, opportunity, quickRecord, actions, risks, knowledge }),
    },
  };
}

function sourceClass(source) {
  const value = String(source ?? "");
  if (value.includes("fallback")) return "fallback";
  if (value === "deepseek" || value === "model") return "model";
  if (value === "mock") return "mock";
  return "deterministic";
}

function outputSourceRefs(result, inputRefs) {
  const refs = [...inputRefs];
  const known = new Set(inputRefs.map((item) => `${item.type}\u0000${item.id}`));
  const add = (type, id) => {
    if (!id || !known.has(`${type}\u0000${id}`) || refs.some((item) => item.type === type && item.id === id) || refs.length >= MAX_SOURCE_REFS) return;
    refs.push({ type, id });
  };
  for (const item of result?.facts ?? []) add(item.sourceType, item.sourceId);
  return refs;
}

export function createSalesDecisionAssistantAdapter({
  config = {},
  fetchImpl = fetch,
  runRepository = null,
  clock = () => new Date(),
} = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("sales-decision manifest is unavailable");

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    analysisType = "opportunity_diagnosis",
    industry = "general",
    analysisAt = new Date(clock()).toISOString(),
    businessSnapshot,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!SALES_DECISION_TYPES.includes(analysisType)) {
      throw new AssistantContractError("analysisType is invalid", "invalid_sales_decision_input");
    }
    const normalizedAnalysisAt = validAnalysisAt(analysisAt);
    const prepared = normalizeContext(businessSnapshot, {
      analysisType,
      industry,
      analysisAt: normalizedAnalysisAt,
    });
    const refs = prepared.inputSnapshot.sourceRefs;
    let run = null;
    if (runRepository) {
      run = runRepository.create({
        owner: normalizedOwner,
        channel,
        conversationId,
        eventId,
        agentId: AGENT_ID,
        agentVersion: manifest.version,
        taskType: analysisType,
        contractVersion: manifest.contractVersion,
        input: prepared.inputSnapshot,
      });
    }
    try {
      const result = await analyzeSalesDecision(prepared.context, config, { fetchImpl });
      const persistedRefs = outputSourceRefs(result, refs);
      const source = sourceClass(result?.source);
      const fallbackReason = source === "fallback" ? String(result?.source ?? "fallback") : null;
      if (runRepository && run?.item) {
        run = runRepository.complete(run.item.id, {
          owner: normalizedOwner,
          output: result,
          source,
          modelProvider: config.modelProvider ?? null,
          modelName: config.modelName ?? null,
          fallbackReason,
          sourceRefs: persistedRefs,
          confirmationStatus: "preview",
        });
      }
      return {
        status: "preview",
        agentId: AGENT_ID,
        agentVersion: manifest.version,
        taskType: analysisType,
        contractVersion: manifest.contractVersion,
        runId: run?.item?.id ?? null,
        source: result?.source ?? source,
        inputSnapshotHash: run?.item?.inputSnapshotHash ?? null,
        sourceRefs: persistedRefs,
        writebackAllowed: false,
        analysis: result,
      };
    } catch (error) {
      if (runRepository && run?.item) {
        try {
          runRepository.fail(run.item.id, {
            owner: normalizedOwner,
            errorCode: "SALES_DECISION_ADAPTER_FAILED",
          });
        } catch {
          // Preserve the safe outward error.
        }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze });
}
