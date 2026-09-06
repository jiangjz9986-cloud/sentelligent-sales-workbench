import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { withImmediateTransaction } from "../src/db/transaction.js";
import {
  QuickRecordConfirmationRepositoryError,
  createQuickRecordConfirmationRepositories,
} from "../src/quickRecords/confirmationRepository.js";
import {
  QuickRecordConfirmationError,
  createQuickRecordConfirmationService,
} from "../src/quickRecords/confirmationService.js";

function seed(db, owner = "owner-a") {
  db.prepare(`
    INSERT INTO customers (id, name, owner, relation, needs)
    VALUES ('customer-a', '示例医院', $owner, 42, '["原诉求"]')
  `).run({ $owner: owner });
  db.prepare(`
    INSERT INTO opportunities (id, customer_id, name, owner, requirements)
    VALUES ('opportunity-a', 'customer-a', '灾备项目', $owner, '["旧需求"]')
  `).run({ $owner: owner });
  db.prepare(`
    INSERT INTO quick_records (
      id, owner, raw_content, occurred_at, customer_id, opportunity_id, status
    ) VALUES (
      'quick-record-a', $owner, '客户希望补齐灾备规划，下周安排技术交流。',
      '2026-08-31T08:00:00.000Z', 'customer-a', 'opportunity-a', 'analyzed'
    )
  `).run({ $owner: owner });
  db.prepare(`
    INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
    VALUES ('analysis-a', 'quick-record-a', 'mock', 88, $analysis)
  `).run({
    $analysis: JSON.stringify({
      source: "mock",
      confidence: 88,
      customer: { id: "customer-a", value: "示例医院", meta: "已匹配", tone: "blue" },
      opportunity: { id: "opportunity-a", value: "灾备项目", meta: "已匹配", tone: "green" },
      weekly: { id: null, value: "本周", meta: "周报建议", tone: "amber" },
      summary: {
        request: { title: "客户诉求", text: "补齐本地灾备规划" },
        feedback: { title: "客户反馈", text: "同意安排技术交流" },
        risk: { title: "风险点", text: "预算窗口待确认" },
        action: { title: "建议动作", text: "下周安排技术交流" },
      },
    }),
  });
}

function createHarness({
  failAudit = false,
  businessOwner = "owner-a",
  quickRecordOwner = businessOwner,
  repositoryOptions,
} = {}) {
  const db = openDatabase({ databaseUrl: ":memory:" });
  seed(db, businessOwner);
  if (quickRecordOwner !== businessOwner) {
    db.prepare("UPDATE quick_records SET owner = $owner WHERE id = 'quick-record-a'")
      .run({ $owner: quickRecordOwner });
  }
  if (failAudit) {
    db.exec(`
      CREATE TRIGGER fail_quick_confirmation_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'quick_record.confirmation'
      BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;
    `);
  }
  const repositories = createQuickRecordConfirmationRepositories(db, repositoryOptions);
  const service = createQuickRecordConfirmationService({
    ...repositories,
    runInTransaction: (work) => withImmediateTransaction(db, work),
    resolveAuthenticatedActor: ({ owner, actor }) => (
      actor?.account === owner
        ? { id: actor.account, owner, authenticated: true }
        : null
    ),
    idFactory: () => "confirmation-preview-a",
    clock: () => new Date("2026-08-31T12:00:00.000Z"),
  });
  return { db, service };
}

function pins(preview) {
  return {
    owner: "owner-a",
    previewId: preview.id,
    suggestionIdentity: preview.identity,
    expectedQuickRecordVersion: preview.quickRecordVersion,
    analysisVersionId: preview.analysisVersionId,
    summaryHash: preview.summaryHash,
    evidenceHash: preview.evidenceHash,
    actor: { account: "owner-a" },
    confirm: true,
  };
}

function virtualWeeklyBase(owner = "owner-a", weekStart = "2026-08-31") {
  const ownerHash = createHash("sha256").update(owner, "utf8").digest("hex").slice(0, 24);
  return `weekly:${weekStart}:${ownerHash}`;
}

