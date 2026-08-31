import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createHospitalTenderLeadConversionService } from "../src/hospitalTender/leadConversion.js";
import { createHospitalTenderRepository } from "../src/hospitalTender/repository.js";

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const NOTICE_ID = "notice-lead-1";
const NOTICE_URL = "https://example.com/notices/lead-1";

let db;
let tenderRepository;
let service;

function counts() {
  return {
    opportunities: Number(db.prepare("SELECT COUNT(*) AS count FROM opportunities").get().count),
    actionItems: Number(db.prepare("SELECT COUNT(*) AS count FROM action_items").get().count),
    audits: Number(db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count),
  };
}

function input(overrides = {}) {
  return {
    owner: OWNER_A,
    noticeId: NOTICE_ID,
    customerId: "customer-a",
    ...overrides,
  };
}

function confirmFromPreview(preview, overrides = {}) {
  return service.confirm(input({
    previewDigest: preview.previewDigest,
    confirmed: true,
    requestId: "request-lead-1",
    ...overrides,
  }));
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  db.exec(`
    INSERT INTO customers (id, name, region, owner, needs) VALUES
      ('customer-a', '青岛市中心医院', '青岛', '${OWNER_A}', '["PACS 双活", "影像存储"]'),
      ('customer-a2', '青岛市第二医院', '青岛', '${OWNER_A}', '["影像平台"]'),
      ('customer-unmatched', '未命中医院', '济南', '${OWNER_A}', '[]'),
      ('customer-b', '另一账号医院', '青岛', '${OWNER_B}', '["PACS"]');
  `);
  tenderRepository = createHospitalTenderRepository(db, {
    clock: () => new Date("2026-08-31T02:00:00.000Z"),
  });
  tenderRepository.upsertNotice({
    id: NOTICE_ID,
    identityKey: "source-a:item-lead-1",
    sourceId: "source-a",
    sourceName: "示例采购平台",
    city: "青岛市",
    title: "青岛市中心医院 PACS 存储扩容项目",
    url: NOTICE_URL,
    publishedAt: "2026-08-30T08:00:00.000Z",
    noticeType: "tender",
    purchaser: "青岛市中心医院",
    projectCode: "QDSZX-2026-01",
    budgetText: "人民币 500 万元",
    deadlineText: "2026-09-10",
    contentText: "采购 PACS 双活存储。",
    hospitalNames: ["青岛市中心医院"],
    sourceItemId: "item-lead-1",
    contentSha256: "a".repeat(64),
    relevance: "high",
  }, {
    matchedCustomerIds: ["customer-a", "customer-a2", "customer-b"],
    matchReasons: {
      "customer-a": ["医院名称精确命中", "PACS 需求命中"],
      "customer-a2": ["同城医院匹配"],
      "customer-b": ["PACS 需求命中"],
    },
    matchedNeeds: {
      "customer-a": ["PACS 双活", "影像存储"],
      "customer-a2": ["影像平台"],
      "customer-b": ["PACS"],
    },
    matchScore: 88,
  });
  service = createHospitalTenderLeadConversionService({
    db,
    tenderRepository,
    clock: () => new Date("2026-08-31T03:00:00.000Z"),
  });
});

afterEach(() => {
  db.close();
  db = null;
});

