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

function noticeSnapshot(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function noticeMatch(overrides = {}) {
  return {
    matchedCustomerIds: ["customer-a", "customer-a2", "customer-b"],
    matchReasons: {
      "customer-a": ["hospital_name", "city", "need"],
      "customer-a2": ["city", "need"],
      "customer-b": ["city", "need"],
    },
    matchedNeeds: {
      "customer-a": ["PACS 双活"],
      "customer-a2": ["存储"],
      "customer-b": ["PACS"],
    },
    matchScore: 100,
    ...overrides,
  };
}

function upsertNotice(snapshotOverrides = {}, matchOverrides = {}) {
  return tenderRepository.upsertNotice(
    noticeSnapshot(snapshotOverrides),
    noticeMatch(matchOverrides),
  );
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  db.exec(`
    INSERT INTO customers (id, name, region, owner, needs) VALUES
      ('customer-a', '青岛市中心医院', '青岛', '${OWNER_A}', '["PACS 双活", "影像存储"]'),
      ('customer-a2', '青岛市第二医院', '青岛', '${OWNER_A}', '["存储"]'),
      ('customer-unmatched', '未命中医院', '济南', '${OWNER_A}', '[]'),
      ('customer-b', '另一账号医院', '青岛', '${OWNER_B}', '["PACS"]');
  `);
  tenderRepository = createHospitalTenderRepository(db, {
    clock: () => new Date("2026-08-31T02:00:00.000Z"),
  });
  upsertNotice();
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
    assert.match(preview.conversionIdentity, /^[0-9a-f]{64}$/u);
    assert.match(preview.noticeSnapshotDigest, /^[0-9a-f]{64}$/u);
    assert.equal(preview.match.score, 100);
    assert.deepEqual(preview.match.reasons, ["hospital_name", "city", "need"]);
    assert.deepEqual(preview.match.needs, ["PACS 双活"]);
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
    assert.ok(requirements.some((item) => item.includes("hospital_name")));

    const actionRow = db.prepare("SELECT * FROM action_items WHERE id = $id").get({ $id: result.actionItem.id });
    assert.equal(actionRow.customer_id, "customer-a");
    assert.equal(actionRow.opportunity_id, result.opportunity.id);
    assert.match(actionRow.reason, /hospital_name/u);
    assert.match(actionRow.reason, /https:\/\/example\.com\/notices\/lead-1/u);

    const audit = db.prepare("SELECT * FROM audit_logs").get();
    assert.equal(audit.action, "hospital_tender.lead_conversion.confirm");
    assert.equal(audit.entity_type, "hospital_tender_notice");
    assert.equal(audit.entity_id, NOTICE_ID);
    assert.equal(audit.actor, OWNER_A);
    assert.equal(audit.request_id, "request-lead-1");
    assert.deepEqual(JSON.parse(audit.after_json), {
      schemaVersion: 2,
      previewDigest: preview.previewDigest,
      conversionIdentity: preview.conversionIdentity,
      noticeSnapshotDigest: preview.noticeSnapshotDigest,
      canonicalNoticeId: preview.canonicalNoticeId,
      canonicalRevision: preview.canonicalRevision,
      canonicalDigest: preview.canonicalDigest,
      noticeId: NOTICE_ID,
      noticeIdentityKey: "source-a:item-lead-1",
      owner: OWNER_A,
      customerId: "customer-a",
      customerVersion: preview.customerVersion,
      customerSnapshotDigest: preview.customerSnapshotDigest,
      matchSnapshotDigest: preview.matchSnapshotDigest,
      opportunitySnapshotDigest: preview.opportunitySnapshotDigest,
      opportunityId: result.opportunity.id,
      actionItemId: result.actionItem.id,
      matchScore: 100,
    });
    assert.deepEqual(JSON.parse(audit.metadata_json), {
      previewDigest: preview.previewDigest,
      conversionIdentity: preview.conversionIdentity,
      noticeSnapshotDigest: preview.noticeSnapshotDigest,
      canonicalNoticeId: preview.canonicalNoticeId,
      canonicalRevision: preview.canonicalRevision,
      canonicalDigest: preview.canonicalDigest,
      noticeIdentityKey: "source-a:item-lead-1",
      owner: OWNER_A,
      customerId: "customer-a",
      customerVersion: preview.customerVersion,
      customerSnapshotDigest: preview.customerSnapshotDigest,
      matchSnapshotDigest: preview.matchSnapshotDigest,
      opportunitySnapshotDigest: preview.opportunitySnapshotDigest,
      opportunityId: result.opportunity.id,
      actionItemId: result.actionItem.id,
      matchScore: 100,
    });
    assert.doesNotMatch(
      `${audit.after_json}${audit.metadata_json}`,
      /青岛市中心医院 PACS 存储扩容项目|采购 PACS 双活存储/u,
    );
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

  it("binds previewDigest to every canonical persisted notice field that drafts can omit or truncate", () => {
    const budgetPrefix = "预".repeat(100);
    const deadlinePrefix = "期".repeat(50);
    const matrixBase = {
      budgetText: `${budgetPrefix}甲`,
      deadlineText: `${deadlinePrefix}甲`,
    };
    upsertNotice(matrixBase);
    const baseline = service.preview(input());
    const variants = [
      ["contentText", {
        contentText: "采购 PACS 双活存储，正文发生变化但匹配和草稿保持不变。",
        contentSha256: "a".repeat(64),
      }],
      ["purchaser", { purchaser: "青岛市中心医院采购办公室" }],
      ["noticeType", { noticeType: "clarification" }],
      ["relevance", { relevance: "medium" }],
      ["city", { city: "青岛" }],
      ["hospitalNames", { hospitalNames: ["青岛市中心医院", "青岛市第三医院"] }],
      ["sourceItemId", { sourceItemId: "item-lead-1-revision" }],
      ["budgetText tail after draft limit", { budgetText: `${budgetPrefix}乙` }],
      ["deadlineText tail after draft limit", { deadlineText: `${deadlinePrefix}乙` }],
    ];

    for (const [label, changes] of variants) {
      upsertNotice({ ...matrixBase, ...changes });
      const changed = service.preview(input());
      assert.notEqual(changed.noticeSnapshotDigest, baseline.noticeSnapshotDigest, label);
      assert.notEqual(changed.previewDigest, baseline.previewDigest, label);
      assert.equal(changed.conversionIdentity, baseline.conversionIdentity, label);
      if (label !== "relevance") assert.deepEqual(changed.drafts, baseline.drafts, label);
      upsertNotice(matrixBase);
      const restored = service.preview(input());
      assert.equal(restored.canonicalDigest, baseline.canonicalDigest, `${label} restore canonical digest`);
      assert.ok(restored.canonicalRevision >= baseline.canonicalRevision, `${label} restore canonical revision`);
      assert.equal(restored.conversionIdentity, baseline.conversionIdentity, `${label} restore identity`);
      assert.notEqual(restored.previewDigest, baseline.previewDigest, `${label} restore revision binding`);
    }
    assert.deepEqual(counts(), { opportunities: 0, actionItems: 0, audits: 0 });
  });

  it("rejects an old digest before the first write when only hidden notice content changed", () => {
    const originalPreview = service.preview(input());
    upsertNotice({
      contentText: "采购 PACS 双活存储，正文在人工预览后发生变化。",
      contentSha256: "a".repeat(64),
    });
    const changedPreview = service.preview(input());

    assert.deepEqual(changedPreview.drafts, originalPreview.drafts);
    assert.equal(changedPreview.conversionIdentity, originalPreview.conversionIdentity);
    assert.notEqual(changedPreview.noticeSnapshotDigest, originalPreview.noticeSnapshotDigest);
    assert.notEqual(changedPreview.previewDigest, originalPreview.previewDigest);
    assert.throws(
      () => confirmFromPreview(originalPreview, { requestId: "request-hidden-content-stale" }),
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

  it("does not report an old conversion as a replay of a changed notice preview", () => {
    const originalPreview = service.preview(input());
    const first = confirmFromPreview(originalPreview);

    upsertNotice({
      contentText: "采购 PACS 双活存储，交付范围已经变更。",
      contentSha256: "a".repeat(64),
    });
    const changedPreview = service.preview(input());
    assert.deepEqual(changedPreview.drafts, originalPreview.drafts);
    assert.equal(changedPreview.conversionIdentity, originalPreview.conversionIdentity);
    assert.notEqual(changedPreview.noticeSnapshotDigest, originalPreview.noticeSnapshotDigest);
    assert.notEqual(changedPreview.previewDigest, originalPreview.previewDigest);
    assert.equal(changedPreview.drafts.opportunity.id, first.opportunity.id);

    assert.throws(
      () => confirmFromPreview(changedPreview, { requestId: "request-changed-preview" }),
      (error) => error.status === 409 && error.code === "CONVERSION_STATE_CONFLICT",
    );
    assert.throws(
      () => confirmFromPreview(originalPreview, { requestId: "request-old-preview" }),
      (error) => error.status === 409 && error.code === "PREVIEW_STALE",
    );
    assert.equal(
      db.prepare("SELECT name FROM opportunities WHERE id = $id").get({ $id: first.opportunity.id }).name,
      "招标线索：青岛市中心医院 PACS 存储扩容项目",
    );
    assert.deepEqual(counts(), { opportunities: 1, actionItems: 1, audits: 1 });
  });

  it("preserves later human edits when replaying the exact confirmed preview", () => {
    const preview = service.preview(input());
    const first = confirmFromPreview(preview);
    db.prepare(`
      UPDATE opportunities
      SET stage = '方案', next = '人工确认后的下一步', version = version + 1
      WHERE id = $id
    `).run({ $id: first.opportunity.id });
    db.prepare(`
      UPDATE action_items
      SET status = 'in_progress', version = version + 1
      WHERE id = $id
    `).run({ $id: first.actionItem.id });

    const replay = confirmFromPreview(preview, { requestId: "request-human-edits" });

    assert.equal(replay.replayed, true);
    assert.equal(replay.opportunity.stage, "方案");
    assert.equal(replay.opportunity.next, "人工确认后的下一步");
    assert.equal(replay.actionItem.status, "in_progress");
    assert.deepEqual(counts(), { opportunities: 1, actionItems: 1, audits: 1 });
  });

  it("fails closed when the immutable confirmation audit receipt is damaged", () => {
    const preview = service.preview(input());
    confirmFromPreview(preview);
    const audit = db.prepare("SELECT id, after_json FROM audit_logs").get();
    const damagedAfter = JSON.parse(audit.after_json);
    damagedAfter.previewDigest = "f".repeat(64);
    db.prepare("UPDATE audit_logs SET after_json = $after WHERE id = $id").run({
      $id: audit.id,
      $after: JSON.stringify(damagedAfter),
    });

    assert.throws(
      () => confirmFromPreview(preview, { requestId: "request-damaged-receipt" }),
      (error) => error.status === 409 && error.code === "CONVERSION_STATE_CONFLICT",
    );
    assert.deepEqual(counts(), { opportunities: 1, actionItems: 1, audits: 1 });
  });

  it("fails closed when the immutable confirmation audit receipt is missing", () => {
    const preview = service.preview(input());
    confirmFromPreview(preview);
    db.prepare("DELETE FROM audit_logs").run();

    assert.throws(
      () => confirmFromPreview(preview, { requestId: "request-missing-receipt" }),
      (error) => error.status === 409 && error.code === "CONVERSION_STATE_CONFLICT",
    );
    assert.deepEqual(counts(), { opportunities: 1, actionItems: 1, audits: 0 });
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

  it("rolls both business rows back when the real audit insert fails", () => {
    const preview = service.preview(input());
    db.exec(`
      CREATE TEMP TRIGGER fail_hospital_tender_conversion_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'hospital_tender.lead_conversion.confirm'
      BEGIN
        SELECT RAISE(ABORT, 'injected audit insert failure');
      END;
    `);

    assert.throws(
      () => confirmFromPreview(preview, { requestId: "request-audit-failure" }),
      /injected audit insert failure/u,
    );
    assert.deepEqual(counts(), { opportunities: 0, actionItems: 0, audits: 0 });
  });

  it("hides an owner-visible customer that was not matched to the notice", () => {
    assert.throws(
      () => service.preview(input({ customerId: "customer-unmatched" })),
      (error) => error.status === 404 && error.code === "NOT_FOUND",
    );
    assert.deepEqual(counts(), { opportunities: 0, actionItems: 0, audits: 0 });
  });

  it("fails closed when persisted customer match evidence disagrees with a current recomputation", () => {
    upsertNotice({}, {
      matchReasons: {
        "customer-a": ["hospital_name", "city"],
        "customer-a2": ["city", "need"],
        "customer-b": ["city", "need"],
      },
    });

    assert.throws(
      () => service.preview(input()),
      (error) => error.status === 409 && error.code === "MATCH_EVIDENCE_STALE",
    );
    assert.deepEqual(counts(), { opportunities: 0, actionItems: 0, audits: 0 });
  });

  it("fails closed when the current customer no longer matches persisted notice evidence", () => {
    db.prepare(`
      UPDATE customers
      SET name = '已迁移客户', region = '济南', needs = '[]', aliases = '[]', tags = '[]'
      WHERE id = 'customer-a'
    `).run();

    assert.throws(
      () => service.preview(input()),
      (error) => error.status === 409 && error.code === "MATCH_EVIDENCE_STALE",
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

  it("converts two legal matched customers under the same owner independently", () => {
    const firstPreview = service.preview(input());
    const first = confirmFromPreview(firstPreview);
    const secondPreview = service.preview(input({ customerId: "customer-a2" }));
    const second = service.confirm(input({
      customerId: "customer-a2",
      previewDigest: secondPreview.previewDigest,
      confirmed: true,
      requestId: "request-second-customer",
    }));

    assert.notEqual(secondPreview.conversionIdentity, firstPreview.conversionIdentity);
    assert.notEqual(second.opportunity.id, first.opportunity.id);
    assert.notEqual(second.actionItem.id, first.actionItem.id);
    assert.equal(first.opportunity.customerId, "customer-a");
    assert.equal(second.opportunity.customerId, "customer-a2");
    assert.equal(first.opportunity.probability, 100);
    assert.equal(second.opportunity.probability, 40);
    assert.equal(first.actionItem.priority, "高");
    assert.equal(second.actionItem.priority, "中");
    assert.deepEqual(counts(), { opportunities: 2, actionItems: 2, audits: 2 });
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

  it("rejects a replay after its deterministic opportunity is rebound to another customer", () => {
    const preview = service.preview(input());
    const first = confirmFromPreview(preview);
    db.prepare("UPDATE opportunities SET customer_id = 'customer-a2' WHERE id = $id").run({
      $id: first.opportunity.id,
    });

    assert.throws(
      () => confirmFromPreview(preview, { requestId: "request-rebound" }),
      (error) => error.status === 409 && error.code === "CONVERSION_STATE_CONFLICT",
    );
    assert.deepEqual(counts(), { opportunities: 1, actionItems: 1, audits: 1 });
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
