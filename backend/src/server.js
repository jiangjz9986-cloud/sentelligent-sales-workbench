import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { all, get, openDatabase, run } from "./db.js";
import {
  analyzeQuickRecord,
  enhanceSolutionDraftWithModel,
  enhanceWeeklyDraftWithModel,
  generateManualSuggestion,
} from "./modelAnalysis.js";
import { seedDatabase } from "./seed.js";
import {
  buildSolutionDraft,
  isSolutionArtifactType,
  normalizeSolutionArtifactType,
} from "./solutionDraft.js";
import { createWeixinLoginBinding } from "./weixin/loginBinding.js";
import { buildWeeklyDraft } from "./weeklyDraft.js";

const jsonColumns = {
  customer: [
    "stakeholders",
    "decision_chain",
    "history_projects",
    "infrastructure",
    "sync_preview",
    "needs",
    "risks",
    "opportunities",
  ],
  opportunity: ["requirements", "competitors", "solution_direction"],
};

const authSessionTtlMs = 7 * 24 * 60 * 60 * 1000;

function parseJson(value, fallback = []) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(value ?? []);
}

function customerFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    type: row.type,
    level: row.level,
    owner: row.owner,
    contact: row.contact,
    relation: row.relation,
    stakeholders: parseJson(row.stakeholders),
    decisionChain: parseJson(row.decision_chain),
    historyProjects: parseJson(row.history_projects),
    infrastructure: parseJson(row.infrastructure),
    syncPreview: parseJson(row.sync_preview),
    budget: row.budget,
    summary: row.summary,
    needs: parseJson(row.needs),
    risks: parseJson(row.risks),
    opportunities: parseJson(row.opportunities),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function opportunityFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    customer: row.customer,
    stage: row.stage,
    amount: row.amount,
    owner: row.owner,
    probability: row.probability,
    days: row.days,
    requirements: parseJson(row.requirements),
    competitors: parseJson(row.competitors),
    solutionDirection: parseJson(row.solution_direction),
    sourceRecord: row.source_record,
    risk: row.risk,
    next: row.next,
    tone: row.tone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function quickRecordFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    rawContent: row.raw_content,
    occurredAt: row.occurred_at,
    sourceChannel: row.source_channel,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insightFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    quickRecordId: row.quick_record_id,
    confidence: row.confidence,
    createdAt: row.created_at,
    ...parseJson(row.analysis_json, {}),
  };
}

function confirmationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    quickRecordId: row.quick_record_id,
    target: row.target,
    confirmedBy: row.confirmed_by,
    note: row.note,
    createdAt: row.created_at,
  };
}

function weeklyReportFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    content: row.content,
    sourceRefs: parseJson(row.source_refs),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function solutionDraftFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    artifactType: row.artifact_type ?? "solution_framework",
    title: row.title,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    status: row.status,
    content: row.content,
    sourceRefs: parseJson(row.source_refs),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aiSuggestionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    content: row.content,
    sourceRefs: parseJson(row.source_refs),
    createdAt: row.created_at,
  };
}

function actionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    title: row.title,
    customer: row.customer,
    reason: row.reason,
    due: row.due,
    assignee: row.assignee,
    priority: row.priority,
    status: row.status,
    sourceRecordId: row.source_record_id,
    tone: row.tone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function riskFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    title: row.title,
    target: row.target,
    score: row.score,
    severity: row.severity,
    status: row.status,
    evidence: row.evidence,
    action: row.action,
    assignee: row.assignee,
    due: row.due,
    sourceType: row.source_type,
    sourceId: row.source_id,
    tone: row.tone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function numberFromText(value) {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function formatMoneyWan(value) {
  if (!value) return "0 万";
  return `${Math.round(value)} 万`;
}

function dateChip(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "今日";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dashboardSummaryFromDb(db) {
  const customers = all(db, "SELECT * FROM customers ORDER BY relation DESC, updated_at DESC").map(customerFromRow);
  const opportunities = all(db, "SELECT * FROM opportunities ORDER BY probability DESC, updated_at DESC").map(opportunityFromRow);
  const priorityRank = (value) => {
    const text = String(value ?? "");
    if (text.includes("高") || text.includes("楂")) return 0;
    if (text.includes("中") || text.includes("涓")) return 1;
    return 2;
  };
  const actions = all(db, "SELECT * FROM action_items ORDER BY updated_at DESC")
    .map(actionFromRow)
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));
  const risks = all(db, "SELECT * FROM risk_items ORDER BY score DESC, updated_at DESC").map(riskFromRow);
  const quickRecords = all(db, "SELECT * FROM quick_records ORDER BY occurred_at DESC, created_at DESC").map(quickRecordFromRow);
  const openActions = actions.filter((item) => item.status !== "done");
  const openRisks = risks.filter((item) => item.status !== "closed");
  const highRisks = openRisks.filter((item) => item.score >= 80 || item.severity === "高" || item.severity === "楂?");
  const forecast = opportunities.reduce((total, item) => total + numberFromText(item.amount), 0);
  const stageCounts = [...new Set(opportunities.map((item) => item.stage).filter(Boolean))]
    .map((stage) => ({
      stage,
      count: opportunities.filter((item) => item.stage === stage).length,
    }));

  return {
    metrics: {
      quickRecords: {
        value: quickRecords.length,
        badge: `${quickRecords.filter((item) => item.status !== "confirmed").length} 条待确认`,
        tone: "blue",
      },
      opportunities: {
        value: opportunities.length,
        badge: `${opportunities.filter((item) => item.probability >= 65).length} 个重点推进`,
        tone: "amber",
      },
      forecast: {
        value: formatMoneyWan(forecast),
        badge: "本月预测",
        tone: "green",
      },
      risks: {
        value: highRisks.length,
        badge: openRisks.length > 0 ? "需处理风险" : "暂无高风险",
        tone: "red",
      },
    },
    priorityActions: openActions.slice(0, 4),
    customerHeat: customers.slice(0, 3).map((customer) => ({
      customerId: customer.id,
      name: customer.name,
      label: customer.level ?? "客户关系",
      value: customer.relation,
      tone: customer.relation >= 80 ? "green" : customer.relation >= 65 ? "blue" : "amber",
    })),
    recentRecords: quickRecords.slice(0, 3).map((record) => ({
      id: record.id,
      date: dateChip(record.occurredAt ?? record.createdAt),
      customer: customers.find((item) => item.id === record.customerId)?.name ?? "未关联客户",
      title: record.sourceChannel ?? "快速记录",
      status: record.status,
      tone: record.status === "confirmed" ? "green" : "blue",
    })),
    opportunities: opportunities.slice(0, 4),
    rhythm: [
      ...(openActions[0]
        ? [{ id: "rhythm-action", time: openActions[0].due ?? "今日", title: openActions[0].title, type: "下一步动作", target: "actions" }]
        : []),
      ...(openRisks[0]
        ? [{ id: "rhythm-risk", time: openRisks[0].due ?? "待确认", title: openRisks[0].title, type: "风险识别", target: "risk" }]
        : []),
      { id: "rhythm-weekly", time: "18:00", title: "整理本周记录", type: "周报与汇报", target: "weekly" },
    ].slice(0, 3),
    stageCounts,
    generatedAt: new Date().toISOString(),
  };
}

function knowledgeFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    tags: parseJson(row.tags),
    summary: row.summary,
    content: row.content,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditLogFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actor: row.actor,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function sanitizeAuditMetadata(value, depth = 0) {
  if (depth > 5) return null;
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAuditMetadata(item, depth + 1));

  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (/key|secret|token|authorization|password/i.test(key)) continue;
    sanitized[key] = sanitizeAuditMetadata(item, depth + 1);
  }
  return sanitized;
}

function recordAuditLog(db, { action, entityType, entityId = null, actor = null, metadata = {} }) {
  const id = randomUUID();
  run(
    db,
    `INSERT INTO audit_logs (id, action, entity_type, entity_id, actor, metadata_json)
     VALUES ($id, $action, $entityType, $entityId, $actor, $metadataJson)`,
    {
      $id: id,
      $action: action,
      $entityType: entityType,
      $entityId: entityId,
      $actor: actor,
      $metadataJson: JSON.stringify(sanitizeAuditMetadata(metadata) ?? {}),
    },
  );
  return auditLogFromRow(get(db, "SELECT * FROM audit_logs WHERE id = $id", { $id: id }));
}

