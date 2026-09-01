import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { openDatabase } from "../src/db.js";
import { createServer as createCurrentServer } from "../src/server.js";
import {
  ASR_SETTING_KEY,
  createSecureSettingsRepository,
} from "../src/settings/repository.js";

const V0103_RELEASE_COMMIT = "2dc9b1114107aee906d0ecfb006ac461cdb86cec";
const currentBackend = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(currentBackend);
const currentNodeModules = join(currentBackend, "node_modules");
const apiKeyField = ["api", "Key"].join("");
const secureSettingsColumns = [
  "setting_key",
  "ciphertext",
  "status",
  "created_at",
  "rotated_at",
  "updated_at",
  "last_success_at",
  "last_failure_at",
  "last_error_code",
  "last_delivery_count",
  "last_chunk_count",
];

function rowHash(row) {
  return createHash("sha256").update(JSON.stringify(row), "utf8").digest("hex");
}

function asrPersistenceSnapshot(databaseUrl) {
  const db = createConnection({ databaseUrl });
  try {
    const asr = db.prepare(`
      SELECT ${secureSettingsColumns.join(", ")}
      FROM secure_settings
      WHERE setting_key = $key
    `).get({ $key: ASR_SETTING_KEY });
    const ledger = db.prepare(`
      SELECT version, checksum, applied_at
      FROM schema_migrations
      WHERE version = '0033'
    `).get();
    assert.ok(asr, "the current ASR row must exist");
    assert.ok(ledger, "the 0033 ledger row must exist");
    return {
      asr: { ...asr },
      ledger: { ...ledger },
      asrHash: rowHash({ ...asr }),
      ledgerHash: rowHash({ ...ledger }),
    };
  } finally {
    db.close();
  }
}

