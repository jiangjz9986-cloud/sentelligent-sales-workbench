import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PRODUCTION_ORIGIN = "https://82.156.210.199";
export const REPORT_FILE_MODE = 0o600;
export const SMOKE_CHECK_IDS = Object.freeze([
  "transport.stack-health",
  "security.unauthorized-read",
  "security.origin-rejection",
  "auth.login-and-cookie",
  "auth.session-read",
  "security.csrf-rejection",
  "business.initial-collections",
  "customer.create",
  "customer.read",
  "customer.update",
  "customer.optimistic-lock",
  "opportunity.create",
  "opportunity.update",
  "quick-record.create",
  "quick-record.preview",
  "quick-record.persisted-analysis",
  "sales-decision.create",
  "itinerary.create",
  "itinerary.read",
  "weekly-report.create",
  "integration.weixin-status",
  "governance.audit-trail",
  "opportunity.soft-delete",
  "customer.soft-delete",
  "business.soft-delete-filtering",
]);

const PRODUCTION_ACCOUNT = "jiangjz";
const SESSION_COOKIE_NAME = "sentelligent_session";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_IDENTITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLEANUP_RESIDUAL_KEYS = Object.freeze([
  "customers",
  "opportunities",
  "quickRecords",
  "aiInsights",
  "salesDecisions",
  "itineraries",
  "weeklyReports",
  "auditLogs",
  "authSessions",
  "idempotencyKeys",
]);
const CLEANUP_CREATED_ID_KEYS = Object.freeze([
  "customers",
  "opportunities",
  "quickRecords",
  "aiInsights",
  "salesDecisions",
  "itineraries",
  "weeklyReports",
  "auditLogs",
]);
const AUDIT_RESOURCE_TYPES = Object.freeze([
  ["customers", "customer"],
  ["opportunities", "opportunity"],
  ["quickRecords", "quick_record"],
  ["salesDecisions", "sales_decision_analysis"],
  ["itineraries", "visit_itinerary"],
  ["weeklyReports", "weekly_report"],
]);

class BlockedCheckError extends Error {}

function fail(message) {
  throw new Error(message);
}

function assertCheck(condition, message) {
  if (!condition) fail(message);
}

function safeIntegerMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => Number.isSafeInteger(item) && item >= 0)
      .map(([key, item]) => [key, item]),
  );
}

function safeErrorMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function assertRunId(runId) {
  if (!UUID_PATTERN.test(String(runId ?? ""))) {
    throw new TypeError("A valid smoke runId UUID is required");
  }
  return String(runId);
}

export function parseProductionOrigin(value) {
  if (typeof value !== "string" || value !== PRODUCTION_ORIGIN) {
    throw new TypeError(`Target must be the exact production HTTPS origin: ${PRODUCTION_ORIGIN}`);
  }
  return value;
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("CLI arguments must be an array");
  let origin;
  let reportPath;

  for (const argument of argv) {
    if (/^--password(?:=|$)/i.test(String(argument))) {
      throw new TypeError("The password must be supplied only through JSON stdin");
    }
    if (String(argument).startsWith("--origin=")) {
      if (origin !== undefined) throw new TypeError("The origin argument may be specified only once");
      origin = String(argument).slice("--origin=".length);
      continue;
    }
    if (String(argument).startsWith("--report=")) {
      if (reportPath !== undefined) throw new TypeError("The report argument may be specified only once");
      reportPath = String(argument).slice("--report=".length);
      continue;
    }
    throw new TypeError(`Unsupported production smoke argument: ${String(argument)}`);
  }

  if (origin === undefined) throw new TypeError("The --origin argument is required");
  if (!reportPath) throw new TypeError("The --report argument is required");
  if (reportPath.includes("\0")) throw new TypeError("The report path is invalid");
  return { origin: parseProductionOrigin(origin), reportPath };
}

export function parsePasswordStdin(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new TypeError("JSON stdin containing the login password is required");
  }

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new TypeError("Password stdin must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Password stdin JSON must be an object");
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "password") {
    throw new TypeError("Password stdin JSON may contain only the password field");
  }
  if (typeof parsed.password !== "string" || parsed.password.length === 0 || parsed.password.length > 1000) {
    throw new TypeError("A non-empty password is required in JSON stdin");
  }
  return parsed.password;
}