function listAuditLogs(db, searchParams) {
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit")) || 100, 500));
  return all(
    db,
    `SELECT * FROM audit_logs
     WHERE ($action IS NULL OR action = $action)
       AND ($entityType IS NULL OR entity_type = $entityType)
       AND ($entityId IS NULL OR entity_id = $entityId)
     ORDER BY created_at DESC
     LIMIT $limit`,
    {
      $action: searchParams.get("action") || null,
      $entityType: searchParams.get("entityType") || null,
      $entityId: searchParams.get("entityId") || null,
      $limit: limit,
    },
  ).map(auditLogFromRow);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  });
  response.end(JSON.stringify(body));
}

function sendDocument(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    ...headers,
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function notFound(response) {
  sendJson(response, 404, { error: "not_found" });
}

function badRequest(response, message) {
  sendJson(response, 400, { error: "bad_request", message });
}

function unauthorized(response, message = "请先登录") {
  sendJson(response, 401, { error: "unauthorized", message });
}

const riskStatuses = new Set(["open", "accepted", "in_progress", "deferred", "closed"]);
const actionStatuses = new Set(["pending", "in_progress", "done", "deferred"]);
const weeklyReportStatuses = new Set(["draft", "saved", "ready"]);

function createCustomer(db, body) {
  const id = body.id ?? randomUUID();
  run(
    db,
    `INSERT INTO customers (
      id, name, region, type, level, owner, contact, relation,
      stakeholders, decision_chain, history_projects, infrastructure,
      sync_preview, budget, summary, needs, risks, opportunities
    ) VALUES (
      $id, $name, $region, $type, $level, $owner, $contact, $relation,
      $stakeholders, $decisionChain, $historyProjects, $infrastructure,
      $syncPreview, $budget, $summary, $needs, $risks, $opportunities
    )`,
    {
      $id: id,
      $name: body.name,
      $region: body.region ?? null,
      $type: body.type ?? null,
      $level: body.level ?? null,
      $owner: body.owner ?? null,
      $contact: body.contact ?? null,
      $relation: body.relation ?? 0,
      $stakeholders: json(body.stakeholders),
      $decisionChain: json(body.decisionChain),
      $historyProjects: json(body.historyProjects),
      $infrastructure: json(body.infrastructure),
      $syncPreview: json(body.syncPreview),
      $budget: body.budget ?? null,
      $summary: body.summary ?? null,
      $needs: json(body.needs),
      $risks: json(body.risks),
      $opportunities: json(body.opportunities),
    },
  );
  return customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id", { $id: id }));
}

function createOpportunity(db, body) {
  const id = body.id ?? randomUUID();
  run(
    db,
    `INSERT INTO opportunities (
      id, customer_id, name, customer, stage, amount, owner, probability,
      days, requirements, competitors, solution_direction, source_record,
      risk, next, tone
    ) VALUES (
      $id, $customerId, $name, $customer, $stage, $amount, $owner, $probability,
      $days, $requirements, $competitors, $solutionDirection, $sourceRecord,
      $risk, $next, $tone
    )`,
    {
      $id: id,
      $customerId: body.customerId,
      $name: body.name,
      $customer: body.customer ?? null,
      $stage: body.stage ?? null,
      $amount: body.amount ?? null,
      $owner: body.owner ?? null,
      $probability: body.probability ?? 0,
      $days: body.days ?? 0,
      $requirements: json(body.requirements),
      $competitors: json(body.competitors),
      $solutionDirection: json(body.solutionDirection),
      $sourceRecord: body.sourceRecord ?? null,
      $risk: body.risk ?? null,
      $next: body.next ?? null,
      $tone: body.tone ?? null,
    },
  );
  return opportunityFromRow(get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: id }));
}

function patchValue(body, field, currentValue) {
  return Object.hasOwn(body, field) ? body[field] : currentValue;
}

function patchJsonValue(body, field, currentValue) {
  return Object.hasOwn(body, field) ? json(body[field]) : json(currentValue);
}

function updateCustomer(db, id, body) {
  const current = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id", { $id: id }));
  if (!current) return null;

  run(
    db,
    `UPDATE customers
     SET name = $name,
         region = $region,
         type = $type,
         level = $level,
         owner = $owner,
         contact = $contact,
         relation = $relation,
         stakeholders = $stakeholders,
         decision_chain = $decisionChain,
         history_projects = $historyProjects,
         infrastructure = $infrastructure,
         sync_preview = $syncPreview,
         budget = $budget,
         summary = $summary,
         needs = $needs,
         risks = $risks,
         opportunities = $opportunities,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $id`,
    {
      $id: id,
      $name: patchValue(body, "name", current.name),
      $region: patchValue(body, "region", current.region),
      $type: patchValue(body, "type", current.type),
      $level: patchValue(body, "level", current.level),
      $owner: patchValue(body, "owner", current.owner),
      $contact: patchValue(body, "contact", current.contact),
      $relation: patchValue(body, "relation", current.relation),
      $stakeholders: patchJsonValue(body, "stakeholders", current.stakeholders),
      $decisionChain: patchJsonValue(body, "decisionChain", current.decisionChain),
      $historyProjects: patchJsonValue(body, "historyProjects", current.historyProjects),
      $infrastructure: patchJsonValue(body, "infrastructure", current.infrastructure),
      $syncPreview: patchJsonValue(body, "syncPreview", current.syncPreview),
      $budget: patchValue(body, "budget", current.budget),
      $summary: patchValue(body, "summary", current.summary),
      $needs: patchJsonValue(body, "needs", current.needs),
      $risks: patchJsonValue(body, "risks", current.risks),
      $opportunities: patchJsonValue(body, "opportunities", current.opportunities),
    },
  );

  return customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id", { $id: id }));
}

function updateOpportunity(db, id, body) {
  const current = opportunityFromRow(get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: id }));
  if (!current) return null;

  run(
    db,
    `UPDATE opportunities
     SET customer_id = $customerId,
         name = $name,
         customer = $customer,
         stage = $stage,
         amount = $amount,
         owner = $owner,
         probability = $probability,
         days = $days,
         requirements = $requirements,
         competitors = $competitors,
         solution_direction = $solutionDirection,
         source_record = $sourceRecord,
         risk = $risk,
         next = $next,
         tone = $tone,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $id`,
    {
      $id: id,
      $customerId: patchValue(body, "customerId", current.customerId),
      $name: patchValue(body, "name", current.name),
      $customer: patchValue(body, "customer", current.customer),
      $stage: patchValue(body, "stage", current.stage),
      $amount: patchValue(body, "amount", current.amount),
      $owner: patchValue(body, "owner", current.owner),
      $probability: patchValue(body, "probability", current.probability),
      $days: patchValue(body, "days", current.days),
      $requirements: patchJsonValue(body, "requirements", current.requirements),
      $competitors: patchJsonValue(body, "competitors", current.competitors),
      $solutionDirection: patchJsonValue(body, "solutionDirection", current.solutionDirection),
      $sourceRecord: patchValue(body, "sourceRecord", current.sourceRecord),
      $risk: patchValue(body, "risk", current.risk),
      $next: patchValue(body, "next", current.next),
      $tone: patchValue(body, "tone", current.tone),
    },
  );

  return opportunityFromRow(get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: id }));
}

function normalizeTags(tags) {
  return Array.from(new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag ?? "").trim()).filter(Boolean)));
}

function createKnowledgeItem(db, body) {
  const id = body.id ?? randomUUID();
  run(
    db,
    `INSERT INTO knowledge_items (
      id, title, category, tags, summary, content, source
    ) VALUES (
      $id, $title, $category, $tags, $summary, $content, $source
    )`,
    {
      $id: id,
      $title: body.title,
      $category: body.category ?? null,
      $tags: json(normalizeTags(body.tags)),
      $summary: body.summary ?? null,
      $content: body.content ?? null,
      $source: body.source ?? null,
    },
  );
  return knowledgeFromRow(get(db, "SELECT * FROM knowledge_items WHERE id = $id", { $id: id }));
}

