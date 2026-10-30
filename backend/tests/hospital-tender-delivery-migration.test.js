import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateDatabase, migrationChecksum } from "../src/db/migrate.js";
import { createHospitalTenderRepository } from "../src/hospitalTender/repository.js";
import { createHospitalTenderSchedulerRepository } from "../src/hospitalTender/schedulerRepository.js";

async function productionSchema() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);`);
  const directory = new URL("../src/db/migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((name) => /^\d{4}_.*\.(?:sql|mjs)$/u.test(name)
    && name.slice(0, 4) <= "0054").sort()) {
    const url = new URL(name, directory);
    const source = readFileSync(url, "utf8");
    if (name.endsWith(".sql")) db.exec(source);
    else (await import(url.href)).apply(db);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, '2026-10-01T00:00:00.000Z')")
      .run(name.slice(0, 4), migrationChecksum(source));
  }
  return db;
}

test("delivery migration refuses to silently acknowledge an unfinished legacy notification batch", async () => {
  const db = await productionSchema();
  try {
    const repository = createHospitalTenderSchedulerRepository(db);
    const saved = repository.saveSnapshot({
      cycleNumber: 1, generatedAt: "2026-10-01T00:00:00.000Z", payload: { sources: [], notices: [], runs: [] },
    });
    repository.updateState({ cycleNumber: 1, snapshotId: saved.id, lastStatus: "partial", lastError: "招标通知发送失败" });
    const before = repository.getState();
    assert.throws(() => migrateDatabase(db), /LEGACY_TENDER_NOTIFICATION_RECOVERY_REQUIRED/u);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 53);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='hospital_tender_notification_batches'").get().n, 0);
    assert.deepEqual(repository.getState(), before);
    for (const lastStatus of ["running", "waiting"]) {
      repository.updateState({ lastStatus, lastError: null });
      assert.throws(() => migrateDatabase(db), /LEGACY_TENDER_NOTIFICATION_RECOVERY_REQUIRED/u);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 53);
    }
    repository.updateSnapshot(saved.id, { status: "completed", completedAt: "2026-10-01T00:30:00.000Z" });
    repository.updateState({ lastStatus: "success", lastError: null, snapshotId: null });
    migrateDatabase(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 57);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally { db.close(); }
});

test("delivery migration establishes the same quiet identity for legacy rows missing canonical IDs", async () => {
  const db = await productionSchema();
  try {
    const notice = {
      identityKey: "old:item", sourceId: "old", sourceName: "医院官网", title: "济宁市第一人民医院采购公告",
      purchaser: "济宁市第一人民医院", noticeType: "procurement_notice", publishedAt: "2026-10-01T00:00:00.000Z",
      projectCode: "JN-1", url: "https://hospital.example.test/1", relevance: "high",
    };
    const original = createHospitalTenderRepository(db).upsertNotice(notice, { matchedCustomerIds: ["customer"] });
    db.prepare("UPDATE hospital_tender_notices SET canonical_notice_id=NULL WHERE id=?").run(original.id);
    migrateDatabase(db);
    const refreshed = createHospitalTenderRepository(db).upsertNotice(notice, { matchedCustomerIds: ["customer"] });
    const baseline = db.prepare("SELECT canonical_notice_id, status FROM hospital_tender_notification_events").all();
    assert.equal(baseline.length, 1);
    assert.equal(baseline[0].canonical_notice_id, refreshed.canonicalNoticeId);
    assert.equal(baseline[0].status, "acknowledged");
  } finally { db.close(); }
});
