import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createConnection } from "../src/db/connection.js";
import { withImmediateTransaction } from "../src/db/transaction.js";
import {
  parseIdempotencyKey,
  requestHash,
  stableJson,
} from "../src/services/idempotency.js";
import { createServer } from "../src/server.js";

const confirmationTargets = ["customer", "opportunity", "weekly"];

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withHarness(options, work) {
  const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-confirm-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  const server = createServer({
    databaseUrl,
    seed: true,
    nodeEnv: "test",
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: false,
    authAccount: "",
    authPassword: "",
    ...options,
  });

  try {
    const baseUrl = await listen(server);
    const request = async (path, requestOptions = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        ...requestOptions,
        headers: {
          "Content-Type": "application/json",
          ...(requestOptions.headers ?? {}),
        },
      });
      const text = await response.text();
      return { response, body: text ? JSON.parse(text) : null };
    };
    await work({ baseUrl, databaseUrl, request, server });
  } finally {
    await closeServer(server);
    await rm(tempDir, { recursive: true, force: true });
  }
}

function inspectDatabase(databaseUrl, work) {
  const db = createConnection({ databaseUrl });
  try {
    return work(db);
  } finally {
    db.close();
  }
}

async function createAnalyzedRecord(request, suffix = "record") {
  const created = await request("/api/quick-records", {
    method: "POST",
    body: JSON.stringify({
      rawContent: `Task 9 ${suffix}`,
      occurredAt: "2026-07-16T10:00:00+08:00",
      sourceChannel: "test",
      customerId: "rizhao",
      opportunityId: "op-rizhao-plan",
    }),
  });
  assert.equal(created.response.status, 201);

  const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(analyzed.response.status, 201);
  return { quickRecord: created.body.item, analysis: analyzed.body.item };
}

async function currentTargetVersions(request) {
  const [customers, opportunities] = await Promise.all([
    request("/api/customers"),
    request("/api/opportunities"),
  ]);
  return {
    customer: customers.body.items.find((item) => item.id === "rizhao").version,
    opportunity: opportunities.body.items.find((item) => item.id === "op-rizhao-plan").version,
  };
}

function confirmOptions(fixture, versions, key, overrides = {}) {
  const targets = overrides.targets ?? confirmationTargets;
  const targetVersions = {};
  if (targets.includes("customer")) targetVersions.customer = versions.customer;
  if (targets.includes("opportunity")) targetVersions.opportunity = versions.opportunity;
  return {
    method: "POST",
    headers: {
      "Idempotency-Key": key,
      "If-Match": `"${overrides.quickRecordVersion ?? fixture.quickRecord.version}"`,
    },
    body: JSON.stringify({
      targets,
      confirmedBy: "Task 9 tester",
      note: "atomic confirmation",
      analysisVersionId: fixture.analysis.id,
      ...(Object.keys(targetVersions).length > 0 ? { targetVersions } : {}),
      ...(overrides.body ?? {}),
    }),
  };
}

function confirmationSnapshot(databaseUrl, quickRecordId, key) {
  return inspectDatabase(databaseUrl, (db) => ({
    quickRecord: db.prepare("SELECT * FROM quick_records WHERE id = ?").get(quickRecordId),
    customer: db.prepare("SELECT * FROM customers WHERE id = 'rizhao'").get(),
    opportunity: db.prepare("SELECT * FROM opportunities WHERE id = 'op-rizhao-plan'").get(),
    confirmations: db.prepare(
      "SELECT * FROM manual_confirmations WHERE quick_record_id = ? ORDER BY target, id",
    ).all(quickRecordId),
    actions: db.prepare(
      "SELECT * FROM action_items WHERE source_record_id = ? ORDER BY id",
    ).all(quickRecordId),
    risks: db.prepare(
      "SELECT * FROM risk_items WHERE source_type = 'quick_record' AND source_id = ? ORDER BY id",
    ).all(quickRecordId),
    audits: db.prepare(
      "SELECT * FROM audit_logs WHERE action = 'quick_record.confirm' AND entity_id = ? ORDER BY id",
    ).all(quickRecordId),
    idempotency: db.prepare(
      "SELECT * FROM idempotency_keys WHERE key = ? ORDER BY actor, method, request_path",
    ).all(key),
  }));
}

