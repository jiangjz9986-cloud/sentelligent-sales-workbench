import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/db.js";
import { apply as applyDeliveryEvents } from "../src/db/migrations/0058_hospital_tender_delivery_events.mjs";
import { createHospitalTenderRepository } from "../src/hospitalTender/repository.js";
import { createHospitalTenderSchedulerRepository } from "../src/hospitalTender/schedulerRepository.js";
import { createHospitalTenderScheduler } from "../src/hospitalTender/scheduler.js";
import { normalizeCollectionProgress } from "../src/hospitalTender/collectionProgress.js";
import { createHospitalTenderNotificationEventRepository } from "../src/hospitalTender/notificationEventRepository.js";

const hospital = "济宁市第一人民医院";
function snapshot() {
  return {
    schemaVersion: "hospital-tender-snapshot-v1", generatedAt: "2026-10-24T00:00:00.000Z",
    notices: [{
      identityKey: "jining:notice-1", sourceId: "jining-ggzy", sourceName: "济宁市公共资源交易平台",
      city: "济宁市", title: `${hospital}网络安全采购公告`, purchaser: hospital,
      projectCode: "JN-2026-001", noticeType: "tender", publishedAt: "2026-10-23T08:00:00.000Z",
      url: "https://public.example.test/notice-1", hospitalNames: [], relevance: "high",
      budgetText: "30万元", contentText: "网络安全服务", contentSha256: "a".repeat(64),
    }], sources: [], runs: [],
  };
}

function fixture(overrides = {}) {
  const db = openDatabase({ databaseUrl: ":memory:" });
  applyDeliveryEvents(db);
  let instant = "2026-10-24T00:00:00.000Z";
  const clock = () => new Date(instant);
  const customers = overrides.customers ?? [{ id: "b", name: hospital, region: "济宁市" }];
  const tender = createHospitalTenderRepository(db, { clock });
  const state = createHospitalTenderSchedulerRepository(db, { clock });
  state.updateState({ batchSize: 1 });
  const options = {
    db, repository: state, tenderRepository: tender, customersProvider: () => customers, clock,
    runner: { run: async () => ({ payload: snapshot() }) }, ...overrides,
  };
  delete options.customers;
  return { db, tender, state, customers, options, scheduler: createHospitalTenderScheduler(options),
    advance: (value) => { instant = value; } };
}

test("notifies a hospital first matched in a later customer batch with advancing timestamps", async () => {
  const sent = [];
  const f = fixture({
    customers: [{ id: "a", name: "青岛市医院", region: "青岛市" }, { id: "b", name: hospital, region: "济宁市" }],
    notifier: async (payload) => { sent.push(payload); return payload.notices.length; },
  });
  try {
    await f.scheduler.runNext({ force: true });
    f.advance("2026-10-24T00:30:00.000Z");
    await f.scheduler.runNext({ force: true });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].notices[0].matchedCustomerNames, [hospital]);
    f.advance("2026-10-24T01:00:00.000Z");
    await f.scheduler.runNext({ force: true });
    await f.scheduler.runNext({ force: true });
    assert.equal(sent.length, 1);
  } finally { f.db.close(); }
});

