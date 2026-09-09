import { readFile } from "node:fs/promises";
import { createRequestBinding } from "../../../shared/aiPlatformRequestAuth.mjs";
import { createAiPlatformServiceToken } from "./runtime.js";
import { HttpError } from "../http/errors.js";
import { readBoundedResponseText } from "../http/request.js";

export const AI_ADMIN_PREFIX = "/api/ai-platform/admin";
export const AI_CONSOLE_PREFIX = "/api/ai-platform/console";
const RESOURCE_NAMES = new Set(["overview", "health", "tasks", "agents", "standards", "providers", "models", "prices", "budgets", "schedules", "costs", "audit"]);
const ASSETS = new Map([["index.html", "text/html; charset=utf-8"], ["admin.js", "text/javascript; charset=utf-8"], ["admin.css", "text/css; charset=utf-8"]]);

export async function readAiConsoleAsset(pathname) {
  const name = pathname.slice(AI_CONSOLE_PREFIX.length + 1) || "index.html";
  if (!ASSETS.has(name)) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  const body = await readFile(new URL(`../../../outputs/ai-platform-admin/${name}`, import.meta.url));
  return { body, contentType: ASSETS.get(name) };
}

export function createAiAdminProxy({ config, fetchImpl = fetch }) {
  return async function proxy({ method, url, body, identity, requestId, signal }) {
    if (identity?.role !== "admin" || identity?.status !== "active" || !identity?.account) {
      throw new HttpError(403, "ADMIN_ROLE_REQUIRED", "Administrator role is required");
    }
    const suffix = url.pathname.slice(AI_ADMIN_PREFIX.length);
    const segments = suffix.split("/").filter(Boolean);
    if (!url.pathname.startsWith(AI_ADMIN_PREFIX + "/") || suffix.length > 2048
      || !RESOURCE_NAMES.has(segments[0]) || segments.length > 4
      || segments.some((part) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(part) || part === "." || part === "..")
      || !["GET", "POST", "PATCH"].includes(method) || url.search.length > 4096) {
      throw new HttpError(404, "NOT_FOUND", "Management resource not found");
    }
    if (!config.aiPlatformBaseUrl || !config.aiPlatformAuthSecret) {
      throw new HttpError(503, "AI_PLATFORM_NOT_CONFIGURED", "AI platform administration is unavailable");
    }
    const target = new URL(config.aiPlatformBaseUrl);
    if ((target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)))
      || target.username || target.password || target.search || target.hash) {
      throw new HttpError(503, "AI_PLATFORM_NOT_CONFIGURED", "AI platform administration is unavailable");
    }
    target.pathname = target.pathname.replace(/\/+$/u, "") + "/internal/ai/v1/admin" + suffix;
    target.search = url.search;
    const text = method === "GET" ? "" : JSON.stringify(body ?? {});
    if (Buffer.byteLength(text) > 512 * 1024) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Management request is too large");
    const scopes = method === "GET" ? ["ai:admin:read"]
      : ["ai:admin:write", ...(["publish", "rollback"].includes(segments[2]) ? ["ai:admin:publish"] : [])];
    const token = createAiPlatformServiceToken({
      secret: config.aiPlatformAuthSecret,
      issuer: config.aiPlatformIssuer, subject: "sentelligent-admin-proxy",
      owner: identity.account, actor: identity.account, scopes,
      requestBinding: createRequestBinding({ method, path: target.pathname + target.search, body: text }),
    });
    const timeoutSignal = AbortSignal.timeout(Math.min(config.aiPlatformRequestTimeoutMs ?? 30_000, 60_000));
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let result;
    try {
      const response = await fetchImpl(target.href, {
        method, signal: combined, redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "X-Request-Id": requestId, ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) },
        ...(method !== "GET" ? { body: text } : {}),
      });
      const payload = JSON.parse(await readBoundedResponseText(response, { maxBytes: 1024 * 1024 }));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid response");
      if ([401, 403].includes(response.status)) throw new HttpError(502, "AI_PLATFORM_AUTH_UNAVAILABLE", "AI platform service authentication failed");
      if (response.status >= 500) throw new HttpError(503, "AI_PLATFORM_UNAVAILABLE", "AI platform is unavailable");
      result = { status: response.status, payload };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "AI_PLATFORM_UNAVAILABLE", "AI platform is unavailable");
    }
    return result;
  };
}
