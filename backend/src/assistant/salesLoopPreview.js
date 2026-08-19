import { buildWeeklyDraft } from "../weeklyDraft.js";
import { SALES_DECISION_TYPES } from "../ai/agents/salesDecisionSchema.js";
import { createAssistantBusinessSnapshotAdapter } from "./businessSnapshotAdapter.js";
import { createSalesDecisionAssistantAdapter } from "./salesDecisionAssistantAdapter.js";
import { AssistantContractError } from "./contracts.js";

const MAX_ITEMS = 100;
const MAX_TEXT = 5000;
const MAX_SOURCE_REFS = 100;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function boundedMultilineText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) return null;
  if (/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function requiredText(value, name, max = 500) {
  const normalized = boundedText(value, max);
  if (!normalized) throw new AssistantContractError(`${name} is required`, "invalid_sales_loop_preview");
  return normalized;
}

function requestObject(value, name = "input") {
  if (!isPlainObject(value)) throw new AssistantContractError(`${name} must be an object`, "invalid_sales_loop_preview");
  return value;
}

function normalizeAnalysisType(value) {
  const normalized = requiredText(value ?? "opportunity_diagnosis", "analysisType", 80);
  if (!SALES_DECISION_TYPES.includes(normalized)) {
    throw new AssistantContractError("analysisType is invalid", "invalid_sales_loop_preview");
  }
  return normalized;
}

function optionalIdentifier(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = requiredText(value, name, 200);
  if (!/^[\u4e00-\u9fffA-Za-z0-9_.:-]{1,200}$/u.test(normalized) || normalized.startsWith("synthetic:")) {
    throw new AssistantContractError(`${name} is invalid`, "invalid_sales_loop_preview");
  }
  return normalized;
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringArray(value, maxItems = 30, maxLength = 500) {
  const parsed = Array.isArray(value) ? value : parseJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, maxItems).flatMap((item) => {
    const normalized = boundedText(item, maxLength);
    return normalized ? [normalized] : [];
  });
}

function stakeholderArray(value) {
  const parsed = Array.isArray(value) ? value : parseJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 20).flatMap((item) => {
    if (typeof item === "string") {
      const name = boundedText(item, 300);
      return name ? [{ name }] : [];
    }
    if (!isPlainObject(item)) return [];
    const name = boundedText(item.name ?? item.title, 300);
    if (!name) return [];
    return [{
      name,
      title: boundedText(item.title, 300),
      role: boundedText(item.role, 100) ?? "unknown",
      stance: boundedText(item.stance, 50) ?? "unknown",
      influence: boundedText(item.influence, 50) ?? "unknown",
      confidence: Number.isSafeInteger(item.confidence) ? Math.max(0, Math.min(100, item.confidence)) : 40,
      evidence: boundedText(item.evidence, 800) ?? "",
    }];
  });
}

function sourceRef(type, id) {
  const normalizedType = boundedText(type, 80);
  let normalizedId = null;
  try {
    normalizedId = optionalIdentifier(id, "sourceRef.id");
  } catch {
    return null;
  }
  return normalizedType && normalizedId ? { type: normalizedType, id: normalizedId } : null;
}

function addSourceRef(refs, type, id) {
  const ref = sourceRef(type, id);
  if (!ref || refs.some((item) => item.type === ref.type && item.id === ref.id)) return;
  if (refs.length < MAX_SOURCE_REFS) refs.push(ref);
}

function sourceRefsFrom(value) {
  if (!Array.isArray(value)) return [];
  const refs = [];
  for (const item of value) {
    if (isPlainObject(item)) addSourceRef(refs, item.type, item.id);
  }
  return refs;
}

function dateOnly(value, name) {
  const normalized = requiredText(value, name, 10);
  if (!DATE_ONLY.test(normalized)) throw new AssistantContractError(`${name} is invalid`, "invalid_sales_loop_preview");
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new AssistantContractError(`${name} is invalid`, "invalid_sales_loop_preview");
  }
  return normalized;
}