function updateKnowledgeItem(db, id, body) {
  const current = knowledgeFromRow(get(db, "SELECT * FROM knowledge_items WHERE id = $id", { $id: id }));
  if (!current) return null;

  run(
    db,
    `UPDATE knowledge_items
     SET title = $title,
         category = $category,
         tags = $tags,
         summary = $summary,
         content = $content,
         source = $source,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $id`,
    {
      $id: id,
      $title: patchValue(body, "title", current.title),
      $category: patchValue(body, "category", current.category),
      $tags: Object.hasOwn(body, "tags") ? json(normalizeTags(body.tags)) : json(current.tags),
      $summary: patchValue(body, "summary", current.summary),
      $content: patchValue(body, "content", current.content),
      $source: patchValue(body, "source", current.source),
    },
  );

  return knowledgeFromRow(get(db, "SELECT * FROM knowledge_items WHERE id = $id", { $id: id }));
}

function updateActionItem(db, id, body) {
  const current = actionFromRow(get(db, "SELECT * FROM action_items WHERE id = $id", { $id: id }));
  if (!current) return null;
  const nextStatus = patchValue(body, "status", current.status);
  if (!actionStatuses.has(nextStatus)) {
    return { error: "invalid_status" };
  }

  run(
    db,
    `UPDATE action_items
     SET status = $status,
         due = $due,
         assignee = $assignee,
         priority = $priority,
         tone = $tone,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $id`,
    {
      $id: id,
      $status: nextStatus,
      $due: patchValue(body, "due", current.due),
      $assignee: patchValue(body, "assignee", current.assignee),
      $priority: patchValue(body, "priority", current.priority),
      $tone: patchValue(body, "tone", current.tone),
    },
  );

  return actionFromRow(get(db, "SELECT * FROM action_items WHERE id = $id", { $id: id }));
}

