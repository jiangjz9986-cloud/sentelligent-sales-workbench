import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  parseCliArguments,
  runV0120ProductionAcceptance,
} from "./v0120-production-acceptance.mjs";
import { PRODUCTION_ORIGIN, parseProductionOrigin } from "../production-https-smoke.mjs";

const OWNER = "jiangjz";
const PASSWORD = "fixture-production-password";
const MACHINE_TOKEN = "fixture-machine-token";
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

  const suggestion = (id, trigger) => ({
    id,
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

    if (url.pathname === "/api/customer-imports/preview" && method === "POST") {
      const xlsx = fileName.endsWith(".xlsx");
      const batchId = xlsx ? ids.xlsxBatch : ids.csvBatch;
      const rowId = xlsx ? ids.xlsxRow : ids.csvRow;
      return jsonResponse({
        item: {
          customerImportBatch: { id: batchId, fileSha256: `${xlsx ? "b" : "a"}`.repeat(64) },
          customerImportRows: [{ id: rowId, customerId: xlsx ? null : ids.csvCustomer }],
          previewDigest: `${xlsx ? "e" : "c"}`.repeat(64),
        },
      }, 201);
    }
    if (url.pathname === `/api/customer-imports/${ids.csvBatch}/confirm` && method === "POST") {
      if (jsonBody?.previewDigest === "0".repeat(64) || jsonBody?.fileSha256 === "f".repeat(64)) {
        return jsonResponse({ error: { code: "PREVIEW_DIGEST_MISMATCH" } }, 409);
      }
      if (jsonBody?.confirmed === true && csvConfirmed) {
        return jsonResponse({ item: { replayed: true } });
      }
      csvConfirmed = true;
      return jsonResponse({ item: { customerImportRows: [{ id: ids.csvRow, customerId: ids.csvCustomer }] } }, 201);
    }
    if (url.pathname === `/api/customer-imports/${ids.xlsxBatch}/cancel` && method === "POST") {
      const replayed = requests.filter((request) => request.url.pathname === url.pathname).length > 1;
      return jsonResponse({ item: replayed ? { replayed: true } : { status: "cancelled" } });
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
      const replayed = requests.filter((request) => request.url.pathname === url.pathname).length > 1;
      if (replayed) return jsonResponse({ item: { replayed: true } });
      if (jsonBody.target === "risk") return jsonResponse({ item: { risk: { id: ids.riskWriteback } } }, 201);
      return jsonResponse({ item: { action: { id: ids.actionWriteback } } }, 201);
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
    cleanup: async (input) => {
      cleanupCalls.push(input);
      return cleanupMode === "clean"
        ? { status: "clean", residual: {}, integrity: { quickCheck: "ok", foreignKeyViolations: 0 } }
        : { status: "failed", error: "fixture cleanup failure" };
    },
    databaseUrl: "/tmp/fixture-production.sqlite",
    authSessionSecret: TEST_SESSION_VALUE,
    hospitalTenderSyncToken: MACHINE_TOKEN,
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
  assert.equal(report.businessModel.model, "deepseek-flash");
  assert.equal(report.developmentTarget.model, "gpt-5.6-luna");
  assert.equal(report.developmentTarget.reasoningEffort, "max");
  assert.equal(report.boundaries.pushPlus, "retired");
  assert.equal(report.boundaries.notificationChannel, "weixin-clawbot-only");
  assert.equal(report.cleanup.status, "clean");
  assert.equal(callbacks.cleanupCalls.length, 1);
  assert.equal(callbacks.cleanupCalls[0].manifest.runId, RUN_ID);
  assert.equal(callbacks.cleanupCalls[0].manifest.databaseIdentity, DATABASE_IDENTITY);
  const reportText = readFileSync(reportPath, "utf8");
  for (const secret of [PASSWORD, SESSION_COOKIE, CSRF_TOKEN, MACHINE_TOKEN]) {
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
