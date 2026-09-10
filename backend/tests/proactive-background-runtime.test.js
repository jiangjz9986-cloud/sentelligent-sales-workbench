import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { apply as applyProactiveRuntime } from "../src/db/migrations/0039_proactive_background_runtime.mjs";
import { openDatabase } from "../src/db.js";
import { createCustomerProactiveSubjectService } from "../src/assistant/customerProactiveSubjectService.js";
import { createProactiveBackgroundWorker } from "../src/assistant/proactiveBackgroundWorker.js";
import { createProactiveScanRepository } from "../src/assistant/proactiveScanRepository.js";
import { createProactiveSuggestionRepository } from "../src/assistant/proactiveSuggestionRepository.js";
import { buildHospitalTenderProactiveEvent } from "../src/hospitalTender/proactiveEvent.js";

const NOW_ISO = "2026-09-05T12:00:00.000Z";

function clockHarness(start = NOW_ISO) {
  let value = new Date(start);
  return {
    now: () => new Date(value),
    advance(ms) { value = new Date(value.getTime() + ms); },
    set(next) { value = new Date(next); },
  };
}

function database() {
  const db = openDatabase({ databaseUrl: ":memory:" });
  // 0039 is intentionally imported by the application migration runner by
  // the integration task. Applying it here keeps this focused test isolated
  // while that wiring remains conflict-free for the parallel server work.
  applyProactiveRuntime(db);
  return db;
}

function insertOpportunity(db, {
  owner = "owner-a",
  customerId = `${owner}-customer`,
  customerName = `${owner} 客户`,
  id,
  name = "医院项目",
  stage = "调研机会",
  next = null,
  days = 5,
  now = NOW_ISO,
} = {}) {
  db.prepare(`
    INSERT OR IGNORE INTO customers (id, name, owner, version, created_at, updated_at)
    VALUES ($customerId, $customerName, $owner, 1, $now, $now)
  `).run({ $customerId: customerId, $customerName: customerName, $owner: owner, $now: now });
  db.prepare(`
    INSERT INTO opportunities (
      id, customer_id, name, stage, owner, days, next, version, created_at, updated_at
    ) VALUES ($id, $customerId, $name, $stage, $owner, $days, $next, 1, $now, $now)
  `).run({ $id: id, $customerId: customerId, $name: name, $stage: stage, $owner: owner, $days: days, $next: next, $now: now });
}

function makeSuggestion(id = "proactive-test") {
  return {
    id,
    schemaVersion: "proactive-assistant-v1",
    modelVersion: "rules/proactive-v1",
    subjectType: "opportunity",
    subjectId: "op-a",
    customerId: "customer-a",
    opportunityId: "op-a",
    title: "补充下一步",
    conclusion: "建议补充可执行动作。",
    facts: [],
    inferences: [],
    unknowns: [],
    risks: [],
    nextActions: [],
    sourceRefs: [{ type: "opportunity", id: "op-a" }],
    trigger: { type: "missing_next_step", detectedAt: NOW_ISO, reason: "next 为空" },
    source: "deterministic",
    fallbackReason: null,
    confidence: 80,
    writebackPreview: { action: { title: "补充下一步", requiresHumanConfirmation: true } },
  };
}

describe("0039 proactive background runtime migration", () => {
  it("creates all durable tables and is idempotent", () => {
    const db = database();
    applyProactiveRuntime(db);
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'proactive_%'
       ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(tables, [
      "proactive_confirmation_previews",
      "proactive_model_cache",
      "proactive_model_usage",
      "proactive_notifications",
      "proactive_scan_events",
      "proactive_scan_lease",
      "proactive_scan_runs",
      "proactive_scan_state",
      "proactive_subjects",
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM proactive_scan_state").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM proactive_scan_lease").get().count, 1);
    assert.ok(db.prepare("PRAGMA table_info(ai_suggestions)").all().some((row) => row.name === "proactive_dedupe_key"));
    db.close();
  });
});

