import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCustomerProactiveSubject,
  createCustomerProactiveSubjectService,
  customerSubjectKey,
  customerSubjectSourceDigest,
} from "../src/assistant/customerProactiveSubjectService.js";
import {
  buildProactiveAssistantSnapshot,
  proactiveConfirmationSnapshot,
} from "../src/assistant/proactiveAssistant.js";
import { openDatabase } from "../src/db.js";

const NOW_ISO = "2026-09-06T04:00:00.000Z";

function clockHarness(start = NOW_ISO) {
  let value = new Date(start);
  return {
    now: () => new Date(value),
    advance(ms) { value = new Date(value.getTime() + ms); },
  };
}

function database() {
  return openDatabase({ databaseUrl: ":memory:" });
}

function insertCustomer(db, {
  id = "customer-a",
  owner = "owner-a",
  name = "A 医院",
  version = 1,
  updatedAt = NOW_ISO,
} = {}) {
  db.prepare(`
    INSERT INTO customers (id, owner, name, version, created_at, updated_at)
    VALUES ($id, $owner, $name, $version, $updatedAt, $updatedAt)
  `).run({ $id: id, $owner: owner, $name: name, $version: version, $updatedAt: updatedAt });
}

function insertOpportunity(db, {
  id,
  owner = "owner-a",
  customerId = "customer-a",
  customerName = "A 医院",
  name = "医院项目",
  version = 1,
  stage = "调研机会",
  next = null,
  updatedAt = NOW_ISO,
} = {}) {
  db.prepare(`
    INSERT INTO opportunities (
      id, owner, customer_id, customer, name, version, stage, next,
      created_at, updated_at
    ) VALUES (
      $id, $owner, $customerId, $customerName, $name, $version, $stage, $next,
      $updatedAt, $updatedAt
    )
  `).run({
    $id: id,
    $owner: owner,
    $customerId: customerId,
    $customerName: customerName,
    $name: name,
    $version: version,
    $stage: stage,
    $next: next,
    $updatedAt: updatedAt,
  });
}

