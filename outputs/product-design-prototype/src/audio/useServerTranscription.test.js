import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BLOB_TTL_MS,
  createServerTranscriptionController,
} from "./useServerTranscription.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function createClock(start = 10_000) {
  let current = start;
  let nextId = 0;
  const tasks = new Map();
  return {
    now: () => current,
    setTimeout(callback, delay = 0) {
      const id = ++nextId;
      tasks.set(id, { at: current + Math.max(0, Number(delay) || 0), callback });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    tick(milliseconds) {
      const target = current + milliseconds;
      while (true) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        const [id, task] = due;
        tasks.delete(id);
        current = task.at;
        task.callback();
      }
      current = target;
    },
    elapseWithoutTimers(milliseconds) {
      current += milliseconds;
    },
    flushDueTimersAtCurrent() {
      while (true) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= current)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        const [id, task] = due;
        tasks.delete(id);
        task.callback();
      }
    },
    pending: () => tasks.size,
  };
}

function makeLifecycleError(code, lifecycle, retryAfterSeconds = null) {
  return Object.assign(new Error("fixed"), {
    code,
    lifecycle,
    retryAfterSeconds,
    userMessage: "固定错误文案",
  });
}

function createHarness({
  transcribeImpl,
  permission,
  chunks,
  SpeechRecognitionImpl,
  purpose = "quick_record",
  onTranscript,
} = {}) {
  const clock = createClock();
  const tracks = [];
  const streams = [];
  const recorderInstances = [];
  const requests = [];
  const transcripts = [];
  const transcriptResults = [];
  const interim = [];
  let uuid = 0;

  class FakeTrack {
    stopCalls = 0;
    stop() { this.stopCalls += 1; }
  }

  class FakeMediaRecorder {
    static isTypeSupported(value) { return value === "audio/webm;codecs=opus"; }
    constructor(stream, options = {}) {
      this.stream = stream;
      this.mimeType = options.mimeType || "audio/webm;codecs=opus";
      this.state = "inactive";
      this.chunks = chunks ?? [new Blob(["synthetic-audio"], { type: this.mimeType })];
      recorderInstances.push(this);
    }
    start() { this.state = "recording"; }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      const dataHandler = this.ondataavailable;
      const stopHandler = this.onstop;
      queueMicrotask(() => {
        for (const chunk of this.chunks) dataHandler?.({ data: chunk });
        stopHandler?.();
      });
    }
  }

  const mediaDevices = {
    async getUserMedia() {
      if (permission) return permission();
      const trackA = new FakeTrack();
      const trackB = new FakeTrack();
      tracks.push(trackA, trackB);
      const stream = { getTracks: () => [trackA, trackB] };
      streams.push(stream);
      return stream;
    },
  };

  const apiClient = {
    async transcribeAudio(input) {
      requests.push(input);
      if (transcribeImpl) return transcribeImpl(input, requests.length);
      return {
        requestId: `request-${requests.length}`,
        item: {
          transcript: `服务端文字-${requests.length}`,
          language: "zh-CN",
          durationMs: input.durationMs,
          source: "server_asr",
          replayed: false,
        },
      };
    },
  };

  const controller = createServerTranscriptionController({
    apiClient,
    purpose,
    mediaDevices,
    MediaRecorderImpl: FakeMediaRecorder,
    SpeechRecognitionImpl,
    cryptoImpl: {
      randomUUID() {
        uuid += 1;
        return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
      },
    },
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    onTranscript(text, result) {
      transcripts.push(text);
      transcriptResults.push(result);
      onTranscript?.(text, result);
    },
    onInterimText(text) { interim.push(text); },
  });

  return {
    controller,
    clock,
    tracks,
    streams,
    recorderInstances,
    requests,
    transcripts,
    transcriptResults,
    interim,
  };
}

async function recordFor(harness, milliseconds = 500) {
  assert.equal(await harness.controller.startCapture(), true);
  assert.equal(harness.controller.getSnapshot().status, "recording");
  harness.clock.tick(milliseconds);
  assert.equal(harness.controller.stopCapture(), true);
  await settle();
}

