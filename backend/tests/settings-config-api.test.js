import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";
import {
  ASR_SETTING_KEY,
  createSecureSettingsRepository,
  DEEPSEEK_SETTING_KEY,
} from "../src/settings/repository.js";
import { maskSecret } from "../src/settings/secretBox.js";

// v0.9.1 起系统配置写端点要求 active admin（users 行由启动兜底种子创建），
// 账号必须符合 ^[a-z0-9]{2,32}$ 才会被种子接受。
const account = "settingsowner";
const password = "unit-password";
const passwordHash = await hashPassword(password, { salt: Buffer.alloc(16, 91) });
const encryptionKey = Buffer.alloc(32, 92).toString("base64url");
const apiKeyField = ["api", "Key"].join("");

let tempDir;
let databaseUrl;
let server;
let baseUrl;

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function startServer(overrides = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-settings-api-"));
  databaseUrl = join(tempDir, "settings.sqlite");
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret: Buffer.alloc(32, 93).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
    settingsEncryptionKey: encryptionKey,
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function login() {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  });
  assert.equal(result.response.status, 200);
  return { cookie: cookiePair(result.response), csrf: result.body.csrfToken };
}

function readSettingsState() {
  const db = createConnection({ databaseUrl });
  try {
    return {
      asr: db.prepare(
        "SELECT * FROM secure_settings WHERE setting_key = $key",
      ).get({ $key: ASR_SETTING_KEY }) ?? null,
      audit: db.prepare(`
        SELECT action, entity_type, entity_id, actor, metadata_json, before_json, after_json
        FROM audit_logs
        WHERE entity_type = 'secure_setting' AND entity_id = $key
        ORDER BY rowid
      `).all({ $key: ASR_SETTING_KEY }).map((row) => ({ ...row })),
    };
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tempDir = null;
  databaseUrl = null;
  server = null;
  baseUrl = null;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("secure settings repository ASR allowlist", () => {
  it("allows the frozen ASR key and exposes its metadata entry without widening to iCost", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const repository = createSecureSettingsRepository(db, { masterKey: encryptionKey });
      assert.equal(ASR_SETTING_KEY, "asr_api_key");
      assert.deepEqual(Object.keys(repository.listMetadata()), ["deepseek", "asr"]);
      assert.deepEqual(repository.listMetadata().asr, {
        configured: false,
        masked: null,
        createdAt: null,
        rotatedAt: null,
        updatedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastErrorCode: null,
        lastDeliveryCount: null,
        lastChunkCount: null,
        status: "not_configured",
      });
      assert.equal(repository.has(ASR_SETTING_KEY), false);
      assert.throws(() => repository.metadata("icost_webhook_token"), /Unknown secure setting/u);
    } finally {
      db.close();
    }
  });

  it("sets and replaces ASR ciphertext while preserving creation and recording rotation", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const times = [
      new Date("2026-08-30T01:02:03.000Z"),
      new Date("2026-08-30T02:03:04.000Z"),
    ];
    let index = 0;
    try {
      const repository = createSecureSettingsRepository(db, {
        masterKey: encryptionKey,
        clock: () => times[index++],
      });
      const firstValue = "synthetic-asr-key-first";
      const secondValue = "synthetic-asr-key-second";

      const first = repository.setSecret(ASR_SETTING_KEY, firstValue);
      const firstRow = { ...db.prepare(
        "SELECT * FROM secure_settings WHERE setting_key = $key",
      ).get({ $key: ASR_SETTING_KEY }) };
      assert.equal(first.createdAt, times[0].toISOString());
      assert.equal(first.rotatedAt, null);
      assert.notEqual(firstRow.ciphertext, firstValue);
      assert.doesNotMatch(firstRow.ciphertext, new RegExp(firstValue, "u"));
      assert.equal(repository.readSecret(ASR_SETTING_KEY), firstValue);

      const replaced = repository.setSecret(ASR_SETTING_KEY, secondValue);
      const replacedRow = { ...db.prepare(
        "SELECT * FROM secure_settings WHERE setting_key = $key",
      ).get({ $key: ASR_SETTING_KEY }) };
      assert.equal(replaced.createdAt, times[0].toISOString());
      assert.equal(replaced.rotatedAt, times[1].toISOString());
      assert.equal(replaced.updatedAt, times[1].toISOString());
      assert.notEqual(replacedRow.ciphertext, firstRow.ciphertext);
      assert.doesNotMatch(replacedRow.ciphertext, new RegExp(secondValue, "u"));
      assert.equal(repository.readSecret(ASR_SETTING_KEY), secondValue);
    } finally {
      db.close();
    }
  });

  it("clears ASR and suppresses every caller-provided fallback", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const repository = createSecureSettingsRepository(db, { masterKey: encryptionKey });
      repository.setSecret(ASR_SETTING_KEY, "synthetic-asr-key-to-clear");
      const cleared = repository.clearSecret(ASR_SETTING_KEY);
      assert.equal(cleared.configured, false);
      assert.equal(cleared.status, "cleared");
      assert.equal(cleared.masked, null);
      assert.equal(repository.readSecret(ASR_SETTING_KEY), null);
      assert.equal(repository.resolveSecret(ASR_SETTING_KEY, "synthetic-forbidden-fallback"), "");
      const row = db.prepare(
        "SELECT ciphertext, status FROM secure_settings WHERE setting_key = $key",
      ).get({ $key: ASR_SETTING_KEY });
      assert.deepEqual({ ...row }, { ciphertext: null, status: "cleared" });
    } finally {
      db.close();
    }
  });

  it("fails closed for unknown keys on every repository read and mutation plane", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const repository = createSecureSettingsRepository(db, { masterKey: encryptionKey });
      const unknown = "unknown_provider_api_key";
      for (const operation of [
        () => repository.readSecret(unknown),
        () => repository.resolveSecret(unknown, "fallback"),
        () => repository.metadata(unknown),
        () => repository.has(unknown),
        () => repository.setSecret(unknown, "synthetic-value"),
        () => repository.clearSecret(unknown),
      ]) {
        assert.throws(operation, /Unknown secure setting/u);
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM secure_settings").get().count, 0);
    } finally {
      db.close();
    }
  });

  it("masks every short-secret boundary without reconstructing plaintext and preserves long provider masks", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const repository = createSecureSettingsRepository(db, { masterKey: encryptionKey });
      const boundaries = [
        ["甲", "••••••"],
        ["乙丙", "••••••"],
        ["丁戊己", "••••••"],
        ["庚辛壬癸", "••••••"],
        ["子丑寅卯辰", "子••••••辰"],
        ["巳午未申酉戌亥乾", "巳••••••乾"],
        ["坤震巽坎离艮兑天地", "坤震巽坎••••••艮兑天地"],
      ];
      assert.deepEqual(boundaries.map(([value]) => value.length), [1, 2, 3, 4, 5, 8, 9]);
      for (const [value, expectedMask] of boundaries) {
        assert.equal(maskSecret(value), expectedMask);
        const metadata = repository.setSecret(ASR_SETTING_KEY, value);
        assert.equal(metadata.masked, expectedMask);
        assert.notEqual(metadata.masked.replaceAll("•", ""), value);
        assert.equal(repository.readSecret(ASR_SETTING_KEY), value);
      }

      for (const [key, value, expectedMask] of [
        [DEEPSEEK_SETTING_KEY, "deepseek-provider-value", "deep••••••alue"],
      ]) {
        assert.equal(maskSecret(value), expectedMask);
        assert.equal(repository.setSecret(key, value).masked, expectedMask);
      }
    } finally {
      db.close();
    }
  });
});

