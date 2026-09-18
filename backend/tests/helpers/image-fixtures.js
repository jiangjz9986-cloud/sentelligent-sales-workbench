import { deflateSync } from "node:zlib";

export const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGPgUbL4DwACCgFmeGgpMwAAAABJRU5ErkJggg==",
  "base64",
);

export const VALID_JPEG = Buffer.from(
  "/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ9AFA4//9k=",
  "base64",
);

export const VALID_WEBP = Buffer.from(
  "UklGRjAAAABXRUJQVlA4ICQAAABQAQCdASoBAAEAAUAmJQBOgC6gAP77LkvF3YjjJ4dVU9ffoAA=",
  "base64",
);

export function minimalPdf(label = "") {
  const labelHex = Buffer.from(String(label), "utf8").toString("hex");
  const chunks = [Buffer.from(`%PDF-1.4\n% fixture-${labelHex}\n`, "ascii")];
  const offsets = [0];
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\nendstream\nendobj\n",
  ];

  let length = chunks[0].length;
  for (const object of objects) {
    offsets.push(length);
    const bytes = Buffer.from(object, "ascii");
    chunks.push(bytes);
    length += bytes.length;
  }

  const xrefOffset = length;
  const xrefEntries = offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  chunks.push(Buffer.from(
    `xref\n0 5\n0000000000 65535 f \n${xrefEntries}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    "ascii",
  ));
  return Buffer.concat(chunks);
}

function pdfXrefEntry(type, offset, generation) {
  const entry = Buffer.alloc(7);
  entry[0] = type;
  entry.writeUInt32BE(offset, 1);
  entry.writeUInt16BE(generation, 5);
  return entry;
}

export function predictorPdf(label = "") {
  const labelHex = Buffer.from(String(label), "utf8").toString("hex");
  const header = Buffer.from(`%PDF-1.5\n% predictor-${labelHex}\n`, "ascii");
  const catalog = Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "ascii");
  const pages = Buffer.from("2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n", "ascii");
  const xrefOffset = header.length + catalog.length + pages.length;
  const rows = Buffer.concat([
    pdfXrefEntry(0, 0, 65535),
    pdfXrefEntry(1, header.length, 0),
    pdfXrefEntry(1, header.length + catalog.length, 0),
    pdfXrefEntry(1, xrefOffset, 0),
  ]);
  const predicted = Buffer.alloc(rows.length + (rows.length / 7));
  let previous = Buffer.alloc(7);
  for (let row = 0; row < rows.length / 7; row += 1) {
    const sourceOffset = row * 7;
    const targetOffset = row * 8;
    predicted[targetOffset] = 2;
    for (let column = 0; column < 7; column += 1) {
      predicted[targetOffset + 1 + column] = (rows[sourceOffset + column] - previous[column] + 256) & 0xff;
    }
    previous = rows.subarray(sourceOffset, sourceOffset + 7);
  }
  const compressed = deflateSync(predicted);
  const xref = Buffer.concat([
    Buffer.from(`3 0 obj\n<< /Type /XRef /W [1 4 2] /Index [0 4] /Size 4 /Filter /FlateDecode /DecodeParms << /Columns 7 /Predictor 12 >> /Length ${compressed.length} /Root 1 0 R >>\nstream\n`, "ascii"),
    compressed,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii"),
  ]);
  return Buffer.concat([header, catalog, pages, xref]);
}

export function multiPagePdf(pageCount, label = "") {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new TypeError("pageCount must be a positive integer");
  }
  const labelHex = Buffer.from(String(label), "utf8").toString("hex");
  const chunks = [Buffer.from(`%PDF-1.4\n% fixture-${labelHex}\n`, "ascii")];
  const offsets = [0];
  const pageObjectNumbers = Array.from({ length: pageCount }, (_, index) => 3 + index);
  const contentObjectNumbers = Array.from({ length: pageCount }, (_, index) => 3 + pageCount + index);
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pageCount} >>\nendobj\n`,
    ...pageObjectNumbers.map((number, index) => (
      `${number} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents ${contentObjectNumbers[index]} 0 R >>\nendobj\n`
    )),
    ...contentObjectNumbers.map((number) => (
      `${number} 0 obj\n<< /Length 0 >>\nstream\nendstream\nendobj\n`
    )),
  ];

  let length = chunks[0].length;
  for (const object of objects) {
    offsets.push(length);
    const bytes = Buffer.from(object, "ascii");
    chunks.push(bytes);
    length += bytes.length;
  }

  const objectCount = objects.length + 1;
  const xrefOffset = length;
  const xrefEntries = offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  chunks.push(Buffer.from(
    `xref\n0 ${objectCount}\n0000000000 65535 f \n${xrefEntries}trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    "ascii",
  ));
  return Buffer.concat(chunks);
}

export const VALID_PDF = minimalPdf();
export const PDF_XREF_STREAM_PREDICTOR = predictorPdf();
export const PDF_PREFIX_SHELL = Buffer.from("%PDF-1.7\nnot a PDF document", "ascii");
export const TRUNCATED_PDF = VALID_PDF.subarray(0, VALID_PDF.length - 6);

const XREF_STREAM_SHELL_PREFIX = Buffer.from(
  "%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n",
  "ascii",
);
export const PDF_XREF_STREAM_SHELL = Buffer.from(
  `${XREF_STREAM_SHELL_PREFIX.toString("ascii")}2 0 obj\n<< /Type /XRef /Size 3 /W [1 2 1] /Root 1 0 R >>\nstream\narbitrary\nendobj\nstartxref\n${XREF_STREAM_SHELL_PREFIX.length}\n%%EOF\n`,
  "ascii",
);

const PDF_WITHOUT_OBJECTS_HEADER = "%PDF-1.4\n";
export const PDF_WITHOUT_OBJECTS = Buffer.from(
  `${PDF_WITHOUT_OBJECTS_HEADER}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(PDF_WITHOUT_OBJECTS_HEADER, "ascii")}\n%%EOF\n`,
  "ascii",
);

export const SHORT_PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const SHORT_JPEG_ENVELOPE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
export const SHORT_WEBP_CONTAINER = Buffer.from("RIFF\x04\x00\x00\x00WEBP", "latin1");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

export function paddedPng(sizeBytes) {
  const iendOffset = VALID_PNG.length - 12;
  const paddingBytes = sizeBytes - VALID_PNG.length - 12;
  if (!Number.isSafeInteger(paddingBytes) || paddingBytes < 0) {
    throw new TypeError("sizeBytes is too small for a padded PNG");
  }
  return Buffer.concat([
    VALID_PNG.subarray(0, iendOffset),
    pngChunk("pADd", Buffer.alloc(paddingBytes)),
    VALID_PNG.subarray(iendOffset),
  ]);
}
