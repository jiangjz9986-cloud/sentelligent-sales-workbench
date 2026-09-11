import { createHash, randomUUID } from "node:crypto";

import { withImmediateTransaction } from "../db/transaction.js";
import { decryptSecret, encryptSecret, maskSecret } from "./secretBox.js";

export const DEEPSEEK_SETTING_KEY = "deepseek_api_key";
export const ASR_SETTING_KEY = "asr_api_key";

const ALLOWED_KEYS = new Set([
  DEEPSEEK_SETTING_KEY,
  ASR_SETTING_KEY,
]);
const SYNC_STATES = new Set(["local", "pending", "synchronized", "degraded", "unknown"]);
const OPERATION_STATES = new Set(["prepared", "platform_applied", "synchronized", "aborted", "compensated", "unknown"]);
const ROW_COLUMNS = [
  "setting_key", "ciphertext", "status", "created_at", "rotated_at", "updated_at",
  "last_success_at", "last_failure_at", "last_error_code", "last_delivery_count", "last_chunk_count",
];

function assertKey(key) {
  if (!ALLOWED_KEYS.has(key)) throw new TypeError("Unknown secure setting");
}

function metadataFromRow(row, value, sync = null) {
  const configured = Boolean(row?.ciphertext) && row?.status === "active";
  const metadata = {
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
  if (sync) {
    metadata.syncState = sync.state;
    metadata.platformRevision = Number(sync.platform_revision);
    metadata.syncErrorCode = sync.last_error_code ?? null;
  }
  return metadata;
}

function validOperationId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value);
}

