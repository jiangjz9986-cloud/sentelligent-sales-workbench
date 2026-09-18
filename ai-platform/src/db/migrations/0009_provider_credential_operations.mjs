// Provider credential operation identities make a committed write safely
// retryable when the response is lost between the platform and Backend.
export const version = "0009";

export function apply(db) {
  db.exec(`
    CREATE TABLE provider_credential_operations (
      operation_id TEXT PRIMARY KEY NOT NULL,
      credential_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('set', 'clear')),
      desired_digest TEXT NOT NULL CHECK (length(desired_digest) = 64),
      expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
      resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
      status TEXT NOT NULL CHECK (status IN ('applied')),
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_provider_credential_operations_credential
      ON provider_credential_operations(credential_id, resulting_revision DESC);
  `);
}
