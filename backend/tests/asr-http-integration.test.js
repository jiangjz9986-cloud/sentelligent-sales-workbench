import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as createHttpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createUser } from "../src/auth/usersStore.js";
import { openDatabase } from "../src/db.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";
import {
  ASR_SETTING_KEY,
  createSecureSettingsRepository,
} from "../src/settings/repository.js";

const passwordField = "pass" + "word";
const adminAccount = "asradmin";
const memberAAccount = "asrmembera";
const memberBAccount = "asrmemberb";
const adminLoginValue = "asr-admin-login";
const memberALoginValue = "asr-member-a-login";
const memberBLoginValue = "asr-member-b-login";
const allowedOrigin = "https://asr.example.test";
const machineBearerValue = "synthetic-asr-machine-token";
const settingsKey = Buffer.alloc(32, 91).toString("base64url");
const sessionSecret = Buffer.alloc(32, 92).toString("base64url");
const validIdempotencyKey = "asr:12345678-1234-4234-8234-123456789abc";

const [adminHash, memberAHash, memberBHash] = await Promise.all([
  hashPassword(adminLoginValue, { salt: Buffer.alloc(16, 91) }),
  hashPassword(memberALoginValue, { salt: Buffer.alloc(16, 92) }),
  hashPassword(memberBLoginValue, { salt: Buffer.alloc(16, 93) }),
]);

function metricsSnapshot(state) {
  return Object.freeze({
    window: Object.freeze({
      startedAt: "2026-08-31T00:00:00.000Z",
      capacity: 512,
      sampleCount: state.transcribeCalls,
      oldestCompletedAt: null,
      newestCompletedAt: null,
    }),
    counters: Object.freeze({
      requestsTotal: Object.freeze({
        "quick_record|openai-compatible|success|none": state.transcribeCalls,
      }),
      providerCallsTotal: Object.freeze({
        "openai-compatible|success": state.transcribeCalls,
      }),
      outcomes: Object.freeze({
        "success|none": state.transcribeCalls,
      }),
      cleanupFailuresTotal: 0,
      stageDurationMs: Object.freeze({}),
      audioDurationMs: Object.freeze({}),
    }),
    gauges: Object.freeze({
      inflight: state.inflight,
      activeUploads: 0,
      tempBytes: 0,
      staleTempDirectories: 0,
    }),
    p95: Object.freeze({ totalMs: null, providerMs: null }),
  });
}

function createStubAsrService(overrides = {}) {
  const state = {
    initializeCalls: 0,
    transcribeCalls: 0,
    closeCalls: 0,
    inflight: 0,
    inputs: [],
    closed: false,
  };
  const service = {
    async initialize() {
      state.initializeCalls += 1;
      return { ready: true, code: "READY" };
    },
    readiness() {
      return state.closed
        ? { ready: false, code: "ASR_CLOSED" }
        : { ready: true, code: "READY" };
    },
    async transcribe(input) {
      state.transcribeCalls += 1;
      state.inflight += 1;
      state.inputs.push(input);
      try {
        let byteLength = 0;
        for await (const chunk of input.body) byteLength += Buffer.byteLength(chunk);
        return {
          transcript: `合成转写-${input.owner}`,
          language: "zh-CN",
          durationMs: input.clientDurationMs ?? 1_200,
          source: "server_asr",
          replayed: false,
          byteLength,
        };
      } finally {
        state.inflight -= 1;
      }
    },
    async close() {
      state.closeCalls += 1;
      state.closed = true;
    },
    metrics: { snapshot: () => metricsSnapshot(state) },
    capacitySnapshot() {
      return {
        uploads: {
          activeUploads: 0,
          tempBytes: 0,
          activeUploadsMax: 4,
          aggregateTempMaxBytes: 33_554_432,
        },
        processing: {
          globalActive: 0,
          activeOwners: 0,
          ownerMax: 1,
          globalMax: 2,
        },
        idempotency: {
          pending: 0,
          completed: 0,
          capacity: 256,
          ttlMs: 300_000,
        },
      };
    },
    lifecycleSnapshot() {
      return {
        accepting: !state.closed,
        activeRequests: state.inflight,
      };
    },
    ...overrides,
  };
  return { service, state };
}

