import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";
import { runConcurrentWorkerRequests } from "./helpers/concurrency-worker.js";

const workerCount = 4;

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

function serverOptions(databaseUrl, seed = false) {
  return {
    databaseUrl,
    seed,
    nodeEnv: "test",
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: false,
    authAccount: "",
    authPassword: "",
  };
}

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createAnalyzedRecord(baseUrl, suffix, links = {}) {
  const created = await jsonRequest(baseUrl, "/api/quick-records", {
    method: "POST",
    body: JSON.stringify({
      rawContent: `concurrent record ${suffix}`,
      sourceChannel: "test",
      ...(links.customerId ? { customerId: links.customerId } : {}),
      ...(links.opportunityId ? { opportunityId: links.opportunityId } : {}),
    }),
  });
  assert.equal(created.status, 201);
  const analyzed = await jsonRequest(baseUrl, `/api/quick-records/${created.body.item.id}/analyze`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(analyzed.status, 201);
  return { quickRecord: created.body.item, analysis: analyzed.body.item };
}

async function targetVersions(baseUrl) {
  const [customers, opportunities] = await Promise.all([
    jsonRequest(baseUrl, "/api/customers"),
    jsonRequest(baseUrl, "/api/opportunities"),
  ]);
  return {
    customer: customers.body.items.find((item) => item.id === "rizhao").version,
    opportunity: opportunities.body.items.find((item) => item.id === "op-rizhao-plan").version,
  };
}

function fullConfirmationOptions(fixture, versions, key) {
  return {
    method: "POST",
    headers: {
      "Idempotency-Key": key,
      "If-Match": `"${fixture.quickRecord.version}"`,
    },
    body: JSON.stringify({
      targets: ["customer", "opportunity", "weekly"],
      confirmedBy: "concurrency tester",
      note: "worker-thread confirmation",
      analysisVersionId: fixture.analysis.id,
      targetVersions: versions,
    }),
  };
}

function distribute(requests, count = workerCount) {
  const batches = Array.from({ length: count }, () => []);
  requests.forEach((request, index) => batches[index % count].push(request));
  return batches;
}

function assertWorkerOverlap(run) {
  assert.equal(run.batches.length, workerCount);
  assert.equal(new Set(run.batches.map((batch) => batch.threadId)).size, workerCount);
  const latestStart = Math.max(...run.batches.map((batch) => batch.startedAt));
  const earliestFinish = Math.min(...run.batches.map((batch) => batch.finishedAt));
  assert.ok(latestStart <= earliestFinish, "worker request batches must overlap after the barrier");
}

it("50 same-key requests across worker connections commit one full derived update", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-worker-same-key-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  let setupServer = createServer(serverOptions(databaseUrl, true));
  try {
    const baseUrl = await listen(setupServer);
    const fixture = await createAnalyzedRecord(baseUrl, "same-key", {
      customerId: "rizhao",
      opportunityId: "op-rizhao-plan",
    });
    const initialVersions = await targetVersions(baseUrl);
    const path = `/api/quick-records/${fixture.quickRecord.id}/confirm`;
    const preliminary = await jsonRequest(
      baseUrl,
      path,
      fullConfirmationOptions(fixture, initialVersions, "worker-preliminary"),
    );
    assert.equal(preliminary.status, 201);
    const currentFixture = { ...fixture, quickRecord: preliminary.body.quickRecord };
    const currentVersions = await targetVersions(baseUrl);
    const sharedOptions = fullConfirmationOptions(
      currentFixture,
      currentVersions,
      "worker-fifty-shared",
    );
    const before = (() => {
      const db = createConnection({ databaseUrl });
      try {
        return {
          quickRecord: db.prepare("SELECT * FROM quick_records WHERE id = ?").get(fixture.quickRecord.id),
          customer: db.prepare("SELECT * FROM customers WHERE id = 'rizhao'").get(),
          opportunity: db.prepare("SELECT * FROM opportunities WHERE id = 'op-rizhao-plan'").get(),
          action: db.prepare("SELECT * FROM action_items WHERE source_record_id = ?").get(fixture.quickRecord.id),
          risk: db.prepare(
            "SELECT * FROM risk_items WHERE source_type = 'quick_record' AND source_id = ?",
          ).get(fixture.quickRecord.id),
          confirmationIds: db.prepare(
            "SELECT id FROM manual_confirmations WHERE quick_record_id = ? ORDER BY id",
          ).all(fixture.quickRecord.id).map((row) => row.id),
          auditCount: db.prepare(
            "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'quick_record.confirm' AND entity_id = ?",
          ).get(fixture.quickRecord.id).count,
        };
      } finally {
        db.close();
      }
    })();
    assert.equal(before.confirmationIds.length, 3);
    await closeServer(setupServer);
    setupServer = null;

    const requests = Array.from({ length: 50 }, () => ({ path, options: sharedOptions }));
    const run = await runConcurrentWorkerRequests({
      databaseUrl,
      batches: distribute(requests),
      timeoutMs: 30_000,
    });
    assertWorkerOverlap(run);
    const results = run.batches.flatMap((batch) => batch.results);
    assert.equal(results.length, 50);
    assert.deepEqual(new Set(results.map((result) => result.status)), new Set([201]));
    for (const result of results) assert.deepEqual(result.body, results[0].body);

    const db = createConnection({ databaseUrl });
    try {
      const quickRecord = db.prepare("SELECT * FROM quick_records WHERE id = ?").get(fixture.quickRecord.id);
      const customer = db.prepare("SELECT * FROM customers WHERE id = 'rizhao'").get();
      const opportunity = db.prepare("SELECT * FROM opportunities WHERE id = 'op-rizhao-plan'").get();
      const actions = db.prepare("SELECT * FROM action_items WHERE source_record_id = ?").all(fixture.quickRecord.id);
      const risks = db.prepare(
        "SELECT * FROM risk_items WHERE source_type = 'quick_record' AND source_id = ?",
      ).all(fixture.quickRecord.id);
      const confirmationIds = db.prepare(
        "SELECT id FROM manual_confirmations WHERE quick_record_id = ? ORDER BY id",
      ).all(fixture.quickRecord.id).map((row) => row.id);
      assert.equal(quickRecord.version, before.quickRecord.version + 1);
      assert.equal(customer.version, before.customer.version + 1);
      assert.equal(opportunity.version, before.opportunity.version + 1);
      assert.equal(actions.length, 1);
      assert.equal(actions[0].id, before.action.id);
      assert.equal(actions[0].version, before.action.version + 1);
      assert.equal(risks.length, 1);
      assert.equal(risks[0].id, before.risk.id);
      assert.equal(risks[0].version, before.risk.version + 1);
      assert.equal(confirmationIds.length, 3);
      assert.deepEqual(confirmationIds, before.confirmationIds);
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'quick_record.confirm' AND entity_id = ?",
      ).get(fixture.quickRecord.id).count, before.auditCount + 1);
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = 'worker-fifty-shared' AND state = 'completed'",
      ).get().count, 1);
      assert.equal(results[0].body.quickRecord.version, quickRecord.version);
      assert.equal(results[0].body.action.id, actions[0].id);
      assert.equal(results[0].body.action.version, actions[0].version);
      assert.equal(results[0].body.risk.id, risks[0].id);
      assert.equal(results[0].body.risk.version, risks[0].version);
    } finally {
      db.close();
    }
  } finally {
    await closeServer(setupServer);
    await rm(tempDir, { recursive: true, force: true });
  }
});

