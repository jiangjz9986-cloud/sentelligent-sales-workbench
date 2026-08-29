import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createWeixinConfirmationOutboxRepository } from "../src/weixin/outboxRepository.js";
import {
  createHospitalTenderWeixinNotifier,
  hospitalTenderNoticeLine,
  renderHospitalTenderNoticeMessage,
} from "../src/hospitalTender/weixinNotifier.js";

const OWNER = "jiangjz";
const CONVERSATION = "weixin:bookkeeping:jiangjz:sender-1";

function notice(index, overrides = {}) {
  return {
    title: `胜利油田中心医院信息化项目公告 ${index}`,
    sourceName: "公开采购平台",
    publishedAt: "2026-08-27",
    url: `https://example.com/notice/${index}`,
    match: { matchedCustomerIds: ["c1"] },
    ...overrides,
  };
}

// v0.9.3 单 owner 语境的标准装配：全部公告匹配 c1 → OWNER。
function singleOwnerWiring(outboxRepository, overrides = {}) {
  return createHospitalTenderWeixinNotifier({
    outboxRepository,
    resolveDigestDeliveries: () => [{ account: OWNER, senderId: "sender-1", conversationId: CONVERSATION }],
    resolveAdminDeliveries: () => [],
    resolveCustomerOwners: (ids) => new Map(ids.map((id) => [id, OWNER])),
    ...overrides,
  });
}

async function withOutbox(work) {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    const outboxRepository = createWeixinConfirmationOutboxRepository(db);
    return await work({ db, outboxRepository });
  } finally {
    db.close();
  }
}

function queuedRows(db) {
  return db.prepare(
    "SELECT owner, conversation_id, payload_json FROM weixin_confirmation_outbox ORDER BY created_at ASC, id ASC",
  ).all();
}