function opportunity(overrides = {}) {
  return {
    id: "op-a",
    owner: "owner-a",
    version: 1,
    customerId: "customer-a",
    customerName: "A 医院",
    customerVersion: 1,
    customerUpdatedAt: NOW_ISO,
    name: "A 医院双活项目",
    stage: "调研机会",
    next: null,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

describe("customer proactive subject aggregation", () => {
  it("aggregates multiple opportunities into one customer card while preserving legacy opportunity cards", () => {
    const opportunities = [
      opportunity({ id: "op-a", name: "双活项目" }),
      opportunity({ id: "op-b", name: "容灾项目", version: 2 }),
    ];
    const legacy = buildProactiveAssistantSnapshot({
      opportunities,
      now: new Date(NOW_ISO),
      includeExtendedSignals: false,
      includeAll: true,
    });
    assert.equal(legacy.items.filter((item) => item.trigger.type === "missing_next_step").length, 2);
    assert.equal(legacy.items.every((item) => item.subjectType === "opportunity"), true);

    const aggregated = buildCustomerProactiveSubject({
      owner: "owner-a",
      customer: {
        id: "customer-a",
        owner: "owner-a",
        name: "A 医院",
        version: 1,
        updatedAt: NOW_ISO,
      },
      opportunities,
      now: new Date(NOW_ISO),
      includeExtendedSignals: false,
    });
    assert.equal(aggregated.subject.identity, "customer:owner-a:customer-a");
    assert.equal(aggregated.subject.subjectType, "customer");
    assert.equal(aggregated.subject.suggestionCount, 1);
    assert.equal(aggregated.suggestions.length, 1);
    assert.equal(aggregated.snapshot.counts.total, 1);
    assert.equal(aggregated.snapshot.counts.missingNextStep, 1);
    const item = aggregated.suggestions[0];
    assert.equal(item.subjectType, "customer");
    assert.equal(item.subjectId, "customer-a");
    assert.deepEqual(item.contributingOpportunityIds, ["op-a", "op-b"]);
    assert.deepEqual(
      item.sourceRefs.filter((ref) => ref.type === "opportunity").map((ref) => ref.id),
      ["op-a", "op-b"],
    );
    assert.equal(item.writebackPreview.action.subjectKey, aggregated.subject.identity);
    assert.equal(item.writebackPreview.action.expectedSubjectVersion, 1);
    assert.equal(item.writebackPreview.action.expectedSourceDigest, aggregated.subject.sourceDigest);
    assert.match(item.previewDigests.action, /^[0-9a-f]{64}$/u);
  });

  it("hashes only canonical source references and provenance", () => {
    const refs = [
      { type: "customer", id: "customer-a", version: 1, updatedAt: NOW_ISO, label: "旧名称" },
      { type: "opportunity", id: "op-a", version: 3, updatedAt: NOW_ISO },
    ];
    const first = customerSubjectSourceDigest(refs);
    const telemetryOnly = customerSubjectSourceDigest([
      { ...refs[1], generatedAt: "2026-09-06T05:00:00.000Z", modelCacheHit: true, modelLatencyMs: 0 },
      { ...refs[0], label: "展示名称变化", detail: "展示详情变化" },
    ]);
    const sourceChanged = customerSubjectSourceDigest([
      refs[0],
      { ...refs[1], version: 4 },
    ]);
    assert.equal(telemetryOnly, first);
    assert.notEqual(sourceChanged, first);
  });
});

describe("customer proactive subject durable service", () => {
  it("keeps an unchanged scan on one revision and advances when source provenance changes", () => {
    const db = database();
    const clock = clockHarness();
    let idIndex = 0;
    insertCustomer(db);
    insertOpportunity(db, { id: "op-a", name: "双活项目" });
    insertOpportunity(db, { id: "op-b", name: "容灾项目" });
    const service = createCustomerProactiveSubjectService({
      db,
      clock: clock.now,
      idFactory: () => `customer-subject-${++idIndex}`,
    });

    const first = service.syncCustomer({
      owner: "owner-a",
      customerId: "customer-a",
      includeExtendedSignals: false,
    });
    assert.equal(first.subject.version, 1);
    assert.equal(first.subject.suggestionCount, 1);
    assert.equal(first.suggestions.length, 1);
    const firstId = first.suggestions[0].id;
    const firstDigest = first.subject.sourceDigest;
    const preview = service.previewContext({
      owner: "owner-a",
      customerId: "customer-a",
      suggestion: first.suggestions[0],
    });
    assert.equal(preview.expectedSubjectVersion, 1);
    assert.equal(preview.expectedSourceDigest, firstDigest);

    clock.advance(60_000);
    const replay = service.syncCustomer({
      owner: "owner-a",
      customerId: "customer-a",
      includeExtendedSignals: false,
    });
    assert.equal(replay.subject.version, 1);
    assert.equal(replay.subject.sourceDigest, firstDigest);
    assert.equal(replay.subject.updatedAt, first.subject.updatedAt);
    assert.equal(replay.suggestions[0].id, firstId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM proactive_subjects").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_suggestions WHERE proactive_subject_key IS NOT NULL").get().count, 1);

    db.prepare(`
      UPDATE opportunities
         SET version = 2, updated_at = '2026-09-06T04:02:00.000Z'
       WHERE id = 'op-b'
    `).run();
    clock.advance(60_000);
    const changed = service.syncCustomer({
      owner: "owner-a",
      customerId: "customer-a",
      includeExtendedSignals: false,
    });
    assert.equal(changed.subject.version, 2);
    assert.notEqual(changed.subject.sourceDigest, firstDigest);
    assert.equal(changed.suggestions[0].id, firstId);
    assert.equal(changed.subject.suggestionCount, 1);
    const row = db.prepare(`
      SELECT proactive_subject_key, proactive_subject_version, proactive_source_digest,
             proactive_source_refs
        FROM ai_suggestions
       WHERE id = $id
    `).get({ $id: firstId });
    assert.equal(row.proactive_subject_key, "customer:owner-a:customer-a");
    assert.equal(row.proactive_subject_version, 2);
    assert.equal(row.proactive_source_digest, changed.subject.sourceDigest);
    assert.deepEqual(JSON.parse(row.proactive_source_refs), changed.subject.sourceRefs);

    assert.throws(
      () => service.assertCurrentRevision({
        owner: "owner-a",
        customerId: "customer-a",
        expectedVersion: preview.expectedSubjectVersion,
        expectedSourceDigest: preview.expectedSourceDigest,
      }),
      (error) => error?.code === "PROACTIVE_SUBJECT_STALE" && error?.fields?.currentVersion === 2,
    );
    assert.equal(service.assertCurrentRevision({
      owner: "owner-a",
      customerId: "customer-a",
      expectedVersion: 2,
      expectedSourceDigest: changed.subject.sourceDigest,
    }).identity, changed.subject.identity);

    const confirmation = proactiveConfirmationSnapshot(changed.suggestions[0], "action");
    assert.equal(confirmation.subjectKey, changed.subject.identity);
    assert.equal(confirmation.subjectVersion, 2);
    assert.equal(confirmation.sourceDigest, changed.subject.sourceDigest);
    assert.deepEqual(confirmation.contributingOpportunityIds, ["op-a", "op-b"]);
    db.close();
  });

  it("isolates customer subjects and source rows by owner", () => {
    const db = database();
    insertCustomer(db, { id: "customer-a", owner: "owner-a", name: "A 医院" });
    insertOpportunity(db, { id: "op-a", owner: "owner-a", customerId: "customer-a", customerName: "A 医院" });
    insertCustomer(db, { id: "customer-b", owner: "owner-b", name: "B 医院" });
    insertOpportunity(db, { id: "op-b", owner: "owner-b", customerId: "customer-b", customerName: "B 医院" });
    const service = createCustomerProactiveSubjectService({ db, clock: () => new Date(NOW_ISO) });

    const subjectA = service.syncCustomer({
      owner: "owner-a",
      customerId: "customer-a",
      includeExtendedSignals: false,
    }).subject;
    const subjectB = service.syncCustomer({
      owner: "owner-b",
      customerId: "customer-b",
      includeExtendedSignals: false,
    }).subject;
    assert.equal(subjectA.identity, customerSubjectKey("owner-a", "customer-a"));
    assert.equal(subjectB.identity, customerSubjectKey("owner-b", "customer-b"));
    assert.notEqual(subjectA.identity, subjectB.identity);
    assert.deepEqual(service.listSubjects({ owner: "owner-a" }).map((item) => item.customerId), ["customer-a"]);
    assert.deepEqual(service.listSubjects({ owner: "owner-b" }).map((item) => item.customerId), ["customer-b"]);
    assert.equal(service.getSubject({ owner: "owner-a", customerId: "customer-b" }), null);
    assert.throws(
      () => service.syncCustomer({ owner: "owner-b", customerId: "customer-a", includeExtendedSignals: false }),
      (error) => error?.code === "PROACTIVE_CUSTOMER_NOT_FOUND",
    );
    assert.equal(
      subjectA.sourceRefs.some((ref) => ref.id === "customer-b" || ref.id === "op-b"),
      false,
    );
    db.close();
  });

  it("persists an empty customer subject without inventing a suggestion", () => {
    const db = database();
    const clock = clockHarness();
    insertCustomer(db, { id: "empty-customer", owner: "owner-a", name: "空客户" });
    const service = createCustomerProactiveSubjectService({ db, clock: clock.now });

    const first = service.syncCustomer({
      owner: "owner-a",
      customerId: "empty-customer",
      includeExtendedSignals: false,
    });
    assert.equal(first.subject.identity, "customer:owner-a:empty-customer");
    assert.equal(first.subject.version, 1);
    assert.equal(first.subject.suggestionCount, 0);
    assert.deepEqual(first.suggestions, []);
    assert.deepEqual(first.subject.sourceRefs.map((ref) => [ref.type, ref.id]), [["customer", "empty-customer"]]);

    clock.advance(60_000);
    const replay = service.syncCustomer({
      owner: "owner-a",
      customerId: "empty-customer",
      includeExtendedSignals: false,
    });
    assert.equal(replay.subject.version, 1);
    assert.equal(replay.subject.sourceDigest, first.subject.sourceDigest);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM proactive_subjects").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_suggestions WHERE proactive_subject_key IS NOT NULL").get().count, 0);
    db.close();
  });
});
