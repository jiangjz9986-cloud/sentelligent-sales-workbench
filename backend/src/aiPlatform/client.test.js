import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AiPlatformClientError, createAiPlatformClient } from "./client.js";

function makeHeaders(values = {}) {
  const entries = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    get(name) {
      return entries.get(String(name).toLowerCase()) ?? null;
    },
  };
}

function jsonResponse(payload, {
  status = 200,
  headers = {},
  text = JSON.stringify(payload),
  contentLength = undefined,
  ok = undefined,
  body = null,
} = {}) {
  const responseHeaders = { ...headers };
  if (contentLength !== null && (contentLength !== undefined || !Object.hasOwn(responseHeaders, "content-length"))) {
    responseHeaders["content-length"] = String(contentLength ?? Buffer.byteLength(text, "utf8"));
  }
  return {
    status,
    ...(ok === undefined ? {} : { ok }),
    headers: makeHeaders(responseHeaders),
    body,
    text: async () => text,
  };
}

function streamResponse(chunks, {
  status = 200,
  headers = {},
  contentLength = null,
} = {}) {
  let index = 0;
  let cancelled = false;
  let released = false;
  const reader = {
    async read() {
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = chunks[index];
      index += 1;
      return { done: false, value: value instanceof Uint8Array ? value : new Uint8Array(value) };
    },
    async cancel() {
      cancelled = true;
    },
    releaseLock() {
      released = true;
    },
  };
  const body = {
    getReader() {
      return reader;
    },
    async cancel() {
      cancelled = true;
    },
  };
  const response = jsonResponse(null, {
    status,
    headers,
    contentLength,
    body,
    text: "",
  });
  Object.defineProperties(response, {
    streamCancelled: { get: () => cancelled },
    streamReleased: { get: () => released },
  });
  return response;
}

