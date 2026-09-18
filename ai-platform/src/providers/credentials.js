import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { AiPlatformError } from "../errors.js";
import { withImmediateTransaction } from "../utils.js";

export function createProviderCredentials({ db, encryptionKey, policies, env = process.env }) {
  const key = Buffer.from(String(encryptionKey ?? ""), "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encryptionKey) throw new Error("invalid provider encryption key");
  const registered = new Set(policies.map((policy) => policy.credentialEnv));
  const operationPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
  const actorPattern = /^[^\u0000-\u001f\u007f]{1,400}$/u;
  function assertId(id) {
    if (!registered.has(id)) throw new AiPlatformError("credential is not registered", { code: "not_found", status: 404 });
  }
  function assertOperationId(operationId) {
    if (typeof operationId !== "string" || !operationPattern.test(operationId)) {
      throw new AiPlatformError("invalid credential operation", { code: "invalid_request", status: 422 });
    }
  }
  function aad(id) { return Buffer.from("sentelligent.ai.credential.v1:" + id); }
  function desiredDigest(operation, value) {
    return createHash("sha256").update(`${operation}:`).update(operation === "clear" ? "" : value).digest("hex");
  }
  function operationRow(operationId) {
    assertOperationId(operationId);
    return db.prepare("SELECT * FROM provider_credential_operations WHERE operation_id=?").get(operationId) ?? null;
  }
  function operationMetadata(row) {
    if (!row) return null;
    return {
      operationId: row.operation_id,
      credentialId: row.credential_id,
      operation: row.operation,
      desiredDigest: row.desired_digest,
      expectedRevision: row.expected_revision,
      resultingRevision: row.resulting_revision,
      status: row.status,
      actor: row.actor,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  function resolve(id) {
    assertId(id);
    const row = db.prepare("SELECT ciphertext,status FROM provider_credentials WHERE credential_id=?").get(id);
    if (!row) return String(env[id] ?? "");
    if (row.status === "cleared") return "";
    try {
      const parts = row.ciphertext.split(":").map((part) => Buffer.from(part, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", key, parts[0]);
      decipher.setAAD(aad(id)); decipher.setAuthTag(parts[1]);
      return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
    } catch {
      throw new AiPlatformError("credential storage unavailable", { code: "credential_storage_unavailable", status: 503 });
    }
  }
  function metadata(id) {
    const value = resolve(id);
    const row = db.prepare("SELECT status,revision,updated_at FROM provider_credentials WHERE credential_id=?").get(id);
    return {
      configured: Boolean(value), status: row?.status ?? (value ? "active" : "not_configured"),
      revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null,
      source: "ai-platform",
      masked: value ? value.length > 8 ? value.slice(0, 4) + "******" + value.slice(-4) : "******" : null,
    };
  }
  function update({ id, value = null, clear = false, expectedRevision, actor, operationId = randomUUID() }) {
    assertId(id);
    assertOperationId(operationId);
    const operation = clear ? "clear" : "set";
    const normalizedValue = clear ? null : value;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || typeof actor !== "string" || !actorPattern.test(actor)
      || (!clear && (typeof value !== "string" || !value || value.length > 500 || /[\s\u0000-\u001f\u007f]/u.test(value)))) {
      throw new AiPlatformError("invalid credential update", { code: "invalid_request", status: 422 });
    }
    const digest = desiredDigest(operation, normalizedValue);
    return withImmediateTransaction(db, () => {
      const existingOperation = operationRow(operationId);
      if (existingOperation) {
        if (existingOperation.credential_id !== id
          || existingOperation.operation !== operation
          || existingOperation.desired_digest !== digest
          || existingOperation.expected_revision !== expectedRevision) {
          throw new AiPlatformError("credential operation already exists", { code: "credential_operation_conflict", status: 409 });
        }
        return { ...metadata(id), operationId, operationStatus: existingOperation.status };
      }
      const row = db.prepare("SELECT revision FROM provider_credentials WHERE credential_id=?").get(id);
      if ((row?.revision ?? 0) !== expectedRevision) throw new AiPlatformError("credential changed", { code: "credential_conflict", status: 409 });
      let ciphertext = null;
      if (!clear) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(aad(id));
        const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        ciphertext = [iv, cipher.getAuthTag(), bytes].map((part) => part.toString("base64url")).join(":");
      }
      const revision = expectedRevision + 1;
      const status = clear ? "cleared" : "active";
      const at = new Date().toISOString();
      db.prepare(`INSERT INTO provider_credentials VALUES (?,?,?,?,?)
        ON CONFLICT(credential_id) DO UPDATE SET ciphertext=excluded.ciphertext,status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(id, ciphertext, status, revision, at);
      db.prepare(`
        INSERT INTO provider_credential_operations
          (operation_id, credential_id, operation, desired_digest, expected_revision,
           resulting_revision, status, actor, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?)
      `).run(operationId, id, operation, digest, expectedRevision, revision, actor, at, at);
      db.prepare("INSERT INTO provider_credential_audit VALUES (?,?,?,?,?)").run(id, revision, status, actor, at);
      return { ...metadata(id), operationId, operationStatus: "applied" };
    });
  }
  function readOperation(operationId) {
    const row = operationRow(operationId);
    return row ? { ...operationMetadata(row), item: metadata(row.credential_id) } : null;
  }
  return { resolve, metadata, update, readOperation };
}