describe("proactive suggestion repository", () => {
  it("persists in the shared ai_suggestions ledger, dedupes and updates volatile text in place", () => {
    const db = database();
    const harness = clockHarness();
    const repository = createProactiveSuggestionRepository(db, { clock: harness.now });
    const suggestion = makeSuggestion();
    const first = repository.save({ owner: "owner-a", suggestion, dedupeKey: "proactive:v1:same" });
    assert.equal(first.replayed, false);
    const changed = { ...suggestion, conclusion: "建议今天补充可执行动作。" };
    const replay = repository.save({ owner: "owner-a", suggestion: changed, dedupeKey: "proactive:v1:same" });
    assert.equal(replay.replayed, true);
    assert.equal(repository.count({ owner: "owner-a" }), 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_suggestions").get().count, 1);
    assert.equal(repository.get("proactive-test", { owner: "owner-a" }).suggestion.conclusion, "建议今天补充可执行动作。");
    assert.equal(repository.get("proactive-test", { owner: "owner-b" }), null);

    harness.advance(60_000);
    const snoozed = repository.snooze("proactive-test", { owner: "owner-a", until: new Date(harness.now().getTime() + 60_000) });
    assert.equal(snoozed.proactiveStatus, "snoozed");
    harness.advance(60_001);
    assert.deepEqual(repository.expireDue({ owner: "owner-a" }), { resumedCount: 1, expiredCount: 0 });
    assert.equal(repository.get("proactive-test", { owner: "owner-a" }).proactiveStatus, "pending");
    assert.equal(repository.dismiss("proactive-test", { owner: "owner-a", reason: "人工判断不需要" }).proactiveStatus, "dismissed");
    assert.equal(repository.resolve("proactive-test", { owner: "owner-a", resultRefs: [{ type: "action", id: "action-a" }] }).proactiveStatus, "resolved");
    db.close();
  });

  it("supports direct point lookup beyond list pagination and preserves lifecycle on rescan", () => {
    const db = database();
    const repository = createProactiveSuggestionRepository(db, { clock: () => new Date(NOW_ISO) });
    for (let index = 0; index < 4; index += 1) {
      repository.save({
        owner: "owner-a",
        suggestion: makeSuggestion(`proactive-${index}`),
        dedupeKey: `proactive:v1:${index}`,
      });
    }
    assert.equal(repository.list({ owner: "owner-a", limit: 2 }).length, 2);
    assert.equal(repository.get("proactive-3", { owner: "owner-a" }).id, "proactive-3");
    repository.resolve("proactive-3", { owner: "owner-a" });
    repository.save({ owner: "owner-a", suggestion: makeSuggestion("proactive-3"), dedupeKey: "proactive:v1:3" });
    assert.equal(repository.get("proactive-3", { owner: "owner-a" }).proactiveStatus, "resolved");
    db.close();
  });
});

describe("proactive scan repository leases and events", () => {
  it("fences concurrent lease holders and recovers the expired holder", () => {
    const db = database();
    const harness = clockHarness();
    let tokenIndex = 0;
    const repository = createProactiveScanRepository(db, {
      clock: harness.now,
      leaseTokenFactory: () => `lease-${++tokenIndex}`,
    });
    const first = repository.tryAcquireLease({ workerId: "worker-a", leaseMs: 1_000 });
    assert.ok(first);
    assert.equal(repository.tryAcquireLease({ workerId: "worker-b", leaseMs: 1_000 }), null);
    assert.equal(repository.isLeaseCurrent({ workerId: "worker-a", leaseToken: first.leaseToken }), true);
    assert.equal(repository.releaseLease({ workerId: "worker-b", leaseToken: first.leaseToken }), false);
    harness.advance(1_001);
    const second = repository.tryAcquireLease({ workerId: "worker-b", leaseMs: 1_000 });
    assert.ok(second);
    assert.equal(repository.isLeaseCurrent({ workerId: "worker-a", leaseToken: first.leaseToken }), false);
    assert.throws(() => repository.assertLease({ workerId: "worker-a", leaseToken: first.leaseToken }), /lease/i);
    assert.equal(repository.releaseLease({ workerId: "worker-a", leaseToken: first.leaseToken }), false);
    assert.equal(repository.releaseLease({ workerId: "worker-b", leaseToken: second.leaseToken }), true);
    db.close();
  });

  it("deduplicates committed events and retries failures with persisted exponential backoff", () => {
    const db = database();
    const harness = clockHarness();
    let idIndex = 0;
    let tokenIndex = 0;
    const repository = createProactiveScanRepository(db, {
      clock: harness.now,
      idFactory: () => `event-${++idIndex}`,
      leaseTokenFactory: () => `event-lease-${++tokenIndex}`,
    });
    const first = repository.enqueueEvent({ owner: "owner-a", eventKey: "op-a:updated:1", entityType: "opportunity", entityId: "op-a", payload: { opportunityId: "op-a", changedAt: NOW_ISO } });
    const replay = repository.enqueueEvent({ owner: "owner-a", eventKey: "op-a:updated:1", entityType: "opportunity", entityId: "op-a", payload: { changedAt: NOW_ISO, opportunityId: "op-a" } });
    assert.equal(replay.replayed, true);
    assert.equal(repository.listEvents({ owner: "owner-a" }).length, 1);
    const claimed = repository.claimEvent({ workerId: "worker-a", leaseMs: 1_000 });
    assert.equal(claimed.item.attemptCount, 1);
    const failed = repository.failEvent(claimed.item.id, { leaseToken: claimed.leaseToken, errorCode: "SOURCE_TEMPORARY", errorText: "source unavailable", retryBaseMs: 10_000 });
    assert.equal(failed.item.status, "failed");
    assert.equal(failed.item.attemptCount, 1);
    assert.equal(failed.item.availableAt, "2026-09-05T12:00:10.000Z");
    assert.equal(repository.claimEvent({ workerId: "worker-b", leaseMs: 1_000 }), null);
    harness.advance(10_001);
    const retried = repository.claimEvent({ workerId: "worker-b", leaseMs: 1_000 });
    assert.equal(retried.item.attemptCount, 2);
    assert.equal(repository.completeEvent(retried.item.id, { leaseToken: retried.leaseToken }).item.status, "completed");
    assert.equal(repository.enqueueEvent({ owner: "owner-a", eventKey: "op-a:updated:1", entityType: "opportunity", entityId: "op-a", payload: { opportunityId: "op-a", changedAt: NOW_ISO } }).replayed, true);
    assert.equal(repository.pendingEventCount({ owner: "owner-a" }), 0);
    db.close();
  });

  it("replays legacy hospital tender events when only the scheduler run id changes", () => {
    const db = database();
    const repository = createProactiveScanRepository(db, { clock: () => new Date(NOW_ISO) });
    const stable = buildHospitalTenderProactiveEvent({
      changedAt: "2026-09-05T12:00:00.000Z",
      snapshotId: "snapshot-a",
      customerIds: ["customer-b", "customer-a", "customer-a"],
      noticeIds: ["notice-b", "notice-a"],
    });

    const first = repository.enqueueEvent({
      owner: "owner-a",
      eventKey: stable.eventKey,
      eventType: "hospital_tender_changed",
      entityType: "hospital_tender",
      entityId: "snapshot-a",
      payload: { ...stable.payload, runId: "scheduler-run-1" },
    });
    const replay = repository.enqueueEvent({
      owner: "owner-a",
      eventKey: stable.eventKey,
      eventType: "hospital_tender_changed",
      entityType: "hospital_tender",
      entityId: "snapshot-a",
      payload: { ...stable.payload, runId: "scheduler-run-2" },
    });

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.item.payload, { ...stable.payload, runId: "scheduler-run-1" });
    assert.throws(
      () => repository.enqueueEvent({
        owner: "owner-a",
        eventKey: stable.eventKey,
        eventType: "hospital_tender_changed",
        entityType: "hospital_tender",
        entityId: "snapshot-a",
        payload: { ...stable.payload, noticeIds: ["notice-a", "notice-c"], runId: "scheduler-run-3" },
      }),
      (error) => error.code === "PROACTIVE_EVENT_CONFLICT",
    );
    db.close();
  });
});

