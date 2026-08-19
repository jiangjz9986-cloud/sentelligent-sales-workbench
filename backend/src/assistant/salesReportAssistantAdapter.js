import { composeWeeklyDraftWithModel } from "../modelAnalysis.js";
import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "sales-report";
const CONTRACT_VERSION = "sales-report-v1";
const MAX_ITEMS = 100;
const MAX_TEXT = 20_000;
const MAX_SOURCE_REFS = 100;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const TASK_TYPES = new Set(["weekly_preview", "meeting_digest", "source_review", "save_preview"]);
const FALSE_EXECUTION_CLAIM = /(?:已|已经)(?:保存|发布|提交|写入)(?:周报|报告|系统|业务)?/u;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssistantContractError(`${name} is required`, "invalid_sales_report_input");
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new AssistantContractError(`${name} is too long`, "invalid_sales_report_input");
  }
  return normalized;
}

function optionalText(value, name, max = 5000) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, max);
}

function identifier(value, name = "id") {
  const normalized = optionalText(value, name, 200);
  if (!normalized) return null;
  if (!/^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(normalized) || normalized.startsWith("synthetic:")) {
    throw new AssistantContractError(`${name} is invalid`, "invalid_sales_report_input");
  }
  return normalized;
}

function dateOnly(value, name) {
  const normalized = text(value, name, 10);
  if (!DATE_ONLY.test(normalized)) throw new AssistantContractError(`${name} is invalid`, "invalid_sales_report_input");
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new AssistantContractError(`${name} is invalid`, "invalid_sales_report_input");
  }
  return normalized;
}

function multiline(value, name = "content", max = MAX_TEXT) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
    if (name === "content") return "";
    throw new AssistantContractError(`${name} is invalid`, "invalid_sales_report_input");
  }
  return normalized;
}

function boundedArray(value, name, max = MAX_ITEMS) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new AssistantContractError(`${name} must be a bounded array`, "invalid_sales_report_input");
  }
  return value;
}

function sourceRef(type, id) {
  const normalizedType = identifier(type, "sourceRef.type");
  const normalizedId = identifier(id, "sourceRef.id");
  return normalizedType && normalizedId ? { type: normalizedType, id: normalizedId } : null;
}

