// v0.12.x: durable intake batches for consecutive WeChat payment screenshots.
// The batch is intentionally separate from assistant_pending_actions so the
// existing confirmation state machine stays backward-compatible while a
// restart can still recover the batch count and FIFO position.
export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weixin_bookkeeping_batches (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      conversation_id TEXT NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 300),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
      started_at TEXT NOT NULL,
      last_received_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS weixin_bookkeeping_batch_items (
      batch_id TEXT NOT NULL REFERENCES weixin_bookkeeping_batches(id) ON DELETE CASCADE,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      action_id TEXT NOT NULL REFERENCES assistant_pending_actions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      created_at TEXT NOT NULL,
      PRIMARY KEY (batch_id, action_id),
      UNIQUE (batch_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_weixin_bookkeeping_batches_open
      ON weixin_bookkeeping_batches(owner, conversation_id, status, last_received_at);
    CREATE INDEX IF NOT EXISTS idx_weixin_bookkeeping_batch_items_action
      ON weixin_bookkeeping_batch_items(owner, action_id);
    CREATE INDEX IF NOT EXISTS idx_weixin_bookkeeping_batch_items_batch
      ON weixin_bookkeeping_batch_items(batch_id, sequence);
  `);
}
