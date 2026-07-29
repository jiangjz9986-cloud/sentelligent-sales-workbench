import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  PRODUCTION_ORIGIN,
  REPORT_FILE_MODE,
  SMOKE_CHECK_IDS,
  atomicWriteJsonReport,
  parseCliArguments,
  parsePasswordStdin,
  parseProductionOrigin,
  runSmoke,
} from "./production-https-smoke.mjs";

const FIXTURE_PASSWORD = "fixture-login-password";
const FIXED_NOW = Date.parse("2026-07-29T04:30:00.000Z");
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const RUN_LABEL = `smoke:${RUN_ID}`;
const MARKER = `[${RUN_LABEL}]`;
const SESSION_TOKEN = "fixture-session-token-fixture-session-token";
const DATABASE_IDENTITY = "d".repeat(43);
const FIXTURE_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; media-src 'self' blob:; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "microphone=(self), geolocation=(self), camera=()",
};
const EXPECTED_CHECK_IDS = [
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
];

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
  });
}

function createHappyFetch({
  throwPath,
  redirectPath,
  logoutStatus = 204,
  initialCollectionSize = 1,
  includeSecurityHeaders = true,
} = {}) {
  const requests = [];
  let customerDeleted = false;
  let opportunityDeleted = false;
  let customerUpdated = false;

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers);
    const request = {
      url,
      method,
      headers,
      body: options.body,
      redirect: options.redirect,
    };
    requests.push(request);

    if (url.pathname === throwPath) throw new Error("fixture transport failure");
    if (url.pathname === redirectPath) {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://redirect.invalid/" },
      });
    }

    const cookie = headers.get("Cookie");
    const authenticated = cookie === `sentelligent_session=${SESSION_TOKEN}`;
    const csrf = headers.get("X-CSRF-Token");
    const body = options.body ? JSON.parse(String(options.body)) : null;

    if (method === "GET" && url.pathname === "/_health") {
      return jsonResponse({
        status: "ok",
        apiBaseUrl: PRODUCTION_ORIGIN,
        distPath: "/opt/sentelligent-sales-workbench/current/dist",
      }, 200, includeSecurityHeaders ? FIXTURE_SECURITY_HEADERS : {});
    }
    if (method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({
        status: "ok",
        database: "ready",
        databaseIdentity: DATABASE_IDENTITY,
        aiAnalysisMode: "model",
        modelProvider: "deepseek",
        modelName: "DeepSeek-V4-Flash",
        modelReady: true,
        authEnabled: true,
      }, 200, includeSecurityHeaders ? FIXTURE_SECURITY_HEADERS : {});
    }
    if (method === "POST" && url.pathname === "/api/auth/login") {
      if (headers.get("Origin") !== PRODUCTION_ORIGIN) {
        return jsonResponse({ error: { code: "ORIGIN_NOT_ALLOWED" } }, 403);
      }
      assert.deepEqual(body, { account: "jiangjz", password: FIXTURE_PASSWORD });
      return jsonResponse({
        account: "jiangjz",
        displayName: "jiangjz",
        csrfToken: "fixture-csrf",
        expiresAt: new Date(FIXED_NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }, 200, {
        "Set-Cookie": [
          `sentelligent_session=${SESSION_TOKEN}`,
          "Path=/",
          "Max-Age=604800",
          "HttpOnly",
          "Secure",
          "SameSite=Lax",
        ].join("; "),
      });
    }
    if (method === "GET" && url.pathname === "/api/customers" && !authenticated) {
      return jsonResponse({ error: { code: "UNAUTHORIZED" } }, 401);
    }
    if (method === "POST" && url.pathname === "/api/customers" && csrf === null) {
      assert.ok(JSON.stringify(body).includes(MARKER));
      return jsonResponse({ error: { code: "CSRF_INVALID" } }, 403);
    }
    if (method === "POST" && url.pathname === "/api/auth/logout") {
      assert.equal(authenticated, true);
      assert.equal(csrf, "fixture-csrf");
      return jsonResponse(null, logoutStatus, {
        "Set-Cookie": "sentelligent_session=; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      });
    }
    if (!authenticated) return jsonResponse({ error: { code: "UNAUTHORIZED" } }, 401);

    if (method === "GET" && url.pathname === "/api/auth/session") {
      return jsonResponse({
        account: "jiangjz",
        displayName: "jiangjz",
        csrfToken: "fixture-csrf",
        expiresAt: new Date(FIXED_NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
    if (method === "GET" && url.pathname === "/api/customers") {
      return jsonResponse({
        items: Array.from({ length: initialCollectionSize }, (_, index) => ({
          id: `existing-customer-${index}`,
        })),
      });
    }
    if (method === "GET" && url.pathname === "/api/opportunities") {
      return jsonResponse({
        items: Array.from({ length: initialCollectionSize }, (_, index) => ({
          id: `existing-opportunity-${index}`,
        })),
      });
    }
    if (method === "POST" && url.pathname === "/api/customers") {
      return jsonResponse({ item: { id: "smoke-customer", version: 1, ...body } }, 201);
    }
    if (method === "GET" && url.pathname === "/api/customers/smoke-customer") {
      return jsonResponse({ item: { id: "smoke-customer", version: customerUpdated ? 2 : 1, name: `${MARKER} customer` } });
    }
    if (method === "PATCH" && url.pathname === "/api/customers/smoke-customer") {
      if (customerUpdated) {
        return jsonResponse({
          error: { code: "VERSION_CONFLICT", fields: { currentVersion: 2 } },
        }, 409);
      }
      customerUpdated = true;
      return jsonResponse({ item: { id: "smoke-customer", version: 2, level: "S", ...body } });
    }
    if (method === "POST" && url.pathname === "/api/opportunities") {
      return jsonResponse({ item: { id: "smoke-opportunity", version: 1, ...body } }, 201);
    }
    if (method === "PATCH" && url.pathname === "/api/opportunities/smoke-opportunity") {
      return jsonResponse({ item: { id: "smoke-opportunity", version: 2, ...body } });
    }
    if (method === "POST" && url.pathname === "/api/quick-records") {
      return jsonResponse({ item: { id: "smoke-record", version: 1, status: "draft", ...body } }, 201);
    }
    if (method === "POST" && url.pathname === "/api/quick-records/preview") {
      return jsonResponse({
        item: {
          id: "preview-fixture",
          quickRecordId: "preview",
          source: "deepseek",
          confidence: 90,
          summary: { action: { text: "Confirm the decision chain." } },
        },
      });
    }
    if (method === "POST" && url.pathname === "/api/quick-records/smoke-record/analyze") {
      return jsonResponse({
        item: {
          id: "smoke-insight",
          quickRecordId: "smoke-record",
          source: "deepseek",
          confidence: 90,
          summary: { action: { text: "Confirm the decision chain." } },
        },
      }, 201);
    }
    if (method === "POST" && url.pathname === "/api/ai/sales-decisions") {
      return jsonResponse({
        item: {
          id: "smoke-decision",
          analysis: {
            source: "deepseek",
            schemaVersion: "sales-decision-v1",
            decision: { code: "validate" },
            score: { total: 72 },
            writebackPreview: { requiresHumanConfirmation: true },
          },
        },
      }, 201);
    }
    if (method === "POST" && url.pathname === "/api/itineraries") {
      return jsonResponse({
        item: {
          id: "smoke-itinerary",
          version: 1,
          ...body,
          plan: {
            route: {
              distanceMeters: 379100,
              durationSeconds: 15360,
              polyline: [[120.149201, 35.987754], [116.608817, 35.415405]],
            },
            optimization: { source: "deterministic" },
          },
        },
      }, 201);
    }
    if (method === "GET" && url.pathname === "/api/itineraries/smoke-itinerary") {
      return jsonResponse({
        item: {
          id: "smoke-itinerary",
          plan: { route: { distanceMeters: 379100 } },
        },
      });
    }
    if (method === "POST" && url.pathname === "/api/reports/weekly/draft") {
      return jsonResponse({
        item: {
          id: "smoke-weekly",
          version: 1,
          status: "draft",
          owner: body.owner,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          content: `${MARKER} isolated weekly report content for smoke validation.`,
        },
      }, 201);
    }
    if (method === "PATCH" && url.pathname === "/api/reports/weekly/smoke-weekly") {
      return jsonResponse({
        item: {
          id: "smoke-weekly",
          version: 2,
          owner: RUN_LABEL,
          periodStart: "2099-01-01",
          periodEnd: "2099-01-07",
          ...body,
        },
      });
    }
    if (method === "GET" && url.pathname === "/api/integrations/weixin-agent/login") {
      return jsonResponse({ item: { status: "logged_in" } });
    }
    if (method === "GET" && url.pathname === "/api/audit-logs") {
      const entityType = url.searchParams.get("entityType");
      const entityId = url.searchParams.get("entityId");
      const byEntity = {
        "customer:smoke-customer": [
          { id: "audit-customer-create", action: "customer.create" },
          { id: "audit-customer-update", action: "customer.update" },
          ...(customerDeleted ? [{ id: "audit-customer-delete", action: "customer.delete" }] : []),
        ],
        "opportunity:smoke-opportunity": [
          { id: "audit-opportunity-create", action: "opportunity.create" },
          { id: "audit-opportunity-update", action: "opportunity.update" },
          ...(opportunityDeleted ? [{ id: "audit-opportunity-delete", action: "opportunity.delete" }] : []),
        ],
        "quick_record:smoke-record": [
          { id: "audit-quick-record-create", action: "quick_record.create" },
          { id: "audit-quick-record-analyze", action: "quick_record.analyze" },
        ],
        "sales_decision_analysis:smoke-decision": [
          { id: "audit-sales-decision-create", action: "sales_decision_analysis.create" },
        ],
        "visit_itinerary:smoke-itinerary": [
          { id: "audit-itinerary-create", action: "visit_itinerary.create" },
        ],
        "weekly_report:smoke-weekly": [
          { id: "audit-weekly-create", action: "weekly_report.draft" },
          { id: "audit-weekly-update", action: "weekly_report.update" },
        ],
      };
      return jsonResponse({
        items: (byEntity[`${entityType}:${entityId}`] ?? []).map((item) => ({
          ...item,
          entityType,
          entityId,
          actor: "jiangjz",
        })),
      });
    }
    if (method === "DELETE" && url.pathname === "/api/opportunities/smoke-opportunity") {
      opportunityDeleted = true;
      return jsonResponse({ deleted: { id: "smoke-opportunity", version: 3 } });
    }
    if (method === "DELETE" && url.pathname === "/api/customers/smoke-customer") {
      customerDeleted = true;
      return jsonResponse({ deleted: { id: "smoke-customer", version: 3 } });
    }

    throw new Error(`Unexpected fixture request: ${method} ${url.pathname}${url.search}`);
  };

  return { fetchImpl, requests };
}

function cleanResult(overrides = {}) {
  return {
    status: "clean",
    runId: RUN_ID,
    databaseIdentity: DATABASE_IDENTITY,
    databasePath: "/secret/production.sqlite",
    deleted: {
      customers: 1,
      opportunities: 1,
      quickRecords: 1,
      aiInsights: 1,
      salesDecisions: 1,
      itineraries: 1,
      weeklyReports: 1,
      auditLogs: 1,
      authSessions: 1,
      idempotencyKeys: 1,
    },
    residual: {
      customers: 0,
      opportunities: 0,
      quickRecords: 0,
      aiInsights: 0,
      salesDecisions: 0,
      itineraries: 0,
      weeklyReports: 0,
      auditLogs: 0,
      authSessions: 0,
      idempotencyKeys: 0,
    },
    integrity: { quickCheck: "ok", foreignKeyViolations: 0 },
    ...overrides,
  };
}

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "sentelligent-production-smoke-"));
  return {
    root,
    reportPath: join(root, "report.json"),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("production HTTPS smoke target and credential boundary", () => {
  it("accepts only the exact production HTTPS origin", () => {
    assert.equal(parseProductionOrigin(PRODUCTION_ORIGIN), PRODUCTION_ORIGIN);

    for (const value of [
      "http://82.156.210.199",
      "https://82.156.210.199/",
      "https://82.156.210.199:443",
      "https://82.156.210.199:8443",
      "https://82.156.210.199/api",
      "https://82.156.210.199?query=1",
      "https://82.156.210.199#fragment",
      "https://user@82.156.210.199",
      "https://82.156.210.199.example.test",
      " https://82.156.210.199",
    ]) {
      assert.throws(() => parseProductionOrigin(value), /exact production HTTPS origin/i);
    }
  });

  it("requires origin and report CLI arguments and rejects password arguments", () => {
    assert.deepEqual(
      parseCliArguments([
        `--origin=${PRODUCTION_ORIGIN}`,
        "--report=.runtime/smoke/report.json",
      ]),
      {
        origin: PRODUCTION_ORIGIN,
        reportPath: ".runtime/smoke/report.json",
      },
    );

    assert.throws(() => parseCliArguments([]), /origin/i);
    assert.throws(
      () => parseCliArguments([`--origin=${PRODUCTION_ORIGIN}`]),
      /report/i,
    );
    assert.throws(
      () => parseCliArguments([
        `--origin=${PRODUCTION_ORIGIN}`,
        "--report=report.json",
        `--password=${FIXTURE_PASSWORD}`,
      ]),
      /stdin/i,
    );
  });

  it("accepts the login password only from strict JSON stdin", () => {
    assert.equal(
      parsePasswordStdin(JSON.stringify({ password: FIXTURE_PASSWORD })),
      FIXTURE_PASSWORD,
    );
    assert.throws(() => parsePasswordStdin(""), /stdin/i);
    assert.throws(() => parsePasswordStdin(FIXTURE_PASSWORD), /JSON/i);
    assert.throws(() => parsePasswordStdin('{"password":""}'), /password/i);
    assert.throws(
      () => parsePasswordStdin(JSON.stringify({ password: FIXTURE_PASSWORD, extra: true })),
      /only.*password/i,
    );
  });

  it("never reads a login password from the process environment", () => {
    const source = readFileSync(
      new URL("./production-https-smoke.mjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /process\.env\.[A-Z0-9_]*PASSWORD/iu);
  });
});

describe("production HTTPS smoke report", () => {
  it("locks the result checklist to exactly 25 stable IDs", () => {
    assert.equal(SMOKE_CHECK_IDS.length, 25);
    assert.deepEqual([...SMOKE_CHECK_IDS], EXPECTED_CHECK_IDS);
    assert.equal(new Set(SMOKE_CHECK_IDS).size, 25);
  });

  it("writes a new JSON report atomically without leaving temporary files", () => {
    const workspace = makeWorkspace();
    try {
      assert.equal(REPORT_FILE_MODE, 0o600);
      atomicWriteJsonReport(workspace.reportPath, { status: "passed" });

      assert.equal(existsSync(workspace.reportPath), true);
      assert.deepEqual(JSON.parse(readFileSync(workspace.reportPath, "utf8")), {
        status: "passed",
      });
      assert.deepEqual(readdirSync(workspace.root), ["report.json"]);
      if (process.platform !== "win32") {
        assert.equal(statSync(workspace.reportPath).mode & 0o777, 0o600);
      }
    } finally {
      workspace.cleanup();
    }
  });

  it("never overwrites an existing report", () => {
    const workspace = makeWorkspace();
    try {
      writeFileSync(workspace.reportPath, "existing evidence\n", "utf8");
      assert.throws(
        () => atomicWriteJsonReport(workspace.reportPath, { status: "passed" }),
        /already exists/i,
      );
      assert.equal(readFileSync(workspace.reportPath, "utf8"), "existing evidence\n");
    } finally {
      workspace.cleanup();
    }
  });
});

describe("production HTTPS smoke execution", () => {
  it("runs the isolated 25 checks and physically cleans the marked run in finally", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch();
    const cleanupCalls = [];
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async (context) => {
          cleanupCalls.push(context);
          return cleanResult();
        },
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.status, "passed");
      assert.deepEqual(report.summary, { total: 25, passed: 25, failed: 0, blocked: 0 });
      assert.deepEqual(report.checks.map((check) => check.id), EXPECTED_CHECK_IDS);
      assert.ok(report.checks.every((check) => check.status === "passed"));
      assert.equal(report.businessValidation.mode, "isolated-write-and-physical-cleanup");
      assert.equal(report.businessValidation.marker, MARKER);
      assert.equal(report.cleanup.status, "clean");
      assert.equal(report.cleanup.sessionLogout.status, "passed");
      assert.equal(report.cleanup.serverData.status, "clean");
      assert.equal(report.cleanup.serverData.integrity.quickCheck, "ok");
      assert.equal(Object.hasOwn(report.cleanup.serverData, "databasePath"), false);

      assert.equal(cleanupCalls.length, 1);
      assert.equal(cleanupCalls[0].runId, RUN_ID);
      assert.equal(cleanupCalls[0].account, "jiangjz");
      assert.equal(cleanupCalls[0].sessionCookie, SESSION_TOKEN);
      assert.equal(cleanupCalls[0].expectedDatabaseIdentity, DATABASE_IDENTITY);
      assert.deepEqual(cleanupCalls[0].createdIds, {
        customers: ["smoke-customer"],
        opportunities: ["smoke-opportunity"],
        quickRecords: ["smoke-record"],
        aiInsights: ["smoke-insight"],
        salesDecisions: ["smoke-decision"],
        itineraries: ["smoke-itinerary"],
        weeklyReports: ["smoke-weekly"],
        auditLogs: [
          "audit-customer-create",
          "audit-customer-update",
          "audit-customer-delete",
          "audit-opportunity-create",
          "audit-opportunity-update",
          "audit-opportunity-delete",
          "audit-quick-record-create",
          "audit-quick-record-analyze",
          "audit-sales-decision-create",
          "audit-itinerary-create",
          "audit-weekly-create",
          "audit-weekly-update",
        ],
      });
      assert.deepEqual(
        cleanupCalls[0].idempotencyKeys.map((entry) => entry.key),
        [
          "customer.create",
          "customer.update",
          "customer.optimistic-lock",
          "opportunity.create",
          "opportunity.update",
          "quick-record.create",
          "quick-record.preview",
          "quick-record.persisted-analysis",
          "sales-decision.create",
          "itinerary.create",
          "weekly-report.create",
          "weekly-report.marker",
          "opportunity.soft-delete",
          "customer.soft-delete",
        ].map((id) => `${RUN_LABEL}:${id}`),
      );
      assert.ok(cleanupCalls[0].idempotencyKeys.every((entry) =>
        entry.actor === "jiangjz" &&
        ["POST", "PATCH", "DELETE"].includes(entry.method) &&
        entry.requestPath.startsWith("/api/")
      ));

      assert.ok(fixture.requests.length > 0);
      assert.ok(fixture.requests.every((request) => request.redirect === "manual"));
      assert.ok(fixture.requests.every((request) => request.url.origin === PRODUCTION_ORIGIN));
      assert.equal(fixture.requests.at(-1).url.pathname, "/api/auth/logout");

      const persistentRequests = fixture.requests.filter((request) => {
        if (!["POST", "PATCH", "DELETE"].includes(request.method)) return false;
        if (["/api/auth/login", "/api/auth/logout"].includes(request.url.pathname)) return false;
        if (request.url.pathname === "/api/customers" && !request.headers.has("X-CSRF-Token")) return false;
        return request.url.pathname !== "/api/quick-records/preview";
      });
      for (const request of persistentRequests) {
        const bodyText = String(request.body ?? "");
        const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
        assert.ok(
          bodyText.includes(MARKER) ||
            bodyText.includes(RUN_LABEL) ||
            idempotencyKey.includes(RUN_LABEL),
          `${request.method} ${request.url.pathname} is missing its smoke marker`,
        );
      }

      const weekly = fixture.requests.find(
        (request) => request.method === "POST" && request.url.pathname === "/api/reports/weekly/draft",
      );
      assert.deepEqual(JSON.parse(weekly.body), {
        owner: RUN_LABEL,
        periodStart: "2099-01-01",
        periodEnd: "2099-01-07",
        knowledgeIds: [],
      });
      const weeklyMarkerPatch = fixture.requests.find(
        (request) => request.method === "PATCH" && request.url.pathname === "/api/reports/weekly/smoke-weekly",
      );
      assert.ok(JSON.parse(weeklyMarkerPatch.body).content.includes(MARKER));

      const reportText = readFileSync(workspace.reportPath, "utf8");
      assert.ok(!reportText.includes(FIXTURE_PASSWORD));
      assert.ok(!reportText.includes(SESSION_TOKEN));
      assert.ok(!reportText.includes("fixture-csrf"));
      assert.deepEqual(JSON.parse(reportText), report);
    } finally {
      workspace.cleanup();
    }
  });

  it("still logs out and cleans in finally while preserving all 25 results after a check throws", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch({ throwPath: "/api/quick-records/smoke-record/analyze" });
    const cleanupCalls = [];
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async (context) => {
          cleanupCalls.push(context);
          return cleanResult();
        },
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.status, "failed");
      assert.equal(report.checks.length, 25);
      assert.equal(
        report.checks.find((check) => check.id === "quick-record.persisted-analysis")?.status,
        "failed",
      );
      assert.equal(report.cleanup.status, "clean");
      assert.equal(cleanupCalls.length, 1);
      assert.ok(
        fixture.requests.some(
          (request) => request.method === "POST" && request.url.pathname === "/api/auth/logout",
        ),
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("accepts empty initial customer and opportunity collections", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch({ initialCollectionSize: 0 });
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async () => cleanResult(),
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.status, "passed");
      assert.equal(
        report.checks.find((check) => check.id === "business.soft-delete-filtering")?.status,
        "passed",
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects redirect responses instead of following them", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch({ redirectPath: "/_health" });
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async () => cleanResult(),
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.status, "failed");
      assert.equal(
        report.checks.find((check) => check.id === "transport.stack-health")?.status,
        "failed",
      );
      assert.ok(fixture.requests.every((request) => request.redirect === "manual"));
      assert.ok(fixture.requests.every((request) => request.url.origin === PRODUCTION_ORIGIN));
    } finally {
      workspace.cleanup();
    }
  });

  it("blocks authentication and business writes when the server-local database identity differs", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch();
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        cleanup: async () => cleanResult(),
        verifyDatabaseIdentity: async () => "e".repeat(43),
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.status, "failed");
      assert.equal(
        report.checks.find((check) => check.id === "transport.stack-health")?.status,
        "failed",
      );
      assert.deepEqual(
        fixture.requests.map((request) => [request.method, request.url.pathname]),
        [["GET", "/_health"], ["GET", "/api/health"]],
      );
      assert.equal(report.summary.blocked, 24);
    } finally {
      workspace.cleanup();
    }
  });

  it("fails when production frontend security headers are missing", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch({ includeSecurityHeaders: false });
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async () => cleanResult(),
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(
        report.checks.find((check) => check.id === "transport.stack-health")?.status,
        "failed",
      );
      assert.equal(report.status, "failed");
    } finally {
      workspace.cleanup();
    }
  });

  it("fails overall when server cleanup is not clean", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch();
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async () => ({ status: "failed", residual: { customers: 1 } }),
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.summary.passed, 25);
      assert.equal(report.cleanup.status, "failed");
      assert.equal(report.cleanup.serverData.status, "failed");
      assert.equal(report.status, "failed");
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects cleanup evidence for a different smoke run", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch();
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async () => cleanResult({
          runId: "22222222-2222-4222-8222-222222222222",
        }),
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.summary.passed, 25);
      assert.equal(report.cleanup.serverData.status, "failed");
      assert.equal(report.cleanup.status, "failed");
      assert.equal(report.status, "failed");
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects cleanup evidence from a different database identity", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch();
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async () => cleanResult({
          databaseIdentity: "e".repeat(43),
        }),
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.summary.passed, 25);
      assert.equal(report.cleanup.serverData.status, "failed");
      assert.equal(report.cleanup.status, "failed");
      assert.equal(report.status, "failed");
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects cleanup evidence with a missing residual counter", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch();
    const incompleteResidual = { ...cleanResult().residual };
    delete incompleteResidual.auditLogs;
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async () => cleanResult({ residual: incompleteResidual }),
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.summary.passed, 25);
      assert.equal(report.cleanup.serverData.status, "failed");
      assert.equal(report.cleanup.status, "failed");
      assert.equal(report.status, "failed");
    } finally {
      workspace.cleanup();
    }
  });

  it("still performs server cleanup when logout fails", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch({ logoutStatus: 500 });
    const cleanupCalls = [];
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async (context) => {
          cleanupCalls.push(context);
          return cleanResult();
        },
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(cleanupCalls.length, 1);
      assert.equal(report.cleanup.sessionLogout.status, "failed");
      assert.equal(report.cleanup.serverData.status, "clean");
      assert.equal(report.cleanup.status, "failed");
      assert.equal(report.status, "failed");
    } finally {
      workspace.cleanup();
    }
  });

  it("fails cleanup when the exact audit id manifest cannot be collected", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch({ throwPath: "/api/audit-logs" });
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async () => cleanResult(),
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.cleanup.auditManifest.status, "failed");
      assert.equal(report.cleanup.serverData.status, "clean");
      assert.equal(report.cleanup.status, "failed");
      assert.equal(report.status, "failed");
    } finally {
      workspace.cleanup();
    }
  });

  it("redacts authentication material from cleanup errors and the JSON report", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch();
    try {
      const report = await runSmoke({
        origin: PRODUCTION_ORIGIN,
        password: FIXTURE_PASSWORD,
        reportPath: workspace.reportPath,
        fetchImpl: fixture.fetchImpl,
        verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
        cleanup: async () => {
          throw new Error(`cleanup ${FIXTURE_PASSWORD} ${SESSION_TOKEN} fixture-csrf`);
        },
        runId: RUN_ID,
        now: () => new Date(FIXED_NOW),
      });

      assert.equal(report.status, "failed");
      const reportText = readFileSync(workspace.reportPath, "utf8");
      for (const secret of [FIXTURE_PASSWORD, SESSION_TOKEN, "fixture-csrf"]) {
        assert.equal(reportText.includes(secret), false);
      }
      assert.match(report.cleanup.serverData.error, /\[redacted\]/i);
    } finally {
      workspace.cleanup();
    }
  });

  it("requires a cleanup callback before making any network request", async () => {
    const workspace = makeWorkspace();
    const fixture = createHappyFetch();
    try {
      await assert.rejects(
        () => runSmoke({
          origin: PRODUCTION_ORIGIN,
          password: FIXTURE_PASSWORD,
          reportPath: workspace.reportPath,
          fetchImpl: fixture.fetchImpl,
          verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
          runId: RUN_ID,
          now: () => new Date(FIXED_NOW),
        }),
        /cleanup callback/i,
      );
      assert.equal(fixture.requests.length, 0);
      assert.equal(existsSync(workspace.reportPath), false);
    } finally {
      workspace.cleanup();
    }
  });
});