function trackedSignal() {
  let aborted = false;
  let reason;
  const listeners = new Set();
  let addCount = 0;
  let removeCount = 0;
  return {
    get aborted() { return aborted; },
    get reason() { return reason; },
    get activeListeners() { return listeners.size; },
    get addCount() { return addCount; },
    get removeCount() { return removeCount; },
    addEventListener(type, listener) {
      if (type !== "abort") return;
      addCount += 1;
      listeners.add(listener);
      if (aborted) queueMicrotask(listener);
    },
    removeEventListener(type, listener) {
      if (type !== "abort") return;
      removeCount += 1;
      listeners.delete(listener);
    },
    abort(value = new Error("caller cancelled")) {
      if (aborted) return;
      aborted = true;
      reason = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

function client(options = {}) {
  return createAiPlatformClient({
    baseUrl: "http://127.0.0.1:18997/",
    token: ["test", "service", "token"].join("-"),
    requestIdFactory: (() => {
      let count = 0;
      return () => `request-${++count}`;
    })(),
    ...options,
  });
}

describe("AI platform business client", () => {
  it("supports task, result, cancel, list, and health calls with fixed safe headers", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/tasks") && options.method === "POST") {
        return jsonResponse({ item: { taskId: "task-1", status: "queued" } }, { status: 202 });
      }
      if (url.includes("/result")) return jsonResponse({ item: { result: "done" } });
      if (url.endsWith("/cancel")) return jsonResponse({ item: { taskId: "task-1", status: "cancelled" } });
      if (url.includes("/tasks/task%3A1")) return jsonResponse({ item: { taskId: "task:1", status: "succeeded" } });
      if (url.includes("/tasks?")) return jsonResponse({ items: [{ taskId: "task-1" }], total: 1 });
      if (url.endsWith("/healthz")) return jsonResponse({ status: "ok" });
      throw new Error(`unexpected URL: ${url}`);
    };
    const api = client({ fetchImpl });

    const created = await api.createTask({
      request: { taskType: "quick-record.analyze", input: { text: "hello" } },
      idempotencyKey: "idem-1",
    });
    const task = await api.getTask("task:1");
    const result = await api.getResult("task:1");
    const cancelled = await api.cancelTask("task:1");
    const listed = await api.listTasks({ status: "queued", feature: "sales&ai" });
    const health = await api.health();

    assert.deepEqual(created, { taskId: "task-1", status: "queued" });
    assert.deepEqual(task, { taskId: "task:1", status: "succeeded" });
    assert.deepEqual(result, { result: "done" });
    assert.deepEqual(cancelled, { taskId: "task-1", status: "cancelled" });
    assert.deepEqual(listed, { items: [{ taskId: "task-1" }], total: 1 });
    assert.deepEqual(health, { status: "ok" });

    assert.equal(calls[0].url, "http://127.0.0.1:18997/internal/ai/v1/tasks");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers.Accept, "application/json");
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-service-token");
    assert.equal(calls[0].options.headers["Idempotency-Key"], "idem-1");
    assert.equal(calls[0].options.headers["X-Request-Id"], "request-1");
    assert.equal(calls[0].options.headers["Content-Type"], "application/json");
    assert.equal(calls[0].options.redirect, "error");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      taskType: "quick-record.analyze",
      input: { text: "hello" },
    });
    assert.ok(calls.some(({ url }) => url === "http://127.0.0.1:18997/internal/ai/v1/tasks/task%3A1/result"));
    assert.ok(calls.some(({ url }) => url === "http://127.0.0.1:18997/internal/ai/v1/tasks/task%3A1/cancel"));
    assert.ok(calls.some(({ url }) => url === "http://127.0.0.1:18997/internal/ai/v1/tasks?limit=50&offset=0&status=queued&feature=sales%26ai"));
    const healthCall = calls.at(-1);
    assert.equal(healthCall.url, "http://127.0.0.1:18997/healthz");
    assert.equal(healthCall.options.headers.Authorization, undefined);
    assert.match(healthCall.options.headers["X-Request-Id"], /^request-\d+$/u);
  });

  it("calls an async tokenProvider per authenticated request and rejects unsafe provider tokens", async () => {
    const contexts = [];
    let fetchCount = 0;
    const api = client({
      token: null,
      tokenProvider: async (context) => {
        contexts.push(context);
        return "rotated-token";
      },
      fetchImpl: async (_url, options) => {
        fetchCount += 1;
        assert.equal(options.headers.Authorization, "Bearer rotated-token");
        return jsonResponse({ item: { taskId: "task-1" } });
      },
    });

    await api.getTask("task-1");
    await api.getResult("task-1");
    assert.equal(fetchCount, 2);
    assert.equal(contexts[0].method, "GET");
    assert.equal(contexts[0].path, "/tasks/task-1");
    assert.equal(contexts[0].requestId, "request-1");
    assert.equal(typeof contexts[0].signal?.addEventListener, "function");

    let unsafeFetches = 0;
    const unsafe = client({
      tokenProvider: () => "token\r\nX-Injected: yes",
      fetchImpl: async () => {
        unsafeFetches += 1;
        return jsonResponse({});
      },
    });
    await assert.rejects(unsafe.getTask("task-1"), (error) => error instanceof TypeError && /token is invalid/u.test(error.message));
    assert.equal(unsafeFetches, 0);
  });

  it("maps HTTP errors while retaining safe response request IDs and retryability", async () => {
    const api = client({
      fetchImpl: async () => jsonResponse({
        error: { code: "forbidden", message: "access denied", details: { scope: "ai:task:read" } },
      }, {
        status: 403,
        headers: { "X-Request-Id": "server-request-7" },
      }),
    });
    await assert.rejects(api.getTask("task-1"), (error) => {
      assert.ok(error instanceof AiPlatformClientError);
      assert.equal(error.code, "forbidden");
      assert.equal(error.status, 403);
      assert.equal(error.requestId, "server-request-7");
      assert.deepEqual(error.details, { scope: "ai:task:read" });
      assert.equal(error.retryable, false);
      return true;
    });

    const unavailable = client({
      fetchImpl: async () => jsonResponse({ error: { code: "provider_unavailable", message: "do not expose" } }, { status: 503 }),
    });
    await assert.rejects(unavailable.getTask("task-1"), (error) => {
      assert.equal(error.code, "provider_unavailable");
      assert.equal(error.message, "AI platform is unavailable");
      assert.equal(error.retryable, true);
      return true;
    });
  });

  it("maps network failures and timeout failures separately", async () => {
    const cause = new Error("connection refused");
    const network = client({ fetchImpl: async () => { throw cause; } });
    await assert.rejects(network.getTask("task-1"), (error) => {
      assert.ok(error instanceof AiPlatformClientError);
      assert.equal(error.code, "ai_platform_network_error");
      assert.equal(error.status, 502);
      assert.equal(error.retryable, true);
      assert.equal(error.cause, cause);
      return true;
    });

    let observedSignal;
    const timeout = client({
      timeoutMs: 15,
      fetchImpl: (_url, options) => {
        observedSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    });
    await assert.rejects(timeout.getTask("task-1"), (error) => {
      assert.equal(error.code, "ai_platform_timeout");
      assert.equal(error.status, 504);
      assert.equal(error.retryable, true);
      return true;
    });
    assert.equal(observedSignal.aborted, true);
  });

  it("propagates caller cancellation and removes abort listeners on success and failure", async () => {
    const signal = trackedSignal();
    let observedSignal;
    const api = client({
      fetchImpl: (_url, options) => {
        observedSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    });
    const pending = api.getTask("task-1", { signal });
    const reason = new Error("caller stopped waiting");
    signal.abort(reason);
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, "ai_platform_aborted");
      assert.equal(error.status, 499);
      assert.equal(error.aborted, true);
      assert.equal(error.cause, reason);
      return true;
    });
    assert.equal(observedSignal.aborted, true);
    assert.equal(signal.activeListeners, 0);
    assert.equal(signal.addCount, signal.removeCount);

    const successfulSignal = trackedSignal();
    const successful = client({ fetchImpl: async () => jsonResponse({ item: { taskId: "task-1" } }) });
    await successful.getTask("task-1", { signal: successfulSignal });
    assert.equal(successfulSignal.activeListeners, 0);
    assert.equal(successfulSignal.addCount, successfulSignal.removeCount);
  });

  it("enforces declared and streamed response byte limits and rejects invalid JSON", async () => {
    let bodyCancelled = false;
    const declared = client({
      responseLimitBytes: 8,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: makeHeaders({ "content-length": "9" }),
        body: { async cancel() { bodyCancelled = true; } },
      }),
    });
    await assert.rejects(declared.getTask("task-1"), (error) => error.code === "response_too_large");
    assert.equal(bodyCancelled, true);

    const streamedResponse = streamResponse([
      new TextEncoder().encode("12345"),
      new TextEncoder().encode("67890"),
    ]);
    const streamed = client({ responseLimitBytes: 8, fetchImpl: async () => streamedResponse });
    await assert.rejects(streamed.getTask("task-1"), (error) => error.code === "response_too_large");
    assert.equal(streamedResponse.streamCancelled, true);
    assert.equal(streamedResponse.streamReleased, true);

    const invalid = client({
      fetchImpl: async () => jsonResponse(null, { text: "{broken", contentLength: null }),
    });
    await assert.rejects(invalid.getTask("task-1"), (error) => error.code === "invalid_response");
  });

  it("waits until a terminal task state, respects the deadline, and cleans polling listeners", async () => {
    const statuses = ["queued", "running", "succeeded"];
    const signal = trackedSignal();
    let calls = 0;
    const api = client({
      fetchImpl: async () => {
        const status = statuses[Math.min(calls, statuses.length - 1)];
        calls += 1;
        return jsonResponse({ item: { taskId: "task-1", status } });
      },
    });
    const task = await api.waitForTask("task-1", { maxWaitMs: 120, pollMs: 2, signal });
    assert.equal(task.status, "succeeded");
    assert.equal(calls, 3);
    assert.equal(signal.activeListeners, 0);
    assert.equal(signal.addCount, signal.removeCount);

    let deadlineCalls = 0;
    const deadlineApi = client({
      fetchImpl: async () => {
        deadlineCalls += 1;
        return jsonResponse({ item: { taskId: "task-2", status: "queued" } });
      },
    });
    const last = await deadlineApi.waitForTask("task-2", { maxWaitMs: 12, pollMs: 4 });
    assert.equal(last.status, "queued");
    assert.ok(deadlineCalls >= 1);
    assert.ok(deadlineCalls <= 4);
  });

  it("cancels a wait during polling without issuing another request", async () => {
    const signal = trackedSignal();
    let calls = 0;
    const api = client({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          setTimeout(() => signal.abort(new Error("stop polling")), 5);
        }
        return jsonResponse({ item: { taskId: "task-1", status: "queued" } });
      },
    });
    await assert.rejects(
      api.waitForTask("task-1", { maxWaitMs: 200, pollMs: 40, signal }),
      (error) => error.code === "ai_platform_aborted",
    );
    assert.equal(calls, 1);
    assert.equal(signal.activeListeners, 0);
    assert.equal(signal.addCount, signal.removeCount);
  });

  it("runs a task through completion and fetches the result", async () => {
    let call = 0;
    const api = client({
      fetchImpl: async (url, options) => {
        call += 1;
        if (options.method === "POST" && url.endsWith("/tasks")) {
          return jsonResponse({ item: { taskId: "task-1", status: "queued" } }, { status: 202 });
        }
        if (url.endsWith("/result")) return jsonResponse({ item: { answer: 42 } });
        return jsonResponse({ item: { taskId: "task-1", status: "succeeded" } });
      },
    });
    const output = await api.runTask({
      request: { taskType: "quick-record.analyze" },
      idempotencyKey: "run-1",
      maxWaitMs: 100,
      pollMs: 1,
    });
    assert.deepEqual(output, {
      taskId: "task-1",
      status: "queued",
      task: { taskId: "task-1", status: "succeeded" },
      result: { answer: 42 },
    });
    assert.equal(call, 3);
  });

  it("rejects URL, path, query, and header injection inputs before fetch", async () => {
    assert.throws(() => createAiPlatformClient({ baseUrl: "https://user:pass@example.com" }), /HTTP\(S\) URL/u);
    assert.throws(() => createAiPlatformClient({ baseUrl: "https://example.com/api?redirect=yes" }), /query parameters/u);
    assert.throws(() => createAiPlatformClient({ baseUrl: "https://example.com/a/../b" }), /path is invalid/u);
    assert.throws(() => createAiPlatformClient({ baseUrl: "https://example.com/a\\b" }), /bounded URL/u);
    assert.throws(() => createAiPlatformClient({ baseUrl: "https://example.com", apiPrefix: "/internal/ai/v1?x=1" }), /apiPrefix is invalid/u);
    const unsafeRequestId = createAiPlatformClient({
      baseUrl: "https://example.com",
      requestIdFactory: () => "ok\r\nX-Bad: yes",
      fetchImpl: async () => jsonResponse({}),
    });
    await assert.rejects(unsafeRequestId.getTask("task-1"), /requestId is invalid/u);
    assert.throws(() => createAiPlatformClient({
      baseUrl: "https://example.com",
      token: `test-token${String.fromCharCode(10)}value`,
    }), /token is invalid/u);

    let fetchCount = 0;
    const api = client({ fetchImpl: async () => { fetchCount += 1; return jsonResponse({}); } });
    await assert.rejects(api.getTask("task/../../other"), TypeError);
    await assert.rejects(api.getTask("task%2Fother"), TypeError);
    await assert.rejects(api.getTask("task?owner=other"), TypeError);
    await assert.rejects(api.listTasks({ limit: 0 }), TypeError);
    await assert.rejects(api.listTasks({ status: "bad\r\nvalue" }), TypeError);
    await assert.rejects(api.createTask({ request: {}, idempotencyKey: "bad\r\nkey" }), TypeError);
    assert.equal(fetchCount, 0);
  });

  it("maps token provider failures and validates request bodies without making a request", async () => {
    const providerCause = new Error("credential store unavailable");
    let fetchCount = 0;
    const api = client({
      tokenProvider: async () => { throw providerCause; },
      fetchImpl: async () => {
        fetchCount += 1;
        return jsonResponse({});
      },
    });
    await assert.rejects(api.getTask("task-1"), (error) => {
      assert.equal(error.code, "token_provider_error");
      assert.equal(error.cause, providerCause);
      return true;
    });
    assert.equal(fetchCount, 0);

    const badBody = client({ fetchImpl: async () => { fetchCount += 1; return jsonResponse({}); } });
    await assert.rejects(badBody.createTask({ request: null }), TypeError);
    const circular = {};
    circular.self = circular;
    await assert.rejects(badBody.createTask({ request: circular }), TypeError);
    assert.equal(fetchCount, 0);
  });
});
