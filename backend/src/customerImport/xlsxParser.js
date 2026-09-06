import { inflateRawSync } from "node:zlib";

import { CUSTOMER_IMPORT_LIMITS } from "./constants.js";
import { importError } from "./errors.js";

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_HEADER = 0x06054b50;
const ZIP64_EXTRA_FIELD = 0x0001;

function invalidXlsx(message, fields = null) {
  return importError("CUSTOMER_IMPORT_INVALID_XLSX", message, fields);
}

function readU16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) throw invalidXlsx("XLSX ZIP header is truncated");
  return bytes.readUInt16LE(offset);
}

function readU32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) throw invalidXlsx("XLSX ZIP header is truncated");
  return bytes.readUInt32LE(offset);
}

function decodeUtf8(bytes, context) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidXlsx(`${context} is not valid UTF-8`);
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeZipPath(name) {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
    throw invalidXlsx("XLSX contains an unsafe archive path");
  }
  return name;
}

function findEndOfCentralDirectory(bytes) {
  const minimum = 22;
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - minimum; offset >= start; offset -= 1) {
    if (offset >= 0 && readU32(bytes, offset) === ZIP_END_HEADER) return offset;
  }
  throw invalidXlsx("XLSX ZIP end record is missing");
}

function parseZipEntries(bytes, limits, inflateRaw) {
  const endOffset = findEndOfCentralDirectory(bytes);
  const disk = readU16(bytes, endOffset + 4);
  const centralDisk = readU16(bytes, endOffset + 6);
  const entriesOnDisk = readU16(bytes, endOffset + 8);
  const totalEntries = readU16(bytes, endOffset + 10);
  const centralSize = readU32(bytes, endOffset + 12);
  const centralOffset = readU32(bytes, endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw invalidXlsx("Multi-disk XLSX archives are not supported");
  }
  if (totalEntries === 0 || totalEntries > limits.maxZipEntries) {
    throw invalidXlsx("XLSX contains too many archive entries", { maxEntries: limits.maxZipEntries });
  }
  if (centralOffset + centralSize > bytes.length) throw invalidXlsx("XLSX central directory is truncated");

  const entries = new Map();
  let declaredUncompressedBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readU32(bytes, offset) !== ZIP_CENTRAL_HEADER) throw invalidXlsx("XLSX central directory entry is invalid");
    const flags = readU16(bytes, offset + 8);
    const method = readU16(bytes, offset + 10);
    const crc = readU32(bytes, offset + 16);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > bytes.length) throw invalidXlsx("XLSX central directory entry is truncated");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = safeZipPath(decodeUtf8(nameBytes, "XLSX archive entry name"));
    if (flags & 0x0001) throw invalidXlsx("Encrypted XLSX entries are not supported");
    if (method !== 0 && method !== 8) throw invalidXlsx("XLSX uses an unsupported compression method", { name, method });
    if (uncompressedSize > limits.maxZipEntryBytes) {
      throw invalidXlsx("XLSX archive entry is too large", { name, maxBytes: limits.maxZipEntryBytes });
    }
    declaredUncompressedBytes += uncompressedSize;
    if (declaredUncompressedBytes > limits.maxZipTotalUncompressedBytes) {
      throw invalidXlsx("XLSX archive exceeds the cumulative decompression budget", {
        maxBytes: limits.maxZipTotalUncompressedBytes,
      });
    }
    if (method === 8 && uncompressedSize > 0) {
      const ratio = uncompressedSize / Math.max(compressedSize, 1);
      if (ratio > limits.maxZipCompressionRatio) {
        throw invalidXlsx("XLSX archive entry exceeds the compression-ratio budget", {
          name,
          maxRatio: limits.maxZipCompressionRatio,
        });
      }
    }
    if (entries.has(name)) throw invalidXlsx("XLSX contains duplicate archive entry names", { name });
    entries.set(name, {
      name,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      extraFlags: extraLength ? bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength) : null,
    });
    offset = recordEnd;
  }

  const cache = new Map();
  let inflatedBytes = 0;
  const get = (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (cache.has(name)) return cache.get(name);
    if (entry.compressedSize > bytes.length || entry.localOffset + 30 > bytes.length) {
      throw invalidXlsx("XLSX archive entry is truncated", { name });
    }
    if (readU32(bytes, entry.localOffset) !== ZIP_LOCAL_HEADER) throw invalidXlsx("XLSX local header is invalid", { name });
    const localNameLength = readU16(bytes, entry.localOffset + 26);
    const localExtraLength = readU16(bytes, entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart < 0 || dataEnd > bytes.length) throw invalidXlsx("XLSX archive data is truncated", { name });
    const compressed = bytes.subarray(dataStart, dataEnd);
    let output;
    try {
      output = entry.method === 0 ? Buffer.from(compressed) : inflateRaw(compressed, {
        maxOutputLength: entry.uncompressedSize,
      });
    } catch {
      throw invalidXlsx("XLSX archive entry could not be decompressed", { name });
    }
    if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc) {
      throw invalidXlsx("XLSX archive entry failed integrity validation", { name });
    }
    inflatedBytes += output.length;
    if (inflatedBytes > limits.maxZipTotalUncompressedBytes) {
      throw invalidXlsx("XLSX archive exceeds the cumulative decompression budget", {
        maxBytes: limits.maxZipTotalUncompressedBytes,
      });
    }
    cache.set(name, output);
    return output;
  };

  return { entries, get };
}

