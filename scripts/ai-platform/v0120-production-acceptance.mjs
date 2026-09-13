import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  atomicWriteJsonReport,
  parsePasswordStdin,
  parseProductionOrigin,
  PRODUCTION_ORIGIN,
} from "../production-https-smoke.mjs";
import { createV0120ProductionAcceptanceFixture } from "../../backend/scripts/v0120-production-acceptance-fixture.mjs";
import { cleanupV0120ProductionAcceptance } from "../../backend/scripts/v0120-production-acceptance-cleanup.mjs";
import { openDatabase } from "../../backend/src/db.js";
import { readProductionDatabaseIdentity } from "../../backend/scripts/production-smoke-cleanup.mjs";
import { ACTION_WRITEBACK_COLUMN_MAP, RISK_WRITEBACK_COLUMN_MAP, computeWritebackDigest } from "../../backend/src/actionRisk/writeback.js";

export const V0120_PRODUCTION_ACCOUNT = "jiangjz";
export const V0120_MACHINE_ACTOR = "hospital-tender-monitor";
export const V0120_REPORT_SCHEMA_VERSION = 1;

const SESSION_COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeErrorMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.replace(/[\r\n]+/gu, " ").slice(0, 600);
}

function assertRunId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError("A valid v0.12.0 production acceptance runId is required");
  }
  return value;
}

function markerFor(runId) {
  return `[v0.12:${runId}]`;
}

function parseSessionCookie(setCookie) {
  const first = String(setCookie ?? "").split(";", 1)[0];
  const separator = first.indexOf("=");
  if (separator <= 0) return null;
  const value = first.slice(separator + 1).trim();
  if (!SESSION_COOKIE_PATTERN.test(value)) return null;
  return { header: first, value };
}

function responseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function itemOf(result, label) {
  if (!result.body || typeof result.body !== "object" || !result.body.item) {
    throw new Error(`${label} did not return an item`);
  }
  return result.body.item;
}

function expectStatus(result, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(result.status)) {
    const code = result.body?.error?.code ? ` code=${result.body.error.code}` : "";
    throw new Error(`${label} returned HTTP ${result.status}${code}`);
  }
}

function assertDigest(value, label) {
  if (!DIGEST_PATTERN.test(String(value ?? ""))) throw new Error(`${label} is not a SHA-256 digest`);
}

