import { HttpError } from "../http/errors.js";

export class CustomerImportError extends HttpError {
  constructor(code, message, fields = null, status = 422) {
    super(status, code, message, fields);
    this.name = "CustomerImportError";
  }
}

export function importError(code, message, fields = null, status = 422) {
  return new CustomerImportError(code, message, fields, status);
}

export function assertImport(condition, code, message, fields = null, status = 422) {
  if (!condition) throw importError(code, message, fields, status);
}
