import { createHash } from "node:crypto";

function stableValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Stable import JSON does not accept non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Stable import JSON only accepts JSON values");
  if (ancestors.has(value)) throw new TypeError("Stable import JSON does not accept cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableValue(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Stable import JSON only accepts plain objects");
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function stableImportJson(value) {
  return stableValue(value);
}

export function importDigest(value) {
  return createHash("sha256").update(stableImportJson(value), "utf8").digest("hex");
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
