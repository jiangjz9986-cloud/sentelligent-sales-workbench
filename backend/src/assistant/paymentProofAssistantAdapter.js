import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "payment-proof";
const CONTRACT_VERSION = "payment-proof-v1";
const TASK_TYPES = new Set(["ingest", "recognize", "candidate_match", "review"]);
const PAYMENT_METHODS = new Set(["wechat", "alipay", "bank_card", "cash", "other"]);
const CONFLICT_FIELDS = new Set(["amountCents", "occurredOn", "paidTime"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new AssistantContractError(`${name} is required`, "invalid_payment_proof_input");
  const normalized = value.trim();
  if (normalized.length > max) throw new AssistantContractError(`${name} is too long`, "invalid_payment_proof_input");
  return normalized;
}

function documentMetadata(value) {
  if (!isPlainObject(value)) throw new AssistantContractError("document is required", "invalid_payment_proof_input");
  const mediaType = text(value.mediaType, "document.mediaType", 100).toLowerCase();
  const sha256 = text(value.sha256, "document.sha256", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new AssistantContractError("document.sha256 is invalid", "invalid_payment_proof_input");
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 12 * 1024 * 1024) {
    throw new AssistantContractError("document.sizeBytes is invalid", "invalid_payment_proof_input");
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
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function date(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}

function time(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value) ? value : null;
}

function warnings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 20).filter((item) => typeof item === "string" && /^[A-Z0-9_]{1,80}$/u.test(item)))];
}

function conflicts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => isPlainObject(item) && CONFLICT_FIELDS.has(item.field)
    ? [{ field: item.field, requiresHumanReview: true }]
    : []);
}

function evidence(value) {
  if (!isPlainObject(value)) return null;
  const paymentMethod = PAYMENT_METHODS.has(value.paymentMethod) ? value.paymentMethod : null;
  const normalized = {
    amountCents: money(value.amountCents),
    occurredOn: date(value.occurredOn),
    paidTime: time(value.paidTime),
    merchant: boundedText(value.merchant, 300),
    paymentMethod,
  };
  return Object.values(normalized).some((item) => item !== null) ? normalized : null;
}

function confidence(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

export function createPaymentProofAssistantAdapter({ runRepository = null, clock = () => new Date() } = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("payment-proof manifest is unavailable");
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
      throw new AssistantContractError("taskType is not registered for payment-proof", "invalid_payment_proof_input");
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
      const normalizedWarnings = warnings(recognition?.warnings);
      const normalizedConflicts = conflicts(recognition?.conflicts);
      const normalizedEvidence = evidence(recognition?.evidence);
      const candidateCount = Array.isArray(recognition?.candidates) ? Math.min(recognition.candidates.length, 10) : 0;
      const sourceRefs = [{ type: "payment_proof_document", id: normalizedDocument.sha256 }];
      const output = {
        schemaVersion: CONTRACT_VERSION,
        agentId: AGENT_ID,
        taskType,
        status: "review_required",
        document: normalizedDocument,
        recognition: {
          evidence: normalizedEvidence,
          confidence: confidence(recognition?.confidence),
          conflicts: normalizedConflicts,
          warnings: normalizedWarnings,
          extractedTextPersisted: false,
        },
        candidateMatch: {
          candidateCount,
          candidates: [],
          validated: false,
          note: "识别器候选不会被 Agent 直接信任；正式关联必须由 owner-scoped 服务端查询和本人确认。",
        },
        facts: normalizedEvidence
          ? Object.entries(normalizedEvidence).flatMap(([key, value]) => value === null ? [] : [{ key, label: key, value, sourceRefs }])
          : [],
        inferences: [],
        unknowns: normalizedEvidence
          ? []
          : [{ key: "recognition", question: "请人工核对付款凭证。", reason: "没有足够的结构化识别证据。" }],
        sourceRefs,
        writebackPreview: {
          requiresHumanConfirmation: true,
          allowed: false,
          actions: [],
          note: "本 Agent 只生成识别预览；入待处理区由现有原子写入处理，正式关联、拒绝或删除必须本人确认。",
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
        try { runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "PAYMENT_PROOF_ADAPTER_FAILED" }); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, recognize: analyze, restore: restoreRun });
}

export { restoreRun as restorePaymentProofRun };
