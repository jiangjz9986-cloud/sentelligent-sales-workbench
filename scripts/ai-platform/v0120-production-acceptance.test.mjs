import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  parseCliArguments,
  runV0120ProductionAcceptance,
  collectManifestFromDb,
} from "./v0120-production-acceptance.mjs";
import { createServer } from "../../backend/src/server.js";
import { hashPassword } from "../../backend/src/auth/password.js";
import { readProductionDatabaseIdentity } from "../../backend/scripts/production-smoke-cleanup.mjs";
import { cleanupV0120ProductionAcceptance } from "../../backend/scripts/v0120-production-acceptance-cleanup.mjs";
import { openDatabase } from "../../backend/src/db.js";
import { PRODUCTION_ORIGIN, parseProductionOrigin } from "../production-https-smoke.mjs";

const OWNER = "jiangjz";
const PASSWORD = "fixture-production-password";
const MACHINE_TOKEN = "fixture-machine-token";
const OPS_TOKEN = "fixture-ops-status-token";
const TEST_SESSION_VALUE = "fixture-session-secret-placeholder-value";
const DATABASE_IDENTITY = "d".repeat(43);
const SESSION_COOKIE = "s".repeat(43);
const CSRF_TOKEN = "fixture-csrf-token";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const temporaryDirectories = [];

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
  });
}

function fixtureManifest(state) {
  return {
    schemaVersion: 1,
    runId: state.runId,
    owner: state.owner,
    databaseIdentity: DATABASE_IDENTITY,
    sessionCookie: SESSION_COOKIE,
    customerIds: [...new Set(state.customerIds)],
    importBatchIds: [...new Set(state.importBatchIds)],
    importRowIds: [...new Set(state.importRowIds)],
    opportunityIds: [...new Set(state.opportunityIds)],
    quickRecordIds: [],
    solutionDraftIds: [],
    actionIds: [...new Set(state.actionIds)],
    riskIds: [...new Set(state.riskIds)],
    noticeIds: [...new Set(state.noticeIds)],
    canonicalNoticeIds: [...new Set(state.canonicalNoticeIds)],
    snapshotIds: [...new Set(state.snapshotIds)],
    bridgeIds: [...new Set(state.bridgeIds)],
    suggestionIds: [...new Set(state.suggestionIds)],
    subjectIds: [...new Set(state.subjectIds)],
    confirmationPreviewIds: [...new Set(state.confirmationPreviewIds)],
    notificationIds: [],
    outboxIds: [],
    auditIds: [],
    idempotencyKeys: [...state.idempotencyKeys.values()],
  };
}

