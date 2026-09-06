import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAsrMetrics } from "../src/asr/metrics.js";

function completion(index, extra = {}) {
  return {
    purpose: "quick_record",
    provider: "openai-compatible",
    outcome: "success",
    errorCode: "",
    totalMs: index,
    providerMs: index,
    cleanupVerified: true,
    ...extra,
  };
}

describe("ASR bounded in-memory metrics gauges and counters", () => {
  it("tracks resource gauges and returns them to exact zero", () => {
    const metrics = createAsrMetrics({ now: () => 1_000 });
    metrics.adjustInflight(2);
    metrics.adjustActiveUploads(1);
    metrics.adjustTempBytes(8_388_608);
    metrics.adjustTempBytes(-8_388_608);
    metrics.adjustActiveUploads(-1);
    metrics.adjustInflight(-2);
    assert.deepEqual(metrics.snapshot().gauges, {
      inflight: 0,
      activeUploads: 0,
      tempBytes: 0,
      staleTempDirectories: 0,
    });
  });

  it("rejects every negative or unsafe gauge transition", () => {
    const metrics = createAsrMetrics();
    assert.throws(() => metrics.adjustInflight(-1), /negative/);
    assert.throws(() => metrics.adjustActiveUploads(-1), /negative/);
    assert.throws(() => metrics.adjustTempBytes(-1), /negative/);
    assert.throws(() => metrics.adjustTempBytes(Number.MAX_SAFE_INTEGER + 1), /safe integer/);
    assert.throws(() => metrics.setStaleTempDirectories(-1), /non-negative/);
  });

  it("records labeled request/provider/outcome counters without any body", () => {
    const metrics = createAsrMetrics();
    metrics.recordRequest({
      purpose: "quick_record",
      provider: "openai-compatible",
      outcome: "error",
      errorCode: "ASR_TIMEOUT",
      transcript: "forbidden-body",
    });
    metrics.recordProviderCall({ provider: "openai-compatible", outcome: "error" });
    const counters = metrics.snapshot().counters;
    assert.equal(counters.requestsTotal["quick_record|openai-compatible|error|ASR_TIMEOUT"], 1);
    assert.equal(counters.providerCallsTotal["openai-compatible|error"], 1);
    assert.equal(counters.outcomes["error|ASR_TIMEOUT"], 1);
    assert.equal(JSON.stringify(counters).includes("forbidden-body"), false);
  });

  it("records bounded stage and audio histograms", () => {
    const metrics = createAsrMetrics();
    metrics.recordStageDuration({ stage: "upload", purpose: "quick_record", elapsedMs: 10 });
    metrics.recordStageDuration({ stage: "upload", purpose: "quick_record", elapsedMs: 61_000 });
    metrics.recordAudioDuration({ purpose: "quick_record", durationMs: 300 });
    const counters = metrics.snapshot().counters;
    assert.equal(counters.stageDurationMs["upload|quick_record"].count, 2);
    assert.equal(counters.stageDurationMs["upload|quick_record"].sum, 61_010);
    assert.equal(counters.stageDurationMs["upload|quick_record"].buckets.at(-1), 1);
    assert.equal(counters.audioDurationMs.quick_record.count, 1);
  });

  it("tracks cleanup failures and stale-directory gauge independently", () => {
    const metrics = createAsrMetrics();
    metrics.recordCleanupFailure();
    metrics.recordCleanupFailure();
    metrics.setStaleTempDirectories(3);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.counters.cleanupFailuresTotal, 2);
    assert.equal(snapshot.gauges.staleTempDirectories, 3);
  });
});

describe("ASR 512-completion ring and p95", () => {
  it("defaults to the frozen 512 capacity", () => {
    const metrics = createAsrMetrics({ now: () => 0 });
    assert.equal(metrics.snapshot().window.capacity, 512);
  });

  it("bounds completed events and overwrites the oldest event", () => {
    let now = 1_000;
    const metrics = createAsrMetrics({ capacity: 2, now: () => now++ });
    metrics.recordCompletion(completion(1));
    const firstCompletedAt = new Date(1_001).toISOString();
    metrics.recordCompletion(completion(2));
    metrics.recordCompletion(completion(3));
    const window = metrics.snapshot().window;
    assert.equal(window.sampleCount, 2);
    assert.notEqual(window.oldestCompletedAt, firstCompletedAt);
    assert.equal(window.newestCompletedAt, new Date(1_003).toISOString());
  });

  it("caps a real-size ring at 512 after 513 completions", () => {
    let now = 10_000;
    const metrics = createAsrMetrics({ now: () => now++ });
    for (let index = 1; index <= 513; index += 1) metrics.recordCompletion(completion(index));
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.window.sampleCount, 512);
    assert.equal(snapshot.p95.totalMs, 488);
    assert.equal(snapshot.p95.providerMs, 488);
  });

  it("returns null p95 for zero or one sample", () => {
    const metrics = createAsrMetrics();
    assert.deepEqual(metrics.snapshot().p95, { totalMs: null, providerMs: null });
    metrics.recordCompletion(completion(10, { providerMs: null }));
    assert.deepEqual(metrics.snapshot().p95, { totalMs: null, providerMs: null });
  });

  it("computes nearest-rank p95 from the current ring only", () => {
    const metrics = createAsrMetrics({ capacity: 4 });
    for (const value of [5, 10, 20, 100]) metrics.recordCompletion(completion(value));
    assert.deepEqual(metrics.snapshot().p95, { totalMs: 100, providerMs: 100 });
  });

  it("whitelists exactly seven completion event fields and drops toxic extras", () => {
    const metrics = createAsrMetrics({ now: () => 0 });
    const event = metrics.recordCompletion(completion(1, {
      requestId: "forbidden-request",
      owner: "forbidden-owner",
      hash: "forbidden-hash",
      transcript: "forbidden-transcript",
      audio: "forbidden-audio",
      path: "/forbidden/path",
      url: "https://forbidden.example",
      key: "forbidden-key",
      header: "forbidden-header",
      credential: "synthetic-credential",
    }));
    assert.deepEqual(Object.keys(event), [
      "completedAt",
      "purpose",
      "provider",
      "outcome",
      "errorCode",
      "totalMs",
      "providerMs",
      "cleanupVerified",
    ]);
    const serialized = JSON.stringify(metrics.snapshot());
    for (const value of [
      "forbidden-request",
      "forbidden-owner",
      "forbidden-hash",
      "forbidden-transcript",
      "forbidden-audio",
      "/forbidden/path",
      "https://forbidden.example",
      "forbidden-key",
      "forbidden-header",
      "synthetic-credential",
    ]) {
      assert.equal(serialized.includes(value), false);
    }
  });

  it("starts a fresh process window for each metrics instance", () => {
    const first = createAsrMetrics({ now: () => 1_000 });
    first.recordCompletion(completion(1));
    const second = createAsrMetrics({ now: () => 2_000 });
    assert.equal(first.snapshot().window.sampleCount, 1);
    assert.equal(second.snapshot().window.sampleCount, 0);
    assert.notEqual(first.snapshot().window.startedAt, second.snapshot().window.startedAt);
  });
});
