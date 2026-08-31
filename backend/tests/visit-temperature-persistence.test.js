import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { withImmediateTransaction } from "../src/db/transaction.js";
import { createVisitTemperatureSuggestionService } from "../src/assistant/visitTemperatureSuggestion.js";
import { createVisitTemperatureSuggestionRepositories } from "../src/assistant/visitTemperatureSuggestionRepository.js";

let db;
let repositories;
let now;

function seedCustomer(id, owner, relation = 42) {
  db.prepare(`
    INSERT INTO customers (id, name, owner, relation, version)
    VALUES ($id, $name, $owner, $relation, 1)
  `).run({ $id: id, $name: `${id}医院`, $owner: owner, $relation: relation });
}

function seedVisit({ id, owner, customerId, status = "confirmed", content = "客户认可试点范围并约定下次沟通。" }) {
  db.prepare(`
    INSERT INTO quick_records (
      id, owner, raw_content, occurred_at, customer_id, status, version, created_at, updated_at
    ) VALUES (
      $id, $owner, $content, '2026-08-30T02:00:00.000Z', $customerId, $status, 3,
      '2026-08-30T03:00:00.000Z', '2026-08-30T03:00:00.000Z'
    )
  `).run({ $id: id, $owner: owner, $content: content, $customerId: customerId, $status: status });
  db.prepare(`
    INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json, created_at)
    VALUES ($id, $visitId, 'mock', 88, $analysis, '2026-08-30T03:00:00.000Z')
  `).run({
    $id: `insight-${id}`,
    $visitId: id,
    $analysis: JSON.stringify({
      confidence: 88,
      evidence: [{
        key: "customer_feedback",
        label: "客户反馈",
        value: "认可试点范围，希望补充实施排期。",
        sourceType: "quick_record",
        sourceId: id,
        confidence: 100,
      }],
      summary: {
        action: { title: "建议动作", text: "下周安排技术交流。" },
      },
    }),
  });
  db.prepare(`
    INSERT INTO manual_confirmations (id, quick_record_id, target, confirmed_by, created_at)
    VALUES ($id, $visitId, 'customer', $owner, '2026-08-30T03:30:00.000Z')
  `).run({ $id: `confirmation-${id}`, $visitId: id, $owner: owner });
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  now = new Date("2026-08-31T04:00:00.000Z");
  seedCustomer("customer-a", "owner-a", 42);
  seedCustomer("customer-b", "owner-b", 31);
  seedVisit({ id: "visit-a", owner: "owner-a", customerId: "customer-a" });
  seedVisit({ id: "visit-b", owner: "owner-b", customerId: "customer-b" });
  seedVisit({ id: "visit-draft", owner: "owner-a", customerId: "customer-a", status: "analyzed" });
  repositories = createVisitTemperatureSuggestionRepositories(db, {
    idFactory: () => "unused",
    clock: () => new Date(now),
  });
});

afterEach(() => db.close());

