import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db.js";
import { createProactiveScanRepository } from "../src/assistant/proactiveScanRepository.js";
import { previewUnavailableCustomerEvents, reconcileUnavailableCustomerEvents } from "../src/assistant/proactiveEventReconciliation.js";

test("reconciliation requires a fresh snapshot and preserves records, valid customers and unrelated failures", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  const repository = createProactiveScanRepository(db);
  try {
    db.prepare("INSERT INTO customers (id,name,owner) VALUES ('live','Live','alice')").run();
    for (const customerId of ["gone", "live", "transient"]) {
      const item = repository.enqueueEvent({ owner: "alice", eventKey: "change:" + customerId, entityType: "customer", entityId: customerId, payload: { customerId } }).item;
      db.prepare("UPDATE proactive_scan_events SET status='failed',last_error_code=?,attempt_count=5 WHERE id=?")
        .run(customerId === "transient" ? "PROACTIVE_TEMPORARY_FAILURE" : "PROACTIVE_CUSTOMER_NOT_FOUND", item.id);
    }
    const preview = previewUnavailableCustomerEvents(db);
    assert.equal(preview.eligible, 1);
    assert.equal(preview.retained, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM audit_logs").get().n, 0);
    assert.throws(() => reconcileUnavailableCustomerEvents(db, { expectedDigest: "0".repeat(64), actor: "operator", requestId: "fixture-reconcile" }), (error) => error.code === "PROACTIVE_RECONCILIATION_CONFLICT");
    const result = reconcileUnavailableCustomerEvents(db, { expectedDigest: preview.digest, actor: "operator", requestId: "fixture-reconcile" });
    assert.equal(result.completed, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM proactive_scan_events").get().n, 3);
    assert.equal(db.prepare("SELECT status FROM proactive_scan_events WHERE entity_id='live'").get().status, "failed");
    assert.equal(db.prepare("SELECT status FROM proactive_scan_events WHERE entity_id='transient'").get().status, "failed");
    const completed = db.prepare("SELECT status,attempt_count,last_error_code FROM proactive_scan_events WHERE entity_id='gone'").get();
    assert.equal(completed.status, "completed");
    assert.equal(completed.attempt_count, 5);
    assert.equal(completed.last_error_code, "PROACTIVE_SUBJECT_UNAVAILABLE");
    assert.equal(db.prepare("SELECT count(*) n FROM audit_logs WHERE action='proactive.events.reconcile'").get().n, 1);
    assert.equal(previewUnavailableCustomerEvents(db).eligible, 0);
  } finally { db.close(); }
});
