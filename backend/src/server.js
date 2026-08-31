import { createHash, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createAsrService } from "./asr/asrService.js";
import {
  ASR_ROUTE,
  ASR_STATUS_ROUTE,
  createDeferredUnreadBodyFinalizer,
  createAsrHttpHandlers,
} from "./asr/http.js";

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
import { hashPassword, validatePasswordHashEncoding, verifyPassword } from "./auth/password.js";
import {
  createCsrfToken,
  createSession,
  getActiveSession,
  revokeSession,
  revokeSessionsForAccount,
} from "./auth/session.js";
import {
  UserNotFoundError,
  UserVersionConflictError,
  countActiveAdmins,
  createUser,
  ensureBootstrapAdmin,
  getUser,
  isValidUserAccount,
  listUsers,
  recordLastLogin,
  updateUserVersioned,
} from "./auth/usersStore.js";
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
import {
  recognizeInvoiceDocument,
  validateDocumentFileName,
} from "./travelExpense/invoiceRecognition.js";
import {
  createLocalDocumentTextExtractor,
  probeLocalDocumentTextTools,
} from "./travelExpense/localDocumentTextExtractor.js";
import { createDocumentVisionAnalyzer } from "./travelExpense/documentVisionAnalysis.js";
import { createLocalPdfImageRenderer } from "./travelExpense/localPdfImageRenderer.js";
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
  TravelExpenseRegionProfileVersionConflictError,
  createTravelExpenseRegionRepository,
  normalizeTravelExpenseRegionProfileInput,
} from "./travelExpense/regionRepository.js";
import {
  applyShortcutSelectionAnalysis,
  createShortcutBookkeepingRepository,
} from "./integrations/shortcutBookkeepingRepository.js";
import { createShortcutAdvanceAllocationRepository } from "./integrations/shortcutAdvanceAllocationRepository.js";
import { planVisitItinerary } from "./itinerary/planner.js";
import { AmapServiceError, createAmapClient } from "./maps/amapClient.js";
import { createMockAmapClient } from "./maps/amapMockClient.js";
import { createOpsAlertService } from "./ops/opsAlertService.js";
import { createOpsAlertPushplusNotifier } from "./ops/opsAlertPushplusNotifier.js";
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
  assertCorsPreflightRequestHeaders,
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
import { createAssistantAgentRunRepository } from "./assistant/agentRunRepository.js";
import { createAssistantBusinessSnapshotAdapter } from "./assistant/businessSnapshotAdapter.js";
import { createAssistantSettlementSnapshotAdapter } from "./assistant/settlementSnapshotAdapter.js";
import { createAssistantOrchestrator } from "./assistant/orchestrator.js";
import { createAgentRegistry } from "./assistant/agentRegistry.js";
import { createAssistantWebHttpHandlers } from "./assistant/webHttpHandlers.js";
import { createAssistantRouter } from "./assistant/router.js";
import { createAssistantToolHandlers } from "./assistant/runtimeHandlers.js";
import {
  createCustomerAssistantAdapter,
  createCustomerPendingPreviewProviders,
} from "./assistant/customerAssistantAdapter.js";
import { createOpportunityAssistantAdapter } from "./assistant/opportunityAssistantAdapter.js";
import { createVisitCaptureAssistantAdapter } from "./assistant/visitCaptureAssistantAdapter.js";
import { createQuickRecordPendingPreviewProviders } from "./assistant/quickRecordPendingPreviewProviders.js";
import {
  assertQuickRecordConfirmationEditable,
  createQuickRecordStore,
} from "./quickRecords/quickRecordStore.js";
import {
  QuickRecordConfirmationError,
  createQuickRecordConfirmationService,
} from "./quickRecords/confirmationService.js";
import {
  QuickRecordConfirmationRepositoryError,
  createQuickRecordConfirmationRepositories,
} from "./quickRecords/confirmationRepository.js";
import { createActionItemStore } from "./actionItems/actionItemStore.js";
import { createActionReminderScheduler } from "./actionReminders/reminderScheduler.js";
import {
  addDays,
  createDigestContentBuilder,
  shanghaiDateParts,
  weekStartOf,
} from "./dailyDigest/digestContent.js";
import { KNOWN_STAGES } from "./opportunities/stageVocabulary.js";
import { createDailyDigestScheduler } from "./dailyDigest/digestScheduler.js";
import { renderDailyDigestMessage, renderFridayCloseoutMessage } from "./dailyDigest/digestMessage.js";
import { createActionItemPendingPreviewProviders } from "./assistant/actionItemPendingPreviewProviders.js";
import { createBusinessOwnerResolver } from "./assistant/businessOwnerResolver.js";
import { createShortcutBookkeepingAssistantRuntime } from "./assistant/shortcutBookkeepingRuntime.js";
import { reconcileWeixinInvoiceAttachments } from "./assistant/weixinInvoiceAttachment.js";
import { createSalesLoopContextRepository } from "./assistant/salesLoopContextRepository.js";
import { createSalesLoopPreviewService } from "./assistant/salesLoopPreview.js";
import { createSalesReportAssistantAdapter } from "./assistant/salesReportAssistantAdapter.js";
import { assertWeixinGroupAllowed, validateWeixinAssistantEvent } from "./assistant/weixinEvent.js";
import { createWeixinBindingGate } from "./assistant/weixinBindingGate.js";
import { issueBindingCode, pruneExpiredBindingCodes } from "./weixin/bindingCodes.js";
import {
  createWeixinBindingsRepository,
  ensureBootstrapBinding,
  weixinSenderHash,
} from "./weixin/bindingsRepository.js";
import { shortcutBookkeepingConversationId } from "./weixin/bookkeepingDeliveryScope.js";
import { createWeixinConfirmationOutboxRepository } from "./weixin/outboxRepository.js";
import { createWeixinDeliveryReadiness } from "./weixin/deliveryReadiness.js";
import { buildWeeklyDraft } from "./weeklyDraft.js";
import { createHospitalTenderRepository } from "./hospitalTender/repository.js";
import { createHospitalTenderSchedulerRepository } from "./hospitalTender/schedulerRepository.js";
import { createHospitalTenderScheduler } from "./hospitalTender/scheduler.js";
import {
  ASR_SETTING_KEY,
  createSecureSettingsRepository,
  DEEPSEEK_SETTING_KEY,
  PUSHPLUS_SETTING_KEY,
} from "./settings/repository.js";
import { isValidSettingsEncryptionKey, maskSecret } from "./settings/secretBox.js";
import {
  ingestHospitalTenderSnapshot,
  normalizeHospitalTenderSyncPayload,
  serializeHospitalTenderNotice,
  serializeHospitalTenderSource,
} from "./hospitalTender/sync.js";
import { createInternalHospitalTenderRunner } from "./hospitalTender/internalRunner.js";
import { createHospitalTenderNotifier } from "./hospitalTender/notifier.js";
import { createHospitalTenderWeixinNotifier } from "./hospitalTender/weixinNotifier.js";
import {
  partialSchema,
  requestSchemas,
  validateVisitItineraryRequest,
  validateObject,
} from "./validation/requests.js";
import {
  createCustomer,
  customerFromRow,
  softDeleteCustomer,
  updateCustomer,
} from "./customers/customerStore.js";
import {
  activeOpportunityEntityRow,
  createOpportunity,
  opportunityFromRow,
  updateOpportunity,
} from "./opportunities/opportunityStore.js";
import { createOpportunityPendingPreviewProviders } from "./assistant/opportunityPendingPreviewProviders.js";

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
const WEIXIN_ASSISTANT_EVENT_ROUTE = "/api/integrations/weixin-agent/events";
const WEIXIN_OUTBOX_ROUTE = "/api/integrations/weixin-agent/confirmation-outbox";
// v0.9.3 多绑定就绪哨兵：worker 侧无唯一 expectedScope，可达性判定移到逐条投递期。
const WEIXIN_MULTI_DELIVERY_SCOPE = "weixin:multi:v1";

export function isRetiredBookkeepingPath(pathname) {
  const value = typeof pathname === "string" ? pathname : "";
  return value === "/api/integrations/icost/expenses"
    || value.startsWith("/api/integrations/shortcut/")
    || value === "/api/settings/icost-token"
    || value === "/api/settings/icost-token/rotate";
}

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

function shortcutResponseItem(item, replayed, extra = {}) {
  return {
    id: item.id,
    status: item.status,
    targetSystem: item.targetSystem,
    ledgerName: item.ledgerName,
    entryType: item.entryType,
    category: item.category,
    subcategory: item.subcategory,
    note: item.note,
    warnings: item.warnings,
    expenseId: item.expenseId,
    paymentId: item.paymentId,
    expenseReferenceCode: item.expenseReferenceCode,
    remoteId: item.remoteId,
    remoteReference: item.remoteReference,
    remoteStatus: item.remoteStatus,
    replayed,
    ...extra,
  };
}

function shortcutReviewResponseItem(item, replayed = false, ledgerReceipt = null) {
  return {
    ...shortcutResponseItem(item, replayed),
    ledgerReceipt,
    rawText: item.rawText,
    analysis: item.analysis,
    analysisProvider: item.analysisProvider,
    analysisModel: item.analysisModel,
    errorCode: item.errorCode,
    attemptCount: item.attemptCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
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

function attachmentContentDisposition(fileName) {
  return `attachment; filename*=UTF-8''${encodeContentDispositionFileName(fileName)}`;
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

function validateShortcutReviewConfirmPayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set(["analysis"]));
  const analysis = plainObject(body.analysis, "analysis");
  return { analysis };
}

function validateShortcutReviewRejectPayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set(["reason"]));
  return { reason: payloadText(body.reason, "reason", { max: 1_000 }) };
}

function validateWeixinOutboxAckPayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set(["id", "leaseToken", "ok", "providerMessageId", "errorCode", "terminal", "check"]));
  if (body.check === true) {
    if (body.ok !== undefined || body.providerMessageId !== undefined || body.errorCode !== undefined || body.terminal !== undefined) {
      validationFailure("check", "exclusive");
    }
    return {
      id: payloadText(body.id, "id", { max: 200 }),
      leaseToken: payloadText(body.leaseToken, "leaseToken", { max: 200 }),
      check: true,
    };
  }
  if (body.check !== undefined) validationFailure("check", "true_or_omitted");
  if (typeof body.ok !== "boolean") validationFailure("ok", "boolean");
  if (body.terminal !== undefined && typeof body.terminal !== "boolean") validationFailure("terminal", "boolean");
  if (body.ok && body.terminal === true) validationFailure("terminal", "false_when_ok");
  return {
    id: payloadText(body.id, "id", { max: 200 }),
    leaseToken: payloadText(body.leaseToken, "leaseToken", { max: 200 }),
    ok: body.ok,
    check: false,
    terminal: body.terminal === true,
    providerMessageId: payloadText(body.providerMessageId, "providerMessageId", { optional: true, max: 200 }),
    errorCode: payloadText(body.errorCode, "errorCode", { optional: true, max: 100 }),
  };
}