function weekRange(value, clock) {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("clock must return a valid Date");
  if (value !== undefined && value !== null && value !== "" && value !== "current") {
    const start = dateOnly(value, "weekStart");
    const parsed = new Date(`${start}T00:00:00.000Z`);
    if (parsed.getUTCDay() !== 1) throw new AssistantContractError("weekStart must be a Monday", "invalid_sales_loop_preview");
    const end = new Date(parsed);
    end.setUTCDate(end.getUTCDate() + 6);
    return { start, end: end.toISOString().slice(0, 10) };
  }
  const business = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const parts = Object.fromEntries(business.map((part) => [part.type, part.value]));
  const start = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
  const day = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - day);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function boundedInsight(value) {
  const parsed = isPlainObject(value) ? value : {};
  const match = (item) => isPlainObject(item)
    ? { id: optionalIdentifier(item.id, "insight.id"), value: boundedText(item.value, 300) }
    : null;
  const summary = (item) => isPlainObject(item)
    ? { title: boundedText(item.title, 200), text: boundedText(item.text, 1200) }
    : null;
  return {
    customer: match(parsed.customer),
    opportunity: match(parsed.opportunity),
    summary: { action: summary(parsed.summary?.action), risk: summary(parsed.summary?.risk) },
  };
}

function rowSourceRefs(rows, type) {
  const refs = [];
  for (const row of rows) addSourceRef(refs, type, row?.id);
  return refs;
}

function safeErrorPreview(error) {
  const isContractError = error instanceof AssistantContractError || error?.name === "AssistantContractError";
  if (!isContractError) throw error;
  if (["missing_sales_decision_evidence", "relationship_conflict", "context_not_found"].includes(error.code)) {
    return {
      status: "review_required",
      writebackAllowed: false,
      blockers: [error.code],
      message: error.message,
    };
  }
  throw error;
}

