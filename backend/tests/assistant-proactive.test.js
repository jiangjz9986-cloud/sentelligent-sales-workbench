import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildProactiveAssistantSnapshot,
  createProactiveAssistantSnapshotFromDb,
} from "../src/assistant/proactiveAssistant.js";
import { openDatabase } from "../src/db.js";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function opportunity(overrides = {}) {
  return {
    id: "op-a",
    version: 3,
    customerId: "customer-a",
    customerName: "A 医院",
    name: "A 医院双活项目",
    stage: "调研机会",
    amount: "300 万",
    days: 5,
    next: "下周做机房调研",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("proactive assistant rules", () => {
  it("surfaces a missing-next-step signal without writing anything", () => {
    const result = buildProactiveAssistantSnapshot({
      opportunities: [opportunity({ next: "" })],
      actions: [],
      interactions: [{
        id: "record-recent",
        opportunityId: "op-a",
        occurredAt: "2026-09-03T10:00:00.000Z",
        sourceChannel: "电话",
      }],
      now: NOW,
    });
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.trigger.type, "missing_next_step");
    assert.match(item.conclusion, /没有记录下一步/);
    assert.equal(item.confirmationStatus, "not_started");
    assert.equal(item.writebackAllowed, false);
    assert.equal(item.writebackPreview.requiresHumanConfirmation, true);
    assert.equal(item.writebackPreview.automaticWriteAllowed, false);
    assert.ok(item.evidenceRefs.some((ref) => ref.type === "quick_record" && ref.id === "record-recent"));
  });

  it("detects stale opportunities and keeps the trigger id stable across refreshes", () => {
    const input = {
      opportunities: [opportunity()],
      actions: [{ id: "action-open", opportunityId: "op-a", title: "跟进", status: "pending" }],
      interactions: [{ id: "record-old", opportunityId: "op-a", occurredAt: "2026-08-01T10:00:00.000Z" }],
      now: NOW,
      staleDays: 21,
    };
    const first = buildProactiveAssistantSnapshot(input);
    const second = buildProactiveAssistantSnapshot(input);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].trigger.type, "stale_opportunity");
    assert.equal(first.items[0].id, second.items[0].id);
    assert.equal(first.counts.staleOpportunity, 1);
    assert.equal(first.items[0].writebackPreview.risk, null);
  });

  it("flags an advanced stage with no evidence and separates facts from inference", () => {
    const result = buildProactiveAssistantSnapshot({
      opportunities: [opportunity({ stage: "方案输出", days: 40 })],
      actions: [{ id: "action-open", opportunityId: "op-a", title: "输出方案", status: "pending" }],
      interactions: [],
      now: NOW,
    });
    // No interaction is an unknown baseline, not proof that the opportunity
    // exceeded the stale threshold; only the stage-evidence signal applies.
    assert.equal(result.items.length, 1);
    const mismatch = result.items.find((item) => item.trigger.type === "stage_evidence_mismatch");
    assert.ok(mismatch);
    assert.ok(mismatch.facts.some((item) => item.key === "opportunity.stage"));
    assert.ok(mismatch.inferences.some((item) => /重新核对/.test(item.claim)));
    assert.ok(mismatch.unknowns.length >= 1);
    assert.ok(mismatch.writebackPreview.risk);
  });

  it("bounds the result and never exposes raw interaction text", () => {
    const result = buildProactiveAssistantSnapshot({
      opportunities: Array.from({ length: 4 }, (_, index) => opportunity({
        id: `op-${index}`,
        customerId: `customer-${index}`,
        name: `项目-${index}`,
        next: "",
      })),
      interactions: [],
      limit: 2,
      now: NOW,
    });
    assert.equal(result.items.length, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.limit, 2);
    assert.doesNotMatch(JSON.stringify(result), /raw interaction body|原始拜访正文/);
  });

  it("connects budget, decision-chain, purchase-time, action, risk, visit, and tender signals", () => {
    const snapshot = buildProactiveAssistantSnapshot({
      opportunities: [opportunity({ next: null })],
      actions: [{ id: "action-due", opportunityId: "op-a", title: "补资料", status: "pending", due: "2026-09-04" }],
      interactions: [],
      risks: [{ id: "risk-open", opportunityId: "op-a", customerId: "customer-a", title: "预算风险", status: "open", severity: "high" }],
      itineraries: [{ id: "visit-a", opportunityId: "op-a", customerId: "customer-a", title: "客户拜访", visitDate: "2026-09-06", status: "planned" }],
      tenders: [{ id: "tender-a", customerId: "customer-a", title: "采购公告更正", noticeType: "clarification", publishedAt: "2026-09-05T10:00:00.000Z", sourceId: "source-a" }],
      now: NOW,
      includeExtendedSignals: true,
      includeAll: true,
    });
    const triggers = new Set(snapshot.items.map((item) => item.trigger.type));
    for (const trigger of ["budget_unknown", "decision_chain_unknown", "purchase_timing_unknown", "action_due", "risk_open", "visit_follow_up", "tender_change"]) {
      assert.equal(triggers.has(trigger), true, `missing ${trigger}`);
    }
    assert.equal(snapshot.items.every((item) => item.writebackPreview.automaticWriteAllowed === false), true);
  });

  it("persists source provenance for every extended signal and rotates identity when a source revision changes", () => {
    const sourceHash = "a".repeat(64);
    const input = {
      opportunities: [opportunity({
        next: null,
        version: 7,
        updatedAt: "2026-09-05T09:00:00.000Z",
        customerVersion: 4,
        customerUpdatedAt: "2026-09-05T08:00:00.000Z",
      })],
      actions: [{
        id: "action-due",
        opportunityId: "op-a",
        version: 3,
        title: "补资料",
        status: "pending",
        due: "2026-09-04",
        updatedAt: "2026-09-05T07:00:00.000Z",
      }],
      interactions: [{
        id: "record-old",
        opportunityId: "op-a",
        customerId: "customer-a",
        version: 2,
        occurredAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-02T10:00:00.000Z",
        status: "confirmed",
        voidedAt: null,
      }],
      risks: [{
        id: "risk-open",
        opportunityId: "op-a",
        customerId: "customer-a",
        version: 5,
        title: "预算风险",
        status: "open",
        severity: "high",
        updatedAt: "2026-09-05T06:00:00.000Z",
      }],
      itineraries: [{
        id: "visit-a",
        opportunityId: "op-a",
        customerId: "customer-a",
        version: 2,
        title: "客户拜访",
        visitDate: "2026-09-06",
        status: "planned",
        updatedAt: "2026-09-05T05:00:00.000Z",
      }],
      tenders: [{
        id: "tender-a",
        identityKey: "tender-identity-a",
        customerId: "customer-a",
        title: "采购公告更正",
        noticeType: "clarification",
        publishedAt: "2026-09-05T04:00:00.000Z",
        sourceId: "source-a",
        contentSha256: sourceHash,
      }],
      now: NOW,
      includeExtendedSignals: true,
      includeAll: true,
    };
    const first = buildProactiveAssistantSnapshot(input);
    const findRef = (trigger, type) => first.items.find((item) => item.trigger.type === trigger)
      ?.sourceRefs.find((ref) => ref.type === type);

    assert.deepEqual(
      findRef("stale_opportunity", "customer"),
      {
        type: "customer",
        id: "customer-a",
        label: "A 医院",
        version: 4,
        updatedAt: "2026-09-05T08:00:00.000Z",
      },
    );
    assert.deepEqual(
      findRef("stale_opportunity", "opportunity"),
      {
        type: "opportunity",
        id: "op-a",
        label: "A 医院双活项目",
        version: 7,
        updatedAt: "2026-09-05T09:00:00.000Z",
      },
    );
    assert.equal(findRef("stale_opportunity", "quick_record").version, 2);
    assert.equal(findRef("stale_opportunity", "quick_record").occurredAt, "2026-08-01T10:00:00.000Z");
    assert.equal(findRef("stale_opportunity", "quick_record").status, "confirmed");
    assert.equal(findRef("stale_opportunity", "quick_record").voidedAt, null);
    assert.equal(
      first.items.find((item) => item.trigger.type === "stale_opportunity")
        .inferences[0].sourceRefs.find((ref) => ref.type === "quick_record").version,
      2,
    );
    assert.equal(findRef("action_due", "action_item").version, 3);
    assert.equal(findRef("action_due", "action_item").updatedAt, "2026-09-05T07:00:00.000Z");
    assert.equal(findRef("risk_open", "risk_item").version, 5);
    assert.equal(findRef("risk_open", "risk_item").updatedAt, "2026-09-05T06:00:00.000Z");
    assert.equal(findRef("visit_follow_up", "visit_itinerary").version, 2);
    assert.equal(findRef("visit_follow_up", "visit_itinerary").visitDate, "2026-09-06");
    assert.equal(findRef("tender_change", "hospital_tender_notice").identityKey, "tender-identity-a");
    assert.equal(findRef("tender_change", "hospital_tender_notice").revision, sourceHash);
    assert.equal(findRef("tender_change", "hospital_tender_notice").publishedAt, "2026-09-05T04:00:00.000Z");
    assert.equal(findRef("tender_change", "hospital_tender_notice").noticeType, "clarification");

    const changedSource = buildProactiveAssistantSnapshot({
      ...input,
      interactions: [{ ...input.interactions[0], version: 3 }],
    });
    const firstStaleId = first.items.find((item) => item.trigger.type === "stale_opportunity").id;
    const changedStaleId = changedSource.items.find((item) => item.trigger.type === "stale_opportunity").id;
    assert.notEqual(changedStaleId, firstStaleId);
    assert.equal(
      changedSource.items.find((item) => item.trigger.type === "stale_opportunity")
        .sourceRefs.find((ref) => ref.type === "quick_record").version,
      3,
    );
  });
});

