import {
  AI_TASK_RESULT_SCHEMA_VERSION,
  isPlainObject,
  sha256,
  stableJson,
} from "../../../shared/aiPlatformContract.mjs";

export const MEDIA_TASK_TYPES = Object.freeze([
  "asr.transcribe",
  "invoice.recognize",
  "payment-proof.recognize",
  "bookkeeping.extract",
]);

export const MEDIA_ADAPTER_LIMITS = Object.freeze({
  audioMaxBytes: 8_388_608,
  audioMinDurationMs: 300,
  audioPurposeMaxDurationMs: Object.freeze({
    quick_record: 120_000,
    assistant_chat: 60_000,
  }),
  documentMaxBytes: 12 * 1024 * 1024,
  documentMaxPages: 4,
  descriptorMaxBytes: 16 * 1024,
  simulationMaxDelayMs: 10_000,
  simulationTranscriptMaxChars: 2_000,
});

const AUDIO_MEDIA_TYPES = new Set(["audio/wav"]);
const DOCUMENT_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const ASR_PURPOSES = new Set(Object.keys(MEDIA_ADAPTER_LIMITS.audioPurposeMaxDurationMs));
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const RAW_MEDIA_KEYS = new Set([
  "audioPath",
  "base64",
  "buffer",
  "bytes",
  "content",
  "data",
  "file",
  "filePath",
  "path",
  "raw",
  "uri",
  "url",
]);

const AUDIO_MEDIA_DESCRIPTOR_KEYS = new Set([
  "byteLength",
  "durationMs",
  "language",
  "mediaType",
  "purpose",
  "sha256",
]);
const DOCUMENT_MEDIA_DESCRIPTOR_KEYS = new Set([
  "byteLength",
  "mediaType",
  "pageCount",
  "sha256",
]);

const SIMULATION_KEYS = new Set(["delayMs", "fixture", "transcript"]);
const SIMULATION_FIXTURES = Object.freeze({
  asr: new Set(["asr-demo"]),
  invoice: new Set(["invoice-demo"]),
  paymentProof: new Set(["payment-proof-demo"]),
  bookkeeping: new Set(["bookkeeping-demo"]),
});

const INVOICE_EMPTY_FIELDS = Object.freeze({
  invoiceCode: null,
  invoiceNumber: null,
  issuedOn: null,
  sellerName: null,
  buyerName: null,
  amountExTaxCents: null,
  taxCents: null,
  totalCents: null,
  suggestedCategory: null,
});

const PAYMENT_EMPTY_EVIDENCE = Object.freeze({
  amountCents: null,
  occurredOn: null,
  occurredOnYearExplicit: false,
  paidTime: null,
  merchant: null,
  paymentMethod: null,
});

const DEFAULT_SIMULATION_MODEL = "gpt-5.6-luna";
const DEFAULT_SIMULATION_REASONING_EFFORT = "max";

export class MediaAdapterError extends Error {
  constructor(code, status, message, details = null) {
    super(message);
    this.name = "MediaAdapterError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

function mediaError(code, status, message, details = null) {
  return new MediaAdapterError(code, status, message, details);
}

function fail(code, status, message, details = null) {
  throw mediaError(code, status, message, details);
}

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  throw mediaError("MEDIA_CANCELLED", 499, "media task was cancelled");
}

function safeText(value, name, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || SAFE_TEXT_PATTERN.test(value)) {
    fail("MEDIA_DESCRIPTOR_INVALID", 422, `${name} is invalid`);
  }
  return value;
}

function boundedPositiveInteger(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail("MEDIA_DESCRIPTOR_INVALID", 422, `${name} is invalid`);
  }
  return value;
}

function boundedNonNegativeInteger(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    fail("MEDIA_DESCRIPTOR_INVALID", 422, `${name} is invalid`);
  }
  return value;
}

function mediaByteLength(value, max) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("MEDIA_DESCRIPTOR_INVALID", 422, "media.byteLength is invalid");
  }
  if (value > max) {
    fail("MEDIA_TOO_LARGE", 413, "media exceeds the size limit");
  }
  return value;
}

