import { TextDecoder } from "node:util";

import { CUSTOMER_IMPORT_LIMITS } from "./constants.js";
import { importError } from "./errors.js";

function utf8Length(value) {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value, label, limits, byteLength) {
  if (value.length > limits.maxCellLength || byteLength(value) > limits.maxCellLength * 4) {
    throw importError(
      "CUSTOMER_IMPORT_FIELD_TOO_LARGE",
      `${label} exceeds the customer import field limit`,
      { label, maxLength: limits.maxCellLength },
    );
  }
  return value;
}

function isBlankRecord(record) {
  return record.every((value) => !String(value ?? "").trim());
}

/**
 * Parse RFC 4180-style CSV without splitting on newlines. The state machine
 * intentionally keeps quoted newlines inside one field and rejects characters
 * after a closing quote unless they are whitespace before a delimiter.
 */
export function parseCsvBytes(bytes, { limits = CUSTOMER_IMPORT_LIMITS, byteLength = utf8Length } = {}) {
  if (!bytes || typeof bytes.length !== "number") {
    throw new TypeError("CSV bytes are required");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw importError("CUSTOMER_IMPORT_INVALID_UTF8", "CSV must be valid UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\u0000")) {
    throw importError("CUSTOMER_IMPORT_INVALID_CSV", "CSV contains a NUL character");
  }

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let rowNumber = 1;
  let fieldStart = 0;
  let recordBytes = 0;
  let fieldBytes = 0;

  const fail = (message, fields = null) => {
    throw importError("CUSTOMER_IMPORT_INVALID_CSV", message, fields);
  };

  const pushField = () => {
    row.push(boundedText(field, `row ${rowNumber} field ${row.length + 1}`, limits, byteLength));
    field = "";
    fieldBytes = 0;
    afterQuote = false;
    fieldStart = 0;
  };

  const pushRow = () => {
    pushField();
    if (!isBlankRecord(row)) {
      if (row.length > limits.maxColumns) {
        throw importError(
          "CUSTOMER_IMPORT_TOO_MANY_COLUMNS",
          "CSV row contains too many columns",
          { rowNumber, maxColumns: limits.maxColumns },
        );
      }
      rows.push({ rowNumber, values: row });
      if (rows.length > limits.maxRows) {
        throw importError(
          "CUSTOMER_IMPORT_TOO_MANY_ROWS",
          "CSV contains too many data rows",
          { maxRows: limits.maxRows },
        );
      }
    }
    row = [];
    rowNumber += 1;
    recordBytes = 0;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    recordBytes += byteLength(character);
    if (recordBytes > limits.maxCsvRecordBytes) {
      throw importError(
        "CUSTOMER_IMPORT_ROW_TOO_LARGE",
        "CSV row exceeds the import record limit",
        { rowNumber, maxBytes: limits.maxCsvRecordBytes },
      );
    }

    if (inQuotes) {
      if (character === '"') {
        if (next === '"') {
          field += '"';
          fieldBytes += 1;
          index += 1;
          recordBytes += byteLength(next);
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (afterQuote) {
      if (character === ",") {
        pushField();
        continue;
      }
      if (character === "\r") {
        if (next === "\n") index += 1;
        pushRow();
        continue;
      }
      if (character === "\n") {
        pushRow();
        continue;
      }
      if (/\s/u.test(character)) continue;
      fail("CSV contains data after a closing quote", { rowNumber, position: index + 1 });
    }

    if (character === '"') {
      if (field.length !== 0) {
        fail("CSV quote must start a field", { rowNumber, position: index + 1 });
      }
      inQuotes = true;
      fieldStart = index;
      continue;
    }
    if (character === ",") {
      pushField();
      continue;
    }
    if (character === "\r") {
      if (next === "\n") index += 1;
      pushRow();
      continue;
    }
    if (character === "\n") {
      pushRow();
      continue;
    }
    field += character;
    fieldBytes += byteLength(character);
    if (field.length > limits.maxCellLength || fieldBytes > limits.maxCellLength * 4) {
      throw importError(
        "CUSTOMER_IMPORT_FIELD_TOO_LARGE",
        `row ${rowNumber} field ${row.length + 1} exceeds the customer import field limit`,
        { rowNumber, fieldIndex: row.length + 1, maxLength: limits.maxCellLength },
      );
    }
  }

  if (inQuotes) {
    fail("CSV contains an unterminated quoted field", { rowNumber, position: fieldStart + 1 });
  }
  if (field.length > 0 || row.length > 0 || afterQuote) pushRow();

  if (rows.length === 0) {
    throw importError("CUSTOMER_IMPORT_EMPTY_FILE", "CSV does not contain a data row");
  }
  return rows;
}