function xmlText(bytes, name, limits) {
  if (!bytes) throw invalidXlsx(`XLSX is missing ${name}`);
  if (bytes.length > limits.maxZipEntryBytes) throw invalidXlsx(`${name} exceeds the XML limit`);
  const text = decodeUtf8(bytes, name);
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(text)) throw invalidXlsx(`${name} contains a prohibited XML declaration`);
  let depth = 0;
  let maxDepth = 0;
  for (const token of text.matchAll(/<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\s*\/?>/g)) {
    const raw = token[0];
    if (raw.startsWith("<!--") || raw.startsWith("<?") || raw.endsWith("/>") || raw.startsWith("<!")) continue;
    if (raw.startsWith("</")) {
      depth -= 1;
    } else {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
    }
    if (depth < 0 || maxDepth > limits.maxXmlDepth) throw invalidXlsx(`${name} has an invalid XML nesting depth`);
  }
  return text;
}

function attributes(rawTag) {
  const result = {};
  const body = rawTag.replace(/^<[^\s>]+|\/?>(?:\s*)$/g, "");
  for (const match of body.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return result;
}

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function tagBlocks(xml, localName) {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b[^>]*>[\\s\\S]*?<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\s*>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => match[0]);
}

function tagInner(block, localName) {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^<[A-Za-z_][\\w:.-]*${escaped}\\b[^>]*>([\\s\\S]*)<\\/[A-Za-z_][\\w:.-]*${escaped}\\s*>$`, "i"));
  return match?.[1] ?? "";
}

function allTagText(block, localName) {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\s*>`, "gi");
  return [...block.matchAll(pattern)].map((match) => decodeXml(match[1].replace(/<[^>]+>/g, ""))).join("");
}

function firstTagText(block, localName) {
  return allTagText(block, localName);
}

