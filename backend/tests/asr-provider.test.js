import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import {
  ASR_PROVIDER_RESOURCE_LIFECYCLE,
  createAsrProvider,
  createOpenAiCompatibleProvider,
  normalizeOpenAiCompatibleBaseUrl,
} from "../src/asr/providers/openAiCompatible.js";

const VALID_INPUT = Object.freeze({
  audioPath: "/synthetic/normalized.wav",
  mediaType: "audio/wav",
  language: "zh-CN",
  durationMs: 1_000,
  purpose: "quick_record",
  signal: new AbortController().signal,
  requestId: "synthetic-request",
});

function responseFromBytes(bytes, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: Readable.from(Array.isArray(bytes) ? bytes : [bytes]),
  };
}

function jsonResponse(value, options) {
  return responseFromBytes(Buffer.from(JSON.stringify(value)), options);
}

function providerWith(overrides = {}, dependencies = {}) {
  return createOpenAiCompatibleProvider({
    baseUrl: "https://provider.example/v1",
    model: "synthetic-asr",
    timeoutMs: 1_000,
    asrApiKeyProvider: async () => "synthetic-provider-key",
    ...overrides,
  }, {
    openAsBlobImpl: async () => new Blob(["synthetic-wav"], { type: "audio/wav" }),
    fetchImpl: async () => jsonResponse({ text: "合成文本" }),
    ...dependencies,
  });
}

