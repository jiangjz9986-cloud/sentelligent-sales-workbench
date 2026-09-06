import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  VisitTemperatureSuggestionError,
  createVisitTemperatureSuggestionService,
} from "../src/assistant/visitTemperatureSuggestion.js";

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function errorCode(code) {
  return (error) => error instanceof VisitTemperatureSuggestionError && error.code === code;
}

function createHarness({
  generated = {
    suggestedValue: 68,
    confidence: 84,
    inferences: [{
      claim: "客户明确同意安排下一次技术交流，关系温度可以谨慎上调。",
      basisKeys: ["customer_feedback", "next_meeting"],
      confidence: 82,
    }],
  },
  ttlMs = 60_000,
} = {}) {
  let now = new Date("2026-08-31T04:00:00.000Z");
  let idSequence = 0;
  const counters = {
    generatorCalls: 0,
    customerWrites: 0,
    suggestionCreates: 0,
    suggestionConfirms: 0,
    suggestionCancels: 0,
    suggestionReads: 0,
    suggestionLists: 0,
  };
  const visits = new Map([
    ["visit-a", {
      id: "visit-a",
      owner: "owner-a",
      status: "confirmed",
      version: 4,
      customerId: "customer-a",
      occurredAt: "2026-08-30T02:00:00.000Z",
      confirmedAt: "2026-08-30T03:00:00.000Z",
      evidence: [
        {
          key: "customer_feedback",
          label: "客户反馈",
          value: "认可试点范围，希望补充实施排期。",
          sourceType: "quick_record",
          sourceId: "visit-a",
          confidence: 100,
        },
        {
          key: "next_meeting",
          label: "下一次沟通",
          value: "下周安排技术交流。",
          sourceRef: { type: "quick_record_insight", id: "insight-a" },
          confidence: 90,
        },
      ],
    }],
    ["visit-b", {
      id: "visit-b",
      owner: "owner-a",
      status: "confirmed",
      version: 1,
      customerId: "customer-a",
      occurredAt: "2026-08-29T02:00:00.000Z",
      confirmedAt: "2026-08-29T03:00:00.000Z",
      evidence: [{
        key: "visit_note",
        label: "拜访记录",
        value: "客户希望后续再沟通。",
        sourceType: "quick_record",
        sourceId: "visit-b",
        confidence: 100,
      }],
    }],
    ["visit-unconfirmed", {
      id: "visit-unconfirmed",
      owner: "owner-a",
      status: "analyzed",
      version: 1,
      customerId: "customer-a",
      evidence: [{
        key: "draft",
        label: "草稿",
        value: "尚未确认。",
        sourceType: "quick_record",
        sourceId: "visit-unconfirmed",
      }],
    }],
  ]);
  const customers = new Map([
    ["customer-a", {
      id: "customer-a",
      owner: "owner-a",
      version: 7,
      relation: 42,
      name: "示例医院",
      updatedAt: "2026-08-30T03:00:00.000Z",
    }],
    ["customer-b", {
      id: "customer-b",
      owner: "owner-b",
      version: 2,
      relation: 30,
      name: "其他医院",
    }],
  ]);
  const suggestions = new Map();
  let failMarkConfirmed = false;

  const visitRepository = {
    getConfirmed({ owner, visitId }) {
      const item = visits.get(visitId);
      return item?.owner === owner ? clone(item) : null;
    },
  };

  const customerRepository = {
    getActive({ owner, customerId }) {
      const item = customers.get(customerId);
      return item?.owner === owner ? clone(item) : null;
    },
    updateRelation({ owner, customerId, expectedVersion, expectedRelation, relation, suggestionId }) {
      const item = customers.get(customerId);
      if (!item || item.owner !== owner) return { notFound: true };
      if (item.version !== expectedVersion || item.relation !== expectedRelation) {
        return { conflict: true, current: clone(item) };
      }
      counters.customerWrites += 1;
      const updated = {
        ...item,
        relation,
        version: item.version + 1,
        temperatureSuggestionId: suggestionId,
      };
      customers.set(customerId, updated);
      return { item: clone(updated) };
    },
  };

  const suggestionRepository = {
    findByVisit({ owner, visitId }) {
      const item = [...suggestions.values()].find((candidate) => (
        candidate.owner === owner && candidate.visitId === visitId
      ));
      return item ? clone(item) : null;
    },
    create(item) {
      const existing = [...suggestions.values()].find((candidate) => (
        candidate.owner === item.owner && candidate.visitId === item.visitId
      ));
      if (existing) return { item: clone(existing), replayed: true };
      counters.suggestionCreates += 1;
      suggestions.set(item.id, clone(item));
      return { item: clone(item), replayed: false };
    },
    get({ owner, suggestionId }) {
      counters.suggestionReads += 1;
      const item = suggestions.get(suggestionId);
      return item?.owner === owner ? clone(item) : null;
    },
    list({ owner, customerId = null, limit }) {
      counters.suggestionLists += 1;
      return [...suggestions.values()]
        .filter((item) => item.owner === owner && (!customerId || item.customerId === customerId))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
        .slice(0, limit)
        .map(clone);
    },
    markConfirmed({ owner, suggestionId, identity, confirmedAt, customerVersion, relation }) {
      if (failMarkConfirmed) throw new Error("injected markConfirmed failure");
      const item = suggestions.get(suggestionId);
      if (!item || item.owner !== owner || item.identity !== identity || item.status !== "pending") {
        return null;
      }
      counters.suggestionConfirms += 1;
      const updated = {
        ...item,
        status: "confirmed",
        confirmedAt,
        confirmedCustomerVersion: customerVersion,
        confirmedRelation: relation,
      };
      suggestions.set(item.id, updated);
      return clone(updated);
    },
    markCancelled({ owner, suggestionId, identity, cancelledAt }) {
      const item = suggestions.get(suggestionId);
      if (!item || item.owner !== owner || item.identity !== identity || item.status !== "pending") {
        return null;
      }
      counters.suggestionCancels += 1;
      const updated = { ...item, status: "cancelled", cancelledAt };
      suggestions.set(item.id, updated);
      return clone(updated);
    },
  };

  const runInTransaction = (work) => {
    const customerSnapshot = clone([...customers.entries()]);
    const suggestionSnapshot = clone([...suggestions.entries()]);
    try {
      const result = work();
      assert.equal(result && typeof result.then, "undefined", "transaction work must stay synchronous");
      return result;
    } catch (error) {
      customers.clear();
      suggestions.clear();
      for (const [key, value] of customerSnapshot) customers.set(key, value);
      for (const [key, value] of suggestionSnapshot) suggestions.set(key, value);
      throw error;
    }
  };

  const suggestionGenerator = async (input) => {
    counters.generatorCalls += 1;
    assert.equal(input.owner, undefined);
    assert.equal(input.customer.owner, undefined);
    assert.equal(input.visit.owner, undefined);
    return clone(generated);
  };

  const service = createVisitTemperatureSuggestionService({
    visitRepository,
    customerRepository,
    suggestionRepository,
    suggestionGenerator,
    runInTransaction,
    idFactory: () => `temperature-suggestion-${++idSequence}`,
    clock: () => new Date(now),
    ttlMs,
  });

  return {
    service,
    counters,
    visits,
    customers,
    suggestions,
    advance(ms) { now = new Date(now.getTime() + ms); },
    setFailMarkConfirmed(value) { failMarkConfirmed = value; },
  };
}