function insertSoftDeletedWeekly(db, { id, owner = "owner-a", entries = ["历史周报条目"], version = 7 } = {}) {
  db.prepare(`
    INSERT INTO weekly_reports (
      id, owner, period_start, period_end, status, content, source_refs,
      entries_json, version, deleted_at, deleted_by
    ) VALUES (
      $id, $owner, '2026-08-31', '2026-09-06', 'draft', '', '[]',
      $entries, $version, '2026-08-31T13:00:00.000Z', 'owner-a'
    )
  `).run({
    $id: id,
    $owner: owner,
    $entries: JSON.stringify(entries),
    $version: version,
  });
}

function insertActiveWeekly(db, {
  id,
  owner = "owner-a",
  status = "ready",
  entries = ["已经锁定的周报条目"],
  version = 2,
} = {}) {
  db.prepare(`
    INSERT INTO weekly_reports (
      id, owner, period_start, period_end, status, content, source_refs,
      entries_json, version
    ) VALUES (
      $id, $owner, '2026-08-31', '2026-09-06', $status, '', '[]',
      $entries, $version
    )
  `).run({
    $id: id,
    $owner: owner,
    $status: status,
    $entries: JSON.stringify(entries),
    $version: version,
  });
}

function insertCustomerOpportunity(db, {
  customerId,
  opportunityId,
  owner = "owner-a",
  customerDeletedAt = null,
  opportunityDeletedAt = null,
} = {}) {
  db.prepare(`
    INSERT INTO customers (id, name, owner, relation, needs, deleted_at)
    VALUES ($id, $name, $owner, 30, '[]', $deletedAt)
  `).run({
    $id: customerId,
    $name: `客户-${customerId}`,
    $owner: owner,
    $deletedAt: customerDeletedAt,
  });
  db.prepare(`
    INSERT INTO opportunities (
      id, customer_id, name, owner, requirements, deleted_at
    ) VALUES (
      $id, $customerId, $name, $owner, '[]', $deletedAt
    )
  `).run({
    $id: opportunityId,
    $customerId: customerId,
    $name: `商机-${opportunityId}`,
    $owner: owner,
    $deletedAt: opportunityDeletedAt,
  });
}

function updateQuickRecordLinks(db, { customerId = null, opportunityId = null } = {}) {
  db.prepare(`
    UPDATE quick_records
    SET customer_id = $customerId, opportunity_id = $opportunityId
    WHERE id = 'quick-record-a'
  `).run({ $customerId: customerId, $opportunityId: opportunityId });
}

function updateAnalysisTargets(db, {
  customerId = null,
  opportunityId = null,
  customerValue,
  opportunityValue,
} = {}) {
  const row = db.prepare(
    "SELECT analysis_json FROM ai_insights WHERE id = 'analysis-a'",
  ).get();
  const analysis = JSON.parse(row.analysis_json);
  analysis.customer.id = customerId;
  analysis.opportunity.id = opportunityId;
  if (customerValue !== undefined) analysis.customer.value = customerValue;
  if (opportunityValue !== undefined) analysis.opportunity.value = opportunityValue;
  db.prepare(
    "UPDATE ai_insights SET analysis_json = $analysis WHERE id = 'analysis-a'",
  ).run({ $analysis: JSON.stringify(analysis) });
}

function targetEntityIds(preview) {
  return Object.fromEntries(
    preview.items
      .filter((item) => ["customer", "opportunity"].includes(item.target))
      .map((item) => [item.target, item.entityId]),
  );
}

function assertRelationshipFailure(work) {
  assert.throws(
    work,
    (error) => (
      error instanceof QuickRecordConfirmationRepositoryError
      && error.code === "QUICK_RECORD_RELATIONSHIP_INVALID"
      && error.message === "Saved quick-record links are not confirmable"
    ),
  );
}