test("recovers a committed notice event after a crash before notification without duplicate delivery", async () => {
  let fail = true;
  const sent = [];
  const f = fixture({
    onBatchCommitted: () => { if (fail) { fail = false; throw new Error("synthetic process interruption"); } },
    notifier: async (payload) => { sent.push(payload); return payload.notices.length; },
  });
  try {
    await assert.rejects(f.scheduler.runNext({ force: true }), /synthetic process interruption/u);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM hospital_tender_notification_batches WHERE status='pending'").get().n, 1);
    f.advance("2026-10-24T00:30:00.000Z");
    const restarted = createHospitalTenderScheduler(f.options);
    assert.equal((await restarted.runNext({ force: true })).status, "success");
    assert.equal(sent.length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM hospital_tender_notification_events WHERE status='acknowledged'").get().n, 1);
    await restarted.runNext({ force: true });
    assert.equal(sent.length, 1);
  } finally { f.db.close(); }
});

test("retries the frozen notification after customer display names change", async () => {
  const sent = [];
  const f = fixture({ notifier: async (payload) => {
    sent.push(payload);
    if (sent.length === 1) throw new Error("synthetic rejection");
    return payload.notices.length;
  } });
  try {
    assert.equal((await f.scheduler.runNext({ force: true })).status, "partial");
    f.customers[0] = { ...f.customers[0], name: "客户新显示名", aliases: [hospital] };
    f.advance("2026-10-24T00:30:00.000Z");
    assert.equal((await f.scheduler.runNext({ force: true })).status, "success");
    assert.deepEqual(sent[1], sent[0]);
  } finally { f.db.close(); }
});

test("migration establishes a quiet baseline for already known customer notices", async () => {
  let sent = 0;
  const f = fixture({ notifier: async ({ notices }) => { sent += notices.length; return notices.length; } });
  try {
    f.tender.upsertNotice(snapshot().notices[0], { matchedCustomerIds: ["b"] });
    applyDeliveryEvents(f.db);
    f.advance("2026-10-24T00:30:00.000Z");
    await f.scheduler.runNext({ force: true });
    assert.equal(sent, 0);
  } finally { f.db.close(); }
});

test("collector resume progress persists across scheduler instances and is configuration-bound", async () => {
  const seen = [];
  const progress = [{ sourceId: "jining-ggzy", configurationDigest: "a".repeat(64), cursor: { categoryIndex: 1, hospitalIndex: 0, page: 2 } }];
  const f = fixture({ runner: { run: async (input) => {
    seen.push(input.collectionProgress);
    return { payload: { ...snapshot(), collectionProgress: progress } };
  } } });
  try {
    await f.scheduler.runNext({ force: true });
    f.advance("2026-10-24T00:30:00.000Z");
    await createHospitalTenderScheduler(f.options).runNext({ force: true });
    assert.deepEqual(seen, [[], progress]);
    assert.throws(() => normalizeCollectionProgress([{ ...progress[0], cursor: { page: "https://private.example.test" } }]), /cursor/u);
    assert.throws(() => normalizeCollectionProgress([progress[0], progress[0]]), /sourceId/u);
  } finally { f.db.close(); }
});

test("snapshot pointer and collector checkpoint roll back together on interrupted state persistence", async () => {
  const seen = [];
  const progress = [{ sourceId: "jining-ggzy", configurationDigest: "b".repeat(64), cursor: { page: 2 } }];
  const f = fixture({ runner: { run: async (input) => {
    seen.push(input.collectionProgress);
    return { payload: { ...snapshot(), collectionProgress: progress } };
  } } });
  const repository = {
    ...f.state,
    updateState(patch) {
      if (patch.snapshotId) throw new Error("synthetic snapshot pointer failure");
      return f.state.updateState(patch);
    },
  };
  try {
    await assert.rejects(createHospitalTenderScheduler({ ...f.options, repository }).runNext({ force: true }), /snapshot pointer failure/u);
    assert.deepEqual(createHospitalTenderNotificationEventRepository(f.db).collectionProgress(), []);
    assert.equal(f.state.getState().snapshotId, null);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM hospital_tender_scheduler_snapshots").get().n, 0);
    await f.scheduler.runNext({ force: true });
    assert.deepEqual(seen, [[], []]);
  } finally { f.db.close(); }
});

test("pending notifications recover before a new source collection fails", async () => {
  let enabled = true;
  let attempted = 0;
  let collectionFails = false;
  const f = fixture({
    notificationEnabled: () => enabled,
    runner: { run: async () => {
      if (collectionFails) throw new Error("synthetic source failure");
      return { payload: snapshot() };
    } },
    notifier: async ({ notices }) => {
      attempted += 1;
      if (attempted === 1) throw new Error("synthetic rejection");
      return notices.length;
    },
  });
  try {
    assert.equal((await f.scheduler.runNext({ force: true })).status, "partial");
    enabled = false;
    await f.scheduler.runNext({ force: true });
    enabled = true;
    collectionFails = true;
    await assert.rejects(f.scheduler.runNext({ force: true }), /synthetic source failure/u);
    assert.equal(attempted, 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM hospital_tender_notification_batches WHERE status='pending'").get().n, 0);
  } finally { f.db.close(); }
});

test("discarding a full page of deleted-customer batches does not hide the next valid notification", () => {
  const f = fixture();
  try {
    const insert = f.db.prepare(`INSERT INTO hospital_tender_notification_batches
      (id, cycle_number, payload_json, status, created_at) VALUES (?, 1, ?, 'pending', ?)`);
    for (let index = 0; index < 51; index += 1) {
      insert.run(String(index).padStart(3, "0"), JSON.stringify({
        cycleNumber: 1, batchCustomerIds: [index === 50 ? "b" : "deleted"],
        notices: [{ match: { matchedCustomerIds: [index === 50 ? "b" : "deleted"] } }],
      }), "2026-10-25T00:00:00.000Z");
    }
    const pending = createHospitalTenderNotificationEventRepository(f.db).pending({ activeCustomerIds: ["b"] });
    assert.deepEqual(pending.map((item) => item.id), ["050"]);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM hospital_tender_notification_batches WHERE status='cancelled'").get().n, 50);
  } finally { f.db.close(); }
});
