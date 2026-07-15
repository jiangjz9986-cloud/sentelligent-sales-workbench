export const INTERNAL_ERROR_MESSAGE = "Internal server error";

export class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    if (fields !== undefined) this.fields = fields;
  }
}

export function errorStatus(error) {
  return error instanceof HttpError && Number.isInteger(error.status)
    ? error.status
    : 500;
}

export function errorBody(error, requestId) {
  if (error instanceof HttpError) {
    const body = {
      error: {
        code: error.code,
        message: error.message,
        fields: error.fields ?? null,
        requestId,
      },
    };
    return body;
  }

  return {
    error: {
      code: "INTERNAL_ERROR",
      message: INTERNAL_ERROR_MESSAGE,
      fields: null,
      requestId,
    },
  };
}
