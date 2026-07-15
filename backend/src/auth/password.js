import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 32 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function scryptOptions() {
  return {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  };
}

function passwordValue(password) {
  if (typeof password !== "string") throw new TypeError("Password must be a string");
  if (!password) throw new Error("Password is required");
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error("Password is too long");
  }
  return password;
}

function decodeCanonicalBase64Url(value, expectedLength) {
  if (!BASE64URL.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedLength || decoded.toString("base64url") !== value) return null;
  return decoded;
}

function parsePasswordHash(encoded) {
  if (typeof encoded !== "string" || encoded.length > 256) return null;
  const parts = encoded.split("$");
  if (parts.length !== 6) return null;
  const [name, n, r, p, saltValue, hashValue] = parts;
  if (
    name !== "scrypt" ||
    n !== String(SCRYPT_N) ||
    r !== String(SCRYPT_R) ||
    p !== String(SCRYPT_P)
  ) {
    return null;
  }
  const salt = decodeCanonicalBase64Url(saltValue, 16);
  const expected = decodeCanonicalBase64Url(hashValue, SCRYPT_KEY_LENGTH);
  return salt && expected ? { salt, expected } : null;
}

export function validatePasswordHashEncoding(encoded) {
  return parsePasswordHash(encoded) !== null;
}

export async function hashPassword(password, { salt = randomBytes(16) } = {}) {
  const normalizedPassword = passwordValue(password);
  const saltBuffer = Buffer.from(salt);
  if (saltBuffer.length !== 16) throw new Error("Password salt must be 16 bytes");

  const derived = await scrypt(
    normalizedPassword,
    saltBuffer,
    SCRYPT_KEY_LENGTH,
    scryptOptions(),
  );
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    saltBuffer.toString("base64url"),
    Buffer.from(derived).toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password, encoded) {
  let normalizedPassword;
  try {
    normalizedPassword = passwordValue(password);
  } catch {
    return false;
  }
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;

  try {
    const actual = Buffer.from(
      await scrypt(
        normalizedPassword,
        parsed.salt,
        parsed.expected.length,
        scryptOptions(),
      ),
    );
    return timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
}