function rejectWhenAborted(signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function within(promise, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("integration wait timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function databaseSnapshot(databaseUrl, { exclude = new Set() } = {}) {
  const db = createConnection({ databaseUrl });
  try {
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name).filter((name) => !exclude.has(name));
    return Object.fromEntries(tables.map((name) => {
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all();
      return [
        name,
        createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex"),
      ];
    }));
  } finally {
    db.close();
  }
}

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let stub;

async function seedHarness({ credential = "active" } = {}) {
  const db = openDatabase({ databaseUrl });
  try {
    for (const user of [
      [adminAccount, "ASR 管理员", adminHash, "admin"],
      [memberAAccount, "ASR 成员 A", memberAHash, "member"],
      [memberBAccount, "ASR 成员 B", memberBHash, "member"],
    ]) {
      createUser(db, {
        account: user[0],
        displayName: user[1],
        passwordHash: user[2],
        role: user[3],
        now: "2026-08-31T00:00:00.000Z",
      });
    }
    const repository = createSecureSettingsRepository(db, { masterKey: settingsKey });
    if (credential === "active") repository.setSecret(ASR_SETTING_KEY, "synthetic-asr-http-key");
    if (credential === "cleared") repository.clearSecret(ASR_SETTING_KEY);
  } finally {
    db.close();
  }
}

async function startHarness({ credential = "active", service, ...overrides } = {}) {
  await seedHarness({ credential });
  stub = service ? { service, state: service.state ?? null } : createStubAsrService();
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: adminAccount,
    authPassword: "",
    authPasswordHash: adminHash,
    authSessionSecret: sessionSecret,
    authCookieSecure: false,
    corsAllowedOrigins: [allowedOrigin],
    settingsEncryptionKey: settingsKey,
    weixinAgentApiToken: machineBearerValue,
    weixinAgentOwner: adminAccount,
    asrMode: "live",
    asrProvider: "openai-compatible",
    asrBaseUrl: "https://asr-provider.example.test/v1",
    asrModel: "synthetic-asr-model",
    asrService: stub.service,
    hospitalTenderSchedulerEnabled: false,
    actionReminderSchedulerEnabled: false,
    dailyDigestSchedulerEnabled: false,
    ...overrides,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return stub;
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body, text };
}

async function login(account, password) {
  const result = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, [passwordField]: password }),
  });
  assert.equal(result.response.status, 200);
  return {
    cookie: cookiePair(result.response),
    csrf: result.body.csrfToken,
  };
}

function transcriptionHeaders(auth, overrides = {}) {
  return {
    Cookie: auth.cookie,
    "X-CSRF-Token": auth.csrf,
    "Content-Type": "audio/webm;codecs=opus",
    "Idempotency-Key": validIdempotencyKey,
    "X-Audio-Duration-Ms": "1200",
    "X-ASR-Language": "zh-CN",
    ...overrides,
  };
}