function uniqueRefs(refs) {
  const result = [];
  const seen = new Set();
  for (const item of refs) {
    if (!item) continue;
    const ref = sourceRef(item.type, item.id);
    if (!ref) continue;
    const key = `${ref.type}\u0000${ref.id}`;
    if (seen.has(key) || result.length >= MAX_SOURCE_REFS) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizePeriod(value) {
  if (!isPlainObject(value)) {
    throw new AssistantContractError("period must be an object", "invalid_sales_report_input");
  }
  const start = dateOnly(value.start ?? value.periodStart, "period.start");
  const end = dateOnly(value.end ?? value.periodEnd, "period.end");
  if (start > end) throw new AssistantContractError("period is reversed", "invalid_sales_report_input");
  return { start, end };
}

function normalizeAnalysis(value) {
  if (!isPlainObject(value)) return {};
  const match = (item) => isPlainObject(item)
    ? {
      id: identifier(item.id, "analysis.id"),
      value: optionalText(item.value, "analysis.value", 500),
    }
    : null;
  const summaryItem = (item) => isPlainObject(item)
    ? {
      title: optionalText(item.title, "analysis.summary.title", 300),
      text: optionalText(item.text, "analysis.summary.text", 2_000),
    }
    : null;
  return {
    customer: match(value.customer),
    opportunity: match(value.opportunity),
    summary: {
      action: summaryItem(value.summary?.action),
      risk: summaryItem(value.summary?.risk),
      request: summaryItem(value.summary?.request),
      feedback: summaryItem(value.summary?.feedback),
    },
  };
}

function normalizeRecord(value, index) {
  if (!isPlainObject(value)) throw new AssistantContractError(`sourceRecords[${index}] is invalid`, "invalid_sales_report_input");
  const id = identifier(value.id, `sourceRecords[${index}].id`);
  if (!id) throw new AssistantContractError(`sourceRecords[${index}].id is required`, "invalid_sales_report_input");
  return {
    id,
    rawContent: multiline(value.rawContent, `sourceRecords[${index}].rawContent`, 5_000),
    occurredAt: optionalText(value.occurredAt, `sourceRecords[${index}].occurredAt`, 100),
    sourceChannel: optionalText(value.sourceChannel, `sourceRecords[${index}].sourceChannel`, 100) ?? "manual",
    analysis: normalizeAnalysis(value.analysis),
  };
}

function normalizeKnowledge(value, index) {
  if (!isPlainObject(value)) throw new AssistantContractError(`knowledge[${index}] is invalid`, "invalid_sales_report_input");
  const id = identifier(value.id, `knowledge[${index}].id`);
  if (!id) throw new AssistantContractError(`knowledge[${index}].id is required`, "invalid_sales_report_input");
  return {
    id,
    title: optionalText(value.title, `knowledge[${index}].title`, 300) ?? "未命名知识",
    summary: multiline(value.summary, `knowledge[${index}].summary`, 1_200),
  };
}

function normalizeReport(value, index) {
  if (!isPlainObject(value)) throw new AssistantContractError(`reports[${index}] is invalid`, "invalid_sales_report_input");
  const id = identifier(value.id, `reports[${index}].id`);
  if (!id) throw new AssistantContractError(`reports[${index}].id is required`, "invalid_sales_report_input");
  return {
    id,
    status: optionalText(value.status, `reports[${index}].status`, 50) ?? "unknown",
    periodStart: optionalText(value.periodStart, `reports[${index}].periodStart`, 10),
    periodEnd: optionalText(value.periodEnd, `reports[${index}].periodEnd`, 10),
  };
}

function deterministicItems(records) {
  const customerUpdates = [];
  const opportunityUpdates = [];
  const actions = [];
  const risks = [];
  const facts = [];
  const inferences = [];
  const refs = [];
  for (const record of records) {
    const ref = sourceRef("quick_record", record.id);
    if (ref) refs.push(ref);
    const analysis = record.analysis;
    const customer = analysis.customer?.value;
    const opportunity = analysis.opportunity?.value;
    if (customer) customerUpdates.push({ text: customer, sourceRefs: ref ? [ref] : [] });
    if (opportunity) opportunityUpdates.push({ text: opportunity, sourceRefs: ref ? [ref] : [] });
    if (analysis.summary.request?.text || analysis.summary.feedback?.text) {
      facts.push({
        text: [analysis.summary.request?.text, analysis.summary.feedback?.text].filter(Boolean).join("；"),
        sourceRefs: ref ? [ref] : [],
      });
    }
    if (analysis.summary.action?.text) {
      actions.push({ text: analysis.summary.action.text, status: "proposed", sourceRefs: ref ? [ref] : [] });
    }
    if (analysis.summary.risk?.text) {
      risks.push({ text: analysis.summary.risk.text, status: "open", sourceRefs: ref ? [ref] : [] });
    }
    if (customer || opportunity) {
      inferences.push({
        text: `${customer ?? "待确认客户"}${opportunity ? ` / ${opportunity}` : ""}出现在已确认记录中，具体推进状态仍以业务档案为准。`,
        sourceRefs: ref ? [ref] : [],
      });
    }
  }
  return { customerUpdates, opportunityUpdates, actions, risks, facts, inferences, refs };
}

function preparationFrom(snapshot, records) {
  const blockers = Array.isArray(snapshot.preparation?.blockers)
    ? snapshot.preparation.blockers.map((item) => String(item)).filter(Boolean).slice(0, 20)
    : [];
  if (records.length === 0 && !blockers.includes("no_confirmed_records")) blockers.push("no_confirmed_records");
  if (snapshot.truncated === true && !blockers.includes("truncated")) blockers.push("truncated");
  return { ready: blockers.length === 0, blockers };
}

function normalizeSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) throw new AssistantContractError("sales report snapshot is invalid", "invalid_sales_report_input");
  if (snapshot.status && snapshot.status !== "ok") return { status: snapshot.status, snapshot };
  const period = normalizePeriod(snapshot.period ?? { start: snapshot.weekStart, end: snapshot.periodEnd });
  const records = boundedArray(snapshot.sourceRecords, "sourceRecords").map(normalizeRecord);
  const knowledge = boundedArray(snapshot.knowledge, "knowledge", 20).map(normalizeKnowledge);
  const reports = boundedArray(snapshot.reports, "reports").map(normalizeReport);
  const items = deterministicItems(records);
  const refs = uniqueRefs([
    ...items.refs,
    ...knowledge.map((item) => sourceRef("knowledge", item.id)),
    ...reports.map((item) => sourceRef("weekly_report", item.id)),
  ]);
  const preparation = preparationFrom(snapshot, records);
  const fallbackDraft = isPlainObject(snapshot.deterministicDraft)
    ? {
      content: multiline(snapshot.deterministicDraft.content, "deterministicDraft.content", MAX_TEXT),
      sourceRefs: refs,
    }
    : { content: "", sourceRefs: refs };
  return {
    status: "ok",
    period,
    asOf: optionalText(snapshot.asOf, "asOf", 100) ?? new Date().toISOString(),
    records,
    knowledge,
    reports,
    candidateRecordCount: safeCount(snapshot.candidateRecordCount),
    statusCounts: isPlainObject(snapshot.statusCounts) ? {
      draft: safeCount(snapshot.statusCounts.draft),
      saved: safeCount(snapshot.statusCounts.saved),
      ready: safeCount(snapshot.statusCounts.ready),
    } : { draft: 0, saved: 0, ready: 0 },
    preparation,
    fallbackDraft,
    sourceRefs: refs,
    items,
  };
}

