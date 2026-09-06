// Durable proactive model cache and quota ledger.
//
// Cache rows are scoped by owner, evidence/payload hashes, model identity and
// rule version.  Usage rows keep both owner and global daily counters so a
// process restart cannot reset the model-call budget.
export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_model_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      evidence_hash TEXT NOT NULL CHECK (
        length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'
      ),
      payload_hash TEXT NOT NULL CHECK (
        length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
      ),
      model_provider TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL DEFAULT '',
      rule_version TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      generated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, evidence_hash, payload_hash, model_provider, model_name, rule_version)
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_model_cache_expiry
      ON proactive_model_cache(expires_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_proactive_model_cache_owner
      ON proactive_model_cache(owner, updated_at DESC);

    CREATE TABLE IF NOT EXISTS proactive_model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usage_date TEXT NOT NULL CHECK (
        length(usage_date) = 10 AND usage_date NOT GLOB '*[^0-9-]*'
      ),
      scope TEXT NOT NULL CHECK (scope IN ('owner', 'global')),
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0),
      updated_at TEXT NOT NULL,
      UNIQUE (usage_date, scope, owner)
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_model_usage_date
      ON proactive_model_usage(usage_date, scope, owner);
  `);
}