async function transcribe(auth, { purpose = "quick_record", headers = {}, body = Buffer.from("synthetic-audio") } = {}) {
  return request(`/api/asr/transcriptions?purpose=${purpose}`, {
    method: "POST",
    headers: transcriptionHeaders(auth, headers),
    body,
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-asr-http-"));
  databaseUrl = join(tempDir, "asr-http.sqlite");
  server = null;
  baseUrl = null;
  stub = null;
});

afterEach(async () => {
  if (server) await closeServer(server);
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("ASR createServer authentication and routing", () => {
  it("rejects anonymous and machine callers before initialization or transcription", async () => {
    const { state } = await startHarness();
    const anonymous = await request("/api/asr/transcriptions?purpose=quick_record", {
      method: "POST",
      headers: {
        "Content-Type": "audio/webm",
        "Idempotency-Key": validIdempotencyKey,
      },
      body: "anonymous-audio",
    });
    assert.equal(anonymous.response.status, 401);
    assert.equal(anonymous.body.error.code, "UNAUTHORIZED");

    const machine = await request("/api/asr/transcriptions?purpose=quick_record", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${machineBearerValue}`,
        "Content-Type": "audio/webm",
        "Idempotency-Key": validIdempotencyKey,
      },
      body: "machine-audio",
    });
    assert.equal(machine.response.status, 403);
    assert.equal(machine.body.error.code, "MACHINE_SCOPE_DENIED");
    assert.equal(state.initializeCalls, 0);
    assert.equal(state.transcribeCalls, 0);
  });

  it("allows member and admin cookies and derives owner only from authContext.account", async () => {
    const { state } = await startHarness();
    const member = await login(memberAAccount, memberALoginValue);
    const admin = await login(adminAccount, adminLoginValue);
    const memberResult = await transcribe(member, {
      headers: { "X-Untrusted-Owner": memberBAccount },
    });
    const adminResult = await transcribe(admin, { purpose: "assistant_chat" });

    assert.equal(memberResult.response.status, 200);
    assert.equal(memberResult.body.item.transcript, `合成转写-${memberAAccount}`);
    assert.equal(memberResult.body.item.source, "server_asr");
    assert.equal(adminResult.response.status, 200);
    assert.deepEqual(state.inputs.map((input) => input.owner), [memberAAccount, adminAccount]);
    assert.deepEqual(state.inputs.map((input) => input.purpose), ["quick_record", "assistant_chat"]);
    for (const input of state.inputs) {
      assert.equal(Object.hasOwn(input, "headers"), false);
      assert.equal(Object.hasOwn(input, "remoteAddress"), false);
    }
  });

  it("rejects bad Origin, bad CSRF and GET before the service handles audio", async () => {
    const { state } = await startHarness();
    const member = await login(memberAAccount, memberALoginValue);

    const badOrigin = await transcribe(member, {
      headers: { Origin: "https://attacker.example.test" },
    });
    assert.equal(badOrigin.response.status, 403);
    assert.equal(badOrigin.body.error.code, "ORIGIN_NOT_ALLOWED");

    const badCsrf = await transcribe(member, {
      headers: { "X-CSRF-Token": "wrong" },
    });
    assert.equal(badCsrf.response.status, 403);
    assert.equal(badCsrf.body.error.code, "CSRF_INVALID");

    const get = await request("/api/asr/transcriptions?purpose=quick_record", {
      headers: { Cookie: member.cookie },
    });
    assert.equal(get.response.status, 405);
    assert.equal(get.body.error.code, "METHOD_NOT_ALLOWED");
    assert.equal(get.response.headers.get("allow"), "POST");
    assert.equal(state.initializeCalls, 0);
    assert.equal(state.transcribeCalls, 0);
  });
});

describe("ASR request-level preflight deadlines and cancellation", () => {
  it("times out and cancels secure-setting metadata before runtime initialization", async () => {
    let metadataSignal = null;
    const { state } = await startHarness({
      asrCredentialMetadataProvider: ({ signal }) => {
        metadataSignal = signal;
        return rejectWhenAborted(signal);
      },
      asrHttpOptions: { preflightTimeoutMs: 20 },
    });
    const member = await login(memberAAccount, memberALoginValue);
    const result = await transcribe(member);

    assert.equal(result.response.status, 504);
    assert.equal(result.body.error.code, "ASR_TIMEOUT");
    assert.equal(result.response.headers.get("cache-control"), "no-store, max-age=0");
    assert.ok(metadataSignal);
    assert.equal(metadataSignal.aborted, true);
    assert.equal(metadataSignal.reason?.code, "ASR_TIMEOUT");
    assert.equal(state.initializeCalls, 0);
    assert.equal(state.transcribeCalls, 0);
  });

  it("times out and cancels runtime initialization before readiness or transcription", async () => {
    let initializeSignal = null;
    let readinessCalls = 0;
    const custom = createStubAsrService({
      initialize({ signal }) {
        custom.state.initializeCalls += 1;
        initializeSignal = signal;
        return rejectWhenAborted(signal);
      },
      readiness() {
        readinessCalls += 1;
        return { ready: true, code: "READY" };
      },
    });
    custom.service.state = custom.state;
    const { state } = await startHarness({
      service: custom.service,
      asrHttpOptions: { preflightTimeoutMs: 20 },
    });
    const member = await login(memberAAccount, memberALoginValue);
    const result = await transcribe(member);

    assert.equal(result.response.status, 504);
    assert.equal(result.body.error.code, "ASR_TIMEOUT");
    assert.ok(initializeSignal);
    assert.equal(initializeSignal.aborted, true);
    assert.equal(initializeSignal.reason?.code, "ASR_TIMEOUT");
    assert.equal(state.initializeCalls, 1);
    assert.equal(readinessCalls, 0);
    assert.equal(state.transcribeCalls, 0);
  });

  it("times out and cancels the admin readiness snapshot", async () => {
    let readinessSignal = null;
    const custom = createStubAsrService({
      readiness({ signal }) {
        readinessSignal = signal;
        return rejectWhenAborted(signal);
      },
    });
    custom.service.state = custom.state;
    const { state } = await startHarness({
      service: custom.service,
      asrHttpOptions: { preflightTimeoutMs: 20 },
    });
    const admin = await login(adminAccount, adminLoginValue);
    const result = await request("/api/admin/asr/status", {
      headers: { Cookie: admin.cookie },
    });

    assert.equal(result.response.status, 504);
    assert.equal(result.body.error.code, "ASR_TIMEOUT");
    assert.equal(result.response.headers.get("cache-control"), "no-store, max-age=0");
    assert.ok(readinessSignal);
    assert.equal(readinessSignal.aborted, true);
    assert.equal(readinessSignal.reason?.code, "ASR_TIMEOUT");
    assert.equal(state.initializeCalls, 0);
    assert.equal(state.transcribeCalls, 0);
  });

  it("cancels metadata and writes no response after the browser disconnects", async () => {
    let metadataSignal = null;
    let metadataStartedResolve;
    let metadataCancelledResolve;
    const metadataStarted = new Promise((resolve) => { metadataStartedResolve = resolve; });
    const metadataCancelled = new Promise((resolve) => { metadataCancelledResolve = resolve; });
    const { state } = await startHarness({
      asrCredentialMetadataProvider: ({ signal }) => {
        metadataSignal = signal;
        metadataStartedResolve();
        signal.addEventListener("abort", metadataCancelledResolve, { once: true });
        return rejectWhenAborted(signal);
      },
      asrHttpOptions: { preflightTimeoutMs: 1_000 },
    });
    const member = await login(memberAAccount, memberALoginValue);
    const client = createHttpRequest({
      host: "127.0.0.1",
      port: server.address().port,
      method: "POST",
      path: "/api/asr/transcriptions?purpose=quick_record",
      headers: {
        Cookie: member.cookie,
        "X-CSRF-Token": member.csrf,
        "Content-Type": "audio/webm",
        "Idempotency-Key": validIdempotencyKey,
        "X-Audio-Duration-Ms": "1200",
        "X-ASR-Language": "zh-CN",
        "Transfer-Encoding": "chunked",
      },
    });
    client.once("error", () => {
      // Destroying the browser-side socket is the behavior under test.
    });
    client.write(Buffer.alloc(1_024, 3));
    await within(metadataStarted);
    client.destroy();
    await within(metadataCancelled);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(metadataSignal);
    assert.equal(metadataSignal.aborted, true);
    assert.equal(metadataSignal.reason?.name, "AbortError");
    assert.equal(state.initializeCalls, 0);
    assert.equal(state.transcribeCalls, 0);
    const health = await request("/api/health");
    assert.equal(health.response.status, 200);
  });
});

describe("ASR owner, limit and secure-setting isolation", () => {
  it("keeps identical idempotency keys and account+IP rate buckets isolated by account", async () => {
    const { state } = await startHarness();
    const accountA = await login(memberAAccount, memberALoginValue);
    const accountB = await login(memberBAccount, memberBLoginValue);
    for (let index = 0; index < 12; index += 1) {
      const accepted = await transcribe(accountA);
      assert.equal(accepted.response.status, 200, `A request ${index + 1}`);
    }
    const limited = await transcribe(accountA);
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error.code, "ASR_RATE_LIMITED");
    assert.match(limited.response.headers.get("retry-after"), /^(?:[1-9]|[1-9]\d|[12]\d{2}|300)$/u);

    const unaffected = await transcribe(accountB);
    assert.equal(unaffected.response.status, 200);
    assert.equal(unaffected.body.item.transcript, `合成转写-${memberBAccount}`);
    assert.equal(state.transcribeCalls, 13);

    const db = createConnection({ databaseUrl });
    try {
      const rows = db.prepare("SELECT key, failures, window_started_at, blocked_until FROM login_rate_limits ORDER BY key").all();
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => row.failures).sort((a, b) => a - b), [1, 12]);
      for (const row of rows) {
        assert.match(row.key, /^[A-Za-z0-9_-]{43}$/u);
        assert.equal(row.key.includes(memberAAccount), false);
        assert.equal(row.key.includes(memberBAccount), false);
        assert.equal(row.blocked_until, null);
      }
    } finally {
      db.close();
    }
  });

  it("fails closed for missing and cleared ASR credentials without initializing the runtime", async () => {
    for (const credential of ["missing", "cleared"]) {
      const isolatedDir = await mkdtemp(join(tmpdir(), `sentelligent-asr-${credential}-`));
      const priorDatabaseUrl = databaseUrl;
      const priorServer = server;
      try {
        databaseUrl = join(isolatedDir, "asr.sqlite");
        server = null;
        const { state } = await startHarness({ credential });
        const member = await login(memberAAccount, memberALoginValue);
        const result = await transcribe(member);
        assert.equal(result.response.status, 503, credential);
        assert.equal(result.body.error.code, "ASR_NOT_CONFIGURED", credential);
        assert.equal(state.initializeCalls, 0, credential);
        assert.equal(state.transcribeCalls, 0, credential);
      } finally {
        if (server) await closeServer(server);
        server = priorServer;
        databaseUrl = priorDatabaseUrl;
        await rm(isolatedDir, { recursive: true, force: true });
      }
    }
  });

  it("observes an explicit credential clear without restarting the server", async () => {
    const { state } = await startHarness();
    const member = await login(memberAAccount, memberALoginValue);
    const admin = await login(adminAccount, adminLoginValue);
    assert.equal((await transcribe(member)).response.status, 200);

    const cleared = await request("/api/settings/asr-api-key", {
      method: "DELETE",
      headers: {
        Cookie: admin.cookie,
        "X-CSRF-Token": admin.csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation: "CLEAR" }),
    });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.body.item.status, "cleared");

    const denied = await transcribe(member);
    assert.equal(denied.response.status, 503);
    assert.equal(denied.body.error.code, "ASR_NOT_CONFIGURED");
    assert.equal(state.transcribeCalls, 1);
  });
});

describe("ASR admin status, persistence and shutdown", () => {
  it("restricts status to admins and returns only bounded aggregate metadata", async () => {
    const { state } = await startHarness();
    const member = await login(memberAAccount, memberALoginValue);
    const admin = await login(adminAccount, adminLoginValue);

    const anonymous = await request("/api/admin/asr/status");
    assert.equal(anonymous.response.status, 401);
    const memberDenied = await request("/api/admin/asr/status", {
      headers: { Cookie: member.cookie },
    });
    assert.equal(memberDenied.response.status, 403);
    assert.equal(memberDenied.body.error.code, "ADMIN_ROLE_REQUIRED");
    const machineDenied = await request("/api/admin/asr/status", {
      headers: { Authorization: `Bearer ${machineBearerValue}` },
    });
    assert.equal(machineDenied.response.status, 403);
    assert.equal(machineDenied.body.error.code, "MACHINE_SCOPE_DENIED");

    assert.equal((await transcribe(member)).response.status, 200);
    const status = await request("/api/admin/asr/status", {
      headers: { Cookie: admin.cookie },
    });
    assert.equal(status.response.status, 200);
    assert.equal(status.response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(status.body.item.mode, "live");
    assert.equal(status.body.item.provider, "openai-compatible");
    assert.equal(status.body.item.credentialConfigured, true);
    assert.equal(status.body.item.inflight, 0);
    assert.equal(status.body.item.requests["quick_record|openai-compatible|success|none"], 1);
    const serialized = JSON.stringify(status.body);
    for (const forbidden of [
      '"owner":', '"account":', "requestId", "transcript", "audioPath", "apiKey", "baseUrl", "ring",
      memberAAccount, "synthetic-asr-http-key",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.equal(state.transcribeCalls, 1);
  });

  it("changes no business or audit table while transcribing", async () => {
    await startHarness();
    const member = await login(memberAAccount, memberALoginValue);
    const exclude = new Set(["login_rate_limits"]);
    const before = databaseSnapshot(databaseUrl, { exclude });
    const result = await transcribe(member);
    assert.equal(result.response.status, 200);
    const after = databaseSnapshot(databaseUrl, { exclude });
    assert.deepEqual(after, before);
  });

  it("waits for the single server-owned ASR runtime to close before resolving close", async () => {
    let releaseClose;
    const closeGate = new Promise((resolve) => { releaseClose = resolve; });
    const custom = createStubAsrService({
      async close() {
        custom.state.closeCalls += 1;
        await closeGate;
        custom.state.closed = true;
      },
    });
    custom.service.state = custom.state;
    await startHarness({ service: custom.service });
    let callbackCalled = false;
    const closePromise = new Promise((resolve, reject) => {
      server.close((error) => {
        callbackCalled = true;
        error ? reject(error) : resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(callbackCalled, false);
    assert.equal(custom.state.closeCalls, 1);
    releaseClose();
    await closePromise;
    assert.equal(callbackCalled, true);
    assert.equal(custom.state.closed, true);
    server = null;
  });
});

describe("ASR slow unread request rejection", () => {
  it("delivers anonymous JSON before terminating an unread upload", async () => {
    const { state } = await startHarness();
    const received = await new Promise((resolve, reject) => {
      const client = createHttpRequest({
        host: "127.0.0.1",
        port: server.address().port,
        method: "POST",
        path: "/api/asr/transcriptions?purpose=quick_record",
        headers: {
          "Content-Type": "audio/webm",
          "Idempotency-Key": validIdempotencyKey,
          "Transfer-Encoding": "chunked",
        },
      }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.once("error", reject);
        response.once("end", () => resolve({ response, text }));
      });
      client.once("error", (error) => {
        if (client.res) return;
        reject(error);
      });
      client.write(Buffer.alloc(1_024, 7));
      setTimeout(() => {
        if (!client.destroyed) client.end(Buffer.alloc(1_024, 8));
      }, 250).unref?.();
    });

    assert.equal(received.response.statusCode, 401);
    const body = JSON.parse(received.text);
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.equal(typeof body.error.requestId, "string");
    assert.equal(received.text, JSON.stringify(body));
    assert.equal(state.initializeCalls, 0);
    assert.equal(state.transcribeCalls, 0);
  });

  it("delivers complete JSON before terminating a slow body", async () => {
    const { state } = await startHarness({ credential: "missing" });
    const member = await login(memberAAccount, memberALoginValue);
    const received = await new Promise((resolve, reject) => {
      const client = createHttpRequest({
        host: "127.0.0.1",
        port: server.address().port,
        method: "POST",
        path: "/api/asr/transcriptions?purpose=quick_record",
        headers: {
          Cookie: member.cookie,
          "X-CSRF-Token": member.csrf,
          "Content-Type": "audio/webm",
          "Idempotency-Key": validIdempotencyKey,
          "X-Audio-Duration-Ms": "1200",
          "X-ASR-Language": "zh-CN",
          "Transfer-Encoding": "chunked",
        },
      }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.once("error", reject);
        response.once("end", () => resolve({ response, text }));
      });
      client.once("error", (error) => {
        // The server intentionally destroys the unread upload after the JSON
        // response.  Once response bytes arrived, that reset is not a failure.
        if (client.res) return;
        reject(error);
      });
      client.write(Buffer.alloc(1_024, 1));
      setTimeout(() => {
        if (!client.destroyed) client.end(Buffer.alloc(1_024, 2));
      }, 250).unref?.();
    });

    assert.equal(received.response.statusCode, 503);
    assert.equal(received.response.headers["cache-control"], "no-store, max-age=0");
    const body = JSON.parse(received.text);
    assert.equal(body.error.code, "ASR_NOT_CONFIGURED");
    assert.equal(typeof body.error.requestId, "string");
    assert.equal(received.text, JSON.stringify(body));
    assert.equal(state.initializeCalls, 0);
    assert.equal(state.transcribeCalls, 0);
  });
});
