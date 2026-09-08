import { AI_ERROR_SCHEMA_VERSION } from "../../shared/aiPlatformContract.mjs";

export class AiPlatformError extends Error {
  constructor(message, { code = "internal_error", status = 500, details = null, cause = undefined } = {}) {
    super(message, { cause });
    this.name = "AiPlatformError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function asPlatformError(error) {
  if (error instanceof AiPlatformError) return error;
  if (error?.name === "AiContractError") {
    return new AiPlatformError(error.message, {
      code: error.code ?? "invalid_request",
      status: error.code === "payload_too_large" ? 413 : 400,
      details: error.details ?? null,
      cause: error,
    });
  }
  if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
    return new AiPlatformError("request conflicts with an existing resource", {
      code: "conflict",
      status: 409,
      cause: error,
    });
  }
  return new AiPlatformError("AI platform request failed", { code: "internal_error", status: 500, cause: error });
}

export function errorBody(error, requestId) {
  const normalized = asPlatformError(error);
  return {
    schemaVersion: AI_ERROR_SCHEMA_VERSION,
    requestId,
    error: {
      code: normalized.code,
      message: normalized.status >= 500 ? "AI platform request failed" : normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  };
}