describe("SQLite quick-record confirmation repository", () => {
  it("keeps auth-disabled anonymous confirmation compatible with globally visible business rows", () => {
    const { db, service } = createHarness({
      businessOwner: "business-owner",
      quickRecordOwner: "anonymous",
      repositoryOptions: { anonymousGlobalTargets: true },
    });
    try {
      const preview = service.preview({ owner: "anonymous", quickRecordId: "quick-record-a" });
      assert.deepEqual(targetEntityIds(preview), {
        customer: "customer-a",
        opportunity: "opportunity-a",
      });

      const outcome = service.confirmAll({
        owner: "anonymous",
        previewId: preview.id,
        suggestionIdentity: preview.identity,
        expectedQuickRecordVersion: preview.quickRecordVersion,
        analysisVersionId: preview.analysisVersionId,
        summaryHash: preview.summaryHash,
        evidenceHash: preview.evidenceHash,
        actor: { account: "anonymous" },
        confirm: true,
      });

      assert.equal(outcome.status, "confirmed");
      assert.ok(JSON.parse(db.prepare(
        "SELECT needs FROM customers WHERE id = 'customer-a'",
      ).get().needs).includes("补齐本地灾备规划"));
      assert.ok(JSON.parse(db.prepare(
        "SELECT requirements FROM opportunities WHERE id = 'opportunity-a'",
      ).get().requirements).includes("补齐本地灾备规划"));
    } finally {
      db.close();
    }
  });

  it("pins active explicit links even when the saved model candidates point at another valid pair", () => {
    const { db, service } = createHarness();
    try {
      insertCustomerOpportunity(db, {
        customerId: "customer-b",
        opportunityId: "opportunity-b",
      });
      updateAnalysisTargets(db, {
        customerId: "customer-b",
        opportunityId: "opportunity-b",
        customerValue: "不可信模型客户名称",
        opportunityValue: "不可信模型商机名称",
      });

      const preview = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });

      assert.deepEqual(targetEntityIds(preview), {
        customer: "customer-a",
        opportunity: "opportunity-a",
      });
    } finally {
      db.close();
    }
  });

  it("fails closed instead of falling back when either explicit link is inactive or outside the owner", () => {
    for (const [target, invalidation] of [
      ["customer", "deleted"],
      ["opportunity", "deleted"],
      ["customer", "owner"],
      ["opportunity", "owner"],
    ]) {
      const { db, service } = createHarness();
      try {
        insertCustomerOpportunity(db, {
          customerId: "customer-b",
          opportunityId: "opportunity-b",
        });
        updateAnalysisTargets(db, {
          customerId: "customer-b",
          opportunityId: "opportunity-b",
        });
        const table = target === "customer" ? "customers" : "opportunities";
        const id = target === "customer" ? "customer-a" : "opportunity-a";
        if (invalidation === "deleted") {
          db.prepare(`
            UPDATE ${table}
            SET deleted_at = '2026-08-31T11:00:00.000Z'
            WHERE id = $id
          `).run({ $id: id });
        } else {
          db.prepare(`UPDATE ${table} SET owner = 'owner-b' WHERE id = $id`).run({ $id: id });
        }

        assertRelationshipFailure(() => (
          service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" })
        ));
        assert.equal(
          db.prepare("SELECT COUNT(*) AS count FROM quick_record_confirmation_previews").get().count,
          0,
        );
      } finally {
        db.close();
      }
    }
  });

  it("rejects a model opportunity from another customer when only the customer link is explicit", () => {
    const { db, service } = createHarness();
    try {
      insertCustomerOpportunity(db, {
        customerId: "customer-b",
        opportunityId: "opportunity-b",
      });
      updateQuickRecordLinks(db, { customerId: "customer-a" });
      updateAnalysisTargets(db, {
        customerId: "customer-a",
        opportunityId: "opportunity-b",
        customerValue: "示例医院",
        opportunityValue: "商机-opportunity-b",
      });

      assertRelationshipFailure(() => (
        service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" })
      ));
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM quick_record_confirmation_previews").get().count,
        0,
      );
    } finally {
      db.close();
    }
  });

  it("keeps valid model candidates for unlinked records and rejects inconsistent candidate pairs", () => {
    const { db, service } = createHarness();
    try {
      insertCustomerOpportunity(db, {
        customerId: "customer-b",
        opportunityId: "opportunity-b",
      });
      updateQuickRecordLinks(db);
      updateAnalysisTargets(db, {
        customerId: "customer-b",
        opportunityId: "opportunity-b",
        customerValue: "客户-customer-b",
        opportunityValue: "商机-opportunity-b",
      });

      const preview = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      assert.deepEqual(targetEntityIds(preview), {
        customer: "customer-b",
        opportunity: "opportunity-b",
      });

      db.prepare("DELETE FROM quick_record_confirmation_previews").run();
      db.prepare(`
        UPDATE quick_records
        SET confirmation_preview_id = NULL, confirmation_preview_status = NULL
        WHERE id = 'quick-record-a'
      `).run();
      updateAnalysisTargets(db, {
        customerId: "customer-a",
        opportunityId: "opportunity-b",
        customerValue: "示例医院",
        opportunityValue: "商机-opportunity-b",
      });

      assertRelationshipFailure(() => (
        service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" })
      ));
    } finally {
      db.close();
    }
  });

  it("excludes inactive or cross-owner model candidates from an unlinked record", () => {
    const { db, service } = createHarness();
    try {
      insertCustomerOpportunity(db, {
        customerId: "customer-other",
        opportunityId: "opportunity-other",
        owner: "owner-b",
      });
      updateQuickRecordLinks(db);
      updateAnalysisTargets(db, {
        customerId: "customer-other",
        opportunityId: "opportunity-other",
        customerValue: "客户-customer-other",
        opportunityValue: "商机-opportunity-other",
      });

      const crossOwnerPreview = service.preview({
        owner: "owner-a",
        quickRecordId: "quick-record-a",
      });
      assert.deepEqual(targetEntityIds(crossOwnerPreview), {});

      db.prepare("DELETE FROM quick_record_confirmation_previews").run();
      db.prepare(`
        UPDATE quick_records
        SET confirmation_preview_id = NULL, confirmation_preview_status = NULL
        WHERE id = 'quick-record-a'
      `).run();
      insertCustomerOpportunity(db, {
        customerId: "customer-deleted",
        opportunityId: "opportunity-deleted",
        customerDeletedAt: "2026-08-31T10:00:00.000Z",
      });
      updateAnalysisTargets(db, {
        customerId: "customer-deleted",
        opportunityId: "opportunity-deleted",
        customerValue: "客户-customer-deleted",
        opportunityValue: "商机-opportunity-deleted",
      });

      const inactivePreview = service.preview({
        owner: "owner-a",
        quickRecordId: "quick-record-a",
      });
      assert.deepEqual(targetEntityIds(inactivePreview), {});
    } finally {
      db.close();
    }
  });

  it("excludes same-owner active model ids whose displayed names do not exactly match", () => {
    for (const forgedTarget of ["customer", "opportunity"]) {
      const { db, service } = createHarness();
      try {
        insertCustomerOpportunity(db, {
          customerId: "customer-b",
          opportunityId: "opportunity-b",
        });
        updateQuickRecordLinks(db);
        updateAnalysisTargets(db, {
          customerId: "customer-b",
          opportunityId: "opportunity-b",
          customerValue: forgedTarget === "customer" ? "伪造客户名称" : "客户-customer-b",
          opportunityValue: forgedTarget === "opportunity" ? "伪造商机名称" : "商机-opportunity-b",
        });

        const preview = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
        const targets = targetEntityIds(preview);
        assert.equal(Object.hasOwn(targets, forgedTarget), false);
        const survivingTarget = forgedTarget === "customer" ? "opportunity" : "customer";
        assert.equal(targets[survivingTarget], `${survivingTarget}-b`);
      } finally {
        db.close();
      }
    }
  });

  it("rejects a pending opportunity write when its model-linked parent customer becomes unavailable", () => {
    for (const invalidation of ["deleted", "owner"]) {
      const { db, service } = createHarness();
      try {
        updateQuickRecordLinks(db);
        const initialPreview = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
        const customerItem = initialPreview.items.find((item) => item.id === "customer-needs");
        assert.ok(customerItem);

        const first = service.confirmItem({
          ...pins(initialPreview),
          itemId: customerItem.id,
          itemIdentity: customerItem.identity,
        });
        assert.equal(first.status, "confirmed");
        assert.equal(first.writeback, true);

        if (invalidation === "deleted") {
          db.prepare(`
            UPDATE customers
            SET deleted_at = '2026-08-31T13:00:00.000Z'
            WHERE id = 'customer-a'
          `).run();
        } else {
          db.prepare("UPDATE customers SET owner = 'owner-b' WHERE id = 'customer-a'").run();
        }

        const opportunityBefore = db.prepare(`
          SELECT requirements, version
          FROM opportunities
          WHERE id = 'opportunity-a'
        `).get();
        const auditCountBefore = db.prepare(`
          SELECT COUNT(*) AS count
          FROM audit_logs
          WHERE action = 'quick_record.confirmation'
        `).get().count;
        const opportunityItem = first.preview.items.find((item) => item.id === "opportunity-requirements");
        assert.ok(opportunityItem);

        const second = service.confirmItem({
          ...pins(first.preview),
          itemId: opportunityItem.id,
          itemIdentity: opportunityItem.identity,
        });

        assert.equal(second.status, "conflict", invalidation);
        assert.equal(second.reason, "target_unavailable", invalidation);
        assert.equal(second.writeback, false, invalidation);
        assert.deepEqual(
          db.prepare(`
            SELECT requirements, version
            FROM opportunities
            WHERE id = 'opportunity-a'
          `).get(),
          opportunityBefore,
          invalidation,
        );
        assert.equal(
          db.prepare(`
            SELECT COUNT(*) AS count
            FROM audit_logs
            WHERE action = 'quick_record.confirmation'
          `).get().count,
          auditCountBefore,
          invalidation,
        );
        assert.equal(
          second.preview.items.find((item) => item.id === opportunityItem.id)?.status,
          "pending",
          invalidation,
        );
      } finally {
        db.close();
      }
    }
  });

  it("persists a replayable preview and writes only the three explicitly allowed fields", () => {
    const { db, service } = createHarness();
    try {
      const before = {
        customer: db.prepare("SELECT needs, relation, version FROM customers WHERE id = 'customer-a'").get(),
        opportunity: db.prepare("SELECT requirements, version FROM opportunities WHERE id = 'opportunity-a'").get(),
        weeklyCount: db.prepare("SELECT COUNT(*) AS count FROM weekly_reports").get().count,
        actions: db.prepare("SELECT COUNT(*) AS count FROM action_items").get().count,
        risks: db.prepare("SELECT COUNT(*) AS count FROM risk_items").get().count,
      };

      const preview = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const replay = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });

      assert.equal(preview.status, "open");
      assert.equal(replay.id, preview.id);
      assert.equal(replay.replayed, true);
      assert.deepEqual(
        preview.items.filter((item) => item.confirmationMode === "explicit").map((item) => `${item.target}.${item.field}`),
        ["customer.needs", "opportunity.requirements", "weekly.entries"],
      );
      assert.ok(preview.items.some((item) => item.target === "action" && item.confirmationMode === "unsupported"));
      assert.deepEqual(
        db.prepare("SELECT needs, relation, version FROM customers WHERE id = 'customer-a'").get(),
        before.customer,
      );
      assert.deepEqual(
        db.prepare("SELECT requirements, version FROM opportunities WHERE id = 'opportunity-a'").get(),
        before.opportunity,
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weekly_reports").get().count, before.weeklyCount);

      const result = service.confirmAll(pins(preview));
      assert.equal(result.status, "confirmed");
      assert.equal(result.preview.status, "completed");
      assert.equal(result.confirmedItems.length, 3);
      assert.deepEqual(JSON.parse(db.prepare("SELECT needs FROM customers WHERE id = 'customer-a'").get().needs), [
        "原诉求",
        "补齐本地灾备规划",
      ]);
      assert.deepEqual(JSON.parse(db.prepare("SELECT requirements FROM opportunities WHERE id = 'opportunity-a'").get().requirements), [
        "旧需求",
        "补齐本地灾备规划",
      ]);
      const weekly = db.prepare("SELECT * FROM weekly_reports WHERE owner = 'owner-a'").get();
      assert.deepEqual(JSON.parse(weekly.entries_json), ["本周：补齐本地灾备规划"]);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM action_items").get().count, before.actions);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM risk_items").get().count, before.risks);
      assert.equal(db.prepare("SELECT relation FROM customers WHERE id = 'customer-a'").get().relation, 42);
      assert.equal(
        db.prepare("SELECT confirmation_preview_status FROM quick_records WHERE id = 'quick-record-a'").get().confirmation_preview_status,
        "completed",
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'quick_record.confirmation'").get().count,
        1,
      );
    } finally {
      db.close();
    }
  });

  it("hides previews across owners and rolls every business write back when audit persistence fails", () => {
    const { db, service } = createHarness({ failAudit: true });
    try {
      const preview = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      assert.throws(
        () => service.get({ owner: "owner-b", previewId: preview.id }),
        (error) => error instanceof QuickRecordConfirmationError && error.code === "NOT_FOUND",
      );
      const beforeCustomer = db.prepare("SELECT needs, version FROM customers WHERE id = 'customer-a'").get();
      const beforeOpportunity = db.prepare("SELECT requirements, version FROM opportunities WHERE id = 'opportunity-a'").get();

      assert.throws(() => service.confirmAll(pins(preview)), /synthetic audit failure/u);

      assert.deepEqual(
        db.prepare("SELECT needs, version FROM customers WHERE id = 'customer-a'").get(),
        beforeCustomer,
      );
      assert.deepEqual(
        db.prepare("SELECT requirements, version FROM opportunities WHERE id = 'opportunity-a'").get(),
        beforeOpportunity,
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weekly_reports").get().count, 0);
      assert.equal(service.get({ owner: "owner-a", previewId: preview.id }).status, "open");
    } finally {
      db.close();
    }
  });

  it("allocates a new editable virtual weekly report after the canonical report is soft-deleted", () => {
    const { db, service } = createHarness();
    try {
      const baseId = virtualWeeklyBase();
      insertSoftDeletedWeekly(db, { id: baseId });

      const preview = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const weeklyItem = preview.items.find((item) => item.id === "weekly-entry");
      assert.ok(weeklyItem);
      assert.equal(weeklyItem.entityId, `${baseId}:1`);
      assert.equal(weeklyItem.entityVersion, 1);
      assert.deepEqual(weeklyItem.before, []);

      const result = service.confirmItem({
        ...pins(preview),
        itemId: weeklyItem.id,
        itemIdentity: weeklyItem.identity,
      });
      assert.equal(result.status, "confirmed");
      assert.equal(result.preview.status, "open");
      assert.deepEqual(result.confirmedItems.map((item) => item.id), ["weekly-entry"]);

      const rows = db.prepare(`
        SELECT id, owner, status, entries_json, version, deleted_at, deleted_by
        FROM weekly_reports WHERE owner = 'owner-a' ORDER BY id
      `).all();
      assert.equal(rows.length, 2);
      const deleted = rows.find((row) => row.id === baseId);
      const replacement = rows.find((row) => row.id === `${baseId}:1`);
      assert.ok(deleted);
      assert.ok(replacement);
      assert.equal(deleted.status, "draft");
      assert.deepEqual(JSON.parse(deleted.entries_json), ["历史周报条目"]);
      assert.equal(deleted.version, 7);
      assert.equal(typeof deleted.deleted_at, "string");
      assert.equal(deleted.deleted_by, "owner-a");
      assert.equal(replacement.status, "draft");
      assert.deepEqual(JSON.parse(replacement.entries_json), weeklyItem.after);
      assert.equal(replacement.version, 2);
      assert.equal(replacement.deleted_at, null);
      assert.equal(replacement.deleted_by, null);
    } finally {
      db.close();
    }
  });

  it("reuses an active replacement generation so a ready report remains a target conflict", () => {
    const { db, service } = createHarness();
    try {
      const baseId = virtualWeeklyBase();
      const replacementId = `${baseId}:1`;
      insertSoftDeletedWeekly(db, { id: baseId });
      insertActiveWeekly(db, { id: replacementId });

      const preview = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const weeklyItem = preview.items.find((item) => item.id === "weekly-entry");
      assert.ok(weeklyItem);
      // The allocator must point at the existing active replacement rather than
      // inventing :2, so confirmation revalidates that same ready target.
      assert.equal(weeklyItem.entityId, replacementId);
      assert.equal(weeklyItem.entityVersion, 1);
      assert.deepEqual(weeklyItem.before, []);

      const result = service.confirmItem({
        ...pins(preview),
        itemId: weeklyItem.id,
        itemIdentity: weeklyItem.identity,
      });
      assert.equal(result.status, "conflict");
      assert.equal(result.reason, "target_changed");
      assert.equal(result.writeback, false);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM weekly_reports WHERE owner = 'owner-a'").get().count,
        2,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM weekly_reports WHERE id = $id").get({ $id: `${baseId}:2` }).count,
        0,
      );
      const active = db.prepare("SELECT status, entries_json, version FROM weekly_reports WHERE id = $id").get({
        $id: replacementId,
      });
      assert.equal(active.status, "ready");
      assert.deepEqual(JSON.parse(active.entries_json), ["已经锁定的周报条目"]);
      assert.equal(active.version, 2);
    } finally {
      db.close();
    }
  });

  it("rejects a ready replacement even when its empty version-1 state resembles a fresh draft", () => {
    const { db, service } = createHarness();
    try {
      const baseId = virtualWeeklyBase();
      const replacementId = `${baseId}:1`;
      insertSoftDeletedWeekly(db, { id: baseId });
      insertActiveWeekly(db, {
        id: replacementId,
        status: "ready",
        entries: [],
        version: 1,
      });

      const preview = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const weeklyItem = preview.items.find((item) => item.id === "weekly-entry");
      assert.ok(weeklyItem);
      assert.equal(weeklyItem.entityId, replacementId);
      assert.equal(weeklyItem.entityVersion, 1);
      assert.deepEqual(weeklyItem.before, []);

      const result = service.confirmItem({
        ...pins(preview),
        itemId: weeklyItem.id,
        itemIdentity: weeklyItem.identity,
      });
      assert.equal(result.status, "conflict");
      assert.equal(result.reason, "target_changed");
      assert.equal(result.writeback, false);

      const active = db.prepare(`
        SELECT status, entries_json, version, deleted_at
        FROM weekly_reports WHERE id = $id
      `).get({ $id: replacementId });
      assert.equal(active.status, "ready");
      assert.deepEqual(JSON.parse(active.entries_json), []);
      assert.equal(active.version, 1);
      assert.equal(active.deleted_at, null);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM weekly_reports WHERE id = $id").get({ $id: `${baseId}:2` }).count,
        0,
      );
    } finally {
      db.close();
    }
  });

  it("skips occupied replacement generations without reviving their tombstones", () => {
    const { db, service } = createHarness();
    try {
      const baseId = virtualWeeklyBase();
      const firstReplacementId = `${baseId}:1`;
      const secondReplacementId = `${baseId}:2`;
      insertSoftDeletedWeekly(db, { id: baseId, entries: ["主周报历史"] });
      insertSoftDeletedWeekly(db, { id: firstReplacementId, entries: ["第一代历史"] });

      const preview = service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const weeklyItem = preview.items.find((item) => item.id === "weekly-entry");
      assert.ok(weeklyItem);
      assert.equal(weeklyItem.entityId, secondReplacementId);
      assert.equal(weeklyItem.entityVersion, 1);
      assert.deepEqual(weeklyItem.before, []);

      const result = service.confirmItem({
        ...pins(preview),
        itemId: weeklyItem.id,
        itemIdentity: weeklyItem.identity,
      });
      assert.equal(result.status, "confirmed");
      const replacement = db.prepare(`
        SELECT id, status, entries_json, version, deleted_at, deleted_by
        FROM weekly_reports WHERE id = $id
      `).get({ $id: secondReplacementId });
      assert.ok(replacement);
      assert.equal(replacement.status, "draft");
      assert.deepEqual(JSON.parse(replacement.entries_json), weeklyItem.after);
      assert.equal(replacement.version, 2);
      assert.equal(replacement.deleted_at, null);
      assert.equal(replacement.deleted_by, null);

      const tombstone = db.prepare(`
        SELECT id, entries_json, version, deleted_at, deleted_by
        FROM weekly_reports WHERE id = $id
      `).get({ $id: firstReplacementId });
      assert.deepEqual(JSON.parse(tombstone.entries_json), ["第一代历史"]);
      assert.equal(tombstone.version, 7);
      assert.equal(typeof tombstone.deleted_at, "string");
      assert.equal(tombstone.deleted_by, "owner-a");
    } finally {
      db.close();
    }
  });
});
