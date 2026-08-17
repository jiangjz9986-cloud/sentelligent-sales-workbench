import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createHospitalTenderNotifier } from "../src/hospitalTender/notifier.js";
import { createHospitalTenderRepository } from "../src/hospitalTender/repository.js";
import { createHospitalTenderSchedulerRepository } from "../src/hospitalTender/schedulerRepository.js";
import { collectorCustomers, createHospitalTenderScheduler } from "../src/hospitalTender/scheduler.js";

function snapshot() {
  return {
    schemaVersion: "hospital-tender-snapshot-v1",
    generatedAt: "2026-08-17T00:00:00.000Z",
    notices: [{
      identityKey: "source-a:item-1",
      sourceId: "source-a",
      sourceName: "公开采购平台",
      city: "东营市",
      title: "胜利油田中心医院 A医院信息化项目",
      url: "https://example.com/a",
      publishedAt: "2026-08-16T10:00:00.000Z",
      noticeType: "procurement_notice",
      purchaser: "胜利油田中心医院 A医院",
      projectCode: "A-1",
      budgetText: "100万元",
      deadlineText: "2026-09-01",
      contentText: "信息化项目采购",
      hospitalNames: ["胜利油田中心医院", "A医院"],
      sourceItemId: "item-1",
      contentSha256: "a".repeat(64),
      relevance: "high",
    }],
    sources: [],
    runs: [],
  };
}

function customers(count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    id: `customer-${String(index + 1).padStart(2, "0")}`,
    name: index === 0 ? "胜利油田中心医院" : `医院${index + 1}`,
    region: "东营市",
    needs: index === 0 ? ["信息化"] : [],
    summary: "",
    opportunities: [],
    aliases: [],
    hospitalNames: [],
    requirements: [],
    painPoints: [],
    keywords: [],
    tags: [],
  }));
}

