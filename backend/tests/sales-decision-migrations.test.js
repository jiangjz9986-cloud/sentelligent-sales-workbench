import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { all, migrateDatabase, openDatabase, run } from "../src/db.js";

function columns(db, table) {
  return all(db, `PRAGMA table_info(${table})`);
}

describe("sales decision analysis migration", () => {
  it("creates immutable JSON snapshots with bounded decision types", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const byName = new Map(columns(db, "sales_decision_analyses").map((column) => [column.name, column]));
      assert.deepEqual([...byName.keys()], [
        "id",
        "version",
        "analysis_type",
        "industry",
        "customer_id",
        "opportunity_id",
        "quick_record_id",
        "input_json",
        "analysis_json",
        "source",
        "created_by",
        "created_at",
      ]);
      for (const required of ["id", "version", "analysis_type", "industry", "input_json", "analysis_json", "source", "created_by", "created_at"]) {
        assert.equal(byName.get(required).notnull, 1, required);
      }
      assert.equal(byName.get("version").dflt_value, "1");
      const migration = all(db, "SELECT version, checksum FROM schema_migrations WHERE version = '0006'");
      assert.equal(migration.length, 1);
      assert.match(migration[0].checksum, /^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
  });

  it("rejects malformed snapshots and unsupported analysis types", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const valid = {
        $id: "decision-valid",
        $analysisType: "opportunity_diagnosis",
        $industry: "medical",
        $input: JSON.stringify({ opportunityId: "op-1" }),
        $analysis: JSON.stringify({ schemaVersion: "sales-decision-v1" }),
        $source: "mock",
        $actor: "jiangjz",
      };
      run(db, `
        INSERT INTO sales_decision_analyses (
          id, analysis_type, industry, input_json, analysis_json, source, created_by
        ) VALUES (
          $id, $analysisType, $industry, $input, $analysis, $source, $actor
        )
      `, valid);
      assert.throws(() => run(db, `
        INSERT INTO sales_decision_analyses (
          id, analysis_type, industry, input_json, analysis_json, source, created_by
        ) VALUES (
          $id, 'not_a_decision', $industry, $input, $analysis, $source, $actor
        )
      `, {
        $id: "decision-invalid-type",
        $industry: valid.$industry,
        $input: valid.$input,
        $analysis: valid.$analysis,
        $source: valid.$source,
        $actor: valid.$actor,
      }), /CHECK constraint failed/i);
      assert.throws(() => run(db, `
        INSERT INTO sales_decision_analyses (
          id, analysis_type, industry, input_json, analysis_json, source, created_by
        ) VALUES (
          $id, $analysisType, $industry, 'not-json', $analysis, $source, $actor
        )
      `, {
        $id: "decision-invalid-json",
        $analysisType: valid.$analysisType,
        $industry: valid.$industry,
        $analysis: valid.$analysis,
        $source: valid.$source,
        $actor: valid.$actor,
      }), /CHECK constraint failed/i);
    } finally {
      db.close();
    }
  });

  it("is idempotent when migration runs again", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const before = all(db, "SELECT version, checksum FROM schema_migrations ORDER BY version");
      migrateDatabase(db);
      assert.deepEqual(all(db, "SELECT version, checksum FROM schema_migrations ORDER BY version"), before);
    } finally {
      db.close();
    }
  });
});
