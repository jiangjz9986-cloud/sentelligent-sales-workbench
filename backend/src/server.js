import { createHash, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

import { insertAudit } from "./audit/auditRepository.js";
import {
  authenticateMachineRequest,
  assertMachineRouteAllowed,
} from "./auth/machineAuthorization.js";
import {
  assertLoginAllowed,
  clearLoginFailures,
  loginRateLimitKey,
  pruneLoginRateLimits,
  recordLoginFailure,
} from "./auth/loginRateLimit.js";
import { validatePasswordHashEncoding, verifyPassword } from "./auth/password.js";
import {
  createCsrfToken,
  createSession,
  getActiveSession,
  revokeSession,
} from "./auth/session.js";
import { loadConfig } from "./config.js";
import { all, get, openDatabase, run } from "./db.js";
import { createDatabaseIdentity } from "./db/databaseIdentity.js";
import { withImmediateTransaction } from "./db/transaction.js";
import { buildSalesDecisionInputSnapshot } from "./ai/agents/salesDecisionAgent.js";
import { createSalesDecisionRepository } from "./ai/agents/salesDecisionRepository.js";
import {
  ItineraryNotFoundError,
  ItineraryVersionConflictError,
  createVisitItineraryRepository,
} from "./itinerary/repository.js";
import {
  TravelExpenseDependencyConflictError,
  TravelExpenseNotFoundError,
  TravelExpenseVersionConflictError,
  createTravelExpenseRepository,
} from "./travelExpense/repository.js";
import { analyzeExpenseText } from "./travelExpense/ingestionAnalysis.js";
import { analyzeInvoiceText } from "./travelExpense/invoiceTextAnalysis.js";
import { createTravelExpenseIngestionRepository } from "./travelExpense/ingestionRepository.js";
import {
  recognizeInvoiceDocument,
  validateDocumentFileName,
} from "./travelExpense/invoiceRecognition.js";
import {
  createLocalDocumentTextExtractor,
  probeLocalDocumentTextTools,
} from "./travelExpense/localDocumentTextExtractor.js";
import {
  DocumentInboxDuplicateError,
  DocumentInboxNotFoundError,
  DocumentInboxStateConflictError,
  DocumentInboxVersionConflictError,
  createTravelExpenseDocumentInboxRepository,
} from "./travelExpense/documentInboxRepository.js";
import {
  analyzePaymentProofText,
  recognizePaymentProofDocument,
} from "./travelExpense/paymentProofRecognition.js";
import {
  InvoiceDuplicateError,
  InvoiceMatchConflictError,
  InvoiceNotFoundError,
  InvoiceVersionConflictError,
  createInvoiceRepository,
} from "./travelExpense/invoiceRepository.js";
import { withDocumentBlobWritePreflight } from "./travelExpense/documentBlobStore.js";
import {
  validateTravelExpenseAdvancePayload,
  validateTravelExpenseAttachmentPayload,
  validateTravelExpensePayload,
  validateTravelExpenseWeekStart,
} from "./travelExpense/validation.js";
import {
  authenticateIcostWebhook,
  createFixedWindowLimiter,
  isIcostWebhookRouteAllowed,
  validateIcostTextPayload,
} from "./integrations/icostWebhook.js";
import { planVisitItinerary } from "./itinerary/planner.js";
import { AmapServiceError, createAmapClient } from "./maps/amapClient.js";
import {
  claimIdempotency,
  completeIdempotency,
  parseIdempotencyKey,
  releaseIdempotencyClaim,
  requestHash,
} from "./services/idempotency.js";
import { HttpError } from "./http/errors.js";
import { Base64DecodingError, decodeCanonicalBase64 } from "./http/strictBase64.js";
import { readJsonBody } from "./http/request.js";
import {
  sendDocument as sendHttpDocument,
  sendError as sendHttpError,
  sendJson as sendHttpJson,
} from "./http/response.js";
import {
  assertCsrfToken,
  buildSessionCookie,
  constantTimeEqual,
  corsHeaders,
  parseCookies,
} from "./http/security.js";
import {
  analyzeQuickRecord,
  analyzeSalesDecision,
  enhanceSolutionDraftWithModel,
  enhanceWeeklyDraftWithModel,
  generateManualSuggestion,
} from "./modelAnalysis.js";
import { seedDatabase } from "./seed.js";
import {
  buildSolutionDraft,
  normalizeSolutionArtifactType,
} from "./solutionDraft.js";
import { createWeixinLoginBinding } from "./weixin/loginBinding.js";
import { createAssistantEventRepository } from "./assistant/eventRepository.js";
import { createAssistantSessionRepository } from "./assistant/sessionRepository.js";
import { createAssistantPendingActionRepository } from "./assistant/pendingActionRepository.js";
import { createAssistantOrchestrator } from "./assistant/orchestrator.js";
import { createAssistantToolHandlers } from "./assistant/runtimeHandlers.js";
import { assertWeixinSenderAllowed, validateWeixinAssistantEvent } from "./assistant/weixinEvent.js";
import { buildWeeklyDraft } from "./weeklyDraft.js";
import { createHospitalTenderRepository } from "./hospitalTender/repository.js";
import { createSecureSettingsRepository, DEEPSEEK_SETTING_KEY, ICOST_SETTING_KEY } from "./settings/repository.js";
import { isValidSettingsEncryptionKey } from "./settings/secretBox.js";
import {
  ingestHospitalTenderSnapshot,
  normalizeHospitalTenderSyncPayload,
  serializeHospitalTenderNotice,
  serializeHospitalTenderSource,
} from "./hospitalTender/sync.js";
import { createInternalHospitalTenderRunner } from "./hospitalTender/internalRunner.js";
import {
  partialSchema,
  requestSchemas,
  validateVisitItineraryRequest,
  validateObject,
} from "./validation/requests.js";

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

const responseContextSymbol = Symbol("responseContext");
const requestConfigSymbol = Symbol("requestConfig");
const TRAVEL_EXPENSE_ATTACHMENT_JSON_MAX_BYTES = 17 * 1024 * 1024;
const INVOICE_UPLOAD_JSON_MAX_BYTES = 17 * 1024 * 1024;
const DOCUMENT_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;
const DOCUMENT_INBOX_EXTRACTED_TEXT_MAX_LENGTH = 200_000;
const EXTRACTED_TEXT_TRUNCATED_WARNING = "EXTRACTED_TEXT_TRUNCATED";
const ICOST_EXPENSE_ROUTE = "/api/integrations/icost/expenses";
const WEIXIN_ASSISTANT_EVENT_ROUTE = "/api/integrations/weixin-agent/events";

function boundPaymentProofRecognition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (typeof value.extractedText !== "string") return value;
  const extractedText = value.extractedText.trim();
  if (extractedText.length <= DOCUMENT_INBOX_EXTRACTED_TEXT_MAX_LENGTH) return value;
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  return {
    ...value,
    extractedText: extractedText.slice(0, DOCUMENT_INBOX_EXTRACTED_TEXT_MAX_LENGTH),
    warnings: [...new Set([...warnings, EXTRACTED_TEXT_TRUNCATED_WARNING])],
  };
}

function modelCompletionUrl(baseUrl) {
  return `${String(baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "")}/chat/completions`;
}

function createExpenseModelClient(config, fetchImpl) {
  if (config.aiAnalysisMode !== "model") return null;
  return async ({ signal, ...request }) => {
    const apiKey = resolveRuntimeModelApiKey(config);
    if (!apiKey) throw new Error("model_not_configured");
    return fetchImpl(modelCompletionUrl(config.modelBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
      signal,
    });
  };
}

function resolveRuntimeModelApiKey(config) {
  if (typeof config.modelApiKeyProvider === "function") {
    return String(config.modelApiKeyProvider() ?? "");
  }
  return String(config.modelApiKey ?? "");
}

function icostResponseItem(item, replayed) {
  return {
    id: item.id,
    status: item.status,
    warnings: item.warnings,
    expenseId: item.expenseId,
    paymentId: item.paymentId,
    expenseReferenceCode: item.expenseReferenceCode,
    replayed,
  };
}

function plainObject(value, field = "body") {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    validationFailure(field, "object");
  }
  return value;
}

function allowedPayloadKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) validationFailure(key, "unknown");
  }
}

function payloadText(value, field, { optional = false, max = 5000 } = {}) {
  if ((value === undefined || value === null || value === "") && optional) return null;
  if (typeof value !== "string" || !value.trim()) validationFailure(field, "required");
  const normalized = value.trim();
  if (normalized.length > max) validationFailure(field, "max");
  return normalized;
}

function payloadPositiveCents(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) validationFailure(field, "positiveInteger");
  return value;
}

function payloadOptionalPositiveCents(value, field) {
  if (value === undefined || value === null || value === "") return null;
  return payloadPositiveCents(value, field);
}

function payloadDateOnly(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    validationFailure(field, "date");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) {
    validationFailure(field, "date");
  }
  return value;
}

function payloadTime(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    validationFailure(field, "time");
  }
  return value;
}

function decodeStrictBase64(value, field = "contentBase64") {
  try {
    return decodeCanonicalBase64(value, { maxDecodedBytes: DOCUMENT_UPLOAD_MAX_BYTES });
  } catch (error) {
    if (error instanceof Base64DecodingError) validationFailure(field, error.reason);
    throw error;
  }
}

function payloadFileName(value, field = "fileName") {
  try {
    return validateDocumentFileName(value);
  } catch {
    validationFailure(field, "invalid");
  }
}

function encodeContentDispositionFileName(fileName) {
  return encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => (
    `%${character.codePointAt(0).toString(16).toUpperCase()}`
  ));
}

function inlineContentDisposition(fileName) {
  return `inline; filename*=UTF-8''${encodeContentDispositionFileName(fileName)}`;
}

function validateInvoiceUploadPayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set(["fileName", "mediaType", "contentBase64", "sourceRef"]));
  return {
    fileName: payloadFileName(body.fileName),
    mediaType: payloadText(body.mediaType, "mediaType", { max: 100 }),
    content: decodeStrictBase64(body.contentBase64),
    sourceRef: payloadText(body.sourceRef, "sourceRef", { optional: true, max: 500 }),
  };
}

function validateTravelExpenseDocumentInboxPayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set([
    "expenseReferenceCode",
    "fileName",
    "mediaType",
    "contentBase64",
    "sourceRef",
    "textHint",
    "amountCents",
    "occurredOn",
    "paidTime",
    "matchMode",
  ]));
  const expenseReferenceCode = payloadText(
    body.expenseReferenceCode,
    "expenseReferenceCode",
    { optional: true, max: 200 },
  );
  const matchMode = payloadText(body.matchMode, "matchMode", { max: 50 });
  if (!new Set(["candidates_only", "expense_reference"]).has(matchMode)) {
    validationFailure("matchMode", "enum");
  }
  if (matchMode === "expense_reference" && !expenseReferenceCode) {
    validationFailure("expenseReferenceCode", "required");
  }
  if (matchMode === "candidates_only" && expenseReferenceCode) {
    validationFailure("expenseReferenceCode", "forbidden");
  }
  return {
    expenseReferenceCode: expenseReferenceCode?.toUpperCase() ?? null,
    fileName: payloadFileName(body.fileName),
    mediaType: payloadText(body.mediaType, "mediaType", { max: 100 }),
    content: decodeStrictBase64(body.contentBase64),
    sourceRef: payloadText(body.sourceRef, "sourceRef", { max: 500 }),
    textHint: payloadText(body.textHint, "textHint", { optional: true, max: 2000 }),
    amountCents: payloadOptionalPositiveCents(body.amountCents, "amountCents"),
    occurredOn: payloadDateOnly(body.occurredOn, "occurredOn"),
    paidTime: payloadTime(body.paidTime, "paidTime"),
    matchMode,
  };
}

function validateDocumentInboxConfirmPayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set(["expenseReferenceCode", "paymentId"]));
  return {
    expenseReferenceCode: payloadText(body.expenseReferenceCode, "expenseReferenceCode", { max: 200 }).toUpperCase(),
    paymentId: payloadText(body.paymentId, "paymentId", { max: 200 }),
  };
}

function documentInboxResponseItem(item) {
  const recognition = item?.recognition && typeof item.recognition === "object"
    ? item.recognition
    : null;
  return {
    ...item,
    candidates: Array.isArray(recognition?.candidates) ? recognition.candidates : [],
    attachmentId: typeof recognition?.attachmentId === "string" ? recognition.attachmentId : null,
  };
}

function validateInvoiceReviewPayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set([
    "invoiceCode",
    "invoiceNumber",
    "issuedOn",
    "sellerName",
    "buyerName",
    "amountExTaxCents",
    "taxCents",
    "totalCents",
    "suggestedCategory",
  ]));
  return body;
}

function validateInvoiceMatchPayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set(["expenseReferenceCode", "paymentId", "allocatedCents", "matchMethod"]));
  return {
    expenseReferenceCode: payloadText(body.expenseReferenceCode, "expenseReferenceCode", { max: 200 }),
    paymentId: payloadText(body.paymentId, "paymentId", { optional: true, max: 200 }),
    allocatedCents: payloadPositiveCents(body.allocatedCents, "allocatedCents"),
    matchMethod: payloadText(body.matchMethod ?? "manual_selection", "matchMethod", { max: 50 }),
  };
}

function validateNoInvoicePayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set(["paymentId", "reason"]));
  return {
    paymentId: payloadText(body.paymentId, "paymentId", { optional: true, max: 200 }),
    reason: payloadText(body.reason, "reason", { max: 1000 }),
  };
}

function validateNoInvoiceRevokePayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set(["confirmationId"]));
  return { confirmationId: payloadText(body.confirmationId, "confirmationId", { max: 200 }) };
}

function optionalQueryBoolean(value, field) {
  if (value === null || value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  validationFailure(field, "boolean");
}

function invoiceRepositoryFailure(error) {
  if (error instanceof InvoiceDuplicateError) {
    throw new HttpError(409, error.code, error.message, { existingInvoiceId: error.existingInvoiceId });
  }
  if (error instanceof InvoiceNotFoundError) {
    throw new HttpError(404, error.code, error.message);
  }
  if (error instanceof InvoiceVersionConflictError) {
    throw new HttpError(409, error.code, error.message, { currentVersion: error.currentVersion });
  }
  if (error instanceof InvoiceMatchConflictError) {
    throw new HttpError(409, error.code, error.message);
  }
  if (error instanceof TypeError) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { body: error.message });
  }
  throw error;
}

function documentInboxRepositoryFailure(error) {
  if (error instanceof DocumentInboxDuplicateError) {
    throw new HttpError(409, error.code, error.message, { existingDocumentId: error.existingId });
  }
  if (error instanceof DocumentInboxNotFoundError) {
    throw new HttpError(404, error.code, error.message);
  }
  if (error instanceof DocumentInboxVersionConflictError) {
    throw new HttpError(409, error.code, error.message, { currentVersion: error.currentVersion });
  }
  if (error instanceof DocumentInboxStateConflictError) {
    throw new HttpError(409, error.code, error.message, { status: error.status });
  }
  if (error instanceof TypeError) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { body: error.message });
  }
  throw error;
}

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
    version: Number(row.version ?? 1),
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
    version: Number(row.version ?? 1),
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
    version: Number(row.version ?? 1),
    owner: row.owner ?? null,
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
    version: Number(row.version ?? 1),
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
    version: Number(row.version ?? 1),
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
    version: Number(row.version ?? 1),
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
    version: Number(row.version ?? 1),
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

function hospitalTenderCustomerNameMap(db) {
  return new Map(
    all(db, "SELECT id, name FROM customers WHERE deleted_at IS NULL ORDER BY id ASC")
      .map((row) => [row.id, row.name]),
  );
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
  const customers = all(db, "SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY relation DESC, updated_at DESC").map(customerFromRow);
  const opportunities = all(
    db,
    `SELECT opportunities.*
     FROM opportunities
     INNER JOIN customers ON customers.id = opportunities.customer_id
     WHERE opportunities.deleted_at IS NULL
       AND customers.deleted_at IS NULL
     ORDER BY opportunities.probability DESC, opportunities.updated_at DESC`,
  ).map(opportunityFromRow);
  const priorityRank = (value) => {
    const text = String(value ?? "");
    if (text.includes("高") || text.includes("楂")) return 0;
    if (text.includes("中") || text.includes("涓")) return 1;
    return 2;
  };
  const actions = all(db, "SELECT * FROM action_items WHERE deleted_at IS NULL ORDER BY updated_at DESC")
    .map(actionFromRow)
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));
  const risks = all(db, "SELECT * FROM risk_items WHERE deleted_at IS NULL ORDER BY score DESC, updated_at DESC").map(riskFromRow);
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
    version: Number(row.version ?? 1),
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
    requestId: row.request_id ?? null,
    before: parseJson(row.before_json, {}),
    after: parseJson(row.after_json, {}),
    entityVersion: row.entity_version ?? null,
    createdAt: row.created_at,
  };
}

const softDeleteAuditFields = {
  customer: ["id", "version", "name", "owner", "createdAt", "updatedAt"],
  opportunity: ["id", "version", "customerId", "name", "stage", "owner", "createdAt", "updatedAt"],
  weekly_report: ["id", "version", "owner", "periodStart", "periodEnd", "status", "createdAt", "updatedAt"],
  action: ["id", "version", "customerId", "opportunityId", "title", "status", "assignee", "due", "createdAt", "updatedAt"],
  risk: ["id", "version", "customerId", "opportunityId", "title", "status", "severity", "score", "sourceType", "sourceId", "createdAt", "updatedAt"],
  knowledge: ["id", "version", "title", "category", "source", "createdAt", "updatedAt"],
};

function softDeleteAuditSnapshot(entityType, entity, lifecycle = {}) {
  const fields = softDeleteAuditFields[entityType];
  if (!fields) throw new Error(`Missing soft-delete audit allowlist for ${entityType}`);
  return {
    ...Object.fromEntries(fields.filter((field) => entity[field] !== undefined).map((field) => [field, entity[field]])),
    ...lifecycle,
  };
}

function listAuditLogs(db, searchParams, account) {
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit")) || 100, 500));
  return all(
    db,
    `SELECT * FROM audit_logs
     WHERE (actor = $account OR json_extract(metadata_json, '$.owner') = $account)
       AND ($action IS NULL OR action = $action)
       AND ($entityType IS NULL OR entity_type = $entityType)
       AND ($entityId IS NULL OR entity_id = $entityId)
     ORDER BY created_at DESC
     LIMIT $limit`,
    {
      $account: account,
      $action: searchParams.get("action") || null,
      $entityType: searchParams.get("entityType") || null,
      $entityId: searchParams.get("entityId") || null,
      $limit: limit,
    },
  ).map(auditLogFromRow);
}

function responseOptions(response, headers) {
  return {
    ...(response[responseContextSymbol] ?? {}),
    ...(headers ? { headers } : {}),
  };
}

function sendJson(response, statusCode, body, headers) {
  sendHttpJson(response, statusCode, body, responseOptions(response, headers));
}

function sendDocument(response, statusCode, body, headers = {}) {
  sendHttpDocument(response, statusCode, body, responseOptions(response, headers));
}

async function readJson(request, { maxBytes } = {}) {
  return readJsonBody(request, {
    maxBytes: maxBytes ?? request[requestConfigSymbol]?.jsonBodyLimitBytes,
  });
}

function notFound() {
  throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
}

function badRequest(_response, message) {
  throw new HttpError(400, "BAD_REQUEST", message);
}

function unauthorized(_response, message = "Please sign in", code = "UNAUTHORIZED") {
  throw new HttpError(401, code, message);
}