describe("ASR OpenAI-compatible provider URL contract", () => {
  it("preserves root and /v1 base pathnames with and without trailing slash", () => {
    const matrix = new Map([
      ["https://provider.example", "https://provider.example/audio/transcriptions"],
      ["https://provider.example/", "https://provider.example/audio/transcriptions"],
      ["https://provider.example/v1", "https://provider.example/v1/audio/transcriptions"],
      ["https://provider.example/v1/", "https://provider.example/v1/audio/transcriptions"],
    ]);
    for (const [input, expected] of matrix) {
      assert.equal(normalizeOpenAiCompatibleBaseUrl(input).endpoint.href, expected);
    }
  });

  it("normalizes multiple trailing slashes without discarding the base pathname", () => {
    assert.equal(
      normalizeOpenAiCompatibleBaseUrl("https://provider.example/team/v1///").endpoint.href,
      "https://provider.example/team/v1/audio/transcriptions",
    );
    assert.equal(
      normalizeOpenAiCompatibleBaseUrl("https://provider.example/team@scope/v1").endpoint.href,
      "https://provider.example/team@scope/v1/audio/transcriptions",
    );
    assert.equal(
      normalizeOpenAiCompatibleBaseUrl("https://provider.example/team\u{1f680}/v1").endpoint.href,
      "https://provider.example/team%F0%9F%9A%80/v1/audio/transcriptions",
    );
    assert.equal(
      normalizeOpenAiCompatibleBaseUrl("https://provider.example/team%E4%B8%AD/v1").endpoint.href,
      "https://provider.example/team%E4%B8%AD/v1/audio/transcriptions",
    );
  });

  it("rejects credentials, query, fragment, non-HTTP protocols, whitespace, and malformed URLs", () => {
    for (const value of [
      "https://user@provider.example/v1",
      "https://user:pass@provider.example/v1",
      "https://@provider.example/v1",
      "https://:@provider.example/v1",
      "https://provider.example/v1?q=1",
      "https://provider.example/v1#fragment",
      "https://provider.example/v1?",
      "https://provider.example/v1#",
      "https://provider.example/v1?#",
      "https://provider.example\\v1",
      "https:\\provider.example\\v1",
      "https://provider.example/v1\\team",
      "https:provider.example/v1",
      "https:/provider.example/v1",
      "https:///provider.example/v1",
      "https:////provider.example/v1",
      "https://provider.example:/v1",
      "ftp://provider.example/v1",
      "https://provi\nder.example/v1",
      "https://provider.example/v\t1",
      "https://provider.example/v 1",
      "https://provider.example/v1\u00a0team",
      "https://provider.example/v1\u2028team",
      "https://provider.example/v1\ufeffteam",
      "https://pro\u200bvider.example/v1",
      "https://provider.example/v1\u202eteam",
      "https://pro\u00advider.example/v1",
      "https://pro\u034fvider.example/v1",
      "https://pro%E2%80%8Bvider.example/v1",
      "https://pro%C2%ADvider.example/v1",
      "https://provider.example/v1\ufe00team",
      "https://provider.example/v1\ud800",
      "https://provider.example/v1\udc00",
      "https://provider.example/v1\u007f",
      " https://provider.example/v1",
      "https://provider.example/v1 ",
      "not-a-url",
      "",
    ]) {
      assert.throws(() => normalizeOpenAiCompatibleBaseUrl(value), /base URL|HTTPS/);
    }
  });

  it("rejects HTTP by default and for non-loopback hosts", () => {
    assert.throws(() => normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8787/v1"), /HTTPS/);
    assert.throws(
      () => normalizeOpenAiCompatibleBaseUrl(
        "http://provider.example/v1",
        { allowLoopbackHttpForTests: true },
      ),
      /HTTPS/,
    );
  });

  it("allows loopback HTTP only through the explicit test dependency", () => {
    for (const value of [
      "http://127.0.0.1:8787/v1",
      "http://localhost:8787/v1/",
      "http://[::1]:8787/v1",
    ]) {
      assert.match(
        normalizeOpenAiCompatibleBaseUrl(value, { allowLoopbackHttpForTests: true }).endpoint.href,
        /\/v1\/audio\/transcriptions$/u,
      );
    }
  });
});

describe("ASR OpenAI-compatible provider upload", () => {
  it("fails before opening the file or fetch when the independent credential is empty", async () => {
    let fetchCalls = 0;
    let blobCalls = 0;
    const provider = providerWith({ asrApiKeyProvider: async () => "" }, {
      fetchImpl: async () => { fetchCalls += 1; },
      openAsBlobImpl: async () => { blobCalls += 1; },
    });
    await assert.rejects(
      provider.transcribe(VALID_INPUT),
      (error) => error.code === "ASR_NOT_CONFIGURED" && error.status === 503,
    );
    assert.equal(fetchCalls, 0);
    assert.equal(blobCalls, 0);
  });

  it("fails before key, openAsBlob, and fetch when the caller signal is already aborted", async () => {
    const calls = { key: 0, blob: 0, fetch: 0 };
    const controller = new AbortController();
    controller.abort(new DOMException("synthetic cancel", "AbortError"));
    const provider = providerWith({
      asrApiKeyProvider: async () => { calls.key += 1; return "synthetic-provider-key"; },
    }, {
      openAsBlobImpl: async () => { calls.blob += 1; return new Blob(); },
      fetchImpl: async () => { calls.fetch += 1; return jsonResponse({ text: "x" }); },
    });
    await assert.rejects(
      provider.transcribe({ ...VALID_INPUT, signal: controller.signal }),
      (error) => error.name === "AbortError",
    );
    assert.deepEqual(calls, { key: 0, blob: 0, fetch: 0 });
  });

  it("bounds a never-settling credential lookup with the provider timeout", async () => {
    const calls = { blob: 0, fetch: 0 };
    const provider = providerWith({
      timeoutMs: 10,
      asrApiKeyProvider: async () => new Promise(() => {}),
    }, {
      openAsBlobImpl: async () => { calls.blob += 1; return new Blob(); },
      fetchImpl: async () => { calls.fetch += 1; return jsonResponse({ text: "x" }); },
    });
    await assert.rejects(
      provider.transcribe(VALID_INPUT),
      (error) => error.code === "ASR_TIMEOUT" && error.status === 504,
    );
    assert.deepEqual(calls, { blob: 0, fetch: 0 });
  });

  it("lets caller abort win while a credential lookup never settles", async () => {
    const calls = { blob: 0, fetch: 0 };
    const controller = new AbortController();
    const provider = providerWith({
      timeoutMs: 1_000,
      asrApiKeyProvider: async () => new Promise(() => {}),
    }, {
      openAsBlobImpl: async () => { calls.blob += 1; return new Blob(); },
      fetchImpl: async () => { calls.fetch += 1; return jsonResponse({ text: "x" }); },
    });
    const pending = provider.transcribe({ ...VALID_INPUT, signal: controller.signal });
    controller.abort(new DOMException("synthetic credential cancel", "AbortError"));
    await assert.rejects(pending, (error) => error.name === "AbortError");
    assert.deepEqual(calls, { blob: 0, fetch: 0 });
  });

  it("preserves caller abort when the credential provider rejects after cancellation", async () => {
    let rejectCredential;
    let credentialStarted;
    const started = new Promise((resolve) => { credentialStarted = resolve; });
    const calls = { blob: 0, fetch: 0 };
    const controller = new AbortController();
    const provider = providerWith({
      asrApiKeyProvider: async () => {
        credentialStarted();
        return new Promise((_resolve, reject) => { rejectCredential = reject; });
      },
    }, {
      openAsBlobImpl: async () => { calls.blob += 1; return new Blob(); },
      fetchImpl: async () => { calls.fetch += 1; return jsonResponse({ text: "x" }); },
    });
    const pending = provider.transcribe({ ...VALID_INPUT, signal: controller.signal });
    await started;
    controller.abort(new DOMException("synthetic credential race cancel", "AbortError"));
    rejectCredential(new Error("synthetic credential lookup failure"));
    await assert.rejects(pending, (error) => error.name === "AbortError");
    assert.deepEqual(calls, { blob: 0, fetch: 0 });
  });

  it("drops a credential that resolves after its provider deadline", async () => {
    let resolveCredential;
    let credentialStarted;
    const started = new Promise((resolve) => { credentialStarted = resolve; });
    const calls = { blob: 0, fetch: 0 };
    const provider = providerWith({
      timeoutMs: 10,
      asrApiKeyProvider: async () => {
        credentialStarted();
        return new Promise((resolve) => { resolveCredential = resolve; });
      },
    }, {
      openAsBlobImpl: async () => { calls.blob += 1; return new Blob(); },
      fetchImpl: async () => { calls.fetch += 1; return jsonResponse({ text: "x" }); },
    });
    const pending = provider.transcribe(VALID_INPUT);
    await started;
    await assert.rejects(pending, (error) => error.code === "ASR_TIMEOUT");
    resolveCredential("synthetic-late-provider-key");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, { blob: 0, fetch: 0 });
  });

  it("consumes a late credential rejection after its provider deadline", async () => {
    let rejectCredential;
    let credentialStarted;
    const started = new Promise((resolve) => { credentialStarted = resolve; });
    const calls = { blob: 0, fetch: 0 };
    const provider = providerWith({
      timeoutMs: 10,
      asrApiKeyProvider: async () => {
        credentialStarted();
        return new Promise((_resolve, reject) => { rejectCredential = reject; });
      },
    }, {
      openAsBlobImpl: async () => { calls.blob += 1; return new Blob(); },
      fetchImpl: async () => { calls.fetch += 1; return jsonResponse({ text: "x" }); },
    });
    const pending = provider.transcribe(VALID_INPUT);
    await started;
    await assert.rejects(pending, (error) => error.code === "ASR_TIMEOUT");
    rejectCredential(new Error("synthetic late credential rejection"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, { blob: 0, fetch: 0 });
  });

  it("rejects whitespace, controls, and overbound credentials before file/network", async () => {
    for (const key of [" synthetic", "synthetic ", "bad\nkey", "x".repeat(4_097)]) {
      let blobCalls = 0;
      let fetchCalls = 0;
      const provider = providerWith({ asrApiKeyProvider: async () => key }, {
        openAsBlobImpl: async () => { blobCalls += 1; return new Blob(); },
        fetchImpl: async () => { fetchCalls += 1; return jsonResponse({ text: "x" }); },
      });
      await assert.rejects(provider.transcribe(VALID_INPUT), (error) => error.code === "ASR_NOT_CONFIGURED");
      assert.equal(blobCalls, 0);
      assert.equal(fetchCalls, 0);
    }
  });

  it("uses file-backed openAsBlob, exact form fields, bearer key, and redirect:error", async () => {
    const calls = [];
    const provider = providerWith({}, {
      openAsBlobImpl: async (path, options) => {
        calls.push({ type: "blob", path, options });
        return new Blob(["synthetic-wav"], { type: options.type });
      },
      fetchImpl: async (url, options) => {
        calls.push({ type: "fetch", url: url.href, options });
        return jsonResponse({ text: "  合成\r\n文本  " });
      },
    });
    const result = await provider.transcribe(VALID_INPUT);
    assert.deepEqual(result, { text: "合成\n文本" });
    assert.deepEqual(calls[0], {
      type: "blob",
      path: VALID_INPUT.audioPath,
      options: { type: "audio/wav" },
    });
    const fetchCall = calls[1];
    assert.equal(fetchCall.url, "https://provider.example/v1/audio/transcriptions");
    assert.equal(fetchCall.options.method, "POST");
    assert.equal(fetchCall.options.redirect, "error");
    assert.deepEqual(fetchCall.options.headers, {
      Authorization: ["Bearer", "synthetic-provider-key"].join(" "),
    });
    assert.deepEqual([...fetchCall.options.body.keys()], ["file", "model", "language", "response_format"]);
    assert.equal(fetchCall.options.body.get("model"), "synthetic-asr");
    assert.equal(fetchCall.options.body.get("language"), "zh");
    assert.equal(fetchCall.options.body.get("response_format"), "json");
    assert.equal(fetchCall.options.body.get("file").type, "audio/wav");
    assert.equal(fetchCall.options.body.get("file").name, "audio.wav");
  });

  it("reads only asrApiKeyProvider and never a similarly named model key provider", async () => {
    let asrCalls = 0;
    let modelCalls = 0;
    const provider = providerWith({
      asrApiKeyProvider: async () => { asrCalls += 1; return "synthetic-provider-key"; },
      modelApiKeyProvider: async () => { modelCalls += 1; return "wrong-key"; },
    });
    await provider.transcribe(VALID_INPUT);
    assert.equal(asrCalls, 1);
    assert.equal(modelCalls, 0);
  });

  it("rejects every non-normalized provider input before fetch", async () => {
    let fetchCalls = 0;
    const provider = providerWith({}, {
      fetchImpl: async () => { fetchCalls += 1; return jsonResponse({ text: "x" }); },
    });
    for (const patch of [
      { mediaType: "audio/webm" },
      { language: "en-US" },
      { durationMs: 0 },
      { purpose: "unknown" },
      { audioPath: "" },
    ]) {
      await assert.rejects(provider.transcribe({ ...VALID_INPUT, ...patch }));
    }
    assert.equal(fetchCalls, 0);
  });

  it("freezes the registry to openai-compatible", () => {
    assert.equal(createAsrProvider({
      provider: "openai-compatible",
      baseUrl: "https://provider.example/v1",
      model: "synthetic-asr",
      asrApiKeyProvider: async () => "synthetic-provider-key",
    }, {
      openAsBlobImpl: async () => new Blob(),
      fetchImpl: async () => jsonResponse({ text: "x" }),
    }).id, "openai-compatible");
    assert.throws(() => createAsrProvider({ provider: "local-whisper" }), /openai-compatible/);
  });
});

describe("ASR OpenAI-compatible provider response limits and sanitization", () => {
  it("accepts exactly 262,144 response bytes while streaming", async () => {
    const prefix = Buffer.from('{"text":"合成文本"}');
    const payload = Buffer.concat([prefix, Buffer.alloc(262_144 - prefix.length, 0x20)]);
    const provider = providerWith({}, {
      fetchImpl: async () => responseFromBytes([
        payload.subarray(0, 100_000),
        payload.subarray(100_000),
      ]),
    });
    assert.deepEqual(await provider.transcribe(VALID_INPUT), { text: "合成文本" });
  });

  it("cancels a locked web-stream reader at byte 262,145 and never pulls another chunk", async () => {
    let pulls = 0;
    let cancelled = false;
    let fetchSignalAborted = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array(262_144));
        else if (pulls === 2) controller.enqueue(new Uint8Array(1));
        else controller.enqueue(new Uint8Array([1]));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const provider = providerWith({}, {
      fetchImpl: async (_url, options) => {
        options.signal.addEventListener("abort", () => { fetchSignalAborted = true; }, { once: true });
        return { ok: true, status: 200, body };
      },
    });
    await assert.rejects(provider.transcribe(VALID_INPUT), (error) => error.code === "ASR_PROVIDER_BAD_RESPONSE");
    assert.equal(cancelled, true);
    assert.equal(fetchSignalAborted, true);
    assert.equal(pulls, 2);
  });

  it("actively cancels and releases a non-cooperative response reader before timeout returns", async () => {
    let reads = 0;
    let cancelGetterCalls = 0;
    let cancels = 0;
    let releaseGetterCalls = 0;
    let releases = 0;
    let fetchSignal;
    const lifecycles = [];
    const reader = {
      read() { reads += 1; return new Promise(() => {}); },
    };
    Object.defineProperties(reader, {
      cancel: {
        configurable: true,
        get() {
          cancelGetterCalls += 1;
          return function cancelSyntheticReader() {
            cancels += 1;
            return Promise.resolve();
          };
        },
      },
      releaseLock: {
        configurable: true,
        get() {
          releaseGetterCalls += 1;
          return function releaseSyntheticReader() { releases += 1; };
        },
      },
    });
    const provider = providerWith({ timeoutMs: 10 }, {
      readerCleanupTimeoutMs: 50,
      fetchImpl: async (_url, options) => {
        fetchSignal = options.signal;
        return { ok: true, status: 200, body: { getReader: () => reader } };
      },
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_TIMEOUT" && error.status === 504);
    assert.equal(fetchSignal.aborted, true);
    assert.equal(reads, 1);
    assert.equal(cancelGetterCalls, 1);
    assert.equal(cancels, 1);
    assert.equal(releaseGetterCalls, 1);
    assert.equal(releases, 1);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(await Promise.allSettled(lifecycles), [{ status: "fulfilled", value: undefined }]);
  });

  it("attempts to register an active cleanup lifecycle once when its hook throws", async () => {
    let lifecycleHookGetterCalls = 0;
    let registrations = 0;
    let reads = 0;
    let cancels = 0;
    let releases = 0;
    const reader = {
      read() { reads += 1; return new Promise(() => {}); },
      cancel() { cancels += 1; return Promise.resolve(); },
      releaseLock() { releases += 1; },
    };
    const input = { ...VALID_INPUT };
    Object.defineProperty(input, ASR_PROVIDER_RESOURCE_LIFECYCLE, {
      configurable: true,
      get() {
        lifecycleHookGetterCalls += 1;
        return function rejectLifecycleRegistration() {
          registrations += 1;
          throw new Error("synthetic lifecycle registration failure");
        };
      },
    });
    const provider = providerWith({ timeoutMs: 10 }, {
      readerCleanupTimeoutMs: 50,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: { getReader: () => reader },
      }),
    });
    await assert.rejects(
      provider.transcribe(input),
      (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503,
    );
    assert.equal(lifecycleHookGetterCalls, 1);
    assert.equal(registrations, 1);
    assert.equal(reads, 1);
    assert.equal(cancels, 1);
    assert.equal(releases, 1);
  });

  it("destroys a non-cooperative Node Readable and waits for close before timeout returns", async (t) => {
    const providerTimeoutMs = 44_321;
    const providerTimer = Object.freeze({ kind: "manual-node-readable-provider-timeout" });
    let fireProviderTimeout = null;
    let readStartedResolve;
    const readStarted = new Promise((resolve) => { readStartedResolve = resolve; });
    let destroyCalls = 0;
    let closeEvents = 0;
    let iteratorNextCalls = 0;
    let iteratorNextSettlements = 0;
    let fetchSignal;
    const lifecycles = [];
    const body = new Readable({ read: () => { readStartedResolve(); } });
    const originalAsyncIterator = body[Symbol.asyncIterator].bind(body);
    body[Symbol.asyncIterator] = () => {
      const iterator = originalAsyncIterator();
      return {
        next(...args) {
          iteratorNextCalls += 1;
          const next = iterator.next(...args);
          next.then(
            () => { iteratorNextSettlements += 1; },
            () => { iteratorNextSettlements += 1; },
          );
          return next;
        },
        return: (...args) => iterator.return(...args),
        [Symbol.asyncIterator]() { return this; },
      };
    };
    const originalDestroy = body.destroy.bind(body);
    body.destroy = (...args) => {
      destroyCalls += 1;
      return originalDestroy(...args);
    };
    body.on("close", () => { closeEvents += 1; });
    t.after(() => { if (!body.destroyed) originalDestroy(); });
    const provider = providerWith({ timeoutMs: providerTimeoutMs }, {
      readerCleanupTimeoutMs: 500,
      setTimeoutImpl: (callback, milliseconds) => {
        if (milliseconds === providerTimeoutMs) {
          assert.equal(fireProviderTimeout, null);
          fireProviderTimeout = callback;
          return providerTimer;
        }
        return setTimeout(callback, milliseconds);
      },
      clearTimeoutImpl: (timer) => {
        if (timer !== providerTimer) clearTimeout(timer);
      },
      fetchImpl: async (_url, options) => {
        fetchSignal = options.signal;
        return { ok: true, status: 200, body };
      },
    });
    const request = provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    });
    const requestRejected = assert.rejects(
      request,
      (error) => error.code === "ASR_TIMEOUT" && error.status === 504,
    );
    await readStarted;
    assert.equal(typeof fireProviderTimeout, "function");
    fireProviderTimeout();
    await requestRejected;
    assert.equal(fetchSignal.aborted, true);
    assert.equal(body.destroyed, true);
    assert.equal(destroyCalls, 1);
    assert.equal(closeEvents, 1);
    assert.equal(iteratorNextCalls, 1);
    assert.equal(iteratorNextSettlements, 1);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(await Promise.allSettled(lifecycles), [
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("accepts observable Node closure when emitClose is disabled", async () => {
    let destroyCalls = 0;
    let closeEvents = 0;
    const lifecycles = [];
    const body = new Readable({ read() {}, emitClose: false });
    const originalDestroy = body.destroy.bind(body);
    body.destroy = (...args) => {
      destroyCalls += 1;
      return originalDestroy(...args);
    };
    body.on("close", () => { closeEvents += 1; });
    const provider = providerWith({ timeoutMs: 10 }, {
      readerCleanupTimeoutMs: 50,
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_TIMEOUT" && error.status === 504);
    assert.equal(destroyCalls, 1);
    assert.equal(body.destroyed, true);
    assert.equal(body.closed, true);
    assert.equal(closeEvents, 0);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(await Promise.allSettled(lifecycles), [
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("fails cleanup-closed when a destroyed Node Readable never emits close", async (t) => {
    const providerTimeoutMs = 44_323;
    const providerTimer = Object.freeze({ kind: "manual-node-readable-provider-timeout" });
    let fireProviderTimeout = null;
    let readStartedResolve;
    const readStarted = new Promise((resolve) => { readStartedResolve = resolve; });
    let destroyCalls = 0;
    const lifecycles = [];
    const body = new Readable({ read: () => { readStartedResolve(); } });
    const originalDestroy = body.destroy.bind(body);
    body.destroy = () => {
      destroyCalls += 1;
      return body;
    };
    t.after(() => originalDestroy());
    const provider = providerWith({ timeoutMs: providerTimeoutMs }, {
      readerCleanupTimeoutMs: 10,
      setTimeoutImpl: (callback, milliseconds) => {
        if (milliseconds === providerTimeoutMs) {
          fireProviderTimeout = callback;
          return providerTimer;
        }
        return setTimeout(callback, milliseconds);
      },
      clearTimeoutImpl: (timer) => {
        if (timer !== providerTimer) clearTimeout(timer);
      },
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    const request = provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    });
    const requestRejected = assert.rejects(
      request,
      (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503,
    );
    await readStarted;
    fireProviderTimeout();
    await requestRejected;
    assert.equal(destroyCalls, 1);
    assert.equal(lifecycles.length, 1);
  });

  it("waits for close after a cleanup error before failing cleanup-closed", async () => {
    let destroyCalls = 0;
    let errorEvents = 0;
    let closeEvents = 0;
    let onceGetterCalls = 0;
    let requestSettled = false;
    let unsettledAtError = false;
    let unsettledAtClose = false;
    const lifecycles = [];
    const body = new EventEmitter();
    body.getReader = () => { throw new Error("synthetic response reader acquisition failure"); };
    body.destroy = () => {
      destroyCalls += 1;
      queueMicrotask(() => body.emit("error", new Error("synthetic cleanup error")));
      setImmediate(() => body.emit("close"));
      return body;
    };
    body.on("error", () => {
      errorEvents += 1;
      unsettledAtError = !requestSettled;
    });
    body.on("close", () => {
      closeEvents += 1;
      unsettledAtClose = !requestSettled;
    });
    const onceMethod = body.once;
    Object.defineProperties(body, {
      once: {
        configurable: true,
        get() { onceGetterCalls += 1; return onceMethod; },
      },
    });
    const provider = providerWith({}, {
      readerCleanupTimeoutMs: 100,
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    const request = provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    });
    request.then(
      () => { requestSettled = true; },
      () => { requestSettled = true; },
    );
    await assert.rejects(
      request,
      (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503,
    );
    assert.equal(destroyCalls, 1);
    assert.equal(errorEvents, 1);
    assert.equal(closeEvents, 1);
    assert.equal(unsettledAtError, true);
    assert.equal(unsettledAtClose, true);
    assert.equal(onceGetterCalls, 1);
    assert.equal(lifecycles.length, 1);
    const settlements = await Promise.allSettled(lifecycles);
    assert.equal(settlements[0].status, "rejected");
  });

  it("cancels an async-iterator body and waits its lifecycle before caller abort returns", async () => {
    let nextStartedResolve;
    const nextStarted = new Promise((resolve) => { nextStartedResolve = resolve; });
    let iteratorReturnStartedResolve;
    const iteratorReturnStarted = new Promise((resolve) => { iteratorReturnStartedResolve = resolve; });
    let cancelGetterCalls = 0;
    let cancelCalls = 0;
    let iteratorNextGetterCalls = 0;
    let iteratorReturnGetterCalls = 0;
    let iteratorReturnCalls = 0;
    let iteratorReturnSettled = false;
    let settleNext;
    let settleIteratorReturn;
    let nextSettled = false;
    let requestSettled = false;
    const lifecycles = [];
    const iterator = {};
    Object.defineProperties(iterator, {
      next: {
        configurable: true,
        get() {
          iteratorNextGetterCalls += 1;
          return function readSyntheticIterator() {
            nextStartedResolve();
            return new Promise((resolve) => { settleNext = resolve; }).then((value) => {
              nextSettled = true;
              return value;
            });
          };
        },
      },
      return: {
        configurable: true,
        get() {
          iteratorReturnGetterCalls += 1;
          return function closeSyntheticIterator() {
            iteratorReturnCalls += 1;
            iteratorReturnStartedResolve();
            return new Promise((resolve) => { settleIteratorReturn = resolve; }).then((value) => {
              iteratorReturnSettled = true;
              return value;
            });
          };
        },
      },
    });
    const body = {
      [Symbol.asyncIterator]() { return iterator; },
    };
    Object.defineProperty(body, "cancel", {
      configurable: true,
      get() {
        cancelGetterCalls += 1;
        return function cancelSyntheticBody() {
          cancelCalls += 1;
          return Promise.resolve();
        };
      },
    });
    const controller = new AbortController();
    const provider = providerWith({}, {
      readerCleanupTimeoutMs: 500,
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    const request = provider.transcribe({
      ...VALID_INPUT,
      signal: controller.signal,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    });
    request.then(
      () => { requestSettled = true; },
      () => { requestSettled = true; },
    );
    const requestRejected = assert.rejects(request, (error) => error.name === "AbortError");
    await nextStarted;
    controller.abort(new DOMException("synthetic async body cancellation", "AbortError"));
    await iteratorReturnStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requestSettled, false);
    assert.equal(nextSettled, false);
    settleIteratorReturn({ done: true, value: undefined });
    await requestRejected;
    assert.equal(iteratorReturnSettled, true);
    assert.equal(nextSettled, false);
    settleNext({ done: true, value: undefined });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelGetterCalls, 1);
    assert.equal(cancelCalls, 1);
    assert.equal(iteratorNextGetterCalls, 1);
    assert.equal(iteratorReturnGetterCalls, 1);
    assert.equal(iteratorReturnCalls, 1);
    assert.equal(nextSettled, true);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(await Promise.allSettled(lifecycles), [
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("destroys a Node response body once when getReader acquisition throws", async (t) => {
    let getReaderCalls = 0;
    let destroyGetterCalls = 0;
    let destroyCalls = 0;
    let closeEvents = 0;
    const lifecycles = [];
    const body = new Readable({ read() {} });
    body.getReader = () => {
      getReaderCalls += 1;
      throw new Error("synthetic getReader acquisition failure");
    };
    const originalDestroy = body.destroy.bind(body);
    Object.defineProperty(body, "destroy", {
      configurable: true,
      get() {
        destroyGetterCalls += 1;
        return function destroySyntheticBody(...args) {
          destroyCalls += 1;
          return originalDestroy(...args);
        };
      },
    });
    body.on("close", () => { closeEvents += 1; });
    t.after(() => { if (!body.destroyed) originalDestroy(); });
    const provider = providerWith({}, {
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_PROVIDER_BAD_RESPONSE" && error.status === 502);
    assert.equal(getReaderCalls, 1);
    assert.equal(destroyGetterCalls, 1);
    assert.equal(destroyCalls, 1);
    assert.equal(closeEvents, 1);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(await Promise.allSettled(lifecycles), [
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("cancels an acquired reader once when its read method is unusable", async () => {
    for (const readShape of ["missing", "getter-throws"]) {
      let readGetterCalls = 0;
      let readerCancelCalls = 0;
      let releaseCalls = 0;
      let bodyCancelCalls = 0;
      const lifecycles = [];
      const reader = {
        cancel() { readerCancelCalls += 1; return Promise.resolve(); },
        releaseLock() { releaseCalls += 1; },
      };
      if (readShape === "getter-throws") {
        Object.defineProperty(reader, "read", {
          configurable: true,
          get() {
            readGetterCalls += 1;
            throw new Error("synthetic read getter failure");
          },
        });
      }
      const body = {
        getReader() { return reader; },
        cancel() { bodyCancelCalls += 1; return Promise.resolve(); },
      };
      const provider = providerWith({}, {
        readerCleanupTimeoutMs: 50,
        fetchImpl: async () => ({ ok: true, status: 200, body }),
      });
      await assert.rejects(provider.transcribe({
        ...VALID_INPUT,
        [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
      }), (error) => error.code === "ASR_PROVIDER_BAD_RESPONSE" && error.status === 502);
      assert.equal(readGetterCalls, readShape === "getter-throws" ? 1 : 0);
      assert.equal(readerCancelCalls, 1);
      assert.equal(releaseCalls, 1);
      assert.equal(bodyCancelCalls, 0);
      assert.equal(lifecycles.length, 1);
      assert.deepEqual(await Promise.allSettled(lifecycles), [
        { status: "fulfilled", value: undefined },
      ]);
    }
  });

  it("releases a terminally errored Web reader without cancelling it again", async () => {
    let cancelCalls = 0;
    let releaseCalls = 0;
    const lifecycles = [];
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error("synthetic terminal Web stream error"));
      },
    });
    const acquiredReader = stream.getReader();
    const originalCancel = acquiredReader.cancel.bind(acquiredReader);
    const originalReleaseLock = acquiredReader.releaseLock.bind(acquiredReader);
    acquiredReader.cancel = (...args) => {
      cancelCalls += 1;
      return originalCancel(...args);
    };
    acquiredReader.releaseLock = (...args) => {
      releaseCalls += 1;
      return originalReleaseLock(...args);
    };
    const body = { getReader: () => acquiredReader };
    const provider = providerWith({}, {
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_PROVIDER_BAD_RESPONSE" && error.status === 502);
    assert.equal(cancelCalls, 0);
    assert.equal(releaseCalls, 1);
    assert.equal(lifecycles.length, 0);
  });

  it("does not cancel a fully drained reader during a caller-abort microtask race", async () => {
    const controller = new AbortController();
    let reads = 0;
    let cancels = 0;
    let releases = 0;
    const lifecycles = [];
    const reader = {
      read() {
        reads += 1;
        return new Promise((resolve) => {
          resolve({ done: true, value: undefined });
          queueMicrotask(() => {
            controller.abort(new DOMException("synthetic drained-reader cancel", "AbortError"));
          });
        });
      },
      cancel() {
        cancels += 1;
        return Promise.reject(new TypeError("reader is already released"));
      },
      releaseLock() { releases += 1; },
    };
    const provider = providerWith({}, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: { getReader: () => reader },
      }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      signal: controller.signal,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.name === "AbortError");
    assert.equal(reads, 1);
    assert.equal(cancels, 0);
    assert.equal(releases, 1);
    assert.equal(lifecycles.length, 0);
  });

  it("cancels a captured body once when response status inspection throws", async () => {
    let bodyGetterCalls = 0;
    let okGetterCalls = 0;
    let cancelCalls = 0;
    const lifecycles = [];
    const body = {
      cancel() { cancelCalls += 1; return Promise.resolve(); },
    };
    const response = {
      get body() { bodyGetterCalls += 1; return body; },
      get ok() {
        okGetterCalls += 1;
        throw new Error("synthetic response status getter failure");
      },
    };
    const provider = providerWith({}, {
      readerCleanupTimeoutMs: 50,
      fetchImpl: async () => response,
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_PROVIDER_BAD_RESPONSE" && error.status === 502);
    assert.equal(bodyGetterCalls, 1);
    assert.equal(okGetterCalls, 1);
    assert.equal(cancelCalls, 1);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(await Promise.allSettled(lifecycles), [
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("cancels a response body once when its async-iterator getter throws", async () => {
    let iteratorGetterCalls = 0;
    let cancelCalls = 0;
    const lifecycles = [];
    const body = {
      cancel() {
        cancelCalls += 1;
        return Promise.resolve();
      },
    };
    Object.defineProperty(body, Symbol.asyncIterator, {
      configurable: true,
      get() {
        iteratorGetterCalls += 1;
        throw new Error("synthetic async-iterator getter failure");
      },
    });
    const provider = providerWith({}, {
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_PROVIDER_BAD_RESPONSE" && error.status === 502);
    assert.equal(iteratorGetterCalls, 1);
    assert.equal(cancelCalls, 1);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(await Promise.allSettled(lifecycles), [
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("cancels a response body once when its async-iterator factory throws", async () => {
    let iteratorFactoryCalls = 0;
    let cancelCalls = 0;
    const lifecycles = [];
    const body = {
      cancel() {
        cancelCalls += 1;
        return Promise.resolve();
      },
      [Symbol.asyncIterator]() {
        iteratorFactoryCalls += 1;
        throw new Error("synthetic async-iterator factory failure");
      },
    };
    const provider = providerWith({}, {
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_PROVIDER_BAD_RESPONSE" && error.status === 502);
    assert.equal(iteratorFactoryCalls, 1);
    assert.equal(cancelCalls, 1);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(await Promise.allSettled(lifecycles), [
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("fails cleanup-closed when acquisition fallback cancellation rejects", async () => {
    let cancelCalls = 0;
    const lifecycles = [];
    const body = {
      cancel() {
        cancelCalls += 1;
        return Promise.reject(new Error("synthetic acquisition cleanup rejection"));
      },
      [Symbol.asyncIterator]() {
        throw new Error("synthetic iterator acquisition failure");
      },
    };
    const provider = providerWith({}, {
      readerCleanupTimeoutMs: 50,
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503);
    assert.equal(cancelCalls, 1);
    assert.equal(lifecycles.length, 1);
    const settlements = await Promise.allSettled(lifecycles);
    assert.equal(settlements[0].status, "rejected");
  });

  it("bounds a never-settling acquisition fallback with the cleanup grace", async () => {
    let cancelCalls = 0;
    const lifecycles = [];
    const body = {
      cancel() {
        cancelCalls += 1;
        return new Promise(() => {});
      },
    };
    Object.defineProperty(body, Symbol.asyncIterator, {
      get() {
        throw new Error("synthetic iterator getter acquisition failure");
      },
    });
    const provider = providerWith({}, {
      readerCleanupTimeoutMs: 10,
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503);
    assert.equal(cancelCalls, 1);
    assert.equal(lifecycles.length, 1);
    assert.equal(await Promise.race([
      lifecycles[0].then(() => "fulfilled", () => "rejected"),
      new Promise((resolve) => setImmediate(() => resolve("pending"))),
    ]), "pending");
  });

  it("uses a return-only async iterator for generic acquisition cleanup", async () => {
    let getReaderCalls = 0;
    let iteratorGetterCalls = 0;
    let iteratorFactoryCalls = 0;
    let returnGetterCalls = 0;
    let returnCalls = 0;
    const lifecycles = [];
    const body = {
      getReader() {
        getReaderCalls += 1;
        throw new Error("synthetic reader acquisition failure");
      },
    };
    Object.defineProperty(body, Symbol.asyncIterator, {
      configurable: true,
      get() {
        iteratorGetterCalls += 1;
        return function acquireSyntheticIterator() {
          iteratorFactoryCalls += 1;
          const iterator = {};
          Object.defineProperty(iterator, "return", {
            configurable: true,
            get() {
              returnGetterCalls += 1;
              return function closeSyntheticIterator() {
                returnCalls += 1;
                return Promise.resolve({ done: true, value: undefined });
              };
            },
          });
          return iterator;
        };
      },
    });
    const provider = providerWith({}, {
      readerCleanupTimeoutMs: 50,
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_PROVIDER_BAD_RESPONSE" && error.status === 502);
    assert.equal(getReaderCalls, 1);
    assert.equal(iteratorGetterCalls, 1);
    assert.equal(iteratorFactoryCalls, 1);
    assert.equal(returnGetterCalls, 1);
    assert.equal(returnCalls, 1);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(await Promise.allSettled(lifecycles), [
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("maps a rejected return-only async iterator cleanup to cleanup-closed", async () => {
    let returnCalls = 0;
    const lifecycles = [];
    const body = {
      getReader() {
        throw new Error("synthetic reader acquisition failure");
      },
      [Symbol.asyncIterator]() {
        return {
          return() {
            returnCalls += 1;
            return Promise.reject(new Error("synthetic iterator return rejection"));
          },
        };
      },
    };
    const provider = providerWith({}, {
      readerCleanupTimeoutMs: 50,
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503);
    assert.equal(returnCalls, 1);
    assert.equal(lifecycles.length, 1);
    assert.equal((await Promise.allSettled(lifecycles))[0].status, "rejected");
  });

  it("bounds a never-settling return-only async iterator cleanup", async () => {
    let returnCalls = 0;
    const lifecycles = [];
    const body = {
      getReader() {
        throw new Error("synthetic reader acquisition failure");
      },
      [Symbol.asyncIterator]() {
        return {
          return() {
            returnCalls += 1;
            return new Promise(() => {});
          },
        };
      },
    };
    const provider = providerWith({}, {
      readerCleanupTimeoutMs: 10,
      fetchImpl: async () => ({ ok: true, status: 200, body }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503);
    assert.equal(returnCalls, 1);
    assert.equal(lifecycles.length, 1);
    assert.equal(await Promise.race([
      lifecycles[0].then(() => "fulfilled", () => "rejected"),
      new Promise((resolve) => setImmediate(() => resolve("pending"))),
    ]), "pending");
  });

  it("fails cleanup-closed when response reader cancellation never settles", async () => {
    let cancels = 0;
    let releases = 0;
    const lifecycles = [];
    const provider = providerWith({ timeoutMs: 10 }, {
      readerCleanupTimeoutMs: 10,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
            cancel: () => { cancels += 1; return new Promise(() => {}); },
            releaseLock: () => { releases += 1; },
          }),
        },
      }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503);
    assert.equal(cancels, 1);
    assert.equal(releases, 1);
    assert.equal(lifecycles.length, 1);
  });

  it("fails cleanup-closed when a cancelled response reader lock cannot be released", async () => {
    let releases = 0;
    const provider = providerWith({ timeoutMs: 10 }, {
      readerCleanupTimeoutMs: 20,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
            cancel: () => Promise.resolve(),
            releaseLock: () => { releases += 1; throw new Error("synthetic locked reader"); },
          }),
        },
      }),
    });
    await assert.rejects(
      provider.transcribe(VALID_INPUT),
      (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503,
    );
    assert.equal(releases, 2);
  });

  it("accepts only the exact object schema with text:string", async () => {
    for (const value of [null, [], {}, { text: 1 }, { text: "ok", language: "zh" }]) {
      const provider = providerWith({}, { fetchImpl: async () => jsonResponse(value) });
      await assert.rejects(
        provider.transcribe(VALID_INPUT),
        (error) => error.code === "ASR_PROVIDER_BAD_RESPONSE" && error.status === 502,
      );
    }
  });

  it("delegates empty, control, and purpose-length text to the frozen normalizer", async () => {
    const cases = [
      { text: "", code: "ASR_TRANSCRIPT_EMPTY" },
      { text: "bad\u0000text", code: "ASR_PROVIDER_BAD_RESPONSE" },
      { text: "a".repeat(10_001), code: "ASR_TRANSCRIPT_TOO_LONG" },
    ];
    for (const item of cases) {
      const provider = providerWith({}, { fetchImpl: async () => jsonResponse({ text: item.text }) });
      await assert.rejects(provider.transcribe(VALID_INPUT), (error) => error.code === item.code);
    }
  });

  it("maps provider 4xx/5xx without exposing the body", async () => {
    for (const status of [400, 401, 429, 500, 503]) {
      const body = `synthetic-upstream-body-${status}`;
      const provider = providerWith({}, {
        fetchImpl: async () => responseFromBytes(Buffer.from(body), { status }),
      });
      await assert.rejects(provider.transcribe(VALID_INPUT), (error) => {
        assert.equal(error.code, "ASR_PROVIDER_BAD_RESPONSE");
        assert.equal(error.message.includes(body), false);
        return true;
      });
    }
  });

  it("fails cleanup-closed when a non-2xx body cancellation rejects", async () => {
    let cancelCalls = 0;
    const lifecycles = [];
    const provider = providerWith({}, {
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        body: {
          cancel() {
            cancelCalls += 1;
            return Promise.reject(new Error("synthetic non-2xx cleanup rejection"));
          },
        },
      }),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503);
    assert.equal(cancelCalls, 1);
    assert.equal(lifecycles.length, 1);
    assert.equal((await Promise.allSettled(lifecycles))[0].status, "rejected");
  });

  it("bounds a non-settling non-2xx body cancellation with the cleanup grace", async () => {
    let cancelCalls = 0;
    let fetchSignal;
    const provider = providerWith({}, {
      readerCleanupTimeoutMs: 10,
      fetchImpl: async (_url, options) => {
        fetchSignal = options.signal;
        return {
          ok: false,
          status: 503,
          body: { cancel: async () => { cancelCalls += 1; return new Promise(() => {}); } },
        };
      },
    });
    await assert.rejects(
      provider.transcribe(VALID_INPUT),
      (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503,
    );
    assert.equal(cancelCalls, 1);
    assert.equal(fetchSignal.aborted, true);
  });

  it("keeps cleanup-closed authoritative when caller aborts non-2xx cancellation", async () => {
    let cancelStarted;
    const started = new Promise((resolve) => { cancelStarted = resolve; });
    let cancelCalls = 0;
    const controller = new AbortController();
    const provider = providerWith({}, {
      readerCleanupTimeoutMs: 10,
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        body: {
          cancel: async () => {
            cancelCalls += 1;
            cancelStarted();
            return new Promise(() => {});
          },
        },
      }),
    });
    const pending = provider.transcribe({ ...VALID_INPUT, signal: controller.signal });
    await started;
    controller.abort(new DOMException("synthetic non-2xx cancel", "AbortError"));
    await assert.rejects(
      pending,
      (error) => error.code === "ASR_CLEANUP_FAILED" && error.status === 503,
    );
    assert.equal(cancelCalls, 1);
  });

  for (const cancellation of ["resolve", "reject", "never"]) {
    it(`registers one late-fetch body lifecycle when cancellation will ${cancellation}`, async () => {
      let resolveFetch;
      let cancelCalls = 0;
      const lifecycles = [];
      const provider = providerWith({ timeoutMs: 10 }, {
        fetchImpl: async () => new Promise((resolve) => { resolveFetch = resolve; }),
      });
      await assert.rejects(provider.transcribe({
        ...VALID_INPUT,
        [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
      }), (error) => error.code === "ASR_TIMEOUT" && error.status === 504);
      assert.equal(lifecycles.length, 1);

      resolveFetch({
        ok: true,
        status: 200,
        body: {
          cancel() {
            cancelCalls += 1;
            if (cancellation === "resolve") return Promise.resolve();
            if (cancellation === "reject") return Promise.reject(new Error("synthetic late cancel"));
            return new Promise(() => {});
          },
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(cancelCalls, 1);
      if (cancellation === "resolve") {
        assert.deepEqual(await Promise.allSettled(lifecycles), [
          { status: "fulfilled", value: undefined },
        ]);
      } else if (cancellation === "reject") {
        const settled = await Promise.allSettled(lifecycles);
        assert.equal(settled[0].status, "rejected");
        assert.match(settled[0].reason.message, /synthetic late cancel/u);
      } else {
        let settled = false;
        lifecycles[0].finally(() => { settled = true; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
      }
    });
  }

  it("registers the unresolved fetch itself before returning its timeout", async () => {
    const lifecycles = [];
    const provider = providerWith({ timeoutMs: 10 }, {
      fetchImpl: async () => new Promise(() => {}),
    });
    await assert.rejects(provider.transcribe({
      ...VALID_INPUT,
      [ASR_PROVIDER_RESOURCE_LIFECYCLE]: (lifecycle) => lifecycles.push(lifecycle),
    }), (error) => error.code === "ASR_TIMEOUT" && error.status === 504);
    assert.equal(lifecycles.length, 1);
    let settled = false;
    lifecycles[0].finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
  });

  it("maps network failures without URL, path, key, header, or body disclosure", async () => {
    const toxic = [
      "https://provider.example/v1/audio/transcriptions",
      VALID_INPUT.audioPath,
      "synthetic-provider-key",
      "Authorization",
      "synthetic-upstream-body",
    ];
    const provider = providerWith({}, {
      fetchImpl: async () => { throw new Error(toxic.join("|")); },
    });
    await assert.rejects(provider.transcribe(VALID_INPUT), (error) => {
      assert.equal(error.code, "ASR_PROVIDER_BAD_RESPONSE");
      for (const value of toxic) assert.equal(error.message.includes(value), false);
      return true;
    });
  });

  it("maps the provider timeout to ASR_TIMEOUT and aborts fetch", async () => {
    let sawAbort = false;
    const provider = providerWith({ timeoutMs: 10 }, {
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(options.signal.reason);
        }, { once: true });
      }),
    });
    await assert.rejects(
      provider.transcribe(VALID_INPUT),
      (error) => error.code === "ASR_TIMEOUT" && error.status === 504,
    );
    assert.equal(sawAbort, true);
  });

  it("preserves an explicit caller AbortError instead of misclassifying it as provider failure", async () => {
    const controller = new AbortController();
    const provider = providerWith({}, {
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }),
    });
    const pending = provider.transcribe({ ...VALID_INPUT, signal: controller.signal });
    controller.abort(new DOMException("synthetic cancel", "AbortError"));
    await assert.rejects(pending, (error) => error.name === "AbortError");
  });
});
