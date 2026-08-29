import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import {
  createCustomerAssistantAdapter,
  createCustomerPendingPreviewProviders,
} from "../src/assistant/customerAssistantAdapter.js";

function snapshotAdapter() {
  return {
    customerDetail({ owner, customerId }) {
      if (owner !== "owner-1" || customerId !== "customer-1") return null;
      return {
        id: "customer-1",
        version: 3,
        name: "示例医院",
        region: "青岛",
        type: "医院",
        level: "重点",
        contact: "张主任",
        budget: "约300万",
        summary: "正推进十五五信息化规划",
        aliases: ["示例院区"],
        tags: ["十五五"],
        updatedAt: "2026-08-20T01:00:00Z",
      };
    },
    customerSearch({ owner, query }) {
      if (owner !== "owner-1") return { items: [] };
      if (query === "同名") return { items: [
        { id: "customer-a", name: "同名医院", region: "青岛", version: 1 },
        { id: "customer-b", name: "同名医院", region: "济南", version: 1 },
      ] };
      if (query.includes("示例医院")) return { items: [{ id: "customer-1", name: "示例医院", region: "青岛", type: "医院", level: "重点", version: 3, contact: "张主任", budget: "约300万", summary: "正推进十五五信息化规划", aliases: ["示例院区"], tags: ["十五五"] }] };
      return { items: [] };
    },
  };
}

