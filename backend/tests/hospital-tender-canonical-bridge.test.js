import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createHospitalTenderLeadConversionHttpHandlers } from "../src/hospitalTender/leadConversionHttp.js";
import { createHospitalTenderLeadConversionService } from "../src/hospitalTender/leadConversion.js";
import {
  canonicalNoticeDigest,
  contentDigest,
  createHospitalTenderRepository,
} from "../src/hospitalTender/repository.js";

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const CUSTOMER_A = "customer-a";
const CUSTOMER_B = "customer-b";
const NOTICE_ID = "tender-bridge-1";

let db;
let repository;
let service;
let now;

function notice(overrides = {}) {
  const value = {
    id: NOTICE_ID,
    identityKey: "source-a:item-1",
    sourceId: "source-a",
    sourceName: "公开采购平台 A",
    city: "青岛市",
    title: "青岛市中心医院 PACS 存储扩容项目",
    url: "https://source-a.example/notices/1",
    publishedAt: "2026-08-30T08:00:00.000Z",
    noticeType: "tender",
    purchaser: "青岛市中心医院",
    projectCode: "QDSZX-2026-01",
    budgetText: "人民币 500 万元",
    deadlineText: "2026-09-10",
    contentText: "采购 PACS 双活存储。",
    hospitalNames: ["青岛市中心医院"],
    sourceItemId: "item-1",
    contentSha256: contentDigest("采购 PACS 双活存储。"),
    relevance: "high",
    ...overrides,
  };
  if (Object.hasOwn(overrides, "contentText") && !Object.hasOwn(overrides, "contentSha256")) {
    value.contentSha256 = contentDigest(value.contentText);
  }
  return value;
}

function matchFor(customerIds = [CUSTOMER_A]) {
  const match = {
    matchedCustomerIds: [],
    matchReasons: {},
    matchedNeeds: {},
    matchScore: 0,
  };
  for (const customerId of customerIds) {
    match.matchedCustomerIds.push(customerId);
    if (customerId === CUSTOMER_A) {
      match.matchReasons[customerId] = ["hospital_name", "city", "need"];
      match.matchedNeeds[customerId] = ["PACS 双活"];
      match.matchScore = Math.max(match.matchScore, 100);
    } else {
      match.matchReasons[customerId] = ["city", "need"];
      match.matchedNeeds[customerId] = ["PACS"];
      match.matchScore = Math.max(match.matchScore, 40);
    }
  }
  return match;
}

function addCustomer({ id, owner, name, region = "青岛", needs = ["PACS 双活"] }) {
  db.prepare(`
    INSERT INTO customers (
      id, name, region, owner, needs, aliases, tags, summary
    ) VALUES (
      $id, $name, $region, $owner, $needs, '[]', '[]', NULL
    )
  `).run({
    $id: id,
    $name: name,
    $region: region,
    $owner: owner,
    $needs: JSON.stringify(needs),
  });
}

function addStandardCustomers({ bothOwners = false } = {}) {
  addCustomer({
    id: CUSTOMER_A,
    owner: OWNER_A,
    name: "青岛市中心医院",
    needs: ["PACS 双活", "影像存储"],
  });
  if (bothOwners) {
    addCustomer({
      id: CUSTOMER_B,
      owner: OWNER_B,
      name: "另一账号医院",
      needs: ["PACS"],
    });
  }
}

function upsert(snapshot = {}, match = matchFor()) {
  return repository.upsertNotice(notice(snapshot), match);
}

function conversionInput(overrides = {}) {
  return {
    owner: OWNER_A,
    noticeId: NOTICE_ID,
    customerId: CUSTOMER_A,
    ...overrides,
  };
}

function confirmInput(preview, overrides = {}) {
  return conversionInput({
    previewDigest: preview.previewDigest,
    confirmed: true,
    requestId: "bridge-confirm-request",
    ...overrides,
  });
}