describe("hospital tender weixin notifier", () => {
  it("skips silently when the batch has no new high-relevance notices", async () => {
    await withOutbox(async ({ db, outboxRepository }) => {
      const notify = singleOwnerWiring(outboxRepository);
      assert.equal(await notify({ cycleNumber: 3, batchCustomerIds: ["c1"], notices: [] }), 0);
      assert.equal(queuedRows(db).length, 0);
    });
  });

  it("enqueues plain-text chunks with stable owner-scoped idempotency keys and replays without duplicates", async () => {
    await withOutbox(async ({ db, outboxRepository }) => {
      let delivered = null;
      const notify = singleOwnerWiring(outboxRepository, {
        onSuccess: (summary) => { delivered = summary; },
      });
      const notices = Array.from({ length: 25 }, (_, index) => notice(index + 1));
      assert.equal(await notify({ cycleNumber: 7, batchCustomerIds: ["c1", "c2"], notices }), 25);
      const rows = queuedRows(db);
      assert.equal(rows.length, 2);
      assert.deepEqual(delivered, { count: 25, chunkCount: 2 });
      for (const row of rows) {
        assert.equal(row.owner, OWNER);
        assert.equal(row.conversation_id, CONVERSATION);
        const payload = JSON.parse(row.payload_json);
        assert.equal(payload.kind, "hospital_tender_notice");
        assert.equal(payload.cycleNumber, 7);
        assert.equal(payload.totalCount, 25);
        assert.equal(payload.batchCustomerCount, 2);
        assert.ok(Array.isArray(payload.lines) && payload.lines.length > 0);
        const message = renderHospitalTenderNoticeMessage(payload);
        assert.match(message, /【小小监测】医院招标新公告（第 7 轮 \d\/2）/);
        assert.match(message, /本批 2 家客户新增 25 条高相关公告/);
        assert.doesNotMatch(message, /token|secret|password/i);
      }

      assert.equal(await notify({ cycleNumber: 7, batchCustomerIds: ["c1", "c2"], notices }), 25);
      assert.equal(queuedRows(db).length, 2, "replayed cycle must not enqueue duplicates");
    });
  });

  it("groups notices by matched-customer owner and delivers each group only to its binding", async () => {
    await withOutbox(async ({ db, outboxRepository }) => {
      const owners = new Map([["c-a", "jiangjz"], ["c-b", "testb"]]);
      const notify = createHospitalTenderWeixinNotifier({
        outboxRepository,
        resolveDigestDeliveries: () => [
          { account: "jiangjz", conversationId: "conversation-a" },
          { account: "testb", conversationId: "conversation-b" },
        ],
        resolveAdminDeliveries: () => [],
        resolveCustomerOwners: (ids) => new Map(ids.map((id) => [id, owners.get(id)]).filter(([, owner]) => owner)),
      });
      const shared = notice(3, { match: { matchedCustomerIds: ["c-a", "c-b"] } });
      const count = await notify({
        cycleNumber: 2,
        batchCustomerIds: ["c-a", "c-b"],
        notices: [
          notice(1, { match: { matchedCustomerIds: ["c-a"] } }),
          notice(2, { match: { matchedCustomerIds: ["c-b"] } }),
          shared,
        ],
      });
      assert.equal(count, 3);
      const rows = queuedRows(db);
      assert.equal(rows.length, 2, "one chunk per owner group");
      const byOwner = Object.fromEntries(rows.map((row) => [row.owner, JSON.parse(row.payload_json)]));
      assert.match(byOwner.jiangjz.lines.join("\n"), /公告 1/);
      assert.match(byOwner.jiangjz.lines.join("\n"), /公告 3/, "a shared notice reaches both groups");
      assert.doesNotMatch(byOwner.jiangjz.lines.join("\n"), /公告 2/);
      assert.match(byOwner.testb.lines.join("\n"), /公告 2/);
      assert.match(byOwner.testb.lines.join("\n"), /公告 3/);
      assert.doesNotMatch(byOwner.testb.lines.join("\n"), /公告 1/);
      assert.equal(rows.find((row) => row.owner === "jiangjz").conversation_id, "conversation-a");
      assert.equal(rows.find((row) => row.owner === "testb").conversation_id, "conversation-b");
    });
  });

  it("falls back for unrouted notices: admin binding, then PushPlus, then the unrouted audit", async () => {
    // admin 兜底。
    await withOutbox(async ({ db, outboxRepository }) => {
      const notify = createHospitalTenderWeixinNotifier({
        outboxRepository,
        resolveDigestDeliveries: () => [],
        resolveAdminDeliveries: () => [{ account: "jiangjz", conversationId: "conversation-admin" }],
        resolveCustomerOwners: () => new Map(),
      });
      assert.equal(await notify({ cycleNumber: 1, batchCustomerIds: ["c1"], notices: [notice(1)] }), 1);
      const rows = queuedRows(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].owner, "jiangjz");
      assert.equal(rows[0].conversation_id, "conversation-admin");
    });
    // PushPlus 兜底。
    await withOutbox(async ({ db, outboxRepository }) => {
      const pushed = [];
      const notify = createHospitalTenderWeixinNotifier({
        outboxRepository,
        resolveDigestDeliveries: () => [],
        resolveAdminDeliveries: () => [],
        resolveCustomerOwners: () => new Map(),
        pushplusNotify: async (batch) => { pushed.push(batch); },
      });
      assert.equal(await notify({ cycleNumber: 4, batchCustomerIds: ["c1"], notices: [notice(1)] }), 1);
      assert.equal(queuedRows(db).length, 0);
      assert.equal(pushed.length, 1);
      assert.equal(pushed[0].notices.length, 1);
    });
    // 审计计数后视为已处理。
    await withOutbox(async ({ db, outboxRepository }) => {
      const unrouted = [];
      const notify = createHospitalTenderWeixinNotifier({
        outboxRepository,
        resolveDigestDeliveries: () => [],
        resolveAdminDeliveries: () => [],
        resolveCustomerOwners: () => new Map(),
        recordUnrouted: (event) => unrouted.push(event),
      });
      assert.equal(await notify({ cycleNumber: 5, batchCustomerIds: ["c1"], notices: [notice(1), notice(2)] }), 2);
      assert.equal(queuedRows(db).length, 0);
      assert.deepEqual(unrouted, [{ count: 2, cycleNumber: 5 }]);
    });
  });

  it("fails closed when the outbox enqueue or owner lookup throws so the scheduler retries", async () => {
    await withOutbox(async ({ db, outboxRepository }) => {
      let failure = null;
      const notify = singleOwnerWiring({
        enqueue: () => { throw new Error("outbox unavailable"); },
      }, {
        onFailure: (summary) => { failure = summary; },
      });
      await assert.rejects(
        () => notify({ cycleNumber: 1, batchCustomerIds: ["c1"], notices: [notice(1)] }),
        /outbox unavailable/,
      );
      assert.equal(queuedRows(db).length, 0);
      assert.equal(failure.errorCode, "outbox unavailable");

      let lookupFailure = null;
      const brokenLookup = createHospitalTenderWeixinNotifier({
        outboxRepository,
        resolveDigestDeliveries: () => { throw new Error("bindings unavailable"); },
        resolveAdminDeliveries: () => [],
        resolveCustomerOwners: () => new Map(),
        onFailure: (summary) => { lookupFailure = summary; },
      });
      await assert.rejects(
        () => brokenLookup({ cycleNumber: 1, batchCustomerIds: ["c1"], notices: [notice(1)] }),
        /bindings unavailable/,
      );
      assert.equal(lookupFailure.errorCode, "bindings unavailable");
    });
  });

  it("renders bounded plain-text lines and rejects malformed payloads", () => {
    const line = hospitalTenderNoticeLine(notice(1, { url: "javascript:alert(1)" }));
    assert.match(line, /^· 胜利油田中心医院信息化项目公告 1/);
    assert.doesNotMatch(line, /javascript:/);

    assert.throws(
      () => renderHospitalTenderNoticeMessage({ kind: "hospital_tender_notice", lines: [] }),
      /empty/,
    );
    assert.throws(
      () => renderHospitalTenderNoticeMessage({ kind: "accepted", lines: ["x"] }),
      /invalid/,
    );
  });
});