function weixinDeliveryReportFromHeaders(headers, expectedScope = null) {
  const rawStatus = headers["x-weixin-delivery-status"];
  if (rawStatus === undefined) return { status: "not_ready", reason: "worker_status_missing" };
  if (typeof rawStatus !== "string" || !["ready", "not_ready"].includes(rawStatus)) {
    validationFailure("X-Weixin-Delivery-Status", "ready_or_not_ready");
  }
  const rawReason = headers["x-weixin-delivery-reason"];
  if (rawReason !== undefined && (
    typeof rawReason !== "string"
    || !/^[a-z0-9_]{1,64}$/u.test(rawReason)
  )) validationFailure("X-Weixin-Delivery-Reason", "safe_reason");
  if (rawStatus === "ready") {
    const rawScope = headers["x-weixin-delivery-scope"];
    if (typeof expectedScope !== "string" || !expectedScope) {
      return { status: "not_ready", reason: "configuration_incomplete" };
    }
    if (rawScope === undefined) return { status: "not_ready", reason: "worker_scope_missing" };
    if (typeof rawScope !== "string" || rawScope !== expectedScope) {
      return { status: "not_ready", reason: "delivery_scope_mismatch" };
    }
  }
  return {
    status: rawStatus,
    ...(rawStatus === "not_ready" ? { reason: rawReason ?? "status_unspecified" } : {}),
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

function quickRecordConfirmationFailure(error) {
  if (error instanceof QuickRecordConfirmationError) {
    const status = error.status === 400 ? 422 : error.status;
    throw new HttpError(status, error.code, error.message, error.details ?? undefined);
  }
  if (error instanceof QuickRecordConfirmationRepositoryError) {
    const status = error.code === "NOT_FOUND"
      ? 404
      : error.code === "NO_CONFIRMATION_CHANGES"
        ? 409
        : 500;
    throw new HttpError(status, error.code, error.message);
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
    confirmationPreviewId: row.confirmation_preview_id ?? null,
    confirmationPreviewStatus: row.confirmation_preview_status ?? null,
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
    entries: parseJson(row.entries_json),
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
    owner: row.owner ?? null,
    remindAt: row.remind_at ?? null,
    remindedAt: row.reminded_at ?? null,
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

// v0.9.2 Web 硬隔离基座：user 与 machine 身份一律以自身 account 作 owner 谓词
//（读=WHERE 过滤，写=服务端注入并忽略 body）；anonymous 仅存在于
// AUTH_REQUIRED=false 的单人开发/测试模式，保持历史全库视角，写路径回落
// LEGACY_OWNER（与迁移 0031 的 DEFAULT 'jiangjz' 同语义）。
const LEGACY_OWNER = "jiangjz";

function requestOwner(request) {
  const identity = request.authContext;
  if (
    !identity
    || identity.kind === "anonymous"
    || typeof identity.account !== "string"
    || !identity.account.trim()
  ) {
    return null;
  }
  return identity.account;
}

function ownerClause(owner, column = "owner") {
  return owner ? ` AND ${column} = $owner` : "";
}

function ownerParams(owner, params = {}) {
  return owner ? { ...params, $owner: owner } : params;
}

function hospitalTenderCustomerNameMap(db, owner = null) {
  return new Map(
    all(
      db,
      `SELECT id, name FROM customers WHERE deleted_at IS NULL${ownerClause(owner)} ORDER BY id ASC`,
      ownerParams(owner),
    ).map((row) => [row.id, row.name]),
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

function shanghaiInstantIso(dateOnly, time = "00:00:00") {
  return new Date(`${dateOnly}T${time}+08:00`).toISOString();
}

// Today-focus aggregation for the web dashboard. v0.9.2 起按会话账号硬过滤
//（与差旅域同模板）；owner=null 仅出现在 AUTH_REQUIRED=false 的单人开发模式，
// 维持历史全库视角。招标段保持全局（外部公开情报）。
function dashboardTodayFocus(db, { today, customers, highRisks, tenderRepository, owner = null }) {
  const itineraryRows = all(
    db,
    `SELECT id, title, plan_json
     FROM visit_itineraries
     WHERE deleted_at IS NULL AND status = 'planned' AND visit_date = $today${ownerClause(owner)}
     ORDER BY updated_at DESC, id
     LIMIT 4`,
    ownerParams(owner, { $today: today }),
  );
  const itineraries = itineraryRows.slice(0, 3).map((row) => {
    let firstStop = "";
    try {
      const plan = JSON.parse(row.plan_json);
      const stops = Array.isArray(plan?.stops) ? plan.stops : [];
      const orderedIds = Array.isArray(plan?.orderedStopIds) ? plan.orderedStopIds : [];
      const first = stops.find((stop) => stop?.id === orderedIds[0]) ?? stops[0];
      firstStop = typeof first?.customerName === "string" ? first.customerName.trim() : "";
    } catch {
      // A corrupted plan snapshot still surfaces the itinerary by title.
    }
    return { id: row.id, title: row.title, firstStop };
  });

  const todayStartIso = shanghaiInstantIso(today);
  const tomorrowStartIso = shanghaiInstantIso(addDays(today, 1));
  const todoRows = all(
    db,
    `SELECT id, title, priority, remind_at
     FROM action_items
     WHERE deleted_at IS NULL AND status IN ('pending', 'in_progress')
       AND remind_at IS NOT NULL AND remind_at < $tomorrowStartIso${ownerClause(owner)}
     ORDER BY remind_at ASC
     LIMIT 8`,
    ownerParams(owner, { $tomorrowStartIso: tomorrowStartIso }),
  );
  const overdueCount = todoRows.filter((row) => row.remind_at < todayStartIso).length;

  const riskItems = highRisks.slice(0, 3).map((risk) => ({
    id: risk.id,
    customerName: customers.find((customer) => customer.id === risk.customerId)?.name ?? "",
    title: risk.title,
    score: risk.score,
    severity: risk.severity,
  }));

  // Same "since yesterday 09:00 Asia/Shanghai" anchor as the daily digest, so
  // the web card and the WeChat morning message agree on what counts as new.
  let tenders = { highCount: 0, items: [] };
  if (tenderRepository) {
    const anchorIso = shanghaiInstantIso(addDays(today, -1), "09:00:00");
    tenders = {
      highCount: tenderRepository.countNotices({ firstSeenFrom: anchorIso, relevance: "high" }),
      items: tenderRepository
        .listNotices({ firstSeenFrom: anchorIso, relevance: "high", limit: 3 })
        .map((notice) => ({ id: notice.id, title: notice.title, sourceName: notice.sourceName })),
    };
  }

  return {
    date: today,
    itineraries: { count: itineraryRows.length, items: itineraries },
    todos: {
      overdueCount,
      todayCount: todoRows.length - overdueCount,
      items: todoRows.slice(0, 4).map((row) => ({
        id: row.id,
        title: row.title,
        priority: row.priority,
        remindAt: row.remind_at,
        overdue: row.remind_at < todayStartIso,
      })),
    },
    risks: { count: highRisks.length, items: riskItems },
    tenders,
  };
}

// Natural-week (Monday-start, Asia/Shanghai) this-week/last-week comparison.
// Reuses the sales-report quick-record scope, the travel-expense weekly-total
// scope, and approximates todo completion time by updated_at (complete/confirm
// both rewrite it; the ±8h substr approximation is accepted for trend display).
function dashboardWeeklyTrend(db, { weekStart, previousWeekStart, owner = null }) {
  const quickRecordCount = (start) => Number(get(
    db,
    `SELECT COUNT(*) AS count FROM quick_records
     WHERE voided_at IS NULL
       AND date(substr(COALESCE(occurred_at, created_at), 1, 10))
           BETWEEN $weekStart AND date($weekStart, '+6 days')${ownerClause(owner)}`,
    ownerParams(owner, { $weekStart: start }),
  )?.count ?? 0);
  const expenseCents = (start) => Number(get(
    db,
    `SELECT COALESCE(SUM(payment.reimbursement_cents), 0) AS cents
     FROM travel_expenses expense
     JOIN travel_expense_payments payment ON payment.expense_id = expense.id
     WHERE expense.deleted_at IS NULL
       AND expense.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')${ownerClause(owner, "expense.owner")}`,
    ownerParams(owner, { $weekStart: start }),
  )?.cents ?? 0);
  const completedTodoCount = (start) => Number(get(
    db,
    `SELECT COUNT(*) AS count FROM action_items
     WHERE deleted_at IS NULL AND status = 'done'
       AND date(substr(updated_at, 1, 10))
           BETWEEN $weekStart AND date($weekStart, '+6 days')${ownerClause(owner)}`,
    ownerParams(owner, { $weekStart: start }),
  )?.count ?? 0);

  return {
    weekStart,
    previousWeekStart,
    quickRecords: { current: quickRecordCount(weekStart), previous: quickRecordCount(previousWeekStart) },
    expenseCents: { current: expenseCents(weekStart), previous: expenseCents(previousWeekStart) },
    completedTodos: { current: completedTodoCount(weekStart), previous: completedTodoCount(previousWeekStart) },
  };
}

function dashboardQuickRecordNeedsConfirmation(record) {
  if (["completed", "cancelled"].includes(record?.confirmationPreviewStatus)) return false;
  if (record?.status === "confirmed") return false;
  return record?.confirmationPreviewStatus === "open" || record?.status === "analyzed";
}

function dashboardSummaryFromDb(db, { now = new Date(), tenderRepository = null, owner = null } = {}) {
  const customers = all(
    db,
    `SELECT * FROM customers WHERE deleted_at IS NULL${ownerClause(owner)} ORDER BY relation DESC, updated_at DESC`,
    ownerParams(owner),
  ).map(customerFromRow);
  const opportunities = all(
    db,
    `SELECT opportunities.*
     FROM opportunities
     INNER JOIN customers ON customers.id = opportunities.customer_id
     WHERE opportunities.deleted_at IS NULL
       AND customers.deleted_at IS NULL${ownerClause(owner, "opportunities.owner")}
     ORDER BY opportunities.probability DESC, opportunities.updated_at DESC`,
    ownerParams(owner),
  ).map(opportunityFromRow);
  const priorityRank = (value) => {
    const text = String(value ?? "");
    if (text.includes("高") || text.includes("楂")) return 0;
    if (text.includes("中") || text.includes("涓")) return 1;
    return 2;
  };
  const actions = all(
    db,
    `SELECT * FROM action_items WHERE deleted_at IS NULL${ownerClause(owner)} ORDER BY updated_at DESC`,
    ownerParams(owner),
  )
    .map(actionFromRow)
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));
  const risks = all(
    db,
    `SELECT * FROM risk_items WHERE deleted_at IS NULL${ownerClause(owner)} ORDER BY score DESC, updated_at DESC`,
    ownerParams(owner),
  ).map(riskFromRow);
  const quickRecords = all(
    db,
    `SELECT * FROM quick_records WHERE 1 = 1${ownerClause(owner)} ORDER BY occurred_at DESC, created_at DESC`,
    ownerParams(owner),
  ).map(quickRecordFromRow);
  const openActions = actions.filter((item) => item.status !== "done");
  const openRisks = risks.filter((item) => item.status !== "closed");
  const highRisks = openRisks.filter((item) => item.score >= 80 || item.severity === "高" || item.severity === "楂?");
  const forecast = opportunities.reduce((total, item) => total + numberFromText(item.amount), 0);

  // Fixed seven-stage funnel in vocabulary order (zero-count stages included),
  // unknown stages appended in encounter order; per-stage amount reuses the
  // KPI "万" parsing so both surfaces under-count non-standard amount text the
  // same way.
  const stageAggregate = new Map();
  for (const item of opportunities) {
    const stage = String(item.stage ?? "").trim();
    if (!stage) continue;
    const entry = stageAggregate.get(stage) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += numberFromText(item.amount);
    stageAggregate.set(stage, entry);
  }
  const stageOrder = [
    ...KNOWN_STAGES,
    ...[...stageAggregate.keys()].filter((stage) => !KNOWN_STAGES.includes(stage)),
  ];
  const stageCounts = stageOrder.map((stage) => {
    const entry = stageAggregate.get(stage) ?? { count: 0, amount: 0 };
    return {
      stage,
      count: entry.count,
      amount: entry.amount > 0 ? `共 ${Math.round(entry.amount)} 万` : "",
    };
  });

  const today = shanghaiDateParts(now).date;
  const weekStart = weekStartOf(today);
  const todayFocus = dashboardTodayFocus(db, { today, customers, highRisks, tenderRepository, owner });
  const weeklyTrend = dashboardWeeklyTrend(db, {
    weekStart,
    previousWeekStart: addDays(weekStart, -7),
    owner,
  });

  return {
    metrics: {
      quickRecords: {
        value: quickRecords.length,
        badge: `${quickRecords.filter(dashboardQuickRecordNeedsConfirmation).length} 条待确认`,
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
    todayFocus,
    weeklyTrend,
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

const auditScopeActionPrefixes = {
  bookkeeping: [
    "travel_expense.",
    "travel_expense_advance.",
    "travel_expense_document_inbox.",
    "invoice.",
    "shortcut_bookkeeping.",
    "bookkeeping_client.",
  ],
};

const bookkeepingClientEvents = new Set([
  "print_expense_list",
  "print_invoices",
  "export_expense_xlsx",
]);

/** Allowed detail fields only; everything else is dropped fail-closed. */
function bookkeepingClientEventMetadata(body, account) {
  const metadata = { owner: account };
  if (typeof body.weekStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.weekStart)) {
    metadata.weekStart = body.weekStart;
  }
  if (Number.isSafeInteger(body.itemCount) && body.itemCount >= 0 && body.itemCount <= 10000) {
    metadata.itemCount = body.itemCount;
  }
  if (typeof body.context === "string" && body.context.trim() && body.context.length <= 200) {
    metadata.context = body.context.trim();
  }
  return metadata;
}

function listAuditLogs(db, searchParams, account) {
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit")) || 100, 500));
  const scope = searchParams.get("scope") || null;
  if (scope !== null && !Object.hasOwn(auditScopeActionPrefixes, scope)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { scope: "allowlist" });
  }
  // Scope prefixes are server-side constants, never user input. GLOB keeps
  // underscores literal (LIKE would treat them as single-char wildcards).
  const scopeClause = scope === null ? "" : ` AND (${
    auditScopeActionPrefixes[scope].map((prefix) => `action GLOB '${prefix}*'`).join(" OR ")
  })`;
  return all(
    db,
    `SELECT * FROM audit_logs
     WHERE (actor = $account OR json_extract(metadata_json, '$.owner') = $account)
       AND ($action IS NULL OR action = $action)
       AND ($entityType IS NULL OR entity_type = $entityType)
       AND ($entityId IS NULL OR entity_id = $entityId)${scopeClause}
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

// v0.9.1 角色门禁：角色每请求从 users 表读取，无缓存。机器令牌不进入本闸——
// admin 路由不在任何 INTEGRATION_ROUTES 白名单内，全局机器闸已回 403。
function requireAdminRole(db, request) {
  if (request.authContext?.kind !== "user") return unauthorized();
  const user = getUser(db, request.authContext.account);
  if (!user || user.role !== "admin" || user.status !== "active") {
    throw new HttpError(403, "ADMIN_ROLE_REQUIRED", "Administrator role is required");
  }
  return user;
}

function userResponseItem(user) {
  if (!user) return null;
  return {
    account: user.account,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    version: user.version,
  };
}

const USER_PASSWORD_MIN_LENGTH = 10;

function assertUserPasswordPolicy(password) {
  if (typeof password !== "string" || password.length < USER_PASSWORD_MIN_LENGTH) {
    validationFailure("password", "policy");
  }
}

function weixinBindingResponseItem(binding, userDisplayName = null) {
  if (!binding) return null;
  return {
    senderId: binding.senderId,
    account: binding.account,
    userDisplayName,
    displayName: binding.displayName,
    financialEnabled: binding.financialEnabled,
    digestEnabled: binding.digestEnabled,
    status: binding.status,
    boundAt: binding.boundAt,
    boundBy: binding.boundBy,
    version: binding.version,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
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

function pushplusDeliveryErrorCode(error) {
  const code = String(error?.message ?? "notification_failed");
  return new Set([
    "notification unavailable",
    "notification rejected",
    "notification response invalid",
    "notification content too large",
    "notification batch too large",
  ]).has(code)
    ? code.replaceAll(" ", "_")
    : "notification_failed";
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

function parseRegionProfileExpectedVersion(request) {
  const rawHeaderCount = Array.isArray(request.rawHeaders)
    ? request.rawHeaders.filter((value, index) => index % 2 === 0 && String(value).toLowerCase() === "if-match").length
    : 0;
  const rawValue = request.headers["if-match"];
  const match = rawHeaderCount === 1 && typeof rawValue === "string"
    ? /^"(0|[1-9]\d*)"$/u.exec(rawValue)
    : null;
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new HttpError(428, "PRECONDITION_REQUIRED", "A current quoted region profile version is required");
  }
  return version;
}

function validateTravelExpenseRegionProfilePayload(value) {
  const body = plainObject(value);
  allowedPayloadKeys(body, new Set(["weekStart", "cities", "defaultCity", "dateOverrides"]));
  try {
    return normalizeTravelExpenseRegionProfileInput(body);
  } catch (error) {
    const message = String(error?.message ?? "");
    const field = ["weekStart", "cities", "defaultCity", "dateOverrides"]
      .find((candidate) => message.includes(candidate)) ?? "regionProfile";
    validationFailure(field, "invalid");
  }
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
  extraWhereSql = "",
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
       ${extraWhereSql}
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

function withConsistentReadSnapshot(db, work) {
  if (db.isTransaction) return work();
  db.exec("BEGIN DEFERRED");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      if (error instanceof Error) {
        try {
          Object.defineProperty(error, "rollbackError", {
            value: rollbackError,
            configurable: true,
          });
        } catch {
          // Preserve the original read failure even when it cannot be extended.
        }
      }
    }
    throw error;
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
  owner = null,
}) {
  return withImmediateTransaction(db, () => {
    // owner 谓词进 before 读取：跨账号查无行 → 404，先于版本比对（不泄露 currentVersion）。
    const beforeRow = get(
      db,
      `SELECT * FROM ${table} WHERE id = $id${ownerClause(owner)}`,
      ownerParams(owner, { $id: id }),
    );
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

function activeCustomerRow(db, id, owner) {
  if (!id) return null;
  const ownerClause = owner === undefined || owner === null ? "" : " AND owner = $owner";
  return get(
    db,
    `SELECT id, name FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause}`,
    owner === undefined || owner === null ? { $id: id } : { $id: id, $owner: owner },
  );
}

function activeOpportunityRow(db, id, owner) {
  if (!id) return null;
  const row = activeOpportunityEntityRow(db, id, owner);
  return row ? { id: row.id, customerId: row.customer_id } : null;
}

function activeSolutionDraftRow(db, id, owner = null) {
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
     WHERE solution_drafts.id = $id${ownerClause(owner, "solution_drafts.owner")}`,
    ownerParams(owner, { $id: id }),
  );
}

function activeSolutionDraftRows(db, owner = null) {
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
     WHERE 1 = 1${ownerClause(owner, "solution_drafts.owner")}
     ORDER BY solution_drafts.updated_at DESC, solution_drafts.created_at DESC`,
    ownerParams(owner),
  );
}

function requireActiveCustomer(db, id, owner) {
  const customer = activeCustomerRow(db, id, owner);
  if (!customer) validationFailure("customerId");
  return customer;
}

function requireActiveOpportunity(db, id, owner) {
  const opportunity = activeOpportunityRow(db, id, owner);
  if (!opportunity) validationFailure("opportunityId");
  return opportunity;
}

function validateCustomerOpportunityPair(db, customerId, opportunityId, { owner } = {}) {
  if (customerId) requireActiveCustomer(db, customerId, owner);
  if (!opportunityId) return;
  const opportunity = requireActiveOpportunity(db, opportunityId, owner);
  if (customerId && opportunity.customerId !== customerId) {
    validationFailure("opportunityId", "relationship");
  }
}

function quickRecordOwnerScope(requestIdentity, alias = "") {
  if (
    !requestIdentity
    || requestIdentity.kind === "anonymous"
    || typeof requestIdentity.account !== "string"
    || !requestIdentity.account.trim()
  ) {
    return { clause: "", params: {} };
  }
  const prefix = alias ? `${alias}.` : "";
  return {
    clause: ` AND ${prefix}owner = $owner`,
    params: { $owner: requestIdentity.account },
  };
}

function patchValue(body, field, currentValue) {
  return Object.hasOwn(body, field) ? body[field] : currentValue;
}

function patchJsonValue(body, field, currentValue) {
  return Object.hasOwn(body, field) ? json(body[field]) : json(currentValue);
}

function normalizeTags(tags) {
  return Array.from(new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag ?? "").trim()).filter(Boolean)));
}

function createKnowledgeItem(db, body, owner) {
  const id = randomUUID();
  run(
    db,
    `INSERT INTO knowledge_items (
      id, title, category, tags, summary, content, source, owner
    ) VALUES (
      $id, $title, $category, $tags, $summary, $content, $source, $owner
    )`,
    {
      $id: id,
      $title: body.title,
      $category: body.category ?? null,
      $tags: json(normalizeTags(body.tags)),
      $summary: body.summary ?? null,
      $content: body.content ?? null,
      $source: body.source ?? null,
      $owner: owner,
    },
  );
  return knowledgeFromRow(get(db, "SELECT * FROM knowledge_items WHERE id = $id", { $id: id }));
}

function updateKnowledgeItem(db, id, body, expectedVersion, owner = null) {
  const current = knowledgeFromRow(get(
    db,
    `SELECT * FROM knowledge_items WHERE id = $id AND deleted_at IS NULL${ownerClause(owner)}`,
    ownerParams(owner, { $id: id }),
  ));
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

function updateActionItem(db, id, body, expectedVersion, owner = null) {
  const current = actionFromRow(get(
    db,
    `SELECT * FROM action_items WHERE id = $id AND deleted_at IS NULL${ownerClause(owner)}`,
    ownerParams(owner, { $id: id }),
  ));
  if (!current) return null;
  const nextStatus = patchValue(body, "status", current.status);
  if (!actionStatuses.has(nextStatus)) {
    return { error: "invalid_status" };
  }
  const nextRemindAt = patchValue(body, "remindAt", current.remindAt);
  // 提醒重新武装语义（对齐 actionItemStore.defer）：remindAt 发生变更（含置
  // null）即清 reminded_at，让提醒调度器按新时间重新扫描；未携带或原值不变则
  // 保留既有已提醒标记，避免重复投递。
  const remindChanged = Object.hasOwn(body, "remindAt") && nextRemindAt !== current.remindAt;

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
         tone = $tone,
         remind_at = $remindAt,
         reminded_at = $remindedAt`,
    params: {
      $title: patchValue(body, "title", current.title),
      $reason: patchValue(body, "reason", current.reason),
      $status: nextStatus,
      $due: patchValue(body, "due", current.due),
      $assignee: patchValue(body, "assignee", current.assignee),
      $priority: patchValue(body, "priority", current.priority),
      $tone: patchValue(body, "tone", current.tone),
      $remindAt: nextRemindAt,
      $remindedAt: remindChanged ? null : current.remindedAt,
    },
  });

  return actionFromRow(get(db, "SELECT * FROM action_items WHERE id = $id AND deleted_at IS NULL", { $id: id }));
}

// remindAt 请求值归一：空串/null 视为清除，合法时间归一为 ISO，非法即 422。
function normalizeRemindAtField(body) {
  if (!Object.hasOwn(body, "remindAt")) return;
  if (body.remindAt === null || !String(body.remindAt).trim()) {
    body.remindAt = null;
    return;
  }
  const parsed = new Date(body.remindAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { remindAt: "dateTime" });
  }
  body.remindAt = parsed.toISOString();
}

function updateWeeklyReport(db, id, body, expectedVersion, owner = null) {
  const current = weeklyReportFromRow(get(
    db,
    `SELECT * FROM weekly_reports WHERE id = $id AND deleted_at IS NULL${ownerClause(owner)}`,
    ownerParams(owner, { $id: id }),
  ));
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

function updateRiskItem(db, id, body, expectedVersion, owner = null) {
  const current = riskFromRow(get(
    db,
    `SELECT * FROM risk_items WHERE id = $id AND deleted_at IS NULL${ownerClause(owner)}`,
    ownerParams(owner, { $id: id }),
  ));
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

function searchKnowledgeItems(db, { query = "", tags = [], limit = 8, owner = null } = {}) {
  const rows = all(
    db,
    `SELECT * FROM knowledge_items WHERE deleted_at IS NULL${ownerClause(owner)} ORDER BY updated_at DESC`,
    ownerParams(owner),
  ).map(knowledgeFromRow);
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

function searchKnowledgeForAnalysis(db, rawText, limit = 4, owner = null) {
  const text = String(rawText ?? "").toLowerCase();
  if (!text.trim()) return [];
  const rows = all(
    db,
    `SELECT * FROM knowledge_items WHERE deleted_at IS NULL${ownerClause(owner)} ORDER BY updated_at DESC`,
    ownerParams(owner),
  ).map(knowledgeFromRow);
  const maxItems = Math.max(1, Math.min(Number(limit) || 4, 8));
  return rows
    .map((item) => {
      const exactNeedles = new Set();
      const partialNeedles = new Set();
      for (const term of splitSearchTerms(item.title, item.category, ...(item.tags ?? []))) {
        exactNeedles.add(term);
        if (term.length > 4 && /[\u4e00-\u9fff]/.test(term)) {
          for (let index = 0; index + 4 <= term.length; index += 2) {
            partialNeedles.add(term.slice(index, index + 4));
          }
        }
      }
      let score = 0;
      for (const needle of exactNeedles) {
        if (text.includes(needle)) score += 3;
      }
      for (const needle of partialNeedles) {
        if (!exactNeedles.has(needle) && text.includes(needle)) score += 1;
      }
      return { item, score };
    })
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, "zh-Hans-CN"))
    .slice(0, maxItems)
    .map((entry) => entry.item);
}

function normalizeKnowledgeIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(value.map((id) => String(id ?? "").trim()).filter(Boolean)));
}

function getKnowledgeItemsByIds(db, ids, owner = null) {
  if (!ids.length) return [];
  const rows = all(
    db,
    `SELECT * FROM knowledge_items WHERE deleted_at IS NULL${ownerClause(owner)}`,
    ownerParams(owner),
  ).map(knowledgeFromRow);
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
    // v0.9.1 终态：展示列用 users.display_name；无行（匿名/机器 owner）保持原值。
    $assignee: getUser(db, quickRecord.owner)?.displayName ?? quickRecord.owner ?? null,
    $priority: priority,
    $sourceRecordId: quickRecord.id,
    $tone: priority === "高" ? "red" : "blue",
    // Deep write-back inherits the record owner so assistant-visible scoping
    // covers these rows without changing their display assignee (v0.7.5).
    $owner: quickRecord.owner ?? null,
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
          owner = COALESCE(owner, $owner),
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
        $owner: params.$owner,
        ...(reactivating ? { $due: params.$due, $assignee: params.$assignee } : {}),
      },
    });
  } else {
    run(
      db,
      `INSERT INTO action_items (
       id, customer_id, opportunity_id, title, customer, reason, due,
       assignee, priority, status, source_record_id, tone, owner
     ) VALUES (
       $id, $customerId, $opportunityId, $title, $customer, $reason, $due,
       $assignee, $priority, 'pending', $sourceRecordId, $tone, $owner
     )`,
      { ...params, $id: randomUUID() },
    );
  }

  return actionFromRow(get(db, "SELECT * FROM action_items WHERE source_record_id = $sourceRecordId AND deleted_at IS NULL", {
    $sourceRecordId: quickRecord.id,
  }));
}

function getDraftActions(db, { customerId, opportunityId, owner = null }) {
  return all(
    db,
    `SELECT * FROM action_items
     WHERE deleted_at IS NULL
       AND (customer_id = $customerId OR opportunity_id = $opportunityId)${ownerClause(owner)}
     ORDER BY
       CASE priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
       updated_at DESC`,
    ownerParams(owner, {
      $customerId: customerId,
      $opportunityId: opportunityId,
    }),
  ).map(actionFromRow);
}

function hasUsefulCompetitors(opportunity) {
  return (opportunity.competitors ?? []).some((item) => {
    const text = String(item ?? "").trim();
    return text && !/暂未明确|无|待确认/.test(text);
  });
}