function counts() {
  return {
    notices: Number(db.prepare("SELECT COUNT(*) AS count FROM hospital_tender_notices").get().count),
    bridges: Number(db.prepare("SELECT COUNT(*) AS count FROM hospital_tender_bridges").get().count),
    opportunities: Number(db.prepare("SELECT COUNT(*) AS count FROM opportunities").get().count),
    actionItems: Number(db.prepare("SELECT COUNT(*) AS count FROM action_items").get().count),
    audits: Number(db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count),
  };
}

function expectError(fn, status, code) {
  assert.throws(fn, (error) => error?.status === status && error?.code === code);
}

function bridgeFor(owner = OWNER_A, customerId = CUSTOMER_A) {
  return repository.getBridge({
    owner,
    noticeId: NOTICE_ID,
    customerId,
  });
}

function canonicalizeForDigest(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForDigest);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeForDigest(value[key])]),
    );
  }
  return value;
}

function digestPlan(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeForDigest(value)), "utf8")
    .digest("hex");
}

function legacyConfirmationReceipt(preview) {
  const legacyIdentity = createHash("sha256")
    .update(JSON.stringify([
      "hospital_tender_lead_conversion",
      1,
      OWNER_A,
      preview.notice.identityKey,
      preview.customer.id,
    ]), "utf8")
    .digest("hex");
  const legacyOpportunityId = `tender-opportunity-${createHash("sha256")
    .update(`${legacyIdentity}:opportunity`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
  const legacyActionItemId = `tender-action-${createHash("sha256")
    .update(`${legacyIdentity}:action_item`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
  const legacyPlan = {
    schemaVersion: 1,
    conversionIdentity: legacyIdentity,
    noticeSnapshotDigest: preview.noticeSnapshotDigest,
    owner: OWNER_A,
    notice: {
      id: preview.notice.id,
      identityKey: preview.notice.identityKey,
      sourceId: preview.notice.sourceId,
      sourceName: preview.notice.sourceName,
      url: preview.notice.url,
      title: preview.notice.title,
      publishedAt: preview.notice.publishedAt,
      projectCode: preview.notice.projectCode,
    },
    customer: preview.customer,
    match: preview.match,
    drafts: {
      opportunity: { ...preview.drafts.opportunity, id: legacyOpportunityId },
      actionItem: {
        ...preview.drafts.actionItem,
        id: legacyActionItemId,
        opportunityId: legacyOpportunityId,
      },
    },
  };
  const common = {
    previewDigest: digestPlan(legacyPlan),
    conversionIdentity: legacyIdentity,
    noticeSnapshotDigest: preview.noticeSnapshotDigest,
    noticeIdentityKey: preview.notice.identityKey,
    owner: OWNER_A,
    customerId: preview.customer.id,
    opportunityId: legacyOpportunityId,
    actionItemId: legacyActionItemId,
    matchScore: preview.match.score,
  };
  return {
    after: {
      schemaVersion: 1,
      ...common,
      noticeId: preview.notice.id,
    },
    metadata: common,
  };
}

function replaceAuditReceipt(receipt) {
  const audit = db.prepare("SELECT id FROM audit_logs LIMIT 1").get();
  db.prepare(`
    UPDATE audit_logs
       SET after_json = $after,
           metadata_json = $metadata
     WHERE id = $id
  `).run({
    $id: audit.id,
    $after: JSON.stringify(receipt.after),
    $metadata: JSON.stringify(receipt.metadata),
  });
}

function removeBridgeProjection() {
  db.prepare("DELETE FROM hospital_tender_bridges").run();
  db.prepare(`
    UPDATE hospital_tender_notices
       SET bridge_status = 'unbridged',
           bridge_refs_json = '[]'
  `).run();
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  now = "2026-08-31T03:00:00.000Z";
  repository = createHospitalTenderRepository(db, {
    clock: () => new Date(now),
  });
  service = createHospitalTenderLeadConversionService({
    db,
    tenderRepository: repository,
    clock: () => new Date(now),
  });
});

afterEach(() => {
  db.close();
  db = null;
  repository = null;
  service = null;
});

describe("hospital tender canonical bridge", () => {
  it("repairs a legacy null content digest before creating an owner bridge", () => {
    addStandardCustomers();
    const stored = upsert();
    db.prepare(`
      UPDATE hospital_tender_notices
         SET content_sha256 = NULL,
             canonical_notice_id = NULL,
             canonical_digest = NULL,
             canonical_revision = 1,
             bridge_status = 'unbridged',
             bridge_refs_json = '[]'
       WHERE id = $id
    `).run({ $id: stored.id });

    const hydrated = repository.getNotice(stored.id);
    assert.equal(hydrated.canonicalRevision, 1);
    assert.equal(hydrated.contentSha256, contentDigest(hydrated.contentText));
    assert.equal(
      db.prepare("SELECT content_sha256 FROM hospital_tender_notices WHERE id = $id").get({ $id: stored.id }).content_sha256,
      contentDigest(hydrated.contentText),
    );
    assert.equal(
      hydrated.canonicalDigest,
      canonicalNoticeDigest(notice(), { canonicalNoticeId: hydrated.canonicalNoticeId }),
    );
    assert.match(hydrated.canonicalNoticeId, /^project:/u);

    const bridge = repository.ensureBridge({
      owner: OWNER_A,
      noticeId: stored.id,
      customerId: CUSTOMER_A,
    });
    assert.equal(bridge.status, "unconverted");
    assert.equal(bridge.noticeRevision, 1);
    assert.equal(bridge.noticeDigest, hydrated.canonicalDigest);
    assert.deepEqual(repository.getNoticeForOwner(stored.id, OWNER_A).bridgeRefs, [bridge]);
  });

  it("converges equivalent cross-source notices and keeps conversion identity stable", () => {
    addStandardCustomers();
    const first = upsert();
    const firstPreview = service.preview(conversionInput());
    const firstConfirmation = service.confirm(confirmInput(firstPreview));

    const second = upsert({
      id: "source-b-row",
      identityKey: "source-b:notice-998",
      sourceId: "source-b",
      sourceName: "公开采购平台 B",
      url: "https://source-b.example/tender/998",
      sourceItemId: "notice-998",
    });

    assert.equal(second.id, first.id);
    assert.equal(repository.countNotices(), 1);
    assert.equal(second.canonicalNoticeId, first.canonicalNoticeId);
    assert.equal(second.canonicalRevision, first.canonicalRevision);
    assert.equal(second.canonicalDigest, first.canonicalDigest);
    assert.equal(second.identityKey, first.identityKey);
    assert.equal(second.sourceId, first.sourceId);
    assert.equal(second.url, first.url);

    const secondPreview = service.preview(conversionInput());
    assert.equal(secondPreview.conversionIdentity, firstPreview.conversionIdentity);
    assert.equal(secondPreview.previewDigest, firstPreview.previewDigest);
    assert.equal(secondPreview.noticeSnapshotDigest, firstPreview.noticeSnapshotDigest);
    assert.equal(
      secondPreview.drafts.opportunity.id,
      firstPreview.drafts.opportunity.id,
    );
    assert.equal(
      secondPreview.drafts.actionItem.id,
      firstPreview.drafts.actionItem.id,
    );
    assert.equal(secondPreview.canonicalRevision, firstPreview.canonicalRevision);
    assert.equal(secondPreview.canonicalDigest, firstPreview.canonicalDigest);

    const replayed = service.confirm(confirmInput(secondPreview, { requestId: "source-b-replay" }));
    assert.equal(firstConfirmation.replayed, false);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.opportunity.id, firstConfirmation.opportunity.id);
    assert.equal(replayed.actionItem.id, firstConfirmation.actionItem.id);
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 1,
      actionItems: 1,
      audits: 1,
    });
    assert.equal(bridgeFor().status, "confirmed");
  });

  it("does not merge the same bare project code across different purchasers", () => {
    const first = upsert({
      purchaser: "采购人甲",
      projectCode: "SHARED-001",
      title: "采购人甲影像系统项目",
      hospitalNames: ["采购人甲医院"],
    }, matchFor([]));
    const second = upsert({
      id: "tender-bridge-2",
      identityKey: "source-b:item-2",
      sourceId: "source-b",
      sourceName: "公开采购平台 B",
      url: "https://source-b.example/notices/2",
      purchaser: "采购人乙",
      projectCode: "SHARED-001",
      title: "采购人乙网络改造项目",
      contentText: "采购网络改造服务。",
      hospitalNames: ["采购人乙医院"],
      sourceItemId: "item-2",
    }, matchFor([]));

    assert.notEqual(second.id, first.id);
    assert.notEqual(second.canonicalNoticeId, first.canonicalNoticeId);
    assert.equal(repository.countNotices(), 2);
  });

  it("normalizes equivalent published timestamps in canonical identity and digest", () => {
    const first = upsert({
      projectCode: null,
      publishedAt: "2026-08-30T08:00:00.000Z",
    }, matchFor([]));
    const second = upsert({
      id: "source-b-row",
      identityKey: "source-b:timezone-equivalent",
      sourceId: "source-b",
      sourceName: "公开采购平台 B",
      url: "https://source-b.example/timezone-equivalent",
      projectCode: null,
      sourceItemId: "timezone-equivalent",
      publishedAt: "2026-08-30T16:00:00+08:00",
    }, matchFor([]));

    assert.equal(second.id, first.id);
    assert.equal(second.canonicalNoticeId, first.canonicalNoticeId);
    assert.equal(second.canonicalDigest, first.canonicalDigest);
    assert.equal(second.canonicalRevision, first.canonicalRevision);
    assert.equal(second.publishedAt, first.publishedAt);
    assert.equal(repository.countNotices(), 1);
  });

  it("does not advance canonical revision for routing-only or relevance changes", () => {
    addStandardCustomers();
    const initial = upsert();
    const routingOnly = upsert({
      id: "source-b-row",
      identityKey: "source-b:notice-2",
      sourceId: "source-b",
      sourceName: "另一个来源",
      url: "https://source-b.example/tender/2",
      sourceItemId: "source-b-2",
    });
    const relevanceOnly = upsert({ relevance: "medium" });
    const sameCanonicalSnapshot = upsert({ relevance: "medium" });
    const changedCanonical = upsert({
      title: "青岛市中心医院 PACS 存储扩容及归档项目",
      contentText: "采购 PACS 双活存储并增加归档节点。",
    });
    const repeatedCanonicalSnapshot = upsert({
      title: "青岛市中心医院 PACS 存储扩容及归档项目",
      contentText: "采购 PACS 双活存储并增加归档节点。",
    });
    const restoredCanonicalSnapshot = upsert();

    assert.equal(routingOnly.canonicalRevision, initial.canonicalRevision);
    assert.equal(routingOnly.canonicalDigest, initial.canonicalDigest);
    assert.equal(relevanceOnly.canonicalRevision, initial.canonicalRevision);
    assert.equal(relevanceOnly.canonicalDigest, initial.canonicalDigest);
    assert.equal(sameCanonicalSnapshot.canonicalRevision, initial.canonicalRevision);
    assert.equal(changedCanonical.canonicalRevision, initial.canonicalRevision + 1);
    assert.notEqual(changedCanonical.canonicalDigest, initial.canonicalDigest);
    assert.equal(repeatedCanonicalSnapshot.canonicalRevision, changedCanonical.canonicalRevision);
    assert.equal(restoredCanonicalSnapshot.canonicalRevision, changedCanonical.canonicalRevision + 1);
    assert.equal(repository.countNotices(), 1);
  });

  it("marks a stale notice bridge as conflict and permits a fresh preview before confirmation", () => {
    addStandardCustomers();
    upsert();
    const originalPreview = service.preview(conversionInput());
    const originalRevision = originalPreview.canonicalRevision;

    const changed = upsert({
      contentText: "采购 PACS 双活存储，交付范围发生变化。",
    });
    assert.equal(changed.canonicalRevision, originalRevision + 1);

    const ownerNotice = repository.getNoticeForOwner(NOTICE_ID, OWNER_A);
    assert.equal(ownerNotice.bridgeStatus, "conflict");
    assert.equal(ownerNotice.bridgeRefs.length, 1);
    assert.equal(ownerNotice.bridgeRefs[0].status, "conflict");

    expectError(
      () => service.confirm(confirmInput(originalPreview, { requestId: "stale-notice" })),
      409,
      "PREVIEW_STALE",
    );
    assert.equal(bridgeFor().status, "conflict");

    const freshPreview = service.preview(conversionInput());
    assert.equal(freshPreview.canonicalRevision, originalRevision + 1);
    assert.equal(freshPreview.bridge.status, "previewed");
    const confirmed = service.confirm(confirmInput(freshPreview, { requestId: "fresh-notice" }));
    assert.equal(confirmed.status, "confirmed");
    assert.equal(bridgeFor().status, "confirmed");
  });

  it("keeps bridge references owner-scoped while exposing a global notice without refs", () => {
    addStandardCustomers({ bothOwners: true });
    upsert({}, matchFor([CUSTOMER_A, CUSTOMER_B]));

    const previewA = service.preview(conversionInput());
    const previewB = service.preview(conversionInput({
      owner: OWNER_B,
      customerId: CUSTOMER_B,
    }));
    assert.notEqual(previewA.bridge.id, previewB.bridge.id);
    assert.equal(repository.listBridges({ owner: OWNER_A }).length, 1);
    assert.equal(repository.listBridges({ owner: OWNER_B }).length, 1);

    const globalNotice = repository.getNotice(NOTICE_ID);
    assert.deepEqual(globalNotice.bridgeRefs, []);
    assert.equal(globalNotice.bridgeStatus, "unbridged");

    const ownerANotice = repository.getNoticeForOwner(NOTICE_ID, OWNER_A);
    const ownerBNotice = repository.getCanonicalNoticeForOwner(
      previewA.canonicalNoticeId,
      OWNER_B,
    );
    assert.deepEqual(ownerANotice.bridgeRefs.map((ref) => ref.owner), [OWNER_A]);
    assert.deepEqual(ownerBNotice.bridgeRefs.map((ref) => ref.owner), [OWNER_B]);
    assert.deepEqual(
      repository.listNoticesForOwner({}, OWNER_A)[0].bridgeRefs.map((ref) => ref.owner),
      [OWNER_A],
    );

    expectError(
      () => service.preview(conversionInput({ owner: OWNER_B, customerId: CUSTOMER_A })),
      404,
      "NOT_FOUND",
    );
    expectError(
      () => service.preview(conversionInput({ owner: OWNER_A, customerId: CUSTOMER_B })),
      404,
      "NOT_FOUND",
    );
    expectError(
      () => repository.getBridge({
        owner: OWNER_B,
        noticeId: NOTICE_ID,
        customerId: CUSTOMER_A,
      }),
      404,
      "NOT_FOUND",
    );
  });

  it("filters bridge lists and notice refs for a soft-deleted customer", () => {
    addStandardCustomers();
    upsert();
    service.preview(conversionInput());
    assert.equal(repository.listBridges({ owner: OWNER_A }).length, 1);

    db.prepare(`
      UPDATE customers
         SET deleted_at = $deletedAt
       WHERE id = $id
    `).run({
      $id: CUSTOMER_A,
      $deletedAt: "2026-09-06T00:00:00.000Z",
    });

    const ownerNotice = repository.getNoticeForOwner(NOTICE_ID, OWNER_A);
    assert.deepEqual(ownerNotice.bridgeRefs, []);
    assert.equal(ownerNotice.bridgeStatus, "unbridged");
    assert.deepEqual(repository.listBridges({ owner: OWNER_A }), []);
    expectError(
      () => repository.getBridge({
        owner: OWNER_A,
        noticeId: NOTICE_ID,
        customerId: CUSTOMER_A,
      }),
      404,
      "NOT_FOUND",
    );
    assert.equal(
      Number(db.prepare("SELECT COUNT(*) AS count FROM hospital_tender_bridges").get().count),
      1,
    );
  });

  it("rejects changed match, customer, and reviewed snapshot evidence before any write", () => {
    addStandardCustomers();
    upsert();
    const preview = service.preview(conversionInput());

    const assertions = [
      ["canonicalNoticeId", "different-canonical-id"],
      ["noticeRevision", preview.canonicalRevision + 1],
      ["noticeDigest", "0".repeat(64)],
      ["matchSnapshotDigest", "0".repeat(64)],
      ["customerSnapshotDigest", "0".repeat(64)],
      ["customerVersion", preview.customerVersion + 1],
      ["opportunitySnapshotDigest", "0".repeat(64)],
    ];
    for (const [field, value] of assertions) {
      expectError(
        () => service.confirm(confirmInput(preview, {
          requestId: `stale-${field}`,
          [field]: value,
        })),
        409,
        "PREVIEW_STALE",
      );
    }
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 0,
      actionItems: 0,
      audits: 0,
    });

    db.prepare(`
      UPDATE customers
         SET contact = 'changed-after-preview',
             version = version + 1
       WHERE id = $id
    `).run({ $id: CUSTOMER_A });
    expectError(
      () => service.confirm(confirmInput(preview, { requestId: "customer-changed" })),
      409,
      "PREVIEW_STALE",
    );
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 0,
      actionItems: 0,
      audits: 0,
    });
  });

  it("rejects changed persisted match evidence as a conflict", () => {
    addStandardCustomers();
    upsert();
    const preview = service.preview(conversionInput());
    upsert({}, {
      matchedCustomerIds: [CUSTOMER_A],
      matchReasons: { [CUSTOMER_A]: ["hospital_name"] },
      matchedNeeds: { [CUSTOMER_A]: ["PACS 双活"] },
      matchScore: 100,
    });

    expectError(
      () => service.confirm(confirmInput(preview, { requestId: "match-evidence-changed" })),
      409,
      "MATCH_EVIDENCE_STALE",
    );
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 0,
      actionItems: 0,
      audits: 0,
    });
  });

  it("cancels exactly one preview, replays exact cancellation, and rejects a wrong digest", () => {
    addStandardCustomers();
    upsert();
    const preview = service.preview(conversionInput());
    const cancelled = service.cancel(conversionInput({ previewDigest: preview.previewDigest }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.bridge.status, "cancelled");
    assert.equal(bridgeFor().status, "cancelled");

    const replayed = service.cancel(conversionInput({ previewDigest: preview.previewDigest }));
    assert.equal(replayed.status, "cancelled");
    assert.equal(replayed.previewDigest, preview.previewDigest);
    assert.equal(bridgeFor().status, "cancelled");

    expectError(
      () => service.cancel(conversionInput({ previewDigest: "0".repeat(64) })),
      409,
      "PREVIEW_STALE",
    );
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 0,
      actionItems: 0,
      audits: 0,
    });
  });

  it("passes exact reviewed bridge snapshots through the HTTP adapter", () => {
    addStandardCustomers();
    upsert();
    const handlers = createHospitalTenderLeadConversionHttpHandlers({ service });
    const route = (action) => `/api/hospital-tenders/${NOTICE_ID}/lead-conversion/${action}`;
    const previewResponse = handlers.handle({
      pathname: route("preview"),
      requestIdentity: { kind: "user", account: OWNER_A },
      body: { customerId: CUSTOMER_A },
    });
    const preview = previewResponse.body.item;
    const confirmed = handlers.handle({
      pathname: route("confirm"),
      requestIdentity: { kind: "user", account: OWNER_A },
      body: {
        customerId: CUSTOMER_A,
        previewDigest: preview.previewDigest,
        confirmed: true,
        canonicalNoticeId: preview.canonicalNoticeId,
        noticeRevision: preview.canonicalRevision,
        noticeDigest: preview.canonicalDigest,
        matchSnapshotDigest: preview.matchSnapshotDigest,
        customerSnapshotDigest: preview.customerSnapshotDigest,
        customerVersion: preview.customerVersion,
        opportunitySnapshotDigest: preview.opportunitySnapshotDigest,
      },
    });
    assert.equal(confirmed.body.item.status, "confirmed");
    assert.equal(confirmed.body.item.replayed, false);
    assert.equal(bridgeFor().status, "confirmed");
  });

  it("fails closed on a deterministic opportunity/action collision", () => {
    addStandardCustomers();
    upsert();
    const preview = service.preview(conversionInput());
    db.prepare(`
      INSERT INTO opportunities (
        id, customer_id, name, stage, owner, source_record
      ) VALUES (
        $id, $customerId, '伪造商机', '线索', 'other-owner', 'other-source'
      )
    `).run({
      $id: preview.drafts.opportunity.id,
      $customerId: CUSTOMER_A,
    });
    db.prepare(`
      INSERT INTO action_items (
        id, customer_id, opportunity_id, title, owner
      ) VALUES (
        $id, $customerId, $opportunityId, '伪造待办', 'other-owner'
      )
    `).run({
      $id: preview.drafts.actionItem.id,
      $customerId: CUSTOMER_A,
      $opportunityId: preview.drafts.opportunity.id,
    });

    expectError(
      () => service.confirm(confirmInput(preview, { requestId: "deterministic-collision" })),
      409,
      "CONVERSION_STATE_CONFLICT",
    );
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 1,
      actionItems: 1,
      audits: 0,
    });
    assert.equal(bridgeFor().status, "conflict");
  });

  it("requires an exact confirmation receipt for replay and never duplicates rows", () => {
    addStandardCustomers();
    upsert();
    const preview = service.preview(conversionInput());
    const first = service.confirm(confirmInput(preview));
    const replay = service.confirm(confirmInput(preview, { requestId: "replay-request" }));
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.opportunity.id, first.opportunity.id);
    assert.equal(replay.actionItem.id, first.actionItem.id);
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 1,
      actionItems: 1,
      audits: 1,
    });

    const audit = db.prepare("SELECT id, after_json FROM audit_logs LIMIT 1").get();
    const damaged = JSON.parse(audit.after_json);
    damaged.canonicalDigest = "0".repeat(64);
    db.prepare("UPDATE audit_logs SET after_json = $after WHERE id = $id").run({
      $id: audit.id,
      $after: JSON.stringify(damaged),
    });
    expectError(
      () => service.confirm(confirmInput(preview, { requestId: "damaged-replay" })),
      409,
      "CONVERSION_STATE_CONFLICT",
    );
    assert.equal(bridgeFor().status, "conflict");
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 1,
      actionItems: 1,
      audits: 1,
    });
  });

  it("adopts an exact v0.11 confirmation receipt into a post-0043 bridge", () => {
    addStandardCustomers();
    upsert();
    const originalPreview = service.preview(conversionInput());
    const originalConfirmation = service.confirm(confirmInput(originalPreview));
    const legacyReceipt = legacyConfirmationReceipt(originalPreview);
    db.prepare(`
      INSERT INTO opportunities (
        id,
        customer_id,
        name,
        customer,
        stage,
        amount,
        owner,
        probability,
        days,
        requirements,
        competitors,
        solution_direction,
        source_record,
        risk,
        next,
        tone,
        created_at,
        updated_at
      )
      SELECT
        $newId,
        customer_id,
        name,
        customer,
        stage,
        amount,
        owner,
        probability,
        days,
        requirements,
        competitors,
        solution_direction,
        source_record,
        risk,
        next,
        tone,
        created_at,
        updated_at
        FROM opportunities
       WHERE id = $oldId
    `).run({
      $oldId: originalConfirmation.opportunity.id,
      $newId: legacyReceipt.after.opportunityId,
    });
    db.prepare(`
      UPDATE action_items
         SET id = $newId,
             opportunity_id = $newOpportunityId
       WHERE id = $oldId
    `).run({
      $oldId: originalConfirmation.actionItem.id,
      $newId: legacyReceipt.after.actionItemId,
      $newOpportunityId: legacyReceipt.after.opportunityId,
    });
    db.prepare("DELETE FROM opportunities WHERE id = $id").run({
      $id: originalConfirmation.opportunity.id,
    });
    replaceAuditReceipt(legacyReceipt);
    removeBridgeProjection();

    const upgradedPreview = service.preview(conversionInput());
    assert.notEqual(upgradedPreview.previewDigest, legacyReceipt.after.previewDigest);
    assert.notEqual(upgradedPreview.conversionIdentity, legacyReceipt.after.conversionIdentity);
    const adopted = service.confirm(confirmInput(upgradedPreview, {
      requestId: "adopt-v011-receipt",
    }));

    assert.equal(adopted.replayed, true);
    assert.equal(adopted.opportunity.id, legacyReceipt.after.opportunityId);
    assert.equal(adopted.actionItem.id, legacyReceipt.after.actionItemId);
    assert.equal(bridgeFor().status, "confirmed");
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 1,
      actionItems: 1,
      audits: 1,
    });
  });

  it("fails closed for a malformed v0.11 receipt instead of adopting it", () => {
    addStandardCustomers();
    upsert({ canonicalNoticeId: "source-a:item-1" });
    const originalPreview = service.preview(conversionInput());
    service.confirm(confirmInput(originalPreview));
    const malformedReceipt = legacyConfirmationReceipt(originalPreview);
    malformedReceipt.metadata.previewDigest = "f".repeat(64);
    replaceAuditReceipt(malformedReceipt);
    removeBridgeProjection();

    const upgradedPreview = service.preview(conversionInput());
    expectError(
      () => service.confirm(confirmInput(upgradedPreview, {
        requestId: "reject-malformed-v011-receipt",
      })),
      409,
      "CONVERSION_STATE_CONFLICT",
    );
    assert.equal(bridgeFor().status, "conflict");
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 1,
      actionItems: 1,
      audits: 1,
    });
  });

  it("rolls back business rows when bridge confirmation cannot transition", () => {
    addStandardCustomers();
    upsert();
    const preview = service.preview(conversionInput());
    db.exec(`
      CREATE TEMP TRIGGER fail_hospital_tender_bridge_confirm
      BEFORE UPDATE ON hospital_tender_bridges
      WHEN NEW.status = 'confirmed'
      BEGIN
        SELECT RAISE(ABORT, 'injected bridge confirmation failure');
      END;
    `);

    assert.throws(
      () => service.confirm(confirmInput(preview, { requestId: "bridge-failpoint" })),
      /injected bridge confirmation failure/u,
    );
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 0,
      actionItems: 0,
      audits: 0,
    });
    assert.equal(bridgeFor().status, "previewed");

    db.exec("DROP TRIGGER fail_hospital_tender_bridge_confirm");
    const retry = service.confirm(confirmInput(preview, { requestId: "bridge-retry" }));
    assert.equal(retry.status, "confirmed");
    assert.deepEqual(counts(), {
      notices: 1,
      bridges: 1,
      opportunities: 1,
      actionItems: 1,
      audits: 1,
    });
  });
});