function relationshipSnapshot(databaseUrl, quickRecordId, key) {
  return inspectDatabase(databaseUrl, (db) => ({
    quickRecord: db.prepare("SELECT * FROM quick_records WHERE id = ?").get(quickRecordId),
    customers: db.prepare(`
      SELECT * FROM customers
      WHERE id IN ('rizhao', 'huangdao-tcm')
      ORDER BY id
    `).all(),
    opportunities: db.prepare(`
      SELECT * FROM opportunities
      WHERE id IN ('op-rizhao-plan', 'op-huangdao-tcm')
      ORDER BY id
    `).all(),
    confirmations: db.prepare(
      "SELECT * FROM manual_confirmations WHERE quick_record_id = ? ORDER BY target, id",
    ).all(quickRecordId),
    actions: db.prepare(
      "SELECT * FROM action_items WHERE source_record_id = ? ORDER BY id",
    ).all(quickRecordId),
    risks: db.prepare(
      "SELECT * FROM risk_items WHERE source_type = 'quick_record' AND source_id = ? ORDER BY id",
    ).all(quickRecordId),
    audits: db.prepare(
      "SELECT * FROM audit_logs WHERE action = 'quick_record.confirm' AND entity_id = ? ORDER BY id",
    ).all(quickRecordId),
    idempotency: db.prepare(
      "SELECT * FROM idempotency_keys WHERE key = ? ORDER BY actor, method, request_path",
    ).all(key),
  }));
}

