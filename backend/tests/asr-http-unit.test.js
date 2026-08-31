import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { AsrContractError } from "../src/asr/contracts.js";
import {
  asrRateLimitKey,
  consumeAsrRateLimit,
  createAsrHttpHandlers,
  createDeferredUnreadBodyFinalizer,
  mapAsrHttpError,
} from "../src/asr/http.js";
import { HttpError } from "../src/http/errors.js";

const rateSecret = Buffer.alloc(32, 41).toString("base64url");
const validKey = "asr:12345678-1234-4234-8234-123456789abc";

async function withDatabase(work) {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    return await work(db);
  } finally {
    db.close();
  }
}

function responseEmitter() {
  const response = new EventEmitter();
  response.writableFinished = false;
  response.destroyed = false;
  return response;
}

function requestStream({
  method = "POST",
  headers = {},
} = {}) {
  const request = new PassThrough();
  request.method = method;
  request.headers = {
    "content-type": "audio/webm;codecs=opus",
    "idempotency-key": validKey,
    "x-audio-duration-ms": "1200",
    "x-asr-language": "zh-CN",
    ...headers,
  };
  request.aborted = false;
  return request;
}

function metricsSnapshot() {
  return Object.freeze({
    window: Object.freeze({
      startedAt: "2026-08-30T00:00:00.000Z",
      capacity: 512,
      sampleCount: 0,
      oldestCompletedAt: null,
      newestCompletedAt: null,
    }),
    counters: Object.freeze({
      requestsTotal: Object.freeze({}),
      providerCallsTotal: Object.freeze({}),
      outcomes: Object.freeze({}),
      cleanupFailuresTotal: 0,
      stageDurationMs: Object.freeze({}),
      audioDurationMs: Object.freeze({}),
    }),
    gauges: Object.freeze({
      inflight: 0,
      activeUploads: 0,
      tempBytes: 0,
      staleTempDirectories: 0,
    }),
    p95: Object.freeze({ totalMs: null, providerMs: null }),
  });
}

function fakeService(overrides = {}) {
  return {
    async initialize() { return { ready: true, code: "READY" }; },
    readiness() { return { ready: true, code: "READY" }; },
    async transcribe() {
      return {
        transcript: "合成转写结果",
        language: "zh-CN",
        durationMs: 1200,
        source: "server_asr",
        replayed: false,
      };
    },
    metrics: { snapshot: metricsSnapshot },
    capacitySnapshot() {
      return {
        uploads: { activeUploads: 0, tempBytes: 0, activeUploadsMax: 4, aggregateTempMaxBytes: 33_554_432 },
        processing: { globalActive: 0, activeOwners: 0, ownerMax: 1, globalMax: 2 },
        idempotency: { pending: 0, completed: 0, capacity: 256, ttlMs: 300_000 },
      };
    },
    ...overrides,
  };
}

function handlers(db, {
  config = {},
  service = fakeService(),
  metadataProvider,
  ...options
} = {}) {
  return createAsrHttpHandlers({
    db,
    config: {
      authSessionSecret: rateSecret,
      asrMode: "live",
      asrProvider: "openai-compatible",
      ...config,
    },
    service,
    credentialMetadataProvider: metadataProvider ?? (() => ({ configured: true, status: "active" })),
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
    ...options,
  });
}

function transcriptionInput(request, response, search = "?purpose=quick_record") {
  return {
    request,
    response,
    url: new URL(`/api/asr/transcriptions${search}`, "http://127.0.0.1"),
    owner: "account-a",
    requestId: "request-http-unit",
    remoteAddress: "127.0.0.1",
  };
}

