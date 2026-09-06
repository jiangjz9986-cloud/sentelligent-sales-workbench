import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";
import {
  createQuickRecordDiffConfirmationPayload,
  normalizeQuickRecordDiffPreview,
} from "../../outputs/product-design-prototype/src/features/salesWorkbench/quickRecordDiffModel.js";

const passwordField = "pass" + "word";
const accountA = "ownera";
const accountB = "ownerb";
const loginA = "quick-confirm-api-owner-a";
const loginB = "quick-confirm-api-owner-b";
const adminHash = await hashPassword(loginA, { salt: Buffer.alloc(16, 71) });

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

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function withHarness(work) {
  const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-quick-confirm-api-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  const server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: true,
    authAccount: accountA,
    authPassword: "",
    authPasswordHash: adminHash,
    authSessionSecret: Buffer.alloc(32, 72).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
    quickRecordConfirmationClock: () => new Date("2026-08-31T12:00:00.000Z"),
  });

  try {
    const baseUrl = await listen(server);
    const rawRequest = async (path, options = {}) => {
      const headers = { ...(options.headers ?? {}) };
      if (options.body !== undefined && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
      const text = await response.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { response, body };
    };
    const login = async (account, secret) => {
      const result = await rawRequest("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ account, [passwordField]: secret }),
      });
      assert.equal(result.response.status, 200, `login ${account}`);
      return {
        account,
        cookie: cookiePair(result.response),
        csrf: result.body.csrfToken,
      };
    };
    const requestAs = (session) => async (path, options = {}) => {
      const method = String(options.method ?? "GET").toUpperCase();
      return rawRequest(path, {
        ...options,
        headers: {
          Cookie: session.cookie,
          ...(method !== "GET" && method !== "HEAD" ? { "X-CSRF-Token": session.csrf } : {}),
          ...(options.headers ?? {}),
        },
      });
    };

    const sessionA = await login(accountA, loginA);
    const asA = requestAs(sessionA);
    const member = await asA("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        account: accountB,
        displayName: "确认隔离账号乙",
        [passwordField]: loginB,
        role: "member",
      }),
    });
    assert.equal(member.response.status, 201);
    const sessionB = await login(accountB, loginB);
    const asB = requestAs(sessionB);

    await work({ asA, asB, databaseUrl, rawRequest, sessionA, sessionB });
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