describe("synchronous immediate transactions", () => {
  it("commits only synchronous non-thenable work", () => {
    const statements = [];
    const db = { exec: (sql) => statements.push(sql) };

    assert.equal(withImmediateTransaction(db, () => 42), 42);
    assert.deepEqual(statements, ["BEGIN IMMEDIATE", "COMMIT"]);

    statements.length = 0;
    assert.throws(
      () => withImmediateTransaction(db, () => Promise.resolve(42)),
      /synchronous|thenable|Promise/i,
    );
    assert.deepEqual(statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("rethrows the original work error and exposes rollback failure non-destructively", () => {
    const original = new Error("work failed");
    const originalStack = original.stack;
    const rollback = new Error("rollback failed");
    const db = {
      exec(sql) {
        if (sql === "ROLLBACK") throw rollback;
      },
    };

    assert.throws(
      () => withImmediateTransaction(db, () => { throw original; }),
      (error) => {
        assert.strictEqual(error, original);
        assert.equal(error.stack, originalStack);
        assert.strictEqual(error.rollbackError, rollback);
        assert.equal(Object.prototype.propertyIsEnumerable.call(error, "rollbackError"), false);
        return true;
      },
    );
  });
});

describe("idempotency primitives", () => {
  it("canonicalizes validated JSON and hashes object keys deterministically", () => {
    const left = { z: [3, { b: true, a: null }], a: "value" };
    const right = { a: "value", z: [3, { a: null, b: true }] };

    assert.equal(stableJson(left), stableJson(right));
    assert.equal(requestHash(left), requestHash(right));
    assert.match(requestHash(left), /^[a-f0-9]{64}$/);
    assert.throws(() => stableJson({ invalid: undefined }), /validated JSON/i);
  });

  it("requires one bounded unambiguous Idempotency-Key", () => {
    assert.equal(parseIdempotencyKey({
      rawHeaders: ["Idempotency-Key", "attempt-123"],
      headers: { "idempotency-key": "attempt-123" },
    }), "attempt-123");

    for (const request of [
      { rawHeaders: [], headers: {} },
      { rawHeaders: ["Idempotency-Key", "   "], headers: { "idempotency-key": "   " } },
      { rawHeaders: ["Idempotency-Key", "bad\u0007key"], headers: { "idempotency-key": "bad\u0007key" } },
      { rawHeaders: ["Idempotency-Key", "a", "Idempotency-Key", "b"], headers: { "idempotency-key": "a, b" } },
      { rawHeaders: ["Idempotency-Key", "x".repeat(201)], headers: { "idempotency-key": "x".repeat(201) } },
    ]) {
      assert.throws(
        () => parseIdempotencyKey(request),
        (error) => error.status === 428 && error.code === "PRECONDITION_REQUIRED",
      );
    }
  });
});

describe("transactional and idempotent quick-record confirmation", () => {
  it("rolls back every write and the idempotency claim at confirm.afterAction", async () => {
    await withHarness({ failpoints: new Set(["confirm.afterAction"]) }, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "failpoint");
      const versions = await currentTargetVersions(request);
      const key = "failpoint-attempt";
      const before = confirmationSnapshot(databaseUrl, fixture.quickRecord.id, key);

      const result = await request(
        `/api/quick-records/${fixture.quickRecord.id}/confirm`,
        confirmOptions(fixture, versions, key),
      );

      assert.equal(result.response.status, 500);
      assert.equal(result.body.error.code, "INTERNAL_ERROR");
      assert.deepEqual(confirmationSnapshot(databaseUrl, fixture.quickRecord.id, key), before);
    });
  });

  it("rolls back every write when the real audit insert fails", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "audit failure");
      const versions = await currentTargetVersions(request);
      const key = "audit-failure-attempt";
      inspectDatabase(databaseUrl, (db) => db.exec(`
        CREATE TRIGGER reject_confirmation_audit
        BEFORE INSERT ON audit_logs
        WHEN NEW.action = 'quick_record.confirm'
        BEGIN
          SELECT RAISE(ABORT, 'deterministic audit failure');
        END
      `));
      const before = confirmationSnapshot(databaseUrl, fixture.quickRecord.id, key);

      const result = await request(
        `/api/quick-records/${fixture.quickRecord.id}/confirm`,
        confirmOptions(fixture, versions, key),
      );

      assert.equal(result.response.status, 500);
      assert.equal(result.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(result.body), /deterministic audit failure/i);
      assert.deepEqual(confirmationSnapshot(databaseUrl, fixture.quickRecord.id, key), before);
    });
  });

  it("replays the exact first status and body without duplicate writes or increments", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "replay");
      const versions = await currentTargetVersions(request);
      const key = "stable-replay-attempt";
      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
      const options = confirmOptions(fixture, versions, key);

      const first = await request(path, options);
      const replay = await request(path, options);

      assert.equal(first.response.status, 201);
      assert.equal(replay.response.status, first.response.status);
      assert.deepEqual(replay.body, first.body);
      const snapshot = confirmationSnapshot(databaseUrl, fixture.quickRecord.id, key);
      assert.equal(snapshot.quickRecord.version, fixture.quickRecord.version + 1);
      assert.equal(snapshot.customer.version, versions.customer + 1);
      assert.equal(snapshot.opportunity.version, versions.opportunity + 1);
      assert.equal(snapshot.confirmations.length, 3);
      assert.equal(snapshot.actions.length, 1);
      assert.equal(snapshot.risks.length, 1);
      assert.equal(snapshot.audits.length, 1);
      assert.equal(snapshot.idempotency.length, 1);
      assert.equal(snapshot.idempotency[0].state, "completed");
    });
  });

  it("updates one derived action and risk across sequential target confirmations", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const created = await request("/api/quick-records", {
        method: "POST",
        body: JSON.stringify({
          rawContent: "日照中医医院十五五规划需要补齐预算路径",
          sourceChannel: "test",
        }),
      });
      const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, {
        method: "POST",
        body: "{}",
      });
      const fixture = { quickRecord: created.body.item, analysis: analyzed.body.item };
      const versions = await currentTargetVersions(request);
      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;

      const customerResult = await request(
        path,
        confirmOptions(fixture, versions, "sequential-customer", { targets: ["customer"] }),
      );
      assert.equal(customerResult.response.status, 201);
      const customerOnlyState = inspectDatabase(databaseUrl, (db) => ({
        action: db.prepare(
          "SELECT customer_id, opportunity_id FROM action_items WHERE source_record_id = ? AND deleted_at IS NULL",
        ).get(fixture.quickRecord.id),
        risk: db.prepare(`
          SELECT customer_id, opportunity_id
          FROM risk_items
          WHERE source_type = 'quick_record' AND source_id = ? AND deleted_at IS NULL
        `).get(fixture.quickRecord.id),
      }));
      assert.equal(customerOnlyState.action.customer_id, "rizhao");
      assert.equal(customerOnlyState.action.opportunity_id, null);
      assert.equal(customerOnlyState.risk.customer_id, "rizhao");
      assert.equal(customerOnlyState.risk.opportunity_id, null);
      const nextFixture = { ...fixture, quickRecord: customerResult.body.quickRecord };
      const opportunityResult = await request(
        path,
        confirmOptions(nextFixture, versions, "sequential-opportunity", { targets: ["opportunity"] }),
      );
      assert.equal(opportunityResult.response.status, 201);

      const snapshot = confirmationSnapshot(databaseUrl, fixture.quickRecord.id, "sequential-opportunity");
      assert.equal(snapshot.actions.length, 1);
      assert.equal(snapshot.actions[0].version, 2);
      assert.equal(snapshot.risks.length, 1);
      assert.equal(snapshot.risks[0].version, 2);
      assert.equal(snapshot.risks[0].opportunity_id, "op-rizhao-plan");
    });
  });

  it("updates one source-identified risk and audits the affected row across analysis versions", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "risk analysis versions");
      const secondAnalysisId = "risk-analysis-version-two";
      const secondRisk = {
        title: "Second analysis risk title",
        text: "The second analysis identifies a changed decision risk.",
      };
      assert.notEqual(fixture.analysis.summary.risk.title, secondRisk.title);
      inspectDatabase(databaseUrl, (db) => {
        const analysis = {
          source: fixture.analysis.source ?? "mock",
          confidence: fixture.analysis.confidence,
          customer: fixture.analysis.customer,
          opportunity: fixture.analysis.opportunity,
          weekly: fixture.analysis.weekly,
          summary: {
            ...fixture.analysis.summary,
            risk: secondRisk,
          },
        };
        db.prepare(`
          INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          secondAnalysisId,
          fixture.quickRecord.id,
          analysis.source,
          analysis.confidence,
          JSON.stringify(analysis),
        );
      });

      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
      const initialVersions = await currentTargetVersions(request);
      const first = await request(
        path,
        confirmOptions(fixture, initialVersions, "risk-analysis-first"),
      );
      assert.equal(first.response.status, 201);

      const secondFixture = {
        quickRecord: first.body.quickRecord,
        analysis: { id: secondAnalysisId },
      };
      const currentVersions = await currentTargetVersions(request);
      const secondOptions = confirmOptions(
        secondFixture,
        currentVersions,
        "risk-analysis-second",
      );
      const second = await request(path, secondOptions);
      assert.equal(second.response.status, 201);
      assert.equal(second.body.risk.id, first.body.risk.id);
      assert.equal(second.body.risk.version, first.body.risk.version + 1);
      assert.equal(second.body.risk.title, secondRisk.title);

      const state = inspectDatabase(databaseUrl, (db) => ({
        risks: db.prepare(`
          SELECT * FROM risk_items
          WHERE source_type = 'quick_record' AND source_id = ? AND deleted_at IS NULL
          ORDER BY created_at ASC, id ASC
        `).all(fixture.quickRecord.id),
        audits: db.prepare(`
          SELECT before_json, after_json
          FROM audit_logs
          WHERE action = 'quick_record.confirm' AND entity_id = ?
          ORDER BY rowid ASC
        `).all(fixture.quickRecord.id),
      }));
      assert.equal(state.risks.length, 1);
      assert.equal(state.risks[0].id, second.body.risk.id);
      assert.equal(state.risks[0].version, second.body.risk.version);
      assert.equal(state.risks[0].title, secondRisk.title);
      assert.equal(state.audits.length, 2);

      const firstAfter = JSON.parse(state.audits[0].after_json);
      assert.deepEqual(firstAfter.risk, {
        id: first.body.risk.id,
        version: first.body.risk.version,
        title: first.body.risk.title,
      });
      const secondBefore = JSON.parse(state.audits[1].before_json);
      const secondAfter = JSON.parse(state.audits[1].after_json);
      assert.deepEqual(secondBefore.risk, firstAfter.risk);
      assert.deepEqual(secondAfter.risk, {
        id: second.body.risk.id,
        version: second.body.risk.version,
        title: second.body.risk.title,
      });

      const beforeReplay = confirmationSnapshot(
        databaseUrl,
        fixture.quickRecord.id,
        "risk-analysis-second",
      );
      const replay = await request(path, secondOptions);
      assert.equal(replay.response.status, second.response.status);
      assert.deepEqual(replay.body, second.body);
      assert.deepEqual(
        confirmationSnapshot(databaseUrl, fixture.quickRecord.id, "risk-analysis-second"),
        beforeReplay,
      );
    });
  });

  it("reactivates the same derived action after its tombstone blocks the unique source", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "action tombstone");
      const initialVersions = await currentTargetVersions(request);
      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
      const first = await request(
        path,
        confirmOptions(fixture, initialVersions, "tombstone-initial"),
      );
      assert.equal(first.response.status, 201);
      const actionId = first.body.action.id;
      const deleted = await request(`/api/actions/${actionId}`, {
        method: "DELETE",
        headers: { "If-Match": `"${first.body.action.version}"` },
      });
      assert.equal(deleted.response.status, 200);
      assert.equal(deleted.body.deleted.version, first.body.action.version + 1);

      const currentVersions = await currentTargetVersions(request);
      const currentFixture = { ...fixture, quickRecord: first.body.quickRecord };
      const retryOptions = confirmOptions(
        currentFixture,
        currentVersions,
        "tombstone-reactivation",
      );
      const reactivated = await request(path, retryOptions);

      assert.equal(reactivated.response.status, 201);
      assert.equal(reactivated.body.action.id, actionId);
      assert.equal(reactivated.body.action.version, deleted.body.deleted.version + 1);
      const after = inspectDatabase(databaseUrl, (db) => ({
        actions: db.prepare(
          "SELECT * FROM action_items WHERE source_record_id = ? ORDER BY id",
        ).all(fixture.quickRecord.id),
        deleteAudits: db.prepare(
          "SELECT * FROM audit_logs WHERE action = 'action.delete' AND entity_id = ?",
        ).all(actionId),
      }));
      assert.equal(after.actions.length, 1);
      assert.equal(after.actions[0].id, actionId);
      assert.equal(after.actions[0].version, deleted.body.deleted.version + 1);
      assert.equal(after.actions[0].deleted_at, null);
      assert.equal(after.actions[0].deleted_by, null);
      assert.equal(after.deleteAudits.length, 1);

      const replay = await request(path, retryOptions);
      assert.equal(replay.response.status, reactivated.response.status);
      assert.deepEqual(replay.body, reactivated.body);
      const replayedAction = inspectDatabase(databaseUrl, (db) => db.prepare(
        "SELECT * FROM action_items WHERE source_record_id = ?",
      ).get(fixture.quickRecord.id));
      assert.equal(replayedAction.id, actionId);
      assert.equal(replayedAction.version, after.actions[0].version);
      assert.equal(replayedAction.deleted_at, null);
    });
  });

  it("reactivates the same derived risk after its quick-record source is tombstoned", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "risk tombstone");
      const initialVersions = await currentTargetVersions(request);
      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
      const first = await request(
        path,
        confirmOptions(fixture, initialVersions, "risk-tombstone-initial"),
      );
      assert.equal(first.response.status, 201);
      const riskId = first.body.risk.id;
      const deleted = await request(`/api/risks/${riskId}`, {
        method: "DELETE",
        headers: { "If-Match": `"${first.body.risk.version}"` },
      });
      assert.equal(deleted.response.status, 200);
      assert.equal(deleted.body.deleted.version, first.body.risk.version + 1);

      const currentVersions = await currentTargetVersions(request);
      const currentFixture = { ...fixture, quickRecord: first.body.quickRecord };
      const retryOptions = confirmOptions(
        currentFixture,
        currentVersions,
        "risk-tombstone-reactivation",
      );
      const reactivated = await request(path, retryOptions);

      assert.equal(reactivated.response.status, 201);
      assert.equal(reactivated.body.risk.id, riskId);
      assert.equal(reactivated.body.risk.version, deleted.body.deleted.version + 1);
      assert.equal(reactivated.body.risk.status, "open");
      const after = inspectDatabase(databaseUrl, (db) => ({
        risks: db.prepare(`
          SELECT * FROM risk_items
          WHERE source_type = 'quick_record' AND source_id = ?
          ORDER BY id
        `).all(fixture.quickRecord.id),
        deleteAudits: db.prepare(
          "SELECT * FROM audit_logs WHERE action = 'risk.delete' AND entity_id = ?",
        ).all(riskId),
      }));
      assert.equal(after.risks.length, 1);
      assert.equal(after.risks[0].id, riskId);
      assert.equal(after.risks[0].version, deleted.body.deleted.version + 1);
      assert.equal(after.risks[0].status, "open");
      assert.equal(after.risks[0].deleted_at, null);
      assert.equal(after.risks[0].deleted_by, null);
      assert.equal(after.deleteAudits.length, 1);

      const replay = await request(path, retryOptions);
      assert.equal(replay.response.status, reactivated.response.status);
      assert.deepEqual(replay.body, reactivated.body);
      const replayedRisk = inspectDatabase(databaseUrl, (db) => db.prepare(`
        SELECT * FROM risk_items
        WHERE source_type = 'quick_record' AND source_id = ?
      `).get(fixture.quickRecord.id));
      assert.equal(replayedRisk.id, riskId);
      assert.equal(replayedRisk.version, after.risks[0].version);
      assert.equal(replayedRisk.deleted_at, null);
    });
  });

  it("prefers an active legacy quick-record risk over tombstoned history", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "active risk preference");
      const initialVersions = await currentTargetVersions(request);
      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
      const first = await request(
        path,
        confirmOptions(fixture, initialVersions, "active-risk-initial"),
      );
      assert.equal(first.response.status, 201);
      const tombstoneId = first.body.risk.id;
      const deleted = await request(`/api/risks/${tombstoneId}`, {
        method: "DELETE",
        headers: { "If-Match": `"${first.body.risk.version}"` },
      });
      assert.equal(deleted.response.status, 200);

      inspectDatabase(databaseUrl, (db) => db.prepare(`
        INSERT INTO risk_items (
          id, customer_id, opportunity_id, title, target, score, severity,
          status, evidence, action, source_type, source_id, tone,
          version, created_at, updated_at
        ) VALUES (
          'legacy-active-risk', 'rizhao', 'op-rizhao-plan', 'Legacy active risk',
          'legacy target', 70, 'medium', 'open', 'legacy evidence', 'legacy action',
          'quick_record', ?, 'amber', 7,
          '2026-07-16T10:00:00.000Z', '2026-07-16T10:00:00.000Z'
        )
      `).run(fixture.quickRecord.id));

      const currentVersions = await currentTargetVersions(request);
      const currentFixture = { ...fixture, quickRecord: first.body.quickRecord };
      const result = await request(
        path,
        confirmOptions(currentFixture, currentVersions, "active-risk-reconfirm"),
      );

      assert.equal(result.response.status, 201);
      assert.equal(result.body.risk.id, "legacy-active-risk");
      assert.equal(result.body.risk.version, 8);
      const rows = inspectDatabase(databaseUrl, (db) => db.prepare(`
        SELECT id, version, deleted_at, deleted_by
        FROM risk_items
        WHERE source_type = 'quick_record' AND source_id = ?
        ORDER BY id
      `).all(fixture.quickRecord.id));
      assert.equal(rows.filter((row) => row.deleted_at === null).length, 1);
      assert.equal(rows.find((row) => row.id === "legacy-active-risk").version, 8);
      const tombstone = rows.find((row) => row.id === tombstoneId);
      assert.equal(tombstone.version, deleted.body.deleted.version);
      assert.ok(tombstone.deleted_at);
      assert.equal(tombstone.deleted_by, "anonymous");
    });
  });

  it("audits actual unchanged derived rows after a weekly-only confirmation", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "weekly audit state");
      const versions = await currentTargetVersions(request);
      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
      const full = await request(path, confirmOptions(fixture, versions, "audit-full-targets"));
      assert.equal(full.response.status, 201);

      const weeklyFixture = { ...fixture, quickRecord: full.body.quickRecord };
      const weekly = await request(
        path,
        confirmOptions(weeklyFixture, versions, "audit-weekly-only", { targets: ["weekly"] }),
      );
      assert.equal(weekly.response.status, 201);

      const state = inspectDatabase(databaseUrl, (db) => ({
        action: db.prepare(
          "SELECT * FROM action_items WHERE source_record_id = ? AND deleted_at IS NULL",
        ).get(fixture.quickRecord.id),
        risk: db.prepare(
          "SELECT * FROM risk_items WHERE source_type = 'quick_record' AND source_id = ? AND deleted_at IS NULL",
        ).get(fixture.quickRecord.id),
        audits: db.prepare(`
          SELECT before_json, after_json
          FROM audit_logs
          WHERE action = 'quick_record.confirm' AND entity_id = ?
          ORDER BY rowid ASC
        `).all(fixture.quickRecord.id),
      }));
      assert.equal(state.audits.length, 2);
      assert.equal(state.action.id, full.body.action.id);
      assert.equal(state.action.version, full.body.action.version);
      assert.equal(state.risk.id, full.body.risk.id);
      assert.equal(state.risk.version, full.body.risk.version);

      const fullAfter = JSON.parse(state.audits[0].after_json);
      assert.deepEqual(fullAfter.action, {
        id: state.action.id,
        version: state.action.version,
      });
      assert.deepEqual(fullAfter.risk, {
        id: state.risk.id,
        version: state.risk.version,
        title: state.risk.title,
      });

      const weeklyBefore = JSON.parse(state.audits[1].before_json);
      const weeklyAfter = JSON.parse(state.audits[1].after_json);
      assert.deepEqual(weeklyBefore.action, {
        id: state.action.id,
        version: state.action.version,
      });
      assert.deepEqual(weeklyAfter.action, weeklyBefore.action);
      assert.deepEqual(weeklyBefore.risk, {
        id: state.risk.id,
        version: state.risk.version,
        title: state.risk.title,
      });
      assert.deepEqual(weeklyAfter.risk, weeklyBefore.risk);
    });
  });

  it("rejects reuse of one key with a different request hash", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "hash conflict");
      const versions = await currentTargetVersions(request);
      const key = "reused-attempt";
      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
      const first = await request(path, confirmOptions(fixture, versions, key, { targets: ["weekly"] }));
      assert.equal(first.response.status, 201);
      const beforeReuse = confirmationSnapshot(databaseUrl, fixture.quickRecord.id, key);

      const reused = await request(path, confirmOptions(fixture, versions, key, { targets: ["customer"] }));

      assert.equal(reused.response.status, 409);
      assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
      assert.deepEqual(confirmationSnapshot(databaseUrl, fixture.quickRecord.id, key), beforeReuse);
    });
  });

  it("requires the idempotency key, quick-record version, and selected target versions", async () => {
    await withHarness({}, async ({ request }) => {
      const fixture = await createAnalyzedRecord(request, "preconditions");
      const versions = await currentTargetVersions(request);
      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
      const valid = confirmOptions(fixture, versions, "required-attempt");

      const missingKey = await request(path, { ...valid, headers: { "If-Match": `"${fixture.quickRecord.version}"` } });
      assert.equal(missingKey.response.status, 428);
      assert.equal(missingKey.body.error.code, "PRECONDITION_REQUIRED");

      const missingIfMatch = await request(path, { ...valid, headers: { "Idempotency-Key": "required-attempt-2" } });
      assert.equal(missingIfMatch.response.status, 428);
      assert.equal(missingIfMatch.body.error.code, "PRECONDITION_REQUIRED");

      const missingTargetVersion = await request(path, {
        ...valid,
        headers: { ...valid.headers, "Idempotency-Key": "required-attempt-3" },
        body: JSON.stringify({
          targets: ["customer"],
          confirmedBy: "Task 9 tester",
          analysisVersionId: fixture.analysis.id,
        }),
      });
      assert.equal(missingTargetVersion.response.status, 422);
      assert.equal(missingTargetVersion.body.error.code, "VALIDATION_ERROR");
      assert.equal(missingTargetVersion.body.error.fields.targetVersions, "required");
    });
  });

  it("rejects single-target confirmations that would break the final customer-opportunity pair", async () => {
    for (const target of ["customer", "opportunity"]) {
      await withHarness({}, async ({ databaseUrl, request }) => {
        const created = await request("/api/quick-records", {
          method: "POST",
          body: JSON.stringify({
            rawContent: "日照中医医院十五五规划需要补齐预算路径",
            sourceChannel: "test",
            customerId: "huangdao-tcm",
            opportunityId: "op-huangdao-tcm",
          }),
        });
        assert.equal(created.response.status, 201);
        const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, {
          method: "POST",
          body: "{}",
        });
        assert.equal(analyzed.response.status, 201);
        assert.equal(analyzed.body.item.customer.id, "rizhao");
        assert.equal(analyzed.body.item.opportunity.id, "op-rizhao-plan");

        const fixture = { quickRecord: created.body.item, analysis: analyzed.body.item };
        const versions = await currentTargetVersions(request);
        const key = `relationship-${target}`;
        const before = relationshipSnapshot(databaseUrl, fixture.quickRecord.id, key);
        const result = await request(
          `/api/quick-records/${fixture.quickRecord.id}/confirm`,
          confirmOptions(fixture, versions, key, { targets: [target] }),
        );

        assert.equal(result.response.status, 422, target);
        assert.equal(result.body.error.code, "VALIDATION_ERROR", target);
        assert.equal(result.body.error.fields.opportunityId, "relationship", target);
        assert.deepEqual(
          relationshipSnapshot(databaseUrl, fixture.quickRecord.id, key),
          before,
          target,
        );
      });
    }
  });

  it("rolls back the claim and every target on stale quick-record or target versions", async () => {
    for (const staleTarget of ["quickRecord", "customer", "opportunity"]) {
      await withHarness({}, async ({ databaseUrl, request }) => {
        const fixture = await createAnalyzedRecord(request, `stale ${staleTarget}`);
        const versions = await currentTargetVersions(request);
        const key = `stale-${staleTarget}`;
        inspectDatabase(databaseUrl, (db) => {
          if (staleTarget === "quickRecord") {
            db.prepare("UPDATE quick_records SET version = version + 1 WHERE id = ?").run(fixture.quickRecord.id);
          } else {
            const table = staleTarget === "customer" ? "customers" : "opportunities";
            const id = staleTarget === "customer" ? "rizhao" : "op-rizhao-plan";
            db.prepare(`UPDATE ${table} SET version = version + 1 WHERE id = ?`).run(id);
          }
        });
        const before = confirmationSnapshot(databaseUrl, fixture.quickRecord.id, key);

        const result = await request(
          `/api/quick-records/${fixture.quickRecord.id}/confirm`,
          confirmOptions(fixture, versions, key),
        );

        assert.equal(result.response.status, 409, staleTarget);
        assert.equal(result.body.error.code, "VERSION_CONFLICT", staleTarget);
        assert.equal(result.body.error.fields.currentVersion, 2, staleTarget);
        assert.deepEqual(confirmationSnapshot(databaseUrl, fixture.quickRecord.id, key), before, staleTarget);
      });
    }
  });

  it("prunes a bounded global expiry batch and still reclaims the current expired key", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "expired claim");
      const versions = await currentTargetVersions(request);
      const key = "expired-attempt";
      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
      inspectDatabase(databaseUrl, (db) => {
        const insert = db.prepare(`
          INSERT INTO idempotency_keys (
            actor, method, request_path, key, request_hash, state,
            response_status, response_json, created_at, expires_at
          ) VALUES (?, 'POST', ?, ?, 'expired-hash', 'processing', NULL, NULL, ?, ?)
        `);
        for (let index = 0; index < 105; index += 1) {
          insert.run(
            "anonymous",
            `/api/unrelated/${index}`,
            `unrelated-expired-${index}`,
            "2000-01-01T00:00:00.000Z",
            "2000-01-02T00:00:00.000Z",
          );
        }
        insert.run(
          "anonymous",
          path,
          key,
          "2001-01-01T00:00:00.000Z",
          "2001-01-02T00:00:00.000Z",
        );
        insert.run(
          "anonymous",
          "/api/unrelated/live",
          "unrelated-live",
          "2999-01-01T00:00:00.000Z",
          "2999-01-02T00:00:00.000Z",
        );
      });

      const result = await request(path, confirmOptions(fixture, versions, key));

      assert.equal(result.response.status, 201);
      const state = inspectDatabase(databaseUrl, (db) => ({
        current: db.prepare(
          "SELECT * FROM idempotency_keys WHERE actor = 'anonymous' AND request_path = ? AND key = ?",
        ).all(path, key),
        expiredUnrelated: db.prepare(`
          SELECT COUNT(*) AS count FROM idempotency_keys
          WHERE request_path LIKE '/api/unrelated/%'
            AND expires_at = '2000-01-02T00:00:00.000Z'
        `).get().count,
        live: db.prepare(
          "SELECT * FROM idempotency_keys WHERE request_path = '/api/unrelated/live' AND key = 'unrelated-live'",
        ).get(),
      }));
      assert.equal(state.expiredUnrelated, 5);
      assert.equal(state.live.expires_at, "2999-01-02T00:00:00.000Z");
      assert.equal(state.current.length, 1);
      assert.equal(state.current[0].state, "completed");
      assert.notEqual(state.current[0].request_hash, "expired-hash");
      assert.ok(Date.parse(state.current[0].expires_at) > Date.now() + 23 * 60 * 60 * 1000);
    });
  });

  it("returns REQUEST_IN_PROGRESS for an active matching claim", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request, "active claim");
      const versions = await currentTargetVersions(request);
      const key = "active-attempt";
      const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
      const options = confirmOptions(fixture, versions, key);
      inspectDatabase(databaseUrl, (db) => {
        db.prepare(`
          INSERT INTO idempotency_keys (
            actor, method, request_path, key, request_hash, state,
            response_status, response_json, created_at, expires_at
          ) VALUES (?, 'POST', ?, ?, ?, 'processing', NULL, NULL, ?, ?)
        `).run(
          "anonymous",
          path,
          key,
          requestHash(JSON.parse(options.body)),
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
        );
      });

      const result = await request(path, options);

      assert.equal(result.response.status, 409);
      assert.equal(result.body.error.code, "REQUEST_IN_PROGRESS");
      const snapshot = confirmationSnapshot(databaseUrl, fixture.quickRecord.id, key);
      assert.equal(snapshot.idempotency.length, 1);
      assert.equal(snapshot.idempotency[0].state, "processing");
      assert.equal(snapshot.confirmations.length, 0);
    });
  });
});