describe("proactive background worker", () => {
  it("syncs one customer subject per owner/customer with the shared suggestion ledger", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, {
      owner: "owner-a",
      customerId: "customer-shared",
      customerName: "共享客户",
      id: "op-shared-a",
      name: "共享项目 A",
    });
    insertOpportunity(db, {
      owner: "owner-a",
      customerId: "customer-shared",
      customerName: "共享客户",
      id: "op-shared-b",
      name: "共享项目 B",
    });
    insertOpportunity(db, {
      owner: "owner-a",
      customerId: "customer-other",
      customerName: "另一客户",
      id: "op-other",
      name: "另一项目",
    });
    insertOpportunity(db, {
      owner: "owner-b",
      customerId: "customer-b",
      customerName: "B 客户",
      id: "op-b",
      name: "B 项目",
    });

    let suggestionId = 0;
    let subjectId = 0;
    const suggestionRepository = createProactiveSuggestionRepository(db, {
      clock: harness.now,
      idFactory: () => `suggestion-${++suggestionId}`,
    });
    const subjectService = createCustomerProactiveSubjectService({
      db,
      clock: harness.now,
      idFactory: () => `subject-${++subjectId}`,
      suggestionRepository,
    });
    const syncCalls = [];
    const injectedSubjectService = {
      suggestionRepository,
      syncCustomer(input) {
        syncCalls.push({ owner: input.owner, customerId: input.customerId });
        return subjectService.syncCustomer(input);
      },
      assertCurrentRevision: subjectService.assertCurrentRevision,
      validateRevision: subjectService.validateRevision,
    };
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-customer-subjects",
      batchSize: 10,
      leaseMs: 1_000,
      retryBaseMs: 10,
      includeExtendedSignals: false,
      suggestionRepository,
      customerProactiveSubjectService: injectedSubjectService,
    });

    const first = await worker.runOnce({ force: true });
    assert.equal(first.status, "success");
    assert.equal(first.objectCount, 4);
    assert.equal(first.opportunityObjectCount, 4);
    assert.equal(first.opportunitySuggestionCount, 4);
    assert.equal(first.customerSubjectCount, 3);
    assert.equal(first.customerScan.attemptedCount, 3);
    assert.equal(first.customerScan.succeededCount, 3);
    assert.equal(first.customerScan.failedCount, 0);
    assert.equal(first.customerSuggestionCount, 3);
    assert.equal(first.suggestionCount, 7);
    assert.equal(first.insertedCount, 7);
    assert.equal(first.run.customerSubjectCount, 3);
    assert.deepEqual(syncCalls, [
      { owner: "owner-a", customerId: "customer-other" },
      { owner: "owner-a", customerId: "customer-shared" },
      { owner: "owner-b", customerId: "customer-b" },
    ]);

    const ownerAItems = suggestionRepository.list({ owner: "owner-a", limit: 100 });
    const ownerBItems = suggestionRepository.list({ owner: "owner-b", limit: 100 });
    assert.equal(ownerAItems.filter((item) => item.subjectType === "opportunity").length, 3);
    assert.equal(ownerAItems.filter((item) => item.subjectType === "customer").length, 2);
    assert.equal(ownerBItems.filter((item) => item.subjectType === "opportunity").length, 1);
    assert.equal(ownerBItems.filter((item) => item.subjectType === "customer").length, 1);
    assert.equal(worker.status().customerProactiveSubjects.lastScan.status, "success");
    assert.equal(worker.status().customerProactiveSubjects.lastScan.subjectCount, 3);

    const before = subjectService.getSubject({ owner: "owner-a", customerId: "customer-shared" });
    assert.equal(worker.assertCurrentCustomerSubjectRevision({
      owner: "owner-a",
      customerId: "customer-shared",
      expectedVersion: before.version,
      expectedSourceDigest: before.sourceDigest,
    }).version, before.version);
    assert.equal(worker.validateCustomerSubjectRevision({
      owner: "owner-a",
      customerId: "customer-shared",
      expectedVersion: before.version,
      expectedSourceDigest: before.sourceDigest,
    }).valid, true);

    db.prepare(`
      UPDATE opportunities
         SET version = 2, updated_at = '2026-09-05T12:01:00.000Z'
       WHERE id = 'op-shared-b'
    `).run();
    harness.advance(60_000);
    const second = await worker.runOnce({ force: true });
    assert.equal(second.status, "success");
    assert.equal(second.customerSubjectCount, 3);
    assert.equal(second.customerInsertedCount, 0);
    assert.equal(second.customerDedupedCount, 3);
    assert.equal(syncCalls.length, 6);

    const after = subjectService.getSubject({ owner: "owner-a", customerId: "customer-shared" });
    assert.equal(after.version, before.version + 1);
    assert.notEqual(after.sourceDigest, before.sourceDigest);
    assert.throws(
      () => worker.assertCurrentCustomerSubjectRevision({
        owner: "owner-a",
        customerId: "customer-shared",
        expectedVersion: before.version,
        expectedSourceDigest: before.sourceDigest,
      }),
      (error) => error?.code === "PROACTIVE_SUBJECT_STALE" && error?.fields?.currentVersion === after.version,
    );
    // The changed opportunity evidence receives a new opportunity suggestion
    // revision; the customer subject keeps its stable id and is updated in
    // place. The ledger therefore grows by one opportunity row, not one
    // customer row.
    assert.equal(suggestionRepository.count({ owner: "owner-a" }), 6);
    assert.equal(suggestionRepository.count({ owner: "owner-b" }), 2);
    db.close();
  });

  it("deduplicates customer sync across multiple events in one batch", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, {
      owner: "owner-a",
      customerId: "event-customer",
      customerName: "事件客户",
      id: "event-op-a",
      name: "事件项目 A",
    });
    insertOpportunity(db, {
      owner: "owner-a",
      customerId: "event-customer",
      customerName: "事件客户",
      id: "event-op-b",
      name: "事件项目 B",
    });
    const suggestionRepository = createProactiveSuggestionRepository(db, { clock: harness.now });
    const subjectService = createCustomerProactiveSubjectService({
      db,
      clock: harness.now,
      suggestionRepository,
    });
    const syncCalls = [];
    const injectedSubjectService = {
      suggestionRepository,
      syncCustomer(input) {
        syncCalls.push(`${input.owner}:${input.customerId}`);
        return subjectService.syncCustomer(input);
      },
      assertCurrentRevision: subjectService.assertCurrentRevision,
      validateRevision: subjectService.validateRevision,
    };
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-customer-events",
      eventBatchSize: 2,
      leaseMs: 1_000,
      retryBaseMs: 10,
      includeExtendedSignals: false,
      suggestionRepository,
      customerProactiveSubjectService: injectedSubjectService,
    });
    worker.enqueueEvent({
      owner: "owner-a",
      eventKey: "event-op-a:updated:1",
      entityType: "opportunity",
      entityId: "event-op-a",
      payload: { opportunityId: "event-op-a" },
    });
    worker.enqueueEvent({
      owner: "owner-a",
      eventKey: "event-op-b:updated:1",
      entityType: "opportunity",
      entityId: "event-op-b",
      payload: { opportunityId: "event-op-b" },
    });

    const result = await worker.runOnce({ force: true });
    assert.equal(result.status, "success");
    assert.equal(result.eventCount, 2);
    assert.equal(result.customerSubjectCount, 1);
    assert.equal(result.customerScan.succeededCount, 1);
    assert.deepEqual(syncCalls, ["owner-a:event-customer"]);
    assert.equal(worker.scanRepository.pendingEventCount({ owner: "owner-a" }), 0);
    assert.equal(
      suggestionRepository.list({ owner: "owner-a", limit: 100 }).filter((item) => item.subjectType === "customer").length,
      1,
    );
    db.close();
  });

  it("finishes unavailable customer events without losing their audit or starving live work", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, { owner: "owner-a", customerId: "live-customer", id: "live-opportunity" });
    db.prepare("INSERT INTO customers (id, name, owner, deleted_at) VALUES ('deleted-customer', 'deleted', 'owner-a', ?), ('other-customer', 'other', 'owner-b', NULL)").run(NOW_ISO);
    const suggestionRepository = createProactiveSuggestionRepository(db, { clock: harness.now });
    const subjectService = createCustomerProactiveSubjectService({ db, clock: harness.now, suggestionRepository });
    const worker = createProactiveBackgroundWorker({
      db, clock: harness.now, suggestionRepository, customerProactiveSubjectService: subjectService,
      workerId: "worker-stale-subjects", eventBatchSize: 10,
    });
    try {
      const stale = ["missing-customer", "deleted-customer", "other-customer"].map((customerId) => worker.enqueueEvent({
        owner: "owner-a", eventKey: customerId + ":changed:1",
        entityType: "customer", entityId: customerId, payload: { customerId },
      }));
      const live = worker.enqueueEvent({
        owner: "owner-a", eventKey: "live:changed:1",
        entityType: "customer", entityId: "live-customer", payload: { customerId: "live-customer" },
      });
      const result = await worker.runOnce({ force: true });
      assert.equal(result.status, "success");
      assert.equal(result.customerScan.skippedCount, 3);
      assert.equal(result.customerScan.failedCount, 0);
      assert.equal(result.state.failureCount, 0);
      for (const event of stale) {
        const row = worker.scanRepository.getEvent(event.item.id);
        assert.equal(row.status, "completed");
        assert.equal(row.lastErrorCode, "PROACTIVE_SUBJECT_UNAVAILABLE");
        assert.equal(row.attemptCount, 1);
        assert.ok(row.completedAt);
      }
      assert.equal(worker.scanRepository.getEvent(live.item.id).status, "completed");
      assert.ok(subjectService.getSubject({ owner: "owner-a", customerId: "live-customer" }));
      harness.advance(60 * 60_000);
      await worker.runOnce({ force: true });
      assert.equal(worker.scanRepository.getEvent(stale[0].item.id).attemptCount, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM proactive_scan_events").get().n, 4);
    } finally {
      worker.stop();
      db.close();
    }
  });

  it("does not suppress a not-found error when the customer still exists for the owner", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, { owner: "owner-a", customerId: "present-customer", id: "present-opportunity" });
    const suggestionRepository = createProactiveSuggestionRepository(db, { clock: harness.now });
    const worker = createProactiveBackgroundWorker({
      db, clock: harness.now, suggestionRepository, workerId: "worker-broken-subject-service",
      customerProactiveSubjectService: {
        suggestionRepository,
        syncCustomer() { throw Object.assign(new Error("unexpected subject failure"), { code: "PROACTIVE_CUSTOMER_NOT_FOUND" }); },
      },
    });
    try {
      const event = worker.enqueueEvent({ owner: "owner-a", eventKey: "present:changed:1", entityType: "customer", entityId: "present-customer", payload: { customerId: "present-customer" } });
      const result = await worker.runOnce({ force: true });
      assert.equal(result.status, "failed");
      assert.equal(worker.scanRepository.getEvent(event.item.id).status, "failed");
      assert.equal(result.customerScan.skippedCount, 0);
    } finally {
      worker.stop();
      db.close();
    }
  });

  it("keeps an event retryable when customer subject sync fails", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, {
      owner: "owner-a",
      customerId: "retry-customer",
      id: "retry-opportunity",
      name: "需要重试的项目",
    });
    const suggestionRepository = createProactiveSuggestionRepository(db, { clock: harness.now });
    const subjectService = createCustomerProactiveSubjectService({ db, clock: harness.now, suggestionRepository });
    let attempts = 0;
    const injectedSubjectService = {
      suggestionRepository,
      syncCustomer(input) {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary customer subject failure");
        return subjectService.syncCustomer(input);
      },
      assertCurrentRevision: subjectService.assertCurrentRevision,
      validateRevision: subjectService.validateRevision,
    };
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-customer-retry",
      eventBatchSize: 1,
      leaseMs: 1_000,
      retryBaseMs: 10,
      suggestionRepository,
      customerProactiveSubjectService: injectedSubjectService,
    });
    const queued = worker.enqueueEvent({
      owner: "owner-a",
      eventKey: "retry-customer:changed:1",
      entityType: "opportunity",
      entityId: "retry-opportunity",
      payload: { opportunityId: "retry-opportunity", customerId: "retry-customer" },
    });

    const first = await worker.runOnce({ force: true });
    assert.equal(first.status, "failed");
    assert.equal(worker.scanRepository.getEvent(queued.item.id).status, "failed");
    assert.equal(worker.scanRepository.getEvent(queued.item.id).attemptCount, 1);
    assert.equal(worker.scanRepository.getEvent(queued.item.id).lastErrorCode, "PROACTIVE_CUSTOMER_SUBJECT_SYNC_FAILED");

    harness.advance(11);
    const second = await worker.runOnce({ force: true });
    assert.equal(second.status, "success");
    assert.equal(worker.scanRepository.getEvent(queued.item.id).status, "completed");
    assert.equal(worker.scanRepository.getEvent(queued.item.id).attemptCount, 2);
    assert.equal(attempts, 2);
    assert.ok(subjectService.getSubject({ owner: "owner-a", customerId: "retry-customer" }));
    db.close();
  });

  it("syncs a customer event without an opportunity and keeps customer ownership isolated", async () => {
    const db = database();
    const harness = clockHarness();
    db.prepare(`
      INSERT INTO customers (id, name, owner, version, created_at, updated_at)
      VALUES ('customer-without-opportunity', '无商机客户', 'owner-a', 1, $now, $now)
    `).run({ $now: NOW_ISO });
    db.prepare(`
      INSERT INTO action_items (id, customer_id, title, owner, status, due, version, created_at, updated_at)
      VALUES ('customer-only-action', 'customer-without-opportunity', '客户级信号', 'owner-a', 'pending', '2026-09-01', 1, $now, $now)
    `).run({ $now: NOW_ISO });
    db.prepare(`
      INSERT INTO customers (id, name, owner, version, created_at, updated_at)
      VALUES ('other-owner-customer', '另一账号客户', 'owner-b', 1, $now, $now)
    `).run({ $now: NOW_ISO });

    const suggestionRepository = createProactiveSuggestionRepository(db, { clock: harness.now });
    const subjectService = createCustomerProactiveSubjectService({ db, clock: harness.now, suggestionRepository });
    const syncCalls = [];
    const injectedSubjectService = {
      suggestionRepository,
      syncCustomer(input) {
        syncCalls.push({ owner: input.owner, customerId: input.customerId });
        return subjectService.syncCustomer(input);
      },
      assertCurrentRevision: subjectService.assertCurrentRevision,
      validateRevision: subjectService.validateRevision,
    };
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-customer-without-opportunity",
      eventBatchSize: 1,
      leaseMs: 1_000,
      retryBaseMs: 10,
      ownersProvider: () => ["owner-a"],
      suggestionRepository,
      customerProactiveSubjectService: injectedSubjectService,
      includeExtendedSignals: true,
    });
    const queued = worker.enqueueEvent({
      owner: "owner-a",
      eventKey: "customer-without-opportunity:changed:1",
      entityType: "customer",
      entityId: "customer-without-opportunity",
      payload: { customerId: "customer-without-opportunity" },
    });
    const result = await worker.runOnce({ force: true });
    assert.equal(result.status, "success");
    assert.deepEqual(syncCalls, [{ owner: "owner-a", customerId: "customer-without-opportunity" }]);
    assert.equal(worker.scanRepository.getEvent(queued.item.id).status, "completed");
    assert.ok(subjectService.getSubject({ owner: "owner-a", customerId: "customer-without-opportunity" }));
    assert.equal(subjectService.getSubject({ owner: "owner-a", customerId: "other-owner-customer" }), null);
    db.close();
  });

  it("periodically scans customer-level signals for customers without opportunities", async () => {
    const db = database();
    const harness = clockHarness();
    db.prepare(`
      INSERT INTO customers (id, name, owner, version, created_at, updated_at)
      VALUES ('periodic-customer-only', '周期客户', 'owner-a', 1, $now, $now),
             ('periodic-foreign-customer', '外部周期客户', 'owner-b', 1, $now, $now)
    `).run({ $now: NOW_ISO });
    db.prepare(`
      INSERT INTO action_items (id, customer_id, title, owner, status, version, created_at, updated_at)
      VALUES ('periodic-customer-action', 'periodic-customer-only', '周期客户信号', 'owner-a', 'pending', 1, $now, $now),
             ('periodic-foreign-action', 'periodic-foreign-customer', '外部客户信号', 'owner-b', 'pending', 1, $now, $now)
    `).run({ $now: NOW_ISO });
    const suggestionRepository = createProactiveSuggestionRepository(db, { clock: harness.now });
    const subjectService = createCustomerProactiveSubjectService({ db, clock: harness.now, suggestionRepository });
    const syncCalls = [];
    const injectedSubjectService = {
      suggestionRepository,
      syncCustomer(input) {
        syncCalls.push(`${input.owner}:${input.customerId}`);
        return subjectService.syncCustomer(input);
      },
      assertCurrentRevision: subjectService.assertCurrentRevision,
      validateRevision: subjectService.validateRevision,
    };
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-periodic-customer-signals",
      batchSize: 10,
      leaseMs: 1_000,
      retryBaseMs: 10,
      ownersProvider: () => ["owner-a"],
      suggestionRepository,
      customerProactiveSubjectService: injectedSubjectService,
    });
    const result = await worker.runOnce({ force: true });
    assert.equal(result.status, "success");
    assert.deepEqual(syncCalls, ["owner-a:periodic-customer-only"]);
    assert.ok(subjectService.getSubject({ owner: "owner-a", customerId: "periodic-customer-only" }));
    assert.equal(subjectService.getSubject({ owner: "owner-b", customerId: "periodic-foreign-customer" }), null);
    db.close();
  });

  it("scans bounded batches, advances a durable cursor, and dedupes a second cycle", async () => {
    const db = database();
    const harness = clockHarness();
    for (let index = 0; index < 5; index += 1) {
      insertOpportunity(db, { id: `op-${index}`, name: `项目-${index}` });
    }
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-a",
      batchSize: 2,
      intervalSeconds: 30,
      leaseMs: 1_000,
      retryBaseMs: 10,
    });
    // Migration state is authoritative; set a small test batch explicitly.
    worker.scanRepository.updateState({ batchSize: 2, intervalSeconds: 30 });
    const first = await worker.runOnce({ force: true });
    assert.equal(first.status, "success");
    assert.equal(first.objectCount, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.state.cursorOpportunityId, "op-1");
    const second = await worker.runOnce({ force: true });
    assert.equal(second.objectCount, 2);
    assert.equal(second.state.cursorOpportunityId, "op-3");
    const third = await worker.runOnce({ force: true });
    assert.equal(third.objectCount, 1);
    assert.equal(third.hasMore, false);
    assert.equal(third.state.cursorOpportunityId, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_suggestions WHERE proactive_trigger IS NOT NULL").get().count, 5);
    const fourth = await worker.runOnce({ force: true });
    assert.equal(fourth.dedupedCount, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_suggestions WHERE proactive_trigger IS NOT NULL").get().count, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM proactive_scan_runs WHERE status = 'success'").get().count, 4);
    db.close();
  });

  it("keeps two worker instances mutually exclusive while one is processing", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, { id: "op-concurrent", name: "并发项目" });
    let entered;
    let release;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const releasePromise = new Promise((resolve) => { release = resolve; });
    const blockingBuilder = async (input) => {
      entered();
      await releasePromise;
      return { items: [] };
    };
    const first = createProactiveBackgroundWorker({ db, clock: harness.now, workerId: "worker-one", leaseMs: 60_000, snapshotBuilder: blockingBuilder });
    const second = createProactiveBackgroundWorker({ db, clock: harness.now, workerId: "worker-two", leaseMs: 60_000, snapshotBuilder: () => ({ items: [] }) });
    const firstRun = first.runOnce({ force: true });
    await enteredPromise;
    const secondRun = await second.runOnce({ force: true });
    assert.equal(secondRun.status, "skipped");
    assert.equal(secondRun.reason, "locked");
    release();
    assert.equal((await firstRun).status, "success");
    db.close();
  });

  it("consumes a committed business event without a page request", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, { id: "op-event", name: "事件项目" });
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-event",
      leaseMs: 1_000,
      retryBaseMs: 10,
    });
    const queued = worker.enqueueEvent({ owner: "owner-a", eventKey: "op-event:changed:1", entityType: "opportunity", entityId: "op-event", payload: { opportunityId: "op-event" } });
    const result = await worker.runOnce({ force: true });
    assert.equal(result.status, "success");
    assert.equal(result.eventCount, 1);
    assert.equal(worker.scanRepository.getEvent(queued.item.id).status, "completed");
    assert.equal(worker.suggestionRepository.count({ owner: "owner-a" }), 1);
    db.close();
  });

  it("does not treat a sibling opportunity interaction as direct stale evidence", async () => {
    const db = database();
    const harness = clockHarness();
    const customerId = "shared-customer";
    insertOpportunity(db, {
      id: "op-primary",
      customerId,
      customerName: "共享客户",
      name: "主项目",
      stage: "调研机会",
      next: "下一次回访",
    });
    insertOpportunity(db, {
      id: "op-sibling",
      customerId,
      customerName: "共享客户",
      name: "兄弟项目",
      stage: "调研机会",
      next: "下一次回访",
    });
    db.prepare(`
      INSERT INTO quick_records (
        id, owner, raw_content, occurred_at, source_channel,
        customer_id, opportunity_id, status
      ) VALUES (
        'sibling-interaction', 'owner-a', '不应被读取到模型上下文的正文',
        '2026-08-01T10:00:00.000Z', 'phone', $customerId, 'op-sibling', 'confirmed'
      )
    `).run({ $customerId: customerId });
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-sibling-boundary",
      batchSize: 10,
      leaseMs: 1_000,
      retryBaseMs: 10,
    });
    const result = await worker.runOnce({ force: true });
    assert.equal(result.status, "success");
    const primary = worker.suggestionRepository.list({ owner: "owner-a", opportunityId: "op-primary", limit: 100 });
    const sibling = worker.suggestionRepository.list({ owner: "owner-a", opportunityId: "op-sibling", limit: 100 });
    assert.equal(primary.some((item) => item.trigger === "stale_opportunity"), false);
    assert.equal(sibling.some((item) => item.trigger === "stale_opportunity"), true);
    db.close();
  });

  it("persists failure backoff and recovers a stale run after restart", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, { id: "op-failure", name: "失败项目" });
    let calls = 0;
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-failure",
      leaseMs: 1_000,
      retryBaseMs: 10_000,
      snapshotBuilder: () => {
        calls += 1;
        if (calls === 1) throw new Error("synthetic source failure");
        return { items: [] };
      },
    });
    const failed = await worker.runOnce({ force: true });
    assert.equal(failed.status, "failed");
    assert.equal(failed.state.failureCount, 1);
    assert.equal(failed.state.nextRetryAt, "2026-09-05T12:00:10.000Z");
    const waiting = await worker.runOnce();
    assert.equal(waiting.status, "waiting");
    harness.advance(10_001);
    const recovered = await worker.runOnce();
    assert.equal(recovered.status, "success");
    assert.equal(recovered.state.failureCount, 0);

    db.prepare(`
      INSERT INTO proactive_scan_runs (
        id, cycle_number, trigger, worker_id, status, started_at, created_at, updated_at
      ) VALUES ('stale-run', 1, 'scheduled', 'old-worker', 'running', $startedAt, $startedAt, $startedAt)
    `).run({ $startedAt: "2026-09-05T11:00:00.000Z" });
    const restarted = createProactiveBackgroundWorker({ db, clock: harness.now, workerId: "new-worker", leaseMs: 1_000, retryBaseMs: 10_000, snapshotBuilder: () => ({ items: [] }) });
    await restarted.runOnce({ force: true });
    assert.equal(db.prepare("SELECT status FROM proactive_scan_runs WHERE id = 'stale-run'").get().status, "failed");
    assert.equal(db.prepare("SELECT error_code FROM proactive_scan_runs WHERE id = 'stale-run'").get().error_code, "PROACTIVE_SCAN_RESTARTED");
    db.close();
  });

  it("exposes a timer-backed API independent of browser/page lifetime", () => {
    const db = database();
    const worker = createProactiveBackgroundWorker({ db, workerId: "worker-timer", pollMs: 1_000 });
    assert.equal(worker.status().running, false);
    worker.start();
    assert.equal(worker.status().running, true);
    worker.stop();
    assert.equal(worker.status().running, false);
    db.close();
  });

  it("enriches deterministic suggestions with the configured sales model and records provenance", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, { id: "op-model", name: "模型项目" });
    db.prepare(`
      INSERT INTO quick_records (
        id, owner, raw_content, occurred_at, source_channel,
        customer_id, opportunity_id, status
      ) VALUES (
        'model-record', 'owner-a', '模型上下文不应包含这段原始正文',
        '2026-09-01T10:00:00.000Z', 'phone', 'owner-a-customer', 'op-model', 'confirmed'
      )
    `).run();
    let calls = 0;
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-model",
      leaseMs: 1_000,
      retryBaseMs: 10,
      snapshotBuilder: () => ({ items: [{ ...makeSuggestion("proactive-model"), opportunityId: "op-model", subjectId: "op-model", customerId: "owner-a-customer" }] }),
      modelProvider: "deepseek",
      modelName: "deepseek-v4-flash",
      modelTimeoutMs: 1_000,
      modelRetryLimit: 0,
      modelAnalyzer: async (context) => {
        calls += 1;
        assert.equal(context.opportunity.id, "op-model");
        assert.equal(context.quickRecord, null);
        assert.equal(context.interactions.length, 1);
        assert.equal(context.interactions[0].id, "model-record");
        assert.equal(context.interactions[0].opportunityId, "op-model");
        assert.equal(context.interactions[0].customerId, "owner-a-customer");
        assert.equal(context.interactions[0].occurredAt, "2026-09-01T10:00:00.000Z");
        assert.equal(context.interactions[0].sourceChannel, "phone");
        assert.equal(context.interactions[0].status, "confirmed");
        assert.ok(context.sourceRefs.some((ref) => ref.type === "quick_record" && ref.id === "model-record"));
        assert.doesNotMatch(JSON.stringify(context), /模型上下文不应包含这段原始正文/);
        return { source: "deepseek", headline: "模型补充了下一步判断。", facts: [], inferences: [], unknowns: [], risks: [], nextActions: [] };
      },
    });
    const result = await worker.runOnce({ force: true });
    assert.equal(result.status, "success");
    assert.equal(calls, 1);
    const item = worker.suggestionRepository.get("proactive-model", { owner: "owner-a" });
    assert.equal(item.source, "model");
    assert.equal(item.modelProvider, "deepseek");
    assert.equal(item.modelName, "deepseek-v4-flash");
    assert.equal(item.fallbackReason, null);
    db.close();
  });

  it("assembles owner-scoped action, risk, visit, tender, and knowledge context for model analysis", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, { id: "op-context", name: "多源上下文项目" });
    db.prepare(`
      INSERT INTO action_items (id, customer_id, opportunity_id, owner, title, status, due)
      VALUES ('context-action', 'owner-a-customer', 'op-context', 'owner-a', '确认采购窗口', 'pending', '2026-09-08')
    `).run();
    db.prepare(`
      INSERT INTO risk_items (id, customer_id, opportunity_id, owner, title, target, severity, status, evidence, action)
      VALUES ('context-risk', 'owner-a-customer', 'op-context', 'owner-a', '预算待确认', '商机', '高', 'open', '已记录但未确认', '补充预算路径')
    `).run();
    db.prepare(`
      INSERT INTO visit_itineraries (
        id, title, visit_date, status, request_json, plan_json, created_by, updated_by, owner
      ) VALUES (
        'context-visit', '拜访共享客户', '2026-09-06', 'planned',
        '{"customerId":"owner-a-customer","opportunityId":"op-context"}', '{}', 'owner-a', 'owner-a', 'owner-a'
      )
    `).run();
    db.prepare(`
      INSERT INTO knowledge_items (id, title, category, summary, content, source, owner)
      VALUES ('context-knowledge', '医院采购节点', '销售', '采购节点核对清单', '完整正文不进入模型上下文', '内部知识库', 'owner-a')
    `).run();
    db.prepare(`
      INSERT INTO hospital_tender_notices (
        id, identity_key, source_id, source_name, title, url, published_at,
        notice_type, relevance, match_customer_ids_json, match_score, first_seen_at, last_seen_at
      ) VALUES (
        'context-tender', 'context-tender-key', 'context-source', '测试招标源',
        '共享客户采购公告', 'https://example.test/context-tender', '2026-09-05T11:00:00.000Z',
        'clarification', 'high', '["owner-a-customer"]', 90,
        '2026-09-05T11:00:00.000Z', '2026-09-05T11:00:00.000Z'
      )
    `).run();
    db.prepare("UPDATE opportunities SET version = 7, updated_at = '2026-09-05T11:01:00.000Z' WHERE id = 'op-context'").run();
    db.prepare("UPDATE action_items SET version = 3, updated_at = '2026-09-05T11:02:00.000Z' WHERE id = 'context-action'").run();
    db.prepare("UPDATE risk_items SET version = 4, updated_at = '2026-09-05T11:03:00.000Z' WHERE id = 'context-risk'").run();
    db.prepare("UPDATE visit_itineraries SET version = 5, updated_at = '2026-09-05T11:04:00.000Z' WHERE id = 'context-visit'").run();
    db.prepare("UPDATE knowledge_items SET version = 6, updated_at = '2026-09-05T11:05:00.000Z' WHERE id = 'context-knowledge'").run();
    db.prepare("UPDATE hospital_tender_notices SET content_sha256 = $digest WHERE id = 'context-tender'")
      .run({ $digest: 'b'.repeat(64) });
    let captured;
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-context",
      batchSize: 10,
      leaseMs: 1_000,
      retryBaseMs: 10,
      snapshotBuilder: () => ({
        items: [{
          ...makeSuggestion("proactive-context"),
          subjectId: "op-context",
          opportunityId: "op-context",
          customerId: "owner-a-customer",
          sourceRefs: [{ type: "opportunity", id: "op-context" }],
        }],
      }),
      modelProvider: "deepseek",
      modelName: "deepseek-v4-flash",
      modelTimeoutMs: 1_000,
      modelRetryLimit: 0,
      modelAnalyzer: async (context) => {
        captured = context;
        return { source: "deepseek", headline: "多源上下文分析完成。", facts: [], inferences: [], unknowns: [], risks: [], nextActions: [] };
      },
    });
    const result = await worker.runOnce({ force: true });
    assert.equal(result.status, "success");
    assert.deepEqual(captured.actions.map((item) => item.id), ["context-action"]);
    assert.deepEqual(captured.risks.map((item) => item.id), ["context-risk"]);
    assert.deepEqual(captured.itineraries.map((item) => item.id), ["context-visit"]);
    assert.deepEqual(captured.tenders.map((item) => item.id), ["context-tender"]);
    assert.deepEqual(captured.knowledge.map((item) => item.id), ["context-knowledge"]);
    assert.ok(captured.sourceRefs.some((ref) => ref.type === "action_item" && ref.id === "context-action"));
    assert.ok(captured.sourceRefs.some((ref) => ref.type === "risk_item" && ref.id === "context-risk"));
    assert.ok(captured.sourceRefs.some((ref) => ref.type === "visit_itinerary" && ref.id === "context-visit"));
    assert.ok(captured.sourceRefs.some((ref) => ref.type === "hospital_tender_notice" && ref.id === "context-tender"));
    assert.ok(captured.sourceRefs.some((ref) => ref.type === "knowledge" && ref.id === "context-knowledge"));
    assert.equal(captured.sourceRefs.find((ref) => ref.type === "opportunity" && ref.id === "op-context").version, 7);
    assert.equal(captured.sourceRefs.find((ref) => ref.type === "action_item" && ref.id === "context-action").version, 3);
    assert.equal(captured.sourceRefs.find((ref) => ref.type === "risk_item" && ref.id === "context-risk").updatedAt, "2026-09-05T11:03:00.000Z");
    assert.equal(captured.sourceRefs.find((ref) => ref.type === "visit_itinerary" && ref.id === "context-visit").visitDate, "2026-09-06");
    assert.equal(captured.sourceRefs.find((ref) => ref.type === "hospital_tender_notice" && ref.id === "context-tender").revision, 'b'.repeat(64));
    assert.equal(captured.sourceRefs.find((ref) => ref.type === "knowledge" && ref.id === "context-knowledge").version, 6);
    assert.equal(captured.sourceRefs.find((ref) => ref.type === "knowledge" && ref.id === "context-knowledge").updatedAt, "2026-09-05T11:05:00.000Z");
    assert.doesNotMatch(JSON.stringify(captured), /完整正文不进入模型上下文/);
    db.close();
  });

  it("keeps the rule result and exposes a bounded fallback reason when model analysis fails", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, { id: "op-model-fail", name: "模型失败项目" });
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-model-fail",
      leaseMs: 1_000,
      retryBaseMs: 10,
      snapshotBuilder: () => ({ items: [{ ...makeSuggestion("proactive-model-fail"), opportunityId: "op-model-fail", subjectId: "op-model-fail", customerId: "owner-a-customer" }] }),
      modelProvider: "deepseek",
      modelName: "deepseek-v4-flash",
      modelTimeoutMs: 1_000,
      modelRetryLimit: 0,
      modelAnalyzer: async () => { throw Object.assign(new Error("provider unavailable"), { code: "UPSTREAM_UNAVAILABLE" }); },
    });
    const result = await worker.runOnce({ force: true });
    assert.equal(result.status, "success");
    const item = worker.suggestionRepository.get("proactive-model-fail", { owner: "owner-a" });
    assert.equal(item.source, "deterministic");
    assert.equal(item.fallbackReason, "model_call_failed");
    assert.equal(item.modelAttempted, true);
    assert.equal(item.modelError, "provider unavailable");
    db.close();
  });

  it("reuses a durable model result across scans and workers, then refreshes after evidence/version or TTL changes", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, { id: "op-cache", name: "缓存项目" });
    let calls = 0;
    const analyzer = async () => {
      calls += 1;
      return { source: "deepseek", headline: `模型结果-${calls}`, facts: [], inferences: [], unknowns: [], risks: [], nextActions: [] };
    };
    const makeWorker = (workerId) => createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId,
      batchSize: 10,
      leaseMs: 1_000,
      retryBaseMs: 10,
      modelProvider: "deepseek",
      modelName: "deepseek-v4-flash",
      modelRetryLimit: 0,
      modelCacheTtlMs: 1_000,
      modelOwnerDailyLimit: 10,
      modelGlobalDailyLimit: 10,
      snapshotBuilder: () => ({
        items: [{
          ...makeSuggestion("proactive-cache"),
          subjectId: "op-cache",
          opportunityId: "op-cache",
          customerId: "owner-a-customer",
        }],
      }),
      modelAnalyzer: analyzer,
    });

    const firstWorker = makeWorker("worker-cache-one");
    const first = await firstWorker.runOnce({ force: true });
    assert.equal(first.status, "success");
    assert.equal(calls, 1);
    const cached = firstWorker.suggestionRepository.get("proactive-cache", { owner: "owner-a" });
    assert.equal(cached.source, "model");
    assert.equal(cached.modelCacheHit, false);
    assert.match(cached.modelEvidenceHash, /^[0-9a-f]{64}$/u);
    assert.match(cached.modelPayloadHash, /^[0-9a-f]{64}$/u);
    assert.equal(db.prepare("SELECT call_count FROM proactive_model_usage WHERE scope = 'owner' AND owner = 'owner-a'").get().call_count, 1);
    assert.equal(db.prepare("SELECT call_count FROM proactive_model_usage WHERE scope = 'global'").get().call_count, 1);

    const restarted = makeWorker("worker-cache-two");
    const second = await restarted.runOnce({ force: true });
    assert.equal(second.status, "success");
    assert.equal(calls, 1);
    const cacheHit = restarted.suggestionRepository.get("proactive-cache", { owner: "owner-a" });
    assert.equal(cacheHit.source, "model");
    assert.equal(cacheHit.modelCacheHit, true);
    assert.equal(db.prepare("SELECT call_count FROM proactive_model_usage WHERE scope = 'global'").get().call_count, 1);

    // A source/entity version change is part of the evidence digest and must
    // invalidate the prior model result even when the suggestion identity is
    // unchanged.
    db.prepare("UPDATE opportunities SET version = 2, updated_at = $updatedAt WHERE id = 'op-cache'")
      .run({ $updatedAt: "2026-09-05T12:00:01.000Z" });
    const changedEvidence = makeWorker("worker-cache-version");
    await changedEvidence.runOnce({ force: true });
    assert.equal(calls, 2);
    assert.equal(changedEvidence.suggestionRepository.get("proactive-cache", { owner: "owner-a" }).modelCacheHit, false);

    harness.advance(1_001);
    const expired = makeWorker("worker-cache-expired");
    await expired.runOnce({ force: true });
    assert.equal(calls, 3);
    assert.equal(expired.suggestionRepository.get("proactive-cache", { owner: "owner-a" }).modelCacheHit, false);
    assert.equal(db.prepare("SELECT call_count FROM proactive_model_usage WHERE scope = 'global'").get().call_count, 3);
    db.close();
  });

  it("enforces independent owner budgets and a shared global budget without cross-owner reuse", async () => {
    const db = database();
    const harness = clockHarness();
    insertOpportunity(db, { owner: "owner-a", id: "op-budget-a1", name: "预算项目 A1" });
    insertOpportunity(db, { owner: "owner-a", id: "op-budget-a2", name: "预算项目 A2" });
    insertOpportunity(db, { owner: "owner-b", id: "op-budget-b1", name: "预算项目 B1" });
    insertOpportunity(db, { owner: "owner-b", id: "op-budget-b2", name: "预算项目 B2" });
    const calls = [];
    const worker = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-budget",
      batchSize: 10,
      leaseMs: 1_000,
      retryBaseMs: 10,
      modelProvider: "deepseek",
      modelName: "deepseek-v4-flash",
      modelRetryLimit: 0,
      modelCacheTtlMs: 60_000,
      modelOwnerDailyLimit: 1,
      modelGlobalDailyLimit: 10,
      snapshotBuilder: ({ opportunities }) => ({
        items: opportunities.map((opportunity) => ({
          ...makeSuggestion(`proactive-${opportunity.id}`),
          subjectId: opportunity.id,
          opportunityId: opportunity.id,
          customerId: opportunity.customerId,
        })),
      }),
      modelAnalyzer: async (context) => {
        calls.push(context.opportunity.id);
        return { source: "deepseek", headline: `已分析 ${context.opportunity.id}`, facts: [], inferences: [], unknowns: [], risks: [], nextActions: [] };
      },
    });
    const first = await worker.runOnce({ force: true });
    assert.equal(first.status, "success");
    // One call is allowed for each owner; owner-a's second row must not use
    // owner-b's remaining allowance.
    assert.deepEqual(calls, ["op-budget-a1", "op-budget-b1"]);
    assert.equal(db.prepare("SELECT call_count FROM proactive_model_usage WHERE scope = 'owner' AND owner = 'owner-a'").get().call_count, 1);
    assert.equal(db.prepare("SELECT call_count FROM proactive_model_usage WHERE scope = 'owner' AND owner = 'owner-b'").get().call_count, 1);
    assert.equal(db.prepare("SELECT call_count FROM proactive_model_usage WHERE scope = 'global'").get().call_count, 2);
    assert.equal(worker.suggestionRepository.get("proactive-op-budget-a2", { owner: "owner-a" }).fallbackReason, "model_daily_limit");
    assert.equal(worker.suggestionRepository.get("proactive-op-budget-b2", { owner: "owner-b" }).fallbackReason, "model_daily_limit");
    assert.equal(worker.suggestionRepository.get("proactive-op-budget-b1", { owner: "owner-b" }).source, "model");

    // Restarting and rescanning reuses the two successful cache entries and
    // does not spend another call; quota state is read from SQLite.
    const restarted = createProactiveBackgroundWorker({
      db,
      clock: harness.now,
      workerId: "worker-budget-restarted",
      batchSize: 10,
      leaseMs: 1_000,
      retryBaseMs: 10,
      modelProvider: "deepseek",
      modelName: "deepseek-v4-flash",
      modelRetryLimit: 0,
      modelCacheTtlMs: 60_000,
      modelOwnerDailyLimit: 1,
      modelGlobalDailyLimit: 10,
      snapshotBuilder: ({ opportunities }) => ({
        items: opportunities.map((opportunity) => ({
          ...makeSuggestion(`proactive-${opportunity.id}`),
          subjectId: opportunity.id,
          opportunityId: opportunity.id,
          customerId: opportunity.customerId,
        })),
      }),
      modelAnalyzer: async (context) => {
        calls.push(context.opportunity.id);
        return { source: "deepseek", headline: "不应被调用", facts: [], inferences: [], unknowns: [], risks: [], nextActions: [] };
      },
    });
    await restarted.runOnce({ force: true });
    assert.deepEqual(calls, ["op-budget-a1", "op-budget-b1"]);
    assert.equal(db.prepare("SELECT call_count FROM proactive_model_usage WHERE scope = 'global'").get().call_count, 2);
    db.close();
  });
});
