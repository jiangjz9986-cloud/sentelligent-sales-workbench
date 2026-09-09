import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aiPlatformStructuredTaskAvailability,
  mediaDescriptorFromFile,
  normalizeAiPlatformMediaInput,
  runAiPlatformMediaTask,
  runAiPlatformStructuredTask,
} from "./structuredAdapter.js";

const DIGEST = "a".repeat(64);

function runtimeStub({ result, configured = true, calls = [] } = {}) {
  return {
    enabled: () => true,
    configured: () => configured,
    runStructuredTask: async (request) => {
      calls.push(request);
      return typeof result === "function" ? result(request) : result;
    },
  };
}

function standardResult(metadata = {}) {
  return {
    schemaVersion: "ai-task-result-v1",
    status: "succeeded",
    source: "mock",
    metadata,
  };
}

function asrMedia(overrides = {}) {
  return {
    mediaType: "audio/wav",
    byteLength: 12_345,
    durationMs: 1_000,
    purpose: "quick_record",
    language: "zh-CN",
    sha256: DIGEST,
    ...overrides,
  };
}

function documentMedia(overrides = {}) {
  return {
    mediaType: "application/pdf",
    byteLength: 20_000,
    pageCount: 2,
    sha256: DIGEST,
    ...overrides,
  };
}