export function atomicWriteJsonReport(reportPath, report) {
  if (typeof reportPath !== "string" || !reportPath) {
    throw new TypeError("A report path is required");
  }
  const targetPath = resolve(reportPath);
  const parentPath = dirname(targetPath);
  mkdirSync(parentPath, { recursive: true });
  if (existsSync(targetPath)) throw new Error(`Report already exists: ${targetPath}`);

  const temporaryPath = join(
    parentPath,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", REPORT_FILE_MODE);
    writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, REPORT_FILE_MODE);
    try {
      linkSync(temporaryPath, targetPath);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`Report already exists: ${targetPath}`);
      throw error;
    }
    chmodSync(targetPath, REPORT_FILE_MODE);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function parseSessionCookie(setCookie) {
  const firstPart = String(setCookie ?? "").split(";", 1)[0];
  const separator = firstPart.indexOf("=");
  if (separator <= 0) return null;
  const name = firstPart.slice(0, separator).trim();
  const value = firstPart.slice(separator + 1).trim();
  if (name !== SESSION_COOKIE_NAME || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  return {
    header: `${name}=${value}`,
    value,
  };
}

function idempotencyKey(runId, checkId) {
  return `smoke:${runId}:${checkId}`;
}

function requireState(value, label) {
  if (value === undefined || value === null || value === "") {
    throw new BlockedCheckError(`${label} is unavailable because an earlier check failed`);
  }
  return value;
}

function expectedStatus(result, status, label) {
  assertCheck(result.status === status, `${label} expected HTTP ${status}, received ${result.status}`);
}

function errorCode(result) {
  return result.body?.error?.code;
}

function safeCleanupResult(value, expectedRunId, expectedDatabaseIdentity) {
  const residual = safeIntegerMap(value?.residual);
  const cleanupRunId = typeof value?.runId === "string" ? value.runId : null;
  const databaseIdentity = typeof value?.databaseIdentity === "string"
    ? value.databaseIdentity
    : null;
  const integrity = {
    quickCheck: typeof value?.integrity?.quickCheck === "string"
      ? value.integrity.quickCheck.slice(0, 100)
      : null,
    foreignKeyViolations: Number.isSafeInteger(value?.integrity?.foreignKeyViolations)
      ? value.integrity.foreignKeyViolations
      : null,
  };
  const hasRequiredResidualCounters = CLEANUP_RESIDUAL_KEYS.every((key) =>
    Object.hasOwn(residual, key)
  );
  const clean =
    value?.status === "clean" &&
    cleanupRunId === expectedRunId &&
    databaseIdentity === expectedDatabaseIdentity &&
    hasRequiredResidualCounters &&
    Object.values(residual).every((count) => count === 0) &&
    integrity.quickCheck === "ok" &&
    integrity.foreignKeyViolations === 0;
  return {
    status: clean ? "clean" : "failed",
    runId: cleanupRunId,
    databaseIdentity,
    deleted: safeIntegerMap(value?.deleted),
    residual,
    integrity,
  };
}

function reportSummary(checks) {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.status === "passed").length,
    failed: checks.filter((check) => check.status === "failed").length,
    blocked: checks.filter((check) => check.status === "blocked").length,
  };
}

