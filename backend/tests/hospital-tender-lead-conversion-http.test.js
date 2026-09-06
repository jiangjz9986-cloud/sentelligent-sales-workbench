import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createHospitalTenderLeadConversionHttpHandlers } from "../src/hospitalTender/leadConversionHttp.js";
import { createHospitalTenderLeadConversionService } from "../src/hospitalTender/leadConversion.js";
import { createHospitalTenderRepository } from "../src/hospitalTender/repository.js";

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const NOTICE_ID = "notice-http-1";
const USER_A = Object.freeze({ kind: "user", account: OWNER_A });

let db;
let service;
let handlers;
let tenderRepository;

function noticeSnapshot(overrides = {}) {
  return {
    id: NOTICE_ID,
    identityKey: "source-http:item-http-1",
    sourceId: "source-http",
    sourceName: "示例采购平台",
    city: "青岛市",
    title: "青岛市中心医院 PACS 存储扩容项目",
    url: "https://example.com/notices/http-1",
    publishedAt: "2026-08-30T08:00:00.000Z",
    noticeType: "tender",
    purchaser: "青岛市中心医院",
    projectCode: "QDSZX-HTTP-01",
    budgetText: "人民币 500 万元",
    deadlineText: "2026-09-10",
    contentText: "采购 PACS 双活存储。",
    hospitalNames: ["青岛市中心医院"],
    sourceItemId: "item-http-1",
    contentSha256: "a".repeat(64),
    relevance: "high",
    ...overrides,
  };
}

function noticeMatch(overrides = {}) {
  return {
    matchedCustomerIds: ["customer-http-a"],
    matchReasons: { "customer-http-a": ["hospital_name", "city", "need"] },
    matchedNeeds: { "customer-http-a": ["PACS 双活"] },
    matchScore: 100,
    ...overrides,
  };
}

function countRows() {
  return {
    opportunities: Number(db.prepare("SELECT COUNT(*) AS count FROM opportunities").get().count),
    actionItems: Number(db.prepare("SELECT COUNT(*) AS count FROM action_items").get().count),
    audits: Number(db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count),
  };
}

function route(action = "preview") {
  return `/api/hospital-tenders/${encodeURIComponent(NOTICE_ID)}/lead-conversion/${action}`;
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  db.exec(`
    INSERT INTO customers (id, name, region, owner, needs) VALUES
      ('customer-http-a', '青岛市中心医院', '青岛', '${OWNER_A}', '["PACS 双活", "影像存储"]'),
      ('customer-http-b', '另一账号医院', '青岛', '${OWNER_B}', '["PACS"]');
  `);
  tenderRepository = createHospitalTenderRepository(db, {
    clock: () => new Date("2026-08-31T02:00:00.000Z"),
  });
  tenderRepository.upsertNotice(noticeSnapshot(), noticeMatch());
  service = createHospitalTenderLeadConversionService({
    db,
    tenderRepository,
    clock: () => new Date("2026-08-31T03:00:00.000Z"),
  });
  handlers = createHospitalTenderLeadConversionHttpHandlers({ service });
});

afterEach(() => {
  db.close();
  db = null;
});