describe("hospital tender lead conversion", () => {
  it("previews the opportunity and todo with source evidence without writing any table", () => {
    const before = counts();
    const preview = service.preview(input());

    assert.deepEqual(counts(), before);
    assert.equal(preview.status, "preview");
    assert.equal(preview.requiresHumanConfirmation, true);
    assert.match(preview.previewDigest, /^[0-9a-f]{64}$/u);
    assert.equal(preview.notice.id, NOTICE_ID);
    assert.equal(preview.notice.url, NOTICE_URL);
    assert.equal(preview.notice.sourceName, "示例采购平台");
    assert.equal(preview.notice.projectCode, "QDSZX-2026-01");
    assert.equal(preview.customer.id, "customer-a");
    assert.equal(preview.customer.version, 1);
    assert.equal(preview.match.score, 88);
    assert.deepEqual(preview.match.reasons, ["医院名称精确命中", "PACS 需求命中"]);
    assert.deepEqual(preview.match.needs, ["PACS 双活", "影像存储"]);
    assert.equal(preview.drafts.opportunity.customerId, "customer-a");
    assert.equal(preview.drafts.actionItem.customerId, "customer-a");
    assert.equal(preview.drafts.actionItem.opportunityId, preview.drafts.opportunity.id);
    assert.deepEqual(preview.diff.opportunity.before, null);
    assert.deepEqual(preview.diff.opportunity.after, preview.drafts.opportunity);
    assert.deepEqual(preview.diff.actionItem.before, null);
    assert.deepEqual(preview.diff.actionItem.after, preview.drafts.actionItem);
  });

  it("cancels a current preview without creating an opportunity, todo, or audit", () => {
    const preview = service.preview(input());
    const before = counts();
    const cancelled = service.cancel(input({ previewDigest: preview.previewDigest }));

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.previewDigest, preview.previewDigest);
    assert.equal(cancelled.noticeId, NOTICE_ID);
    assert.equal(cancelled.customerId, "customer-a");
    assert.deepEqual(counts(), before);
  });

  it("creates exactly one owner-scoped opportunity and linked todo after explicit confirmation", () => {
    const preview = service.preview(input());
    const result = confirmFromPreview(preview);

    assert.equal(result.status, "confirmed");
    assert.equal(result.replayed, false);
    assert.equal(result.requiresHumanConfirmation, false);
    assert.equal(result.opportunity.owner, OWNER_A);
    assert.equal(result.actionItem.owner, OWNER_A);
    assert.equal(result.actionItem.opportunityId, result.opportunity.id);
    assert.deepEqual(counts(), { opportunities: 1, actionItems: 1, audits: 1 });

    const opportunityRow = db.prepare("SELECT * FROM opportunities WHERE id = $id").get({ $id: result.opportunity.id });
    assert.equal(opportunityRow.customer_id, "customer-a");
    assert.equal(opportunityRow.source_record, `hospital_tender:${NOTICE_ID}`);
    const requirements = JSON.parse(opportunityRow.requirements);
    assert.ok(requirements.includes(`公告编号：${NOTICE_ID}`));
    assert.ok(requirements.includes(`公告原文：${NOTICE_URL}`));
    assert.ok(requirements.some((item) => item.includes("医院名称精确命中")));

    const actionRow = db.prepare("SELECT * FROM action_items WHERE id = $id").get({ $id: result.actionItem.id });
    assert.equal(actionRow.customer_id, "customer-a");
    assert.equal(actionRow.opportunity_id, result.opportunity.id);
    assert.match(actionRow.reason, /医院名称精确命中/u);
    assert.match(actionRow.reason, /https:\/\/example\.com\/notices\/lead-1/u);

    const audit = db.prepare("SELECT * FROM audit_logs").get();
    assert.equal(audit.action, "hospital_tender.lead_conversion.confirm");
    assert.equal(audit.entity_type, "hospital_tender_notice");
    assert.equal(audit.entity_id, NOTICE_ID);
    assert.equal(audit.actor, OWNER_A);
    assert.equal(audit.request_id, "request-lead-1");
    assert.deepEqual(JSON.parse(audit.after_json), {
      noticeId: NOTICE_ID,
      customerId: "customer-a",
      opportunityId: result.opportunity.id,
      actionItemId: result.actionItem.id,
    });
  });

  it("requires the caller to say confirmed true before any write", () => {
    const preview = service.preview(input());
    assert.throws(
      () => service.confirm(input({ previewDigest: preview.previewDigest })),
      (error) => error.status === 422 && error.code === "CONFIRMATION_REQUIRED",
    );
    assert.deepEqual(counts(), { opportunities: 0, actionItems: 0, audits: 0 });
  });

  it("rejects a stale or changed preview digest without writing", () => {
    service.preview(input());
    assert.throws(
      () => service.confirm(input({ previewDigest: "0".repeat(64), confirmed: true })),
      (error) => error.status === 409 && error.code === "PREVIEW_STALE",
    );
    assert.deepEqual(counts(), { opportunities: 0, actionItems: 0, audits: 0 });
  });

  it("replays a repeated confirmation with the same ids and no duplicate rows", () => {
    const preview = service.preview(input());
    const first = confirmFromPreview(preview);
    const replay = confirmFromPreview(preview, { requestId: "request-lead-2" });

    assert.equal(replay.replayed, true);
    assert.equal(replay.opportunity.id, first.opportunity.id);
    assert.equal(replay.actionItem.id, first.actionItem.id);
    assert.deepEqual(counts(), { opportunities: 1, actionItems: 1, audits: 1 });
  });

  it("rolls the opportunity back when the todo step fails, then allows a clean retry", () => {
    const failing = createHospitalTenderLeadConversionService({
      db,
      tenderRepository,
      failpoint: (name) => {
        if (name === "afterOpportunity") throw new Error("injected todo failure");
      },
    });
    const preview = failing.preview(input());
    assert.throws(
      () => failing.confirm(input({
        previewDigest: preview.previewDigest,
        confirmed: true,
        requestId: "request-failpoint",
      })),
      /injected todo failure/u,
    );
    assert.deepEqual(counts(), { opportunities: 0, actionItems: 0, audits: 0 });

    const retry = service.confirm(input({
      previewDigest: preview.previewDigest,
      confirmed: true,
      requestId: "request-retry",
    }));
    assert.equal(retry.replayed, false);
    assert.deepEqual(counts(), { opportunities: 1, actionItems: 1, audits: 1 });
  });

  it("hides an owner-visible customer that was not matched to the notice", () => {
    assert.throws(
      () => service.preview(input({ customerId: "customer-unmatched" })),
      (error) => error.status === 404 && error.code === "NOT_FOUND",
    );
    assert.deepEqual(counts(), { opportunities: 0, actionItems: 0, audits: 0 });
  });

  it("does not reveal a customer that belongs to another owner", () => {
    let caught;
    try {
      service.preview(input({ owner: OWNER_B, customerId: "customer-a" }));
    } catch (error) {
      caught = error;
    }
    assert.equal(caught?.status, 404);
    assert.equal(caught?.code, "NOT_FOUND");
    assert.equal(caught?.message, "Requested resource was not found");
    assert.equal(caught?.fields, undefined);
    assert.doesNotMatch(JSON.stringify(caught), /owner-a|version|青岛市中心医院/u);
    assert.deepEqual(counts(), { opportunities: 0, actionItems: 0, audits: 0 });
  });

  it("rejects binding the same owner and notice to a second customer", () => {
    const firstPreview = service.preview(input());
    const first = confirmFromPreview(firstPreview);
    const secondPreview = service.preview(input({ customerId: "customer-a2" }));

    assert.throws(
      () => service.confirm(input({
        customerId: "customer-a2",
        previewDigest: secondPreview.previewDigest,
        confirmed: true,
        requestId: "request-second-customer",
      })),
      (error) => error.status === 409 && error.code === "CONVERSION_STATE_CONFLICT",
    );
    assert.deepEqual(counts(), { opportunities: 1, actionItems: 1, audits: 1 });
    assert.equal(db.prepare("SELECT customer_id FROM opportunities").get().customer_id, "customer-a");
    assert.equal(db.prepare("SELECT opportunity_id FROM action_items").get().opportunity_id, first.opportunity.id);
  });

  it("refuses to repair a hidden half-completed conversion", () => {
    const preview = service.preview(input());
    db.prepare(`
      INSERT INTO opportunities (
        id, customer_id, name, customer, stage, owner, source_record
      ) VALUES (
        $id, $customerId, $name, $customer, '线索', $owner, $sourceRecord
      )
    `).run({
      $id: preview.drafts.opportunity.id,
      $customerId: "customer-a",
      $name: preview.drafts.opportunity.name,
      $customer: preview.drafts.opportunity.customer,
      $owner: OWNER_A,
      $sourceRecord: preview.drafts.opportunity.sourceRecord,
    });

    assert.throws(
      () => confirmFromPreview(preview),
      (error) => error.status === 409 && error.code === "CONVERSION_STATE_CONFLICT",
    );
    assert.deepEqual(counts(), { opportunities: 1, actionItems: 0, audits: 0 });
  });

  it("keeps deterministic conversions separate for different owners", () => {
    const previewA = service.preview(input());
    const first = confirmFromPreview(previewA);
    const previewB = service.preview(input({ owner: OWNER_B, customerId: "customer-b" }));
    const second = service.confirm(input({
      owner: OWNER_B,
      customerId: "customer-b",
      previewDigest: previewB.previewDigest,
      confirmed: true,
      requestId: "request-owner-b",
    }));

    assert.notEqual(second.opportunity.id, first.opportunity.id);
    assert.notEqual(second.actionItem.id, first.actionItem.id);
    assert.deepEqual(counts(), { opportunities: 2, actionItems: 2, audits: 2 });
  });
});
