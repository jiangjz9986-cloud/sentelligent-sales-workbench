import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import {
  ItineraryNotFoundError,
  ItineraryVersionConflictError,
  createVisitItineraryRepository,
} from "../src/itinerary/repository.js";

let db;
let repository;
let idCounter;
let now;

function snapshot(overrides = {}) {
  return {
    title: "济宁客户拜访",
    visitDate: "2026-07-28",
    status: "planned",
    request: {
      departureAddress: "青岛市黄岛区秀兰禧悦山",
      departureAt: "2026-07-28T00:00:00.000Z",
      stops: [{ id: "customer-a", address: "济宁市第二人民医院" }],
    },
    plan: {
      orderedStopIds: ["customer-a"],
      summary: "先前往济宁第二人民医院。",
    },
    actor: "jiangjz",
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  idCounter = 0;
  now = "2026-07-27T12:00:00.000Z";
  repository = createVisitItineraryRepository(db, {
    idFactory: () => `itinerary-${++idCounter}`,
    clock: () => new Date(now),
  });
});

afterEach(() => {
  db.close();
});

describe("visit itinerary repository", () => {
  it("creates and reloads immutable request and plan snapshots", () => {
    const input = snapshot();
    const created = repository.create(input);
    input.request.stops[0].address = "被调用方后续修改";
    input.plan.orderedStopIds.reverse();

    assert.deepEqual(created, {
      id: "itinerary-1",
      version: 1,
      title: "济宁客户拜访",
      visitDate: "2026-07-28",
      status: "planned",
      request: snapshot().request,
      plan: snapshot().plan,
      createdBy: "jiangjz",
      updatedBy: "jiangjz",
      createdAt: "2026-07-27T12:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z",
    });
    assert.deepEqual(repository.get("itinerary-1"), created);
    assert.deepEqual(repository.list(), [created]);
  });

  it("replaces the snapshot and increments the optimistic version", () => {
    const created = repository.create(snapshot());
    now = "2026-07-27T13:30:00.000Z";
    const updated = repository.update(created.id, snapshot({
      expectedVersion: created.version,
      title: "济宁客户拜访（已调整）",
      status: "completed",
      request: { ...snapshot().request, departureAt: "2026-07-28T01:00:00.000Z" },
      plan: { orderedStopIds: ["customer-a"], summary: "调整后快照" },
    }));

    assert.equal(updated.version, 2);
    assert.equal(updated.title, "济宁客户拜访（已调整）");
    assert.equal(updated.status, "completed");
    assert.equal(updated.request.departureAt, "2026-07-28T01:00:00.000Z");
    assert.equal(updated.plan.summary, "调整后快照");
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, "2026-07-27T13:30:00.000Z");
  });

  it("rejects stale updates without changing the current snapshot", () => {
    const created = repository.create(snapshot());
    const current = repository.update(created.id, snapshot({ expectedVersion: 1, title: "当前版本" }));

    assert.throws(
      () => repository.update(created.id, snapshot({ expectedVersion: 1, title: "过期修改" })),
      (error) => {
        assert.equal(error instanceof ItineraryVersionConflictError, true);
        assert.equal(error.currentVersion, 2);
        return true;
      },
    );
    assert.deepEqual(repository.get(created.id), current);
  });

  it("soft-deletes with a version check and hides the retained row", () => {
    const first = repository.create(snapshot({ title: "第一条" }));
    now = "2026-07-28T09:00:00.000Z";
    const second = repository.create(snapshot({ title: "第二条", visitDate: "2026-07-29" }));
    const deleted = repository.softDelete(first.id, { expectedVersion: 1, actor: "jiangjz" });

    assert.equal(deleted.id, first.id);
    assert.equal(deleted.version, 2);
    assert.equal(deleted.deletedBy, "jiangjz");
    assert.equal(deleted.deletedAt, "2026-07-28T09:00:00.000Z");
    assert.equal(repository.get(first.id), null);
    assert.deepEqual(repository.list(), [second]);
    assert.throws(
      () => repository.softDelete(first.id, { expectedVersion: 2, actor: "jiangjz" }),
      ItineraryNotFoundError,
    );
  });

  it("filters active rows by status", () => {
    const planned = repository.create(snapshot({ title: "计划中" }));
    now = "2026-07-27T13:00:00.000Z";
    repository.create(snapshot({ title: "已取消", status: "cancelled", visitDate: "2026-07-29" }));

    assert.deepEqual(repository.list({ status: "planned" }), [planned]);
    assert.throws(() => repository.list({ status: "unknown" }), /status/);
  });
});
