import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, it } from "node:test";

import {
  ASR_SWEEP_RESIDUAL_PATHS,
  createUploadCapacity,
  createWorkspace,
  prepareTempRoot,
  removeWorkspaceAndVerify,
  sweepTempRoot,
  writeAudioBody,
} from "../src/asr/audioBody.js";
import { createAsrService, createProcessingCapacity } from "../src/asr/asrService.js";
import { AsrContractError } from "../src/asr/contracts.js";
import {
  createAsrFingerprint,
  createAsrIdempotencyCache,
} from "../src/asr/idempotencyCache.js";
import { createAsrMetrics } from "../src/asr/metrics.js";
import {
  createCanonicalWavHeader,
  createCanonicalWavPlaceholder,
  ffmpegArguments,
  ffprobeArguments,
  probeAudio,
  terminateMediaChild,
  transcodeToCanonicalWav,
  validateCanonicalWavHeader,
} from "../src/asr/mediaTools.js";
import { createOpenAiCompatibleProvider } from "../src/asr/providers/openAiCompatible.js";

const HMAC_FIXTURE = ["synthetic", "session", "material", "for", "tests"].join("-");
const WAV_MAGIC = Buffer.from("524946460000000057415645", "hex");
const TEST_LIFECYCLE_BUDGET_MS = 500;
const TEST_CONDITION_TIMEOUT_MS = 2_000;

async function waitForCondition(predicate, message, {
  timeoutMs = TEST_CONDITION_TIMEOUT_MS,
  intervalMs = 5,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function manualFirstTimeout() {
  const manualTimer = Object.freeze({ kind: "manual-first-timeout" });
  let captured = false;
  let callback = null;
  return Object.freeze({
    setTimeoutImpl(nextCallback, milliseconds) {
      if (!captured) {
        captured = true;
        callback = nextCallback;
        return manualTimer;
      }
      return setTimeout(nextCallback, milliseconds);
    },
    clearTimeoutImpl(timer) {
      if (timer !== manualTimer) clearTimeout(timer);
    },
    fire() {
      assert.equal(typeof callback, "function", "operation deadline timer was not registered");
      const nextCallback = callback;
      callback = null;
      nextCallback();
    },
  });
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "sentelligent-asr-b-"));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function fakeChild({
  stdoutChunks = [],
  stderrChunks = [],
  code = 0,
  stayAlive = false,
  asyncError = null,
  exitOnTerm = true,
  exitOnKill = true,
} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  let exited = false;
  const finish = (exitCode, signalCode) => {
    if (exited) return;
    exited = true;
    child.exitCode = exitCode;
    child.signalCode = signalCode;
    child.emit("exit", exitCode, signalCode);
    child.emit("close", exitCode, signalCode);
  };
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if ((signal === "SIGTERM" && exitOnTerm) || (signal === "SIGKILL" && exitOnKill)) {
      queueMicrotask(() => finish(null, signal));
    }
    return true;
  };
  queueMicrotask(() => {
    if (asyncError) {
      child.stdout.end();
      child.stderr.end();
      child.emit("error", asyncError);
      return;
    }
    for (const chunk of stdoutChunks) child.stdout.write(chunk);
    for (const chunk of stderrChunks) child.stderr.write(chunk);
    child.stdout.end();
    child.stderr.end();
    if (!stayAlive) finish(code, null);
  });
  return child;
}

function validProbeJson(overrides = {}) {
  return JSON.stringify({
    format: { format_name: "wav", duration: "1.000", ...(overrides.format ?? {}) },
    streams: [{
      index: 0,
      codec_type: "audio",
      codec_name: "pcm_s16le",
      channels: 1,
      sample_rate: "16000",
      ...(overrides.stream ?? {}),
    }],
  });
}

function expectCode(code, status) {
  return (error) => {
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

describe("ASR five-minute HMAC idempotency cache", () => {
  function fingerprint(seed = "a", durationMs = 1_000) {
    return createAsrFingerprint({
      purpose: "quick_record",
      mediaType: "audio/wav",
      audioSha256: seed.repeat(64),
      durationMs,
    });
  }

  it("isolates the same key and fingerprint by HMAC owner scope", () => {
    const cache = createAsrIdempotencyCache({ secret: HMAC_FIXTURE, randomId: () => "token" });
    const a = cache.claim({ owner: "owner-a", key: "asr:synthetic-key-0001", fingerprint: fingerprint() });
    const b = cache.claim({ owner: "owner-b", key: "asr:synthetic-key-0001", fingerprint: fingerprint() });
    assert.equal(a.kind, "claimed");
    assert.equal(b.kind, "claimed");
    assert.notEqual(a.digest, b.digest);
    assert.deepEqual(cache.snapshot(), { pending: 2, completed: 0, capacity: 256, ttlMs: 300_000 });
  });

  it("returns IN_PROGRESS for same pending fingerprint and CONFLICT for different fingerprint", () => {
    const cache = createAsrIdempotencyCache({ secret: HMAC_FIXTURE });
    const scope = { owner: "owner-a", key: "asr:synthetic-key-0002" };
    cache.claim({ ...scope, fingerprint: fingerprint("a") });
    assert.throws(() => cache.claim({ ...scope, fingerprint: fingerprint("a") }), expectCode("ASR_IN_PROGRESS", 409));
    assert.throws(() => cache.claim({ ...scope, fingerprint: fingerprint("b") }), expectCode("IDEMPOTENCY_CONFLICT", 409));
    assert.equal(cache.snapshot().pending, 1);
  });

  it("replays same completed fingerprint and preserves completed entry on conflict", () => {
    const cache = createAsrIdempotencyCache({ secret: HMAC_FIXTURE });
    const scope = { owner: "owner-a", key: "asr:synthetic-key-0003" };
    const claim = cache.claim({ ...scope, fingerprint: fingerprint("a") });
    assert.equal(cache.complete(claim, { transcript: "合成结果" }), true);
    assert.deepEqual(cache.claim({ ...scope, fingerprint: fingerprint("a") }), {
      kind: "replay",
      digest: claim.digest,
      value: { transcript: "合成结果" },
    });
    assert.throws(() => cache.claim({ ...scope, fingerprint: fingerprint("b") }), expectCode("IDEMPOTENCY_CONFLICT"));
    assert.equal(cache.snapshot().completed, 1);
  });

  it("releases failed reservations so the exact request can be claimed again", () => {
    const cache = createAsrIdempotencyCache({ secret: HMAC_FIXTURE });
    const scope = { owner: "owner-a", key: "asr:synthetic-key-0004", fingerprint: fingerprint() };
    const first = cache.claim(scope);
    assert.equal(cache.release(first), true);
    assert.equal(cache.release(first), false);
    assert.equal(cache.claim(scope).kind, "claimed");
  });

  it("binds complete/release to the exact scoped claim despite deterministic token collision", () => {
    const cache = createAsrIdempotencyCache({
      secret: HMAC_FIXTURE,
      randomId: () => "same-deterministic-token",
    });
    const aScope = { owner: "owner-a", key: "asr:synthetic-key-0005", fingerprint: fingerprint("a") };
    const bScope = { owner: "owner-b", key: "asr:synthetic-key-0005", fingerprint: fingerprint("b") };
    const a = cache.claim(aScope);
    const b = cache.claim(bScope);
    assert.equal(cache.complete(b, { transcript: "owner-b-result" }), true);
    assert.throws(() => cache.claim(aScope), expectCode("ASR_IN_PROGRESS"));
    assert.deepEqual(cache.claim(bScope).value, { transcript: "owner-b-result" });
    assert.equal(cache.release(a), true);
    assert.deepEqual(cache.snapshot(), { pending: 0, completed: 1, capacity: 256, ttlMs: 300_000 });
  });

  it("expires completed entries at five minutes and accepts a fresh claim", () => {
    let now = 0;
    const cache = createAsrIdempotencyCache({ secret: HMAC_FIXTURE, now: () => now });
    const scope = { owner: "owner", key: "asr:synthetic-key-0006", fingerprint: fingerprint() };
    const claim = cache.claim(scope);
    cache.complete(claim, { transcript: "old" });
    now = 299_999;
    assert.equal(cache.claim(scope).kind, "replay");
    now = 300_000;
    assert.equal(cache.claim(scope).kind, "claimed");
  });

  it("evicts least-recently-used completed entries but never pending entries", () => {
    const cache = createAsrIdempotencyCache({ secret: HMAC_FIXTURE, capacity: 1 });
    const pendingScope = { owner: "owner", key: "asr:synthetic-pending", fingerprint: fingerprint("a") };
    cache.claim(pendingScope);
    for (const [key, seed] of [["asr:synthetic-done-01", "b"], ["asr:synthetic-done-02", "c"]]) {
      const scope = { owner: "owner", key, fingerprint: fingerprint(seed) };
      const claim = cache.claim(scope);
      cache.complete(claim, { transcript: seed });
    }
    assert.throws(() => cache.claim(pendingScope), expectCode("ASR_IN_PROGRESS"));
    assert.deepEqual(cache.snapshot(), { pending: 1, completed: 1, capacity: 1, ttlMs: 300_000 });
  });

  it("stores neither raw owner nor raw key in its aggregate snapshot", () => {
    const cache = createAsrIdempotencyCache({ secret: HMAC_FIXTURE });
    cache.claim({ owner: "raw-owner-forbidden", key: "raw-key-forbidden-0001", fingerprint: fingerprint() });
    const serialized = JSON.stringify(cache.snapshot());
    assert.equal(serialized.includes("raw-owner-forbidden"), false);
    assert.equal(serialized.includes("raw-key-forbidden"), false);
  });
});

describe("ASR active-upload and temporary-byte reservations", () => {
  it("allows active uploads 1..4 and rejects the fifth without queueing", () => {
    const capacity = createUploadCapacity();
    const reservations = Array.from({ length: 4 }, () => capacity.acquire(null));
    assert.deepEqual(capacity.snapshot(), {
      activeUploads: 4,
      tempBytes: 0,
      activeUploadsMax: 4,
      aggregateTempMaxBytes: 33_554_432,
    });
    assert.throws(() => capacity.acquire(null), expectCode("ASR_CAPACITY_EXCEEDED", 429));
    for (const reservation of reservations) reservation.abort();
    assert.equal(capacity.snapshot().activeUploads, 0);
  });

  it("reserves exact known lengths atomically through 32 MiB and releases exactly", () => {
    const deltas = [];
    const capacity = createUploadCapacity({ onTempBytesChange: (delta) => deltas.push(delta) });
    const reservations = Array.from({ length: 4 }, () => capacity.acquire(8_388_608));
    assert.equal(capacity.snapshot().tempBytes, 33_554_432);
    assert.throws(() => capacity.acquire(1), expectCode("ASR_CAPACITY_EXCEEDED"));
    for (const reservation of reservations) reservation.abort();
    assert.equal(capacity.snapshot().tempBytes, 0);
    assert.equal(deltas.reduce((sum, value) => sum + value, 0), 0);
  });

  it("reserves unknown-length chunks atomically and rejects aggregate byte +1", () => {
    const capacity = createUploadCapacity({ aggregateTempMaxBytes: 8 });
    const reservation = capacity.acquire(null);
    reservation.reserveChunk(8);
    assert.throws(() => reservation.reserveChunk(1), expectCode("ASR_CAPACITY_EXCEEDED"));
    reservation.abort();
    assert.deepEqual(capacity.snapshot(), {
      activeUploads: 0,
      tempBytes: 0,
      activeUploadsMax: 4,
      aggregateTempMaxBytes: 8,
    });
  });

  it("returns unused known reservation at upload finish and retains actual bytes until cleanup", () => {
    const capacity = createUploadCapacity({ aggregateTempMaxBytes: 100 });
    const reservation = capacity.acquire(100);
    reservation.reserveChunk(10);
    reservation.finishUpload(10);
    assert.deepEqual(capacity.snapshot(), {
      activeUploads: 0,
      tempBytes: 10,
      activeUploadsMax: 4,
      aggregateTempMaxBytes: 100,
    });
    reservation.releaseTemp();
    assert.equal(capacity.snapshot().tempBytes, 0);
  });

  it("enforces owner=1 and global=2 processing without a wait queue", () => {
    const capacity = createProcessingCapacity();
    const a = capacity.acquire("owner-a");
    assert.throws(() => capacity.acquire("owner-a"), expectCode("ASR_CAPACITY_EXCEEDED"));
    const b = capacity.acquire("owner-b");
    assert.throws(() => capacity.acquire("owner-c"), expectCode("ASR_CAPACITY_EXCEEDED"));
    a.release();
    b.release();
    assert.equal(capacity.snapshot().globalActive, 0);
  });
});

describe("ASR raw-body streaming, hashing, limits, and aborts", () => {
  async function upload(t, chunks, options = {}) {
    const root = await tempRoot(t);
    const workspace = await createWorkspace(root);
    const outputPath = join(workspace, "input.audio");
    const capacity = createUploadCapacity({ aggregateTempMaxBytes: options.aggregateMax ?? 33_554_432 });
    const reservation = capacity.acquire(options.contentLength ?? null);
    try {
      const result = await writeAudioBody({
        readable: Readable.from(chunks),
        outputPath,
        reservation,
        maxBytes: options.maxBytes ?? 8_388_608,
        wallTimeoutMs: options.wallTimeoutMs ?? 60_000,
        idleTimeoutMs: options.idleTimeoutMs ?? 15_000,
      });
      return { result, outputPath, workspace, reservation, capacity };
    } catch (error) {
      error.syntheticState = { outputPath, workspace, reservation, capacity };
      throw error;
    }
  }

  it("rejects an empty raw body and releases upload/temp reservations", async (t) => {
    await assert.rejects(upload(t, []), (error) => {
      assert.equal(error.code, "AUDIO_BODY_REQUIRED");
      assert.deepEqual(error.syntheticState.capacity.snapshot(), {
        activeUploads: 0,
        tempBytes: 0,
        activeUploadsMax: 4,
        aggregateTempMaxBytes: 33_554_432,
      });
      return true;
    });
  });

  it("accepts one byte, computes SHA-256/magic, fsyncs/closes, and creates exact 0600", async (t) => {
    const state = await upload(t, [Buffer.of(0x41)]);
    assert.equal(state.result.byteLength, 1);
    assert.equal(state.result.sha256, "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd");
    assert.deepEqual([...state.result.magicBytes], [0x41]);
    const stat = await fs.lstat(state.outputPath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.size, 1);
    state.reservation.releaseTemp();
    assert.equal(state.capacity.snapshot().tempBytes, 0);
  });

  it("accepts exactly 8 MiB without whole-file aggregation", async (t) => {
    const bytes = Buffer.alloc(8_388_608, 0x5a);
    const state = await upload(t, [bytes], { contentLength: bytes.length });
    assert.equal(state.result.byteLength, 8_388_608);
    assert.equal((await fs.lstat(state.outputPath)).size, 8_388_608);
    state.reservation.releaseTemp();
  });

  it("rejects 8 MiB+1 at the overflow chunk and never writes that chunk", async (t) => {
    const allowed = Buffer.alloc(8_388_608, 0x5a);
    await assert.rejects(upload(t, [allowed, Buffer.of(0x01)]), (error) => {
      assert.equal(error.code, "AUDIO_TOO_LARGE");
      assert.equal(error.status, 413);
      assert.deepEqual(error.syntheticState.capacity.snapshot().tempBytes, 0);
      return true;
    });
  });

  it("rejects a small synthetic chunked max+1 at the first extra byte", async (t) => {
    await assert.rejects(upload(t, [Buffer.alloc(8), Buffer.of(1)], { maxBytes: 8 }), (error) => {
      assert.equal(error.code, "AUDIO_TOO_LARGE");
      return true;
    });
  });

  it("fails an already-aborted signal before open and releases its capacity", async () => {
    const capacity = createUploadCapacity();
    const reservation = capacity.acquire(1);
    const controller = new AbortController();
    controller.abort(new DOMException("synthetic cancel", "AbortError"));
    let openCalls = 0;
    await assert.rejects(writeAudioBody({
      readable: Readable.from([Buffer.of(1)]),
      outputPath: "/synthetic/must-not-open",
      reservation,
      signal: controller.signal,
      openFile: async () => { openCalls += 1; },
    }), (error) => error.name === "AbortError");
    assert.equal(openCalls, 0);
    assert.equal(capacity.snapshot().activeUploads, 0);
    assert.equal(capacity.snapshot().tempBytes, 0);
  });

  it("preserves AUDIO_TOO_LARGE for a real chunked IncomingMessage max+1", async (t) => {
    const root = await tempRoot(t);
    const capacity = createUploadCapacity();
    let serverError = null;
    const server = createServer(async (req, res) => {
      try {
        await writeAudioBody({
          readable: req,
          outputPath: join(root, "incoming-overflow.audio"),
          reservation: capacity.acquire(null),
          maxBytes: 8,
          wallTimeoutMs: 1_000,
          idleTimeoutMs: 1_000,
        });
        res.statusCode = 204;
        res.end();
      } catch (error) {
        serverError = error;
        res.statusCode = error.status ?? 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ code: error.code ?? "ASR_INTERNAL_ERROR" }));
      }
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/synthetic-overflow",
        headers: { "Transfer-Encoding": "chunked", Connection: "close" },
      });
      request.once("error", reject);
      request.once("response", (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => { body += chunk; });
        incoming.once("end", () => resolve({ status: incoming.statusCode, body }));
      });
      request.write(Buffer.alloc(8, 0x41));
      setTimeout(() => request.end(Buffer.of(0x42)), 10);
    });
    assert.equal(serverError?.code, "AUDIO_TOO_LARGE");
    assert.equal(serverError?.status, 413);
    assert.deepEqual(response, {
      status: 413,
      body: JSON.stringify({ code: "AUDIO_TOO_LARGE" }),
    });
    assert.equal(capacity.snapshot().activeUploads, 0);
    assert.equal(capacity.snapshot().tempBytes, 0);
  });

  it("preserves ASR_TIMEOUT for a stalled real IncomingMessage idle deadline", async (t) => {
    const root = await tempRoot(t);
    const capacity = createUploadCapacity();
    let serverError = null;
    const server = createServer(async (req, res) => {
      try {
        await writeAudioBody({
          readable: req,
          outputPath: join(root, "incoming-idle.audio"),
          reservation: capacity.acquire(null),
          maxBytes: 8,
          wallTimeoutMs: 1_000,
          idleTimeoutMs: 20,
          cleanupTimeoutMs: 100,
        });
        res.statusCode = 204;
        res.end();
      } catch (error) {
        serverError = error;
        res.statusCode = error.status ?? 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ code: error.code ?? "ASR_INTERNAL_ERROR" }));
      }
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const response = await new Promise((resolve, reject) => {
      let receivedResponse = false;
      const request = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/synthetic-idle",
        headers: { "Transfer-Encoding": "chunked", Connection: "close" },
      });
      request.once("error", (error) => {
        if (!receivedResponse) reject(error);
      });
      request.once("response", (incoming) => {
        receivedResponse = true;
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => { body += chunk; });
        incoming.once("end", () => resolve({ status: incoming.statusCode, body }));
      });
      request.write(Buffer.of(0x41));
    });
    assert.equal(serverError?.code, "ASR_TIMEOUT");
    assert.equal(serverError?.status, 504);
    assert.deepEqual(response, {
      status: 504,
      body: JSON.stringify({ code: "ASR_TIMEOUT" }),
    });
    assert.equal(capacity.snapshot().activeUploads, 0);
    assert.equal(capacity.snapshot().tempBytes, 0);
  });

  it("maps a wall/idle stall to ASR_TIMEOUT and closes/releases resources", async (t) => {
    const root = await tempRoot(t);
    const workspace = await createWorkspace(root);
    const capacity = createUploadCapacity();
    const reservation = capacity.acquire(null);
    const stalled = new PassThrough();
    await assert.rejects(writeAudioBody({
      readable: stalled,
      outputPath: join(workspace, "input.audio"),
      reservation,
      wallTimeoutMs: 20,
      idleTimeoutMs: 10,
    }), expectCode("ASR_TIMEOUT", 504));
    assert.equal(capacity.snapshot().activeUploads, 0);
    assert.equal(capacity.snapshot().tempBytes, 0);
  });

  it("propagates client abort without converting it to a provider/transcode error", async (t) => {
    const root = await tempRoot(t);
    const workspace = await createWorkspace(root);
    const capacity = createUploadCapacity();
    const reservation = capacity.acquire(null);
    const body = new PassThrough();
    const controller = new AbortController();
    const pending = writeAudioBody({
      readable: body,
      outputPath: join(workspace, "input.audio"),
      reservation,
      signal: controller.signal,
    });
    const pendingRejected = assert.rejects(pending, (error) => error.name === "AbortError");
    body.write(Buffer.of(1));
    controller.abort(new DOMException("synthetic cancel", "AbortError"));
    await pendingRejected;
    assert.equal(capacity.snapshot().activeUploads, 0);
    assert.equal(capacity.snapshot().tempBytes, 0);
  });

  it("bounds a never-settling upload open and releases capacity at the wall deadline", async (t) => {
    const root = await tempRoot(t);
    const capacity = createUploadCapacity();
    const reservation = capacity.acquire(null);
    await assert.rejects(writeAudioBody({
      readable: Readable.from([Buffer.of(1)]),
      outputPath: join(root, "never-open.audio"),
      reservation,
      openFile: async () => new Promise(() => {}),
      wallTimeoutMs: 10,
      idleTimeoutMs: 1_000,
      cleanupTimeoutMs: 10,
    }), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.equal(capacity.snapshot().activeUploads, 0);
    assert.equal(capacity.snapshot().tempBytes, 0);
  });

  it("lets caller abort bound a never-settling upload open", async (t) => {
    const root = await tempRoot(t);
    const reservation = createUploadCapacity().acquire(null);
    const controller = new AbortController();
    const pending = writeAudioBody({
      readable: new PassThrough(),
      outputPath: join(root, "abort-open.audio"),
      reservation,
      signal: controller.signal,
      openFile: async () => new Promise(() => {}),
      wallTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      cleanupTimeoutMs: 10,
    });
    const pendingRejected = assert.rejects(pending, expectCode("ASR_CLEANUP_FAILED", 503));
    controller.abort(new DOMException("synthetic open cancel", "AbortError"));
    await pendingRejected;
    assert.equal(reservation.snapshot().released, true);
  });

  it("closes a file handle that resolves after the upload deadline", async (t) => {
    const root = await tempRoot(t);
    const outputPath = join(root, "late-open.audio");
    const realHandle = await fs.open(outputPath, "wx", 0o600);
    let resolveOpen;
    let closeCalls = 0;
    const lifecycles = [];
    const reservation = createUploadCapacity().acquire(null);
    const pending = writeAudioBody({
      readable: Readable.from([Buffer.of(1)]),
      outputPath,
      reservation,
      openFile: async () => new Promise((resolve) => { resolveOpen = resolve; }),
      wallTimeoutMs: 10,
      idleTimeoutMs: 1_000,
      cleanupTimeoutMs: 100,
      onLateResourceLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    });
    const rejection = assert.rejects(pending, expectCode("ASR_TIMEOUT", 504));
    await waitForCondition(() => typeof resolveOpen === "function", "late upload open did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveOpen({ close: async () => { closeCalls += 1; await realHandle.close(); } });
    await rejection;
    assert.equal(closeCalls, 1);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(await Promise.allSettled(lifecycles), [{ status: "fulfilled", value: undefined }]);
    await assert.rejects(realHandle.stat(), (error) => error.code === "EBADF");
  });

  it("surfaces a rejecting late upload handle close as cleanup failure", async (t) => {
    const root = await tempRoot(t);
    const outputPath = join(root, "late-open-reject.audio");
    const realHandle = await fs.open(outputPath, "wx", 0o600);
    let resolveOpen;
    let closeCalls = 0;
    const lifecycles = [];
    const pending = writeAudioBody({
      readable: Readable.from([Buffer.of(1)]),
      outputPath,
      reservation: createUploadCapacity().acquire(null),
      openFile: async () => new Promise((resolve) => { resolveOpen = resolve; }),
      wallTimeoutMs: 10,
      idleTimeoutMs: 1_000,
      cleanupTimeoutMs: 100,
      onLateResourceLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    });
    const rejection = assert.rejects(pending, expectCode("ASR_CLEANUP_FAILED", 503));
    await waitForCondition(() => typeof resolveOpen === "function", "rejecting upload open did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveOpen({
      close: async () => { closeCalls += 1; throw new Error("synthetic late close rejection"); },
    });
    await rejection;
    assert.equal(closeCalls, 1);
    assert.equal(lifecycles.length, 1);
    assert.equal((await Promise.allSettled(lifecycles))[0].status, "rejected");
    await realHandle.close();
  });

  it("bounds and tracks a late upload handle close that never settles", async (t) => {
    const root = await tempRoot(t);
    const outputPath = join(root, "late-open-never.audio");
    const realHandle = await fs.open(outputPath, "wx", 0o600);
    let resolveOpen;
    let closeCalls = 0;
    const lifecycles = [];
    const pending = writeAudioBody({
      readable: Readable.from([Buffer.of(1)]),
      outputPath,
      reservation: createUploadCapacity().acquire(null),
      openFile: async () => new Promise((resolve) => { resolveOpen = resolve; }),
      wallTimeoutMs: 10,
      idleTimeoutMs: 1_000,
      cleanupTimeoutMs: 20,
      onLateResourceLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    });
    const rejection = assert.rejects(pending, expectCode("ASR_CLEANUP_FAILED", 503));
    await waitForCondition(() => typeof resolveOpen === "function", "never-closing upload open did not start");
    await new Promise((resolve) => setTimeout(resolve, 15));
    resolveOpen({ close: async () => { closeCalls += 1; return new Promise(() => {}); } });
    await rejection;
    assert.equal(closeCalls, 1);
    assert.equal(lifecycles.length, 1);
    await realHandle.close();
  });

  it("bounds a never-settling upload sync and closes the accepted handle", async (t) => {
    const root = await tempRoot(t);
    const outputPath = join(root, "never-sync.audio");
    const realHandle = await fs.open(outputPath, "wx", 0o600);
    let closeCalls = 0;
    const wrappedHandle = {
      stat: (...args) => realHandle.stat(...args),
      createWriteStream: (...args) => realHandle.createWriteStream(...args),
      sync: async () => new Promise(() => {}),
      close: async () => { closeCalls += 1; return realHandle.close(); },
    };
    await assert.rejects(writeAudioBody({
      readable: Readable.from([Buffer.of(1)]),
      outputPath,
      reservation: createUploadCapacity().acquire(null),
      openFile: async () => wrappedHandle,
      wallTimeoutMs: 10,
      idleTimeoutMs: 1_000,
      cleanupTimeoutMs: 50,
    }), expectCode("ASR_TIMEOUT", 504));
    assert.equal(closeCalls, 1);
  });

  it("returns cleanup failure instead of hanging on an upload close that never settles", async (t) => {
    const root = await tempRoot(t);
    const outputPath = join(root, "never-close.audio");
    const realHandle = await fs.open(outputPath, "wx", 0o600);
    let closeCalls = 0;
    const wrappedHandle = {
      stat: (...args) => realHandle.stat(...args),
      createWriteStream: (...args) => realHandle.createWriteStream(...args),
      sync: (...args) => realHandle.sync(...args),
      close: async () => { closeCalls += 1; return new Promise(() => {}); },
    };
    await assert.rejects(writeAudioBody({
      readable: Readable.from([Buffer.of(1)]),
      outputPath,
      reservation: createUploadCapacity().acquire(null),
      openFile: async () => wrappedHandle,
      wallTimeoutMs: 10,
      idleTimeoutMs: 1_000,
      cleanupTimeoutMs: 10,
    }), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.equal(closeCalls, 1);
    await realHandle.close();
  });

  it("contains no whole-audio readFile or Buffer.concat implementation", async () => {
    for (const path of [
      new URL("../src/asr/audioBody.js", import.meta.url),
      new URL("../src/asr/mediaTools.js", import.meta.url),
      new URL("../src/asr/providers/openAiCompatible.js", import.meta.url),
    ]) {
      const source = await fs.readFile(path, "utf8");
      assert.equal(/\breadFile(?:Sync)?\s*\(/u.test(source), false);
      assert.equal(/\bBuffer\.concat\s*\(/u.test(source), false);
    }
  });
});

describe("ASR protected workspace and stale sweeping", () => {
  it("creates the temp root/workspace as exact 0700", async (t) => {
    const parent = await tempRoot(t);
    const root = join(parent, "runtime");
    await prepareTempRoot(root);
    assert.equal((await fs.lstat(root)).mode & 0o777, 0o700);
    const workspace = await createWorkspace(root);
    assert.equal((await fs.lstat(workspace)).mode & 0o777, 0o700);
    assert.equal(dirname(workspace), root);
    assert.match(basename(workspace), /^request-/u);
  });

  it("rejects a symlink, wrong owner, or non-0700 temp root", async (t) => {
    const parent = await tempRoot(t);
    const target = join(parent, "target");
    const symlink = join(parent, "runtime-link");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, symlink);
    await assert.rejects(prepareTempRoot(symlink), expectCode("ASR_NOT_CONFIGURED", 503));
    await assert.rejects(prepareTempRoot(target, { currentUid: (process.getuid?.() ?? 0) + 1 }), expectCode("ASR_NOT_CONFIGURED"));
    await fs.chmod(target, 0o750);
    await assert.rejects(prepareTempRoot(target), expectCode("ASR_NOT_CONFIGURED"));
  });

  it("removes its newly created workspace when chmod verification setup fails", async (t) => {
    const root = await tempRoot(t);
    let created = null;
    const fsImpl = {
      lstat: fs.lstat,
      mkdir: fs.mkdir,
      mkdtemp: async (...args) => { created = await fs.mkdtemp(...args); return created; },
      chmod: async (path, mode) => {
        if (basename(path).startsWith("request-")) throw new Error("synthetic chmod failure");
        return fs.chmod(path, mode);
      },
      rm: fs.rm,
    };
    await assert.rejects(createWorkspace(root, { fsImpl }), /synthetic chmod failure/);
    await assert.rejects(fs.lstat(created), (error) => error.code === "ENOENT");
  });

  it("validates explicit workspace cleanup ownership before materialization", async (t) => {
    const root = await tempRoot(t);
    await assert.rejects(
      createWorkspace(root, { cleanupOnFailure: "external" }),
      /cleanupOnFailure must be a boolean/u,
    );
    assert.deepEqual(await fs.readdir(root), []);
  });

  it("retries cleanup, verifies ENOENT, and does not use an unref sleep", async (t) => {
    const root = await tempRoot(t);
    const workspace = await createWorkspace(root);
    await fs.writeFile(join(workspace, "input.audio"), "synthetic", { mode: 0o600 });
    let rmCalls = 0;
    let sleepCalls = 0;
    const fsImpl = {
      lstat: fs.lstat,
      rm: async (...args) => {
        rmCalls += 1;
        if (rmCalls === 1) throw new Error("synthetic transient cleanup error");
        return fs.rm(...args);
      },
    };
    assert.equal(await removeWorkspaceAndVerify(workspace, {
      fsImpl,
      attempts: [0, 1],
      sleepImpl: async () => { sleepCalls += 1; },
    }), true);
    assert.equal(rmCalls, 2);
    assert.equal(sleepCalls, 1);
    await assert.rejects(fs.lstat(workspace), (error) => error.code === "ENOENT");
  });

  it("startup sweep removes every valid request directory regardless of age", async (t) => {
    const root = await tempRoot(t);
    for (const name of ["request-abcdef", "request-ghijkl"]) {
      await fs.mkdir(join(root, name), { mode: 0o700 });
      await fs.chmod(join(root, name), 0o700);
    }
    const result = await sweepTempRoot(root, { mode: "startup", cleanupOptions: { attempts: [0] } });
    assert.deepEqual(result, {
      ready: true,
      removedCount: 2,
      staleCount: 2,
      anomalyCount: 0,
      residualDirectoryCount: 0,
    });
    assert.deepEqual(await fs.readdir(root), []);
  });

  it("startup sweep leaves symlink/nonmatching entries and degrades readiness", async (t) => {
    const root = await tempRoot(t);
    const outside = join(dirname(root), `${basename(root)}-outside`);
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, join(root, "request-abcdef"));
    await fs.writeFile(join(root, "unexpected"), "synthetic");
    const result = await sweepTempRoot(root, { mode: "startup", cleanupOptions: { attempts: [0] } });
    assert.deepEqual(result, {
      ready: false,
      removedCount: 0,
      staleCount: 0,
      anomalyCount: 2,
      residualDirectoryCount: 0,
    });
    assert.equal((await fs.lstat(join(root, "request-abcdef"))).isSymbolicLink(), true);
    assert.equal((await fs.lstat(outside)).isDirectory(), true);
  });

  for (const directoryCount of [1, 2]) {
    it(`counts ${directoryCount} failed stale-directory removal${directoryCount === 1 ? "" : "s"} once each`, async (t) => {
      const root = await tempRoot(t);
      for (let index = 0; index < directoryCount; index += 1) {
        const workspace = join(root, `request-failed${index}`);
        await fs.mkdir(workspace, { mode: 0o700 });
        await fs.chmod(workspace, 0o700);
      }
      const result = await sweepTempRoot(root, {
        mode: "startup",
        fsImpl: {
          ...fs,
          rm: async () => { throw new Error("synthetic stale removal failure"); },
        },
        cleanupOptions: { attempts: [0] },
      });
      assert.deepEqual(result, {
        ready: false,
        removedCount: 0,
        staleCount: directoryCount,
        anomalyCount: directoryCount,
        residualDirectoryCount: directoryCount,
      });
      assert.equal((await fs.readdir(root)).length, directoryCount);
    });
  }

  it("counts only real directory anomalies in residualDirectoryCount", async (t) => {
    const root = await tempRoot(t);
    const outside = join(dirname(root), `${basename(root)}-matrix-outside`);
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.mkdir(join(root, "request-badmode"), { mode: 0o750 });
    await fs.chmod(join(root, "request-badmode"), 0o750);
    await fs.mkdir(join(root, "nonmatching-directory"), { mode: 0o700 });
    await fs.writeFile(join(root, "nonmatching-file"), "synthetic");
    const fifoPath = join(root, "nonmatching-fifo");
    const socketPath = join(root, "nonmatching-socket");
    await fs.writeFile(fifoPath, "synthetic placeholder");
    await fs.writeFile(socketPath, "synthetic placeholder");
    await fs.symlink(outside, join(root, "request-link01"));
    const result = await sweepTempRoot(root, {
      mode: "startup",
      fsImpl: {
        ...fs,
        lstat: async (path) => {
          if (path === fifoPath) {
            return {
              isDirectory: () => false,
              isSymbolicLink: () => false,
              isFIFO: () => true,
            };
          }
          if (path === socketPath) {
            return {
              isDirectory: () => false,
              isSymbolicLink: () => false,
              isSocket: () => true,
            };
          }
          return fs.lstat(path);
        },
      },
      cleanupOptions: { attempts: [0] },
    });
    assert.deepEqual(result, {
      ready: false,
      removedCount: 0,
      staleCount: 0,
      anomalyCount: 6,
      residualDirectoryCount: 2,
    });
  });

  it("uses Dirent evidence only for real directories when candidate lstat is unavailable", async (t) => {
    const root = await tempRoot(t);
    const outside = join(dirname(root), `${basename(root)}-dirent-outside`);
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.mkdir(outside, { mode: 0o700 });
    const directory = join(root, "request-dir001");
    const file = join(root, "request-file01");
    const symlink = join(root, "request-link02");
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(file, "synthetic");
    await fs.symlink(outside, symlink);
    const candidates = new Set([directory, file, symlink]);
    const result = await sweepTempRoot(root, {
      mode: "startup",
      fsImpl: {
        ...fs,
        lstat: async (path) => {
          if (candidates.has(path)) {
            const error = new Error("synthetic lstat denied");
            error.code = "EACCES";
            throw error;
          }
          return fs.lstat(path);
        },
      },
      cleanupOptions: { attempts: [0] },
    });
    assert.deepEqual(result, {
      ready: false,
      removedCount: 0,
      staleCount: 0,
      anomalyCount: 3,
      residualDirectoryCount: 1,
    });
  });

  it("periodic sweep removes only age strictly greater than ten minutes", async (t) => {
    const root = await tempRoot(t);
    const equal = join(root, "request-equal01");
    const older = join(root, "request-older01");
    await fs.mkdir(equal, { mode: 0o700 });
    await fs.mkdir(older, { mode: 0o700 });
    const now = 1_000_000;
    await fs.utimes(equal, new Date(now - 600_000), new Date(now - 600_000));
    await fs.utimes(older, new Date(now - 600_001), new Date(now - 600_001));
    const result = await sweepTempRoot(root, {
      mode: "periodic",
      now: () => now,
      cleanupOptions: { attempts: [0] },
    });
    assert.deepEqual(result, {
      ready: true,
      removedCount: 1,
      staleCount: 1,
      anomalyCount: 0,
      residualDirectoryCount: 0,
    });
    assert.equal((await fs.lstat(equal)).isDirectory(), true);
    await assert.rejects(fs.lstat(older), (error) => error.code === "ENOENT");
  });
});

