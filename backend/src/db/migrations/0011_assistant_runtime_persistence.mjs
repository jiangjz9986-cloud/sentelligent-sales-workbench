export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_inbound_events (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      channel TEXT NOT NULL,
      event_id_hash TEXT NOT NULL CHECK (length(event_id_hash) = 64 AND event_id_hash NOT GLOB '*[^0-9a-f]*'),
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'completed', 'failed')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      lease_token_hash TEXT CHECK (lease_token_hash IS NULL OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
      lease_expires_at TEXT,
      response_status INTEGER CHECK (response_status IS NULL OR (response_status BETWEEN 100 AND 599)),
      response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
      error_code TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (owner, channel, event_id_hash)
    );

    CREATE TABLE IF NOT EXISTS assistant_conversations (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      channel TEXT NOT NULL,
      conversation_id_hash TEXT NOT NULL CHECK (length(conversation_id_hash) = 64 AND conversation_id_hash NOT GLOB '*[^0-9a-f]*'),
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'expired')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (owner, channel, conversation_id_hash)
    );

    CREATE TABLE IF NOT EXISTS assistant_draft_parts (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (conversation_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS assistant_pending_actions (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      channel TEXT NOT NULL,
      conversation_id TEXT REFERENCES assistant_conversations(id) ON DELETE SET NULL,
      action_type TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'confirmed', 'executed', 'expired', 'cancelled', 'failed')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      confirmation_code_hash TEXT NOT NULL CHECK (length(confirmation_code_hash) = 64 AND confirmation_code_hash NOT GLOB '*[^0-9a-f]*'),
      lease_token_hash TEXT CHECK (lease_token_hash IS NULL OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
      lease_expires_at TEXT,
      expires_at TEXT NOT NULL,
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assistant_tool_runs (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      channel TEXT NOT NULL,
      event_id_hash TEXT,
      tool_name TEXT NOT NULL,
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
      input_json TEXT NOT NULL CHECK (json_valid(input_json)),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      lease_token_hash TEXT CHECK (lease_token_hash IS NULL OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
      lease_expires_at TEXT,
      output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (owner, channel, event_id_hash, tool_name)
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_events_status ON assistant_inbound_events(owner, channel, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_conversations_updated ON assistant_conversations(owner, channel, updated_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_draft_parts_conversation ON assistant_draft_parts(conversation_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_assistant_actions_status ON assistant_pending_actions(owner, channel, status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_actions_one_active_per_conversation
      ON assistant_pending_actions(owner, channel, conversation_id)
      WHERE conversation_id IS NOT NULL AND status IN ('pending', 'processing', 'confirmed');
    CREATE INDEX IF NOT EXISTS idx_assistant_tool_runs_status ON assistant_tool_runs(owner, channel, status, created_at);
  `);
}
