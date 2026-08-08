import { addColumnIfMissing } from "./0002_phase1_write_integrity.mjs";

export function apply(db) {
  addColumnIfMissing(db, "idempotency_keys", "claim_token", "TEXT");
}