async function createAnalyzedFixture(request, databaseUrl, suffix, { enrichSuggestions = false } = {}) {
  const customer = await request("/api/customers", {
    method: "POST",
    body: JSON.stringify({
      name: `确认测试客户-${suffix}`,
      relation: 42,
      needs: ["原诉求"],
    }),
  });
  assert.equal(customer.response.status, 201);

  const opportunity = await request("/api/opportunities", {
    method: "POST",
    body: JSON.stringify({
      customerId: customer.body.item.id,
      name: `确认测试商机-${suffix}`,
      requirements: ["旧需求"],
    }),
  });
  assert.equal(opportunity.response.status, 201);

  const created = await request("/api/quick-records", {
    method: "POST",
    body: JSON.stringify({
      rawContent: `拜访确认测试客户 ${suffix}，客户提出补齐本地灾备规划，下周安排技术交流。`,
      occurredAt: "2026-08-31T10:00:00+08:00",
      sourceChannel: "api-test",
      customerId: customer.body.item.id,
      opportunityId: opportunity.body.item.id,
    }),
  });
  assert.equal(created.response.status, 201);

  const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(analyzed.response.status, 201);

  if (enrichSuggestions) {
    inspectDatabase(databaseUrl, (db) => {
      const row = db.prepare(`
        SELECT id, analysis_json FROM ai_insights
        WHERE quick_record_id = $quickRecordId
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get({ $quickRecordId: created.body.item.id });
      const analysis = JSON.parse(row.analysis_json);
      analysis.customerTemperature = { suggestedValue: 88 };
      analysis.financial = {
        expenseId: `expense-${suffix}`,
        currentAmountCents: 0,
        amountCents: 12345,
        version: 1,
      };
      db.prepare("UPDATE ai_insights SET analysis_json = $analysis WHERE id = $id").run({
        $analysis: JSON.stringify(analysis),
        $id: row.id,
      });
    });
  }

  return {
    customer: customer.body.item,
    opportunity: opportunity.body.item,
    quickRecord: analyzed.body.quickRecord ?? created.body.item,
    analysis: analyzed.body.item,
  };
}

async function createPreview(request, quickRecordId, expectedStatus = 201) {
  const result = await request(`/api/quick-records/${quickRecordId}/confirmation-previews`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(result.response.status, expectedStatus);
  assert.ok(result.body?.item);
  return result.body.item;
}

function confirmationPins(preview) {
  return {
    confirm: true,
    suggestionIdentity: preview.identity,
    expectedQuickRecordVersion: preview.quickRecordVersion,
    analysisVersionId: preview.analysisVersionId,
    summaryHash: preview.summaryHash,
    evidenceHash: preview.evidenceHash,
  };
}

function businessSnapshot(databaseUrl, fixture) {
  return inspectDatabase(databaseUrl, (db) => ({
    customer: db.prepare(
      "SELECT needs, relation, version FROM customers WHERE id = $id AND owner = $owner",
    ).get({ $id: fixture.customer.id, $owner: accountA }),
    opportunity: db.prepare(
      "SELECT requirements, version FROM opportunities WHERE id = $id AND owner = $owner",
    ).get({ $id: fixture.opportunity.id, $owner: accountA }),
    weekly: db.prepare(
      "SELECT id, entries_json, version, status FROM weekly_reports WHERE owner = $owner ORDER BY id",
    ).all({ $owner: accountA }),
    quickRecord: db.prepare(`
      SELECT status, version, confirmation_preview_id, confirmation_preview_status
      FROM quick_records WHERE id = $id AND owner = $owner
    `).get({ $id: fixture.quickRecord.id, $owner: accountA }),
    actionCount: Number(db.prepare(
      "SELECT COUNT(*) AS count FROM action_items WHERE owner = $owner",
    ).get({ $owner: accountA }).count),
    riskCount: Number(db.prepare(
      "SELECT COUNT(*) AS count FROM risk_items WHERE owner = $owner",
    ).get({ $owner: accountA }).count),
    auditCount: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs
      WHERE entity_type = 'quick_record_confirmation_preview'
    `).get().count),
  }));
}

function terminalLockSnapshot(databaseUrl, fixture) {
  return inspectDatabase(databaseUrl, (db) => ({
    quickRecord: db.prepare(`
      SELECT * FROM quick_records
      WHERE id = $id AND owner = $owner
    `).get({ $id: fixture.quickRecord.id, $owner: accountA }),
    insights: db.prepare(`
      SELECT * FROM ai_insights
      WHERE quick_record_id = $quickRecordId
      ORDER BY created_at, rowid
    `).all({ $quickRecordId: fixture.quickRecord.id }),
    previews: db.prepare(`
      SELECT * FROM quick_record_confirmation_previews
      WHERE quick_record_id = $quickRecordId AND owner = $owner
      ORDER BY created_at, rowid
    `).all({ $quickRecordId: fixture.quickRecord.id, $owner: accountA }),
    audits: db.prepare(`
      SELECT * FROM audit_logs
      ORDER BY created_at, id
    `).all(),
  }));
}

