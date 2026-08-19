import { analyzeQuickRecord } from "../modelAnalysis.js";
import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "visit-capture";
const MAX_TEXT = 20_000;
const MAX_QUERY = 200;
const MAX_ITEMS = 20;
const MAX_SOURCE_REFS = 100;
const DATE_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const TASK_TYPES = new Set(["capture", "normalize", "preview", "link_candidates"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = MAX_TEXT) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssistantContractError(`${name} is required`, "invalid_visit_capture_input");
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new AssistantContractError(`${name} is too long`, "invalid_visit_capture_input");
  }
  return normalized;
}

function optionalText(value, name, max = MAX_TEXT) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, max);
}

function safeIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function boundedArray(value, name, max = MAX_ITEMS) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new AssistantContractError(`${name} must be a bounded array`, "invalid_visit_capture_input");
  }
  return value;
}

function validOccurredAt(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = text(value, "occurredAt", 100);
  if (!DATE_WITH_ZONE.test(normalized) || !Number.isFinite(Date.parse(normalized))) return null;
  return new Date(normalized).toISOString();
}

function compact(value, max = 800) {
  const normalized = String(value ?? "").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function sourceClass(source) {
  const value = String(source ?? "");
  if (value.includes("fallback") || value.startsWith("mock_")) return "fallback";
  if (value === "deepseek" || value === "model" || (value && value !== "mock")) return "model";
  if (value === "mock") return "mock";
  return "deterministic";
}

function sourceRef(type, id) {
  const normalizedType = safeIdentifier(type);
  const normalizedId = safeIdentifier(id);
  return normalizedType && normalizedId ? { type: normalizedType, id: normalizedId } : null;
}

function uniqueSourceRefs(refs) {
  const result = [];
  const seen = new Set();
  for (const item of refs) {
    const ref = sourceRef(item?.type, item?.id);
    if (!ref) continue;
    const key = `${ref.type}\u0000${ref.id}`;
    if (seen.has(key) || result.length >= MAX_SOURCE_REFS) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function normalizeContext(value) {
  if (!isPlainObject(value)) return { customerId: null, opportunityId: null };
  return {
    customerId: safeIdentifier(value.customerId ?? value.customer?.id),
    opportunityId: safeIdentifier(value.opportunityId ?? value.opportunity?.id),
  };
}

function candidateName(value) {
  if (!isPlainObject(value)) return null;
  return safeIdentifier(value.value ?? value.name);
}

function candidateId(value) {
  if (!isPlainObject(value)) return null;
  return safeIdentifier(value.id);
}

function matchSummary(value, fallbackTitle, fallbackText) {
  const item = isPlainObject(value) ? value : {};
  const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 300) : fallbackTitle;
  const body = typeof item.text === "string" && item.text.trim() ? item.text.trim().slice(0, 2_000) : fallbackText;
  return { title, text: body };
}

function normalizeLegacyAnalysis(rawContent, result) {
  const source = String(result?.source ?? "mock");
  const fallbackText = compact(rawContent, 2_000);
  const summary = {
    request: matchSummary(result?.summary?.request, "客户诉求", fallbackText || "待补充客户诉求。"),
    feedback: matchSummary(result?.summary?.feedback, "客户反馈", "客户反馈尚未形成可确认结论。"),
    risk: matchSummary(result?.summary?.risk, "风险点", "客户、商机或决策链信息仍需人工确认。"),
    action: matchSummary(result?.summary?.action, "建议动作", "先确认客户、商机和下一步责任人。"),
  };
  const normalizeMatch = (value, fallback) => {
    const item = isPlainObject(value) ? value : {};
    return {
      id: candidateId(item),
      value: candidateName(item) ?? fallback,
      meta: typeof item.meta === "string" && item.meta.trim() ? item.meta.trim().slice(0, 300) : "待确认",
      tone: typeof item.tone === "string" && item.tone.trim() ? item.tone.trim().slice(0, 50) : "blue",
    };
  };
  return {
    source,
    confidence: Number.isFinite(Number(result?.confidence)) ? Math.max(0, Math.min(100, Number(result.confidence))) : 50,
    customer: normalizeMatch(result?.customer, "待匹配客户"),
    opportunity: normalizeMatch(result?.opportunity, "待确认商机"),
    weekly: normalizeMatch(result?.weekly, "待确认时间"),
    summary,
  };
}

function minimalLegacyAnalysis(rawContent, source = "fallback") {
  return normalizeLegacyAnalysis(rawContent, {
    source,
    confidence: 0,
    customer: { value: "待匹配客户" },
    opportunity: { value: "待确认商机" },
    weekly: { value: "待确认时间" },
    summary: {},
  });
}

function entitySnapshot(entity, kind) {
  if (!entity || typeof entity !== "object") return null;
  const id = safeIdentifier(entity.id);
  if (!id) return null;
  return {
    id,
    name: compact(entity.name ?? entity.customer ?? entity.value, 300),
    customerId: safeIdentifier(entity.customerId),
    ...(kind === "customer" ? { region: compact(entity.region, 100) } : { stage: compact(entity.stage, 100) }),
  };
}

function safeLookup(adapter, kind, owner, id) {
  if (!adapter || !id) return null;
  const method = kind === "customer" ? adapter.customerDetail : adapter.opportunityDetail;
  if (typeof method !== "function") return null;
  try {
    return entitySnapshot(method.call(adapter, kind === "customer"
      ? { owner, customerId: id }
      : { owner, opportunityId: id }), kind);
  } catch {
    return null;
  }
}

function safeSearch(adapter, kind, owner, query) {
  if (!adapter || !query) return [];
  const method = kind === "customer" ? adapter.customerSearch : adapter.opportunitySearch;
  if (typeof method !== "function") return [];
  try {
    const result = method.call(adapter, { owner, query: query.slice(0, MAX_QUERY) });
    return boundedArray(result?.items, `${kind}Search.items`, 100)
      .map((item) => entitySnapshot(item, kind))
      .filter(Boolean)
      .slice(0, 100);
  } catch {
    return [];
  }
}

function candidateResult({ kind, owner, raw, contextId, adapter, fallback }) {
  const explicit = safeLookup(adapter, kind, owner, contextId);
  if (explicit) {
    return {
      status: "context_verified",
      id: explicit.id,
      name: explicit.name || candidateName(raw) || `已验证${kind === "customer" ? "客户" : "商机"}`,
      confidence: 100,
      requiresConfirmation: true,
      matches: [explicit],
      sourceRef: sourceRef(kind, explicit.id),
      reason: "来自服务端已验证会话上下文。",
    };
  }

  const rawId = candidateId(raw);
  const byId = safeLookup(adapter, kind, owner, rawId);
  if (byId) {
    return {
      status: "candidate",
      id: byId.id,
      name: byId.name || candidateName(raw) || "待确认",
      confidence: fallback ? Math.min(50, Number(raw?.confidence ?? 50)) : 70,
      requiresConfirmation: true,
      matches: [byId],
      sourceRef: sourceRef(kind, byId.id),
      reason: "候选由服务端 owner-scoped 查询验证，仍需本人确认。",
    };
  }

  const query = candidateName(raw);
  const matches = safeSearch(adapter, kind, owner, query ?? "");
  if (matches.length === 1) {
    const match = matches[0];
    return {
      status: "candidate",
      id: match.id,
      name: match.name || query || "待确认",
      confidence: fallback ? 40 : 60,
      requiresConfirmation: true,
      matches,
      sourceRef: sourceRef(kind, match.id),
      reason: "按名称得到唯一 owner-scoped 候选，仍需本人确认。",
    };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      id: null,
      name: query || "待确认",
      confidence: 0,
      requiresConfirmation: true,
      matches,
      sourceRef: null,
      reason: `找到多个${kind === "customer" ? "客户" : "商机"}候选。`,
    };
  }
  return {
    status: "unknown",
    id: null,
    name: query || `待匹配${kind === "customer" ? "客户" : "商机"}`,
    confidence: 0,
    requiresConfirmation: true,
    matches: [],
    sourceRef: null,
    reason: `没有找到可验证的${kind === "customer" ? "客户" : "商机"}候选。`,
  };
}

function fact(key, value, ref, confidence = 100) {
  return {
    key,
    value: compact(value, 2_000),
    sourceType: ref?.type ?? "visit_capture_input",
    sourceId: ref?.id ?? "unverified-input",
    confidence,
  };
}

function inference(claim, basis, confidence, source = "model") {
  return {
    claim: compact(claim, 2_000),
    basis: compact(basis, 1_000),
    confidence: Math.max(0, Math.min(100, Number(confidence) || 0)),
    source,
  };
}

function unknown(key, question, reason) {
  return { key, question: compact(question, 500), reason: compact(reason, 800) };
}

function proposal(type, summaryItem, refs) {
  const textValue = summaryItem?.text ?? "";
  return {
    type,
    title: summaryItem?.title ?? (type === "action" ? "待确认行动" : "待确认风险"),
    text: compact(textValue, 1_500),
    status: "proposed",
    requiresConfirmation: true,
    sourceRefs: refs,
  };
}

function buildTextFacts({ legacy, customerCandidate, opportunityCandidate, occurredAt, sourceChannel, refs }) {
  const facts = [];
  if (customerCandidate?.id) facts.push(fact("customer_candidate", customerCandidate.name, sourceRef("customer", customerCandidate.id), customerCandidate.confidence));
  if (opportunityCandidate?.id) facts.push(fact("opportunity_candidate", opportunityCandidate.name, sourceRef("opportunity", opportunityCandidate.id), opportunityCandidate.confidence));
  if (occurredAt) facts.push(fact("occurred_at", occurredAt, sourceRef("visit_capture_input", "occurred-at"), 100));
  if (sourceChannel) facts.push(fact("source_channel", sourceChannel, sourceRef("visit_capture_input", "source-channel"), 100));
  if (facts.length === 0 && refs.length > 0) facts.push(fact("verified_context", "服务端已验证上下文存在。", refs[0], 100));
  return facts;
}

function buildOutput({
  rawContent,
  occurredAt,
  sourceChannel,
  draftId,
  taskType,
  context,
  legacy,
  customerCandidate,
  opportunityCandidate,
  source,
}) {
  const fallback = sourceClass(source) === "fallback";
  const refs = uniqueSourceRefs([
    sourceRef("quick_record_draft", draftId),
    customerCandidate?.sourceRef,
    opportunityCandidate?.sourceRef,
  ]);
  const inferences = [
    inference(legacy.summary.request.text, "快速记录文本的结构化提炼，尚未作为客户或商机事实写回。", fallback ? 35 : 65, fallback ? "deterministic" : "model"),
    inference(legacy.summary.feedback.text, "快速记录文本的结构化提炼，需人工核对原话。", fallback ? 30 : 60, fallback ? "deterministic" : "model"),
  ];
  const unknowns = [];
  if (["unknown", "ambiguous", "conflict"].includes(customerCandidate.status)) {
    unknowns.push(unknown("customer", "请确认这条记录对应的客户。", customerCandidate.reason));
  }
  if (["unknown", "ambiguous", "conflict"].includes(opportunityCandidate.status)) {
    unknowns.push(unknown("opportunity", "请确认这条记录对应的商机，或说明暂不关联商机。", opportunityCandidate.reason));
  }
  if (!occurredAt) unknowns.push(unknown("occurredAt", "请确认拜访、电话或会议发生时间。", "输入没有提供带时区的发生时间。"));
  unknowns.push(unknown("writeback_targets", "请确认是否只创建快速记录，以及是否稍后人工关联客户、商机和行动。", "候选链接和行动风险均不是自动写回结果。"));

  const actions = [proposal("action", legacy.summary.action, refs)];
  const risks = [proposal("risk", legacy.summary.risk, refs)];
  const status = fallback
    ? "fallback"
    : (unknowns.some((item) => ["customer", "opportunity"].includes(item.key)) ? "review_required" : taskType === "capture" ? "drafted" : "preview");
  const writebackPreview = {
    requiresHumanConfirmation: true,
    creates: ["quick_record"],
    customerId: null,
    opportunityId: null,
    customerFields: [],
    opportunityFields: [],
    actions: [],
    risks: [],
    note: "只允许在本人确认后创建快速记录；不会自动写客户、商机、行动或风险。",
  };
  const safeMatch = (legacyMatch, candidate, fallbackLabel) => ({
    ...legacyMatch,
    id: candidate?.id ?? null,
    value: candidate?.id && candidate?.status !== "ambiguous" && candidate?.status !== "unknown"
      ? candidate.name
      : fallbackLabel,
    meta: candidate?.id
      ? `${candidate.status === "context_verified" ? "服务端上下文已验证" : "服务端候选，待本人确认"}`
      : "待确认",
  });

  return {
    schemaVersion: "visit-capture-v1",
    agentId: AGENT_ID,
    status,
    taskType,
    draftId: safeIdentifier(draftId),
    rawContent,
    occurredAt,
    sourceChannel,
    context: {
      customerId: context.customerId,
      opportunityId: context.opportunityId,
    },
    source,
    confidence: legacy.confidence,
    customer: safeMatch(legacy.customer, customerCandidate, "待匹配客户"),
    opportunity: safeMatch(legacy.opportunity, opportunityCandidate, "待确认商机"),
    weekly: legacy.weekly,
    summary: legacy.summary,
    customerCandidate,
    opportunityCandidate,
    facts: buildTextFacts({ legacy, customerCandidate, opportunityCandidate, occurredAt, sourceChannel, refs }),
    inferences,
    unknowns,
    actions,
    risks,
    sourceRefs: refs,
    writebackPreview,
    writebackAllowed: false,
  };
}

function storedResult(run) {
  if (!run?.output || !isPlainObject(run.output)) return null;
  return {
    ...run.output,
    runId: run.id,
    inputSnapshotHash: run.inputSnapshotHash,
    persistedSource: run.source,
    replayed: true,
  };
}

export function createVisitCaptureAssistantAdapter({
  config = {},
  fetchImpl = fetch,
  runRepository = null,
  businessSnapshotAdapter = null,
  clock = () => new Date(),
} = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("visit-capture manifest is unavailable");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "preview",
    rawContent,
    occurredAt = null,
    sourceChannel = "assistant",
    draftId = null,
    businessContext = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    const normalizedContent = text(rawContent, "rawContent", MAX_TEXT);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for visit-capture", "invalid_visit_capture_input");
    }
    const normalizedOccurredAt = validOccurredAt(occurredAt);
    const normalizedSourceChannel = optionalText(sourceChannel, "sourceChannel", 100) ?? "assistant";
    const normalizedDraftId = safeIdentifier(draftId);
    const context = normalizeContext(businessContext);
    const inputSnapshot = {
      rawContent: normalizedContent,
      occurredAt: normalizedOccurredAt,
      sourceChannel: normalizedSourceChannel,
      draftId: normalizedDraftId,
      taskType,
      context,
    };

    let run = null;
    if (runRepository) {
      run = runRepository.create({
        owner: normalizedOwner,
        channel,
        conversationId,
        eventId,
        agentId: AGENT_ID,
        agentVersion: manifest.version,
        taskType,
        contractVersion: manifest.contractVersion,
        input: inputSnapshot,
      });
      const replay = storedResult(run.item);
      if (run.replayed && replay) return replay;
    }

    try {
      let modelResult;
      try {
        modelResult = await analyzeQuickRecord(normalizedContent, config, { fetchImpl });
      } catch {
        modelResult = null;
      }
      const legacy = modelResult
        ? normalizeLegacyAnalysis(normalizedContent, modelResult)
        : minimalLegacyAnalysis(normalizedContent, "fallback");
      const source = legacy.source || "fallback";
      const fallback = sourceClass(source) === "fallback";
      const customerCandidate = candidateResult({
        kind: "customer",
        owner: normalizedOwner,
        raw: legacy.customer,
        contextId: context.customerId,
        adapter: businessSnapshotAdapter,
        fallback,
      });
      const opportunityCandidate = candidateResult({
        kind: "opportunity",
        owner: normalizedOwner,
        raw: legacy.opportunity,
        contextId: context.opportunityId,
        adapter: businessSnapshotAdapter,
        fallback,
      });
      if (
        customerCandidate.id
        && opportunityCandidate.id
        && opportunityCandidate.matches?.[0]?.customerId
        && opportunityCandidate.matches[0].customerId !== customerCandidate.id
      ) {
        opportunityCandidate.status = "conflict";
        opportunityCandidate.id = null;
        opportunityCandidate.sourceRef = null;
        opportunityCandidate.reason = "客户与商机的服务端关联不一致。";
      }
      const output = buildOutput({
        rawContent: normalizedContent,
        occurredAt: normalizedOccurredAt,
        sourceChannel: normalizedSourceChannel,
        draftId: normalizedDraftId,
        taskType,
        context,
        legacy,
        customerCandidate,
        opportunityCandidate,
        source,
      });
      if (runRepository && run?.item) {
        const persistedSource = sourceClass(source);
        run = runRepository.complete(run.item.id, {
          owner: normalizedOwner,
          output,
          source: persistedSource,
          modelProvider: config.modelProvider ?? null,
          modelName: config.modelName ?? null,
          fallbackReason: persistedSource === "fallback" ? source : null,
          sourceRefs: output.sourceRefs,
          confirmationStatus: "preview",
        });
      }
      return {
        ...output,
        agentVersion: manifest.version,
        contractVersion: manifest.contractVersion,
        runId: run?.item?.id ?? null,
        inputSnapshotHash: run?.item?.inputSnapshotHash ?? null,
        persistedSource: run?.item?.source ?? sourceClass(source),
      };
    } catch (error) {
      if (runRepository && run?.item) {
        try {
          runRepository.fail(run.item.id, {
            owner: normalizedOwner,
            errorCode: "VISIT_CAPTURE_ADAPTER_FAILED",
          });
        } catch {
          // Preserve the original error and fail closed.
        }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze });
}

export { buildOutput as buildVisitCaptureOutput, minimalLegacyAnalysis };
