import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import {
  ActionRiskWritebackConflictError,
  ActionRiskWritebackNotFoundError,
  ActionRiskWritebackSchemaError,
  ActionRiskWritebackValidationError,
  actionWritebackFromRow,
  buildActionWriteback,
  buildRiskWriteback,
  computeWritebackDigest,
  createActionRiskWritebackService,
  riskWritebackFromRow,
  writebackDigestMatches,
} from "../src/actionRisk/index.js";

function seedDatabase() {
  const db = openDatabase({ databaseUrl: ":memory:" });
  db.exec(`
    INSERT INTO customers (id, name, owner, relation)
    VALUES
      ('customer-a', '示例医院', 'owner-a', 60),
      ('customer-b', '另一家医院', 'owner-b', 30),
      ('customer-a2', '同 owner 的另一客户', 'owner-a', 20);

    INSERT INTO opportunities (id, customer_id, name, owner)
    VALUES
      ('opportunity-a', 'customer-a', '灾备项目', 'owner-a'),
      ('opportunity-b', 'customer-b', '云平台项目', 'owner-b'),
      ('opportunity-a2', 'customer-a2', '另一商机', 'owner-a');

    INSERT INTO quick_records (id, owner, raw_content, customer_id, opportunity_id, status)
    VALUES
      ('quick-a', 'owner-a', '客户确认下一步', 'customer-a', 'opportunity-a', 'confirmed'),
      ('quick-b', 'owner-b', '其他 owner 的记录', 'customer-b', 'opportunity-b', 'confirmed'),
      ('quick-a-voided', 'owner-a', '已作废记录', 'customer-a', 'opportunity-a', 'confirmed');

    UPDATE quick_records
       SET voided_at = '2026-09-05T00:00:00.000Z',
           voided_by = 'owner-a',
           void_reason = 'test'
     WHERE id = 'quick-a-voided';
  `);
  return db;
}

function closeDatabase(db) {
  db.close();
}

function assertCode(error, code) {
  assert.equal(error.code, code);
  return true;
}

function reviewedAction(overrides = {}) {
  return {
    id: "action-reviewed",
    owner: "owner-a",
    customerId: "customer-a",
    opportunityId: "opportunity-a",
    title: "确认灾备方案",
    customer: "示例医院",
    reason: "客户要求补齐本地灾备规划",
    due: "2026-09-14",
    assignee: "reviewed-assignee",
    priority: "高",
    status: "in_progress",
    sourceRecordId: "quick-a",
    sourceType: "quick_record",
    sourceId: "quick-a",
    sourceProactiveId: "suggestion-action-1",
    tone: "reviewed-red",
    remindAt: "2026-09-13T09:00:00.000Z",
    expectedResult: "锁定技术交流时间和交付边界",
    ...overrides,
  };
}

function reviewedRisk(overrides = {}) {
  return {
    id: "risk-reviewed",
    owner: "owner-a",
    customerId: "customer-a",
    opportunityId: "opportunity-a",
    title: "预算路径未确认",
    target: "示例医院 / 灾备项目",
    score: 86,
    severity: "高",
    status: "in_progress",
    evidence: "客户尚未确认预算来源和审批链",
    action: "确认预算来源、审批链和最终拍板人",
    assignee: "risk-reviewer",
    due: "2026-09-16",
    sourceType: "proactive_assistant",
    sourceId: "suggestion-risk-1",
    sourceProactiveId: "suggestion-risk-1",
    tone: "reviewed-amber",
    expectedResult: "获得书面预算窗口和决策链",
    ...overrides,
  };
}

