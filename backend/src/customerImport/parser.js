import { basename } from "node:path";

import { CUSTOMER_IMPORT_FORMATS, CUSTOMER_IMPORT_LIMITS, CUSTOMER_IMPORT_MEDIA_TYPES } from "./constants.js";
import { importError } from "./errors.js";
import { sha256Bytes } from "./stable.js";
import { parseCsvBytes } from "./csvParser.js";
import { parseXlsxBytes } from "./xlsxParser.js";

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (value && typeof value === "object" && value.buffer instanceof ArrayBuffer) {
    return Buffer.from(value.buffer, value.byteOffset ?? 0, value.byteLength ?? value.buffer.byteLength);
  }
  throw new TypeError("Customer import file bytes must be a Buffer, Uint8Array, or ArrayBuffer");
}

function normalizeFileName(value) {
  const raw = String(value ?? "customer-import.csv").replaceAll("\\", "/");
  const safe = basename(raw).trim();
  if (!safe || safe === "." || safe === ".." || /[\u0000-\u001f\u007f]/u.test(safe)) {
    throw importError("CUSTOMER_IMPORT_INVALID_FILE_NAME", "The import file name is invalid");
  }
  if (safe.length > 255) throw importError("CUSTOMER_IMPORT_FILE_NAME_TOO_LONG", "The import file name is too long");
  return safe;
}

function normalizedMediaType(value) {
  if (typeof value !== "string") return "";
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function detectCustomerImportFormat(fileName, mediaType = "") {
  const extension = String(fileName ?? "").toLowerCase().split(".").pop();
  const type = normalizedMediaType(mediaType);
  if (extension === "csv" || type === "text/csv" || type === "application/csv" || type === "text/plain") {
    return CUSTOMER_IMPORT_FORMATS.csv;
  }
  if (
    extension === "xlsx"
    || type === CUSTOMER_IMPORT_MEDIA_TYPES.xlsx
    || type === "application/xlsx"
  ) return CUSTOMER_IMPORT_FORMATS.xlsx;
  throw importError(
    "CUSTOMER_IMPORT_UNSUPPORTED_FORMAT",
    "Only UTF-8 CSV and XLSX files are supported",
    { fileName, mediaType: type || null },
  );
}

function boundedHeader(value, index, limits) {
  const header = String(value ?? "").replace(/^\uFEFF/u, "").trim();
  if (header.length > limits.maxHeaderLength || Buffer.byteLength(header, "utf8") > limits.maxHeaderLength * 4) {
    throw importError("CUSTOMER_IMPORT_HEADER_TOO_LONG", "A file header is too long", {
      column: index + 1,
      maxLength: limits.maxHeaderLength,
    });
  }
  if (!header) throw importError("CUSTOMER_IMPORT_EMPTY_HEADER", "A file header cannot be empty", { column: index + 1 });
  return header;
}

function validateHeaders(values, limits) {
  if (!Array.isArray(values) || values.length === 0) {
    throw importError("CUSTOMER_IMPORT_MISSING_HEADER", "The import file must contain a header row");
  }
  if (values.length > limits.maxColumns) {
    throw importError("CUSTOMER_IMPORT_TOO_MANY_COLUMNS", "The import file contains too many columns", {
      maxColumns: limits.maxColumns,
    });
  }
  const headers = values.map((value, index) => boundedHeader(value, index, limits));
  const seen = new Set();
  for (const header of headers) {
    const identity = header.normalize("NFKC").replace(/[\s\u200b]+/gu, "").toLocaleLowerCase();
    if (seen.has(identity)) {
      throw importError("CUSTOMER_IMPORT_DUPLICATE_HEADER", "The import file contains duplicate headers", { header });
    }
    seen.add(identity);
  }
  return headers;
}

function normalizeRows(rows, headers, limits) {
  return rows.map((row) => {
    if (!Array.isArray(row.values)) throw importError("CUSTOMER_IMPORT_INVALID_ROW", "The import row is invalid");
    if (row.values.length > limits.maxColumns) {
      throw importError("CUSTOMER_IMPORT_TOO_MANY_COLUMNS", "The import row contains too many columns", {
        rowNumber: row.rowNumber,
        maxColumns: limits.maxColumns,
      });
    }
    if (row.values.length > headers.length) {
      throw importError("CUSTOMER_IMPORT_COLUMN_COUNT_MISMATCH", "The import row contains more cells than its header", {
        rowNumber: row.rowNumber,
        expected: headers.length,
        received: row.values.length,
      });
    }
    const values = headers.map((_, index) => String(row.values[index] ?? ""));
    return { rowNumber: row.rowNumber, values };
  });
}

/**
 * Parse a customer import file. The parser is synchronous by design so the
 * returned rows can be consumed inside a SQLite preview transaction without
 * retaining a file handle or a raw byte payload.
 */
export function parseCustomerImportFile(input, options = {}) {
  const source = input && typeof input === "object" && !Buffer.isBuffer(input) && !(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)
    ? input
    : { bytes: input };
  const limits = { ...CUSTOMER_IMPORT_LIMITS, ...(options.limits ?? source.limits ?? {}) };
  const bytes = asBuffer(source.bytes ?? source.buffer ?? source.data);
  if (bytes.length === 0) throw importError("CUSTOMER_IMPORT_EMPTY_FILE", "The import file is empty");
  if (bytes.length > limits.maxFileBytes) {
    throw importError("CUSTOMER_IMPORT_FILE_TOO_LARGE", "The import file exceeds the size limit", {
      fileSizeBytes: bytes.length,
      maxFileBytes: limits.maxFileBytes,
    });
  }
  const fileName = normalizeFileName(source.fileName ?? options.fileName ?? "customer-import.csv");
  const mediaType = normalizedMediaType(source.mediaType ?? options.mediaType ?? "");
  const format = detectCustomerImportFormat(fileName, mediaType);
  const parsedRows = format === CUSTOMER_IMPORT_FORMATS.csv
    ? parseCsvBytes(bytes, { limits })
    : parseXlsxBytes(bytes, { limits });
  const headerRow = parsedRows[0];
  const headers = validateHeaders(headerRow.values, limits);
  const dataRows = normalizeRows(parsedRows.slice(1), headers, limits);
  return {
    format,
    fileName,
    mediaType: mediaType || CUSTOMER_IMPORT_MEDIA_TYPES[format],
    fileSizeBytes: bytes.length,
    fileSha256: sha256Bytes(bytes),
    headers,
    rows: dataRows,
  };
}

export async function readCustomerImportBytes(file) {
  if (file?.bytes !== undefined || file?.buffer !== undefined || file?.data !== undefined) {
    return asBuffer(file.bytes ?? file.buffer ?? file.data);
  }
  if (file && typeof file.arrayBuffer === "function") return asBuffer(await file.arrayBuffer());
  return asBuffer(file);
}

export async function parseCustomerImportFileAsync(input, options = {}) {
  const source = input && typeof input === "object" && !Buffer.isBuffer(input) && !(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)
    ? input
    : { bytes: input };
  const bytes = await readCustomerImportBytes(source);
  return parseCustomerImportFile({ ...source, bytes }, options);
}

export const parseCustomerImport = parseCustomerImportFile;