function buildOpportunityRiskDrafts({ customer, opportunity, sourceType, sourceId, owner }) {
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
    owner,
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
           tone = $tone,
           owner = COALESCE($owner, owner)
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
        $owner: draft.owner ?? null,
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
       status, evidence, action, source_type, source_id, tone, owner
     ) VALUES (
       $id, $customerId, $opportunityId, $title, $target, $score, $severity,
       $status, $evidence, $action, $sourceType, $sourceId, $tone,
       COALESCE($owner, '${LEGACY_OWNER}')
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
      $owner: draft.owner ?? null,
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
    // 深写回链与 action 同款：风险继承快速记录的 owner（v0.9.2）。
    owner: quickRecord.owner ?? null,
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

  // v0.9.1 双轨：users 表优先；该账号查无行时回退 env 凭据比对（异常信号，
  // 计划 v0.9.3 评估移除）。三条失败路径都恰好执行一次 scrypt，保持恒时。
  const user = getUser(db, account);
  let fallback = false;
  let credentialsValid = false;
  if (user) {
    const passwordMatches = await verifyPassword(body?.password, user.passwordHash);
    credentialsValid = passwordMatches && user.status === "active";
  } else {
    credentialsValid = await configuredCredentialsMatch(config, body);
    fallback = credentialsValid;
  }
  if (!credentialsValid) {
    for (const limiterKey of limiterKeys) recordLoginFailure(db, limiterKey, now);
    return null;
  }

  for (const limiterKey of limiterKeys) clearLoginFailures(db, limiterKey);
  const sessionAccount = user?.account ?? config.authAccount;
  if (user) recordLastLogin(db, user.account, new Date(now).toISOString());
  if (fallback) {
    console.warn(
      `category=auth env fallback login account=${sessionAccount} (no users row; credentials matched the configured environment pair)`,
    );
    insertAudit(db, {
      action: "auth.login.env_fallback",
      entityType: "user",
      entityId: sessionAccount,
      actor: sessionAccount,
      before: null,
      after: null,
      metadata: { reason: "user_row_missing" },
    });
  }
  return {
    session: createSession(db, config, { account: sessionAccount, now }),
    displayName: user?.displayName ?? sessionAccount,
    role: user?.role ?? "member",
    fallback,
  };
}

