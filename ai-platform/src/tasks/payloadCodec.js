import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AiPlatformError } from "../errors.js";

const PREFIX = "aipayload1:";
export function createTaskPayloadCodec({ encryptionKey = null, required = false } = {}) {
  const key = encryptionKey ? Buffer.from(encryptionKey, "base64url") : null;
  if ((required && !key) || (key && (key.length !== 32 || key.toString("base64url") !== encryptionKey))) {
    throw new Error("AI platform task encryption key is required");
  }
  function aad(row, field) { return Buffer.from(JSON.stringify(["ai-task-payload-v1", row.id, row.owner, field])); }
  function encode(value, row, field) {
    if (value === null || value === undefined || !key) return value;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(row, field));
    const encoded = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return PREFIX + [iv, cipher.getAuthTag(), encoded].map((part) => part.toString("base64url")).join(":");
  }
  function decode(value, row, field) {
    if (value === null || value === undefined) return value;
    if (!value.startsWith(PREFIX)) {
      if (required) throw new AiPlatformError("task payload is not encrypted", { code: "payload_integrity_failed", status: 503 });
      return value;
    }
    try {
      if (!key) throw new Error("key missing");
      const parts = value.slice(PREFIX.length).split(":").map((part) => Buffer.from(part, "base64url"));
      if (parts.length !== 3) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", key, parts[0]);
      decipher.setAAD(aad(row, field)); decipher.setAuthTag(parts[1]);
      return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
    } catch {
      throw new AiPlatformError("task payload could not be verified", { code: "payload_integrity_failed", status: 503 });
    }
  }
  function decodeRow(row, { includeInput = true, includeOutput = true } = {}) {
    if (!row) return row;
    if (row.payload_pruned_at) return { ...row, input_json: "{}", output_json: null };
    return {
      ...row,
      ...(includeInput && row.input_json !== undefined ? { input_json: decode(row.input_json, row, "input") } : {}),
      ...(includeOutput && row.output_json !== undefined ? { output_json: decode(row.output_json, row, "output") } : {}),
    };
  }
  return { encode, decodeRow };
}