describe("quick-record confirmation preview HTTP API", () => {
  it("creates and replays a durable preview without changing business data", async () => {
    await withHarness(async ({ asA, databaseUrl }) => {
      const fixture = await createAnalyzedFixture(asA, databaseUrl, "preview", { enrichSuggestions: true });
      const savedAnalysis = await asA(`/api/quick-records/${fixture.quickRecord.id}/analysis`, {
        method: "PATCH",
        headers: { "If-Match": `"${fixture.quickRecord.version}"` },
        body: JSON.stringify({
          summary: {
            request: "补齐本地灾备规划并保留确认预览字段。",
            feedback: fixture.analysis.summary.feedback.text,
            risk: fixture.analysis.summary.risk.text,
            action: fixture.analysis.summary.action.text,
          },
        }),
      });
      assert.equal(savedAnalysis.response.status, 200);
      assert.equal(savedAnalysis.body.quickRecord.confirmationPreviewId, null);
      assert.equal(savedAnalysis.body.quickRecord.confirmationPreviewStatus, null);
      fixture.quickRecord = savedAnalysis.body.quickRecord;
      const before = businessSnapshot(databaseUrl, fixture);

      const preview = await createPreview(asA, fixture.quickRecord.id);
      assert.equal(preview.status, "open");
      assert.equal(preview.requiresHumanConfirmation, true);
      assert.equal(preview.automaticWriteAllowed, false);
      assert.deepEqual(
        preview.items
          .filter((item) => item.confirmationMode === "explicit")
          .map((item) => `${item.target}.${item.field}`),
        ["customer.needs", "opportunity.requirements", "weekly.entries"],
      );
      assert.ok(preview.items.some((item) => item.confirmationMode === "independent"));
      assert.ok(preview.items.some((item) => item.target === "action" && item.confirmationMode === "unsupported"));
      assert.ok(preview.items.some((item) => item.target === "financial" && item.confirmationMode === "unsupported"));

      const frontendModel = normalizeQuickRecordDiffPreview(preview);
      assert.equal(frontendModel.confirmationContractValid, true);
      assert.equal(frontendModel.readOnly, false);
      assert.deepEqual(
        frontendModel.items.filter((item) => item.confirmable).map((item) => `${item.target}.${item.field}`),
        ["customer.needs", "opportunity.requirements", "weekly.entries"],
      );
      assert.deepEqual(
        createQuickRecordDiffConfirmationPayload(frontendModel, { confirmAll: true }),
        { previewId: preview.id, ...confirmationPins(preview) },
      );

      const afterPreview = businessSnapshot(databaseUrl, fixture);
      assert.deepEqual(afterPreview.customer, before.customer);
      assert.deepEqual(afterPreview.opportunity, before.opportunity);
      assert.deepEqual(afterPreview.weekly, before.weekly);
      assert.equal(afterPreview.actionCount, before.actionCount);
      assert.equal(afterPreview.riskCount, before.riskCount);
      assert.equal(afterPreview.auditCount, before.auditCount);
      assert.equal(afterPreview.quickRecord.status, "analyzed");
      assert.equal(afterPreview.quickRecord.confirmation_preview_id, preview.id);
      assert.equal(afterPreview.quickRecord.confirmation_preview_status, "open");

      const replay = await createPreview(asA, fixture.quickRecord.id, 200);
      assert.equal(replay.id, preview.id);
      assert.equal(replay.identity, preview.identity);
      assert.equal(replay.replayed, true);

      const loaded = await asA(`/api/quick-record-confirmation-previews/${preview.id}`);
      assert.equal(loaded.response.status, 200);
      assert.equal(loaded.body.item.id, preview.id);
      assert.equal(loaded.body.item.status, "open");

      const history = await asA("/api/quick-records");
      assert.equal(history.response.status, 200);
      const historyItem = history.body.items.find((item) => item.id === fixture.quickRecord.id);
      assert.equal(historyItem.confirmationPreviewId, preview.id);
      assert.equal(historyItem.confirmationPreviewStatus, "open");
    });
  });

  it("confirms all only once and writes only customer needs, opportunity requirements, and weekly entries", async () => {
    await withHarness(async ({ asA, databaseUrl }) => {
      const fixture = await createAnalyzedFixture(asA, databaseUrl, "all", { enrichSuggestions: true });
      const preview = await createPreview(asA, fixture.quickRecord.id);
      const before = businessSnapshot(databaseUrl, fixture);
      const payload = confirmationPins(preview);

      const confirmed = await asA(`/api/quick-record-confirmation-previews/${preview.id}/confirm-all`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      assert.equal(confirmed.response.status, 200);
      assert.equal(confirmed.body.item.status, "confirmed");
      assert.equal(confirmed.body.item.reason, null);
      assert.equal(confirmed.body.item.details, null);
      assert.equal(confirmed.body.item.preview.status, "completed");
      assert.deepEqual(
        confirmed.body.item.confirmedItems.map((item) => `${item.target}.${item.receipt.field}`),
        ["customer.needs", "opportunity.requirements", "weekly.entries"],
      );

      const after = businessSnapshot(databaseUrl, fixture);
      assert.notDeepEqual(after.customer.needs, before.customer.needs);
      assert.equal(after.customer.relation, before.customer.relation);
      assert.notDeepEqual(after.opportunity.requirements, before.opportunity.requirements);
      assert.equal(after.weekly.length, before.weekly.length + 1);
      assert.ok(JSON.parse(after.weekly[0].entries_json).length > 0);
      assert.equal(after.actionCount, before.actionCount);
      assert.equal(after.riskCount, before.riskCount);
      assert.equal(after.quickRecord.status, "analyzed");
      assert.equal(after.quickRecord.confirmation_preview_status, "completed");
      assert.equal(after.auditCount, before.auditCount + 1);

      const replay = await asA(`/api/quick-record-confirmation-previews/${preview.id}/confirm-all`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      assert.equal(replay.response.status, 200);
      assert.equal(replay.body.item.replayed, true);
      assert.equal(replay.body.item.writeback, false);
      assert.deepEqual(businessSnapshot(databaseUrl, fixture), after);
    });
  });

  it("confirms one selected item, cancels the rest, and keeps the terminal preview read-only", async () => {
    await withHarness(async ({ asA, databaseUrl }) => {
      const fixture = await createAnalyzedFixture(asA, databaseUrl, "item", { enrichSuggestions: true });
      const preview = await createPreview(asA, fixture.quickRecord.id);
      const selected = preview.items.find((item) => item.target === "customer" && item.field === "needs");
      assert.ok(selected);
      const before = businessSnapshot(databaseUrl, fixture);

      const confirmed = await asA(`/api/quick-record-confirmation-previews/${preview.id}/confirm-item`, {
        method: "POST",
        body: JSON.stringify({
          ...confirmationPins(preview),
          itemId: selected.id,
          itemIdentity: selected.identity,
        }),
      });
      assert.equal(confirmed.response.status, 200);
      assert.equal(confirmed.body.item.status, "confirmed");
      assert.deepEqual(confirmed.body.item.confirmedItems.map((item) => item.id), [selected.id]);

      const afterOne = businessSnapshot(databaseUrl, fixture);
      assert.notDeepEqual(afterOne.customer.needs, before.customer.needs);
      assert.deepEqual(afterOne.opportunity, before.opportunity);
      assert.deepEqual(afterOne.weekly, before.weekly);
      assert.equal(afterOne.customer.relation, before.customer.relation);
      assert.equal(afterOne.actionCount, before.actionCount);
      assert.equal(afterOne.riskCount, before.riskCount);

      const openPreview = confirmed.body.item.preview;
      const cancelled = await asA(`/api/quick-record-confirmation-previews/${preview.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ cancel: true, suggestionIdentity: openPreview.identity }),
      });
      assert.equal(cancelled.response.status, 200);
      assert.equal(cancelled.body.item.status, "cancelled");
      assert.ok(cancelled.body.item.items.every((item) => item.status !== "pending"));
      const terminal = businessSnapshot(databaseUrl, fixture);

      const terminalConfirm = await asA(`/api/quick-record-confirmation-previews/${preview.id}/confirm-all`, {
        method: "POST",
        body: JSON.stringify(confirmationPins(cancelled.body.item)),
      });
      assert.equal(terminalConfirm.response.status, 200);
      assert.equal(terminalConfirm.body.item.status, "cancelled");
      assert.equal(terminalConfirm.body.item.writeback, false);
      assert.deepEqual(businessSnapshot(databaseUrl, fixture), terminal);

      const loaded = await asA(`/api/quick-record-confirmation-previews/${preview.id}`);
      assert.equal(loaded.response.status, 200);
      assert.equal(loaded.body.item.status, "cancelled");
    });
  });

  it("confirms all three writable items one by one without treating the prior write as a changed draft", async () => {
    await withHarness(async ({ asA, databaseUrl }) => {
      const fixture = await createAnalyzedFixture(asA, databaseUrl, "sequential");
      let preview = await createPreview(asA, fixture.quickRecord.id);
      const writableIds = preview.items
        .filter((item) => item.confirmationMode === "explicit")
        .map((item) => item.id);
      assert.deepEqual(writableIds, ["customer-needs", "opportunity-requirements", "weekly-entry"]);

      for (const [index, itemId] of writableIds.entries()) {
        const item = preview.items.find((candidate) => candidate.id === itemId);
        const confirmed = await asA(`/api/quick-record-confirmation-previews/${preview.id}/confirm-item`, {
          method: "POST",
          body: JSON.stringify({
            ...confirmationPins(preview),
            itemId: item.id,
            itemIdentity: item.identity,
          }),
        });
        assert.equal(confirmed.response.status, 200, itemId);
        assert.equal(confirmed.body.item.status, "confirmed", itemId);
        assert.equal(confirmed.body.item.reason, null, itemId);
        assert.deepEqual(confirmed.body.item.confirmedItems.map((entry) => entry.id), [itemId]);
        preview = confirmed.body.item.preview;
        assert.equal(preview.status, index === writableIds.length - 1 ? "completed" : "open");
      }

      const after = businessSnapshot(databaseUrl, fixture);
      assert.equal(after.quickRecord.confirmation_preview_status, "completed");
      assert.equal(JSON.parse(after.customer.needs).length, 2);
      assert.equal(JSON.parse(after.opportunity.requirements).length, 2);
      assert.equal(after.weekly.length, 1);
      assert.ok(JSON.parse(after.weekly[0].entries_json).length > 0);
    });
  });

  for (const terminalStatus of ["completed", "cancelled"]) {
    it(`locks analysis edits and preview recreation after a ${terminalStatus} durable preview`, async () => {
      await withHarness(async ({ asA, databaseUrl }) => {
        const fixture = await createAnalyzedFixture(asA, databaseUrl, `terminal-${terminalStatus}`);
        const preview = await createPreview(asA, fixture.quickRecord.id);
        let terminalPreview;
        if (terminalStatus === "completed") {
          const confirmed = await asA(`/api/quick-record-confirmation-previews/${preview.id}/confirm-all`, {
            method: "POST",
            body: JSON.stringify(confirmationPins(preview)),
          });
          assert.equal(confirmed.response.status, 200);
          terminalPreview = confirmed.body.item.preview;
        } else {
          const cancelled = await asA(`/api/quick-record-confirmation-previews/${preview.id}/cancel`, {
            method: "POST",
            body: JSON.stringify({ cancel: true, suggestionIdentity: preview.identity }),
          });
          assert.equal(cancelled.response.status, 200);
          terminalPreview = cancelled.body.item;
        }
        assert.equal(terminalPreview.status, terminalStatus);

        const before = terminalLockSnapshot(databaseUrl, fixture);
        assert.equal(before.quickRecord.confirmation_preview_id, preview.id);
        assert.equal(before.quickRecord.confirmation_preview_status, terminalStatus);
        assert.equal(before.previews.length, 1);
        assert.equal(before.previews[0].identity, terminalPreview.identity);

        const patched = await asA(`/api/quick-records/${fixture.quickRecord.id}/analysis`, {
          method: "PATCH",
          headers: { "If-Match": `"${before.quickRecord.version}"` },
          body: JSON.stringify({ summary: { request: `不得保存-${terminalStatus}` } }),
        });
        const recreated = await asA(`/api/quick-records/${fixture.quickRecord.id}/confirmation-previews`, {
          method: "POST",
          body: "{}",
        });

        for (const [operation, result] of [["analysis", patched], ["preview", recreated]]) {
          assert.equal(result.response.status, 409, `${terminalStatus}:${operation}`);
          assert.equal(result.body.error.code, "QUICK_RECORD_CONFIRMATION_TERMINAL", `${terminalStatus}:${operation}`);
          assert.deepEqual(result.body.error.fields, {
            currentStatus: terminalStatus,
            previewId: preview.id,
          }, `${terminalStatus}:${operation}`);
        }

        const after = terminalLockSnapshot(databaseUrl, fixture);
        assert.deepEqual(after, before, `${terminalStatus}: rejected terminal operations must be side-effect free`);

        const loaded = await asA(`/api/quick-record-confirmation-previews/${preview.id}`);
        assert.equal(loaded.response.status, 200);
        assert.equal(loaded.body.item.status, terminalStatus);
        assert.equal(loaded.body.item.identity, terminalPreview.identity);
        assert.equal(loaded.body.item.revision, terminalPreview.revision);

        const summary = await asA("/api/dashboard/summary");
        assert.equal(summary.response.status, 200);
        assert.equal(summary.body.item.metrics.quickRecords.badge, "0 条待确认");
      });
    });
  }

  it("rejects forged actor or owner fields and hides previews from another account", async () => {
    await withHarness(async ({ asA, asB, databaseUrl }) => {
      for (const occurredAt of ["", "not-a-date"]) {
        const invalidDate = await asA("/api/quick-records", {
          method: "POST",
          body: JSON.stringify({ rawContent: "日期边界测试", occurredAt }),
        });
        assert.equal(invalidDate.response.status, 422, JSON.stringify({ occurredAt }));
        assert.equal(invalidDate.body.error.code, "VALIDATION_ERROR");
        assert.equal(invalidDate.body.error.fields.occurredAt, "dateTime");
      }
      const fixture = await createAnalyzedFixture(asA, databaseUrl, "scope");

      const nonEmptyCreate = await asA(`/api/quick-records/${fixture.quickRecord.id}/confirmation-previews`, {
        method: "POST",
        body: JSON.stringify({ owner: accountA }),
      });
      assert.equal(nonEmptyCreate.response.status, 422);

      const preview = await createPreview(asA, fixture.quickRecord.id);
      const hiddenRead = await asB(`/api/quick-record-confirmation-previews/${preview.id}`);
      assert.equal(hiddenRead.response.status, 404);

      const hiddenWrite = await asB(`/api/quick-record-confirmation-previews/${preview.id}/confirm-all`, {
        method: "POST",
        body: JSON.stringify(confirmationPins(preview)),
      });
      assert.equal(hiddenWrite.response.status, 404);
      assert.equal(JSON.stringify(hiddenWrite.body).includes("currentVersion"), false);

      for (const [field, value] of [
        ["owner", accountB],
        ["actor", { account: accountB }],
        ["confirmedBy", accountB],
        ["cancelledBy", accountB],
        ["previewId", preview.id],
      ]) {
        const rejected = await asA(`/api/quick-record-confirmation-previews/${preview.id}/confirm-all`, {
          method: "POST",
          body: JSON.stringify({ ...confirmationPins(preview), [field]: value }),
        });
        assert.equal(rejected.response.status, 422, field);
        assert.equal(rejected.body.error.code, "VALIDATION_ERROR", field);
        assert.equal(rejected.body.error.fields[field], "unknown", field);
      }
    });
  });

  it("returns a conflict without partial writes and rolls every write back when audit persistence fails", async () => {
    await withHarness(async ({ asA, databaseUrl }) => {
      const conflictFixture = await createAnalyzedFixture(asA, databaseUrl, "conflict");
      const conflictPreview = await createPreview(asA, conflictFixture.quickRecord.id);
      inspectDatabase(databaseUrl, (db) => {
        db.prepare(`
          UPDATE customers SET version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $id AND owner = $owner
        `).run({ $id: conflictFixture.customer.id, $owner: accountA });
      });
      const beforeConflict = businessSnapshot(databaseUrl, conflictFixture);
      const conflict = await asA(`/api/quick-record-confirmation-previews/${conflictPreview.id}/confirm-all`, {
        method: "POST",
        body: JSON.stringify(confirmationPins(conflictPreview)),
      });
      assert.equal(conflict.response.status, 409);
      assert.equal(conflict.body.item.status, "conflict");
      assert.ok(conflict.body.item.reason);
      assert.deepEqual(businessSnapshot(databaseUrl, conflictFixture), beforeConflict);

      const rollbackFixture = await createAnalyzedFixture(asA, databaseUrl, "rollback");
      const rollbackPreview = await createPreview(asA, rollbackFixture.quickRecord.id);
      const beforeRollback = businessSnapshot(databaseUrl, rollbackFixture);
      inspectDatabase(databaseUrl, (db) => {
        db.exec(`
          CREATE TRIGGER fail_quick_confirmation_audit
          BEFORE INSERT ON audit_logs
          WHEN NEW.action = 'quick_record.confirmation'
          BEGIN SELECT RAISE(ABORT, 'synthetic confirmation audit failure'); END;
        `);
      });

      const failed = await asA(`/api/quick-record-confirmation-previews/${rollbackPreview.id}/confirm-all`, {
        method: "POST",
        body: JSON.stringify(confirmationPins(rollbackPreview)),
      });
      assert.equal(failed.response.status, 500);
      assert.deepEqual(businessSnapshot(databaseUrl, rollbackFixture), beforeRollback);

      const stillOpen = await asA(`/api/quick-record-confirmation-previews/${rollbackPreview.id}`);
      assert.equal(stillOpen.response.status, 200);
      assert.equal(stillOpen.body.item.status, "open");
      assert.ok(stillOpen.body.item.items.every((item) => item.status === "pending"));
    });
  });
});
