import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createV0120ProductionAcceptanceFixture } from "../scripts/v0120-production-acceptance-fixture.mjs";
import { openDatabase } from "../src/db.js";

const OWNER = "v0120-fixture-owner";
const TEST_SESSION_VALUE = "fixture-session-secret-placeholder-value";
const temporaryDirectories = [];

function createDatabaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), "sentelligent-v0120-fixture-"));
  temporaryDirectories.push(directory);
  const databaseUrl = join(directory, "acceptance.sqlite");
  const customerId = `customer-${randomUUID()}`;
  const opportunityId = `opportunity-${randomUUID()}`;
  const db = openDatabase({ databaseUrl });
  db.prepare(`
    INSERT INTO customers (id, name, owner, summary, created_at, updated_at)
    VALUES ($id, $name, $owner, $summary, $now, $now)
  `).run({
    $id: customerId,
    $name: "v0.12 fixture customer",
    $owner: OWNER,
    $summary: "fixture customer",
    $now: "2026-09-13T00:00:00.000Z",
  });
  db.prepare(`
    INSERT INTO opportunities (id, customer_id, name, owner, source_record, next, created_at, updated_at)
    VALUES ($id, $customerId, $name, $owner, $sourceRecord, NULL, $now, $now)
  `).run({
    $id: opportunityId,
    $customerId: customerId,
    $name: "v0.12 fixture opportunity",
    $owner: OWNER,
    $sourceRecord: "fixture",
    $now: "2026-09-13T00:00:00.000Z",
  });
  db.close();
  return { databaseUrl, customerId, opportunityId };
}

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test("v0.12.0 production fixture uses the real proactive subject and writeback services", () => {
  const fixture = createDatabaseFixture();
  const runId = randomUUID();
  const result = createV0120ProductionAcceptanceFixture({
    databaseUrl: fixture.databaseUrl,
    authSessionSecret: TEST_SESSION_VALUE,
    runId,
    owner: OWNER,
    customerId: fixture.customerId,
    opportunityId: fixture.opportunityId,
    clock: () => new Date("2026-09-13T08:00:00.000Z"),
  });

  assert.equal(result.runId, runId);
  assert.equal(result.owner, OWNER);
  assert.equal(result.customerId, fixture.customerId);
  assert.equal(result.opportunityId, fixture.opportunityId);
  assert.match(result.marker, new RegExp(runId));
  assert.match(result.subjectKey, new RegExp(`customer:${OWNER}:${fixture.customerId}`));
  assert.ok(result.subjectId);
  assert.ok(result.seedRiskId);
  assert.ok(result.seedAuditId);
  assert.ok(result.suggestionIds.length >= 2);
  assert.ok(result.actionSuggestionId);
  assert.ok(result.riskSuggestionId);
  assert.match(result.sourceDigest, /^[0-9a-f]{64}$/u);

  const db = openDatabase({ databaseUrl: fixture.databaseUrl });
  try {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM risk_items WHERE id = $id AND owner = $owner")
        .get({ $id: result.seedRiskId, $owner: OWNER }).count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM proactive_subjects WHERE id = $id AND owner = $owner")
        .get({ $id: result.subjectId, $owner: OWNER }).count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM ai_suggestions WHERE proactive_subject_key = $key AND owner = $owner")
        .get({ $key: result.subjectKey, $owner: OWNER }).count,
      result.suggestionIds.length,
    );
  } finally {
    db.close();
  }
});

test("v0.12.0 production fixture rejects a cross-owner customer/opportunity pair", () => {
  const fixture = createDatabaseFixture();
  assert.throws(
    () => createV0120ProductionAcceptanceFixture({
      databaseUrl: fixture.databaseUrl,
      authSessionSecret: TEST_SESSION_VALUE,
      runId: randomUUID(),
      owner: "different-owner",
      customerId: fixture.customerId,
      opportunityId: fixture.opportunityId,
    }),
    /belong to the acceptance owner/i,
  );
});