describe("hospital tender lead conversion HTTP adapter", () => {
  it("returns a read-only preview and injects the authenticated owner", () => {
    const before = countRows();
    const result = handlers.handle({
      pathname: route(),
      requestIdentity: USER_A,
      requestId: "req-http-preview",
      body: { customerId: "customer-http-a" },
    });

    assert.equal(result.status, 200);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.body.requestId, "req-http-preview");
    assert.equal(result.body.item.status, "preview");
    assert.equal(result.body.item.requiresHumanConfirmation, true);
    assert.equal(result.body.item.customer.id, "customer-http-a");
    assert.equal(result.body.item.drafts.opportunity.owner, OWNER_A);
    assert.deepEqual(countRows(), before);
  });

  it("confirms once and replays the same result without duplicate rows", () => {
    const preview = handlers.handle({
      pathname: route(),
      requestIdentity: USER_A,
      body: { customerId: "customer-http-a" },
    });
    const confirmed = handlers.handle({
      pathname: route("confirm"),
      requestIdentity: USER_A,
      requestId: "req-http-confirm",
      body: {
        customerId: "customer-http-a",
        previewDigest: preview.body.item.previewDigest,
        confirmed: true,
      },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.item.status, "confirmed");
    assert.equal(confirmed.body.item.replayed, false);
    assert.equal(
      db.prepare("SELECT request_id FROM audit_logs WHERE action = 'hospital_tender.lead_conversion.confirm'").get().request_id,
      "req-http-confirm",
    );
    assert.deepEqual(countRows(), { opportunities: 1, actionItems: 1, audits: 1 });

    const replay = handlers.handle({
      pathname: route("confirm"),
      requestIdentity: USER_A,
      body: {
        customerId: "customer-http-a",
        previewDigest: preview.body.item.previewDigest,
        confirmed: true,
      },
    });
    assert.equal(replay.body.item.status, "confirmed");
    assert.equal(replay.body.item.replayed, true);
    assert.equal(replay.body.item.opportunity.id, confirmed.body.item.opportunity.id);
    assert.equal(replay.body.item.actionItem.id, confirmed.body.item.actionItem.id);
    assert.deepEqual(countRows(), { opportunities: 1, actionItems: 1, audits: 1 });
  });

  it("cancels explicitly without writing business rows", () => {
    const preview = handlers.handle({
      pathname: route(),
      requestIdentity: USER_A,
      body: { customerId: "customer-http-a" },
    });
    const before = countRows();
    const cancelled = handlers.handle({
      pathname: route("cancel"),
      requestIdentity: USER_A,
      body: {
        customerId: "customer-http-a",
        previewDigest: preview.body.item.previewDigest,
        cancel: true,
      },
    });
    assert.equal(cancelled.body.item.status, "cancelled");
    assert.deepEqual(countRows(), before);
  });

  it("fails closed for missing auth, unknown fields, forged owner, and non-POST", () => {
    assert.throws(
      () => handlers.handle({ pathname: route(), body: { customerId: "customer-http-a" } }),
      (error) => error.status === 401 && error.code === "UNAUTHORIZED",
    );
    assert.throws(
      () => handlers.handle({ pathname: route(), requestIdentity: USER_A, body: {
        customerId: "customer-http-a",
        owner: OWNER_B,
      } }),
      (error) => error.status === 422 && error.fields.owner === "unknown",
    );
    assert.throws(
      () => handlers.handle({
        method: "GET",
        pathname: route(),
        requestIdentity: USER_A,
        body: { customerId: "customer-http-a" },
      }),
      (error) => error.status === 405 && error.headers.Allow === "POST",
    );
    assert.equal(handlers.matches("/api/hospital-tenders/not-a-route"), false);
  });

  it("does not expose another account's customer and rejects stale confirmation", () => {
    assert.throws(
      () => handlers.handle({
        pathname: route(),
        requestIdentity: { kind: "user", account: OWNER_B },
        body: { customerId: "customer-http-a" },
      }),
      (error) => error.status === 404 && error.code === "NOT_FOUND",
    );

    const preview = handlers.handle({
      pathname: route(),
      requestIdentity: USER_A,
      body: { customerId: "customer-http-a" },
    });
    tenderRepository.upsertNotice(
      noticeSnapshot({ contentText: "采购 PACS 双活存储，增加归档节点。" }),
      noticeMatch(),
    );
    assert.throws(
      () => handlers.handle({
        pathname: route("confirm"),
        requestIdentity: USER_A,
        body: {
          customerId: "customer-http-a",
          previewDigest: preview.body.item.previewDigest,
          confirmed: true,
        },
      }),
      (error) => error.status === 409 && error.code === "PREVIEW_STALE",
    );
  });
});
