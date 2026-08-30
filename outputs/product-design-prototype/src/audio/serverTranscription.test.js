import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TRANSCRIPTION_COPY,
  adaptTranscriptionError,
  createTranscriptionIdempotencyKey,
  transcribeAudio,
} from "./serverTranscription.js";

describe("server transcription capability", () => {
  it("creates an ASR idempotency key only through crypto.randomUUID", () => {
    const calls = [];
    assert.equal(
      createTranscriptionIdempotencyKey({ randomUUID() { calls.push("randomUUID"); return "12345678-1234-4234-9234-123456789abc"; } }),
      "asr:12345678-1234-4234-9234-123456789abc",
    );
    assert.deepEqual(calls, ["randomUUID"]);
    assert.throws(() => createTranscriptionIdempotencyKey({}), /crypto\.randomUUID/);
  });

  it("forwards the same raw Blob, key, purpose, duration, language, and signal", async () => {
    const calls = [];
    const blob = new Blob(["synthetic-audio"], { type: "audio/webm;codecs=opus" });
    const signal = new AbortController().signal;
    const apiClient = {
      async transcribeAudio(input) {
        calls.push(input);
        return {
          requestId: "request-1",
          item: {
            transcript: "服务端文字",
            language: "zh-CN",
            durationMs: 800,
            source: "server_asr",
            replayed: false,
            providerBody: "must-not-cross-capability",
            model: "must-not-cross-capability",
            headers: { authorization: "must-not-cross-capability" },
          },
          internalPath: "must-not-cross-capability",
        };
      },
    };

    const result = await transcribeAudio(apiClient, {
      blob,
      purpose: "quick_record",
      durationMs: 800,
      key: "asr:12345678-1234-4234-9234-123456789abc",
      signal,
    });

    assert.equal(result.transcript, "服务端文字");
    assert.deepEqual(result, {
      transcript: "服务端文字",
      language: "zh-CN",
      durationMs: 800,
      source: "server_asr",
      replayed: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /must-not-cross-capability/u);
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0].blob, blob);
    assert.equal(calls[0].purpose, "quick_record");
    assert.equal(calls[0].durationMs, 800);
    assert.equal(calls[0].idempotencyKey, "asr:12345678-1234-4234-9234-123456789abc");
    assert.equal(calls[0].language, "zh-CN");
    assert.strictEqual(calls[0].signal, signal);
  });

  it("matches the server transcript control boundary without rejecting DEL or C1", async () => {
    const blob = new Blob(["x"], { type: "audio/webm" });
    const input = {
      blob,
      purpose: "quick_record",
      durationMs: 500,
      key: "asr:12345678-1234-4234-9234-123456789abc",
    };
    const allowed = "第一行\n\t第二行\u007F\u0085";
    assert.equal((await transcribeAudio({
      async transcribeAudio() {
        return {
          requestId: "boundary",
          item: {
            transcript: allowed,
            language: "zh-CN",
            durationMs: 500,
            source: "server_asr",
            replayed: false,
          },
        };
      },
    }, input)).transcript, allowed);

    for (const transcript of ["含\u0000控制字符", "含\r裸回车"]) {
      await assert.rejects(() => transcribeAudio({
        async transcribeAudio() {
          return {
            requestId: "invalid-boundary",
            item: {
              transcript,
              language: "zh-CN",
              durationMs: 500,
              source: "server_asr",
              replayed: false,
            },
          };
        },
      }, input), (error) => error.code === "ASR_PROVIDER_BAD_RESPONSE");
    }
  });

  it("keeps only the five designed transient failures eligible for the same Blob retry", () => {
    for (const code of [
      "ASR_NETWORK_ERROR",
      "ASR_IN_PROGRESS",
      "ASR_CAPACITY_EXCEEDED",
      "ASR_PROVIDER_BAD_RESPONSE",
      "ASR_TIMEOUT",
    ]) {
      const adapted = adaptTranscriptionError({ code, message: "provider body must stay hidden" });
      assert.equal(adapted.lifecycle, "same_blob_retryable", code);
      assert.notEqual(adapted.userMessage, "provider body must stay hidden");
    }
  });

  it("classifies rate limiting separately and all validation/conflict failures as release", () => {
    const rateLimited = adaptTranscriptionError({
      code: "ASR_RATE_LIMITED",
      lifecycle: "rate_limited",
      retryAfterSeconds: 17,
    });
    assert.equal(rateLimited.lifecycle, "rate_limited");
    assert.equal(rateLimited.retryAfterSeconds, 17);

    for (const code of [
      "INVALID_IDEMPOTENCY_KEY",
      "ASR_TRANSCRIPT_EMPTY",
      "IDEMPOTENCY_CONFLICT",
      "AUDIO_TOO_LARGE",
      "ASR_NOT_CONFIGURED",
      "ASR_CLEANUP_FAILED",
      "UNKNOWN_PROVIDER_FAILURE",
    ]) {
      assert.equal(adaptTranscriptionError({ code }).lifecycle, "release_and_rerecord", code);
    }
  });

  it("uses fixed Chinese copy and never reflects unknown messages or raw bodies", () => {
    const error = adaptTranscriptionError({
      status: 502,
      code: "SOMETHING_NEW",
      message: "secret upstream response",
      body: { error: { message: "secret nested response" } },
      retryAfterSeconds: 999,
    });
    assert.equal(error.userMessage, TRANSCRIPTION_COPY.UNKNOWN_ERROR);
    assert.equal(error.retryAfterSeconds, null);
    assert.equal(Object.hasOwn(error, "body"), false);
    assert.doesNotMatch(JSON.stringify(error), /secret/i);
  });

  it("rejects malformed wrapper inputs before calling the API", async () => {
    let calls = 0;
    const apiClient = { async transcribeAudio() { calls += 1; } };
    const blob = new Blob(["x"], { type: "audio/webm" });
    await assert.rejects(() => transcribeAudio(apiClient, {
      blob,
      purpose: "other",
      durationMs: 500,
      key: "asr:12345678-1234-4234-9234-123456789abc",
    }), /purpose/);
    await assert.rejects(() => transcribeAudio(apiClient, {
      blob,
      purpose: "quick_record",
      durationMs: 0,
      key: "asr:12345678-1234-4234-9234-123456789abc",
    }), /durationMs/);
    assert.equal(calls, 0);
  });

  it("sanitizes a malformed 2xx wrapper response as a transient provider contract failure", async () => {
    const blob = new Blob(["x"], { type: "audio/webm" });
    await assert.rejects(() => transcribeAudio({
      async transcribeAudio() {
        return { item: { transcript: null, providerBody: "untrusted" } };
      },
    }, {
      blob,
      purpose: "quick_record",
      durationMs: 500,
      key: "asr:12345678-1234-4234-9234-123456789abc",
    }), (error) => {
      assert.equal(error.code, "ASR_PROVIDER_BAD_RESPONSE");
      assert.equal(error.lifecycle, "same_blob_retryable");
      assert.doesNotMatch(error.message, /untrusted|providerBody/);
      return true;
    });
  });
});