describe("customer assistant adapter", () => {
  it("returns an owner-scoped detail with facts, unknowns, and a durable run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "customer-run-1" });
    const adapter = createCustomerAssistantAdapter({ snapshotAdapter: snapshotAdapter(), runRepository: runs });
    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-1",
      eventId: "event-1",
      taskType: "detail",
      customerId: "customer-1",
    });
    assert.equal(result.schemaVersion, "customer-v1");
    assert.equal(result.agentId, "customer");
    assert.equal(result.status, "ok");
    assert.equal(result.customer.name, "示例医院");
    assert.ok(result.facts.some((item) => item.key === "name"));
    assert.ok(result.unknowns.some((item) => item.key === "decision_chain"));
    assert.deepEqual(result.sourceRefs, [{ type: "customer", id: "customer-1" }]);
    assert.equal(result.writebackAllowed, false);
    assert.equal(result.writebackPreview.allowed, false);
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.source, "deterministic");
    assert.equal(stored.input.owner, undefined);
    db.close();
  });

  it("clarifies multiple matches and never selects a fuzzy customer", async () => {
    const adapter = createCustomerAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({ owner: "owner-1", taskType: "search", query: "同名" });
    assert.equal(result.status, "clarify");
    assert.equal(result.customer, null);
    assert.equal(result.matches.length, 2);
    assert.ok(result.unknowns.some((item) => item.key === "ambiguity"));
    assert.equal(result.sourceRefs.length, 2);
    assert.equal(result.truncated, false);
  });

  it("preserves a bounded source truncation marker", async () => {
    const source = snapshotAdapter();
    const adapter = createCustomerAssistantAdapter({
      snapshotAdapter: {
        ...source,
        customerSearch() {
          return {
            items: Array.from({ length: 100 }, (_, index) => ({
              id: `customer-${index}`,
              name: `客户 ${index}`,
            })),
            truncated: true,
          };
        },
      },
    });
    const result = await adapter.analyze({ owner: "owner-1", taskType: "search", query: "客户" });
    assert.equal(result.matches.length, 100);
    assert.equal(result.truncated, true);
  });

  it("creates a bounded change preview but cannot execute it", async () => {
    const adapter = createCustomerAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "change_preview",
      customerId: "customer-1",
      changes: { region: "济南", level: "普通", owner: "forged-owner", unknownField: "x" },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.changePreview.changedFields, ["region", "level"]);
    assert.deepEqual(result.changePreview.before, { region: "青岛", level: "重点" });
    assert.deepEqual(result.changePreview.after, { region: "济南", level: "普通" });
    assert.deepEqual(result.changePreview.rejectedFields, ["owner", "unknownField"]);
    assert.equal(result.changePreview.expectedVersion, 3);
    assert.equal(result.writebackPreview.requiresHumanConfirmation, true);
    assert.equal(result.writebackAllowed, false);
  });

  it("previews profile fields, array add/remove, and rejects structured fields", async () => {
    const adapter = createCustomerAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "change_preview",
      customerId: "customer-1",
      changes: {
        contact: "王科长",
        budget: "约500万",
        summary: "新阶段：信创集成",
        aliases: { add: ["示例人民医院"], remove: ["示例院区"] },
        tags: ["信创", "十五五"],
        stakeholders: [{ name: "张三" }],
        decisionChain: "不支持",
      },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.changePreview.changedFields, ["contact", "budget", "summary", "aliases", "tags"]);
    assert.deepEqual(result.changePreview.before.aliases, ["示例院区"]);
    assert.deepEqual(result.changePreview.after.aliases, ["示例人民医院"]);
    assert.deepEqual(result.changePreview.before.tags, ["十五五"]);
    assert.deepEqual(result.changePreview.after.tags, ["信创", "十五五"]);
    assert.equal(result.changePreview.before.contact, "张主任");
    assert.equal(result.changePreview.after.contact, "王科长");
    assert.deepEqual(result.changePreview.rejectedFields, ["stakeholders", "decisionChain"]);
    assert.equal(result.changePreview.expectedVersion, 3);
  });

  it("reports review_required when the requested change matches the snapshot", async () => {
    const adapter = createCustomerAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "change_preview",
      customerId: "customer-1",
      changes: { region: "青岛" },
    });
    assert.equal(result.status, "review_required");
    assert.deepEqual(result.changePreview.changedFields, []);
  });

  it("resolves delete_preview through the same clarify/not_found boundary", async () => {
    const adapter = createCustomerAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const resolved = await adapter.analyze({ owner: "owner-1", taskType: "delete_preview", customerId: "customer-1" });
    assert.equal(resolved.status, "ok");
    assert.equal(resolved.customer.version, 3);

    const ambiguous = await adapter.analyze({ owner: "owner-1", taskType: "delete_preview", query: "同名" });
    assert.equal(ambiguous.status, "clarify");
    assert.equal(ambiguous.matches.length, 2);

    const missing = await adapter.analyze({ owner: "owner-1", taskType: "delete_preview", query: "不存在医院" });
    assert.equal(missing.status, "not_found");
  });

  it("replays the same event without running the snapshot query twice", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "customer-run-replay" });
    let details = 0;
    const source = snapshotAdapter();
    const adapter = createCustomerAssistantAdapter({
      snapshotAdapter: {
        ...source,
        customerDetail(input) { details += 1; return source.customerDetail(input); },
      },
      runRepository: runs,
    });
    const input = { owner: "owner-1", channel: "desktop", conversationId: "conversation-replay", eventId: "event-replay", customerId: "customer-1" };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);
    assert.equal(details, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    db.close();
  });
});