it("20 distinct writes overlap across worker connections without database damage", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-worker-distinct-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  let setupServer = createServer(serverOptions(databaseUrl, true));
  try {
    const baseUrl = await listen(setupServer);
    const fixtures = [];
    for (let index = 0; index < 20; index += 1) {
      fixtures.push(await createAnalyzedRecord(baseUrl, `distinct-${index}`));
    }
    await closeServer(setupServer);
    setupServer = null;

    const requests = fixtures.map((fixture, index) => ({
      path: `/api/quick-records/${fixture.quickRecord.id}/confirm`,
      options: {
        method: "POST",
        headers: {
          "Idempotency-Key": `worker-distinct-${index}`,
          "If-Match": `"${fixture.quickRecord.version}"`,
        },
        body: JSON.stringify({
          targets: ["weekly"],
          confirmedBy: "concurrency tester",
          analysisVersionId: fixture.analysis.id,
        }),
      },
    }));
    const run = await runConcurrentWorkerRequests({
      databaseUrl,
      batches: distribute(requests),
      timeoutMs: 30_000,
    });
    assertWorkerOverlap(run);
    const results = run.batches.flatMap((batch) => batch.results);
    assert.equal(results.length, 20);
    assert.deepEqual(results.map((result) => result.status), Array(20).fill(201));
    assert.doesNotMatch(JSON.stringify(results), /SQLITE_BUSY|database is locked/i);

    const db = createConnection({ databaseUrl });
    try {
      for (const fixture of fixtures) {
        assert.equal(
          db.prepare("SELECT version FROM quick_records WHERE id = ?").get(fixture.quickRecord.id).version,
          fixture.quickRecord.version + 1,
        );
      }
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS count FROM manual_confirmations WHERE quick_record_id IN (SELECT id FROM quick_records WHERE raw_content LIKE 'concurrent record distinct-%')",
      ).get().count, 20);
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'quick_record.confirm'",
      ).get().count, 20);
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_keys WHERE key LIKE 'worker-distinct-%' AND state = 'completed'",
      ).get().count, 20);
      assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally {
      db.close();
    }
  } finally {
    await closeServer(setupServer);
    await rm(tempDir, { recursive: true, force: true });
  }
});
