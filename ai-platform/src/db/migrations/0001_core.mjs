export const version = "0001";

export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('mock', 'openai_compatible', 'asr', 'vision')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id),
      name TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider_id, name)
    );

    CREATE TABLE IF NOT EXISTS price_versions (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES models(id),
      version TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      input_micro_per_1k INTEGER NOT NULL DEFAULT 0 CHECK (input_micro_per_1k >= 0),
      output_micro_per_1k INTEGER NOT NULL DEFAULT 0 CHECK (output_micro_per_1k >= 0),
      cached_input_micro_per_1k INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_micro_per_1k >= 0),
      audio_micro_per_minute INTEGER NOT NULL DEFAULT 0 CHECK (audio_micro_per_minute >= 0),
      image_micro_per_page INTEGER NOT NULL DEFAULT 0 CHECK (image_micro_per_page >= 0),
      function_fee_micro INTEGER NOT NULL DEFAULT 0 CHECK (function_fee_micro >= 0),
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (model_id, version)
    );

    CREATE TABLE IF NOT EXISTS standards (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'draft', 'disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS standard_versions (
      id TEXT PRIMARY KEY,
      standard_id TEXT NOT NULL REFERENCES standards(id),
      version TEXT NOT NULL,
      content TEXT NOT NULL,
      rules_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (standard_id, version)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'draft', 'disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_versions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      version TEXT NOT NULL,
      task_types_json TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      instructions_json TEXT NOT NULL DEFAULT '{}',
      tools_json TEXT NOT NULL DEFAULT '[]',
      model_policy_json TEXT NOT NULL DEFAULT '{}',
      input_schema_json TEXT NOT NULL DEFAULT '{}',
      output_schema_json TEXT NOT NULL DEFAULT '{}',
      standard_ids_json TEXT NOT NULL DEFAULT '[]',
      limits_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (agent_id, version)
    );

    CREATE TABLE IF NOT EXISTS agent_releases (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      agent_version_id TEXT NOT NULL REFERENCES agent_versions(id),
      status TEXT NOT NULL CHECK (status IN ('active', 'rolled_back', 'retired')),
      test_run_id TEXT,
      published_by TEXT NOT NULL,
      published_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_one_active_release
      ON agent_releases(agent_id) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      issuer TEXT NOT NULL,
      owner TEXT NOT NULL,
      actor TEXT NOT NULL,
      channel TEXT NOT NULL,
      feature TEXT NOT NULL,
      task_type TEXT NOT NULL,
      subject_type TEXT,
      subject_id TEXT,
      priority TEXT NOT NULL CHECK (priority IN ('interactive', 'normal', 'background')),
      input_json TEXT NOT NULL,
      evidence_digest TEXT,
      request_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      agent_version_id TEXT NOT NULL REFERENCES agent_versions(id),
      model_id TEXT NOT NULL REFERENCES models(id),
      standard_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
      source TEXT NOT NULL DEFAULT 'model',
      output_json TEXT,
      output_digest TEXT,
      error_code TEXT,
      error_message TEXT,
      current_attempt INTEGER NOT NULL DEFAULT 0 CHECK (current_attempt >= 0),
      lease_token TEXT,
      lease_expires_at TEXT,
      cancel_requested_at TEXT,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (issuer, owner, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, priority, requested_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner, requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature, requested_at DESC);

    CREATE TABLE IF NOT EXISTS task_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
      provider_id TEXT NOT NULL REFERENCES providers(id),
      model_id TEXT NOT NULL REFERENCES models(id),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'unknown')),
      lease_token TEXT,
      request_meta_json TEXT NOT NULL DEFAULT '{}',
      response_meta_json TEXT NOT NULL DEFAULT '{}',
      input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
      audio_seconds INTEGER NOT NULL DEFAULT 0 CHECK (audio_seconds >= 0),
      image_pages INTEGER NOT NULL DEFAULT 0 CHECK (image_pages >= 0),
      cost_micro INTEGER NOT NULL DEFAULT 0 CHECK (cost_micro >= 0),
      cost_status TEXT NOT NULL CHECK (cost_status IN ('calculated', 'estimated', 'unknown', 'not_applicable')),
      price_version_id TEXT REFERENCES price_versions(id),
      external_request_id TEXT,
      error_code TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (task_id, attempt_no)
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id, attempt_no);

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);

    CREATE TABLE IF NOT EXISTS budget_policies (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'owner', 'feature', 'agent')),
      scope_key TEXT NOT NULL,
      period TEXT NOT NULL CHECK (period IN ('daily', 'monthly')),
      currency TEXT NOT NULL DEFAULT 'USD',
      amount_micro INTEGER NOT NULL DEFAULT 0 CHECK (amount_micro >= 0),
      call_limit INTEGER NOT NULL DEFAULT 0 CHECK (call_limit >= 0),
      warning_percent INTEGER NOT NULL DEFAULT 80 CHECK (warning_percent BETWEEN 1 AND 100),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (scope_type, scope_key, period)
    );

    CREATE TABLE IF NOT EXISTS budget_reservations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
      policy_id TEXT NOT NULL REFERENCES budget_policies(id),
      period_key TEXT NOT NULL,
      reserved_micro INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0),
      actual_micro INTEGER NOT NULL DEFAULT 0 CHECK (actual_micro >= 0),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'unknown')),
      created_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_budget_reservations_period
      ON budget_reservations(policy_id, period_key, status);

    CREATE TABLE IF NOT EXISTS usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      feature TEXT NOT NULL,
      task_type TEXT NOT NULL,
      agent_version_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      price_version_id TEXT,
      usage_json TEXT NOT NULL,
      cost_micro INTEGER NOT NULL DEFAULT 0 CHECK (cost_micro >= 0),
      cost_status TEXT NOT NULL CHECK (cost_status IN ('calculated', 'estimated', 'unknown', 'not_applicable')),
      currency TEXT NOT NULL DEFAULT 'USD',
      function_fee_micro INTEGER NOT NULL DEFAULT 0 CHECK (function_fee_micro >= 0),
      fee_status TEXT NOT NULL DEFAULT 'not_configured' CHECK (fee_status IN ('calculated', 'estimated', 'not_configured')),
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_ledger(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_feature ON usage_ledger(feature, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      task_type TEXT NOT NULL,
      feature TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 30 AND 2592000),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      priority TEXT NOT NULL DEFAULT 'background' CHECK (priority = 'background'),
      input_template_json TEXT NOT NULL DEFAULT '{}',
      next_run_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
      started_at TEXT,
      completed_at TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (schedule_id, dedupe_key)
    );

    CREATE TABLE IF NOT EXISTS result_deliveries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      request_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}