export async function runSmoke({
  origin,
  password,
  reportPath,
  cleanup,
  verifyDatabaseIdentity,
  fetchImpl = globalThis.fetch,
  runId = randomUUID(),
  now = () => new Date(),
} = {}) {
  const exactOrigin = parseProductionOrigin(origin);
  const exactRunId = assertRunId(runId);
  if (typeof password !== "string" || !password) throw new TypeError("A login password is required");
  if (typeof reportPath !== "string" || !reportPath) throw new TypeError("A report path is required");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (typeof cleanup !== "function") {
    throw new TypeError("A server-local cleanup callback is required before production smoke can run");
  }
  if (typeof verifyDatabaseIdentity !== "function") {
    throw new TypeError("A server-local database identity verifier is required before production smoke can run");
  }
  if (existsSync(resolve(reportPath))) throw new Error(`Report already exists: ${resolve(reportPath)}`);

  const startedAtValue = now();
  if (!(startedAtValue instanceof Date) || Number.isNaN(startedAtValue.valueOf())) {
    throw new TypeError("The smoke clock must return a valid Date");
  }

  const marker = `[smoke:${exactRunId}]`;
  const runLabel = `smoke:${exactRunId}`;
  const state = {
    cookieHeader: "",
    sessionCookie: "",
    csrfToken: "",
    customer: null,
    opportunity: null,
    quickRecord: null,
    itinerary: null,
    weekly: null,
    initialCustomers: null,
    initialOpportunities: null,
    createdIds: Object.fromEntries(CLEANUP_CREATED_ID_KEYS.map((key) => [key, new Set()])),
    idempotencyKeys: new Map(),
    databaseIdentity: "",
  };
  const checks = [];
  let preflightVerified = false;

  const rememberCreatedId = (key, value) => {
    if (typeof value === "string" && value) state.createdIds[key].add(value);
  };
  const createdIdManifest = () => Object.fromEntries(
    CLEANUP_CREATED_ID_KEYS.map((key) => [key, [...state.createdIds[key]]]),
  );

  const request = async (path, {
    method = "GET",
    body,
    authenticated = false,
    csrfProtected = false,
    requestOrigin = exactOrigin,
    headers = {},
    timeoutMs = 90_000,
  } = {}) => {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError("Smoke request paths must be absolute paths");
    }
    const url = new URL(path, `${exactOrigin}/`);
    if (url.origin !== exactOrigin) throw new Error("Smoke request escaped the exact production origin");
    const requestHeaders = new Headers({ Accept: "application/json", Origin: requestOrigin });
    for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, String(value));
    if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
    if (authenticated) {
      requestHeaders.set("Cookie", requireState(state.cookieHeader, "authenticated session"));
    }
    if (csrfProtected) {
      requestHeaders.set("X-CSRF-Token", requireState(state.csrfToken, "CSRF token"));
    }
    const exactIdempotencyKey = requestHeaders.get("Idempotency-Key");
    if (exactIdempotencyKey) {
      const descriptor = {
        actor: PRODUCTION_ACCOUNT,
        method: String(method).toUpperCase(),
        requestPath: url.pathname,
        key: exactIdempotencyKey,
      };
      const fingerprint = JSON.stringify([
        descriptor.actor,
        descriptor.method,
        descriptor.requestPath,
        descriptor.key,
      ]);
      state.idempotencyKeys.set(fingerprint, descriptor);
    }

    const response = await fetchImpl(url.href, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Redirect response rejected for ${method} ${path}`);
    }
    const responseText = await response.text();
    let responseBody = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        throw new Error(`${method} ${path} returned a non-JSON response`);
      }
    }
    return { status: response.status, headers: response.headers, body: responseBody };
  };

  const execute = async (id, operation) => {
    if (id !== "transport.stack-health" && !preflightVerified) {
      checks.push({
        id,
        status: "blocked",
        error: "Production smoke preflight did not verify the server-local database identity",
      });
      return;
    }
    try {
      const details = await operation();
      checks.push({ id, status: "passed", ...(details ? { details } : {}) });
    } catch (error) {
      checks.push({
        id,
        status: error instanceof BlockedCheckError ? "blocked" : "failed",
        error: safeErrorMessage(error, [password, state.sessionCookie, state.csrfToken]),
      });
    }
  };

  const writeHeaders = (checkId, extra = {}) => ({
    "Idempotency-Key": idempotencyKey(exactRunId, checkId),
    ...extra,
  });

  const collectAuditManifest = async () => {
    for (const [resourceKey, entityType] of AUDIT_RESOURCE_TYPES) {
      for (const entityId of state.createdIds[resourceKey]) {
        const query = new URLSearchParams({ entityType, entityId, limit: "500" });
        const result = await request(`/api/audit-logs?${query}`, { authenticated: true });
        expectedStatus(result, 200, `${entityType} audit manifest`);
        assertCheck(Array.isArray(result.body?.items), `${entityType} audit manifest is not a list`);
        for (const item of result.body.items) {
          rememberCreatedId("auditLogs", item?.id);
          assertCheck(typeof item?.id === "string" && item.id, "audit manifest entry is missing its id");
          assertCheck(item.entityType === entityType, "audit manifest returned the wrong entity type");
          assertCheck(item.entityId === entityId, "audit manifest returned the wrong entity id");
          assertCheck(item.actor === PRODUCTION_ACCOUNT, "audit manifest contains another actor");
        }
      }
    }
    return state.createdIds.auditLogs.size;
  };

  let sessionLogout = { status: "not_run" };
  let auditManifest = { status: "not_run" };
  let serverDataCleanup = { status: "failed", error: "authenticated smoke session was not established" };

  try {
    await execute("transport.stack-health", async () => {
      const frontend = await request("/_health", { timeoutMs: 20_000 });
      expectedStatus(frontend, 200, "frontend health");
      assertCheck(frontend.body?.status === "ok", "frontend health status is not ok");
      assertCheck(
        String(frontend.headers.get("content-security-policy") ?? "").includes("default-src 'self'"),
        "frontend Content-Security-Policy is missing",
      );
      assertCheck(
        /max-age=31536000/i.test(String(frontend.headers.get("strict-transport-security") ?? "")),
        "frontend Strict-Transport-Security is missing",
      );
      assertCheck(
        frontend.headers.get("x-content-type-options") === "nosniff",
        "frontend X-Content-Type-Options is missing",
      );
      assertCheck(
        String(frontend.headers.get("permissions-policy") ?? "").includes("microphone=(self)"),
        "frontend Permissions-Policy does not allow same-origin microphone access",
      );
      const backend = await request("/api/health", { timeoutMs: 20_000 });
      expectedStatus(backend, 200, "backend health");
      assertCheck(backend.body?.status === "ok", "backend health status is not ok");
      assertCheck(backend.body?.database === "ready", "production database is not ready");
      assertCheck(
        DATABASE_IDENTITY_PATTERN.test(String(backend.body?.databaseIdentity ?? "")),
        "production database identity is unavailable",
      );
      const localDatabaseIdentity = await verifyDatabaseIdentity();
      assertCheck(
        DATABASE_IDENTITY_PATTERN.test(String(localDatabaseIdentity ?? "")),
        "server-local database identity is unavailable",
      );
      assertCheck(
        localDatabaseIdentity === backend.body.databaseIdentity,
        "server-local database identity does not match the public backend",
      );
      state.databaseIdentity = localDatabaseIdentity;
      assertCheck(backend.body?.aiAnalysisMode === "model", "AI analysis is not in model mode");
      assertCheck(backend.body?.modelReady === true, "AI model is not ready");
      assertCheck(backend.body?.authEnabled === true, "production authentication is not enabled");
      preflightVerified = true;
      return {
        modelName: String(backend.body?.modelName ?? "unknown").slice(0, 100),
        securityHeaders: true,
      };
    });

    await execute("security.unauthorized-read", async () => {
      const result = await request("/api/customers");
      expectedStatus(result, 401, "unauthorized customer read");
      assertCheck(errorCode(result) === "UNAUTHORIZED", "unauthorized read returned the wrong error code");
      return { statusCode: result.status, code: errorCode(result) };
    });

    await execute("security.origin-rejection", async () => {
      const originProbe = "origin-probe";
      const result = await request("/api/auth/login", {
        method: "POST",
        requestOrigin: "https://invalid.example",
        body: { account: originProbe, password: originProbe },
      });
      expectedStatus(result, 403, "invalid origin login");
      assertCheck(errorCode(result) === "ORIGIN_NOT_ALLOWED", "invalid origin returned the wrong error code");
      return { statusCode: result.status, code: errorCode(result) };
    });

    await execute("auth.login-and-cookie", async () => {
      const result = await request("/api/auth/login", {
        method: "POST",
        body: { account: PRODUCTION_ACCOUNT, password },
      });
      const setCookie = String(result.headers.get("set-cookie") ?? "");
      const parsedCookie = parseSessionCookie(setCookie);
      if (parsedCookie) {
        state.cookieHeader = parsedCookie.header;
        state.sessionCookie = parsedCookie.value;
      }
      if (typeof result.body?.csrfToken === "string") state.csrfToken = result.body.csrfToken;

      expectedStatus(result, 200, "login");
      assertCheck(result.body?.account === PRODUCTION_ACCOUNT, "login returned the wrong account");
      assertCheck(Boolean(parsedCookie), "login did not return the expected session cookie");
      assertCheck(Boolean(state.csrfToken), "login did not return a CSRF token");
      assertCheck(/;\s*Path=\//i.test(setCookie), "session cookie is missing Path=/");
      assertCheck(/;\s*HttpOnly/i.test(setCookie), "session cookie is missing HttpOnly");
      assertCheck(/;\s*Secure/i.test(setCookie), "session cookie is missing Secure");
      assertCheck(/;\s*SameSite=Lax/i.test(setCookie), "session cookie is missing SameSite=Lax");
      assertCheck(/;\s*Max-Age=604800/i.test(setCookie), "session cookie is missing the seven-day Max-Age");
      const expiresInMs = Date.parse(result.body?.expiresAt) - startedAtValue.valueOf();
      assertCheck(
        expiresInMs > 6.9 * 24 * 60 * 60 * 1000 && expiresInMs <= 7.1 * 24 * 60 * 60 * 1000,
        "server session expiry is outside the seven-day tolerance",
      );
      return { statusCode: result.status, secureCookie: true, sevenDaySession: true };
    });

    await execute("auth.session-read", async () => {
      const result = await request("/api/auth/session", { authenticated: true });
      expectedStatus(result, 200, "session read");
      assertCheck(result.body?.account === PRODUCTION_ACCOUNT, "session returned the wrong account");
      assertCheck(result.body?.csrfToken === state.csrfToken, "session returned a different CSRF token");
      assertCheck(Date.parse(result.body?.expiresAt) > startedAtValue.valueOf(), "session is already expired");
      return { statusCode: result.status };
    });

    await execute("security.csrf-rejection", async () => {
      const result = await request("/api/customers", {
        method: "POST",
        authenticated: true,
        body: { name: `${marker} must not persist`, summary: marker },
      });
      expectedStatus(result, 403, "missing CSRF write");
      assertCheck(errorCode(result) === "CSRF_INVALID", "missing CSRF returned the wrong error code");
      return { statusCode: result.status, code: errorCode(result) };
    });

    await execute("business.initial-collections", async () => {
      const customers = await request("/api/customers", { authenticated: true });
      const opportunities = await request("/api/opportunities", { authenticated: true });
      expectedStatus(customers, 200, "initial customer list");
      expectedStatus(opportunities, 200, "initial opportunity list");
      assertCheck(Array.isArray(customers.body?.items), "initial customer list is invalid");
      assertCheck(Array.isArray(opportunities.body?.items), "initial opportunity list is invalid");
      state.initialCustomers = customers.body.items.length;
      state.initialOpportunities = opportunities.body.items.length;
      return { customers: state.initialCustomers, opportunities: state.initialOpportunities };
    });

    await execute("customer.create", async () => {
      const result = await request("/api/customers", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("customer.create"),
        body: {
          name: `${marker} production smoke customer`,
          region: "Shandong",
          type: "medical",
          level: "A",
          owner: PRODUCTION_ACCOUNT,
          contact: marker,
          summary: `${marker} isolated production smoke validation`,
        },
      });
      if (result.body?.item?.id) {
        state.customer = result.body.item;
        rememberCreatedId("customers", result.body.item.id);
      }
      expectedStatus(result, 201, "customer create");
      assertCheck(state.customer?.version === 1, "created customer does not start at version 1");
      assertCheck(String(state.customer?.name ?? "").includes(marker), "created customer lost its marker");
      return { statusCode: result.status, version: state.customer.version };
    });

    await execute("customer.read", async () => {
      const customer = requireState(state.customer, "created customer");
      const result = await request(`/api/customers/${encodeURIComponent(customer.id)}`, { authenticated: true });
      expectedStatus(result, 200, "customer read");
      assertCheck(result.body?.item?.id === customer.id, "customer read returned the wrong entity");
      return { statusCode: result.status };
    });

    await execute("customer.update", async () => {
      const customer = requireState(state.customer, "created customer");
      const result = await request(`/api/customers/${encodeURIComponent(customer.id)}`, {
        method: "PATCH",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("customer.update", { "If-Match": `"${customer.version}"` }),
        body: { level: "S", summary: `${marker} customer update passed` },
      });
      if (result.body?.item?.id === customer.id) state.customer = result.body.item;
      expectedStatus(result, 200, "customer update");
      assertCheck(state.customer?.version === 2, "updated customer did not advance to version 2");
      assertCheck(state.customer?.level === "S", "customer update was not persisted");
      return { statusCode: result.status, version: state.customer.version };
    });

    await execute("customer.optimistic-lock", async () => {
      const customer = requireState(state.customer, "updated customer");
      const result = await request(`/api/customers/${encodeURIComponent(customer.id)}`, {
        method: "PATCH",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("customer.optimistic-lock", { "If-Match": '"1"' }),
        body: { summary: `${marker} stale update must not persist` },
      });
      expectedStatus(result, 409, "stale customer update");
      assertCheck(errorCode(result) === "VERSION_CONFLICT", "stale update returned the wrong error code");
      assertCheck(result.body?.error?.fields?.currentVersion === 2, "stale update returned the wrong current version");
      return { statusCode: result.status, code: errorCode(result) };
    });

    await execute("opportunity.create", async () => {
      const customer = requireState(state.customer, "created customer");
      const result = await request("/api/opportunities", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("opportunity.create"),
        body: {
          customerId: customer.id,
          name: `${marker} production smoke opportunity`,
          stage: "qualification",
          amount: "100000",
          owner: PRODUCTION_ACCOUNT,
          probability: 35,
          sourceRecord: marker,
          risk: `${marker} budget and decision chain require validation`,
          next: `${marker} confirm the technical review`,
        },
      });
      if (result.body?.item?.id) {
        state.opportunity = result.body.item;
        rememberCreatedId("opportunities", result.body.item.id);
      }
      expectedStatus(result, 201, "opportunity create");
      assertCheck(state.opportunity?.customerId === customer.id, "opportunity has the wrong customer");
      assertCheck(state.opportunity?.version === 1, "created opportunity does not start at version 1");
      return { statusCode: result.status, version: state.opportunity.version };
    });

    await execute("opportunity.update", async () => {
      const opportunity = requireState(state.opportunity, "created opportunity");
      const result = await request(`/api/opportunities/${encodeURIComponent(opportunity.id)}`, {
        method: "PATCH",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("opportunity.update", { "If-Match": `"${opportunity.version}"` }),
        body: { probability: 45, next: `${marker} opportunity update passed` },
      });
      if (result.body?.item?.id === opportunity.id) state.opportunity = result.body.item;
      expectedStatus(result, 200, "opportunity update");
      assertCheck(state.opportunity?.version === 2, "updated opportunity did not advance to version 2");
      assertCheck(state.opportunity?.probability === 45, "opportunity update was not persisted");
      return { statusCode: result.status, version: state.opportunity.version };
    });

    await execute("quick-record.create", async () => {
      const customer = requireState(state.customer, "created customer");
      const opportunity = requireState(state.opportunity, "created opportunity");
      const result = await request("/api/quick-records", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("quick-record.create"),
        body: {
          rawContent: `${marker} Customer requested a technical review; budget owner and final decision maker remain unverified.`,
          occurredAt: "2099-01-02T10:00:00+08:00",
          sourceChannel: `${marker} production-smoke`,
          customerId: customer.id,
          opportunityId: opportunity.id,
        },
      });
      if (result.body?.item?.id) {
        state.quickRecord = result.body.item;
        rememberCreatedId("quickRecords", result.body.item.id);
      }
      expectedStatus(result, 201, "quick record create");
      assertCheck(state.quickRecord?.customerId === customer.id, "quick record has the wrong customer");
      assertCheck(state.quickRecord?.opportunityId === opportunity.id, "quick record has the wrong opportunity");
      return { statusCode: result.status };
    });

    await execute("quick-record.preview", async () => {
      const result = await request("/api/quick-records/preview", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("quick-record.preview"),
        body: { rawContent: `${marker} Preview only: validate budget owner and decision chain.` },
      });
      expectedStatus(result, 200, "quick record preview");
      assertCheck(result.body?.item?.source === "deepseek", "quick record preview did not use DeepSeek");
      assertCheck(Boolean(result.body?.item?.summary?.action?.text), "quick record preview has no action summary");
      return { statusCode: result.status, source: result.body.item.source };
    });

    await execute("quick-record.persisted-analysis", async () => {
      const quickRecord = requireState(state.quickRecord, "created quick record");
      const result = await request(`/api/quick-records/${encodeURIComponent(quickRecord.id)}/analyze`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("quick-record.persisted-analysis"),
      });
      rememberCreatedId("aiInsights", result.body?.item?.id);
      expectedStatus(result, 201, "persisted quick record analysis");
      assertCheck(result.body?.item?.source === "deepseek", "persisted analysis did not use DeepSeek");
      return { statusCode: result.status, source: result.body.item.source };
    });

    await execute("sales-decision.create", async () => {
      const opportunity = requireState(state.opportunity, "created opportunity");
      const quickRecord = requireState(state.quickRecord, "created quick record");
      const result = await request("/api/ai/sales-decisions", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("sales-decision.create"),
        body: {
          analysisType: "opportunity_diagnosis",
          industry: "medical",
          opportunityId: opportunity.id,
          quickRecordId: quickRecord.id,
          rawContent: `${marker} Diagnose the marked production smoke opportunity only.`,
        },
      });
      const analysis = result.body?.item?.analysis;
      rememberCreatedId("salesDecisions", result.body?.item?.id);
      expectedStatus(result, 201, "sales decision analysis");
      assertCheck(analysis?.source === "deepseek", "sales decision analysis did not use DeepSeek");
      assertCheck(analysis?.schemaVersion === "sales-decision-v1", "sales decision schema version is invalid");
      assertCheck(
        analysis?.writebackPreview?.requiresHumanConfirmation === true,
        "sales decision writeback is missing human confirmation",
      );
      return {
        statusCode: result.status,
        source: analysis.source,
        decision: analysis.decision?.code ?? null,
        score: analysis.score?.total ?? null,
      };
    });

    await execute("itinerary.create", async () => {
      const customer = requireState(state.customer, "created customer");
      const result = await request("/api/itineraries", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("itinerary.create"),
        timeoutMs: 120_000,
        body: {
          title: `${marker} Huangdao to Jining production smoke itinerary`,
          visitDate: "2099-01-02",
          status: "planned",
          departureAddress: "青岛市黄岛区秀兰禧悦山",
          departureCity: "青岛市",
          departureAt: "2099-01-02T08:00:00+08:00",
          stops: [
            {
              id: `stop-${exactRunId}`,
              customerId: customer.id,
              customerName: `${marker} 济宁市第二人民医院`,
              address: "济宁市第二人民医院",
              city: "济宁市",
              priority: "high",
              visitMinutes: 60,
              appointmentAt: "2099-01-02T13:30:00+08:00",
              notes: `${marker} isolated route validation`,
            },
          ],
        },
      });
      if (result.body?.item?.id) {
        state.itinerary = result.body.item;
        rememberCreatedId("itineraries", result.body.item.id);
      }
      expectedStatus(result, 201, "itinerary create");
      const route = state.itinerary?.plan?.route;
      assertCheck(route?.distanceMeters > 0, "itinerary route has no distance");
      assertCheck(route?.durationSeconds > 0, "itinerary route has no duration");
      assertCheck(Array.isArray(route?.polyline) && route.polyline.length > 1, "itinerary route has no polyline");
      return {
        statusCode: result.status,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
      };
    });

    await execute("itinerary.read", async () => {
      const itinerary = requireState(state.itinerary, "created itinerary");
      const result = await request(`/api/itineraries/${encodeURIComponent(itinerary.id)}`, { authenticated: true });
      expectedStatus(result, 200, "itinerary read");
      assertCheck(result.body?.item?.id === itinerary.id, "itinerary read returned the wrong entity");
      assertCheck(
        result.body?.item?.plan?.route?.distanceMeters === itinerary.plan.route.distanceMeters,
        "saved itinerary route changed during read",
      );
      return { statusCode: result.status };
    });

    await execute("weekly-report.create", async () => {
      const created = await request("/api/reports/weekly/draft", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("weekly-report.create"),
        body: {
          owner: runLabel,
          periodStart: "2099-01-01",
          periodEnd: "2099-01-07",
          knowledgeIds: [],
        },
      });
      if (created.body?.item?.id) {
        state.weekly = created.body.item;
        rememberCreatedId("weeklyReports", created.body.item.id);
      }
      expectedStatus(created, 201, "weekly draft create");
      assertCheck(state.weekly?.owner === runLabel, "weekly draft owner is not isolated by runId");
      assertCheck(state.weekly?.periodStart === "2099-01-01", "weekly draft period start is not isolated in 2099");
      assertCheck(state.weekly?.periodEnd === "2099-01-07", "weekly draft period end is not isolated in 2099");
      assertCheck(state.weekly?.status === "draft", "weekly report was not created as a draft");

      const markedContent = `${marker}\n${String(state.weekly.content ?? "").slice(0, 99_000)}`;
      const updated = await request(`/api/reports/weekly/${encodeURIComponent(state.weekly.id)}`, {
        method: "PATCH",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("weekly-report.marker", { "If-Match": `"${state.weekly.version}"` }),
        body: { content: markedContent, status: "draft" },
      });
      if (updated.body?.item?.id === state.weekly.id) state.weekly = updated.body.item;
      expectedStatus(updated, 200, "weekly marker update");
      assertCheck(String(state.weekly?.content ?? "").includes(marker), "weekly report content lost its cleanup marker");
      return { statusCode: created.status, markerStatusCode: updated.status, version: state.weekly.version };
    });

    await execute("integration.weixin-status", async () => {
      const result = await request("/api/integrations/weixin-agent/login", { authenticated: true });
      expectedStatus(result, 200, "Weixin binding status");
      assertCheck(typeof result.body?.item?.status === "string", "Weixin binding status is invalid");
      return { statusCode: result.status, bindingStatus: result.body.item.status.slice(0, 100) };
    });

    await execute("governance.audit-trail", async () => {
      const customer = requireState(state.customer, "created customer");
      const query = new URLSearchParams({ entityType: "customer", entityId: customer.id });
      const result = await request(`/api/audit-logs?${query}`, { authenticated: true });
      expectedStatus(result, 200, "customer audit trail");
      assertCheck(Array.isArray(result.body?.items), "audit trail is not a list");
      const actions = new Set(result.body.items.map((item) => item.action));
      assertCheck(actions.has("customer.create"), "audit trail is missing customer.create");
      assertCheck(actions.has("customer.update"), "audit trail is missing customer.update");
      return { statusCode: result.status, entries: result.body.items.length };
    });

    await execute("opportunity.soft-delete", async () => {
      const opportunity = requireState(state.opportunity, "updated opportunity");
      const result = await request(`/api/opportunities/${encodeURIComponent(opportunity.id)}`, {
        method: "DELETE",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("opportunity.soft-delete", { "If-Match": `"${opportunity.version}"` }),
      });
      expectedStatus(result, 200, "opportunity soft delete");
      assertCheck(result.body?.deleted?.id === opportunity.id, "opportunity delete returned the wrong entity");
      return { statusCode: result.status };
    });

    await execute("customer.soft-delete", async () => {
      const customer = requireState(state.customer, "updated customer");
      const result = await request(`/api/customers/${encodeURIComponent(customer.id)}`, {
        method: "DELETE",
        authenticated: true,
        csrfProtected: true,
        headers: writeHeaders("customer.soft-delete", { "If-Match": `"${customer.version}"` }),
      });
      expectedStatus(result, 200, "customer soft delete");
      assertCheck(result.body?.deleted?.id === customer.id, "customer delete returned the wrong entity");
      return { statusCode: result.status };
    });

    await execute("business.soft-delete-filtering", async () => {
      const initialCustomers = requireState(state.initialCustomers, "initial customer count");
      const initialOpportunities = requireState(state.initialOpportunities, "initial opportunity count");
      const customers = await request("/api/customers", { authenticated: true });
      const opportunities = await request("/api/opportunities", { authenticated: true });
      expectedStatus(customers, 200, "final customer list");
      expectedStatus(opportunities, 200, "final opportunity list");
      assertCheck(customers.body?.items?.length === initialCustomers, "soft-deleted customer remains visible");
      assertCheck(opportunities.body?.items?.length === initialOpportunities, "soft-deleted opportunity remains visible");
      return { customers: customers.body.items.length, opportunities: opportunities.body.items.length };
    });
  } finally {
    if (state.cookieHeader) {
      try {
        const entries = await collectAuditManifest();
        auditManifest = { status: "passed", entries };
      } catch (error) {
        auditManifest = {
          status: "failed",
          error: safeErrorMessage(error, [password, state.sessionCookie, state.csrfToken]),
        };
      }
    } else {
      auditManifest = { status: "failed", error: "authenticated session was unavailable for audit collection" };
    }

    if (state.cookieHeader && state.csrfToken) {
      try {
        const result = await request("/api/auth/logout", {
          method: "POST",
          authenticated: true,
          csrfProtected: true,
        });
        expectedStatus(result, 204, "session logout");
        sessionLogout = { status: "passed" };
      } catch (error) {
        sessionLogout = {
          status: "failed",
          error: safeErrorMessage(error, [password, state.sessionCookie, state.csrfToken]),
        };
      }
    } else {
      sessionLogout = { status: "failed", error: "authenticated session was unavailable for logout" };
    }

    if (state.sessionCookie) {
      try {
        serverDataCleanup = safeCleanupResult(
          await cleanup({
            runId: exactRunId,
            account: PRODUCTION_ACCOUNT,
            sessionCookie: state.sessionCookie,
            expectedDatabaseIdentity: requireState(
              state.databaseIdentity,
              "production database identity",
            ),
            createdIds: createdIdManifest(),
            idempotencyKeys: [...state.idempotencyKeys.values()],
          }),
          exactRunId,
          state.databaseIdentity,
        );
      } catch (error) {
        serverDataCleanup = {
          status: "failed",
          error: safeErrorMessage(error, [password, state.sessionCookie, state.csrfToken]),
        };
      }
    }
  }

  if (checks.length !== SMOKE_CHECK_IDS.length) {
    throw new Error(`Smoke runner produced ${checks.length} checks instead of ${SMOKE_CHECK_IDS.length}`);
  }
  const actualIds = checks.map((check) => check.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(SMOKE_CHECK_IDS)) {
    throw new Error("Smoke runner check order does not match the fixed 25-check contract");
  }

  const summary = reportSummary(checks);
  const cleanupStatus =
    auditManifest.status === "passed" &&
    sessionLogout.status === "passed" &&
    serverDataCleanup.status === "clean"
      ? "clean"
      : "failed";
  const finishedAtValue = now();
  const report = {
    schemaVersion: 1,
    runner: "sentelligent-production-https-smoke",
    runId: exactRunId,
    target: { origin: exactOrigin },
    startedAt: startedAtValue.toISOString(),
    finishedAt: finishedAtValue.toISOString(),
    status:
      summary.passed === 25 &&
      summary.failed === 0 &&
      summary.blocked === 0 &&
      cleanupStatus === "clean"
        ? "passed"
        : "failed",
    summary,
    checks,
    businessValidation: {
      mode: "isolated-write-and-physical-cleanup",
      marker,
      weeklyOwner: runLabel,
      weeklyPeriod: { start: "2099-01-01", end: "2099-01-07" },
    },
    cleanup: {
      status: cleanupStatus,
      auditManifest,
      sessionLogout,
      serverData: serverDataCleanup,
    },
  };

  const reportText = JSON.stringify(report);
  for (const secret of [password, state.sessionCookie, state.csrfToken]) {
    if (secret && reportText.includes(secret)) {
      throw new Error("Smoke report contains sensitive authentication material");
    }
  }
  atomicWriteJsonReport(reportPath, report);
  return report;
}

async function serverLocalSmokeCallbacks() {
  const databaseUrl = process.env.DATABASE_URL;
  const authSessionSecret = process.env.AUTH_SESSION_SECRET;
  if (!databaseUrl || !authSessionSecret) {
    throw new Error(
      "CLI production smoke requires server-local DATABASE_URL and AUTH_SESSION_SECRET before any network request",
    );
  }
  const { cleanupProductionSmokeRun, readProductionDatabaseIdentity } = await import(
    "../backend/scripts/production-smoke-cleanup.mjs"
  );
  return {
    verifyDatabaseIdentity: () => readProductionDatabaseIdentity({
      databaseUrl,
      authSessionSecret,
    }).databaseIdentity,
    cleanup: ({
      runId,
      account,
      sessionCookie,
      expectedDatabaseIdentity,
      createdIds,
      idempotencyKeys,
    }) => cleanupProductionSmokeRun({
      databaseUrl,
      runId,
      account,
      sessionCookie,
      authSessionSecret,
      expectedDatabaseIdentity,
      createdIds,
      idempotencyKeys,
    }),
  };
}

async function runCli() {
  try {
    const { origin, reportPath } = parseCliArguments(process.argv.slice(2));
    const { cleanup, verifyDatabaseIdentity } = await serverLocalSmokeCallbacks();
    const password = parsePasswordStdin(readFileSync(0, "utf8"));
    const report = await runSmoke({
      origin,
      reportPath,
      password,
      cleanup,
      verifyDatabaseIdentity,
    });
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      runId: report.runId,
      summary: report.summary,
      cleanup: report.cleanup.status,
      reportPath: resolve(reportPath),
    })}\n`);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Production HTTPS smoke failed: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

const directEntry = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (directEntry) await runCli();
