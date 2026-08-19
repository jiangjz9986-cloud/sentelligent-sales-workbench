import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "invoice";
const CONTRACT_VERSION = "invoice-v1";
const TASK_TYPES = new Set(["ingest", "recognize", "match_preview", "no_invoice_review"]);
const MONEY_FIELDS = new Set(["amountExTaxCents", "taxCents", "totalCents"]);
const TEXT_FIELDS = new Set(["invoiceCode", "invoiceNumber", "issuedOn", "sellerName", "buyerName", "suggestedCategory"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new AssistantContractError(`${name} is required`, "invalid_invoice_input");
  const normalized = value.trim();
  if (normalized.length > max) throw new AssistantContractError(`${name} is too long`, "invalid_invoice_input");
  return normalized;
}

function documentMetadata(value) {
  if (!isPlainObject(value)) throw new AssistantContractError("document is required", "invalid_invoice_input");
  const mediaType = text(value.mediaType, "document.mediaType", 100).toLowerCase();
  const sha256 = text(value.sha256, "document.sha256", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new AssistantContractError("document.sha256 is invalid", "invalid_invoice_input");
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 12 * 1024 * 1024) {
    throw new AssistantContractError("document.sizeBytes is invalid", "invalid_invoice_input");
  }
  return { mediaType, sizeBytes: value.sizeBytes, sha256 };
}

function boundedText(value, max = 300) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function money(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function warnings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 20).filter((item) => typeof item === "string" && /^[A-Z0-9_]{1,80}$/u.test(item)))];
}

function conflicts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    const field = isPlainObject(item) ? boundedText(item.field, 80) : null;
    return field && (TEXT_FIELDS.has(field) || MONEY_FIELDS.has(field))
      ? [{ field, requiresHumanReview: true }]
      : [];
  });
}

function fields(value) {
  if (!isPlainObject(value)) return null;
  const result = {};
  for (const key of [...TEXT_FIELDS, ...MONEY_FIELDS]) {
    if (TEXT_FIELDS.has(key)) result[key] = boundedText(value[key], key.includes("Name") ? 300 : 120);
    else result[key] = money(value[key]);
  }
  return Object.values(result).some((item) => item !== null) ? result : null;
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

export function createInvoiceAssistantAdapter({ runRepository = null, clock = () => new Date() } = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("invoice manifest is unavailable");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "ingest",
    document,
    recognition = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for invoice", "invalid_invoice_input");
    }
    const normalizedDocument = documentMetadata(document);
    const input = { taskType, document: normalizedDocument };
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
        input,
      });
      const replay = run.replayed ? restoreRun(run.item) : null;
      if (replay) return replay;
    }
    try {
      const normalizedFields = fields(recognition?.fields);
      const normalizedWarnings = warnings(recognition?.warnings);
      const normalizedConflicts = conflicts(recognition?.conflicts);
      const sourceRefs = [{ type: "invoice_document", id: normalizedDocument.sha256 }];
      const output = {
        schemaVersion: CONTRACT_VERSION,
        agentId: AGENT_ID,
        taskType,
        status: "review_required",
        document: normalizedDocument,
        recognition: {
          status: boundedText(recognition?.status, 60) ?? "review_required",
          fields: normalizedFields,
          conflicts: normalizedConflicts,
          warnings: normalizedWarnings,
          extractedTextPersisted: false,
          modelPayloadPersisted: false,
          ocrPayloadPersisted: false,
        },
        matchPreview: {
          candidates: [],
          autoMatched: false,
          note: "发票无需先匹配费用即可入库；正式匹配或替代无票必须由 owner-scoped 服务端流程和本人确认。",
        },
        facts: normalizedFields
          ? Object.entries(normalizedFields).flatMap(([key, value]) => value === null ? [] : [{ key, label: key, value, sourceRefs }])
          : [],
        inferences: [],
        unknowns: normalizedFields
          ? []
          : [{ key: "recognition", question: "请人工复核发票字段。", reason: "没有足够的结构化识别字段。" }],
        sourceRefs,
        writebackPreview: {
          requiresHumanConfirmation: true,
          allowed: false,
          actions: [],
          note: "本 Agent 只生成识别预览；原件入库由现有原子写入处理，匹配、替代无票确认和删除必须本人确认。",
        },
        writebackAllowed: false,
      };
      if (runRepository && run?.item) {
        run = runRepository.complete(run.item.id, {
          owner: normalizedOwner,
          output,
          source: "deterministic",
          sourceRefs,
          confirmationStatus: "preview",
        });
      }
      return { ...output, runId: run?.item?.id ?? null, inputSnapshotHash: run?.item?.inputSnapshotHash ?? null };
    } catch (error) {
      if (runRepository && run?.item) {
        try { runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "INVOICE_ADAPTER_FAILED" }); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, recognize: analyze, restore: restoreRun });
}

export { restoreRun as restoreInvoiceRun };