function createFakeProductionFetch({ cleanupMode = "clean" } = {}) {
  const marker = `[v0.12:${RUN_ID}]`;
  const requests = [];
  const ids = {
    csvBatch: "fixture-csv-batch",
    csvRow: "fixture-csv-row",
    csvCustomer: "fixture-csv-customer",
    xlsxBatch: "fixture-xlsx-batch",
    xlsxRow: "fixture-xlsx-row",
    opportunity: "fixture-opportunity",
    tenderNotice: "fixture-tender-notice",
    canonicalNotice: "fixture-canonical-notice",
    tenderOpportunity: "fixture-tender-opportunity",
    tenderAction: "fixture-tender-action",
    tenderBridge: "fixture-tender-bridge",
    fixtureRisk: "fixture-seeded-risk",
    subject: "fixture-subject",
    actionSuggestion: "fixture-action-suggestion",
    riskSuggestion: "fixture-risk-suggestion",
    actionPreview: "fixture-action-preview",
    riskPreview: "fixture-risk-preview",
    actionWriteback: "fixture-action-writeback",
    riskWriteback: "fixture-risk-writeback",
  };
  let tenderPreviewCount = 0;
  let tenderConfirmed = false;
  let csvConfirmed = false;
  const batches = new Map();
  const confirmations = new Map();
  const reviewedFields = new Map();

  const suggestion = (id, trigger) => ({
    id,
    version: 1,
    customerId: ids.csvCustomer,
    opportunityId: ids.opportunity,
    trigger: { type: trigger },
  });

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method ?? "GET").toUpperCase();
    requests.push({ url, method, headers: new Headers(options.headers), body: options.body });
    const jsonBody = typeof options.body === "string" ? JSON.parse(options.body) : null;
    const file = options.body instanceof FormData ? options.body.get("file") : null;
    const fileName = typeof file?.name === "string" ? file.name : "";

    if (url.pathname === "/api/health" && method === "GET") {
      return jsonResponse({ status: "ok", database: "ready", databaseIdentity: DATABASE_IDENTITY });
    }
    if (url.pathname === "/api/auth/login" && method === "POST") {
      assert.deepEqual(jsonBody, { account: OWNER, password: PASSWORD });
      return jsonResponse({ account: OWNER, csrfToken: CSRF_TOKEN }, 200, {
        "Set-Cookie": `sentelligent_session=${SESSION_COOKIE}; Path=/; HttpOnly`,
      });
    }
    if (url.pathname === "/api/auth/logout" && method === "POST") return new Response(null, { status: 204 });
    if (url.pathname === "/api/assistant/proactive/status") return jsonResponse({ item: {
      running: false, ticking: false, notificationScheduler: { running: false, ticking: false },
    } });
    if (url.pathname === "/api/integrations/ops-alerts/status") return jsonResponse({ item: {
      schedulers: Object.fromEntries(["actionReminders", "invoiceEscalation", "dailyDigest", "proactiveNotifications"].map((name) => [name, { running: false, ticking: false }])),
    } });

    if (url.pathname === "/api/customer-imports/preview" && method === "POST") {
      const xlsx = fileName.endsWith(".xlsx");
      const suffix = fileName.includes("cancel-customers") ? "-cancel" : "";
      const batchId = `${xlsx ? ids.xlsxBatch : ids.csvBatch}${suffix}`;
      const rowId = `${xlsx ? ids.xlsxRow : ids.csvRow}${suffix}`;
      const item = {
          customerImportBatch: { id: batchId, owner: OWNER, status: "preview", fileSha256: `${xlsx ? "b" : "a"}`.repeat(64) },
          customerImportRows: [{ id: rowId, action: "create", customerId: null }],
          previewDigest: `${xlsx ? "e" : "c"}`.repeat(64),
      };
      batches.set(batchId, item);
      return jsonResponse({ item }, 201);
    }
    const importMatch = url.pathname.match(/^\/api\/customer-imports\/([^/]+)\/(confirm|cancel)$/u);
    if (importMatch && method === "POST") {
      const item = batches.get(importMatch[1]);
      const operation = importMatch[2];
      if (jsonBody?.previewDigest === "0".repeat(64) || jsonBody?.fileSha256 === "f".repeat(64)) {
        return jsonResponse({ error: { code: "PREVIEW_DIGEST_MISMATCH" } }, 409);
      }
      const finalStatus = operation === "confirm" ? "committed" : "cancelled";
      if (item.customerImportBatch.status !== "preview" && item.customerImportBatch.status !== finalStatus) {
        return jsonResponse({ error: { code: "CUSTOMER_IMPORT_STATE_CONFLICT" } }, 409);
      }
      const replayed = item.customerImportBatch.status === finalStatus;
      item.customerImportBatch.status = finalStatus;
      if (operation === "confirm") item.customerImportRows[0].customerId = importMatch[1] === ids.csvBatch ? ids.csvCustomer : "fixture-xlsx-customer";
      return jsonResponse({ item: { ...item, replayed } }, operation === "confirm" && !replayed ? 201 : 200);
    }

    if (url.pathname === "/api/opportunities" && method === "POST") {
      return jsonResponse({ item: {
        id: ids.opportunity,
        customerId: ids.csvCustomer,
        name: `${marker} 生产主动助手商机`,
        version: 1,
      } }, 201);
    }

    if (url.pathname === "/api/integrations/hospital-tenders/sync" && method === "POST") {
      const generatedAt = jsonBody.generatedAt;
      return jsonResponse({ item: {
        notices: [{
          id: ids.tenderNotice,
          canonicalNoticeId: ids.canonicalNotice,
          title: `${marker} 医院存储采购公告`,
        }],
        snapshot: { generatedAt },
      } });
    }
    if (url.pathname === "/api/hospital-tenders" && method === "GET") {
      return jsonResponse({ items: [{ id: ids.tenderNotice, matchedCustomerIds: [ids.csvCustomer] }] });
    }
    if (url.pathname === `/api/hospital-tenders/${ids.tenderNotice}/lead-conversion/preview` && method === "POST") {
      tenderPreviewCount += 1;
      return jsonResponse({ item: {
        previewDigest: tenderPreviewCount === 1 ? "tender-preview-cancel" : "tender-preview-fresh",
        customerId: ids.csvCustomer,
      } });
    }
    if (url.pathname === `/api/hospital-tenders/${ids.tenderNotice}/lead-conversion/cancel` && method === "POST") {
      return jsonResponse({ item: { status: "cancelled" } });
    }
    if (url.pathname === `/api/hospital-tenders/${ids.tenderNotice}/lead-conversion/confirm` && method === "POST") {
      if (tenderConfirmed) return jsonResponse({ item: { replayed: true } });
      tenderConfirmed = true;
      return jsonResponse({ item: {
        status: "confirmed",
        replayed: false,
        opportunity: { id: ids.tenderOpportunity },
        actionItem: { id: ids.tenderAction },
        bridge: { id: ids.tenderBridge },
      } });
    }

    if (url.pathname === "/api/assistant/proactive" && method === "GET") {
      return jsonResponse({ items: [suggestion(ids.actionSuggestion, "missing_next_step"), suggestion(ids.riskSuggestion, "risk_open")] });
    }
    const fieldsMatch = url.pathname.match(/^\/api\/assistant\/proactive\/([^/]+)\/fields$/u);
    if (fieldsMatch && method === "PATCH") {
      reviewedFields.set(fieldsMatch[1], jsonBody);
      return jsonResponse({ item: { version: 2, reviewFields: jsonBody } });
    }
    const proactivePreviewMatch = url.pathname.match(/^\/api\/assistant\/proactive\/([^/]+)\/previews$/u);
    if (proactivePreviewMatch && method === "POST") {
      const target = jsonBody.target;
      const risk = target === "risk";
      return jsonResponse({ item: {
        id: risk ? ids.riskPreview : ids.actionPreview,
        previewDigest: `${risk ? "8" : "7"}`.repeat(64),
        customerId: ids.csvCustomer,
        opportunityId: ids.opportunity,
        opportunityVersion: 1,
        customerVersion: 1,
        preview: { title: `${marker} ${target} preview` },
      } }, 201);
    }
    const proactiveConfirmMatch = url.pathname.match(/^\/api\/assistant\/proactive\/([^/]+)\/confirm$/u);
    if (proactiveConfirmMatch && method === "POST") {
      const suggestionId = proactiveConfirmMatch[1];
      const key = new Headers(options.headers).get("Idempotency-Key");
      if (confirmations.has(key)) return jsonResponse(confirmations.get(key), 201);
      const fields = reviewedFields.get(suggestionId);
      const item = { replayed: key.endsWith("stable-replay"), [jsonBody.target]: {
        id: jsonBody.target === "risk" ? ids.riskWriteback : ids.actionWriteback,
        owner: OWNER, customerId: ids.csvCustomer, opportunityId: ids.opportunity,
        assignee: fields.assignee, due: fields.dueDate, expectedResult: fields.expectedResult,
        priority: "低", severity: "低",
        sourceType: "proactive_assistant", sourceId: suggestionId, sourceProactiveId: suggestionId,
        version: 1, writebackDigest: "a".repeat(64),
      } };
      confirmations.set(key, { item });
      return jsonResponse({ item }, item.replayed ? 200 : 201);
    }

    throw new Error(`Unexpected fake production request: ${method} ${url.pathname}`);
  };

  return { fetchImpl, requests, ids, marker };
}

