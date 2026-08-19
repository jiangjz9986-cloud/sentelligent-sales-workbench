export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_business_contexts (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      channel TEXT NOT NULL CHECK (length(channel) BETWEEN 1 AND 100),
      conversation_id_hash TEXT NOT NULL CHECK (
        length(conversation_id_hash) = 64
        AND conversation_id_hash NOT GLOB '*[^0-9a-f]*'
      ),
      customer_id TEXT CHECK (customer_id IS NULL OR length(customer_id) BETWEEN 1 AND 200),
      opportunity_id TEXT CHECK (opportunity_id IS NULL OR length(opportunity_id) BETWEEN 1 AND 200),
      source TEXT NOT NULL CHECK (
        source IN ('user_selection', 'verified_entity', 'analysis', 'system')
      ),
      source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, channel, conversation_id_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_business_context_owner_updated
      ON assistant_business_contexts(owner, channel, updated_at DESC);
  `);
}