describe("customer pending preview providers", () => {
  const context = Object.freeze({
    owner: "owner-1",
    channel: "weixin",
    conversation: "conversation-preview",
    event: "event-preview",
    requestId: "request-preview",
  });
  const directServerData = Object.freeze({ auditMetadata: { chatType: "direct", financialScope: false } });

  function makeProviders(db) {
    const adapter = createCustomerAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    return createCustomerPendingPreviewProviders({
      adapter,
      db,
      resolveBusinessOwner: (owner) => (owner === "owner-1" ? "owner-1" : null),
    });
  }

  it("blocks group chats and unbound owners before any preview", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const providers = makeProviders(db);
      const group = await providers["customer.create"]({
        arguments: { name: "新客户" },
        context,
        serverData: { auditMetadata: { chatType: "group" } },
      });
      assert.equal(group.block, true);
      assert.match(group.text, /私聊/);

      const unbound = await providers["customer.create"]({
        arguments: { name: "新客户" },
        context: { ...context, owner: "someone-else" },
        serverData: directServerData,
      });
      assert.equal(unbound.block, true);
      assert.match(unbound.text, /业务负责人/);
    } finally {
      db.close();
    }
  });

  it("previews a create, blocks duplicates, and normalizes stored arguments", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const providers = makeProviders(db);
      const preview = await providers["customer.create"]({
        arguments: { name: "莒县人民医院", region: "日照", tags: ["信创"] },
        context,
        serverData: directServerData,
      });
      assert.equal(preview.block, undefined);
      assert.deepEqual(preview.arguments, { name: "莒县人民医院", region: "日照", tags: ["信创"] });
      assert.match(preview.previewText, /【小小提醒！新建客户】/);
      assert.match(preview.previewText, /名称：莒县人民医院/);
      assert.doesNotMatch(preview.previewText, /\d{6}/);

      db.prepare(`
        INSERT INTO customers (id, name, owner) VALUES ('existing-1', '莒县人民医院', 'owner-1')
      `).run();
      const duplicate = await providers["customer.create"]({
        arguments: { name: "莒县人民医院" },
        context,
        serverData: directServerData,
      });
      assert.equal(duplicate.block, true);
      assert.match(duplicate.text, /已存在同名客户/);
      assert.match(duplicate.text, /existing-1/);
    } finally {
      db.close();
    }
  });

  it("previews an update with pinned version and only the changed fields", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const providers = makeProviders(db);
      const preview = await providers["customer.update"]({
        arguments: { query: "示例医院", changes: { level: "普通", region: "青岛", aliases: { add: ["示例人民医院"] } } },
        context,
        serverData: directServerData,
      });
      assert.equal(preview.block, undefined);
      assert.equal(preview.arguments.customerId, "customer-1");
      assert.equal(preview.arguments.expectedVersion, 3);
      assert.deepEqual(Object.keys(preview.arguments.changes).sort(), ["aliases", "level"]);
      assert.deepEqual(preview.arguments.changes.aliases, ["示例院区", "示例人民医院"]);
      assert.match(preview.previewText, /【小小提醒！修改客户】/);
      assert.match(preview.previewText, /名称：示例医院/);
      assert.match(preview.previewText, /级别：重点 → 普通/);
      assert.doesNotMatch(preview.previewText, /区域/);

      const noop = await providers["customer.update"]({
        arguments: { query: "示例医院", changes: { region: "青岛" } },
        context,
        serverData: directServerData,
      });
      assert.equal(noop.block, true);
      assert.match(noop.text, /内容与现有档案一致/);

      const rejectedOnly = await providers["customer.update"]({
        arguments: { query: "示例医院", changes: { stakeholders: ["张三"] } },
        context,
        serverData: directServerData,
      });
      assert.equal(rejectedOnly.block, true);
      assert.match(rejectedOnly.text, /暂不支持修改/);

      const ambiguous = await providers["customer.update"]({
        arguments: { query: "同名", changes: { level: "A" } },
        context,
        serverData: directServerData,
      });
      assert.equal(ambiguous.block, true);
      assert.match(ambiguous.text, /【找到多个客户】/);

      const missing = await providers["customer.update"]({
        arguments: { query: "不存在医院", changes: { level: "A" } },
        context,
        serverData: directServerData,
      });
      assert.equal(missing.block, true);
      assert.match(missing.text, /未找到客户：不存在医院/);
    } finally {
      db.close();
    }
  });

  it("previews a delete with the active opportunity warning", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      db.exec(`
        INSERT INTO customers (id, name, owner) VALUES ('customer-1', '示例医院', 'owner-1');
        INSERT INTO opportunities (id, customer_id, name, owner) VALUES ('opp-1', 'customer-1', '信息化一期', 'owner-1');
        INSERT INTO opportunities (id, customer_id, name, owner) VALUES ('opp-2', 'customer-1', '信息化二期', 'owner-1');
      `);
      const providers = makeProviders(db);
      const preview = await providers["customer.delete"]({
        arguments: { query: "示例医院" },
        context,
        serverData: directServerData,
      });
      assert.equal(preview.block, undefined);
      assert.deepEqual(preview.arguments, { customerId: "customer-1", expectedVersion: 3 });
      assert.match(preview.previewText, /【小小提醒！删除客户】/);
      assert.match(preview.previewText, /关联商机：2/);
    } finally {
      db.close();
    }
  });
});