describe("AI platform structured adapter", () => {
  it("does not call a runtime when the integration is disabled", async () => {
    let calls = 0;
    await assert.rejects(
      runAiPlatformStructuredTask({
        config: { aiPlatformMode: "disabled" },
        options: {
          aiPlatformRuntime: {
            enabled: () => { calls += 1; return true; },
            configured: () => true,
            runStructuredTask: async () => { calls += 1; },
          },
        },
        taskType: "quick-record.analyze",
        feature: "quick_record_analysis",
        owner: "owner-a",
        input: { text: "内容" },
      }),
      (error) => error.code === "AI_PLATFORM_DISABLED",
    );
    assert.equal(calls, 0);
  });

  it("reports optional missing and required unavailable states without a legacy fallback", async () => {
    assert.equal(
      aiPlatformStructuredTaskAvailability({ aiPlatformMode: "optional" }),
      "missing",
    );
    assert.equal(
      aiPlatformStructuredTaskAvailability({ aiPlatformMode: "required" }),
      "unavailable",
    );

    for (const mode of ["optional", "required"]) {
      await assert.rejects(
        runAiPlatformStructuredTask({
          config: { aiPlatformMode: mode },
          taskType: "bookkeeping.extract",
          feature: "bookkeeping_text_analysis",
          owner: "owner-a",
          input: { text: "出差交通费" },
        }),
        (error) => error.code === "AI_PLATFORM_NOT_CONFIGURED",
      );
    }
  });

  it("passes server-owned identity separately from the task input", async () => {
    const calls = [];
    const config = {
      aiPlatformMode: "required",
      aiPlatformRuntime: runtimeStub({
        calls,
        result: { payload: { accepted: true } },
      }),
    };
    const payload = await runAiPlatformStructuredTask({
      config,
      taskType: "sales-decision.analyze",
      feature: "sales_decision",
      channel: "worker",
      owner: "owner-a",
      actor: "actor-a",
      subject: { type: "opportunity", id: "opportunity-a" },
      input: {
        rawContent: "客户希望在本季度完成评审",
        owner: "body-owner-must-not-become-identity",
        actor: "body-actor-must-not-become-identity",
      },
    });

    assert.deepEqual(payload, { accepted: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].owner, "owner-a");
    assert.equal(calls[0].actor, "actor-a");
    assert.deepEqual(calls[0].subject, { type: "opportunity", id: "opportunity-a" });
    assert.equal(calls[0].channel, "worker");
    assert.equal(calls[0].input.owner, "body-owner-must-not-become-identity");
    assert.equal(calls[0].input.actor, "body-actor-must-not-become-identity");
    assert.notEqual(calls[0].owner, calls[0].input.owner);
    assert.notEqual(calls[0].actor, calls[0].input.actor);
  });

  it("keeps idempotency and evidence stable for the same input and changes both with evidence", async () => {
    const firstCalls = [];
    const secondCalls = [];
    const makeConfig = (calls) => ({
      aiPlatformMode: "required",
      aiPlatformRuntime: runtimeStub({ calls, result: { payload: { ok: true } } }),
    });
    const base = {
      taskType: "payment-proof.recognize",
      feature: "payment_proof_recognition",
      owner: "owner-a",
      actor: "actor-a",
      subject: { type: "payment-proof", id: "proof-a" },
      input: { media: documentMedia(), referenceDate: "2026-09-08" },
    };

    await runAiPlatformStructuredTask({ ...base, config: makeConfig(firstCalls) });
    await runAiPlatformStructuredTask({ ...base, config: makeConfig(secondCalls) });
    assert.equal(firstCalls[0].idempotencyKey, secondCalls[0].idempotencyKey);
    assert.equal(firstCalls[0].evidenceDigest, secondCalls[0].evidenceDigest);

    const changedCalls = [];
    await runAiPlatformStructuredTask({
      ...base,
      config: makeConfig(changedCalls),
      input: { media: documentMedia({ byteLength: 20_001 }), referenceDate: "2026-09-08" },
    });
    assert.notEqual(firstCalls[0].idempotencyKey, changedCalls[0].idempotencyKey);
    assert.notEqual(firstCalls[0].evidenceDigest, changedCalls[0].evidenceDigest);
    assert.doesNotMatch(firstCalls[0].idempotencyKey, /2026|proof-a|owner-a/u);
  });

  it("unwraps standard metadata payloads, compatibility payloads, direct objects, and task envelopes", async () => {
    const cases = [
      [standardResult({ payload: { kind: "payload" } }), { kind: "payload" }],
      [standardResult({ compatibility: { kind: "compatibility" } }), { kind: "compatibility" }],
      [{ result: { kind: "direct" } }, { kind: "direct" }],
      [{ task: { taskId: "task-1" }, result: { kind: "envelope" } }, { kind: "envelope" }],
    ];

    for (const [result, expected] of cases) {
      const payload = await runAiPlatformStructuredTask({
        config: {
          aiPlatformMode: "required",
          aiPlatformRuntime: runtimeStub({ result }),
        },
        taskType: "invoice.recognize",
        feature: "invoice_recognition",
        owner: "owner-a",
        input: { media: documentMedia() },
      });
      assert.deepEqual(payload, expected);
    }
  });

  it("rejects raw media, encoded media, paths, and URLs before the runtime is called", async () => {
    const cases = [
      { media: Buffer.from("raw") },
      { base64: "aGVsbG8=" },
      { filePath: "/tmp/secret.wav" },
      { path: "/tmp/secret.wav" },
      { url: "https://example.invalid/media" },
    ];
    for (const input of cases) {
      let calls = 0;
      await assert.rejects(
        runAiPlatformStructuredTask({
          config: {
            aiPlatformMode: "required",
            aiPlatformRuntime: runtimeStub({
              result: { payload: { ok: true } },
              calls: { push: () => { calls += 1; } },
            }),
          },
          taskType: "asr.transcribe",
          feature: "asr",
          owner: "owner-a",
          input,
        }),
      );
      assert.equal(calls, 0);
    }
  });

  it("accepts only the bounded ASR descriptor contract", () => {
    const input = normalizeAiPlatformMediaInput("asr.transcribe", {
      media: asrMedia(),
    });
    assert.deepEqual(input, { media: asrMedia() });
    assert.deepEqual(Object.keys(input.media).sort(), [
      "byteLength",
      "durationMs",
      "language",
      "mediaType",
      "purpose",
      "sha256",
    ]);

    assert.throws(
      () => normalizeAiPlatformMediaInput("asr.transcribe", {
        media: asrMedia({ durationMs: 299 }),
      }),
      /durationMs is invalid/u,
    );
    assert.throws(
      () => normalizeAiPlatformMediaInput("asr.transcribe", {
        media: asrMedia({ purpose: "assistant_chat", durationMs: 60_001 }),
      }),
      /purpose or duration is invalid/u,
    );
    assert.throws(
      () => normalizeAiPlatformMediaInput("asr.transcribe", {
        media: asrMedia({ mediaType: "image/png" }),
      }),
      /ASR requires audio\/wav/u,
    );
    assert.throws(
      () => normalizeAiPlatformMediaInput("asr.transcribe", {
        media: { ...asrMedia(), path: "/tmp/audio.wav" },
      }),
      /not supported/u,
    );
  });

  it("accepts bounded document descriptors and rejects invalid page, size, and type values", () => {
    const input = normalizeAiPlatformMediaInput("invoice.recognize", {
      media: documentMedia(),
    });
    assert.deepEqual(input, { media: documentMedia() });

    assert.deepEqual(
      normalizeAiPlatformMediaInput("payment-proof.recognize", {
        media: documentMedia({ mediaType: "image/png", pageCount: undefined }),
        referenceDate: "2026-09-08",
      }),
      {
        media: {
          mediaType: "image/png",
          byteLength: 20_000,
          pageCount: 1,
          sha256: DIGEST,
        },
        referenceDate: "2026-09-08",
      },
    );
    assert.throws(
      () => normalizeAiPlatformMediaInput("invoice.recognize", {
        media: documentMedia({ pageCount: 5 }),
      }),
      /pageCount is invalid/u,
    );
    assert.throws(
      () => normalizeAiPlatformMediaInput("invoice.recognize", {
        media: documentMedia({ byteLength: 12 * 1024 * 1024 + 1 }),
      }),
      /byteLength is invalid/u,
    );
    assert.throws(
      () => normalizeAiPlatformMediaInput("invoice.recognize", {
        media: documentMedia({ mediaType: "audio/wav" }),
      }),
      /document media type is unsupported/u,
    );
    assert.throws(
      () => normalizeAiPlatformMediaInput("payment-proof.recognize", {
        media: documentMedia(),
        referenceDate: "2026-02-30",
      }),
      /referenceDate is invalid/u,
    );
  });

  it("sends media tasks through the runtime with no raw file fields", async () => {
    const calls = [];
    const payload = await runAiPlatformMediaTask({
      config: {
        aiPlatformMode: "required",
        aiPlatformRuntime: runtimeStub({ calls, result: { payload: { transcript: "你好" } } }),
      },
      taskType: "asr.transcribe",
      feature: "asr",
      owner: "owner-a",
      actor: "owner-a",
      subject: { type: "quick_record", id: "record-a" },
      media: asrMedia(),
    });

    assert.deepEqual(payload, { transcript: "你好" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input, { media: asrMedia() });
    assert.equal(calls[0].input.media.path, undefined);
    assert.equal(calls[0].input.media.base64, undefined);
  });

  it("builds a descriptor from file metadata without retaining a path", () => {
    const descriptor = mediaDescriptorFromFile({
      taskType: "invoice.recognize",
      mediaType: "image/jpeg",
      byteLength: 1_024,
      pageCount: 1,
      sha256: DIGEST,
    });
    assert.deepEqual(descriptor, {
      mediaType: "image/jpeg",
      byteLength: 1_024,
      pageCount: 1,
      sha256: DIGEST,
    });
    assert.equal(Object.hasOwn(descriptor, "path"), false);
  });
});