async function request(baseUrl, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, text };
}

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function login(baseUrl, account, password) {
  const loggedIn = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  });
  assert.equal(loggedIn.response.status, 200);
  return {
    cookie: cookiePair(loggedIn.response),
    csrf: loggedIn.body.csrfToken,
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function materializeV0103Backend(tempRoot) {
  const resolved = spawnSync(
    "git",
    ["rev-parse", `${V0103_RELEASE_COMMIT}^{commit}`],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), V0103_RELEASE_COMMIT);

  const archivePath = join(tempRoot, "v0103-backend.tar");
  const archived = spawnSync(
    "git",
    ["archive", "--format=tar", `--output=${archivePath}`, V0103_RELEASE_COMMIT, "backend"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync(
    "tar",
    ["-xf", archivePath, "-C", tempRoot],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(extracted.status, 0, extracted.stderr);
  return join(tempRoot, "backend");
}

async function exactV0103Database(oldBackend, databaseUrl) {
  const oldDbUrl = pathToFileURL(join(oldBackend, "src", "db.js"));
  oldDbUrl.searchParams.set("release", V0103_RELEASE_COMMIT);
  const oldDbModule = await import(oldDbUrl.href);
  const environmentKeys = [
    "AUTH_ACCOUNT",
    "AUTH_PASSWORD_HASH",
    "WEIXIN_BOOKKEEPING_SENDER_ID",
    "WEIXIN_BOOKKEEPING_OWNER",
  ];
  const savedEnvironment = new Map(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of environmentKeys) delete process.env[key];
  try {
    const db = oldDbModule.openDatabase({ databaseUrl });
    try {
      const versions = db.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all().map((row) => row.version);
      assert.equal(versions.length, 31);
      assert.equal(versions.at(-1), "0032");
      assert.deepEqual(
        db.prepare("PRAGMA table_info(secure_settings)").all().map((column) => column.name),
        secureSettingsColumns,
      );
    } finally {
      db.close();
    }
  } finally {
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("exact v0.10.3 remains forward-compatible with a current 0036 database", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sentelligent-v0103-forward-"));
  const databaseUrl = join(tempRoot, "forward.sqlite");
  const account = "forwardadmin";
  const password = ["synthetic", "forward", "password"].join("-");
  const passwordHash = await hashPassword(password, { salt: Buffer.alloc(16, 103) });
  const authSessionSecret = Buffer.alloc(32, 104).toString("base64url");
  const settingsEncryptionKey = Buffer.alloc(32, 105).toString("base64url");
  const asrValue = "synthetic-forward-asr-value";
  const currentOptions = {
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret,
    authCookieSecure: false,
    corsAllowedOrigins: [],
    settingsEncryptionKey,
    aiAnalysisMode: "mock",
    hospitalTenderAutoRun: false,
    actionReminderAutoRun: false,
    dailyDigestAutoRun: false,
  };
  let currentServer = null;
  let oldServer = null;

  try {
    const oldBackend = materializeV0103Backend(tempRoot);
    assert.equal(existsSync(join(oldBackend, "src", "server.js")), true);
    assert.equal(existsSync(currentNodeModules), true);
    await symlink(currentNodeModules, join(oldBackend, "node_modules"), "dir");

    // Phase 1: exact release code creates a real, complete 0032 database.
    await exactV0103Database(oldBackend, databaseUrl);

    // Phase 2: current code upgrades the exact 0032 database through 0033, 0034, 0035, and 0036, then its repository/API writes the new ASR key and an owner-scoped
    // customer fixture.
    const upgraded = openDatabase({ databaseUrl });
    try {
      const versions = upgraded.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all().map((row) => row.version);
      assert.equal(versions.length, 35);
      assert.deepEqual(versions.slice(-4), ["0033", "0034", "0035", "0036"]);
    } finally {
      upgraded.close();
    }

    currentServer = createCurrentServer(currentOptions);
    const currentBaseUrl = await listen(currentServer);
    const currentAuth = await login(currentBaseUrl, account, password);
    const currentWriteHeaders = {
      Cookie: currentAuth.cookie,
      "X-CSRF-Token": currentAuth.csrf,
    };
    const savedAsr = await request(currentBaseUrl, "/api/settings/asr-api-key", {
      method: "PUT",
      headers: currentWriteHeaders,
      body: JSON.stringify({ [apiKeyField]: asrValue }),
    });
    assert.equal(savedAsr.response.status, 200);
    assert.equal(savedAsr.body.item.configured, true);
    assert.doesNotMatch(JSON.stringify(savedAsr.body), new RegExp(asrValue, "u"));

    const customerName = "V0103前向兼容医院";
    const createdCustomer = await request(currentBaseUrl, "/api/customers", {
      method: "POST",
      headers: currentWriteHeaders,
      body: JSON.stringify({
        name: customerName,
        region: "兼容测试区",
        summary: "exact v0.10.3 forward compatibility fixture",
      }),
    });
    assert.equal(createdCustomer.response.status, 201);
    await close(currentServer);
    currentServer = null;

    const beforeOldCode = asrPersistenceSnapshot(databaseUrl);

    // Phase 3: boot exact release code against the 0036 database and exercise
    // its established read/write planes. The release has no ASR route.
    const oldServerUrl = pathToFileURL(join(oldBackend, "src", "server.js"));
    oldServerUrl.searchParams.set("release", V0103_RELEASE_COMMIT);
    const { createServer: createOldServer } = await import(oldServerUrl.href);
    oldServer = createOldServer(currentOptions);
    const oldBaseUrl = await listen(oldServer);

    const health = await request(oldBaseUrl, "/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(health.body.database, "ready");

    const oldAuth = await login(oldBaseUrl, account, password);
    const oldWriteHeaders = {
      Cookie: oldAuth.cookie,
      "X-CSRF-Token": oldAuth.csrf,
    };
    const session = await request(oldBaseUrl, "/api/auth/session", {
      headers: { Cookie: oldAuth.cookie },
    });
    assert.equal(session.response.status, 200);
    assert.equal(session.body.account, account);
    assert.equal(session.body.role, "admin");

    const oldSettings = await request(oldBaseUrl, "/api/settings/security", {
      headers: { Cookie: oldAuth.cookie },
    });
    assert.equal(oldSettings.response.status, 200);
    assert.equal(Object.hasOwn(oldSettings.body.item, "deepseek"), true);
    assert.equal(Object.hasOwn(oldSettings.body.item, "pushplus"), true);
    assert.equal(Object.hasOwn(oldSettings.body.item, "asr"), false);

    const oldDeepseekValue = "synthetic-v0103-deepseek-value";
    const oldDeepseek = await request(oldBaseUrl, "/api/settings/deepseek-key", {
      method: "PUT",
      headers: oldWriteHeaders,
      body: JSON.stringify({ [apiKeyField]: oldDeepseekValue }),
    });
    assert.equal(oldDeepseek.response.status, 200);
    assert.equal(oldDeepseek.body.item.configured, true);
    assert.doesNotMatch(JSON.stringify(oldDeepseek.body), new RegExp(oldDeepseekValue, "u"));

    const oldPushplusValue = "synthetic-v0103-pushplus-value";
    const oldPushplus = await request(oldBaseUrl, "/api/settings/pushplus-token", {
      method: "PUT",
      headers: oldWriteHeaders,
      body: JSON.stringify({ token: oldPushplusValue }),
    });
    assert.equal(oldPushplus.response.status, 200);
    assert.equal(oldPushplus.body.item.configured, true);
    assert.doesNotMatch(JSON.stringify(oldPushplus.body), new RegExp(oldPushplusValue, "u"));

    const quickRecord = await request(oldBaseUrl, "/api/quick-records", {
      method: "POST",
      headers: oldWriteHeaders,
      body: JSON.stringify({
        rawContent: "周三现场拜访日照中医医院，客户需要十五五规划材料。",
        occurredAt: "2026-08-26T09:00:00+08:00",
        sourceChannel: "forward-compat-test",
      }),
    });
    assert.equal(quickRecord.response.status, 201);
    const analyzed = await request(
      oldBaseUrl,
      `/api/quick-records/${quickRecord.body.item.id}/analyze`,
      { method: "POST", headers: oldWriteHeaders, body: "{}" },
    );
    assert.equal(analyzed.response.status, 201);
    assert.equal(analyzed.body.item.source, "mock");

    const help = await request(oldBaseUrl, "/api/assistant/chat", {
      method: "POST",
      headers: oldWriteHeaders,
      body: JSON.stringify({
        message: "帮助",
        conversationId: "v0103-forward-help",
      }),
    });
    assert.equal(help.response.status, 200);
    assert.equal(help.body.status, "help");

    const customerQuery = await request(oldBaseUrl, "/api/assistant/chat", {
      method: "POST",
      headers: oldWriteHeaders,
      body: JSON.stringify({
        message: `客户 ${customerName}`,
        conversationId: "v0103-forward-customer",
      }),
    });
    assert.equal(customerQuery.response.status, 200);
    assert.equal(customerQuery.body.status, "ok");
    assert.match(JSON.stringify(customerQuery.body), new RegExp(customerName, "u"));

    const absentAsrRoute = await request(oldBaseUrl, "/api/settings/asr-api-key", {
      method: "PUT",
      headers: oldWriteHeaders,
      body: JSON.stringify({ [apiKeyField]: "synthetic-v0103-route-probe" }),
    });
    assert.equal(absentAsrRoute.response.status, 404);
    assert.equal(absentAsrRoute.body.error.code, "NOT_FOUND");

    await close(oldServer);
    oldServer = null;

    const afterOldCode = asrPersistenceSnapshot(databaseUrl);
    assert.equal(afterOldCode.asrHash, beforeOldCode.asrHash);
    assert.equal(afterOldCode.ledgerHash, beforeOldCode.ledgerHash);
    assert.deepEqual(afterOldCode.asr, beforeOldCode.asr);
    assert.deepEqual(afterOldCode.ledger, beforeOldCode.ledger);

    // Phase 4: current code reopens the old-touched file, resolves ASR metadata,
    // verifies the exact persisted secret, and passes SQLite integrity checks.
    const reopened = openDatabase({ databaseUrl });
    try {
      const repository = createSecureSettingsRepository(reopened, {
        masterKey: settingsEncryptionKey,
      });
      const metadata = repository.listMetadata().asr;
      assert.equal(metadata.configured, true);
      assert.equal(metadata.status, "active");
      assert.equal(metadata.masked.includes(asrValue), false);
      assert.equal(repository.readSecret(ASR_SETTING_KEY), asrValue);
      assert.deepEqual(
        reopened.prepare("PRAGMA quick_check").all().map((row) => row.quick_check),
        ["ok"],
      );
      assert.equal(
        reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count,
        35,
      );
      assert.ok(reopened.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'quick_record_confirmation_previews'
      `).get());
    } finally {
      reopened.close();
    }
  } finally {
    await close(oldServer);
    await close(currentServer);
    await rm(tempRoot, { recursive: true, force: true });
    assert.equal(existsSync(tempRoot), false);
  }
});
