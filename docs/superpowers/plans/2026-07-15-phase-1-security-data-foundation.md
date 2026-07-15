# Phase 1 Security And Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current fail-open, stateless MVP foundation with versioned SQLite migrations, server-side cookie sessions, CSRF and origin protection, transactional and idempotent writes, optimistic concurrency, soft deletion, and verifiable backup/restore behavior without changing the visible business workflow.

**Architecture:** Keep `backend/src/server.js` as a single controller-owned integration point during Phase 1. New authentication, HTTP, database, idempotency, and audit behavior lives in focused modules with explicit public functions. Existing entity and route behavior remains available through compatibility facades until the later monolith split.

**Tech Stack:** Node.js 24+, `node:http`, `node:sqlite`, built-in `crypto`, React 19, Vite, Node test runner, existing CDP integration QA.

---

## File Ownership

Controller-only integration files:

- `backend/src/server.js`
- `backend/src/config.js`
- `backend/src/db.js`
- `backend/src/schema.sql`
- `shared/salesWorkbenchApiContract.mjs`
- `outputs/product-design-prototype/src/App.jsx`
- root and package-level `package.json`

Worker-owned new modules:

```text
backend/src/db/connection.js
backend/src/db/migrate.js
backend/src/db/transaction.js
backend/src/db/migrations/0001_baseline.sql
backend/src/db/migrations/0002_phase1_write_integrity.mjs
backend/src/auth/password.js
backend/src/auth/session.js
backend/src/auth/machineAuthorization.js
backend/src/auth/loginRateLimit.js
backend/src/http/errors.js
backend/src/http/request.js
backend/src/http/response.js
backend/src/http/security.js
backend/src/validation/requests.js
backend/src/services/idempotency.js
backend/src/audit/auditRepository.js
backend/scripts/hash-password.mjs
backend/scripts/db-check.mjs
```

Test files are owned by the task that creates them. No two workers edit the same existing file concurrently.

## Specification Coverage

This plan implements the approved design specification sections for backend boundaries, database and migrations, API safety, authentication, DeepSeek-adjacent transport protection, error recovery, security and Phase 1 release evidence. It intentionally does not change the approved Apple visual layout, entity page state machines, voice transcription, AI prompt behavior or WeChat persistence. Those remain required and receive separate plans after this completion gate.

## Task 1: Versioned Migration Engine And SQLite Connection

**Files:**

- Create: `backend/src/db/connection.js`
- Create: `backend/src/db/migrate.js`
- Create: `backend/src/db/migrations/0001_baseline.sql`
- Create: `backend/tests/db-connection.test.js`
- Create: `backend/tests/migrations.test.js`
- Modify: `backend/src/db.js`

- [ ] **Step 1: Write the failing connection test**

```js
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "../src/db.js";

describe("SQLite connection policy", () => {
  it("enables WAL, foreign keys, normal sync, and a five-second busy timeout", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 1);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test and verify the missing policy fails**

Run:

```powershell
node --test backend/tests/db-connection.test.js
```

Expected: FAIL because `busy_timeout` and `synchronous=NORMAL` are not configured.

- [ ] **Step 3: Implement the connection policy**

```js
// backend/src/db/connection.js
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

export function resolveDatabasePath(databaseUrl = "./data/sales-workbench.sqlite") {
  if (databaseUrl === ":memory:") return databaseUrl;
  if (databaseUrl.startsWith("file:")) return fileURLToPath(databaseUrl);
  return isAbsolute(databaseUrl) ? databaseUrl : resolve(process.cwd(), databaseUrl);
}

export function configureConnection(db) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

export function createConnection(databaseUrl) {
  const databasePath = resolveDatabasePath(databaseUrl);
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  return configureConnection(new DatabaseSync(databasePath));
}
```

For `:memory:` the `journal_mode` result remains `memory`; the test must only assert `wal` for a temporary file database.

- [ ] **Step 4: Write the failing migration checksum tests**

```js
it("records each immutable migration exactly once", () => {
  const db = openDatabase({ databaseUrl });
  const first = db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
  db.close();
  const reopened = openDatabase({ databaseUrl });
  const second = reopened.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(second, first);
  assert.ok(first.some((row) => row.version === "0001"));
  reopened.close();
});
```

Add a second test that inserts a false checksum for `0001` and expects `openDatabase` to throw `Migration checksum mismatch for 0001`.

- [ ] **Step 5: Implement the migration runner**

```js
// backend/src/db/migrate.js
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

