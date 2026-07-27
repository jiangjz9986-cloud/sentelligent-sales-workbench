import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { all, migrateDatabase, openDatabase, run } from "../src/db.js";

function columns(db, table) {
  return all(db, `PRAGMA table_info(${table})`);
}

describe("visit itinerary migration", () => {
  it("creates the versioned soft-deletable itinerary snapshot table", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const byName = new Map(columns(db, "visit_itineraries").map((column) => [column.name, column]));
      assert.deepEqual([...byName.keys()], [
        "id",
        "version",
        "title",
        "visit_date",
        "status",
        "request_json",
        "plan_json",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
        "deleted_at",
        "deleted_by",
      ]);
      for (const required of ["id", "version", "title", "visit_date", "status", "request_json", "plan_json", "created_by", "updated_by", "created_at", "updated_at"]) {
        assert.equal(byName.get(required).notnull, 1, required);
      }
      assert.equal(byName.get("version").dflt_value, "1");
      assert.equal(byName.get("status").dflt_value, "'planned'");

      const indexes = all(db, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'visit_itineraries'");
      assert.equal(indexes.some((index) => index.name === "idx_visit_itineraries_active_date"), true);
      assert.equal(indexes.some((index) => index.name === "idx_visit_itineraries_status"), true);
      const migration = all(db, "SELECT version, checksum FROM schema_migrations WHERE version = '0005'");
      assert.equal(migration.length, 1);
      assert.match(migration[0].checksum, /^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
  });

  it("enforces status, positive versions, and valid JSON snapshots", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const valid = {
        $id: "itinerary-valid",
        $title: "济宁拜访",
        $visitDate: "2026-07-28",
        $requestJson: JSON.stringify({ stops: [] }),
        $planJson: JSON.stringify({ orderedStopIds: [] }),
        $actor: "jiangjz",
      };
      run(db, `
        INSERT INTO visit_itineraries (
          id, title, visit_date, request_json, plan_json, created_by, updated_by
        ) VALUES (
          $id, $title, $visitDate, $requestJson, $planJson, $actor, $actor
        )
      `, valid);
      assert.equal(all(db, "SELECT status, version FROM visit_itineraries")[0].status, "planned");

      for (const status of ["draft", "deleted", "done"]) {
        assert.throws(() => run(db, `
          INSERT INTO visit_itineraries (
            id, title, visit_date, status, request_json, plan_json, created_by, updated_by
          ) VALUES (
            $id, $title, $visitDate, $status, $requestJson, $planJson, $actor, $actor
          )
        `, { ...valid, $id: `invalid-${status}`, $status: status }), /CHECK constraint failed/i);
      }
      assert.throws(() => run(db, `
        INSERT INTO visit_itineraries (
          id, version, title, visit_date, request_json, plan_json, created_by, updated_by
        ) VALUES (
          $id, 0, $title, $visitDate, $requestJson, $planJson, $actor, $actor
        )
      `, { ...valid, $id: "invalid-version" }), /CHECK constraint failed/i);
      assert.throws(() => run(db, `
        INSERT INTO visit_itineraries (
          id, title, visit_date, request_json, plan_json, created_by, updated_by
        ) VALUES (
          $id, $title, $visitDate, $requestJson, $planJson, $actor, $actor
        )
      `, { ...valid, $id: "invalid-json", $requestJson: "not-json" }), /CHECK constraint failed/i);
    } finally {
      db.close();
    }
  });

  it("is idempotent when migration runs again", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const before = all(db, "SELECT version, checksum FROM schema_migrations ORDER BY version");
      migrateDatabase(db);
      const after = all(db, "SELECT version, checksum FROM schema_migrations ORDER BY version");
      assert.equal(before.some((migration) => migration.version === "0005"), true);
      assert.deepEqual(after, before);
    } finally {
      db.close();
    }
  });
});