describe("ASR ffprobe fixed execution and bounded metadata", () => {
  it("uses exact shell:false argv and validates the frozen probe contract", async () => {
    const calls = [];
    const result = await probeAudio({
      inputPath: "/synthetic/input.audio",
      mediaType: "audio/wav",
      purpose: "quick_record",
      ffprobeCommand: "/synthetic/ffprobe",
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return fakeChild({ stdoutChunks: [validProbeJson()] });
      },
    });
    assert.equal(result.durationMs, 1_000);
    assert.deepEqual(calls, [{
      command: "/synthetic/ffprobe",
      args: [...ffprobeArguments("/synthetic/input.audio")],
      options: { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    }]);
  });

  it("maps nonzero, malformed JSON, and invalid stream metadata to AUDIO_INVALID", async () => {
    const cases = [
      fakeChild({ code: 1 }),
      fakeChild({ stdoutChunks: ["not-json"] }),
      fakeChild({ stdoutChunks: [validProbeJson({ stream: { channels: 3 } })] }),
    ];
    for (const child of cases) {
      await assert.rejects(probeAudio({
        inputPath: "/synthetic/input.audio",
        mediaType: "audio/wav",
        purpose: "quick_record",
        spawnImpl: () => child,
      }), expectCode("AUDIO_INVALID", 422));
    }
  });

  it("bounds stdout and stderr independently at 64 KiB", async () => {
    for (const streamName of ["stdoutChunks", "stderrChunks"]) {
      const spec = {
        stdoutChunks: [validProbeJson()],
        stderrChunks: [],
        [streamName]: [Buffer.alloc(65_537, 0x20)],
      };
      await assert.rejects(probeAudio({
        inputPath: "/synthetic/input.audio",
        mediaType: "audio/wav",
        purpose: "quick_record",
        outputMaxBytes: 65_536,
        spawnImpl: () => fakeChild(spec),
      }), expectCode("AUDIO_INVALID", 422));
    }
  });

  it("maps ffprobe timeout to AUDIO_INVALID and terminates the child", async () => {
    const child = fakeChild({ stayAlive: true, exitOnTerm: true });
    await assert.rejects(probeAudio({
      inputPath: "/synthetic/input.audio",
      mediaType: "audio/wav",
      purpose: "quick_record",
      timeoutMs: 10,
      spawnImpl: () => child,
    }), expectCode("AUDIO_INVALID", 422));
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
  });

  it("fails cleanup-closed when ffprobe remains alive after TERM and KILL", async () => {
    const child = fakeChild({ stayAlive: true, exitOnTerm: false, exitOnKill: false });
    await assert.rejects(probeAudio({
      inputPath: "/synthetic/input.audio",
      mediaType: "audio/wav",
      purpose: "quick_record",
      timeoutMs: 1,
      childKillGraceMs: 1,
      spawnImpl: () => child,
    }), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    child.stdout.destroy();
    child.stderr.destroy();
  });

  it("maps asynchronous ENOENT/error to ASR_NOT_CONFIGURED", async () => {
    const missing = new Error("synthetic path must remain hidden");
    missing.code = "ENOENT";
    await assert.rejects(probeAudio({
      inputPath: "/synthetic/input.audio",
      mediaType: "audio/wav",
      purpose: "quick_record",
      spawnImpl: () => fakeChild({ asyncError: missing }),
    }), expectCode("ASR_NOT_CONFIGURED", 503));
  });

  it("does not spawn ffprobe when the signal is already aborted", async () => {
    let spawnCalls = 0;
    const controller = new AbortController();
    controller.abort(new DOMException("synthetic cancel", "AbortError"));
    await assert.rejects(probeAudio({
      inputPath: "/synthetic/input.audio",
      mediaType: "audio/wav",
      purpose: "quick_record",
      signal: controller.signal,
      spawnImpl: () => { spawnCalls += 1; },
    }), (error) => error.name === "AbortError");
    assert.equal(spawnCalls, 0);
  });
});

describe("ASR ffmpeg raw-s16le to canonical WAV", () => {
  async function paths(t) {
    const root = await tempRoot(t);
    const workspace = await createWorkspace(root);
    const inputPath = join(workspace, "input.audio");
    const outputPath = join(workspace, "normalized.wav");
    await fs.writeFile(inputPath, WAV_MAGIC, { mode: 0o600 });
    return { workspace, inputPath, outputPath };
  }

  function syntheticOutputHandle({ syncImpl = async () => {}, closeImpl = async () => {} } = {}) {
    const sink = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
    });
    return {
      async stat() {
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          uid: process.getuid(),
          mode: 0o100600,
          nlink: 1,
          dev: 1,
          ino: 1,
          size: 0,
        };
      },
      async write(_buffer, _offset, length) { return { bytesWritten: length }; },
      createWriteStream() { return sink; },
      sync: syncImpl,
      close: closeImpl,
    };
  }

  it("builds a 44-byte canonical placeholder with both mutable sizes zero", () => {
    const placeholder = createCanonicalWavPlaceholder();
    assert.equal(placeholder.length, 44);
    assert.equal(placeholder.toString("ascii", 0, 4), "RIFF");
    assert.equal(placeholder.readUInt32LE(4), 0);
    assert.equal(placeholder.toString("ascii", 8, 12), "WAVE");
    assert.equal(placeholder.readUInt32LE(40), 0);
  });

  it("uses exact raw-s16le stdout argv, offset 44, fsync/close, and full header verification", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    const calls = [];
    const result = await transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 300,
      ffmpegCommand: "/synthetic/ffmpeg",
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return fakeChild({ stdoutChunks: [Buffer.alloc(9_600)] });
      },
    });
    assert.deepEqual(result, {
      outputPath,
      pcmBytes: 9_600,
      durationMs: 300,
      byteLength: 9_644,
    });
    assert.deepEqual(calls, [{
      command: "/synthetic/ffmpeg",
      args: [...ffmpegArguments(inputPath)],
      options: { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    }]);
    const handle = await fs.open(outputPath, "r");
    const header = Buffer.alloc(44);
    try {
      assert.equal((await handle.read(header, 0, 44, 0)).bytesRead, 44);
    } finally {
      await handle.close();
    }
    assert.equal(validateCanonicalWavHeader(header, 9_600), true);
    assert.deepEqual(header, createCanonicalWavHeader(9_600));
    const stat = await fs.lstat(outputPath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.size, 9_644);
  });

  it("accepts the exact 3,840,000-byte PCM ceiling", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    const result = await transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 120_000,
      spawnImpl: () => fakeChild({ stdoutChunks: [Buffer.alloc(3_840_000)] }),
    });
    assert.equal(result.pcmBytes, 3_840_000);
    assert.equal((await fs.lstat(outputPath)).size, 3_840_044);
  });

  it("rejects PCM byte 3,840,001 immediately and sends TERM", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    const child = fakeChild({
      stdoutChunks: [Buffer.alloc(3_840_000), Buffer.of(1)],
      stayAlive: true,
      exitOnTerm: true,
    });
    await assert.rejects(transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 120_000,
      spawnImpl: () => child,
    }), expectCode("ASR_TRANSCODE_FAILED", 500));
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
  });

  it("rejects empty/odd PCM and 501ms duration divergence", async (t) => {
    for (const [size, originalDurationMs] of [[0, 300], [9_601, 300], [9_600, 801]]) {
      const { inputPath, outputPath } = await paths(t);
      await assert.rejects(transcodeToCanonicalWav({
        inputPath,
        outputPath,
        purpose: "quick_record",
        originalDurationMs,
        spawnImpl: () => fakeChild({ stdoutChunks: size ? [Buffer.alloc(size)] : [] }),
      }), expectCode("ASR_TRANSCODE_FAILED", 500));
    }
  });

  it("maps ffmpeg timeout to ASR_TIMEOUT and terminates the child", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    const child = fakeChild({ stayAlive: true, exitOnTerm: true });
    await assert.rejects(transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 300,
      timeoutMs: 10,
      spawnImpl: () => child,
    }), expectCode("ASR_TIMEOUT", 504));
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
  });

  it("bounds a never-settling ffmpeg output open before spawning a child", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    let spawnCalls = 0;
    await assert.rejects(transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 300,
      timeoutMs: 10,
      cleanupTimeoutMs: 10,
      fsImpl: {
        open: async () => new Promise(() => {}),
      },
      spawnImpl: () => { spawnCalls += 1; },
    }), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.equal(spawnCalls, 0);
  });

  it("lets caller abort bound a never-settling ffmpeg output open", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    const controller = new AbortController();
    const pending = transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 300,
      timeoutMs: 1_000,
      cleanupTimeoutMs: 10,
      signal: controller.signal,
      fsImpl: {
        open: async () => new Promise(() => {}),
      },
      spawnImpl: () => { throw new Error("must not spawn"); },
    });
    const pendingRejected = assert.rejects(pending, expectCode("ASR_CLEANUP_FAILED", 503));
    controller.abort(new DOMException("synthetic transcode open cancel", "AbortError"));
    await pendingRejected;
  });

  for (const closeOutcome of ["resolve", "reject", "never"]) {
    it(`tracks a late ffmpeg output handle whose close will ${closeOutcome}`, async (t) => {
      const { inputPath, outputPath } = await paths(t);
      const realHandle = await fs.open(outputPath, "wx", 0o600);
      let resolveOpen;
      let closeCalls = 0;
      const lifecycles = [];
      const pending = transcodeToCanonicalWav({
        inputPath,
        outputPath,
        purpose: "quick_record",
        originalDurationMs: 300,
        timeoutMs: 10,
        cleanupTimeoutMs: closeOutcome === "never" ? 20 : 100,
        fsImpl: {
          open: async () => new Promise((resolve) => { resolveOpen = resolve; }),
        },
        onLateResourceLifecycle: (lifecycle) => lifecycles.push(lifecycle),
        spawnImpl: () => { throw new Error("must not spawn"); },
      });
      const expected = closeOutcome === "resolve"
        ? expectCode("ASR_TIMEOUT", 504)
        : expectCode("ASR_CLEANUP_FAILED", 503);
      const rejection = assert.rejects(pending, expected);
      await waitForCondition(
        () => typeof resolveOpen === "function",
        `late ffmpeg output open did not start for ${closeOutcome}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 15));
      resolveOpen({
        close: async () => {
          closeCalls += 1;
          if (closeOutcome === "resolve") return realHandle.close();
          if (closeOutcome === "reject") throw new Error("synthetic ffmpeg late close rejection");
          return new Promise(() => {});
        },
      });
      await rejection;
      assert.equal(closeCalls, 1);
      assert.equal(lifecycles.length, 1);
      if (closeOutcome === "resolve") {
        assert.equal((await Promise.allSettled(lifecycles))[0].status, "fulfilled");
        await assert.rejects(realHandle.stat(), (error) => error.code === "EBADF");
      } else {
        if (closeOutcome === "reject") {
          assert.equal((await Promise.allSettled(lifecycles))[0].status, "rejected");
        }
        await realHandle.close();
      }
    });
  }

  for (const closeOutcome of ["resolve", "reject", "never"]) {
    it(`tracks a late canonical-header read handle whose close will ${closeOutcome}`, async (t) => {
      const { inputPath, outputPath } = await paths(t);
      let openCalls = 0;
      let resolveHeaderOpen;
      let headerHandle;
      let headerOpenStarted;
      const headerStarted = new Promise((resolve) => { headerOpenStarted = resolve; });
      let closeCalls = 0;
      const lifecycles = [];
      let lifecycleRegisteredResolve;
      const lifecycleRegistered = new Promise((resolve) => { lifecycleRegisteredResolve = resolve; });
      const operationDeadline = manualFirstTimeout();
      const fsImpl = {
        lstat: (...args) => fs.lstat(...args),
        open: async (...args) => {
          openCalls += 1;
          if (openCalls === 1) return fs.open(...args);
          headerHandle = await fs.open(...args);
          headerOpenStarted();
          return new Promise((resolve) => { resolveHeaderOpen = resolve; });
        },
      };
      const pending = transcodeToCanonicalWav({
        inputPath,
        outputPath,
        purpose: "quick_record",
        originalDurationMs: 300,
        timeoutMs: 30,
        cleanupTimeoutMs: closeOutcome === "never" ? 50 : TEST_LIFECYCLE_BUDGET_MS,
        setTimeoutImpl: operationDeadline.setTimeoutImpl,
        clearTimeoutImpl: operationDeadline.clearTimeoutImpl,
        fsImpl,
        onLateResourceLifecycle: (lifecycle) => {
          lifecycles.push(lifecycle);
          lifecycleRegisteredResolve();
        },
        spawnImpl: () => fakeChild({ stdoutChunks: [Buffer.alloc(9_600)] }),
      });
      const expected = closeOutcome === "resolve"
        ? expectCode("ASR_TIMEOUT", 504)
        : expectCode("ASR_CLEANUP_FAILED", 503);
      const rejection = assert.rejects(pending, expected);
      await headerStarted;
      operationDeadline.fire();
      await lifecycleRegistered;
      resolveHeaderOpen({
        close: async () => {
          closeCalls += 1;
          if (closeOutcome === "resolve") return headerHandle.close();
          if (closeOutcome === "reject") throw new Error("synthetic header late close rejection");
          return new Promise(() => {});
        },
      });
      await rejection;
      assert.equal(openCalls, 2);
      assert.equal(closeCalls, 1);
      assert.equal(lifecycles.length, 1);
      if (closeOutcome === "resolve") {
        assert.equal((await Promise.allSettled(lifecycles))[0].status, "fulfilled");
        await assert.rejects(headerHandle.stat(), (error) => error.code === "EBADF");
      } else {
        if (closeOutcome === "reject") {
          assert.equal((await Promise.allSettled(lifecycles))[0].status, "rejected");
        }
        await headerHandle.close();
      }
    });
  }

  it("bounds a never-settling ffmpeg output sync and closes its accepted handle", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    let closeCalls = 0;
    const handle = syntheticOutputHandle({
      syncImpl: async () => new Promise(() => {}),
      closeImpl: async () => { closeCalls += 1; },
    });
    await assert.rejects(transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 300,
      timeoutMs: 10,
      cleanupTimeoutMs: 50,
      fsImpl: { open: async () => handle },
      spawnImpl: () => fakeChild({ stdoutChunks: [Buffer.alloc(9_600)] }),
    }), expectCode("ASR_TIMEOUT", 504));
    assert.equal(closeCalls, 1);
  });

  it("returns cleanup failure instead of hanging on an ffmpeg output close", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    let closeCalls = 0;
    const handle = syntheticOutputHandle({
      closeImpl: async () => { closeCalls += 1; return new Promise(() => {}); },
    });
    await assert.rejects(transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 300,
      timeoutMs: 10,
      cleanupTimeoutMs: 10,
      fsImpl: { open: async () => handle },
      spawnImpl: () => fakeChild({ stdoutChunks: [Buffer.alloc(9_600)] }),
    }), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.equal(closeCalls, 1);
  });

  it("fails cleanup-closed when ffmpeg remains alive after TERM and KILL", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    const child = fakeChild({ stayAlive: true, exitOnTerm: false, exitOnKill: false });
    await assert.rejects(transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 300,
      timeoutMs: 50,
      childKillGraceMs: 1,
      spawnImpl: () => child,
    }), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    child.stdout.destroy();
    child.stderr.destroy();
  });

  it("maps asynchronous ffmpeg ENOENT to ASR_NOT_CONFIGURED", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    const missing = new Error("synthetic missing command");
    missing.code = "ENOENT";
    await assert.rejects(transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 300,
      spawnImpl: () => fakeChild({ asyncError: missing }),
    }), expectCode("ASR_NOT_CONFIGURED", 503));
  });

  it("fails before open/spawn when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("synthetic cancel", "AbortError"));
    let openCalls = 0;
    let spawnCalls = 0;
    await assert.rejects(transcodeToCanonicalWav({
      inputPath: "/synthetic/input.audio",
      outputPath: "/synthetic/normalized.wav",
      purpose: "quick_record",
      originalDurationMs: 300,
      signal: controller.signal,
      fsImpl: { open: async () => { openCalls += 1; } },
      spawnImpl: () => { spawnCalls += 1; },
    }), (error) => error.name === "AbortError");
    assert.equal(openCalls, 0);
    assert.equal(spawnCalls, 0);
  });

  it("fails closed when output mode/inode/size/header verification changes", async (t) => {
    const { inputPath, outputPath } = await paths(t);
    await assert.rejects(transcodeToCanonicalWav({
      inputPath,
      outputPath,
      purpose: "quick_record",
      originalDurationMs: 300,
      spawnImpl: () => {
        const child = fakeChild({ stdoutChunks: [Buffer.alloc(9_600)], stayAlive: true });
        child.stdout.once("end", async () => {
          await fs.chmod(outputPath, 0o640);
          child.exitCode = 0;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child;
      },
    }), expectCode("ASR_TRANSCODE_FAILED", 500));
  });

  it("performs TERM, waits, KILL, then confirms bounded child exit", async () => {
    const child = fakeChild({ stayAlive: true, exitOnTerm: false, exitOnKill: true });
    assert.equal(await terminateMediaChild(child, { graceMs: 1 }), true);
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  });

  it("returns false only after bounded waits prove even KILL did not exit", async () => {
    const child = fakeChild({ stayAlive: true, exitOnTerm: false, exitOnKill: false });
    assert.equal(await terminateMediaChild(child, { graceMs: 1 }), false);
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref?.();
  });

  it("does not treat a child error event as proof that the process exited", async () => {
    const child = fakeChild({ stayAlive: true, exitOnTerm: false, exitOnKill: false });
    child.kill = (signal) => {
      child.killSignals.push(signal);
      queueMicrotask(() => child.emit("error", new Error("synthetic kill failure")));
      return false;
    };
    assert.equal(await terminateMediaChild(child, { graceMs: 1 }), false);
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    child.stdout.destroy();
    child.stderr.destroy();
  });
});

function syntheticBody(hashSeed = "a") {
  const body = Readable.from([WAV_MAGIC]);
  body.syntheticHash = hashSeed.repeat(64);
  return body;
}

function deferredUnreadBody() {
  const body = new PassThrough();
  let destroyCalls = 0;
  let deferCalls = 0;
  let deferredTermination = null;
  const originalDestroy = body.destroy.bind(body);
  body.destroy = (...args) => {
    destroyCalls += 1;
    return originalDestroy(...args);
  };
  return {
    body,
    defer(terminate) {
      deferCalls += 1;
      deferredTermination = terminate;
    },
    snapshot() {
      return { destroyCalls, deferCalls, deferredTermination, destroyed: body.destroyed };
    },
  };
}

function requestInput({
  owner = "owner-a",
  key = "asr:synthetic-request-0001",
  hashSeed = "a",
  signal,
  body,
  deferUnreadBodyTermination = (terminate) => terminate(),
} = {}) {
  return {
    owner,
    idempotencyKey: key,
    purpose: "quick_record",
    mediaType: "audio/wav",
    body: body ?? syntheticBody(hashSeed),
    contentLength: null,
    language: "zh-CN",
    requestId: "synthetic-request-id",
    signal,
    deferUnreadBodyTermination,
  };
}

async function serviceFixture(t, overrides = {}) {
  const root = overrides.root ?? await tempRoot(t);
  const providerCalls = overrides.providerCalls ?? [];
  const workspaces = [];
  const provider = Object.hasOwn(overrides, "provider") ? overrides.provider : {
    id: "openai-compatible",
    readiness: () => ({ ready: true, code: "READY" }),
    async transcribe(input) {
      providerCalls.push(input);
      return { text: "合成转写结果" };
    },
  };
  const writer = overrides.writeAudioBodyImpl ?? (async ({ readable, outputPath, reservation }) => {
    workspaces.push(dirname(outputPath));
    await fs.writeFile(outputPath, WAV_MAGIC, { mode: 0o600 });
    reservation.reserveChunk(WAV_MAGIC.length);
    reservation.finishUpload(WAV_MAGIC.length);
    return {
      byteLength: WAV_MAGIC.length,
      sha256: readable.syntheticHash ?? "a".repeat(64),
      magicBytes: Uint8Array.from(WAV_MAGIC),
    };
  });
  const probe = overrides.probeAudioImpl ?? (async () => ({
    durationMs: 1_000,
    formatNames: ["wav"],
    audioStream: { index: 0, codecName: "pcm_s16le", channels: 1, sampleRate: 16_000 },
  }));
  const transcode = overrides.transcodeImpl ?? (async ({ outputPath }) => {
    await fs.writeFile(outputPath, createCanonicalWavHeader(32_000), { mode: 0o600 });
    return { outputPath, pcmBytes: 32_000, durationMs: 1_000, byteLength: 32_044 };
  });
  const service = createAsrService({
    asrMode: overrides.mode ?? "live",
    asrProvider: "openai-compatible",
    asrBaseUrl: "https://provider.example/v1",
    asrModel: "synthetic-asr",
    asrTempRoot: root,
    authSessionSecret: HMAC_FIXTURE,
    asrReuseModelCredential: false,
    ...overrides.config,
  }, {
    provider,
    aiPlatformRuntime: overrides.aiPlatformRuntime,
    asrApiKeyProvider: overrides.asrApiKeyProvider,
    modelApiKeyProvider: overrides.modelApiKeyProvider,
    modelCredentialReuseVerified: overrides.modelCredentialReuseVerified,
    credentialCompatibility: overrides.credentialCompatibility,
    providerDependencies: overrides.providerDependencies,
    metrics: overrides.metrics,
    uploadCapacity: overrides.uploadCapacity,
    processingCapacity: overrides.processingCapacity,
    writeAudioBodyImpl: writer,
    probeAudioImpl: probe,
    transcodeImpl: transcode,
    processingTimeoutMs: overrides.processingTimeoutMs,
    cleanupImpl: overrides.cleanupImpl,
    sweepImpl: overrides.sweepImpl,
    createWorkspaceImpl: overrides.createWorkspaceImpl,
    closeTimeoutMs: overrides.closeTimeoutMs,
    setIntervalImpl: overrides.setIntervalImpl,
    clearIntervalImpl: overrides.clearIntervalImpl,
    setTimeoutImpl: overrides.setTimeoutImpl,
    clearTimeoutImpl: overrides.clearTimeoutImpl,
    sweepIntervalMs: overrides.sweepIntervalMs,
    spawnImpl: overrides.spawnImpl,
    childKillGraceMs: overrides.childKillGraceMs,
    preflightBodyTimeoutMs: overrides.preflightBodyTimeoutMs,
    workspaceTimeoutMs: overrides.workspaceTimeoutMs,
    requestCleanupTimeoutMs: overrides.requestCleanupTimeoutMs,
  });
  t.after(async () => {
    try { await service.close(); } catch { /* individual failure tests assert the error */ }
  });
  if (overrides.initialize !== false) await service.initialize();
  return { service, root, providerCalls, workspaces };
}

async function assertWorkspacesRemoved(workspaces) {
  for (const workspace of new Set(workspaces)) {
    await assert.rejects(fs.lstat(workspace), (error) => error.code === "ENOENT");
  }
}

function sweepResultWithResidualPaths(paths, overrides = {}) {
  const result = {
    ready: paths.length === 0,
    removedCount: 0,
    staleCount: 0,
    anomalyCount: paths.length,
    residualDirectoryCount: paths.length,
    ...overrides,
  };
  Object.defineProperty(result, ASR_SWEEP_RESIDUAL_PATHS, {
    value: Object.freeze([...paths]),
    enumerable: false,
  });
  return result;
}

describe("ASR service orchestration, cleanup, and provider zero-delta gates", () => {
  it("runs upload→magic→probe→transcode→provider→cleanup and releases every gauge/slot", async (t) => {
    const fixture = await serviceFixture(t);
    const result = await fixture.service.transcribe(requestInput());
    assert.deepEqual(result, {
      transcript: "合成转写结果",
      language: "zh-CN",
      durationMs: 1_000,
      source: "server_asr",
      replayed: false,
    });
    assert.equal(fixture.providerCalls.length, 1);
    assert.deepEqual(Object.keys(fixture.providerCalls[0]).toSorted(), [
      "audioPath", "durationMs", "language", "mediaType", "purpose", "requestId", "signal",
    ]);
    assert.equal(Object.hasOwn(fixture.providerCalls[0], "owner"), false);
    assert.equal(Object.hasOwn(fixture.providerCalls[0], "idempotencyKey"), false);
    assert.deepEqual(fixture.service.metrics.snapshot().gauges, {
      inflight: 0,
      activeUploads: 0,
      tempBytes: 0,
      staleTempDirectories: 0,
    });
    assert.equal(fixture.service.capacitySnapshot().processing.globalActive, 0);
    await assertWorkspacesRemoved(fixture.workspaces);
  });

  it("routes required ASR through the platform with a descriptor-only task and never reads the legacy key", async (t) => {
    const platformCalls = [];
    let keyCalls = 0;
    const fixture = await serviceFixture(t, {
      provider: null,
      config: { aiPlatformMode: "required" },
      aiPlatformRuntime: {
        mode: "required",
        configured: () => true,
        async runTask(input) {
          platformCalls.push(input);
          return {
            result: {
              metadata: { compatibility: { text: "统一平台转写结果" } },
            },
          };
        },
      },
      asrApiKeyProvider: async () => {
        keyCalls += 1;
        return "must-not-be-read";
      },
    });

    const result = await fixture.service.transcribe(requestInput({
      key: "asr:synthetic-platform-required",
    }));
    assert.deepEqual(result, {
      transcript: "统一平台转写结果",
      language: "zh-CN",
      durationMs: 1_000,
      source: "server_asr",
      replayed: false,
    });
    assert.equal(platformCalls.length, 1);
    assert.equal(platformCalls[0].taskType, "asr.transcribe");
    assert.equal(platformCalls[0].feature, "asr");
    assert.equal(platformCalls[0].owner, "owner-a");
    assert.equal(platformCalls[0].actor, "owner-a");
    assert.deepEqual(platformCalls[0].subject, {
      type: "asr_audio",
      id: `sha256-${"a".repeat(64)}`,
    });
    assert.equal(platformCalls[0].channel, "web");
    assert.equal(platformCalls[0].idempotencyKey, "asr:synthetic-platform-required");
    assert.deepEqual(Object.keys(platformCalls[0].input), ["media"]);
    assert.deepEqual(Object.keys(platformCalls[0].input.media), [
      "mediaType", "byteLength", "durationMs", "purpose", "language", "sha256",
    ]);
    assert.deepEqual(platformCalls[0].input.media, {
      mediaType: "audio/wav",
      byteLength: 32_044,
      durationMs: 1_000,
      purpose: "quick_record",
      language: "zh-CN",
      sha256: "a".repeat(64),
    });
    assert.equal(JSON.stringify(platformCalls[0]).includes(fixture.root), false);
    assert.equal(JSON.stringify(platformCalls[0]).includes("audioPath"), false);
    assert.equal(JSON.stringify(platformCalls[0]).includes("input.audio"), false);
    assert.equal(keyCalls, 0);
    assert.deepEqual(fixture.service.metrics.snapshot().counters.providerCallsTotal, {
      "ai-platform|success": 1,
    });
    await assertWorkspacesRemoved(fixture.workspaces);
  });

  it("fails required platform mode closed without creating the legacy provider or reading its key", async (t) => {
    let keyCalls = 0;
    let transcodeCalls = 0;
    const fixture = await serviceFixture(t, {
      provider: null,
      config: { aiPlatformMode: "required" },
      aiPlatformRuntime: {
        mode: "required",
        configured: () => false,
        async runTask() {
          throw new Error("platform must not run when unconfigured");
        },
      },
      asrApiKeyProvider: async () => {
        keyCalls += 1;
        return "must-not-be-read";
      },
      transcodeImpl: async () => {
        transcodeCalls += 1;
        throw new Error("transcode must not run when platform is unconfigured");
      },
    });

    assert.deepEqual(fixture.service.readiness(), {
      ready: false,
      code: "ASR_NOT_CONFIGURED",
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-platform-missing" })),
      expectCode("ASR_NOT_CONFIGURED", 503),
    );
    assert.equal(keyCalls, 0);
    assert.equal(transcodeCalls, 0);
    assert.equal(fixture.service.metrics.snapshot().counters.providerCallsTotal["ai-platform|success"], undefined);
  });

  it("uses the platform for optional mode only when it is configured and keeps the legacy fallback otherwise", async (t) => {
    const configuredCalls = [];
    const configured = await serviceFixture(t, {
      provider: null,
      config: { aiPlatformMode: "optional" },
      aiPlatformRuntime: {
        mode: "optional",
        configured: () => true,
        async runTask(input) {
          configuredCalls.push(input);
          return { transcript: "可选平台结果" };
        },
      },
      asrApiKeyProvider: async () => { throw new Error("optional platform must not read legacy key"); },
    });
    assert.equal(
      (await configured.service.transcribe(requestInput({ key: "asr:synthetic-platform-optional" }))).transcript,
      "可选平台结果",
    );
    assert.equal(configuredCalls.length, 1);
    assert.equal(configured.providerCalls.length, 0);

    const fallbackCalls = [];
    const fallbackPlatformCalls = [];
    const fallback = await serviceFixture(t, {
      providerCalls: fallbackCalls,
      config: { aiPlatformMode: "optional" },
      aiPlatformRuntime: {
        mode: "optional",
        configured: () => false,
        async runTask(input) {
          fallbackPlatformCalls.push(input);
          return { transcript: "must-not-run" };
        },
      },
    });
    assert.equal(
      (await fallback.service.transcribe(requestInput({ key: "asr:synthetic-platform-fallback" }))).transcript,
      "合成转写结果",
    );
    assert.equal(fallbackCalls.length, 1);
    assert.equal(fallbackPlatformCalls.length, 0);
  });

  it("maps platform not-configured, timeout, and cancellation failures to the ASR contract", async (t) => {
    const cases = [
      ["ai_platform_not_configured", "ASR_NOT_CONFIGURED", 503],
      ["agent_not_configured", "ASR_NOT_CONFIGURED", 503],
      ["provider_disabled", "ASR_NOT_CONFIGURED", 503],
      ["AI_PLATFORM_NOT_CONFIGURED", "ASR_NOT_CONFIGURED", 503],
      ["task_pending", "ASR_TIMEOUT", 504],
      ["ai_platform_timeout", "ASR_TIMEOUT", 504],
      ["cancelled", "AbortError", undefined],
      ["ai_platform_aborted", "AbortError", undefined],
      ["queue_full", "ASR_CAPACITY_EXCEEDED", 429],
    ];
    for (const [platformCode, expectedCode, expectedStatus] of cases) {
      const fixture = await serviceFixture(t, {
        provider: null,
        config: { aiPlatformMode: "required" },
        aiPlatformRuntime: {
          mode: "required",
          configured: () => true,
          async runTask() {
            const error = new Error("private platform failure");
            error.code = platformCode;
            throw error;
          },
        },
      });
      await assert.rejects(
        fixture.service.transcribe(requestInput({
          key: `asr:synthetic-platform-error-${platformCode}`,
        })),
        (error) => {
          assert.equal(error.name === "AbortError" ? "AbortError" : error.code, expectedCode);
          if (expectedStatus !== undefined) assert.equal(error.status, expectedStatus);
          return true;
        },
      );
    }
  });

  it("propagates the request processing deadline to platform runTask", async (t) => {
    let platformSignal = null;
    const fixture = await serviceFixture(t, {
      provider: null,
      processingTimeoutMs: 10,
      config: { aiPlatformMode: "required" },
      aiPlatformRuntime: {
        mode: "required",
        configured: () => true,
        async runTask({ signal }) {
          platformSignal = signal;
          return new Promise((resolve, reject) => {
            const onAbort = () => {
              signal.removeEventListener("abort", onAbort);
              reject(signal.reason);
            };
            signal.addEventListener("abort", onAbort, { once: true });
          });
        },
      },
    });

    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-platform-timeout" })),
      expectCode("ASR_TIMEOUT", 504),
    );
    assert.ok(platformSignal);
    assert.equal(platformSignal.aborted, true);
    assert.equal(platformSignal.reason?.name, "TimeoutError");
  });

  it("keeps provider delta zero for upload, magic, probe, and transcode rejection", async (t) => {
    const stages = [
      {
        writeAudioBodyImpl: async () => { throw new AsrContractError("AUDIO_TOO_LARGE", 413, "fixed"); },
        code: "AUDIO_TOO_LARGE",
      },
      {
        writeAudioBodyImpl: async ({ outputPath, reservation }) => {
          await fs.writeFile(outputPath, "bad", { mode: 0o600 });
          reservation.reserveChunk(3);
          reservation.finishUpload(3);
          return { byteLength: 3, sha256: "a".repeat(64), magicBytes: Uint8Array.of(1, 2, 3) };
        },
        code: "AUDIO_SIGNATURE_MISMATCH",
      },
      {
        probeAudioImpl: async () => { throw new AsrContractError("AUDIO_INVALID", 422, "fixed"); },
        code: "AUDIO_INVALID",
      },
      {
        transcodeImpl: async () => { throw new AsrContractError("ASR_TRANSCODE_FAILED", 500, "fixed"); },
        code: "ASR_TRANSCODE_FAILED",
      },
    ];
    for (const [index, stage] of stages.entries()) {
      const providerCalls = [];
      const fixture = await serviceFixture(t, { ...stage, providerCalls });
      await assert.rejects(
        fixture.service.transcribe(requestInput({ key: `asr:synthetic-gate-${String(index).padStart(4, "0")}` })),
        expectCode(stage.code),
      );
      assert.equal(providerCalls.length, 0);
      assert.deepEqual(fixture.service.metrics.snapshot().gauges, {
        inflight: 0,
        activeUploads: 0,
        tempBytes: 0,
        staleTempDirectories: 0,
      });
      await assertWorkspacesRemoved(fixture.workspaces);
      await fixture.service.close();
    }
  });

  it("releases failed provider reservations and cleans before returning the fixed error", async (t) => {
    const providerCalls = [];
    const fixture = await serviceFixture(t, {
      providerCalls,
      provider: {
        id: "openai-compatible",
        readiness: () => ({ ready: true, code: "READY" }),
        async transcribe(input) {
          providerCalls.push(input);
          throw new AsrContractError("ASR_PROVIDER_BAD_RESPONSE", 502, "fixed provider failure");
        },
      },
    });
    const input = requestInput({ key: "asr:synthetic-provider-fail" });
    await assert.rejects(fixture.service.transcribe(input), expectCode("ASR_PROVIDER_BAD_RESPONSE", 502));
    assert.equal(fixture.service.capacitySnapshot().idempotency.pending, 0);
    assert.equal(fixture.service.metrics.snapshot().gauges.inflight, 0);
    await assertWorkspacesRemoved(fixture.workspaces);
  });

  it("records exactly one provider error and one duration when transcript normalization rejects", async (t) => {
    const fixture = await serviceFixture(t, {
      provider: {
        id: "openai-compatible",
        readiness: () => ({ ready: true, code: "READY" }),
        async transcribe() { return { text: "\u0000invalid synthetic transcript" }; },
      },
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-provider-normalize-error" })),
      expectCode("ASR_PROVIDER_BAD_RESPONSE", 502),
    );
    const counters = fixture.service.metrics.snapshot().counters;
    assert.deepEqual(counters.providerCallsTotal, { "openai-compatible|error": 1 });
    assert.equal(counters.providerCallsTotal["openai-compatible|success"], undefined);
    assert.equal(counters.stageDurationMs["provider|quick_record"].count, 1);
    assert.equal(fixture.service.capacitySnapshot().idempotency.pending, 0);
    await assertWorkspacesRemoved(fixture.workspaces);
  });

  it("retries one transient cleanup failure before returning success", async (t) => {
    let rmCalls = 0;
    const fixture = await serviceFixture(t, {
      cleanupImpl: async (workspace, options) => removeWorkspaceAndVerify(workspace, {
        ...options,
        attempts: [0, 0],
        fsImpl: {
          lstat: fs.lstat,
          rm: async (...args) => {
            rmCalls += 1;
            if (rmCalls === 1) throw new Error("synthetic transient cleanup failure");
            return fs.rm(...args);
          },
        },
      }),
    });
    assert.equal((await fixture.service.transcribe(requestInput({ key: "asr:synthetic-clean-retry" }))).replayed, false);
    assert.equal(rmCalls, 2);
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 0);
    await assertWorkspacesRemoved(fixture.workspaces);
  });

  it("overrides a provider success with ASR_CLEANUP_FAILED and never stores completed text", async (t) => {
    const fixture = await serviceFixture(t, {
      cleanupImpl: async (workspace) => {
        await fs.rm(workspace, { recursive: true, force: true });
        throw new Error("synthetic persistent verification failure");
      },
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-clean-fail" })),
      expectCode("ASR_CLEANUP_FAILED", 503),
    );
    assert.equal(fixture.service.capacitySnapshot().idempotency.completed, 0);
    assert.equal(fixture.service.capacitySnapshot().idempotency.pending, 0);
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 1);
    assert.deepEqual(fixture.service.metrics.snapshot().gauges, {
      inflight: 0,
      activeUploads: 0,
      tempBytes: 0,
      staleTempDirectories: 0,
    });
    await assertWorkspacesRemoved(fixture.workspaces);
  });

  it("bounds a never-settling workspace creation and releases request capacity", async (t) => {
    const fixture = await serviceFixture(t, {
      workspaceTimeoutMs: 10,
      closeTimeoutMs: 15,
      createWorkspaceImpl: async () => new Promise(() => {}),
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-workspace-timeout" })),
      expectCode("ASR_TIMEOUT", 504),
    );
    assert.equal(fixture.providerCalls.length, 0);
    assert.equal(fixture.service.capacitySnapshot().uploads.activeUploads, 0);
    assert.equal(fixture.service.capacitySnapshot().uploads.tempBytes, 0);
    assert.equal(fixture.service.metrics.snapshot().gauges.inflight, 0);
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 2);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 2);
  });

  it("lets caller abort bound a never-settling workspace creation", async (t) => {
    const controller = new AbortController();
    let workspaceEnteredResolve;
    const workspaceEntered = new Promise((resolve) => { workspaceEnteredResolve = resolve; });
    const fixture = await serviceFixture(t, {
      workspaceTimeoutMs: 1_000,
      closeTimeoutMs: 15,
      createWorkspaceImpl: async () => {
        workspaceEnteredResolve();
        return new Promise(() => {});
      },
    });
    const request = fixture.service.transcribe(requestInput({
      key: "asr:synthetic-workspace-abort",
      signal: controller.signal,
    }));
    const requestRejected = assert.rejects(request, (error) => error.name === "AbortError");
    await workspaceEntered;
    controller.abort(new DOMException("synthetic workspace cancel", "AbortError"));
    await requestRejected;
    assert.equal(fixture.service.metrics.snapshot().gauges.inflight, 0);
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 2);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
  });

  it("cleans a callback-materialized workspace while its creation promise never settles", async (t) => {
    let workspace;
    let materializedResolve;
    const materialized = new Promise((resolve) => { materializedResolve = resolve; });
    let cleanupCalls = 0;
    const fixture = await serviceFixture(t, {
      workspaceTimeoutMs: 10,
      closeTimeoutMs: 20,
      createWorkspaceImpl: async (root, options) => {
        assert.equal(options.cleanupOnFailure, false);
        workspace = await fs.mkdtemp(join(root, "request-"));
        await fs.chmod(workspace, 0o700);
        options.onWorkspaceCreated(workspace);
        materializedResolve();
        return new Promise(() => {});
      },
      cleanupImpl: async (path, options) => {
        cleanupCalls += 1;
        return removeWorkspaceAndVerify(path, options);
      },
    });
    const request = fixture.service.transcribe(requestInput({ key: "asr:synthetic-materialized-never" }));
    const requestRejected = assert.rejects(request, expectCode("ASR_TIMEOUT", 504));
    await materialized;
    await requestRejected;
    assert.equal(cleanupCalls, 1);
    await assert.rejects(fs.lstat(workspace), (error) => error.code === "ENOENT");
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 1);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 1);
  });

  for (const lateOutcome of ["resolve", "reject"]) {
    it(`does not double-clean a callback workspace when creation will ${lateOutcome} late`, async (t) => {
      let settleWorkspace;
      let workspace;
      let materializedResolve;
      const materialized = new Promise((resolve) => { materializedResolve = resolve; });
      let cleanupCalls = 0;
      const fixture = await serviceFixture(t, {
        workspaceTimeoutMs: 10,
        closeTimeoutMs: 100,
        createWorkspaceImpl: async (root, options) => {
          workspace = await fs.mkdtemp(join(root, "request-"));
          await fs.chmod(workspace, 0o700);
          options.onWorkspaceCreated(workspace);
          materializedResolve();
          return new Promise((resolve, reject) => {
            settleWorkspace = lateOutcome === "resolve"
              ? () => resolve(workspace)
              : () => reject(new Error("synthetic late workspace rejection"));
          });
        },
        cleanupImpl: async (path, options) => {
          cleanupCalls += 1;
          return removeWorkspaceAndVerify(path, options);
        },
      });
      const request = fixture.service.transcribe(requestInput({
        key: `asr:synthetic-materialized-late-${lateOutcome}`,
      }));
      const requestRejected = assert.rejects(request, expectCode("ASR_TIMEOUT", 504));
      await materialized;
      await requestRejected;
      assert.equal(cleanupCalls, 1);
      await assert.rejects(fs.lstat(workspace), (error) => error.code === "ENOENT");
      assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 1);
      settleWorkspace();
      await waitForCondition(
        () => fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles === 0,
        "late workspace settlement lifecycle did not reach zero",
      );
      assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 0);
      assert.equal(cleanupCalls, 1);
      await fixture.service.close();
      assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
    });
  }

  it("owns exactly one cleanup after a callback-materialized creation rejects", async (t) => {
    let workspace;
    let cleanupCalls = 0;
    const fixture = await serviceFixture(t, {
      createWorkspaceImpl: async (root, options) => {
        workspace = await fs.mkdtemp(join(root, "request-"));
        await fs.chmod(workspace, 0o700);
        options.onWorkspaceCreated(workspace);
        throw new Error("synthetic workspace readiness rejection");
      },
      cleanupImpl: async (path, options) => {
        cleanupCalls += 1;
        return removeWorkspaceAndVerify(path, options);
      },
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-materialized-reject" })),
      /synthetic workspace readiness rejection/u,
    );
    assert.equal(cleanupCalls, 1);
    await assert.rejects(fs.lstat(workspace), (error) => error.code === "ENOENT");
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 0);
    await fixture.service.close();
  });

  it("cleans a real createWorkspace path when post-mkdtemp lstat never settles", async (t) => {
    let workspace;
    let materializedResolve;
    const materialized = new Promise((resolve) => { materializedResolve = resolve; });
    let lstatStartedResolve;
    const lstatStarted = new Promise((resolve) => { lstatStartedResolve = resolve; });
    const workspaceTimeoutMs = 58_731;
    const workspaceTimer = Object.freeze({ kind: "manual-workspace-timeout" });
    let workspaceTimeoutCallback = null;
    const fixture = await serviceFixture(t, {
      workspaceTimeoutMs,
      closeTimeoutMs: 20,
      setTimeoutImpl: (callback, milliseconds) => {
        if (milliseconds === workspaceTimeoutMs) {
          assert.equal(workspaceTimeoutCallback, null, "workspace deadline registered exactly once");
          workspaceTimeoutCallback = callback;
          return workspaceTimer;
        }
        return setTimeout(callback, milliseconds);
      },
      clearTimeoutImpl: (timer) => {
        if (timer !== workspaceTimer) clearTimeout(timer);
      },
      createWorkspaceImpl: (root, options) => createWorkspace(root, {
        ...options,
        fsImpl: {
          ...fs,
          mkdtemp: async (...args) => {
            workspace = await fs.mkdtemp(...args);
            materializedResolve();
            return workspace;
          },
          lstat: async (path) => {
            if (path !== workspace) return fs.lstat(path);
            lstatStartedResolve();
            return new Promise(() => {});
          },
        },
      }),
    });
    const request = fixture.service.transcribe(
      requestInput({ key: "asr:synthetic-workspace-lstat-never" }),
    );
    const requestRejected = assert.rejects(request, expectCode("ASR_TIMEOUT", 504));
    await materialized;
    await lstatStarted;
    assert.equal(typeof workspace, "string", "workspace was materialized before its deadline");
    assert.equal(typeof workspaceTimeoutCallback, "function", "workspace deadline was registered");
    const fireWorkspaceTimeout = workspaceTimeoutCallback;
    workspaceTimeoutCallback = null;
    fireWorkspaceTimeout();
    await requestRejected;
    await waitForCondition(async () => {
      try {
        await fs.lstat(workspace);
        return false;
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        throw error;
      }
    }, "materialized workspace was not removed after its deadline");
    await assert.rejects(fs.lstat(workspace), (error) => error.code === "ENOENT");
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 1);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
  });

  it("cleans once when real createWorkspace post-mkdtemp chmod rejects", async (t) => {
    let workspace;
    let cleanupCalls = 0;
    const fixture = await serviceFixture(t, {
      createWorkspaceImpl: (root, options) => createWorkspace(root, {
        ...options,
        fsImpl: {
          ...fs,
          mkdtemp: async (...args) => { workspace = await fs.mkdtemp(...args); return workspace; },
          chmod: async (path, mode) => {
            if (path === workspace) throw new Error("synthetic post-mkdtemp chmod rejection");
            return fs.chmod(path, mode);
          },
        },
      }),
      cleanupImpl: async (path, options) => {
        cleanupCalls += 1;
        return removeWorkspaceAndVerify(path, options);
      },
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-workspace-chmod-reject" })),
      /synthetic post-mkdtemp chmod rejection/u,
    );
    assert.equal(cleanupCalls, 1);
    await assert.rejects(fs.lstat(workspace), (error) => error.code === "ENOENT");
    await fixture.service.close();
  });

  it("removes a workspace that resolves after its request creation deadline", async (t) => {
    let resolveWorkspace;
    const fixture = await serviceFixture(t, {
      workspaceTimeoutMs: 10,
      createWorkspaceImpl: async () => new Promise((resolve) => { resolveWorkspace = resolve; }),
    });
    const lateWorkspace = await createWorkspace(fixture.root);
    const request = fixture.service.transcribe(requestInput({ key: "asr:synthetic-workspace-late" }));
    await assert.rejects(request, expectCode("ASR_TIMEOUT", 504));
    resolveWorkspace(lateWorkspace);
    await waitForCondition(async () => {
      try {
        await fs.lstat(lateWorkspace);
        return false;
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        throw error;
      }
    }, "late workspace was not removed");
    await assert.rejects(fs.lstat(lateWorkspace), (error) => error.code === "ENOENT");
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 0);
  });

  it("makes close wait for a workspace that resolves after its request deadline", async (t) => {
    let resolveWorkspace;
    const fixture = await serviceFixture(t, {
      workspaceTimeoutMs: 10,
      closeTimeoutMs: 250,
      createWorkspaceImpl: async () => new Promise((resolve) => { resolveWorkspace = resolve; }),
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-close-before-late-workspace" })),
      expectCode("ASR_TIMEOUT", 504),
    );
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 2);
    let closeSettled = false;
    const closing = fixture.service.close().finally(() => { closeSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closeSettled, false);

    const lateWorkspace = await createWorkspace(fixture.root);
    await fs.writeFile(join(lateWorkspace, "input.audio"), WAV_MAGIC, { mode: 0o600 });
    resolveWorkspace(lateWorkspace);
    await closing;
    await assert.rejects(fs.lstat(lateWorkspace), (error) => error.code === "ENOENT");
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 0);
    assert.deepEqual(await fs.readdir(fixture.root), []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await fs.readdir(fixture.root), []);
  });

  it("fails close cleanup-closed when late workspace cleanup throws", async (t) => {
    let resolveWorkspace;
    const fixture = await serviceFixture(t, {
      workspaceTimeoutMs: 10,
      closeTimeoutMs: 250,
      createWorkspaceImpl: async () => new Promise((resolve) => { resolveWorkspace = resolve; }),
      cleanupImpl: async () => { throw new Error("synthetic late cleanup failure"); },
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-late-cleanup-throw" })),
      expectCode("ASR_TIMEOUT", 504),
    );
    const lateWorkspace = await createWorkspace(fixture.root);
    await fs.writeFile(join(lateWorkspace, "input.audio"), WAV_MAGIC, { mode: 0o600 });
    const closing = fixture.service.close();
    const closingRejected = assert.rejects(closing, expectCode("ASR_CLEANUP_FAILED", 503));
    resolveWorkspace(lateWorkspace);
    await closingRejected;
    await assert.rejects(fs.lstat(lateWorkspace), (error) => error.code === "ENOENT");
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 0);
    assert.equal(fixture.service.lifecycleSnapshot().lateWorkspaceCleanupFailed, true);
  });

  it("bounds close when late workspace cleanup never settles", async (t) => {
    let resolveWorkspace;
    const fixture = await serviceFixture(t, {
      workspaceTimeoutMs: 10,
      closeTimeoutMs: 20,
      createWorkspaceImpl: async () => new Promise((resolve) => { resolveWorkspace = resolve; }),
      cleanupImpl: async () => new Promise(() => {}),
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-late-cleanup-never" })),
      expectCode("ASR_TIMEOUT", 504),
    );
    const lateWorkspace = await createWorkspace(fixture.root);
    await fs.writeFile(join(lateWorkspace, "input.audio"), WAV_MAGIC, { mode: 0o600 });
    resolveWorkspace(lateWorkspace);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.equal(fixture.service.lifecycleSnapshot().pendingWorkspaceLifecycles, 1);
    assert.equal((await fs.lstat(lateWorkspace)).isDirectory(), true);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
  });

  it("bounds a never-settling request cleanup and prevents close from passing it", async (t) => {
    const fixture = await serviceFixture(t, {
      requestCleanupTimeoutMs: TEST_LIFECYCLE_BUDGET_MS,
      closeTimeoutMs: 20,
      cleanupImpl: async () => new Promise(() => {}),
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-cleanup-timeout" })),
      expectCode("ASR_CLEANUP_FAILED", 503),
    );
    assert.equal(fixture.service.metrics.snapshot().gauges.inflight, 0);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
    assert.equal((await fs.readdir(fixture.root)).length, 1);
  });

  it("preserves a young confirmed residue across periodic sweep, then clears it after late cleanup", async (t) => {
    let releaseCleanup;
    let cleanupPath;
    let intervalCallback;
    const fixture = await serviceFixture(t, {
      requestCleanupTimeoutMs: TEST_LIFECYCLE_BUDGET_MS,
      closeTimeoutMs: 100,
      setIntervalImpl: (callback) => {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
      cleanupImpl: async (workspace) => {
        cleanupPath = workspace;
        return new Promise((resolve) => {
          releaseCleanup = async () => {
            await fs.rm(workspace, { recursive: true, force: true });
            resolve(true);
          };
        });
      },
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-cleanup-late-success" })),
      expectCode("ASR_CLEANUP_FAILED", 503),
    );
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
    assert.equal((await fs.lstat(cleanupPath)).isDirectory(), true);
    intervalCallback();
    await waitForCondition(
      () => !fixture.service.lifecycleSnapshot().periodicSweepActive,
      "young-residue periodic sweep did not finish",
    );
    assert.equal(fixture.service.lifecycleSnapshot().periodicSweepActive, false);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
    assert.equal((await fs.lstat(cleanupPath)).isDirectory(), true);
    await releaseCleanup();
    await waitForCondition(
      () => fixture.service.lifecycleSnapshot().pendingResourceLifecycles === 0,
      "late cleanup lifecycle did not reach zero",
    );
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 0);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
    await assert.rejects(fixture.service.close(), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
  });

  for (const replacement of ["file", "symlink"]) {
    it(`drops a confirmed residue identity when its path becomes a ${replacement} before late settlement`, async (t) => {
      let cleanupPath;
      let settleCleanup;
      let intervalCallback;
      const fixture = await serviceFixture(t, {
        requestCleanupTimeoutMs: TEST_LIFECYCLE_BUDGET_MS,
        closeTimeoutMs: 100,
        setIntervalImpl: (callback) => {
          intervalCallback = callback;
          return { unref() {} };
        },
        clearIntervalImpl: () => {},
        cleanupImpl: async (workspace) => {
          cleanupPath = workspace;
          return new Promise((resolve) => { settleCleanup = resolve; });
        },
      });
      await assert.rejects(
        fixture.service.transcribe(requestInput({
          key: `asr:synthetic-residue-becomes-${replacement}`,
        })),
        expectCode("ASR_CLEANUP_FAILED", 503),
      );
      assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
      assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
      await fs.rm(cleanupPath, { recursive: true, force: true });
      let outside = null;
      if (replacement === "file") {
        await fs.writeFile(cleanupPath, "synthetic replacement");
      } else {
        outside = join(dirname(fixture.root), `${basename(fixture.root)}-replacement-outside`);
        t.after(() => fs.rm(outside, { recursive: true, force: true }));
        await fs.mkdir(outside, { mode: 0o700 });
        await fs.symlink(outside, cleanupPath);
      }
      intervalCallback();
      await waitForCondition(
        () => !fixture.service.lifecycleSnapshot().periodicSweepActive,
        `${replacement} replacement periodic sweep did not finish`,
      );
      assert.equal(fixture.service.lifecycleSnapshot().periodicSweepActive, false);
      assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
      assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
      settleCleanup(true);
      await waitForCondition(
        () => fixture.service.lifecycleSnapshot().pendingResourceLifecycles === 0,
        `${replacement} replacement lifecycle did not reach zero`,
      );
      assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 0);
      assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
      await fs.rm(cleanupPath, { recursive: true, force: true });
      await assert.rejects(fixture.service.close(), expectCode("ASR_CLEANUP_FAILED", 503));
      assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
      assert.equal(outside === null || (await fs.lstat(outside)).isDirectory(), true);
    });
  }

  it("counts two distinct confirmed workspace residues in the stale gauge", async (t) => {
    const fixture = await serviceFixture(t, {
      requestCleanupTimeoutMs: TEST_LIFECYCLE_BUDGET_MS,
      closeTimeoutMs: 20,
      cleanupImpl: async () => new Promise(() => {}),
    });
    const requests = [0, 1].map((index) => fixture.service.transcribe(requestInput({
      owner: `owner-${index}`,
      key: `asr:synthetic-residue-${index}`,
    })));
    const settled = await Promise.allSettled(requests);
    assert.equal(settled.length, 2);
    for (const outcome of settled) {
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.reason.code, "ASR_CLEANUP_FAILED");
      assert.equal(outcome.reason.status, 503);
    }
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 2);
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 2);
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 2);
    assert.equal((await fs.readdir(fixture.root)).length, 2);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 2);
  });

  for (const closeOutcome of ["resolve", "reject", "never"]) {
    it(`tracks a service upload late-handle lifecycle whose close will ${closeOutcome}`, async (t) => {
      let resolveOpen;
      let realHandle;
      let openStartedResolve;
      const openStarted = new Promise((resolve) => { openStartedResolve = resolve; });
      let closeCalls = 0;
      const fixture = await serviceFixture(t, {
        requestCleanupTimeoutMs: 500,
        closeTimeoutMs: 30,
        writeAudioBodyImpl: (options) => writeAudioBody({
          ...options,
          wallTimeoutMs: 10,
          idleTimeoutMs: 1_000,
          cleanupTimeoutMs: closeOutcome === "never" ? 20 : 100,
          openFile: async (path, flags, mode) => {
            realHandle = await fs.open(path, flags, mode);
            openStartedResolve();
            return new Promise((resolve) => { resolveOpen = resolve; });
          },
        }),
      });
      const request = fixture.service.transcribe(requestInput({
        key: `asr:synthetic-service-late-handle-${closeOutcome}`,
      }));
      const expectedRequest = closeOutcome === "resolve"
        ? expectCode("ASR_TIMEOUT", 504)
        : expectCode("ASR_CLEANUP_FAILED", 503);
      const rejection = assert.rejects(request, expectedRequest);
      await openStarted;
      await new Promise((resolve) => setTimeout(resolve, 15));
      resolveOpen({
        close: async () => {
          closeCalls += 1;
          if (closeOutcome === "resolve") return realHandle.close();
          if (closeOutcome === "reject") throw new Error("synthetic service late close rejection");
          return new Promise(() => {});
        },
      });
      await rejection;
      assert.equal(closeCalls, 1);
      assert.equal(fixture.service.metrics.snapshot().gauges.inflight, 0);
      assert.deepEqual(await fs.readdir(fixture.root), []);
      if (closeOutcome === "resolve") {
        assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 0);
        assert.equal(fixture.service.lifecycleSnapshot().resourceCleanupFailed, false);
        await fixture.service.close();
        await assert.rejects(realHandle.stat(), (error) => error.code === "EBADF");
      } else if (closeOutcome === "reject") {
        assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 0);
        assert.equal(fixture.service.lifecycleSnapshot().resourceCleanupFailed, true);
        await assert.rejects(fixture.service.close(), expectCode("ASR_CLEANUP_FAILED", 503));
        await realHandle.close();
      } else {
        assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
        assert.equal(fixture.service.lifecycleSnapshot().resourceCleanupFailed, true);
        await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
        await realHandle.close();
      }
    });
  }

  it("fails disabled mode before workspace, body, or provider", async (t) => {
    let workspaceCalls = 0;
    let writerCalls = 0;
    const providerCalls = [];
    const fixture = await serviceFixture(t, {
      mode: "disabled",
      providerCalls,
      createWorkspaceImpl: async () => { workspaceCalls += 1; },
      writeAudioBodyImpl: async () => { writerCalls += 1; },
    });
    await assert.rejects(fixture.service.transcribe(requestInput()), expectCode("ASR_NOT_CONFIGURED", 503));
    assert.equal(workspaceCalls, 0);
    assert.equal(writerCalls, 0);
    assert.equal(providerCalls.length, 0);
  });

  it("requires the HTTP-safe unread-body termination callback before business processing", async (t) => {
    let workspaceCalls = 0;
    const fixture = await serviceFixture(t, {
      createWorkspaceImpl: async () => { workspaceCalls += 1; },
    });
    for (const invalidCallback of [undefined, "not-a-function"]) {
      const unread = deferredUnreadBody();
      const input = requestInput({ body: unread.body });
      if (invalidCallback === undefined) delete input.deferUnreadBodyTermination;
      else input.deferUnreadBodyTermination = invalidCallback;
      await assert.rejects(
        fixture.service.transcribe(input),
        expectCode("ASR_NOT_CONFIGURED", 503),
      );
      assert.equal(unread.snapshot().destroyCalls, 0);
      assert.equal(unread.snapshot().destroyed, false);
    }
    assert.equal(workspaceCalls, 0);
    assert.equal(fixture.providerCalls.length, 0);
  });

  it("fails cleanup-closed and records lifecycle state when deferred termination registration throws", async (t) => {
    const fixture = await serviceFixture(t, { mode: "disabled" });
    const unread = deferredUnreadBody();
    let finalizer;
    await assert.rejects(fixture.service.transcribe(requestInput({
      body: unread.body,
      deferUnreadBodyTermination: (terminate) => {
        finalizer = terminate;
        throw new Error("synthetic HTTP lifecycle failure");
      },
    })), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.equal(unread.snapshot().destroyCalls, 0);
    assert.equal(unread.snapshot().destroyed, false);
    assert.equal(finalizer(), true);
    assert.equal(unread.snapshot().destroyCalls, 1);
    assert.equal(fixture.service.lifecycleSnapshot().unreadBodyTerminationFailed, true);
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 1);
    await assert.rejects(fixture.service.close(), expectCode("ASR_CLEANUP_FAILED", 503));
  });

  it("keeps deferred unread-body finalization available when upload pipeline throws synchronously", async (t) => {
    const unread = deferredUnreadBody();
    let finalizer;
    const fixture = await serviceFixture(t, {
      writeAudioBodyImpl: (options) => writeAudioBody({
        ...options,
        pipelineImpl: () => { throw new Error("synthetic synchronous pipeline failure"); },
      }),
    });
    await assert.rejects(fixture.service.transcribe(requestInput({
      key: "asr:synthetic-sync-pipeline-finalizer",
      body: unread.body,
      deferUnreadBodyTermination: (terminate) => { finalizer = terminate; },
    })), /synthetic synchronous pipeline failure/u);
    assert.equal(typeof finalizer, "function");
    assert.equal(unread.snapshot().destroyCalls, 0);
    assert.equal(finalizer(), true);
    assert.equal(finalizer(), false);
    assert.equal(unread.snapshot().destroyCalls, 1);
    assert.equal(fixture.providerCalls.length, 0);
    assert.deepEqual(await fs.readdir(fixture.root), []);
  });

  it("counts two independent unread-body registration failures exactly once each", async (t) => {
    const fixture = await serviceFixture(t, { mode: "disabled" });
    for (let index = 0; index < 2; index += 1) {
      const unread = deferredUnreadBody();
      await assert.rejects(fixture.service.transcribe(requestInput({
        key: `asr:synthetic-unread-failure-${index}`,
        body: unread.body,
        deferUnreadBodyTermination: () => {
          throw new Error(`synthetic unread registration failure ${index}`);
        },
      })), expectCode("ASR_CLEANUP_FAILED", 503));
    }
    assert.equal(fixture.service.lifecycleSnapshot().unreadBodyTerminationFailed, true);
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 2);
    await assert.rejects(fixture.service.close(), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 2);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
  });

  it("keeps a direct IncomingMessage 503 response intact until the finalizer destroys the body", async (t) => {
    const fixture = await serviceFixture(t, { mode: "disabled" });
    const server = createServer((req, res) => {
      let finalizer;
      let responseFinished = false;
      const originalDestroy = req.destroy.bind(req);
      req.destroy = (...args) => {
        assert.equal(responseFinished, true);
        return originalDestroy(...args);
      };
      fixture.service.transcribe(requestInput({
        body: req,
        deferUnreadBodyTermination: (terminate) => {
          finalizer = terminate;
          throw new Error("synthetic response-finalizer registration error");
        },
      })).then(
        () => { res.statusCode = 500; res.end(JSON.stringify({ code: "UNEXPECTED" })); },
        (error) => {
          res.statusCode = error.status ?? 503;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ code: error.code }));
          res.once("finish", () => {
            responseFinished = true;
            finalizer?.();
          });
        },
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const payload = Buffer.from("synthetic unread body");
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/asr",
        headers: { "content-type": "audio/wav", "content-length": String(payload.byteLength) },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      request.end(payload);
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.body), { code: "ASR_CLEANUP_FAILED" });
  });

  it("keeps a direct IncomingMessage 429 response and Retry-After intact until finalization", async (t) => {
    const fixture = await serviceFixture(t, {
      uploadCapacity: {
        acquire() {
          throw new AsrContractError("ASR_CAPACITY_EXCEEDED", 429, "synthetic capacity");
        },
      },
    });
    const server = createServer((req, res) => {
      let finalizer;
      let responseFinished = false;
      const originalDestroy = req.destroy.bind(req);
      req.destroy = (...args) => {
        assert.equal(responseFinished, true);
        return originalDestroy(...args);
      };
      fixture.service.transcribe(requestInput({
        body: req,
        deferUnreadBodyTermination: (terminate) => {
          finalizer = terminate;
        },
      })).then(
        () => { res.statusCode = 500; res.end(JSON.stringify({ code: "UNEXPECTED" })); },
        (error) => {
          res.statusCode = error.status ?? 503;
          if (error.code === "ASR_CAPACITY_EXCEEDED") res.setHeader("retry-after", "1");
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ code: error.code }));
          res.once("finish", () => {
            responseFinished = true;
            finalizer?.();
          });
        },
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const payload = Buffer.from("synthetic unread body");
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/asr",
        headers: { "content-type": "audio/wav", "content-length": String(payload.byteLength) },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          statusCode: res.statusCode,
          retryAfter: res.headers["retry-after"],
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.on("error", reject);
      request.end(payload);
    });
    assert.equal(response.statusCode, 429);
    assert.equal(response.retryAfter, "1");
    assert.deepEqual(JSON.parse(response.body), { code: "ASR_CAPACITY_EXCEEDED" });
  });

  it("defers unread-body termination until the HTTP layer finishes a disabled response", async (t) => {
    const fixture = await serviceFixture(t, { mode: "disabled" });
    const unread = deferredUnreadBody();
    await assert.rejects(fixture.service.transcribe(requestInput({
      body: unread.body,
      deferUnreadBodyTermination: (terminate) => unread.defer(terminate),
    })), expectCode("ASR_NOT_CONFIGURED", 503));
    const beforeFinish = unread.snapshot();
    assert.equal(beforeFinish.deferCalls, 1);
    assert.equal(beforeFinish.destroyCalls, 0);
    assert.equal(beforeFinish.destroyed, false);
    assert.equal(beforeFinish.deferredTermination(), true);
    assert.equal(beforeFinish.deferredTermination(), false);
    assert.deepEqual(unread.snapshot(), {
      destroyCalls: 1,
      deferCalls: 1,
      deferredTermination: beforeFinish.deferredTermination,
      destroyed: true,
    });
  });

  it("defers unread-body termination after the service has closed", async (t) => {
    const fixture = await serviceFixture(t);
    await fixture.service.close();
    const unread = deferredUnreadBody();
    await assert.rejects(fixture.service.transcribe(requestInput({
      body: unread.body,
      deferUnreadBodyTermination: (terminate) => unread.defer(terminate),
    })), expectCode("ASR_NOT_CONFIGURED", 503));
    assert.equal(unread.snapshot().destroyed, false);
    assert.equal(unread.snapshot().deferCalls, 1);
    unread.snapshot().deferredTermination();
    assert.equal(unread.snapshot().destroyCalls, 1);
  });

  it("defers unread-body termination for provider-not-ready and invalid-input fast rejects", async (t) => {
    const notReady = await serviceFixture(t, {
      provider: {
        id: "openai-compatible",
        readiness: () => ({ ready: false, code: "NOT_READY" }),
        async transcribe() { throw new Error("must not run"); },
      },
    });
    const notReadyBody = deferredUnreadBody();
    await assert.rejects(notReady.service.transcribe(requestInput({
      body: notReadyBody.body,
      deferUnreadBodyTermination: (terminate) => notReadyBody.defer(terminate),
    })), expectCode("ASR_NOT_CONFIGURED", 503));
    assert.equal(notReadyBody.snapshot().destroyed, false);
    assert.equal(notReadyBody.snapshot().deferCalls, 1);
    notReadyBody.snapshot().deferredTermination();
    assert.equal(notReadyBody.snapshot().destroyCalls, 1);

    const valid = await serviceFixture(t);
    const invalidBody = deferredUnreadBody();
    await assert.rejects(valid.service.transcribe({
      ...requestInput({
        body: invalidBody.body,
        deferUnreadBodyTermination: (terminate) => invalidBody.defer(terminate),
      }),
      owner: "",
    }), /owner/u);
    assert.equal(invalidBody.snapshot().destroyed, false);
    assert.equal(invalidBody.snapshot().deferCalls, 1);
    invalidBody.snapshot().deferredTermination();
    assert.equal(invalidBody.snapshot().destroyCalls, 1);
  });

  it("times out a request-local preflight without waiting for shared initialize", async (t) => {
    let releaseSweep;
    let sweepStarted;
    const preflightBodyTimeoutMs = 57_127;
    const manualPreflightTimers = new Set();
    const preflightTimeoutCallbacks = [];
    const started = new Promise((resolve) => { sweepStarted = resolve; });
    const fixture = await serviceFixture(t, {
      initialize: false,
      preflightBodyTimeoutMs,
      closeTimeoutMs: 15,
      setTimeoutImpl: (callback, milliseconds) => {
        if (milliseconds === preflightBodyTimeoutMs && preflightTimeoutCallbacks.length < 2) {
          preflightTimeoutCallbacks.push(callback);
          const timer = Object.freeze({
            kind: preflightTimeoutCallbacks.length === 1
              ? "manual-unread-body-timeout"
              : "manual-initialization-timeout",
          });
          manualPreflightTimers.add(timer);
          return timer;
        }
        return setTimeout(callback, milliseconds);
      },
      clearTimeoutImpl: (timer) => {
        if (!manualPreflightTimers.has(timer)) clearTimeout(timer);
      },
      sweepImpl: async () => {
        sweepStarted();
        await new Promise((resolve) => { releaseSweep = resolve; });
        return { ready: true, removedCount: 0, staleCount: 0, anomalyCount: 0 };
      },
    });
    const unread = deferredUnreadBody();
    const request = fixture.service.transcribe(requestInput({
      body: unread.body,
      deferUnreadBodyTermination: (terminate) => unread.defer(terminate),
    }));
    const requestRejected = assert.rejects(request, expectCode("ASR_TIMEOUT", 504));
    await started;
    assert.equal(preflightTimeoutCallbacks.length, 2);
    preflightTimeoutCallbacks[1]();
    await requestRejected;
    assert.equal(unread.snapshot().deferCalls, 1);
    assert.equal(unread.snapshot().destroyed, false);
    assert.equal(fixture.service.lifecycleSnapshot().activeRequests, 0);
    assert.equal(fixture.service.lifecycleSnapshot().activeControllers, 0);
    unread.snapshot().deferredTermination();
    assert.equal(unread.snapshot().destroyCalls, 1);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.equal(fixture.service.lifecycleSnapshot().activeRequests, 0);
    releaseSweep();
  });

  it("lets caller abort a request-local preflight without cancelling shared initialize", async (t) => {
    let releaseSweep;
    let sweepStarted;
    const preflightBodyTimeoutMs = 57_239;
    const manualPreflightTimers = new Set();
    let preflightTimerRegistrations = 0;
    const started = new Promise((resolve) => { sweepStarted = resolve; });
    const fixture = await serviceFixture(t, {
      initialize: false,
      preflightBodyTimeoutMs,
      closeTimeoutMs: 15,
      setTimeoutImpl: (callback, milliseconds) => {
        if (milliseconds === preflightBodyTimeoutMs && preflightTimerRegistrations < 2) {
          preflightTimerRegistrations += 1;
          const timer = Object.freeze({
            kind: preflightTimerRegistrations === 1
              ? "manual-unread-body-timeout"
              : "manual-initialization-timeout",
          });
          manualPreflightTimers.add(timer);
          return timer;
        }
        return setTimeout(callback, milliseconds);
      },
      clearTimeoutImpl: (timer) => {
        if (!manualPreflightTimers.has(timer)) clearTimeout(timer);
      },
      sweepImpl: async () => {
        sweepStarted();
        await new Promise((resolve) => { releaseSweep = resolve; });
        return { ready: true, removedCount: 0, staleCount: 0, anomalyCount: 0 };
      },
    });
    const unread = deferredUnreadBody();
    const controller = new AbortController();
    const request = fixture.service.transcribe(requestInput({
      key: "asr:synthetic-init-abort",
      body: unread.body,
      signal: controller.signal,
      deferUnreadBodyTermination: (terminate) => unread.defer(terminate),
    }));
    const requestRejected = assert.rejects(request, (error) => error.name === "AbortError");
    await started;
    assert.equal(preflightTimerRegistrations, 2);
    controller.abort(new DOMException("synthetic init cancel", "AbortError"));
    await requestRejected;
    assert.equal(unread.snapshot().deferCalls, 1);
    assert.equal(fixture.service.lifecycleSnapshot().activeRequests, 0);
    unread.snapshot().deferredTermination();
    assert.equal(unread.snapshot().destroyCalls, 1);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    releaseSweep();
  });

  it("keeps shared initialize usable after one request-local preflight timeout", async (t) => {
    let releaseSweep;
    let sweepStarted;
    let sweepCalls = 0;
    const preflightBodyTimeoutMs = 57_913;
    const manualPreflightTimers = new Set();
    let preflightTimerRegistrations = 0;
    let fireInitializationTimeout = null;
    const started = new Promise((resolve) => { sweepStarted = resolve; });
    const fixture = await serviceFixture(t, {
      initialize: false,
      preflightBodyTimeoutMs,
      setTimeoutImpl: (callback, milliseconds) => {
        if (milliseconds === preflightBodyTimeoutMs && preflightTimerRegistrations < 2) {
          preflightTimerRegistrations += 1;
          const timer = Object.freeze({
            kind: preflightTimerRegistrations === 1
              ? "manual-unread-body-timeout"
              : "manual-initialization-timeout",
          });
          manualPreflightTimers.add(timer);
          if (preflightTimerRegistrations === 2) fireInitializationTimeout = callback;
          return timer;
        }
        return setTimeout(callback, milliseconds);
      },
      clearTimeoutImpl: (timer) => {
        if (!manualPreflightTimers.has(timer)) clearTimeout(timer);
      },
      sweepImpl: async () => {
        sweepCalls += 1;
        if (sweepCalls > 1) {
          return { ready: true, removedCount: 0, staleCount: 0, anomalyCount: 0 };
        }
        sweepStarted();
        await new Promise((resolve) => { releaseSweep = resolve; });
        return { ready: true, removedCount: 0, staleCount: 0, anomalyCount: 0 };
      },
    });
    const firstRequest = fixture.service.transcribe(requestInput({
      key: "asr:synthetic-init-local-timeout",
    }));
    const firstRequestRejected = assert.rejects(
      firstRequest,
      expectCode("ASR_TIMEOUT", 504),
    );
    await started;
    assert.equal(preflightTimerRegistrations, 2);
    assert.equal(typeof fireInitializationTimeout, "function");
    fireInitializationTimeout();
    await firstRequestRejected;
    releaseSweep();
    assert.deepEqual(await fixture.service.initialize(), { ready: true, code: "READY" });
    const result = await fixture.service.transcribe(requestInput({
      key: "asr:synthetic-init-after-local-timeout",
    }));
    assert.equal(result.transcript, "合成转写结果");
  });

  it("sweeps an existing request workspace in disabled mode without touching provider readiness", async (t) => {
    const root = await tempRoot(t);
    const staleWorkspace = await createWorkspace(root);
    await fs.writeFile(join(staleWorkspace, "input.audio"), WAV_MAGIC, { mode: 0o600 });
    let readinessCalls = 0;
    const fixture = await serviceFixture(t, {
      root,
      mode: "disabled",
      provider: {
        id: "openai-compatible",
        readiness() { readinessCalls += 1; return { ready: true, code: "READY" }; },
        async transcribe() { throw new Error("disabled provider must not run"); },
      },
    });
    await assert.rejects(fs.lstat(staleWorkspace), (error) => error.code === "ENOENT");
    assert.equal(readinessCalls, 0);
    assert.deepEqual(fixture.service.readiness(), { ready: false, code: "ASR_DISABLED" });
  });

  it("does not create a missing temporary root when disabled initialize and close only clean", async (t) => {
    const parent = await tempRoot(t);
    const missingRoot = join(parent, "missing-disabled-root");
    let readinessCalls = 0;
    const fixture = await serviceFixture(t, {
      root: missingRoot,
      mode: "disabled",
      provider: {
        id: "openai-compatible",
        readiness() { readinessCalls += 1; return { ready: true, code: "READY" }; },
        async transcribe() { throw new Error("disabled provider must not run"); },
      },
    });
    await assert.rejects(fs.lstat(missingRoot), (error) => error.code === "ENOENT");
    await fixture.service.close();
    await assert.rejects(fs.lstat(missingRoot), (error) => error.code === "ENOENT");
    assert.equal(readinessCalls, 0);
  });

  it("sweeps existing audio before a provider readiness failure", async (t) => {
    const root = await tempRoot(t);
    const staleWorkspace = await createWorkspace(root);
    await fs.writeFile(join(staleWorkspace, "input.audio"), WAV_MAGIC, { mode: 0o600 });
    let readinessCalls = 0;
    const fixture = await serviceFixture(t, {
      root,
      provider: {
        id: "openai-compatible",
        readiness() { readinessCalls += 1; return { ready: false, code: "NOT_READY" }; },
        async transcribe() { throw new Error("unready provider must not run"); },
      },
    });
    await assert.rejects(fs.lstat(staleWorkspace), (error) => error.code === "ENOENT");
    assert.equal(readinessCalls, 1);
    assert.deepEqual(fixture.service.readiness(), { ready: false, code: "ASR_NOT_CONFIGURED" });
  });

  it("sweeps existing audio before a provider constructor rejects invalid configuration", async (t) => {
    const root = await tempRoot(t);
    const staleWorkspace = await createWorkspace(root);
    await fs.writeFile(join(staleWorkspace, "input.audio"), WAV_MAGIC, { mode: 0o600 });
    let keyCalls = 0;
    const service = createAsrService({
      asrMode: "live",
      asrProvider: "openai-compatible",
      asrBaseUrl: "not-a-provider-url",
      asrModel: "synthetic-asr",
      asrTempRoot: root,
      asrReuseModelCredential: false,
      authSessionSecret: HMAC_FIXTURE,
    }, {
      asrApiKeyProvider: async () => { keyCalls += 1; return HMAC_FIXTURE; },
    });
    t.after(async () => {
      try { await service.close(); } catch { /* this case asserts initialize behavior */ }
    });
    assert.deepEqual(await service.initialize(), { ready: false, code: "ASR_NOT_CONFIGURED" });
    await assert.rejects(fs.lstat(staleWorkspace), (error) => error.code === "ENOENT");
    assert.equal(keyCalls, 0);
  });

  it("degrades startup on an anomalous runtime entry and rejects before provider", async (t) => {
    const root = await tempRoot(t);
    await fs.writeFile(join(root, "unexpected"), "synthetic");
    const fixture = await serviceFixture(t, { root });
    assert.deepEqual(fixture.service.readiness(), { ready: false, code: "ASR_TEMP_ROOT_DEGRADED" });
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
    await assert.rejects(fixture.service.transcribe(requestInput()), expectCode("ASR_NOT_CONFIGURED"));
    assert.equal(fixture.providerCalls.length, 0);
  });

  it("reports a nonmatching real directory as one stale directory while degrading readiness", async (t) => {
    const root = await tempRoot(t);
    await fs.mkdir(join(root, "nonmatching-directory"), { mode: 0o700 });
    const fixture = await serviceFixture(t, { root });
    assert.deepEqual(fixture.service.readiness(), { ready: false, code: "ASR_TEMP_ROOT_DEGRADED" });
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
    await assert.rejects(fixture.service.transcribe(requestInput()), expectCode("ASR_NOT_CONFIGURED"));
  });
});

describe("ASR service idempotency and processing precedence", () => {
  it("replays completed same fingerprint without a second transcode/provider call", async (t) => {
    let transcodeCalls = 0;
    const providerCalls = [];
    const fixture = await serviceFixture(t, {
      providerCalls,
      transcodeImpl: async ({ outputPath }) => {
        transcodeCalls += 1;
        await fs.writeFile(outputPath, createCanonicalWavHeader(32_000), { mode: 0o600 });
        return { outputPath, pcmBytes: 32_000, durationMs: 1_000, byteLength: 32_044 };
      },
    });
    const first = await fixture.service.transcribe(requestInput({ key: "asr:synthetic-replay-0001" }));
    const replay = await fixture.service.transcribe(requestInput({ key: "asr:synthetic-replay-0001" }));
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.transcript, first.transcript);
    assert.equal(transcodeCalls, 1);
    assert.equal(providerCalls.length, 1);
    await assertWorkspacesRemoved(fixture.workspaces);
  });

  it("fast-fails a pending owner/key before workspace or body, then stabilizes different audio as CONFLICT", async (t) => {
    let releaseProvider;
    let providerStarted;
    const started = new Promise((resolve) => { providerStarted = resolve; });
    let createWorkspaceCalls = 0;
    let writeAudioBodyCalls = 0;
    let probeCalls = 0;
    let transcodeCalls = 0;
    const providerCalls = [];
    const uploadCapacity = createUploadCapacity();
    const fixture = await serviceFixture(t, {
      providerCalls,
      uploadCapacity,
      createWorkspaceImpl: async (...args) => {
        createWorkspaceCalls += 1;
        return createWorkspace(...args);
      },
      writeAudioBodyImpl: async ({ readable, outputPath, reservation, onPipelineStart }) => {
        writeAudioBodyCalls += 1;
        assert.equal(onPipelineStart(), true);
        const chunks = [];
        let byteLength = 0;
        for await (const chunk of readable) {
          const bytes = Buffer.from(chunk);
          chunks.push(bytes);
          byteLength += bytes.byteLength;
          reservation.reserveChunk(bytes.byteLength);
        }
        await fs.writeFile(outputPath, Buffer.concat(chunks), { mode: 0o600 });
        reservation.finishUpload(byteLength);
        return {
          byteLength,
          sha256: readable.syntheticHash,
          magicBytes: Uint8Array.from(WAV_MAGIC),
        };
      },
      probeAudioImpl: async () => {
        probeCalls += 1;
        return { durationMs: 1_000, formatNames: ["wav"], audioStream: {} };
      },
      transcodeImpl: async ({ outputPath }) => {
        transcodeCalls += 1;
        await fs.writeFile(outputPath, createCanonicalWavHeader(32_000), { mode: 0o600 });
        return { outputPath, pcmBytes: 32_000, durationMs: 1_000, byteLength: 32_044 };
      },
      provider: {
        id: "openai-compatible",
        readiness: () => ({ ready: true, code: "READY" }),
        transcribe(input) {
          providerCalls.push(input);
          providerStarted();
          return new Promise((resolve) => { releaseProvider = () => resolve({ text: "first result" }); });
        },
      },
    });
    const key = "asr:synthetic-pending-0001";
    const first = fixture.service.transcribe(requestInput({ key, hashSeed: "a" }));
    await started;
    const capacityHolds = Array.from({ length: 4 }, () => uploadCapacity.acquire(null));
    const callsBeforePendingRetry = {
      createWorkspaceCalls,
      writeAudioBodyCalls,
      probeCalls,
      transcodeCalls,
      providerCalls: providerCalls.length,
    };
    const capacityBeforePendingRetry = structuredClone(fixture.service.capacitySnapshot());
    const metricsBeforePendingRetry = structuredClone(fixture.service.metrics.snapshot());
    const gaugesBeforePendingRetry = metricsBeforePendingRetry.gauges;
    const rootEntriesBeforePendingRetry = (await fs.readdir(fixture.root)).toSorted();
    let bodyReadCalls = 0;
    let deferredTermination = null;
    let deferCalls = 0;
    let destroyCalls = 0;
    const retryBody = new Readable({
      read() {
        bodyReadCalls += 1;
        this.push(WAV_MAGIC);
        this.push(null);
      },
    });
    retryBody.syntheticHash = "b".repeat(64);
    const originalDestroy = retryBody.destroy.bind(retryBody);
    retryBody.destroy = (...args) => {
      destroyCalls += 1;
      return originalDestroy(...args);
    };
    try {
      await assert.rejects(
        fixture.service.transcribe({
          ...requestInput({ key, hashSeed: "b" }),
          purpose: "synthetic-invalid-purpose",
        }),
        TypeError,
      );
      await assert.rejects(
        fixture.service.transcribe(requestInput({
          key,
          body: retryBody,
          deferUnreadBodyTermination: (terminate) => {
            deferCalls += 1;
            deferredTermination = terminate;
          },
        })),
        expectCode("ASR_IN_PROGRESS", 409),
      );
      assert.deepEqual({
        createWorkspaceCalls,
        writeAudioBodyCalls,
        probeCalls,
        transcodeCalls,
        providerCalls: providerCalls.length,
      }, callsBeforePendingRetry);
      assert.deepEqual(fixture.service.capacitySnapshot(), capacityBeforePendingRetry);
      const metricsAfterPendingRetry = fixture.service.metrics.snapshot();
      assert.deepEqual(metricsAfterPendingRetry.gauges, gaugesBeforePendingRetry);
      assert.equal(
        metricsAfterPendingRetry.counters.requestsTotal[
          "quick_record|openai-compatible|error|ASR_IN_PROGRESS"
        ],
        (metricsBeforePendingRetry.counters.requestsTotal[
          "quick_record|openai-compatible|error|ASR_IN_PROGRESS"
        ] ?? 0) + 1,
      );
      assert.equal(
        metricsAfterPendingRetry.counters.outcomes["error|ASR_IN_PROGRESS"],
        (metricsBeforePendingRetry.counters.outcomes["error|ASR_IN_PROGRESS"] ?? 0) + 1,
      );
      assert.equal(
        metricsAfterPendingRetry.window.sampleCount,
        metricsBeforePendingRetry.window.sampleCount + 1,
      );
      assert.deepEqual(
        metricsAfterPendingRetry.counters.providerCallsTotal,
        metricsBeforePendingRetry.counters.providerCallsTotal,
      );
      assert.deepEqual((await fs.readdir(fixture.root)).toSorted(), rootEntriesBeforePendingRetry);
      assert.equal(bodyReadCalls, 0);
      assert.equal(deferCalls, 1);
      assert.equal(retryBody.destroyed, false);
      assert.equal(destroyCalls, 0);
      assert.equal(typeof deferredTermination, "function");
      assert.equal(deferredTermination(), true);
      assert.equal(retryBody.destroyed, true);
      assert.equal(destroyCalls, 1);
    } finally {
      for (const hold of capacityHolds) hold.abort();
      releaseProvider();
    }
    await first;
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key, hashSeed: "b" })),
      expectCode("IDEMPOTENCY_CONFLICT", 409),
    );
    assert.equal(providerCalls.length, 1);
    assert.equal(fixture.service.capacitySnapshot().idempotency.completed, 1);
    assert.deepEqual(await fs.readdir(fixture.root), []);
  });

  it("records a pending retry unread-body registration failure as the final cleanup outcome once", async (t) => {
    let releaseProvider;
    let providerStarted;
    const started = new Promise((resolve) => { providerStarted = resolve; });
    const completionEvents = [];
    const baseMetrics = createAsrMetrics();
    const metrics = Object.freeze({
      ...baseMetrics,
      recordCompletion(event) {
        completionEvents.push(structuredClone(event));
        return baseMetrics.recordCompletion(event);
      },
    });
    let providerCalls = 0;
    const fixture = await serviceFixture(t, {
      metrics,
      provider: {
        id: "openai-compatible",
        readiness: () => ({ ready: true, code: "READY" }),
        transcribe() {
          providerCalls += 1;
          providerStarted();
          return new Promise((resolve) => {
            releaseProvider = () => resolve({ text: "first result" });
          });
        },
      },
    });
    const key = "asr:synthetic-pending-metrics-0001";
    const first = fixture.service.transcribe(requestInput({ key, hashSeed: "a" }));
    await started;
    const metricsBeforeRetry = structuredClone(metrics.snapshot());
    const capacityBeforeRetry = structuredClone(fixture.service.capacitySnapshot());
    const lifecycleBeforeRetry = structuredClone(fixture.service.lifecycleSnapshot());
    let bodyReadCalls = 0;
    let deferCalls = 0;
    const retryBody = new Readable({
      read() {
        bodyReadCalls += 1;
        this.push(WAV_MAGIC);
        this.push(null);
      },
    });
    retryBody.syntheticHash = "b".repeat(64);
    try {
      await assert.rejects(
        fixture.service.transcribe(requestInput({
          key,
          body: retryBody,
          deferUnreadBodyTermination: () => {
            deferCalls += 1;
            throw new Error("synthetic defer registration failure");
          },
        })),
        expectCode("ASR_CLEANUP_FAILED", 503),
      );
      const metricsAfterRetry = metrics.snapshot();
      assert.equal(
        metricsAfterRetry.counters.requestsTotal[
          "quick_record|openai-compatible|error|ASR_IN_PROGRESS"
        ] ?? 0,
        metricsBeforeRetry.counters.requestsTotal[
          "quick_record|openai-compatible|error|ASR_IN_PROGRESS"
        ] ?? 0,
      );
      assert.equal(
        metricsAfterRetry.counters.requestsTotal[
          "quick_record|openai-compatible|error|ASR_CLEANUP_FAILED"
        ],
        (metricsBeforeRetry.counters.requestsTotal[
          "quick_record|openai-compatible|error|ASR_CLEANUP_FAILED"
        ] ?? 0) + 1,
      );
      assert.equal(
        metricsAfterRetry.counters.outcomes["error|ASR_IN_PROGRESS"] ?? 0,
        metricsBeforeRetry.counters.outcomes["error|ASR_IN_PROGRESS"] ?? 0,
      );
      assert.equal(
        metricsAfterRetry.counters.outcomes["error|ASR_CLEANUP_FAILED"],
        (metricsBeforeRetry.counters.outcomes["error|ASR_CLEANUP_FAILED"] ?? 0) + 1,
      );
      assert.equal(
        metricsAfterRetry.counters.cleanupFailuresTotal,
        metricsBeforeRetry.counters.cleanupFailuresTotal + 1,
      );
      assert.deepEqual(
        {
          outcome: completionEvents.at(-1)?.outcome,
          errorCode: completionEvents.at(-1)?.errorCode,
          cleanupVerified: completionEvents.at(-1)?.cleanupVerified,
        },
        {
          outcome: "error",
          errorCode: "ASR_CLEANUP_FAILED",
          cleanupVerified: false,
        },
      );
      assert.deepEqual(metricsAfterRetry.gauges, metricsBeforeRetry.gauges);
      assert.deepEqual(fixture.service.capacitySnapshot(), capacityBeforeRetry);
      const lifecycleAfterRetry = fixture.service.lifecycleSnapshot();
      assert.equal(lifecycleAfterRetry.activeRequests, lifecycleBeforeRetry.activeRequests);
      assert.equal(lifecycleAfterRetry.activeControllers, lifecycleBeforeRetry.activeControllers);
      assert.equal(
        lifecycleAfterRetry.pendingResourceLifecycles,
        lifecycleBeforeRetry.pendingResourceLifecycles,
      );
      assert.equal(bodyReadCalls, 0);
      assert.equal(deferCalls, 1);
      assert.equal(retryBody.destroyed, false);
      assert.equal(providerCalls, 1);
    } finally {
      releaseProvider();
      await first;
    }
    assert.deepEqual(fixture.service.metrics.snapshot().gauges, {
      inflight: 0,
      activeUploads: 0,
      tempBytes: 0,
      staleTempDirectories: 0,
    });
    assert.equal(fixture.service.lifecycleSnapshot().activeRequests, 0);
    assert.equal(fixture.service.lifecycleSnapshot().activeControllers, 0);
  });

  it("isolates identical key/audio across owners and calls provider once per owner", async (t) => {
    const fixture = await serviceFixture(t);
    const key = "asr:synthetic-owner-scope";
    await fixture.service.transcribe(requestInput({ key, owner: "owner-a" }));
    await fixture.service.transcribe(requestInput({ key, owner: "owner-b" }));
    assert.equal(fixture.providerCalls.length, 2);
    assert.equal(fixture.service.capacitySnapshot().idempotency.completed, 2);
  });

  it("returns owner processing capacity before a second provider call", async (t) => {
    let startedResolve;
    let providerResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const providerCalls = [];
    const fixture = await serviceFixture(t, {
      providerCalls,
      provider: {
        id: "openai-compatible",
        readiness: () => ({ ready: true, code: "READY" }),
        transcribe(input) {
          providerCalls.push(input);
          startedResolve();
          return new Promise((resolve) => { providerResolve = resolve; });
        },
      },
    });
    const first = fixture.service.transcribe(requestInput({ key: "asr:synthetic-owner-cap-1" }));
    await started;
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-owner-cap-2" })),
      expectCode("ASR_CAPACITY_EXCEEDED", 429),
    );
    assert.equal(providerCalls.length, 1);
    providerResolve({ text: "done" });
    await first;
  });

  it("returns global processing capacity on owner three while two providers run", async (t) => {
    const releases = [];
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const fixture = await serviceFixture(t, {
      provider: {
        id: "openai-compatible",
        readiness: () => ({ ready: true, code: "READY" }),
        transcribe(input) {
          fixture.providerCalls.push(input);
          if (fixture.providerCalls.length === 2) startedResolve();
          return new Promise((resolve) => releases.push(resolve));
        },
      },
    });
    const first = fixture.service.transcribe(requestInput({ owner: "owner-a", key: "asr:synthetic-global-1" }));
    const second = fixture.service.transcribe(requestInput({ owner: "owner-b", key: "asr:synthetic-global-2" }));
    await started;
    await assert.rejects(
      fixture.service.transcribe(requestInput({ owner: "owner-c", key: "asr:synthetic-global-3" })),
      expectCode("ASR_CAPACITY_EXCEEDED", 429),
    );
    assert.equal(fixture.providerCalls.length, 2);
    for (const resolve of releases) resolve({ text: "done" });
    await Promise.all([first, second]);
  });

  it("rejects the fifth active upload before workspace/provider and releases after abort", async (t) => {
    const entered = [];
    const releases = [];
    let fourResolve;
    const fourEntered = new Promise((resolve) => { fourResolve = resolve; });
    const providerCalls = [];
    const fixture = await serviceFixture(t, {
      providerCalls,
      writeAudioBodyImpl: async ({ outputPath, reservation }) => {
        entered.push(dirname(outputPath));
        if (entered.length === 4) fourResolve();
        await new Promise((resolve) => releases.push(resolve));
        await fs.writeFile(outputPath, WAV_MAGIC, { mode: 0o600 });
        reservation.reserveChunk(WAV_MAGIC.length);
        reservation.finishUpload(WAV_MAGIC.length);
        return { byteLength: 12, sha256: "a".repeat(64), magicBytes: Uint8Array.from(WAV_MAGIC) };
      },
    });
    const pending = Array.from({ length: 4 }, (_, index) => fixture.service.transcribe(requestInput({
      owner: `owner-${index}`,
      key: `asr:synthetic-upload-${index}`,
    })));
    await fourEntered;
    const rejectedBody = new PassThrough();
    let destroyCalls = 0;
    let deferCalls = 0;
    let deferredTermination;
    const originalDestroy = rejectedBody.destroy.bind(rejectedBody);
    rejectedBody.destroy = (...args) => {
      destroyCalls += 1;
      return originalDestroy(...args);
    };
    await assert.rejects(
      fixture.service.transcribe(requestInput({
        owner: "owner-5",
        key: "asr:synthetic-upload-5",
        body: rejectedBody,
        deferUnreadBodyTermination: (terminate) => {
          deferCalls += 1;
          deferredTermination = terminate;
        },
      })),
      expectCode("ASR_CAPACITY_EXCEEDED", 429),
    );
    assert.equal(providerCalls.length, 0);
    assert.equal(deferCalls, 1);
    assert.equal(destroyCalls, 0);
    assert.equal(rejectedBody.destroyed, false);
    assert.equal(deferredTermination(), true);
    assert.equal(deferredTermination(), false);
    assert.equal(destroyCalls, 1);
    assert.equal(rejectedBody.destroyed, true);
    let lateDataEvents = 0;
    rejectedBody.on("data", () => { lateDataEvents += 1; });
    assert.equal(rejectedBody.write(Buffer.from("late synthetic upload chunk")), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lateDataEvents, 0);
    for (const resolve of releases) resolve();
    await Promise.allSettled(pending);
    assert.equal(fixture.service.metrics.snapshot().gauges.activeUploads, 0);
    assert.equal(fixture.service.metrics.snapshot().gauges.tempBytes, 0);
  });
});

describe("ASR non-cooperative stage fences, cancellation, and close", () => {
  for (const stage of ["probe", "transcode", "provider"]) {
    it(`drops a late non-cooperative ${stage} resolve after processing timeout`, async (t) => {
      let enteredResolve;
      let release;
      const entered = new Promise((resolve) => { enteredResolve = resolve; });
      const deferred = () => new Promise((resolve) => {
        release = resolve;
        enteredResolve();
      });
      const providerCalls = [];
      const overrides = { providerCalls, processingTimeoutMs: 10 };
      if (stage === "probe") {
        overrides.probeAudioImpl = async () => deferred();
      } else if (stage === "transcode") {
        overrides.transcodeImpl = async () => deferred();
      } else {
        overrides.provider = {
          id: "openai-compatible",
          readiness: () => ({ ready: true, code: "READY" }),
          transcribe(input) { providerCalls.push(input); return deferred(); },
        };
      }
      const fixture = await serviceFixture(t, overrides);
      const pending = fixture.service.transcribe(requestInput({ key: `asr:synthetic-late-${stage}` }));
      const rejection = assert.rejects(pending, expectCode("ASR_TIMEOUT", 504));
      await entered;
      await rejection;
      if (stage === "probe") {
        release({ durationMs: 1_000, formatNames: ["wav"], audioStream: {} });
      } else if (stage === "transcode") {
        const outputPath = join(fixture.root, "late.wav");
        release({ outputPath, pcmBytes: 32_000, durationMs: 1_000, byteLength: 32_044 });
      } else {
        release({ text: "late result must be dropped" });
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (stage !== "provider") assert.equal(providerCalls.length, 0);
      assert.equal(fixture.service.capacitySnapshot().idempotency.pending, 0);
      assert.deepEqual(fixture.service.metrics.snapshot().gauges, {
        inflight: 0,
        activeUploads: 0,
        tempBytes: 0,
        staleTempDirectories: 0,
      });
      await assertWorkspacesRemoved(fixture.workspaces);
    });
  }

  it("drops a late provider result after caller abort and releases the pending reservation", async (t) => {
    let enteredResolve;
    let release;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const fixture = await serviceFixture(t, {
      provider: {
        id: "openai-compatible",
        readiness: () => ({ ready: true, code: "READY" }),
        transcribe() {
          enteredResolve();
          return new Promise((resolve) => { release = resolve; });
        },
      },
    });
    const controller = new AbortController();
    const pending = fixture.service.transcribe(requestInput({
      key: "asr:synthetic-caller-abort",
      signal: controller.signal,
    }));
    const pendingRejected = assert.rejects(pending, (error) => error.name === "AbortError");
    await entered;
    controller.abort(new DOMException("synthetic cancel", "AbortError"));
    release({ text: "late result" });
    await pendingRejected;
    assert.equal(fixture.service.capacitySnapshot().idempotency.pending, 0);
    assert.equal(fixture.service.capacitySnapshot().idempotency.completed, 0);
    await assertWorkspacesRemoved(fixture.workspaces);
  });

  for (const ending of ["processing timeout", "caller abort"]) {
    it(`${ending} terminates its request-scoped media child before returning`, async (t) => {
      const child = fakeChild({ stayAlive: true, exitOnTerm: true });
      let probeStarted;
      const entered = new Promise((resolve) => { probeStarted = resolve; });
      const fixture = await serviceFixture(t, {
        processingTimeoutMs: 10,
        childKillGraceMs: 5,
        probeAudioImpl: ({ onChildSpawn }) => {
          onChildSpawn(child);
          probeStarted();
          return new Promise(() => {});
        },
      });
      const controller = new AbortController();
      const request = fixture.service.transcribe(requestInput({
        key: `asr:synthetic-request-child-${ending.replaceAll(" ", "-")}`,
        signal: controller.signal,
      }));
      const requestRejected = ending === "processing timeout"
        ? assert.rejects(request, expectCode("ASR_TIMEOUT", 504))
        : assert.rejects(request, (error) => error.name === "AbortError");
      await entered;
      if (ending === "caller abort") {
        controller.abort(new DOMException("synthetic request cancellation", "AbortError"));
      }
      await requestRejected;
      assert.deepEqual(child.killSignals, ["SIGTERM"]);
      assert.equal(child.signalCode, "SIGTERM");
      assert.deepEqual(fixture.service.capacitySnapshot().processing, {
        globalActive: 0,
        activeOwners: 0,
        ownerMax: 1,
        globalMax: 2,
      });
      assert.deepEqual(fixture.service.metrics.snapshot().gauges, {
        inflight: 0,
        activeUploads: 0,
        tempBytes: 0,
        staleTempDirectories: 0,
      });
      assert.equal(fixture.service.lifecycleSnapshot().activeMediaChildren, 0);
      assert.equal(fixture.service.lifecycleSnapshot().resourceCleanupFailed, false);
      assert.equal(child.listenerCount("close"), 0);
      for (const stream of [child.stdout, child.stderr]) {
        assert.equal(stream.listenerCount("close"), 0);
        assert.equal(stream.listenerCount("end"), 0);
        assert.equal(stream.listenerCount("finish"), 0);
      }
      await assertWorkspacesRemoved(fixture.workspaces);
      await fixture.service.close();
      assert.equal(fixture.service.lifecycleSnapshot().activeMediaChildren, 0);
      assert.deepEqual(await fs.readdir(fixture.root), []);
    });
  }

  it("close aborts an active request, shares one closePromise, and ends with no lifecycle resources", async (t) => {
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const fixture = await serviceFixture(t, {
      provider: {
        id: "openai-compatible",
        readiness: () => ({ ready: true, code: "READY" }),
        transcribe({ signal }) {
          enteredResolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    });
    const request = fixture.service.transcribe(requestInput({ key: "asr:synthetic-close-active" }));
    const requestRejected = assert.rejects(request, (error) => error.name === "AbortError");
    await entered;
    const firstClose = fixture.service.close();
    const secondClose = fixture.service.close();
    assert.equal(firstClose, secondClose);
    await requestRejected;
    await firstClose;
    assert.deepEqual(fixture.service.lifecycleSnapshot(), {
      accepting: false,
      initialized: true,
      activeRequests: 0,
      activeControllers: 0,
      activeMediaChildren: 0,
      pendingWorkspaceLifecycles: 0,
      pendingResourceLifecycles: 0,
      mediaChildTerminationFailed: false,
      resourceCleanupFailed: false,
      lateWorkspaceCleanupFailed: false,
      unreadBodyTerminationFailed: false,
      intervalActive: false,
      periodicSweepActive: false,
      closing: true,
    });
    assert.deepEqual(fixture.service.metrics.snapshot().gauges, {
      inflight: 0,
      activeUploads: 0,
      tempBytes: 0,
      staleTempDirectories: 0,
    });
    assert.deepEqual(await fs.readdir(fixture.root), []);
  });

  it("keeps an unkillable fake media child visible and makes request plus close fail cleanup-closed", async (t) => {
    const child = fakeChild({ stayAlive: true, exitOnTerm: false, exitOnKill: false });
    const fixture = await serviceFixture(t, {
      childKillGraceMs: 1,
      spawnImpl: () => child,
      probeAudioImpl: (options) => probeAudio({
        ...options,
        timeoutMs: 1,
        childKillGraceMs: 1,
      }),
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-stuck-child" })),
      expectCode("ASR_CLEANUP_FAILED", 503),
    );
    assert.equal(fixture.providerCalls.length, 0);
    assert.equal(fixture.service.lifecycleSnapshot().activeMediaChildren, 1);
    assert.equal(fixture.service.lifecycleSnapshot().mediaChildTerminationFailed, true);
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 1);
    await assertWorkspacesRemoved(fixture.workspaces);
    await assert.rejects(fixture.service.close(), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.equal(fixture.service.lifecycleSnapshot().activeMediaChildren, 1);
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 1);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
    assert.deepEqual(child.killSignals, [
      "SIGTERM", "SIGKILL",
      "SIGTERM", "SIGKILL",
      "SIGTERM", "SIGKILL",
    ]);
    child.stdout.destroy();
    child.stderr.destroy();
  });
});

describe("ASR initialize/periodic/close concurrency", () => {
  it("keeps an empty-root startup sweep exception degraded without inventing stale directories", async (t) => {
    const fixture = await serviceFixture(t, {
      sweepImpl: async () => { throw new Error("synthetic startup sweep failure"); },
    });
    assert.deepEqual(fixture.service.readiness(), {
      ready: false,
      code: "ASR_TEMP_ROOT_DEGRADED",
    });
    assert.deepEqual(await fs.readdir(fixture.root), []);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
    await assert.rejects(fixture.service.close(), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
  });

  it("returns ASR_CLOSED without recreating provider, temp root, sweep, or timer after close", async (t) => {
    let readinessCalls = 0;
    let sweepCalls = 0;
    let intervalCalls = 0;
    const fixture = await serviceFixture(t, {
      initialize: false,
      provider: {
        id: "openai-compatible",
        readiness() {
          readinessCalls += 1;
          return { ready: true, code: "READY" };
        },
        async transcribe() { return { text: "unused" }; },
      },
      sweepImpl: async () => {
        sweepCalls += 1;
        return { ready: true, removedCount: 0, staleCount: 0, anomalyCount: 0 };
      },
      setIntervalImpl: () => {
        intervalCalls += 1;
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    });
    await fixture.service.initialize();
    await fixture.service.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
    const before = { readinessCalls, sweepCalls, intervalCalls };
    assert.deepEqual(await fixture.service.initialize(), { ready: false, code: "ASR_CLOSED" });
    assert.deepEqual({ readinessCalls, sweepCalls, intervalCalls }, before);
    await assert.rejects(fs.lstat(fixture.root), (error) => error.code === "ENOENT");
    assert.equal(fixture.service.lifecycleSnapshot().intervalActive, false);
  });

  it("close racing deferred initialize never lets initialize create a periodic timer afterward", async (t) => {
    let releaseStartup;
    let startupEnteredResolve;
    const startupEntered = new Promise((resolve) => { startupEnteredResolve = resolve; });
    const sweepModes = [];
    let intervalsCreated = 0;
    const fixture = await serviceFixture(t, {
      initialize: false,
      sweepImpl: async (_root, { mode }) => {
        sweepModes.push(mode);
        if (sweepModes.length === 1) {
          startupEnteredResolve();
          await new Promise((resolve) => { releaseStartup = resolve; });
        }
        return { ready: true, removedCount: 0, staleCount: 0, anomalyCount: 0 };
      },
      setIntervalImpl: () => {
        intervalsCreated += 1;
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    });
    const initializing = fixture.service.initialize();
    await startupEntered;
    const closing = fixture.service.close();
    releaseStartup();
    await initializing;
    await closing;
    assert.equal(intervalsCreated, 0);
    assert.deepEqual(sweepModes, ["startup", "startup"]);
    assert.equal(fixture.service.lifecycleSnapshot().intervalActive, false);
  });

  it("periodic timer is unrefed, sweeps never overlap, and close waits active periodic before final sweep", async (t) => {
    let intervalCallback;
    let intervalUnref = 0;
    let intervalCleared = 0;
    let releasePeriodic;
    let periodicEnteredResolve;
    const periodicEntered = new Promise((resolve) => { periodicEnteredResolve = resolve; });
    const sweepModes = [];
    const fixture = await serviceFixture(t, {
      initialize: false,
      sweepImpl: async (_root, { mode }) => {
        sweepModes.push(mode);
        if (mode === "periodic") {
          periodicEnteredResolve();
          await new Promise((resolve) => { releasePeriodic = resolve; });
        }
        return { ready: true, removedCount: 0, staleCount: 0, anomalyCount: 0 };
      },
      setIntervalImpl: (callback) => {
        intervalCallback = callback;
        return { unref() { intervalUnref += 1; } };
      },
      clearIntervalImpl: () => { intervalCleared += 1; },
    });
    await fixture.service.initialize();
    assert.equal(intervalUnref, 1);
    intervalCallback();
    intervalCallback();
    await periodicEntered;
    const closing = fixture.service.close();
    await Promise.resolve();
    assert.deepEqual(sweepModes, ["startup", "periodic"]);
    releasePeriodic();
    await closing;
    assert.deepEqual(sweepModes, ["startup", "periodic", "startup"]);
    assert.equal(intervalCleared, 1);
    assert.equal(fixture.service.lifecycleSnapshot().periodicSweepActive, false);
  });

  it("keeps an empty-root periodic sweep exception at stale zero", async (t) => {
    let intervalCallback;
    const fixture = await serviceFixture(t, {
      sweepImpl: async (_root, { mode }) => {
        if (mode === "periodic") throw new Error("synthetic periodic sweep failure");
        return sweepResultWithResidualPaths([]);
      },
      setIntervalImpl: (callback) => {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    });
    intervalCallback();
    await waitForCondition(
      () => !fixture.service.lifecycleSnapshot().periodicSweepActive,
      "throwing empty-root periodic sweep did not finish",
    );
    assert.equal(fixture.service.lifecycleSnapshot().periodicSweepActive, false);
    assert.deepEqual(fixture.service.readiness(), {
      ready: false,
      code: "ASR_TEMP_ROOT_DEGRADED",
    });
    assert.deepEqual(await fs.readdir(fixture.root), []);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
    await fixture.service.close();
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
  });

  it("preserves a confirmed directory identity when periodic sweep throws", async (t) => {
    let intervalCallback;
    const fixture = await serviceFixture(t, {
      requestCleanupTimeoutMs: TEST_LIFECYCLE_BUDGET_MS,
      closeTimeoutMs: 20,
      cleanupImpl: async () => new Promise(() => {}),
      sweepImpl: async (_root, { mode }) => {
        if (mode === "periodic") throw new Error("synthetic periodic sweep failure");
        return sweepResultWithResidualPaths([]);
      },
      setIntervalImpl: (callback) => {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-periodic-throw-residue" })),
      expectCode("ASR_CLEANUP_FAILED", 503),
    );
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
    intervalCallback();
    await waitForCondition(
      () => !fixture.service.lifecycleSnapshot().periodicSweepActive,
      "throwing residue periodic sweep did not finish",
    );
    assert.equal(fixture.service.lifecycleSnapshot().periodicSweepActive, false);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
  });

  it("unions periodic residual identities without double-counting the same physical path", async (t) => {
    let intervalCallback;
    let cleanupPath;
    let periodicCalls = 0;
    const fixture = await serviceFixture(t, {
      requestCleanupTimeoutMs: TEST_LIFECYCLE_BUDGET_MS,
      closeTimeoutMs: 20,
      cleanupImpl: async (workspace) => {
        cleanupPath = workspace;
        return new Promise(() => {});
      },
      sweepImpl: async (_root, { mode }) => {
        if (mode !== "periodic") return sweepResultWithResidualPaths([]);
        periodicCalls += 1;
        const paths = periodicCalls === 1
          ? [cleanupPath]
          : [cleanupPath, join(fixture.root, "nonmatching-second-residue")];
        return sweepResultWithResidualPaths(paths);
      },
      setIntervalImpl: (callback) => {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-sweep-union" })),
      expectCode("ASR_CLEANUP_FAILED", 503),
    );
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
    intervalCallback();
    await waitForCondition(
      () => !fixture.service.lifecycleSnapshot().periodicSweepActive,
      "first residual-union periodic sweep did not finish",
    );
    assert.equal(fixture.service.lifecycleSnapshot().periodicSweepActive, false);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
    const secondPath = join(fixture.root, "nonmatching-second-residue");
    await fs.mkdir(secondPath, { mode: 0o700 });
    intervalCallback();
    await waitForCondition(
      () => !fixture.service.lifecycleSnapshot().periodicSweepActive,
      "second residual-union periodic sweep did not finish",
    );
    assert.equal(fixture.service.lifecycleSnapshot().periodicSweepActive, false);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 2);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 2);
  });

  it("clears confirmed residual identities when the final sweep reports a missing root", async (t) => {
    const syntheticResidual = join(tmpdir(), "sentelligent-asr-b-synthetic-residual");
    let calls = 0;
    const fixture = await serviceFixture(t, {
      sweepImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return sweepResultWithResidualPaths([syntheticResidual], { ready: false });
        }
        const missing = new Error("synthetic missing temp root");
        missing.code = "ENOENT";
        throw missing;
      },
    });
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 1);
    await fixture.service.close();
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
  });

  it("close timeout timer stays referenced and no final sweep starts while initialization remains active", async (t) => {
    let enteredResolve;
    let releaseStartup;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const unrefDurations = [];
    const sweepModes = [];
    const fixture = await serviceFixture(t, {
      initialize: false,
      closeTimeoutMs: 15,
      setTimeoutImpl: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        const originalUnref = timer.unref.bind(timer);
        timer.unref = () => {
          unrefDurations.push(milliseconds);
          return originalUnref();
        };
        return timer;
      },
      clearTimeoutImpl: clearTimeout,
      sweepImpl: async (_root, { mode }) => {
        sweepModes.push(mode);
        if (sweepModes.length === 1) {
          enteredResolve();
          await new Promise((resolve) => { releaseStartup = resolve; });
        }
        return { ready: true, removedCount: 0, staleCount: 0, anomalyCount: 0 };
      },
    });
    const initializing = fixture.service.initialize();
    await entered;
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.deepEqual(sweepModes, ["startup"]);
    assert.equal(unrefDurations.includes(15), false);
    assert.equal(fixture.service.lifecycleSnapshot().activeRequests, 0);
    releaseStartup();
    await initializing;
    assert.equal(fixture.service.lifecycleSnapshot().activeRequests, 0);
  });

  it("close fails ASR_CLEANUP_FAILED when final startup sweep reports anomaly/residue", async (t) => {
    let calls = 0;
    const fixture = await serviceFixture(t, {
      sweepImpl: async () => {
        calls += 1;
        if (calls === 1) return { ready: true, removedCount: 0, staleCount: 0, anomalyCount: 0 };
        return { ready: false, removedCount: 0, staleCount: 0, anomalyCount: 1 };
      },
    });
    await assert.rejects(fixture.service.close(), expectCode("ASR_CLEANUP_FAILED", 503));
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
  });

  it("maps a toxic final-sweep exception to a fixed cleanup error without leaking its path", async (t) => {
    const toxic = "/private/synthetic/asr/request-secret";
    let calls = 0;
    const fixture = await serviceFixture(t, {
      sweepImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return { ready: true, removedCount: 0, staleCount: 0, anomalyCount: 0 };
        }
        throw new Error(`synthetic final sweep failed at ${toxic}`);
      },
    });
    await assert.rejects(fixture.service.close(), (error) => {
      assert.equal(error.code, "ASR_CLEANUP_FAILED");
      assert.equal(error.status, 503);
      assert.equal(error.message.includes(toxic), false);
      assert.equal(error.message.includes("synthetic final sweep"), false);
      return true;
    });
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 1);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
  });
});

describe("ASR independent credential selection", () => {
  it("ASR_REUSE_MODEL_CREDENTIAL=false calls only asrApiKeyProvider", async (t) => {
    const root = await tempRoot(t);
    let asrKeyCalls = 0;
    let modelKeyCalls = 0;
    let fetchCalls = 0;
    const service = createAsrService({
      asrMode: "live",
      asrProvider: "openai-compatible",
      asrBaseUrl: "https://provider.example/v1",
      asrModel: "synthetic-asr",
      asrTempRoot: root,
      asrReuseModelCredential: false,
      authSessionSecret: HMAC_FIXTURE,
    }, {
      asrApiKeyProvider: async () => { asrKeyCalls += 1; return "synthetic-asr-key"; },
      modelApiKeyProvider: async () => { modelKeyCalls += 1; return "synthetic-model-key"; },
      providerDependencies: {
        executionMode: "external-provider",
        openAsBlobImpl: async () => new Blob(["synthetic"], { type: "audio/wav" }),
        fetchImpl: async () => {
          fetchCalls += 1;
          return { ok: true, body: Readable.from([Buffer.from('{"text":"独立凭据结果"}')]) };
        },
      },
      writeAudioBodyImpl: async ({ readable, outputPath, reservation }) => {
        await fs.writeFile(outputPath, WAV_MAGIC, { mode: 0o600 });
        reservation.reserveChunk(12);
        reservation.finishUpload(12);
        return { byteLength: 12, sha256: readable.syntheticHash, magicBytes: Uint8Array.from(WAV_MAGIC) };
      },
      probeAudioImpl: async () => ({ durationMs: 1_000, formatNames: ["wav"], audioStream: {} }),
      transcodeImpl: async ({ outputPath }) => {
        await fs.writeFile(outputPath, createCanonicalWavHeader(32_000), { mode: 0o600 });
        return { outputPath, pcmBytes: 32_000, durationMs: 1_000, byteLength: 32_044 };
      },
    });
    t.after(() => service.close());
    await service.initialize();
    assert.equal((await service.transcribe(requestInput({ key: "asr:synthetic-independent-key" }))).transcript, "独立凭据结果");
    assert.equal(asrKeyCalls, 1);
    assert.equal(modelKeyCalls, 0);
    assert.equal(fetchCalls, 1);
    await service.close();
  });

  it("processing timeout aborts a hanging real-provider credential lookup and close reaches zero", async (t) => {
    const root = await tempRoot(t);
    let credentialStarted;
    const started = new Promise((resolve) => { credentialStarted = resolve; });
    let blobCalls = 0;
    let fetchCalls = 0;
    const service = createAsrService({
      asrMode: "live",
      asrProvider: "openai-compatible",
      asrBaseUrl: "https://provider.example/v1",
      asrModel: "synthetic-asr",
      asrTimeoutMs: 1_000,
      asrTempRoot: root,
      asrReuseModelCredential: false,
      authSessionSecret: HMAC_FIXTURE,
    }, {
      processingTimeoutMs: 10,
      asrApiKeyProvider: async () => {
        credentialStarted();
        return new Promise(() => {});
      },
      providerDependencies: {
        executionMode: "external-provider",
        openAsBlobImpl: async () => { blobCalls += 1; return new Blob(); },
        fetchImpl: async () => {
          fetchCalls += 1;
          return { ok: true, body: Readable.from([Buffer.from('{"text":"unused"}')]) };
        },
      },
      writeAudioBodyImpl: async ({ readable, outputPath, reservation }) => {
        await fs.writeFile(outputPath, WAV_MAGIC, { mode: 0o600 });
        reservation.reserveChunk(12);
        reservation.finishUpload(12);
        return { byteLength: 12, sha256: readable.syntheticHash, magicBytes: Uint8Array.from(WAV_MAGIC) };
      },
      probeAudioImpl: async () => ({ durationMs: 1_000, formatNames: ["wav"], audioStream: {} }),
      transcodeImpl: async ({ outputPath }) => {
        await fs.writeFile(outputPath, createCanonicalWavHeader(32_000), { mode: 0o600 });
        return { outputPath, pcmBytes: 32_000, durationMs: 1_000, byteLength: 32_044 };
      },
    });
    t.after(async () => {
      try { await service.close(); } catch { /* this test asserts close explicitly */ }
    });
    await service.initialize();
    const request = service.transcribe(requestInput({ key: "asr:synthetic-hanging-key" }));
    const requestRejected = assert.rejects(request, expectCode("ASR_TIMEOUT", 504));
    await started;
    await requestRejected;
    assert.deepEqual({ blobCalls, fetchCalls }, { blobCalls: 0, fetchCalls: 0 });
    assert.equal(service.capacitySnapshot().processing.globalActive, 0);
    assert.deepEqual(service.metrics.snapshot().gauges, {
      inflight: 0,
      activeUploads: 0,
      tempBytes: 0,
      staleTempDirectories: 0,
    });
    await service.close();
    assert.equal(service.lifecycleSnapshot().activeRequests, 0);
    assert.equal(service.lifecycleSnapshot().activeControllers, 0);
    assert.equal(service.lifecycleSnapshot().activeMediaChildren, 0);
  });

  it("keeps close waiting for a late fetch response body and cancels it exactly once", async (t) => {
    let resolveFetch;
    let cancelCalls = 0;
    const provider = createOpenAiCompatibleProvider({
      executionMode: "external-provider",
      baseUrl: "https://provider.example/v1",
      model: "synthetic-asr",
      timeoutMs: 10,
      asrApiKeyProvider: async () => "synthetic-provider-key",
    }, {
      openAsBlobImpl: async () => new Blob(["synthetic-wav"], { type: "audio/wav" }),
      fetchImpl: async () => new Promise((resolve) => { resolveFetch = resolve; }),
    });
    const fixture = await serviceFixture(t, {
      provider,
      requestCleanupTimeoutMs: 500,
      closeTimeoutMs: 250,
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-late-fetch-close" })),
      expectCode("ASR_CLEANUP_FAILED", 503),
    );
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 1);
    let closeSettled = false;
    const closingRejected = assert.rejects(
      fixture.service.close().finally(() => { closeSettled = true; }),
      expectCode("ASR_CLEANUP_FAILED", 503),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closeSettled, false);
    resolveFetch({
      ok: true,
      status: 200,
      body: {
        cancel() {
          cancelCalls += 1;
          return Promise.resolve();
        },
      },
    });
    await closingRejected;
    assert.equal(cancelCalls, 1);
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 0);
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 1);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
    assert.deepEqual(await fs.readdir(fixture.root), []);
  });

  it("waits for a return-only acquisition cleanup through the service lifecycle", async (t) => {
    let returnCalls = 0;
    let iteratorFactoryCalls = 0;
    const provider = createOpenAiCompatibleProvider({
      executionMode: "external-provider",
      baseUrl: "https://provider.example/v1",
      model: "synthetic-asr",
      timeoutMs: 1_000,
      asrApiKeyProvider: async () => "synthetic-provider-key",
    }, {
      openAsBlobImpl: async () => new Blob(["synthetic-wav"], { type: "audio/wav" }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: {
          getReader() {
            throw new Error("synthetic reader acquisition failure");
          },
          [Symbol.asyncIterator]() {
            iteratorFactoryCalls += 1;
            return {
              return() {
                returnCalls += 1;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        },
      }),
    });
    const fixture = await serviceFixture(t, {
      provider,
      requestCleanupTimeoutMs: TEST_LIFECYCLE_BUDGET_MS,
      closeTimeoutMs: TEST_LIFECYCLE_BUDGET_MS,
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-return-only-service" })),
      expectCode("ASR_PROVIDER_BAD_RESPONSE", 502),
    );
    assert.equal(iteratorFactoryCalls, 1);
    assert.equal(returnCalls, 1);
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 0);
    assert.equal(fixture.service.lifecycleSnapshot().activeRequests, 0);
    assert.equal(fixture.service.lifecycleSnapshot().activeControllers, 0);
    assert.equal(fixture.service.metrics.snapshot().gauges.inflight, 0);
    assert.equal(fixture.service.metrics.snapshot().gauges.activeUploads, 0);
    assert.equal(fixture.service.metrics.snapshot().gauges.tempBytes, 0);
    assert.deepEqual(await fs.readdir(fixture.root), []);
    await fixture.service.close();
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 0);
  });

  it("bounds close when the provider fetch and its registered lifecycle never settle", async (t) => {
    const provider = createOpenAiCompatibleProvider({
      executionMode: "external-provider",
      baseUrl: "https://provider.example/v1",
      model: "synthetic-asr",
      timeoutMs: 10,
      asrApiKeyProvider: async () => "synthetic-provider-key",
    }, {
      openAsBlobImpl: async () => new Blob(["synthetic-wav"], { type: "audio/wav" }),
      fetchImpl: async () => new Promise(() => {}),
    });
    const fixture = await serviceFixture(t, {
      provider,
      requestCleanupTimeoutMs: 500,
      closeTimeoutMs: 20,
    });
    await assert.rejects(
      fixture.service.transcribe(requestInput({ key: "asr:synthetic-never-fetch-close" })),
      expectCode("ASR_CLEANUP_FAILED", 503),
    );
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
    await assert.rejects(fixture.service.close(), expectCode("ASR_TIMEOUT", 504));
    assert.equal(fixture.service.lifecycleSnapshot().pendingResourceLifecycles, 1);
    assert.equal(fixture.service.metrics.snapshot().counters.cleanupFailuresTotal, 1);
    assert.equal(fixture.service.metrics.snapshot().gauges.staleTempDirectories, 0);
    assert.deepEqual(await fs.readdir(fixture.root), []);
  });

  for (const cancellation of ["resolve", "never"]) {
    it(`tracks real-provider response reader cleanup when cancel will ${cancellation}`, async (t) => {
      const root = await tempRoot(t);
      let readerStartedResolve;
      const readerStarted = new Promise((resolve) => { readerStartedResolve = resolve; });
      const processingTimeoutMs = 59_321;
      const processingTimer = Object.freeze({ kind: "manual-reader-processing-timeout" });
      let processingTimeoutCallback = null;
      let cancelCalls = 0;
      let releaseCalls = 0;
      const service = createAsrService({
        asrMode: "live",
        asrProvider: "openai-compatible",
        asrBaseUrl: "https://provider.example/v1",
        asrModel: "synthetic-asr",
        asrTimeoutMs: 45_000,
        asrTempRoot: root,
        asrReuseModelCredential: false,
        authSessionSecret: HMAC_FIXTURE,
      }, {
        processingTimeoutMs,
        requestCleanupTimeoutMs: TEST_LIFECYCLE_BUDGET_MS,
        closeTimeoutMs: 30,
        setTimeoutImpl: (callback, milliseconds) => {
          if (milliseconds === processingTimeoutMs) {
            assert.equal(processingTimeoutCallback, null, "processing deadline registered exactly once");
            processingTimeoutCallback = callback;
            return processingTimer;
          }
          return setTimeout(callback, milliseconds);
        },
        clearTimeoutImpl: (timer) => {
          if (timer !== processingTimer) clearTimeout(timer);
        },
        asrApiKeyProvider: async () => "synthetic-provider-key",
        providerDependencies: {
          executionMode: "external-provider",
          readerCleanupTimeoutMs: 10,
          openAsBlobImpl: async () => new Blob(["synthetic-wav"], { type: "audio/wav" }),
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            body: {
              getReader: () => ({
                read: () => {
                  readerStartedResolve();
                  return new Promise(() => {});
                },
                cancel: () => {
                  cancelCalls += 1;
                  return cancellation === "resolve" ? Promise.resolve() : new Promise(() => {});
                },
                releaseLock: () => { releaseCalls += 1; },
              }),
            },
          }),
        },
        writeAudioBodyImpl: async ({ readable, outputPath, reservation }) => {
          await fs.writeFile(outputPath, WAV_MAGIC, { mode: 0o600 });
          reservation.reserveChunk(12);
          reservation.finishUpload(12);
          return { byteLength: 12, sha256: readable.syntheticHash, magicBytes: Uint8Array.from(WAV_MAGIC) };
        },
        probeAudioImpl: async () => ({ durationMs: 1_000, formatNames: ["wav"], audioStream: {} }),
        transcodeImpl: async ({ outputPath }) => {
          await fs.writeFile(outputPath, createCanonicalWavHeader(32_000), { mode: 0o600 });
          return { outputPath, pcmBytes: 32_000, durationMs: 1_000, byteLength: 32_044 };
        },
      });
      t.after(async () => {
        try { await service.close(); } catch { /* each branch asserts close explicitly */ }
      });
      await service.initialize();
      const request = service.transcribe(requestInput({
        key: `asr:synthetic-reader-cleanup-${cancellation}`,
      }));
      const requestRejected = cancellation === "resolve"
        ? assert.rejects(request, expectCode("ASR_TIMEOUT", 504))
        : assert.rejects(request, expectCode("ASR_CLEANUP_FAILED", 503));
      await readerStarted;
      assert.equal(typeof processingTimeoutCallback, "function", "processing deadline was registered");
      const fireProcessingTimeout = processingTimeoutCallback;
      processingTimeoutCallback = null;
      fireProcessingTimeout();
      if (cancellation === "resolve") {
        await requestRejected;
        assert.equal(service.lifecycleSnapshot().pendingResourceLifecycles, 0);
        assert.equal(service.lifecycleSnapshot().resourceCleanupFailed, false);
        await service.close();
      } else {
        await requestRejected;
        assert.equal(service.lifecycleSnapshot().pendingResourceLifecycles, 1);
        assert.equal(service.lifecycleSnapshot().resourceCleanupFailed, true);
        await assert.rejects(service.close(), expectCode("ASR_TIMEOUT", 504));
      }
      assert.equal(cancelCalls, 1);
      assert.equal(releaseCalls, 1);
      assert.equal(service.metrics.snapshot().gauges.inflight, 0);
      assert.deepEqual(await fs.readdir(root), []);
    });
  }
});
