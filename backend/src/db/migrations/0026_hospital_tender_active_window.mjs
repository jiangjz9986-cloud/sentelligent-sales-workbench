export function apply(db) {
  db.exec(`
    ALTER TABLE hospital_tender_scheduler_state
      ADD COLUMN active_start_hour INTEGER NOT NULL DEFAULT 9
        CHECK (active_start_hour BETWEEN 0 AND 23);
    ALTER TABLE hospital_tender_scheduler_state
      ADD COLUMN active_end_hour INTEGER NOT NULL DEFAULT 20
        CHECK (active_end_hour BETWEEN 1 AND 24);
  `);
}
