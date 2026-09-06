import { basename } from "node:path";

import { HttpError } from "../http/errors.js";
import { CUSTOMER_IMPORT_LIMITS } from "./constants.js";
import { importError } from "./errors.js";

const DEFAULT_OVERHEAD_BYTES = 64 * 1024;
const DEFAULT_MAX_PARTS = 3;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_MAX_MAPPING_BYTES = 64 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const BOUNDARY_VALUE = /^[\u0020-\u007e]+$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function singleHeader(request, name) {
  const normalizedName = name.toLowerCase();
  const count = Array.isArray(request?.rawHeaders)
    ? request.rawHeaders.filter((value, index) => (
      index % 2 === 0 && String(value).toLowerCase() === normalizedName
    )).length
    : 0;
  const value = request?.headers?.[normalizedName];
  if (count > 1 || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_MULTIPART", `Only one ${name} header is allowed`);
  }
  return typeof value === "string" ? value : null;
}

function splitParameters(value) {
  const result = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of String(value ?? "")) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === ";" && !quoted) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (quoted || escaped) throw new HttpError(400, "INVALID_MULTIPART", "Malformed multipart header parameters");
  result.push(current.trim());
  return result;
}

function parameterValue(value, name) {
  const segments = splitParameters(value);
  const mediaType = String(segments.shift() ?? "").toLowerCase();
  const parameters = new Map();
  for (const segment of segments) {
    if (!segment) continue;
    const equals = segment.indexOf("=");
    if (equals <= 0) throw new HttpError(400, "INVALID_MULTIPART", "Malformed multipart header parameter");
    const key = segment.slice(0, equals).trim().toLowerCase();
    let raw = segment.slice(equals + 1).trim();
    if (!HEADER_NAME.test(key) || parameters.has(key)) {
      throw new HttpError(400, "INVALID_MULTIPART", "Malformed or duplicate multipart header parameter");
    }
    if (raw.startsWith('"')) {
      if (!raw.endsWith('"') || raw.length < 2) {
        throw new HttpError(400, "INVALID_MULTIPART", "Malformed quoted multipart header parameter");
      }
      raw = raw.slice(1, -1).replace(/\\(["\\])/gu, "$1");
    }
    parameters.set(key, raw);
  }
  return { mediaType, value: parameters.get(name.toLowerCase()) ?? null, parameters };
}

function multipartBoundary(request) {
  const contentType = singleHeader(request, "Content-Type");
  if (!contentType) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Customer import preview requires multipart/form-data");
  }
  const parsed = parameterValue(contentType, "boundary");
  const boundary = parsed.value;
  if (
    parsed.mediaType !== "multipart/form-data"
    || !boundary
    || boundary.length > 70
    || boundary.trim() !== boundary
    || !BOUNDARY_VALUE.test(boundary)
    || CONTROL_CHARACTERS.test(boundary)
  ) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Customer import preview requires a valid multipart/form-data boundary");
  }
  return boundary;
}

function contentLength(request, maxBytes) {
  const raw = singleHeader(request, "Content-Length");
  if (raw === null) return null;
  if (!/^\d+$/u.test(raw)) throw new HttpError(400, "INVALID_CONTENT_LENGTH", "Content-Length must be a non-negative integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Customer import request is too large");
  if (value > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Customer import request is too large");
  return value;
}

async function readBoundedBody(request, maxBytes) {
  contentLength(request, maxBytes);
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Customer import request is too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function parseHeaders(bytes, maxHeaderBytes) {
  if (bytes.length === 0 || bytes.length > maxHeaderBytes) {
    throw new HttpError(400, "INVALID_MULTIPART", "Multipart part headers are invalid or too large");
  }
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD") || CONTROL_CHARACTERS.test(text.replaceAll("\r", "").replaceAll("\n", ""))) {
    throw new HttpError(400, "INVALID_MULTIPART", "Multipart part headers must be valid UTF-8 text");
  }
  const headers = new Map();
  for (const line of text.split("\r\n")) {
    if (!line || /^[ \t]/u.test(line)) throw new HttpError(400, "INVALID_MULTIPART", "Folded multipart headers are not allowed");
    const colon = line.indexOf(":");
    if (colon <= 0) throw new HttpError(400, "INVALID_MULTIPART", "Malformed multipart part header");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!HEADER_NAME.test(name) || !value || headers.has(name)) {
      throw new HttpError(400, "INVALID_MULTIPART", "Malformed or duplicate multipart part header");
    }
    headers.set(name, value);
  }
  return headers;
}

function disposition(headers) {
  const raw = headers.get("content-disposition");
  if (!raw) throw new HttpError(400, "INVALID_MULTIPART", "Each multipart part requires Content-Disposition");
  const parsed = parameterValue(raw, "name");
  if (parsed.mediaType !== "form-data" || !parsed.value || parsed.value.length > 100) {
    throw new HttpError(400, "INVALID_MULTIPART", "Multipart Content-Disposition is invalid");
  }
  return {
    name: parsed.value,
    filename: parsed.parameters.get("filename") ?? null,
  };
}

function safeFileName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 255 || CONTROL_CHARACTERS.test(value)) {
    throw importError("CUSTOMER_IMPORT_INVALID_FILE_NAME", "导入文件名无效", { file: "fileName" });
  }
  const normalized = value.trim();
  if (normalized.includes("/") || normalized.includes("\\") || basename(normalized) !== normalized) {
    throw importError("CUSTOMER_IMPORT_INVALID_FILE_NAME", "导入文件名不能包含路径", { file: "fileName" });
  }
  return normalized;
}