function outputSummary(snapshot, content, sourceRefs, source, runId) {
  return {
    persisted: false,
    content: multiline(content, "content", MAX_TEXT),
    sourceRecordCount: snapshot.records.length,
    sourceRefs,
    truncated: snapshot.preparation.blockers.includes("truncated"),
    preparation: snapshot.preparation,
    source,
    ...(runId ? { runId } : {}),
  };
}

function hasUnknownCitation(content, sourceRefs) {
  const known = new Set(sourceRefs.map((item) => `${item.type}\u0000${item.id}`));
  const pattern = /\[来源[:：]\s*([\u4e00-\u9fffA-Za-z0-9_.-]+)[/:]([\u4e00-\u9fffA-Za-z0-9_.:-]+)\]/gu;
  for (const match of content.matchAll(pattern)) {
    if (!known.has(`${match[1]}\u0000${match[2]}`)) return true;
  }
  return false;
}

function guardedComposition(composed, fallbackDraft, sourceRefs) {
  const source = String(composed?.source ?? "deterministic");
  const candidate = multiline(composed?.content, "content", MAX_TEXT);
  if (candidate && !FALSE_EXECUTION_CLAIM.test(candidate) && !hasUnknownCitation(candidate, sourceRefs)) {
    return { ...composed, content: candidate, source };
  }
  const fallbackContent = multiline(fallbackDraft?.content, "content", MAX_TEXT);
  return {
    ...fallbackDraft,
    content: fallbackContent,
    source: source === "deterministic" ? "deterministic" : "fallback",
    fallbackReason: !candidate
      ? "weekly_draft_invalid_model_output"
      : FALSE_EXECUTION_CLAIM.test(candidate)
        ? "weekly_draft_false_execution_claim"
        : "weekly_draft_unknown_source_reference",
  };
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return {
    ...item.output,
    runId: item.id,
    inputSnapshotHash: item.inputSnapshotHash,
    replayed: true,
  };
}

