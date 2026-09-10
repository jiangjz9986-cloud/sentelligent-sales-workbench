import { createHash } from "node:crypto";
import { withImmediateTransaction } from "../db/transaction.js";
import { insertAudit } from "../audit/auditRepository.js";

function inventory(db) {
  const candidates = db.prepare(`SELECT id,owner,entity_type,entity_id,payload_json,status,attempt_count,updated_at
    FROM proactive_scan_events WHERE status='failed' AND last_error_code='PROACTIVE_CUSTOMER_NOT_FOUND' ORDER BY id`).all();
  const eligible = [];
  let retained = 0;
  for (const event of candidates) {
    let payload;
    try { payload = JSON.parse(event.payload_json); } catch { retained++; continue; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || (payload.customerIds !== undefined && !Array.isArray(payload.customerIds))) { retained++; continue; }
    const ids = [...new Set([
      ...(payload.customerIds ?? []), payload.customerId,
      event.entity_type === "customer" ? event.entity_id : null,
    ].filter((value) => value !== null && value !== undefined))];
    if (!ids.length || ids.some((id) => typeof id !== "string" || !id || id.length > 200)) { retained++; continue; }
    if (ids.some((id) => db.prepare("SELECT 1 FROM customers WHERE id=? AND owner=? AND deleted_at IS NULL").get(id, event.owner))) { retained++; continue; }
    eligible.push(event);
  }
  const digest = createHash("sha256").update(JSON.stringify(eligible)).digest("hex");
  return { eligible, summary: { candidates: candidates.length, eligible: eligible.length, retained, digest } };
}

export function previewUnavailableCustomerEvents(db) {
  return inventory(db).summary;
}

export function reconcileUnavailableCustomerEvents(db, { expectedDigest, actor, requestId, now = new Date() }) {
  if (!/^[0-9a-f]{64}$/u.test(expectedDigest) || typeof actor !== "string" || !actor || actor.length > 200) {
    throw new TypeError("reconciliation identity and digest are required");
  }
  return withImmediateTransaction(db, () => {
    const current = inventory(db);
    if (current.summary.digest !== expectedDigest) throw Object.assign(new Error("proactive reconciliation snapshot changed"), { code: "PROACTIVE_RECONCILIATION_CONFLICT" });
    const at = now.toISOString();
    for (const event of current.eligible) {
      db.prepare(`UPDATE proactive_scan_events SET status='completed',completed_at=?,updated_at=?,
        lease_token_hash=NULL,lease_expires_at=NULL,last_error_code='PROACTIVE_SUBJECT_UNAVAILABLE',
        last_error_text='Unavailable customer reference reconciled'
        WHERE id=? AND owner=? AND status='failed' AND last_error_code='PROACTIVE_CUSTOMER_NOT_FOUND'`).run(at, at, event.id, event.owner);
    }
    if (current.eligible.length) {
      db.prepare("UPDATE proactive_scan_state SET next_retry_at=NULL,next_run_at=?,updated_at=?").run(at, at);
      insertAudit(db, {
        action: "proactive.events.reconcile", entityType: "proactive_scan", entityId: "runtime",
        actor, requestId, before: null, after: { completedCount: current.eligible.length, retainedCount: current.summary.retained },
        metadata: { evidenceDigest: expectedDigest },
      });
    }
    return { ...current.summary, completed: current.eligible.length };
  });
}