describe("proactive assistant database snapshot", () => {
  it("reads only the requested owner and ignores voided records", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    db.prepare("INSERT INTO customers (id, name, owner) VALUES ('customer-a', 'A 医院', 'owner-a')").run();
    db.prepare("INSERT INTO customers (id, name, owner) VALUES ('customer-b', 'B 医院', 'owner-b')").run();
    db.prepare(`
      INSERT INTO opportunities (id, customer_id, name, stage, owner, next)
      VALUES ('op-a', 'customer-a', 'A 项目', '方案输出', 'owner-a', NULL)
    `).run();
    db.prepare(`
      INSERT INTO opportunities (id, customer_id, name, stage, owner, next)
      VALUES ('op-b', 'customer-b', 'B 项目', '方案输出', 'owner-b', NULL)
    `).run();
    db.prepare(`
      INSERT INTO quick_records (id, owner, raw_content, occurred_at, customer_id, opportunity_id, status)
      VALUES ('record-a-voided', 'owner-a', '原始拜访正文', '2026-08-01T10:00:00Z', 'customer-a', 'op-a', 'recorded')
    `).run();
    db.prepare("UPDATE quick_records SET voided_at = '2026-08-02T00:00:00Z' WHERE id = 'record-a-voided'").run();
    db.prepare(`
      INSERT INTO action_items (id, opportunity_id, owner, title, status)
      VALUES ('action-a', 'op-a', 'owner-a', '联系客户', 'pending')
    `).run();

    const snapshot = createProactiveAssistantSnapshotFromDb({
      db,
      owner: "owner-a",
      now: NOW,
    });
    assert.ok(snapshot.items.length >= 1);
    assert.ok(snapshot.items.every((item) => item.customerId === "customer-a"));
    assert.doesNotMatch(JSON.stringify(snapshot), /原始拜访正文/);
    assert.ok(snapshot.items.every((item) => item.writebackAllowed === false));
    db.close();
  });
});