describe("v0.12.0 action/risk writeback builders", () => {
  it("preserves every reviewed action field and computes a canonical digest", () => {
    const built = buildActionWriteback(reviewedAction());

    assert.deepEqual(built.payload, {
      ...reviewedAction(),
      writebackDigest: built.writebackDigest,
    });
    assert.equal(built.columns.expected_result, "锁定技术交流时间和交付边界");
    assert.equal(built.columns.source_type, "quick_record");
    assert.equal(built.columns.source_id, "quick-a");
    assert.equal(built.columns.source_record_id, "quick-a");
    assert.equal(built.columns.source_proactive_id, "suggestion-action-1");
    assert.equal(built.columns.writeback_digest, built.writebackDigest);
    assert.equal(computeWritebackDigest("action", built.payload), built.writebackDigest);
    assert.equal(writebackDigestMatches("action", built.payload, built.writebackDigest), true);
    assert.equal(built.canonicalJson.includes("writebackDigest"), false);
    assert.deepEqual(built.defaultsApplied, []);

    const reordered = Object.fromEntries(Object.entries(built.payload).reverse());
    assert.equal(computeWritebackDigest("action", reordered), built.writebackDigest);
    assert.notEqual(
      computeWritebackDigest("action", { ...built.payload, expectedResult: "另一个结果" }),
      built.writebackDigest,
    );
  });

  it("preserves every reviewed risk field, including score zero and explicit nulls", () => {
    const built = buildRiskWriteback(reviewedRisk());

    assert.equal(built.payload.score, 86);
    assert.equal(built.payload.severity, "高");
    assert.equal(built.payload.status, "in_progress");
    assert.equal(built.payload.expectedResult, "获得书面预算窗口和决策链");
    assert.equal(built.payload.sourceType, "proactive_assistant");
    assert.equal(built.payload.sourceId, "suggestion-risk-1");
    assert.equal(built.payload.sourceProactiveId, "suggestion-risk-1");
    assert.equal(built.payload.tone, "reviewed-amber");
    assert.equal(built.columns.expected_result, "获得书面预算窗口和决策链");
    assert.equal(built.columns.source_proactive_id, "suggestion-risk-1");
    assert.equal(built.columns.writeback_digest, built.writebackDigest);
    assert.equal(computeWritebackDigest("risk", built.payload), built.writebackDigest);
    assert.deepEqual(built.defaultsApplied, []);

    const explicitValues = buildRiskWriteback({
      owner: "owner-a",
      title: "显式值不应被默认值覆盖",
      target: "客户 / 商机",
      evidence: "证据",
      action: "动作",
      score: 0,
      severity: "low",
      status: "closed",
      assignee: null,
      due: null,
      expectedResult: null,
      sourceType: null,
      sourceId: null,
      sourceProactiveId: null,
      tone: null,
    });
    assert.equal(explicitValues.payload.score, 0);
    assert.equal(explicitValues.payload.severity, "低");
    assert.equal(explicitValues.payload.status, "closed");
    assert.equal(explicitValues.payload.assignee, null);
    assert.equal(explicitValues.payload.due, null);
    assert.equal(explicitValues.payload.expectedResult, null);
    assert.equal(explicitValues.payload.sourceType, null);
    assert.equal(explicitValues.payload.sourceId, null);
    assert.equal(explicitValues.payload.sourceProactiveId, null);
    assert.equal(explicitValues.payload.tone, null);
    assert.equal(explicitValues.defaultsApplied.includes("score"), false);
    assert.equal(explicitValues.defaultsApplied.includes("assignee"), false);
    assert.equal(explicitValues.defaultsApplied.includes("sourceType"), false);
  });

  it("does not replace explicit nullable action review values with defaults", () => {
    const built = buildActionWriteback({
      owner: "owner-a",
      title: "保留人工清空的字段",
      customer: null,
      reason: null,
      due: null,
      assignee: null,
      priority: "low",
      status: "deferred",
      sourceRecordId: null,
      sourceType: null,
      sourceId: null,
      sourceProactiveId: null,
      tone: null,
      remindAt: null,
      expectedResult: null,
    });

    assert.equal(built.payload.customer, null);
    assert.equal(built.payload.reason, null);
    assert.equal(built.payload.due, null);
    assert.equal(built.payload.assignee, null);
    assert.equal(built.payload.priority, "低");
    assert.equal(built.payload.status, "deferred");
    assert.equal(built.payload.sourceRecordId, null);
    assert.equal(built.payload.sourceType, null);
    assert.equal(built.payload.sourceId, null);
    assert.equal(built.payload.sourceProactiveId, null);
    assert.equal(built.payload.tone, null);
    assert.equal(built.payload.remindAt, null);
    assert.equal(built.payload.expectedResult, null);
    for (const field of [
      "customer", "reason", "due", "assignee", "priority", "status",
      "sourceRecordId", "sourceType", "sourceId", "sourceProactiveId",
      "tone", "remindAt", "expectedResult",
    ]) {
      assert.equal(built.defaultsApplied.includes(field), false, field);
    }
  });
});