describe("secure system settings API", () => {
  it("requires a user session even when the legacy global API auth switch is off", async () => {
    await startServer({ authRequired: false });
    const result = await request("/api/settings/security");
    assert.equal(result.response.status, 401);
  });

  it("requires an encryption key before exposing persisted settings", async () => {
    await startServer({ settingsEncryptionKey: "" });
    const auth = await login();
    const result = await request("/api/settings/security", { headers: { Cookie: auth.cookie } });
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error.code, "SECURE_SETTINGS_NOT_CONFIGURED");
  });

  it("reports active environment fallbacks without exposing their values", async () => {
    const environmentFallbacks = {
      deepseek: ["environment", "deepseek", "key"].join("-"),
    };
    await startServer({
      modelApiKey: environmentFallbacks.deepseek,
    });
    const auth = await login();
    const listed = await request("/api/settings/security", {
      headers: { Cookie: auth.cookie },
    });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.response.headers.get("cache-control"), "no-store");
    assert.equal(Object.hasOwn(listed.body.item, "icost"), false);
    assert.equal(listed.body.item.deepseek.source, "environment");
    assert.equal(listed.body.item.deepseek.configured, true);
    assert.equal(JSON.stringify(listed.body).includes(environmentFallbacks.deepseek), false);
  });

  it("never returns a DeepSeek key and requires explicit confirmation to clear it", async () => {
    await startServer();
    const auth = await login();
    const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf };
    const fixtureValue = "synthetic-deepseek-key";

    const saved = await request("/api/settings/deepseek-key", {
      method: "PUT",
      headers,
      body: JSON.stringify({ [apiKeyField]: fixtureValue }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(JSON.stringify(saved.body), new RegExp(fixtureValue));
    assert.equal(saved.body.item.configured, true);
    assert.equal(saved.body.item.masked.includes(fixtureValue), false);

    const missingConfirmation = await request("/api/settings/deepseek-key", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ confirmation: "no" }),
    });
    assert.equal(missingConfirmation.response.status, 428);

    const cleared = await request("/api/settings/deepseek-key", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ confirmation: "CLEAR" }),
    });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.response.headers.get("cache-control"), "no-store");
    assert.equal(cleared.body.item.configured, false);

    const listed = await request("/api/settings/security", { headers: { Cookie: auth.cookie } });
    assert.equal(listed.body.item.deepseek.status, "cleared");
  });

  it("keeps a historical PushPlus row untouched while removing metadata, mutation, test, and outbound paths", async () => {
    const outboundCalls = [];
    const retiredEnvironmentValue = ["retired", "environment", "value"].join("-");
    const retiredCiphertext = ["retired", "ciphertext"].join("-");
    const retiredTokenBody = JSON.stringify({ [["to", "ken"].join("")]: ["replacement"].join("") });
    await startServer({
      [["hospital", "Tender", "Pushplus", "Token"].join("")]: retiredEnvironmentValue,
      fetchImpl: async (...args) => {
        outboundCalls.push(args);
        throw new Error("retired notification transport must not run");
      },
    });
    const db = createConnection({ databaseUrl });
    try {
      db.prepare(`
        INSERT INTO secure_settings (
          setting_key, ciphertext, status, created_at, rotated_at, updated_at,
          last_success_at, last_failure_at, last_error_code,
          last_delivery_count, last_chunk_count
        ) VALUES (
          'hospital_tender_pushplus_token', '${retiredCiphertext}', 'active',
          '2026-08-20T00:00:00.000Z', NULL, '2026-08-20T00:00:00.000Z',
          NULL, NULL, NULL, NULL, NULL
        )
      `).run();
    } finally {
      db.close();
    }
    const auth = await login();
    const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf };

    const listed = await request("/api/settings/security", { headers: { Cookie: auth.cookie } });
    assert.equal(listed.response.status, 200);
    assert.deepEqual(Object.keys(listed.body.item), ["deepseek", "asr"]);
    assert.equal(Object.hasOwn(listed.body.item, "pushplus"), false);
    assert.doesNotMatch(JSON.stringify(listed.body), new RegExp(`${retiredCiphertext}|${retiredEnvironmentValue}`, "u"));

    for (const [method, path, body] of [
      ["PUT", "/api/settings/pushplus-token", retiredTokenBody],
      ["POST", "/api/settings/pushplus", retiredTokenBody],
      ["DELETE", "/api/settings/pushplus-token", JSON.stringify({ confirmation: "CLEAR" })],
      ["POST", "/api/settings/pushplus/test", "{}"],
    ]) {
      const result = await request(path, { method, headers, body });
      assert.equal(result.response.status, 404, `${method} ${path}`);
      assert.equal(result.body.error.code, "NOT_FOUND", `${method} ${path}`);
    }

    const verify = createConnection({ databaseUrl });
    try {
      const row = verify.prepare(`
        SELECT setting_key, ciphertext, status, updated_at
        FROM secure_settings
        WHERE setting_key = 'hospital_tender_pushplus_token'
      `).get();
      assert.deepEqual({ ...row }, {
        setting_key: "hospital_tender_pushplus_token",
        ciphertext: retiredCiphertext,
        status: "active",
        updated_at: "2026-08-20T00:00:00.000Z",
      });
    } finally {
      verify.close();
    }
    assert.equal(outboundCalls.length, 0);
  });

  it("lets only an active admin read ASR metadata and never invents an environment fallback", async () => {
    const ignoredFallback = "synthetic-asr-environment-fallback";
    await startServer({ asrApiKey: ignoredFallback });
    const auth = await login();
    const listed = await request("/api/settings/security", {
      headers: { Cookie: auth.cookie },
    });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(listed.body.item.asr, {
      configured: false,
      masked: null,
      createdAt: null,
      rotatedAt: null,
      updatedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      lastDeliveryCount: null,
      lastChunkCount: null,
      status: "not_configured",
      source: "none",
      fallbackSuppressed: false,
    });
    assert.doesNotMatch(JSON.stringify(listed.body), new RegExp(ignoredFallback, "u"));
    assert.deepEqual(Object.keys(listed.body.item.asr).sort(), [
      "configured",
      "createdAt",
      "fallbackSuppressed",
      "lastChunkCount",
      "lastDeliveryCount",
      "lastErrorCode",
      "lastFailureAt",
      "lastSuccessAt",
      "masked",
      "rotatedAt",
      "source",
      "status",
      "updatedAt",
    ]);
  });

  it("sets and replaces ASR through repeated PUT while POST remains absent", async () => {
    let currentTime = new Date("2026-08-30T03:04:05.000Z");
    await startServer({ settingsClock: () => currentTime });
    const auth = await login();
    const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf };
    const firstValue = "synthetic-asr-http-first";
    const secondValue = "synthetic-asr-http-second";
    const consoleLines = [];
    const originals = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    console.log = (...values) => consoleLines.push(values.join(" "));
    console.warn = (...values) => consoleLines.push(values.join(" "));
    console.error = (...values) => consoleLines.push(values.join(" "));
    try {
      const saved = await request("/api/settings/asr-api-key", {
        method: "PUT",
        headers,
        body: JSON.stringify({ [apiKeyField]: firstValue }),
      });
      assert.equal(saved.response.status, 200);
      assert.equal(saved.response.headers.get("cache-control"), "no-store");
      assert.equal(saved.body.item.configured, true);
      assert.equal(saved.body.item.rotatedAt, null);
      assert.doesNotMatch(JSON.stringify(saved.body), new RegExp(firstValue, "u"));

      currentTime = new Date("2026-08-30T04:05:06.000Z");
      const replaced = await request("/api/settings/asr-api-key", {
        method: "PUT",
        headers,
        body: JSON.stringify({ [apiKeyField]: secondValue }),
      });
      assert.equal(replaced.response.status, 200);
      assert.equal(replaced.body.item.rotatedAt, currentTime.toISOString());
      assert.doesNotMatch(JSON.stringify(replaced.body), new RegExp(secondValue, "u"));

      const postProbe = await request("/api/settings/asr-api-key", {
        method: "POST",
        headers,
        body: JSON.stringify({ [apiKeyField]: "synthetic-asr-post-probe" }),
      });
      assert.equal(postProbe.response.status, 404);
      assert.equal(postProbe.body.error.code, "NOT_FOUND");
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }

    const state = readSettingsState();
    assert.equal(state.asr.status, "active");
    assert.notEqual(state.asr.ciphertext, firstValue);
    assert.notEqual(state.asr.ciphertext, secondValue);
    assert.doesNotMatch(state.asr.ciphertext, new RegExp(`${firstValue}|${secondValue}`, "u"));
    assert.deepEqual(state.audit.map((row) => row.action), [
      "settings.asr_api_key.save",
      "settings.asr_api_key.save",
    ]);
    const persistedDump = JSON.stringify(state);
    const consoleDump = consoleLines.join("\n");
    for (const value of [firstValue, secondValue]) {
      assert.doesNotMatch(persistedDump, new RegExp(value, "u"));
      assert.doesNotMatch(consoleDump, new RegExp(value, "u"));
    }
    for (const audit of state.audit) {
      assert.equal(audit.actor, account);
      assert.equal(audit.entity_type, "secure_setting");
      assert.equal(audit.entity_id, ASR_SETTING_KEY);
      assert.deepEqual(JSON.parse(audit.metadata_json), { setting: ASR_SETTING_KEY });
      assert.deepEqual(Object.keys(JSON.parse(audit.after_json)).sort(), ["masked", "status", "updatedAt"]);
    }
  });

  it("keeps length 1, 2, 3, 4, 5, 8, and 9 ASR values out of response, audit, storage, and console", async () => {
    await startServer();
    const auth = await login();
    const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf };
    const values = [
      "甲",
      "乙丙",
      "丁戊己",
      "庚辛壬癸",
      "子丑寅卯辰",
      "巳午未申酉戌亥乾",
      "坤震巽坎离艮兑天地",
    ];
    assert.deepEqual(values.map((value) => value.length), [1, 2, 3, 4, 5, 8, 9]);
    const consoleLines = [];
    const originals = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    console.log = (...parts) => consoleLines.push(parts.join(" "));
    console.warn = (...parts) => consoleLines.push(parts.join(" "));
    console.error = (...parts) => consoleLines.push(parts.join(" "));
    try {
      for (const value of values) {
        const saved = await request("/api/settings/asr-api-key", {
          method: "PUT",
          headers,
          body: JSON.stringify({ [apiKeyField]: value }),
        });
        assert.equal(saved.response.status, 200, `length ${value.length}`);
        assert.equal(saved.body.item.configured, true);
        assert.notEqual(saved.body.item.masked.replaceAll("•", ""), value);
        assert.equal(JSON.stringify(saved.body).includes(value), false);
        const state = readSettingsState();
        assert.equal(JSON.stringify(state).includes(value), false);
      }
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }
    const state = readSettingsState();
    assert.equal(state.audit.length, values.length);
    assert.equal(state.audit.every((row) => row.action === "settings.asr_api_key.save"), true);
    for (const value of values) {
      assert.equal(JSON.stringify(state.audit).includes(value), false);
      assert.equal(consoleLines.join("\n").includes(value), false);
    }
  });

  it("requires CLEAR before deleting ASR and persists an explicit cleared state", async () => {
    await startServer();
    const auth = await login();
    const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf };
    const fixtureValue = "synthetic-asr-clear-value";
    const saved = await request("/api/settings/asr-api-key", {
      method: "PUT",
      headers,
      body: JSON.stringify({ [apiKeyField]: fixtureValue }),
    });
    assert.equal(saved.response.status, 200);

    const missing = await request("/api/settings/asr-api-key", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ confirmation: "clear" }),
    });
    assert.equal(missing.response.status, 428);
    assert.equal(missing.body.error.code, "CONFIRMATION_REQUIRED");
    assert.equal(readSettingsState().asr.status, "active");

    const cleared = await request("/api/settings/asr-api-key", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ confirmation: "CLEAR" }),
    });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.body.item.configured, false);
    assert.equal(cleared.body.item.status, "cleared");
    assert.doesNotMatch(JSON.stringify(cleared.body), new RegExp(fixtureValue, "u"));
    const state = readSettingsState();
    assert.equal(state.asr.ciphertext, null);
    assert.equal(state.asr.status, "cleared");
    assert.deepEqual(state.audit.map((row) => row.action), [
      "settings.asr_api_key.save",
      "settings.asr_api_key.clear",
    ]);
    assert.deepEqual(JSON.parse(state.audit.at(-1).metadata_json), {
      setting: ASR_SETTING_KEY,
      confirmation: "provided",
    });
  });

  it("rejects unauthenticated GET, PUT, and DELETE before ASR storage or audit changes", async () => {
    await startServer();
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", JSON.stringify({ [apiKeyField]: "synthetic-unauthenticated-asr" })],
      ["DELETE", JSON.stringify({ confirmation: "CLEAR" })],
    ]) {
      const path = method === "GET" ? "/api/settings/security" : "/api/settings/asr-api-key";
      const denied = await request(path, { method, body });
      assert.equal(denied.response.status, 401, method);
      assert.equal(denied.body.error.code, "UNAUTHORIZED", method);
    }
    assert.deepEqual(readSettingsState(), { asr: null, audit: [] });
  });

  it("rejects active members on GET, PUT, and DELETE with the admin-role gate", async () => {
    await startServer();
    const auth = await login();
    const db = createConnection({ databaseUrl });
    try {
      db.prepare("UPDATE users SET role = 'member' WHERE account = $account").run({ $account: account });
    } finally {
      db.close();
    }
    const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf };
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", JSON.stringify({ [apiKeyField]: "synthetic-member-asr" })],
      ["DELETE", JSON.stringify({ confirmation: "CLEAR" })],
    ]) {
      const path = method === "GET" ? "/api/settings/security" : "/api/settings/asr-api-key";
      const denied = await request(path, { method, headers, body });
      assert.equal(denied.response.status, 403, method);
      assert.equal(denied.body.error.code, "ADMIN_ROLE_REQUIRED", method);
    }
    assert.deepEqual(readSettingsState(), { asr: null, audit: [] });
  });

  it("keeps machine tokens outside GET, PUT, and DELETE on the ASR admin plane", async () => {
    const machineToken = ["synthetic", "asr", "machine", "token"].join("-");
    await startServer({ weixinAgentApiToken: machineToken, weixinAgentOwner: account });
    const headers = { Authorization: `Bearer ${machineToken}` };
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", JSON.stringify({ [apiKeyField]: "synthetic-machine-asr" })],
      ["DELETE", JSON.stringify({ confirmation: "CLEAR" })],
    ]) {
      const path = method === "GET" ? "/api/settings/security" : "/api/settings/asr-api-key";
      const denied = await request(path, { method, headers, body });
      assert.equal(denied.response.status, 403, method);
      assert.equal(denied.body.error.code, "MACHINE_SCOPE_DENIED", method);
    }
    assert.deepEqual(readSettingsState(), { asr: null, audit: [] });
  });

  it("allows the ASR PUT browser preflight only for an exact configured Origin without writing state", async () => {
    const allowedOrigin = "https://settings.example.test";
    await startServer({ corsAllowedOrigins: [allowedOrigin] });
    const allowed = await request("/api/settings/asr-api-key", {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "Content-Type,X-CSRF-Token",
      },
    });
    assert.equal(allowed.response.status, 204);
    assert.equal(allowed.response.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.equal(allowed.response.headers.get("access-control-allow-credentials"), "true");
    assert.equal(
      allowed.response.headers.get("access-control-allow-methods"),
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    assert.match(
      allowed.response.headers.get("access-control-allow-headers"),
      /(?:^|,)X-CSRF-Token(?:,|$)/u,
    );
    assert.deepEqual(readSettingsState(), { asr: null, audit: [] });

    const forbidden = await request("/api/settings/asr-api-key", {
      method: "OPTIONS",
      headers: {
        Origin: "https://forbidden.example.test",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "Content-Type,X-CSRF-Token",
      },
    });
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.body.error.code, "ORIGIN_NOT_ALLOWED");
    assert.deepEqual(readSettingsState(), { asr: null, audit: [] });
  });

  it("leaves the ASR row and audit unchanged after bad CSRF and bad Origin attempts", async () => {
    const allowedOrigin = "https://settings.example.test";
    await startServer({ corsAllowedOrigins: [allowedOrigin] });
    const auth = await login();
    const fixtureValue = "synthetic-asr-csrf-origin-value";
    const goodHeaders = {
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrf,
      Origin: allowedOrigin,
    };
    const saved = await request("/api/settings/asr-api-key", {
      method: "PUT",
      headers: goodHeaders,
      body: JSON.stringify({ [apiKeyField]: fixtureValue }),
    });
    assert.equal(saved.response.status, 200);
    const before = readSettingsState();

    const badCsrf = await request("/api/settings/asr-api-key", {
      method: "PUT",
      headers: { ...goodHeaders, "X-CSRF-Token": "invalid-csrf-token" },
      body: JSON.stringify({ [apiKeyField]: "synthetic-asr-bad-csrf" }),
    });
    assert.equal(badCsrf.response.status, 403);
    assert.equal(badCsrf.body.error.code, "CSRF_INVALID");

    const badOrigin = await request("/api/settings/asr-api-key", {
      method: "DELETE",
      headers: { ...goodHeaders, Origin: "https://forbidden.example.test" },
      body: JSON.stringify({ confirmation: "CLEAR" }),
    });
    assert.equal(badOrigin.response.status, 403);
    assert.equal(badOrigin.body.error.code, "ORIGIN_NOT_ALLOWED");
    assert.deepEqual(readSettingsState(), before);
  });

  it("returns fixed non-leaking errors for unavailable storage and invalid or oversized ASR payloads", async () => {
    await startServer({ settingsEncryptionKey: "" });
    const auth = await login();
    const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf };
    const validSecret = ["synthetic", "asr", "storage", "unavailable"].join("-");
    const unavailable = await request("/api/settings/asr-api-key", {
      method: "PUT",
      headers,
      body: JSON.stringify({ [apiKeyField]: validSecret }),
    });
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.error.code, "SECURE_SETTINGS_NOT_CONFIGURED");

    const invalid = await request("/api/settings/asr-api-key", {
      method: "PUT",
      headers,
      body: JSON.stringify({ [apiKeyField]: 42 }),
    });
    assert.equal(invalid.response.status, 422);
    assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(invalid.body.error.fields, { [apiKeyField]: "format" });

    const oversizedValue = `asr-${"x".repeat(497)}`;
    assert.equal(oversizedValue.length, 501);
    const oversized = await request("/api/settings/asr-api-key", {
      method: "PUT",
      headers,
      body: JSON.stringify({ [apiKeyField]: oversizedValue }),
    });
    assert.equal(oversized.response.status, 422);
    assert.equal(oversized.body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(oversized.body.error.fields, { [apiKeyField]: "format" });

    const responseDump = JSON.stringify([unavailable.body, invalid.body, oversized.body]);
    for (const value of [validSecret, oversizedValue]) {
      assert.doesNotMatch(responseDump, new RegExp(value, "u"));
    }
    assert.deepEqual(readSettingsState(), { asr: null, audit: [] });
  });
});
