import { createHash, timingSafeEqual } from "node:crypto";

import { HttpError } from "../http/errors.js";

const ALLOWED_MACHINE_ROUTES = new Set([
  "GET /api/customers",
  "POST /api/quick-records/preview",
  "POST /api/quick-records",
  "POST /api/reports/weekly/draft",
  "POST /api/travel-expense-document-inbox",
  "POST /api/invoices",
  "POST /api/integrations/weixin-agent/events",
  "POST /api/integrations/hospital-tenders/sync",
  "GET /api/integrations/hospital-tenders/health",
]);
const QUICK_RECORD_ANALYZE_ROUTE = /^POST \/api\/quick-records\/[^/]+\/analyze$/;

const INTEGRATION_ROUTES = Object.freeze({
  "weixin-agent": new Set([
    "GET /api/customers",
    "POST /api/quick-records/preview",
    "POST /api/quick-records",
    "POST /api/reports/weekly/draft",
    "POST /api/travel-expense-document-inbox",
    "POST /api/invoices",
    "POST /api/integrations/weixin-agent/events",
  ]),
  "hospital-tender-monitor": new Set([
    "POST /api/integrations/hospital-tenders/sync",
    "GET /api/integrations/hospital-tenders/health",
  ]),
});

function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function configuredMachineCredentials(config) {
  const credentials = [];
  if (typeof config?.weixinAgentApiToken === "string" && config.weixinAgentApiToken.length > 0) {
    credentials.push({
      token: config.weixinAgentApiToken,
      integration: "weixin-agent",
      owner: config.weixinAgentOwner,
    });
  }
  if (typeof config?.hospitalTenderSyncToken === "string" && config.hospitalTenderSyncToken.length > 0) {
    credentials.push({
      token: config.hospitalTenderSyncToken,
      integration: "hospital-tender-monitor",
      owner: config.hospitalTenderSyncOwner,
    });
  }
  return credentials;
}

function configuredMachineOwner(config, integration, owner) {
  for (const value of [owner, config?.authAccount]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return integration === "hospital-tender-monitor" ? "hospital-tender-monitor" : "weixin-agent";
}

function machineIdentity(config, integration, owner) {
  return {
    account: configuredMachineOwner(config, integration, owner),
    integration,
  };
}

export function verifyMachineToken(token, config) {
  if (typeof token !== "string" || token.length === 0) return null;
  for (const credential of configuredMachineCredentials(config)) {
    // Hashing both values gives timingSafeEqual two equal-length buffers for every comparison.
    if (timingSafeEqual(tokenDigest(token), tokenDigest(credential.token))) {
      return machineIdentity(config, credential.integration, credential.owner);
    }
  }
  return null;
}

export function authenticateMachineRequest(header, config) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) return null;

  const identity = verifyMachineToken(match[1], config);
  return identity ? { ...identity, kind: "machine" } : null;
}

export function isMachineRouteAllowed(method, path, integration) {
  if (typeof method !== "string" || typeof path !== "string") return false;
  const route = `${method.toUpperCase()} ${path}`;
  if (integration) {
    const routes = INTEGRATION_ROUTES[integration];
    if (!routes) return false;
    return routes.has(route) || (integration === "weixin-agent" && QUICK_RECORD_ANALYZE_ROUTE.test(route));
  }
  return ALLOWED_MACHINE_ROUTES.has(route) || QUICK_RECORD_ANALYZE_ROUTE.test(route);
}

export function assertMachineRouteAllowed(method, path, integration) {
  if (!isMachineRouteAllowed(method, path, integration)) {
    throw new HttpError(403, "MACHINE_SCOPE_DENIED", "Machine token is not allowed for this route");
  }
}

export const assertMachineScope = assertMachineRouteAllowed;