const riskStatuses = new Set(["open", "accepted", "in_progress", "deferred", "closed"]);
const actionStatuses = new Set(["pending", "in_progress", "done", "deferred"]);
const weeklyReportStatuses = new Set(["draft", "saved", "ready"]);
const customerPatchSchema = partialSchema(requestSchemas.customerCreate);
const opportunityPatchSchema = partialSchema(requestSchemas.opportunityCreate);
const knowledgePatchSchema = partialSchema(requestSchemas.knowledgeCreate);

async function readValidatedJson(request, schema, options) {
  return validateObject(schema, await readJson(request), options);
}

async function validateEmptyBody(request) {
  await readValidatedJson(request, {}, { allowEmpty: true });
}

function requireSecureSettings(repository) {
  if (!repository) {
    throw new HttpError(
      503,
      "SECURE_SETTINGS_NOT_CONFIGURED",
      "Secure settings storage is not configured",
    );
  }
  return repository;
}

function validateSecureSettingBody(value, { field, max = 500 } = {}) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set([field]));
  if (typeof body[field] !== "string" || !body[field].trim() || body[field].length > max) {
    validationFailure(field, "format");
  }
  return body[field].trim();
}

function validationFailure(field, rule = "reference") {
  throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", {
    [field]: rule,
  });
}

function requireConfirmationTargetVersions(body, targets) {
  for (const target of ["customer", "opportunity"]) {
    if (!targets.includes(target)) continue;
    if (!Number.isSafeInteger(body.targetVersions?.[target]) || body.targetVersions[target] <= 0) {
      validationFailure("targetVersions", "required");
    }
  }
}

function triggerFailpoint(options, name) {
  if (options.failpoints instanceof Set && options.failpoints.has(name)) {
    throw new Error(`Failpoint triggered: ${name}`);
  }
}

function parseExpectedVersion(request) {
  const rawHeaderCount = Array.isArray(request.rawHeaders)
    ? request.rawHeaders.filter((value, index) => index % 2 === 0 && String(value).toLowerCase() === "if-match").length
    : 0;
  const rawValue = request.headers["if-match"];
  const match = rawHeaderCount === 1 && typeof rawValue === "string"
    ? /^"([1-9]\d*)"$/.exec(rawValue)
    : null;
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new HttpError(428, "PRECONDITION_REQUIRED", "A current quoted entity version is required");
  }
  return version;
}

function throwVersionFailure(db, { table, id, softDeletable }) {
  const current = get(
    db,
    `SELECT version${softDeletable ? ", deleted_at" : ""} FROM ${table} WHERE id = $id`,
    { $id: id },
  );
  if (!current || (softDeletable && current.deleted_at)) notFound();
  throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
    currentVersion: Number(current.version),
  });
}

function runVersionedUpdate(db, {
  table,
  id,
  expectedVersion,
  setSql,
  params,
  softDeletable = true,
}) {
  const result = run(
    db,
    `UPDATE ${table}
     SET ${setSql},
         version = version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $id
       AND version = $expectedVersion
       ${softDeletable ? "AND deleted_at IS NULL" : ""}`,
    {
      ...params,
      $id: id,
      $expectedVersion: expectedVersion,
    },
  );
  if (result.changes !== 1) {
    throwVersionFailure(db, { table, id, softDeletable });
  }
}

function softDeleteRecord(db, {
  table,
  id,
  expectedVersion,
  fromRow,
  deletedBy,
  action,
  entityType,
  requestId,
  metadata,
}) {
  return withImmediateTransaction(db, () => {
    const beforeRow = get(db, `SELECT * FROM ${table} WHERE id = $id`, { $id: id });
    if (!beforeRow || beforeRow.deleted_at) notFound();

    const result = run(
      db,
      `UPDATE ${table}
       SET deleted_at = CURRENT_TIMESTAMP,
           deleted_by = $deletedBy,
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $id
         AND version = $expectedVersion
         AND deleted_at IS NULL`,
      {
        $id: id,
        $expectedVersion: expectedVersion,
        $deletedBy: deletedBy,
      },
    );
    if (result.changes !== 1) {
      throwVersionFailure(db, { table, id, softDeletable: true });
    }

    const afterRow = get(db, `SELECT * FROM ${table} WHERE id = $id`, { $id: id });
    const beforeEntity = fromRow(beforeRow);
    const afterEntity = fromRow(afterRow);
    const before = softDeleteAuditSnapshot(entityType, beforeEntity);
    const after = softDeleteAuditSnapshot(entityType, afterEntity, {
      deletedAt: afterRow.deleted_at,
      deletedBy: afterRow.deleted_by,
    });
    insertAudit(db, {
      action,
      entityType,
      entityId: id,
      actor: deletedBy,
      metadata: typeof metadata === "function" ? metadata(beforeEntity) : metadata,
      requestId,
      before,
      after,
      entityVersion: afterEntity.version,
    });
    return {
      ...afterEntity,
      deletedAt: afterRow.deleted_at,
      deletedBy: afterRow.deleted_by,
    };
  });
}

function activeCustomerRow(db, id) {
  if (!id) return null;
  return get(
    db,
    "SELECT id, name FROM customers WHERE id = $id AND deleted_at IS NULL",
    { $id: id },
  );
}

function activeOpportunityRow(db, id) {
  if (!id) return null;
  const row = activeOpportunityEntityRow(db, id);
  return row ? { id: row.id, customerId: row.customer_id } : null;
}

function activeOpportunityEntityRow(db, id) {
  if (!id) return null;
  return get(
    db,
    `SELECT opportunities.*
     FROM opportunities
     INNER JOIN customers ON customers.id = opportunities.customer_id
     WHERE opportunities.id = $id
       AND opportunities.deleted_at IS NULL
       AND customers.deleted_at IS NULL`,
    { $id: id },
  );
}

function activeSolutionDraftRow(db, id) {
  if (!id) return null;
  return get(
    db,
    `SELECT solution_drafts.*
     FROM solution_drafts
     INNER JOIN customers
       ON customers.id = solution_drafts.customer_id
      AND customers.deleted_at IS NULL
     INNER JOIN opportunities
       ON opportunities.id = solution_drafts.opportunity_id
      AND opportunities.customer_id = solution_drafts.customer_id
      AND opportunities.deleted_at IS NULL
     WHERE solution_drafts.id = $id`,
    { $id: id },
  );
}

function activeSolutionDraftRows(db) {
  return all(
    db,
    `SELECT solution_drafts.*
     FROM solution_drafts
     INNER JOIN customers
       ON customers.id = solution_drafts.customer_id
      AND customers.deleted_at IS NULL
     INNER JOIN opportunities
       ON opportunities.id = solution_drafts.opportunity_id
      AND opportunities.customer_id = solution_drafts.customer_id
      AND opportunities.deleted_at IS NULL
     ORDER BY solution_drafts.updated_at DESC, solution_drafts.created_at DESC`,
  );
}

function requireActiveCustomer(db, id) {
  const customer = activeCustomerRow(db, id);
  if (!customer) validationFailure("customerId");
  return customer;
}

function requireActiveOpportunity(db, id) {
  const opportunity = activeOpportunityRow(db, id);
  if (!opportunity) validationFailure("opportunityId");
  return opportunity;
}

function validateCustomerOpportunityPair(db, customerId, opportunityId) {
  if (customerId) requireActiveCustomer(db, customerId);
  if (!opportunityId) return;
  const opportunity = requireActiveOpportunity(db, opportunityId);
  if (customerId && opportunity.customerId !== customerId) {
    validationFailure("opportunityId", "relationship");
  }
}

function createCustomer(db, body) {
  const id = randomUUID();
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
  const id = randomUUID();
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

function updateCustomer(db, id, body, expectedVersion) {
  const current = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL", { $id: id }));
  if (!current) return null;

  runVersionedUpdate(db, {
    table: "customers",
    id,
    expectedVersion,
    setSql: `name = $name,
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
         opportunities = $opportunities`,
    params: {
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
  });

  return customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL", { $id: id }));
}

function updateOpportunity(db, id, body, expectedVersion) {
  const current = opportunityFromRow(activeOpportunityEntityRow(db, id));
  if (!current) return null;

  runVersionedUpdate(db, {
    table: "opportunities",
    id,
    expectedVersion,
    setSql: `customer_id = $customerId,
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
         tone = $tone`,
    params: {
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
  });

  return opportunityFromRow(activeOpportunityEntityRow(db, id));
}

function normalizeTags(tags) {
  return Array.from(new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag ?? "").trim()).filter(Boolean)));
}

function createKnowledgeItem(db, body) {
  const id = randomUUID();
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

function updateKnowledgeItem(db, id, body, expectedVersion) {
  const current = knowledgeFromRow(get(db, "SELECT * FROM knowledge_items WHERE id = $id AND deleted_at IS NULL", { $id: id }));
  if (!current) return null;

  runVersionedUpdate(db, {
    table: "knowledge_items",
    id,
    expectedVersion,
    setSql: `title = $title,
         category = $category,
         tags = $tags,
         summary = $summary,
         content = $content,
         source = $source`,
    params: {
      $title: patchValue(body, "title", current.title),
      $category: patchValue(body, "category", current.category),
      $tags: Object.hasOwn(body, "tags") ? json(normalizeTags(body.tags)) : json(current.tags),
      $summary: patchValue(body, "summary", current.summary),
      $content: patchValue(body, "content", current.content),
      $source: patchValue(body, "source", current.source),
    },
  });

  return knowledgeFromRow(get(db, "SELECT * FROM knowledge_items WHERE id = $id AND deleted_at IS NULL", { $id: id }));
}

function updateActionItem(db, id, body, expectedVersion) {
  const current = actionFromRow(get(db, "SELECT * FROM action_items WHERE id = $id AND deleted_at IS NULL", { $id: id }));
  if (!current) return null;
  const nextStatus = patchValue(body, "status", current.status);
  if (!actionStatuses.has(nextStatus)) {
    return { error: "invalid_status" };
  }

  runVersionedUpdate(db, {
    table: "action_items",
    id,
    expectedVersion,
    setSql: `title = $title,
         reason = $reason,
         status = $status,
         due = $due,
         assignee = $assignee,
         priority = $priority,
         tone = $tone`,
    params: {
      $title: patchValue(body, "title", current.title),
      $reason: patchValue(body, "reason", current.reason),
      $status: nextStatus,
      $due: patchValue(body, "due", current.due),
      $assignee: patchValue(body, "assignee", current.assignee),
      $priority: patchValue(body, "priority", current.priority),
      $tone: patchValue(body, "tone", current.tone),
    },
  });

  return actionFromRow(get(db, "SELECT * FROM action_items WHERE id = $id AND deleted_at IS NULL", { $id: id }));
}

function updateWeeklyReport(db, id, body, expectedVersion) {
  const current = weeklyReportFromRow(get(db, "SELECT * FROM weekly_reports WHERE id = $id AND deleted_at IS NULL", { $id: id }));
  if (!current) return null;
  const nextStatus = patchValue(body, "status", current.status);
  if (!weeklyReportStatuses.has(nextStatus)) {
    return { error: "invalid_status" };
  }

  runVersionedUpdate(db, {
    table: "weekly_reports",
    id,
    expectedVersion,
    setSql: `status = $status,
         content = $content`,
    params: {
      $status: nextStatus,
      $content: patchValue(body, "content", current.content),
    },
  });

  return weeklyReportFromRow(get(db, "SELECT * FROM weekly_reports WHERE id = $id AND deleted_at IS NULL", { $id: id }));
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

function updateRiskItem(db, id, body, expectedVersion) {
  const current = riskFromRow(get(db, "SELECT * FROM risk_items WHERE id = $id AND deleted_at IS NULL", { $id: id }));
  if (!current) return null;
  const nextStatus = patchValue(body, "status", current.status);
  if (!riskStatuses.has(nextStatus)) {
    return { error: "invalid_status" };
  }

  runVersionedUpdate(db, {
    table: "risk_items",
    id,
    expectedVersion,
    setSql: `status = $status,
         action = $action,
         assignee = $assignee,
         due = $due,
         severity = $severity,
         score = $score,
         tone = $tone`,
    params: {
      $status: nextStatus,
      $action: patchValue(body, "action", current.action),
      $assignee: patchValue(body, "assignee", current.assignee),
      $due: patchValue(body, "due", current.due),
      $severity: patchValue(body, "severity", current.severity),
      $score: patchValue(body, "score", current.score),
      $tone: patchValue(body, "tone", current.tone),
    },
  });

  return riskFromRow(get(db, "SELECT * FROM risk_items WHERE id = $id AND deleted_at IS NULL", { $id: id }));
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
  const rows = all(db, "SELECT * FROM knowledge_items WHERE deleted_at IS NULL ORDER BY updated_at DESC").map(knowledgeFromRow);
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
  const rows = all(db, "SELECT * FROM knowledge_items WHERE deleted_at IS NULL").map(knowledgeFromRow);
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

function getLatestInsightRow(db, quickRecordId) {
  return get(
    db,
    `SELECT * FROM ai_insights
     WHERE quick_record_id = $quickRecordId
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
    { $quickRecordId: quickRecordId },
  );
}

function getLatestInsight(db, quickRecordId) {
  return insightFromRow(getLatestInsightRow(db, quickRecordId));
}

function quickRecordHistoryFromRow(db, row) {
  const quickRecord = quickRecordFromRow(row);
  if (!quickRecord) return null;
  const confirmations = all(
    db,
    `SELECT * FROM manual_confirmations
     WHERE quick_record_id = $quickRecordId
     ORDER BY created_at ASC, target ASC`,
    { $quickRecordId: quickRecord.id },
  ).map(confirmationFromRow);
  return {
    ...quickRecord,
    analysis: getLatestInsight(db, quickRecord.id),
    confirmations,
    confirmedTargets: confirmations.map((item) => item.target),
    syncLog: confirmations,
  };
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

function syncCustomerFromQuickRecord(db, customerId, expectedVersion, quickRecord, insight) {
  if (!customerId) return null;
  const current = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL", { $id: customerId }));
  if (!current) notFound();

  const syncPreview = appendUnique(current.syncPreview, buildCustomerSyncPreview(quickRecord, insight)).slice(0, 8);
  const needs = appendUnique(current.needs, insight?.summary?.request?.text).slice(0, 8);
  const risks = appendUnique(current.risks, insight?.summary?.risk?.text).slice(0, 8);

  runVersionedUpdate(db, {
    table: "customers",
    id: current.id,
    expectedVersion,
    setSql: `sync_preview = $syncPreview,
         needs = $needs,
         risks = $risks`,
    params: {
      $id: current.id,
      $syncPreview: json(syncPreview),
      $needs: json(needs),
      $risks: json(risks),
    },
  });

  return customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL", { $id: current.id }));
}

function syncOpportunityFromQuickRecord(db, opportunityId, expectedVersion, quickRecord, insight) {
  if (!opportunityId) return null;
  const current = opportunityFromRow(activeOpportunityEntityRow(db, opportunityId));
  if (!current) notFound();

  const requirements = appendUnique(current.requirements, insight?.summary?.request?.text).slice(0, 8);
  const solutionDirection = appendUnique(current.solutionDirection, insight?.summary?.action?.text).slice(0, 8);

  runVersionedUpdate(db, {
    table: "opportunities",
    id: current.id,
    expectedVersion,
    setSql: `requirements = $requirements,
         solution_direction = $solutionDirection,
         source_record = $sourceRecord,
         risk = COALESCE($risk, risk),
         next = COALESCE($next, next)`,
    params: {
      $id: current.id,
      $requirements: json(requirements),
      $solutionDirection: json(solutionDirection),
      $sourceRecord: buildOpportunitySourceRecord(quickRecord),
      $risk: insight?.summary?.risk?.text ?? null,
      $next: insight?.summary?.action?.text ?? null,
    },
  });

  return opportunityFromRow(activeOpportunityEntityRow(db, current.id));
}

function upsertActionFromQuickRecord(db, quickRecord, insight, customer, opportunity) {
  const customerName = customer?.name ?? opportunity?.customer ?? insight?.customer?.value ?? null;
  const actionText = insight?.summary?.action?.text ?? `跟进快速记录：${compactText(quickRecord.rawContent, 40)}`;
  const riskText = insight?.summary?.risk?.text;
  const priority = riskText ? "高" : "中";
  const params = {
    $customerId: customer?.id ?? opportunity?.customerId ?? quickRecord.customerId,
    $opportunityId: opportunity?.id ?? quickRecord.opportunityId,
    $title: compactText(actionText, 80),
    $customer: customerName,
    $reason: riskText || `来自快速记录 ${quickRecord.id} 的人工确认结果`,
    $due: "待确认",
    $assignee: "继振",
    $priority: priority,
    $sourceRecordId: quickRecord.id,
    $tone: priority === "高" ? "red" : "blue",
  };
  const currentRow = get(
    db,
    "SELECT * FROM action_items WHERE source_record_id = $sourceRecordId",
    { $sourceRecordId: quickRecord.id },
  );
  const current = actionFromRow(currentRow);

  if (current) {
    const reactivating = Boolean(currentRow.deleted_at);
    runVersionedUpdate(db, {
      table: "action_items",
      id: current.id,
      expectedVersion: current.version,
      softDeletable: false,
      setSql: `customer_id = $customerId,
          opportunity_id = $opportunityId,
          title = $title,
          customer = $customer,
          reason = $reason,
          priority = $priority,
          tone = $tone,
          deleted_at = NULL,
          deleted_by = NULL
          ${reactivating ? ", due = $due, assignee = $assignee, status = 'pending'" : ""}`,
      params: {
        $customerId: params.$customerId,
        $opportunityId: params.$opportunityId,
        $title: params.$title,
        $customer: params.$customer,
        $reason: params.$reason,
        $priority: params.$priority,
        $tone: params.$tone,
        ...(reactivating ? { $due: params.$due, $assignee: params.$assignee } : {}),
      },
    });
  } else {
    run(
      db,
      `INSERT INTO action_items (
       id, customer_id, opportunity_id, title, customer, reason, due,
       assignee, priority, status, source_record_id, tone
     ) VALUES (
       $id, $customerId, $opportunityId, $title, $customer, $reason, $due,
       $assignee, $priority, 'pending', $sourceRecordId, $tone
     )`,
      { ...params, $id: randomUUID() },
    );
  }

  return actionFromRow(get(db, "SELECT * FROM action_items WHERE source_record_id = $sourceRecordId AND deleted_at IS NULL", {
    $sourceRecordId: quickRecord.id,
  }));
}

function getDraftActions(db, { customerId, opportunityId }) {
  return all(
    db,
    `SELECT * FROM action_items
     WHERE deleted_at IS NULL
       AND (customer_id = $customerId OR opportunity_id = $opportunityId)
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

function getActiveQuickRecordRiskRow(db, sourceId) {
  return get(
    db,
    `SELECT * FROM risk_items
     WHERE source_type = 'quick_record'
       AND source_id = $sourceId
       AND deleted_at IS NULL
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    { $sourceId: sourceId },
  );
}

function getQuickRecordRiskRow(db, sourceId) {
  return get(
    db,
    `SELECT * FROM risk_items
     WHERE source_type = 'quick_record'
       AND source_id = $sourceId
     ORDER BY
       (deleted_at IS NOT NULL) ASC,
       julianday(updated_at) DESC,
       updated_at DESC,
       id DESC
     LIMIT 1`,
    { $sourceId: sourceId },
  );
}

function findRiskItemRowForDraft(db, draft) {
  return draft.sourceType === "quick_record"
    ? getQuickRecordRiskRow(db, draft.sourceId)
    : get(
        db,
        `SELECT * FROM risk_items
         WHERE title = $title
           AND opportunity_id = $opportunityId
           AND source_type = $sourceType
           AND COALESCE(source_id, '') = COALESCE($sourceId, '')
           AND deleted_at IS NULL
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
        {
          $title: draft.title,
          $opportunityId: draft.opportunityId,
          $sourceType: draft.sourceType,
          $sourceId: draft.sourceId ?? null,
        },
      );
}

function upsertRiskItem(db, draft) {
  const currentRow = findRiskItemRowForDraft(db, draft);
  const current = riskFromRow(currentRow);

  if (current) {
    const reactivating = draft.sourceType === "quick_record" && Boolean(currentRow.deleted_at);
    runVersionedUpdate(db, {
      table: "risk_items",
      id: current.id,
      expectedVersion: current.version,
      softDeletable: !reactivating,
      setSql: `title = $title,
           customer_id = $customerId,
           opportunity_id = $opportunityId,
           target = $target,
           score = $score,
           severity = $severity,
           evidence = $evidence,
           action = $action,
           tone = $tone
           ${reactivating ? ", status = $status, deleted_at = NULL, deleted_by = NULL" : ""}`,
      params: {
        $id: current.id,
        $title: draft.title,
        $customerId: draft.customerId,
        $opportunityId: draft.opportunityId,
        $target: draft.target,
        $score: draft.score,
        $severity: draft.severity,
        $evidence: draft.evidence,
        $action: draft.action,
        $tone: draft.tone,
        ...(reactivating ? { $status: draft.status } : {}),
      },
    });
    return riskFromRow(get(db, "SELECT * FROM risk_items WHERE id = $id AND deleted_at IS NULL", { $id: current.id }));
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

  return riskFromRow(get(db, "SELECT * FROM risk_items WHERE id = $id AND deleted_at IS NULL", { $id: id }));
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

function hasCookieAuthConfiguration(config) {
  const hasCredential =
    validatePasswordHashEncoding(config.authPasswordHash) ||
    (config.nodeEnv === "development" &&
      typeof config.authPassword === "string" &&
      config.authPassword.length > 0);
  return Boolean(
    config.authAccount &&
    hasCredential &&
    config.authSessionSecret,
  );
}

function isAuthEnabled(config) {
  return Boolean(config.authRequired && hasCookieAuthConfiguration(config));
}

function isAuthMisconfigured(config) {
  return Boolean(config.authRequired && !hasCookieAuthConfiguration(config));
}

async function authenticateLogin(db, config, body, remoteAddress, now = Date.now()) {
  const account = typeof body?.account === "string" ? body.account.trim() : "";
  const address = remoteAddress || "unknown";
  const limiterKeys = [
    loginRateLimitKey(config.authSessionSecret, account || "<missing>", address),
    loginRateLimitKey(config.authSessionSecret, "<all-accounts>", address),
  ];
  pruneLoginRateLimits(db, now);
  for (const limiterKey of limiterKeys) assertLoginAllowed(db, limiterKey, now);

  const passwordMatches = validatePasswordHashEncoding(config.authPasswordHash)
    ? await verifyPassword(body?.password, config.authPasswordHash)
    : constantTimeEqual(body?.password, config.authPassword);
  if (account !== config.authAccount || !passwordMatches) {
    for (const limiterKey of limiterKeys) recordLoginFailure(db, limiterKey, now);
    return null;
  }

  for (const limiterKey of limiterKeys) clearLoginFailures(db, limiterKey);
  return createSession(db, config, { account: config.authAccount, now });
}

function authenticateRequest(db, config, request, now = Date.now()) {
  const cookies = parseCookies(request.headers.cookie);
  const cookieValue = cookies[config.authCookieName];
  const activeSession = getActiveSession(db, config, cookieValue, now);
  if (activeSession) {
    return {
      ...activeSession,
      cookieValue,
      csrfToken: createCsrfToken(config, activeSession.id),
      kind: "user",
    };
  }
  return authenticateMachineRequest(request.headers.authorization, config);
}

function isCookieWrite(method) {
  return method === "POST" || method === "PATCH" || method === "DELETE";
}

function itineraryAuditSnapshot(item) {
  if (!item) return null;
  return {
    id: item.id,
    version: item.version,
    title: item.title,
    visitDate: item.visitDate,
    status: item.status,
    stopCount: Array.isArray(item.request?.stops) ? item.request.stops.length : 0,
    optimizationSource: item.plan?.optimization?.source ?? null,
    createdBy: item.createdBy,
    updatedBy: item.updatedBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.deletedAt ? { deletedAt: item.deletedAt, deletedBy: item.deletedBy } : {}),
  };
}

function itineraryRepositoryFailure(error) {
  if (error instanceof ItineraryNotFoundError) notFound();
  if (error instanceof ItineraryVersionConflictError) {
    throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
      currentVersion: error.currentVersion,
    });
  }
  throw error;
}

function travelExpenseRepositoryFailure(error) {
  if (error instanceof TravelExpenseNotFoundError) notFound();
  if (error instanceof TravelExpenseVersionConflictError) {
    throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
      currentVersion: error.currentVersion,
    });
  }
  if (error instanceof TravelExpenseDependencyConflictError) {
    throw new HttpError(409, error.code, error.message);
  }
  throw error;
}

function travelExpenseAuditSnapshot(item) {
  if (!item) return null;
  return {
    id: item.id,
    version: item.version,
    owner: item.owner,
    occurredOn: item.occurredOn,
    category: item.category,
    purpose: item.purpose,
    merchant: item.merchant,
    invoiceStatus: item.invoiceStatus,
    paymentCount: item.payments.length,
    attachmentCount: item.attachments.length,
    actualPaidCents: item.actualPaidCents,
    reimbursementCents: item.reimbursementCents,
    createdBy: item.createdBy,
    updatedBy: item.updatedBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.deletedAt ? { deletedAt: item.deletedAt, deletedBy: item.deletedBy } : {}),
  };
}

function travelExpenseAttachmentAuditSnapshot(item) {
  if (!item) return null;
  return {
    id: item.id,
    expenseId: item.expenseId,
    paymentIds: item.paymentIds,
    sequence: item.sequence,
    kind: item.kind,
    fileName: item.fileName,
    mediaType: item.mediaType,
    sizeBytes: item.sizeBytes,
    coveredCents: item.coveredCents,
    notes: item.notes,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
  };
}

function travelExpenseAdvanceFromRow(row) {
  if (!row) return null;
  const item = {
    id: row.id,
    version: Number(row.version),
    owner: row.owner,
    weekStart: row.week_start,
    status: row.status,
    requestedCents: Number(row.requested_cents),
    receivedCents: Number(row.received_cents),
    requestedOn: row.requested_on,
    receivedOn: row.received_on,
    purpose: row.purpose,
    notes: row.notes,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.deleted_at) {
    item.deletedAt = row.deleted_at;
    item.deletedBy = row.deleted_by;
  }
  return item;
}

function activeTravelExpenseAdvance(db, id, owner) {
  return travelExpenseAdvanceFromRow(get(
    db,
    `SELECT * FROM travel_expense_advances
     WHERE id = $id AND owner = $owner AND deleted_at IS NULL`,
    { $id: id, $owner: owner },
  ));
}

function itineraryMapFailure(error) {
  if (!(error instanceof AmapServiceError)) throw error;
  if (error.code === "AMAP_LOCATION_MISMATCH") {
    throw new HttpError(422, error.code, "Resolved location does not match the requested city");
  }
  if (error.code === "AMAP_NO_RESULT" || error.code === "AMAP_NO_ROUTE") {
    throw new HttpError(422, error.code, "Map service could not resolve the requested itinerary");
  }
  if (error.code === "AMAP_TIMEOUT") {
    throw new HttpError(504, error.code, "Map service request timed out");
  }
  throw new HttpError(502, error.code, "Map service could not complete the request");
}

function buildSalesDecisionContext(db, body) {
  let customer = null;
  let opportunity = null;
  let quickRecord = null;

  if (body.customerId) {
    customer = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL", {
      $id: body.customerId,
    }));
    if (!customer) notFound();
  }

  if (body.opportunityId) {
    opportunity = opportunityFromRow(activeOpportunityEntityRow(db, body.opportunityId));
    if (!opportunity) notFound();
    if (customer && opportunity.customerId !== customer.id) {
      validationFailure("opportunityId", "relationship");
    }
    if (!customer) {
      customer = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL", {
        $id: opportunity.customerId,
      }));
    }
  }

  if (body.quickRecordId) {
    quickRecord = quickRecordFromRow(get(
      db,
      "SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL",
      { $id: body.quickRecordId },
    ));
    if (!quickRecord) notFound();
    if (customer && quickRecord.customerId && quickRecord.customerId !== customer.id) {
      validationFailure("quickRecordId", "relationship");
    }
    if (opportunity && quickRecord.opportunityId && quickRecord.opportunityId !== opportunity.id) {
      validationFailure("quickRecordId", "relationship");
    }
    if (!customer && quickRecord.customerId) {
      customer = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL", {
        $id: quickRecord.customerId,
      }));
    }
    if (!opportunity && quickRecord.opportunityId) {
      opportunity = opportunityFromRow(activeOpportunityEntityRow(db, quickRecord.opportunityId));
    }
  }

  const rawContent = String(body.rawContent ?? quickRecord?.rawContent ?? "").trim();
  if (!customer && !opportunity && !quickRecord && !rawContent) {
    validationFailure("body", "source");
  }

  const customerId = customer?.id ?? quickRecord?.customerId ?? opportunity?.customerId ?? null;
  const opportunityId = opportunity?.id ?? quickRecord?.opportunityId ?? null;
  const actions = customerId || opportunityId
    ? getDraftActions(db, { customerId, opportunityId })
    : [];
  const risks = customerId || opportunityId
    ? all(
      db,
      `SELECT * FROM risk_items
       WHERE deleted_at IS NULL
         AND (customer_id = $customerId OR opportunity_id = $opportunityId)
       ORDER BY updated_at DESC
       LIMIT 20`,
      { $customerId: customerId, $opportunityId: opportunityId },
    ).map(riskFromRow)
    : [];
  const knowledge = searchKnowledgeItems(db, {
    query: [customer?.name, opportunity?.name, rawContent].filter(Boolean).join(" "),
    limit: 6,
  });

  return {
    analysisType: body.analysisType ?? "opportunity_diagnosis",
    industry: body.industry ?? "general",
    rawContent,
    customer,
    opportunity,
    quickRecord,
    actions,
    risks,
    knowledge,
    customerId,
    opportunityId,
    quickRecordId: quickRecord?.id ?? null,
  };
}