function partMediaType(headers) {
  const raw = headers.get("content-type");
  if (!raw) return null;
  const parsed = parameterValue(raw, "charset");
  if (!parsed.mediaType || CONTROL_CHARACTERS.test(parsed.mediaType)) {
    throw new HttpError(400, "INVALID_MULTIPART", "Multipart part Content-Type is invalid");
  }
  return parsed.mediaType;
}

function parseParts(body, boundary, { maxParts, maxHeaderBytes }) {
  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const marker = Buffer.from(`\r\n--${boundary}`, "utf8");
  const headerTerminator = Buffer.from("\r\n\r\n", "ascii");
  const crlf = Buffer.from("\r\n", "ascii");
  const closing = Buffer.from("--", "ascii");
  const parts = [];
  let offset = 0;

  if (body.length < delimiter.length + 4 || !body.subarray(0, delimiter.length).equals(delimiter)) {
    throw new HttpError(400, "INVALID_MULTIPART", "Multipart body does not begin with its declared boundary");
  }
  offset = delimiter.length;
  if (!body.subarray(offset, offset + crlf.length).equals(crlf)) {
    throw new HttpError(400, "INVALID_MULTIPART", "Multipart opening boundary is malformed");
  }
  offset += crlf.length;

  while (offset < body.length) {
    if (parts.length >= maxParts) throw new HttpError(413, "MULTIPART_TOO_MANY_PARTS", "Customer import request has too many parts");
    const headerEnd = body.indexOf(headerTerminator, offset);
    if (headerEnd < 0 || headerEnd - offset > maxHeaderBytes) {
      throw new HttpError(400, "INVALID_MULTIPART", "Multipart part headers are missing or too large");
    }
    const headers = parseHeaders(body.subarray(offset, headerEnd), maxHeaderBytes);
    const contentStart = headerEnd + headerTerminator.length;
    const nextMarker = body.indexOf(marker, contentStart);
    if (nextMarker < 0) throw new HttpError(400, "INVALID_MULTIPART", "Multipart closing boundary is missing");
    parts.push({ headers, bytes: body.subarray(contentStart, nextMarker) });

    offset = nextMarker + crlf.length + delimiter.length;
    if (body.subarray(offset, offset + closing.length).equals(closing)) {
      offset += closing.length;
      if (body.subarray(offset, offset + crlf.length).equals(crlf)) offset += crlf.length;
      if (offset !== body.length) throw new HttpError(400, "INVALID_MULTIPART", "Multipart epilogue is not allowed");
      return parts;
    }
    if (!body.subarray(offset, offset + crlf.length).equals(crlf)) {
      throw new HttpError(400, "INVALID_MULTIPART", "Multipart boundary separator is malformed");
    }
    offset += crlf.length;
  }
  throw new HttpError(400, "INVALID_MULTIPART", "Multipart closing boundary is missing");
}