async function withDb(testBody) {
  const dir = await mkdtemp(join(tmpdir(), "sentelligent-hospital-scheduler-"));
  const db = openDatabase({ databaseUrl: join(dir, "scheduler.sqlite") });
  try {
    await testBody(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function setup(db, options = {}) {
  const baseTenderRepository = createHospitalTenderRepository(db, {
    clock: options.tenderClock ?? (() => new Date("2026-08-17T00:00:00.000Z")),
  });
  const tenderRepository = options.tenderRepository?.(baseTenderRepository) ?? baseTenderRepository;
  const schedulerRepository = createHospitalTenderSchedulerRepository(db, {
    clock: () => new Date("2026-08-17T00:00:00.000Z"),
    idFactory: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })(),
  });
  const list = options.customers ?? customers();
  const scheduler = createHospitalTenderScheduler({
    db,
    repository: schedulerRepository,
    tenderRepository,
    customersProvider: () => list,
    runner: options.runner ?? { run: async () => ({ payload: snapshot(), source: "test" }) },
    notifier: options.notifier ?? null,
    intervalMinutes: 60,
    batchSize: 10,
    clock: () => new Date("2026-08-17T00:00:00.000Z"),
    idFactory: (() => {
      let id = 100;
      return () => `scheduler-${++id}`;
    })(),
  });
  return { scheduler, schedulerRepository, tenderRepository, list };
}

describe("hospital tender scheduler", () => {
  it("keeps a large customer registry bounded and de-duplicates collector names", () => {
    const list = customers(201);
    list[200] = { ...list[200], id: "customer-201", name: list[0].name, needs: ["信息化", "信息化"] };
    const collected = collectorCustomers(list);
    assert.equal(collected.length, 200);
    assert.equal(collected[0].name, "胜利油田中心医院");
    assert.deepEqual(collected[0].aliases, ["信息化"]);
  });

  it("persists a source snapshot and advances stable ten-customer batches", async () => {
    await withDb(async (db) => {
      const { scheduler, schedulerRepository, tenderRepository } = setup(db);
      const first = await scheduler.runNext({ force: true });
      assert.equal(first.status, "success");
      assert.equal(first.batchCustomerIds.length, 10);
      assert.equal(first.batchCustomerIds[0], "customer-01");
      assert.equal(first.batchCustomerIds.at(-1), "customer-10");
      assert.equal(schedulerRepository.getState().cursorCustomerId, "customer-10");
      assert.equal(schedulerRepository.getState().cycleProcessedCount, 10);
      assert.equal(schedulerRepository.getState().lastHighRelevanceCount, 1);
      assert.ok(schedulerRepository.getState().snapshotId);
      assert.equal(tenderRepository.summary().matchedNotices, 1);

      const second = await scheduler.runNext({ force: true });
      assert.equal(second.status, "success");
      assert.deepEqual(second.batchCustomerIds, ["customer-11", "customer-12"]);
      assert.equal(schedulerRepository.getState().snapshotId, null);
      assert.equal(schedulerRepository.getState().cursorCustomerId, null);
      assert.equal(schedulerRepository.getState().cycleProcessedCount, 12);
      assert.equal(schedulerRepository.listRuns().length, 2);
      assert.equal(tenderRepository.getNotice("nonexistent"), null);
    });
  });

  it("accepts a usable partial-source snapshot and preserves degraded health", async () => {
    await withDb(async (db) => {
      const payload = snapshot();
      payload.sources = [
        {
          sourceId: "jining-ggzy",
          sourceName: "济宁市公共资源交易公共服务平台",
          status: "healthy",
          lastRunAt: "2026-08-17T00:00:00.000Z",
          lastSuccessAt: "2026-08-17T00:00:00.000Z",
          lastItemCount: 1,
          lastUpsertedCount: 1,
          lastRejectedCount: 0,
          lastError: null,
        },
        {
          sourceId: "hospital-jining-first",
          sourceName: "济宁市第一人民医院",
          status: "error",
          lastRunAt: "2026-08-17T00:00:00.000Z",
          lastSuccessAt: null,
          lastItemCount: 0,
          lastUpsertedCount: 0,
          lastRejectedCount: 0,
          lastError: "source failure",
        },
      ];
      payload.runs = [{
        id: "run-partial-1",
        sourceId: "aggregate",
        startedAt: "2026-08-17T00:00:00.000Z",
        finishedAt: "2026-08-17T00:00:01.000Z",
        status: "partial",
        fetchedCount: 1,
        upsertedCount: 1,
        rejectedCount: 1,
        errorText: "source failure",
      }];
      const { scheduler, schedulerRepository, tenderRepository } = setup(db, {
        customers: customers(1),
        runner: { run: async () => ({ payload, source: "test" }) },
      });

      const result = await scheduler.runNext({ force: true });

      assert.equal(result.status, "partial");
      assert.equal(schedulerRepository.getState().cursorCustomerId, null);
      assert.equal(schedulerRepository.getState().lastStatus, "partial");
      assert.equal(schedulerRepository.getState().lastError, "部分公开来源失败");
      assert.equal(tenderRepository.listSources().find((item) => item.sourceId === "hospital-jining-first").status, "error");
      assert.equal(
        db.prepare("SELECT status FROM hospital_tender_runs ORDER BY started_at DESC LIMIT 1").get().status,
        "partial",
      );
    });
  });

  it("rechecks failed sources next cycle and does not duplicate a prior notification", async () => {
    await withDb(async (db) => {
      let cycle = 0;
      let tenderNow = "2026-08-17T00:01:00.000Z";
      const deliveries = [];
      const runner = {
        run: async () => {
          cycle += 1;
          const payload = snapshot();
          payload.generatedAt = cycle === 1
            ? "2026-08-17T00:00:00.000Z"
            : "2026-08-17T01:00:00.000Z";
          payload.sources = [{
            sourceId: "hospital-jining-first",
            sourceName: "济宁市第一人民医院",
            status: cycle === 1 ? "error" : "healthy",
            lastRunAt: payload.generatedAt,
            lastSuccessAt: cycle === 1 ? null : payload.generatedAt,
            lastItemCount: cycle === 1 ? 0 : 1,
            lastUpsertedCount: cycle === 1 ? 0 : 1,
            lastRejectedCount: 0,
            lastError: cycle === 1 ? "source failure" : null,
          }];
          payload.runs = [{
            id: `run-cycle-${cycle}`,
            sourceId: "aggregate",
            startedAt: payload.generatedAt,
            finishedAt: payload.generatedAt,
            status: cycle === 1 ? "partial" : "success",
            fetchedCount: 1,
            upsertedCount: 1,
            rejectedCount: 0,
            errorText: cycle === 1 ? "source failure" : null,
          }];
          return { payload, source: "test" };
        },
      };
      const { scheduler, schedulerRepository, tenderRepository } = setup(db, {
        customers: customers(1),
        runner,
        tenderClock: () => new Date(tenderNow),
        notifier: async ({ notices }) => {
          deliveries.push(notices.map((notice) => notice.identityKey));
          return notices.length;
        },
      });

      const first = await scheduler.runNext({ force: true });
      assert.equal(first.status, "partial");
      assert.equal(schedulerRepository.getState().lastStatus, "partial");
      assert.equal(deliveries.length, 1);

      tenderNow = "2026-08-17T01:01:00.000Z";
      const second = await scheduler.runNext({ force: true });
      assert.equal(second.status, "success");
      assert.equal(schedulerRepository.getState().lastStatus, "success");
      assert.equal(tenderRepository.listSources()[0].status, "healthy");
      assert.deepEqual(schedulerRepository.listRuns().map((run) => run.status), ["success", "partial"]);
      assert.equal(deliveries.length, 1);
    });
  });

  it("merges customer matches across batches instead of clearing prior evidence", async () => {
    await withDb(async (db) => {
      const list = customers(12);
      list[1] = { ...list[1], name: "A医院" };
      const { scheduler, tenderRepository } = setup(db, { customers: list });
      await scheduler.runNext({ force: true });
      await scheduler.runNext({ force: true });
      const notice = tenderRepository.listNotices({ limit: 10, offset: 0 })[0];
      assert.deepEqual(notice.match.matchedCustomerIds, ["customer-01", "customer-02"]);
    });
  });

  it("starts each new source snapshot with fresh customer matches", async () => {
    await withDb(async (db) => {
      const list = customers(1);
      const { scheduler, tenderRepository } = setup(db, { customers: list });
      await scheduler.runNext({ force: true });
      assert.deepEqual(
        tenderRepository.listNotices({ limit: 10, offset: 0 })[0].match.matchedCustomerIds,
        ["customer-01"],
      );

      list[0] = { ...list[0], name: "不相关医院", region: "青岛市", needs: [] };
      await scheduler.runNext({ force: true });
      assert.deepEqual(
        tenderRepository.listNotices({ limit: 10, offset: 0 })[0].match.matchedCustomerIds,
        [],
      );
    });
  });

  it("retains the current batch when any notice is rejected", async () => {
    await withDb(async (db) => {
      const { scheduler, schedulerRepository, tenderRepository } = setup(db, {
        tenderRepository: (base) => ({
          ...base,
          upsertNotice() {
            throw new Error("synthetic persistence failure");
          },
        }),
      });
      const result = await scheduler.runNext({ force: true });
      assert.equal(result.status, "partial");
      assert.equal(result.rejectedCount, 1);
      assert.equal(schedulerRepository.getState().cursorCustomerId, null);
      assert.equal(schedulerRepository.getState().cycleProcessedCount, 0);
      assert.ok(schedulerRepository.getState().snapshotId);
      assert.equal(tenderRepository.listNotices({ limit: 10, offset: 0 }).length, 0);
    });
  });

  it("rolls back accepted notices with a rejected notice and notifies once after recovery", async () => {
    await withDb(async (db) => {
      const payload = snapshot();
      payload.notices.push({
        ...payload.notices[0],
        identityKey: "source-a:item-2",
        title: "胜利油田中心医院 第二个信息化项目",
        url: "https://example.com/b",
        sourceItemId: "item-2",
        contentSha256: "b".repeat(64),
      });
      let failSecond = true;
      const deliveries = [];
      const { scheduler, tenderRepository } = setup(db, {
        customers: customers(1),
        runner: { run: async () => ({ payload, source: "test" }) },
        tenderRepository: (base) => ({
          ...base,
          upsertNotice(notice, ...args) {
            if (notice.identityKey === "source-a:item-2" && failSecond) {
              failSecond = false;
              throw new Error("synthetic transient persistence failure");
            }
            return base.upsertNotice(notice, ...args);
          },
        }),
        notifier: async ({ notices }) => {
          deliveries.push(notices.map((notice) => notice.identityKey).sort());
          return notices.length;
        },
      });

      assert.equal((await scheduler.runNext({ force: true })).status, "partial");
      assert.equal(tenderRepository.listNotices({ limit: 10, offset: 0 }).length, 0);
      assert.equal((await scheduler.runNext({ force: true })).status, "success");
      assert.deepEqual(deliveries, [["source-a:item-1", "source-a:item-2"]]);
      assert.equal(tenderRepository.listNotices({ limit: 10, offset: 0 }).length, 2);
    });
  });

  it("does not advance the cursor when notification delivery fails", async () => {
    await withDb(async (db) => {
      const { scheduler, schedulerRepository } = setup(db, {
        notifier: async () => { throw new Error("notification unavailable"); },
      });
      const result = await scheduler.runNext({ force: true });
      assert.equal(result.status, "partial");
      assert.equal(schedulerRepository.getState().cursorCustomerId, null);
      assert.equal(schedulerRepository.getState().lastError, "招标通知发送失败");
      assert.equal(schedulerRepository.getState().lastHighRelevanceCount, 1);
    });
  });

  it("does not advance the cursor when a notifier reports an incomplete batch", async () => {
    await withDb(async (db) => {
      const { scheduler, schedulerRepository } = setup(db, {
        notifier: async () => 0,
      });
      const result = await scheduler.runNext({ force: true });
      assert.equal(result.status, "partial");
      assert.equal(schedulerRepository.getState().cursorCustomerId, null);
      assert.equal(schedulerRepository.getState().lastError, "招标通知发送失败");
    });
  });

  it("retries a failed aggregate notification before advancing the batch", async () => {
    await withDb(async (db) => {
      let attempts = 0;
      const { scheduler, schedulerRepository } = setup(db, {
        notifier: async ({ notices }) => {
          attempts += 1;
          assert.equal(notices.length, 1);
          if (attempts === 1) throw new Error("notification unavailable");
          return notices.length;
        },
      });
      assert.equal((await scheduler.runNext({ force: true })).status, "partial");
      assert.equal(schedulerRepository.getState().cursorCustomerId, null);
      assert.equal((await scheduler.runNext({ force: true })).status, "success");
      assert.equal(attempts, 2);
      assert.equal(schedulerRepository.getState().cursorCustomerId, "customer-10");
      assert.equal(schedulerRepository.listRuns()[0].highRelevanceCount, 1);
    });
  });

  it("eventually delivers an oversized chunked notification batch before advancing", async () => {
    await withDb(async (db) => {
      const payload = snapshot();
      payload.notices = Array.from({ length: 120 }, (_, index) => ({
        ...payload.notices[0],
        identityKey: `source-a:item-${index + 1}`,
        title: `胜利油田中心医院 信息化项目 ${index + 1}`,
        url: `https://example.com/notices/${index + 1}`,
        sourceItemId: `item-${index + 1}`,
        contentSha256: (index + 1).toString(16).padStart(64, "0"),
      }));
      let calls = 0;
      const notifier = createHospitalTenderNotifier({
        token: ["fixture", "chunked", "value"].join("-"),
        fetchImpl: async () => {
          calls += 1;
          if (calls === 2) return new Response("provider-private", { status: 503 });
          return new Response(JSON.stringify({ code: "200" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      const { scheduler, schedulerRepository, tenderRepository } = setup(db, {
        runner: { run: async () => ({ payload, source: "test" }) },
        notifier,
      });

      assert.equal((await scheduler.runNext({ force: true })).status, "partial");
      assert.equal(schedulerRepository.getState().cursorCustomerId, null);
      const recovered = await scheduler.runNext({ force: true });
      assert.equal(recovered.status, "success");
      assert.equal(recovered.notificationCount, 120);
      assert.equal(schedulerRepository.getState().cursorCustomerId, "customer-10");
      assert.equal(tenderRepository.listNotices({ limit: 200, offset: 0 }).length, 120);
      assert.equal(calls, 4);
    });
  });

  it("persists collector failures and leaves the pending batch resumable", async () => {
    await withDb(async (db) => {
      const { scheduler, schedulerRepository } = setup(db, {
        runner: { run: async () => { throw new Error("collector timed out"); } },
      });
      await assert.rejects(() => scheduler.runNext({ force: true }), /collector timed out/);
      const state = schedulerRepository.getState();
      assert.equal(state.lastStatus, "failed");
      assert.equal(state.lastError, "collector timed out");
      assert.equal(state.cursorCustomerId, null);
      assert.equal(state.snapshotId, null);
      assert.ok(state.nextRunAt);
    });
  });

  it("resumes a persisted snapshot after scheduler recreation", async () => {
    await withDb(async (db) => {
      const first = setup(db);
      await first.scheduler.runNext({ force: true });
      const pendingSnapshotId = first.schedulerRepository.getState().snapshotId;
      assert.ok(pendingSnapshotId);
      first.scheduler.stop();

      const second = setup(db, { customers: first.list });
      const resumed = await second.scheduler.runNext({ force: true });
      assert.equal(resumed.status, "success");
      assert.deepEqual(resumed.batchCustomerIds, ["customer-11", "customer-12"]);
      assert.equal(second.schedulerRepository.getState().snapshotId, null);
      assert.equal(second.schedulerRepository.getSnapshot(pendingSnapshotId).status, "completed");
    });
  });

  it("uses the current customer registry without replaying deleted ids", async () => {
    await withDb(async (db) => {
      const list = customers(12);
      const { scheduler, schedulerRepository } = setup(db, { customers: list });
      await scheduler.runNext({ force: true });
      list.splice(10, 1);
      list.push({ ...customers(1)[0], id: "customer-13", name: "新医院" });
      const resumed = await scheduler.runNext({ force: true });
      assert.deepEqual(resumed.batchCustomerIds, ["customer-12", "customer-13"]);
      assert.equal(schedulerRepository.getState().cursorCustomerId, null);
    });
  });

  it("closes a pending snapshot when every customer is deleted", async () => {
    await withDb(async (db) => {
      const list = customers(12);
      const { scheduler, schedulerRepository } = setup(db, { customers: list });
      await scheduler.runNext({ force: true });
      const pendingSnapshotId = schedulerRepository.getState().snapshotId;
      assert.ok(pendingSnapshotId);

      list.splice(0, list.length);
      const result = await scheduler.runNext({ force: true });
      assert.equal(result.status, "success");
      assert.equal(schedulerRepository.getState().snapshotId, null);
      assert.equal(schedulerRepository.getState().cursorCustomerId, null);
      assert.equal(schedulerRepository.getSnapshot(pendingSnapshotId).status, "completed");
    });
  });

  it("skips overlapping runs through the database lease", async () => {
    await withDb(async (db) => {
      let resolveRunner;
      const runnerPromise = new Promise((resolve) => { resolveRunner = resolve; });
      const { scheduler } = setup(db, {
        runner: { run: async () => { await runnerPromise; return { payload: snapshot(), source: "test" }; } },
      });
      const first = scheduler.runNext({ force: true });
      await new Promise((resolve) => setImmediate(resolve));
      const second = await scheduler.runNext({ force: true });
      assert.equal(second.status, "skipped");
      resolveRunner();
      assert.equal((await first).status, "success");
    });
  });
});
