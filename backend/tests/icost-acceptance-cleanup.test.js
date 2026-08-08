import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  cleanupIcostAcceptance,
} from "../scripts/icost-acceptance-cleanup.mjs";
import { insertAudit } from "../src/audit/auditRepository.js";
import { openDatabase } from "../src/db.js";
import { createDatabaseIdentity } from "../src/db/databaseIdentity.js";

const TEST_SESSION_SECRET = "fixture-session-token-fixture-session-token";
const cleanupScriptPath = fileURLToPath(
  new URL("../scripts/icost-acceptance-cleanup.mjs", import.meta.url),
);
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "sent-zx-icost-acceptance-cleanup-"));
  temporaryDirectories.push(directory);
  const databaseUrl = join(directory, "workbench.sqlite");
  return { directory, databaseUrl, db: openDatabase({ databaseUrl }) };
}

function count(db, table, where = "1 = 1", params = {}) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(params).count);
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function insertAcceptanceFixture(db, {
  owner = "jiangjz",
  sourceId = `ACCEPTANCE-${randomUUID()}`,
  actor = "icost-webhook",
  source = "icost",
  status = "accepted",
  expenseOwner = owner,
  expenseCreatedBy = actor,
} = {}) {
  const ingestionId = randomUUID();
  const expenseId = status === "accepted" ? randomUUID() : null;
  const paymentId = status === "accepted" ? randomUUID() : null;
  const now = "2026-08-05T02:03:04.000Z";

  if (expenseId) {
    db.prepare(`
      INSERT INTO travel_expenses (
        id, reference_code, owner, occurred_on, category, purpose, merchant,
        invoice_status, created_by, updated_by, created_at, updated_at
      ) VALUES (
        $id, $referenceCode, $owner, '2026-08-05', 'lunch',
        'Production acceptance meal', 'Acceptance merchant', 'pending',
        $createdBy, $createdBy, $now, $now
      )
    `).run({
      $id: expenseId,
      $referenceCode: `EXP-20260805-${expenseId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      $owner: expenseOwner,
      $createdBy: expenseCreatedBy,
      $now: now,
    });
    db.prepare(`
      INSERT INTO travel_expense_payments (
        id, expense_id, sequence, paid_at, merchant, amount_cents,
        reimbursement_cents, funding_source, payment_method, created_at, updated_at
      ) VALUES (
        $id, $expenseId, 1, '2026-08-05T12:30:00+08:00',
        'Acceptance merchant', 12850, 12850, 'personal', 'wechat', $now, $now
      )
    `).run({ $id: paymentId, $expenseId: expenseId, $now: now });
  }

  db.prepare(`
    INSERT INTO travel_expense_ingestions (
      id, owner, actor, source, idempotency_key_hash, request_hash,
      source_id, raw_text, captured_at, status, attempt_count,
      analysis_provider, analysis_model, analysis_json, warnings_json,
      expense_id, payment_id, created_at, updated_at
    ) VALUES (
      $id, $owner, $actor, $source, $idempotencyKeyHash, $requestHash,
      $sourceId, '2026-08-05 lunch acceptance 128.50',
      '2026-08-05T12:30:00+08:00', $status, 1,
      'deepseek', 'deepseek-chat', $analysisJson, '[]',
      $expenseId, $paymentId, $now, $now
    )
  `).run({
    $id: ingestionId,
    $owner: owner,
    $actor: actor,
    $source: source,
    $idempotencyKeyHash: digest(`idempotency:${ingestionId}`),
    $requestHash: digest(`request:${ingestionId}`),
    $sourceId: sourceId,
    $status: status,
    $analysisJson: JSON.stringify({ status: status === "accepted" ? "ready" : "review_required" }),
    $expenseId: expenseId,
    $paymentId: paymentId,
    $now: now,
  });

  const auditActions = status === "accepted"
    ? ["travel_expense.ingestion.receive", "travel_expense.ingestion.accept"]
    : ["travel_expense.ingestion.receive", "travel_expense.ingestion.review_required"];
  const auditIds = auditActions.map((action) => insertAudit(db, {
    action,
    entityType: "travel_expense_ingestion",
    entityId: ingestionId,
    actor,
    requestId: sourceId,
    before: null,
    after: { status },
    metadata: { owner, source },
  }).id);

  return {
    owner,
    sourceId,
    ingestionId,
    expenseId,
    paymentId,
    auditIds,
  };
}

function acceptanceManifest(databaseUrl, fixture, overrides = {}) {
  const manifest = {
    owner: fixture.owner,
    source_id: fixture.sourceId,
    ingestion_id: fixture.ingestionId,
    database_identity: createDatabaseIdentity({
      databaseUrl,
      secret: TEST_SESSION_SECRET,
    }),
  };
  if (fixture.expenseId) manifest.expense_id = fixture.expenseId;
  if (fixture.paymentId) manifest.payment_id = fixture.paymentId;
  return { ...manifest, ...overrides };
}

function runCleanup(databaseUrl, fixture, overrides = {}) {
  return cleanupIcostAcceptance({
    databaseUrl,
    authSessionSecret: TEST_SESSION_SECRET,
    manifest: acceptanceManifest(databaseUrl, fixture, overrides),
  });
}

function assertFixturePresent(databaseUrl, fixture) {
  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "travel_expense_ingestions", "id = $id", { $id: fixture.ingestionId }), 1);
    if (fixture.expenseId) {
      assert.equal(count(verify, "travel_expenses", "id = $id", { $id: fixture.expenseId }), 1);
      assert.equal(count(verify, "travel_expense_payments", "id = $id", { $id: fixture.paymentId }), 1);
    }
    for (const auditId of fixture.auditIds) {
      assert.equal(count(verify, "audit_logs", "id = $id", { $id: auditId }), 1);
    }
  } finally {
    verify.close();
  }
}

test("cleanup implementation contains no fuzzy SQL selector", () => {
  const source = readFileSync(cleanupScriptPath, "utf8");
  assert.doesNotMatch(source, /\binstr\s*\(|\bLIKE\b|\bGLOB\b/iu);
});

test("cleans one exact accepted iCost ingestion without exposing manifest or secret values", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db);
  const unrelatedIdempotencyKey = "unrelated-icost-write";
  db.prepare(`
    INSERT INTO idempotency_keys (
      actor, method, request_path, key, request_hash, state,
      response_status, response_json, created_at, expires_at
    ) VALUES (
      'icost-webhook', 'POST', '/api/integrations/icost/expenses', $key,
      'unrelated-request-hash', 'completed', 201, '{}',
      '2026-08-05T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
    )
  `).run({ $key: unrelatedIdempotencyKey });
  db.close();

  const report = runCleanup(databaseUrl, fixture);

  assert.deepEqual(report, {
    status: "clean",
    verified: {
      databaseIdentity: true,
      ingestion: true,
      relationships: true,
    },
    deleted: {
      auditLogs: 2,
      ingestions: 1,
      payments: 1,
      expenses: 1,
    },
    residual: {
      auditLogs: 0,
      ingestions: 0,
      payments: 0,
      expenses: 0,
    },
    integrity: {
      quickCheck: "ok",
      foreignKeyViolations: 0,
    },
  });
  const serialized = JSON.stringify(report);
  for (const sensitiveValue of [
    fixture.owner,
    fixture.sourceId,
    fixture.ingestionId,
    fixture.expenseId,
    fixture.paymentId,
    TEST_SESSION_SECRET,
    databaseUrl,
    acceptanceManifest(databaseUrl, fixture).database_identity,
  ]) {
    assert.doesNotMatch(serialized, new RegExp(sensitiveValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "travel_expense_ingestions", "id = $id", { $id: fixture.ingestionId }), 0);
    assert.equal(count(verify, "travel_expenses", "id = $id", { $id: fixture.expenseId }), 0);
    assert.equal(count(verify, "travel_expense_payments", "id = $id", { $id: fixture.paymentId }), 0);
    assert.equal(count(verify, "audit_logs", "entity_id = $id", { $id: fixture.ingestionId }), 0);
    assert.equal(
      count(verify, "idempotency_keys", "key = $key", { $key: unrelatedIdempotencyKey }),
      1,
      "the iCost route does not use the generic idempotency table, so cleanup must not guess",
    );
  } finally {
    verify.close();
  }
});

test("cleans an exact review-required ingestion without financial rows", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db, { status: "review_required" });
  db.close();

  const report = runCleanup(databaseUrl, fixture);

  assert.deepEqual(report.deleted, {
    auditLogs: 2,
    ingestions: 1,
    payments: 0,
    expenses: 0,
  });
  assert.deepEqual(report.residual, {
    auditLogs: 0,
    ingestions: 0,
    payments: 0,
    expenses: 0,
  });
});

test("rejects financial ids for a review-required ingestion", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db, { status: "review_required" });
  db.close();

  assert.throws(
    () => runCleanup(databaseUrl, fixture, {
      expense_id: randomUUID(),
      payment_id: randomUUID(),
    }),
    /financial|expense|payment|review/i,
  );
  assertFixturePresent(databaseUrl, fixture);
});

test("rejects a wrong database identity before deleting anything", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db);
  db.close();

  assert.throws(
    () => runCleanup(databaseUrl, fixture, { database_identity: "x".repeat(43) }),
    /database identity.*does not match|does not match.*database identity/i,
  );
  assertFixturePresent(databaseUrl, fixture);
});

test("rejects a missing exact ingestion id and preserves the database", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db);
  db.close();

  assert.throws(
    () => runCleanup(databaseUrl, fixture, { ingestion_id: randomUUID() }),
    /ingestion.*not found|missing.*ingestion/i,
  );
  assertFixturePresent(databaseUrl, fixture);
});

test("rejects exact owner, source id, expense, and payment mismatches", async (t) => {
  for (const mismatch of [
    { label: "owner", values: { owner: "another-owner" } },
    { label: "source id", values: { source_id: `ACCEPTANCE-${randomUUID()}` } },
    { label: "expense", values: { expense_id: randomUUID() } },
    { label: "payment", values: { payment_id: randomUUID() } },
  ]) {
    await t.test(mismatch.label, () => {
      const { db, databaseUrl } = temporaryDatabase();
      const fixture = insertAcceptanceFixture(db);
      db.close();

      assert.throws(
        () => runCleanup(databaseUrl, fixture, mismatch.values),
        /manifest|owner|source|expense|payment|relationship/i,
      );
      assertFixturePresent(databaseUrl, fixture);
    });
  }
});

test("rejects a cross-owner ingestion using the same exact acceptance source id", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db);
  insertAcceptanceFixture(db, {
    owner: "other-owner",
    sourceId: fixture.sourceId,
    status: "review_required",
  });
  db.close();

  assert.throws(
    () => runCleanup(databaseUrl, fixture),
    /source id|cross.owner|multiple|unique/i,
  );
  assertFixturePresent(databaseUrl, fixture);
});

test("rejects a non-iCost source or a non-webhook actor", async (t) => {
  for (const fixtureOptions of [
    { source: "manual" },
    { actor: "jiangjz", expenseCreatedBy: "jiangjz" },
  ]) {
    await t.test(JSON.stringify(fixtureOptions), () => {
      const { db, databaseUrl } = temporaryDatabase();
      const fixture = insertAcceptanceFixture(db, fixtureOptions);
      db.close();

      assert.throws(
        () => runCleanup(databaseUrl, fixture),
        /source|actor|icost.webhook/i,
      );
      assertFixturePresent(databaseUrl, fixture);
    });
  }
});

test("rejects an extra payment on the manifested expense", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db);
  const extraPaymentId = randomUUID();
  db.prepare(`
    INSERT INTO travel_expense_payments (
      id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents,
      funding_source, payment_method, created_at, updated_at
    ) VALUES (
      $id, $expenseId, 2, '2026-08-05T13:00:00+08:00', 100, 100,
      'personal', 'cash', '2026-08-05T05:00:00.000Z', '2026-08-05T05:00:00.000Z'
    )
  `).run({ $id: extraPaymentId, $expenseId: fixture.expenseId });
  db.close();

  assert.throws(
    () => runCleanup(databaseUrl, fixture),
    /dependent|extra|payment|relationship/i,
  );
  assertFixturePresent(databaseUrl, fixture);
  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "travel_expense_payments", "id = $id", { $id: extraPaymentId }), 1);
  } finally {
    verify.close();
  }
});

test("rejects another ingestion referencing the manifested financial rows", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db);
  const otherIngestionId = randomUUID();
  db.prepare(`
    INSERT INTO travel_expense_ingestions (
      id, owner, actor, source, idempotency_key_hash, request_hash,
      source_id, raw_text, status, warnings_json, expense_id, payment_id
    ) VALUES (
      $id, $owner, 'manual-user', 'manual', $idempotencyHash, $requestHash,
      'manual-reference', 'manual record', 'accepted', '[]', $expenseId, $paymentId
    )
  `).run({
    $id: otherIngestionId,
    $owner: fixture.owner,
    $idempotencyHash: digest(`other:${otherIngestionId}`),
    $requestHash: digest(`other-request:${otherIngestionId}`),
    $expenseId: fixture.expenseId,
    $paymentId: fixture.paymentId,
  });
  db.close();

  assert.throws(
    () => runCleanup(databaseUrl, fixture),
    /dependent|ingestion|relationship/i,
  );
  assertFixturePresent(databaseUrl, fixture);
});

test("rejects a business record referencing the manifested expense or payment", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db);
  const confirmationId = randomUUID();
  db.prepare(`
    INSERT INTO travel_expense_no_invoice_confirmations (
      id, owner, expense_id, payment_id, amount_snapshot_cents,
      reason, confirmed_by, confirmed_at, created_at, updated_at
    ) VALUES (
      $id, $owner, $expenseId, $paymentId, 12850,
      'Business confirmation', 'jiangjz', '2026-08-05T06:00:00.000Z',
      '2026-08-05T06:00:00.000Z', '2026-08-05T06:00:00.000Z'
    )
  `).run({
    $id: confirmationId,
    $owner: fixture.owner,
    $expenseId: fixture.expenseId,
    $paymentId: fixture.paymentId,
  });
  db.close();

  assert.throws(
    () => runCleanup(databaseUrl, fixture),
    /dependent|business|confirmation|reference/i,
  );
  assertFixturePresent(databaseUrl, fixture);
});

test("rejects missing or extra ingestion audit rows", async (t) => {
  await t.test("missing audit", () => {
    const { db, databaseUrl } = temporaryDatabase();
    const fixture = insertAcceptanceFixture(db);
    db.prepare("DELETE FROM audit_logs WHERE id = $id").run({ $id: fixture.auditIds[1] });
    fixture.auditIds = [fixture.auditIds[0]];
    db.close();

    assert.throws(() => runCleanup(databaseUrl, fixture), /audit.*expected|audit.*missing|audit.*exact/i);
    assertFixturePresent(databaseUrl, fixture);
  });

  await t.test("extra audit", () => {
    const { db, databaseUrl } = temporaryDatabase();
    const fixture = insertAcceptanceFixture(db);
    const extra = insertAudit(db, {
      action: "travel_expense.ingestion.accept",
      entityType: "travel_expense_ingestion",
      entityId: fixture.ingestionId,
      actor: "icost-webhook",
      requestId: fixture.sourceId,
      metadata: { owner: fixture.owner, source: "icost" },
    });
    fixture.auditIds.push(extra.id);
    db.close();

    assert.throws(() => runCleanup(databaseUrl, fixture), /audit.*expected|audit.*extra|audit.*exact/i);
    assertFixturePresent(databaseUrl, fixture);
  });
});

test("rejects an audit showing that the generated expense was edited", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db);
  const financialAudit = insertAudit(db, {
    action: "travel_expense.update",
    entityType: "travel_expense",
    entityId: fixture.expenseId,
    actor: fixture.owner,
    requestId: randomUUID(),
    before: { version: 1 },
    after: { version: 2 },
  });
  fixture.auditIds.push(financialAudit.id);
  db.close();

  assert.throws(() => runCleanup(databaseUrl, fixture), /audit|edited|business/i);
  assertFixturePresent(databaseUrl, fixture);
});

test("rolls back all exact deletions when a later delete fails", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db);
  db.exec(`
    CREATE TRIGGER force_icost_acceptance_cleanup_failure
    BEFORE DELETE ON travel_expense_payments
    WHEN OLD.id = '${fixture.paymentId}'
    BEGIN
      SELECT RAISE(ABORT, 'forced acceptance cleanup rollback');
    END;
  `);
  db.close();

  assert.throws(
    () => runCleanup(databaseUrl, fixture),
    /forced acceptance cleanup rollback/i,
  );
  assertFixturePresent(databaseUrl, fixture);
});

test("CLI reads one explicit manifest file and emits only the sanitized report", () => {
  const { directory, db, databaseUrl } = temporaryDatabase();
  const fixture = insertAcceptanceFixture(db);
  db.close();
  const manifest = acceptanceManifest(databaseUrl, fixture);
  const manifestPath = join(directory, "acceptance-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const result = spawnSync(
    process.execPath,
    [
      cleanupScriptPath,
      `--manifest=${manifestPath}`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        AUTH_SESSION_SECRET: TEST_SESSION_SECRET,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "clean");
  const output = `${result.stdout}\n${result.stderr}`;
  for (const sensitiveValue of [
    fixture.owner,
    fixture.sourceId,
    fixture.ingestionId,
    fixture.expenseId,
    fixture.paymentId,
    TEST_SESSION_SECRET,
    databaseUrl,
    manifest.database_identity,
  ]) {
    assert.doesNotMatch(output, new RegExp(sensitiveValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
