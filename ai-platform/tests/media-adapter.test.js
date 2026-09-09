import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { mockProvider } from "../src/providers/mockProvider.js";
import {
  MEDIA_ADAPTER_LIMITS,
  MEDIA_TASK_TYPES,
  MediaAdapterError,
  executeMediaTask,
  isMediaTaskType,
  normalizeMediaTaskInput,
  simulateAsrTranscription,
  simulateMediaTask,
} from "../src/providers/mediaAdapter.js";

const DIGEST = "a".repeat(64);
const ORIGINAL_MEDIA_MARKER = "/private/synthetic/original-media.wav";

function audioMedia(overrides = {}) {
  return {
    mediaType: "audio/wav",
    byteLength: 1_024,
    sha256: DIGEST,
    durationMs: 1_000,
    purpose: "quick_record",
    language: "zh-CN",
    ...overrides,
  };
}

function documentMedia(overrides = {}) {
  return {
    mediaType: "image/png",
    byteLength: 2_048,
    sha256: DIGEST,
    pageCount: 1,
    ...overrides,
  };
}

function taskInput(media, simulation) {
  return {
    media,
    ...(simulation === undefined ? {} : { simulation }),
  };
}

function errorWithCode(code, status) {
  return (error) => error instanceof MediaAdapterError
    && error.code === code
    && error.status === status;
}

