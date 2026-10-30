import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { apply as applyNotices } from "../src/db/migrations/0014_hospital_tender_monitor.mjs";
import { apply as applyScheduler } from "../src/db/migrations/0016_hospital_tender_scheduler.mjs";
import { apply as applyBridges } from "../src/db/migrations/0043_hospital_tender_canonical_bridge.mjs";
import { apply as applySources } from "../src/db/migrations/0057_hospital_tender_notice_sources.mjs";
import { apply as applyDeliveryEvents } from "../src/db/migrations/0058_hospital_tender_delivery_events.mjs";
import { canonicalNoticeIdentity, canonicalNoticeIdentityCandidates, canonicalNoticePublicationDate } from "../src/hospitalTender/canonicalBridge.js";
import { createHospitalTenderLeadConversionService } from "../src/hospitalTender/leadConversion.js";
import { matchNoticeToCustomers } from "../src/hospitalTender/matching.js";
import { createHospitalTenderNotificationEventRepository } from "../src/hospitalTender/notificationEventRepository.js";
import { createHospitalTenderRepository, mergeNoticeMatches } from "../src/hospitalTender/repository.js";

function notice(overrides = {}) {
  return {
    id: "notice-a", identityKey: "source-a:item-a", sourceId: "source-a",
    sourceName: "医院官网", city: "济宁市", title: "济宁市第一人民医院信息化项目采购公告",
    url: "https://hospital.example/a", publishedAt: "2026-10-20T00:00:00.000Z",
    noticeType: "procurement_notice", purchaser: "济宁市第一人民医院", projectCode: "JN-2026-001",
    budgetText: "200万元", deadlineText: "2026-11-01", contentText: "采购信息化存储设备。",
    hospitalNames: ["济宁市第一人民医院"], sourceItemId: "item-a", relevance: "high",
    ...overrides,
  };
}

function otherSource(overrides = {}) {
  return notice({
    id: "notice-b", identityKey: "source-b:item-b", sourceId: "source-b",
    sourceName: "公共采购平台", sourceItemId: "item-b", url: "https://public.example/b",
    ...overrides,
  });
}

