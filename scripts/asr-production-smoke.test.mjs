import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";

import {
  ASR_SMOKE_ASSISTANT_MAX_DURATION_MS,
  ASR_SMOKE_MANIFEST_FILE_MODE,
  ASR_SMOKE_MAX_AUDIO_BYTES,
  ASR_SMOKE_OVERSIZE_BYTES,
  ASR_SMOKE_QUICK_MAX_DURATION_MS,
  ASR_SMOKE_QUALITY_FIXTURE_COUNT,
  atomicWriteAsrSmokeReport,
  characterErrorRate,
  inspectProtectedFixture,
  inspectRuntimeDirectoryDefault,
  parseAsrFixtureManifest,
  parseAsrSmokeCliArguments,
  parseAsrSmokeOrigin,
  parseAsrSmokeSecretsStdin,
  runAsrProductionSmoke,
} from "./asr-production-smoke.mjs";

const SESSION_VALUE = "s".repeat(43);
const CSRF_TOKEN = "fixture-csrf-token";
const STARTED_AT = "2026-09-01T00:00:00.000Z";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const TEST_PRODUCTION_ORIGIN = "https://asr-production.example.invalid";

function makeWorkspace(prefix = "sentelligent-asr-smoke-test-") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const files = [];
  const write = (name, bytes, mode = ASR_SMOKE_MANIFEST_FILE_MODE) => {
    const filePath = join(root, name);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, bytes);
    chmodSync(filePath, mode);
    files.push(filePath);
    return filePath;
  };
  return {
    root,
    write,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function fixtureManifest({ root = "/private/tmp/asr-fixtures", quality = null, overrides = {} } = {}) {
  const entries = quality ?? Array.from({ length: ASR_SMOKE_QUALITY_FIXTURE_COUNT }, (_, index) => ({
    id: `q-${index + 1}`,
    file: join(root, `quality-${index + 1}.wav`),
    mediaType: "audio/wav",
    durationMs: 10_000,
    speaker: index % 2 === 0 ? "speaker-a" : "speaker-b",
    reference: `销售短句${index + 1}`,
  }));
  const firstFile = entries[0]?.file ?? join(root, "quality-1.wav");
  return {
    schemaVersion: 1,
    quality: entries,
    performanceFixtureId: entries[0]?.id ?? "q-1",
    cancellationFixtureId: entries[0]?.id ?? "q-1",
    boundaries: {
      oversize: {
        id: "oversize",
        file: join(root, "oversize.bin"),
        mediaType: "audio/wav",
        durationMs: 10_000,
        purpose: "quick_record",
        expectedStatus: 413,
        expectedCode: "AUDIO_TOO_LARGE",
      },
      quickTooLong: {
        id: "quick-too-long",
        file: firstFile,
        mediaType: "audio/wav",
        durationMs: ASR_SMOKE_QUICK_MAX_DURATION_MS + 1,
        purpose: "quick_record",
        expectedStatus: 422,
        expectedCode: "AUDIO_TOO_LONG",
      },
      assistantTooLong: {
        id: "assistant-too-long",
        file: firstFile,
        mediaType: "audio/wav",
        durationMs: ASR_SMOKE_ASSISTANT_MAX_DURATION_MS + 1,
        purpose: "assistant_chat",
        expectedStatus: 422,
        expectedCode: "AUDIO_TOO_LONG",
      },
      mimeMismatch: {
        id: "mime-mismatch",
        file: firstFile,
        mediaType: "audio/ogg",
        durationMs: 10_000,
        purpose: "quick_record",
        expectedStatus: 415,
        expectedCode: "AUDIO_SIGNATURE_MISMATCH",
      },
    },
    ...overrides,
  };
}

function validManifest(overrides = {}) {
  return parseAsrFixtureManifest(fixtureManifest(overrides));
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { "content-type": "application/json" }),
      ...headers,
    },
  });
}

function statusSnapshot(counters, { cacheControl = "no-store" } = {}) {
  return jsonResponse({
    mode: "live",
    provider: "openai-compatible",
    credentialConfigured: true,
    readiness: { ready: true, code: "READY" },
    window: { startedAt: STARTED_AT, capacity: 512, sampleCount: counters.total },
    requests: { total: counters.requests },
    providerCalls: { total: counters.providerCalls },
    outcomes: { success: counters.providerCalls },
    cleanupFailures: 0,
    inflight: 0,
    activeUploads: 0,
    tempBytes: 0,
    staleTempDirectories: 0,
    p95: { totalMs: null, providerMs: null },
  }, 200, cacheControl ? { "cache-control": cacheControl } : {});
}