function json(value) {
  return JSON.stringify(value);
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Minimal ZIP writer for a small, standards-compliant XLSX fixture. Store
// entries are sufficient for Office Open XML and keep this production runner
// dependency-free.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function minimalXlsx(rows) {
  const entries = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Customers" sheetId="1" r:id="rId1"/></sheets>
</workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => `<c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`],
  ].map(([name, content]) => ({ name, data: Buffer.from(content, "utf8") }));

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(checksum), u32(entry.data.length), u32(entry.data.length),
      u16(name.length), u16(0), name, entry.data,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(checksum), u32(entry.data.length), u32(entry.data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(local.length), u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

function csvFixture(marker) {
  return [
    "name,region,summary",
    `${marker} 客户,山东,${marker} 客户导入验收`,
    "",
  ].join("\n");
}

function xlsxFixture(marker) {
  return minimalXlsx([
    ["name", "region", "summary"],
    [`${marker} XLSX 客户`, "山东", `${marker} XLSX 导入验收`],
  ]);
}

function exactIn(values, prefix) {
  const params = {};
  const placeholders = values.map((value, index) => {
    const name = `$${prefix}${index}`;
    params[name] = value;
    return name;
  });
  return { sql: placeholders.join(", "), params };
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function verifyPersistedWriteback({ databaseUrl, authSessionSecret, databaseIdentity, target, item, suggestionId }) {
  const identity = readProductionDatabaseIdentity({ databaseUrl, authSessionSecret });
  if (identity.databaseIdentity !== databaseIdentity) throw new Error("Writeback proof database identity changed");
  const db = openDatabase({ databaseUrl: identity.databasePath });
  try {
    const table = target === "action" ? "action_items" : "risk_items";
    const columns = target === "action" ? ACTION_WRITEBACK_COLUMN_MAP : RISK_WRITEBACK_COLUMN_MAP;
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = $id`).get({ $id: item.id });
    if (!row) throw new Error(`${target} writeback was not persisted`);
    for (const [field, column] of Object.entries(columns)) {
      if ((row[column] ?? null) !== (item[field] ?? null)) throw new Error(`${target} persisted ${field} differs from the HTTP response`);
    }
    if (row.version !== item.version || computeWritebackDigest(target, item) !== item.writebackDigest) throw new Error(`${target} persisted version or digest is invalid`);
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_proactive_id = $id AND owner = $owner`)
      .get({ $id: suggestionId, $owner: item.owner }).count;
    if (count !== 1) throw new Error(`${target} replay created duplicate writebacks`);
    const audits = db.prepare("SELECT id, entity_version, metadata_json FROM audit_logs WHERE action = $action AND entity_type = $type AND entity_id = $id AND actor = $owner")
      .all({ $action: `${target}.create`, $type: target, $id: item.id, $owner: item.owner });
    if (audits.length !== 1 || audits[0].entity_version !== item.version || JSON.parse(audits[0].metadata_json).writebackDigest !== item.writebackDigest) {
      throw new Error(`${target} writeback audit is missing, duplicated or has an invalid digest`);
    }
    return { persistedFields: Object.keys(columns).length, uniqueWriteback: true, createAuditId: audits[0].id };
  } finally { db.close(); }
}

export function collectManifestFromDb({ databaseUrl, authSessionSecret, state }) {
  const identity = readProductionDatabaseIdentity({ databaseUrl, authSessionSecret });
  if (identity.databaseIdentity !== state.databaseIdentity) {
    throw new Error("The server-local database identity changed during v0.12.0 acceptance");
  }
  const db = openDatabase({ databaseUrl: identity.databasePath });
  try {
    const suggestionIds = unique(state.suggestionIds);
    const derived = {
      notificationIds: [],
      outboxIds: [],
    };
    if (suggestionIds.length > 0) {
      const suggestionClause = exactIn(suggestionIds, "suggestion");
      derived.notificationIds = db.prepare(`
        SELECT id FROM proactive_notifications
         WHERE owner = $owner AND suggestion_id IN (${suggestionClause.sql})
      `).all({ $owner: state.owner, ...suggestionClause.params }).map((row) => String(row.id));
      const notificationClause = exactIn(derived.notificationIds, "notification");
      if (derived.notificationIds.length > 0) {
        derived.outboxIds = db.prepare(`
          SELECT outbox_id AS id FROM proactive_notifications
           WHERE owner = $owner AND outbox_id IS NOT NULL
             AND id IN (${notificationClause.sql})
        `).all({ $owner: state.owner, ...notificationClause.params }).map((row) => String(row.id));
      }
    }

    const entitySets = [
      ["customer", state.customerIds],
      ["customer_import_batch", state.importBatchIds],
      ["customer_import_row", state.importRowIds],
      ["opportunity", state.opportunityIds],
      ["action", state.actionIds],
      ["risk", state.riskIds],
      ["hospital_tender_notice", state.noticeIds],
      ["proactive_assistant_suggestion", suggestionIds],
      ["proactive_confirmation_preview", state.confirmationPreviewIds],
      ["proactive_assistant_writeback", suggestionIds],
      ["hospital_tender_snapshot", state.snapshotIds],
    ];
    const auditIds = [];
    for (const [entityType, values] of entitySets) {
      for (const entityId of unique(values)) {
        const rows = db.prepare(`
          SELECT id, actor, entity_type, entity_id
            FROM audit_logs
           WHERE entity_type = $entityType AND entity_id = $entityId
        `).all({ $entityType: entityType, $entityId: entityId });
        for (const row of rows) {
          if (![state.owner, V0120_MACHINE_ACTOR].includes(row.actor)) {
            throw new Error(`Acceptance audit row has an unexpected actor for ${entityType}:${entityId}`);
          }
          auditIds.push(String(row.id));
        }
      }
    }

    return {
      schemaVersion: 1,
      runId: state.runId,
      owner: state.owner,
      databaseIdentity: state.databaseIdentity,
      sessionCookie: state.sessionCookie,
      customerIds: unique(state.customerIds),
      importBatchIds: unique(state.importBatchIds),
      importRowIds: unique(state.importRowIds),
      opportunityIds: unique(state.opportunityIds),
      quickRecordIds: unique(state.quickRecordIds),
      solutionDraftIds: unique(state.solutionDraftIds),
      actionIds: unique(state.actionIds),
      riskIds: unique(state.riskIds),
      noticeIds: unique(state.noticeIds),
      canonicalNoticeIds: unique(state.canonicalNoticeIds),
      snapshotIds: unique(state.snapshotIds),
      bridgeIds: unique(state.bridgeIds),
      suggestionIds,
      subjectIds: unique(state.subjectIds),
      confirmationPreviewIds: unique(state.confirmationPreviewIds),
      notificationIds: unique(derived.notificationIds),
      outboxIds: unique(derived.outboxIds),
      auditIds: unique(auditIds),
      idempotencyKeys: [...state.idempotencyKeys.values()],
    };
  } finally {
    db.close();
  }
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("CLI arguments must be an array");
  let origin;
  let reportPath;
  for (const argument of argv) {
    const value = String(argument);
    if (/^--password(?:=|$)/iu.test(value)) throw new TypeError("The password must be supplied only through JSON stdin");
    if (value.startsWith("--origin=")) {
      if (origin !== undefined) throw new TypeError("The origin argument may be specified only once");
      origin = value.slice("--origin=".length);
      continue;
    }
    if (value.startsWith("--report=")) {
      if (reportPath !== undefined) throw new TypeError("The report argument may be specified only once");
      reportPath = value.slice("--report=".length);
      continue;
    }
    throw new TypeError(`Unsupported v0.12.0 production acceptance argument: ${value}`);
  }
  if (origin === undefined) throw new TypeError("The --origin argument is required");
  if (!reportPath) throw new TypeError("The --report argument is required");
  return { origin: parseProductionOrigin(origin), reportPath };
}

export async function runV0120ProductionAcceptance({
  origin,
  password,
  reportPath,
  fetchImpl = globalThis.fetch,
  cleanup,
  verifyDatabaseIdentity,
  collectManifest,
  fixtureFactory = createV0120ProductionAcceptanceFixture,
  verifyWriteback = verifyPersistedWriteback,
  databaseUrl = process.env.DATABASE_URL,
  authSessionSecret = process.env.AUTH_SESSION_SECRET,
  hospitalTenderSyncToken = process.env.HOSPITAL_TENDER_SYNC_TOKEN,
  opsAlertToken = process.env.OPS_ALERT_TOKEN,
  owner = V0120_PRODUCTION_ACCOUNT,
  runId = randomUUID(),
  now = () => new Date(),
} = {}) {
  const exactOrigin = parseProductionOrigin(origin);
  const exactRunId = assertRunId(runId);
  if (typeof password !== "string" || !password) throw new TypeError("A login password is required");
  if (typeof reportPath !== "string" || !reportPath) throw new TypeError("A report path is required");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (typeof cleanup !== "function") throw new TypeError("A server-local cleanup callback is required");
  if (typeof verifyDatabaseIdentity !== "function") throw new TypeError("A database identity verifier is required");
  if (typeof collectManifest !== "function") throw new TypeError("A server-local manifest collector is required");
  if (typeof fixtureFactory !== "function") throw new TypeError("A production fixture factory is required");
  if (typeof hospitalTenderSyncToken !== "string" || !hospitalTenderSyncToken) {
    throw new TypeError("HOSPITAL_TENDER_SYNC_TOKEN is required before production acceptance");
  }
  if (typeof opsAlertToken !== "string" || !opsAlertToken) throw new TypeError("Server-local OPS_ALERT_TOKEN is required for read-only scheduler checks");
  if (typeof databaseUrl !== "string" || !databaseUrl || typeof authSessionSecret !== "string" || authSessionSecret.length < 32) {
    throw new TypeError("Server-local DATABASE_URL and AUTH_SESSION_SECRET are required before production acceptance");
  }

  const marker = markerFor(exactRunId);
  const state = {
    runId: exactRunId,
    owner,
    marker,
    databaseIdentity: "",
    sessionCookie: "",
    cookieHeader: "",
    csrfToken: "",
    customerIds: [],
    importBatchIds: [],
    importRowIds: [],
    opportunityIds: [],
    quickRecordIds: [],
    solutionDraftIds: [],
    actionIds: [],
    riskIds: [],
    noticeIds: [],
    canonicalNoticeIds: [],
    snapshotIds: [],
    bridgeIds: [],
    suggestionIds: [],
    subjectIds: [],
    confirmationPreviewIds: [],
    idempotencyKeys: new Map(),
    customer: null,
    opportunity: null,
    fixture: null,
  };
  const checks = [];
  let fatalError = null;
  let sessionLogout = { status: "not_run" };
  let cleanupReport = { status: "failed", error: "acceptance did not establish a session" };
  let collectedManifest = null;

  const request = async (path, {
    method = "GET",
    body,
    headers = {},
    authenticated = false,
    csrfProtected = false,
    timeoutMs = 90_000,
  } = {}) => {
    const url = new URL(path, `${exactOrigin}/`);
    if (url.origin !== exactOrigin) throw new Error("v0.12.0 acceptance request escaped the exact production origin");
    const requestHeaders = new Headers({ Accept: "application/json", Origin: exactOrigin });
    for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, String(value));
    if (authenticated) requestHeaders.set("Cookie", state.cookieHeader);
    if (csrfProtected) requestHeaders.set("X-CSRF-Token", state.csrfToken);
    let requestBody = body;
    if (body !== undefined && !(body instanceof FormData)) {
      requestHeaders.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    }
    const idempotencyKey = requestHeaders.get("Idempotency-Key");
    if (idempotencyKey) {
      const descriptor = {
        actor: owner,
        method: method.toUpperCase(),
        requestPath: url.pathname,
        key: idempotencyKey,
      };
      state.idempotencyKeys.set(JSON.stringify(Object.values(descriptor)), descriptor);
    }
    const response = await fetchImpl(url.href, {
      method,
      headers: requestHeaders,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) throw new Error(`Redirect rejected for ${method} ${path}`);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: responseBody(text) };
  };

  const runCheck = async (id, operation) => {
    try {
      const details = await operation();
      checks.push({ id, status: "passed", ...(details ? { details } : {}) });
      return details;
    } catch (error) {
      checks.push({ id, status: "failed", error: safeErrorMessage(error, [password, state.sessionCookie, state.csrfToken, hospitalTenderSyncToken, opsAlertToken]) });
      throw error;
    }
  };

  try {
    await runCheck("preflight.health-and-identity", async () => {
      const result = await request("/api/health");
      expectStatus(result, 200, "production health");
      if (result.body?.status !== "ok" || result.body?.database !== "ready") throw new Error("production backend is not ready");
      const localIdentity = await verifyDatabaseIdentity();
      if (localIdentity !== result.body.databaseIdentity) throw new Error("server-local and public database identities differ");
      state.databaseIdentity = localIdentity;
      return { databaseIdentityVerified: true };
    });

    await runCheck("auth.login", async () => {
      const result = await request("/api/auth/login", {
        method: "POST",
        body: { account: owner, password },
      });
      expectStatus(result, 200, "production login");
      const cookie = parseSessionCookie(result.headers.get("set-cookie"));
      if (!cookie || result.body?.account !== owner || typeof result.body?.csrfToken !== "string") throw new Error("production login did not return a valid session");
      state.cookieHeader = cookie.header;
      state.sessionCookie = cookie.value;
      state.csrfToken = result.body.csrfToken;
      return { account: owner };
    });

    await runCheck("preflight.synthetic-workers-stopped", async () => {
      const status = await request("/api/assistant/proactive/status", { authenticated: true });
      expectStatus(status, 200, "proactive runtime status");
      const worker = itemOf(status, "proactive runtime status");
      const ops = await request("/api/integrations/ops-alerts/status", { headers: { Authorization: `Bearer ${opsAlertToken}` } });
      expectStatus(ops, 200, "notification scheduler status");
      const schedulers = itemOf(ops, "notification scheduler status").schedulers;
      for (const [name, runtime] of [
        ["proactive worker", worker], ["proactive notification", worker.notificationScheduler],
        ...["actionReminders", "invoiceEscalation", "dailyDigest", "proactiveNotifications"].map((name) => [name, schedulers?.[name]]),
      ]) {
        if (!runtime || runtime.running !== false || runtime.ticking !== false) throw new Error(`${name} must be stopped and drained before synthetic acceptance`);
      }
      return { providerCalls: "none", notificationSchedulers: "stopped", evidenceType: "synthetic" };
    });

    for (const format of ["csv", "xlsx"]) {
    await runCheck(`customer-import.${format}.preview-confirm-replay`, async () => {
      const form = new FormData();
      form.append("file", new Blob([format === "csv" ? csvFixture(marker) : xlsxFixture(marker)], {
        type: format === "csv" ? "text/csv" : XLSX_MEDIA_TYPE,
      }), `${marker} customers.${format}`);
      form.append("mapping", JSON.stringify({ name: "name", region: "region", summary: "summary" }));
      const previewKey = `v0120:${exactRunId}:${format}-preview`;
      const previewResult = await request("/api/customer-imports/preview", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: { "Idempotency-Key": previewKey },
        body: form,
      });
      expectStatus(previewResult, 201, "CSV import preview");
      const preview = itemOf(previewResult, "CSV import preview");
      const batch = preview.customerImportBatch;
      const rows = preview.customerImportRows;
      if (!batch?.id || !rows?.[0]?.id) throw new Error("CSV import preview omitted exact batch/row ids");
      state.importBatchIds.push(batch.id);
      state.importRowIds.push(...rows.map((row) => row.id));
      if (batch.owner !== owner || batch.status !== "preview" || rows.length !== 1 || rows[0].action !== "create" || rows[0].customerId) {
        throw new Error(`${format} preview must create exactly one new owner-scoped customer`);
      }
      assertDigest(preview.previewDigest, `${format} preview digest`);
      assertDigest(batch.fileSha256, `${format} file digest`);
      const confirmBody = {
        confirmed: true,
        previewDigest: preview.previewDigest,
        fileSha256: batch.fileSha256,
      };
      const wrongPreview = await request(`/api/customer-imports/${encodeURIComponent(batch.id)}/confirm`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: { "Idempotency-Key": `v0120:${exactRunId}:${format}-wrong-preview` },
        body: { ...confirmBody, previewDigest: "0".repeat(64) },
      });
      expectStatus(wrongPreview, [409, 422], "CSV wrong preview digest");
      const wrongFile = await request(`/api/customer-imports/${encodeURIComponent(batch.id)}/confirm`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: { "Idempotency-Key": `v0120:${exactRunId}:${format}-wrong-file` },
        body: { ...confirmBody, fileSha256: "f".repeat(64) },
      });
      expectStatus(wrongFile, [409, 422], "CSV wrong file digest");
      const confirmedResult = await request(`/api/customer-imports/${encodeURIComponent(batch.id)}/confirm`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: { "Idempotency-Key": `v0120:${exactRunId}:${format}-confirm` },
        body: confirmBody,
      });
      expectStatus(confirmedResult, [200, 201], "CSV import confirm");
      const confirmed = itemOf(confirmedResult, "CSV import confirm");
      if (confirmed.replayed === true) throw new Error("CSV import confirm unexpectedly replayed before the first commit");
      const customerId = confirmed.customerImportRows?.[0]?.customerId ?? rows[0].customerId;
      if (!customerId) throw new Error("CSV import confirmation did not return the customer id");
      state.customerIds.push(customerId);
      if (confirmed.customerImportBatch?.status !== "committed" || confirmed.customerImportRows?.[0]?.action !== "create") {
        throw new Error(`${format} confirmation did not commit a new customer`);
      }
      const replay = await request(`/api/customer-imports/${encodeURIComponent(batch.id)}/confirm`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: { "Idempotency-Key": `v0120:${exactRunId}:${format}-confirm` },
        body: confirmBody,
      });
      expectStatus(replay, 200, "CSV import confirm replay");
      if (itemOf(replay, "CSV import replay").replayed !== true) throw new Error("CSV confirm replay was not durable");
      if (itemOf(replay, "import replay").customerImportRows?.[0]?.customerId !== customerId) throw new Error("Import replay changed customer identity");
      const conflict = await request(`/api/customer-imports/${encodeURIComponent(batch.id)}/cancel`, {
        method: "POST", authenticated: true, csrfProtected: true,
        headers: { "Idempotency-Key": `v0120:${exactRunId}:${format}-cancel-committed` },
        body: { reason: "v0120-production-acceptance" },
      });
      expectStatus(conflict, 409, `${format} cannot cancel a committed batch`);
      if (format === "csv") state.customer = { id: customerId, name: `${marker} 客户` };
      return { batchId: batch.id, customerId, replayed: true };
    });
    }

    for (const format of ["csv", "xlsx"]) {
    await runCheck(`customer-import.${format}.preview-cancel-replay`, async () => {
      const form = new FormData();
      const cancelMarker = `${marker} cancel`;
      form.append("file", new Blob([format === "csv" ? csvFixture(cancelMarker) : xlsxFixture(cancelMarker)], {
        type: format === "csv" ? "text/csv" : XLSX_MEDIA_TYPE,
      }), `${marker} cancel-customers.${format}`);
      form.append("mapping", JSON.stringify({ name: "name", region: "region", summary: "summary" }));
      const previewResult = await request("/api/customer-imports/preview", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: { "Idempotency-Key": `v0120:${exactRunId}:${format}-cancel-preview` },
        body: form,
      });
      expectStatus(previewResult, 201, "XLSX import preview");
      const preview = itemOf(previewResult, "XLSX import preview");
      const batch = preview.customerImportBatch;
      const rows = preview.customerImportRows;
      state.importBatchIds.push(batch.id);
      state.importRowIds.push(...rows.map((row) => row.id));
      const cancelBody = { reason: "v0120-production-acceptance" };
      const cancelled = await request(`/api/customer-imports/${encodeURIComponent(batch.id)}/cancel`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: { "Idempotency-Key": `v0120:${exactRunId}:${format}-cancel` },
        body: cancelBody,
      });
      expectStatus(cancelled, 200, "XLSX import cancel");
      const cancelledItem = itemOf(cancelled, "Import cancel");
      if (cancelledItem.customerImportBatch?.status !== "cancelled" || cancelledItem.customerImportRows?.some((row) => row.customerId)) throw new Error("Cancelled import created a customer");
      const replay = await request(`/api/customer-imports/${encodeURIComponent(batch.id)}/cancel`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: { "Idempotency-Key": `v0120:${exactRunId}:${format}-cancel` },
        body: cancelBody,
      });
      expectStatus(replay, 200, "XLSX import cancel replay");
      if (itemOf(replay, "XLSX cancel replay").replayed !== true) throw new Error("XLSX cancel replay was not durable");
      const conflict = await request(`/api/customer-imports/${encodeURIComponent(batch.id)}/confirm`, {
        method: "POST", authenticated: true, csrfProtected: true,
        headers: { "Idempotency-Key": `v0120:${exactRunId}:${format}-confirm-cancelled` },
        body: { confirmed: true, previewDigest: preview.previewDigest, fileSha256: batch.fileSha256 },
      });
      expectStatus(conflict, 409, `${format} cannot confirm a cancelled batch`);
      return { batchId: batch.id, customerCount: 0, replayed: true };
    });
    }

    await runCheck("opportunity.create", async () => {
      const result = await request("/api/opportunities", {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        headers: { "Idempotency-Key": `v0120:${exactRunId}:opportunity-create` },
        body: {
          customerId: state.customer.id,
          name: `${marker} 生产主动助手商机`,
          stage: "qualification",
          amount: "100000",
          probability: 35,
          sourceRecord: marker,
          risk: `${marker} 仅用于生产验收`,
          next: null,
        },
      });
      expectStatus(result, 201, "acceptance opportunity create");
      const item = itemOf(result, "acceptance opportunity");
      if (item.customerId !== state.customer.id || !String(item.name).includes(marker)) throw new Error("acceptance opportunity relationship or marker is invalid");
      state.opportunity = item;
      state.opportunityIds.push(item.id);
      return { opportunityId: item.id };
    });

    await runCheck("hospital-tender.bridge-preview-cancel-confirm-replay", async () => {
      const generatedAt = new Date().toISOString();
      const noticeIdentity = `v0120-${exactRunId}-notice`;
      const contentText = `${marker} 医院招标 bridge 生产验收公告`;
      const syncPayload = {
        schemaVersion: "hospital-tender-snapshot-v1",
        generatedAt,
        notices: [{
          identityKey: noticeIdentity,
          sourceId: `v0120-${exactRunId}-source`,
          sourceName: "v0.12.0 acceptance source",
          city: "山东",
          title: `${marker} 医院存储采购公告`,
          url: `https://example.invalid/${encodeURIComponent(exactRunId)}`,
          publishedAt: generatedAt,
          noticeType: "result",
          purchaser: state.customer.name,
          projectCode: `V0120-${exactRunId.slice(0, 8)}`,
          budgetText: "100 万元",
          deadlineText: "2099-12-31",
          contentText,
          hospitalNames: [state.customer.name],
          sourceItemId: `v0120-${exactRunId}-item`,
          contentSha256: sha256(contentText),
          relevance: "high",
        }],
        sources: [{
          sourceId: `v0120-${exactRunId}-source`,
          sourceName: "v0.12.0 acceptance source",
          status: "healthy",
          lastRunAt: generatedAt,
          lastSuccessAt: generatedAt,
          lastItemCount: 1,
          lastUpsertedCount: 1,
          lastRejectedCount: 0,
        }],
        runs: [{
          id: `v0120-${exactRunId}-run`, sourceId: `v0120-${exactRunId}-source`,
          startedAt: generatedAt, finishedAt: generatedAt, status: "success",
          fetchedCount: 1, upsertedCount: 1, rejectedCount: 0,
        }],
      };
      const synced = await request("/api/integrations/hospital-tenders/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${hospitalTenderSyncToken}` },
        body: syncPayload,
      });
      expectStatus(synced, 200, "hospital tender sync");
      const syncItem = itemOf(synced, "hospital tender sync");
      const notice = syncItem.notices?.find((candidate) => String(candidate.title).includes(marker));
      if (!notice) throw new Error("hospital tender sync did not return the acceptance notice");
      state.snapshotIds.push(generatedAt);
      state.noticeIds.push(notice.id);
      state.canonicalNoticeIds.push(notice.canonicalNoticeId);

      const list = await request(`/api/hospital-tenders?customerId=${encodeURIComponent(state.customer.id)}`, { authenticated: true });
      expectStatus(list, 200, "hospital tender owner read");
      const visible = list.body?.items?.find((candidate) => candidate.id === notice.id);
      if (!visible || !visible.matchedCustomerIds?.includes(state.customer.id)) throw new Error("hospital tender owner read lost the customer bridge");
      const route = `/api/hospital-tenders/${encodeURIComponent(notice.id)}/lead-conversion`;
      const preview = itemOf(await request(`${route}/preview`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        body: { customerId: state.customer.id },
      }), "hospital tender conversion preview");
      const cancel = itemOf(await request(`${route}/cancel`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        body: { customerId: state.customer.id, previewDigest: preview.previewDigest, cancel: true },
      }), "hospital tender conversion cancel");
      if (cancel.status !== "cancelled") throw new Error("hospital tender conversion cancel did not close the bridge");
      const fresh = itemOf(await request(`${route}/preview`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        body: { customerId: state.customer.id },
      }), "hospital tender fresh conversion preview");
      const confirmed = itemOf(await request(`${route}/confirm`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        body: {
          customerId: state.customer.id,
          previewDigest: fresh.previewDigest,
          confirmed: true,
        },
      }), "hospital tender conversion confirm");
      if (confirmed.status !== "confirmed" || confirmed.replayed === true) throw new Error("hospital tender conversion was not newly confirmed");
      state.opportunityIds.push(confirmed.opportunity.id);
      state.actionIds.push(confirmed.actionItem.id);
      state.bridgeIds.push(confirmed.bridge.id);
      const replay = itemOf(await request(`${route}/confirm`, {
        method: "POST",
        authenticated: true,
        csrfProtected: true,
        body: {
          customerId: state.customer.id,
          previewDigest: fresh.previewDigest,
          confirmed: true,
        },
      }), "hospital tender conversion replay");
      if (replay.replayed !== true) throw new Error("hospital tender conversion replay was not durable");
      return { noticeId: notice.id, bridgeId: confirmed.bridge.id, replayed: true };
    });

    await runCheck("proactive.subject-fixture", async () => {
      state.fixture = await fixtureFactory({
        databaseUrl,
        authSessionSecret,
        runId: exactRunId,
        owner,
        customerId: state.customer.id,
        opportunityId: state.opportunity.id,
      });
      if (state.fixture.databaseIdentity !== state.databaseIdentity) throw new Error("proactive fixture used a different database identity");
      state.riskIds.push(state.fixture.seedRiskId);
      state.subjectIds.push(state.fixture.subjectId);
      state.suggestionIds.push(...(state.fixture.suggestionIds ?? [state.fixture.actionSuggestionId, state.fixture.riskSuggestionId]));
      return { subjectVersion: state.fixture.subjectVersion, suggestionCount: state.fixture.suggestionIds?.length ?? 2 };
    });

    await runCheck("proactive.action-risk.preview-confirm-replay", async () => {
      const list = await request(`/api/assistant/proactive?customerId=${encodeURIComponent(state.customer.id)}&limit=100`, { authenticated: true });
      expectStatus(list, 200, "customer proactive list");
      const items = list.body?.items ?? list.body?.item?.items ?? [];
      const actionSuggestion = items.find((item) => item.id === state.fixture.actionSuggestionId);
      const riskSuggestion = items.find((item) => item.id === state.fixture.riskSuggestionId);
      if (!actionSuggestion || !riskSuggestion) throw new Error("customer proactive list omitted fixture suggestions");

      const confirmTarget = async (suggestion, target, prefix) => {
        const expectedFields = { assignee: owner, dueDate: "2099-12-30", priority: "low", expectedResult: `${marker} ${target} expected result` };
        const edit = await request(`/api/assistant/proactive/${encodeURIComponent(suggestion.id)}/fields`, {
          method: "PATCH", authenticated: true, csrfProtected: true,
          headers: { "Idempotency-Key": `v0120:${exactRunId}:${prefix}-fields` },
          body: { ...expectedFields, expectedVersion: suggestion.version },
        });
        expectStatus(edit, 200, `${prefix} review fields`);
        const previewResult = await request(`/api/assistant/proactive/${encodeURIComponent(suggestion.id)}/previews`, {
          method: "POST",
          authenticated: true,
          csrfProtected: true,
          headers: { "Idempotency-Key": `v0120:${exactRunId}:${prefix}-preview` },
          body: { target },
        });
        expectStatus(previewResult, 201, `${prefix} proactive preview`);
        const preview = itemOf(previewResult, `${prefix} proactive preview`);
        assertDigest(preview.previewDigest, `${prefix} preview digest`);
        state.confirmationPreviewIds.push(preview.id);
        if (preview.customerId !== state.customer.id || preview.opportunityId !== state.opportunity.id) throw new Error(`${prefix} preview changed the acceptance relationship`);
        const body = {
          confirmationPreviewId: preview.id,
          target,
          customerId: preview.customerId,
          opportunityId: preview.opportunityId,
          expectedOpportunityVersion: preview.opportunityVersion,
          expectedCustomerVersion: preview.customerVersion,
          previewDigest: preview.previewDigest,
          preview: preview.preview,
        };
        const confirmedResult = await request(`/api/assistant/proactive/${encodeURIComponent(suggestion.id)}/confirm`, {
          method: "POST",
          authenticated: true,
          csrfProtected: true,
          headers: { "Idempotency-Key": `v0120:${exactRunId}:${prefix}-confirm` },
          body,
        });
        expectStatus(confirmedResult, 201, `${prefix} proactive confirm`);
        const confirmed = itemOf(confirmedResult, `${prefix} proactive confirm`);
        if (target === "action") state.actionIds.push(confirmed.action.id);
        else state.riskIds.push(confirmed.risk.id);
        const written = confirmed[target];
        assertDigest(written.writebackDigest, `${prefix} writeback digest`);
        if (written.owner !== owner || written.customerId !== state.customer.id || written.opportunityId !== state.opportunity.id
          || written.assignee !== expectedFields.assignee || written.due !== expectedFields.dueDate
          || written.expectedResult !== expectedFields.expectedResult || written.sourceProactiveId !== suggestion.id
          || written[target === "action" ? "priority" : "severity"] !== "低"
          || written.sourceId !== suggestion.id || written.sourceType !== "proactive_assistant" || !(written.version >= 1)) {
          throw new Error(`${prefix} writeback lost reviewed fields, ownership or provenance`);
        }
        const replayResult = await request(`/api/assistant/proactive/${encodeURIComponent(suggestion.id)}/confirm`, {
          method: "POST",
          authenticated: true,
          csrfProtected: true,
          headers: { "Idempotency-Key": `v0120:${exactRunId}:${prefix}-confirm` },
          body,
        });
        expectStatus(replayResult, confirmedResult.status, `${prefix} exact idempotency replay`);
        if (json(replayResult.body) !== json(confirmedResult.body)) throw new Error(`${prefix} exact replay changed its response`);
        const stableReplay = await request(`/api/assistant/proactive/${encodeURIComponent(suggestion.id)}/confirm`, {
          method: "POST", authenticated: true, csrfProtected: true,
          headers: { "Idempotency-Key": `v0120:${exactRunId}:${prefix}-stable-replay` }, body,
        });
        expectStatus(stableReplay, 200, `${prefix} stable business replay`);
        const stable = itemOf(stableReplay, "stable replay");
        if (stable.replayed !== true || stable[target]?.id !== written.id || stable[target]?.writebackDigest !== written.writebackDigest) throw new Error(`${prefix} stable replay changed writeback identity`);
        const persisted = await verifyWriteback({ databaseUrl, authSessionSecret, databaseIdentity: state.databaseIdentity, target, item: written, suggestionId: suggestion.id });
        return { previewId: preview.id, writebackId: written.id, persisted };
      };

      const action = await confirmTarget(actionSuggestion, "action", "action");
      const risk = await confirmTarget(riskSuggestion, "risk", "risk");
      return { action, risk };
    });
  } catch (error) {
    fatalError = safeErrorMessage(error, [password, state.sessionCookie, state.csrfToken, hospitalTenderSyncToken, opsAlertToken]);
  } finally {
    if (state.cookieHeader && state.csrfToken) {
      try {
        const logout = await request("/api/auth/logout", { method: "POST", authenticated: true, csrfProtected: true });
        expectStatus(logout, 204, "production logout");
        sessionLogout = { status: "passed" };
      } catch (error) {
        sessionLogout = { status: "failed", error: safeErrorMessage(error, [password, state.sessionCookie, state.csrfToken]) };
      }
    }
    if (state.sessionCookie && state.databaseIdentity) {
      try {
        collectedManifest = await collectManifest({ databaseUrl, authSessionSecret, state });
        cleanupReport = await cleanup({
          databaseUrl,
          authSessionSecret,
          manifest: collectedManifest,
        });
      } catch (error) {
        cleanupReport = { status: "failed", error: safeErrorMessage(error, [password, state.sessionCookie, state.csrfToken, hospitalTenderSyncToken, opsAlertToken]) };
      }
    }
  }

  const failedChecks = checks.filter((check) => check.status !== "passed");
  const report = {
    schemaVersion: V0120_REPORT_SCHEMA_VERSION,
    runner: "sentelligent-v0120-production-acceptance",
    runId: exactRunId,
    target: { origin: exactOrigin, account: owner },
    businessModel: { provider: "deepseek", model: "deepseek-flash" },
    developmentTarget: { model: "gpt-6" },
    boundaries: {
      productionWrites: cleanupReport.status === "clean" ? "synthetic-only-and-cleaned" : "synthetic-cleanup-required",
      evidenceType: "synthetic-business-http",
      liveProviderProof: false,
      pushPlus: "retired",
      notificationChannel: "weixin-clawbot-only",
      iphoneRealDevice: "out-of-scope",
    },
    status: !fatalError && failedChecks.length === 0 && sessionLogout.status === "passed" && cleanupReport.status === "clean"
      ? "passed"
      : "failed",
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === "passed").length,
      failed: failedChecks.length,
    },
    error: fatalError,
    databaseIdentity: state.databaseIdentity || null,
    cleanup: {
      status: cleanupReport.status,
      error: cleanupReport.error ?? null,
      sessionLogout,
      deleted: cleanupReport.deleted ?? {},
      residual: cleanupReport.residual ?? {},
      integrity: cleanupReport.integrity ?? null,
      recovery: cleanupReport.status === "clean" ? null : {
        runId: exactRunId, owner, databaseIdentity: state.databaseIdentity,
        entityIds: Object.fromEntries(Object.entries(state).filter(([key]) => key.endsWith("Ids"))),
        idempotencyKeys: [...state.idempotencyKeys.values()],
        instruction: "Drain workers and reconcile exact run ids before retrying cleanup; never delete by marker substring or rerun blindly.",
      },
      manifestCounts: collectedManifest
        ? Object.fromEntries([
            "customerIds", "importBatchIds", "importRowIds", "opportunityIds", "actionIds", "riskIds",
            "noticeIds", "canonicalNoticeIds", "snapshotIds", "bridgeIds", "suggestionIds", "subjectIds",
            "confirmationPreviewIds", "notificationIds", "outboxIds", "auditIds", "idempotencyKeys",
          ].map((key) => [key, Array.isArray(collectedManifest[key]) ? collectedManifest[key].length : 0]))
        : {},
    },
  };
  const reportText = JSON.stringify(report);
  for (const secret of [password, state.sessionCookie, state.csrfToken, hospitalTenderSyncToken, opsAlertToken]) {
    if (secret && reportText.includes(secret)) throw new Error("v0.12.0 production acceptance report contains sensitive material");
  }
  atomicWriteJsonReport(reportPath, report);
  return report;
}

