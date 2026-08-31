// v0.11 拜访确认 -> 客户温度建议：保存只读建议快照，并把最终状态限制为
// pending / confirmed / cancelled。客户温度本身仍由显式确认后的乐观锁更新完成。
//
// IF NOT EXISTS 让迁移主体可独立重复执行；正式迁移账本仍由 migrateDatabase
// 以版本号和源码校验和保证只登记一次。
export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visit_temperature_suggestions (
      id TEXT PRIMARY KEY NOT NULL
        CHECK (length(id) BETWEEN 1 AND 200),
      schema_version TEXT NOT NULL
        CHECK (schema_version = 'visit-temperature-suggestion-v1'),
      owner TEXT NOT NULL
        CHECK (length(owner) BETWEEN 1 AND 200),
      visit_id TEXT NOT NULL
        REFERENCES quick_records(id) ON DELETE CASCADE
        CHECK (length(visit_id) BETWEEN 1 AND 200),
      visit_version INTEGER NOT NULL
        CHECK (visit_version >= 1),
      customer_id TEXT NOT NULL
        REFERENCES customers(id) ON DELETE CASCADE
        CHECK (length(customer_id) BETWEEN 1 AND 200),
      customer_version INTEGER NOT NULL
        CHECK (customer_version >= 1),
      previous_value INTEGER NOT NULL
        CHECK (previous_value BETWEEN 0 AND 100),
      suggested_value INTEGER NOT NULL
        CHECK (suggested_value BETWEEN 0 AND 100),
      delta INTEGER NOT NULL
        CHECK (delta = suggested_value - previous_value),
      confidence INTEGER NOT NULL
        CHECK (confidence BETWEEN 0 AND 100),
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'confirmed', 'cancelled')),
      identity TEXT NOT NULL
        CHECK (
          length(identity) = 64
          AND identity NOT GLOB '*[^0-9a-f]*'
        ),
      visit_evidence_hash TEXT NOT NULL
        CHECK (
          length(visit_evidence_hash) = 64
          AND visit_evidence_hash NOT GLOB '*[^0-9a-f]*'
        ),
      input_snapshot_hash TEXT NOT NULL
        CHECK (
          length(input_snapshot_hash) = 64
          AND input_snapshot_hash NOT GLOB '*[^0-9a-f]*'
        ),
      facts_json TEXT NOT NULL
        CHECK (json_valid(facts_json) AND json_type(facts_json) = 'array'),
      inferences_json TEXT NOT NULL
        CHECK (json_valid(inferences_json) AND json_type(inferences_json) = 'array'),
      source_refs_json TEXT NOT NULL
        CHECK (json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'),
      requires_human_confirmation INTEGER NOT NULL DEFAULT 1
        CHECK (requires_human_confirmation = 1),
      writeback_allowed INTEGER NOT NULL DEFAULT 0
        CHECK (writeback_allowed = 0),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT,
      cancelled_at TEXT,
      confirmed_customer_version INTEGER
        CHECK (confirmed_customer_version IS NULL OR confirmed_customer_version >= 1),
      confirmed_relation INTEGER
        CHECK (confirmed_relation IS NULL OR confirmed_relation BETWEEN 0 AND 100),
      UNIQUE (owner, visit_id),
      CHECK (
        (status = 'pending'
          AND confirmed_at IS NULL
          AND cancelled_at IS NULL
          AND confirmed_customer_version IS NULL
          AND confirmed_relation IS NULL)
        OR
        (status = 'confirmed'
          AND confirmed_at IS NOT NULL
          AND cancelled_at IS NULL
          AND confirmed_customer_version IS NOT NULL
          AND confirmed_relation IS NOT NULL)
        OR
        (status = 'cancelled'
          AND confirmed_at IS NULL
          AND cancelled_at IS NOT NULL
          AND confirmed_customer_version IS NULL
          AND confirmed_relation IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_visit_temperature_suggestions_visit
      ON visit_temperature_suggestions(owner, visit_id);
    CREATE INDEX IF NOT EXISTS idx_visit_temperature_suggestions_status
      ON visit_temperature_suggestions(owner, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_visit_temperature_suggestions_customer
      ON visit_temperature_suggestions(owner, customer_id, created_at DESC);
  `);
}
