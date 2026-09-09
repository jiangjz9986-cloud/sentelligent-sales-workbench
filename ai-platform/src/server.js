import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";

import { loadAiPlatformConfig } from "./config.js";
import { openAiPlatformDatabase } from "./db/index.js";
import { asPlatformError, errorBody, AiPlatformError } from "./errors.js";
import { authenticateRequest } from "./auth/internalAuth.js";
import { createProviderRegistry } from "./providers/mockProvider.js";
import { createTaskService } from "./tasks/taskService.js";
import { createAdminService } from "./admin/adminService.js";
import { createScheduleService } from "./schedules/scheduleService.js";
import { safeLimit, safeOffset } from "./utils.js";

const PACKAGE_VERSION = "0.1.0";
const ADMIN_PREFIX = "/internal/ai/v1/admin";
const API_PREFIX = "/internal/ai/v1";
const STATIC_PREFIXES = new Set(["/admin", "/ai-platform-admin"]);
const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
});

function requestIdFor(request) {
  const candidate = request.headers["x-request-id"];
  if (typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(candidate)) return candidate;
  return randomUUID();
}

function setSecurityHeaders(response, requestId) {
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
}

function sendJson(response, status, payload, requestId, headers = {}) {
  if (response.headersSent) return;
  setSecurityHeaders(response, requestId);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.end(JSON.stringify(payload));
}

function sendEmpty(response, status, requestId, headers = {}) {
  if (response.headersSent) return;
  setSecurityHeaders(response, requestId);
  response.statusCode = status;
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.end();
}

function methodNotAllowed(response, requestId, allow) {
  sendJson(response, 405, {
    schemaVersion: "ai-error-v1",
    requestId,
    error: { code: "method_not_allowed", message: "method not allowed" },
  }, requestId, { Allow: allow });
}

async function readJsonBody(request, maxBytes) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    throw new AiPlatformError("request body is too large", { code: "payload_too_large", status: 413 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new AiPlatformError("request body is too large", { code: "payload_too_large", status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be an object");
    }
    return parsed;
  } catch {
    throw new AiPlatformError("request body must be valid JSON", { code: "invalid_json", status: 400 });
  }
}

function pathParts(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { throw new AiPlatformError("path is invalid", { code: "invalid_request", status: 400 }); }
  });
}

function queryPage(url, max = 200) {
  try {
    return {
      limit: safeLimit(url.searchParams.get("limit"), 50, max),
      offset: safeOffset(url.searchParams.get("offset"), 0, 100_000),
    };
  } catch {
    throw new AiPlatformError("pagination is invalid", { code: "invalid_request", status: 400 });
  }
}

function identityForTask(auth) {
  return {
    issuer: auth.issuer,
    owner: auth.owner,
    actor: auth.actor,
    scopes: auth.scopes,
    isAdmin: auth.isAdmin,
  };
}