async function configuredCredentialsMatch(config, body) {
  const account = typeof body?.account === "string" ? body.account.trim() : "";
  const passwordMatches = validatePasswordHashEncoding(config.authPasswordHash)
    ? await verifyPassword(body?.password, config.authPasswordHash)
    : constantTimeEqual(body?.password, config.authPassword);
  return account === config.authAccount && passwordMatches;
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
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
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

function userRepositoryFailure(error) {
  if (error instanceof UserNotFoundError) {
    throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
  }
  if (error instanceof UserVersionConflictError) {
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

function buildSalesDecisionContext(db, body, owner = null) {
  let customer = null;
  let opportunity = null;
  let quickRecord = null;

  if (body.customerId) {
    customer = customerFromRow(get(
      db,
      `SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause(owner)}`,
      ownerParams(owner, { $id: body.customerId }),
    ));
    if (!customer) notFound();
  }

  if (body.opportunityId) {
    opportunity = opportunityFromRow(activeOpportunityEntityRow(db, body.opportunityId, owner ?? undefined));
    if (!opportunity) notFound();
    if (customer && opportunity.customerId !== customer.id) {
      validationFailure("opportunityId", "relationship");
    }
    if (!customer) {
      customer = customerFromRow(get(
        db,
        `SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause(owner)}`,
        ownerParams(owner, { $id: opportunity.customerId }),
      ));
    }
  }

  if (body.quickRecordId) {
    quickRecord = quickRecordFromRow(get(
      db,
      `SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL${ownerClause(owner)}`,
      ownerParams(owner, { $id: body.quickRecordId }),
    ));
    if (!quickRecord) notFound();
    if (customer && quickRecord.customerId && quickRecord.customerId !== customer.id) {
      validationFailure("quickRecordId", "relationship");
    }
    if (opportunity && quickRecord.opportunityId && quickRecord.opportunityId !== opportunity.id) {
      validationFailure("quickRecordId", "relationship");
    }
    if (!customer && quickRecord.customerId) {
      customer = customerFromRow(get(
        db,
        `SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause(owner)}`,
        ownerParams(owner, { $id: quickRecord.customerId }),
      ));
    }
    if (!opportunity && quickRecord.opportunityId) {
      opportunity = opportunityFromRow(activeOpportunityEntityRow(db, quickRecord.opportunityId, owner ?? undefined));
    }
  }

  const rawContent = String(body.rawContent ?? quickRecord?.rawContent ?? "").trim();
  if (!customer && !opportunity && !quickRecord && !rawContent) {
    validationFailure("body", "source");
  }

  const customerId = customer?.id ?? quickRecord?.customerId ?? opportunity?.customerId ?? null;
  const opportunityId = opportunity?.id ?? quickRecord?.opportunityId ?? null;
  const actions = customerId || opportunityId
    ? getDraftActions(db, { customerId, opportunityId, owner })
    : [];
  const risks = customerId || opportunityId
    ? all(
      db,
      `SELECT * FROM risk_items
       WHERE deleted_at IS NULL
         AND (customer_id = $customerId OR opportunity_id = $opportunityId)${ownerClause(owner)}
       ORDER BY updated_at DESC
       LIMIT 20`,
      ownerParams(owner, { $customerId: customerId, $opportunityId: opportunityId }),
    ).map(riskFromRow)
    : [];
  const knowledge = searchKnowledgeForAnalysis(
    db,
    [customer?.name, opportunity?.name, rawContent].filter(Boolean).join(" "),
    6,
    owner,
  );

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
  const quickRecordConfirmationRepositories = createQuickRecordConfirmationRepositories(db);
  const quickRecordConfirmationService = createQuickRecordConfirmationService({
    ...quickRecordConfirmationRepositories,
    runInTransaction: (work) => withImmediateTransaction(db, work),
    resolveAuthenticatedActor: ({ owner, actor }) => {
      if (
        !actor
        || typeof actor !== "object"
        || !["user", "anonymous"].includes(actor.kind)
        || actor.account !== owner
      ) return null;
      return { id: actor.account, owner, authenticated: true };
    },
    ...(options.quickRecordConfirmationIdFactory
      ? { idFactory: options.quickRecordConfirmationIdFactory }
      : {}),
    clock: options.quickRecordConfirmationClock ?? (() => new Date()),
  });
  // 三重种子保障之二：迁移 0030 env 种子缺席（如 env-less 彩排）时，每次启动
  // 兜底补种首个 admin。只插不改，绝不覆盖已有行。
  ensureBootstrapAdmin(db, config);
  // v0.9.3：绑定表即 sender 白名单。0032 env 种子缺席时启动兜底补种（只插不改，
  // 停用行绝不复活）；零绑定不 fail 启动——微信面自动静默，Web 面不受影响。
  const weixinBindingsRepository = createWeixinBindingsRepository(db, {
    clock: options.weixinBindingsClock ?? (() => new Date()),
  });
  ensureBootstrapBinding(db, config);
  if (!weixinBindingsRepository.hasActive()) {
    console.warn("category=weixin bindings_empty (no active weixin binding; proactive WeChat delivery is dormant)");
  }
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
      ? secureSettingsRepository.resolveSecret(DEEPSEEK_SETTING_KEY, config.modelApiKey)
      : config.modelApiKey,
  };
  // A server owns exactly one ASR runtime.  Its independent key provider reads
  // secure_settings on every provider request, so save/rotate/clear takes
  // effect without restart and a missing or cleared row never falls back to
  // the DeepSeek credential.
  const resolveAsrApiKey = () => secureSettingsRepository
    ? secureSettingsRepository.resolveSecret(ASR_SETTING_KEY, "")
    : "";
  const asrService = options.asrService ?? (config.authSessionSecret
    ? createAsrService(config, {
        ...(options.asrServiceDependencies ?? {}),
        asrApiKeyProvider: resolveAsrApiKey,
        providerDependencies: {
          fetchImpl: options.asrFetchImpl ?? options.fetchImpl ?? fetch,
          ...(options.asrServiceDependencies?.providerDependencies ?? {}),
          ...(options.asrProviderDependencies ?? {}),
        },
      })
    : null);
  const asrCredentialMetadata = options.asrCredentialMetadataProvider ?? (() => secureSettingsRepository
    ? secureSettingsRepository.metadata(ASR_SETTING_KEY)
    : { configured: false, status: "not_configured" });
  const asrHttp = asrService && config.authSessionSecret
    ? createAsrHttpHandlers({
        db,
        config,
        service: asrService,
        credentialMetadataProvider: asrCredentialMetadata,
        now: options.asrHttpClock ?? Date.now,
        ...(options.asrHttpOptions ?? {}),
      })
    : null;
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
  const hospitalTenderSchedulerRepository = createHospitalTenderSchedulerRepository(db, {
    clock: options.hospitalTenderSchedulerClock ?? (() => new Date()),
    ...(options.hospitalTenderSchedulerIdFactory
      ? { idFactory: options.hospitalTenderSchedulerIdFactory }
      : {}),
  });
  const resolvePushplusToken = () => secureSettingsRepository
    ? secureSettingsRepository.resolveSecret(PUSHPLUS_SETTING_KEY, config.hospitalTenderPushplusToken)
    : config.hospitalTenderPushplusToken;
  const secureSettingMetadata = (key, fallback = "") => {
    const stored = secureSettingsRepository?.has(key) ?? false;
    if (stored) {
      const item = secureSettingsRepository.metadata(key);
      return {
        ...item,
        // A cleared row is an explicit suppression of the legacy environment
        // fallback, so it must not be presented as an active settings value.
        source: item.status === "active" ? "settings" : "none",
        fallbackSuppressed: item.status === "cleared",
      };
    }
    const environmentSecret = String(fallback ?? "").trim();
    const item = secureSettingsRepository?.metadata(key) ?? {
      configured: false,
      masked: null,
      createdAt: null,
      rotatedAt: null,
      updatedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      lastDeliveryCount: null,
      lastChunkCount: null,
      status: "not_configured",
    };
    return {
      ...item,
      configured: Boolean(environmentSecret),
      masked: environmentSecret ? maskSecret(environmentSecret) : null,
      status: environmentSecret ? "active" : "not_configured",
      source: environmentSecret ? "environment" : "none",
      fallbackSuppressed: false,
    };
  };
  const hospitalTenderPushplusNotifier = createHospitalTenderNotifier({
        ...(secureSettingsRepository
          ? { tokenProvider: resolvePushplusToken }
          : { token: config.hospitalTenderPushplusToken }),
        fetchImpl: options.fetchImpl ?? fetch,
        onSuccess: ({ count, chunkCount }) => {
          if (!secureSettingsRepository || !secureSettingsRepository.has(PUSHPLUS_SETTING_KEY)) return;
          try {
            secureSettingsRepository.recordDeliverySuccess(PUSHPLUS_SETTING_KEY, {
              count,
              chunkCount,
            });
          } catch {}
        },
        onFailure: ({ errorCode }) => {
          if (!secureSettingsRepository || !secureSettingsRepository.has(PUSHPLUS_SETTING_KEY)) return;
          try {
            secureSettingsRepository.recordDeliveryFailure(PUSHPLUS_SETTING_KEY, { errorCode });
          } catch {}
        },
      });
  // WeChat "小小" push is the primary tender-notification channel. The
  // shortcut-bookkeeping runtime and outbox repository are declared later in
  // this scope, so readiness and the notifier itself resolve lazily at call
  // time; PushPlus remains only as a fallback while no WeChat binding is
  // active.
  const weixinDeliveryEnabled = () => {
    try {
      return Boolean(shortcutBookkeepingAssistantRuntime?.ready);
    } catch {
      return false;
    }
  };
  // 招标推送按客户 owner 分组投递（v0.9.3）：matchedCustomerIds → owner 映射。
  const resolveCustomerOwnersByIds = (customerIds) => {
    const map = new Map();
    const ids = [...new Set((customerIds ?? []).filter((id) => typeof id === "string" && id))];
    for (let index = 0; index < ids.length; index += 100) {
      const chunk = ids.slice(index, index + 100);
      const placeholders = chunk.map((_, position) => `$id${position}`).join(", ");
      const params = Object.fromEntries(chunk.map((id, position) => [`$id${position}`, id]));
      for (const row of db.prepare(
        `SELECT id, owner FROM customers WHERE deleted_at IS NULL AND id IN (${placeholders})`,
      ).all(params)) {
        map.set(row.id, row.owner);
      }
    }
    return map;
  };
  let hospitalTenderWeixinNotifierInstance = null;
  const hospitalTenderWeixinNotify = async (batch) => {
    if (!hospitalTenderWeixinNotifierInstance) {
      hospitalTenderWeixinNotifierInstance = createHospitalTenderWeixinNotifier({
        outboxRepository: weixinConfirmationOutboxRepository,
        resolveDigestDeliveries: () => weixinBindingsRepository.listDigestTargets(),
        // 无路由公告兜底目标：active ∧ digest_enabled 的 admin 绑定。
        resolveAdminDeliveries: () => weixinBindingsRepository.listAdminTargets().filter(
          (target) => weixinBindingsRepository.activeByAccount(target.account)?.digestEnabled === true,
        ),
        resolveCustomerOwners: resolveCustomerOwnersByIds,
        pushplusNotify: async (batch) => {
          if (!hospitalTenderPushplusNotifier || !resolvePushplusToken()) {
            throw new Error("notification unavailable");
          }
          return hospitalTenderPushplusNotifier(batch);
        },
        recordUnrouted: ({ count, cycleNumber }) => insertAudit(db, {
          action: "hospital_tender.push.unrouted",
          entityType: "hospital_tender_notice",
          entityId: `cycle:${cycleNumber}`,
          actor: "system:hospital-tender",
          before: null,
          after: null,
          metadata: { count, cycleNumber },
        }),
      });
    }
    return hospitalTenderWeixinNotifierInstance(batch);
  };
  const hospitalTenderNotifier = options.hospitalTenderNotifier !== undefined
    ? options.hospitalTenderNotifier
    : async (batch) => {
      if (weixinDeliveryEnabled()) return hospitalTenderWeixinNotify(batch);
      if (hospitalTenderPushplusNotifier && resolvePushplusToken()) return hospitalTenderPushplusNotifier(batch);
      throw new Error("notification unavailable");
    };
  const hospitalTenderNotificationState = () => ({
    status: weixinDeliveryEnabled() || (hospitalTenderPushplusNotifier && resolvePushplusToken())
      ? "enabled"
      : "disabled",
    provider: weixinDeliveryEnabled() ? "weixin" : "pushplus",
  });
  const hospitalTenderScheduler = createHospitalTenderScheduler({
    db,
    repository: hospitalTenderSchedulerRepository,
    tenderRepository: hospitalTenderRepository,
    runner: hospitalTenderInternalRunner,
    customersProvider: () => all(
      db,
      "SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY id ASC",
    ).map(customerFromRow),
    notifier: hospitalTenderNotifier,
    // The notifier is intentionally constructed once so a newly saved or
    // cleared encrypted setting takes effect without restarting the scheduler.
    // A missing/cleared token disables delivery while allowing collection and
    // durable matching to continue normally.
    notificationEnabled: () => weixinDeliveryEnabled() || Boolean(resolvePushplusToken()),
    clock: options.hospitalTenderSchedulerClock ?? (() => new Date()),
    ...(options.hospitalTenderSchedulerIdFactory
      ? { idFactory: options.hospitalTenderSchedulerIdFactory }
      : {}),
    intervalMinutes: config.hospitalTenderIntervalMinutes,
    batchSize: config.hospitalTenderBatchSize,
  });
  const hospitalTenderAutoRun = options.hospitalTenderAutoRun ?? config.hospitalTenderAutoRun;
  if (hospitalTenderAutoRun && options.hospitalTenderSchedulerEnabled !== false) hospitalTenderScheduler.start();
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
  const travelExpenseRegionRepository = createTravelExpenseRegionRepository(db, {
    clock: options.travelExpenseRegionClock ?? options.travelExpenseClock ?? (() => new Date()),
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
  const expenseModelClient = createExpenseModelClient(runtimeConfig, options.fetchImpl ?? fetch);
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
  const invoicePdfImageRenderer = options.invoicePdfImageRenderer ?? createLocalPdfImageRenderer({
    command: config.invoicePdfImageCommand,
    timeoutMs: config.invoiceTextExtractionTimeoutMs,
  });
  const documentVisionAnalyzer = options.documentVisionAnalyzer ?? (expenseModelClient
    ? createDocumentVisionAnalyzer({
        modelClient: expenseModelClient,
        modelName: config.modelVisionName,
        modelTimeoutMs: config.modelTimeoutMs,
        pdfRenderer: invoicePdfImageRenderer,
      })
    : null);
  const invoiceRecognizer = options.invoiceRecognizer ?? ((file) => recognizeInvoiceDocument(file, {
    textExtractor: invoiceTextExtractor,
    analyzeText: options.invoiceTextAnalyzer ?? ((text) => analyzeInvoiceText(text, {
      modelClient: expenseModelClient,
      modelName: config.modelName,
      modelTimeoutMs: config.modelTimeoutMs,
    })),
    ...(documentVisionAnalyzer
      ? { analyzeDocument: options.invoiceDocumentVisionAnalyzer ?? documentVisionAnalyzer.analyzeInvoice }
      : {}),
  }));
  const shortcutBookkeepingRepository = createShortcutBookkeepingRepository(db, {
    ...(options.shortcutBookkeepingIdFactory ? { idFactory: options.shortcutBookkeepingIdFactory } : {}),
    ...(options.shortcutBookkeepingClock ? { clock: options.shortcutBookkeepingClock } : {}),
  });
  const shortcutAdvanceAllocationRepository = options.shortcutAdvanceAllocationRepository
    ?? createShortcutAdvanceAllocationRepository(db, {
      ...(options.shortcutAdvanceAllocationIdFactory ? { idFactory: options.shortcutAdvanceAllocationIdFactory } : {}),
      ...(options.shortcutAdvanceAllocationClock ? { clock: options.shortcutAdvanceAllocationClock } : {}),
    });
  const weixinConfirmationOutboxRepository = options.weixinConfirmationOutboxRepository
    ?? createWeixinConfirmationOutboxRepository(db, {
      ...(options.weixinConfirmationOutboxIdFactory ? { idFactory: options.weixinConfirmationOutboxIdFactory } : {}),
      ...(options.weixinConfirmationOutboxClock ? { clock: options.weixinConfirmationOutboxClock } : {}),
    });
  const weixinDeliveryReadiness = options.weixinDeliveryReadiness
    ?? createWeixinDeliveryReadiness({
      clock: options.weixinDeliveryReadinessClock ?? Date.now,
      staleMs: Math.max(15_000, Math.min(10 * 60_000, config.weixinOutboxPollMs * 4)),
    });
  const paymentProofRecognizer = options.paymentProofRecognizer ?? ((file, recognitionOptions = {}) => (
    recognizePaymentProofDocument(file, {
      typedEvidence: recognitionOptions.typedEvidence,
      referenceDate: recognitionOptions.referenceDate,
      textExtractor: invoiceTextExtractor,
      analyzeText: options.paymentProofTextAnalyzer ?? ((text) => analyzePaymentProofText(text, {
        modelClient: expenseModelClient,
        modelName: config.modelName,
        modelTimeoutMs: config.modelTimeoutMs,
      })),
      ...(documentVisionAnalyzer
        ? {
            analyzeDocument: options.paymentProofDocumentVisionAnalyzer
              ?? documentVisionAnalyzer.analyzePaymentProof,
          }
        : {}),
      modelProvider: config.modelProvider,
      modelName: documentVisionAnalyzer ? config.modelVisionName : config.modelName,
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
    : config.amapMode === "mock"
      ? createMockAmapClient()
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
  const shortcutBookkeepingAssistantRuntime = options.shortcutBookkeepingAssistantRuntime
    ?? createShortcutBookkeepingAssistantRuntime({
      db,
      config,
      shortcutBookkeepingRepository,
      travelExpenseRepository,
      travelExpenseRegionRepository,
      travelExpenseDocumentInboxRepository,
      advanceAllocationRepository: shortcutAdvanceAllocationRepository,
      pendingActionRepository: assistantPendingActionRepository,
      sessionRepository: assistantSessionRepository,
      outboxRepository: weixinConfirmationOutboxRepository,
      bindingsRepository: weixinBindingsRepository,
      confirmationSecret: assistantConfirmationSecret,
      ...(options.shortcutBookkeepingAssistantIdFactory ? { idFactory: options.shortcutBookkeepingAssistantIdFactory } : {}),
      clock: options.shortcutBookkeepingAssistantClock ?? assistantClock,
    });
  // v0.9.3：resolver 改查绑定表，闭合语义不变——无 active 绑定 → null 拒答，绝不回退全量。
  const assistantBusinessOwnerResolver = typeof options.resolveBusinessOwner === "function"
    ? options.resolveBusinessOwner
    : createBusinessOwnerResolver({
        hasActiveBinding: (account) => Boolean(weixinBindingsRepository.activeByAccount(account)),
      });
  function resolveAssistantBusinessOwner(account) {
    const bound = assistantBusinessOwnerResolver(account);
    if (bound) return bound;
    const normalized = typeof account === "string" ? account.trim() : "";
    return normalized || null;
  }
  // 入口安全闸（§2.1 序 5a/5b）。限流键密钥优先复用会话密钥（登录限流同源）；
  // 无会话密钥的测试/开发栈退化为确认密钥派生值，生产两者恒在。
  const weixinBindingGate = createWeixinBindingGate({
    db,
    bindingsRepository: weixinBindingsRepository,
    codeSecret: assistantConfirmationSecret,
    rateLimitSecret: typeof config.authSessionSecret === "string" && config.authSessionSecret.trim()
      ? config.authSessionSecret
      : createHash("sha256")
        .update(Buffer.isBuffer(assistantConfirmationSecret)
          ? assistantConfirmationSecret
          : Buffer.from(String(assistantConfirmationSecret), "utf8"))
        .digest("base64url"),
    clock: assistantClock,
  });
  const assistantBusinessSnapshotAdapter = options.assistantBusinessSnapshotAdapter
    ?? createAssistantBusinessSnapshotAdapter({
      db,
      clock: assistantClock,
      resolveBusinessOwner: resolveAssistantBusinessOwner,
    });
  const assistantSettlementSnapshotAdapter = options.assistantSettlementSnapshotAdapter
    ?? createAssistantSettlementSnapshotAdapter({
      db,
      clock: assistantClock,
      resolveBusinessOwner: resolveAssistantBusinessOwner,
    });
  const assistantBusinessContextRepository = options.assistantBusinessContextRepository
    ?? createSalesLoopContextRepository(db, {
      clock: assistantClock,
      ...(options.assistantBusinessContextIdFactory
        ? { idFactory: options.assistantBusinessContextIdFactory }
        : {}),
      resolveEntities: ({ owner, customerId, opportunityId }) => ({
        customer: customerId
          ? assistantBusinessSnapshotAdapter.customerDetail({ owner, customerId })
          : null,
        opportunity: opportunityId
          ? assistantBusinessSnapshotAdapter.opportunityDetail({ owner, opportunityId })
          : null,
      }),
    });
  const assistantAgentRunRepository = options.assistantAgentRunRepository
    ?? createAssistantAgentRunRepository(db, {
      clock: assistantClock,
      ...(options.assistantAgentRunIdFactory
        ? { idFactory: options.assistantAgentRunIdFactory }
        : {}),
    });
  const assistantSalesLoopPreviewService = options.assistantSalesLoopPreviewService
    ?? createSalesLoopPreviewService({
      db,
      businessSnapshotAdapter: assistantBusinessSnapshotAdapter,
      contextRepository: assistantBusinessContextRepository,
      runRepository: assistantAgentRunRepository,
      config: runtimeConfig,
      fetchImpl: options.fetchImpl ?? fetch,
      resolveBusinessOwner: resolveAssistantBusinessOwner,
      clock: assistantClock,
    });
  const assistantSalesReportAdapter = options.assistantSalesReportAdapter
    ?? createSalesReportAssistantAdapter({
      config: runtimeConfig,
      fetchImpl: options.fetchImpl ?? fetch,
      runRepository: assistantAgentRunRepository,
      clock: assistantClock,
      snapshotProvider: ({ owner, weekStart, periodStart, periodEnd, knowledgeQuery }) => assistantSalesLoopPreviewService.buildSalesReportSnapshot({
        owner,
        weekStart,
        periodStart,
        periodEnd,
        knowledgeQuery,
      }),
    });
  const assistantCustomerAdapter = options.assistantCustomerAdapter
    ?? createCustomerAssistantAdapter({
      snapshotAdapter: assistantBusinessSnapshotAdapter,
      runRepository: assistantAgentRunRepository,
      clock: assistantClock,
    });
  const assistantOpportunityAdapter = options.assistantOpportunityAdapter
    ?? createOpportunityAssistantAdapter({
      snapshotAdapter: assistantBusinessSnapshotAdapter,
      runRepository: assistantAgentRunRepository,
      clock: assistantClock,
    });
  const assistantVisitCaptureAdapter = options.assistantVisitCaptureAdapter
    ?? createVisitCaptureAssistantAdapter({
      config: runtimeConfig,
      fetchImpl: options.fetchImpl ?? fetch,
      runRepository: assistantAgentRunRepository,
      businessSnapshotAdapter: assistantBusinessSnapshotAdapter,
      clock: assistantClock,
    });
  const assistantQuickRecordStore = createQuickRecordStore(db, { clock: assistantClock });
  const assistantActionItemStore = createActionItemStore(db, { clock: assistantClock });
  const actionReminderScheduler = createActionReminderScheduler({
    db,
    store: assistantActionItemStore,
    outboxRepository: weixinConfirmationOutboxRepository,
    resolveDeliveries: () => weixinBindingsRepository.listDigestTargets(),
    deliveryReady: weixinDeliveryEnabled,
    clock: options.actionReminderSchedulerClock ?? (() => new Date()),
    pollMs: config.actionReminderPollMs,
  });
  const actionReminderAutoRun = options.actionReminderAutoRun ?? config.actionReminderAutoRun;
  if (actionReminderAutoRun && options.actionReminderSchedulerEnabled !== false) actionReminderScheduler.start();
  const dailyDigestClock = options.dailyDigestSchedulerClock ?? (() => new Date());
  const digestContentBuilder = createDigestContentBuilder({
    db,
    snapshotAdapter: assistantBusinessSnapshotAdapter,
    actionItemStore: assistantActionItemStore,
    tenderRepository: hospitalTenderRepository,
    resolveBusinessOwner: resolveAssistantBusinessOwner,
    clock: dailyDigestClock,
    dailyTime: config.dailyDigestTime,
  });
  const dailyDigestScheduler = createDailyDigestScheduler({
    db,
    outboxRepository: weixinConfirmationOutboxRepository,
    buildDailyDigest: digestContentBuilder.buildDailyDigest,
    buildFridayCloseout: digestContentBuilder.buildFridayCloseout,
    resolveDeliveries: () => weixinBindingsRepository.listDigestTargets(),
    deliveryReady: weixinDeliveryEnabled,
    clock: dailyDigestClock,
    pollMs: config.dailyDigestPollMs,
    dailyTime: config.dailyDigestTime,
    fridayTime: config.dailyDigestFridayTime,
  });
  const dailyDigestAutoRun = options.dailyDigestAutoRun ?? config.dailyDigestAutoRun;
  if (dailyDigestAutoRun && options.dailyDigestSchedulerEnabled !== false) dailyDigestScheduler.start();
  const opsAlertPushplusNotifier = createOpsAlertPushplusNotifier({
    tokenProvider: resolvePushplusToken,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  const opsAlertService = options.opsAlertService ?? createOpsAlertService({
    outboxRepository: weixinConfirmationOutboxRepository,
    // 告警非订阅内容：目标=active admin 绑定（无视 digest_enabled），无则 PushPlus 兜底。
    resolveDeliveries: () => weixinBindingsRepository.listAdminTargets(),
    weixinDeliveryReady: weixinDeliveryEnabled,
    pushplusNotify: opsAlertPushplusNotifier,
    recordAudit: ({ actor, requestId, entityId, metadata }) => insertAudit(db, {
      action: "ops_alert.receive",
      entityType: "ops_alert",
      entityId,
      actor,
      requestId,
      before: null,
      after: null,
      metadata,
    }),
    clock: options.opsAlertClock ?? (() => new Date()),
  });
  // One probe covers backend liveness, the three scheduler lastError states,
  // outbox backlog, and worker heartbeat for the 5-minute ops inspector.
  const opsAlertStatusSnapshot = () => {
    const tenderState = hospitalTenderScheduler.getState();
    return {
      generatedAt: new Date().toISOString(),
      outbox: weixinConfirmationOutboxRepository.statusCounts(),
      weixinDelivery: weixinDeliveryReadiness.snapshot(),
      weixinBindings: { active: weixinBindingsRepository.countActive() },
      schedulers: {
        hospitalTender: tenderState
          ? {
              enabled: Boolean(tenderState.enabled),
              lastStatus: tenderState.lastStatus ?? null,
              lastError: tenderState.lastError ?? null,
              lastFinishedAt: tenderState.lastFinishedAt ?? null,
              nextRunAt: tenderState.nextRunAt ?? null,
            }
          : null,
        actionReminders: actionReminderScheduler.status(),
        dailyDigest: dailyDigestScheduler.status(),
      },
    };
  };
  const assistantToolHandlers = options.assistantToolHandlers
    ?? createAssistantToolHandlers({
      db,
      // Assistant-triggered quick-record analysis must use the same
      // server-owned persisted model-key provider as browser API calls.
      config: runtimeConfig,
      sessionRepository: assistantSessionRepository,
      travelExpenseDocumentInboxRepository,
      bookkeepingRepository: shortcutBookkeepingRepository,
      bookkeepingRuntime: shortcutBookkeepingAssistantRuntime,
      hospitalTenderRepository,
      actionItemStore: assistantActionItemStore,
      travelExpenseRepository,
      travelExpenseRegionRepository,
      travelExpenseAnalyzer: travelExpenseAnalyzer,
      invoiceRepository,
      paymentProofRecognizer,
      invoiceRecognizer,
      businessSnapshotAdapter: assistantBusinessSnapshotAdapter,
      settlementSnapshotAdapter: assistantSettlementSnapshotAdapter,
      customerAssistantAdapter: assistantCustomerAdapter,
      opportunityAssistantAdapter: assistantOpportunityAdapter,
      visitCaptureAssistantAdapter: assistantVisitCaptureAdapter,
      quickRecordStore: assistantQuickRecordStore,
      agentRunRepository: assistantAgentRunRepository,
      salesReportAssistantAdapter: assistantSalesReportAdapter,
      salesLoopPreviewService: assistantSalesLoopPreviewService,
      resolveBusinessOwner: resolveAssistantBusinessOwner,
      clock: assistantClock,
      fetchImpl: options.fetchImpl ?? fetch,
    });
  const assistantOrchestrator = options.assistantOrchestrator
    ?? createAssistantOrchestrator({
      router: createAssistantRouter({ clock: assistantClock }),
      eventRepository: assistantEventRepository,
      sessionRepository: assistantSessionRepository,
      pendingActionRepository: assistantPendingActionRepository,
      businessContextRepository: assistantBusinessContextRepository,
      toolHandlers: assistantToolHandlers,
      confirmationSecret: assistantConfirmationSecret,
      clock: assistantClock,
      pendingActionHandler: shortcutBookkeepingAssistantRuntime.handlePending,
      pendingPreviewProviders: {
        ...createCustomerPendingPreviewProviders({
          adapter: assistantCustomerAdapter,
          db,
          resolveBusinessOwner: resolveAssistantBusinessOwner,
        }),
        ...createQuickRecordPendingPreviewProviders({
          visitCaptureAdapter: assistantVisitCaptureAdapter,
          customerAdapter: assistantCustomerAdapter,
          snapshotAdapter: assistantBusinessSnapshotAdapter,
          store: assistantQuickRecordStore,
          resolveBusinessOwner: resolveAssistantBusinessOwner,
          clock: assistantClock,
        }),
        ...createActionItemPendingPreviewProviders({
          store: assistantActionItemStore,
          customerAdapter: assistantCustomerAdapter,
          resolveBusinessOwner: resolveAssistantBusinessOwner,
          clock: assistantClock,
        }),
        ...createOpportunityPendingPreviewProviders({
          opportunityAdapter: assistantOpportunityAdapter,
          customerAdapter: assistantCustomerAdapter,
          db,
          resolveBusinessOwner: resolveAssistantBusinessOwner,
        }),
      },
    });
  const assistantAgentRegistry = options.assistantAgentRegistry ?? createAgentRegistry();
  const assistantWebHttp = options.assistantWebHttp ?? createAssistantWebHttpHandlers({
    db,
    config,
    assistantOrchestrator,
    assistantSessionRepository,
    assistantPendingActionRepository: assistantPendingActionRepository,
    assistantRegistry: assistantAgentRegistry,
    confirmationSecret: assistantConfirmationSecret,
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
    const schedulerClock = options.hospitalTenderSchedulerClock ?? (() => new Date());
    const lockStartedAt = schedulerClock();
    if (!(lockStartedAt instanceof Date) || Number.isNaN(lockStartedAt.getTime())) {
      throw new Error("hospital tender scheduler clock is invalid");
    }
    const manualLockOwner = `hospital-tender-manual-${randomUUID()}`;
    if (!hospitalTenderSchedulerRepository.tryAcquireLock(
      manualLockOwner,
      new Date(lockStartedAt.getTime() + 30 * 60_000).toISOString(),
    )) {
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
      hospitalTenderSchedulerRepository.releaseLock(manualLockOwner);
    }
  }

  const server = createHttpServer(async (request, response) => {
    const requestId = randomUUID();
    request[requestConfigSymbol] = config;
    response[responseContextSymbol] = { config, requestId };
    // Keep an ASR body unread until the fixed error JSON has been emitted even
    // when an earlier global gate (Origin/auth/CSRF/machine scope) rejects the
    // request before the ASR handler gets control.
    let asrUnreadBodyFinalizer = null;
    try {
      const origin = request.headers.origin;
      if (Array.isArray(origin)) {
        throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed");
      }
      corsHeaders(origin, config);
      response[responseContextSymbol].origin = origin;

      const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
      const parts = splitPath(url.pathname);
      if (url.pathname === ASR_ROUTE) {
        asrUnreadBodyFinalizer = createDeferredUnreadBodyFinalizer(response);
      }

      if (isRetiredBookkeepingPath(url.pathname)) {
        sendHttpError(
          response,
          new HttpError(410, "LEGACY_BOOKKEEPING_RETIRED", "iOS 快捷指令和 iCost 记账入口已停用，请直接向小小发送图片或记账文字。"),
          responseOptions(response, { "Cache-Control": "no-store" }),
        );
        return;
      }

      if (request.method === "OPTIONS") {
        // Only ASR needs the stricter fixed-header preflight contract.  Keep
        // existing non-ASR OPTIONS behavior unchanged.
        if (url.pathname === ASR_ROUTE) {
          assertCorsPreflightRequestHeaders(request.headers["access-control-request-headers"]);
        }
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
        const authenticated = await authenticateLogin(
          db,
          config,
          await readValidatedJson(request, requestSchemas.login),
          request.socket?.remoteAddress ?? "unknown",
        );
        if (!authenticated) {
          return unauthorized(response, "Account or password is incorrect", "INVALID_CREDENTIALS");
        }
        sendJson(response, 200, {
          account: authenticated.session.account,
          displayName: authenticated.displayName,
          role: authenticated.role,
          expiresAt: authenticated.session.expiresAt,
          csrfToken: authenticated.session.csrfToken,
        }, {
          "Set-Cookie": buildSessionCookie(config, authenticated.session.cookieValue),
        });
        return;
      }

      if (url.pathname === WEIXIN_OUTBOX_ROUTE) {
        const machineIdentity = authenticateMachineRequest(request.headers.authorization, config);
        if (!machineIdentity) return unauthorized(response);
        assertMachineRouteAllowed(request.method, url.pathname, machineIdentity.integration);
        if (request.method === "GET") {
          // 协议 v2：多绑定无唯一 scope，就绪回显收敛为 multi:v1 哨兵；旧 worker 报
          // 旧 scope → delivery_scope_mismatch fail-closed 不放租约（升级窗口语义）。
          const expectedDeliveryScope = shortcutBookkeepingAssistantRuntime.ready
            ? WEIXIN_MULTI_DELIVERY_SCOPE
            : null;
          const deliveryReport = weixinDeliveryReportFromHeaders(
            request.headers,
            expectedDeliveryScope,
          );
          weixinDeliveryReadiness.report(deliveryReport);
          if (deliveryReport.status !== "ready") {
            response.statusCode = 204;
            response.removeHeader("Content-Type");
            response.end();
            return;
          }
          shortcutBookkeepingAssistantRuntime.reconcileAcceptedReceipts();
          if (shortcutBookkeepingAssistantRuntime.ready) {
            for (const activeBinding of weixinBindingsRepository.listAll()) {
              if (activeBinding.status !== "active") continue;
              try {
                reconcileWeixinInvoiceAttachments({
                  db,
                  invoiceRepository,
                  travelExpenseRepository,
                  owner: activeBinding.account,
                  actor: activeBinding.account,
                  requestIdPrefix: "weixin-worker-invoice-attachment",
                });
              } catch {
                // Invoice and match rows remain the durable retry source. A
                // transient attachment failure must not block confirmation
                // message delivery; the next worker lease retries it.
              }
            }
          }
          const workerId = typeof request.headers["x-weixin-worker-id"] === "string"
            ? request.headers["x-weixin-worker-id"].trim().slice(0, 200)
            : "weixin-worker";
          const lease = weixinConfirmationOutboxRepository.leaseNext({
            workerId: workerId || "weixin-worker",
            renderMessage: shortcutBookkeepingAssistantRuntime.renderOutboxMessage,
          });
          if (!lease) {
            response.statusCode = 204;
            response.removeHeader("Content-Type");
            response.end();
            return;
          }
          // lease 侧第一道保险：owner 现有 active 绑定且行会话 ≡ hash(owner, 绑定
          // sender)，否则（解绑/换绑前旧行、幽灵 owner、伪造行）终态判废。
          const leaseBinding = weixinBindingsRepository.activeByAccount(lease.item.owner);
          if (
            !leaseBinding
            || lease.item.conversationId !== shortcutBookkeepingConversationId(lease.item.owner, leaseBinding.senderId)
          ) {
            weixinConfirmationOutboxRepository.discardLeased(lease.item.id, {
              leaseToken: lease.leaseToken,
              errorCode: "WEIXIN_DELIVERY_SCOPE_MISMATCH",
            });
            response.statusCode = 204;
            response.removeHeader("Content-Type");
            response.end();
            return;
          }
          sendJson(response, 200, {
            item: {
              id: lease.item.id,
              owner: lease.item.owner,
              conversationId: lease.item.conversationId,
              deliveryScope: lease.item.conversationId,
              // additive 字段：worker 侧以此重算哈希做第二道保险后 sendMessageTo。
              targetSenderId: leaseBinding.senderId,
              status: lease.item.status,
              message: lease.message,
            },
            leaseToken: lease.leaseToken,
          }, { "Cache-Control": "no-store" });
          return;
        }
        if (request.method === "POST") {
          const body = validateWeixinOutboxAckPayload(await readJson(request));
          if (body.check) {
            sendJson(response, 200, {
              current: weixinConfirmationOutboxRepository.isLeaseCurrent(body.id, body.leaseToken),
            }, { "Cache-Control": "no-store" });
            return;
          }
          const item = body.ok
            ? weixinConfirmationOutboxRepository.ackSuccess(body.id, {
                leaseToken: body.leaseToken,
                providerMessageId: body.providerMessageId,
              })
            : body.terminal
              ? weixinConfirmationOutboxRepository.discardLeased(body.id, {
                  leaseToken: body.leaseToken,
                  errorCode: body.errorCode ?? "WEIXIN_SEND_FAILED",
                })
              : weixinConfirmationOutboxRepository.ackFailure(body.id, {
                  leaseToken: body.leaseToken,
                  errorCode: body.errorCode ?? "WEIXIN_SEND_FAILED",
                });
          sendJson(response, 200, {
            item: {
              id: item.id,
              status: item.status,
              attemptCount: item.attemptCount,
              lastErrorCode: item.lastErrorCode,
              providerMessageId: item.providerMessageId,
            },
          }, { "Cache-Control": "no-store" });
          return;
        }
        sendHttpError(response, new HttpError(405, "METHOD_NOT_ALLOWED", "Only GET and POST are allowed for the WeChat outbox"), responseOptions(response, { Allow: "GET, POST" }));
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
        // v0.9.3 入口安全顺序（§2.1）：①机器令牌+路由白名单（上）→ ②幂等键+payload
        // 校验（上）→ ③群闸 → ④绑定解析 → ⑤a 未绑定能力面={绑定意图} / ⑤b 绑定控制词
        // → ⑥正常编排（owner := binding.account，机器令牌仅通道鉴权）。
        assertWeixinGroupAllowed(config, body);
        const binding = weixinBindingsRepository.activeBySender(body.senderId);
        if (!binding) {
          // 固定拒答：不入编排、不落 assistant_inbound_events、不写 blob。回 200
          // 保证 worker 把引导文案带回用户（403 会被 worker 当错误吞掉）。
          const denial = weixinBindingGate.handleUnbound({
            senderId: body.senderId,
            chatType: body.chatType,
            text: body.text ?? "",
          });
          sendJson(response, denial.status, denial.body);
          return;
        }
        const bindingControl = weixinBindingGate.handleBoundControl({
          binding,
          chatType: body.chatType,
          text: body.text ?? "",
        });
        if (bindingControl) {
          sendJson(response, bindingControl.status, bindingControl.body);
          return;
        }
        const eventOwner = binding.account;
        const senderHash = createHash("sha256").update(body.senderId, "utf8").digest("hex");
        // 种子绑定 account == machineIdentity.account == 'jiangjz'：升级前后
        // conversation/event 哈希不变，幂等与会话零漂移。
        const conversationTuple = JSON.stringify([
          eventOwner,
          "weixin",
          body.senderId,
          body.chatType,
          body.groupId ?? null,
          body.conversationId,
        ]);
        const shortcutConversation = shortcutBookkeepingAssistantRuntime.enabled
          && body.chatType === "direct";
        const conversationScope = shortcutConversation
          ? shortcutBookkeepingAssistantRuntime.conversationFor(eventOwner, body.senderId)
          : `weixin:conversation:v1:${createHash("sha256")
            .update(conversationTuple, "utf8")
            .digest("hex")}`;
        const eventTuple = JSON.stringify([
          eventOwner,
          "weixin",
          body.senderId,
          body.sourceMessageId,
        ]);
        const eventId = `weixin:event:v1:${createHash("sha256")
          .update(eventTuple, "utf8")
          .digest("hex")}`;
        // financialScope := 私聊 ∧ binding.financial_enabled ∧ runtime.enabled。
        const financialScope = body.chatType === "direct"
          && binding.financialEnabled === true
          && shortcutBookkeepingAssistantRuntime.enabled === true;
        const auditMetadata = {
          senderHash,
          chatType: body.chatType,
          financialScope,
          ...(body.groupId
            ? { groupHash: createHash("sha256").update(body.groupId, "utf8").digest("hex") }
            : {}),
        };
        const result = await assistantOrchestrator.handle({
          context: {
            owner: eventOwner,
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
            ...((body.quotedMessageId || body.quotedText)
              ? {
                  quote: {
                    ...(body.quotedMessageId ? { providerMessageId: body.quotedMessageId } : {}),
                    ...(body.quotedText ? { text: body.quotedText } : {}),
                  },
                }
              : {}),
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

      if (
        url.pathname === "/api/integrations/ops-alerts"
        || url.pathname === "/api/integrations/ops-alerts/status"
      ) {
        const machineIdentity = authenticateMachineRequest(request.headers.authorization, config);
        if (!machineIdentity) return unauthorized(response);
        assertMachineRouteAllowed(request.method, url.pathname, machineIdentity.integration);
        if (url.pathname.endsWith("/status")) {
          if (request.method !== "GET") {
            sendHttpError(
              response,
              new HttpError(405, "METHOD_NOT_ALLOWED", "Only GET is allowed for the ops alert status endpoint"),
              responseOptions(response, { Allow: "GET" }),
            );
            return;
          }
          sendJson(response, 200, { item: opsAlertStatusSnapshot() }, { "Cache-Control": "no-store" });
          return;
        }
        if (request.method !== "POST") {
          sendHttpError(
            response,
            new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed for the ops alert endpoint"),
            responseOptions(response, { Allow: "POST" }),
          );
          return;
        }
        const body = await readJson(request, { maxBytes: Math.min(config.jsonBodyLimitBytes, 64 * 1024) });
        const result = await opsAlertService.receive(body, {
          actor: machineIdentity.account,
          requestId,
        });
        sendJson(response, 200, result, { "Cache-Control": "no-store" });
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
        if (!requestIdentity) {
          asrUnreadBodyFinalizer?.defer(() => {
            if (request.destroyed === true) return true;
            request.destroy();
            return true;
          });
          return unauthorized(response);
        }
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

      if (url.pathname === ASR_ROUTE) {
        // Authentication and the global cookie-CSRF/machine-scope gates above
        // always run before the ASR handler.  Owner is server-derived only.
        if (requestIdentity.kind !== "user") {
          asrUnreadBodyFinalizer?.defer(() => {
            if (request.destroyed === true) return true;
            request.destroy();
            return true;
          });
          return unauthorized(response);
        }
        if (!asrHttp) {
          throw new HttpError(503, "ASR_NOT_CONFIGURED", "ASR is not configured");
        }
        let result;
        try {
          result = await asrHttp.handleTranscription({
            request,
            response,
            url,
            owner: request.authContext.account,
            requestId,
            remoteAddress: request.socket?.remoteAddress ?? "unknown",
            unreadBodyFinalizer: asrUnreadBodyFinalizer,
          });
        } catch (error) {
          // ASR attaches Retry-After/no-store headers to mapped failures.  The
          // shared outer catch intentionally knows nothing about ASR-specific
          // headers, so consume this branch here and preserve the contract.
          if (!response.headersSent && !response.destroyed) {
            sendHttpError(response, error, responseOptions(response, error?.headers));
          }
          return;
        }
        if (result !== null && response.destroyed !== true && response.writableEnded !== true) {
          sendJson(response, result.status, result.body, result.headers);
        }
        return;
      }

      if (url.pathname === ASR_STATUS_ROUTE) {
        if (request.method !== "GET") {
          sendHttpError(
            response,
            new HttpError(405, "METHOD_NOT_ALLOWED", "Only GET is allowed for ASR status"),
            responseOptions(response, { Allow: "GET", "Cache-Control": "no-store" }),
          );
          return;
        }
        requireAdminRole(db, request);
        if (!asrHttp) {
          throw new HttpError(503, "ASR_NOT_CONFIGURED", "ASR is not configured");
        }
        let statusSnapshot;
        try {
          statusSnapshot = await asrHttp.statusSnapshot({ request, response });
        } catch (error) {
          if (!response.headersSent && !response.destroyed) {
            sendHttpError(response, error, responseOptions(response, error?.headers));
          }
          return;
        }
        if (statusSnapshot === null || response.destroyed === true || response.writableEnded === true) {
          return;
        }
        sendJson(response, 200, { item: statusSnapshot }, {
          "Cache-Control": "no-store, max-age=0",
          Pragma: "no-cache",
        });
        return;
      }

      const weixinBookkeepingReviewRoute = "/api/integrations/weixin/bookkeeping/review";
      const weixinBookkeepingReviewParts = url.pathname.split("/");
      const isWeixinBookkeepingReviewPath = url.pathname === weixinBookkeepingReviewRoute
        || (weixinBookkeepingReviewParts[0] === ""
          && weixinBookkeepingReviewParts[1] === "api"
          && weixinBookkeepingReviewParts[2] === "integrations"
          && weixinBookkeepingReviewParts[3] === "weixin"
          && weixinBookkeepingReviewParts[4] === "bookkeeping"
          && weixinBookkeepingReviewParts[5] === "review");
      if (isWeixinBookkeepingReviewPath) {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        const owner = request.authContext.account;
        const reviewResponseItem = (item, replayed = false) => shortcutReviewResponseItem(
          item,
          replayed,
          item?.status === "accepted"
            ? shortcutBookkeepingRepository.getLedgerReceipt(item.id, { owner })
            : null,
        );
        if (request.method === "GET" && url.pathname === weixinBookkeepingReviewRoute) {
          const status = url.searchParams.get("status") || "review_required";
          const limitText = url.searchParams.get("limit");
          const limit = limitText ? Number(limitText) : 100;
          const items = shortcutBookkeepingRepository.listReview({ owner, status, limit });
          sendJson(response, 200, {
            items: items.map((item) => reviewResponseItem(item)),
          }, { "Cache-Control": "no-store" });
          return;
        }
        const reviewId = weixinBookkeepingReviewParts[6];
        if (!reviewId || weixinBookkeepingReviewParts.length > 8) return notFound();
        if (request.method === "GET" && weixinBookkeepingReviewParts.length === 7) {
          const item = shortcutBookkeepingRepository.getReview(reviewId, { owner });
          if (!item) return notFound();
          sendJson(response, 200, { item: reviewResponseItem(item) }, { "Cache-Control": "no-store" });
          return;
        }
        if (request.method !== "POST" || weixinBookkeepingReviewParts.length !== 8) {
          sendHttpError(response, new HttpError(405, "METHOD_NOT_ALLOWED", "Only GET and POST are allowed for WeChat bookkeeping review"));
          return;
        }
        const action = weixinBookkeepingReviewParts[7];
        const settleShortcutWebReview = (item) => {
          if (!["accepted", "rejected"].includes(item?.status)) return null;
          return shortcutBookkeepingAssistantRuntime.settleFromWeb({
            account: owner,
            entry: item,
            decision: item.status,
          });
        };
        if (action === "reject") {
          const { reason } = validateShortcutReviewRejectPayload(await readJson(request));
          const result = shortcutBookkeepingRepository.rejectReview(reviewId, {
            owner,
            actor: owner,
            reason,
          });
          settleShortcutWebReview(result.item);
          sendJson(response, result.replayed ? 200 : 200, {
            item: reviewResponseItem(result.item, result.replayed),
          }, { "Cache-Control": "no-store" });
          return;
        }
        if (action === "confirm") {
          const { analysis } = validateShortcutReviewConfirmPayload(await readJson(request));
          const claimed = shortcutBookkeepingRepository.claimReview(reviewId, { owner });
          if (claimed.replayed) {
            settleShortcutWebReview(claimed.item);
            shortcutBookkeepingAssistantRuntime.attachAcceptedEntryAttachments({
              account: owner,
              entry: claimed.item,
              requestId,
            });
            sendJson(response, 200, { item: reviewResponseItem(claimed.item, true) }, { "Cache-Control": "no-store" });
            return;
          }
          try {
            const completed = shortcutBookkeepingRepository.completeLocal(reviewId, {
              analysis,
              leaseToken: claimed.leaseToken,
            });
            settleShortcutWebReview(completed.item);
            shortcutBookkeepingAssistantRuntime.attachAcceptedEntryAttachments({
              account: owner,
              entry: completed.item,
              requestId,
            });
            sendJson(response, completed.replayed ? 200 : 201, {
              item: reviewResponseItem(completed.item, completed.replayed),
            }, { "Cache-Control": "no-store" });
          } catch (error) {
            shortcutBookkeepingRepository.release(reviewId, {
              leaseToken: claimed.leaseToken,
              errorCode: "MANUAL_CONFIRM_FAILED",
            });
            if (error instanceof TypeError) {
              throw new HttpError(422, "VALIDATION_ERROR", "Review confirmation is invalid", { body: error.message });
            }
            throw error;
          }
          return;
        }
        if (action === "retry") {
          const retried = shortcutBookkeepingRepository.retryReview(reviewId, { owner, actor: owner });
          if (retried.replayed) {
            sendJson(response, 200, { item: reviewResponseItem(retried.item, true) }, { "Cache-Control": "no-store" });
            return;
          }
          const claimed = shortcutBookkeepingRepository.claim(reviewId);
          try {
            const current = claimed.item;
            let analyzed;
            try {
              analyzed = applyShortcutSelectionAnalysis(
                await travelExpenseAnalyzer(current.rawText),
                current,
              );
            } catch {
              analyzed = {
                status: "review_required",
                confidence: 0,
                expense: null,
                warnings: ["model_error"],
                source: { provider: config.modelProvider || "deepseek", model: config.modelName || null },
              };
            }
            // Retry means "analyze again", not "confirm". Even a complete
            // ready result must return to the human-review state; only the
            // explicit /confirm route is allowed to create formal ledger rows.
            analyzed = {
              ...analyzed,
              status: "review_required",
            };
            const completed = shortcutBookkeepingRepository.completeLocal(reviewId, {
              analysis: analyzed,
              leaseToken: claimed.leaseToken,
            });
            shortcutBookkeepingAssistantRuntime.attachAcceptedEntryAttachments({
              account: owner,
              entry: completed.item,
              requestId,
            });
            sendJson(response, completed.item.status === "accepted" ? 201 : 202, {
              item: reviewResponseItem(completed.item, completed.replayed),
            }, { "Cache-Control": "no-store" });
          } catch (error) {
            shortcutBookkeepingRepository.release(reviewId, {
              leaseToken: claimed.leaseToken,
              errorCode: "SHORTCUT_REVIEW_RETRY_FAILED",
            });
            throw error;
          }
          return;
        }
        return notFound();
      }

      if (request.method === "GET" && url.pathname === "/api/travel-expense-workbench") {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        const owner = request.authContext.account;
        const weekStart = validateTravelExpenseWeekStart(url.searchParams.get("weekStart"));
        // Read the formal rows and the human-review queue from one SQLite
        // snapshot. Without this boundary, a concurrent confirmation between
        // SELECTs could make a record disappear from one projection cycle.
        const item = withConsistentReadSnapshot(db, () => {
          const expenses = travelExpenseRepository.listExpenses({ owner, weekStart });
          const advances = travelExpenseRepository.listAdvances({ owner, weekStart });
          const bookkeepingReviews = shortcutBookkeepingRepository.listReview({
            owner,
            status: "review_required",
            limit: 100,
          });
          const regionProfile = travelExpenseRegionRepository.getProfile({ owner, weekStart });
          const recentLedgerReceipts = shortcutBookkeepingRepository.listRecentLedgerReceipts({
            owner,
            limit: 50,
          });
          return {
            weekStart,
            expenses,
            advances,
            bookkeepingReviews: bookkeepingReviews.map((review) => shortcutReviewResponseItem(review)),
            regionProfile,
            recentLedgerReceipts,
            generatedAt: new Date().toISOString(),
          };
        });
        sendJson(response, 200, {
          item,
        }, { "Cache-Control": "no-store" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/travel-expense-region-profile") {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        const owner = request.authContext.account;
        const weekStart = validateTravelExpenseWeekStart(url.searchParams.get("weekStart"));
        const item = travelExpenseRegionRepository.getProfile({ owner, weekStart });
        sendJson(response, 200, { item }, {
          "Cache-Control": "no-store",
          ETag: `"${item.version}"`,
        });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/travel-expense-region-profile") {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        const expectedVersion = parseRegionProfileExpectedVersion(request);
        const body = validateTravelExpenseRegionProfilePayload(await readJson(request));
        const owner = request.authContext.account;
        const item = withImmediateTransaction(db, () => {
          const before = travelExpenseRegionRepository.getProfile({
            owner,
            weekStart: body.weekStart,
          });
          let saved;
          try {
            saved = travelExpenseRegionRepository.putProfile({
              ...body,
              owner,
              actor: owner,
              expectedVersion,
            });
          } catch (error) {
            if (error instanceof TravelExpenseRegionProfileVersionConflictError) {
              throw new HttpError(409, "VERSION_CONFLICT", "The region profile was updated by another request", {
                currentVersion: error.currentVersion,
              });
            }
            throw error;
          }
          if (saved.version !== before.version) {
            insertAudit(db, {
              action: "travel_expense.region_profile.save",
              entityType: "travel_expense_region_profile",
              entityId: `${owner}:${body.weekStart}`,
              actor: owner,
              requestId,
              before,
              after: saved,
              entityVersion: saved.version,
              metadata: {
                weekStart: saved.weekStart,
                cityCount: saved.cities.length,
                overrideCount: saved.dateOverrides.length,
              },
            });
          }
          return saved;
        });
        let draftRefresh;
        try {
          const refreshedEntryIds = shortcutBookkeepingAssistantRuntime.refreshRegionDependentDrafts({
            account: owner,
            weekStart: item.weekStart,
          });
          draftRefresh = {
            status: "completed",
            refreshedCount: Array.isArray(refreshedEntryIds) ? refreshedEntryIds.length : 0,
          };
        } catch {
          // The profile and its audit row are already durably committed. Do not
          // report a false save failure that makes a client retry the old
          // If-Match version. Pending confirmations remain version-gated and a
          // later region refresh/confirmation attempt can recover the drafts.
          draftRefresh = {
            status: "deferred",
            refreshedCount: 0,
            errorCode: "REGION_DRAFT_REFRESH_DEFERRED",
          };
        }
        sendJson(response, 200, { item, draftRefresh }, {
          "Cache-Control": "no-store",
          ETag: `"${item.version}"`,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/hospital-tenders/run") {
        requireAdminRole(db, request);
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
        // 每请求查表（表极小）：角色/显示名变更即时生效免重登；回退轨会话无行
        // 时降级为 account/member。
        const sessionUser = getUser(db, requestIdentity.account);
        sendJson(response, 200, {
          account: requestIdentity.account,
          displayName: sessionUser?.displayName ?? requestIdentity.account,
          role: sessionUser?.role ?? "member",
          expiresAt: requestIdentity.expiresAt,
          csrfToken: requestIdentity.csrfToken,
        });
        return;
      }

      const assistantWebChatRoute = "/api/assistant/chat";
      const assistantWebConfirmRoute = "/api/assistant/confirm";
      const assistantWebHistoryRoute = "/api/assistant/history";
      if (
        url.pathname === assistantWebChatRoute
        || url.pathname === assistantWebConfirmRoute
        || url.pathname === assistantWebHistoryRoute
      ) {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        const remoteAddress = request.socket?.remoteAddress ?? "unknown";
        if (url.pathname === assistantWebHistoryRoute) {
          if (request.method !== "GET") {
            sendHttpError(response, new HttpError(405, "METHOD_NOT_ALLOWED", "Only GET is allowed for assistant history"), responseOptions(response, { Allow: "GET" }));
            return;
          }
          const history = assistantWebHttp.handleHistory({
            requestIdentity,
            conversationId: url.searchParams.get("conversationId"),
          });
          sendJson(response, history.status, history.body, { "Cache-Control": "no-store" });
          return;
        }
        if (request.method !== "POST") {
          sendHttpError(response, new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed for assistant web actions"), responseOptions(response, { Allow: "POST" }));
          return;
        }
        const maxBytes = Math.min(config.jsonBodyLimitBytes, 32 * 1024);
        const body = await readJson(request, { maxBytes });
        if (url.pathname === assistantWebChatRoute) {
          const result = await assistantWebHttp.handleChat({
            requestIdentity,
            remoteAddress,
            requestId,
            body,
          });
          sendJson(response, result.status, result.body, { "Cache-Control": "no-store" });
          return;
        }
        const result = await assistantWebHttp.handleConfirm({
          requestIdentity,
          remoteAddress,
          requestId,
          body,
        });
        sendJson(response, result.status, result.body, { "Cache-Control": "no-store" });
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

      if (request.method === "POST" && url.pathname === "/api/auth/change-password") {
        if (requestIdentity.kind !== "user") return unauthorized(response);
        const body = await readValidatedJson(request, requestSchemas.changePassword);
        assertUserPasswordPolicy(body.newPassword);
        const account = requestIdentity.account;
        const address = request.socket?.remoteAddress ?? "unknown";
        // 复用登录限流键（account+address 与 IP 全域），防拿到会话后暴破旧密码。
        const limiterKeys = [
          loginRateLimitKey(config.authSessionSecret, account, address),
          loginRateLimitKey(config.authSessionSecret, "<all-accounts>", address),
        ];
        const now = Date.now();
        pruneLoginRateLimits(db, now);
        for (const limiterKey of limiterKeys) assertLoginAllowed(db, limiterKey, now);
        const user = getUser(db, account);
        if (!user) {
          throw new HttpError(
            409,
            "USER_NOT_PROVISIONED",
            "当前会话来自环境凭据回退，用户表中没有该账号，暂不能在线修改密码",
          );
        }
        const currentPasswordValid = await verifyPassword(body.currentPassword, user.passwordHash);
        if (!currentPasswordValid) {
          for (const limiterKey of limiterKeys) recordLoginFailure(db, limiterKey, now);
          // 绝不可回 401：前端 requestApi 对一切 401 调 invalidateSession 全局登出。
          throw new HttpError(403, "CURRENT_PASSWORD_INCORRECT", "当前密码不正确");
        }
        for (const limiterKey of limiterKeys) clearLoginFailures(db, limiterKey);
        const newPasswordHash = await hashPassword(body.newPassword);
        const result = withImmediateTransaction(db, () => {
          let updated;
          try {
            updated = updateUserVersioned(db, {
              account,
              expectedVersion: user.version,
              set: { passwordHash: newPasswordHash },
              now,
            });
          } catch (error) {
            userRepositoryFailure(error);
          }
          // 改密后吊销本人其他会话、当前会话保留：被盗会话改密自锁 + 改密者不被打断。
          const revokedSessions = revokeSessionsForAccount(db, account, {
            exceptSessionId: requestIdentity.id,
            now,
          }).changes;
          insertAudit(db, {
            action: "password.change",
            entityType: "user",
            entityId: account,
            actor: account,
            requestId,
            before: null,
            // 审计敏感键正则会剔除含 session 的键名，计数键用 revokedCount。
            after: { revokedCount: revokedSessions },
            entityVersion: updated.version,
          });
          return { revokedSessions };
        });
        sendJson(response, 200, { ok: true, revokedSessions: result.revokedSessions });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/users") {
        requireAdminRole(db, request);
        sendJson(response, 200, {
          items: listUsers(db).map(userResponseItem),
        }, { "Cache-Control": "no-store" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/users") {
        requireAdminRole(db, request);
        const body = await readValidatedJson(request, requestSchemas.adminUserCreate);
        const account = body.account.trim();
        if (!isValidUserAccount(account)) validationFailure("account", "format");
        assertUserPasswordPolicy(body.password);
        const displayName = body.displayName.trim();
        // scrypt 异步且耗时，放事务外；PK 即幂等闸，不接 Idempotency-Key。
        const passwordHash = await hashPassword(body.password);
        let item;
        try {
          item = withImmediateTransaction(db, () => {
            const created = createUser(db, {
              account,
              displayName,
              passwordHash,
              role: body.role ?? "member",
            });
            insertAudit(db, {
              action: "user.create",
              entityType: "user",
              entityId: account,
              actor: request.authContext.account,
              requestId,
              before: null,
              after: {
                account: created.account,
                displayName: created.displayName,
                role: created.role,
                status: created.status,
              },
              entityVersion: created.version,
            });
            return created;
          });
        } catch (error) {
          if (/UNIQUE constraint failed/i.test(String(error?.message ?? ""))) {
            throw new HttpError(409, "USER_EXISTS", "账号已存在");
          }
          throw error;
        }
        sendJson(response, 201, { item: userResponseItem(item) }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        request.method === "PATCH"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "admin"
        && parts[2] === "users"
        && parts[3]
      ) {
        requireAdminRole(db, request);
        const targetAccount = parts[3];
        const body = await readValidatedJson(request, requestSchemas.adminUserPatch);
        if (
          body.displayName === undefined
          && body.role === undefined
          && body.status === undefined
          && body.password === undefined
        ) {
          validationFailure("body", "empty");
        }
        if (body.password !== undefined) assertUserPasswordPolicy(body.password);
        const passwordHash = body.password !== undefined ? await hashPassword(body.password) : undefined;
        const actorAccount = request.authContext.account;
        const item = withImmediateTransaction(db, () => {
          const target = getUser(db, targetAccount);
          if (!target) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
          if (targetAccount === actorAccount && body.status === "disabled") {
            throw new HttpError(409, "SELF_DISABLE_FORBIDDEN", "不能停用自己");
          }
          const strippingAdmin = target.role === "admin" && target.status === "active"
            && (body.status === "disabled" || body.role === "member");
          if (strippingAdmin && countActiveAdmins(db) === 1) {
            throw new HttpError(409, "LAST_ADMIN_PROTECTED", "至少保留一位启用状态的管理员");
          }
          const set = {};
          if (body.displayName !== undefined) set.displayName = body.displayName.trim();
          if (body.role !== undefined) set.role = body.role;
          if (body.status !== undefined) set.status = body.status;
          if (passwordHash !== undefined) set.passwordHash = passwordHash;
          let updated;
          try {
            updated = updateUserVersioned(db, {
              account: targetAccount,
              expectedVersion: body.expectedVersion,
              set,
            });
          } catch (error) {
            userRepositoryFailure(error);
          }
          let sessionsRevoked = 0;
          if (body.status === "disabled" || passwordHash !== undefined) {
            // 例外：admin 重置自己密码时保留当前会话，防被自己踢出中断操作。
            const exceptSessionId = targetAccount === actorAccount && passwordHash !== undefined
              ? request.authContext.id
              : undefined;
            sessionsRevoked = revokeSessionsForAccount(db, targetAccount, { exceptSessionId }).changes;
          }
          const profileBefore = {};
          const profileAfter = {};
          if (set.displayName !== undefined && set.displayName !== target.displayName) {
            profileBefore.displayName = target.displayName;
            profileAfter.displayName = updated.displayName;
          }
          if (set.role !== undefined && set.role !== target.role) {
            profileBefore.role = target.role;
            profileAfter.role = updated.role;
          }
          if (Object.keys(profileAfter).length > 0) {
            insertAudit(db, {
              action: "user.update",
              entityType: "user",
              entityId: targetAccount,
              actor: actorAccount,
              requestId,
              before: profileBefore,
              after: profileAfter,
              entityVersion: updated.version,
            });
          }
          if (set.status !== undefined && set.status !== target.status) {
            insertAudit(db, {
              action: set.status === "disabled" ? "user.disable" : "user.enable",
              entityType: "user",
              entityId: targetAccount,
              actor: actorAccount,
              requestId,
              before: { status: target.status },
              after: { status: updated.status, revokedCount: sessionsRevoked },
              entityVersion: updated.version,
            });
          }
          if (passwordHash !== undefined) {
            insertAudit(db, {
              action: "password.reset",
              entityType: "user",
              entityId: targetAccount,
              actor: actorAccount,
              requestId,
              before: null,
              after: { revokedCount: sessionsRevoked },
              entityVersion: updated.version,
            });
          }
          return updated;
        });
        sendJson(response, 200, { item: userResponseItem(item) }, { "Cache-Control": "no-store" });
        return;
      }

      // v0.9.3 微信绑定管理（均 requireAdminRole；机器路由白名单不加，机器令牌 403）。
      if (request.method === "GET" && url.pathname === "/api/admin/weixin-bindings") {
        requireAdminRole(db, request);
        const displayNames = new Map(listUsers(db).map((user) => [user.account, user.displayName]));
        sendJson(response, 200, {
          items: weixinBindingsRepository.listAll().map((binding) => (
            weixinBindingResponseItem(binding, displayNames.get(binding.account) ?? null)
          )),
        }, { "Cache-Control": "no-store" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/weixin-bindings/codes") {
        requireAdminRole(db, request);
        const body = await readValidatedJson(request, requestSchemas.adminWeixinBindingCode);
        const account = body.account.trim();
        const targetUser = getUser(db, account);
        if (!targetUser) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
        if (targetUser.status !== "active") {
          throw new HttpError(409, "USER_DISABLED", "已停用账号不能生成绑定码，请先启用该账号");
        }
        if (weixinBindingsRepository.activeByAccount(account)) {
          throw new HttpError(409, "ACCOUNT_ALREADY_BOUND", "该账号已存在生效中的微信绑定，请先解绑");
        }
        const issued = withImmediateTransaction(db, () => {
          pruneExpiredBindingCodes(db);
          const created = issueBindingCode(db, {
            account,
            createdBy: request.authContext.account,
            secret: assistantConfirmationSecret,
          });
          insertAudit(db, {
            action: "weixin.binding.code_issued",
            entityType: "weixin_binding",
            entityId: account,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: null,
            metadata: { account, expiresAt: created.expiresAt },
          });
          return created;
        });
        // 绑定码明文只出现在本次响应：不入库（哈希存储）、不入审计、不入日志。
        sendJson(response, 201, {
          item: { account, code: issued.code, expiresAt: issued.expiresAt },
        }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        request.method === "PATCH"
        && parts.length === 4
        && parts[0] === "api"
        && parts[1] === "admin"
        && parts[2] === "weixin-bindings"
        && parts[3]
      ) {
        requireAdminRole(db, request);
        const targetSenderId = decodeURIComponent(parts[3]);
        const body = await readValidatedJson(request, requestSchemas.adminWeixinBindingPatch);
        if (
          body.displayName === undefined
          && body.financialEnabled === undefined
          && body.digestEnabled === undefined
          && body.status === undefined
        ) {
          validationFailure("body", "empty");
        }
        const actorAccount = request.authContext.account;
        const item = withImmediateTransaction(db, () => {
          const target = weixinBindingsRepository.bySender(targetSenderId);
          if (!target) throw new HttpError(404, "WEIXIN_BINDING_NOT_FOUND", "微信绑定不存在");
          const set = {};
          if (body.displayName !== undefined) set.displayName = body.displayName;
          if (body.financialEnabled !== undefined) set.financialEnabled = body.financialEnabled;
          if (body.digestEnabled !== undefined) set.digestEnabled = body.digestEnabled;
          if (body.status !== undefined) set.status = body.status;
          const updated = weixinBindingsRepository.updateVersioned({
            senderId: targetSenderId,
            expectedVersion: body.expectedVersion,
            set,
          });
          const before = {};
          const after = {};
          for (const field of ["displayName", "financialEnabled", "digestEnabled", "status"]) {
            if (set[field] !== undefined && updated[field] !== target[field]) {
              before[field] = target[field];
              after[field] = updated[field];
            }
          }
          const senderHash = weixinSenderHash(targetSenderId);
          if (Object.keys(after).length > 0) {
            // financial 开关变更必产生本行 = 财务授权可追溯。
            insertAudit(db, {
              action: "weixin.binding.updated",
              entityType: "weixin_binding",
              entityId: senderHash,
              actor: actorAccount,
              requestId,
              before,
              after,
              metadata: { senderHash, account: updated.account },
            });
          }
          if (set.status === "disabled" && target.status === "active") {
            insertAudit(db, {
              action: "weixin.binding.unbound",
              entityType: "weixin_binding",
              entityId: senderHash,
              actor: actorAccount,
              requestId,
              before: null,
              after: null,
              metadata: { senderHash, account: updated.account, via: "web_admin" },
            });
          }
          return updated;
        });
        const owningUser = getUser(db, item.account);
        sendJson(response, 200, {
          item: weixinBindingResponseItem(item, owningUser?.displayName ?? null),
        }, { "Cache-Control": "no-store" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/settings/security") {
        requireAdminRole(db, request);
        const repository = requireSecureSettings(secureSettingsRepository);
        let item;
        try {
          item = {
            deepseek: secureSettingMetadata(DEEPSEEK_SETTING_KEY, config.modelApiKey),
            pushplus: secureSettingMetadata(
              PUSHPLUS_SETTING_KEY,
              config.hospitalTenderPushplusToken,
            ),
            asr: secureSettingMetadata(ASR_SETTING_KEY),
          };
        } catch {
          throw new HttpError(503, "SECURE_SETTINGS_UNAVAILABLE", "Secure settings storage is unavailable");
        }
        sendJson(response, 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        request.method === "PUT"
        && url.pathname === "/api/settings/asr-api-key"
      ) {
        requireAdminRole(db, request);
        const value = validateSecureSettingBody(await readJson(request), { field: "apiKey", max: 500 });
        const repository = requireSecureSettings(secureSettingsRepository);
        const item = withImmediateTransaction(db, () => {
          const saved = repository.setSecret(ASR_SETTING_KEY, value);
          insertAudit(db, {
            action: "settings.asr_api_key.save",
            entityType: "secure_setting",
            entityId: ASR_SETTING_KEY,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: {
              status: saved.status,
              masked: saved.masked,
              updatedAt: saved.updatedAt,
            },
            metadata: { setting: ASR_SETTING_KEY },
          });
          return saved;
        });
        sendJson(response, 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/settings/asr-api-key") {
        requireAdminRole(db, request);
        const confirmation = validateSecureSettingBody(
          await readJson(request),
          { field: "confirmation", max: 32 },
        );
        if (confirmation !== "CLEAR") {
          throw new HttpError(428, "CONFIRMATION_REQUIRED", "Explicit confirmation is required to clear the ASR API key");
        }
        const repository = requireSecureSettings(secureSettingsRepository);
        const item = withImmediateTransaction(db, () => {
          const cleared = repository.clearSecret(ASR_SETTING_KEY);
          insertAudit(db, {
            action: "settings.asr_api_key.clear",
            entityType: "secure_setting",
            entityId: ASR_SETTING_KEY,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: { status: cleared.status, updatedAt: cleared.updatedAt },
            metadata: { setting: ASR_SETTING_KEY, confirmation: "provided" },
          });
          return cleared;
        });
        sendJson(response, 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        (request.method === "PUT" || request.method === "POST")
        && (url.pathname === "/api/settings/deepseek-key" || url.pathname === "/api/settings/deepseek-api-key")
      ) {
        requireAdminRole(db, request);
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
        sendJson(response, 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        request.method === "DELETE"
        && (url.pathname === "/api/settings/deepseek-key" || url.pathname === "/api/settings/deepseek-api-key")
      ) {
        requireAdminRole(db, request);
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
        sendJson(response, 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        (request.method === "PUT" || request.method === "POST")
        && (url.pathname === "/api/settings/pushplus-token" || url.pathname === "/api/settings/pushplus")
      ) {
        requireAdminRole(db, request);
        const value = validateSecureSettingBody(await readJson(request), { field: "token", max: 512 });
        const repository = requireSecureSettings(secureSettingsRepository);
        const item = withImmediateTransaction(db, () => {
          const saved = repository.setSecret(PUSHPLUS_SETTING_KEY, value);
          insertAudit(db, {
            action: "settings.pushplus_token.save",
            entityType: "secure_setting",
            entityId: PUSHPLUS_SETTING_KEY,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: {
              status: saved.status,
              masked: saved.masked,
              updatedAt: saved.updatedAt,
            },
            metadata: { setting: PUSHPLUS_SETTING_KEY },
          });
          return saved;
        });
        sendJson(response, 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        request.method === "DELETE"
        && (url.pathname === "/api/settings/pushplus-token" || url.pathname === "/api/settings/pushplus")
      ) {
        requireAdminRole(db, request);
        const confirmation = validateSecureSettingBody(
          await readJson(request),
          { field: "confirmation", max: 32 },
        );
        if (confirmation !== "CLEAR") {
          throw new HttpError(428, "CONFIRMATION_REQUIRED", "Explicit confirmation is required to clear the PushPlus token");
        }
        const repository = requireSecureSettings(secureSettingsRepository);
        const item = withImmediateTransaction(db, () => {
          const cleared = repository.clearSecret(PUSHPLUS_SETTING_KEY);
          insertAudit(db, {
            action: "settings.pushplus_token.clear",
            entityType: "secure_setting",
            entityId: PUSHPLUS_SETTING_KEY,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: { status: cleared.status, updatedAt: cleared.updatedAt },
            metadata: { setting: PUSHPLUS_SETTING_KEY, confirmation: "provided" },
          });
          return cleared;
        });
        sendJson(response, 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/settings/pushplus/test") {
        requireAdminRole(db, request);
        await validateEmptyBody(request);
        const repository = requireSecureSettings(secureSettingsRepository);
        if (!resolvePushplusToken()) {
          throw new HttpError(409, "PUSHPLUS_NOT_CONFIGURED", "PushPlus Token 尚未配置");
        }
        if (typeof hospitalTenderNotifier !== "function") {
          throw new HttpError(503, "PUSHPLUS_UNAVAILABLE", "PushPlus 通知服务暂不可用");
        }
        try {
          const count = await hospitalTenderNotifier({
            cycleNumber: 0,
            batchCustomerIds: [],
            notices: [{
              title: "森特智行测试通知",
              sourceName: "系统配置",
              publishedAt: new Date().toISOString(),
            }],
          });
          insertAudit(db, {
            action: "settings.pushplus_token.test",
            entityType: "secure_setting",
            entityId: PUSHPLUS_SETTING_KEY,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: { status: "sent", notificationCount: count },
            metadata: { setting: PUSHPLUS_SETTING_KEY },
          });
          sendJson(response, 200, {
            item: {
              status: "sent",
              notificationCount: count,
              testedAt: new Date().toISOString(),
            },
          }, { "Cache-Control": "no-store" });
        } catch (error) {
          const errorCode = pushplusDeliveryErrorCode(error);
          insertAudit(db, {
            action: "settings.pushplus_token.test_failed",
            entityType: "secure_setting",
            entityId: PUSHPLUS_SETTING_KEY,
            actor: request.authContext.account,
            requestId,
            before: null,
            after: { status: "failed", errorCode },
            metadata: { setting: PUSHPLUS_SETTING_KEY },
          });
          throw new HttpError(502, "PUSHPLUS_TEST_FAILED", "PushPlus 测试通知失败，请检查 Token 或稍后重试");
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/dashboard/summary") {
        sendJson(response, 200, {
          item: dashboardSummaryFromDb(db, {
            tenderRepository: hospitalTenderRepository,
            owner: requestOwner(request),
          }),
        });
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
        // 公告=全局情报，双账号可见；匹配客户名映射按账号过滤（B 不见 A 的客户名/
        // 匹配 id）。customerId 筛选先校归属：不属于当前账号 → 空集（200，防枚举
        // 且不破 UI）。
        const tenderOwner = requestOwner(request);
        if (customerId && tenderOwner && !activeCustomerRow(db, customerId, tenderOwner)) {
          sendJson(response, 200, { items: [], total: 0, limit, offset, hasMore: false });
          return;
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
        let total;
        try {
          total = hospitalTenderRepository.countNotices(filters);
        } catch (error) {
          throw new HttpError(422, "VALIDATION_ERROR", "招标公告筛选条件无效", { filters: error.message });
        }
        const customerNames = hospitalTenderCustomerNameMap(db, tenderOwner);
        const serializeOptions = { restrictMatchesToKnownCustomers: tenderOwner !== null };
        sendJson(response, 200, {
          items: items.map((item) => serializeHospitalTenderNotice(item, customerNames, serializeOptions)),
          total,
          limit,
          offset,
          hasMore: offset + items.length < total,
        });
        return;
      }

      if (
        request.method === "GET"
        && parts.length === 3
        && parts[0] === "api"
        && parts[1] === "hospital-tenders"
        && parts[2]
        && !new Set(["summary", "sources", "health", "scheduler"]).has(parts[2])
      ) {
        const item = hospitalTenderRepository.getNotice(parts[2]);
        if (!item) return notFound(response);
        const tenderOwner = requestOwner(request);
        sendJson(response, 200, {
          item: serializeHospitalTenderNotice(item, hospitalTenderCustomerNameMap(db, tenderOwner), {
            restrictMatchesToKnownCustomers: tenderOwner !== null,
          }),
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
            notification: hospitalTenderNotificationState(),
          },
        });
        return;
      }

      if (
        request.method === "GET"
        && (url.pathname === "/api/hospital-tenders/scheduler" || url.pathname === "/api/hospital-tenders/scheduler/status")
      ) {
        if (request.authContext.kind !== "user") return unauthorized(response);
        sendJson(response, 200, {
          item: hospitalTenderScheduler.getState(),
          runs: hospitalTenderScheduler.listRuns(10),
          lock: hospitalTenderSchedulerRepository.lockState(),
          notification: hospitalTenderNotificationState(),
        });
        return;
      }

      if (
        request.method === "POST"
        && (url.pathname === "/api/hospital-tenders/scheduler/run-next" || url.pathname === "/api/hospital-tenders/scheduler/run")
      ) {
        requireAdminRole(db, request);
        await validateEmptyBody(request);
        const result = await hospitalTenderScheduler.runNext({ force: true });
        sendJson(response, result.status === "skipped" && result.reason === "locked" ? 409 : 200, {
          item: {
            status: result.status,
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.error ? { error: result.error } : {}),
            ...(result.cycleNumber !== undefined ? { cycleNumber: result.cycleNumber } : {}),
            ...(result.batchCustomerIds ? { batchCustomerIds: result.batchCustomerIds } : {}),
            ...(result.acceptedCount !== undefined ? { acceptedCount: result.acceptedCount } : {}),
            ...(result.rejectedCount !== undefined ? { rejectedCount: result.rejectedCount } : {}),
            ...(result.notificationCount !== undefined ? { notificationCount: result.notificationCount } : {}),
            notification: hospitalTenderNotificationState(),
            state: hospitalTenderScheduler.getState(),
          },
        });
        return;
      }

      if (request.method === "PATCH" && url.pathname === "/api/hospital-tenders/scheduler") {
        requireAdminRole(db, request);
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new HttpError(422, "VALIDATION_ERROR", "轮巡配置必须是对象");
        }
        const allowedFields = new Set(["enabled", "intervalMinutes", "batchSize"]);
        if (Object.keys(body).some((key) => !allowedFields.has(key))) {
          throw new HttpError(422, "VALIDATION_ERROR", "轮巡配置包含未知字段");
        }
        const patch = {};
        if (Object.hasOwn(body, "enabled")) {
          if (typeof body.enabled !== "boolean") throw new HttpError(422, "VALIDATION_ERROR", "enabled 必须是布尔值");
          patch.enabled = body.enabled;
        }
        if (Object.hasOwn(body, "intervalMinutes")) {
          if (!Number.isSafeInteger(body.intervalMinutes) || body.intervalMinutes < 1 || body.intervalMinutes > 1440) {
            throw new HttpError(422, "VALIDATION_ERROR", "intervalMinutes 必须在 1-1440 之间");
          }
          patch.intervalMinutes = body.intervalMinutes;
        }
        if (Object.hasOwn(body, "batchSize")) {
          if (!Number.isSafeInteger(body.batchSize) || body.batchSize < 1 || body.batchSize > 200) {
            throw new HttpError(422, "VALIDATION_ERROR", "batchSize 必须在 1-200 之间");
          }
          patch.batchSize = body.batchSize;
        }
        if (Object.hasOwn(body, "activeStartHour")) {
          if (!Number.isSafeInteger(body.activeStartHour) || body.activeStartHour < 0 || body.activeStartHour > 23) {
            throw new HttpError(422, "VALIDATION_ERROR", "activeStartHour 必须在 0-23 之间");
          }
          patch.activeStartHour = body.activeStartHour;
        }
        if (Object.hasOwn(body, "activeEndHour")) {
          if (!Number.isSafeInteger(body.activeEndHour) || body.activeEndHour < 1 || body.activeEndHour > 24) {
            throw new HttpError(422, "VALIDATION_ERROR", "activeEndHour 必须在 1-24 之间");
          }
          patch.activeEndHour = body.activeEndHour;
        }
        if (Object.hasOwn(patch, "activeStartHour") || Object.hasOwn(patch, "activeEndHour")) {
          const currentWindowState = hospitalTenderSchedulerRepository.getState();
          const nextStart = Object.hasOwn(patch, "activeStartHour")
            ? patch.activeStartHour
            : currentWindowState.activeStartHour;
          const nextEnd = Object.hasOwn(patch, "activeEndHour")
            ? patch.activeEndHour
            : currentWindowState.activeEndHour;
          if (nextStart >= nextEnd) {
            throw new HttpError(422, "VALIDATION_ERROR", "activeStartHour 必须小于 activeEndHour");
          }
        }
        if (Object.keys(patch).length === 0) throw new HttpError(422, "VALIDATION_ERROR", "未提供可更新配置");
        const windowChanged = Object.hasOwn(patch, "activeStartHour") || Object.hasOwn(patch, "activeEndHour");
        const item = hospitalTenderSchedulerRepository.updateState({
          ...patch,
          ...(patch.enabled === false || Object.hasOwn(patch, "intervalMinutes") || windowChanged
            ? { nextRunAt: null }
            : {}),
        });
        if (item.enabled && (Object.hasOwn(patch, "intervalMinutes") || windowChanged)) {
          hospitalTenderScheduler.stop();
          hospitalTenderScheduler.start();
        } else if (item.enabled && !hospitalTenderScheduler.isStarted()) {
          hospitalTenderScheduler.start();
        }
        if (!item.enabled && hospitalTenderScheduler.isStarted()) hospitalTenderScheduler.stop();
        sendJson(response, 200, {
          item: hospitalTenderScheduler.getState(),
          notification: hospitalTenderNotificationState(),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/hospital-tenders/scheduler/runs") {
        if (request.authContext.kind !== "user") return unauthorized(response);
        sendJson(response, 200, { items: hospitalTenderScheduler.listRuns(50) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/audit-logs") {
        sendJson(response, 200, {
          items: listAuditLogs(db, url.searchParams, request.authContext.account),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/bookkeeping/client-events") {
        if (request.authContext.kind !== "user") return unauthorized(response);
        const body = plainObject(await readJson(request));
        if (typeof body.event !== "string" || !bookkeepingClientEvents.has(body.event)) {
          validationFailure("event", "allowlist");
        }
        const account = request.authContext.account;
        insertAudit(db, {
          action: `bookkeeping_client.${body.event}`,
          entityType: "bookkeeping_client_event",
          actor: account,
          requestId,
          metadata: bookkeepingClientEventMetadata(body, account),
        });
        sendJson(response, 201, { recorded: true });
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
        sendJson(response, 200, { item }, { "Cache-Control": "no-store" });
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
          items = itineraryRepository.list({ status, owner: requestOwner(request) });
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
        const item = itineraryRepository.get(parts[2], { owner: requestOwner(request) });
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
        const itineraryOwner = requestOwner(request);
        const current = itineraryRepository.get(parts[2], { owner: itineraryOwner });
        if (!current) notFound();
        if (current.version !== expectedVersion) {
          throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
            currentVersion: current.version,
          });
        }
        const snapshotRequest = { ...body, status: body.status ?? current.status };
        const plan = await buildItineraryPlan(snapshotRequest);
        const item = withImmediateTransaction(db, () => {
          const before = itineraryRepository.get(parts[2], { owner: itineraryOwner });
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
              owner: itineraryOwner,
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
        const itineraryOwner = requestOwner(request);
        const deleted = withImmediateTransaction(db, () => {
          const before = itineraryRepository.get(parts[2], { owner: itineraryOwner });
          if (!before) notFound();
          let result;
          try {
            result = itineraryRepository.softDelete(parts[2], {
              expectedVersion,
              actor: request.authContext.account,
              owner: itineraryOwner,
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
        requireAdminRole(db, request);
        sendJson(response, 200, { item: weixinLoginBinding.current() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/integrations/weixin-agent/login") {
        requireAdminRole(db, request);
        await validateEmptyBody(request);
        sendJson(response, 201, { item: weixinLoginBinding.start() });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/integrations/weixin-agent/login") {
        requireAdminRole(db, request);
        await validateEmptyBody(request);
        sendJson(response, 200, { item: weixinLoginBinding.stop() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/customers") {
        // user 与 machine 分支合一为 owner 过滤（机器传自身 account，SQL 等价、行为不变）。
        const listOwner = requestOwner(request);
        const rows = all(
          db,
          `SELECT * FROM customers WHERE deleted_at IS NULL${ownerClause(listOwner)} ORDER BY created_at ASC`,
          ownerParams(listOwner),
        );
        sendJson(response, 200, { items: rows.map(customerFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/customers") {
        const body = await readValidatedJson(request, requestSchemas.customerCreate);
        const item = withImmediateTransaction(db, () => {
          const created = createCustomer(db, {
            ...body,
            owner: requestOwner(request) ?? LEGACY_OWNER,
          });
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
        const detailOwner = requestOwner(request);
        const item = customerFromRow(get(
          db,
          `SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause(detailOwner)}`,
          ownerParams(detailOwner, { $id: parts[2] }),
        ));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "customers" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, customerPatchSchema);
        const patchOwner = requestOwner(request);
        const item = withImmediateTransaction(db, () => {
          const before = customerFromRow(get(
            db,
            `SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause(patchOwner)}`,
            ownerParams(patchOwner, { $id: parts[2] }),
          ));
          if (!before) notFound();
          const updated = updateCustomer(db, parts[2], body, expectedVersion, { owner: patchOwner });
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
        const deleted = softDeleteCustomer(db, {
          id: parts[2],
          expectedVersion,
          deletedBy: request.authContext.account,
          requestId,
          owner: requestOwner(request),
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/opportunities") {
        const listOwner = requestOwner(request);
        const rows = all(
          db,
          `SELECT opportunities.*
           FROM opportunities
           INNER JOIN customers ON customers.id = opportunities.customer_id
           WHERE opportunities.deleted_at IS NULL
             AND customers.deleted_at IS NULL${ownerClause(listOwner, "opportunities.owner")}
           ORDER BY opportunities.created_at ASC`,
          ownerParams(listOwner),
        );
        sendJson(response, 200, { items: rows.map(opportunityFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/opportunities") {
        const body = await readValidatedJson(request, requestSchemas.opportunityCreate);
        const createOwner = requestOwner(request);
        const item = withImmediateTransaction(db, () => {
          // 跨账号客户 → 422 validationFailure（与"不存在"同响应，防枚举）。
          const customer = requireActiveCustomer(db, body.customerId, createOwner ?? undefined);
          const created = createOpportunity(db, {
            ...body,
            customer: customer.name,
            owner: createOwner ?? LEGACY_OWNER,
          });
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
        const item = opportunityFromRow(activeOpportunityEntityRow(db, parts[2], requestOwner(request) ?? undefined));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "opportunities" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, opportunityPatchSchema);
        const patchOwner = requestOwner(request);
        const item = withImmediateTransaction(db, () => {
          const before = opportunityFromRow(activeOpportunityEntityRow(db, parts[2], patchOwner ?? undefined));
          if (!before) notFound();
          const customer = requireActiveCustomer(db, body.customerId ?? before.customerId, patchOwner ?? undefined);
          const updated = updateOpportunity(db, parts[2], { ...body, customer: customer.name }, expectedVersion, { owner: patchOwner });
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
          owner: requestOwner(request),
          metadata: (before) => ({ name: before.name, customerId: before.customerId, stage: before.stage }),
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/actions") {
        const listOwner = requestOwner(request);
        const rows = all(
          db,
          `SELECT * FROM action_items
           WHERE deleted_at IS NULL${ownerClause(listOwner)}
           ORDER BY
             CASE priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
             updated_at DESC`,
          ownerParams(listOwner),
        );
        sendJson(response, 200, { items: rows.map(actionFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/actions") {
        // v0.10.0：Web 首个创建待办入口。owner ≡ 会话账号（v0.9.2 隔离契约），
        // 复用 actionItemStore.create（微信侧同一写路径），customerId 只允许挂
        // 接本人名下客户（查无按校验失败处理，防跨账号挂接与存在性探测）。
        const body = await readValidatedJson(request, requestSchemas.actionCreate);
        normalizeRemindAtField(body);
        const createOwner = requestOwner(request) ?? LEGACY_OWNER;
        const item = withImmediateTransaction(db, () => {
          let customerName = null;
          if (body.customerId) {
            const customerRow = get(
              db,
              `SELECT name FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause(createOwner)}`,
              ownerParams(createOwner, { $id: body.customerId }),
            );
            if (!customerRow) {
              throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { customerId: "invalid" });
            }
            customerName = customerRow.name;
          }
          const created = createActionItemStore(db).create({
            owner: createOwner,
            id: randomUUID(),
            title: body.title,
            reason: body.reason ?? null,
            due: body.due ?? null,
            remindAt: body.remindAt ?? null,
            priority: body.priority ?? "中",
            customerId: body.customerId ?? null,
            customerName,
          });
          insertAudit(db, {
            action: "action.create",
            entityType: "action",
            entityId: created.id,
            actor: request.authContext.account ?? createOwner,
            requestId,
            before: null,
            after: created,
            entityVersion: created.version,
            metadata: { source: "web", remindAt: created.remindAt, priority: created.priority },
          });
          return actionFromRow(get(db, "SELECT * FROM action_items WHERE id = $id AND deleted_at IS NULL", { $id: created.id }));
        });
        sendJson(response, 201, { item });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/actions/reminders/status") {
        if (request.authContext.kind !== "user") return unauthorized(response);
        const reminderOwner = requestOwner(request);
        const pending = get(
          db,
          `SELECT COUNT(*) AS count FROM action_items
           WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND deleted_at IS NULL
             AND status IN ('pending', 'in_progress')${ownerClause(reminderOwner)}`,
          ownerParams(reminderOwner),
        );
        sendJson(response, 200, {
          item: actionReminderScheduler.status(),
          pendingCount: Number(pending?.count ?? 0),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/digest/status") {
        if (request.authContext.kind !== "user") return unauthorized(response);
        sendJson(response, 200, {
          item: dailyDigestScheduler.status(),
          markers: dailyDigestScheduler.markers(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/digest/run") {
        // v0.9.2：运维端点归位 admin 门禁（member 探测即 403）；dryRun 回显以调用者
        // 账号为 digest owner，堵"回显他人晨报全文"的泄露面。
        requireAdminRole(db, request);
        const kind = url.searchParams.get("kind") ?? "daily";
        if (kind !== "daily" && kind !== "friday") {
          badRequest(response, "kind must be daily or friday");
          return;
        }
        const dryRunRaw = url.searchParams.get("dryRun");
        const dryRun = dryRunRaw === "1" || dryRunRaw === "true";
        await validateEmptyBody(request);
        if (dryRun) {
          // Preview only: build and render against live data without touching
          // the outbox, the idempotency marker, or the audit log.
          const digestOwner = request.authContext.account;
          const built = kind === "daily"
            ? await digestContentBuilder.buildDailyDigest({ owner: digestOwner })
            : await digestContentBuilder.buildFridayCloseout({ owner: digestOwner });
          if (built.empty) {
            sendJson(response, 200, { kind, dryRun: true, status: "empty", reason: built.reason });
            return;
          }
          const message = kind === "daily"
            ? renderDailyDigestMessage(built.payload)
            : renderFridayCloseoutMessage(built.payload);
          sendJson(response, 200, { kind, dryRun: true, status: "rendered", message, stats: built.stats });
          return;
        }
        const result = await dailyDigestScheduler.runManual({ kind });
        sendJson(response, 200, { kind, dryRun: false, ...result });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "actions" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, requestSchemas.actionPatch);
        normalizeRemindAtField(body);
        const patchOwner = requestOwner(request);
        const item = withImmediateTransaction(db, () => {
          const before = actionFromRow(get(
            db,
            `SELECT * FROM action_items WHERE id = $id AND deleted_at IS NULL${ownerClause(patchOwner)}`,
            ownerParams(patchOwner, { $id: parts[2] }),
          ));
          if (!before) notFound();
          const updated = updateActionItem(db, parts[2], body, expectedVersion, patchOwner);
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
          owner: requestOwner(request),
          metadata: (before) => ({ title: before.title, customerId: before.customerId, status: before.status }),
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/risks") {
        const listOwner = requestOwner(request);
        const rows = all(
          db,
          `SELECT * FROM risk_items
           WHERE deleted_at IS NULL${ownerClause(listOwner)}
           ORDER BY
             CASE severity WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
             score DESC,
             updated_at DESC`,
          ownerParams(listOwner),
        );
        sendJson(response, 200, { items: rows.map(riskFromRow) });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "risks" && parts[2]) {
        const expectedVersion = parseExpectedVersion(request);
        const body = await readValidatedJson(request, requestSchemas.riskPatch);
        const patchOwner = requestOwner(request);
        const item = withImmediateTransaction(db, () => {
          const before = riskFromRow(get(
            db,
            `SELECT * FROM risk_items WHERE id = $id AND deleted_at IS NULL${ownerClause(patchOwner)}`,
            ownerParams(patchOwner, { $id: parts[2] }),
          ));
          if (!before) notFound();
          const updated = updateRiskItem(db, parts[2], body, expectedVersion, patchOwner);
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
          owner: requestOwner(request),
          metadata: (before) => ({ title: before.title, status: before.status, sourceType: before.sourceType }),
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/knowledge") {
        // D1 裁定：知识库本版从"全局"翻转为"个人"。
        const listOwner = requestOwner(request);
        const rows = all(
          db,
          `SELECT * FROM knowledge_items WHERE deleted_at IS NULL${ownerClause(listOwner)} ORDER BY updated_at DESC, title ASC`,
          ownerParams(listOwner),
        );
        sendJson(response, 200, { items: rows.map(knowledgeFromRow) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/knowledge") {
        const body = await readValidatedJson(request, requestSchemas.knowledgeCreate);
        const item = withImmediateTransaction(db, () => {
          const created = createKnowledgeItem(db, {
            ...body,
            title: String(body.title).trim(),
          }, requestOwner(request) ?? LEGACY_OWNER);
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
        const patchOwner = requestOwner(request);
        const item = withImmediateTransaction(db, () => {
          const before = knowledgeFromRow(get(
            db,
            `SELECT * FROM knowledge_items WHERE id = $id AND deleted_at IS NULL${ownerClause(patchOwner)}`,
            ownerParams(patchOwner, { $id: parts[2] }),
          ));
          if (!before) notFound();
          const updated = updateKnowledgeItem(db, parts[2], body, expectedVersion, patchOwner);
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
          owner: requestOwner(request),
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
          owner: requestOwner(request),
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
        const diagnoseOwner = requestOwner(request);
        const items = withImmediateTransaction(db, () => {
          const opportunity = opportunityFromRow(activeOpportunityEntityRow(db, parts[2], diagnoseOwner ?? undefined));
          if (!opportunity) notFound();
          const customer = customerFromRow(get(
            db,
            `SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause(diagnoseOwner)}`,
            ownerParams(diagnoseOwner, { $id: opportunity.customerId }),
          ));
          if (!customer) notFound();

          return buildOpportunityRiskDrafts({
            customer,
            opportunity,
            sourceType,
            sourceId,
            owner: diagnoseOwner ?? LEGACY_OWNER,
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
        const ownerScope = quickRecordOwnerScope(request.authContext);
        const rows = all(
          db,
          `SELECT * FROM quick_records
           WHERE voided_at IS NULL${ownerScope.clause}
           ORDER BY created_at DESC`,
          ownerScope.params,
        );
        sendJson(response, 200, { items: rows.map((row) => quickRecordHistoryFromRow(db, row)) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/quick-records/preview") {
        const body = await readValidatedJson(request, requestSchemas.quickRecordPreview);
        const rawContent = String(body.rawContent ?? "").trim();

        const analysisKnowledge = searchKnowledgeForAnalysis(db, rawContent, 4, requestOwner(request));
        const analysis = await analyzeQuickRecord(rawContent, runtimeConfig, {
          fetchImpl: options.fetchImpl,
          knowledgeItems: analysisKnowledge,
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
        if (body.occurredAt !== undefined && body.occurredAt !== null) {
          if (!Number.isFinite(Date.parse(body.occurredAt))) {
            validationFailure("occurredAt", "dateTime");
          }
        }
        const item = withImmediateTransaction(db, () => {
          // v0.9.2：目标归属校验对 user 与 machine 一视同仁（机器 account=WEIXIN_AGENT_OWNER，
          // 值相同、行为不变）。
          validateCustomerOpportunityPair(db, body.customerId, body.opportunityId, {
            owner: requestOwner(request) ?? undefined,
          });
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
        const ownerScope = quickRecordOwnerScope(request.authContext);
        const quickRecord = quickRecordFromRow(
          get(
            db,
            `SELECT * FROM quick_records WHERE id = $id${ownerScope.clause}`,
            { $id: parts[2], ...ownerScope.params },
          ),
        );
        if (!quickRecord) return notFound(response);
        assertQuickRecordConfirmationEditable(quickRecord);

        const analysisKnowledge = searchKnowledgeForAnalysis(db, quickRecord.rawContent, 4, requestOwner(request));
        const analysis = await analyzeQuickRecord(quickRecord.rawContent, runtimeConfig, {
          fetchImpl: options.fetchImpl,
          knowledgeItems: analysisKnowledge,
        });
        if (!analysis) return badRequest(response, "quick record content is empty");

        const result = withImmediateTransaction(db, () => {
          const current = quickRecordFromRow(get(
            db,
            `SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL${ownerScope.clause}`,
            { $id: quickRecord.id, ...ownerScope.params },
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
          run(db, `UPDATE quick_records
            SET status = 'analyzed', updated_at = CURRENT_TIMESTAMP
            WHERE id = $id${ownerScope.clause}`, {
            $id: current.id,
            ...ownerScope.params,
          });
          const updatedRecord = quickRecordFromRow(get(
            db,
            `SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL${ownerScope.clause}`,
            { $id: current.id, ...ownerScope.params },
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
        const ownerScope = quickRecordOwnerScope(request.authContext);

        // The write itself lives in the shared quick-record store so the web
        // PATCH route and the WeChat assistant edit the analysis through one
        // SQL implementation (v0.7.3); route semantics and body shape are
        // unchanged (the store's join/void projection keys are stripped).
        const webProjection = ({ customerName, voidedAt, voidedBy, voidReason, ...record }) => record;
        const result = withImmediateTransaction(db, () => {
          const updated = assistantQuickRecordStore.updateInsightSummary({
            owner: ownerScope.params.$owner ?? null,
            id: parts[2],
            expectedVersion,
            summaryPatch: body.summary,
          });
          const beforeRecord = webProjection(updated.beforeRecord);
          const quickRecord = webProjection(updated.record);
          insertAudit(db, {
            action: "quick_record.analysis.update",
            entityType: "quick_record",
            entityId: quickRecord.id,
            actor: request.authContext.account,
            requestId,
            before: { quickRecord: beforeRecord, analysis: updated.beforeAnalysis },
            after: { quickRecord, analysis: updated.analysis },
            entityVersion: quickRecord.version,
            metadata: {
              insightId: updated.analysis.id,
              summaryFields: Object.keys(body.summary),
            },
          });
          return { quickRecord, analysis: updated.analysis };
        });
        sendJson(response, 200, result);
        return;
      }

      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "quick-records" &&
        parts[2] &&
        parts[3] === "confirmation-previews"
      ) {
        await validateEmptyBody(request);
        if (request.authContext.kind === "machine") {
          throw new HttpError(403, "HUMAN_CONFIRMATION_REQUIRED", "A signed-in human session is required");
        }
        let item;
        try {
          item = quickRecordConfirmationService.preview({
            owner: request.authContext.account,
            quickRecordId: parts[2],
          });
        } catch (error) {
          quickRecordConfirmationFailure(error);
        }
        sendJson(response, item.replayed ? 200 : 201, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "quick-record-confirmation-previews" &&
        parts[2]
      ) {
        let item;
        try {
          item = quickRecordConfirmationService.get({
            owner: request.authContext.account,
            previewId: parts[2],
          });
        } catch (error) {
          quickRecordConfirmationFailure(error);
        }
        sendJson(response, 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "quick-record-confirmation-previews" &&
        parts[2] &&
        parts[3] === "confirm-item"
      ) {
        if (request.authContext.kind === "machine") {
          throw new HttpError(403, "HUMAN_CONFIRMATION_REQUIRED", "A signed-in human session is required");
        }
        const body = await readValidatedJson(request, requestSchemas.quickRecordConfirmationItem);
        let result;
        try {
          result = quickRecordConfirmationService.confirmItem({
            ...body,
            owner: request.authContext.account,
            previewId: parts[2],
            actor: request.authContext,
          });
        } catch (error) {
          quickRecordConfirmationFailure(error);
        }
        const item = {
          ...result,
          reason: result.reason ?? null,
          details: result.details ?? null,
        };
        sendJson(response, result.status === "conflict" ? 409 : 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "quick-record-confirmation-previews" &&
        parts[2] &&
        parts[3] === "confirm-all"
      ) {
        if (request.authContext.kind === "machine") {
          throw new HttpError(403, "HUMAN_CONFIRMATION_REQUIRED", "A signed-in human session is required");
        }
        const body = await readValidatedJson(request, requestSchemas.quickRecordConfirmationAll);
        let result;
        try {
          result = quickRecordConfirmationService.confirmAll({
            ...body,
            owner: request.authContext.account,
            previewId: parts[2],
            actor: request.authContext,
          });
        } catch (error) {
          quickRecordConfirmationFailure(error);
        }
        const item = {
          ...result,
          reason: result.reason ?? null,
          details: result.details ?? null,
        };
        sendJson(response, result.status === "conflict" ? 409 : 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "quick-record-confirmation-previews" &&
        parts[2] &&
        parts[3] === "cancel"
      ) {
        if (request.authContext.kind === "machine") {
          throw new HttpError(403, "HUMAN_CONFIRMATION_REQUIRED", "A signed-in human session is required");
        }
        const body = await readValidatedJson(request, requestSchemas.quickRecordConfirmationCancel);
        let item;
        try {
          item = quickRecordConfirmationService.cancel({
            ...body,
            owner: request.authContext.account,
            previewId: parts[2],
            actor: request.authContext,
          });
        } catch (error) {
          quickRecordConfirmationFailure(error);
        }
        sendJson(response, 200, { item }, { "Cache-Control": "no-store" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/ai/sales-decisions") {
        const items = salesDecisionRepository.list({
          customerId: url.searchParams.get("customerId") || undefined,
          opportunityId: url.searchParams.get("opportunityId") || undefined,
          quickRecordId: url.searchParams.get("quickRecordId") || undefined,
          owner: requestOwner(request),
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
        const item = salesDecisionRepository.get(parts[3], { owner: requestOwner(request) });
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/ai/sales-decisions") {
        const body = await readValidatedJson(request, requestSchemas.salesDecisionAnalyze);
        const decisionOwner = requestOwner(request);
        const context = buildSalesDecisionContext(db, body, decisionOwner);
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
            owner: decisionOwner ?? LEGACY_OWNER,
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
            `INSERT INTO ai_suggestions (id, type, title, status, content, source_refs, owner)
             VALUES ($id, $type, $title, $status, $content, $sourceRefs, $owner)`,
            {
              $id: id,
              $type: suggestion.type,
              $title: suggestion.title,
              $status: suggestion.status,
              $content: suggestion.content,
              $sourceRefs: JSON.stringify(suggestion.sourceRefs),
              $owner: requestOwner(request) ?? LEGACY_OWNER,
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
        const ownerScope = quickRecordOwnerScope(request.authContext);

        const result = withImmediateTransaction(db, () => {
          const claim = claimIdempotency(db, idempotencyScope);
          if (claim.replay) return { status: claim.status, body: claim.body };

          const quickRecord = quickRecordFromRow(get(
            db,
            `SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL${ownerScope.clause}`,
            { $id: parts[2], ...ownerScope.params },
          ));
          if (!quickRecord) notFound();
          if (quickRecord.version !== expectedQuickRecordVersion) {
            throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
              currentVersion: quickRecord.version,
            });
          }
          // A v2 durable preview owns the record's final state.  Keep the
          // legacy all-in-one confirmation route from reopening or
          // overwriting a completed/cancelled snapshot behind the new UI.
          assertQuickRecordConfirmationEditable(quickRecord);

          const insight = body.analysisVersionId
            ? insightFromRow(get(
              db,
              "SELECT * FROM ai_insights WHERE id = $id AND quick_record_id = $quickRecordId",
              { $id: body.analysisVersionId, $quickRecordId: quickRecord.id },
            ))
            : getLatestInsight(db, quickRecord.id);
          if (body.analysisVersionId && !insight) notFound();

          // v0.9.2：确认目标读取对 user 与 machine 一视同仁地带 owner 谓词。
          const confirmScopeOwner = requestOwner(request);
          // v0.9.3 顺手修复（v0.9.2 观察项）：模型分析可能给出幻觉客户/商机 id（如
          // cust-unknown）。模型来源的 id 仅在库内真实存在（含 owner 归属）时才作为
          // 确认目标，否则按“未匹配”回退记录原值，而不是让整个 confirm 以 422 中断。
          const insightCustomerId = insight?.customer?.id ?? null;
          const insightCustomerExists = insightCustomerId
            ? Boolean(get(
              db,
              `SELECT 1 AS present FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause(confirmScopeOwner)}`,
              ownerParams(confirmScopeOwner, { $id: insightCustomerId }),
            ))
            : false;
          const insightOpportunityId = insight?.opportunity?.id ?? null;
          const insightOpportunityExists = insightOpportunityId
            ? Boolean(activeOpportunityEntityRow(db, insightOpportunityId, confirmScopeOwner ?? undefined))
            : false;
          const nextCustomerId = targets.includes("customer")
            ? (insightCustomerExists ? insightCustomerId : quickRecord.customerId)
            : quickRecord.customerId;
          const nextOpportunityId = targets.includes("opportunity")
            ? (insightOpportunityExists ? insightOpportunityId : quickRecord.opportunityId)
            : quickRecord.opportunityId;
          const finalCustomer = nextCustomerId
            ? customerFromRow(get(
              db,
              `SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause(confirmScopeOwner)}`,
              ownerParams(confirmScopeOwner, { $id: nextCustomerId }),
            ))
            : null;
          const finalOpportunity = nextOpportunityId
            ? opportunityFromRow(activeOpportunityEntityRow(
              db,
              nextOpportunityId,
              confirmScopeOwner ?? undefined,
            ))
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
            extraWhereSql: ownerScope.clause,
            setSql: `status = 'confirmed',
                 customer_id = $customerId,
                 opportunity_id = $opportunityId`,
            params: {
              $customerId: nextCustomerId ?? null,
              $opportunityId: nextOpportunityId ?? null,
              ...ownerScope.params,
            },
          });
          const updatedRecord = quickRecordFromRow(get(
            db,
            `SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL${ownerScope.clause}`,
            { $id: quickRecord.id, ...ownerScope.params },
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
        if (request.authContext.kind === "machine" && body.owner !== request.authContext.account) {
          throw new HttpError(403, "OWNER_SCOPE_DENIED", "Machine identity cannot select another business owner");
        }
        // v0.9.2：user 与 machine 统一以会话账号为 draft owner（Web 忽略 body.owner）；
        // anonymous 单人开发模式保留 body/legacy 回退。
        const scopeOwner = requestOwner(request);
        const draftOwner = scopeOwner ?? body.owner ?? LEGACY_OWNER;
        const knowledgeIds = normalizeKnowledgeIds(body.knowledgeIds);
        if (knowledgeIds === null) {
          validationFailure("knowledgeIds", "array");
        }
        const knowledge = getKnowledgeItemsByIds(db, knowledgeIds, scopeOwner);
        if (knowledge.length !== knowledgeIds.length) {
          validationFailure("knowledgeIds");
        }

        const rows = all(
          db,
          `SELECT qr.*, ai.analysis_json
           FROM quick_records qr
           LEFT JOIN manual_confirmations mc ON mc.quick_record_id = qr.id AND mc.target = 'weekly'
           LEFT JOIN ai_insights ai ON ai.quick_record_id = qr.id
           WHERE date(substr(COALESCE(qr.occurred_at, qr.created_at), 1, 10))
             BETWEEN date($periodStart) AND date($periodEnd)${ownerClause(scopeOwner, "qr.owner")}
             AND (
               (
                 qr.status IN ('analyzed', 'confirmed')
                 AND (qr.source_channel = '微信助手' OR mc.id IS NOT NULL)
               )
               OR qr.confirmation_preview_status = 'completed'
             )
           GROUP BY qr.id
           ORDER BY COALESCE(qr.occurred_at, qr.created_at) ASC`,
          ownerParams(scopeOwner, {
            $periodStart: body.periodStart,
            $periodEnd: body.periodEnd,
          }),
        );

        const records = rows.map((row) => ({
          ...quickRecordFromRow(row),
          analysis: parseJson(row.analysis_json, null),
        }));
        const fallbackDraft = buildWeeklyDraft({
          owner: draftOwner,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          records,
          knowledge,
        });
        const draft = await enhanceWeeklyDraftWithModel(
          fallbackDraft,
          {
            owner: draftOwner,
            periodStart: body.periodStart,
            periodEnd: body.periodEnd,
            records,
            knowledge,
          },
          runtimeConfig,
          { fetchImpl: options.fetchImpl },
        );

        const item = withImmediateTransaction(db, () => {
          if (getKnowledgeItemsByIds(db, knowledgeIds, scopeOwner).length !== knowledgeIds.length) {
            validationFailure("knowledgeIds");
          }
          const id = randomUUID();
          run(
            db,
            `INSERT INTO weekly_reports (id, owner, period_start, period_end, status, content, source_refs)
             VALUES ($id, $owner, $periodStart, $periodEnd, 'draft', $content, $sourceRefs)`,
            {
              $id: id,
              $owner: draftOwner,
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
        const exportOwner = requestOwner(request);
        const item = weeklyReportFromRow(get(
          db,
          `SELECT * FROM weekly_reports WHERE id = $id AND deleted_at IS NULL${ownerClause(exportOwner)}`,
          ownerParams(exportOwner, { $id: parts[3] }),
        ));
        if (!item) return notFound(response);
        const format = url.searchParams.get("format") ?? "word";
        if (format !== "word") return badRequest(response, "format must be word");
        const fileName = `weekly-report-${item.periodStart}-${item.periodEnd}.doc`;
        sendDocument(response, 200, buildWeeklyWordDocument(item), {
          "Content-Type": "application/msword; charset=utf-8",
          "Content-Disposition": attachmentContentDisposition(fileName),
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
        const patchOwner = requestOwner(request);
        const item = withImmediateTransaction(db, () => {
          const before = weeklyReportFromRow(get(
            db,
            `SELECT * FROM weekly_reports WHERE id = $id AND deleted_at IS NULL${ownerClause(patchOwner)}`,
            ownerParams(patchOwner, { $id: parts[3] }),
          ));
          if (!before) notFound();
          const updated = updateWeeklyReport(db, parts[3], body, expectedVersion, patchOwner);
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
          owner: requestOwner(request),
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
        const detailOwner = requestOwner(request);
        const item = weeklyReportFromRow(get(
          db,
          `SELECT * FROM weekly_reports WHERE id = $id AND deleted_at IS NULL${ownerClause(detailOwner)}`,
          ownerParams(detailOwner, { $id: parts[3] }),
        ));
        if (!item) return notFound(response);
        sendJson(response, 200, { item });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/solutions") {
        const items = activeSolutionDraftRows(db, requestOwner(request)).map(solutionDraftFromRow);
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

        // v0.9.2：owner=会话账号（Web 忽略 body.owner）；客户/商机/知识引用全部按
        // 账号校验归属（跨账号 → 422，与"不存在"同响应）。
        const scopeOwner = requestOwner(request);
        const draftOwner = scopeOwner ?? body.owner ?? LEGACY_OWNER;
        const customer = customerFromRow(get(
          db,
          `SELECT * FROM customers WHERE id = $id AND deleted_at IS NULL${ownerClause(scopeOwner)}`,
          ownerParams(scopeOwner, { $id: body.customerId }),
        ));
        const opportunity = opportunityFromRow(activeOpportunityEntityRow(db, body.opportunityId, scopeOwner ?? undefined));
        validateCustomerOpportunityPair(db, body.customerId, body.opportunityId, { owner: scopeOwner ?? undefined });
        const selectedKnowledge = getKnowledgeItemsByIds(db, knowledgeIds, scopeOwner);
        if (selectedKnowledge.length !== knowledgeIds.length) {
          validationFailure("knowledgeIds");
        }

        const actions = getDraftActions(db, {
          customerId: customer.id,
          opportunityId: opportunity.id,
          owner: scopeOwner,
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
          owner: scopeOwner,
        });
        const knowledge = mergeKnowledgeItems(selectedKnowledge, autoKnowledge).slice(0, 8);
        const fallbackDraft = buildSolutionDraft({
          owner: draftOwner,
          customer,
          opportunity,
          actions,
          knowledge,
          artifactType: normalizeSolutionArtifactType(artifactType),
        });
        const draft = await enhanceSolutionDraftWithModel(
          fallbackDraft,
          {
            owner: draftOwner,
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
          validateCustomerOpportunityPair(db, body.customerId, body.opportunityId, { owner: scopeOwner ?? undefined });
          if (getKnowledgeItemsByIds(db, knowledgeIds, scopeOwner).length !== knowledgeIds.length) {
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
              $owner: draftOwner,
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
          const before = solutionDraftFromRow(activeSolutionDraftRow(db, parts[2], requestOwner(request)));
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
        const item = solutionDraftFromRow(activeSolutionDraftRow(db, parts[2], requestOwner(request)));
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
      if (asrUnreadBodyFinalizer) {
        asrUnreadBodyFinalizer.defer(() => {
          if (request.destroyed === true) return true;
          try {
            request.destroy();
            return true;
          } catch {
            return false;
          }
        });
      }
      sendHttpError(response, error, responseOptions(response));
    }
  });

  server.on("close", () => {
    hospitalTenderScheduler.stop();
    actionReminderScheduler.stop();
    dailyDigestScheduler.stop();
    db.close();
  });
  server.hospitalTenderScheduler = hospitalTenderScheduler;
  server.hospitalTenderSchedulerRepository = hospitalTenderSchedulerRepository;
  server.actionReminderScheduler = actionReminderScheduler;
  server.dailyDigestScheduler = dailyDigestScheduler;
  server.asrService = asrService;

  // Node's native close callback only waits for HTTP connections.  Wrap it so
  // callers (tests, service scripts and production shutdown) also wait for ASR
  // request abort, media-child termination, pending cleanup and final sweep.
  const closeHttpServer = server.close.bind(server);
  let shutdownPromise = null;
  server.close = function closeWithAsr(callback) {
    if (!shutdownPromise) {
      const asrClose = asrService?.close?.() ?? Promise.resolve();
      // Attach a rejection observer immediately; the native HTTP close may
      // take longer than ASR teardown when keep-alive connections exist.
      Promise.resolve(asrClose).catch(() => {});
      shutdownPromise = new Promise((resolve, reject) => {
        closeHttpServer((httpError) => {
          Promise.resolve(asrClose).then(
            () => httpError ? reject(httpError) : resolve(),
            reject,
          );
        });
      });
    }
    if (typeof callback === "function") {
      shutdownPromise.then(() => callback(), (error) => callback(error));
    }
    return server;
  };
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`Backend listening on http://${config.host}:${config.port}`);
  });
}
