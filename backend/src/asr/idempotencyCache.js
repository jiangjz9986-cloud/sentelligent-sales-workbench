import { createHash, createHmac, randomUUID } from "node:crypto";

import { ASR_LIMITS, AsrContractError } from "./contracts.js";

function contractError(code, status, message) {
  throw new AsrContractError(code, status, message);
}

function boundedString(value, name, maxLength = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function cloneCompletedValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("completed ASR idempotency value must be an object");
  }
  return Object.freeze(structuredClone(value));
}

export function createAsrFingerprint({ purpose, mediaType, audioSha256, durationMs }) {
  const normalizedPurpose = boundedString(purpose, "purpose", 64);
  const normalizedMediaType = boundedString(mediaType, "mediaType", 64);
  if (typeof audioSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(audioSha256)) {
    throw new TypeError("audioSha256 must be a lowercase SHA-256 digest");
  }
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new TypeError("durationMs must be a positive safe integer");
  }
  return createHash("sha256")
    .update(`${normalizedPurpose}${normalizedMediaType}${audioSha256}${durationMs}`, "utf8")
    .digest("hex");
}

export function createAsrIdempotencyCache({
  secret,
  ttlMs = ASR_LIMITS.idempotencyTtlMs,
  capacity = ASR_LIMITS.idempotencyCompletedCapacity,
  now = Date.now,
  randomId = randomUUID,
  createHmacImpl = createHmac,
} = {}) {
  const normalizedSecret = typeof secret === "string" || Buffer.isBuffer(secret) ? secret : null;
  if (!normalizedSecret || normalizedSecret.length === 0) {
    throw new TypeError("secret must be a non-empty string or Buffer");
  }
  positiveSafeInteger(ttlMs, "ttlMs");
  positiveSafeInteger(capacity, "capacity");
  if (typeof now !== "function" || typeof randomId !== "function" || typeof createHmacImpl !== "function") {
    throw new TypeError("idempotency dependencies must be functions");
  }

  const entries = new Map();
  const reservations = new WeakMap();

  function currentTime() {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError("now() must return a finite number");
    return value;
  }

  function scopedDigest(owner, key) {
    const normalizedOwner = boundedString(owner, "owner", 512);
    const normalizedKey = boundedString(key, "key", 128);
    return createHmacImpl("sha256", normalizedSecret)
      .update(normalizedOwner, "utf8")
      .update("\0", "utf8")
      .update(normalizedKey, "utf8")
      .digest("hex");
  }

  function purgeExpired(at = currentTime()) {
    for (const [digest, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(digest);
    }
  }

  function completedCount() {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.state === "completed") count += 1;
    }
    return count;
  }

  function enforceCompletedCapacity() {
    purgeExpired();
    let excess = completedCount() - capacity;
    if (excess <= 0) return;
    for (const [digest, entry] of entries) {
      if (entry.state !== "completed") continue;
      entries.delete(digest);
      excess -= 1;
      if (excess === 0) return;
    }
  }

  function existingFor(owner, key) {
    purgeExpired();
    const digest = scopedDigest(owner, key);
    return { digest, entry: entries.get(digest) ?? null };
  }

  return Object.freeze({
    peek(owner, key) {
      const { entry } = existingFor(owner, key);
      return entry ? entry.state : "missing";
    },

    claim({ owner, key, fingerprint }) {
      if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
        throw new TypeError("fingerprint must be a lowercase SHA-256 digest");
      }
      const at = currentTime();
      purgeExpired(at);
      const digest = scopedDigest(owner, key);
      const existing = entries.get(digest);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          contractError(
            "IDEMPOTENCY_CONFLICT",
            409,
            "Idempotency key conflicts with an earlier ASR request",
          );
        }
        if (existing.state === "pending") {
          contractError("ASR_IN_PROGRESS", 409, "ASR request is already in progress");
        }
        entries.delete(digest);
        entries.set(digest, existing);
        return Object.freeze({
          kind: "replay",
          digest: digest.slice(0, 12),
          value: structuredClone(existing.value),
        });
      }

      const token = boundedString(String(randomId()), "reservation token", 256);
      entries.set(digest, {
        state: "pending",
        fingerprint,
        token,
        expiresAt: at + ttlMs,
      });
      const claim = Object.freeze({ kind: "claimed", token, digest: digest.slice(0, 12) });
      reservations.set(claim, { digest, token });
      return claim;
    },

    complete(claim, value) {
      if (!claim || claim.kind !== "claimed" || typeof claim.token !== "string") {
        throw new TypeError("a claimed idempotency reservation is required");
      }
      purgeExpired();
      const binding = reservations.get(claim);
      const matchedDigest = binding?.digest;
      const matchedEntry = matchedDigest ? entries.get(matchedDigest) : null;
      if (
        !binding
        || !matchedEntry
        || matchedEntry.state !== "pending"
        || matchedEntry.token !== binding.token
      ) return false;
      entries.delete(matchedDigest);
      entries.set(matchedDigest, {
        state: "completed",
        fingerprint: matchedEntry.fingerprint,
        value: cloneCompletedValue(value),
        expiresAt: currentTime() + ttlMs,
      });
      reservations.delete(claim);
      enforceCompletedCapacity();
      return true;
    },

    release(claim) {
      if (!claim || claim.kind !== "claimed" || typeof claim.token !== "string") return false;
      const binding = reservations.get(claim);
      const entry = binding ? entries.get(binding.digest) : null;
      if (!binding || !entry || entry.state !== "pending" || entry.token !== binding.token) return false;
      entries.delete(binding.digest);
      reservations.delete(claim);
      return true;
    },

    sweep() {
      const before = entries.size;
      purgeExpired();
      return before - entries.size;
    },

    snapshot() {
      purgeExpired();
      let pending = 0;
      let completed = 0;
      for (const entry of entries.values()) {
        if (entry.state === "pending") pending += 1;
        else completed += 1;
      }
      return Object.freeze({ pending, completed, capacity, ttlMs });
    },
  });
}