export function createSalesLoopPreviewService({
  db,
  businessSnapshotAdapter = null,
  contextRepository = null,
  salesDecisionAdapter = null,
  runRepository = null,
  config = {},
  fetchImpl = fetch,
  resolveBusinessOwner = (owner) => owner,
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db must be a synchronous SQLite connection");
  const snapshotAdapter = businessSnapshotAdapter
    ?? createAssistantBusinessSnapshotAdapter({ db, clock, resolveBusinessOwner });
  const decisionAdapter = salesDecisionAdapter
    ?? createSalesDecisionAssistantAdapter({ config, fetchImpl, runRepository, clock });

  function owner(value) {
    return requiredText(value, "owner", 200);
  }

function dataOwner(value) {
    let resolved;
    try {
      resolved = resolveBusinessOwner(owner(value));
    } catch {
      return null;
    }
    const normalized = boundedText(resolved, 200);
    return normalized || null;
  }

  function resolveContext(input = {}) {
    const normalizedOwner = owner(input.owner);
    const channel = input.channel === undefined || input.channel === null ? "assistant" : requiredText(input.channel, "channel", 100);
    const conversationId = input.conversationId === undefined || input.conversationId === null
      ? null
      : requiredText(input.conversationId, "conversationId", 500);
    const persisted = contextRepository && conversationId
      ? contextRepository.get({ owner: normalizedOwner, channel, conversationId })
      : null;
    const customerId = optionalIdentifier(input.customerId ?? persisted?.customerId, "customerId");
    const opportunityId = optionalIdentifier(input.opportunityId ?? persisted?.opportunityId, "opportunityId");
    return {
      owner: normalizedOwner,
      channel,
      conversationId,
      customerId,
      opportunityId,
      persisted,
    };
  }

  function customerRow(ownerValue, customerId) {
    if (!customerId) return null;
    const row = db.prepare(`
      SELECT id, name, type, budget, summary, needs, risks, stakeholders, decision_chain, updated_at
      FROM customers
      WHERE id = $id AND owner = $owner AND deleted_at IS NULL
    `).get({ $id: customerId, $owner: ownerValue });
    if (!row) return null;
    return {
      id: row.id,
      name: boundedText(row.name, 300) ?? "",
      type: boundedText(row.type, 100) ?? "",
      budget: boundedText(row.budget, 300) ?? "",
      summary: boundedText(row.summary, 1200) ?? "",
      needs: stringArray(row.needs),
      risks: stringArray(row.risks),
      stakeholders: stakeholderArray(row.stakeholders),
      decisionChain: stringArray(row.decision_chain),
      updatedAt: boundedText(row.updated_at, 100),
    };
  }

  function opportunityRow(ownerValue, opportunityId) {
    if (!opportunityId) return null;
    const row = db.prepare(`
      SELECT opportunity.id, opportunity.customer_id, opportunity.name, opportunity.stage,
             opportunity.amount, opportunity.requirements, opportunity.competitors,
             opportunity.solution_direction, opportunity.risk, opportunity.next,
             opportunity.source_record, opportunity.updated_at
      FROM opportunities opportunity
      INNER JOIN customers customer
        ON customer.id = opportunity.customer_id AND customer.deleted_at IS NULL
      WHERE opportunity.id = $id
        AND opportunity.deleted_at IS NULL
        AND (opportunity.owner = $owner OR (opportunity.owner IS NULL AND customer.owner = $owner))
    `).get({ $id: opportunityId, $owner: ownerValue });
    if (!row) return null;
    return {
      id: row.id,
      customerId: row.customer_id,
      name: boundedText(row.name, 300) ?? "",
      stage: boundedText(row.stage, 100) ?? "",
      amount: boundedText(row.amount, 100) ?? "",
      requirements: stringArray(row.requirements),
      competitors: stringArray(row.competitors),
      solutionDirection: stringArray(row.solution_direction),
      risk: boundedText(row.risk, 1200) ?? "",
      next: boundedText(row.next, 1200) ?? "",
      sourceRecord: boundedText(row.source_record, 1800) ?? "",
      updatedAt: boundedText(row.updated_at, 100),
    };
  }

  function quickRecords(ownerValue, customerId, opportunityId) {
    const rows = db.prepare(`
      SELECT id, raw_content, occurred_at, source_channel, customer_id, opportunity_id, status, created_at
      FROM quick_records
      WHERE owner = $owner AND voided_at IS NULL
        AND status IN ('recorded', 'analyzed')
        AND ($opportunityId IS NULL OR opportunity_id = $opportunityId)
        AND ($customerId IS NULL OR customer_id = $customerId OR (customer_id IS NULL AND opportunity_id = $opportunityId))
      ORDER BY COALESCE(occurred_at, created_at) DESC, id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: ownerValue, $customerId: customerId ?? null, $opportunityId: opportunityId ?? null });
    return {
      rows: rows.slice(0, MAX_ITEMS).map((row) => ({
        id: row.id,
        rawContent: boundedMultilineText(row.raw_content, MAX_TEXT) ?? "",
        occurredAt: boundedText(row.occurred_at, 100),
        sourceChannel: boundedText(row.source_channel, 100) ?? "",
        customerId: row.customer_id,
        opportunityId: row.opportunity_id,
        status: boundedText(row.status, 50) ?? "",
      })),
      truncated: rows.length > MAX_ITEMS,
    };
  }

  function buildSnapshot(input = {}) {
    input = requestObject(input);
    const context = resolveContext(input);
    const scopedOwner = dataOwner(context.owner);
    if (!scopedOwner) return { status: "not_found", context, reason: "owner_scope_denied" };
    if (!context.customerId && !context.opportunityId) {
      return { status: "clarify", question: "请先指定客户或商机，再生成销售闭环预览。", context };
    }
    const opportunity = opportunityRow(scopedOwner, context.opportunityId);
    if (context.opportunityId && !opportunity) return { status: "not_found", context };
    const customerId = context.customerId ?? opportunity?.customerId ?? null;
    const customer = customerRow(scopedOwner, customerId);
    if (customerId && !customer) return { status: "not_found", context: { ...context, customerId } };
    if (customer && opportunity && opportunity.customerId !== customer.id) {
      return {
        status: "review_required",
        blockers: ["relationship_conflict"],
        message: "客户与商机的服务端关系不一致，暂不生成分析。",
        context,
      };
    }
    const records = quickRecords(scopedOwner, customer?.id ?? null, opportunity?.id ?? null);
    const latest = records.rows[0] ?? null;
    const actionRisk = snapshotAdapter.actionRiskSummary({
      owner: context.owner,
      customerId: customer?.id ?? null,
      opportunityId: opportunity?.id ?? null,
    });
    const knowledge = input.knowledgeQuery
      ? snapshotAdapter.knowledgeSearch({ query: requiredText(input.knowledgeQuery, "knowledgeQuery", 200) }).items
      : [];
    // Source references are reconstructed from rows that passed the owner scope;
    // caller-supplied references are never trusted as evidence.
    const refs = [];
    addSourceRef(refs, "customer", customer?.id);
    addSourceRef(refs, "opportunity", opportunity?.id);
    for (const record of records.rows) addSourceRef(refs, "quick_record", record.id);
    for (const action of actionRisk.actions) addSourceRef(refs, "action", action.id);
    for (const risk of actionRisk.risks) addSourceRef(refs, "risk", risk.id);
    for (const item of knowledge) addSourceRef(refs, "knowledge", item.id);
    const snapshot = {
      analysisType: normalizeAnalysisType(input.analysisType),
      industry: boundedText(input.industry, 100) ?? "general",
      rawContent: latest?.rawContent ?? "",
      customer,
      opportunity,
      quickRecord: latest,
      actions: actionRisk.actions.map((item) => ({
        id: item.id,
        title: item.title ?? "",
        due: item.due ?? "",
        status: item.status ?? "",
        assignee: item.assignee ?? "",
      })),
      risks: actionRisk.risks.map((item) => ({
        id: item.id,
        title: item.title ?? "",
        severity: item.severity ?? "",
        status: item.status ?? "",
        evidence: item.evidence ?? "",
      })),
      knowledge: knowledge.map((item) => ({ id: item.id, title: item.title ?? "", summary: item.summary ?? "" })),
      sourceRefs: refs,
    };
    return {
      status: "ok",
      context: { ...context, customerId: customer?.id ?? null, opportunityId: opportunity?.id ?? null },
      snapshot,
      evidence: {
        asOf: new Date(clock()).toISOString(),
        customerId: customer?.id ?? null,
        opportunityId: opportunity?.id ?? null,
        quickRecordCount: records.rows.length,
        quickRecordTruncated: records.truncated,
        actionCount: actionRisk.actions.length,
        riskCount: actionRisk.risks.length,
        knowledgeCount: knowledge.length,
        sourceRefs: refs,
      },
    };
  }

  async function previewSalesDecision(input = {}) {
    input = requestObject(input);
    const analysisType = normalizeAnalysisType(input.analysisType);
    const prepared = buildSnapshot({ ...input, analysisType });
    if (prepared.status !== "ok") return { ...prepared, writebackAllowed: false };
    try {
      const result = await decisionAdapter.analyze({
        owner: prepared.context.owner,
        channel: prepared.context.channel,
        conversationId: prepared.context.conversationId,
        eventId: input.eventId ?? null,
        analysisType,
        industry: input.industry ?? "general",
        analysisAt: input.analysisAt ?? new Date(clock()).toISOString(),
        businessSnapshot: prepared.snapshot,
      });
      return {
        status: "preview",
        writebackAllowed: false,
        context: prepared.context,
        evidence: prepared.evidence,
        sourceRefs: result.sourceRefs,
        runId: result.runId,
        source: result.source,
        inputSnapshotHash: result.inputSnapshotHash,
        analysis: result.analysis,
      };
    } catch (error) {
      return safeErrorPreview(error);
    }
  }

  function rememberContext(input = {}) {
    input = requestObject(input);
    if (!contextRepository) throw new TypeError("contextRepository is required to remember business context");
    const prepared = buildSnapshot(input);
    if (prepared.status !== "ok") return { ...prepared, changed: false };
    const saved = contextRepository.set({
      owner: prepared.context.owner,
      channel: prepared.context.channel,
      conversationId: requiredText(prepared.context.conversationId, "conversationId", 500),
      customerId: prepared.context.customerId,
      opportunityId: prepared.context.opportunityId,
      source: input.source ?? "verified_entity",
      sourceRefs: prepared.evidence.sourceRefs,
      expectedVersion: input.expectedVersion,
      requestId: input.requestId,
    });
    return { status: "ok", changed: saved.changed, context: saved.item, sourceRefs: prepared.evidence.sourceRefs };
  }

  function weeklyReportRows(ownerValue, range) {
    return db.prepare(`
      SELECT id, period_start, period_end, status, source_refs, created_at, updated_at
      FROM weekly_reports
      WHERE owner = $owner AND deleted_at IS NULL
        AND status IN ('draft', 'saved', 'ready')
        AND period_start <= $end AND period_end >= $start
      ORDER BY period_start DESC, updated_at DESC, id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: ownerValue, $start: range.start, $end: range.end });
  }

  function weeklySourceRows(ownerValue, range) {
    return db.prepare(`
      SELECT qr.id, qr.raw_content, qr.occurred_at, qr.source_channel, ai.analysis_json
      FROM quick_records qr
      LEFT JOIN ai_insights ai ON ai.id = (
        SELECT latest.id FROM ai_insights latest
        WHERE latest.quick_record_id = qr.id
        ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
      )
      WHERE qr.owner = $owner AND qr.voided_at IS NULL AND qr.status = 'analyzed'
        AND date(substr(COALESCE(qr.occurred_at, qr.created_at), 1, 10)) BETWEEN $start AND $end
        AND (
          qr.source_channel = '微信助手'
          OR EXISTS (
            SELECT 1 FROM manual_confirmations confirmation
            WHERE confirmation.quick_record_id = qr.id AND confirmation.target = 'weekly'
          )
        )
      ORDER BY COALESCE(qr.occurred_at, qr.created_at), qr.id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: ownerValue, $start: range.start, $end: range.end });
  }

  function weeklyCandidateRecordCount(ownerValue, range) {
    const row = db.prepare(`
      SELECT COUNT(*) AS record_count
      FROM quick_records
      WHERE owner = $owner AND voided_at IS NULL
        AND date(substr(COALESCE(occurred_at, created_at), 1, 10)) BETWEEN $start AND $end
    `).get({ $owner: ownerValue, $start: range.start, $end: range.end });
    const count = Number(row?.record_count ?? 0);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }

  function buildSalesReportSnapshot(input = {}) {
    input = requestObject(input);
    const normalizedOwner = owner(input.owner);
    const scopedOwner = dataOwner(normalizedOwner);
    const range = weekRange(input.weekStart ?? input.week ?? "current", clock);
    if (!scopedOwner) {
      return {
        status: "owner_scope_denied",
        period: { start: range.start, end: range.end },
      };
    }
    const reports = weeklyReportRows(scopedOwner, range);
    const sourceRows = weeklySourceRows(scopedOwner, range);
    const candidateRecordCount = weeklyCandidateRecordCount(scopedOwner, range);
    const sourceRecords = sourceRows.slice(0, MAX_ITEMS).map((row) => ({
      id: row.id,
      rawContent: boundedMultilineText(row.raw_content, MAX_TEXT) ?? "",
      occurredAt: row.occurred_at,
      sourceChannel: boundedText(row.source_channel, 100) ?? "manual",
      analysis: boundedInsight(parseJson(row.analysis_json, {})),
    }));
    const reportItems = reports.slice(0, MAX_ITEMS).map((row) => ({
      id: row.id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      status: row.status,
      sourceRefs: sourceRefsFrom(parseJson(row.source_refs, [])),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const knowledge = input.knowledgeQuery
      ? snapshotAdapter.knowledgeSearch({ query: requiredText(input.knowledgeQuery, "knowledgeQuery", 200) }).items
      : [];
    const draft = buildWeeklyDraft({
      // The business owner is an authorization boundary, not report prose or
      // model input. Use a neutral heading in the deterministic draft.
      owner: "销售团队",
      periodStart: range.start,
      periodEnd: range.end,
      records: sourceRecords,
      knowledge,
    });
    const refs = sourceRefsFrom(draft.sourceRefs);
    const truncated = sourceRows.length > MAX_ITEMS || reports.length > MAX_ITEMS;
    const blockers = [];
    if (sourceRecords.length === 0) blockers.push("no_confirmed_records");
    if (truncated) blockers.push("truncated");
    const statusCounts = { draft: 0, saved: 0, ready: 0 };
    for (const item of reportItems) if (Object.hasOwn(statusCounts, item.status)) statusCounts[item.status] += 1;
    return {
      status: "ok",
      period: { start: range.start, end: range.end },
      asOf: new Date(clock()).toISOString(),
      sourceRecords,
      knowledge,
      reports: reportItems,
      candidateRecordCount,
      statusCounts,
      deterministicDraft: {
        content: boundedMultilineText(draft.content, 20_000) ?? "",
        sourceRefs: refs,
      },
      sourceRefs: refs,
      truncated: sourceRows.length > MAX_ITEMS || reports.length > MAX_ITEMS,
      sourceTruncated: sourceRows.length > MAX_ITEMS,
      reportsTruncated: reports.length > MAX_ITEMS,
      preparation: { ready: blockers.length === 0, blockers },
    };
  }

  function previewSalesReport(input = {}) {
    const snapshot = buildSalesReportSnapshot(input);
    if (snapshot.status === "owner_scope_denied") {
      return {
        status: "preview",
        writebackAllowed: false,
        weekStart: snapshot.period.start,
        periodEnd: snapshot.period.end,
        reportCount: 0,
        candidateRecordCount: 0,
        statusCounts: { draft: 0, saved: 0, ready: 0 },
        reports: [],
        preview: {
          persisted: false,
          content: "",
          sourceRecordCount: 0,
          sourceRefs: [],
          truncated: false,
          preparation: { ready: false, blockers: ["owner_scope_denied"] },
        },
      };
    }
    return {
      status: "preview",
      writebackAllowed: false,
      weekStart: snapshot.period.start,
      periodEnd: snapshot.period.end,
      reportCount: snapshot.reports.length,
      candidateRecordCount: snapshot.candidateRecordCount,
      statusCounts: snapshot.statusCounts,
      reports: snapshot.reports,
      preview: {
        persisted: false,
        content: snapshot.deterministicDraft.content,
        sourceRecordCount: snapshot.sourceRecords.length,
        sourceRefs: snapshot.sourceRefs,
        truncated: snapshot.sourceTruncated === true,
        preparation: snapshot.preparation,
      },
    };
  }

  function projectPreview(input = {}) {
    const prepared = buildSnapshot(input);
    if (prepared.status !== "ok") return { ...prepared, writebackAllowed: false };
    const analysis = snapshotAdapter.projectAnalysis({
      owner: prepared.context.owner,
      customerId: prepared.context.customerId,
      opportunityId: prepared.context.opportunityId,
    });
    return {
      status: "preview",
      writebackAllowed: false,
      context: prepared.context,
      evidence: prepared.evidence,
      sourceRefs: prepared.evidence.sourceRefs,
      analysis,
    };
  }

  return Object.freeze({ buildSnapshot, buildSalesReportSnapshot, previewSalesDecision, previewSalesReport, projectPreview, rememberContext });
}