function checksum(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function applySqlMigration(db, { version, filename }) {
  const path = resolve(here, "migrations", filename);
  const source = readFileSync(path, "utf8");
  const digest = checksum(source);
  const existing = db.prepare("SELECT checksum FROM schema_migrations WHERE version = ?").get(version);
  if (existing && existing.checksum !== digest) throw new Error(`Migration checksum mismatch for ${version}`);
  if (existing) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(source);
    db.prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
      .run(version, digest, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrateDatabase(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  applySqlMigration(db, { version: "0001", filename: "0001_baseline.sql" });
}
```

Copy the current `schema.sql` content into `0001_baseline.sql`, including the current `assignee`, `due`, and `artifact_type` columns. Keep all statements idempotent so a legacy database can adopt the baseline record without data rewrites.

- [ ] **Step 6: Turn `db.js` into a compatibility facade**

```js
import { createConnection, resolveDatabasePath } from "./db/connection.js";
import { migrateDatabase } from "./db/migrate.js";

export { resolveDatabasePath, migrateDatabase };

export function openDatabase({ databaseUrl } = {}) {
  const db = createConnection(databaseUrl);
  migrateDatabase(db);
  return db;
}

export function run(db, sql, params = {}) { return db.prepare(sql).run(params); }
export function get(db, sql, params = {}) { return db.prepare(sql).get(params); }
export function all(db, sql, params = {}) { return db.prepare(sql).all(params); }
```

- [ ] **Step 7: Run the focused and full backend tests**

Run:

```powershell
node --test backend/tests/db-connection.test.js backend/tests/migrations.test.js
npm --prefix backend test
```

Expected: focused tests PASS and all existing backend tests remain green.

- [ ] **Step 8: Commit**

```powershell
git add backend/src/db.js backend/src/db backend/tests/db-connection.test.js backend/tests/migrations.test.js
git commit -m "feat(db): add versioned sqlite migrations"
```

## Task 2: Phase 1 Schema Additions

**Files:**

- Create: `backend/src/db/migrations/0002_phase1_write_integrity.mjs`
- Modify: `backend/src/db/migrate.js`
- Modify: `backend/tests/migrations.test.js`

- [ ] **Step 1: Add the failing legacy-upgrade test**

Create a legacy database from `0001_baseline.sql`, insert one row into each of the 12 existing business tables, then open it through `openDatabase`. Assert:

```js
assert.equal(columnNames(db, "customers").includes("version"), true);
assert.equal(columnNames(db, "customers").includes("deleted_at"), true);
assert.equal(columnNames(db, "quick_records").includes("voided_at"), true);
assert.equal(columnNames(db, "audit_logs").includes("before_json"), true);
assert.equal(tableNames(db).includes("auth_sessions"), true);
assert.equal(tableNames(db).includes("idempotency_keys"), true);
assert.deepEqual(countsAfter, countsBefore);
```

- [ ] **Step 2: Run the migration test and verify it fails**

Run:

```powershell
node --test backend/tests/migrations.test.js
```

Expected: FAIL because migration `0002` and the new columns/tables do not exist.

- [ ] **Step 3: Implement additive migration helpers and schema**

```js
// backend/src/db/migrations/0002_phase1_write_integrity.mjs
export function addColumnIfMissing(db, table, column, definition) {
  const names = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!names.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function apply(db) {
  for (const table of [
    "customers", "opportunities", "quick_records", "weekly_reports",
    "solution_drafts", "action_items", "risk_items", "knowledge_items",
  ]) addColumnIfMissing(db, table, "version", "INTEGER NOT NULL DEFAULT 1");

  for (const table of [
    "customers", "opportunities", "weekly_reports", "action_items", "risk_items", "knowledge_items",
  ]) {
    addColumnIfMissing(db, table, "deleted_at", "TEXT");
    addColumnIfMissing(db, table, "deleted_by", "TEXT");
  }

  addColumnIfMissing(db, "quick_records", "voided_at", "TEXT");
  addColumnIfMissing(db, "quick_records", "voided_by", "TEXT");
  addColumnIfMissing(db, "quick_records", "void_reason", "TEXT");
  addColumnIfMissing(db, "audit_logs", "request_id", "TEXT");
  addColumnIfMissing(db, "audit_logs", "before_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "audit_logs", "after_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "audit_logs", "entity_version", "INTEGER");

  db.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    account TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_auth_sessions_active ON auth_sessions(token_hash, expires_at, revoked_at)");

  db.exec(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    actor TEXT NOT NULL,
    method TEXT NOT NULL,
    request_path TEXT NOT NULL,
    key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('processing', 'completed')),
    response_status INTEGER,
    response_json TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (actor, method, request_path, key)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at)");

  db.exec(`CREATE TABLE IF NOT EXISTS login_rate_limits (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL,
    window_started_at TEXT NOT NULL,
    blocked_until TEXT
  )`);
}
```

- [ ] **Step 4: Register executable migration checksums**

Extend `migrate.js` so both SQL and module migrations are checksummed from their source bytes. Execute `0002.apply(db)` inside the same `BEGIN IMMEDIATE` transaction used by SQL migrations.

```js
const migrations = [
  { version: "0001", filename: "0001_baseline.sql", type: "sql" },
  { version: "0002", filename: "0002_phase1_write_integrity.mjs", type: "module" },
];
```

- [ ] **Step 5: Add deterministic data-preservation assertions**

For every legacy table, compare count before and after. For customers, opportunities, quick records, actions, risks and knowledge, compare SHA-256 of `JSON.stringify(rows ordered by id)` before and after while omitting only newly added columns.

- [ ] **Step 6: Run tests and commit**

```powershell
node --test backend/tests/migrations.test.js
npm --prefix backend test
git add backend/src/db/migrations backend/src/db/migrate.js backend/tests/migrations.test.js
git commit -m "feat(db): add phase one integrity schema"
```

Expected: migration tests and existing backend tests PASS.

## Task 3: Database Integrity And Safe Maintenance

**Files:**

- Create: `backend/scripts/db-check.mjs`
- Create: `backend/src/db/integrity.js`
- Modify: `backend/scripts/db-maintenance.mjs`
- Modify: `backend/tests/db-maintenance.test.js`
- Modify: `backend/package.json`

- [ ] **Step 1: Write failing integrity-report tests**

```js
it("reports quick check, foreign key violations, pragmas, and all business table counts", async () => {
  const report = await inspectDatabase(databasePath);
  assert.equal(report.quickCheck, "ok");
  assert.deepEqual(report.foreignKeyViolations, []);
  assert.equal(report.pragmas.busyTimeout, 5000);
  assert.equal(Object.keys(report.tableCounts).length, 12);
});
```

Add `rejects a restore candidate that fails quick_check before replacing the live database` and assert the live file hash remains unchanged.

- [ ] **Step 2: Run and verify the missing report fails**

```powershell
node --test backend/tests/db-maintenance.test.js
```

Expected: FAIL because `inspectDatabase` and candidate validation do not exist.

- [ ] **Step 3: Implement `inspectDatabase`**

```js
// backend/src/db/integrity.js
import { createConnection } from "./connection.js";

export const BUSINESS_TABLES = [
  "customers", "opportunities", "quick_records", "ai_insights",
  "manual_confirmations", "weekly_reports", "solution_drafts", "ai_suggestions",
  "action_items", "risk_items", "knowledge_items", "audit_logs",
];

export function inspectDatabase(databasePath) {
  const db = createConnection(databasePath);
  try {
    const quickCheck = db.prepare("PRAGMA quick_check").get().quick_check;
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
    const tableCounts = Object.fromEntries(BUSINESS_TABLES.map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]));
    return {
      quickCheck,
      foreignKeyViolations,
      tableCounts,
      pragmas: {
        foreignKeys: db.prepare("PRAGMA foreign_keys").get().foreign_keys,
        journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
        busyTimeout: db.prepare("PRAGMA busy_timeout").get().timeout,
      },
    };
  } finally {
    db.close();
  }
}
```

Use an explicit `BUSINESS_TABLES` array containing all 12 existing tables. Do not discover arbitrary SQLite tables.

- [ ] **Step 4: Make restore validate then atomically replace**

Restore flow:

1. Copy the selected backup to a sibling temporary path.
2. Run `inspectDatabase` on the temporary copy.
3. Require `quickCheck === "ok"` and zero foreign-key violations.
4. Rename live database to a timestamped rollback path.
5. Rename the validated temporary file to the live path.
6. Reopen and run the same checks.
7. Restore the rollback path if post-replacement checks fail.

- [ ] **Step 5: Add command and verify**

```js
// backend/scripts/db-check.mjs
import { loadConfig } from "../src/config.js";
import { resolveDatabasePath } from "../src/db.js";
import { inspectDatabase } from "../src/db/integrity.js";

const databasePath = resolveDatabasePath(loadConfig().databaseUrl);
const report = inspectDatabase(databasePath);
console.log(JSON.stringify({ databasePath, ...report }, null, 2));
if (report.quickCheck !== "ok" || report.foreignKeyViolations.length > 0) process.exitCode = 1;
```

```json
"db:check": "node scripts/db-check.mjs"
```

Run:

```powershell
npm --prefix backend run db:check
node --test backend/tests/db-maintenance.test.js
npm --prefix backend test
```

Expected: all checks PASS and no runtime database remains in the repository.

- [ ] **Step 6: Commit**

```powershell
git add backend/scripts backend/tests/db-maintenance.test.js backend/package.json
git commit -m "feat(db): verify backup and restore integrity"
```

## Task 4: Password Hashing And Server-Side Sessions

**Files:**

- Create: `backend/src/auth/password.js`
- Create: `backend/src/auth/session.js`
- Create: `backend/scripts/hash-password.mjs`
- Create: `backend/tests/auth-session.test.js`
- Modify: `backend/src/config.js`
- Modify: `backend/package.json`
- Modify: `backend/.env.example`

- [ ] **Step 1: Write failing password and session tests**

```js
it("verifies a scrypt password hash without storing the password", async () => {
  const encoded = await hashPassword("unit-secret", { salt: Buffer.alloc(16, 7) });
  assert.equal(await verifyPassword("unit-secret", encoded), true);
  assert.equal(await verifyPassword("wrong", encoded), false);
  assert.doesNotMatch(encoded, /unit-secret/);
});

it("persists only the session token hash and revokes one session", () => {
  const created = createSession(db, config, { account: "jiangjz", now });
  assert.equal(db.prepare("SELECT token_hash FROM auth_sessions").get().token_hash.includes(created.cookieValue), false);
  assert.equal(getActiveSession(db, config, created.cookieValue, now)?.account, "jiangjz");
  revokeSession(db, config, created.cookieValue, now + 1);
  assert.equal(getActiveSession(db, config, created.cookieValue, now + 2), null);
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test backend/tests/auth-session.test.js
```

Expected: FAIL because the auth modules do not exist.

- [ ] **Step 3: Implement scrypt password encoding**

```js
// backend/src/auth/password.js
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export async function hashPassword(password, { salt = randomBytes(16) } = {}) {
  const derived = await scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, encoded) {
  const [name, n, r, p, saltValue, hashValue] = String(encoded).split("$");
  if (name !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = Buffer.from(await scrypt(String(password), Buffer.from(saltValue, "base64url"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: Implement opaque sessions and deterministic CSRF tokens**

```js
// backend/src/auth/session.js
import { createHmac, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;

function digest(secret, value) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createCsrfToken(config, sessionId) {
  return digest(config.authSessionSecret, `csrf:${sessionId}`);
}

export function createSession(db, config, { account, now = Date.now() } = {}) {
  const id = randomUUID();
  const cookieValue = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now + 7 * DAY_MS).toISOString();
  db.prepare(`INSERT INTO auth_sessions (id, token_hash, account, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(id, digest(config.authSessionSecret, cookieValue), account, expiresAt, new Date(now).toISOString());
  return { id, account, cookieValue, expiresAt, csrfToken: createCsrfToken(config, id) };
}

export function getActiveSession(db, config, cookieValue, now = Date.now()) {
  if (!cookieValue) return null;
  return db.prepare(`SELECT id, account, expires_at AS expiresAt FROM auth_sessions
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
    .get(digest(config.authSessionSecret, cookieValue), new Date(now).toISOString()) ?? null;
}

export function revokeSession(db, config, cookieValue, now = Date.now()) {
  return db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .run(new Date(now).toISOString(), digest(config.authSessionSecret, cookieValue));
}
```

- [ ] **Step 5: Add fail-closed configuration**

Add parsed config fields:

```js
authRequired: String(env.AUTH_REQUIRED ?? "true") !== "false",
authPasswordHash: env.AUTH_PASSWORD_HASH ?? "",
authCookieName: env.AUTH_COOKIE_NAME ?? "sentelligent_session",
authCookieSecure: String(env.AUTH_COOKIE_SECURE ?? (env.NODE_ENV === "production" ? "true" : "false")) === "true",
authCookieSameSite: "Lax",
corsAllowedOrigins: String(env.CORS_ALLOWED_ORIGINS ?? "http://127.0.0.1:5184,http://localhost:5184")
  .split(",").map((item) => item.trim()).filter(Boolean),
jsonBodyLimitBytes: Number(env.JSON_BODY_LIMIT_BYTES ?? 1_048_576),
nodeEnv: env.NODE_ENV ?? "development",
```

Production validation must throw when account, password hash, session secret, secure cookie, or explicit allowed origin is missing. Development may use the existing `AUTH_PASSWORD` only as a compatibility path; emit one startup warning without printing the password.

- [ ] **Step 6: Add interactive hash command and examples**

`hash-password.mjs` reads one standard-input line and prints only the encoded scrypt hash. Do not accept the password as a command-line argument.

```js
// backend/scripts/hash-password.mjs
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hashPassword } from "../src/auth/password.js";

if (stdin.isTTY) stdout.write("Password: ");
const reader = createInterface({ input: stdin, terminal: false });
const password = await reader.question("");
reader.close();
if (!password) throw new Error("Password is required");
stdout.write(`${await hashPassword(password)}\n`);
```

```json
"auth:hash": "node scripts/hash-password.mjs"
```

Update `.env.example` with placeholder values only.

- [ ] **Step 7: Run and commit**

```powershell
node --test backend/tests/auth-session.test.js backend/tests/config.test.js
npm --prefix backend test
git add backend/src/auth backend/src/config.js backend/scripts/hash-password.mjs backend/tests/auth-session.test.js backend/package.json backend/.env.example
git commit -m "feat(auth): add hashed credentials and revocable sessions"
```

## Task 5: HTTP Security, Cookie Login, CSRF, CORS, And Scoped Machine Access

**Files:**

- Create: `backend/src/http/errors.js`
- Create: `backend/src/http/request.js`
- Create: `backend/src/http/response.js`
- Create: `backend/src/http/security.js`
- Create: `backend/src/auth/machineAuthorization.js`
- Create: `backend/src/auth/loginRateLimit.js`
- Create: `backend/tests/auth-http.test.js`
- Create: `backend/tests/http-security.test.js`
- Modify: `backend/src/server.js`
- Modify: `backend/tests/api.test.js`
- Modify: `backend/tests/weixin-binding.test.js`

- [ ] **Step 1: Write failing protocol tests**

Add these exact test cases:

```text
returns 503 instead of opening business APIs when required auth is unconfigured
login issues a seven-day HttpOnly SameSite session cookie without a bearer token
rejects legacy bearer and query user tokens after cookie migration
accepts an active session cookie and rejects a revoked session cookie
requires matching CSRF for cookie-authenticated writes
logs out by revoking the server session and expiring the cookie
allows credentialed CORS only for configured origins
rejects JSON bodies larger than the configured limit
sanitizes unexpected errors and returns a request id
limits a WeChat machine token to the route allowlist
rate limits repeated login failures without revealing account existence
sets CSP nosniff referrer frame and production HSTS headers
```

Login assertions:

```js
assert.equal(response.status, 200);
assert.match(response.headers.get("set-cookie"), /sentelligent_session=.*HttpOnly.*SameSite=Lax.*Max-Age=604800/i);
assert.equal("token" in body, false);
assert.ok(body.csrfToken);
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test backend/tests/auth-http.test.js backend/tests/http-security.test.js
```

Expected: FAIL on missing modules and legacy Bearer behavior.

- [ ] **Step 3: Implement bounded body parsing and typed errors**

```js
// backend/src/http/errors.js
export class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

// backend/src/http/request.js
import { HttpError } from "./errors.js";

export async function readJsonBody(request, { maxBytes = 1_048_576 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "提交内容超过大小限制");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "INVALID_JSON", "提交内容不是有效 JSON"); }
}
```

- [ ] **Step 4: Implement cookie, CORS, CSRF, and response helpers**

```js
export function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

export function buildSessionCookie(config, value, { clear = false } = {}) {
  const parts = [
    `${config.authCookieName}=${clear ? "" : encodeURIComponent(value)}`,
    "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${clear ? 0 : 604800}`,
  ];
  if (config.authCookieSecure) parts.push("Secure");
  return parts.join("; ");
}

export function corsHeaders(origin, config) {
  if (!origin) return {};
  if (!config.corsAllowedOrigins.includes(origin)) throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "请求来源不受信任");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type,X-CSRF-Token,Idempotency-Key,If-Match",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    Vary: "Origin",
  };
}
```

Every JSON error body must use:

```js
{ error: { code, message, fields, requestId } }
```

Do not expose `error.message` for unexpected exceptions.

`response.js` applies these headers to JSON and document responses:

```js
export function securityHeaders(config) {
  return {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    ...(config.authCookieSecure ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}
```

- [ ] **Step 5: Implement persistent login throttling**

```js
// backend/src/auth/loginRateLimit.js
import { createHmac } from "node:crypto";
import { HttpError } from "../http/errors.js";

export function loginRateLimitKey(secret, account, remoteAddress) {
  return createHmac("sha256", secret)
    .update(`${String(account).trim().toLowerCase()}|${String(remoteAddress)}`)
    .digest("base64url");
}

export function assertLoginAllowed(db, key, now = Date.now()) {
  const row = db.prepare("SELECT blocked_until AS blockedUntil FROM login_rate_limits WHERE key = ?").get(key);
  if (row?.blockedUntil && Date.parse(row.blockedUntil) > now) {
    throw new HttpError(429, "LOGIN_RATE_LIMITED", "登录尝试过多，请稍后再试");
  }
}

export function recordLoginFailure(db, key, now = Date.now()) {
  const existing = db.prepare("SELECT failures, window_started_at AS windowStartedAt FROM login_rate_limits WHERE key = ?").get(key);
  const inWindow = existing && now - Date.parse(existing.windowStartedAt) < 15 * 60 * 1000;
  const failures = inWindow ? existing.failures + 1 : 1;
  const blockedUntil = failures >= 5 ? new Date(now + 15 * 60 * 1000).toISOString() : null;
  db.prepare(`INSERT INTO login_rate_limits (key,failures,window_started_at,blocked_until)
    VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET
    failures=excluded.failures,window_started_at=excluded.window_started_at,blocked_until=excluded.blocked_until`)
    .run(key, failures, inWindow ? existing.windowStartedAt : new Date(now).toISOString(), blockedUntil);
}

export function clearLoginFailures(db, key) {
  db.prepare("DELETE FROM login_rate_limits WHERE key = ?").run(key);
}
```

The rate-limit key is an HMAC of normalized account plus remote IP. Call `assertLoginAllowed` before password verification, record the same generic failure for unknown account and wrong password, and clear only after successful login.

- [ ] **Step 6: Implement authentication and route capabilities**

User browser flow:

- `POST /api/auth/login`: verify password, create DB session, set cookie, return account/displayName/expiresAt/csrfToken.
- `GET /api/auth/session`: read cookie, return current identity and deterministic csrfToken.
- `POST /api/auth/logout`: require cookie and CSRF, revoke session, clear cookie, return `204`.

Machine allowlist:

```js
const MACHINE_CAPABILITIES = [
  ["GET", /^\/api\/customers$/],
  ["POST", /^\/api\/quick-records$/],
  ["POST", /^\/api\/quick-records\/[^/]+\/analyze$/],
  ["POST", /^\/api\/reports\/weekly\/draft$/],
];
```

The machine token must receive `403 MACHINE_SCOPE_DENIED` for audit logs, delete, patch, export, binding control, and all unmatched paths.

- [ ] **Step 7: Integrate once in `server.js`**

The controller performs this order:

1. Create `requestId`.
2. Validate/emit CORS.
3. Handle OPTIONS.
4. Parse URL.
5. Handle public health and rate-limited login.
6. Authenticate cookie or machine token.
7. Enforce machine path scope.
8. Enforce CSRF for cookie-authenticated `POST/PATCH/DELETE` except login.
9. Dispatch existing routes.
10. Map `HttpError`; sanitize unexpected errors.

Remove HMAC browser token creation, query token acceptance, wildcard CORS, and unbounded `readJson` from `server.js`.

- [ ] **Step 8: Update existing API test fixtures**

Existing behavior tests may explicitly start with `authRequired: false` while the focused auth tests prove fail-closed behavior. Replace the old Bearer test with cookie/session assertions. Update the machine token test so it succeeds only on allowlisted routes.

- [ ] **Step 9: Run and commit**

```powershell
node --test backend/tests/auth-http.test.js backend/tests/http-security.test.js
npm --prefix backend test
git add backend/src/http backend/src/auth/machineAuthorization.js backend/src/auth/loginRateLimit.js backend/src/server.js backend/tests
git commit -m "feat(api): enforce cookie csrf and origin security"
```

## Task 6: Strict Request Validation

**Files:**

- Create: `backend/src/validation/requests.js`
- Create: `backend/tests/request-validation.test.js`
- Modify: `backend/src/server.js`
- Modify: `backend/tests/api.test.js`

- [ ] **Step 1: Write failing validation tests**

Add exact cases:

```text
rejects unknown customer fields with 422 and a field map
requires a non-empty customer name no longer than 200 characters
requires an opportunity to reference an existing active customer
rejects probability outside 0 through 100 and non-integer day counts
rejects invalid action risk and weekly status enums
rejects malformed arrays nested objects and overlong free text
rejects a confirmation target outside customer opportunity weekly
does not echo rejected sensitive values in the error or audit log
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test backend/tests/request-validation.test.js
```

Expected: FAIL because route bodies are accepted without strict schemas.

- [ ] **Step 3: Implement reusable field validation**

```js
// backend/src/validation/requests.js
import { HttpError } from "../http/errors.js";

function validateField(name, rule, value, errors) {
  if (value === undefined) {
    if (rule.required) errors[name] = "不能为空";
    return;
  }
  if (rule.type === "string" && (typeof value !== "string" || (rule.required && value.trim().length === 0) || value.trim().length > rule.max)) errors[name] = `必须是最多 ${rule.max} 个字符的文本`;
  if (rule.type === "integer" && (!Number.isInteger(value) || value < rule.min || value > rule.max)) errors[name] = `必须是 ${rule.min} 到 ${rule.max} 的整数`;
  if (rule.type === "array" && (!Array.isArray(value) || (rule.required && value.length === 0) || value.length > rule.maxItems)) errors[name] = `必须是最多 ${rule.maxItems} 项的列表`;
  if (rule.type === "array" && Array.isArray(value) && rule.values && value.some((item) => !rule.values.includes(item))) errors[name] = `包含不支持的选项`;
  if (rule.type === "object" && (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > rule.maxKeys)) errors[name] = `必须是最多 ${rule.maxKeys} 项的对象`;
  if (rule.type === "enum" && !rule.values.includes(value)) errors[name] = `必须是 ${rule.values.join("、")} 之一`;
}

export function validateObject(schema, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(422, "VALIDATION_ERROR", "提交内容有误", { body: "必须是对象" });
  const errors = {};
  for (const key of Object.keys(body)) if (!Object.hasOwn(schema, key)) errors[key] = "不支持该字段";
  for (const [name, rule] of Object.entries(schema)) validateField(name, rule, body[name], errors);
  if (Object.keys(errors).length > 0) throw new HttpError(422, "VALIDATION_ERROR", "提交内容有误", errors);
  return body;
}

const text = (max, required = false) => ({ type: "string", max, required });
const list = (maxItems = 100) => ({ type: "array", maxItems });

export const requestSchemas = {
  customerCreate: {
    name: text(200, true), region: text(100), type: text(100), level: text(50), owner: text(100), contact: text(500),
    relation: { type: "integer", min: 0, max: 100 }, stakeholders: list(), decisionChain: list(), historyProjects: list(),
    infrastructure: list(), syncPreview: list(), budget: text(500), summary: text(5000), needs: list(), risks: list(), opportunities: list(),
  },
  opportunityCreate: {
    customerId: text(200, true), name: text(200, true), customer: text(200), stage: text(100), amount: text(100), owner: text(100),
    probability: { type: "integer", min: 0, max: 100 }, days: { type: "integer", min: 0, max: 10000 }, requirements: list(),
    competitors: list(), solutionDirection: list(), sourceRecord: text(200), risk: text(5000), next: text(5000), tone: text(50),
  },
  quickRecordCreate: {
    rawContent: text(50000, true), occurredAt: text(50), sourceChannel: text(100), customerId: text(200), opportunityId: text(200),
  },
  confirmation: {
    targets: { type: "array", maxItems: 3, values: ["customer", "opportunity", "weekly"], required: true },
    analysisVersionId: text(200, true), confirmedBy: text(100), note: text(5000),
    targetVersions: { type: "object", maxKeys: 3, required: true },
  },
  actionPatch: {
    title: text(500), assignee: text(100), due: text(50), priority: { type: "enum", values: ["高", "中", "低"] },
    status: { type: "enum", values: ["pending", "in_progress", "done", "deferred"] }, reason: text(5000),
  },
  riskPatch: {
    assignee: text(100), due: text(50), score: { type: "integer", min: 0, max: 100 }, severity: { type: "enum", values: ["高", "中", "低"] },
    status: { type: "enum", values: ["open", "accepted", "in_progress", "deferred", "closed"] }, action: text(5000),
  },
  weeklyPatch: { content: text(100000), status: { type: "enum", values: ["draft", "saved", "ready"] } },
  knowledgeCreate: { title: text(500, true), category: text(100), tags: list(50), summary: text(5000), content: text(100000), source: text(1000) },
  weeklyDraft: { owner: text(100, true), periodStart: text(50, true), periodEnd: text(50, true), knowledgeIds: list(100) },
  aiSuggestion: { type: text(100, true), title: text(500, true), context: { type: "object", maxKeys: 30 } },
  solutionDraft: {
    owner: text(100, true), customerId: text(200, true), opportunityId: text(200, true),
    artifactType: { type: "enum", values: ["solution_framework", "communication_outline", "presales_questions", "report_outline", "competitor_response"] },
    knowledgeIds: list(100),
  },
  login: { account: text(100, true), password: text(1000, true) },
};

export function partialSchema(schema) {
  return Object.fromEntries(Object.entries(schema).map(([key, rule]) => [key, { ...rule, required: false }]));
}
```

Use `partialSchema(requestSchemas.customerCreate)`, `partialSchema(requestSchemas.opportunityCreate)`, `partialSchema(requestSchemas.knowledgeCreate)`, and the explicit PATCH schemas for updates. Solution write schemas remain reachable only when the feature flag is enabled.

- [ ] **Step 4: Add foreign-key and cross-field validation**

Before creating an opportunity, require an active customer row. When both customer and opportunity IDs are supplied for a quick record, require that the opportunity belongs to that customer. Return `422 VALIDATION_ERROR` with `customerId` or `opportunityId` in `fields`.

- [ ] **Step 5: Integrate validation before every write service**

Call `validateObject` immediately after bounded JSON parsing and before starting a transaction, model request or file write. Do not pass unknown body keys into SQL or audit metadata.

- [ ] **Step 6: Run and commit**

```powershell
node --test backend/tests/request-validation.test.js
npm --prefix backend test
git add backend/src/validation backend/src/server.js backend/tests
git commit -m "feat(api): validate all business write requests"
```

## Task 7: Frontend Cookie Session And Protected Export

**Files:**

- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.test.js`
- Modify: `outputs/product-design-prototype/src/sessionAuth.js`
- Modify: `outputs/product-design-prototype/src/sessionAuth.test.js`
- Modify: `outputs/product-design-prototype/src/App.jsx`
- Modify: `outputs/product-design-prototype/src/features/salesWorkbench/pages.jsx`

- [ ] **Step 1: Replace token tests with cookie and CSRF expectations**

```js
assert.equal(request.options.credentials, "include");
assert.equal(request.options.headers.Authorization, undefined);
assert.equal(request.options.headers["X-CSRF-Token"], "csrf-test");
assert.equal(loginResult.token, undefined);
```

Add tests for `restoreSession`, `logout`, `401` session expiry, `409` preservation, and weekly export through authenticated fetch.

- [ ] **Step 2: Run focused frontend tests and verify failure**

```powershell
npm --prefix outputs/product-design-prototype run test:auth
npm --prefix outputs/product-design-prototype run test:api
```

Expected: FAIL because the API client still injects Bearer tokens and export URLs.

- [ ] **Step 3: Make the API client session-aware**

```js
async function requestJson(fetchImpl, url, options = {}, csrfToken = "") {
  const method = String(options.method ?? "GET").toUpperCase();
  const response = await fetchImpl(url, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" && method !== "HEAD" && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(options.headers ?? {}),
    },
  });
  // Preserve status/body/requestId on the thrown error.
}

export function createSalesWorkbenchApi({ baseUrl, fetchImpl = fetch } = {}) {
  let csrfToken = "";
  const setSession = (session) => { csrfToken = session?.csrfToken ?? ""; };
  const requestApi = (path, options) => requestJson(fetchImpl, url(path), options, csrfToken);
  return {
    setSession,
    async login(credentials) {
      const session = await requestJson(fetchImpl, url("/api/auth/login"), {
        method: "POST",
        body: JSON.stringify(credentials),
      });
      setSession(session);
      return session;
    },
    async restoreSession() {
      const session = await requestJson(fetchImpl, url("/api/auth/session"));
      setSession(session);
      return session;
    },
    async logout() {
      await requestApi("/api/auth/logout", { method: "POST", body: "{}" });
      setSession(null);
    },
  };
}
```

Remove `authToken`, `authHeaders`, and all Authorization header generation.

- [ ] **Step 4: Remove sensitive browser storage**

`sessionAuth.js` must expose only:

```js
export function clearLegacyAuthSession(storage) {
  storage?.removeItem?.("sentelligent.salesWorkbench.login");
}

export function createDisplaySession({ account, displayName, expiresAt, csrfToken }) {
  return { account, displayName: displayName || account, expiresAt, csrfToken };
}
```

Do not write the session or CSRF token to `localStorage` or `sessionStorage`. App startup clears the legacy item and calls `api.restoreSession()`.

- [ ] **Step 5: Replace URL export with a Blob download command**

```js
async function downloadWeeklyReport(reportId, format = "word") {
  const response = await fetchImpl(url(`/api/reports/weekly/${encodeURIComponent(reportId)}/export?format=${encodeURIComponent(format)}`), {
    credentials: "include",
  });
  if (!response.ok) throw await toApiError(response);
  return {
    blob: await response.blob(),
    filename: parseContentDisposition(response.headers.get("content-disposition")) ?? `weekly-report.${format === "word" ? "docx" : format}`,
  };
}
```

The weekly page uses a button with a download icon, calls this method, creates a temporary object URL, clicks a temporary anchor, and revokes the URL in `finally`.

- [ ] **Step 6: Update App login/restore/logout flow**

- Initial state is `checking`, not authenticated from storage.
- Successful `restoreSession` or `login` calls `api.setSession(session)` and stores display-only state in React memory.
- `401` clears React session and shows login.
- Logout calls the backend first, then clears memory even when the network request fails.

- [ ] **Step 7: Run and commit**

```powershell
npm --prefix outputs/product-design-prototype run test:auth
npm --prefix outputs/product-design-prototype run test:api
npm --prefix outputs/product-design-prototype run qa:local
git add outputs/product-design-prototype/src
git commit -m "feat(frontend): use cookie sessions and protected export"
```

## Task 8: Optimistic Versions And Soft Deletion

**Files:**

- Modify: `shared/salesWorkbenchApiContract.mjs`
- Modify: `backend/src/server.js`
- Create: `backend/tests/optimistic-lock.test.js`
- Create: `backend/tests/soft-delete.test.js`
- Modify: `backend/tests/api.test.js`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.test.js`

- [ ] **Step 1: Add failing contract and API tests**

For customer, opportunity, quick record, weekly report, solution draft, action, risk and knowledge entities, assert `version` is a positive integer.

Add exact cases:

```text
updates an entity when If-Match equals the current version
returns 409 VERSION_CONFLICT for a stale If-Match without changing data
soft-deletes an entity with the current version and hides it from list/get
returns 404 for a deleted entity while retaining its audit snapshot
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test backend/tests/optimistic-lock.test.js backend/tests/soft-delete.test.js
node --test outputs/product-design-prototype/src/api/salesWorkbenchApi.test.js
```

Expected: FAIL because entities lack versions and deletes are physical.

- [ ] **Step 3: Add version mapping and parsing**

Every mutable entity mapper returns:

```js
version: Number(row.version ?? 1),
```

Every PATCH/DELETE requires `If-Match: "<version>"`. Missing or invalid headers return `428 PRECONDITION_REQUIRED`.

```js
export function parseExpectedVersion(request) {
  const match = String(request.headers["if-match"] ?? "").match(/^"?(\d+)"?$/);
  if (!match) throw new HttpError(428, "PRECONDITION_REQUIRED", "请刷新后再提交");
  return Number(match[1]);
}
```

- [ ] **Step 4: Implement versioned update and soft delete**

```js
export function runVersionedUpdate(db, { table, id, expectedVersion, setSql, params }) {
  const result = db.prepare(`UPDATE ${table}
    SET ${setSql}, version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $id AND version = $expectedVersion AND deleted_at IS NULL`)
    .run({ ...params, $id: id, $expectedVersion: expectedVersion });
  if (result.changes === 1) return;
  const current = db.prepare(`SELECT version, deleted_at FROM ${table} WHERE id = ?`).get(id);
  if (!current || current.deleted_at) throw new HttpError(404, "NOT_FOUND", "记录不存在或已归档");
  throw new HttpError(409, "VERSION_CONFLICT", "记录已被其他操作更新", { currentVersion: current.version });
}
```

Soft delete sets `deleted_at`, `deleted_by`, increments version, and writes before/after audit data in one transaction. All list/get queries for soft-deletable entities add `deleted_at IS NULL`.

- [ ] **Step 5: Send versions from the frontend**

API client PATCH and DELETE methods set:

```js
headers: { "If-Match": `"${entity.version}"` }
```

The UI must not replace local data on `409`; it retains the form and exposes the server `currentVersion` for the later conflict dialog work.

- [ ] **Step 6: Run and commit**

```powershell
node --test backend/tests/optimistic-lock.test.js backend/tests/soft-delete.test.js
npm --prefix backend test
npm --prefix outputs/product-design-prototype run qa:local
git add shared backend/src/server.js backend/tests outputs/product-design-prototype/src/api
git commit -m "feat(data): add optimistic versions and soft deletion"
```

## Task 9: Transactional And Idempotent Quick Record Confirmation

**Files:**

- Create: `backend/src/db/transaction.js`
- Create: `backend/src/services/idempotency.js`
- Create: `backend/tests/confirm-transaction.test.js`
- Create: `backend/tests/concurrency.test.js`
- Modify: `backend/src/server.js`
- Modify: `backend/tests/api.test.js`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.test.js`

- [ ] **Step 1: Write failing rollback and replay tests**

```text
rolls back customer opportunity action risk confirmation and audit when any persistence step fails
replays one completed response for the same Idempotency-Key and request within 24 hours
rejects the same Idempotency-Key with a different request hash
returns 409 and rolls back every target when one expected entity version is stale
commits only one confirmation for 50 concurrent requests with the same key
completes 20 distinct writes without SQLITE_BUSY or database damage
```

Fault injection is supplied through `createServer({ failpoints: new Set(["confirm.afterAction"]) })`; production config never reads failpoints.

- [ ] **Step 2: Run and verify failure**

```powershell
node --test backend/tests/confirm-transaction.test.js backend/tests/concurrency.test.js
```

Expected: FAIL because confirmation autocommits and ignores `Idempotency-Key`.

- [ ] **Step 3: Implement transaction helper**

```js
export function withImmediateTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
```

- [ ] **Step 4: Implement idempotency claim and completion**

```js
export function requestHash(body) {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function claimIdempotency(db, scope) {
  const existing = db.prepare(`SELECT * FROM idempotency_keys
    WHERE actor=? AND method=? AND request_path=? AND key=? AND expires_at>?`)
    .get(scope.actor, scope.method, scope.path, scope.key, scope.nowIso);
  if (existing && existing.request_hash !== scope.hash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "该请求标识已用于其他内容");
  }
  if (existing?.state === "completed") return { replay: true, status: existing.response_status, body: JSON.parse(existing.response_json) };
  if (existing) throw new HttpError(409, "REQUEST_IN_PROGRESS", "相同请求正在处理中");
  db.prepare(`INSERT INTO idempotency_keys
    (actor,method,request_path,key,request_hash,state,created_at,expires_at)
    VALUES (?,?,?,?,?,'processing',?,?)`)
    .run(scope.actor, scope.method, scope.path, scope.key, scope.hash, scope.nowIso, scope.expiresIso);
  return { replay: false };
}
```

`completeIdempotency` stores status and JSON response before the surrounding transaction commits.

- [ ] **Step 5: Wrap the confirmation route**

Require:

- `Idempotency-Key` header.
- Quick record `If-Match` version.
- `targetVersions` for customer/opportunity targets in the body.

Inside one transaction perform claim, confirmation UPSERT, quick-record version update, customer and opportunity synchronization, action/risk upsert, audit before/after, and response completion. Any target conflict or failpoint throws before commit.

- [ ] **Step 6: Add frontend key generation and retry stability**

Generate one UUID when the user starts a confirmation attempt. Reuse it for retries until the request succeeds or the user changes selected targets/analysis version. Do not generate a new key on every click handler retry.

- [ ] **Step 7: Run and commit**

```powershell
node --test backend/tests/confirm-transaction.test.js backend/tests/concurrency.test.js
npm --prefix backend test
npm --prefix outputs/product-design-prototype run test:api
git add backend/src/db/transaction.js backend/src/services backend/src/server.js backend/tests outputs/product-design-prototype/src/api
git commit -m "feat(records): make confirmation atomic and idempotent"
```

## Task 10: Atomic Audit Records With Authenticated Actors

**Files:**

- Create: `backend/src/audit/auditRepository.js`
- Create: `backend/tests/transaction-audit.test.js`
- Modify: `backend/src/server.js`
- Modify: `backend/tests/api.test.js`

- [ ] **Step 1: Write failing audit tests**

```text
uses the authenticated account instead of request-controlled owner fields
stores request id entity version and sanitized before-after snapshots
rolls back the business mutation when audit persistence fails
never stores password cookie csrf authorization phone email or model key values
rolls back quick-record analysis when insight status or audit persistence fails
rolls back all risk-diagnosis items when one risk or audit write fails
rolls back weekly draft creation when its audit write fails
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test backend/tests/transaction-audit.test.js
```

- [ ] **Step 3: Implement one audit repository**

```js
export function insertAudit(db, {
  action, entityType, entityId, actor, requestId,
  before = null, after = null, entityVersion = null, metadata = {},
}) {
  const record = {
    id: randomUUID(), action, entityType, entityId, actor, requestId,
    before: sanitizeAuditValue(before),
    after: sanitizeAuditValue(after),
    metadata: sanitizeAuditValue(metadata),
    entityVersion,
  };
  db.prepare(`INSERT INTO audit_logs
    (id,action,entity_type,entity_id,actor,request_id,before_json,after_json,metadata_json,entity_version)
    VALUES ($id,$action,$entityType,$entityId,$actor,$requestId,$beforeJson,$afterJson,$metadataJson,$entityVersion)`)
    .run({
      $id: record.id,
      $action: action,
      $entityType: entityType,
      $entityId: entityId,
      $actor: actor,
      $requestId: requestId,
      $beforeJson: JSON.stringify(record.before ?? {}),
      $afterJson: JSON.stringify(record.after ?? {}),
      $metadataJson: JSON.stringify(record.metadata ?? {}),
      $entityVersion: entityVersion,
    });
  return record;
}
```

Sanitize keys matching `password|secret|token|authorization|cookie|csrf|phone|mobile|email|wechat` at any depth and limit arrays and recursion as the existing sanitizer does.

```js
export function sanitizeAuditValue(value, depth = 0) {
  if (depth > 5) return null;
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAuditValue(item, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|secret|token|authorization|cookie|csrf|phone|mobile|email|wechat/i.test(key)) continue;
    result[key] = sanitizeAuditValue(item, depth + 1);
  }
  return result;
}
```

- [ ] **Step 4: Replace route-controlled actors**

All route audit calls use `requestContext.actor.account`. Owner, assignee, and `confirmedBy` remain business fields but never determine the audit principal. Wrap every route that performs more than one database statement, or a business statement plus audit, in `withImmediateTransaction`: quick-record analyze, quick-record confirm, risk diagnosis, customer/opportunity/action/risk/knowledge/weekly create-update-delete, weekly draft, and solution compatibility writes when enabled.

External DeepSeek, transcription and SDK calls must finish before opening `BEGIN IMMEDIATE`. Validate the external result first, then keep only SQLite persistence and audit inside the transaction so a slow network request never holds the writer lock.

- [ ] **Step 5: Run and commit**

```powershell
node --test backend/tests/transaction-audit.test.js
npm --prefix backend test
git add backend/src/audit backend/src/server.js backend/tests
git commit -m "feat(audit): record atomic authenticated changes"
```

## Task 11: Browser Integration, Local Runtime, And Delivery Evidence

**Files:**

- Modify: `outputs/product-design-prototype/scripts/integration-qa.mjs`
- Modify: `outputs/product-design-prototype/vite.config.mjs`
- Modify: `scripts/local-dev.mjs`
- Modify: `scripts/local-dev.test.mjs`
- Modify: `scripts/wsl-backend.test.mjs`
- Modify: `scripts/wsl-stack.test.mjs`
- Create: `scripts/release-boundary.test.mjs`
- Modify: `docs/正式交付验收手册.md`
- Modify: `scripts/delivery-guide.test.mjs`

- [ ] **Step 1: Add failing browser auth assertions**

Integration QA must verify:

```text
login response creates an HttpOnly session cookie and no localStorage token
page refresh restores the session through GET /api/auth/session
a write carries X-CSRF-Token and no Authorization header
weekly export succeeds without a query token
logout revokes the cookie and protected navigation returns to login
```

Pass the random frontend origin to the backend through `CORS_ALLOWED_ORIGINS` and set `AUTH_COOKIE_SECURE=false`, `NODE_ENV=test` only for this loopback QA process.

- [ ] **Step 2: Add runtime isolation assertions**

`release-boundary.test.mjs` scans runtime and delivery scripts and rejects:

```js
const forbidden = [/pkill\s+node/i, /taskkill\s+\/im\s+node/i, /docker\s+compose\s+down/i, /systemctl\s+(restart|stop)\s+(?!sentelligent)/i];
```

Existing PID stop helpers must verify the process command line or project runtime fingerprint before termination.

- [ ] **Step 3: Update local and Vite configuration**

Keep explicit CORS during Phase 1 to avoid changing the production static serving path. `local-dev.mjs` passes:

```js
CORS_ALLOWED_ORIGINS: config.frontendUrl,
AUTH_COOKIE_SECURE: "false",
NODE_ENV: "development",
```

Integration QA passes the same values with `NODE_ENV=test`. Production keeps same-origin reverse proxy and `Secure=true`.

- [ ] **Step 4: Update delivery manual**

Document exact commands and evidence for:

- password hash generation and production env migration;
- `db:check`, migration checksum report, backup hash, restore verification;
- cookie/CSRF/CORS checks;
- no query/Bearer user token;
- project-scoped service ownership;
- application rollback with additive schema compatibility.

- [ ] **Step 5: Run the full local gate**

```powershell
npm run test:deploy
npm --prefix backend test
npm --prefix outputs/product-design-prototype run qa:local
npm --prefix outputs/product-design-prototype run qa:integration
```

Expected: every suite PASS, secret scans report zero findings, and integration QA leaves no temp database or process.

- [ ] **Step 6: Create and verify a Phase 1 database backup**

```powershell
npm run wsl:db:backup -- --label=phase1-complete
npm run wsl:db:info
```

Record backup path, SHA-256, `quick_check`, foreign-key result, 12 table counts, migration versions, and restore-test result in `outputs/qa-audit/<date>-phase1/phase1-evidence.md`. Do not commit the SQLite file or secrets.

- [ ] **Step 7: Commit**

```powershell
git add outputs/product-design-prototype/scripts outputs/product-design-prototype/vite.config.mjs scripts docs/正式交付验收手册.md outputs/qa-audit
git commit -m "test: verify phase one security and recovery"
```

## Phase 1 Completion Gate

Before starting the Apple shell or business page implementation, the controller must prove:

- [ ] Missing production auth configuration fails closed.
- [ ] Browser login uses a seven-day HttpOnly cookie and no persisted bearer token.
- [ ] Logout and expiry revoke server sessions.
- [ ] CSRF, Origin, body limit, CORS and safe errors pass focused tests.
- [ ] Login throttling and strict request field validation pass focused tests.
- [ ] WeChat machine access is restricted to its allowlist.
- [ ] Migrations are immutable, checksummed, additive and data-preserving.
- [ ] SQLite uses foreign keys, WAL, `busy_timeout=5000`, normal sync and integrity checks.
- [ ] Updates reject stale versions; deletes are soft and audited.
- [ ] Quick-record confirmation is transactional and idempotent.
- [ ] Audit actor comes from authentication and before/after data is sanitized.
- [ ] Backup and restore verification covers all 12 existing business tables.
- [ ] Root, backend, frontend local and browser integration gates all pass.
- [ ] Worktree is clean and each task has a focused commit.

Only then create the Phase 2 plan for monolith extraction and the Apple PC/mobile shell.
