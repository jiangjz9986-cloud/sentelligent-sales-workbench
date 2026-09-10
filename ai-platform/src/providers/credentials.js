import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AiPlatformError } from "../errors.js";
import { withImmediateTransaction } from "../utils.js";

export function createProviderCredentials({ db, encryptionKey, policies, env = process.env }) {
  const key = Buffer.from(String(encryptionKey ?? ""), "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encryptionKey) throw new Error("invalid provider encryption key");
  const registered = new Set(policies.map((policy) => policy.credentialEnv));
  function assertId(id) {
    if (!registered.has(id)) throw new AiPlatformError("credential is not registered", { code: "not_found", status: 404 });
  }
  function aad(id) { return Buffer.from("sentelligent.ai.credential.v1:" + id); }
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
  function update({ id, value = null, clear = false, expectedRevision, actor }) {
    assertId(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || typeof actor !== "string" || !actor || actor.length > 400 || /[\u0000-\u001f\u007f]/u.test(actor)
      || (!clear && (typeof value !== "string" || !value || value.length > 500 || /[\s\u0000-\u001f\u007f]/u.test(value)))) {
      throw new AiPlatformError("invalid credential update", { code: "invalid_request", status: 422 });
    }
    return withImmediateTransaction(db, () => {
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
      db.prepare("INSERT INTO provider_credential_audit VALUES (?,?,?,?,?)").run(id, revision, status, actor, at);
      return metadata(id);
    });
  }
  return { resolve, metadata, update };
}
