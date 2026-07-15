import { randomUUID } from "node:crypto";

import { errorBody, errorStatus } from "./errors.js";
import { corsHeaders, securityHeaders } from "./security.js";

export { securityHeaders } from "./security.js";

function responseHeaders({ config = {}, origin, headers = {}, requestId, contentType }) {
  const resolvedRequestId = requestId ?? headers["X-Request-Id"] ?? randomUUID();
  return {
    ...headers,
    ...securityHeaders(config),
    ...corsHeaders(origin, config),
    "X-Request-Id": resolvedRequestId,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

export function sendJson(response, statusCode, body, options = {}) {
  const headers = responseHeaders({
    ...options,
    contentType: "application/json; charset=utf-8",
  });
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(body));
}

export function sendDocument(response, statusCode, body, options = {}) {
  const headers = responseHeaders({
    ...options,
    contentType: options.headers?.["Content-Type"] ?? "application/octet-stream",
  });
  response.writeHead(statusCode, headers);
  response.end(body);
}

export function sendError(response, error, options = {}) {
  const requestId = options.requestId ?? options.headers?.["X-Request-Id"] ?? randomUUID();
  sendJson(response, errorStatus(error), errorBody(error, requestId), {
    ...options,
    requestId,
  });
}