function ensureNoRawMedia(value, path = "input", seen = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    fail("MEDIA_RAW_PAYLOAD_FORBIDDEN", 422, "raw media payloads are not accepted by the AI platform");
  }
  if (seen.has(value)) fail("MEDIA_DESCRIPTOR_INVALID", 422, `${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => ensureNoRawMedia(item, `${path}[${index}]`, seen));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (RAW_MEDIA_KEYS.has(key)) {
        fail("MEDIA_RAW_PAYLOAD_FORBIDDEN", 422, `${path}.${key} is not accepted`);
      }
      ensureNoRawMedia(child, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function assertAllowedKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("MEDIA_DESCRIPTOR_INVALID", 422, `${name}.${key} is not supported`);
  }
}

function assertMediaDescriptorKeys(taskType, media) {
  assertAllowedKeys(
    media,
    taskType === "asr.transcribe" ? AUDIO_MEDIA_DESCRIPTOR_KEYS : DOCUMENT_MEDIA_DESCRIPTOR_KEYS,
    "media",
  );
}

function canonicalMediaType(value) {
  if (typeof value !== "string") fail("MEDIA_TYPE_UNSUPPORTED", 415, "media type is unsupported");
  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  if (!AUDIO_MEDIA_TYPES.has(normalized) && !DOCUMENT_MEDIA_TYPES.has(normalized)) {
    fail("MEDIA_TYPE_UNSUPPORTED", 415, "media type is unsupported");
  }
  return normalized;
}

function canonicalDigest(value) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail("MEDIA_DESCRIPTOR_INVALID", 422, "media sha256 is invalid");
  }
  return value;
}

function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    fail("MEDIA_DESCRIPTOR_INVALID", 422, "referenceDate is invalid");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail("MEDIA_DESCRIPTOR_INVALID", 422, "referenceDate is invalid");
  }
  return value;
}

function normalizeSimulation(value, kind) {
  if (value === undefined || value === null) return Object.freeze({});
  if (!isPlainObject(value)) fail("MEDIA_DESCRIPTOR_INVALID", 422, "simulation must be an object");
  assertAllowedKeys(value, SIMULATION_KEYS, "simulation");
  const normalized = {};
  if (value.delayMs !== undefined) {
    normalized.delayMs = boundedNonNegativeInteger(
      value.delayMs,
      "simulation.delayMs",
      MEDIA_ADAPTER_LIMITS.simulationMaxDelayMs,
    );
  }
  if (value.fixture !== undefined) {
    const fixture = safeText(value.fixture, "simulation.fixture", 80);
    const allowed = SIMULATION_FIXTURES[kind];
    if (!allowed?.has(fixture)) fail("MEDIA_DESCRIPTOR_INVALID", 422, "simulation.fixture is unsupported");
    normalized.fixture = fixture;
  }
  if (value.transcript !== undefined) {
    if (kind !== "asr") fail("MEDIA_DESCRIPTOR_INVALID", 422, "simulation.transcript is only valid for ASR");
    normalized.transcript = safeText(
      value.transcript,
      "simulation.transcript",
      MEDIA_ADAPTER_LIMITS.simulationTranscriptMaxChars,
    ).trim();
    if (!normalized.transcript) fail("MEDIA_DESCRIPTOR_INVALID", 422, "simulation.transcript is empty");
  }
  return Object.freeze(normalized);
}

function normalizeMediaDescriptor(taskType, media) {
  if (!isPlainObject(media)) fail("MEDIA_DESCRIPTOR_INVALID", 422, "media descriptor is required");
  assertMediaDescriptorKeys(taskType, media);
  const mediaType = canonicalMediaType(media.mediaType);
  const digest = canonicalDigest(media.sha256);
  const byteLimit = taskType === "asr.transcribe"
    ? MEDIA_ADAPTER_LIMITS.audioMaxBytes
    : MEDIA_ADAPTER_LIMITS.documentMaxBytes;
  const byteLength = mediaByteLength(media.byteLength, byteLimit);

  if (taskType === "asr.transcribe") {
    if (!AUDIO_MEDIA_TYPES.has(mediaType)) {
      fail("MEDIA_TYPE_UNSUPPORTED", 415, "ASR requires normalized audio/wav");
    }
    const purpose = safeText(media.purpose, "media.purpose", 40);
    if (!ASR_PURPOSES.has(purpose)) fail("MEDIA_DESCRIPTOR_INVALID", 422, "media.purpose is invalid");
    if (!Number.isSafeInteger(media.durationMs) || media.durationMs < 1) {
      fail("MEDIA_DESCRIPTOR_INVALID", 422, "media.durationMs is invalid");
    }
    const durationLimit = MEDIA_ADAPTER_LIMITS.audioPurposeMaxDurationMs[purpose];
    if (media.durationMs > durationLimit) {
      fail("MEDIA_TOO_LONG", 422, "audio is too long");
    }
    const durationMs = media.durationMs;
    if (durationMs < MEDIA_ADAPTER_LIMITS.audioMinDurationMs) {
      fail("MEDIA_TOO_SHORT", 422, "audio is too short");
    }
    const language = safeText(media.language, "media.language", 20);
    if (language !== "zh-CN") fail("MEDIA_DESCRIPTOR_INVALID", 422, "media.language is invalid");
    return Object.freeze({
      mediaType,
      byteLength,
      sha256: digest,
      durationMs,
      purpose,
      language,
    });
  }

  if (!DOCUMENT_MEDIA_TYPES.has(mediaType)) {
    fail("MEDIA_TYPE_UNSUPPORTED", 415, "document media type is unsupported");
  }
  const pageCount = media.pageCount === undefined
    ? 1
    : boundedPositiveInteger(media.pageCount, "media.pageCount", MEDIA_ADAPTER_LIMITS.documentMaxPages);
  return Object.freeze({
    mediaType,
    byteLength,
    sha256: digest,
    pageCount,
  });
}

export function normalizeMediaTaskInput(taskType, input, { allowSyntheticDescriptor = false } = {}) {
  if (!MEDIA_TASK_TYPES.includes(taskType)) {
    throw new TypeError("media task type is not registered");
  }
  ensureNoRawMedia(input);
  if (!isPlainObject(input)) fail("MEDIA_DESCRIPTOR_INVALID", 422, "media task input must be an object");
  const allowedInputKeys = new Set(["media", "referenceDate", "simulation"]);
  assertAllowedKeys(input, allowedInputKeys, "input");

  let encodedInput;
  try {
    encodedInput = stableJson(input);
  } catch {
    fail("MEDIA_DESCRIPTOR_INVALID", 422, "media task input is not JSON data");
  }
  if (Buffer.byteLength(encodedInput, "utf8") > MEDIA_ADAPTER_LIMITS.descriptorMaxBytes) {
    fail("MEDIA_DESCRIPTOR_TOO_LARGE", 413, "media task descriptor is too large");
  }

  let media = input.media;
  if (isPlainObject(media)) assertMediaDescriptorKeys(taskType, media);
  if (allowSyntheticDescriptor && (!isPlainObject(media) || media.byteLength === undefined || media.sha256 === undefined)) {
    if (!isPlainObject(media)) media = {};
    const base = {
      mediaType: media.mediaType,
      byteLength: media.byteLength ?? 1,
      sha256: media.sha256 ?? sha256({
        mediaType: media.mediaType ?? null,
        durationMs: media.durationMs ?? null,
        purpose: media.purpose ?? null,
        language: media.language ?? null,
      }),
      ...(media.durationMs === undefined ? {} : { durationMs: media.durationMs }),
      ...(media.purpose === undefined ? {} : { purpose: media.purpose }),
      ...(media.language === undefined ? {} : { language: media.language }),
      ...(media.pageCount === undefined ? {} : { pageCount: media.pageCount }),
    };
    media = base;
  }

  const normalizedMedia = normalizeMediaDescriptor(taskType, media);
  const kind = taskType === "asr.transcribe"
    ? "asr"
    : taskType === "invoice.recognize"
      ? "invoice"
      : taskType === "payment-proof.recognize" ? "paymentProof" : "bookkeeping";
  return Object.freeze({
    media: normalizedMedia,
    referenceDate: taskType === "payment-proof.recognize" || taskType === "bookkeeping.extract"
      ? validDate(input.referenceDate)
      : null,
    simulation: normalizeSimulation(input.simulation, kind),
  });
}

function waitForSimulation(delayMs, signal) {
  if (!delayMs) {
    assertNotAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, mediaError("MEDIA_CANCELLED", 499, "media task was cancelled"));
    const timer = setTimeout(() => finish(resolve), delayMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function redactedMediaDescriptor(media) {
  return Object.freeze({
    mediaType: media.mediaType,
    byteLength: media.byteLength,
    ...(media.durationMs === undefined ? {} : { durationMs: media.durationMs }),
    ...(media.pageCount === undefined ? {} : { pageCount: media.pageCount }),
    sha256: media.sha256,
  });
}

function defaultAsrText(simulation) {
  if (simulation.transcript) return simulation.transcript;
  if (simulation.fixture === "asr-demo") return "本地模拟语音转写结果";
  return "本地模拟语音转写结果";
}

function invoicePayload(simulation) {
  if (simulation.fixture === "invoice-demo") {
    return {
      fields: {
        invoiceCode: "044002100111",
        invoiceNumber: "12345678",
        issuedOn: "2026-08-04",
        sellerName: "本地模拟商户",
        buyerName: "森特公司",
        amountExTaxCents: 9434,
        taxCents: 566,
        totalCents: 10000,
        suggestedCategory: "lodging",
      },
      warnings: [],
      status: "unmatched",
    };
  }
  return {
    fields: { ...INVOICE_EMPTY_FIELDS },
    warnings: ["LOCAL_SIMULATION_REVIEW_REQUIRED"],
    status: "review_required",
  };
}

function paymentProofPayload(simulation, referenceDate) {
  if (simulation.fixture === "payment-proof-demo") {
    return {
      documentKind: "payment_proof",
      evidence: {
        amountCents: 200,
        occurredOn: referenceDate ?? "2026-08-25",
        occurredOnYearExplicit: Boolean(referenceDate),
        paidTime: "14:23",
        merchant: "本地模拟商户",
        paymentMethod: "wechat",
      },
      transactions: [],
      confidence: 0.5,
      warnings: [],
    };
  }
  return {
    documentKind: "payment_proof",
    evidence: { ...PAYMENT_EMPTY_EVIDENCE },
    transactions: [],
    confidence: null,
    warnings: ["LOCAL_SIMULATION_REVIEW_REQUIRED"],
  };
}

function bookkeepingPayload(simulation, referenceDate) {
  const source = { provider: "local-simulated", model: DEFAULT_SIMULATION_MODEL };
  if (simulation.fixture === "bookkeeping-demo") {
    const occurredOn = referenceDate ?? "2026-09-08";
    return {
      status: "review_required",
      candidates: [{
        index: 0,
        status: "review_required",
        confidence: 0.5,
        category: "餐饮",
        subcategory: "午餐",
        note: null,
        noteAutomation: {
          kind: "meal",
          tripRegion: null,
          tripRegionSource: null,
          paidTime: "12:18",
        },
        categoryAutomation: {
          kind: "contextual",
          sourceCategory: null,
          sourceSubcategory: null,
        },
        expense: {
          occurredOn,
          amountCents: 1_280,
          reimbursementCents: 1_280,
          purpose: "商务用餐",
          merchant: "本地模拟商户",
          paidAt: `${occurredOn}T12:18:00+08:00`,
          fundingSource: "personal",
          paymentMethod: "wechat",
        },
        warnings: ["WEIXIN_CONFIRMATION_REQUIRED"],
        source,
      }],
      warnings: [],
      source,
    };
  }
  return {
    status: "review_required",
    candidates: [],
    warnings: ["LOCAL_SIMULATION_REVIEW_REQUIRED"],
    source,
  };
}

export async function simulateMediaTask({ taskType, input, signal, allowSyntheticDescriptor = false } = {}) {
  assertNotAborted(signal);
  const normalized = normalizeMediaTaskInput(taskType, input, { allowSyntheticDescriptor });
  await waitForSimulation(normalized.simulation.delayMs ?? 0, signal);
  assertNotAborted(signal);
  if (taskType === "asr.transcribe") {
    return Object.freeze({
      taskType,
      media: redactedMediaDescriptor(normalized.media),
      payload: Object.freeze({
        text: defaultAsrText(normalized.simulation),
        language: normalized.media.language,
        durationMs: normalized.media.durationMs,
        source: "local-simulated",
      }),
      usage: Object.freeze({
        audioSeconds: Math.max(1, Math.ceil(normalized.media.durationMs / 1_000)),
        imagePages: 0,
      }),
    });
  }
  const payload = taskType === "invoice.recognize"
    ? invoicePayload(normalized.simulation)
    : taskType === "payment-proof.recognize"
      ? paymentProofPayload(normalized.simulation, normalized.referenceDate)
      : bookkeepingPayload(normalized.simulation, normalized.referenceDate);
  return Object.freeze({
    taskType,
    media: redactedMediaDescriptor(normalized.media),
    payload: Object.freeze(payload),
    usage: Object.freeze({
      audioSeconds: 0,
      imagePages: normalized.media.pageCount ?? 1,
    }),
  });
}

export async function simulateAsrTranscription(input = {}, options = {}) {
  const taskInput = {
    media: {
      mediaType: input.mediaType,
      byteLength: input.byteLength,
      sha256: input.sha256 ?? input.audioSha256,
      durationMs: input.durationMs,
      purpose: input.purpose,
      language: input.language,
    },
    ...(input.simulation === undefined ? {} : { simulation: input.simulation }),
  };
  const result = await simulateMediaTask({
    taskType: "asr.transcribe",
    input: taskInput,
    signal: options.signal ?? input.signal,
    allowSyntheticDescriptor: true,
  }).catch((error) => {
    if (error instanceof MediaAdapterError) throw error;
    throw mediaError("MEDIA_PROVIDER_ERROR", 502, "local media simulation failed");
  });
  return Object.freeze({
    text: result.payload.text,
    language: result.payload.language,
    durationMs: result.payload.durationMs,
    source: result.payload.source,
    media: result.media,
    usage: result.usage,
  });
}

function standardMediaResult(task, model, simulated) {
  const media = simulated.media;
  const payload = simulated.payload;
  const mediaSummary = stableJson(media);
  const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(mediaSummary, "utf8") / 4));
  return {
    externalRequestId: `local-media-${task.id}`,
    result: {
      schemaVersion: AI_TASK_RESULT_SCHEMA_VERSION,
      status: "success",
      source: "deterministic",
      facts: [
        { key: "media_task_type", value: task.taskType, confidence: 100 },
        { key: "media_type", value: media.mediaType, confidence: 100 },
        { key: "media_bytes", value: media.byteLength, confidence: 100 },
        { key: "media_sha256", value: media.sha256, confidence: 100 },
      ],
      inferences: [],
      unknowns: ["当前媒体任务使用 local-simulated，不能代表真实视觉、票据、记账或 ASR 质量。"],
      suggestions: [{ title: "人工复核", text: "正式写回业务数据前必须由业务侧完成确认。" }],
      sourceRefs: [
        { type: "ai_task", id: task.id },
        { type: "media_digest", id: media.sha256 },
      ],
      writebackPreview: { requiresHumanConfirmation: true, actions: [] },
      metadata: {
        executionMode: "local-simulated",
        provider: "provider-mock",
        model: model?.name ?? DEFAULT_SIMULATION_MODEL,
        reasoningEffort: DEFAULT_SIMULATION_REASONING_EFFORT,
        media,
        compatibility: payload,
      },
    },
    usage: {
      inputTokens,
      outputTokens: 120,
      cachedInputTokens: 0,
      audioSeconds: simulated.usage.audioSeconds,
      imagePages: simulated.usage.imagePages,
    },
  };
}

export async function executeMediaTask({ task, model, signal } = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new TypeError("media task is required");
  }
  const simulated = await simulateMediaTask({
    taskType: task.taskType,
    input: task.input,
    signal,
  });
  return standardMediaResult(task, model, simulated);
}

export function isMediaTaskType(taskType) {
  return MEDIA_TASK_TYPES.includes(taskType);
}
