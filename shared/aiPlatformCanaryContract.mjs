import {
  AI_TASK_SCHEMA_VERSION,
  AI_TARGET_MODEL,
  AI_TARGET_REASONING_EFFORT,
} from "./aiPlatformContract.mjs";

export const AI_PROVIDER_CANARY_TASK_TYPE = "quick-record.analyze";
export const AI_PROVIDER_CANARY_OWNER = "p2-acceptance";
export const AI_PROVIDER_CANARY_ACTOR = "p2-acceptance";
export const AI_PROVIDER_CANARY_ISSUER = "sentelligent-ai-platform";
export const AI_PROVIDER_CANARY_FEATURE = "p2-acceptance";
export const AI_PROVIDER_CANARY_CHANNEL = "system";
export const AI_PROVIDER_CANARY_SUBJECT_TYPE = "p2_acceptance";
export const AI_PROVIDER_CANARY_MAX_SAMPLES = 10;
export const AI_PROVIDER_CANARY_MAX_OUTPUT_TOKENS = 256;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;

function assertRunId(value) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError("provider canary runId is invalid");
  }
  return value;
}

function assertSampleIndex(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > AI_PROVIDER_CANARY_MAX_SAMPLES) {
    throw new TypeError("provider canary sampleIndex is invalid");
  }
  return value;
}

export function providerCanarySampleId(sampleIndex) {
  return `sample-${String(assertSampleIndex(sampleIndex)).padStart(3, "0")}`;
}

export function providerCanaryIdempotencyKey(runId, sampleIndex) {
  return `p2-acceptance:${assertRunId(runId)}:sample:${assertSampleIndex(sampleIndex)}`;
}

export function createProviderCanaryInput(runId, sampleIndex) {
  const normalizedRunId = assertRunId(runId);
  const normalizedSampleIndex = assertSampleIndex(sampleIndex);
  const sampleId = providerCanarySampleId(normalizedSampleIndex);
  const message = JSON.stringify({
    sampleId,
    runId: normalizedRunId,
    text: `Synthetic P2 acceptance sample ${normalizedSampleIndex}.`,
    output: "json-only",
  });
  return Object.freeze({
    protocol: "chat.completions.v1",
    model: AI_TARGET_MODEL,
    reasoningEffort: AI_TARGET_REASONING_EFFORT,
    request: Object.freeze({
      model: AI_TARGET_MODEL,
      messages: Object.freeze([{ role: "user", content: message }]),
      max_tokens: AI_PROVIDER_CANARY_MAX_OUTPUT_TOKENS,
    }),
  });
}

export function createProviderCanaryTaskRequest(runId, sampleIndex) {
  const normalizedRunId = assertRunId(runId);
  const normalizedSampleIndex = assertSampleIndex(sampleIndex);
  return Object.freeze({
    schemaVersion: AI_TASK_SCHEMA_VERSION,
    taskType: AI_PROVIDER_CANARY_TASK_TYPE,
    feature: AI_PROVIDER_CANARY_FEATURE,
    channel: AI_PROVIDER_CANARY_CHANNEL,
    priority: "interactive",
    subject: Object.freeze({ type: AI_PROVIDER_CANARY_SUBJECT_TYPE, id: normalizedRunId }),
    input: createProviderCanaryInput(normalizedRunId, normalizedSampleIndex),
  });
}

export function normalizeProviderCanaryCoordinates({ runId, sampleIndex } = {}) {
  return Object.freeze({
    runId: assertRunId(runId),
    sampleIndex: assertSampleIndex(sampleIndex),
  });
}

