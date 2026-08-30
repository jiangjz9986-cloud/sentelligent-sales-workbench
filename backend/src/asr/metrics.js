import { ASR_LIMITS } from "./contracts.js";

const STAGES = new Set(["upload", "probe", "transcode", "provider", "cleanup"]);
const PURPOSES = new Set(["quick_record", "assistant_chat"]);
const HISTOGRAM_BOUNDS = Object.freeze([
  10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 45_000, 60_000,
]);

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function finiteDuration(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function safeLabel(value, fallback = "unknown") {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/u.test(value)
    ? value
    : fallback;
}

function percentile95(values) {
  if (values.length < 2) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function addCounter(map, key, delta = 1) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function counterObject(map) {
  return Object.fromEntries([...map].toSorted(([left], [right]) => left.localeCompare(right)));
}

function createHistogram() {
  return { count: 0, sum: 0, buckets: Array(HISTOGRAM_BOUNDS.length + 1).fill(0) };
}

function observeHistogram(histogram, value) {
  histogram.count += 1;
  histogram.sum += value;
  const index = HISTOGRAM_BOUNDS.findIndex((bound) => value <= bound);
  histogram.buckets[index === -1 ? HISTOGRAM_BOUNDS.length : index] += 1;
}

function histogramSnapshot(map) {
  return Object.fromEntries([...map].toSorted(([left], [right]) => left.localeCompare(right)).map(
    ([key, value]) => [key, {
      count: value.count,
      sum: value.sum,
      bounds: [...HISTOGRAM_BOUNDS],
      buckets: [...value.buckets],
    }],
  ));
}

export function createAsrMetrics({
  capacity = ASR_LIMITS.metricsRingCapacity,
  now = Date.now,
} = {}) {
  positiveSafeInteger(capacity, "capacity");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const startedAtValue = now();
  if (!Number.isFinite(startedAtValue)) throw new TypeError("now() must return a finite number");
  const startedAt = new Date(startedAtValue).toISOString();
  const requests = new Map();
  const providerCalls = new Map();
  const outcomes = new Map();
  const stageHistograms = new Map();
  const audioHistograms = new Map();
  const completed = [];
  const gauges = {
    inflight: 0,
    activeUploads: 0,
    tempBytes: 0,
    staleTempDirectories: 0,
  };
  let cleanupFailuresTotal = 0;

  function adjustGauge(name, delta) {
    if (!Number.isSafeInteger(delta)) throw new TypeError(`${name} delta must be a safe integer`);
    const next = gauges[name] + delta;
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new RangeError(`${name} gauge cannot become negative or unsafe`);
    }
    gauges[name] = next;
    return next;
  }

  return Object.freeze({
    adjustInflight(delta) {
      return adjustGauge("inflight", delta);
    },
    adjustActiveUploads(delta) {
      return adjustGauge("activeUploads", delta);
    },
    adjustTempBytes(delta) {
      return adjustGauge("tempBytes", delta);
    },
    setStaleTempDirectories(value) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("stale temp directory gauge must be a non-negative safe integer");
      }
      gauges.staleTempDirectories = value;
    },
    recordCleanupFailure() {
      cleanupFailuresTotal += 1;
      return cleanupFailuresTotal;
    },
    recordRequest({ purpose, provider, outcome, errorCode = "" }) {
      const key = [
        PURPOSES.has(purpose) ? purpose : "unknown",
        safeLabel(provider),
        safeLabel(outcome),
        errorCode ? safeLabel(errorCode) : "none",
      ].join("|");
      addCounter(requests, key);
      addCounter(outcomes, `${safeLabel(outcome)}|${errorCode ? safeLabel(errorCode) : "none"}`);
    },
    recordProviderCall({ provider, outcome }) {
      addCounter(providerCalls, `${safeLabel(provider)}|${safeLabel(outcome)}`);
    },
    recordStageDuration({ stage, purpose, elapsedMs }) {
      finiteDuration(elapsedMs, "elapsedMs");
      const key = `${STAGES.has(stage) ? stage : "unknown"}|${PURPOSES.has(purpose) ? purpose : "unknown"}`;
      const histogram = stageHistograms.get(key) ?? createHistogram();
      observeHistogram(histogram, elapsedMs);
      stageHistograms.set(key, histogram);
    },
    recordAudioDuration({ purpose, durationMs }) {
      finiteDuration(durationMs, "durationMs");
      const key = PURPOSES.has(purpose) ? purpose : "unknown";
      const histogram = audioHistograms.get(key) ?? createHistogram();
      observeHistogram(histogram, durationMs);
      audioHistograms.set(key, histogram);
    },
    recordCompletion(event) {
      const completedAtMs = now();
      if (!Number.isFinite(completedAtMs)) throw new TypeError("now() must return a finite number");
      const sanitized = Object.freeze({
        completedAt: new Date(completedAtMs).toISOString(),
        purpose: PURPOSES.has(event?.purpose) ? event.purpose : "unknown",
        provider: safeLabel(event?.provider),
        outcome: safeLabel(event?.outcome),
        errorCode: event?.errorCode ? safeLabel(event.errorCode) : "",
        totalMs: finiteDuration(event?.totalMs, "totalMs"),
        providerMs: event?.providerMs === null || event?.providerMs === undefined
          ? null
          : finiteDuration(event.providerMs, "providerMs"),
        cleanupVerified: event?.cleanupVerified === true,
      });
      if (completed.length === capacity) completed.shift();
      completed.push(sanitized);
      return sanitized;
    },
    snapshot() {
      const totalSamples = completed.map((event) => event.totalMs);
      const providerSamples = completed
        .map((event) => event.providerMs)
        .filter((value) => typeof value === "number");
      return Object.freeze({
        window: Object.freeze({
          startedAt,
          capacity,
          sampleCount: completed.length,
          oldestCompletedAt: completed[0]?.completedAt ?? null,
          newestCompletedAt: completed.at(-1)?.completedAt ?? null,
        }),
        counters: Object.freeze({
          requestsTotal: counterObject(requests),
          providerCallsTotal: counterObject(providerCalls),
          outcomes: counterObject(outcomes),
          cleanupFailuresTotal,
          stageDurationMs: histogramSnapshot(stageHistograms),
          audioDurationMs: histogramSnapshot(audioHistograms),
        }),
        gauges: Object.freeze({ ...gauges }),
        p95: Object.freeze({
          totalMs: percentile95(totalSamples),
          providerMs: percentile95(providerSamples),
        }),
      });
    },
  });
}
