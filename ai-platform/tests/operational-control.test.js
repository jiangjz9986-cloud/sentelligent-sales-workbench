import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openAiPlatformDatabase, migrateAiPlatformDatabase } from "../src/db/index.js";
import { readOperationalControl, updateOperationalControl } from "../src/operations/control.js";
import { createAiPlatformRuntime } from "../src/server.js";

const identity = { issuer: "ops", actor: "operator", scopes: ["ai:ops:write"] };

test("maintenance pause survives restart and is observed by another worker connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-"));
  const path = join(dir, "platform.sqlite");
  const first = openAiPlatformDatabase(path);
  let restarted;
  try {
    restarted = createAiPlatformRuntime({ config: { databasePath: path }, autoStart: false });
    updateOperationalControl(first, { paused: true, expectedGeneration: 0, identity });
    const taskInput = {
      identity: { issuer: "backend", actor: "alice", owner: "alice" },
      idempotencyKey: "paused",
      request: { taskType: "quick-record.analyze", feature: "quick-record", channel: "web", input: { text: "fixture" } },
    };
    assert.throws(() => restarted.taskService.createTask(taskInput), (error) => error.code === "service_draining");
    assert.equal((await restarted.taskService.runPending()).claimed, 0);
    assert.equal((await restarted.scheduleService.scanDue()).claimed, 0);
    await restarted.close();
    restarted = createAiPlatformRuntime({ config: { databasePath: path }, autoStart: false });
    assert.equal(restarted.taskService.status().admissionOpen, false);
    assert.throws(() => restarted.taskService.createTask(taskInput), (error) => error.code === "service_draining");
    updateOperationalControl(first, { paused: false, expectedGeneration: 1, identity });
    assert.equal(restarted.taskService.createTask(taskInput).status, "queued");
  } finally {
    await restarted?.close();
    first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration schema and checksum ledger roll back together on failure", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => migrateAiPlatformDatabase(db, { clock: () => { throw new Error("fixture interrupted migration"); } }), /fixture interrupted/);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name = 'providers'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM platform_migrations").get().n, 0);
    migrateAiPlatformDatabase(db);
    assert.equal(db.prepare("SELECT count(*) n FROM platform_migrations").get().n, 4);
    const unchanged = readOperationalControl(db);
    assert.throws(
      () => updateOperationalControl(db, { paused: true, expectedGeneration: 0, identity: { ...identity, scopes: ["ai:task:create"] } }),
      (error) => error.code === "forbidden",
    );
    assert.deepEqual(readOperationalControl(db), unchanged);
    updateOperationalControl(db, { paused: true, expectedGeneration: 0, identity });
    assert.throws(
      () => updateOperationalControl(db, { paused: false, expectedGeneration: 0, identity }),
      (error) => error.code === "control_conflict",
    );
    assert.equal(readOperationalControl(db).paused, true);
  } finally {
    db.close();
  }
});
