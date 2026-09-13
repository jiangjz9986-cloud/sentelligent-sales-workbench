export const version = "0011";

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === columnName);
}

export function apply(db) {
  if (!hasColumn(db, "tasks", "admission_mode")) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN admission_mode TEXT NOT NULL DEFAULT 'standard'
        CHECK (admission_mode IN ('standard', 'provider-canary'))
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_admission_mode
      ON tasks(admission_mode, status, requested_at);

    CREATE TABLE IF NOT EXISTS provider_readiness_evidence (
      id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL REFERENCES providers(id),
      model_id TEXT NOT NULL REFERENCES models(id),
      model_name TEXT NOT NULL,
      task_type TEXT NOT NULL,
      credential_revision INTEGER NOT NULL CHECK (credential_revision >= 0),
      credential_digest TEXT NOT NULL CHECK (length(credential_digest) = 64),
      provider_policy_digest TEXT NOT NULL CHECK (length(provider_policy_digest) = 64),
      run_id TEXT NOT NULL,
      sample_index INTEGER NOT NULL CHECK (sample_index BETWEEN 1 AND 10),
      task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL UNIQUE REFERENCES task_attempts(id) ON DELETE CASCADE,
      platform_request_id TEXT NOT NULL,
      provider_request_id TEXT NOT NULL,
      price_version_id TEXT NOT NULL REFERENCES price_versions(id),
      usage_json TEXT NOT NULL,
      cost_micro INTEGER NOT NULL CHECK (cost_micro >= 0),
      function_fee_micro INTEGER NOT NULL CHECK (function_fee_micro >= 0),
      total_micro INTEGER NOT NULL CHECK (total_micro >= 0),
      currency TEXT NOT NULL CHECK (currency IN ('CNY', 'USD')),
      result_schema_version TEXT NOT NULL,
      result_digest TEXT NOT NULL CHECK (length(result_digest) = 64),
      settled_status TEXT NOT NULL CHECK (settled_status = 'settled'),
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (provider_id, run_id, sample_index),
      UNIQUE (provider_id, provider_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_readiness_lookup
      ON provider_readiness_evidence(provider_id, model_id, task_type, expires_at DESC);
  `);
}