describe("visit temperature SQLite persistence", () => {
  it("applies migration 0035 with owner/visit uniqueness and lifecycle constraints", () => {
    const columns = db.prepare("PRAGMA table_info(visit_temperature_suggestions)").all().map((row) => row.name);
    assert.deepEqual(columns, [
      "id", "schema_version", "owner", "visit_id", "visit_version", "customer_id",
      "customer_version", "previous_value", "suggested_value", "delta", "confidence", "status",
      "identity", "visit_evidence_hash", "input_snapshot_hash", "facts_json", "inferences_json",
      "source_refs_json", "requires_human_confirmation", "writeback_allowed", "created_at", "expires_at",
      "confirmed_at", "cancelled_at", "confirmed_customer_version", "confirmed_relation",
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '0035'").get().count, 1);
    assert.throws(() => db.prepare(`
      INSERT INTO visit_temperature_suggestions (
        id, schema_version, owner, visit_id, visit_version, customer_id, customer_version,
        previous_value, suggested_value, delta, confidence, status, identity,
        visit_evidence_hash, input_snapshot_hash, facts_json, inferences_json, source_refs_json,
        created_at, expires_at
      ) VALUES ('bad', 'visit-temperature-suggestion-v1', 'owner-a', 'visit-a', 3, 'customer-a', 1,
        42, 68, 26, 80, 'pending', 'identity', 'hash', 'hash', '[]', '[]', '[]',
        '2026-08-31T04:00:00.000Z', '2026-09-01T04:00:00.000Z')
    `).run(), /CHECK constraint failed|UNIQUE constraint failed/u);
  });

  it("reads only confirmed visits and materializes saved evidence with a confirmation timestamp", () => {
    const visit = repositories.visitRepository.getConfirmed({ owner: "owner-a", visitId: "visit-a" });
    assert.equal(visit.id, "visit-a");
    assert.equal(visit.version, 3);
    assert.equal(visit.customerId, "customer-a");
    assert.equal(visit.confirmedAt, "2026-08-30T03:30:00.000Z");
    assert.ok(visit.evidence.some((item) => item.key === "customer_feedback"));
    assert.equal(repositories.visitRepository.getConfirmed({ owner: "owner-a", visitId: "visit-draft" }), null);
    assert.equal(repositories.visitRepository.getConfirmed({ owner: "owner-b", visitId: "visit-a" }), null);
  });

  it("keeps customer reads and relation writes owner-scoped, versioned, and audited", () => {
    assert.equal(repositories.customerRepository.getActive({ owner: "owner-b", customerId: "customer-a" }), null);
    const updated = repositories.customerRepository.updateRelation({
      owner: "owner-a",
      customerId: "customer-a",
      expectedVersion: 1,
      expectedRelation: 42,
      relation: 68,
      suggestionId: "suggestion-a",
    });
    assert.equal(updated.item.relation, 68);
    assert.equal(updated.item.version, 2);
    assert.deepEqual(repositories.customerRepository.updateRelation({
      owner: "owner-a",
      customerId: "customer-a",
      expectedVersion: 1,
      expectedRelation: 42,
      relation: 72,
      suggestionId: "suggestion-stale",
    }), { conflict: true, current: updated.item });
    const audit = db.prepare(`
      SELECT action, entity_type, entity_id, actor, entity_version, before_json, after_json, metadata_json
      FROM audit_logs WHERE action = 'customer.relation.update'
    `).get();
    assert.equal(audit.action, "customer.relation.update");
    assert.equal(audit.entity_type, "customer");
    assert.equal(audit.entity_id, "customer-a");
    assert.equal(audit.actor, "owner-a");
    assert.equal(audit.entity_version, 2);
    assert.match(audit.before_json, /"relation":42/);
    assert.match(audit.after_json, /"relation":68/);
    assert.match(audit.metadata_json, /suggestion-a/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.relation.update'").get().count, 1);
  });

  it("round-trips a suggestion, isolates history, and atomically confirms relation plus suggestion", async () => {
    let calls = 0;
    const service = createVisitTemperatureSuggestionService({
      ...repositories,
      suggestionGenerator: async (input) => {
        calls += 1;
        assert.equal(input.customer.relation, 42);
        assert.equal(input.visit.evidence[0].sourceRefs[0].type, "quick_record");
        return {
          suggestedValue: 68,
          confidence: 84,
          inferences: [{
            claim: "客户愿意安排下一次技术交流。",
            basisKeys: ["customer_feedback"],
            confidence: 84,
          }],
        };
      },
      runInTransaction: (work) => withImmediateTransaction(db, work),
      idFactory: () => "suggestion-a",
      clock: () => new Date(now),
      ttlMs: 60_000,
    });
    const created = await service.suggest({ owner: "owner-a", visitId: "visit-a" });
    assert.equal(created.status, "pending");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM visit_temperature_suggestions").get().count, 1);
    const reloaded = repositories.suggestionRepository.get({ owner: "owner-a", suggestionId: created.id });
    assert.deepEqual({ ...reloaded, replayed: undefined }, { ...created, replayed: undefined });
    assert.equal(repositories.suggestionRepository.get({ owner: "owner-b", suggestionId: created.id }), null);
    const replay = await service.suggest({ owner: "owner-a", visitId: "visit-a" });
    assert.equal(replay.replayed, true);
    assert.equal(calls, 1);

    const confirmed = service.confirm({
      owner: "owner-a",
      suggestionId: created.id,
      suggestionIdentity: created.identity,
      expectedCustomerVersion: created.customerVersion,
      previousValue: created.previousValue,
      confirm: true,
    });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.customer.relation, 68);
    assert.equal(repositories.suggestionRepository.get({ owner: "owner-a", suggestionId: created.id }).status, "confirmed");
    assert.equal(db.prepare("SELECT relation, version FROM customers WHERE id = 'customer-a'").get().relation, 68);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.relation.update'").get().count, 1);
    assert.deepEqual(repositories.suggestionRepository.list({ owner: "owner-b", limit: 20 }).items, []);
  });

  it("rolls back customer relation and audit when suggestion state persistence fails", async () => {
    // The repository is intentionally frozen; use a proxy to inject the state failure
    // while retaining the real owner-scoped visit and customer repositories.
    const failingSuggestions = {
      ...repositories.suggestionRepository,
      markConfirmed: () => { throw new Error("injected state failure"); },
    };
    const service = createVisitTemperatureSuggestionService({
      visitRepository: repositories.visitRepository,
      customerRepository: repositories.customerRepository,
      suggestionRepository: failingSuggestions,
      suggestionGenerator: async () => ({
        suggestedValue: 68,
        confidence: 80,
        inferences: [{ claim: "x", basisKeys: ["customer_feedback"], confidence: 80 }],
      }),
      runInTransaction: (work) => withImmediateTransaction(db, work),
      idFactory: () => "suggestion-failure",
      clock: () => new Date(now),
      ttlMs: 60_000,
    });
    const suggestion = await service.suggest({ owner: "owner-a", visitId: "visit-a" });
    assert.throws(() => service.confirm({
      owner: "owner-a",
      suggestionId: suggestion.id,
      suggestionIdentity: suggestion.identity,
      expectedCustomerVersion: suggestion.customerVersion,
      previousValue: suggestion.previousValue,
      confirm: true,
    }), /injected state failure/);
    const restored = db.prepare("SELECT relation, version FROM customers WHERE id = 'customer-a'").get();
    assert.equal(restored.relation, 42);
    assert.equal(restored.version, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.relation.update'").get().count, 0);
    assert.equal(repositories.suggestionRepository.get({ owner: "owner-a", suggestionId: suggestion.id }).status, "pending");
  });
});
