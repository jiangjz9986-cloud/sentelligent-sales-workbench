export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_decision_analyses (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      analysis_type TEXT NOT NULL CHECK (
        analysis_type IN (
          'opportunity_diagnosis',
          'customer_analysis',
          'meeting_preparation',
          'next_step_decision'
        )
      ),
      industry TEXT NOT NULL DEFAULT 'general',
      customer_id TEXT,
      opportunity_id TEXT,
      quick_record_id TEXT,
      input_json TEXT NOT NULL CHECK (json_valid(input_json)),
      analysis_json TEXT NOT NULL CHECK (json_valid(analysis_json)),
      source TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sales_decision_analysis_opportunity
      ON sales_decision_analyses(opportunity_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sales_decision_analysis_customer
      ON sales_decision_analyses(customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sales_decision_analysis_quick_record
      ON sales_decision_analyses(quick_record_id, created_at DESC);
  `);
}