async function serverLocalCallbacks() {
  const databaseUrl = process.env.DATABASE_URL;
  const authSessionSecret = process.env.AUTH_SESSION_SECRET;
  if (!databaseUrl || !authSessionSecret) {
    throw new Error("v0.12.0 production acceptance requires server-local DATABASE_URL and AUTH_SESSION_SECRET");
  }
  return {
    databaseUrl,
    authSessionSecret,
    verifyDatabaseIdentity: () => readProductionDatabaseIdentity({ databaseUrl, authSessionSecret }).databaseIdentity,
    collectManifest: ({ state }) => collectManifestFromDb({ databaseUrl, authSessionSecret, state }),
    cleanup: (input) => cleanupV0120ProductionAcceptance(input),
  };
}

async function runCli() {
  try {
    const { origin, reportPath } = parseCliArguments(process.argv.slice(2));
    const callbacks = await serverLocalCallbacks();
    const password = parsePasswordStdin(readFileSync(0, "utf8"));
    const report = await runV0120ProductionAcceptance({
      origin,
      reportPath,
      password,
      ...callbacks,
      hospitalTenderSyncToken: process.env.HOSPITAL_TENDER_SYNC_TOKEN,
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
    process.stderr.write(`v0.12.0 production acceptance failed: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await runCli();