function callbacksFor({ fake, cleanupMode = "clean" }) {
  const cleanupCalls = [];
  return {
    cleanupCalls,
    verifyDatabaseIdentity: async () => DATABASE_IDENTITY,
    collectManifest: async ({ state }) => fixtureManifest(state),
    fixtureFactory: async () => ({
      databaseIdentity: DATABASE_IDENTITY,
      seedRiskId: fake.ids.fixtureRisk,
      subjectId: fake.ids.subject,
      subjectVersion: 1,
      suggestionIds: [fake.ids.actionSuggestion, fake.ids.riskSuggestion],
      actionSuggestionId: fake.ids.actionSuggestion,
      riskSuggestionId: fake.ids.riskSuggestion,
    }),
    verifyWriteback: async () => ({ syntheticMock: true }),
    cleanup: async (input) => {
      cleanupCalls.push(input);
      return cleanupMode === "clean"
        ? { status: "clean", residual: {}, integrity: { quickCheck: "ok", foreignKeyViolations: 0 } }
        : { status: "failed", error: "fixture cleanup failure" };
    },
    databaseUrl: "/tmp/fixture-production.sqlite",
    authSessionSecret: TEST_SESSION_VALUE,
    hospitalTenderSyncToken: MACHINE_TOKEN,
    opsAlertToken: OPS_TOKEN,
    cleanupCalls,
  };
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

test("v0.12.0 production acceptance CLI and origin stay fail-closed", () => {
  assert.equal(parseCliArguments([
    `--origin=${PRODUCTION_ORIGIN}`,
    "--report=/tmp/v0120-report.json",
  ]).origin, PRODUCTION_ORIGIN);
  assert.throws(() => parseCliArguments([]), /origin/i);
  assert.throws(() => parseCliArguments([`--origin=${PRODUCTION_ORIGIN}`]), /report/i);
  assert.throws(() => parseCliArguments([
    `--origin=${PRODUCTION_ORIGIN}`,
    "--report=/tmp/v0120-report.json",
    "--password=do-not-accept",
  ]), /stdin/i);
  for (const origin of [
    "http://82.156.210.199",
    "https://82.156.210.199/",
    "https://82.156.210.199:8443",
    "https://82.156.210.199/api",
  ]) assert.throws(() => parseProductionOrigin(origin), /exact production HTTPS origin/i);
});

test("v0.12.0 production acceptance completes the isolated business matrix and scrubs secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sentelligent-v0120-runner-"));
  temporaryDirectories.push(directory);
  const reportPath = join(directory, "report.json");
  const fake = createFakeProductionFetch();
  const callbacks = callbacksFor({ fake });
  const report = await runV0120ProductionAcceptance({
    origin: PRODUCTION_ORIGIN,
    password: PASSWORD,
    reportPath,
    fetchImpl: fake.fetchImpl,
    runId: RUN_ID,
    now: () => new Date("2026-09-13T08:00:00.000Z"),
    ...callbacks,
  });

  assert.equal(report.status, "passed");
  assert.equal(report.summary.failed, 0);
  assert.ok(report.checks.some((check) => check.id === "customer-import.csv.preview-confirm-replay"));
  assert.ok(report.checks.some((check) => check.id === "hospital-tender.bridge-preview-cancel-confirm-replay"));
  assert.ok(report.checks.some((check) => check.id === "proactive.action-risk.preview-confirm-replay"));
  assert.deepEqual(report.businessModel, { provider: "deepseek", model: "deepseek-flash" });
  assert.deepEqual(report.developmentTarget, { model: "gpt-6" });
  assert.equal(report.boundaries.pushPlus, "retired");
  assert.equal(report.boundaries.notificationChannel, "weixin-clawbot-only");
  assert.equal(report.cleanup.status, "clean");
  assert.equal(callbacks.cleanupCalls.length, 1);
  assert.equal(callbacks.cleanupCalls[0].manifest.runId, RUN_ID);
  assert.equal(callbacks.cleanupCalls[0].manifest.databaseIdentity, DATABASE_IDENTITY);
  const reportText = readFileSync(reportPath, "utf8");
  for (const secret of [PASSWORD, SESSION_COOKIE, CSRF_TOKEN, MACHINE_TOKEN, OPS_TOKEN]) {
    assert.doesNotMatch(reportText, new RegExp(secret, "u"));
  }
  assert.ok(fake.requests.some((request) => request.url.pathname === "/api/auth/login"));
  assert.ok(fake.requests.some((request) => request.url.pathname === "/api/auth/logout"));
});