describe("visit temperature suggestion core", () => {
  it("refuses to start without an injected transaction boundary", () => {
    const noop = () => null;
    assert.throws(() => createVisitTemperatureSuggestionService({
      visitRepository: { getConfirmed: noop },
      customerRepository: { getActive: noop, updateRelation: noop },
      suggestionRepository: {
        findByVisit: noop,
        create: noop,
        get: noop,
        list: noop,
        markConfirmed: noop,
        markCancelled: noop,
      },
      suggestionGenerator: async () => null,
    }), {
      name: "TypeError",
      message: "runInTransaction must be a function",
    });
  });

  it("creates a bounded evidence-backed preview without changing the customer", async () => {
    const harness = createHarness();
    const before = clone(harness.customers.get("customer-a"));

    const result = await harness.service.suggest({ owner: "owner-a", visitId: "visit-a" });

    assert.equal(result.schemaVersion, "visit-temperature-suggestion-v1");
    assert.equal(result.status, "pending");
    assert.equal(result.owner, "owner-a");
    assert.equal(result.visitId, "visit-a");
    assert.equal(result.customerId, "customer-a");
    assert.equal(result.customerVersion, 7);
    assert.equal(result.previousValue, 42);
    assert.equal(result.suggestedValue, 68);
    assert.equal(result.delta, 26);
    assert.equal(result.requiresHumanConfirmation, true);
    assert.equal(result.writebackAllowed, false);
    assert.match(result.identity, /^[0-9a-f]{64}$/u);
    assert.match(result.inputSnapshotHash, /^[0-9a-f]{64}$/u);
    assert.ok(result.facts.some((item) => item.key === "current_relation" && item.value === 42));
    assert.ok(result.facts.some((item) => item.key === "customer_feedback"));
    assert.ok(result.inferences[0].sourceRefs.some((item) => item.type === "quick_record" && item.id === "visit-a"));
    assert.deepEqual(harness.customers.get("customer-a"), before);
    assert.equal(harness.counters.customerWrites, 0);
    assert.equal(harness.counters.generatorCalls, 1);
    assert.equal(harness.counters.suggestionCreates, 1);
  });

  it("reuses one durable suggestion and keeps history read-only without recalling the generator", async () => {
    const harness = createHarness();
    const first = await harness.service.suggest({ owner: "owner-a", visitId: "visit-a" });
    const replay = await harness.service.suggest({ owner: "owner-a", visitId: "visit-a" });
    const beforeHistory = clone([...harness.suggestions.entries()]);
    const loaded = harness.service.get({ owner: "owner-a", suggestionId: first.id });
    const history = harness.service.history({ owner: "owner-a", customerId: "customer-a", limit: 20 });

    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    assert.equal(loaded.id, first.id);
    assert.deepEqual(history.items.map((item) => item.id), [first.id]);
    assert.equal(harness.counters.generatorCalls, 1);
    assert.equal(harness.counters.suggestionCreates, 1);
    assert.deepEqual([...harness.suggestions.entries()], beforeHistory);

    loaded.facts[0].value = "tampered";
    history.items[0].status = "tampered";
    assert.equal(harness.service.get({ owner: "owner-a", suggestionId: first.id }).facts[0].value, 42);
    assert.equal(harness.suggestions.get(first.id).status, "pending");
  });

  it("fails closed for unconfirmed, evidence-free, and cross-owner visits before generation", async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.service.suggest({ owner: "owner-a", visitId: "visit-unconfirmed" }),
      errorCode("VISIT_NOT_CONFIRMED"),
    );
    harness.visits.get("visit-b").evidence = [];
    await assert.rejects(
      harness.service.suggest({ owner: "owner-a", visitId: "visit-b" }),
      errorCode("VISIT_EVIDENCE_REQUIRED"),
    );
    await assert.rejects(
      harness.service.suggest({ owner: "owner-b", visitId: "visit-a" }),
      errorCode("NOT_FOUND"),
    );
    assert.equal(harness.counters.generatorCalls, 0);
    assert.equal(harness.counters.suggestionCreates, 0);
    assert.equal(harness.counters.customerWrites, 0);
  });

  it("requires an explicit confirm and updates once after revalidating every pinned field", async () => {
    const harness = createHarness();
    const suggestion = await harness.service.suggest({ owner: "owner-a", visitId: "visit-a" });
    const input = {
      owner: "owner-a",
      suggestionId: suggestion.id,
      suggestionIdentity: suggestion.identity,
      expectedCustomerVersion: suggestion.customerVersion,
      previousValue: suggestion.previousValue,
    };

    assert.throws(() => harness.service.confirm(input), errorCode("EXPLICIT_CONFIRMATION_REQUIRED"));
    assert.equal(harness.counters.customerWrites, 0);

    const confirmed = harness.service.confirm({ ...input, confirm: true });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.writeback, true);
    assert.equal(confirmed.replayed, false);
    assert.equal(confirmed.customer.relation, 68);
    assert.equal(confirmed.customer.version, 8);
    assert.equal(harness.counters.customerWrites, 1);
    assert.equal(harness.counters.suggestionConfirms, 1);

    const replay = harness.service.confirm({ ...input, confirm: true });
    assert.equal(replay.status, "confirmed");
    assert.equal(replay.replayed, true);
    assert.equal(replay.writeback, false);
    assert.equal(harness.counters.customerWrites, 1);
    assert.equal(harness.counters.suggestionConfirms, 1);
  });

  it("hides suggestions across owners and rejects a forged identity without any write", async () => {
    const harness = createHarness();
    const suggestion = await harness.service.suggest({ owner: "owner-a", visitId: "visit-a" });

    assert.throws(
      () => harness.service.get({ owner: "owner-b", suggestionId: suggestion.id }),
      errorCode("NOT_FOUND"),
    );
    assert.deepEqual(harness.service.history({ owner: "owner-b", limit: 20 }).items, []);
    assert.throws(() => harness.service.confirm({
      owner: "owner-b",
      suggestionId: suggestion.id,
      suggestionIdentity: suggestion.identity,
      expectedCustomerVersion: suggestion.customerVersion,
      previousValue: suggestion.previousValue,
      confirm: true,
    }), errorCode("NOT_FOUND"));
    assert.throws(() => harness.service.confirm({
      owner: "owner-a",
      suggestionId: suggestion.id,
      suggestionIdentity: "0".repeat(64),
      expectedCustomerVersion: suggestion.customerVersion,
      previousValue: suggestion.previousValue,
      confirm: true,
    }), errorCode("SUGGESTION_IDENTITY_MISMATCH"));
    assert.equal(harness.counters.customerWrites, 0);
    assert.equal(harness.counters.suggestionConfirms, 0);
  });

  it("rejects an unknown stored schema before it can participate in confirmation", async () => {
    const harness = createHarness();
    const suggestion = await harness.service.suggest({ owner: "owner-a", visitId: "visit-a" });
    harness.suggestions.get(suggestion.id).schemaVersion = "visit-temperature-suggestion-v999";

    assert.throws(() => harness.service.confirm({
      owner: "owner-a",
      suggestionId: suggestion.id,
      suggestionIdentity: suggestion.identity,
      expectedCustomerVersion: suggestion.customerVersion,
      previousValue: suggestion.previousValue,
      confirm: true,
    }), errorCode("SUGGESTION_DATA_INVALID"));
    assert.equal(harness.counters.customerWrites, 0);
    assert.equal(harness.counters.suggestionConfirms, 0);
  });

  it("returns a conflict and preserves newer customer or visit evidence", async () => {
    const harness = createHarness();
    const suggestion = await harness.service.suggest({ owner: "owner-a", visitId: "visit-a" });
    harness.customers.set("customer-a", {
      ...harness.customers.get("customer-a"),
      relation: 57,
      version: 8,
      name: "示例医院（新数据）",
    });

    const conflict = harness.service.confirm({
      owner: "owner-a",
      suggestionId: suggestion.id,
      suggestionIdentity: suggestion.identity,
      expectedCustomerVersion: suggestion.customerVersion,
      previousValue: suggestion.previousValue,
      confirm: true,
    });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.reason, "customer_changed");
    assert.equal(conflict.currentCustomer.relation, 57);
    assert.equal(conflict.currentCustomer.version, 8);
    assert.equal(harness.customers.get("customer-a").name, "示例医院（新数据）");
    assert.equal(harness.counters.customerWrites, 0);
    assert.equal(harness.counters.suggestionConfirms, 0);
    assert.equal(harness.suggestions.get(suggestion.id).status, "pending");

    harness.customers.set("customer-a", {
      ...harness.customers.get("customer-a"),
      relation: 42,
      version: 7,
    });
    harness.visits.get("visit-a").evidence[0].value = "客户后来修订了已保存证据。";
    const visitConflict = harness.service.confirm({
      owner: "owner-a",
      suggestionId: suggestion.id,
      suggestionIdentity: suggestion.identity,
      expectedCustomerVersion: suggestion.customerVersion,
      previousValue: suggestion.previousValue,
      confirm: true,
    });
    assert.equal(visitConflict.status, "conflict");
    assert.equal(visitConflict.reason, "visit_evidence_changed");
    assert.equal(harness.counters.customerWrites, 0);
    assert.equal(harness.counters.suggestionConfirms, 0);
  });

  it("cancels once and lets cancelled or expired confirmations finish without customer writes", async () => {
    const harness = createHarness();
    const cancelledSuggestion = await harness.service.suggest({ owner: "owner-a", visitId: "visit-a" });
    const cancelInput = {
      owner: "owner-a",
      suggestionId: cancelledSuggestion.id,
      suggestionIdentity: cancelledSuggestion.identity,
      cancel: true,
    };
    const cancelled = harness.service.cancel(cancelInput);
    const cancelReplay = harness.service.cancel(cancelInput);
    const confirmCancelled = harness.service.confirm({
      owner: "owner-a",
      suggestionId: cancelledSuggestion.id,
      suggestionIdentity: cancelledSuggestion.identity,
      expectedCustomerVersion: cancelledSuggestion.customerVersion,
      previousValue: cancelledSuggestion.previousValue,
      confirm: true,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelReplay.replayed, true);
    assert.equal(confirmCancelled.status, "cancelled");
    assert.equal(harness.counters.suggestionCancels, 1);
    assert.equal(harness.counters.customerWrites, 0);

    const expiringHarness = createHarness({
      generated: {
        suggestedValue: 43,
        confidence: 70,
        inferences: [{
          claim: "客户希望后续再沟通，关系温度暂时只做小幅调整。",
          basisKeys: ["visit_note"],
          confidence: 70,
        }],
      },
    });
    const expiring = await expiringHarness.service.suggest({ owner: "owner-a", visitId: "visit-b" });
    const stateBeforeExpiry = clone([...expiringHarness.suggestions.entries()]);
    expiringHarness.advance(60_001);
    const expired = expiringHarness.service.confirm({
      owner: "owner-a",
      suggestionId: expiring.id,
      suggestionIdentity: expiring.identity,
      expectedCustomerVersion: expiring.customerVersion,
      previousValue: expiring.previousValue,
      confirm: true,
    });
    assert.equal(expired.status, "expired");
    assert.equal(expired.writeback, false);
    assert.deepEqual([...expiringHarness.suggestions.entries()], stateBeforeExpiry);
    assert.equal(expiringHarness.counters.customerWrites, 0);
  });

  it("rolls back the customer update if confirmation persistence fails", async () => {
    const harness = createHarness();
    const suggestion = await harness.service.suggest({ owner: "owner-a", visitId: "visit-a" });
    const beforeCustomer = clone(harness.customers.get("customer-a"));
    harness.setFailMarkConfirmed(true);

    assert.throws(() => harness.service.confirm({
      owner: "owner-a",
      suggestionId: suggestion.id,
      suggestionIdentity: suggestion.identity,
      expectedCustomerVersion: suggestion.customerVersion,
      previousValue: suggestion.previousValue,
      confirm: true,
    }), /injected markConfirmed failure/u);

    assert.deepEqual(harness.customers.get("customer-a"), beforeCustomer);
    assert.equal(harness.suggestions.get(suggestion.id).status, "pending");
  });

  it("rejects out-of-range or ungrounded generator results without persisting a suggestion", async () => {
    const outOfRange = createHarness({ generated: { suggestedValue: 101, confidence: 50, inferences: [] } });
    await assert.rejects(
      outOfRange.service.suggest({ owner: "owner-a", visitId: "visit-a" }),
      errorCode("INVALID_GENERATED_SUGGESTION"),
    );
    assert.equal(outOfRange.counters.suggestionCreates, 0);
    assert.equal(outOfRange.counters.customerWrites, 0);

    const ungrounded = createHarness({
      generated: {
        suggestedValue: 60,
        confidence: 70,
        inferences: [{ claim: "没有事实依据的推断", basisKeys: ["missing_fact"], confidence: 70 }],
      },
    });
    await assert.rejects(
      ungrounded.service.suggest({ owner: "owner-a", visitId: "visit-a" }),
      errorCode("INVALID_GENERATED_SUGGESTION"),
    );
    assert.equal(ungrounded.counters.suggestionCreates, 0);
    assert.equal(ungrounded.counters.customerWrites, 0);
  });
});