function setup({ migrated = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE customers (id TEXT PRIMARY KEY, owner TEXT NOT NULL, deleted_at TEXT, version INTEGER DEFAULT 1);
    INSERT INTO customers (id, owner) VALUES ('customer-a', 'owner-a');`);
  applyNotices(db);
  applyScheduler(db);
  applyBridges(db);
  if (migrated) applySources(db);
  return {
    db,
    repository: createHospitalTenderRepository(db, { clock: () => new Date("2026-10-24T00:00:00.000Z") }),
  };
}

function confirmedBridge(repository, saved) {
  const input = {
    owner: "owner-a", customerId: "customer-a", noticeId: saved.id,
    noticeRevision: saved.canonicalRevision, noticeDigest: saved.canonicalDigest,
    previewDigest: "a".repeat(64),
  };
  repository.recordBridgePreview(input);
  return repository.confirmBridge({ ...input, opportunityId: "opportunity-a", actionItemId: "action-a" });
}

function bridge(repository) {
  return repository.getBridge({ owner: "owner-a", customerId: "customer-a", noticeId: "notice-a" });
}

function count(db, table) {
  return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
}

describe("hospital tender notice identity reliability", () => {
  it("keeps procurement, clarification, award and cancellation independently under one project", () => {
    const { db, repository } = setup();
    try {
      const saved = ["procurement_notice", "clarification", "bid_result", "bid_cancelled"].map((noticeType, i) => (
        repository.upsertNotice(notice({ id: `phase-${i}`, identityKey: `a:phase-${i}`, noticeType }))
      ));
      assert.equal(new Set(saved.map((item) => item.canonicalNoticeId)).size, 4);
      assert.equal(count(db, "hospital_tender_notices"), 4);
      assert.equal(db.prepare("SELECT count(DISTINCT project_identity) AS n FROM hospital_tender_notices").get().n, 1);
      assert.ok(saved.every((item) => item.canonicalRevision === 1));
    } finally { db.close(); }
  });

  it("converges same-stage sources, stores both URLs, and replays mappings after repository restart", () => {
    const { db, repository } = setup();
    try {
      const first = repository.upsertNotice(notice());
      const second = repository.upsertNotice(otherSource());
      assert.equal(second.id, first.id);
      assert.equal(second.canonicalRevision, first.canonicalRevision);
      assert.equal(count(db, "hospital_tender_notice_sources"), 2);
      assert.deepEqual(db.prepare("SELECT url FROM hospital_tender_notice_sources ORDER BY source_id").all()
        .map((row) => row.url), ["https://hospital.example/a", "https://public.example/b"]);
      const restarted = createHospitalTenderRepository(db);
      assert.equal(restarted.upsertNotice(otherSource()).canonicalNoticeId, first.canonicalNoticeId);
      assert.equal(count(db, "hospital_tender_notice_sources"), 2);
    } finally { db.close(); }
  });

  it("uses the publication day to distinguish repeated same-stage notices", () => {
    const { db, repository } = setup();
    try {
      const first = repository.upsertNotice(notice());
      const sameDay = repository.upsertNotice(otherSource({ publishedAt: "2026-10-20T08:00:00.000Z" }));
      const nextDay = repository.upsertNotice(otherSource({
        id: "notice-c", identityKey: "source-b:item-c", sourceItemId: "item-c",
        publishedAt: "2026-10-21T00:00:00.000Z",
      }));
      assert.equal(sameDay.id, first.id);
      assert.equal(sameDay.canonicalRevision, first.canonicalRevision);
      assert.notEqual(nextDay.canonicalNoticeId, first.canonicalNoticeId);
      assert.equal(count(db, "hospital_tender_notices"), 2);
    } finally { db.close(); }
  });

  it("uses the Shanghai publication day across UTC boundaries and calendar rollovers", () => {
    const cases = [
      ["2026-10-20", "2026-10-20"],
      ["2026-10-20T00:00:00.000Z", "2026-10-20"],
      ["2026-10-20T00:00:00+08:00", "2026-10-20"],
      ["2026-10-20T00:00:00", "2026-10-20"],
      ["2026-10-20T18:30:00", "2026-10-21"],
      ["2026-10-19T15:59:59.999Z", "2026-10-19"],
      ["2026-10-19T16:00:00.000Z", "2026-10-20"],
      ["2026-10-20T15:59:59.999Z", "2026-10-20"],
      ["2026-10-20T16:00:00.000Z", "2026-10-21"],
      ["2026-12-31T16:00:00.000Z", "2027-01-01"],
      ["2024-02-28T16:00:00.000Z", "2024-02-29"],
    ];
    for (const [publishedAt, expected] of cases) {
      assert.equal(canonicalNoticePublicationDate({ publishedAt }), expected, publishedAt);
      assert.equal(canonicalNoticePublicationDate({ published_at: publishedAt }), expected, publishedAt);
    }
  });

  it("converges UTC-midnight and Shanghai-midnight sources while preserving a confirmed bridge", () => {
    for (const projectCode of ["JN-2026-001", null]) {
      const { db, repository } = setup();
      try {
        const first = repository.upsertNotice(notice({ projectCode }));
        confirmedBridge(repository, first);
        const second = repository.upsertNotice(otherSource({ projectCode, publishedAt: "2026-10-19T16:00:00.000Z" }));
        assert.equal(second.id, first.id);
        assert.equal(second.canonicalDigest, first.canonicalDigest);
        assert.equal(second.canonicalRevision, first.canonicalRevision);
        assert.equal(bridge(repository).status, "confirmed");
        const nextDay = repository.upsertNotice(otherSource({
          projectCode, publishedAt: "2026-10-20T16:00:00.000Z", id: "notice-c", identityKey: "source-b:item-c", sourceItemId: "item-c",
        }));
        assert.notEqual(nextDay.canonicalNoticeId, first.canonicalNoticeId);
        assert.deepEqual(db.prepare("SELECT published_date FROM hospital_tender_notice_sources ORDER BY source_id, identity_key").all()
          .map((row) => row.published_date), ["2026-10-20", "2026-10-20", "2026-10-21"]);
      } finally { db.close(); }
    }
  });

  it("does not merge different project codes that reuse a generic title", () => {
    const { db, repository } = setup();
    try {
      const first = repository.upsertNotice(notice());
      const second = repository.upsertNotice(otherSource({ projectCode: "JN-2026-002" }));
      assert.notEqual(second.id, first.id);
      const candidates = new Set(canonicalNoticeIdentityCandidates(first));
      assert.ok(!canonicalNoticeIdentityCandidates(second).some((candidate) => candidates.has(candidate)));
    } finally { db.close(); }
  });

  it("does not merge a source-local item key used by a different source", () => {
    const { db, repository } = setup();
    try {
      const first = repository.upsertNotice(notice());
      const second = repository.upsertNotice(otherSource({
        identityKey: "source-a:item-a", projectCode: "OTHER-2026", purchaser: "济宁市中医院",
        title: "济宁市中医院设备采购", hospitalNames: ["济宁市中医院"],
      }));
      assert.notEqual(second.id, first.id);
    } finally { db.close(); }
  });

  it("ignores source hospital arrays for code-less identity and preserves a confirmed bridge", () => {
    const { db, repository } = setup();
    try {
      const first = repository.upsertNotice(notice({ projectCode: null }));
      const confirmed = confirmedBridge(repository, first);
      const second = repository.upsertNotice(otherSource({
        projectCode: null, hospitalNames: ["济宁市第一人民医院", "济宁一院", "来源页面附带医院"],
      }));
      assert.equal(second.id, first.id);
      assert.equal(second.canonicalRevision, first.canonicalRevision);
      assert.equal(second.canonicalDigest, first.canonicalDigest);
      assert.equal(bridge(repository).id, confirmed.id);
      assert.equal(bridge(repository).status, "confirmed");
      assert.equal(count(db, "hospital_tender_notices"), 1);
    } finally { db.close(); }
  });

  it("does not erase a previously extracted budget on list-only refresh", () => {
    const { db, repository } = setup();
    try {
      const first = repository.upsertNotice(notice());
      const second = repository.upsertNotice(otherSource({ budgetText: null }));
      assert.equal(second.budgetText, first.budgetText);
      assert.equal(second.canonicalDigest, first.canonicalDigest);
    } finally { db.close(); }
  });

  it("drops legacy city-only matches while retaining formally identified customers across batches", () => {
    const previous = {
      matchedCustomerIds: ["named-hospital", "same-city-hospital"],
      matchReasons: { "named-hospital": ["hospital_name", "city"], "same-city-hospital": ["city", "need"] },
      matchedNeeds: { "named-hospital": [], "same-city-hospital": ["信息化"] }, matchScore: 75,
    };
    const incoming = {
      matchedCustomerIds: ["next-batch-hospital"], matchReasons: { "next-batch-hospital": ["hospital_name"] },
      matchedNeeds: { "next-batch-hospital": [] }, matchScore: 60,
    };
    const merged = mergeNoticeMatches(previous, incoming);
    assert.deepEqual(merged.matchedCustomerIds, ["named-hospital", "next-batch-hospital"]);
    assert.equal(merged.matchReasons["same-city-hospital"], undefined);
    assert.equal(merged.matchedNeeds["same-city-hospital"], undefined);
    assert.deepEqual(mergeNoticeMatches({ ...previous, matchedCustomerIds: ["same-city-hospital"] }, {}).matchedCustomerIds, []);
  });

  it("backfills legacy project identities and source mapping without changing canonical or bridge references", () => {
    const { db, repository } = setup({ migrated: false });
    try {
      const legacyProjectId = `project:${createHash("sha256")
        .update("济宁市第一人民医院|jn2026001").digest("hex").slice(0, 48)}`;
      const first = repository.upsertNotice(notice({ canonicalNoticeId: legacyProjectId }));
      const confirmed = confirmedBridge(repository, first);
      const before = db.prepare("SELECT * FROM hospital_tender_notices").get();
      applySources(db);
      applySources(db);
      const after = db.prepare("SELECT * FROM hospital_tender_notices").get();
      const { project_identity: projectIdentity, ...preserved } = after;
      assert.deepEqual(preserved, { ...before });
      assert.equal(projectIdentity, legacyProjectId);
      const upgraded = createHospitalTenderRepository(db);
      const award = upgraded.upsertNotice(otherSource({ noticeType: "bid_result", title: "信息化项目中标公告" }));
      assert.notEqual(award.canonicalNoticeId, legacyProjectId);
      assert.equal(upgraded.getNoticeByCanonicalId(legacyProjectId).id, first.id);
      assert.equal(bridge(upgraded).id, confirmed.id);
      assert.equal(bridge(upgraded).status, "confirmed");
      const replay = upgraded.upsertNotice(otherSource());
      assert.equal(replay.canonicalNoticeId, legacyProjectId);
      assert.equal(bridge(upgraded).status, "confirmed");
      const changed = upgraded.upsertNotice(otherSource({ budgetText: "300万元" }));
      assert.equal(changed.canonicalRevision, first.canonicalRevision + 1);
      assert.equal(bridge(upgraded).status, "conflict");
      assert.equal(bridge(upgraded).opportunityId, "opportunity-a");
      assert.equal(count(db, "hospital_tender_notice_sources"), 3);
      assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  });

  it("repairs missing canonical IDs without reintroducing project-level collisions across stages", () => {
    const { db, repository } = setup();
    try {
      repository.upsertNotice(notice());
      repository.upsertNotice(otherSource({ noticeType: "bid_result" }));
      db.exec("UPDATE hospital_tender_notices SET canonical_notice_id = NULL, canonical_digest = NULL");
      const procurement = repository.getNotice("notice-a");
      const award = repository.getNotice("notice-b");
      assert.notEqual(procurement.canonicalNoticeId, award.canonicalNoticeId);
      assert.equal(repository.getNoticeByCanonicalId(procurement.canonicalNoticeId).id, procurement.id);
    } finally { db.close(); }
  });

  it("backfills null canonical IDs before the quiet delivery baseline and keeps historical replays silent", () => {
    const timestamps = ["2026-10-19T16:00:00.000Z", "2026-10-20", "2026-12-31T16:00:00.000Z", "2024-02-28T16:00:00.000Z", "2026-10-20T18:30:00"];
    const cases = ["JN-2026-001", null].flatMap((projectCode) => timestamps.map((publishedAt) => ({ projectCode, publishedAt })));
    for (const { projectCode, publishedAt } of cases) {
      const { db, repository } = setup({ migrated: false });
      try {
        const original = notice({ projectCode, publishedAt });
        const expectedDay = canonicalNoticePublicationDate(original);
        const match = { matchedCustomerIds: ["customer-a"], matchReasons: { "customer-a": ["hospital_name"] } };
        repository.upsertNotice(original, match);
        db.exec("UPDATE hospital_tender_notices SET canonical_notice_id = NULL, canonical_digest = NULL");
        applySources(db);
        const backfilled = db.prepare("SELECT canonical_notice_id FROM hospital_tender_notices").get().canonical_notice_id;
        assert.equal(backfilled, canonicalNoticeIdentity(original));
        assert.equal(db.prepare("SELECT published_date FROM hospital_tender_notice_sources").get().published_date, expectedDay);
        applyDeliveryEvents(db);
        const upgraded = createHospitalTenderRepository(db);
        const events = createHospitalTenderNotificationEventRepository(db);
        db.exec("BEGIN IMMEDIATE");
        const replay = upgraded.upsertNotice(otherSource({ projectCode, publishedAt: `${expectedDay}T00:00:00.000Z` }), match);
        assert.equal(replay.canonicalNoticeId, backfilled);
        const queued = events.enqueue({
          notices: [replay], sourceNotices: [original], customers: [{ id: "customer-a", name: original.purchaser }],
          batchCustomerIds: ["customer-a"], cycleNumber: 1, enabled: true,
        });
        db.exec("COMMIT");
        assert.equal(queued.noticeCount, 0);
        assert.equal(queued.batchId, null);
        assert.equal(count(db, "hospital_tender_notification_events"), 1);
        assert.equal(db.prepare("SELECT status FROM hospital_tender_notification_events").get().status, "acknowledged");
        assert.deepEqual(events.pending({ activeCustomerIds: ["customer-a"] }), []);
        assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      } finally { db.close(); }
    }
  });

  it("backfills legacy Shanghai days without rewriting existing canonical IDs or confirmed bridge receipts", () => {
    const { db, repository } = setup({ migrated: false });
    try {
      const first = repository.upsertNotice(notice({ canonicalNoticeId: "project:stable-legacy", publishedAt: "2026-10-19T16:00:00.000Z" }));
      confirmedBridge(repository, first);
      const before = db.prepare("SELECT * FROM hospital_tender_bridges").all();
      applySources(db);
      assert.equal(db.prepare("SELECT canonical_notice_id FROM hospital_tender_notices").get().canonical_notice_id, first.canonicalNoticeId);
      assert.deepEqual(db.prepare("SELECT * FROM hospital_tender_bridges").all(), before);
      const upgraded = createHospitalTenderRepository(db);
      const replay = upgraded.upsertNotice(otherSource());
      assert.equal(replay.canonicalNoticeId, first.canonicalNoticeId);
      assert.equal(bridge(upgraded).status, "confirmed");
      assert.equal(db.prepare("SELECT count(DISTINCT published_date) AS n FROM hospital_tender_notice_sources").get().n, 1);
    } finally { db.close(); }
  });

  it("keeps legacy duplicate rows distinct when backfilling missing canonical IDs", () => {
    const { db, repository } = setup({ migrated: false });
    try {
      repository.upsertNotice(notice());
      repository.upsertNotice(otherSource({ projectCode: "OTHER-2026" }));
      db.exec("UPDATE hospital_tender_notices SET project_code = 'JN-2026-001', canonical_notice_id = NULL, canonical_digest = NULL");
      applySources(db);
      assert.equal(db.prepare("SELECT count(DISTINCT canonical_notice_id) AS n FROM hospital_tender_notices").get().n, 2);
      assert.equal(count(db, "hospital_tender_notice_sources"), 2);
      const upgraded = createHospitalTenderRepository(db);
      assert.throws(() => upgraded.upsertNotice(notice()), (error) => error.code === "NOTICE_CANONICAL_AMBIGUITY");
    } finally { db.close(); }
  });

  it("restores a missing canonical ID from an existing confirmed bridge without rewriting its receipt", () => {
    const { db, repository } = setup({ migrated: false });
    try {
      const first = repository.upsertNotice(notice({ canonicalNoticeId: "project:confirmed-legacy" }));
      confirmedBridge(repository, first);
      const before = db.prepare("SELECT * FROM hospital_tender_bridges").all();
      db.exec("UPDATE hospital_tender_notices SET canonical_notice_id = NULL");
      applySources(db);
      applySources(db);
      assert.equal(db.prepare("SELECT canonical_notice_id FROM hospital_tender_notices").get().canonical_notice_id, first.canonicalNoticeId);
      assert.deepEqual(db.prepare("SELECT * FROM hospital_tender_bridges").all(), before);
      const upgraded = createHospitalTenderRepository(db);
      assert.equal(upgraded.upsertNotice(otherSource()).canonicalNoticeId, first.canonicalNoticeId);
      assert.equal(bridge(upgraded).status, "confirmed");
    } finally { db.close(); }
  });

  it("scopes explicit legacy project IDs and recycled source keys to the stage for notification grouping", () => {
    const procurement = notice({ canonicalNoticeId: "project:legacy", identityKey: "recycled-project-key" });
    const award = { ...procurement, noticeType: "bid_result" };
    const first = new Set(canonicalNoticeIdentityCandidates(procurement));
    assert.ok(!canonicalNoticeIdentityCandidates(award).some((candidate) => first.has(candidate)));
    assert.ok(!first.has("project:legacy"));
  });

  it("separates recycled upstream row IDs and identity keys across stages and publication dates", () => {
    const { db, repository } = setup();
    try {
      const first = repository.upsertNotice(notice({ canonicalNoticeId: "project:recycled" }));
      const award = repository.upsertNotice(notice({ canonicalNoticeId: "project:recycled", noticeType: "bid_result" }));
      const republished = repository.upsertNotice(notice({ canonicalNoticeId: "project:recycled", publishedAt: "2026-10-21" }));
      assert.equal(new Set([first.id, award.id, republished.id]).size, 3);
      assert.equal(new Set([first.canonicalNoticeId, award.canonicalNoticeId, republished.canonicalNoticeId]).size, 3);
      assert.equal(repository.upsertNotice(notice({ canonicalNoticeId: "project:recycled", noticeType: "bid_result" })).id, award.id);
      assert.equal(count(db, "hospital_tender_notice_sources"), 3);
    } finally { db.close(); }
  });

  it("rolls back the notice update if persisting its source mapping fails", () => {
    const { db, repository } = setup();
    try {
      db.exec(`CREATE TRIGGER reject_source BEFORE INSERT ON hospital_tender_notice_sources
        BEGIN SELECT RAISE(ABORT, 'source fixture failure'); END;`);
      assert.throws(() => repository.upsertNotice(notice()), /source fixture failure/);
      assert.equal(count(db, "hospital_tender_notices"), 0);
    } finally { db.close(); }
  });

  it("keeps notice and source writes inside the caller's transaction", () => {
    const { db, repository } = setup();
    try {
      db.exec("BEGIN IMMEDIATE");
      repository.upsertNotice(notice());
      assert.equal(count(db, "hospital_tender_notice_sources"), 1);
      db.exec("ROLLBACK");
      assert.equal(count(db, "hospital_tender_notices"), 0);
      assert.equal(count(db, "hospital_tender_notice_sources"), 0);
    } finally { db.close(); }
  });

  it("replays a real confirmed conversion on the registered schema and ignores a later project phase", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      db.prepare("INSERT INTO customers (id, name, region, owner, needs) VALUES (?, ?, ?, ?, ?)")
        .run("customer-a", "济宁市第一人民医院", "济宁市", "owner-a", '["信息化"]');
      let repository = createHospitalTenderRepository(db);
      const original = notice({ canonicalNoticeId: "project:legacy-conversion" });
      const match = matchNoticeToCustomers(original, [{
        id: "customer-a", name: "济宁市第一人民医院", city: "济宁市", needs: ["信息化"],
      }]);
      repository.upsertNotice(original, match);
      let service = createHospitalTenderLeadConversionService({ db, tenderRepository: repository });
      const input = { owner: "owner-a", noticeId: original.id, customerId: "customer-a" };
      const preview = service.preview(input);
      const confirmation = { ...input, confirmed: true, previewDigest: preview.previewDigest, requestId: "confirm-legacy" };
      const first = service.confirm(confirmation);
      repository = createHospitalTenderRepository(db);
      service = createHospitalTenderLeadConversionService({ db, tenderRepository: repository });
      repository.upsertNotice(otherSource({ noticeType: "bid_result", title: "信息化项目中标公告" }), match);
      const replay = service.confirm({ ...confirmation, requestId: "replay-after-upgrade" });
      assert.equal(replay.replayed, true);
      assert.equal(replay.opportunity.id, first.opportunity.id);
      assert.equal(replay.actionItem.id, first.actionItem.id);
      assert.equal(count(db, "opportunities"), 1);
      assert.equal(count(db, "action_items"), 1);
      assert.equal(bridge(repository).status, "confirmed");
    } finally { db.close(); }
  });
});
