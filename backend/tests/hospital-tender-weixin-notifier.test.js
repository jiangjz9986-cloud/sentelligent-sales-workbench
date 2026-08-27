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
    ...overrides,
  };
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
      const notify = createHospitalTenderWeixinNotifier({
        outboxRepository,
        resolveOwner: () => OWNER,
        resolveConversationId: () => CONVERSATION,
      });
      assert.equal(await notify({ cycleNumber: 3, batchCustomerIds: ["c1"], notices: [] }), 0);
      assert.equal(queuedRows(db).length, 0);
    });
  });

  it("enqueues plain-text chunks with stable idempotency keys and replays without duplicates", async () => {
    await withOutbox(async ({ db, outboxRepository }) => {
      let delivered = null;
      const notify = createHospitalTenderWeixinNotifier({
        outboxRepository,
        resolveOwner: () => OWNER,
        resolveConversationId: () => CONVERSATION,
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

  it("fails closed when the WeChat delivery target cannot be resolved", async () => {
    await withOutbox(async ({ db, outboxRepository }) => {
      let failure = null;
      const notify = createHospitalTenderWeixinNotifier({
        outboxRepository,
        resolveOwner: () => "",
        resolveConversationId: () => { throw new Error("scope missing"); },
        onFailure: (summary) => { failure = summary; },
      });
      await assert.rejects(
        () => notify({ cycleNumber: 1, batchCustomerIds: ["c1"], notices: [notice(1)] }),
        /notification unavailable/,
      );
      assert.equal(queuedRows(db).length, 0);
      assert.equal(failure.errorCode, "notification unavailable");
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
