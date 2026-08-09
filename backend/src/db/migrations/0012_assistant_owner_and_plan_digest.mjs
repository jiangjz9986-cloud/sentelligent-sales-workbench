import { createHash } from "node:crypto";

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  const encoded = JSON.stringify(canonical(value));
  return encoded ? createHash("sha256").update(encoded, "utf8").digest("hex") : null;
}

export function apply(db) {
  addColumnIfMissing(db, "assistant_pending_actions", "plan_digest", "TEXT");
  addColumnIfMissing(db, "quick_records", "owner", "TEXT");

  const pendingRows = db.prepare(
    "SELECT id, payload_json FROM assistant_pending_actions WHERE plan_digest IS NULL",
  ).all();
  const updatePlanDigest = db.prepare(
    "UPDATE assistant_pending_actions SET plan_digest = $planDigest WHERE id = $id AND plan_digest IS NULL",
  );
  for (const row of pendingRows) {
    try {
      const payload = JSON.parse(row.payload_json);
      const value = payload?.plan ?? payload;
      const planDigest = digest(value);
      if (planDigest) updatePlanDigest.run({ $id: row.id, $planDigest: planDigest });
    } catch {
      // Leave malformed legacy payloads null; the runtime will fail closed.
    }
  }

  db.exec(`
    UPDATE quick_records
    SET owner = (
      SELECT actor FROM audit_logs
      WHERE entity_type = 'quick_record'
        AND entity_id = quick_records.id
        AND action = 'quick_record.create'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
    WHERE owner IS NULL;

    UPDATE quick_records
    SET owner = (
      SELECT owner FROM customers WHERE customers.id = quick_records.customer_id
    )
    WHERE owner IS NULL AND customer_id IS NOT NULL;

    UPDATE quick_records
    SET owner = (
      SELECT owner FROM opportunities WHERE opportunities.id = quick_records.opportunity_id
    )
    WHERE owner IS NULL AND opportunity_id IS NOT NULL;

    UPDATE quick_records SET owner = 'legacy' WHERE owner IS NULL;

    CREATE INDEX IF NOT EXISTS idx_quick_records_owner_week
      ON quick_records(owner, occurred_at, created_at);
  `);
}
