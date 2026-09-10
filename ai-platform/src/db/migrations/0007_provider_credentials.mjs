export const version = "0007";
export function apply(db) {
  db.exec(`
    CREATE TABLE provider_credentials (
      credential_id TEXT PRIMARY KEY,
      ciphertext TEXT,
      status TEXT NOT NULL CHECK (status IN ('active','cleared')),
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE provider_credential_audit (
      credential_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      actor TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (credential_id,revision)
    );
  `);
}