function relationshipTarget(workbookRelationships, relationshipId) {
  for (const match of workbookRelationships.matchAll(/<Relationship\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (attrs.Id === relationshipId) {
      const target = attrs.Target ?? "";
      if (!target || target.includes("..")) throw invalidXlsx("XLSX workbook relationship target is unsafe");
      return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//u, "")}`;
    }
  }
  return null;
}

function columnIndexFromReference(reference) {
  const letters = String(reference).match(/^[A-Za-z]+/u)?.[0];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function cellValue(block, type, sharedStrings) {
  if (type === "inlineStr") return allTagText(block, "t");
  const value = firstTagText(block, "v");
  if (type === "s") {
    const index = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) {
      throw invalidXlsx("XLSX shared-string reference is invalid");
    }
    return sharedStrings[index];
  }
  if (type === "b") return value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
  if (type === "e") return value;
  if (value) return decodeXml(value);
  return allTagText(block, "t");
}

function parseSharedStrings(xml, limits) {
  const strings = [];
  for (const block of tagBlocks(xml, "si")) {
    if (strings.length >= limits.maxSharedStrings) throw invalidXlsx("XLSX contains too many shared strings");
    strings.push(firstTagText(block, "t"));
  }
  return strings;
}

function parseWorksheet(xml, sharedStrings, limits) {
  const rows = [];
  let fallbackRowNumber = 1;
  for (const rowBlock of tagBlocks(xml, "row")) {
    const rowAttributes = attributes(rowBlock.match(/^<[^>]+>/u)?.[0] ?? "");
    const rowNumber = Number.parseInt(rowAttributes.r ?? String(fallbackRowNumber), 10);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) throw invalidXlsx("XLSX row number is invalid");
    fallbackRowNumber = rowNumber + 1;
    const values = [];
    for (const cellMatch of rowBlock.matchAll(/<c\b[^>]*>[\s\S]*?<\/c\s*>/gi)) {
      const block = cellMatch[0];
      const cellAttributes = attributes(block.match(/^<c\b[^>]*>/iu)?.[0] ?? "");
      const columnIndex = columnIndexFromReference(cellAttributes.r ?? "");
      if (columnIndex === null || columnIndex >= limits.maxColumns) {
        throw invalidXlsx("XLSX contains too many columns", { maxColumns: limits.maxColumns, rowNumber });
      }
      const value = cellValue(block, cellAttributes.t ?? "", sharedStrings);
      if (value.length > limits.maxCellLength || Buffer.byteLength(value, "utf8") > limits.maxCellLength * 4) {
        throw invalidXlsx("XLSX cell exceeds the customer import field limit", { rowNumber, maxLength: limits.maxCellLength });
      }
      values[columnIndex] = value;
    }
    const bounded = Array.from({ length: Math.max(values.length, 0) }, (_, index) => values[index] ?? "");
    if (bounded.some((value) => String(value).trim())) {
      rows.push({ rowNumber, values: bounded });
      if (rows.length > limits.maxRows) throw invalidXlsx("XLSX contains too many data rows", { maxRows: limits.maxRows });
    }
  }
  if (rows.length === 0) throw importError("CUSTOMER_IMPORT_EMPTY_FILE", "XLSX does not contain a data row");
  return rows;
}

/** Parse the first worksheet of a bounded XLSX workbook into header/data rows. */
export function parseXlsxBytes(bytes, { limits = CUSTOMER_IMPORT_LIMITS, inflateRaw = inflateRawSync } = {}) {
  if (!bytes || typeof bytes.length !== "number") throw new TypeError("XLSX bytes are required");
  const zip = parseZipEntries(bytes, limits, inflateRaw);
  const workbookXml = xmlText(zip.get("xl/workbook.xml"), "xl/workbook.xml", limits);
  const relationshipsBytes = zip.get("xl/_rels/workbook.xml.rels");
  const relationshipsXml = relationshipsBytes
    ? xmlText(relationshipsBytes, "xl/_rels/workbook.xml.rels", limits)
    : "";
  const sharedStringsXml = zip.get("xl/sharedStrings.xml");
  const sharedStrings = sharedStringsXml
    ? parseSharedStrings(xmlText(sharedStringsXml, "xl/sharedStrings.xml", limits), limits)
    : [];

  let sheetPath = null;
  const sheetBlock = tagBlocks(workbookXml, "sheet")[0];
  if (sheetBlock) {
    const sheetAttributes = attributes(sheetBlock.match(/^<[^>]+>/u)?.[0] ?? "");
    sheetPath = relationshipTarget(relationshipsXml, sheetAttributes["r:id"] ?? sheetAttributes.id);
  }
  sheetPath ??= [...zip.entries.keys()].find((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)) ?? null;
  if (!sheetPath || !zip.entries.has(sheetPath)) throw invalidXlsx("XLSX does not contain a worksheet");
  const worksheetXml = xmlText(zip.get(sheetPath), sheetPath, limits);
  return parseWorksheet(worksheetXml, sharedStrings, limits);
}
