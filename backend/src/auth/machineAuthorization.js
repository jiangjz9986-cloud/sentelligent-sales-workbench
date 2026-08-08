import { createHash, timingSafeEqual } from "node:crypto";

import { HttpError } from "../http/errors.js";

const ALLOWED_MACHINE_ROUTES = new Set([
  "GET /api/customers",
  "POST /api/quick-records",
  "POST /api/reports/weekly/draft",
  "POST /api/travel-expense-document-inbox",
  "POST /api/invoices",
]);
const QUICK_RECORD_ANALYZE_ROUTE = /^POST \/api\/quick-records\/[^/]+\/analyze$/;

function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function configuredMachineToken(config) {
  const token = config?.weixinAgentApiToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function configuredMachineOwner(config) {
  for (const value of [config?.weixinAgentOwner, config?.authAccount]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "weixin-agent";
}

function machineIdentity(config) {
  return {
    account: configuredMachineOwner(config),
    integration: "weixin-agent",
  };
}

export function verifyMachineToken(token, config) {
  const expected = configuredMachineToken(config);
  if (!expected || typeof token !== "string" || token.length === 0) return null;

  // Hashing both values gives timingSafeEqual two equal-length buffers for every comparison.
  return timingSafeEqual(tokenDigest(token), tokenDigest(expected))
    ? machineIdentity(config)
    : null;
}

export function authenticateMachineRequest(header, config) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) return null;

  const identity = verifyMachineToken(match[1], config);
  return identity ? { ...identity, kind: "machine" } : null;
}

export function isMachineRouteAllowed(method, path) {
  if (typeof method !== "string" || typeof path !== "string") return false;
  const route = `${method.toUpperCase()} ${path}`;
  return ALLOWED_MACHINE_ROUTES.has(route) || QUICK_RECORD_ANALYZE_ROUTE.test(route);
}

export function assertMachineRouteAllowed(method, path) {
  if (!isMachineRouteAllowed(method, path)) {
    throw new HttpError(403, "MACHINE_SCOPE_DENIED", "Machine token is not allowed for this route");
  }
}

export const assertMachineScope = assertMachineRouteAllowed;