function parseMapping(bytes, maxBytes) {
  if (bytes.length > maxBytes) throw new HttpError(413, "MULTIPART_FIELD_TOO_LARGE", "Customer import mapping is too large");
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD")) throw importError("CUSTOMER_IMPORT_INVALID_MAPPING", "mapping 必须是 UTF-8 JSON 对象", { mapping: "encoding" });
  let value;
  try {
    value = JSON.parse(text || "null");
  } catch {
    throw importError("CUSTOMER_IMPORT_INVALID_MAPPING", "mapping 必须是有效 JSON", { mapping: "json" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw importError("CUSTOMER_IMPORT_INVALID_MAPPING", "mapping 必须是 JSON 对象", { mapping: "object" });
  }
  return value;
}

/**
 * Decode the frozen customer-import multipart request without persisting raw
 * bytes. The returned Buffer is request-scoped and is passed directly to the
 * bounded CSV/XLSX parser.
 */
export async function readCustomerImportMultipart(request, {
  maxFileBytes = CUSTOMER_IMPORT_LIMITS.maxFileBytes,
  maxParts = DEFAULT_MAX_PARTS,
  maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES,
  maxMappingBytes = DEFAULT_MAX_MAPPING_BYTES,
  maxRequestBytes = maxFileBytes + DEFAULT_OVERHEAD_BYTES,
} = {}) {
  for (const [name, value] of Object.entries({ maxFileBytes, maxParts, maxHeaderBytes, maxMappingBytes, maxRequestBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  if (maxRequestBytes < maxFileBytes) throw new RangeError("maxRequestBytes must cover maxFileBytes");

  const boundary = multipartBoundary(request);
  const body = await readBoundedBody(request, maxRequestBytes);
  const parts = parseParts(body, boundary, { maxParts, maxHeaderBytes });
  let file = null;
  let mapping = null;

  for (const part of parts) {
    const { name, filename } = disposition(part.headers);
    if (name === "owner" || name === "account") {
      throw importError(
        "CUSTOMER_IMPORT_OWNER_NOT_ALLOWED",
        "owner is supplied by the authenticated session and cannot be overridden",
        { owner: "server_owned" },
      );
    }
    if (name === "file") {
      if (file) throw importError("CUSTOMER_IMPORT_DUPLICATE_FILE", "只能上传一个客户导入文件", { file: "duplicate" });
      if (!filename) throw importError("CUSTOMER_IMPORT_FILE_REQUIRED", "file 字段必须包含文件名", { file: "filename" });
      if (part.bytes.length < 1) throw importError("CUSTOMER_IMPORT_FILE_REQUIRED", "客户导入文件不能为空", { file: "empty" });
      if (part.bytes.length > maxFileBytes) throw importError("CUSTOMER_IMPORT_FILE_TOO_LARGE", "客户导入文件过大", { file: "maxFileBytes" }, 413);
      file = {
        bytes: Buffer.from(part.bytes),
        fileName: safeFileName(filename),
        mediaType: partMediaType(part.headers),
      };
      continue;
    }
    if (name === "mapping") {
      if (mapping !== null) throw importError("CUSTOMER_IMPORT_DUPLICATE_MAPPING", "只能提交一个 mapping 字段", { mapping: "duplicate" });
      if (filename) throw importError("CUSTOMER_IMPORT_INVALID_MAPPING", "mapping 不能作为文件上传", { mapping: "file" });
      mapping = parseMapping(part.bytes, maxMappingBytes);
      continue;
    }
    throw importError("CUSTOMER_IMPORT_UNKNOWN_FIELD", `不支持的客户导入字段：${name}`, { [name]: "unknown" });
  }

  if (!file) throw importError("CUSTOMER_IMPORT_FILE_REQUIRED", "必须提供 file 字段", { file: "required" });
  return {
    file,
    body: mapping === null ? {} : { mapping },
  };
}
