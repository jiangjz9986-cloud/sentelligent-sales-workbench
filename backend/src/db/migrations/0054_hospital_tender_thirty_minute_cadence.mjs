export function apply(db) {
  db.exec(`
    UPDATE hospital_tender_scheduler_state
    SET interval_minutes = 30,
        next_run_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1;
  `);
}
