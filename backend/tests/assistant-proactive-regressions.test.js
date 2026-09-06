import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildProactiveAssistantSnapshot,
  createProactiveAssistantSnapshotFromDb,
  findProactiveAssistantSuggestionFromDb,
} from "../src/assistant/proactiveAssistant.js";
import { openDatabase } from "../src/db.js";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function opportunity(overrides = {}) {
  return {
    id: "op-current",
    version: 1,
    customerId: "customer-a",
    customerName: "A 医院",
    name: "A 医院当前项目",
    stage: "调研机会",
    days: 3,
    createdAt: "2026-09-03T12:00:00.000Z",
    updatedAt: "2026-09-03T12:00:00.000Z",
    next: "下周确认需求",
    ...overrides,
  };
}

function staleItem(snapshot) {
  return snapshot.items.find((item) => item.trigger.type === "stale_opportunity");
}

describe("proactive assistant rule regressions", () => {
  it("does not call a newly-created opportunity stale when it has no interaction yet", () => {
    const result = buildProactiveAssistantSnapshot({
      opportunities: [opportunity({ next: "下周建立联系" })],
      interactions: [],
      now: NOW,
    });

    assert.equal(result.counts.staleOpportunity, 0);
    assert.equal(staleItem(result), undefined);
    assert.equal(result.items.length, 0);
  });

  it("does not let another opportunity's customer interaction hide current-opportunity stagnation", () => {
    const result = buildProactiveAssistantSnapshot({
      opportunities: [opportunity()],
      interactions: [
        {
          id: "record-current-old",
          opportunityId: "op-current",
          customerId: "customer-a",
          occurredAt: "2026-08-01T12:00:00.000Z",
        },
        {
          id: "record-other-recent",
          opportunityId: "op-other",
          customerId: "customer-a",
          occurredAt: "2026-09-04T12:00:00.000Z",
        },
      ],
      now: NOW,
    });

    const stale = staleItem(result);
    assert.ok(stale, "the old interaction for the current opportunity must remain stale");
    const interactionCount = stale.facts.find((item) => item.key === "interaction.count");
    assert.equal(interactionCount.value, 1);
    assert.deepEqual(
      stale.evidenceRefs.filter((ref) => ref.type === "quick_record").map((ref) => ref.id),
      ["record-current-old"],
    );
  });

  it("suppresses missing-next-step and stale reminders for terminal and lost opportunities", () => {
    for (const stage of ["丢单", "输单", "赢单", "已签约", "交付完成", "失败"]) {
      const result = buildProactiveAssistantSnapshot({
        opportunities: [opportunity({ id: `op-${stage}`, stage, next: "" })],
        interactions: [],
        now: NOW,
      });

      assert.equal(result.items.length, 0, `${stage} must leave routine proactive reminders`);
      assert.equal(result.counts.missingNextStep, 0, `${stage} must not emit missing-next-step`);
      assert.equal(result.counts.staleOpportunity, 0, `${stage} must not emit stale`);
    }
  });

  it("uses the shared stage vocabulary and exposes an unknown stage as an explicit unknown", () => {
    const unknown = buildProactiveAssistantSnapshot({
      opportunities: [opportunity({ stage: "合同阶段", next: "下周确认" })],
      interactions: [],
      now: NOW,
    });
    const item = unknown.items.find((candidate) => candidate.opportunityId === "op-current");
    assert.ok(item);
    assert.ok(item.unknowns.some((entry) => entry.key === "opportunity.stage"));
    assert.match(item.conclusion, /阶段/);

    const knownAdvanced = buildProactiveAssistantSnapshot({
      opportunities: [opportunity({ stage: "预算确认", next: "下周确认" })],
      interactions: [],
      now: NOW,
    });
    assert.equal(
      knownAdvanced.items.filter((candidate) => candidate.trigger.type === "stage_evidence_mismatch").length,
      1,
    );
  });

  it("does not publish uncalibrated confidence percentages or a fixed default priority", () => {
    const result = buildProactiveAssistantSnapshot({
      opportunities: [opportunity({ next: "" })],
      interactions: [],
      now: NOW,
    });
    const item = result.items[0];
    assert.equal(item.confidence, null);
    assert.equal(item.confidenceCalibrated, false);
    assert.equal(item.priority, null);
    assert.equal(item.priorityCalibrated, false);
    assert.ok(item.inferences.every((inference) => !Object.hasOwn(inference, "confidence")));
  });

  it("keeps same-opportunity triggers adjacent when age and evidence tie", () => {
    const result = buildProactiveAssistantSnapshot({
      opportunities: [
        opportunity({ id: "op-current-a", stage: "方案输出", next: "" }),
        opportunity({ id: "op-current-b", stage: "方案输出", next: "" }),
      ],
      interactions: [],
      now: NOW,
    });
    assert.equal(result.items.length, 4);
    const grouped = result.items.map((item) => `${item.opportunityId}:${item.trigger.type}`);
    assert.equal(grouped[0].split(":", 1)[0], grouped[1].split(":", 1)[0]);
    assert.equal(grouped[2].split(":", 1)[0], grouped[3].split(":", 1)[0]);
    assert.deepEqual(
      grouped.filter((value) => value.startsWith("op-current-a:")),
      ["op-current-a:missing_next_step", "op-current-a:stage_evidence_mismatch"],
    );
  });
});

describe("proactive assistant complete lookup", () => {
  it("finds a valid suggestion beyond the default page without changing the bounded list response", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      db.prepare("INSERT INTO customers (id, name, owner) VALUES ($id, $name, $owner)").run({
        $id: "customer-page",
        $name: "分页医院",
        $owner: "owner-page",
      });
      const insert = db.prepare(`
        INSERT INTO opportunities (
          id, customer_id, name, stage, owner, next, created_at, updated_at
        ) VALUES ($id, 'customer-page', $name, '调研机会', 'owner-page', NULL, $createdAt, $updatedAt)
      `);
      for (let index = 0; index < 60; index += 1) {
        const id = `op-page-${String(index).padStart(2, "0")}`;
        insert.run({
          $id: id,
          $name: `分页项目 ${index}`,
          $createdAt: "2026-09-04T12:00:00.000Z",
          $updatedAt: "2026-09-04T12:00:00.000Z",
        });
      }

      const bounded = createProactiveAssistantSnapshotFromDb({
        db,
        owner: "owner-page",
        now: NOW,
      });
      assert.equal(bounded.items.length, 50);
      assert.equal(bounded.truncated, true);
      assert.equal(bounded.counts.missingNextStep, 60);

      const complete = createProactiveAssistantSnapshotFromDb({
        db,
        owner: "owner-page",
        now: NOW,
        limit: 100,
      });
      const expected = complete.items.at(-1).id;
      assert.equal(bounded.items.some((item) => item.id === expected), false);
      const target = findProactiveAssistantSuggestionFromDb({
        db,
        owner: "owner-page",
        suggestionId: expected,
        now: NOW,
      });
      assert.equal(target?.id, expected);
    } finally {
      db.close();
    }
  });
});