describe("server transcription controller", () => {
  it("runs permission -> recording -> one processing -> succeeded and releases every track", async () => {
    const pending = deferred();
    const harness = createHarness({ transcribeImpl: () => pending.promise });
    const statuses = [];
    harness.controller.subscribe((snapshot) => statuses.push(snapshot.status));
    await recordFor(harness);

    assert.equal(harness.controller.getSnapshot().status, "processing");
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].blob instanceof Blob, true);
    assert.equal(harness.requests[0].purpose, "quick_record");
    assert.equal(harness.requests[0].durationMs, 500);
    assert.equal(harness.requests[0].idempotencyKey, "asr:00000000-0000-4000-8000-000000000001");
    assert.equal(harness.tracks.every((track) => track.stopCalls === 1), true);
    assert.equal(statuses.includes("uploading"), false);
    assert.equal(statuses.includes("transcribing"), false);

    pending.resolve({
      requestId: "request-1",
      item: { transcript: "服务端文字", language: "zh-CN", durationMs: 500, source: "server_asr", replayed: false },
    });
    await settle();
    assert.equal(harness.controller.getSnapshot().status, "succeeded");
    assert.deepEqual(harness.transcripts, ["服务端文字"]);
    assert.equal(harness.controller.getSnapshot().hasRetainedBlob, false);
  });

  it("preserves a synchronous cancel triggered while the consumer applies the transcript", async () => {
    let controller;
    const harness = createHarness({
      onTranscript() { controller.cancelCapture("consumer_closed"); },
    });
    controller = harness.controller;
    await recordFor(harness);
    assert.deepEqual(harness.transcripts, ["服务端文字-1"]);
    assert.equal(harness.controller.getSnapshot().status, "cancelled");
    assert.equal(harness.controller.getSnapshot().hasRetainedBlob, false);
    assert.equal(harness.clock.pending(), 0);
  });

  it("keeps the same Blob/key for exactly one manual retry and increments before sending", async () => {
    const second = deferred();
    const harness = createHarness({
      transcribeImpl(input, callNumber) {
        if (callNumber === 1) throw makeLifecycleError("ASR_TIMEOUT", "same_blob_retryable");
        assert.equal(harness.controller.getSnapshot().sameBlobRetryCount, 1);
        return second.promise;
      },
    });
    await recordFor(harness);
    const firstRequest = harness.requests[0];
    const firstExpiry = harness.controller.getSnapshot().expiresAt;
    assert.equal(harness.controller.getSnapshot().status, "retryable_error");
    assert.equal(harness.controller.getSnapshot().sameBlobRetryCount, 0);
    assert.equal(harness.controller.getSnapshot().hasRetainedBlob, true);

    assert.equal(harness.controller.retry(), true);
    await settle();
    assert.equal(harness.requests.length, 2);
    assert.strictEqual(harness.requests[1].blob, firstRequest.blob);
    assert.equal(harness.requests[1].idempotencyKey, firstRequest.idempotencyKey);
    assert.equal(harness.controller.getSnapshot().sameBlobRetryCount, 1);
    assert.equal(harness.controller.getSnapshot().expiresAt, firstExpiry);

    second.resolve({
      requestId: "request-2",
      item: { transcript: "重试成功", language: "zh-CN", durationMs: 500, source: "server_asr", replayed: true },
    });
    await settle();
    assert.deepEqual(harness.transcripts, ["重试成功"]);
    assert.equal(harness.controller.getSnapshot().hasRetainedBlob, false);
  });

  it("releases the Blob/key after the one retry fails and never sends a third request", async () => {
    const harness = createHarness({
      transcribeImpl() { throw makeLifecycleError("ASR_PROVIDER_BAD_RESPONSE", "same_blob_retryable"); },
    });
    await recordFor(harness);
    assert.equal(harness.controller.retry(), true);
    await settle();
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.controller.getSnapshot().status, "error");
    assert.equal(harness.controller.getSnapshot().hasRetainedBlob, false);
    assert.equal(harness.controller.retry(), false);
    assert.equal(harness.requests.length, 2);
  });

  it("keeps fixed expiresAt across retry and aborts retry processing at the original TTL", async () => {
    const second = deferred();
    const harness = createHarness({
      transcribeImpl(input, callNumber) {
        if (callNumber === 1) throw makeLifecycleError("ASR_IN_PROGRESS", "same_blob_retryable");
        return second.promise;
      },
    });
    await recordFor(harness);
    const expiresAt = harness.controller.getSnapshot().expiresAt;
    harness.clock.tick(1_000);
    assert.equal(harness.controller.retry(), true);
    await settle();
    assert.equal(harness.controller.getSnapshot().expiresAt, expiresAt);
    const retrySignal = harness.requests[1].signal;

    harness.clock.tick(BLOB_TTL_MS - 1_000);
    await settle();
    assert.equal(retrySignal.aborted, true);
    assert.equal(retrySignal.reason, "blob_ttl_expired");
    assert.equal(harness.controller.getSnapshot().status, "error");
    assert.equal(harness.controller.getSnapshot().errorCode, "BLOB_TTL_EXPIRED");
    assert.equal(harness.controller.getSnapshot().hasRetainedBlob, false);

    second.resolve({
      requestId: "late",
      item: { transcript: "迟到文字", language: "zh-CN", durationMs: 500, source: "server_asr", replayed: false },
    });
    await settle();
    assert.deepEqual(harness.transcripts, []);
    assert.equal(harness.controller.getSnapshot().status, "error");
  });

  it("enforces Blob TTL from wall-clock time even when the scheduled timer is throttled", async () => {
    for (const outcome of ["resolve", "reject"]) {
      const pending = deferred();
      const harness = createHarness({ transcribeImpl: () => pending.promise });
      await recordFor(harness);
      const signal = harness.requests[0].signal;
      harness.clock.elapseWithoutTimers(BLOB_TTL_MS);
      if (outcome === "resolve") {
        pending.resolve({
          requestId: "late-success",
          item: {
            transcript: "过期结果",
            language: "zh-CN",
            durationMs: 500,
            source: "server_asr",
            replayed: false,
          },
        });
      } else {
        pending.reject(makeLifecycleError("ASR_TIMEOUT", "same_blob_retryable"));
      }
      await settle();
      assert.equal(signal.aborted, true, outcome);
      assert.equal(signal.reason, "blob_ttl_expired", outcome);
      assert.equal(harness.controller.getSnapshot().status, "error", outcome);
      assert.equal(harness.controller.getSnapshot().errorCode, "BLOB_TTL_EXPIRED", outcome);
      assert.deepEqual(harness.transcripts, [], outcome);
      assert.equal(harness.controller.getSnapshot().hasRetainedBlob, false, outcome);
    }
  });

  it("prioritizes wall-clock TTL expiry over retry exhaustion when timers are throttled", async () => {
    const harness = createHarness({
      transcribeImpl() { throw makeLifecycleError("ASR_TIMEOUT", "same_blob_retryable"); },
    });
    await recordFor(harness);
    assert.equal(harness.controller.getSnapshot().status, "retryable_error");
    harness.clock.elapseWithoutTimers(BLOB_TTL_MS);
    assert.equal(harness.controller.retry(), false);
    assert.equal(harness.controller.getSnapshot().errorCode, "BLOB_TTL_EXPIRED");
    assert.notEqual(harness.controller.getSnapshot().errorCode, "SAME_BLOB_RETRY_EXHAUSTED");
    assert.equal(harness.requests.length, 1);
  });

  it("releases immediately for the explicit non-retryable matrix", async () => {
    for (const code of ["INVALID_IDEMPOTENCY_KEY", "ASR_TRANSCRIPT_EMPTY", "IDEMPOTENCY_CONFLICT", "ASR_NOT_CONFIGURED"]) {
      const harness = createHarness({ transcribeImpl() { throw makeLifecycleError(code, "release_and_rerecord"); } });
      await recordFor(harness);
      assert.equal(harness.controller.getSnapshot().status, "error", code);
      assert.equal(harness.controller.getSnapshot().hasRetainedBlob, false, code);
      assert.equal(harness.controller.retry(), false, code);
    }
  });

  it("rate limiting releases immediately, uses a 300-second UI fallback, and never auto-retries", async () => {
    const harness = createHarness({
      transcribeImpl() { throw makeLifecycleError("ASR_RATE_LIMITED", "rate_limited", null); },
    });
    await recordFor(harness);
    assert.equal(harness.controller.getSnapshot().status, "rate_limited");
    assert.equal(harness.controller.getSnapshot().rateLimitCountdownSeconds, 300);
    assert.equal(harness.controller.getSnapshot().hasRetainedBlob, false);
    assert.equal(harness.controller.retry(), false);
    harness.clock.tick(299_000);
    assert.equal(harness.controller.getSnapshot().rateLimitCountdownSeconds, 1);
    assert.equal(harness.requests.length, 1);
    harness.clock.tick(1_000);
    assert.equal(harness.controller.getSnapshot().status, "idle");
    assert.equal(harness.requests.length, 1);
  });

  it("cancels rate-limit lifecycle timers and starts a fresh generation with a fresh key", async () => {
    const harness = createHarness({
      transcribeImpl(input, callNumber) {
        if (callNumber === 1) throw makeLifecycleError("ASR_RATE_LIMITED", "rate_limited", null);
        return {
          requestId: "fresh",
          item: {
            transcript: "新录音",
            language: "zh-CN",
            durationMs: input.durationMs,
            source: "server_asr",
            replayed: false,
          },
        };
      },
    });
    await recordFor(harness);
    const firstKey = harness.requests[0].idempotencyKey;
    assert.equal(harness.controller.getSnapshot().status, "rate_limited");
    assert.ok(harness.clock.pending() > 0);
    assert.equal(harness.controller.cancelCapture("panel_closed"), true);
    assert.equal(harness.controller.getSnapshot().status, "cancelled");
    assert.equal(harness.controller.getSnapshot().rateLimitCountdownSeconds, 0);
    assert.equal(harness.clock.pending(), 0);
    assert.equal(await harness.controller.startCapture(), true);
    harness.clock.tick(500);
    assert.equal(harness.controller.stopCapture(), true);
    await settle();
    assert.equal(harness.requests.length, 2);
    assert.notEqual(harness.requests[1].idempotencyKey, firstKey);
    assert.deepEqual(harness.transcripts, ["新录音"]);
  });

  it("honors valid retry countdown without triggering a request", async () => {
    const second = deferred();
    const harness = createHarness({
      transcribeImpl(input, callNumber) {
        if (callNumber === 1) throw makeLifecycleError("ASR_CAPACITY_EXCEEDED", "same_blob_retryable", 2);
        return second.promise;
      },
    });
    await recordFor(harness);
    assert.equal(harness.controller.getSnapshot().retryCountdownSeconds, 2);
    assert.equal(harness.controller.retry(), false);
    harness.clock.tick(2_000);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.controller.getSnapshot().retryCountdownSeconds, 0);
    assert.equal(harness.controller.retry(), true);
    await settle();
    assert.equal(harness.requests.length, 2);
  });

  it("invalidates an old processing generation before re-record and ignores its late success", async () => {
    const first = deferred();
    const harness = createHarness({
      transcribeImpl(input, callNumber) {
        if (callNumber === 1) return first.promise;
        return {
          requestId: "new",
          item: { transcript: "新录音", language: "zh-CN", durationMs: input.durationMs, source: "server_asr", replayed: false },
        };
      },
    });
    await recordFor(harness);
    const oldGeneration = harness.controller.getSnapshot().recordingGeneration;
    const oldSignal = harness.requests[0].signal;
    assert.equal(await harness.controller.startCapture(), true);
    assert.equal(oldSignal.aborted, true);
    assert.ok(harness.controller.getSnapshot().recordingGeneration > oldGeneration);
    harness.clock.tick(500);
    harness.controller.stopCapture();
    await settle();
    assert.deepEqual(harness.transcripts, ["新录音"]);

    first.resolve({
      requestId: "old",
      item: { transcript: "旧录音迟到", language: "zh-CN", durationMs: 500, source: "server_asr", replayed: false },
    });
    await settle();
    assert.deepEqual(harness.transcripts, ["新录音"]);
    assert.equal(harness.controller.getSnapshot().status, "succeeded");
  });

  it("ignores a late rejection from an invalidated processing generation", async () => {
    const first = deferred();
    const harness = createHarness({
      transcribeImpl(input, callNumber) {
        if (callNumber === 1) return first.promise;
        return {
          requestId: "new",
          item: { transcript: "新录音成功", language: "zh-CN", durationMs: input.durationMs, source: "server_asr", replayed: false },
        };
      },
    });
    await recordFor(harness);
    await harness.controller.startCapture();
    harness.clock.tick(500);
    harness.controller.stopCapture();
    await settle();
    assert.deepEqual(harness.transcripts, ["新录音成功"]);

    first.reject(makeLifecycleError("ASR_TIMEOUT", "same_blob_retryable", 1));
    await settle();
    assert.deepEqual(harness.transcripts, ["新录音成功"]);
    assert.equal(harness.controller.getSnapshot().status, "succeeded");
    assert.equal(harness.controller.getSnapshot().hasRetainedBlob, false);
  });

  it("fences processing resolve/reject across active, disabled, and logout render transitions", async () => {
    const transitions = [
      { patch: { active: false }, reason: "panel_closed" },
      { patch: { disabled: true }, reason: "disabled" },
      { patch: { sessionEpoch: 1 }, reason: "logout" },
    ];
    for (const { patch, reason } of transitions) {
      for (const outcome of ["resolve", "reject"]) {
        const pending = deferred();
        const harness = createHarness({ transcribeImpl: () => pending.promise });
        await recordFor(harness);
        const signal = harness.requests[0].signal;
        harness.controller.updateOptions(patch);
        assert.equal(harness.controller.getSnapshot().status, "processing");
        if (outcome === "resolve") {
          pending.resolve({
            requestId: `${reason}-late-success`,
            item: {
              transcript: "SHOULD_NOT_APPLY",
              language: "zh-CN",
              durationMs: 500,
              source: "server_asr",
              replayed: false,
            },
          });
        } else {
          pending.reject(makeLifecycleError("ASR_TIMEOUT", "same_blob_retryable"));
        }
        await settle();
        assert.deepEqual(harness.transcripts, [], `${reason}/${outcome}`);
        assert.equal(harness.controller.getSnapshot().status, "cancelled", `${reason}/${outcome}`);
        assert.equal(harness.controller.getSnapshot().errorCode, null, `${reason}/${outcome}`);
        assert.equal(harness.controller.getSnapshot().hasRetainedBlob, false, `${reason}/${outcome}`);
        assert.equal(signal.aborted, true, `${reason}/${outcome}`);
        assert.equal(signal.reason, reason, `${reason}/${outcome}`);
        assert.equal(harness.clock.pending(), 0, `${reason}/${outcome}`);
        assert.equal(harness.controller.getResourceDiagnosticsForTests().current, null);
        assert.deepEqual(harness.controller.getResourceDiagnosticsForTests().lastReleased, {
          chunkCount: 0,
          hasBlob: false,
          hasKey: false,
          hasRecorder: false,
          hasStream: false,
          hasSpeechRecognition: false,
          hasRequestController: false,
        });
        assert.equal(harness.controller.cancelCapture(reason), false, `${reason}/${outcome}/idempotent`);
      }
    }
  });

  it("cancels pagehide/unmount idempotently, aborts fetch, and ignores late callbacks", async () => {
    const pending = deferred();
    const harness = createHarness({ transcribeImpl: () => pending.promise });
    await recordFor(harness);
    const signal = harness.requests[0].signal;
    assert.equal(harness.controller.cancelCapture("pagehide"), true);
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, "pagehide");
    assert.equal(harness.controller.getSnapshot().status, "cancelled");
    assert.equal(harness.controller.cancelCapture("pagehide"), false);
    harness.controller.destroy("unmount");
    harness.controller.destroy("unmount");
    assert.equal(harness.tracks.every((track) => track.stopCalls === 1), true);
    pending.resolve({
      requestId: "late",
      item: { transcript: "迟到", language: "zh-CN", durationMs: 500, source: "server_asr", replayed: false },
    });
    await settle();
    assert.deepEqual(harness.transcripts, []);
    assert.equal(harness.clock.pending(), 0);
  });

  it("destroy then activate supports StrictMode-style recording and processing remounts", async () => {
    const oldPending = deferred();
    const harness = createHarness({
      transcribeImpl(input, callNumber) {
        if (callNumber === 1) return oldPending.promise;
        return {
          requestId: "after-remount",
          item: {
            transcript: "重新挂载成功",
            language: "zh-CN",
            durationMs: input.durationMs,
            source: "server_asr",
            replayed: false,
          },
        };
      },
    });

    assert.equal(await harness.controller.startCapture(), true);
    harness.controller.destroy("strict_cleanup_recording");
    assert.equal(harness.controller.getSnapshot().status, "cancelled");
    harness.controller.activate();
    assert.equal(await harness.controller.startCapture(), true);
    harness.clock.tick(500);
    harness.controller.stopCapture();
    await settle();
    assert.equal(harness.controller.getSnapshot().status, "processing");
    const oldSignal = harness.requests[0].signal;
    harness.controller.destroy("strict_cleanup_processing");
    assert.equal(oldSignal.aborted, true);
    harness.controller.activate();
    assert.equal(await harness.controller.startCapture(), true);
    harness.clock.tick(500);
    harness.controller.stopCapture();
    await settle();
    assert.deepEqual(harness.transcripts, ["重新挂载成功"]);

    oldPending.resolve({
      requestId: "stale",
      item: {
        transcript: "旧结果",
        language: "zh-CN",
        durationMs: 500,
        source: "server_asr",
        replayed: false,
      },
    });
    await settle();
    assert.deepEqual(harness.transcripts, ["重新挂载成功"]);
    assert.equal(harness.controller.getSnapshot().status, "succeeded");
  });

  it("cancels touch release while permission is pending and stops a late stream without starting a recorder", async () => {
    const permission = deferred();
    const harness = createHarness({
      permission: () => permission.promise,
    });
    const startPromise = harness.controller.startCapture();
    await settle();
    assert.equal(harness.controller.getSnapshot().status, "requesting_permission");
    assert.equal(harness.controller.cancelCapture("pointer_up_before_permission"), true);
    assert.equal(harness.controller.getSnapshot().status, "cancelled");

    const lateTrack = { stopCalls: 0, stop() { this.stopCalls += 1; } };
    const lateStream = { getTracks: () => [lateTrack] };
    permission.resolve(lateStream);
    assert.equal(await startPromise, false);
    await settle();
    assert.equal(lateTrack.stopCalls, 1);
    assert.equal(harness.recorderInstances.length, 0);
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.controller.getSnapshot().status, "cancelled");
  });

  it("maps permission denial, empty data, and sub-300ms recordings without uploading", async () => {
    const denied = createHarness({ permission: async () => { throw new DOMException("Denied", "NotAllowedError"); } });
    assert.equal(await denied.controller.startCapture(), false);
    assert.equal(denied.controller.getSnapshot().status, "error");
    assert.equal(denied.controller.getSnapshot().errorCode, "MICROPHONE_PERMISSION_DENIED");
    assert.equal(denied.requests.length, 0);

    const empty = createHarness({ chunks: [] });
    await recordFor(empty);
    assert.equal(empty.controller.getSnapshot().errorCode, "AUDIO_BODY_REQUIRED");
    assert.equal(empty.requests.length, 0);

    const short = createHarness();
    await recordFor(short, 299);
    assert.equal(short.controller.getSnapshot().errorCode, "AUDIO_TOO_SHORT");
    assert.equal(short.requests.length, 0);

    const oversized = createHarness({
      chunks: [{ size: 8 * 1024 * 1024 + 1, type: "audio/webm;codecs=opus" }],
    });
    await recordFor(oversized);
    assert.equal(oversized.controller.getSnapshot().errorCode, "AUDIO_TOO_LARGE");
    assert.equal(oversized.requests.length, 0);
  });

  it("automatically stops at the purpose maximum without inventing upload progress", async () => {
    const pending = deferred();
    const harness = createHarness({ transcribeImpl: () => pending.promise });
    await harness.controller.startCapture();
    harness.clock.tick(120_000);
    await settle();
    assert.equal(harness.recorderInstances[0].state, "inactive");
    assert.equal(harness.controller.getSnapshot().status, "processing");
    assert.equal(harness.controller.getSnapshot().statusText, "正在上传并转成文字");
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].durationMs, 120_000);
    assert.equal(harness.controller.stopCapture(), false);
    assert.equal(harness.requests.length, 1);
  });

  it("rejects a max timer that fires late instead of clamping and uploading an overlong recording", async () => {
    const harness = createHarness();
    assert.equal(await harness.controller.startCapture(), true);
    harness.clock.elapseWithoutTimers(123_000);
    harness.clock.flushDueTimersAtCurrent();
    await settle();
    assert.equal(harness.controller.getSnapshot().status, "error");
    assert.equal(harness.controller.getSnapshot().errorCode, "AUDIO_TOO_LONG");
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.clock.pending(), 0);
    assert.equal(harness.tracks.every((track) => track.stopCalls === 1), true);
    assert.deepEqual(harness.controller.getResourceDiagnosticsForTests().lastReleased, {
      chunkCount: 0,
      hasBlob: false,
      hasKey: false,
      hasRecorder: false,
      hasStream: false,
      hasSpeechRecognition: false,
      hasRequestController: false,
    });
  });

  it("waits for queued final data/onstop when recorder is already inactive and fixes duration at stop", async () => {
    const pending = deferred();
    const harness = createHarness({ transcribeImpl: () => pending.promise });
    assert.equal(await harness.controller.startCapture(), true);
    harness.clock.tick(500);
    const recorder = harness.recorderInstances[0];
    const queuedData = recorder.ondataavailable;
    const queuedStop = recorder.onstop;
    recorder.state = "inactive";

    assert.equal(harness.controller.stopCapture(), true);
    assert.equal(harness.controller.getSnapshot().status, "preparing");
    assert.equal(harness.requests.length, 0);
    harness.clock.elapseWithoutTimers(10_000);
    queuedData({ data: recorder.chunks[0] });
    queuedStop();
    await settle();

    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].durationMs, 500);
    assert.equal(harness.controller.getSnapshot().status, "processing");
    queuedStop();
    await settle();
    assert.equal(harness.requests.length, 1);
  });

  it("uses a bounded one-shot fallback if an inactive recorder loses onstop", async () => {
    const harness = createHarness();
    assert.equal(await harness.controller.startCapture(), true);
    harness.clock.tick(500);
    harness.recorderInstances[0].state = "inactive";
    assert.equal(harness.controller.stopCapture(), true);
    assert.equal(harness.controller.getSnapshot().status, "preparing");
    harness.clock.tick(999);
    assert.equal(harness.controller.getSnapshot().status, "preparing");
    harness.clock.tick(1);
    await settle();
    assert.equal(harness.controller.getSnapshot().status, "error");
    assert.equal(harness.controller.getSnapshot().errorCode, "AUDIO_BODY_REQUIRED");
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.clock.pending(), 0);
  });

  it("uses assistant purpose identity and its 60-second maximum even if mutable options request another purpose", async () => {
    const pending = deferred();
    const harness = createHarness({ purpose: "assistant_chat", transcribeImpl: () => pending.promise });
    assert.equal(harness.controller.getSnapshot().purpose, "assistant_chat");
    harness.controller.updateOptions({ purpose: "quick_record" });
    assert.equal(await harness.controller.startCapture(), true);
    harness.clock.tick(60_000);
    await settle();
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].purpose, "assistant_chat");
    assert.equal(harness.requests[0].durationMs, 60_000);
    assert.equal(harness.controller.getSnapshot().purpose, "assistant_chat");
  });

  it("fails closed while inactive or disabled and recovers without replacing the controller", async () => {
    const harness = createHarness();
    harness.controller.updateOptions({ active: false });
    assert.equal(await harness.controller.startCapture(), false);
    assert.equal(harness.controller.getSnapshot().status, "idle");
    assert.equal(harness.recorderInstances.length, 0);
    harness.controller.updateOptions({ active: true, disabled: true });
    assert.equal(await harness.controller.startCapture(), false);
    assert.equal(harness.recorderInstances.length, 0);
    harness.controller.updateOptions({ disabled: false });
    assert.equal(await harness.controller.startCapture(), true);
    assert.equal(harness.controller.getSnapshot().status, "recording");
    assert.equal(harness.controller.cancelCapture("test_cleanup"), true);
  });

  it("retains only retry resources and clears every owned reference on terminal outcomes", async () => {
    const retryHarness = createHarness({
      transcribeImpl() { throw makeLifecycleError("ASR_TIMEOUT", "same_blob_retryable"); },
    });
    await recordFor(retryHarness);
    assert.deepEqual(retryHarness.controller.getResourceDiagnosticsForTests().current, {
      chunkCount: 0,
      hasBlob: true,
      hasKey: true,
      hasRecorder: false,
      hasStream: false,
      hasSpeechRecognition: false,
      hasRequestController: false,
    });
    assert.equal(retryHarness.controller.retry(), true);
    await settle();
    assert.equal(retryHarness.controller.getSnapshot().status, "error");
    assert.equal(retryHarness.controller.getResourceDiagnosticsForTests().current, null);
    assert.deepEqual(retryHarness.controller.getResourceDiagnosticsForTests().lastReleased, {
      chunkCount: 0,
      hasBlob: false,
      hasKey: false,
      hasRecorder: false,
      hasStream: false,
      hasSpeechRecognition: false,
      hasRequestController: false,
    });

    const successHarness = createHarness();
    await recordFor(successHarness);
    assert.equal(successHarness.controller.getSnapshot().status, "succeeded");
    assert.deepEqual(
      successHarness.controller.getResourceDiagnosticsForTests().lastReleased,
      retryHarness.controller.getResourceDiagnosticsForTests().lastReleased,
    );
  });

  it("publishes Web Speech only as interim text and ignores its error", async () => {
    const recognitions = [];
    class FakeSpeechRecognition {
      constructor() { recognitions.push(this); }
      start() { this.started = true; }
      abort() { this.aborted = true; }
    }
    const pending = deferred();
    const harness = createHarness({ SpeechRecognitionImpl: FakeSpeechRecognition, transcribeImpl: () => pending.promise });
    await harness.controller.startCapture();
    recognitions[0].onresult({
      resultIndex: 0,
      results: [{ 0: { transcript: "浏览器临时文字" }, isFinal: false }],
    });
    recognitions[0].onerror(new Error("browser speech failed"));
    assert.deepEqual(harness.interim, ["浏览器临时文字"]);
    assert.equal(harness.controller.getSnapshot().status, "recording");
    harness.clock.tick(500);
    harness.controller.stopCapture();
    await settle();
    assert.equal(harness.controller.getSnapshot().status, "processing");
  });

  it("fences generation interim callbacks across disabled and logout render transitions", async () => {
    for (const patch of [{ disabled: true }, { sessionEpoch: 1 }]) {
      const recognitions = [];
      class FakeSpeechRecognition {
        constructor() { recognitions.push(this); }
        start() { this.started = true; }
        abort() { this.aborted = true; }
      }
      const harness = createHarness({ SpeechRecognitionImpl: FakeSpeechRecognition });
      assert.equal(await harness.controller.startCapture(), true);
      const lateInterim = recognitions[0].onresult;
      harness.controller.updateOptions(patch);
      lateInterim({
        resultIndex: 0,
        results: [{ 0: { transcript: "SHOULD_NOT_APPLY" }, isFinal: false }],
      });
      assert.deepEqual(harness.interim, []);
      assert.equal(harness.controller.getSnapshot().status, "cancelled");
      assert.equal(recognitions[0].aborted, true);
      assert.equal(harness.tracks.every((track) => track.stopCalls === 1), true);
      assert.equal(harness.clock.pending(), 0);
    }
  });

  it("offers Web Speech only as an explicit interim fallback when server capture is unsupported", async () => {
    const recognitions = [];
    const interim = [];
    let apiCalls = 0;
    class FakeSpeechRecognition {
      constructor() { recognitions.push(this); }
      start() { this.started = true; }
      abort() { this.aborted = true; }
    }
    const controller = createServerTranscriptionController({
      purpose: "assistant_chat",
      mediaDevices: {},
      MediaRecorderImpl: undefined,
      SpeechRecognitionImpl: FakeSpeechRecognition,
      apiClient: { async transcribeAudio() { apiCalls += 1; } },
      onInterimText(text) { interim.push(text); },
    });

    assert.equal(controller.getSnapshot().supported, false);
    assert.equal(controller.getSnapshot().browserInterimAvailable, true);
    assert.equal(await controller.startCapture(), false);
    assert.equal(controller.startBrowserInterim(), true);
    assert.equal(controller.getSnapshot().browserInterimActive, true);
    recognitions[0].onresult({
      resultIndex: 0,
      results: [{ 0: { transcript: "仅临时显示" }, isFinal: true }],
    });
    assert.deepEqual(interim, ["仅临时显示"]);
    assert.equal(controller.getSnapshot().interimText, "仅临时显示");
    assert.equal(apiCalls, 0);
    assert.equal(controller.stopBrowserInterim(), true);
    assert.equal(controller.getSnapshot().browserInterimActive, false);
    assert.equal(recognitions[0].aborted, true);

    controller.updateOptions({ active: false });
    assert.equal(controller.startBrowserInterim(), false);
    controller.updateOptions({ active: true, disabled: true });
    assert.equal(controller.startBrowserInterim(), false);
    controller.updateOptions({ disabled: false });
    assert.equal(controller.startBrowserInterim(), true);
    assert.equal(controller.stopBrowserInterim(), true);
  });
});