function desiredDigest(operation, value) {
  return createHash("sha256")
    .update(`${operation}:`)
    .update(operation === "clear" ? "" : value)
    .digest("hex");
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

  function syncRow(key) {
    assertKey(key);
    return db.prepare("SELECT * FROM secure_setting_sync_state WHERE setting_key = $key").get({ $key: key }) ?? null;
  }

  function operationRow(operationId) {
    if (!validOperationId(operationId)) throw new TypeError("Credential sync operation id is invalid");
    return db.prepare("SELECT * FROM secure_setting_sync_operations WHERE id = $id").get({ $id: operationId }) ?? null;
  }

  function upsertSyncState(key, {
    state, operationId = undefined, platformRevision = 0, lastErrorCode = null,
  }) {
    assertKey(key);
    if (!SYNC_STATES.has(state) || !Number.isSafeInteger(platformRevision) || platformRevision < 0
      || (operationId !== null && !validOperationId(operationId))) {
      throw new TypeError("Credential sync state is invalid");
    }
    const normalizedError = lastErrorCode === null || lastErrorCode === undefined
      ? null
      : String(lastErrorCode).trim().slice(0, 120) || null;
    const existing = syncRow(key);
    const effectiveOperationId = operationId === undefined
      ? existing?.operation_id ?? null
      : operationId;
    db.prepare(`
      INSERT INTO secure_setting_sync_state
        (setting_key, state, operation_id, platform_revision, last_error_code, updated_at)
      VALUES ($key, $state, $operationId, $platformRevision, $lastErrorCode, $updatedAt)
      ON CONFLICT(setting_key) DO UPDATE SET
        state = excluded.state,
        operation_id = excluded.operation_id,
        platform_revision = excluded.platform_revision,
        last_error_code = excluded.last_error_code,
        updated_at = excluded.updated_at
    `).run({
      $key: key,
      $state: state,
      $operationId: effectiveOperationId,
      $platformRevision: platformRevision,
      $lastErrorCode: normalizedError,
      $updatedAt: now(),
    });
  }

  function restoreSnapshot(key, snapshot) {
    assertKey(key);
    if (snapshot && snapshot.setting_key !== key) throw new Error("Credential sync snapshot key mismatch");
    db.prepare("DELETE FROM secure_settings WHERE setting_key = $key").run({ $key: key });
    if (!snapshot) return;
    const values = Object.fromEntries(ROW_COLUMNS.map((column) => [`$${column}`, snapshot[column] ?? null]));
    db.prepare(`
      INSERT INTO secure_settings (${ROW_COLUMNS.join(", ")})
      VALUES (${ROW_COLUMNS.map((column) => `$${column}`).join(", ")})
    `).run(values);
  }

  function operationMetadata(operation) {
    return {
      operationId: operation.id,
      setting: operation.setting_key,
      operation: operation.operation,
      state: operation.state,
      platformRevisionBefore: Number(operation.platform_revision_before),
      platformRevisionAfter: operation.platform_revision_after === null
        ? null
        : Number(operation.platform_revision_after),
      lastErrorCode: operation.last_error_code ?? null,
    };
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
    const sync = syncRow(key);
    if (sync && !["local", "synchronized"].includes(sync.state)) return "";
    if (!current.ciphertext || current.status !== "active") return "";
    return decryptSecret(current.ciphertext, masterKey);
  }

  function metadata(key) {
    const current = row(key);
    return metadataFromRow(current, current?.ciphertext ? readSecret(key) : null, syncRow(key));
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

  function prepareSync(key, { operationId = randomUUID(), operation, value = null } = {}) {
    assertKey(key);
    if (!(operation === "set" || operation === "clear")) throw new TypeError("Credential sync operation is invalid");
    if (!validOperationId(operationId)) throw new TypeError("Credential sync operation id is invalid");
    if (operation === "set" && (typeof value !== "string" || !value.trim() || value.length > 500)) {
      throw new TypeError("Secret value is required");
    }
    const normalizedValue = operation === "clear" ? null : value.trim();
    const digest = desiredDigest(operation, normalizedValue);
    const desiredCiphertext = operation === "clear" ? null : encryptSecret(value.trim(), masterKey);
    const desiredStatus = operation === "clear" ? "cleared" : "active";
    return withImmediateTransaction(db, () => {
      const existingOperation = operationRow(operationId);
      if (existingOperation) {
        if (existingOperation.setting_key !== key || existingOperation.operation !== operation
          || existingOperation.desired_digest !== digest
          || existingOperation.desired_status !== desiredStatus) {
          throw new Error("Credential sync operation already exists");
        }
        if (!OPERATION_STATES.has(existingOperation.state)) throw new Error("Credential sync operation is invalid");
        return { operation: operationMetadata(existingOperation), metadata: metadata(key) };
      }
      const currentSync = syncRow(key);
      if (currentSync?.state === "pending") throw new Error("Credential sync is already pending");
      const current = row(key);
      const timestamp = now();
      const platformRevisionBefore = Number(currentSync?.platform_revision ?? 0);
      db.prepare(`
        INSERT INTO secure_setting_sync_operations
          (id, setting_key, operation, state, previous_json, desired_status,
           desired_ciphertext, desired_digest, platform_revision_before, platform_revision_after,
           last_error_code, created_at, updated_at)
        VALUES ($id, $key, $operation, 'prepared', $previousJson, $desiredStatus,
                $desiredCiphertext, $desiredDigest, $platformRevisionBefore, NULL, NULL, $at, $at)
      `).run({
        $id: operationId,
        $key: key,
        $operation: operation,
        $previousJson: JSON.stringify(current ?? null),
        $desiredStatus: desiredStatus,
        $desiredCiphertext: desiredCiphertext,
        $desiredDigest: digest,
        $platformRevisionBefore: platformRevisionBefore,
        $at: timestamp,
      });
      if (current) {
        db.prepare(`
          UPDATE secure_settings
             SET ciphertext = $ciphertext,
                 status = $status,
                 rotated_at = CASE WHEN $status = 'active' AND ciphertext IS NOT NULL THEN $at ELSE rotated_at END,
                 updated_at = $at,
                 last_success_at = NULL,
                 last_failure_at = NULL,
                 last_error_code = NULL,
                 last_delivery_count = NULL,
                 last_chunk_count = NULL
           WHERE setting_key = $key
        `).run({ $key: key, $ciphertext: desiredCiphertext, $status: desiredStatus, $at: timestamp });
      } else {
        db.prepare(`
          INSERT INTO secure_settings (setting_key, ciphertext, status, created_at, rotated_at, updated_at)
          VALUES ($key, $ciphertext, $status, $at, NULL, $at)
        `).run({ $key: key, $ciphertext: desiredCiphertext, $status: desiredStatus, $at: timestamp });
      }
      upsertSyncState(key, { state: "pending", operationId, platformRevision: platformRevisionBefore });
      return { operation: operationMetadata(operationRow(operationId)), metadata: metadata(key) };
    });
  }

  function markPlatformApplied(operationId, platformRevision) {
    if (!Number.isSafeInteger(platformRevision) || platformRevision < 1) throw new TypeError("Platform revision is invalid");
    const operation = operationRow(operationId);
    if (!operation) throw new Error("Credential sync operation not found");
    if (["synchronized", "compensated"].includes(operation.state)) return operationMetadata(operation);
    if (operation.state === "platform_applied") {
      if (Number(operation.platform_revision_after) !== platformRevision) {
        throw new Error("Credential sync platform revision conflict");
      }
      return operationMetadata(operation);
    }
    if (operation.state !== "prepared" || platformRevision <= Number(operation.platform_revision_before)) {
      throw new Error("Credential sync operation is not active");
    }
    return withImmediateTransaction(db, () => {
      db.prepare(`
        UPDATE secure_setting_sync_operations
           SET state = 'platform_applied', platform_revision_after = $revision, updated_at = $at
         WHERE id = $id
      `).run({ $id: operationId, $revision: platformRevision, $at: now() });
      upsertSyncState(operation.setting_key, { state: "pending", operationId, platformRevision });
      return operationMetadata(operationRow(operationId));
    });
  }

  function finalizeSync(operationId, platformRevision, onFinalized = null) {
    if (!Number.isSafeInteger(platformRevision) || platformRevision < 1) throw new TypeError("Platform revision is invalid");
    if (onFinalized !== null && typeof onFinalized !== "function") {
      throw new TypeError("Credential sync finalize callback is invalid");
    }
    const operation = operationRow(operationId);
    if (!operation) throw new Error("Credential sync operation not found");
    if (operation.state === "synchronized") return metadata(operation.setting_key);
    if (operation.state !== "platform_applied" || Number(operation.platform_revision_after) !== platformRevision) {
      throw new Error("Credential sync operation is not finalizable");
    }
    return withImmediateTransaction(db, () => {
      db.prepare(`
        UPDATE secure_setting_sync_operations
           SET state = 'synchronized', platform_revision_after = $revision, last_error_code = NULL, updated_at = $at
         WHERE id = $id
      `).run({ $id: operationId, $revision: platformRevision, $at: now() });
      upsertSyncState(operation.setting_key, {
        state: "synchronized", operationId, platformRevision, lastErrorCode: null,
      });
      const finalized = metadata(operation.setting_key);
      onFinalized?.(finalized);
      return finalized;
    });
  }

  function abortSync(operationId, { errorCode = "credential_sync_failed" } = {}) {
    const operation = operationRow(operationId);
    if (!operation) throw new Error("Credential sync operation not found");
    if (operation.state === "aborted") return metadata(operation.setting_key);
    if (operation.state !== "prepared") throw new Error("Credential sync operation is not abortable");
    const snapshot = JSON.parse(operation.previous_json);
    const revision = Number(operation.platform_revision_before);
    return withImmediateTransaction(db, () => {
      restoreSnapshot(operation.setting_key, snapshot);
      db.prepare(`
        UPDATE secure_setting_sync_operations
           SET state = 'aborted', platform_revision_after = $revision,
               last_error_code = $errorCode, updated_at = $at
         WHERE id = $id
      `).run({
        $id: operationId,
        $revision: revision,
        $errorCode: String(errorCode).slice(0, 120),
        $at: now(),
      });
      upsertSyncState(operation.setting_key, {
        state: "degraded", operationId,
        platformRevision: revision,
        lastErrorCode: errorCode,
      });
      return metadata(operation.setting_key);
    });
  }

  function compensateSync(operationId, { platformRevision, errorCode = "credential_sync_compensated" } = {}) {
    if (!Number.isSafeInteger(platformRevision) || platformRevision < 0) throw new TypeError("Platform revision is invalid");
    const operation = operationRow(operationId);
    if (!operation) throw new Error("Credential sync operation not found");
    if (operation.state === "compensated") return metadata(operation.setting_key);
    if (!["platform_applied", "unknown"].includes(operation.state)) {
      throw new Error("Credential sync operation is not compensatable");
    }
    return withImmediateTransaction(db, () => {
      restoreSnapshot(operation.setting_key, JSON.parse(operation.previous_json));
      db.prepare(`
        UPDATE secure_setting_sync_operations
           SET state = 'compensated', platform_revision_after = $revision,
               last_error_code = $errorCode, updated_at = $at
         WHERE id = $id
      `).run({
        $id: operationId,
        $revision: platformRevision,
        $errorCode: String(errorCode).slice(0, 120),
        $at: now(),
      });
      upsertSyncState(operation.setting_key, {
        state: "synchronized", operationId, platformRevision, lastErrorCode: null,
      });
      return metadata(operation.setting_key);
    });
  }

  function markUnknown(operationId, { errorCode = "credential_sync_unknown", platformRevision = null } = {}) {
    const operation = operationRow(operationId);
    if (!operation) throw new Error("Credential sync operation not found");
    if (operation.state === "unknown") return metadata(operation.setting_key);
    if (!["prepared", "platform_applied"].includes(operation.state)) {
      throw new Error("Credential sync operation cannot become unknown");
    }
    const revision = platformRevision === null
      ? Number(operation.platform_revision_after ?? operation.platform_revision_before)
      : platformRevision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError("Platform revision is invalid");
    return withImmediateTransaction(db, () => {
      db.prepare(`
        UPDATE secure_setting_sync_operations
           SET state = 'unknown', platform_revision_after = $revision,
               last_error_code = $errorCode, updated_at = $at
         WHERE id = $id
      `).run({
        $id: operationId,
        $revision: revision,
        $errorCode: String(errorCode).slice(0, 120),
        $at: now(),
      });
      upsertSyncState(operation.setting_key, {
        state: "unknown", operationId, platformRevision: revision, lastErrorCode: errorCode,
      });
      return metadata(operation.setting_key);
    });
  }

  // This is an internal-only compensation view. It returns a plaintext value
  // to the caller so it can issue one bounded rollback request, but it is not
  // included in metadata, HTTP responses, logs or audit payloads.
  function previousCredential(operationId) {
    const operation = operationRow(operationId);
    if (!operation) throw new Error("Credential sync operation not found");
    if (!["prepared", "platform_applied", "unknown"].includes(operation.state)) {
      throw new Error("Credential sync operation is not active");
    }
    const previous = JSON.parse(operation.previous_json);
    return Object.freeze({
      setting: operation.setting_key,
      operationId,
      hadRow: Boolean(previous),
      shouldClear: !previous || previous.status !== "active" || !previous.ciphertext,
      value: previous?.status === "active" && previous.ciphertext
        ? decryptSecret(previous.ciphertext, masterKey)
        : null,
      platformRevisionBefore: Number(operation.platform_revision_before),
    });
  }

  function setSynchronizedSecret(key, value, platformRevision) {
    if (!Number.isSafeInteger(platformRevision) || platformRevision < 0) throw new TypeError("Platform revision is invalid");
    return withImmediateTransaction(db, () => {
      setSecret(key, value);
      upsertSyncState(key, { state: "synchronized", platformRevision, lastErrorCode: null });
      return metadata(key);
    });
  }

  function clearSynchronizedSecret(key, platformRevision) {
    if (!Number.isSafeInteger(platformRevision) || platformRevision < 0) throw new TypeError("Platform revision is invalid");
    return withImmediateTransaction(db, () => {
      clearSecret(key);
      upsertSyncState(key, { state: "synchronized", platformRevision, lastErrorCode: null });
      return metadata(key);
    });
  }

  function syncStatus(key) {
    assertKey(key);
    const current = syncRow(key);
    return {
      state: current?.state ?? "local",
      operationId: current?.operation_id ?? null,
      platformRevision: Number(current?.platform_revision ?? 0),
      lastErrorCode: current?.last_error_code ?? null,
    };
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

  return {
    readSecret,
    resolveSecret,
    metadata,
    has(key) {
      return row(key) !== null;
    },
    setSecret,
    clearSecret,
    prepareSync,
    markPlatformApplied,
    finalizeSync,
    abortSync,
    compensateSync,
    markUnknown,
    previousCredential,
    setSynchronizedSecret,
    clearSynchronizedSecret,
    syncStatus,
    recordDeliverySuccess,
    recordDeliveryFailure,
    listMetadata() {
      return {
        deepseek: metadata(DEEPSEEK_SETTING_KEY),
        asr: metadata(ASR_SETTING_KEY),
      };
    },
  };
}
