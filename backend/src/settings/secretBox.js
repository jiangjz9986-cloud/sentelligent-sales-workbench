import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const AAD = Buffer.from("sentelligent.settings.v1", "utf8");

function keyBuffer(masterKey) {
  if (Buffer.isBuffer(masterKey)) {
    if (masterKey.length !== 32) throw new Error("Settings encryption key must contain 32 bytes");
    return masterKey;
  }
  if (typeof masterKey !== "string" || !masterKey.trim()) {
    throw new Error("Settings encryption key is required");
  }
  let decoded;
  try {
    decoded = Buffer.from(masterKey, "base64url");
  } catch {
    throw new Error("Settings encryption key must be base64url encoded");
  }
  if (decoded.length !== 32 || decoded.toString("base64url") !== masterKey) {
    throw new Error("Settings encryption key must be canonical base64url encoding of 32 bytes");
  }
  return decoded;
}

export function isValidSettingsEncryptionKey(masterKey) {
  try {
    keyBuffer(masterKey);
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(value, masterKey) {
  if (typeof value !== "string" || !value) throw new TypeError("Secret value is required");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyBuffer(masterKey), iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptSecret(ciphertext, masterKey) {
  if (typeof ciphertext !== "string") throw new TypeError("Encrypted secret is required");
  const [version, ivValue, tagValue, encryptedValue] = ciphertext.split(":");
  if (version !== VERSION || !ivValue || !tagValue || !encryptedValue) {
    throw new Error("Encrypted secret has an invalid format");
  }
  const iv = Buffer.from(ivValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  const encrypted = Buffer.from(encryptedValue, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) {
    throw new Error("Encrypted secret has an invalid format");
  }
  const decipher = createDecipheriv(ALGORITHM, keyBuffer(masterKey), iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function maskSecret(value) {
  if (typeof value !== "string" || !value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}••••${value.slice(-2)}`;
  return `${value.slice(0, 4)}••••••${value.slice(-4)}`;
}