describe("AI platform media adapter", () => {
  afterEach(() => {
    // Keep the tests explicit about not starting a service or calling a vendor.
    assert.equal(typeof globalThis.fetch, "function");
  });

  it("simulates ASR, invoice, payment-proof, and bookkeeping tasks with stable bounded output", async () => {
    const asr = await simulateMediaTask({
      taskType: "asr.transcribe",
      input: taskInput(audioMedia(), { fixture: "asr-demo" }),
    });
    assert.deepEqual(asr.payload, {
      text: "本地模拟语音转写结果",
      language: "zh-CN",
      durationMs: 1_000,
      source: "local-simulated",
    });
    assert.deepEqual(asr.media, {
      mediaType: "audio/wav",
      byteLength: 1_024,
      durationMs: 1_000,
      sha256: DIGEST,
    });
    assert.deepEqual(asr.usage, { audioSeconds: 1, imagePages: 0 });

    const invoice = await simulateMediaTask({
      taskType: "invoice.recognize",
      input: taskInput(documentMedia(), { fixture: "invoice-demo" }),
    });
    assert.equal(invoice.payload.status, "unmatched");
    assert.equal(invoice.payload.fields.totalCents, 10_000);
    assert.deepEqual(invoice.usage, { audioSeconds: 0, imagePages: 1 });

    const paymentProof = await simulateMediaTask({
      taskType: "payment-proof.recognize",
      input: {
        ...taskInput(documentMedia({ mediaType: "image/jpeg" }), { fixture: "payment-proof-demo" }),
        referenceDate: "2026-09-08",
      },
    });
    assert.equal(paymentProof.payload.documentKind, "payment_proof");
    assert.equal(paymentProof.payload.evidence.occurredOn, "2026-09-08");
    assert.equal(paymentProof.payload.evidence.amountCents, 200);

    const bookkeeping = await simulateMediaTask({
      taskType: "bookkeeping.extract",
      input: {
        ...taskInput(documentMedia({ mediaType: "image/jpeg" }), { fixture: "bookkeeping-demo" }),
        referenceDate: "2026-09-08",
      },
    });
    assert.equal(bookkeeping.payload.status, "review_required");
    assert.equal(bookkeeping.payload.candidates.length, 1);
    assert.deepEqual(bookkeeping.payload.candidates[0].expense, {
      occurredOn: "2026-09-08",
      amountCents: 1_280,
      reimbursementCents: 1_280,
      purpose: "商务用餐",
      merchant: "本地模拟商户",
      paidAt: "2026-09-08T12:18:00+08:00",
      fundingSource: "personal",
      paymentMethod: "wechat",
    });
    assert.deepEqual(bookkeeping.usage, { audioSeconds: 0, imagePages: 1 });
  });

  it("registers all four media task types and does not let them use the generic mock path", async () => {
    assert.deepEqual(MEDIA_TASK_TYPES, [
      "asr.transcribe",
      "invoice.recognize",
      "payment-proof.recognize",
      "bookkeeping.extract",
    ]);
    for (const taskType of MEDIA_TASK_TYPES) assert.equal(isMediaTaskType(taskType), true);

    const output = await mockProvider.execute({
      task: {
        id: "task-bookkeeping-1",
        taskType: "bookkeeping.extract",
        feature: "bookkeeping",
        input: {
          ...taskInput(documentMedia(), { fixture: "bookkeeping-demo" }),
          referenceDate: "2026-09-08",
        },
      },
      agent: { versionId: "agent-bookkeeping-v1" },
      model: { name: "gpt-5.6-luna", providerId: "provider-mock" },
      signal: new AbortController().signal,
    });

    assert.equal(output.externalRequestId, "local-media-task-bookkeeping-1");
    assert.equal(output.result.metadata.executionMode, "local-simulated");
    assert.equal(output.result.metadata.compatibility.status, "review_required");
    assert.equal(output.result.metadata.compatibility.candidates[0].expense.amountCents, 1_280);
    assert.equal(output.result.facts.some((fact) => fact.key === "input_summary"), false);
  });

  it("routes media tasks through mockProvider and keeps the standard result contract", async () => {
    const output = await mockProvider.execute({
      task: {
        id: "task-media-1",
        taskType: "invoice.recognize",
        feature: "invoice",
        input: taskInput(documentMedia(), { fixture: "invoice-demo" }),
      },
      agent: { versionId: "agent-v1" },
      model: { name: "gpt-5.6-luna", providerId: "provider-mock" },
      signal: new AbortController().signal,
    });

    assert.equal(output.externalRequestId, "local-media-task-media-1");
    assert.equal(output.result.schemaVersion, "ai-task-result-v1");
    assert.equal(output.result.source, "deterministic");
    assert.equal(output.result.metadata.executionMode, "local-simulated");
    assert.equal(output.result.metadata.compatibility.fields.totalCents, 10_000);
    assert.deepEqual(output.usage, {
      inputTokens: output.usage.inputTokens,
      outputTokens: 120,
      cachedInputTokens: 0,
      audioSeconds: 0,
      imagePages: 1,
    });
  });

  it("enforces media type, size, duration, page, and digest boundaries", () => {
    assert.doesNotThrow(() => normalizeMediaTaskInput("asr.transcribe", {
      media: audioMedia({ byteLength: MEDIA_ADAPTER_LIMITS.audioMaxBytes }),
    }));
    assert.throws(
      () => normalizeMediaTaskInput("asr.transcribe", {
        media: audioMedia({ byteLength: MEDIA_ADAPTER_LIMITS.audioMaxBytes + 1 }),
      }),
      errorWithCode("MEDIA_TOO_LARGE", 413),
    );
    assert.throws(
      () => normalizeMediaTaskInput("asr.transcribe", {
        media: audioMedia({ durationMs: MEDIA_ADAPTER_LIMITS.audioMinDurationMs - 1 }),
      }),
      errorWithCode("MEDIA_TOO_SHORT", 422),
    );
    assert.doesNotThrow(() => normalizeMediaTaskInput("asr.transcribe", {
      media: audioMedia({ durationMs: MEDIA_ADAPTER_LIMITS.audioPurposeMaxDurationMs.quick_record }),
    }));
    assert.throws(
      () => normalizeMediaTaskInput("asr.transcribe", {
        media: audioMedia({ durationMs: MEDIA_ADAPTER_LIMITS.audioPurposeMaxDurationMs.quick_record + 1 }),
      }),
      errorWithCode("MEDIA_TOO_LONG", 422),
    );
    assert.doesNotThrow(() => normalizeMediaTaskInput("asr.transcribe", {
      media: audioMedia({
        durationMs: MEDIA_ADAPTER_LIMITS.audioPurposeMaxDurationMs.assistant_chat,
        purpose: "assistant_chat",
      }),
    }));
    assert.throws(
      () => normalizeMediaTaskInput("asr.transcribe", {
        media: audioMedia({ purpose: "assistant_chat", durationMs: 60_001 }),
      }),
      errorWithCode("MEDIA_TOO_LONG", 422),
    );

    assert.doesNotThrow(() => normalizeMediaTaskInput("invoice.recognize", {
      media: documentMedia({ byteLength: MEDIA_ADAPTER_LIMITS.documentMaxBytes, pageCount: 4 }),
    }));
    assert.throws(
      () => normalizeMediaTaskInput("invoice.recognize", {
        media: documentMedia({ pageCount: MEDIA_ADAPTER_LIMITS.documentMaxPages + 1 }),
      }),
      errorWithCode("MEDIA_DESCRIPTOR_INVALID", 422),
    );
    assert.throws(
      () => normalizeMediaTaskInput("invoice.recognize", {
        media: documentMedia({ mediaType: "audio/wav" }),
      }),
      errorWithCode("MEDIA_TYPE_UNSUPPORTED", 415),
    );
    assert.throws(
      () => normalizeMediaTaskInput("invoice.recognize", {
        media: documentMedia({ sha256: "not-a-digest" }),
      }),
      errorWithCode("MEDIA_DESCRIPTOR_INVALID", 422),
    );
  });

  it("rejects raw media, path, URL, and unsupported descriptor fields before simulation", () => {
    for (const key of ["audioPath", "base64", "buffer", "bytes", "content", "data", "file", "filePath", "path", "raw", "uri", "url"]) {
      const value = key === "buffer" ? Buffer.from("synthetic") : ORIGINAL_MEDIA_MARKER;
      assert.throws(
        () => normalizeMediaTaskInput("asr.transcribe", {
          media: { ...audioMedia(), [key]: value },
        }),
        errorWithCode("MEDIA_RAW_PAYLOAD_FORBIDDEN", 422),
        key,
      );
    }
    assert.throws(
      () => normalizeMediaTaskInput("asr.transcribe", {
        audioPath: ORIGINAL_MEDIA_MARKER,
        media: audioMedia(),
      }),
      errorWithCode("MEDIA_RAW_PAYLOAD_FORBIDDEN", 422),
    );
    assert.throws(
      () => normalizeMediaTaskInput("invoice.recognize", {
        media: { ...documentMedia(), durationMs: 1_000 },
      }),
      errorWithCode("MEDIA_DESCRIPTOR_INVALID", 422),
    );
  });

  it("supports cancellation and removes the simulation abort listener", async () => {
    const controller = new AbortController();
    const { signal } = controller;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    let addCalls = 0;
    let removeCalls = 0;
    signal.addEventListener = (...args) => {
      if (args[0] === "abort") addCalls += 1;
      return originalAdd(...args);
    };
    signal.removeEventListener = (...args) => {
      if (args[0] === "abort") removeCalls += 1;
      return originalRemove(...args);
    };

    try {
      const pending = simulateMediaTask({
        taskType: "asr.transcribe",
        input: taskInput(audioMedia(), { delayMs: 50 }),
        signal,
      });
      setTimeout(() => controller.abort(new DOMException("synthetic cancel", "AbortError")), 5);
      await assert.rejects(pending, errorWithCode("MEDIA_CANCELLED", 499));
      assert.equal(addCalls, 1);
      assert.equal(removeCalls, 1);
    } finally {
      signal.addEventListener = originalAdd;
      signal.removeEventListener = originalRemove;
    }
  });

  it("creates a safe synthetic ASR descriptor without retaining audioPath", async () => {
    const result = await simulateAsrTranscription({
      audioPath: ORIGINAL_MEDIA_MARKER,
      mediaType: "audio/wav",
      durationMs: 1_000,
      purpose: "quick_record",
      language: "zh-CN",
      simulation: { transcript: "安全的本地转写" },
    });
    assert.equal(result.text, "安全的本地转写");
    assert.equal(result.media.byteLength, 1);
    assert.match(result.media.sha256, /^[0-9a-f]{64}$/u);
    assert.doesNotMatch(JSON.stringify(result), /original-media|audioPath|base64|filePath|https?:/u);
  });

  it("does not retain raw media markers in the standard result metadata", async () => {
    const output = await executeMediaTask({
      task: {
        id: "task-media-2",
        taskType: "asr.transcribe",
        input: taskInput(audioMedia(), { transcript: "本地结果" }),
      },
      model: { name: "gpt-5.6-luna" },
      signal: new AbortController().signal,
    });
    const serialized = JSON.stringify(output);
    assert.doesNotMatch(serialized, /original-media|audioPath|base64|filePath|https?:/u);
    assert.equal(output.result.metadata.compatibility.text, "本地结果");
  });
});
