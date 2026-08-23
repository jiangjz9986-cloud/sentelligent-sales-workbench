import { randomBytes } from "node:crypto";

import { decryptSecret, encryptSecret, maskSecret } from "./secretBox.js";

export const ICOST_SETTING_KEY = "icost_webhook_token";
export const DEEPSEEK_SETTING_KEY = "deepseek_api_key";
export const PUSHPLUS_SETTING_KEY = "hospital_tender_pushplus_token";

const ALLOWED_KEYS = new Set([
  ICOST_SETTING_KEY,
  DEEPSEEK_SETTING_KEY,
  PUSHPLUS_SETTING_KEY,
]);

function assertKey(key) {
  if (!ALLOWED_KEYS.has(key)) throw new TypeError("Unknown secure setting");
}

function metadataFromRow(row, value) {
  const configured = Boolean(row?.ciphertext) && row?.status === "active";
  return {
    configured,
    masked: configured ? maskSecret(value) : null,
    createdAt: row?.created_at ?? null,
    rotatedAt: row?.rotated_at ?? null,
    updatedAt: row?.updated_at ?? null,
    lastSuccessAt: row?.last_success_at ?? null,
    lastFailureAt: row?.last_failure_at ?? null,
    lastErrorCode: row?.last_error_code ?? null,
    lastDeliveryCount: row?.last_delivery_count ?? null,
    lastChunkCount: row?.last_chunk_count ?? null,
    status: row?.status ?? "not_configured",
  };
}

export function createSecureSettingsRepository(db, { masterKey, clock = () => new Date() } = {}) {
  function now() {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("Settings clock must return a valid date");
    return date.toISOString();
  }

  function row(key) {
    assertKey(key);
    return db.prepare("SELECT * FROM secure_settings WHERE setting_key = $key").get({ $key: key }) ?? null;
  }

  function readSecret(key) {
    const current = row(key);
    if (!current?.ciphertext || current.status !== "active") return null;
    return decryptSecret(current.ciphertext, masterKey);
  }

  // A cleared row is an explicit operator decision and must suppress any
  // legacy environment fallback. A missing row means the caller may still
  // use its legacy fallback for a gradual migration.
  function resolveSecret(key, fallback = "") {
    const current = row(key);
    if (!current) return fallback;
    if (!current.ciphertext || current.status !== "active") return "";
    return decryptSecret(current.ciphertext, masterKey);
  }

  function metadata(key) {
    const current = row(key);
    return metadataFromRow(current, current?.ciphertext ? readSecret(key) : null);
  }

  function setSecret(key, value) {
    assertKey(key);
    if (typeof value !== "string" || !value.trim()) throw new TypeError("Secret value is required");
    const timestamp = now();
    const previous = row(key);
    const ciphertext = encryptSecret(value.trim(), masterKey);
    db.prepare(`
      INSERT INTO secure_settings (setting_key, ciphertext, status, created_at, rotated_at, updated_at)
      VALUES ($key, $ciphertext, 'active', $timestamp, $rotatedAt, $timestamp)
      ON CONFLICT(setting_key) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        status = 'active',
        rotated_at = excluded.rotated_at,
        updated_at = excluded.updated_at,
        last_success_at = NULL,
        last_failure_at = NULL,
        last_error_code = NULL,
        last_delivery_count = NULL,
        last_chunk_count = NULL
    `).run({
      $key: key,
      $ciphertext: ciphertext,
      $timestamp: timestamp,
      $rotatedAt: previous?.ciphertext ? timestamp : null,
    });
    return metadata(key);
  }

  function clearSecret(key) {
    assertKey(key);
    const timestamp = now();
    const previous = row(key);
    if (!previous) {
      db.prepare(`
        INSERT INTO secure_settings (setting_key, ciphertext, status, created_at, rotated_at, updated_at)
        VALUES ($key, NULL, 'cleared', $timestamp, NULL, $timestamp)
      `).run({ $key: key, $timestamp: timestamp });
    } else {
      db.prepare(`
        UPDATE secure_settings
        SET ciphertext = NULL,
            status = 'cleared',
            updated_at = $timestamp,
            last_success_at = NULL,
            last_failure_at = NULL,
            last_error_code = NULL,
            last_delivery_count = NULL,
            last_chunk_count = NULL
        WHERE setting_key = $key
      `).run({ $key: key, $timestamp: timestamp });
    }
    return metadata(key);
  }

  function recordDeliverySuccess(key, { at = now(), count = 0, chunkCount = 0 } = {}) {
    assertKey(key);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(chunkCount) || chunkCount < 0) {
      throw new TypeError("Delivery counters must be non-negative safe integers");
    }
    db.prepare(`
      UPDATE secure_settings
      SET last_success_at = $at,
          last_failure_at = NULL,
          last_error_code = NULL,
          last_delivery_count = $count,
          last_chunk_count = $chunkCount,
          updated_at = $at
      WHERE setting_key = $key AND status = 'active'
    `).run({ $key: key, $at: at, $count: count, $chunkCount: chunkCount });
    return metadata(key);
  }

  function recordDeliveryFailure(key, { at = now(), errorCode = "notification_failed" } = {}) {
    assertKey(key);
    const normalizedErrorCode = String(errorCode ?? "notification_failed").trim().slice(0, 120) || "notification_failed";
    db.prepare(`
      UPDATE secure_settings
      SET last_failure_at = $at,
          last_error_code = $errorCode,
          updated_at = $at
      WHERE setting_key = $key
    `).run({ $key: key, $at: at, $errorCode: normalizedErrorCode });
    return metadata(key);
  }

  function rotateIcostToken() {
    const token = `icost_${randomBytes(32).toString("base64url")}`;
    const item = setSecret(ICOST_SETTING_KEY, token);
    return { item, token };
  }

  return {
    readSecret,
    resolveSecret,
    metadata,
    has(key) {
      return row(key) !== null;
    },
    setSecret,
    clearSecret,
    recordDeliverySuccess,
    recordDeliveryFailure,
    rotateIcostToken,
    listMetadata() {
      return {
        icost: metadata(ICOST_SETTING_KEY),
        deepseek: metadata(DEEPSEEK_SETTING_KEY),
        pushplus: metadata(PUSHPLUS_SETTING_KEY),
      };
    },
  };
}