describe("ASR account+IP rate limiting", () => {
  it("allows exactly twelve requests and rejects the thirteenth with a bounded retry", async () => {
    await withDatabase((db) => {
      const key = asrRateLimitKey(rateSecret, " Account-A ", "127.0.0.1");
      assert.match(key, /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(key.includes("account-a"), false);
      for (let index = 1; index <= 12; index += 1) {
        const result = consumeAsrRateLimit(db, key, Date.parse("2026-08-30T12:00:00.000Z"));
        assert.equal(result.count, index);
        assert.equal(result.remaining, 12 - index);
      }
      assert.throws(
        () => consumeAsrRateLimit(db, key, Date.parse("2026-08-30T12:00:00.000Z")),
        (error) => (
          error instanceof HttpError
          && error.status === 429
          && error.code === "ASR_RATE_LIMITED"
          && error.retryAfterSeconds === 300
        ),
      );
    });
  });

  it("keeps account and IP namespaces independent and resets an expired window", async () => {
    await withDatabase((db) => {
      const started = Date.parse("2026-08-30T12:00:00.000Z");
      const keyA = asrRateLimitKey(rateSecret, "account-a", "127.0.0.1");
      const keyB = asrRateLimitKey(rateSecret, "account-b", "127.0.0.1");
      const keyIp = asrRateLimitKey(rateSecret, "account-a", "127.0.0.2");
      for (let index = 0; index < 12; index += 1) consumeAsrRateLimit(db, keyA, started);
      assert.equal(consumeAsrRateLimit(db, keyB, started).count, 1);
      assert.equal(consumeAsrRateLimit(db, keyIp, started).count, 1);
      assert.equal(
        consumeAsrRateLimit(db, keyA, started + 15 * 60 * 1_000).count,
        1,
      );
    });
  });

  it("clamps the retry hint to one second at the end of a live window", async () => {
    await withDatabase((db) => {
      const started = Date.parse("2026-08-30T12:00:00.000Z");
      const key = asrRateLimitKey(rateSecret, "account-a", "127.0.0.1");
      for (let index = 0; index < 12; index += 1) consumeAsrRateLimit(db, key, started);
      assert.throws(
        () => consumeAsrRateLimit(db, key, started + 15 * 60 * 1_000 - 1),
        (error) => error.retryAfterSeconds === 1,
      );
    });
  });
});

describe("ASR unread body finalizer", () => {
  it("runs only after finish and exactly once even when close follows", () => {
    const response = responseEmitter();
    const finalizer = createDeferredUnreadBodyFinalizer(response);
    let calls = 0;
    assert.equal(finalizer.defer(() => { calls += 1; return true; }), true);
    assert.equal(calls, 0);
    response.emit("finish");
    response.emit("finish");
    response.emit("close");
    assert.equal(calls, 1);
    assert.equal(finalizer.isRegistered(), true);
    assert.equal(finalizer.isFinalized(), true);
  });

  it("uses close as the fallback when finish cannot happen", () => {
    const response = responseEmitter();
    const finalizer = createDeferredUnreadBodyFinalizer(response);
    let calls = 0;
    finalizer.defer(() => { calls += 1; return true; });
    response.emit("close");
    response.emit("finish");
    assert.equal(calls, 1);
  });

  it("finalizes immediately when registration happens after response completion", () => {
    const response = responseEmitter();
    response.writableFinished = true;
    const finalizer = createDeferredUnreadBodyFinalizer(response);
    let calls = 0;
    finalizer.defer(() => { calls += 1; return true; });
    assert.equal(calls, 1);
  });
});

describe("ASR HTTP handlers", () => {
  it("rejects a missing independent credential before service initialization or body ownership", async () => {
    await withDatabase(async (db) => {
      let initializeCalls = 0;
      let transcribeCalls = 0;
      const service = fakeService({
        async initialize() { initializeCalls += 1; return { ready: true, code: "READY" }; },
        async transcribe() { transcribeCalls += 1; throw new Error("must not run"); },
      });
      const http = handlers(db, {
        service,
        metadataProvider: () => ({ configured: false, status: "cleared" }),
      });
      const request = requestStream();
      const response = responseEmitter();
      await assert.rejects(
        () => http.handleTranscription(transcriptionInput(request, response)),
        (error) => error.status === 503 && error.code === "ASR_NOT_CONFIGURED",
      );
      assert.equal(initializeCalls, 0);
      assert.equal(transcribeCalls, 0);
      assert.equal(request.destroyed, false);
      response.emit("finish");
      assert.equal(request.destroyed, true);
    });
  });

  it("passes only the server owner and controlled transport fields to the ASR service", async () => {
    await withDatabase(async (db) => {
      let captured;
      const service = fakeService({
        async transcribe(input) {
          captured = input;
          return {
            transcript: "合成转写结果",
            language: "zh-CN",
            durationMs: 1200,
            source: "server_asr",
            replayed: false,
          };
        },
      });
      const request = requestStream({ headers: { "content-length": "1024", "x-untrusted-owner": "other" } });
      const response = responseEmitter();
      const result = await handlers(db, { service }).handleTranscription(
        transcriptionInput(request, response),
      );
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        requestId: "request-http-unit",
        item: {
          transcript: "合成转写结果",
          language: "zh-CN",
          durationMs: 1200,
          source: "server_asr",
          replayed: false,
        },
      });
      assert.equal(result.headers["Cache-Control"], "no-store, max-age=0");
      assert.equal(captured.owner, "account-a");
      assert.equal(captured.purpose, "quick_record");
      assert.equal(captured.mediaType, "audio/webm");
      assert.equal(captured.contentLength, 1024);
      assert.equal(captured.idempotencyKey, validKey);
      assert.equal(captured.clientDurationMs, 1200);
      assert.equal(captured.language, "zh-CN");
      assert.equal(Object.hasOwn(captured, "headers"), false);
      assert.equal(Object.hasOwn(captured, "remoteAddress"), false);
      assert.equal(request.destroyed, false);
    });
  });

  it("bounds and actively cancels credential, initialize, and readiness preflights", async () => {
    await withDatabase(async (db) => {
      for (const stage of ["metadata", "initialize", "readiness"]) {
        let operationSignal = null;
        let initializeCalls = 0;
        let readinessCalls = 0;
        let transcribeCalls = 0;
        const pending = ({ signal }) => {
          operationSignal = signal;
          return new Promise(() => {});
        };
        const service = fakeService({
          initialize: stage === "initialize"
            ? async (options) => {
                initializeCalls += 1;
                return pending(options);
              }
            : async ({ signal }) => {
                assert.equal(signal.aborted, false);
                initializeCalls += 1;
                return { ready: true, code: "READY" };
              },
          readiness: stage === "readiness"
            ? (options) => {
                readinessCalls += 1;
                return pending(options);
              }
            : ({ signal }) => {
                assert.equal(signal.aborted, false);
                readinessCalls += 1;
                return { ready: true, code: "READY" };
              },
          async transcribe() {
            transcribeCalls += 1;
            throw new Error("transcription must not start during preflight timeout");
          },
        });
        const request = requestStream();
        const response = responseEmitter();
        const http = handlers(db, {
          service,
          metadataProvider: stage === "metadata"
            ? pending
            : ({ signal }) => {
                assert.equal(signal.aborted, false);
                return { configured: true, status: "active" };
              },
          preflightTimeoutMs: 10,
        });

        await assert.rejects(
          () => http.handleTranscription(transcriptionInput(request, response)),
          (error) => {
            assert.equal(error.status, 504, stage);
            assert.equal(error.code, "ASR_TIMEOUT", stage);
            assert.equal(error.headers["Cache-Control"], "no-store, max-age=0", stage);
            return true;
          },
        );
        assert.ok(operationSignal, stage);
        assert.equal(operationSignal.aborted, true, stage);
        assert.equal(operationSignal.reason?.code, "ASR_TIMEOUT", stage);
        assert.equal(initializeCalls, stage === "metadata" ? 0 : 1, stage);
        assert.equal(readinessCalls, stage === "readiness" ? 1 : 0, stage);
        assert.equal(transcribeCalls, 0, stage);
        assert.equal(request.destroyed, false, stage);
        response.emit("finish");
        assert.equal(request.destroyed, true, stage);
      }
    });
  });

  it("cancels metadata and returns no result after a client disconnect", async () => {
    await withDatabase(async (db) => {
      let operationSignal = null;
      let metadataStarted;
      const started = new Promise((resolve) => { metadataStarted = resolve; });
      const service = fakeService({
        async initialize() { throw new Error("initialize must not run after disconnect"); },
        async transcribe() { throw new Error("transcribe must not run after disconnect"); },
      });
      const http = handlers(db, {
        service,
        metadataProvider: ({ signal }) => {
          operationSignal = signal;
          metadataStarted();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        preflightTimeoutMs: 1_000,
      });
      const request = requestStream();
      const response = responseEmitter();
      const resultPromise = http.handleTranscription(transcriptionInput(request, response));
      await started;
      request.aborted = true;
      request.emit("aborted");
      assert.equal(await resultPromise, null);
      assert.ok(operationSignal);
      assert.equal(operationSignal.aborted, true);
      assert.equal(operationSignal.reason?.name, "AbortError");
      assert.equal(request.destroyed, false);
      assert.equal(response.destroyed, false);
    });
  });

  it("does not start metadata for a request already aborted before route entry", async () => {
    await withDatabase(async (db) => {
      let metadataCalls = 0;
      const http = handlers(db, {
        metadataProvider: () => {
          metadataCalls += 1;
          return { configured: true, status: "active" };
        },
        service: fakeService({
          async initialize() { throw new Error("initialize must not run"); },
          async transcribe() { throw new Error("transcribe must not run"); },
        }),
      });
      const request = requestStream();
      request.aborted = true;
      const response = responseEmitter();
      assert.equal(
        await http.handleTranscription(transcriptionInput(request, response)),
        null,
      );
      assert.equal(metadataCalls, 0);
    });
  });

  it("returns fixed method/query/header failures and defers unread body termination", async () => {
    await withDatabase(async (db) => {
      const cases = [
        {
          request: requestStream({ method: "GET" }),
          search: "?purpose=quick_record",
          status: 405,
          code: "METHOD_NOT_ALLOWED",
          header: ["Allow", "POST"],
        },
        {
          request: requestStream(),
          search: "?purpose=quick_record&owner=other",
          status: 422,
          code: "VALIDATION_ERROR",
        },
        {
          request: requestStream({ headers: { "content-type": "application/json" } }),
          search: "?purpose=quick_record",
          status: 415,
          code: "AUDIO_MEDIA_TYPE_UNSUPPORTED",
        },
      ];
      for (const item of cases) {
        const response = responseEmitter();
        await assert.rejects(
          () => handlers(db).handleTranscription(
            transcriptionInput(item.request, response, item.search),
          ),
          (error) => {
            assert.equal(error.status, item.status);
            assert.equal(error.code, item.code);
            assert.equal(error.headers["Cache-Control"], "no-store, max-age=0");
            if (item.header) assert.equal(error.headers[item.header[0]], item.header[1]);
            return true;
          },
        );
        assert.equal(item.request.destroyed, false);
        response.emit("finish");
        assert.equal(item.request.destroyed, true);
      }
    });
  });

  it("maps capacity and in-progress service errors to fixed retry hints after response finish", async () => {
    await withDatabase(async (db) => {
      for (const [code, status, retry] of [
        ["ASR_IN_PROGRESS", 409, "1"],
        ["ASR_CAPACITY_EXCEEDED", 429, "2"],
      ]) {
        const request = requestStream();
        const response = responseEmitter();
        let deferredCalls = 0;
        const service = fakeService({
          async transcribe(input) {
            input.deferUnreadBodyTermination(() => {
              deferredCalls += 1;
              request.destroy();
              return true;
            });
            throw new AsrContractError(code, status, "fixed ASR error");
          },
        });
        await assert.rejects(
          () => handlers(db, { service }).handleTranscription(
            transcriptionInput(request, response),
          ),
          (error) => {
            assert.equal(error.status, status);
            assert.equal(error.code, code);
            assert.equal(error.headers["Retry-After"], retry);
            return true;
          },
        );
        assert.equal(deferredCalls, 0);
        response.emit("finish");
        response.emit("close");
        assert.equal(deferredCalls, 1);
      }
    });
  });

  it("exposes only bounded aggregate admin status metadata", async () => {
    await withDatabase(async (db) => {
      const status = await handlers(db).statusSnapshot();
      assert.equal(status.mode, "live");
      assert.equal(status.provider, "openai-compatible");
      assert.equal(status.credentialConfigured, true);
      assert.deepEqual(status.readiness, { ready: true, code: "READY" });
      assert.equal(status.inflight, 0);
      assert.equal(status.cleanupFailures, 0);
      const serialized = JSON.stringify(status);
      for (const forbidden of [
        '"owner":', "account-a", "requestId", "transcript", "audioPath", "apiKey", "baseUrl", "ring",
      ]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
    });
  });

  it("bounds and cancels status metadata before reading aggregate readiness", async () => {
    await withDatabase(async (db) => {
      let operationSignal = null;
      let readinessCalls = 0;
      const service = fakeService({
        readiness() {
          readinessCalls += 1;
          return { ready: true, code: "READY" };
        },
      });
      const http = handlers(db, {
        service,
        metadataProvider: ({ signal }) => {
          operationSignal = signal;
          return new Promise(() => {});
        },
        preflightTimeoutMs: 10,
      });
      await assert.rejects(
        () => http.statusSnapshot(),
        (error) => {
          assert.equal(error.status, 504);
          assert.equal(error.code, "ASR_TIMEOUT");
          assert.equal(error.headers["Cache-Control"], "no-store, max-age=0");
          return true;
        },
      );
      assert.equal(operationSignal.aborted, true);
      assert.equal(operationSignal.reason?.code, "ASR_TIMEOUT");
      assert.equal(readinessCalls, 0);
    });
  });
});

describe("ASR error mapping", () => {
  it("maps typed ASR failures without reflecting arbitrary unexpected errors", () => {
    const typed = mapAsrHttpError(new AsrContractError("ASR_TIMEOUT", 504, "ASR processing timed out"));
    assert.equal(typed.status, 504);
    assert.equal(typed.code, "ASR_TIMEOUT");
    const unexpected = new Error("provider body must stay private");
    const mapped = mapAsrHttpError(unexpected);
    assert.equal(mapped.status, 500);
    assert.equal(mapped.code, "INTERNAL_ERROR");
    assert.equal(mapped.message, "Internal server error");
    assert.equal(JSON.stringify(mapped).includes(unexpected.message), false);
  });

  it("sanitizes unexpected service failures and preserves ASR no-store headers", async () => {
    await withDatabase(async (db) => {
      const request = requestStream();
      const response = responseEmitter();
      const service = fakeService({
        async transcribe() {
          throw new Error("private upstream response body and credential");
        },
      });
      await assert.rejects(
        () => handlers(db, { service }).handleTranscription(
          transcriptionInput(request, response),
        ),
        (error) => {
          assert.equal(error.status, 500);
          assert.equal(error.code, "INTERNAL_ERROR");
          assert.equal(error.message, "Internal server error");
          assert.equal(error.headers["Cache-Control"], "no-store, max-age=0");
          assert.equal(JSON.stringify(error).includes("private upstream"), false);
          return true;
        },
      );
    });
  });
});