function abortableDelay(signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 10_000);
  });
}

function createSmokeFetch(manifest, { cacheControl = "no-store", changeWindow = false } = {}) {
  const counters = { requests: 0, providerCalls: 0, total: 0 };
  const calls = [];
  const qualityByKey = new Map();
  manifest.quality.forEach((fixture, index) => {
    qualityByKey.set(`quality:${index}`, fixture.reference);
  });
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers);
    calls.push({ url, method, headers, options });

    if (method === "POST" && url.pathname === "/api/auth/login") {
      return jsonResponse({ account: "accounta", csrfToken: CSRF_TOKEN }, 200, {
        "set-cookie": `sentelligent_session=${SESSION_VALUE}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      });
    }
    if (method === "POST" && url.pathname === "/api/auth/logout") return new Response(null, { status: 204 });
    if (method === "GET" && url.pathname === "/api/admin/asr/status") {
      return statusSnapshot(counters, {
        cacheControl,
      });
    }
    if (method !== "POST" || url.pathname !== "/api/asr/transcriptions") {
      return jsonResponse({ error: { code: "NOT_FOUND" } }, 404);
    }

    const key = headers.get("Idempotency-Key") ?? "";
    const signal = options.signal;
    if (key.includes(":cancel-upload:") || key.includes(":cancel-provider:")) {
      await abortableDelay(signal);
      return jsonResponse({ error: { code: "ASR_TIMEOUT" } }, 504);
    }

    counters.requests += 1;
    counters.total += 1;
    if (key.includes(":boundary-oversize:")) {
      return jsonResponse({ error: { code: "AUDIO_TOO_LARGE" } }, 413);
    }
    if (key.includes(":boundary-quick-too-long:") || key.includes(":boundary-assistant-too-long:")) {
      return jsonResponse({ error: { code: "AUDIO_TOO_LONG" } }, 422);
    }
    if (key.includes(":boundary-mime-mismatch:")) {
      return jsonResponse({ error: { code: "AUDIO_SIGNATURE_MISMATCH" } }, 415);
    }

    counters.providerCalls += 1;
    if (key.includes(":quality:")) {
      const index = Number(key.split(":").at(-1));
      return jsonResponse({ item: { transcript: qualityByKey.get(`quality:${index}`) ?? "销售短句" } });
    }
    if (key.includes(":performance:")) return jsonResponse({ item: { transcript: "性能测试" } });
    return jsonResponse({ item: { transcript: "语音测试" } });
  };
  if (changeWindow) {
    const original = fetchImpl;
    let statusCount = 0;
    return {
      calls,
      get counters() { return counters; },
      fetchImpl: async (input, options = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/admin/asr/status") {
          statusCount += 1;
          const response = await original(input, options);
          const body = await response.json();
          if (statusCount === 3) body.window.startedAt = "2026-09-01T00:01:00.000Z";
          return jsonResponse(body, 200, { "cache-control": "no-store" });
        }
        return original(input, options);
      },
    };
  }
  return { fetchImpl, calls, counters };
}

function materializeManifest(workspace) {
  const bytes = Buffer.from("RIFF" + "\0".repeat(256), "binary");
  const quality = [];
  for (let index = 0; index < ASR_SMOKE_QUALITY_FIXTURE_COUNT; index += 1) {
    quality.push({
      id: `q-${index + 1}`,
      file: workspace.write(`quality-${index + 1}.wav`, bytes),
      mediaType: "audio/wav",
      durationMs: 10_000,
      speaker: index % 2 === 0 ? "speaker-a" : "speaker-b",
      reference: `销售短句${index + 1}`,
    });
  }
  const oversize = workspace.write("oversize.wav", Buffer.alloc(ASR_SMOKE_OVERSIZE_BYTES, 0));
  const raw = fixtureManifest({ root: workspace.root, quality });
  raw.boundaries.oversize.file = oversize;
  return parseAsrFixtureManifest(raw);
}

describe("ASR production smoke manifest and fixture guards", () => {
  it("requires exactly twelve quality samples", () => {
    assert.throws(
      () => parseAsrFixtureManifest(fixtureManifest({ quality: fixtureManifest().quality.slice(0, 11) })),
      /exactly 12 quality fixtures/,
    );
    assert.equal(validManifest().quality.length, 12);
  });

  it("keeps every browser and device acceptance item pending", () => {
    const allManualClaims = Object.fromEntries(
      [
        "quick-record.processing-copy-only",
        "quick-record.no-write-before-human-confirm",
        "assistant.draft-before-send",
        "account-b.owner-isolation",
        "persistence.no-audio-anywhere",
        "browser.media-recorder-fallback",
        "settings.metadata-only-key-lifecycle",
        "device.desktop-and-iphone",
      ].map((id) => [id, true]),
    );
    const manifest = validManifest({ manualAcceptance: allManualClaims });
    assert.equal(manifest.manualAcceptance.status, "pending");
    assert.ok(manifest.manualAcceptance.checks.every(({ status }) => status === "pending"));
  });

  it("requires two speakers unless equivalent synthetic voices are declared", () => {
    const quality = fixtureManifest().quality.map((item) => ({ ...item, speaker: "one-speaker" }));
    assert.throws(() => parseAsrFixtureManifest(fixtureManifest({ quality })), /at least two speakers/);
    assert.equal(parseAsrFixtureManifest(fixtureManifest({ quality, overrides: { equivalentSyntheticVoices: true } })).speakers, 1);
  });

  it("rejects fixture mode other than 0600", () => {
    const workspace = makeWorkspace();
    try {
      const file = workspace.write("bad.wav", Buffer.from("fixture"), 0o640);
      assert.throws(() => inspectProtectedFixture(file, { forbiddenRoots: [] }), /mode must be exactly 0600/);
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects symlinked fixtures and repository/release paths", () => {
    const workspace = makeWorkspace();
    try {
      const target = workspace.write("target.wav", Buffer.from("fixture"));
      const link = join(workspace.root, "link.wav");
      symlinkSync(target, link);
      assert.throws(() => inspectProtectedFixture(link, { forbiddenRoots: [] }), /canonical non-symlink/);
      const releaseFile = workspace.write("release/fixture.wav", Buffer.from("fixture"));
      assert.throws(() => inspectProtectedFixture(releaseFile, { forbiddenRoots: [] }), /outside Git, release/);
    } finally {
      workspace.cleanup();
    }
  });

  it("enforces the 8 MiB plus one oversize boundary", () => {
    const workspace = makeWorkspace();
    try {
      const file = workspace.write("oversize.wav", Buffer.alloc(ASR_SMOKE_OVERSIZE_BYTES));
      const inspected = inspectProtectedFixture(file, {
        expectedBytes: ASR_SMOKE_OVERSIZE_BYTES,
        forbiddenRoots: [],
      });
      assert.equal(inspected.byteLength, ASR_SMOKE_MAX_AUDIO_BYTES + 1);
      assert.equal(inspected.byteLength, ASR_SMOKE_OVERSIZE_BYTES);
    } finally {
      workspace.cleanup();
    }
  });
});

describe("ASR production smoke pure contracts", () => {
  it("calculates Unicode code-point CER, including empty strings", () => {
    assert.equal(characterErrorRate("你好", "你好"), 0);
    assert.equal(characterErrorRate("你好", "你"), 0.5);
    assert.equal(characterErrorRate("😀好", "😀坏"), 0.5);
    assert.equal(characterErrorRate("", ""), 0);
    assert.equal(characterErrorRate("", "非空"), 1);
  });

  it("accepts only an explicitly supplied exact bare production HTTPS origin", () => {
    assert.equal(parseAsrSmokeOrigin(TEST_PRODUCTION_ORIGIN), TEST_PRODUCTION_ORIGIN);
    for (const value of [
      "http://asr-production.example.invalid",
      `${TEST_PRODUCTION_ORIGIN}/path`,
      `${TEST_PRODUCTION_ORIGIN}?x=1`,
      `${TEST_PRODUCTION_ORIGIN}#fragment`,
      "https://user:pass@asr-production.example.invalid",
      "https://asr-production.example.invalid:443",
    ]) assert.throws(() => parseAsrSmokeOrigin(value), /exact production HTTPS origin|bare HTTPS origin/);
  });

  it("does not embed any production URL in the runner source", () => {
    const runnerSource = readFileSync(new URL("./asr-production-smoke.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(runnerSource, /https?:\/\/[A-Za-z0-9.-]+/u);
  });

  it("requires an explicit origin but accepts the documented environment input", () => {
    const base = [
      "--manifest=/private/tmp/manifest.json",
      "--report=/private/tmp/report.json",
    ];
    assert.throws(() => parseAsrSmokeCliArguments(base, { environment: {} }), /origin/);
    assert.equal(
      parseAsrSmokeCliArguments(base, {
        environment: { SENT_ZX_ASR_SMOKE_ORIGIN: TEST_PRODUCTION_ORIGIN },
      }).origin,
      TEST_PRODUCTION_ORIGIN,
    );
    assert.throws(
      () => parseAsrSmokeCliArguments(base, { environment: { SENT_ZX_ASR_SMOKE_ORIGIN: "http://127.0.0.1" } }),
      /bare HTTPS origin/,
    );
  });

  it("keeps credentials out of CLI arguments and reads them only from JSON stdin", () => {
    const base = [
      `--origin=${TEST_PRODUCTION_ORIGIN}`,
      "--manifest=/private/tmp/manifest.json",
      "--report=/private/tmp/report.json",
      "--account=accounta",
    ];
    assert.throws(() => parseAsrSmokeCliArguments([...base, "--password=secret"]), /only through JSON stdin/);
    assert.throws(
      () => parseAsrSmokeSecretsStdin('{"password":"fixture-password"}'),
      /--account is required/,
    );
    assert.deepEqual(parseAsrSmokeSecretsStdin('{"password":"fixture-password"}', { defaultAccount: "accounta" }), [
      { account: "accounta", password: "fixture-password" },
    ]);
    assert.deepEqual(parseAsrSmokeSecretsStdin('{"accounts":[{"account":"accounta","password":"fixture-password"},{"account":"acctb","password":"test-password"}]}'), [
      { account: "accounta", password: "fixture-password" },
      { account: "acctb", password: "test-password" },
    ]);
    assert.throws(() => parseAsrSmokeSecretsStdin('{"password":"fixture-password","cookie":"fixture-cookie"}'), /only password or accounts/);
    assert.throws(() => parseAsrSmokeCliArguments([...base, "--cookie=x"]), /only through JSON stdin/);
  });

  it("atomically writes a 0600 report and never overwrites it", () => {
    const workspace = makeWorkspace();
    try {
      const reportPath = join(workspace.root, "reports", "smoke.json");
      assert.equal(atomicWriteAsrSmokeReport(reportPath, { status: "passed", checks: [] }), reportPath);
      assert.equal(statSync(reportPath).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), { status: "passed", checks: [] });
      assert.throws(() => atomicWriteAsrSmokeReport(reportPath, { status: "changed" }), /already exists/);
      assert.equal(existsSync(join(workspace.root, "reports", `.${basename(reportPath)}.tmp`)), false);
      assert.throws(
        () => atomicWriteAsrSmokeReport(join(workspace.root, "reports", "unsafe.json"), { transcript: "secret" }),
        /forbidden field transcript/,
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("fails closed for missing, unsafe, or non-empty runtime directories", () => {
    const workspace = makeWorkspace();
    try {
      assert.deepEqual(
        inspectRuntimeDirectoryDefault(join(workspace.root, "missing")),
        { empty: false, count: null, status: "missing" },
      );
      const runtime = join(workspace.root, "runtime");
      mkdirSync(runtime);
      chmodSync(runtime, 0o755);
      assert.equal(inspectRuntimeDirectoryDefault(runtime).status, "unsafe");
      chmodSync(runtime, 0o700);
      workspace.write("runtime/leftover", Buffer.from("residual"));
      assert.deepEqual(inspectRuntimeDirectoryDefault(runtime), {
        empty: false,
        count: 1,
        status: "inspected",
      });
    } finally {
      workspace.cleanup();
    }
  });
});

describe("ASR production smoke end-to-end runner", () => {
  it("runs quality, performance, cancellation and boundary checks without writing audio or transcript", async () => {
    const workspace = makeWorkspace();
    try {
      const manifest = materializeManifest(workspace);
      const mock = createSmokeFetch(manifest);
      const reportPath = join(workspace.root, "report.json");
      const report = await runAsrProductionSmoke({
        origin: TEST_PRODUCTION_ORIGIN,
        reportPath,
        accounts: [{ account: "accounta", password: "fixture-password" }],
        manifest,
        manifestSha256: "a".repeat(64),
        manifestBytes: 1234,
        fetchImpl: mock.fetchImpl,
        runId: RUN_ID,
        now: () => new Date("2026-09-01T00:00:00.000Z"),
        monotonicNow: (() => {
          let value = 0;
          return () => (value += 1);
        })(),
        sleep: async () => {},
        inspectFixture: (filePath, options) => inspectProtectedFixture(filePath, { ...options, forbiddenRoots: [] }),
        inspectRuntimeDirectory: async () => ({ empty: true, count: 0, status: "inspected" }),
        uploadCancelDelayMs: 1,
        providerCancelDelayMs: 1,
      });
      assert.equal(report.status, "passed");
      assert.equal(report.releaseReady, false, "manual browser/device evidence is intentionally pending");
      assert.equal(report.quality.validResponses, 12);
      assert.equal(report.quality.medianCer, 0);
      assert.equal(report.performance.attempts, 20);
      assert.equal(report.performance.successes, 20);
      assert.deepEqual(report.performance.metricsDelta, {
        requests: 20,
        providerCalls: 20,
        cleanupVerified: 20,
        cleanupFailures: 0,
        stale: 0,
      });
      assert.equal(report.cancellation.attempts, 10);
      assert.equal(report.cancellation.releasedWithinTwoSeconds, 10);
      assert.equal(report.boundaries.providerCallsDelta, 0);
      assert.ok(report.checks.every(({ status }) => status === "passed"));
      const serialized = readFileSync(reportPath, "utf8");
      assert.equal(serialized.includes(workspace.root), false);
      assert.equal(serialized.includes("销售短句1"), false);
      assert.equal(serialized.includes("fixture-password"), false);
      assert.equal(serialized.includes(SESSION_VALUE), false);
      assert.equal(serialized.includes(CSRF_TOKEN), false);
      assert.equal(serialized.includes('"transcript":'), false);
      assert.equal(statSync(reportPath).mode & 0o777, 0o600);
    } finally {
      workspace.cleanup();
    }
  });

  it("fails status checks when the admin response is not no-store", async () => {
    const workspace = makeWorkspace();
    try {
      const manifest = materializeManifest(workspace);
      const mock = createSmokeFetch(manifest, { cacheControl: "private, max-age=60" });
      const report = await runAsrProductionSmoke({
        origin: TEST_PRODUCTION_ORIGIN,
        reportPath: join(workspace.root, "report.json"),
        accounts: [{ account: "accounta", password: "fixture-password" }],
        manifest,
        manifestSha256: "b".repeat(64),
        manifestBytes: 1234,
        fetchImpl: mock.fetchImpl,
        runId: RUN_ID,
        now: () => new Date("2026-09-01T00:00:00.000Z"),
        inspectFixture: (filePath, options) => inspectProtectedFixture(filePath, { ...options, forbiddenRoots: [] }),
        inspectRuntimeDirectory: async () => ({ empty: true, count: 0, status: "inspected" }),
        uploadCancelDelayMs: 1,
        providerCancelDelayMs: 1,
      });
      assert.equal(report.status, "failed");
      assert.equal(report.checks.find(({ id }) => id === "status.before").status, "failed");
      assert.equal(report.checks.find(({ id }) => id === "quality.cer").status, "blocked");
    } finally {
      workspace.cleanup();
    }
  });

  it("fails a performance metrics window that changes while the run is in progress", async () => {
    const workspace = makeWorkspace();
    try {
      const manifest = materializeManifest(workspace);
      const mock = createSmokeFetch(manifest, { changeWindow: true });
      const report = await runAsrProductionSmoke({
        origin: TEST_PRODUCTION_ORIGIN,
        reportPath: join(workspace.root, "report.json"),
        accounts: [{ account: "accounta", password: "fixture-password" }],
        manifest,
        manifestSha256: "c".repeat(64),
        manifestBytes: 1234,
        fetchImpl: mock.fetchImpl,
        runId: RUN_ID,
        now: () => new Date("2026-09-01T00:00:00.000Z"),
        inspectFixture: (filePath, options) => inspectProtectedFixture(filePath, { ...options, forbiddenRoots: [] }),
        inspectRuntimeDirectory: async () => ({ empty: true, count: 0, status: "inspected" }),
        uploadCancelDelayMs: 1,
        providerCancelDelayMs: 1,
      });
      assert.equal(report.status, "failed");
      const performanceCheck = report.checks.find(({ id }) => id === "performance.metrics-delta");
      assert.equal(performanceCheck.status, "failed");
      assert.match(performanceCheck.error ?? "", /window restarted|metrics window/);
    } finally {
      workspace.cleanup();
    }
  });
});