describe("v0.12.0 action/risk SQLite writeback", () => {
  it("creates, replays, updates, and replays both action and risk rows", () => {
    const db = seedDatabase();
    try {
      let generatedId = 0;
      const service = createActionRiskWritebackService({
        db,
        idFactory: () => `generated-${++generatedId}`,
      });

      const actionInput = reviewedAction();
      const actionCreated = service.writeAction(actionInput);
      assert.equal(actionCreated.status, "created");
      assert.equal(actionCreated.replayed, false);
      assert.equal(actionCreated.version, 1);
      assert.equal(actionCreated.item.expectedResult, actionInput.expectedResult);
      assert.equal(actionCreated.item.sourceRecordId, "quick-a");
      assert.equal(actionCreated.item.sourceType, "quick_record");
      assert.equal(actionCreated.item.sourceId, "quick-a");
      assert.equal(actionCreated.item.sourceProactiveId, "suggestion-action-1");
      assert.equal(actionCreated.item.writebackDigest, actionCreated.writebackDigest);
      const actionRow = db.prepare("SELECT * FROM action_items WHERE id = $id").get({ $id: actionInput.id });
      assert.equal(actionRow.writeback_digest, actionCreated.writebackDigest);
      assert.equal(
        computeWritebackDigest("action", actionWritebackFromRow(actionRow)),
        actionRow.writeback_digest,
      );

      const actionReplay = service.writeAction({ ...actionInput, mode: "create" });
      assert.equal(actionReplay.status, "replayed");
      assert.equal(actionReplay.version, 1);

      const actionUpdateInput = {
        ...actionInput,
        mode: "update",
        expectedVersion: 1,
        due: "2026-09-20",
        priority: "低",
        expectedResult: "完成书面方案确认",
      };
      const actionUpdated = service.writeAction(actionUpdateInput);
      assert.equal(actionUpdated.status, "updated");
      assert.equal(actionUpdated.version, 2);
      assert.equal(actionUpdated.item.due, "2026-09-20");
      assert.equal(actionUpdated.item.priority, "低");
      assert.equal(actionUpdated.item.expectedResult, "完成书面方案确认");
      assert.equal(actionUpdated.item.writebackDigest, actionUpdated.writebackDigest);
      const actionUpdateReplay = service.writeAction(actionUpdateInput);
      assert.equal(actionUpdateReplay.status, "replayed");
      assert.equal(actionUpdateReplay.version, 2);

      const riskInput = reviewedRisk();
      const riskCreated = service.writeRisk(riskInput);
      assert.equal(riskCreated.status, "created");
      assert.equal(riskCreated.version, 1);
      assert.equal(riskCreated.item.expectedResult, riskInput.expectedResult);
      assert.equal(riskCreated.item.sourceType, "proactive_assistant");
      assert.equal(riskCreated.item.sourceId, "suggestion-risk-1");
      assert.equal(riskCreated.item.sourceProactiveId, "suggestion-risk-1");
      const riskRow = db.prepare("SELECT * FROM risk_items WHERE id = $id").get({ $id: riskInput.id });
      assert.equal(riskRow.writeback_digest, riskCreated.writebackDigest);
      assert.equal(
        computeWritebackDigest("risk", riskWritebackFromRow(riskRow)),
        riskRow.writeback_digest,
      );

      const riskReplay = service.writeRisk({ ...riskInput, mode: "create" });
      assert.equal(riskReplay.status, "replayed");
      assert.equal(riskReplay.version, 1);

      const riskUpdateInput = {
        ...riskInput,
        mode: "update",
        expectedVersion: 1,
        score: 91,
        severity: "中",
        action: "安排预算专项会议",
      };
      const riskUpdated = service.writeRisk(riskUpdateInput);
      assert.equal(riskUpdated.status, "updated");
      assert.equal(riskUpdated.version, 2);
      assert.equal(riskUpdated.item.score, 91);
      assert.equal(riskUpdated.item.severity, "中");
      assert.equal(riskUpdated.item.action, "安排预算专项会议");
      assert.equal(riskUpdated.item.writebackDigest, riskUpdated.writebackDigest);
      const riskUpdateReplay = service.writeRisk(riskUpdateInput);
      assert.equal(riskUpdateReplay.status, "replayed");
      assert.equal(riskUpdateReplay.version, 2);
    } finally {
      closeDatabase(db);
    }
  });

  it("keeps owner isolation and rejects mismatched customer/opportunity relationships", () => {
    const db = seedDatabase();
    try {
      const service = createActionRiskWritebackService({ db, idFactory: () => "unused" });
      const created = service.writeAction(reviewedAction());

      assert.throws(
        () => service.writeAction(reviewedAction({ owner: "owner-b", customerId: "customer-b", opportunityId: "opportunity-b" })),
        (error) => error instanceof ActionRiskWritebackNotFoundError
          && assertCode(error, "ACTION_RISK_WRITEBACK_NOT_FOUND"),
      );
      const unchanged = db.prepare("SELECT owner, version, title FROM action_items WHERE id = $id").get({ $id: created.id });
      assert.deepEqual({ ...unchanged }, { owner: "owner-a", version: 1, title: "确认灾备方案" });

      assert.throws(
        () => service.writeRisk(reviewedRisk({ customerId: "customer-a", opportunityId: "opportunity-b" })),
        (error) => error instanceof ActionRiskWritebackValidationError
          && assertCode(error, "ACTION_RISK_WRITEBACK_INVALID"),
      );
      assert.throws(
        () => service.writeRisk(reviewedRisk({
          id: "risk-relationship-mismatch",
          customerId: "customer-a",
          opportunityId: "opportunity-a2",
        })),
        (error) => error instanceof ActionRiskWritebackValidationError
          && assertCode(error, "ACTION_RISK_WRITEBACK_INVALID"),
      );
      assert.throws(
        () => service.writeAction(reviewedAction({
          id: "action-owner-mismatch",
          owner: "owner-b",
          customerId: "customer-a",
          opportunityId: "opportunity-a",
        })),
        (error) => error instanceof ActionRiskWritebackValidationError
          && assertCode(error, "ACTION_RISK_WRITEBACK_INVALID"),
      );
    } finally {
      closeDatabase(db);
    }
  });

  it("enforces owner-scoped quick-record provenance for action and risk writeback", () => {
    const db = seedDatabase();
    try {
      const service = createActionRiskWritebackService({ db, idFactory: () => "unused" });

      assert.throws(
        () => service.writeAction(reviewedAction({ id: "action-foreign-source", sourceRecordId: "quick-b" , sourceId: "quick-b" })),
        (error) => error instanceof ActionRiskWritebackValidationError
          && assertCode(error, "ACTION_RISK_WRITEBACK_INVALID"),
      );
      assert.throws(
        () => service.writeAction(reviewedAction({ id: "action-voided-source", sourceRecordId: "quick-a-voided", sourceId: "quick-a-voided" })),
        (error) => error instanceof ActionRiskWritebackValidationError
          && assertCode(error, "ACTION_RISK_WRITEBACK_INVALID"),
      );

      assert.throws(
        () => service.writeRisk(reviewedRisk({ id: "risk-foreign-source", sourceType: "quick_record", sourceId: "quick-b", sourceProactiveId: null })),
        (error) => error instanceof ActionRiskWritebackValidationError
          && assertCode(error, "ACTION_RISK_WRITEBACK_INVALID"),
      );
      assert.throws(
        () => service.writeRisk(reviewedRisk({ id: "risk-voided-source", sourceType: "quick_record", sourceId: "quick-a-voided", sourceProactiveId: null })),
        (error) => error instanceof ActionRiskWritebackValidationError
          && assertCode(error, "ACTION_RISK_WRITEBACK_INVALID"),
      );

      const validRisk = service.writeRisk(reviewedRisk({
        id: "risk-quick-record",
        sourceType: "quick_record",
        sourceId: "quick-a",
        sourceProactiveId: null,
      }));
      assert.equal(validRisk.status, "created");
      assert.equal(validRisk.item.sourceType, "quick_record");
      assert.equal(validRisk.item.sourceId, "quick-a");
      assert.equal(validRisk.item.owner, "owner-a");
    } finally {
      closeDatabase(db);
    }
  });

  it("rejects stale updates with a version conflict and leaves the current row unchanged", () => {
    const db = seedDatabase();
    try {
      const service = createActionRiskWritebackService({ db, idFactory: () => "unused" });
      const input = reviewedAction({ id: "action-versioned" });
      const created = service.writeAction(input);
      const updated = service.writeAction({
        ...input,
        mode: "update",
        expectedVersion: created.version,
        due: "2026-09-22",
      });
      assert.equal(updated.version, 2);
      const beforeStale = db.prepare("SELECT * FROM action_items WHERE id = $id").get({ $id: input.id });

      assert.throws(
        () => service.writeAction({
          ...input,
          mode: "update",
          expectedVersion: 1,
          due: "2026-09-23",
        }),
        (error) => error instanceof ActionRiskWritebackConflictError
          && assertCode(error, "ACTION_RISK_WRITEBACK_VERSION_CONFLICT"),
      );
      const afterStale = db.prepare("SELECT * FROM action_items WHERE id = $id").get({ $id: input.id });
      assert.deepEqual(afterStale, beforeStale);

      const riskInput = reviewedRisk({ id: "risk-versioned" });
      const riskCreated = service.writeRisk(riskInput);
      const riskUpdated = service.writeRisk({
        ...riskInput,
        mode: "update",
        expectedVersion: riskCreated.version,
        score: 93,
      });
      assert.equal(riskUpdated.version, 2);
      const riskBeforeStale = db.prepare("SELECT * FROM risk_items WHERE id = $id").get({ $id: riskInput.id });
      assert.throws(
        () => service.writeRisk({
          ...riskInput,
          mode: "update",
          expectedVersion: 1,
          score: 94,
        }),
        (error) => error instanceof ActionRiskWritebackConflictError
          && assertCode(error, "ACTION_RISK_WRITEBACK_VERSION_CONFLICT"),
      );
      const riskAfterStale = db.prepare("SELECT * FROM risk_items WHERE id = $id").get({ $id: riskInput.id });
      assert.deepEqual(riskAfterStale, riskBeforeStale);
    } finally {
      closeDatabase(db);
    }
  });

  it("fails closed on a persisted digest mismatch and rolls back the write", () => {
    const db = seedDatabase();
    try {
      const service = createActionRiskWritebackService({ db, idFactory: () => "unused" });
      db.exec(`
        CREATE TRIGGER corrupt_action_writeback_digest
        AFTER INSERT ON action_items
        WHEN NEW.id = 'action-corrupt'
        BEGIN
          UPDATE action_items
             SET writeback_digest = 'not-a-valid-digest'
           WHERE id = NEW.id;
        END;
      `);

      assert.throws(
        () => service.writeAction(reviewedAction({ id: "action-corrupt" })),
        (error) => error instanceof ActionRiskWritebackSchemaError
          && assertCode(error, "ACTION_RISK_WRITEBACK_SCHEMA_REQUIRED"),
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM action_items WHERE id = $id").get({ $id: "action-corrupt" }).count,
        0,
      );

      db.exec(`
        CREATE TRIGGER corrupt_risk_writeback_digest
        AFTER INSERT ON risk_items
        WHEN NEW.id = 'risk-corrupt'
        BEGIN
          UPDATE risk_items
             SET writeback_digest = 'not-a-valid-digest'
           WHERE id = NEW.id;
        END;
      `);
      assert.throws(
        () => service.writeRisk(reviewedRisk({ id: "risk-corrupt" })),
        (error) => error instanceof ActionRiskWritebackSchemaError
          && assertCode(error, "ACTION_RISK_WRITEBACK_SCHEMA_REQUIRED"),
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM risk_items WHERE id = $id").get({ $id: "risk-corrupt" }).count,
        0,
      );

      const created = service.writeAction(reviewedAction({ id: "action-update-corrupt" }));
      const before = db.prepare("SELECT * FROM action_items WHERE id = $id").get({ $id: created.id });
      db.exec(`
        CREATE TRIGGER corrupt_action_update_digest
        AFTER UPDATE ON action_items
        WHEN OLD.id = 'action-update-corrupt' AND OLD.version = 1 AND NEW.version = 2
        BEGIN
          UPDATE action_items
             SET writeback_digest = 'also-not-a-valid-digest'
           WHERE id = NEW.id;
        END;
      `);

      assert.throws(
        () => service.writeAction({
          ...reviewedAction({ id: "action-update-corrupt" }),
          mode: "update",
          expectedVersion: 1,
          due: "2026-09-30",
        }),
        (error) => error instanceof ActionRiskWritebackSchemaError
          && assertCode(error, "ACTION_RISK_WRITEBACK_SCHEMA_REQUIRED"),
      );
      const after = db.prepare("SELECT * FROM action_items WHERE id = $id").get({ $id: created.id });
      assert.deepEqual(after, before);
    } finally {
      closeDatabase(db);
    }
  });
});
