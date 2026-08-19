import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createSalesLoopContextRepository } from "../src/assistant/salesLoopContextRepository.js";

function createFixture(options = {}) {
  const db = openDatabase({ databaseUrl: ":memory:" });
  const repository = createSalesLoopContextRepository(db, {
    idFactory: () => options.id ?? "context-1",
    clock: () => new Date("2026-08-20T10:00:00.000Z"),
    ...options,
  });
  return { db, repository };
}

describe("sales loop context repository", () => {
  it("persists owner/channel/conversation-scoped entity context without storing the raw conversation id", () => {
    const { db, repository } = createFixture();
    const created = repository.set({
      owner: "owner-a",
      channel: "desktop",
      conversationId: "conversation-a",
      customerId: "customer-a",
      opportunityId: "opportunity-a",
      source: "verified_entity",
      sourceRefs: [
        { type: "customer", id: "customer-a" },
        { type: "opportunity", id: "opportunity-a" },
      ],
      requestId: "request-a",
    });
    assert.equal(created.changed, true);
    assert.equal(created.item.version, 1);
    assert.equal(created.item.customerId, "customer-a");
    assert.equal(created.item.conversationIdHash.length, 64);
    assert.notEqual(created.item.conversationIdHash, "conversation-a");
    assert.deepEqual(repository.get({ owner: "owner-a", channel: "desktop", conversationId: "conversation-a" }), created.item);
    assert.equal(repository.get({ owner: "owner-b", channel: "desktop", conversationId: "conversation-a" }), null);
    const row = db.prepare("SELECT * FROM assistant_business_contexts").get();
    assert.equal(row.conversation_id_hash.includes("conversation-a"), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers").get().count, 0);
    const audit = db.prepare("SELECT action, entity_type, request_id FROM audit_logs").all()
      .map((row) => ({ ...row }));
    assert.deepEqual(audit, [{
      action: "assistant_business_context.create",
      entity_type: "assistant_business_context",
      request_id: "request-a",
    }]);
    db.close();
  });

  it("is idempotent for the same context and increments version for a deliberate change", () => {
    const { db, repository } = createFixture();
    const input = {
      owner: "owner-a",
      channel: "desktop",
      conversationId: "conversation-a",
      customerId: "customer-a",
      opportunityId: "opportunity-a",
      source: "user_selection",
    };
    const first = repository.set(input);
    const replay = repository.set(input);
    assert.equal(replay.changed, false);
    assert.equal(replay.item.version, 1);
    const changed = repository.set({ ...input, customerId: "customer-b", expectedVersion: 1 });
    assert.equal(changed.changed, true);
    assert.equal(changed.item.version, 2);
    assert.throws(
      () => repository.set({ ...input, customerId: "customer-c", expectedVersion: 1 }),
      (error) => error?.code === "ASSISTANT_CONTEXT_VERSION_CONFLICT",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count, 2);
    db.close();
  });

  it("validates owner-scoped entity visibility and customer/opportunity relationships", () => {
    const { db } = createFixture({
      resolveEntities: ({ owner, customerId, opportunityId }) => {
        if (owner !== "owner-a") return { customer: null, opportunity: null };
        return {
          customer: customerId === "customer-a" ? { id: "customer-a" } : null,
          opportunity: opportunityId === "opportunity-a" ? { id: "opportunity-a", customerId: "customer-a" } : null,
        };
      },
    });
    const repository = createSalesLoopContextRepository(db, {
      resolveEntities: ({ owner, customerId, opportunityId }) => {
        if (owner !== "owner-a") return { customer: null, opportunity: null };
        return {
          customer: customerId === "customer-a" ? { id: "customer-a" } : null,
          opportunity: opportunityId === "opportunity-a" ? { id: "opportunity-a", customerId: "customer-a" } : null,
        };
      },
      idFactory: () => "context-relation",
      clock: () => new Date("2026-08-20T10:00:00.000Z"),
    });
    assert.throws(
      () => repository.set({ owner: "owner-b", channel: "desktop", conversationId: "c", customerId: "customer-a" }),
      /not visible/,
    );
    assert.throws(
      () => repository.set({ owner: "owner-a", channel: "desktop", conversationId: "c", customerId: "customer-a", opportunityId: "opportunity-b" }),
      /not visible/,
    );
    assert.throws(
      () => repository.set({
        owner: "owner-a", channel: "desktop", conversationId: "c", customerId: "customer-a", opportunityId: "opportunity-a",
        sourceRefs: [{ type: "x", id: "synthetic:forged" }],
      }),
      /safe identifier/,
    );
    const valid = repository.set({
      owner: "owner-a", channel: "desktop", conversationId: "c", customerId: "customer-a", opportunityId: "opportunity-a",
    });
    assert.equal(valid.item.opportunityId, "opportunity-a");
    db.close();
  });

  it("rejects relationship conflicts and caller-controlled secret-shaped fields", () => {
    const { db, repository } = createFixture({
      resolveEntities: () => ({
        customer: { id: "customer-a" },
        opportunity: { id: "opportunity-a", customerId: "customer-b" },
      }),
    });
    assert.throws(
      () => repository.set({
        owner: "owner-a", channel: "desktop", conversationId: "c", customerId: "customer-a", opportunityId: "opportunity-a",
      }),
      /relationship/,
    );
    assert.throws(
      () => repository.set({
        owner: "owner-a", channel: "desktop", conversationId: "c", customerId: "customer-a", token: "secret",
      }),
      /unsupported business context field/,
    );
    db.close();
  });

  it("clears context while retaining an auditable versioned record", () => {
    const { db, repository } = createFixture();
    const first = repository.set({
      owner: "owner-a", channel: "desktop", conversationId: "c", customerId: "customer-a", source: "user_selection",
    });
    const cleared = repository.clear({
      owner: "owner-a", channel: "desktop", conversationId: "c", expectedVersion: first.item.version, requestId: "clear-a",
    });
    assert.equal(cleared.item.customerId, null);
    assert.equal(cleared.item.opportunityId, null);
    assert.equal(cleared.item.version, 2);
    assert.equal(cleared.item.source, "system");
    assert.equal(repository.get({ owner: "owner-a", channel: "desktop", conversationId: "c" }).customerId, null);
    db.close();
  });
});