function queueSnapshot(db) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
      FROM tasks
     GROUP BY status
  `).all();
  const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  return {
    queued: counts.queued ?? 0,
    running: counts.running ?? 0,
    succeeded: counts.succeeded ?? 0,
    failed: counts.failed ?? 0,
    cancelled: counts.cancelled ?? 0,
    expired: counts.expired ?? 0,
    depth: counts.queued ?? 0,
  };
}

function normalizeAdminMethodResult(value) {
  if (value === undefined) throw new AiPlatformError("management resource is unavailable", { code: "not_implemented", status: 501 });
  return value;
}

function collectionResponse(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.items)) {
    return value;
  }
  return { items: Array.isArray(value) ? value : [], total: Array.isArray(value) ? value.length : 0 };
}

function pickBodyFields(body, fields) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(body, field))
    .map((field) => [field, body[field]]));
}

function omitBodyFields(body, fields) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const omitted = new Set(fields);
  return Object.fromEntries(Object.entries(body).filter(([field]) => !omitted.has(field)));
}

function copyQueryFields(url, target, fields) {
  for (const field of fields) {
    const value = url.searchParams.get(field);
    if (value !== null && value !== "") target[field] = value;
  }
  return target;
}

function queryBoolean(url, field, fallback = null) {
  const value = url.searchParams.get(field);
  if (value === null || value === "") return fallback;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  throw new AiPlatformError(`${field} is invalid`, { code: "invalid_request", status: 400 });
}

function contentTypeFor(pathname) {
  return MIME_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

function staticPathFor(staticDirectory, pathname) {
  const normalized = pathname.replace(/^\/(?:admin|ai-platform-admin)(?:\/|$)/u, "");
  const relativePath = normalized || "index.html";
  const root = resolve(staticDirectory);
  const candidate = resolve(root, relativePath);
  const relativePathCheck = relative(root, candidate);
  if (relativePathCheck === ".." || relativePathCheck.startsWith(`..${sep}`) || relativePathCheck.includes(`..${sep}`)) {
    throw new AiPlatformError("resource not found", { code: "not_found", status: 404 });
  }
  return candidate;
}

async function serveStatic(request, response, config, requestId) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    methodNotAllowed(response, requestId, "GET, HEAD");
    return;
  }
  const requestUrl = new URL(request.url ?? "/", "http://ai-platform.local");
  const pathname = requestUrl.pathname;
  if (pathname === "/admin" || pathname === "/ai-platform-admin") {
    return sendEmpty(response, 308, requestId, { Location: `${pathname}/${requestUrl.search}` });
  }
  const filePath = staticPathFor(config.staticDirectory, pathname);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    // The management console is a static entrypoint. Unknown extension paths
    // fall back to index.html for client-side navigation.
    if (extname(filePath)) throw new AiPlatformError("resource not found", { code: "not_found", status: 404 });
    fileStat = await stat(resolve(config.staticDirectory, "index.html")).catch(() => null);
    if (!fileStat) throw new AiPlatformError("resource not found", { code: "not_found", status: 404 });
  }
  if (!fileStat.isFile()) throw new AiPlatformError("resource not found", { code: "not_found", status: 404 });
  const actualPath = fileStat.isFile() && await stat(filePath).catch(() => null) ? filePath : resolve(config.staticDirectory, "index.html");
  const body = request.method === "HEAD" ? null : await readFile(actualPath);
  setSecurityHeaders(response, requestId);
  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypeFor(actualPath));
  response.setHeader("Content-Length", String(fileStat.size));
  response.setHeader("Cache-Control", extname(actualPath) === ".html" ? "no-store" : "public, max-age=60");
  response.end(body);
}

export function createAiPlatformRuntime(options = {}) {
  const config = loadAiPlatformConfig(options.config ?? options, options.env ?? process.env);
  const ownsDatabase = !options.db;
  const db = options.db ?? openAiPlatformDatabase(config.databasePath);
  const providerRegistry = options.providerRegistry ?? createProviderRegistry();
  const taskService = options.taskService ?? createTaskService({
    db,
    config,
    providerRegistry,
    clock: options.clock,
    logger: options.logger,
  });
  const adminService = options.adminService ?? createAdminService({
    db,
    clock: options.clock,
    timeZone: options.timeZone,
  });
  const scheduleService = options.scheduleService ?? createScheduleService({
    db,
    taskService,
    clock: options.clock,
    logger: options.logger,
    config,
  });
  if (options.autoStart !== false && !options.taskService) taskService.start();
  if (options.autoStart !== false && !options.scheduleService) scheduleService.start();
  let closed = false;
  return Object.freeze({
    config,
    db,
    providerRegistry,
    taskService,
    adminService,
    scheduleService,
    close() {
      if (closed) return;
      closed = true;
      taskService.close?.();
      scheduleService.close?.();
      if (ownsDatabase) db.close();
    },
  });
}

export function createServer(options = {}) {
  const runtime = options.runtime ?? createAiPlatformRuntime(options);
  const { config, db, taskService, scheduleService } = runtime;
  const logger = options.logger ?? console;

  async function authenticate(request, scopes, { admin = false } = {}) {
    if (admin && config.adminEnabled === false) {
      throw new AiPlatformError("AI platform administration is disabled", { code: "admin_disabled", status: 404 });
    }
    return authenticateRequest(request, config, {
      requiredScopes: scopes,
      allowDevAdmin: admin,
    });
  }

  async function adminCall(name, args) {
    const service = runtime.adminService;
    if (!service || typeof service[name] !== "function") {
      throw new AiPlatformError("management resource is unavailable", { code: "not_implemented", status: 501 });
    }
    return normalizeAdminMethodResult(await service[name](args));
  }

  async function scheduleCall(name, args) {
    if (!scheduleService || typeof scheduleService[name] !== "function") {
      throw new AiPlatformError("schedule management is unavailable", { code: "not_implemented", status: 501 });
    }
    return normalizeAdminMethodResult(await scheduleService[name](args));
  }

  async function handleAdmin(request, response, requestId, url) {
    const parts = pathParts(url.pathname.slice(ADMIN_PREFIX.length));
    const method = request.method ?? "GET";
    const auth = await authenticate(
      request,
      ["POST", "PATCH", "PUT", "DELETE"].includes(method) ? [] : ["ai:admin:read"],
      { admin: true },
    );
    const identity = identityForTask(auth);
    if (parts.length === 0 || (parts.length === 1 && parts[0] === "health")) {
      if (method !== "GET") return methodNotAllowed(response, requestId, "GET");
      return sendJson(response, 200, { item: healthSnapshot(runtime) }, requestId);
    }
    if (method === "GET" && parts.length === 1 && parts[0] === "overview") {
      return sendJson(response, 200, { item: await adminCall("getOverview", { identity, requestId }) }, requestId);
    }
    if (method === "GET" && parts[0] === "tasks") {
      if (parts.length === 1) {
        const args = copyQueryFields(url, {
          identity,
          requestId,
          ...queryPage(url),
        }, [
          "owner", "status", "feature", "modelId", "agentVersionId", "taskType", "from", "to",
        ]);
        args.includeInput = queryBoolean(url, "includeInput", false);
        return sendJson(response, 200, collectionResponse(await adminCall("listTasks", args)), requestId);
      }
      if (parts.length === 2) {
        return sendJson(response, 200, { item: await adminCall("getTaskDetail", { identity, taskId: parts[1], requestId }) }, requestId);
      }
      if (parts.length === 3 && ["attempts", "events", "reservations", "usage"].includes(parts[2])) {
        const taskId = parts[1];
        if (parts[2] === "attempts") {
          return sendJson(response, 200, collectionResponse(await adminCall("listTaskAttempts", {
            identity,
            taskId,
            requestId,
            ...queryPage(url),
          })), requestId);
        }
        if (parts[2] === "events") {
          return sendJson(response, 200, collectionResponse(await adminCall("listTaskEvents", {
            identity,
            taskId,
            requestId,
            ...queryPage(url),
          })), requestId);
        }
        const detail = await adminCall("getTaskDetail", { identity, taskId, requestId });
        const key = parts[2] === "reservations" ? "budgetReservations" : "usageLedger";
        const values = Array.isArray(detail?.[key]) ? detail[key] : [];
        const page = queryPage(url);
        const items = values.slice(page.offset, page.offset + page.limit);
        return sendJson(response, 200, {
          items,
          rows: items,
          total: values.length,
          pagination: {
            limit: page.limit,
            offset: page.offset,
            total: values.length,
            hasMore: page.offset + items.length < values.length,
          },
        }, requestId);
      }
      if (parts.length === 4 && parts[2] === "attempts") {
        const attempt = await adminCall("getTaskAttempt", { identity, attemptId: parts[3], requestId });
        if (attempt?.taskId !== parts[1]) {
          throw new AiPlatformError("task attempt not found", { code: "not_found", status: 404 });
        }
        return sendJson(response, 200, { item: attempt }, requestId);
      }
    }
    const listMethods = new Map([
      ["providers", "listProviders"],
      ["agents", "listAgents"],
      ["standards", "listStandards"],
      ["models", "listModels"],
      ["prices", "listPrices"],
      ["budgets", "listBudgets"],
      ["schedules", "listSchedules"],
      ["audit", "listAudit"],
    ]);
    if (method === "GET" && parts.length === 1 && listMethods.has(parts[0])) {
      const args = copyQueryFields(url, { identity, requestId, ...queryPage(url) }, {
        providers: [],
        models: ["providerId", "enabled"],
        prices: ["modelId", "effectiveAt"],
        agents: ["lifecycle", "slug"],
        standards: ["lifecycle", "slug"],
        budgets: ["scopeType", "enabled"],
        schedules: ["enabled", "taskType"],
        audit: ["actor", "action", "resourceType", "from", "to"],
      }[parts[0]] ?? []);
      if (["models", "budgets", "schedules"].includes(parts[0])) {
        const enabled = queryBoolean(url, "enabled");
        if (enabled !== null) args.enabled = enabled;
      }
      return sendJson(response, 200, collectionResponse(await adminCall(listMethods.get(parts[0]), args)), requestId);
    }
    if (method === "GET" && parts.length === 1 && parts[0] === "costs") {
      const args = copyQueryFields(url, { identity, requestId }, [
        "owner", "feature", "modelId", "providerId", "agentVersionId", "taskType", "from", "to", "groupBy",
      ]);
      return sendJson(response, 200, { item: await adminCall("getCostSummary", {
        ...args,
      }) }, requestId);
    }
    if (method === "GET" && parts[0] === "schedules" && parts[1] === "runs") {
      if (parts.length === 2) {
        const args = copyQueryFields(url, { ...queryPage(url) }, ["scheduleId", "status"]);
        return sendJson(response, 200, collectionResponse(scheduleService.listScheduleRuns(args)), requestId);
      }
      if (parts.length === 3) {
        return sendJson(response, 200, { item: scheduleService.readScheduleRun(parts[2]) }, requestId);
      }
    }
    if (method === "GET" && parts[0] === "schedules" && parts[1] === "errors" && parts.length === 2) {
      const args = copyQueryFields(url, { ...queryPage(url) }, ["scheduleId"]);
      return sendJson(response, 200, collectionResponse(scheduleService.listScheduleErrors(args)), requestId);
    }

    const detailMethods = new Map([
      ["providers", "getProvider"],
      ["models", "getModel"],
      ["prices", "getPrice"],
      ["agents", "getAgent"],
      ["standards", "getStandard"],
      ["budgets", "getBudgetPolicy"],
      ["schedules", "getSchedule"],
    ]);
    if (method === "GET" && parts.length === 2 && detailMethods.has(parts[0])) {
      const idField = {
        providers: "providerId",
        models: "modelId",
        prices: "priceId",
        agents: "agentId",
        standards: "standardId",
        budgets: "policyId",
        schedules: "scheduleId",
      }[parts[0]];
      return sendJson(response, 200, {
        item: await adminCall(detailMethods.get(parts[0]), { identity, requestId, [idField]: parts[1] }),
      }, requestId);
    }

    const bodyRequired = ["POST", "PATCH", "PUT"].includes(method);
    const body = bodyRequired ? await readJsonBody(request, config.bodyLimitBytes) : null;
    const resource = parts[0];
    const resourceId = parts[1] ?? null;
    const action = parts[2] ?? null;
    if (method === "POST" && resource === "tasks" && resourceId && action === "cancel") {
      const writeAuth = await authenticate(request, ["ai:admin:write"], { admin: true });
      return sendJson(response, 200, {
        item: taskService.cancelTask({ identity: identityForTask(writeAuth), taskId: resourceId }),
      }, requestId);
    }
    if (method === "POST" && resource === "schedules" && !resourceId) {
      const writeAuth = await authenticate(request, ["ai:admin:write"], { admin: true });
      return sendJson(response, 201, {
        item: await scheduleCall("createSchedule", {
          ...body,
          actor: writeAuth.actor,
          requestId,
        }),
      }, requestId);
    }
    if (method === "POST" && resource === "schedules" && resourceId === "scan" && !action) {
      const writeAuth = await authenticate(request, ["ai:admin:write"], { admin: true });
      const scanOptions = pickBodyFields(body, ["limit", "maxOccurrencesPerSchedule"]);
      return sendJson(response, 200, {
        item: await scheduleCall("scanDue", {
          ...scanOptions,
          actor: writeAuth.actor,
          requestId,
        }),
      }, requestId);
    }
    if (method === "POST" && resource === "schedules" && resourceId && ["enable", "disable"].includes(action)) {
      const writeAuth = await authenticate(request, ["ai:admin:write"], { admin: true });
      const operation = action === "enable" ? "enableSchedule" : "disableSchedule";
      return sendJson(response, 200, {
        item: await scheduleCall(operation, {
          scheduleId: resourceId,
          actor: writeAuth.actor,
          requestId,
        }),
      }, requestId);
    }
    if (method === "POST" && resource === "agents" && !resourceId) {
      const writeAuth = await authenticate(request, ["ai:admin:write"], { admin: true });
      return sendJson(response, 201, { item: await adminCall("createAgent", { identity: identityForTask(writeAuth), draft: body, requestId }) }, requestId);
    }
    if (method === "PATCH" && resource === "agents" && resourceId && !action) {
      const writeAuth = await authenticate(request, ["ai:admin:write"], { admin: true });
      return sendJson(response, 200, { item: await adminCall("updateAgent", {
        identity: identityForTask(writeAuth),
        agentId: resourceId,
        draft: omitBodyFields(body, ["expectedUpdatedAt", "expectedVersionId", "expectedVersion", "expectedReleaseId"]),
        ...pickBodyFields(body, ["expectedUpdatedAt", "expectedVersionId", "expectedVersion", "expectedReleaseId"]),
        requestId,
      }) }, requestId);
    }
    if (method === "POST" && resource === "agents" && resourceId && action === "publish") {
      const writeAuth = await authenticate(request, ["ai:admin:publish"], { admin: true });
      return sendJson(response, 200, { item: await adminCall("publishAgent", {
        identity: identityForTask(writeAuth),
        agentId: resourceId,
        ...pickBodyFields(body, ["versionId", "agentVersionId", "draftVersionId", "testRunId", "offlineTestRunId", "expectedUpdatedAt", "expectedVersionId", "expectedVersion", "expectedReleaseId"]),
        requestId,
      }) }, requestId);
    }
    if (method === "POST" && resource === "agents" && resourceId && action === "rollback") {
      const writeAuth = await authenticate(request, ["ai:admin:publish"], { admin: true });
      return sendJson(response, 200, { item: await adminCall("rollbackAgent", {
        identity: identityForTask(writeAuth),
        agentId: resourceId,
        ...pickBodyFields(body, ["versionId", "agentVersionId", "targetVersionId", "testRunId", "offlineTestRunId", "expectedUpdatedAt", "expectedVersionId", "expectedVersion", "expectedReleaseId"]),
        requestId,
      }) }, requestId);
    }
    if (method === "POST" && resource === "standards" && !resourceId) {
      const writeAuth = await authenticate(request, ["ai:admin:write"], { admin: true });
      return sendJson(response, 201, { item: await adminCall("createStandard", { identity: identityForTask(writeAuth), draft: body, requestId }) }, requestId);
    }
    if (method === "PATCH" && resource === "standards" && resourceId) {
      const writeAuth = await authenticate(request, ["ai:admin:write"], { admin: true });
      return sendJson(response, 200, { item: await adminCall("updateStandard", {
        identity: identityForTask(writeAuth),
        standardId: resourceId,
        patch: omitBodyFields(body, ["expectedUpdatedAt", "expectedVersionId", "expectedVersion"]),
        ...pickBodyFields(body, ["expectedUpdatedAt", "expectedVersionId", "expectedVersion"]),
        requestId,
      }) }, requestId);
    }
    if (method === "PATCH" && resource === "budgets" && resourceId) {
      const writeAuth = await authenticate(request, ["ai:admin:write"], { admin: true });
      return sendJson(response, 200, { item: await adminCall("updateBudget", {
        identity: identityForTask(writeAuth),
        policyId: resourceId,
        patch: omitBodyFields(body, ["expectedUpdatedAt"]),
        ...pickBodyFields(body, ["expectedUpdatedAt"]),
        requestId,
      }) }, requestId);
    }
    if (method === "PATCH" && resource === "schedules" && resourceId) {
      const writeAuth = await authenticate(request, ["ai:admin:write"], { admin: true });
      return sendJson(response, 200, { item: await adminCall("updateSchedule", {
        identity: identityForTask(writeAuth),
        scheduleId: resourceId,
        patch: omitBodyFields(body, ["expectedUpdatedAt"]),
        ...pickBodyFields(body, ["expectedUpdatedAt"]),
        requestId,
      }) }, requestId);
    }
    throw new AiPlatformError("resource not found", { code: "not_found", status: 404 });
  }

  async function handleApi(request, response, requestId, url) {
    const suffix = url.pathname.slice(API_PREFIX.length);
    const parts = pathParts(suffix);
    if (parts[0] === "admin") return handleAdmin(request, response, requestId, url);
    if (parts[0] !== "tasks") throw new AiPlatformError("resource not found", { code: "not_found", status: 404 });

    const method = request.method ?? "GET";
    if (method === "POST" && parts.length === 1) {
      const auth = await authenticate(request, ["ai:task:create"]);
      const body = await readJsonBody(request, config.bodyLimitBytes);
      const item = taskService.createTask({
        identity: identityForTask(auth),
        idempotencyKey: request.headers["idempotency-key"],
        request: body,
      });
      const requestedWaitMs = Number(body.requestedWaitMs ?? 0);
      if (Number.isSafeInteger(requestedWaitMs) && requestedWaitMs > 0) {
        const task = await taskService.waitForTask({
          identity: identityForTask(auth),
          taskId: item.taskId,
          waitMs: requestedWaitMs,
        });
        return sendJson(response, 200, { item, task }, requestId);
      }
      return sendJson(response, item.replayed ? 200 : 202, { item }, requestId, { Location: `${API_PREFIX}/tasks/${item.taskId}` });
    }

    if (method === "GET" && parts.length === 1) {
      const auth = await authenticate(request, ["ai:task:read"]);
      return sendJson(response, 200, { items: taskService.listTasks({
        identity: identityForTask(auth),
        owner: url.searchParams.get("owner") || null,
        status: url.searchParams.get("status") || null,
        feature: url.searchParams.get("feature") || null,
        ...queryPage(url),
      }) }, requestId);
    }
    if (parts.length < 2) throw new AiPlatformError("resource not found", { code: "not_found", status: 404 });
    const taskId = parts[1];
    if (method === "GET" && parts.length === 2) {
      const auth = await authenticate(request, ["ai:task:read"]);
      return sendJson(response, 200, { item: taskService.readTask({ identity: identityForTask(auth), taskId }) }, requestId);
    }
    if (method === "GET" && parts.length === 3 && parts[2] === "result") {
      const auth = await authenticate(request, ["ai:task:read"]);
      return sendJson(response, 200, { item: taskService.readTaskResult({ identity: identityForTask(auth), taskId }) }, requestId);
    }
    if (method === "GET" && parts.length === 3 && parts[2] === "events") {
      const auth = await authenticate(request, ["ai:task:read"]);
      return sendJson(response, 200, { items: taskService.readTaskEvents({ identity: identityForTask(auth), taskId, limit: url.searchParams.get("limit") }) }, requestId);
    }
    if (method === "POST" && parts.length === 3 && parts[2] === "cancel") {
      const auth = await authenticate(request, ["ai:task:cancel"]);
      return sendJson(response, 200, { item: taskService.cancelTask({ identity: identityForTask(auth), taskId }) }, requestId);
    }
    throw new AiPlatformError("resource not found", { code: "not_found", status: 404 });
  }

  function health() {
    const requestId = randomUUID();
    return healthSnapshot(runtime, requestId);
  }

  const server = createHttpServer(async (request, response) => {
    const requestId = requestIdFor(request);
    const url = new URL(request.url ?? "/", "http://ai-platform.local");
    try {
      if (url.pathname === "/healthz" || url.pathname === "/readyz") {
        if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(response, requestId, "GET, HEAD");
        const snapshot = healthSnapshot(runtime, requestId);
        const ready = snapshot.status === "ok" && snapshot.database === "ready";
        if (url.pathname === "/readyz" && !ready) return sendJson(response, 503, snapshot, requestId);
        return sendJson(response, 200, snapshot, requestId);
      }
      const staticPrefix = [...STATIC_PREFIXES].find((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
      if (staticPrefix) return await serveStatic(request, response, config, requestId);
      if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        return await handleApi(request, response, requestId, url);
      }
      throw new AiPlatformError("resource not found", { code: "not_found", status: 404 });
    } catch (error) {
      const normalized = asPlatformError(error);
      logger.error?.("AI platform request failed", {
        requestId,
        method: request.method,
        path: url.pathname,
        code: normalized.code,
        status: normalized.status,
        error: normalized.status >= 500 ? error?.message : undefined,
      });
      sendJson(response, normalized.status, errorBody(error, requestId), requestId);
    }
  });
  server.aiPlatform = runtime;
  server.health = health;
  server.closeAiPlatform = (callback) => {
    runtime.close();
    server.close(callback);
  };
  return server;
}

function healthSnapshot(runtime, requestId = null) {
  let database = "ready";
  try { runtime.db.prepare("SELECT 1 AS ok").get(); } catch { database = "unavailable"; }
  const queue = database === "ready" ? queueSnapshot(runtime.db) : null;
  return {
    status: database === "ready" ? "ok" : "degraded",
    service: "sentelligent-ai-unified-platform",
    version: PACKAGE_VERSION,
    database,
    providers: runtime.providerRegistry.list().map((provider) => ({ id: provider.id, kind: provider.kind })),
    externalProvidersEnabled: runtime.config.externalProvidersEnabled,
    executionMode: runtime.config.executionMode,
    proactiveScheduleOwner: runtime.config.proactiveScheduleOwner,
    targetModel: runtime.config.targetModel,
    targetReasoningEffort: runtime.config.targetReasoningEffort,
    adminEnabled: runtime.config.adminEnabled,
    queue,
    ...(requestId ? { requestId } : {}),
  };
}

export { PACKAGE_VERSION };