function updateWeeklyReport(db, id, body) {
  const current = weeklyReportFromRow(get(db, "SELECT * FROM weekly_reports WHERE id = $id", { $id: id }));
  if (!current) return null;
  const nextStatus = patchValue(body, "status", current.status);
  if (!weeklyReportStatuses.has(nextStatus)) {
    return { error: "invalid_status" };
  }

  run(
    db,
    `UPDATE weekly_reports
     SET status = $status,
         content = $content,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $id`,
    {
      $id: id,
      $status: nextStatus,
      $content: patchValue(body, "content", current.content),
    },
  );

  return weeklyReportFromRow(get(db, "SELECT * FROM weekly_reports WHERE id = $id", { $id: id }));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildWeeklyWordDocument(report) {
  const title = `${report.owner} 销售周报`;
  const lines = String(report.content ?? "").split(/\r?\n/);
  const body = lines
    .map((line) => {
      if (line.startsWith("# ")) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith("- ")) return `<p>· ${escapeHtml(line.slice(2))}</p>`;
      if (!line.trim()) return "<p>&nbsp;</p>";
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: "Microsoft YaHei", Arial, sans-serif; line-height: 1.6; color: #111827; }
    h1 { font-size: 24px; margin: 0 0 18px; }
    h2 { font-size: 18px; margin: 18px 0 8px; }
    p { margin: 6px 0; }
    .meta { color: #667085; font-size: 12px; margin-bottom: 18px; }
  </style>
</head>
<body>
  <div class="meta">周期：${escapeHtml(report.periodStart)} 至 ${escapeHtml(report.periodEnd)} / 状态：${escapeHtml(report.status)} / 来源：${report.sourceRefs.length} 条</div>
  ${body}
</body>
</html>`;
}

function updateRiskItem(db, id, body) {
  const current = riskFromRow(get(db, "SELECT * FROM risk_items WHERE id = $id", { $id: id }));
  if (!current) return null;
  const nextStatus = patchValue(body, "status", current.status);
  if (!riskStatuses.has(nextStatus)) {
    return { error: "invalid_status" };
  }

  run(
    db,
    `UPDATE risk_items
     SET status = $status,
         action = $action,
         assignee = $assignee,
         due = $due,
         severity = $severity,
         score = $score,
         tone = $tone,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $id`,
    {
      $id: id,
      $status: nextStatus,
      $action: patchValue(body, "action", current.action),
      $assignee: patchValue(body, "assignee", current.assignee),
      $due: patchValue(body, "due", current.due),
      $severity: patchValue(body, "severity", current.severity),
      $score: patchValue(body, "score", current.score),
      $tone: patchValue(body, "tone", current.tone),
    },
  );

  return riskFromRow(get(db, "SELECT * FROM risk_items WHERE id = $id", { $id: id }));
}

function deleteRecord(db, { table, id, fromRow, select = "SELECT * FROM $table WHERE id = $id" }) {
  const query = select.replace("$table", table);
  const current = fromRow(get(db, query, { $id: id }));
  if (!current) return null;
  run(db, `DELETE FROM ${table} WHERE id = $id`, { $id: id });
  return current;
}

function splitSearchTerms(...values) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => String(value ?? "").split(/[\s,，、/|]+/))
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= 2),
    ),
  );
}

function scoreKnowledgeItem(item, terms, tags) {
  const haystack = [
    item.title,
    item.category,
    item.summary,
    item.content,
    ...(item.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  const termScore = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  const tagScore = tags.reduce((score, tag) => score + ((item.tags ?? []).includes(tag) ? 2 : 0), 0);
  return termScore + tagScore;
}

function searchKnowledgeItems(db, { query = "", tags = [], limit = 8 } = {}) {
  const rows = all(db, "SELECT * FROM knowledge_items ORDER BY updated_at DESC").map(knowledgeFromRow);
  const cleanTags = normalizeTags(tags);
  const terms = splitSearchTerms(query, ...cleanTags);
  const maxItems = Math.max(1, Math.min(Number(limit) || 8, 20));

  if (terms.length === 0 && cleanTags.length === 0) {
    return rows.slice(0, maxItems);
  }

  return rows
    .map((item) => ({ item, score: scoreKnowledgeItem(item, terms, cleanTags) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, "zh-Hans-CN"))
    .slice(0, maxItems)
    .map((entry) => entry.item);
}

function normalizeKnowledgeIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(value.map((id) => String(id ?? "").trim()).filter(Boolean)));
}

function getKnowledgeItemsByIds(db, ids) {
  if (!ids.length) return [];
  const rows = all(db, "SELECT * FROM knowledge_items").map(knowledgeFromRow);
  const byId = new Map(rows.map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function mergeKnowledgeItems(...groups) {
  const byId = new Map();
  for (const item of groups.flat()) {
    if (item?.id && !byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

function getLatestInsight(db, quickRecordId) {
  return insightFromRow(
    get(
      db,
      `SELECT * FROM ai_insights
       WHERE quick_record_id = $quickRecordId
       ORDER BY created_at DESC
       LIMIT 1`,
      { $quickRecordId: quickRecordId },
    ),
  );
}

function compactText(value, maxLength = 72) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function appendUnique(items, item) {
  const next = String(item ?? "").trim();
  if (!next) return items;
  return items.includes(next) ? items : [next, ...items];
}

function buildCustomerSyncPreview(quickRecord, insight) {
  const requestText = insight?.summary?.request?.text;
  return `快速记录已确认：${compactText(requestText || quickRecord.rawContent)}`;
}

function buildOpportunitySourceRecord(quickRecord) {
  const occurred = quickRecord.occurredAt ? quickRecord.occurredAt.slice(0, 10) : "未标注日期";
  return `${occurred} 快速记录 ${quickRecord.id}：${compactText(quickRecord.rawContent)}`;
}

function syncCustomerFromQuickRecord(db, customerId, quickRecord, insight) {
  if (!customerId) return null;
  const current = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id", { $id: customerId }));
  if (!current) return null;

  const syncPreview = appendUnique(current.syncPreview, buildCustomerSyncPreview(quickRecord, insight)).slice(0, 8);
  const needs = appendUnique(current.needs, insight?.summary?.request?.text).slice(0, 8);
  const risks = appendUnique(current.risks, insight?.summary?.risk?.text).slice(0, 8);

  run(
    db,
    `UPDATE customers
     SET sync_preview = $syncPreview,
         needs = $needs,
         risks = $risks,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $id`,
    {
      $id: current.id,
      $syncPreview: json(syncPreview),
      $needs: json(needs),
      $risks: json(risks),
    },
  );

  return customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id", { $id: current.id }));
}

function syncOpportunityFromQuickRecord(db, opportunityId, quickRecord, insight) {
  if (!opportunityId) return null;
  const current = opportunityFromRow(get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: opportunityId }));
  if (!current) return null;

  const requirements = appendUnique(current.requirements, insight?.summary?.request?.text).slice(0, 8);
  const solutionDirection = appendUnique(current.solutionDirection, insight?.summary?.action?.text).slice(0, 8);

  run(
    db,
    `UPDATE opportunities
     SET requirements = $requirements,
         solution_direction = $solutionDirection,
         source_record = $sourceRecord,
         risk = COALESCE($risk, risk),
         next = COALESCE($next, next),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $id`,
    {
      $id: current.id,
      $requirements: json(requirements),
      $solutionDirection: json(solutionDirection),
      $sourceRecord: buildOpportunitySourceRecord(quickRecord),
      $risk: insight?.summary?.risk?.text ?? null,
      $next: insight?.summary?.action?.text ?? null,
    },
  );

  return opportunityFromRow(get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: current.id }));
}

function upsertActionFromQuickRecord(db, quickRecord, insight, customer, opportunity) {
  const customerName = customer?.name ?? opportunity?.customer ?? insight?.customer?.value ?? null;
  const actionText = insight?.summary?.action?.text ?? `跟进快速记录：${compactText(quickRecord.rawContent, 40)}`;
  const riskText = insight?.summary?.risk?.text;
  const priority = riskText ? "高" : "中";

  run(
    db,
    `INSERT INTO action_items (
       id, customer_id, opportunity_id, title, customer, reason, due,
       assignee, priority, status, source_record_id, tone
     ) VALUES (
       $id, $customerId, $opportunityId, $title, $customer, $reason, $due,
       $assignee, $priority, 'pending', $sourceRecordId, $tone
     )
     ON CONFLICT(source_record_id) DO UPDATE SET
       customer_id = excluded.customer_id,
       opportunity_id = excluded.opportunity_id,
       title = excluded.title,
       customer = excluded.customer,
       reason = excluded.reason,
       due = excluded.due,
       assignee = excluded.assignee,
       priority = excluded.priority,
       tone = excluded.tone,
       updated_at = CURRENT_TIMESTAMP`,
    {
      $id: randomUUID(),
      $customerId: customer?.id ?? opportunity?.customerId ?? insight?.customer?.id ?? quickRecord.customerId,
      $opportunityId: opportunity?.id ?? insight?.opportunity?.id ?? quickRecord.opportunityId,
      $title: compactText(actionText, 80),
      $customer: customerName,
      $reason: riskText || `来自快速记录 ${quickRecord.id} 的人工确认结果`,
      $due: "待确认",
      $assignee: "继振",
      $priority: priority,
      $sourceRecordId: quickRecord.id,
      $tone: priority === "高" ? "red" : "blue",
    },
  );

  return actionFromRow(get(db, "SELECT * FROM action_items WHERE source_record_id = $sourceRecordId", {
    $sourceRecordId: quickRecord.id,
  }));
}

function getDraftActions(db, { customerId, opportunityId }) {
  return all(
    db,
    `SELECT * FROM action_items
     WHERE customer_id = $customerId OR opportunity_id = $opportunityId
     ORDER BY
       CASE priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
       updated_at DESC`,
    {
      $customerId: customerId,
      $opportunityId: opportunityId,
    },
  ).map(actionFromRow);
}

function hasUsefulCompetitors(opportunity) {
  return (opportunity.competitors ?? []).some((item) => {
    const text = String(item ?? "").trim();
    return text && !/暂未明确|无|待确认/.test(text);
  });
}

function buildOpportunityRiskDrafts({ customer, opportunity, sourceType, sourceId }) {
  const text = [
    opportunity.amount,
    opportunity.risk,
    opportunity.next,
    customer.budget,
    ...(customer.risks ?? []),
    ...(opportunity.requirements ?? []),
    ...(opportunity.competitors ?? []),
    ...(opportunity.solutionDirection ?? []),
  ].join(" / ");
  const target = `${customer.name} / ${opportunity.name}`;
  const drafts = [];

  if (/预算|回款|金额|待定|规划类|审批/.test(text)) {
    drafts.push({
      title: "预算路径未确认",
      score: 86,
      severity: "高",
      evidence: `${target} 仍存在预算、金额或审批节奏不清的问题：${compactText(text, 96)}`,
      action: "下一次沟通必须确认预算来源、审批链、预计回款窗口和最终拍板人。",
      tone: "red",
    });
  }

  if (/移动云|数据自主权|平台封闭|数据导出|后台管理权/.test(text)) {
    drafts.push({
      title: "数据自主权与平台可控性风险",
      score: 82,
      severity: "高",
      evidence: `${target} 的沟通内容明确出现移动云体验、数据导出、后台管理权或平台封闭问题。`,
      action: "把客户反馈转成自建、本地稳态运行、混合灾备三类方案对比材料。",
      tone: "red",
    });
  }

  if (hasUsefulCompetitors(opportunity) || /竞争|金通|飞讯|宏杉|对手/.test(text)) {
    drafts.push({
      title: "竞争对手关系切入",
      score: 72,
      severity: "中",
      evidence: `${target} 已出现竞争方或替代方案信号：${compactText((opportunity.competitors ?? []).join("、") || text, 96)}`,
      action: "用架构图、调研深度、本地服务能力和案例背书建立差异化证据。",
      tone: "amber",
    });
  }

  if (/售前|调研|架构图|问题清单|方案材料/.test(text)) {
    drafts.push({
      title: "售前资源与材料未锁定",
      score: 64,
      severity: "中",
      evidence: `${target} 的下一步依赖售前、调研或方案材料，但责任人和交付物仍需明确。`,
      action: "锁定售前参与时间，形成调研问题清单、架构图输出模板和材料交付时间。",
      tone: "blue",
    });
  }

  if (drafts.length === 0) {
    drafts.push({
      title: "关键推进信息待补齐",
      score: 58,
      severity: "中",
      evidence: `${target} 尚未形成足够的预算、决策链、竞品和时间窗口证据。`,
      action: "补齐决策链、预算节奏、竞争关系和下一次明确动作。",
      tone: "amber",
    });
  }

  return drafts.map((draft) => ({
    ...draft,
    customerId: customer.id,
    opportunityId: opportunity.id,
    target,
    status: "open",
    sourceType,
    sourceId,
  }));
}

function upsertRiskItem(db, draft) {
  const current = riskFromRow(
    get(
      db,
      `SELECT * FROM risk_items
       WHERE opportunity_id = $opportunityId
         AND title = $title
         AND source_type = $sourceType
         AND COALESCE(source_id, '') = COALESCE($sourceId, '')
       LIMIT 1`,
      {
        $opportunityId: draft.opportunityId,
        $title: draft.title,
        $sourceType: draft.sourceType,
        $sourceId: draft.sourceId ?? null,
      },
    ),
  );

  if (current) {
    run(
      db,
      `UPDATE risk_items
       SET customer_id = $customerId,
           target = $target,
           score = $score,
           severity = $severity,
           status = $status,
           evidence = $evidence,
           action = $action,
           tone = $tone,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $id`,
      {
        $id: current.id,
        $customerId: draft.customerId,
        $target: draft.target,
        $score: draft.score,
        $severity: draft.severity,
        $status: draft.status,
        $evidence: draft.evidence,
        $action: draft.action,
        $tone: draft.tone,
      },
    );
    return riskFromRow(get(db, "SELECT * FROM risk_items WHERE id = $id", { $id: current.id }));
  }

  const id = randomUUID();
  run(
    db,
    `INSERT INTO risk_items (
       id, customer_id, opportunity_id, title, target, score, severity,
       status, evidence, action, source_type, source_id, tone
     ) VALUES (
       $id, $customerId, $opportunityId, $title, $target, $score, $severity,
       $status, $evidence, $action, $sourceType, $sourceId, $tone
     )`,
    {
      $id: id,
      $customerId: draft.customerId,
      $opportunityId: draft.opportunityId,
      $title: draft.title,
      $target: draft.target,
      $score: draft.score,
      $severity: draft.severity,
      $status: draft.status,
      $evidence: draft.evidence,
      $action: draft.action,
      $sourceType: draft.sourceType,
      $sourceId: draft.sourceId ?? null,
      $tone: draft.tone,
    },
  );

  return riskFromRow(get(db, "SELECT * FROM risk_items WHERE id = $id", { $id: id }));
}

function upsertRiskFromQuickRecord(db, quickRecord, insight, customer, opportunity) {
  const riskText = insight?.summary?.risk?.text;
  if (!riskText) return null;

  const customerName = customer?.name ?? opportunity?.customer ?? insight?.customer?.value ?? "未关联客户";
  const opportunityName = opportunity?.name ?? insight?.opportunity?.value ?? "未关联商机";
  return upsertRiskItem(db, {
    customerId: customer?.id ?? opportunity?.customerId ?? quickRecord.customerId,
    opportunityId: opportunity?.id ?? quickRecord.opportunityId,
    title: insight?.summary?.risk?.title ?? "快速记录识别风险",
    target: `${customerName} / ${opportunityName}`,
    score: /预算|移动云|数据自主权|决策/.test(riskText) ? 84 : 68,
    severity: /预算|移动云|数据自主权|决策/.test(riskText) ? "高" : "中",
    status: "open",
    evidence: `来自快速记录 ${quickRecord.id}：${riskText}`,
    action: insight?.summary?.action?.text ?? "由销售确认风险后补齐下一步动作。",
    sourceType: "quick_record",
    sourceId: quickRecord.id,
    tone: /预算|移动云|数据自主权|决策/.test(riskText) ? "red" : "amber",
  });
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean);
}

function hasLegacyBearerAuthConfiguration(config) {
  return Boolean(
    config.nodeEnv !== "production" &&
    config.authAccount &&
    config.authPassword &&
    config.authSessionSecret,
  );
}

function isAuthEnabled(config) {
  return Boolean(config.authRequired && hasLegacyBearerAuthConfiguration(config));
}

function isAuthMisconfigured(config) {
  return Boolean(config.authRequired && !hasLegacyBearerAuthConfiguration(config));
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function signAuthPayload(encodedPayload, config) {
  const secret = config.authSessionSecret || config.authPassword;
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function createAuthToken(config, now = Date.now()) {
  const expiresAt = now + authSessionTtlMs;
  const payload = Buffer.from(
    JSON.stringify({
      account: config.authAccount,
      expiresAt,
    }),
  ).toString("base64url");
  const signature = signAuthPayload(payload, config);
  return {
    account: config.authAccount,
    displayName: config.authAccount,
    token: `${payload}.${signature}`,
    expiresAt,
  };
}

function verifyAuthToken(token, config, now = Date.now()) {
  if (!isAuthEnabled(config) || typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expectedSignature = signAuthPayload(payload, config);
  if (!safeEqual(signature, expectedSignature)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed.account !== config.authAccount) return null;
    if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= now) return null;
    return { account: parsed.account, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function verifyWeixinAgentToken(token, config) {
  if (!config.weixinAgentApiToken || typeof token !== "string") return null;
  if (!safeEqual(token, config.weixinAgentApiToken)) return null;
  return { account: "weixin-agent", integration: "weixin-agent" };
}

function verifyAuthorizationHeader(header, config) {
  const value = String(header ?? "");
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return verifyAuthToken(match[1], config) ?? verifyWeixinAgentToken(match[1], config);
}

function authenticateLogin(config, body) {
  if (!isAuthEnabled(config)) return null;
  const account = String(body?.account ?? "").trim();
  const password = String(body?.password ?? "");
  if (!safeEqual(account, config.authAccount)) return null;
  if (!safeEqual(password, config.authPassword)) return null;
  return createAuthToken(config);
}

export function createServer(options = {}) {
  const config = loadConfig(options);
  const db = openDatabase({ databaseUrl: config.databaseUrl });
  if (options.seed) seedDatabase(db);
  const weixinLoginBinding = createWeixinLoginBinding({
    config,
    spawnLoginProcess: options.spawnWeixinLoginProcess,
    now: options.now,
  });

  const server = createHttpServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
    const parts = splitPath(url.pathname);

    try {
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        if (!isAuthEnabled(config)) {
          sendJson(response, 503, { error: "auth_not_configured", message: "登录账号尚未配置" });
          return;
        }
        const session = authenticateLogin(config, await readJson(request));
        if (!session) return unauthorized(response, "账号或密码错误");
        sendJson(response, 200, session);
        return;
      }

      if (
        isAuthMisconfigured(config) &&
        url.pathname.startsWith("/api/") &&
        url.pathname !== "/api/health"
      ) {
        sendJson(response, 503, {
          error: "auth_not_configured",
          message: "Authentication is required but not fully configured",
        });
        return;
      }

      if (
        isAuthEnabled(config) &&
        url.pathname.startsWith("/api/") &&
        url.pathname !== "/api/health" &&
        !verifyAuthorizationHeader(request.headers.authorization, config) &&
        !verifyAuthToken(url.searchParams.get("token"), config)
      ) {
        return unauthorized(response);
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        get(db, "SELECT 1 AS ready");
        sendJson(response, 200, {
          status: "ok",
          database: "ready",
          aiAnalysisMode: config.aiAnalysisMode,
          modelProvider: config.modelProvider,
          modelName: config.modelName,
          modelReady: config.aiAnalysisMode === "model" && Boolean(config.modelApiKey),
          authEnabled: isAuthEnabled(config),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/dashboard/summary") {
        sendJson(response, 200, { item: dashboardSummaryFromDb(db) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/audit-logs") {
        sendJson(response, 200, { items: listAuditLogs(db, url.searchParams) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/integrations/weixin-agent/login") {
        sendJson(response, 200, { item: weixinLoginBinding.current() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/integrations/weixin-agent/login") {
        sendJson(response, 201, { item: weixinLoginBinding.start() });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/integrations/weixin-agent/login") {
        sendJson(response, 200, { item: weixinLoginBinding.stop() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/customers") {
        const rows = all(db, "SELECT * FROM customers ORDER BY created_at ASC");
        sendJson(response, 200, { items: rows.map(customerFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/customers") {
        const body = await readJson(request);
        if (!body.name) return badRequest(response, "name is required");
        const item = createCustomer(db, body);
        recordAuditLog(db, {
          action: "customer.create",
          entityType: "customer",
          entityId: item.id,
          actor: item.owner,
          metadata: { name: item.name, region: item.region, level: item.level },
        });
        sendJson(response, 201, { item });
        return;
      }

      if (request.method === "GET" && parts[0] === "api" && parts[1] === "customers" && parts[2]) {
        const item = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id", { $id: parts[2] }));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "customers" && parts[2]) {
        const body = await readJson(request);
        const item = updateCustomer(db, parts[2], body);
        if (!item) return notFound(response);
        recordAuditLog(db, {
          action: "customer.update",
          entityType: "customer",
          entityId: item.id,
          actor: item.owner,
          metadata: { changedFields: Object.keys(body) },
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "customers" && parts[2]) {
        const deleted = deleteRecord(db, {
          table: "customers",
          id: parts[2],
          fromRow: customerFromRow,
        });
        if (!deleted) return notFound(response);
        recordAuditLog(db, {
          action: "customer.delete",
          entityType: "customer",
          entityId: deleted.id,
          actor: deleted.owner,
          metadata: { name: deleted.name, region: deleted.region, level: deleted.level },
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/opportunities") {
        const rows = all(db, "SELECT * FROM opportunities ORDER BY created_at ASC");
        sendJson(response, 200, { items: rows.map(opportunityFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/opportunities") {
        const body = await readJson(request);
        if (!body.name || !body.customerId) return badRequest(response, "name and customerId are required");
        const item = createOpportunity(db, body);
        recordAuditLog(db, {
          action: "opportunity.create",
          entityType: "opportunity",
          entityId: item.id,
          actor: item.owner,
          metadata: { name: item.name, customerId: item.customerId, stage: item.stage },
        });
        sendJson(response, 201, { item });
        return;
      }

      if (request.method === "GET" && parts[0] === "api" && parts[1] === "opportunities" && parts[2]) {
        const item = opportunityFromRow(get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: parts[2] }));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "opportunities" && parts[2]) {
        const body = await readJson(request);
        const item = updateOpportunity(db, parts[2], body);
        if (!item) return notFound(response);
        recordAuditLog(db, {
          action: "opportunity.update",
          entityType: "opportunity",
          entityId: item.id,
          actor: item.owner,
          metadata: { changedFields: Object.keys(body), stage: item.stage, probability: item.probability },
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "opportunities" && parts[2]) {
        const deleted = deleteRecord(db, {
          table: "opportunities",
          id: parts[2],
          fromRow: opportunityFromRow,
        });
        if (!deleted) return notFound(response);
        recordAuditLog(db, {
          action: "opportunity.delete",
          entityType: "opportunity",
          entityId: deleted.id,
          actor: deleted.owner,
          metadata: { name: deleted.name, customerId: deleted.customerId, stage: deleted.stage },
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/actions") {
        const rows = all(
          db,
          `SELECT * FROM action_items
           ORDER BY
             CASE priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
             updated_at DESC`,
        );
        sendJson(response, 200, { items: rows.map(actionFromRow) });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "actions" && parts[2]) {
        const body = await readJson(request);
        const item = updateActionItem(db, parts[2], body);
        if (!item) return notFound(response);
        if (item.error === "invalid_status") return badRequest(response, "status must be pending, in_progress, done, or deferred");
        recordAuditLog(db, {
          action: "action.update",
          entityType: "action",
          entityId: item.id,
          actor: item.assignee,
          metadata: { status: item.status, due: item.due, changedFields: Object.keys(body) },
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "actions" && parts[2]) {
        const deleted = deleteRecord(db, {
          table: "action_items",
          id: parts[2],
          fromRow: actionFromRow,
        });
        if (!deleted) return notFound(response);
        recordAuditLog(db, {
          action: "action.delete",
          entityType: "action",
          entityId: deleted.id,
          actor: deleted.assignee,
          metadata: { title: deleted.title, customerId: deleted.customerId, status: deleted.status },
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/risks") {
        const rows = all(
          db,
          `SELECT * FROM risk_items
           ORDER BY
             CASE severity WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
             score DESC,
             updated_at DESC`,
        );
        sendJson(response, 200, { items: rows.map(riskFromRow) });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "risks" && parts[2]) {
        const body = await readJson(request);
        const item = updateRiskItem(db, parts[2], body);
        if (!item) return notFound(response);
        if (item.error === "invalid_status") return badRequest(response, "status must be open, accepted, in_progress, deferred, or closed");
        recordAuditLog(db, {
          action: "risk.update",
          entityType: "risk",
          entityId: item.id,
          actor: item.assignee,
          metadata: { status: item.status, due: item.due, changedFields: Object.keys(body) },
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "risks" && parts[2]) {
        const deleted = deleteRecord(db, {
          table: "risk_items",
          id: parts[2],
          fromRow: riskFromRow,
        });
        if (!deleted) return notFound(response);
        recordAuditLog(db, {
          action: "risk.delete",
          entityType: "risk",
          entityId: deleted.id,
          actor: deleted.assignee,
          metadata: { title: deleted.title, status: deleted.status, sourceType: deleted.sourceType },
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/knowledge") {
        const rows = all(db, "SELECT * FROM knowledge_items ORDER BY updated_at DESC, title ASC");
        sendJson(response, 200, { items: rows.map(knowledgeFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/knowledge") {
        const body = await readJson(request);
        if (!String(body.title ?? "").trim()) return badRequest(response, "title is required");
        const item = createKnowledgeItem(db, {
          ...body,
          title: String(body.title).trim(),
        });
        recordAuditLog(db, {
          action: "knowledge.create",
          entityType: "knowledge",
          entityId: item.id,
          metadata: { title: item.title, category: item.category, tags: item.tags },
        });
        sendJson(response, 201, { item });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "knowledge" && parts[2]) {
        const body = await readJson(request);
        const item = updateKnowledgeItem(db, parts[2], body);
        if (!item) return notFound(response);
        recordAuditLog(db, {
          action: "knowledge.update",
          entityType: "knowledge",
          entityId: item.id,
          metadata: { changedFields: Object.keys(body), title: item.title },
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "knowledge" && parts[2]) {
        const deleted = deleteRecord(db, {
          table: "knowledge_items",
          id: parts[2],
          fromRow: knowledgeFromRow,
        });
        if (!deleted) return notFound(response);
        recordAuditLog(db, {
          action: "knowledge.delete",
          entityType: "knowledge",
          entityId: deleted.id,
          metadata: { title: deleted.title, category: deleted.category },
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/knowledge/search") {
        const body = await readJson(request);
        const items = searchKnowledgeItems(db, {
          query: body.query,
          tags: body.tags,
          limit: body.limit,
        });
        sendJson(response, 200, { items });
        return;
      }

      if (
        request.method === "POST" &&
        parts[0] === "api" &&
        parts[1] === "opportunities" &&
        parts[2] &&
        parts[3] === "diagnose-risks"
      ) {
        const opportunity = opportunityFromRow(
          get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: parts[2] }),
        );
        if (!opportunity) return notFound(response);

        const customer = customerFromRow(
          get(db, "SELECT * FROM customers WHERE id = $id", { $id: opportunity.customerId }),
        );
        if (!customer) return notFound(response);

        const body = await readJson(request);
        const sourceType = body.sourceType ?? "opportunity_diagnosis";
        const sourceId = body.sourceId ?? opportunity.id;
        const items = buildOpportunityRiskDrafts({
          customer,
          opportunity,
          sourceType,
          sourceId,
        }).map((draft) => upsertRiskItem(db, draft));

        for (const item of items) {
          recordAuditLog(db, {
            action: "risk.diagnose",
            entityType: "risk",
            entityId: item.id,
            metadata: {
              customerId: item.customerId,
              opportunityId: item.opportunityId,
              sourceType: item.sourceType,
              sourceId: item.sourceId,
            },
          });
        }
        sendJson(response, 201, { items });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/quick-records") {
        const rows = all(db, "SELECT * FROM quick_records ORDER BY created_at DESC");
        sendJson(response, 200, { items: rows.map(quickRecordFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/quick-records/preview") {
        const body = await readJson(request);
        const rawContent = String(body.rawContent ?? "").trim();
        if (!rawContent) return badRequest(response, "rawContent is required");

        const analysis = await analyzeQuickRecord(rawContent, config, {
          fetchImpl: options.fetchImpl,
        });
        if (!analysis) return badRequest(response, "quick record content is empty");

        sendJson(response, 200, {
          item: {
            id: `preview-${randomUUID()}`,
            quickRecordId: "preview",
            ...analysis,
          },
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/quick-records") {
        const body = await readJson(request);
        const rawContent = String(body.rawContent ?? "").trim();
        if (!rawContent) return badRequest(response, "rawContent is required");

        const id = randomUUID();
        run(
          db,
          `INSERT INTO quick_records (
            id, raw_content, occurred_at, source_channel, customer_id, opportunity_id
          ) VALUES (
            $id, $rawContent, $occurredAt, $sourceChannel, $customerId, $opportunityId
          )`,
          {
            $id: id,
            $rawContent: rawContent,
            $occurredAt: body.occurredAt ?? null,
            $sourceChannel: body.sourceChannel ?? "快速记录",
            $customerId: body.customerId ?? null,
            $opportunityId: body.opportunityId ?? null,
          },
        );
        const item = quickRecordFromRow(get(db, "SELECT * FROM quick_records WHERE id = $id", { $id: id }));
        sendJson(response, 201, { item });
        return;
      }

      if (
        request.method === "POST" &&
        parts[0] === "api" &&
        parts[1] === "quick-records" &&
        parts[2] &&
        parts[3] === "analyze"
      ) {
        const quickRecord = quickRecordFromRow(
          get(db, "SELECT * FROM quick_records WHERE id = $id", { $id: parts[2] }),
        );
        if (!quickRecord) return notFound(response);

        const analysis = await analyzeQuickRecord(quickRecord.rawContent, config, {
          fetchImpl: options.fetchImpl,
        });
        if (!analysis) return badRequest(response, "quick record content is empty");

        const id = randomUUID();
        run(
          db,
          `INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
           VALUES ($id, $quickRecordId, $source, $confidence, $analysisJson)`,
          {
            $id: id,
            $quickRecordId: quickRecord.id,
            $source: analysis.source,
            $confidence: analysis.confidence ?? 70,
            $analysisJson: JSON.stringify(analysis),
          },
        );
        run(db, "UPDATE quick_records SET status = 'analyzed', updated_at = CURRENT_TIMESTAMP WHERE id = $id", {
          $id: quickRecord.id,
        });

        sendJson(response, 201, { item: getLatestInsight(db, quickRecord.id) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/ai/suggestions") {
        const body = await readJson(request);
        const type = String(body.type ?? "").trim();
        const title = String(body.title ?? "").trim();
        if (!type || !title) return badRequest(response, "type and title are required");

        const suggestion = await generateManualSuggestion(
          {
            type,
            title,
            context: body.context && typeof body.context === "object" ? body.context : {},
          },
          config,
          { fetchImpl: options.fetchImpl },
        );
        const id = randomUUID();
        run(
          db,
          `INSERT INTO ai_suggestions (id, type, title, status, content, source_refs)
           VALUES ($id, $type, $title, $status, $content, $sourceRefs)`,
          {
            $id: id,
            $type: suggestion.type,
            $title: suggestion.title,
            $status: suggestion.status,
            $content: suggestion.content,
            $sourceRefs: JSON.stringify(suggestion.sourceRefs),
          },
        );

        const item = aiSuggestionFromRow(get(db, "SELECT * FROM ai_suggestions WHERE id = $id", { $id: id }));
        recordAuditLog(db, {
          action: "ai.suggestion.generate",
          entityType: "ai_suggestion",
          entityId: item.id,
          metadata: {
            type: item.type,
            title: item.title,
            sourceRefs: item.sourceRefs.length,
          },
        });
        sendJson(response, 201, { item });
        return;
      }

      if (
        request.method === "POST" &&
        parts[0] === "api" &&
        parts[1] === "quick-records" &&
        parts[2] &&
        parts[3] === "confirm"
      ) {
        const quickRecord = quickRecordFromRow(
          get(db, "SELECT * FROM quick_records WHERE id = $id", { $id: parts[2] }),
        );
        if (!quickRecord) return notFound(response);

        const body = await readJson(request);
        const targets = Array.from(new Set(body.targets ?? []));
        const allowed = new Set(["customer", "opportunity", "weekly"]);
        if (targets.length === 0 || targets.some((target) => !allowed.has(target))) {
          return badRequest(response, "targets must include customer, opportunity, or weekly");
        }

        const insight = getLatestInsight(db, quickRecord.id);
        for (const target of targets) {
          run(
            db,
            `INSERT INTO manual_confirmations (id, quick_record_id, target, confirmed_by, note)
             VALUES ($id, $quickRecordId, $target, $confirmedBy, $note)
             ON CONFLICT(quick_record_id, target) DO UPDATE SET
               confirmed_by = excluded.confirmed_by,
               note = excluded.note,
               created_at = CURRENT_TIMESTAMP`,
            {
              $id: randomUUID(),
              $quickRecordId: quickRecord.id,
              $target: target,
              $confirmedBy: body.confirmedBy ?? null,
              $note: body.note ?? null,
            },
          );
        }

        const nextCustomerId = targets.includes("customer") ? insight?.customer?.id ?? quickRecord.customerId : quickRecord.customerId;
        const nextOpportunityId = targets.includes("opportunity")
          ? insight?.opportunity?.id ?? quickRecord.opportunityId
          : quickRecord.opportunityId;

        run(
          db,
          `UPDATE quick_records
           SET status = 'confirmed',
               customer_id = $customerId,
               opportunity_id = $opportunityId,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $id`,
          {
            $id: quickRecord.id,
            $customerId: nextCustomerId ?? null,
            $opportunityId: nextOpportunityId ?? null,
          },
        );

        const confirmations = all(
          db,
          "SELECT * FROM manual_confirmations WHERE quick_record_id = $quickRecordId ORDER BY target ASC",
          { $quickRecordId: quickRecord.id },
        ).map(confirmationFromRow);
        const updatedRecord = quickRecordFromRow(get(db, "SELECT * FROM quick_records WHERE id = $id", { $id: quickRecord.id }));
        const updatedCustomer = targets.includes("customer")
          ? syncCustomerFromQuickRecord(db, nextCustomerId, updatedRecord, insight)
          : null;
        const updatedOpportunity = targets.includes("opportunity")
          ? syncOpportunityFromQuickRecord(db, nextOpportunityId, updatedRecord, insight)
          : null;
        const action = targets.some((target) => target === "customer" || target === "opportunity")
          ? upsertActionFromQuickRecord(db, updatedRecord, insight, updatedCustomer, updatedOpportunity)
          : null;
        const risk = targets.some((target) => target === "customer" || target === "opportunity")
          ? upsertRiskFromQuickRecord(db, updatedRecord, insight, updatedCustomer, updatedOpportunity)
          : null;

        recordAuditLog(db, {
          action: "quick_record.confirm",
          entityType: "quick_record",
          entityId: updatedRecord.id,
          actor: body.confirmedBy ?? null,
          metadata: {
            targets,
            customerId: updatedRecord.customerId,
            opportunityId: updatedRecord.opportunityId,
          },
        });
        sendJson(response, 201, {
          confirmations,
          quickRecord: updatedRecord,
          ...(updatedCustomer ? { customer: updatedCustomer } : {}),
          ...(updatedOpportunity ? { opportunity: updatedOpportunity } : {}),
          ...(action ? { action } : {}),
          ...(risk ? { risk } : {}),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reports/weekly/draft") {
        const body = await readJson(request);
        if (!body.owner || !body.periodStart || !body.periodEnd) {
          return badRequest(response, "owner, periodStart, and periodEnd are required");
        }
        const knowledgeIds = normalizeKnowledgeIds(body.knowledgeIds);
        if (knowledgeIds === null) {
          return badRequest(response, "knowledgeIds must be an array when provided");
        }
        const knowledge = getKnowledgeItemsByIds(db, knowledgeIds);
        if (knowledge.length !== knowledgeIds.length) {
          return badRequest(response, "knowledgeIds must reference existing knowledge items");
        }

        const rows = all(
          db,
          `SELECT qr.*, ai.analysis_json
           FROM quick_records qr
           JOIN manual_confirmations mc ON mc.quick_record_id = qr.id AND mc.target = 'weekly'
           LEFT JOIN ai_insights ai ON ai.quick_record_id = qr.id
           WHERE date(substr(COALESCE(qr.occurred_at, qr.created_at), 1, 10))
             BETWEEN date($periodStart) AND date($periodEnd)
           GROUP BY qr.id
           ORDER BY COALESCE(qr.occurred_at, qr.created_at) ASC`,
          {
            $periodStart: body.periodStart,
            $periodEnd: body.periodEnd,
          },
        );

        const records = rows.map((row) => ({
          ...quickRecordFromRow(row),
          analysis: parseJson(row.analysis_json, null),
        }));
        const fallbackDraft = buildWeeklyDraft({
          owner: body.owner,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          records,
          knowledge,
        });
        const draft = await enhanceWeeklyDraftWithModel(
          fallbackDraft,
          {
            owner: body.owner,
            periodStart: body.periodStart,
            periodEnd: body.periodEnd,
            records,
            knowledge,
          },
          config,
          { fetchImpl: options.fetchImpl },
        );

        const id = randomUUID();
        run(
          db,
          `INSERT INTO weekly_reports (id, owner, period_start, period_end, status, content, source_refs)
           VALUES ($id, $owner, $periodStart, $periodEnd, 'draft', $content, $sourceRefs)`,
          {
            $id: id,
            $owner: body.owner,
            $periodStart: body.periodStart,
            $periodEnd: body.periodEnd,
            $content: draft.content,
            $sourceRefs: JSON.stringify(draft.sourceRefs),
          },
        );

        const item = weeklyReportFromRow(get(db, "SELECT * FROM weekly_reports WHERE id = $id", { $id: id }));
        recordAuditLog(db, {
          action: "weekly_report.draft",
          entityType: "weekly_report",
          entityId: item.id,
          actor: item.owner,
          metadata: {
            periodStart: item.periodStart,
            periodEnd: item.periodEnd,
            sourceRefs: item.sourceRefs.length,
            knowledgeIds,
          },
        });
        sendJson(response, 201, { item });
        return;
      }

      if (
        request.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "reports" &&
        parts[2] === "weekly" &&
        parts[3] &&
        parts[4] === "export"
      ) {
        const item = weeklyReportFromRow(get(db, "SELECT * FROM weekly_reports WHERE id = $id", { $id: parts[3] }));
        if (!item) return notFound(response);
        const format = url.searchParams.get("format") ?? "word";
        if (format !== "word") return badRequest(response, "format must be word");
        const fileName = `weekly-report-${item.periodStart}-${item.periodEnd}.doc`;
        sendDocument(response, 200, buildWeeklyWordDocument(item), {
          "Content-Type": "application/msword; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        });
        return;
      }

      if (
        request.method === "PATCH" &&
        parts[0] === "api" &&
        parts[1] === "reports" &&
        parts[2] === "weekly" &&
        parts[3]
      ) {
        const body = await readJson(request);
        const item = updateWeeklyReport(db, parts[3], body);
        if (!item) return notFound(response);
        if (item.error === "invalid_status") return badRequest(response, "status must be draft, saved, or ready");
        recordAuditLog(db, {
          action: "weekly_report.update",
          entityType: "weekly_report",
          entityId: item.id,
          actor: item.owner,
          metadata: { status: item.status, changedFields: Object.keys(body) },
        });
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "reports" &&
        parts[2] === "weekly" &&
        parts[3]
      ) {
        const item = weeklyReportFromRow(get(db, "SELECT * FROM weekly_reports WHERE id = $id", { $id: parts[3] }));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/solutions/draft") {
        const body = await readJson(request);
        if (!body.owner || !body.customerId || !body.opportunityId) {
          return badRequest(response, "owner, customerId, and opportunityId are required");
        }
        const artifactType = body.artifactType === undefined
          ? "solution_framework"
          : String(body.artifactType);
        if (!isSolutionArtifactType(artifactType)) {
          return badRequest(response, "artifactType must be communication_outline, presales_questions, solution_framework, report_outline, or competitive_talk");
        }
        const knowledgeIds = normalizeKnowledgeIds(body.knowledgeIds);
        if (knowledgeIds === null) {
          return badRequest(response, "knowledgeIds must be an array when provided");
        }

        const customer = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id", { $id: body.customerId }));
        const opportunity = opportunityFromRow(get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: body.opportunityId }));
        if (!customer || !opportunity) return notFound(response);
        const selectedKnowledge = getKnowledgeItemsByIds(db, knowledgeIds);
        if (selectedKnowledge.length !== knowledgeIds.length) {
          return badRequest(response, "knowledgeIds must reference existing knowledge items");
        }

        const actions = getDraftActions(db, {
          customerId: customer.id,
          opportunityId: opportunity.id,
        });
        const autoKnowledge = searchKnowledgeItems(db, {
          query: [
            customer.name,
            customer.summary,
            ...(customer.needs ?? []),
            opportunity.name,
            opportunity.stage,
            ...(opportunity.requirements ?? []),
            ...(opportunity.competitors ?? []),
            ...(opportunity.solutionDirection ?? []),
          ].join(" "),
          limit: 4,
        });
        const knowledge = mergeKnowledgeItems(selectedKnowledge, autoKnowledge).slice(0, 8);
        const fallbackDraft = buildSolutionDraft({
          owner: body.owner,
          customer,
          opportunity,
          actions,
          knowledge,
          artifactType: normalizeSolutionArtifactType(artifactType),
        });
        const draft = await enhanceSolutionDraftWithModel(
          fallbackDraft,
          {
            owner: body.owner,
            artifactType: fallbackDraft.artifactType,
            customer,
            opportunity,
            actions,
            knowledge,
          },
          config,
          { fetchImpl: options.fetchImpl },
        );

        const id = randomUUID();
        run(
          db,
          `INSERT INTO solution_drafts (
             id, owner, artifact_type, title, customer_id, opportunity_id, status, content, source_refs
           ) VALUES (
             $id, $owner, $artifactType, $title, $customerId, $opportunityId, 'draft', $content, $sourceRefs
           )`,
          {
            $id: id,
            $owner: body.owner,
            $artifactType: draft.artifactType ?? fallbackDraft.artifactType,
            $title: draft.title,
            $customerId: customer.id,
            $opportunityId: opportunity.id,
            $content: draft.content,
            $sourceRefs: JSON.stringify(draft.sourceRefs),
          },
        );

        const item = solutionDraftFromRow(get(db, "SELECT * FROM solution_drafts WHERE id = $id", { $id: id }));
        recordAuditLog(db, {
          action: "solution_draft.generate",
          entityType: "solution_draft",
          entityId: item.id,
          actor: item.owner,
          metadata: {
            customerId: item.customerId,
            opportunityId: item.opportunityId,
            artifactType: item.artifactType,
            sourceRefs: item.sourceRefs.length,
            knowledgeIds,
          },
        });
        sendJson(response, 201, { item });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "solutions" && parts[2]) {
        const existing = solutionDraftFromRow(get(db, "SELECT * FROM solution_drafts WHERE id = $id", { $id: parts[2] }));
        if (!existing) return notFound(response);
        const body = await readJson(request);
        const status = body.status ?? existing.status;
        if (!["draft", "saved", "ready"].includes(status)) {
          return badRequest(response, "status must be draft, saved, or ready");
        }
        run(
          db,
          `UPDATE solution_drafts
             SET title = $title,
                 content = $content,
                 status = $status,
                 updated_at = CURRENT_TIMESTAMP
           WHERE id = $id`,
          {
            $id: existing.id,
            $title: body.title ?? existing.title,
            $content: body.content ?? existing.content,
            $status: status,
          },
        );
        const item = solutionDraftFromRow(get(db, "SELECT * FROM solution_drafts WHERE id = $id", { $id: existing.id }));
        recordAuditLog(db, {
          action: "solution_draft.update",
          entityType: "solution_draft",
          entityId: item.id,
          actor: item.owner,
          metadata: {
            status: item.status,
            artifactType: item.artifactType,
            changedFields: Object.keys(body),
          },
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "GET" && parts[0] === "api" && parts[1] === "solutions" && parts[2]) {
        const item = solutionDraftFromRow(get(db, "SELECT * FROM solution_drafts WHERE id = $id", { $id: parts[2] }));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      notFound(response);
    } catch (error) {
      if (error instanceof SyntaxError) {
        badRequest(response, "invalid JSON body");
        return;
      }
      sendJson(response, 500, { error: "internal_error", message: error.message });
    }
  });

  server.on("close", () => db.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`Backend listening on http://${config.host}:${config.port}`);
  });
}