test("v0.12.0 production acceptance fails when server-local cleanup is not clean", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sentelligent-v0120-runner-failed-cleanup-"));
  temporaryDirectories.push(directory);
  const fake = createFakeProductionFetch({ cleanupMode: "failed" });
  const report = await runV0120ProductionAcceptance({
    origin: PRODUCTION_ORIGIN,
    password: PASSWORD,
    reportPath: join(directory, "report.json"),
    fetchImpl: fake.fetchImpl,
    runId: RUN_ID,
    fixtureFactory: async () => ({
      databaseIdentity: DATABASE_IDENTITY,
      seedRiskId: fake.ids.fixtureRisk,
      subjectId: fake.ids.subject,
      subjectVersion: 1,
      suggestionIds: [fake.ids.actionSuggestion, fake.ids.riskSuggestion],
      actionSuggestionId: fake.ids.actionSuggestion,
      riskSuggestionId: fake.ids.riskSuggestion,
    }),
    ...callbacksFor({ fake, cleanupMode: "failed" }),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.cleanup.status, "failed");
});

test("synthetic acceptance runs through real local HTTP routes and cleans every business write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sentelligent-v0120-real-http-"));
  temporaryDirectories.push(directory);
  const databaseUrl = join(directory, "acceptance.sqlite");
  const authSessionSecret = TEST_SESSION_VALUE;
  const server = createServer({
    databaseUrl, seed: false, nodeEnv: "test", aiAnalysisMode: "mock", modelApiKey: "",
    authRequired: true, authAccount: OWNER, authPassword: "", authPasswordHash: await hashPassword(PASSWORD),
    authSessionSecret, authCookieSecure: false, corsAllowedOrigins: [PRODUCTION_ORIGIN],
    hospitalTenderSyncToken: MACHINE_TOKEN, opsAlertToken: OPS_TOKEN, hospitalTenderAutoRun: false,
    proactiveAssistantAutoRun: false, proactiveAssistantWorkerEnabled: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  try {
    const report = await runV0120ProductionAcceptance({
      origin: PRODUCTION_ORIGIN, password: PASSWORD, reportPath: join(directory, "report.json"),
      databaseUrl, authSessionSecret, hospitalTenderSyncToken: MACHINE_TOKEN, opsAlertToken: OPS_TOKEN,
      fetchImpl: (input, options) => {
        const url = new URL(input);
        assert.equal(url.origin, PRODUCTION_ORIGIN);
        return fetch(`${localOrigin}${url.pathname}${url.search}`, options);
      },
      verifyDatabaseIdentity: () => readProductionDatabaseIdentity({ databaseUrl, authSessionSecret }).databaseIdentity,
      collectManifest: collectManifestFromDb, cleanup: cleanupV0120ProductionAcceptance,
    });
    assert.equal(report.status, "passed", JSON.stringify(report, null, 2));
    assert.equal(report.boundaries.liveProviderProof, false);
    const db = openDatabase({ databaseUrl });
    try {
      for (const table of ["customers", "opportunities", "action_items", "risk_items", "customer_import_batches", "customer_import_rows", "hospital_tender_notices", "hospital_tender_bridges", "hospital_tender_sources", "hospital_tender_runs", "proactive_scan_events", "proactive_subjects", "proactive_confirmation_previews", "ai_suggestions", "auth_sessions", "idempotency_keys"]) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
      }
    } finally { db.close(); }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