export function createServer(options = {}) {
  const config = loadConfig(options);
  const db = openDatabase({ databaseUrl: config.databaseUrl });
  const secureSettingsRepository = isValidSettingsEncryptionKey(config.settingsEncryptionKey)
    ? createSecureSettingsRepository(db, {
        masterKey: config.settingsEncryptionKey,
        clock: options.settingsClock ?? (() => new Date()),
      })
    : null;
  const runtimeConfig = {
    ...config,
    // Once the encrypted store is configured, runtime model calls use only its
    // value. The environment fallback remains for legacy non-production/test
    // deployments that have not enabled persisted settings yet.
    modelApiKeyProvider: () => secureSettingsRepository
      ? (secureSettingsRepository.readSecret(DEEPSEEK_SETTING_KEY) || config.modelApiKey)
      : config.modelApiKey,
  };
  const hospitalTenderRepository = createHospitalTenderRepository(db, {
    clock: options.hospitalTenderClock ?? (() => new Date()),
    ...(options.hospitalTenderIdFactory ? { idFactory: options.hospitalTenderIdFactory } : {}),
  });
  const hospitalTenderInternalRunner = options.hospitalTenderInternalRunner
    ?? createInternalHospitalTenderRunner({
      ...(options.hospitalTenderInternalRunnerOptions ?? {}),
      pythonExecutable: options.hospitalTenderInternalRunnerOptions?.pythonExecutable
        ?? config.hospitalTenderPython,
    });
  let hospitalTenderInternalRunPromise = null;
  const databaseIdentity = config.authSessionSecret.length >= 32
    ? createDatabaseIdentity({
        databaseUrl: config.databaseUrl,
        secret: config.authSessionSecret,
      })
    : null;
  if (options.seed) seedDatabase(db);
  const itineraryRepository = createVisitItineraryRepository(db, {
    clock: options.itineraryClock ?? (() => new Date()),
    ...(options.itineraryIdFactory ? { idFactory: options.itineraryIdFactory } : {}),
  });
  const travelExpenseRepository = createTravelExpenseRepository(db, {
    clock: options.travelExpenseClock ?? (() => new Date()),
    ...(options.travelExpenseIdFactory ? { idFactory: options.travelExpenseIdFactory } : {}),
  });
  const travelExpenseDocumentInboxRepository = createTravelExpenseDocumentInboxRepository(db, {
    clock: options.travelExpenseDocumentInboxClock ?? options.travelExpenseClock ?? (() => new Date()),
    ...(options.travelExpenseDocumentInboxIdFactory
      ? { idFactory: options.travelExpenseDocumentInboxIdFactory }
      : {}),
  });
  const invoiceRepository = createInvoiceRepository(db, {
    clock: options.invoiceClock ?? options.travelExpenseClock ?? (() => new Date()),
    ...(options.invoiceIdFactory ? { idFactory: options.invoiceIdFactory } : {}),
    ...(options.invoiceMatchIdFactory ? { matchIdFactory: options.invoiceMatchIdFactory } : {}),
    ...(options.noInvoiceConfirmationIdFactory
      ? { confirmationIdFactory: options.noInvoiceConfirmationIdFactory }
      : {}),
    ...(options.invoiceCandidateIdFactory
      ? { candidateIdFactory: options.invoiceCandidateIdFactory }
      : {}),
  });
  const invoiceTextTools = options.invoiceTextTools ?? probeLocalDocumentTextTools({
    ocrCommand: config.invoiceOcrCommand,
    pdfTextCommand: config.invoicePdfTextCommand,
  });
  const invoiceTextExtractor = options.invoiceTextExtractor ?? createLocalDocumentTextExtractor({
    ocrCommand: config.invoiceOcrCommand,
    pdfTextCommand: config.invoicePdfTextCommand,
    ocrLanguages: config.invoiceOcrLanguages,
    timeoutMs: config.invoiceTextExtractionTimeoutMs,
  });
  const invoiceRecognizer = options.invoiceRecognizer ?? ((file) => recognizeInvoiceDocument(file, {
    textExtractor: invoiceTextExtractor,
    analyzeText: options.invoiceTextAnalyzer ?? ((text) => analyzeInvoiceText(text, {
      modelClient: expenseModelClient,
      modelName: config.modelName,
      modelTimeoutMs: config.modelTimeoutMs,
    })),
  }));
  const travelExpenseIngestionRepository = createTravelExpenseIngestionRepository(db, {
    clock: options.travelExpenseIngestionClock ?? options.travelExpenseClock ?? (() => new Date()),
    ...(options.travelExpenseIngestionIdFactory
      ? { idFactory: options.travelExpenseIngestionIdFactory }
      : {}),
  });
  const icostRateLimiter = options.icostRateLimiter ?? createFixedWindowLimiter({
    limit: config.icostWebhookRateLimit,
    windowMs: config.icostWebhookWindowMs,
    clock: options.icostRateLimitClock ?? Date.now,
  });
  const expenseModelClient = createExpenseModelClient(runtimeConfig, options.fetchImpl ?? fetch);
  const paymentProofRecognizer = options.paymentProofRecognizer ?? ((file, recognitionOptions = {}) => (
    recognizePaymentProofDocument(file, {
      typedEvidence: recognitionOptions.typedEvidence,
      textExtractor: invoiceTextExtractor,
      analyzeText: options.paymentProofTextAnalyzer ?? ((text) => analyzePaymentProofText(text, {
        modelClient: expenseModelClient,
        modelName: config.modelName,
        modelTimeoutMs: config.modelTimeoutMs,
      })),
      modelProvider: config.modelProvider,
      modelName: config.modelName,
      modelTimeoutMs: config.modelTimeoutMs,
    })
  ));
  const travelExpenseAnalyzer = options.travelExpenseAnalyzer ?? ((text) => analyzeExpenseText(text, {
    clock: options.travelExpenseAnalysisClock ?? options.travelExpenseClock ?? (() => new Date()),
    modelClient: expenseModelClient,
    modelProvider: config.modelProvider,
    modelName: config.modelName,
    modelTimeoutMs: config.modelTimeoutMs,
    minModelConfidence: 0.8,
  }));
  const salesDecisionRepository = createSalesDecisionRepository(db, {
    ...(options.salesDecisionIdFactory ? { idFactory: options.salesDecisionIdFactory } : {}),
    ...(options.salesDecisionClock ? { clock: options.salesDecisionClock } : {}),
  });
  const amapClient = Object.hasOwn(options, "amapClient")
    ? options.amapClient
    : config.amapWebServiceKey
      ? createAmapClient({
          apiKey: config.amapWebServiceKey,
          timeoutMs: config.amapTimeoutMs,
          fetchImpl: options.fetchImpl ?? fetch,
        })
      : null;
  const weixinLoginBinding = createWeixinLoginBinding({
    config,
    spawnLoginProcess: options.spawnWeixinLoginProcess,
    now: options.now,
  });

  const assistantClock = options.assistantClock ?? options.now ?? (() => new Date());
  const configuredAssistantConfirmationSecret = options.assistantConfirmationSecret ?? config.assistantConfirmationSecret;
  const assistantConfirmationSecret = typeof configuredAssistantConfirmationSecret === "string" && configuredAssistantConfirmationSecret.trim()
    ? configuredAssistantConfirmationSecret
    : (configuredAssistantConfirmationSecret instanceof Buffer
      ? configuredAssistantConfirmationSecret
      : (config.nodeEnv === "production"
        ? null
        : (config.authSessionSecret.length >= 32
          ? Buffer.from(config.authSessionSecret, "utf8")
          : createHash("sha256").update(String(config.authSessionSecret || "assistant-runtime"), "utf8").digest())));
  if (!assistantConfirmationSecret) {
    throw new Error("ASSISTANT_CONFIRMATION_SECRET is required before starting the production assistant runtime");
  }
  const assistantEventRepository = options.assistantEventRepository
    ?? createAssistantEventRepository(db, { clock: assistantClock });
  const assistantSessionRepository = options.assistantSessionRepository
    ?? createAssistantSessionRepository(db, { clock: assistantClock });
  const assistantPendingActionRepository = options.assistantPendingActionRepository
    ?? createAssistantPendingActionRepository(db, {
      clock: assistantClock,
      confirmationSecret: assistantConfirmationSecret,
    });
  const assistantToolHandlers = options.assistantToolHandlers
    ?? createAssistantToolHandlers({
      db,
      config,
      sessionRepository: assistantSessionRepository,
      travelExpenseDocumentInboxRepository,
      invoiceRepository,
      paymentProofRecognizer,
      invoiceRecognizer,
      clock: assistantClock,
      fetchImpl: options.fetchImpl ?? fetch,
    });
  const assistantOrchestrator = options.assistantOrchestrator
    ?? createAssistantOrchestrator({
      eventRepository: assistantEventRepository,
      sessionRepository: assistantSessionRepository,
      pendingActionRepository: assistantPendingActionRepository,
      toolHandlers: assistantToolHandlers,
      confirmationSecret: assistantConfirmationSecret,
      clock: assistantClock,
    });

  async function buildItineraryPlan(body) {
    if (!amapClient) {
      throw new HttpError(503, "AMAP_NOT_CONFIGURED", "Map service is not configured");
    }
    try {
      return await planVisitItinerary(body, {
        amapClient,
        modelConfig: runtimeConfig,
        fetchImpl: options.fetchImpl,
        clock: options.itineraryClock ?? (() => new Date()),
        ...(options.itineraryEnhanceOrder ? { enhanceOrder: options.itineraryEnhanceOrder } : {}),
      });
    } catch (error) {
      return itineraryMapFailure(error);
    }
  }

  async function runInternalHospitalTender({ actor, requestId }) {
    if (hospitalTenderInternalRunPromise) {
      throw new HttpError(409, "HOSPITAL_TENDER_RUN_IN_PROGRESS", "医院招标监测任务正在运行");
    }
    hospitalTenderInternalRunPromise = (async () => {
      const customers = all(
        db,
        "SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY id ASC",
      ).map(customerFromRow);
      const customerHospitals = customers.map((customer) => {
        const summaryTerms = typeof customer.summary === "string"
          ? customer.summary
            .split(/[，。；,.;\s]+/u)
            .map((item) => item.trim())
            .filter(Boolean)
          : [];
        const aliases = [
          ...(Array.isArray(customer.needs) ? customer.needs : []),
          ...(Array.isArray(customer.opportunities) ? customer.opportunities : []),
          ...summaryTerms,
        ]
          .filter((item) => typeof item === "string" && item.trim())
          .map((item) => item.trim().slice(0, 200))
          .filter((item, index, values) => values.indexOf(item) === index)
          .slice(0, 30);
        const region = String(customer.region ?? "").trim() || "全国";
        return {
          id: String(customer.id ?? "").trim().slice(0, 200),
          name: String(customer.name ?? "").trim().slice(0, 200),
          city: region.slice(0, 100),
          region: region.slice(0, 100),
          status: "direct",
          source_ids: [],
          aliases,
        };
      });
      const collected = await hospitalTenderInternalRunner.run({ customerHospitals });
      const customerNameById = new Map(customers.map((customer) => [customer.id, customer.name]));
      return withImmediateTransaction(db, () => {
        const syncResult = ingestHospitalTenderSnapshot({
          repository: hospitalTenderRepository,
          payload: collected.payload,
          customers,
        });
        insertAudit(db, {
          action: "hospital_tender.internal_run",
          entityType: "hospital_tender_snapshot",
          entityId: collected.payload.generatedAt,
          actor,
          requestId,
          before: null,
          after: null,
          metadata: {
            source: "bundled-public-collector",
            acceptedCount: syncResult.acceptedCount,
            rejectedCount: syncResult.rejectedCount,
            sourceCount: collected.payload.sources.length,
          },
        });
        return {
          generatedAt: syncResult.generatedAt,
          acceptedCount: syncResult.acceptedCount,
          rejectedCount: syncResult.rejectedCount,
          summary: hospitalTenderRepository.summary(),
          notices: syncResult.notices.map((item) => serializeHospitalTenderNotice(item, customerNameById)),
        };
      });
    })();
    try {
      return await hospitalTenderInternalRunPromise;
    } finally {
      hospitalTenderInternalRunPromise = null;
    }
  }

  const server = createHttpServer(async (request, response) => {
    const requestId = randomUUID();
    request[requestConfigSymbol] = config;
    response[responseContextSymbol] = { config, requestId };
    try {
      const origin = request.headers.origin;
      if (Array.isArray(origin)) {
        throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed");
      }
      corsHeaders(origin, config);
      response[responseContextSymbol].origin = origin;

      const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
      const parts = splitPath(url.pathname);

      if (request.method === "OPTIONS") {
        sendJson(response, 204, null);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        get(db, "SELECT 1 AS ready");
        sendJson(response, 200, {
          status: "ok",
          database: "ready",
          databaseIdentity,
          aiAnalysisMode: config.aiAnalysisMode,
          modelProvider: config.modelProvider,
          modelName: config.modelName,
          modelReady: config.aiAnalysisMode === "model" && Boolean(resolveRuntimeModelApiKey(runtimeConfig)),
          invoiceTextTools,
          authEnabled: isAuthEnabled(config),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const machineIdentity = authenticateMachineRequest(request.headers.authorization, config);
        if (machineIdentity) {
          assertMachineRouteAllowed(request.method, url.pathname, machineIdentity.integration);
        }
        if (!isAuthEnabled(config)) {
          throw new HttpError(
            503,
            "AUTH_NOT_CONFIGURED",
            "Authentication is required but not fully configured",
          );
        }
        const session = await authenticateLogin(
          db,
          config,
          await readValidatedJson(request, requestSchemas.login),
          request.socket?.remoteAddress ?? "unknown",
        );
        if (!session) {
          return unauthorized(response, "Account or password is incorrect", "INVALID_CREDENTIALS");
        }
        sendJson(response, 200, {
          account: session.account,
          displayName: session.account,
          expiresAt: session.expiresAt,
          csrfToken: session.csrfToken,
        }, {
          "Set-Cookie": buildSessionCookie(config, session.cookieValue),
        });
        return;
      }

      if (url.pathname === ICOST_EXPENSE_ROUTE) {
        if (!isIcostWebhookRouteAllowed(request.method, url.pathname)) {
          sendHttpError(
            response,
            new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed for the iCost expense webhook"),
            responseOptions(response, { Allow: "POST" }),
          );
          return;
        }
        const integrationIdentity = authenticateIcostWebhook(
          request.headers.authorization,
          secureSettingsRepository
            ? {
              ...config,
              icostWebhookToken: secureSettingsRepository.readSecret(ICOST_SETTING_KEY)
                || config.icostWebhookToken,
            }
            : config,
        );
        if (!integrationIdentity) return unauthorized(response);

        const remoteAddress = request.socket?.remoteAddress ?? "unknown";
        const rateLimit = icostRateLimiter.consume(`${integrationIdentity.account}\u0000${remoteAddress}`);
        if (!rateLimit.allowed) {
          sendHttpError(
            response,
            new HttpError(429, "RATE_LIMITED", "Too many iCost expense writes"),
            responseOptions(response, {
              "Retry-After": String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000))),
            }),
          );
          return;
        }

        const body = validateIcostTextPayload(await readJson(request));
        const received = travelExpenseIngestionRepository.receive({
          owner: integrationIdentity.account,
          actor: "icost-webhook",
          source: "icost",
          idempotencyKey: body.idempotencyKey,
          requestHash: requestHash(body),
          rawText: body.text,
          capturedAt: body.capturedAt ?? null,
          sourceId: body.sourceId ?? null,
        });

        if (received.replayed && ["accepted", "review_required"].includes(received.item.status)) {
          sendJson(response, 200, { item: icostResponseItem(received.item, true) });
          return;
        }

        const claimed = travelExpenseIngestionRepository.claim(received.item.id, {
          leaseMs: Math.max(60_000, config.modelTimeoutMs * 2),
        });
        if (claimed.replayed) {
          sendJson(response, 200, { item: icostResponseItem(claimed.item, true) });
          return;
        }

        let analysis;
        try {
          analysis = await travelExpenseAnalyzer(body.text, {
            capturedAt: body.capturedAt ?? null,
            sourceId: body.sourceId ?? null,
          });
        } catch {
          analysis = {
            status: "review_required",
            confidence: 0,
            expense: null,
            warnings: ["model_error"],
            source: {
              provider: config.modelProvider || "deepseek",
              model: config.modelName || null,
            },
          };
        }
        const completed = travelExpenseIngestionRepository.complete(received.item.id, {
          analysis,
          leaseToken: claimed.leaseToken,
        });
        const replayed = received.replayed || completed.replayed;
        const statusCode = replayed
          ? 200
          : completed.item.status === "accepted"
            ? 201
            : 202;
        sendJson(response, statusCode, { item: icostResponseItem(completed.item, replayed) });
        return;
      }

      if (url.pathname === WEIXIN_ASSISTANT_EVENT_ROUTE) {
        if (request.method !== "POST") {
          sendHttpError(
            response,
            new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed for the WeChat assistant event endpoint"),
            responseOptions(response, { Allow: "POST" }),
          );
          return;
        }
        const machineIdentity = authenticateMachineRequest(request.headers.authorization, config);
        if (!machineIdentity) return unauthorized(response);
        assertMachineRouteAllowed(request.method, url.pathname, machineIdentity.integration);
        const idempotencyKey = parseIdempotencyKey(request);
        const rawBody = await readJson(request, { maxBytes: TRAVEL_EXPENSE_ATTACHMENT_JSON_MAX_BYTES });
        let body;
        try {
          body = await validateWeixinAssistantEvent(rawBody);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { media: "invalid" });
        }
        if (idempotencyKey !== body.sourceMessageId && idempotencyKey !== `weixin:${body.sourceMessageId}`) {
          throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { idempotencyKey: "mismatch" });
        }
        assertWeixinSenderAllowed(config, body);
        const senderHash = createHash("sha256").update(body.senderId, "utf8").digest("hex");
        const conversationTuple = JSON.stringify([
          machineIdentity.account,
          "weixin",
          body.senderId,
          body.chatType,
          body.groupId ?? null,
          body.conversationId,
        ]);
        const conversationScope = `weixin:conversation:v1:${createHash("sha256")
          .update(conversationTuple, "utf8")
          .digest("hex")}`;
        const eventTuple = JSON.stringify([
          machineIdentity.account,
          "weixin",
          body.senderId,
          body.sourceMessageId,
        ]);
        const eventId = `weixin:event:v1:${createHash("sha256")
          .update(eventTuple, "utf8")
          .digest("hex")}`;
        const auditMetadata = {
          senderHash,
          chatType: body.chatType,
          ...(body.groupId
            ? { groupHash: createHash("sha256").update(body.groupId, "utf8").digest("hex") }
            : {}),
        };
        const result = await assistantOrchestrator.handle({
          context: {
            owner: machineIdentity.account,
            channel: "weixin",
            conversation: conversationScope,
            event: eventId,
            requestId,
          },
          input: {
            text: body.text,
            ...(body.pendingActionId ? { pendingActionId: body.pendingActionId } : {}),
            ...(body.confirmationCode ? { confirmationCode: body.confirmationCode } : {}),
          },
          serverData: {
            auditMetadata,
            ...(body.media ? { media: body.media } : {}),
          },
        });
        const runtimeBody = result.body && typeof result.body === "object" ? result.body : {};
        const toolResult = runtimeBody.result && typeof runtimeBody.result === "object"
          ? runtimeBody.result
          : {};
        const publicBody = {
          status: runtimeBody.status ?? (result.status >= 400 ? "error" : "ok"),
          text: typeof runtimeBody.text === "string"
            ? runtimeBody.text
            : typeof toolResult.text === "string"
              ? toolResult.text
            : typeof runtimeBody.message === "string"
              ? runtimeBody.message
              : "处理完成。",
          ...(runtimeBody.toolName ? { toolName: runtimeBody.toolName } : {}),
          ...(runtimeBody.actionId ? { actionId: runtimeBody.actionId } : {}),
          ...(runtimeBody.risk ? { risk: runtimeBody.risk } : {}),
        };
        sendJson(response, result.status, publicBody);
        return;
      }

      if (
        url.pathname === "/api/integrations/hospital-tenders/sync"
        || url.pathname === "/api/integrations/hospital-tenders/health"
      ) {
        const machineIdentity = authenticateMachineRequest(request.headers.authorization, config);
        if (!machineIdentity || machineIdentity.integration !== "hospital-tender-monitor") {
          return unauthorized(response);
        }
        assertMachineRouteAllowed(request.method, url.pathname, machineIdentity.integration);
        if (url.pathname.endsWith("/health")) {
          if (request.method !== "GET") {
            sendHttpError(
              response,
              new HttpError(405, "METHOD_NOT_ALLOWED", "Only GET is allowed for the hospital tender health endpoint"),
              responseOptions(response, { Allow: "GET" }),
            );
            return;
          }
          const health = hospitalTenderRepository.health();
          sendJson(response, 200, {
            item: {
              status: health.status,
              sourceCount: health.sourceCount,
              staleCount: health.unhealthySourceCount + health.degradedSourceCount,
              latestRun: hospitalTenderRepository.summary().latestRun,
            },
          });
          return;
        }
        if (request.method !== "POST") {
          sendHttpError(
            response,
            new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed for the hospital tender sync endpoint"),
            responseOptions(response, { Allow: "POST" }),
          );
          return;
        }
        let payload;
        try {
          payload = normalizeHospitalTenderSyncPayload(await readJson(request, {
            maxBytes: Math.min(config.jsonBodyLimitBytes, 8 * 1024 * 1024),
          }));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { snapshot: error.message });
        }
        const customers = all(
          db,
          "SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY id ASC",
        ).map(customerFromRow);
        const customerNameById = new Map(customers.map((customer) => [customer.id, customer.name]));
        const result = withImmediateTransaction(db, () => {
          const syncResult = ingestHospitalTenderSnapshot({
            repository: hospitalTenderRepository,
            payload,
            customers,
          });
          insertAudit(db, {
            action: "hospital_tender.sync",
            entityType: "hospital_tender_snapshot",
            entityId: payload.generatedAt,
            actor: machineIdentity.account,
            requestId,
            before: null,
            after: null,
            metadata: {
              integration: machineIdentity.integration,
              acceptedCount: syncResult.acceptedCount,
              rejectedCount: syncResult.rejectedCount,
              sourceCount: payload.sources.length,
            },
          });
          return syncResult;
        });
        sendJson(response, 200, {
          item: {
            generatedAt: result.generatedAt,
            acceptedCount: result.acceptedCount,
            rejectedCount: result.rejectedCount,
            summary: hospitalTenderRepository.summary(),
            notices: result.notices.map((item) => serializeHospitalTenderNotice(item, customerNameById)),
          },
        });
        return;
      }

      if (isAuthMisconfigured(config) && url.pathname.startsWith("/api/")) {
        throw new HttpError(
          503,
          "AUTH_NOT_CONFIGURED",
          "Authentication is required but not fully configured",
        );
      }

      let requestIdentity = { account: "anonymous", kind: "anonymous" };
      if (config.authRequired && url.pathname.startsWith("/api/")) {
        requestIdentity = authenticateRequest(db, config, request);
        if (!requestIdentity) return unauthorized(response);
        if (requestIdentity.kind === "machine") {
          assertMachineRouteAllowed(request.method, url.pathname, requestIdentity.integration);
        } else if (isCookieWrite(request.method)) {
          assertCsrfToken(request.headers["x-csrf-token"], requestIdentity.csrfToken);
        }
      } else if (url.pathname.startsWith("/api/") && request.headers.authorization) {
        requestIdentity = authenticateMachineRequest(request.headers.authorization, config);
        if (!requestIdentity) return unauthorized(response);
        assertMachineRouteAllowed(request.method, url.pathname, requestIdentity.integration);
      }
      request.authContext = requestIdentity;

      if (request.method === "POST" && url.pathname === "/api/hospital-tenders/run") {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        await validateEmptyBody(request);
        const result = await runInternalHospitalTender({
          actor: requestIdentity.account,
          requestId,
        });
        sendJson(response, 200, { item: result });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/auth/session") {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        sendJson(response, 200, {
          account: requestIdentity.account,
          displayName: requestIdentity.account,
          expiresAt: requestIdentity.expiresAt,
          csrfToken: requestIdentity.csrfToken,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        await validateEmptyBody(request);
        revokeSession(db, config, requestIdentity.cookieValue);
        sendJson(response, 204, null, {
          "Set-Cookie": buildSessionCookie(config, "", { clear: true }),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/settings/security") {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        const repository = requireSecureSettings(secureSettingsRepository);
        let item;
        try {
          item = repository.listMetadata();
        } catch {
          throw new HttpError(503, "SECURE_SETTINGS_UNAVAILABLE", "Secure settings storage is unavailable");
        }
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "POST"
        && (url.pathname === "/api/settings/icost-token" || url.pathname === "/api/settings/icost-token/rotate")
      ) {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        await validateEmptyBody(request);
        const repository = requireSecureSettings(secureSettingsRepository);
        const result = withImmediateTransaction(db, () => {
          const rotated = repository.rotateIcostToken();
          insertAudit(db, {
            action: "settings.icost_token.rotate",
            entityType: "secure_setting",
            entityId: ICOST_SETTING_KEY,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: {
              status: rotated.item.status,
              masked: rotated.item.masked,
              createdAt: rotated.item.createdAt,
              rotatedAt: rotated.item.rotatedAt,
            },
            metadata: { setting: ICOST_SETTING_KEY },
          });
          return rotated;
        });
        sendJson(response, 201, {
          item: {
            ...result.item,
            // This is the only endpoint that returns the generated token.
            token: result.token,
          },
        });
        return;
      }

      if (
        (request.method === "PUT" || request.method === "POST")
        && (url.pathname === "/api/settings/deepseek-key" || url.pathname === "/api/settings/deepseek-api-key")
      ) {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        const value = validateSecureSettingBody(await readJson(request), { field: "apiKey", max: 500 });
        const repository = requireSecureSettings(secureSettingsRepository);
        const item = withImmediateTransaction(db, () => {
          const saved = repository.setSecret(DEEPSEEK_SETTING_KEY, value);
          insertAudit(db, {
            action: "settings.deepseek_key.save",
            entityType: "secure_setting",
            entityId: DEEPSEEK_SETTING_KEY,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: {
              status: saved.status,
              masked: saved.masked,
              updatedAt: saved.updatedAt,
            },
            metadata: { setting: DEEPSEEK_SETTING_KEY },
          });
          return saved;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "DELETE"
        && (url.pathname === "/api/settings/deepseek-key" || url.pathname === "/api/settings/deepseek-api-key")
      ) {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        const confirmation = validateSecureSettingBody(
          await readJson(request),
          { field: "confirmation", max: 32 },
        );
        if (confirmation !== "CLEAR") {
          throw new HttpError(428, "CONFIRMATION_REQUIRED", "Explicit confirmation is required to clear the DeepSeek key");
        }
        const repository = requireSecureSettings(secureSettingsRepository);
        const item = withImmediateTransaction(db, () => {
          const cleared = repository.clearSecret(DEEPSEEK_SETTING_KEY);
          insertAudit(db, {
            action: "settings.deepseek_key.clear",
            entityType: "secure_setting",
            entityId: DEEPSEEK_SETTING_KEY,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: { status: cleared.status, updatedAt: cleared.updatedAt },
            metadata: { setting: DEEPSEEK_SETTING_KEY, confirmation: "provided" },
          });
          return cleared;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/dashboard/summary") {
        sendJson(response, 200, { item: dashboardSummaryFromDb(db) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/hospital-tenders") {
        const rawLimit = url.searchParams.get("limit");
        const rawOffset = url.searchParams.get("offset");
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        const offset = rawOffset === null ? 0 : Number(rawOffset);
        const customerId = url.searchParams.get("customerId");
        const query = url.searchParams.get("q")?.trim() ?? "";
        if (customerId && (customerId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(customerId))) {
          throw new HttpError(422, "VALIDATION_ERROR", "客户筛选条件无效", { customerId: "identifier" });
        }
        if (query.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(query)) {
          throw new HttpError(422, "VALIDATION_ERROR", "关键词筛选条件无效", { q: "max" });
        }
        const filters = {
          sourceId: url.searchParams.get("sourceId") || undefined,
          noticeType: url.searchParams.get("noticeType") || undefined,
          relevance: url.searchParams.get("relevance") || undefined,
          city: url.searchParams.get("city") || undefined,
          customerId: customerId || undefined,
          query: query || undefined,
          publishedFrom: url.searchParams.get("publishedFrom") || undefined,
          publishedTo: url.searchParams.get("publishedTo") || undefined,
          limit,
          offset,
        };
        let items;
        try {
          items = hospitalTenderRepository.listNotices(filters);
        } catch (error) {
          throw new HttpError(422, "VALIDATION_ERROR", "招标公告筛选条件无效", { filters: error.message });
        }
        const customerNames = hospitalTenderCustomerNameMap(db);
        sendJson(response, 200, {
          items: items.map((item) => serializeHospitalTenderNotice(item, customerNames)),
        });
        return;
      }

      if (
        request.method === "GET"
        && parts.length === 3
        && parts[0] === "api"
        && parts[1] === "hospital-tenders"
        && parts[2]
        && !new Set(["summary", "sources", "health"]).has(parts[2])
      ) {
        const item = hospitalTenderRepository.getNotice(parts[2]);
        if (!item) return notFound(response);
        sendJson(response, 200, {
          item: serializeHospitalTenderNotice(item, hospitalTenderCustomerNameMap(db)),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/hospital-tenders/summary") {
        sendJson(response, 200, { item: hospitalTenderRepository.summary() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/hospital-tenders/sources") {
        sendJson(response, 200, {
          items: hospitalTenderRepository.listSources().map(serializeHospitalTenderSource),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/hospital-tenders/health") {
        const health = hospitalTenderRepository.health();
        sendJson(response, 200, {
          item: {
            status: health.status,
            sourceCount: health.sourceCount,
            staleCount: health.unhealthySourceCount + health.degradedSourceCount,
            latestRun: hospitalTenderRepository.summary().latestRun,
          },
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/audit-logs") {
        sendJson(response, 200, {
          items: listAuditLogs(db, url.searchParams, request.authContext.account),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/travel-expense-document-inbox") {
        if (request.authContext.kind !== "user") return unauthorized(response);
        let items;
        try {
          items = travelExpenseDocumentInboxRepository.listDocuments({
            owner: request.authContext.account,
            status: url.searchParams.get("status"),
            documentKind: url.searchParams.get("documentKind"),
          });
        } catch (error) {
          documentInboxRepositoryFailure(error);
        }
        sendJson(response, 200, { items: items.map(documentInboxResponseItem) });
        return;
      }

      if (
        request.method === "GET"
        && parts.length === 3
        && parts[0] === "api"
        && parts[1] === "travel-expense-document-inbox"
        && parts[2]
      ) {
        if (request.authContext.kind !== "user") return unauthorized(response);
        const item = travelExpenseDocumentInboxRepository.getDocument(parts[2], {
          owner: request.authContext.account,
        });
        if (!item) notFound();
        sendJson(response, 200, { item: documentInboxResponseItem(item) });
        return;
      }

      if (
        request.method === "GET"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "travel-expense-document-inbox"
        && parts[2]
        && parts[3] === "content"
      ) {
        if (request.authContext.kind !== "user") return unauthorized(response);
        const item = travelExpenseDocumentInboxRepository.getDocumentContent(parts[2], {
          owner: request.authContext.account,
        });
        if (!item) notFound();
        sendDocument(response, 200, item.content, {
          "Content-Type": item.mediaType,
          "Content-Length": String(item.sizeBytes),
          "Content-Disposition": inlineContentDisposition(item.fileName),
          "Cache-Control": "no-store",
        });
        return;
      }

      if (
        request.method === "POST"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "travel-expense-document-inbox"
        && parts[2]
        && parts[3] === "confirm"
      ) {
        if (request.authContext.kind !== "user") return unauthorized(response);
        const expectedVersion = parseExpectedVersion(request);
        const body = validateDocumentInboxConfirmPayload(await readJson(request));
        const inboxContent = travelExpenseDocumentInboxRepository.getDocumentContent(parts[2], {
          owner: request.authContext.account,
        });
        if (!inboxContent) notFound();

        const item = await withDocumentBlobWritePreflight(db, {
          owner: request.authContext.account,
          content: inboxContent.content,
        }, (encodedDocumentBlob) => withImmediateTransaction(db, () => {
          const beforeInbox = travelExpenseDocumentInboxRepository.getDocument(parts[2], {
            owner: request.authContext.account,
          });
          if (!beforeInbox) notFound();
          if (beforeInbox.version !== expectedVersion) {
            throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
              currentVersion: beforeInbox.version,
            });
          }
          if (beforeInbox.status !== "review_required") {
            throw new HttpError(409, "DOCUMENT_INBOX_STATE_CONFLICT", "Document inbox item is no longer awaiting review", {
              status: beforeInbox.status,
            });
          }

          const expenseReference = travelExpenseDocumentInboxRepository.findExpenseByReference({
            owner: request.authContext.account,
            referenceCode: body.expenseReferenceCode,
          });
          if (!expenseReference) notFound();
          const beforeExpense = travelExpenseRepository.getExpense(expenseReference.id, {
            owner: request.authContext.account,
          });
          if (!beforeExpense) notFound();
          const payment = beforeExpense.payments.find((candidate) => candidate.id === body.paymentId);
          if (!payment) {
            throw new HttpError(422, "PAYMENT_NOT_IN_EXPENSE", "The selected payment does not belong to this expense");
          }

          let updatedExpense;
          try {
            updatedExpense = travelExpenseRepository.addAttachment(beforeExpense.id, {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion: beforeExpense.version,
              paymentIds: [payment.id],
              kind: "payment_proof",
              fileName: inboxContent.fileName,
              mediaType: inboxContent.mediaType,
              content: inboxContent.content,
              encodedDocumentBlob,
              coveredCents: payment.reimbursementCents,
              notes: "微信付款凭证人工确认",
            });
          } catch (error) {
            travelExpenseRepositoryFailure(error);
          }
          const previousAttachmentIds = new Set(beforeExpense.attachments.map((attachment) => attachment.id));
          const attachment = updatedExpense.attachments.find((candidate) => !previousAttachmentIds.has(candidate.id));
          if (!attachment) throw new Error("Payment proof confirmation did not return the new attachment");

          let matchedInbox;
          try {
            matchedInbox = travelExpenseDocumentInboxRepository.markMatched(parts[2], {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
              matchedExpenseId: beforeExpense.id,
              matchedPaymentId: payment.id,
              attachmentId: attachment.id,
            });
          } catch (error) {
            documentInboxRepositoryFailure(error);
          }

          insertAudit(db, {
            action: "travel_expense.attachment_add",
            entityType: "travel_expense_attachment",
            entityId: attachment.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: travelExpenseAttachmentAuditSnapshot(attachment),
            entityVersion: updatedExpense.version,
            metadata: {
              expenseId: updatedExpense.id,
              expenseVersion: updatedExpense.version,
              source: "weixin_review",
              documentInboxId: matchedInbox.id,
            },
          });
          insertAudit(db, {
            action: "travel_expense_document_inbox.confirm",
            entityType: "travel_expense_document_inbox",
            entityId: matchedInbox.id,
            actor: request.authContext.account,
            requestId,
            before: { id: beforeInbox.id, status: beforeInbox.status, version: beforeInbox.version },
            after: { id: matchedInbox.id, status: matchedInbox.status, version: matchedInbox.version },
            entityVersion: matchedInbox.version,
            metadata: {
              expenseId: updatedExpense.id,
              paymentId: payment.id,
              attachmentId: attachment.id,
            },
          });
          return documentInboxResponseItem(matchedInbox);
        }));
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "POST"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "travel-expense-document-inbox"
        && parts[2]
        && parts[3] === "reject"
      ) {
        if (request.authContext.kind !== "user") return unauthorized(response);
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        let item;
        try {
          item = withImmediateTransaction(db, () => {
            const before = travelExpenseDocumentInboxRepository.getDocument(parts[2], {
              owner: request.authContext.account,
            });
            if (!before) notFound();
            const rejected = travelExpenseDocumentInboxRepository.rejectDocument(parts[2], {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
            });
            insertAudit(db, {
              action: "travel_expense_document_inbox.reject",
              entityType: "travel_expense_document_inbox",
              entityId: rejected.id,
              actor: request.authContext.account,
              requestId,
              before: { id: before.id, status: before.status, version: before.version },
              after: { id: rejected.id, status: rejected.status, version: rejected.version },
              entityVersion: rejected.version,
              metadata: { source: rejected.source },
            });
            return documentInboxResponseItem(rejected);
          });
        } catch (error) {
          documentInboxRepositoryFailure(error);
        }
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/travel-expense-document-inbox") {
        if (request.authContext.kind !== "machine") {
          throw new HttpError(403, "MACHINE_REQUIRED", "This document inbox accepts WeChat machine requests only");
        }
        const rawBody = await readJson(request, { maxBytes: TRAVEL_EXPENSE_ATTACHMENT_JSON_MAX_BYTES });
        const body = validateTravelExpenseDocumentInboxPayload(rawBody);
        const idempotencyScope = {
          actor: request.authContext.account,
          method: request.method,
          path: url.pathname,
          key: parseIdempotencyKey(request),
          hash: requestHash(rawBody),
        };
        const claim = claimIdempotency(db, idempotencyScope);
        if (claim.replay) {
          sendJson(response, claim.status, claim.body);
          return;
        }

        try {
          if (body.matchMode === "expense_reference") {
            const referencedExpense = travelExpenseDocumentInboxRepository.findExpenseByReference({
              owner: request.authContext.account,
              referenceCode: body.expenseReferenceCode,
            });
            if (!referencedExpense) notFound();
          }
          const recognition = boundPaymentProofRecognition(await paymentProofRecognizer({
            fileName: body.fileName,
            mediaType: body.mediaType,
            buffer: body.content,
          }, {
            typedEvidence: {
              amountCents: body.amountCents,
              occurredOn: body.occurredOn,
              paidTime: body.paidTime,
            },
          }));
          const recognizedEvidence = recognition?.evidence && typeof recognition.evidence === "object"
            ? recognition.evidence
            : {};
          const conflictFields = new Set(Array.isArray(recognition?.conflicts)
            ? recognition.conflicts.map((conflict) => conflict?.field).filter(Boolean)
            : []);
          const effectiveEvidence = Object.fromEntries(
            ["amountCents", "occurredOn", "paidTime"].map((field) => [
              field,
              conflictFields.has(field) ? null : body[field] ?? recognizedEvidence[field] ?? null,
            ]),
          );
          const usedRecognizedEvidence = ["amountCents", "occurredOn", "paidTime"]
            .some((field) => body[field] === null && effectiveEvidence[field] !== null);

          const result = await withDocumentBlobWritePreflight(db, {
            owner: request.authContext.account,
            content: body.content,
          }, (encodedDocumentBlob) => withImmediateTransaction(db, () => {
            if (body.matchMode === "expense_reference") {
              const referencedExpense = travelExpenseDocumentInboxRepository.findExpenseByReference({
                owner: request.authContext.account,
                referenceCode: body.expenseReferenceCode,
              });
              if (!referencedExpense) notFound();
            }
            const candidates = travelExpenseDocumentInboxRepository.findPaymentCandidates({
              owner: request.authContext.account,
              expenseReferenceCode: body.matchMode === "expense_reference"
                ? body.expenseReferenceCode
                : null,
              amountCents: effectiveEvidence.amountCents,
              occurredOn: effectiveEvidence.occurredOn,
              paidTime: effectiveEvidence.paidTime,
            });
            const hasCompleteTypedEvidence = body.amountCents !== null
              && body.occurredOn !== null
              && body.paidTime !== null;
            const matchedCandidate = body.matchMode === "expense_reference"
              && hasCompleteTypedEvidence
              && conflictFields.size === 0
              && !recognition?.warnings?.includes(EXTRACTED_TEXT_TRUNCATED_WARNING)
              && candidates.length === 1
              ? candidates[0]
              : null;
            const before = matchedCandidate
              ? travelExpenseRepository.getExpense(matchedCandidate.expenseId, {
                  owner: request.authContext.account,
                })
              : null;
            if (matchedCandidate && !before) notFound();

            let inboxItem;
            try {
              inboxItem = travelExpenseDocumentInboxRepository.createDocument({
                owner: request.authContext.account,
                actor: request.authContext.account,
                source: "weixin",
                sourceRef: body.sourceRef,
                documentKind: "payment_proof",
                fileName: body.fileName,
                mediaType: body.mediaType,
                content: body.content,
                encodedDocumentBlob,
                status: matchedCandidate ? "matched" : "review_required",
                extractedText: recognition?.extractedText ?? null,
                recognition: {
                  ...recognition,
                  expenseReferenceCode: body.expenseReferenceCode,
                  matchMode: body.matchMode,
                  textHint: body.textHint,
                  effectiveEvidence,
                  usedRecognizedEvidence,
                  candidates,
                },
                errorCode: matchedCandidate ? null : recognition?.warnings?.[0] ?? null,
                matchedExpenseId: matchedCandidate?.expenseId ?? null,
                matchedPaymentId: matchedCandidate?.paymentId ?? null,
              });
            } catch (error) {
              documentInboxRepositoryFailure(error);
            }

            let attachmentId = null;
            if (matchedCandidate) {
              let updated;
              try {
                updated = travelExpenseRepository.addAttachment(matchedCandidate.expenseId, {
                  owner: request.authContext.account,
                  actor: request.authContext.account,
                  expectedVersion: before.version,
                  paymentIds: [matchedCandidate.paymentId],
                  kind: "payment_proof",
                  fileName: body.fileName,
                  mediaType: body.mediaType,
                  content: body.content,
                  encodedDocumentBlob,
                  coveredCents: matchedCandidate.reimbursementCents,
                  notes: "微信导入付款凭证",
                });
              } catch (error) {
                travelExpenseRepositoryFailure(error);
              }
              const previousAttachmentIds = new Set(before.attachments.map((item) => item.id));
              const added = updated.attachments.find((item) => !previousAttachmentIds.has(item.id));
              if (!added) throw new Error("WeChat payment proof write did not return the new attachment");
              attachmentId = added.id;
              insertAudit(db, {
                action: "travel_expense.attachment_add",
                entityType: "travel_expense_attachment",
                entityId: added.id,
                actor: request.authContext.account,
                requestId,
                before: null,
                after: travelExpenseAttachmentAuditSnapshot(added),
                entityVersion: updated.version,
                metadata: {
                  expenseId: updated.id,
                  expenseVersion: updated.version,
                  kind: added.kind,
                  sizeBytes: added.sizeBytes,
                  source: "weixin",
                },
              });
            }

            const responseBody = {
              item: {
                ...documentInboxResponseItem(inboxItem),
                expenseReferenceCode: body.expenseReferenceCode,
                candidates,
                attachmentId,
              },
            };
            insertAudit(db, {
              action: "travel_expense_document_inbox.create",
              entityType: "travel_expense_document_inbox",
              entityId: inboxItem.id,
              actor: request.authContext.account,
              requestId,
              before: null,
              after: {
                id: inboxItem.id,
                status: inboxItem.status,
                matchedExpenseId: inboxItem.matchedExpenseId,
                matchedPaymentId: inboxItem.matchedPaymentId,
                sizeBytes: inboxItem.sizeBytes,
              },
              entityVersion: inboxItem.version,
              metadata: {
                source: "weixin",
                candidateCount: candidates.length,
                matchMode: body.matchMode,
                usedRecognizedEvidence,
                recognitionWarningCount: Array.isArray(recognition?.warnings) ? recognition.warnings.length : 0,
              },
            });
            const status = matchedCandidate ? 201 : 202;
            completeIdempotency(db, {
              ...idempotencyScope,
              claimToken: claim.claimToken,
              status,
              body: responseBody,
            });
            return { status, body: responseBody };
          }));
          sendJson(response, result.status, result.body);
        } catch (error) {
          releaseIdempotencyClaim(db, { ...idempotencyScope, claimToken: claim.claimToken });
          documentInboxRepositoryFailure(error);
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/invoices") {
        const items = invoiceRepository.listInvoices({
          owner: request.authContext.account,
          status: url.searchParams.get("status"),
        });
        sendJson(response, 200, { items });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/invoice-matches") {
        const items = invoiceRepository.listMatches({
          owner: request.authContext.account,
          weekStart: url.searchParams.get("weekStart") || undefined,
          invoiceId: url.searchParams.get("invoiceId") || undefined,
          expenseId: url.searchParams.get("expenseId") || undefined,
          state: url.searchParams.get("state") || undefined,
        });
        sendJson(response, 200, { items });
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/api/travel-expense-no-invoice-confirmations"
      ) {
        const items = invoiceRepository.listNoInvoiceConfirmations({
          owner: request.authContext.account,
          weekStart: url.searchParams.get("weekStart") || undefined,
          expenseId: url.searchParams.get("expenseId") || undefined,
          paymentId: url.searchParams.get("paymentId") || undefined,
          active: optionalQueryBoolean(url.searchParams.get("active"), "active"),
        });
        sendJson(response, 200, { items });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/invoices") {
        const rawBody = await readJson(request, { maxBytes: INVOICE_UPLOAD_JSON_MAX_BYTES });
        const body = validateInvoiceUploadPayload(rawBody);
        const idempotencyScope = {
          actor: request.authContext.account,
          method: request.method,
          path: url.pathname,
          key: parseIdempotencyKey(request),
          hash: requestHash(rawBody),
        };
        const claim = claimIdempotency(db, idempotencyScope);
        if (claim.replay) {
          sendJson(response, claim.status, claim.body);
          return;
        }

        let recognition;
        try {
          recognition = await invoiceRecognizer({
            fileName: body.fileName,
            mediaType: body.mediaType,
            buffer: body.content,
          });
        } catch {
          recognition = {
            status: "review_required",
            extractedText: null,
            ocr: null,
            model: null,
            conflicts: [],
            warnings: ["RECOGNITION_FAILED"],
            fields: {},
          };
        }

        try {
          const responseBody = await withDocumentBlobWritePreflight(db, {
            owner: request.authContext.account,
            content: body.content,
          }, (encodedDocumentBlob) => withImmediateTransaction(db, () => {
            let created;
            try {
              created = invoiceRepository.createInvoice({
                owner: request.authContext.account,
                actor: request.authContext.account,
                source: request.authContext.kind === "machine" ? "weixin" : "manual",
                sourceRef: body.sourceRef,
                fileName: body.fileName,
                mediaType: body.mediaType,
                content: body.content,
                encodedDocumentBlob,
                recognition,
              });
            } catch (error) {
              invoiceRepositoryFailure(error);
            }
            insertAudit(db, {
              action: "invoice.create",
              entityType: "invoice",
              entityId: created.id,
              actor: request.authContext.account,
              requestId,
              before: null,
              after: {
                id: created.id,
                status: created.status,
                version: created.version,
                sizeBytes: created.sizeBytes,
                totalCents: created.totalCents,
                conflictCount: created.conflicts.length,
              },
              entityVersion: created.version,
              metadata: { source: created.source, mediaType: created.mediaType },
            });
            const result = { item: created };
            completeIdempotency(db, {
              ...idempotencyScope,
              claimToken: claim.claimToken,
              status: 201,
              body: result,
            });
            return result;
          }));
          sendJson(response, 201, responseBody);
        } catch (error) {
          releaseIdempotencyClaim(db, { ...idempotencyScope, claimToken: claim.claimToken });
          invoiceRepositoryFailure(error);
        }
        return;
      }

      if (
        request.method === "GET"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "invoices"
        && parts[2]
        && parts[3] === "content"
      ) {
        const item = invoiceRepository.getInvoiceContent(parts[2], {
          owner: request.authContext.account,
        });
        if (!item) notFound();
        sendDocument(response, 200, item.content, {
          "Content-Type": item.mediaType,
          "Content-Length": String(item.sizeBytes),
          "Content-Disposition": inlineContentDisposition(item.fileName),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return;
      }

      if (
        request.method === "GET"
        && parts.length === 3
        && parts[0] === "api"
        && parts[1] === "invoices"
        && parts[2]
      ) {
        const item = invoiceRepository.getInvoice(parts[2], { owner: request.authContext.account });
        if (!item) notFound();
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "DELETE"
        && parts.length === 3
        && parts[0] === "api"
        && parts[1] === "invoices"
        && parts[2]
      ) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const deleted = withImmediateTransaction(db, () => {
          const before = invoiceRepository.getInvoice(parts[2], { owner: request.authContext.account });
          if (!before) notFound();
          let item;
          try {
            item = invoiceRepository.softDeleteInvoice(parts[2], {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
            });
          } catch (error) {
            invoiceRepositoryFailure(error);
          }
          insertAudit(db, {
            action: "invoice.delete",
            entityType: "invoice",
            entityId: item.id,
            actor: request.authContext.account,
            requestId,
            before: { status: before.status, version: before.version, deletedAt: null },
            after: { status: item.status, version: item.version, deletedAt: item.deletedAt },
            entityVersion: item.version,
            metadata: { sizeBytes: item.sizeBytes, mediaType: item.mediaType },
          });
          return item;
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (
        request.method === "PATCH"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "invoices"
        && parts[2]
        && parts[3] === "review"
      ) {
        const expectedVersion = parseExpectedVersion(request);
        const fields = validateInvoiceReviewPayload(await readJson(request));
        const item = withImmediateTransaction(db, () => {
          const before = invoiceRepository.getInvoice(parts[2], { owner: request.authContext.account });
          if (!before) notFound();
          let updated;
          try {
            updated = invoiceRepository.finalizeReview(parts[2], {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
              fields,
            });
          } catch (error) {
            invoiceRepositoryFailure(error);
          }
          insertAudit(db, {
            action: "invoice.review_finalize",
            entityType: "invoice",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before: { status: before.status, version: before.version, conflictCount: before.conflicts.length },
            after: { status: updated.status, version: updated.version, conflictCount: updated.conflicts.length },
            entityVersion: updated.version,
            metadata: { totalCents: updated.totalCents, issuedOn: updated.issuedOn },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "GET"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "travel-expense-weeks"
        && parts[2]
        && parts[3] === "invoice-suggestions"
      ) {
        const items = invoiceRepository.listMatchCandidates({
          owner: request.authContext.account,
          weekStart: parts[2],
          invoiceId: url.searchParams.get("invoiceId") || undefined,
          expenseId: url.searchParams.get("expenseId") || undefined,
          status: url.searchParams.get("status") || undefined,
        });
        sendJson(response, 200, { items });
        return;
      }

      if (
        request.method === "POST"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "invoices"
        && parts[2]
        && parts[3] === "matches"
      ) {
        const expectedInvoiceVersion = parseExpectedVersion(request);
        const body = validateInvoiceMatchPayload(await readJson(request));
        const idempotencyScope = {
          actor: request.authContext.account,
          method: request.method,
          path: url.pathname,
          key: parseIdempotencyKey(request),
          hash: requestHash(body),
        };
        const result = withImmediateTransaction(db, () => {
          const claim = claimIdempotency(db, idempotencyScope);
          if (claim.replay) return { status: claim.status, body: claim.body };
          const invoice = invoiceRepository.getInvoice(parts[2], { owner: request.authContext.account });
          if (!invoice) notFound();
          if (invoice.version !== expectedInvoiceVersion) {
            throw new HttpError(409, "VERSION_CONFLICT", "Invoice was updated by another request", {
              currentVersion: invoice.version,
            });
          }
          let match;
          try {
            match = invoiceRepository.createConfirmedMatch({
              ...body,
              owner: request.authContext.account,
              actor: request.authContext.account,
              invoiceId: parts[2],
              expectedInvoiceVersion,
            });
          } catch (error) {
            invoiceRepositoryFailure(error);
          }
          insertAudit(db, {
            action: "invoice.match_confirm",
            entityType: "invoice_match",
            entityId: match.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: {
              state: match.state,
              invoiceId: match.invoiceId,
              expenseId: match.expenseId,
              paymentId: match.paymentId,
              allocatedCents: match.allocatedCents,
            },
            entityVersion: match.version,
            metadata: { matchMethod: match.matchMethod },
          });
          const responseBody = { item: match };
          completeIdempotency(db, {
            ...idempotencyScope,
            claimToken: claim.claimToken,
            status: 201,
            body: responseBody,
          });
          return { status: 201, body: responseBody };
        });
        sendJson(response, result.status, result.body);
        return;
      }

      if (
        request.method === "DELETE"
        && parts.length === 3
        && parts[0] === "api"
        && parts[1] === "invoice-matches"
        && parts[2]
      ) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const item = withImmediateTransaction(db, () => {
          let revoked;
          try {
            revoked = invoiceRepository.revokeMatch(parts[2], {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
            });
          } catch (error) {
            invoiceRepositoryFailure(error);
          }
          insertAudit(db, {
            action: "invoice.match_revoke",
            entityType: "invoice_match",
            entityId: revoked.id,
            actor: request.authContext.account,
            requestId,
            before: { state: "confirmed" },
            after: { state: revoked.state },
            entityVersion: revoked.version,
            metadata: {
              invoiceId: revoked.invoiceId,
              expenseId: revoked.expenseId,
              allocatedCents: revoked.allocatedCents,
            },
          });
          return revoked;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "POST"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "travel-expenses"
        && parts[2]
        && parts[3] === "no-invoice"
      ) {
        const expectedExpenseVersion = parseExpectedVersion(request);
        const body = validateNoInvoicePayload(await readJson(request));
        const idempotencyScope = {
          actor: request.authContext.account,
          method: request.method,
          path: url.pathname,
          key: parseIdempotencyKey(request),
          hash: requestHash(body),
        };
        const result = withImmediateTransaction(db, () => {
          const claim = claimIdempotency(db, idempotencyScope);
          if (claim.replay) return { status: claim.status, body: claim.body };
          const expense = travelExpenseRepository.getExpense(parts[2], { owner: request.authContext.account });
          if (!expense) notFound();
          if (expense.version !== expectedExpenseVersion) {
            throw new HttpError(409, "VERSION_CONFLICT", "Travel expense was updated by another request", {
              currentVersion: expense.version,
            });
          }
          let confirmation;
          try {
            confirmation = invoiceRepository.confirmNoInvoice({
              ...body,
              owner: request.authContext.account,
              actor: request.authContext.account,
              expenseId: parts[2],
            });
          } catch (error) {
            invoiceRepositoryFailure(error);
          }
          insertAudit(db, {
            action: "travel_expense.no_invoice_confirm",
            entityType: "travel_expense_no_invoice_confirmation",
            entityId: confirmation.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: {
              expenseId: confirmation.expenseId,
              paymentId: confirmation.paymentId,
              amountSnapshotCents: confirmation.amountSnapshotCents,
              active: true,
            },
            entityVersion: confirmation.version,
            metadata: { reasonLength: confirmation.reason.length },
          });
          const responseBody = { item: confirmation };
          completeIdempotency(db, {
            ...idempotencyScope,
            claimToken: claim.claimToken,
            status: 201,
            body: responseBody,
          });
          return { status: 201, body: responseBody };
        });
        sendJson(response, result.status, result.body);
        return;
      }

      if (
        request.method === "DELETE"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "travel-expenses"
        && parts[2]
        && parts[3] === "no-invoice"
      ) {
        const expectedVersion = parseExpectedVersion(request);
        const body = validateNoInvoiceRevokePayload(await readJson(request));
        const item = withImmediateTransaction(db, () => {
          let revoked;
          try {
            revoked = invoiceRepository.revokeNoInvoice(body.confirmationId, {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expenseId: parts[2],
              expectedVersion,
            });
          } catch (error) {
            invoiceRepositoryFailure(error);
          }
          insertAudit(db, {
            action: "travel_expense.no_invoice_revoke",
            entityType: "travel_expense_no_invoice_confirmation",
            entityId: revoked.id,
            actor: request.authContext.account,
            requestId,
            before: { active: true },
            after: { active: false, expenseId: revoked.expenseId, paymentId: revoked.paymentId },
            entityVersion: revoked.version,
            metadata: { amountSnapshotCents: revoked.amountSnapshotCents },
          });
          return revoked;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "GET"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "travel-expense-weeks"
        && parts[2]
        && parts[3] === "invoice-coverage"
      ) {
        const item = invoiceRepository.getWeekInvoiceCoverage({
          owner: request.authContext.account,
          weekStart: parts[2],
        });
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "POST"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "travel-expense-weeks"
        && parts[2]
        && parts[3] === "invoice-suggestions"
      ) {
        const body = plainObject(await readJson(request));
        allowedPayloadKeys(body, new Set());
        const idempotencyScope = {
          actor: request.authContext.account,
          method: request.method,
          path: url.pathname,
          key: parseIdempotencyKey(request),
          hash: requestHash(body),
        };
        const result = withImmediateTransaction(db, () => {
          const claim = claimIdempotency(db, idempotencyScope);
          if (claim.replay) return { status: claim.status, body: claim.body };
          let items;
          try {
            items = invoiceRepository.generateMatchCandidates({
              owner: request.authContext.account,
              actor: request.authContext.account,
              weekStart: parts[2],
            });
          } catch (error) {
            invoiceRepositoryFailure(error);
          }
          insertAudit(db, {
            action: "invoice.suggestions_generate",
            entityType: "travel_expense_week",
            entityId: parts[2],
            actor: request.authContext.account,
            requestId,
            before: null,
            after: { weekStart: parts[2], candidateCount: items.length, status: "suggested" },
            metadata: { proposedCents: items.reduce((sum, item) => sum + item.proposedCents, 0) },
          });
          const responseBody = { items };
          completeIdempotency(db, {
            ...idempotencyScope,
            claimToken: claim.claimToken,
            status: 201,
            body: responseBody,
          });
          return { status: 201, body: responseBody };
        });
        sendJson(response, result.status, result.body);
        return;
      }

      if (
        request.method === "POST"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "invoice-match-candidates"
        && parts[2]
        && ["accept", "reject"].includes(parts[3])
      ) {
        const expectedVersion = parseExpectedVersion(request);
        const body = plainObject(await readJson(request));
        allowedPayloadKeys(body, new Set());
        const idempotencyScope = {
          actor: request.authContext.account,
          method: request.method,
          path: url.pathname,
          key: parseIdempotencyKey(request),
          hash: requestHash({ expectedVersion }),
        };
        const result = withImmediateTransaction(db, () => {
          const claim = claimIdempotency(db, idempotencyScope);
          if (claim.replay) return { status: claim.status, body: claim.body };

          if (parts[3] === "accept") {
            let accepted;
            try {
              accepted = invoiceRepository.acceptMatchCandidate(parts[2], {
                owner: request.authContext.account,
                actor: request.authContext.account,
                expectedVersion,
              });
            } catch (error) {
              invoiceRepositoryFailure(error);
            }
            insertAudit(db, {
              action: "invoice.candidate_accept",
              entityType: "invoice_match_candidate",
              entityId: accepted.candidate.id,
              actor: request.authContext.account,
              requestId,
              before: { status: "suggested", version: expectedVersion },
              after: {
                status: accepted.candidate.status,
                version: accepted.candidate.version,
                acceptedMatchId: accepted.match.id,
              },
              entityVersion: accepted.candidate.version,
              metadata: {
                invoiceId: accepted.candidate.invoiceId,
                expenseId: accepted.candidate.expenseId,
                proposedCents: accepted.candidate.proposedCents,
              },
            });
            const responseBody = { item: accepted.candidate, match: accepted.match };
            completeIdempotency(db, {
              ...idempotencyScope,
              claimToken: claim.claimToken,
              status: 201,
              body: responseBody,
            });
            return { status: 201, body: responseBody };
          }

          let rejected;
          try {
            rejected = invoiceRepository.rejectMatchCandidate(parts[2], {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
            });
          } catch (error) {
            invoiceRepositoryFailure(error);
          }
          insertAudit(db, {
            action: "invoice.candidate_reject",
            entityType: "invoice_match_candidate",
            entityId: rejected.id,
            actor: request.authContext.account,
            requestId,
            before: { status: "suggested", version: expectedVersion },
            after: { status: rejected.status, version: rejected.version },
            entityVersion: rejected.version,
            metadata: {
              invoiceId: rejected.invoiceId,
              expenseId: rejected.expenseId,
              proposedCents: rejected.proposedCents,
            },
          });
          const responseBody = { item: rejected };
          completeIdempotency(db, {
            ...idempotencyScope,
            claimToken: claim.claimToken,
            status: 200,
            body: responseBody,
          });
          return { status: 200, body: responseBody };
        });
        sendJson(response, result.status, result.body);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/travel-expenses") {
        const weekStart = validateTravelExpenseWeekStart(url.searchParams.get("weekStart"));
        const items = travelExpenseRepository.listExpenses({
          owner: request.authContext.account,
          weekStart,
        });
        sendJson(response, 200, { items });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/travel-expenses") {
        const body = validateTravelExpensePayload(await readJson(request));
        const item = withImmediateTransaction(db, () => {
          const created = travelExpenseRepository.createExpense({
            ...body,
            owner: request.authContext.account,
            actor: request.authContext.account,
          });
          triggerFailpoint(options, "travelExpense.create.afterWrite");
          insertAudit(db, {
            action: "travel_expense.create",
            entityType: "travel_expense",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: travelExpenseAuditSnapshot(created),
            entityVersion: created.version,
            metadata: {
              occurredOn: created.occurredOn,
              category: created.category,
              paymentCount: created.payments.length,
            },
          });
          return created;
        });
        sendJson(response, 201, { item });
        return;
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "travel-expenses" &&
        parts[2]
      ) {
        const item = travelExpenseRepository.getExpense(parts[2], {
          owner: request.authContext.account,
        });
        if (!item) notFound();
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "PATCH" &&
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "travel-expenses" &&
        parts[2]
      ) {
        const expectedVersion = parseExpectedVersion(request);
        const body = validateTravelExpensePayload(await readJson(request));
        const item = withImmediateTransaction(db, () => {
          const before = travelExpenseRepository.getExpense(parts[2], {
            owner: request.authContext.account,
          });
          if (!before) notFound();
          let updated;
          try {
            updated = travelExpenseRepository.updateExpense(parts[2], {
              ...body,
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
            });
          } catch (error) {
            travelExpenseRepositoryFailure(error);
          }
          triggerFailpoint(options, "travelExpense.update.afterWrite");
          insertAudit(db, {
            action: "travel_expense.update",
            entityType: "travel_expense",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before: travelExpenseAuditSnapshot(before),
            after: travelExpenseAuditSnapshot(updated),
            entityVersion: updated.version,
            metadata: {
              occurredOn: updated.occurredOn,
              category: updated.category,
              paymentCount: updated.payments.length,
            },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "DELETE" &&
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "travel-expenses" &&
        parts[2]
      ) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const deleted = withImmediateTransaction(db, () => {
          const before = travelExpenseRepository.getExpense(parts[2], {
            owner: request.authContext.account,
          });
          if (!before) notFound();
          let result;
          try {
            result = travelExpenseRepository.softDeleteExpense(parts[2], {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
            });
          } catch (error) {
            travelExpenseRepositoryFailure(error);
          }
          triggerFailpoint(options, "travelExpense.delete.afterWrite");
          insertAudit(db, {
            action: "travel_expense.delete",
            entityType: "travel_expense",
            entityId: result.id,
            actor: request.authContext.account,
            requestId,
            before: travelExpenseAuditSnapshot(before),
            after: travelExpenseAuditSnapshot(result),
            entityVersion: result.version,
            metadata: {
              occurredOn: result.occurredOn,
              category: result.category,
              paymentCount: result.payments.length,
            },
          });
          return result;
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "travel-expenses" &&
        parts[2] &&
        parts[3] === "attachments"
      ) {
        const expectedVersion = parseExpectedVersion(request);
        const body = validateTravelExpenseAttachmentPayload(await readJson(request, {
          maxBytes: TRAVEL_EXPENSE_ATTACHMENT_JSON_MAX_BYTES,
        }));
        let item;
        try {
          item = await withDocumentBlobWritePreflight(db, {
            owner: request.authContext.account,
            content: body.content,
          }, (encodedDocumentBlob) => withImmediateTransaction(db, () => {
            const before = travelExpenseRepository.getExpense(parts[2], {
              owner: request.authContext.account,
            });
            if (!before) notFound();
            let updated;
            try {
              updated = travelExpenseRepository.addAttachment(parts[2], {
                ...body,
                owner: request.authContext.account,
                actor: request.authContext.account,
                expectedVersion,
                encodedDocumentBlob,
              });
            } catch (error) {
              travelExpenseRepositoryFailure(error);
            }
            const previousIds = new Set(before.attachments.map((attachment) => attachment.id));
            const added = updated.attachments.find((attachment) => !previousIds.has(attachment.id));
            if (!added) throw new Error("Travel expense attachment write did not return the new attachment");
            triggerFailpoint(options, "travelExpense.attachmentAdd.afterWrite");
            insertAudit(db, {
              action: "travel_expense.attachment_add",
              entityType: "travel_expense_attachment",
              entityId: added.id,
              actor: request.authContext.account,
              requestId,
              before: null,
              after: travelExpenseAttachmentAuditSnapshot(added),
              entityVersion: updated.version,
              metadata: {
                expenseId: updated.id,
                expenseVersion: updated.version,
                kind: added.kind,
                sizeBytes: added.sizeBytes,
              },
            });
            return updated;
          }));
        } catch (error) {
          travelExpenseRepositoryFailure(error);
        }
        sendJson(response, 201, { item });
        return;
      }

      if (
        request.method === "GET" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "travel-expense-attachments" &&
        parts[2] &&
        parts[3] === "content"
      ) {
        const item = travelExpenseRepository.getAttachmentContent(parts[2], {
          owner: request.authContext.account,
        });
        if (!item) notFound();
        sendDocument(response, 200, item.content, {
          "Content-Type": item.mediaType,
          "Content-Length": String(item.sizeBytes),
          "Content-Disposition": inlineContentDisposition(item.fileName),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return;
      }

      if (
        request.method === "DELETE" &&
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "travel-expense-attachments" &&
        parts[2]
      ) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const item = withImmediateTransaction(db, () => {
          const attachmentRow = get(
            db,
            `SELECT a.id, a.expense_id
             FROM travel_expense_attachments a
             JOIN travel_expenses e ON e.id = a.expense_id
             WHERE a.id = $id AND e.owner = $owner AND e.deleted_at IS NULL`,
            { $id: parts[2], $owner: request.authContext.account },
          );
          if (!attachmentRow) notFound();
          const beforeExpense = travelExpenseRepository.getExpense(attachmentRow.expense_id, {
            owner: request.authContext.account,
          });
          const beforeAttachment = beforeExpense?.attachments.find((attachment) => attachment.id === parts[2]);
          if (!beforeAttachment) notFound();
          let updated;
          try {
            updated = travelExpenseRepository.deleteAttachment(parts[2], {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
            });
          } catch (error) {
            travelExpenseRepositoryFailure(error);
          }
          triggerFailpoint(options, "travelExpense.attachmentDelete.afterWrite");
          insertAudit(db, {
            action: "travel_expense.attachment_delete",
            entityType: "travel_expense_attachment",
            entityId: beforeAttachment.id,
            actor: request.authContext.account,
            requestId,
            before: travelExpenseAttachmentAuditSnapshot(beforeAttachment),
            after: null,
            entityVersion: updated.version,
            metadata: {
              expenseId: updated.id,
              expenseVersion: updated.version,
              kind: beforeAttachment.kind,
              sizeBytes: beforeAttachment.sizeBytes,
            },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/travel-expense-advances") {
        const weekStart = validateTravelExpenseWeekStart(url.searchParams.get("weekStart"));
        const items = travelExpenseRepository.listAdvances({
          owner: request.authContext.account,
          weekStart,
        });
        sendJson(response, 200, { items });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/travel-expense-advances") {
        const body = validateTravelExpenseAdvancePayload(await readJson(request));
        const item = withImmediateTransaction(db, () => {
          const created = travelExpenseRepository.createAdvance({
            ...body,
            owner: request.authContext.account,
            actor: request.authContext.account,
          });
          triggerFailpoint(options, "travelExpense.advanceCreate.afterWrite");
          insertAudit(db, {
            action: "travel_expense_advance.create",
            entityType: "travel_expense_advance",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: created,
            entityVersion: created.version,
            metadata: {
              weekStart: created.weekStart,
              status: created.status,
              requestedCents: created.requestedCents,
              receivedCents: created.receivedCents,
            },
          });
          return created;
        });
        sendJson(response, 201, { item });
        return;
      }

      if (
        request.method === "PATCH" &&
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "travel-expense-advances" &&
        parts[2]
      ) {
        const expectedVersion = parseExpectedVersion(request);
        const body = validateTravelExpenseAdvancePayload(await readJson(request));
        const item = withImmediateTransaction(db, () => {
          const before = activeTravelExpenseAdvance(db, parts[2], request.authContext.account);
          if (!before) notFound();
          let updated;
          try {
            updated = travelExpenseRepository.updateAdvance(parts[2], {
              ...body,
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
            });
          } catch (error) {
            travelExpenseRepositoryFailure(error);
          }
          triggerFailpoint(options, "travelExpense.advanceUpdate.afterWrite");
          insertAudit(db, {
            action: "travel_expense_advance.update",
            entityType: "travel_expense_advance",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before,
            after: updated,
            entityVersion: updated.version,
            metadata: {
              weekStart: updated.weekStart,
              status: updated.status,
              requestedCents: updated.requestedCents,
              receivedCents: updated.receivedCents,
            },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "DELETE" &&
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "travel-expense-advances" &&
        parts[2]
      ) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const deleted = withImmediateTransaction(db, () => {
          const before = activeTravelExpenseAdvance(db, parts[2], request.authContext.account);
          if (!before) notFound();
          let result;
          try {
            result = travelExpenseRepository.softDeleteAdvance(parts[2], {
              owner: request.authContext.account,
              actor: request.authContext.account,
              expectedVersion,
            });
          } catch (error) {
            travelExpenseRepositoryFailure(error);
          }
          triggerFailpoint(options, "travelExpense.advanceDelete.afterWrite");
          insertAudit(db, {
            action: "travel_expense_advance.delete",
            entityType: "travel_expense_advance",
            entityId: result.id,
            actor: request.authContext.account,
            requestId,
            before,
            after: result,
            entityVersion: result.version,
            metadata: {
              weekStart: result.weekStart,
              status: result.status,
              requestedCents: result.requestedCents,
              receivedCents: result.receivedCents,
            },
          });
          return result;
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/itineraries") {
        const status = url.searchParams.get("status") || undefined;
        let items;
        try {
          items = itineraryRepository.list({ status });
        } catch (error) {
          if (error instanceof TypeError) validationFailure("status", "enum");
          throw error;
        }
        sendJson(response, 200, { items });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/itineraries") {
        const body = validateVisitItineraryRequest(await readJson(request));
        const snapshotRequest = { ...body, status: body.status ?? "planned" };
        const plan = await buildItineraryPlan(snapshotRequest);
        const item = withImmediateTransaction(db, () => {
          const created = itineraryRepository.create({
            title: snapshotRequest.title,
            visitDate: snapshotRequest.visitDate,
            status: snapshotRequest.status,
            request: snapshotRequest,
            plan,
            actor: request.authContext.account,
          });
          triggerFailpoint(options, "itinerary.create.afterWrite");
          insertAudit(db, {
            action: "visit_itinerary.create",
            entityType: "visit_itinerary",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: itineraryAuditSnapshot(created),
            entityVersion: created.version,
            metadata: {
              visitDate: created.visitDate,
              status: created.status,
              stopCount: created.request.stops.length,
            },
          });
          return created;
        });
        sendJson(response, 201, { item });
        return;
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "itineraries" &&
        parts[2]
      ) {
        const item = itineraryRepository.get(parts[2]);
        if (!item) notFound();
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "PATCH" &&
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "itineraries" &&
        parts[2]
      ) {
        const expectedVersion = parseExpectedVersion(request);
        const body = validateVisitItineraryRequest(await readJson(request));
        const current = itineraryRepository.get(parts[2]);
        if (!current) notFound();
        if (current.version !== expectedVersion) {
          throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
            currentVersion: current.version,
          });
        }
        const snapshotRequest = { ...body, status: body.status ?? current.status };
        const plan = await buildItineraryPlan(snapshotRequest);
        const item = withImmediateTransaction(db, () => {
          const before = itineraryRepository.get(parts[2]);
          if (!before) notFound();
          let updated;
          try {
            updated = itineraryRepository.update(parts[2], {
              expectedVersion,
              title: snapshotRequest.title,
              visitDate: snapshotRequest.visitDate,
              status: snapshotRequest.status,
              request: snapshotRequest,
              plan,
              actor: request.authContext.account,
            });
          } catch (error) {
            itineraryRepositoryFailure(error);
          }
          triggerFailpoint(options, "itinerary.update.afterWrite");
          insertAudit(db, {
            action: "visit_itinerary.update",
            entityType: "visit_itinerary",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before: itineraryAuditSnapshot(before),
            after: itineraryAuditSnapshot(updated),
            entityVersion: updated.version,
            metadata: {
              visitDate: updated.visitDate,
              status: updated.status,
              stopCount: updated.request.stops.length,
              replanned: true,
            },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "DELETE" &&
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "itineraries" &&
        parts[2]
      ) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const deleted = withImmediateTransaction(db, () => {
          const before = itineraryRepository.get(parts[2]);
          if (!before) notFound();
          let result;
          try {
            result = itineraryRepository.softDelete(parts[2], {
              expectedVersion,
              actor: request.authContext.account,
            });
          } catch (error) {
            itineraryRepositoryFailure(error);
          }
          triggerFailpoint(options, "itinerary.delete.afterWrite");
          insertAudit(db, {
            action: "visit_itinerary.delete",
            entityType: "visit_itinerary",
            entityId: result.id,
            actor: request.authContext.account,
            requestId,
            before: itineraryAuditSnapshot(before),
            after: itineraryAuditSnapshot(result),
            entityVersion: result.version,
            metadata: {
              visitDate: result.visitDate,
              status: result.status,
              stopCount: result.request.stops.length,
            },
          });
          return result;
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/integrations/weixin-agent/login") {
        sendJson(response, 200, { item: weixinLoginBinding.current() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/integrations/weixin-agent/login") {
        await validateEmptyBody(request);
        sendJson(response, 201, { item: weixinLoginBinding.start() });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/integrations/weixin-agent/login") {
        await validateEmptyBody(request);
        sendJson(response, 200, { item: weixinLoginBinding.stop() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/customers") {
        const rows = all(db, "SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY created_at ASC");
        sendJson(response, 200, { items: rows.map(customerFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/customers") {
        const body = await readValidatedJson(request, requestSchemas.customerCreate);
        const item = withImmediateTransaction(db, () => {
          const created = createCustomer(db, body);
          insertAudit(db, {
            action: "customer.create",
            entityType: "customer",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: created,
            entityVersion: created.version,
            metadata: { name: created.name, region: created.region, level: created.level },
          });
          return created;
        });
        sendJson(response, 201, { item });
        return;
      }

      if (request.method === "GET" && parts[0] === "api" && parts[1] === "customers" && parts[2]) {
        const item = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL", { $id: parts[2] }));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "customers" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, customerPatchSchema);
        const item = withImmediateTransaction(db, () => {
          const before = customerFromRow(get(
            db,
            "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL",
            { $id: parts[2] },
          ));
          if (!before) notFound();
          const updated = updateCustomer(db, parts[2], body, expectedVersion);
          if (!updated) notFound();
          insertAudit(db, {
            action: "customer.update",
            entityType: "customer",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before,
            after: updated,
            entityVersion: updated.version,
            metadata: { changedFields: Object.keys(body) },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "customers" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const deleted = softDeleteRecord(db, {
          table: "customers",
          id: parts[2],
          expectedVersion,
          fromRow: customerFromRow,
          action: "customer.delete",
          entityType: "customer",
          deletedBy: request.authContext.account,
          requestId,
          metadata: (before) => ({ name: before.name, region: before.region, level: before.level }),
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/opportunities") {
        const rows = all(
          db,
          `SELECT opportunities.*
           FROM opportunities
           INNER JOIN customers ON customers.id = opportunities.customer_id
           WHERE opportunities.deleted_at IS NULL
             AND customers.deleted_at IS NULL
           ORDER BY opportunities.created_at ASC`,
        );
        sendJson(response, 200, { items: rows.map(opportunityFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/opportunities") {
        const body = await readValidatedJson(request, requestSchemas.opportunityCreate);
        const item = withImmediateTransaction(db, () => {
          const customer = requireActiveCustomer(db, body.customerId);
          const created = createOpportunity(db, { ...body, customer: customer.name });
          insertAudit(db, {
            action: "opportunity.create",
            entityType: "opportunity",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: created,
            entityVersion: created.version,
            metadata: { name: created.name, customerId: created.customerId, stage: created.stage },
          });
          return created;
        });
        sendJson(response, 201, { item });
        return;
      }

      if (request.method === "GET" && parts[0] === "api" && parts[1] === "opportunities" && parts[2]) {
        const item = opportunityFromRow(activeOpportunityEntityRow(db, parts[2]));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "opportunities" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, opportunityPatchSchema);
        const item = withImmediateTransaction(db, () => {
          const before = opportunityFromRow(activeOpportunityEntityRow(db, parts[2]));
          if (!before) notFound();
          const customer = requireActiveCustomer(db, body.customerId ?? before.customerId);
          const updated = updateOpportunity(db, parts[2], { ...body, customer: customer.name }, expectedVersion);
          if (!updated) notFound();
          insertAudit(db, {
            action: "opportunity.update",
            entityType: "opportunity",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before,
            after: updated,
            entityVersion: updated.version,
            metadata: {
              changedFields: Object.keys(body),
              stage: updated.stage,
              probability: updated.probability,
            },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "opportunities" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const deleted = softDeleteRecord(db, {
          table: "opportunities",
          id: parts[2],
          expectedVersion,
          fromRow: opportunityFromRow,
          action: "opportunity.delete",
          entityType: "opportunity",
          deletedBy: request.authContext.account,
          requestId,
          metadata: (before) => ({ name: before.name, customerId: before.customerId, stage: before.stage }),
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/actions") {
        const rows = all(
          db,
          `SELECT * FROM action_items
           WHERE deleted_at IS NULL
           ORDER BY
             CASE priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
             updated_at DESC`,
        );
        sendJson(response, 200, { items: rows.map(actionFromRow) });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "actions" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, requestSchemas.actionPatch);
        const item = withImmediateTransaction(db, () => {
          const before = actionFromRow(get(
            db,
            "SELECT * FROM action_items WHERE id = $id AND deleted_at IS NULL",
            { $id: parts[2] },
          ));
          if (!before) notFound();
          const updated = updateActionItem(db, parts[2], body, expectedVersion);
          if (!updated) notFound();
          if (updated.error === "invalid_status") {
            badRequest(response, "status must be pending, in_progress, done, or deferred");
          }
          insertAudit(db, {
            action: "action.update",
            entityType: "action",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before,
            after: updated,
            entityVersion: updated.version,
            metadata: { status: updated.status, due: updated.due, changedFields: Object.keys(body) },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "actions" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const deleted = softDeleteRecord(db, {
          table: "action_items",
          id: parts[2],
          expectedVersion,
          fromRow: actionFromRow,
          action: "action.delete",
          entityType: "action",
          deletedBy: request.authContext.account,
          requestId,
          metadata: (before) => ({ title: before.title, customerId: before.customerId, status: before.status }),
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/risks") {
        const rows = all(
          db,
          `SELECT * FROM risk_items
           WHERE deleted_at IS NULL
           ORDER BY
             CASE severity WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
             score DESC,
             updated_at DESC`,
        );
        sendJson(response, 200, { items: rows.map(riskFromRow) });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "risks" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, requestSchemas.riskPatch);
        const item = withImmediateTransaction(db, () => {
          const before = riskFromRow(get(
            db,
            "SELECT * FROM risk_items WHERE id = $id AND deleted_at IS NULL",
            { $id: parts[2] },
          ));
          if (!before) notFound();
          const updated = updateRiskItem(db, parts[2], body, expectedVersion);
          if (!updated) notFound();
          if (updated.error === "invalid_status") {
            badRequest(response, "status must be open, accepted, in_progress, deferred, or closed");
          }
          insertAudit(db, {
            action: "risk.update",
            entityType: "risk",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before,
            after: updated,
            entityVersion: updated.version,
            metadata: { status: updated.status, due: updated.due, changedFields: Object.keys(body) },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "risks" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const deleted = softDeleteRecord(db, {
          table: "risk_items",
          id: parts[2],
          expectedVersion,
          fromRow: riskFromRow,
          action: "risk.delete",
          entityType: "risk",
          deletedBy: request.authContext.account,
          requestId,
          metadata: (before) => ({ title: before.title, status: before.status, sourceType: before.sourceType }),
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/knowledge") {
        const rows = all(db, "SELECT * FROM knowledge_items WHERE deleted_at IS NULL ORDER BY updated_at DESC, title ASC");
        sendJson(response, 200, { items: rows.map(knowledgeFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/knowledge") {
        const body = await readValidatedJson(request, requestSchemas.knowledgeCreate);
        const item = withImmediateTransaction(db, () => {
          const created = createKnowledgeItem(db, {
            ...body,
            title: String(body.title).trim(),
          });
          insertAudit(db, {
            action: "knowledge.create",
            entityType: "knowledge",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: created,
            entityVersion: created.version,
            metadata: { title: created.title, category: created.category, tags: created.tags },
          });
          return created;
        });
        sendJson(response, 201, { item });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "knowledge" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, knowledgePatchSchema);
        const item = withImmediateTransaction(db, () => {
          const before = knowledgeFromRow(get(
            db,
            "SELECT * FROM knowledge_items WHERE id = $id AND deleted_at IS NULL",
            { $id: parts[2] },
          ));
          if (!before) notFound();
          const updated = updateKnowledgeItem(db, parts[2], body, expectedVersion);
          if (!updated) notFound();
          insertAudit(db, {
            action: "knowledge.update",
            entityType: "knowledge",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before,
            after: updated,
            entityVersion: updated.version,
            metadata: { changedFields: Object.keys(body), title: updated.title },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "knowledge" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const deleted = softDeleteRecord(db, {
          table: "knowledge_items",
          id: parts[2],
          expectedVersion,
          fromRow: knowledgeFromRow,
          action: "knowledge.delete",
          entityType: "knowledge",
          deletedBy: request.authContext.account,
          requestId,
          metadata: (before) => ({ title: before.title, category: before.category }),
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/knowledge/search") {
        const body = await readValidatedJson(
          request,
          requestSchemas.knowledgeSearch,
          { allowEmpty: true },
        );
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
        const body = await readValidatedJson(
          request,
          requestSchemas.riskDiagnose,
          { allowEmpty: true },
        );
        const sourceType = body.sourceType ?? "opportunity_diagnosis";
        const sourceId = body.sourceId ?? parts[2];
        const items = withImmediateTransaction(db, () => {
          const opportunity = opportunityFromRow(activeOpportunityEntityRow(db, parts[2]));
          if (!opportunity) notFound();
          const customer = customerFromRow(get(
            db,
            "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL",
            { $id: opportunity.customerId },
          ));
          if (!customer) notFound();

          return buildOpportunityRiskDrafts({
            customer,
            opportunity,
            sourceType,
            sourceId,
          }).map((draft) => {
            const before = riskFromRow(findRiskItemRowForDraft(db, draft));
            const item = upsertRiskItem(db, draft);
            insertAudit(db, {
              action: "risk.diagnose",
              entityType: "risk",
              entityId: item.id,
              actor: request.authContext.account,
              requestId,
              before,
              after: item,
              entityVersion: item.version,
              metadata: {
                customerId: item.customerId,
                opportunityId: item.opportunityId,
                sourceType: item.sourceType,
                sourceId: item.sourceId,
              },
            });
            return item;
          });
        });
        sendJson(response, 201, { items });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/quick-records") {
        const rows = all(db, "SELECT * FROM quick_records WHERE voided_at IS NULL ORDER BY created_at DESC");
        sendJson(response, 200, { items: rows.map((row) => quickRecordHistoryFromRow(db, row)) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/quick-records/preview") {
        const body = await readValidatedJson(request, requestSchemas.quickRecordPreview);
        const rawContent = String(body.rawContent ?? "").trim();

        const analysis = await analyzeQuickRecord(rawContent, runtimeConfig, {
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
        const body = await readValidatedJson(request, requestSchemas.quickRecordCreate);
        const rawContent = String(body.rawContent ?? "").trim();
        const item = withImmediateTransaction(db, () => {
          validateCustomerOpportunityPair(db, body.customerId, body.opportunityId);
          const id = randomUUID();
          run(
            db,
            `INSERT INTO quick_records (
              id, owner, raw_content, occurred_at, source_channel, customer_id, opportunity_id
            ) VALUES (
              $id, $owner, $rawContent, $occurredAt, $sourceChannel, $customerId, $opportunityId
            )`,
            {
              $id: id,
              $owner: request.authContext.account,
              $rawContent: rawContent,
              $occurredAt: body.occurredAt ?? null,
              $sourceChannel: body.sourceChannel ?? "快速记录",
              $customerId: body.customerId ?? null,
              $opportunityId: body.opportunityId ?? null,
            },
          );
          const created = quickRecordFromRow(get(db, "SELECT * FROM quick_records WHERE id = $id", { $id: id }));
          insertAudit(db, {
            action: "quick_record.create",
            entityType: "quick_record",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: created,
            entityVersion: created.version,
            metadata: {
              sourceChannel: created.sourceChannel,
              customerId: created.customerId,
              opportunityId: created.opportunityId,
            },
          });
          return created;
        });
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
        await validateEmptyBody(request);
        const quickRecord = quickRecordFromRow(
          get(db, "SELECT * FROM quick_records WHERE id = $id", { $id: parts[2] }),
        );
        if (!quickRecord) return notFound(response);

        const analysis = await analyzeQuickRecord(quickRecord.rawContent, runtimeConfig, {
          fetchImpl: options.fetchImpl,
        });
        if (!analysis) return badRequest(response, "quick record content is empty");

        const result = withImmediateTransaction(db, () => {
          const current = quickRecordFromRow(get(
            db,
            "SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL",
            { $id: quickRecord.id },
          ));
          if (!current) notFound();

          const id = randomUUID();
          run(
            db,
            `INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
             VALUES ($id, $quickRecordId, $source, $confidence, $analysisJson)`,
            {
              $id: id,
              $quickRecordId: current.id,
              $source: analysis.source,
              $confidence: analysis.confidence ?? 70,
              $analysisJson: JSON.stringify(analysis),
            },
          );
          run(db, "UPDATE quick_records SET status = 'analyzed', updated_at = CURRENT_TIMESTAMP WHERE id = $id", {
            $id: current.id,
          });
          const updatedRecord = quickRecordFromRow(get(
            db,
            "SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL",
            { $id: current.id },
          ));
          const insight = insightFromRow(get(db, "SELECT * FROM ai_insights WHERE id = $id", { $id: id }));
          insertAudit(db, {
            action: "quick_record.analyze",
            entityType: "quick_record",
            entityId: current.id,
            actor: request.authContext.account,
            requestId,
            before: { quickRecord: current, insight: null },
            after: { quickRecord: updatedRecord, insight },
            entityVersion: updatedRecord.version,
            metadata: { insightId: insight.id, source: insight.source, confidence: insight.confidence },
          });
          return { insight, quickRecord: updatedRecord };
        });
        sendJson(response, 201, { item: result.insight, quickRecord: result.quickRecord });
        return;
      }

      if (
        request.method === "PATCH" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "quick-records" &&
        parts[2] &&
        parts[3] === "analysis"
      ) {
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, requestSchemas.quickRecordAnalysisPatch);
        if (Object.keys(body.summary).length === 0) validationFailure("summary", "minKeys");

        const result = withImmediateTransaction(db, () => {
          const beforeRecord = quickRecordFromRow(get(
            db,
            "SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL",
            { $id: parts[2] },
          ));
          if (!beforeRecord) notFound();
          const insightRow = getLatestInsightRow(db, beforeRecord.id);
          if (!insightRow) notFound();

          const persistedAnalysis = parseJson(insightRow.analysis_json, null);
          if (!persistedAnalysis?.summary || typeof persistedAnalysis.summary !== "object") {
            throw new HttpError(500, "DATA_INTEGRITY_ERROR", "Saved quick-record analysis is invalid");
          }
          const nextSummary = { ...persistedAnalysis.summary };
          for (const [key, text] of Object.entries(body.summary)) {
            const current = nextSummary[key];
            if (!current || typeof current !== "object" || Array.isArray(current)) {
              throw new HttpError(500, "DATA_INTEGRITY_ERROR", "Saved quick-record analysis summary is invalid");
            }
            nextSummary[key] = { ...current, text };
          }
          const nextAnalysisJson = {
            ...persistedAnalysis,
            summary: nextSummary,
          };

          runVersionedUpdate(db, {
            table: "quick_records",
            id: beforeRecord.id,
            expectedVersion,
            softDeletable: false,
            setSql: "status = $status",
            params: { $status: beforeRecord.status },
          });
          run(
            db,
            "UPDATE ai_insights SET analysis_json = $analysisJson WHERE id = $id",
            {
              $id: insightRow.id,
              $analysisJson: JSON.stringify(nextAnalysisJson),
            },
          );

          const quickRecord = quickRecordFromRow(get(
            db,
            "SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL",
            { $id: beforeRecord.id },
          ));
          const beforeAnalysis = insightFromRow(insightRow);
          const analysis = insightFromRow(get(
            db,
            "SELECT * FROM ai_insights WHERE id = $id",
            { $id: insightRow.id },
          ));
          insertAudit(db, {
            action: "quick_record.analysis.update",
            entityType: "quick_record",
            entityId: quickRecord.id,
            actor: request.authContext.account,
            requestId,
            before: { quickRecord: beforeRecord, analysis: beforeAnalysis },
            after: { quickRecord, analysis },
            entityVersion: quickRecord.version,
            metadata: {
              insightId: analysis.id,
              summaryFields: Object.keys(body.summary),
            },
          });
          return { quickRecord, analysis };
        });
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/ai/sales-decisions") {
        const items = salesDecisionRepository.list({
          customerId: url.searchParams.get("customerId") || undefined,
          opportunityId: url.searchParams.get("opportunityId") || undefined,
          quickRecordId: url.searchParams.get("quickRecordId") || undefined,
        });
        sendJson(response, 200, { items });
        return;
      }

      if (
        request.method === "GET" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "ai" &&
        parts[2] === "sales-decisions" &&
        parts[3]
      ) {
        const item = salesDecisionRepository.get(parts[3]);
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/ai/sales-decisions") {
        const body = await readValidatedJson(request, requestSchemas.salesDecisionAnalyze);
        const context = buildSalesDecisionContext(db, body);
        const inputSnapshot = buildSalesDecisionInputSnapshot(context);
        const analysis = await analyzeSalesDecision(context, runtimeConfig, {
          fetchImpl: options.fetchImpl,
        });
        const item = withImmediateTransaction(db, () => {
          const created = salesDecisionRepository.create({
            analysisType: context.analysisType,
            industry: context.industry,
            customerId: context.customerId,
            opportunityId: context.opportunityId,
            quickRecordId: context.quickRecordId,
            input: inputSnapshot,
            analysis,
            source: analysis.source,
            createdBy: request.authContext.account,
          });
          insertAudit(db, {
            action: "sales_decision_analysis.create",
            entityType: "sales_decision_analysis",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: {
              id: created.id,
              version: created.version,
              analysisType: created.analysisType,
              customerId: created.customerId,
              opportunityId: created.opportunityId,
              quickRecordId: created.quickRecordId,
              source: created.source,
              analysisTypeResult: created.analysis.analysisType,
            },
            entityVersion: created.version,
            metadata: {
              source: created.source,
              decision: created.analysis.decision?.code,
              score: created.analysis.score?.total,
            },
          });
          return created;
        });
        sendJson(response, 201, { item });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/ai/suggestions") {
        const body = await readValidatedJson(request, requestSchemas.aiSuggestion);
        const type = String(body.type ?? "").trim();
        const title = String(body.title ?? "").trim();

        const suggestion = await generateManualSuggestion(
          {
            type,
            title,
            context: body.context && typeof body.context === "object" ? body.context : {},
          },
          runtimeConfig,
          { fetchImpl: options.fetchImpl },
        );
        const item = withImmediateTransaction(db, () => {
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
          const created = aiSuggestionFromRow(get(db, "SELECT * FROM ai_suggestions WHERE id = $id", { $id: id }));
          insertAudit(db, {
            action: "ai.suggestion.generate",
            entityType: "ai_suggestion",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: created,
            metadata: {
              type: created.type,
              title: created.title,
              sourceRefs: created.sourceRefs.length,
            },
          });
          return created;
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
        const idempotencyKey = parseIdempotencyKey(request);
        const expectedQuickRecordVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, requestSchemas.confirmation);
        const targets = Array.from(new Set(body.targets ?? []));
        requireConfirmationTargetVersions(body, targets);
        const idempotencyScope = {
          actor: request.authContext.account,
          method: request.method,
          path: url.pathname,
          key: idempotencyKey,
          hash: requestHash(body),
        };

        const result = withImmediateTransaction(db, () => {
          const claim = claimIdempotency(db, idempotencyScope);
          if (claim.replay) return { status: claim.status, body: claim.body };

          const quickRecord = quickRecordFromRow(get(
            db,
            "SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL",
            { $id: parts[2] },
          ));
          if (!quickRecord) notFound();
          if (quickRecord.version !== expectedQuickRecordVersion) {
            throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
              currentVersion: quickRecord.version,
            });
          }

          const insight = body.analysisVersionId
            ? insightFromRow(get(
              db,
              "SELECT * FROM ai_insights WHERE id = $id AND quick_record_id = $quickRecordId",
              { $id: body.analysisVersionId, $quickRecordId: quickRecord.id },
            ))
            : getLatestInsight(db, quickRecord.id);
          if (body.analysisVersionId && !insight) notFound();

          const nextCustomerId = targets.includes("customer")
            ? insight?.customer?.id ?? quickRecord.customerId
            : quickRecord.customerId;
          const nextOpportunityId = targets.includes("opportunity")
            ? insight?.opportunity?.id ?? quickRecord.opportunityId
            : quickRecord.opportunityId;
          const finalCustomer = nextCustomerId
            ? customerFromRow(get(
              db,
              "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL",
              { $id: nextCustomerId },
            ))
            : null;
          const finalOpportunity = nextOpportunityId
            ? opportunityFromRow(activeOpportunityEntityRow(db, nextOpportunityId))
            : null;
          if (nextCustomerId && !finalCustomer) validationFailure("customerId");
          if (nextOpportunityId && !finalOpportunity) validationFailure("opportunityId");
          if (finalCustomer && finalOpportunity && finalOpportunity.customerId !== finalCustomer.id) {
            validationFailure("opportunityId", "relationship");
          }
          const customerBefore = targets.includes("customer") ? finalCustomer : null;
          const opportunityBefore = targets.includes("opportunity") ? finalOpportunity : null;
          if (customerBefore && customerBefore.version !== body.targetVersions.customer) {
            throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
              currentVersion: customerBefore.version,
            });
          }
          if (opportunityBefore && opportunityBefore.version !== body.targetVersions.opportunity) {
            throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
              currentVersion: opportunityBefore.version,
            });
          }

          const confirmationsBefore = all(
            db,
            "SELECT * FROM manual_confirmations WHERE quick_record_id = $quickRecordId ORDER BY target ASC",
            { $quickRecordId: quickRecord.id },
          ).map(confirmationFromRow);
          const actionBefore = actionFromRow(get(
            db,
            "SELECT * FROM action_items WHERE source_record_id = $sourceRecordId AND deleted_at IS NULL",
            { $sourceRecordId: quickRecord.id },
          ));
          const riskBefore = riskFromRow(getActiveQuickRecordRiskRow(db, quickRecord.id));

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

          runVersionedUpdate(db, {
            table: "quick_records",
            id: quickRecord.id,
            expectedVersion: expectedQuickRecordVersion,
            softDeletable: false,
            setSql: `status = 'confirmed',
                 customer_id = $customerId,
                 opportunity_id = $opportunityId`,
            params: {
              $customerId: nextCustomerId ?? null,
              $opportunityId: nextOpportunityId ?? null,
            },
          });
          const updatedRecord = quickRecordFromRow(get(
            db,
            "SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL",
            { $id: quickRecord.id },
          ));
          const updatedCustomer = customerBefore
            ? syncCustomerFromQuickRecord(
              db,
              nextCustomerId,
              body.targetVersions.customer,
              updatedRecord,
              insight,
            )
            : null;
          const updatedOpportunity = opportunityBefore
            ? syncOpportunityFromQuickRecord(
              db,
              nextOpportunityId,
              body.targetVersions.opportunity,
              updatedRecord,
              insight,
            )
            : null;
          const derivedCustomer = updatedCustomer ?? finalCustomer;
          const derivedOpportunity = updatedOpportunity ?? finalOpportunity;
          const writesBusinessTargets = customerBefore || opportunityBefore;
          const action = writesBusinessTargets
            ? upsertActionFromQuickRecord(db, updatedRecord, insight, derivedCustomer, derivedOpportunity)
            : null;
          triggerFailpoint(options, "confirm.afterAction");
          const risk = writesBusinessTargets
            ? upsertRiskFromQuickRecord(db, updatedRecord, insight, derivedCustomer, derivedOpportunity)
            : null;
          const actionAfter = actionFromRow(get(
            db,
            "SELECT * FROM action_items WHERE source_record_id = $sourceRecordId AND deleted_at IS NULL",
            { $sourceRecordId: quickRecord.id },
          ));
          const riskAfter = riskFromRow(getActiveQuickRecordRiskRow(db, quickRecord.id));
          const confirmations = all(
            db,
            "SELECT * FROM manual_confirmations WHERE quick_record_id = $quickRecordId ORDER BY target ASC",
            { $quickRecordId: quickRecord.id },
          ).map(confirmationFromRow);
          const responseBody = {
            confirmations,
            quickRecord: updatedRecord,
            analysis: insight,
            ...(updatedCustomer ? { customer: updatedCustomer } : {}),
            ...(updatedOpportunity ? { opportunity: updatedOpportunity } : {}),
            ...(action ? { action } : {}),
            ...(risk ? { risk } : {}),
          };
          const auditEvidence = (record, customer, opportunity, confirmationRows, actionItem, riskItem) => ({
            quickRecord: {
              id: record.id,
              version: record.version,
              status: record.status,
              customerId: record.customerId,
              opportunityId: record.opportunityId,
            },
            customer: customer ? { id: customer.id, version: customer.version } : null,
            opportunity: opportunity ? { id: opportunity.id, version: opportunity.version } : null,
            confirmations: confirmationRows.map((item) => ({ id: item.id, target: item.target })),
            action: actionItem ? { id: actionItem.id, version: actionItem.version } : null,
            risk: riskItem ? { id: riskItem.id, version: riskItem.version, title: riskItem.title } : null,
          });
          insertAudit(db, {
            action: "quick_record.confirm",
            entityType: "quick_record",
            entityId: updatedRecord.id,
            actor: request.authContext.account,
            requestId,
            metadata: {
              targets,
              analysisVersionId: body.analysisVersionId ?? null,
            },
            before: auditEvidence(
              quickRecord,
              customerBefore,
              opportunityBefore,
              confirmationsBefore,
              actionBefore,
              riskBefore,
            ),
            after: auditEvidence(
              updatedRecord,
              updatedCustomer,
              updatedOpportunity,
              confirmations,
              actionAfter,
              riskAfter,
            ),
            entityVersion: updatedRecord.version,
          });
          completeIdempotency(db, {
            ...idempotencyScope,
            claimToken: claim.claimToken,
            status: 201,
            body: responseBody,
          });
          return { status: 201, body: responseBody };
        });
        sendJson(response, result.status, result.body);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reports/weekly/draft") {
        const body = await readValidatedJson(request, requestSchemas.weeklyDraft);
        const knowledgeIds = normalizeKnowledgeIds(body.knowledgeIds);
        if (knowledgeIds === null) {
          validationFailure("knowledgeIds", "array");
        }
        const knowledge = getKnowledgeItemsByIds(db, knowledgeIds);
        if (knowledge.length !== knowledgeIds.length) {
          validationFailure("knowledgeIds");
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
          runtimeConfig,
          { fetchImpl: options.fetchImpl },
        );

        const item = withImmediateTransaction(db, () => {
          if (getKnowledgeItemsByIds(db, knowledgeIds).length !== knowledgeIds.length) {
            validationFailure("knowledgeIds");
          }
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
          const created = weeklyReportFromRow(get(db, "SELECT * FROM weekly_reports WHERE id = $id", { $id: id }));
          insertAudit(db, {
            action: "weekly_report.draft",
            entityType: "weekly_report",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: created,
            entityVersion: created.version,
            metadata: {
              periodStart: created.periodStart,
              periodEnd: created.periodEnd,
              sourceRefs: created.sourceRefs.length,
              knowledgeIds,
            },
          });
          return created;
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
        const item = weeklyReportFromRow(get(db, "SELECT * FROM weekly_reports WHERE id = $id AND deleted_at IS NULL", { $id: parts[3] }));
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
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, requestSchemas.weeklyPatch);
        const item = withImmediateTransaction(db, () => {
          const before = weeklyReportFromRow(get(
            db,
            "SELECT * FROM weekly_reports WHERE id = $id AND deleted_at IS NULL",
            { $id: parts[3] },
          ));
          if (!before) notFound();
          const updated = updateWeeklyReport(db, parts[3], body, expectedVersion);
          if (!updated) notFound();
          if (updated.error === "invalid_status") {
            badRequest(response, "status must be draft, saved, or ready");
          }
          insertAudit(db, {
            action: "weekly_report.update",
            entityType: "weekly_report",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before,
            after: updated,
            entityVersion: updated.version,
            metadata: { status: updated.status, changedFields: Object.keys(body) },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (
        request.method === "DELETE" &&
        parts[0] === "api" &&
        parts[1] === "reports" &&
        parts[2] === "weekly" &&
        parts[3]
      ) {
        const expectedVersion = parseExpectedVersion(request);
        await validateEmptyBody(request);
        const deleted = softDeleteRecord(db, {
          table: "weekly_reports",
          id: parts[3],
          expectedVersion,
          fromRow: weeklyReportFromRow,
          action: "weekly_report.delete",
          entityType: "weekly_report",
          deletedBy: request.authContext.account,
          requestId,
          metadata: (before) => ({
            owner: before.owner,
            periodStart: before.periodStart,
            periodEnd: before.periodEnd,
            status: before.status,
          }),
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (
        request.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "reports" &&
        parts[2] === "weekly" &&
        parts[3]
      ) {
        const item = weeklyReportFromRow(get(db, "SELECT * FROM weekly_reports WHERE id = $id AND deleted_at IS NULL", { $id: parts[3] }));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/solutions") {
        const items = activeSolutionDraftRows(db).map(solutionDraftFromRow);
        sendJson(response, 200, { items });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/solutions/draft") {
        if (!config.solutionWritesEnabled) {
          throw new HttpError(403, "FEATURE_DISABLED", "Solution writes are disabled");
        }
        const body = await readValidatedJson(request, requestSchemas.solutionDraft);
        const artifactType = body.artifactType === undefined
          ? "solution_framework"
          : String(body.artifactType);
        const knowledgeIds = normalizeKnowledgeIds(body.knowledgeIds);
        if (knowledgeIds === null) {
          validationFailure("knowledgeIds", "array");
        }

        const customer = customerFromRow(get(db, "SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL", { $id: body.customerId }));
        const opportunity = opportunityFromRow(activeOpportunityEntityRow(db, body.opportunityId));
        validateCustomerOpportunityPair(db, body.customerId, body.opportunityId);
        const selectedKnowledge = getKnowledgeItemsByIds(db, knowledgeIds);
        if (selectedKnowledge.length !== knowledgeIds.length) {
          validationFailure("knowledgeIds");
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
          runtimeConfig,
          { fetchImpl: options.fetchImpl },
        );

        const item = withImmediateTransaction(db, () => {
          validateCustomerOpportunityPair(db, body.customerId, body.opportunityId);
          if (getKnowledgeItemsByIds(db, knowledgeIds).length !== knowledgeIds.length) {
            validationFailure("knowledgeIds");
          }
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
          const created = solutionDraftFromRow(get(db, "SELECT * FROM solution_drafts WHERE id = $id", { $id: id }));
          insertAudit(db, {
            action: "solution_draft.generate",
            entityType: "solution_draft",
            entityId: created.id,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: created,
            entityVersion: created.version,
            metadata: {
              customerId: created.customerId,
              opportunityId: created.opportunityId,
              artifactType: created.artifactType,
              sourceRefs: created.sourceRefs.length,
              knowledgeIds,
            },
          });
          return created;
        });
        sendJson(response, 201, { item });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "solutions" && parts[2]) {
        if (!config.solutionWritesEnabled) {
          throw new HttpError(403, "FEATURE_DISABLED", "Solution writes are disabled");
        }
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, requestSchemas.solutionPatch);
        const item = withImmediateTransaction(db, () => {
          const before = solutionDraftFromRow(activeSolutionDraftRow(db, parts[2]));
          if (!before) notFound();
          runVersionedUpdate(db, {
            table: "solution_drafts",
            id: before.id,
            expectedVersion,
            softDeletable: false,
            setSql: `title = $title,
                   content = $content,
                   status = $status`,
            params: {
              $title: body.title ?? before.title,
              $content: body.content ?? before.content,
              $status: body.status ?? before.status,
            },
          });
          const updated = solutionDraftFromRow(get(
            db,
            "SELECT * FROM solution_drafts WHERE id = $id",
            { $id: before.id },
          ));
          insertAudit(db, {
            action: "solution_draft.update",
            entityType: "solution_draft",
            entityId: updated.id,
            actor: request.authContext.account,
            requestId,
            before,
            after: updated,
            entityVersion: updated.version,
            metadata: {
              status: updated.status,
              artifactType: updated.artifactType,
              changedFields: Object.keys(body),
            },
          });
          return updated;
        });
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "GET" && parts[0] === "api" && parts[1] === "solutions" && parts[2]) {
        const item = solutionDraftFromRow(activeSolutionDraftRow(db, parts[2]));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      notFound(response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendHttpError(response, error, responseOptions(response));
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