export function createSalesReportAssistantAdapter({
  snapshotProvider = null,
  previewService = null,
  salesLoopPreviewService = null,
  config = {},
  fetchImpl = fetch,
  runRepository = null,
  clock = () => new Date(),
} = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("sales-report manifest is unavailable");
  const provider = typeof snapshotProvider === "function"
    ? snapshotProvider
    : (previewService ?? salesLoopPreviewService)?.buildSalesReportSnapshot
      ? ({ owner, weekStart, knowledgeQuery, taskType }) => (previewService ?? salesLoopPreviewService).buildSalesReportSnapshot({ owner, weekStart, knowledgeQuery, taskType })
      : null;
  if (typeof provider !== "function") throw new TypeError("snapshotProvider is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "weekly_preview",
    weekStart = "current",
    periodStart = null,
    periodEnd = null,
    knowledgeQuery = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for sales-report", "invalid_sales_report_input");
    }
    const rawSnapshot = await provider({
      owner: normalizedOwner,
      weekStart: periodStart ?? weekStart,
      periodStart,
      periodEnd,
      knowledgeQuery,
      taskType,
    });
    const snapshot = normalizeSnapshot(rawSnapshot);
    if (snapshot.status !== "ok") {
      return {
        schemaVersion: CONTRACT_VERSION,
        agentId: AGENT_ID,
        agentVersion: manifest.version,
        contractVersion: manifest.contractVersion,
        status: snapshot.status === "owner_scope_denied" ? "not_found" : "review_required",
        period: rawSnapshot.period ?? null,
        facts: [],
        inferences: [],
        unknowns: [{ key: "snapshot", question: "无法读取当前账号的销售周报数据。", reason: "owner_scope_denied" }],
        sourceRefs: [],
        writebackPreview: { requiresHumanConfirmation: true, save: false, publish: false },
        writebackAllowed: false,
      };
    }

    const inputSnapshot = {
      taskType,
      period: snapshot.period,
      sourceRecords: snapshot.records,
      knowledge: snapshot.knowledge,
      existingReports: snapshot.reports,
      sourceRefs: snapshot.sourceRefs,
      preparation: snapshot.preparation,
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
      const replay = run.replayed ? restoreRun(run.item) : null;
      if (replay) return replay;
    }

    try {
      const rawComposition = snapshot.records.length > 0
        ? await composeWeeklyDraftWithModel(
          snapshot.fallbackDraft,
          {
            periodStart: snapshot.period.start,
            periodEnd: snapshot.period.end,
            records: snapshot.records,
            knowledge: snapshot.knowledge,
            sourceRefs: snapshot.sourceRefs,
          },
          config,
          { fetchImpl, systemPrompt: manifest.systemPrompt },
        )
        : { ...snapshot.fallbackDraft, source: "deterministic", fallbackReason: null };
      const composed = guardedComposition(rawComposition, snapshot.fallbackDraft, snapshot.sourceRefs);
      const source = composed.source ?? "deterministic";
      const persistedSource = source === "fallback"
        ? "fallback"
        : source === "deterministic"
          ? "deterministic"
          : "model";
      const refs = snapshot.sourceRefs;
      const output = {
        schemaVersion: CONTRACT_VERSION,
        agentId: AGENT_ID,
        agentVersion: manifest.version,
        contractVersion: manifest.contractVersion,
        status: "preview",
        taskType,
        period: snapshot.period,
        asOf: snapshot.asOf,
        candidateRecordCount: snapshot.candidateRecordCount,
        sourceRecordCount: snapshot.records.length,
        statusCounts: snapshot.statusCounts,
        executiveSummary: snapshot.records.length
          ? `本周期纳入 ${snapshot.records.length} 条已确认销售记录，报告正文仅作预览。`
          : "本周期没有已确认销售记录，暂不生成进展结论。",
        customerUpdates: snapshot.items.customerUpdates,
        opportunityUpdates: snapshot.items.opportunityUpdates,
        actions: snapshot.items.actions,
        risks: snapshot.items.risks,
        facts: snapshot.items.facts,
        inferences: snapshot.items.inferences,
        unknowns: [
          ...(snapshot.preparation.blockers.length
            ? snapshot.preparation.blockers.map((blocker) => ({ key: blocker, question: "请先处理周报准备阻塞。", reason: blocker }))
            : []),
          ...(snapshot.records.some((record) => !record.analysis.summary.action?.text)
            ? [{ key: "action", question: "请补充没有明确下一步动作的记录。", reason: "来源分析缺少行动摘要。" }]
            : []),
        ],
        sourceRefs: refs,
        persistedReportRefs: snapshot.reports.map((item) => sourceRef("weekly_report", item.id)).filter(Boolean),
        preparation: snapshot.preparation,
        content: multiline(composed.content, "content", MAX_TEXT),
        summary: outputSummary(snapshot, composed.content, refs, source, run?.item?.id ?? null),
        source,
        writebackPreview: {
          requiresHumanConfirmation: true,
          save: false,
          publish: false,
          note: "当前只生成销售周报预览，不保存、不发布、不修改拜访、客户、商机、行动或风险。",
        },
        writebackAllowed: false,
      };
      if (runRepository && run?.item) {
        run = runRepository.complete(run.item.id, {
          owner: normalizedOwner,
          output,
          source: persistedSource,
          modelProvider: config.modelProvider ?? null,
          modelName: config.modelName ?? null,
          fallbackReason: composed.fallbackReason ?? null,
          sourceRefs: refs,
          confirmationStatus: "preview",
        });
      }
      return {
        ...output,
        runId: run?.item?.id ?? null,
        inputSnapshotHash: run?.item?.inputSnapshotHash ?? null,
      };
    } catch (error) {
      if (runRepository && run?.item) {
        try {
          runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "SALES_REPORT_ADAPTER_FAILED" });
        } catch {
          // Preserve the original error and fail closed.
        }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, preview: analyze, restore: restoreRun });
}

export { normalizeSnapshot as normalizeSalesReportSnapshot, restoreRun as restoreSalesReportRun };
