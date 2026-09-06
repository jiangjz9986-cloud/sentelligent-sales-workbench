import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

const NOW = "2026-09-06T04:00:00.000Z";
const OWNER = "customer-writeback-owner";
const LOGIN_PASSWORD = ["test", "customer", "writeback", "password"].join("-");
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let asOwner;

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

async function login() {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account: OWNER, password: LOGIN_PASSWORD }),
  });
  assert.equal(result.response.status, 200);
  return {
    cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    csrf: result.body.csrfToken,
  };
}

function authenticatedRequest(session) {
  return (path, options = {}) => request(path, {
    ...options,
    headers: {
      Cookie: session.cookie,
      ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": session.csrf } : {}),
      ...(options.headers ?? {}),
    },
  });
}

function seedSyntheticData(db) {
  db.prepare(`
    INSERT INTO customers (
      id, name, owner, version, decision_chain, budget, created_at, updated_at
    ) VALUES
      ('stale-preview-customer', '旧预览客户', $owner, 1, '[]', NULL, $now, $now),
      ('stale-confirm-customer', '旧确认客户', $owner, 1, '[]', NULL, $now, $now),
      ('reviewed-action-customer', '人工行动客户', $owner, 1, '[]', NULL, $now, $now),
      ('reviewed-risk-customer', '人工风险客户', $owner, 1, '[]', NULL, $now, $now),
      ('partial-fields-customer', '部分字段客户', $owner, 1, '[]', NULL, $now, $now),
      ('mutated-replay-customer', '变更重放客户', $owner, 1, '[]', NULL, $now, $now)
  `).run({ $owner: OWNER, $now: NOW });

  db.prepare(`
    INSERT INTO opportunities (
      id, customer_id, name, stage, owner, version, days, next, created_at, updated_at
    ) VALUES
      ('stale-preview-opportunity', 'stale-preview-customer', '旧预览商机', '调研机会', $owner, 1, 1, NULL, $now, $now),
      ('stale-confirm-opportunity', 'stale-confirm-customer', '旧确认商机', '调研机会', $owner, 1, 1, NULL, $now, $now),
      ('reviewed-action-opportunity', 'reviewed-action-customer', '人工行动商机', '调研机会', $owner, 1, 1, NULL, $now, $now),
      ('reviewed-risk-opportunity', 'reviewed-risk-customer', '人工风险商机', '调研机会', $owner, 1, 1, '确认采购窗口', $now, $now),
      ('partial-fields-opportunity', 'partial-fields-customer', '部分字段商机', '调研机会', $owner, 1, 1, NULL, $now, $now),
      ('mutated-replay-opportunity', 'mutated-replay-customer', '变更重放商机', '调研机会', $owner, 1, 1, NULL, $now, $now)
  `).run({ $owner: OWNER, $now: NOW });

  db.prepare(`
    INSERT INTO risk_items (
      id, customer_id, opportunity_id, title, target, score, severity, status,
      evidence, action, assignee, due, owner, version, created_at, updated_at
    ) VALUES (
      'reviewed-risk-source', 'reviewed-risk-customer', 'reviewed-risk-opportunity',
      '预算审批路径未确认', '人工风险客户 / 人工风险商机', 82, '高', 'open',
      '客户尚未确认预算审批路径', '核对预算来源和审批链', $owner, '2026-09-18',
      $owner, 1, $now, $now
    )
  `).run({ $owner: OWNER, $now: NOW });
}

async function customerSuggestion(customerId, trigger, target) {
  const snapshot = await asOwner("/api/assistant/proactive?limit=100");
  assert.equal(snapshot.response.status, 200);
  const item = snapshot.body.item.items.find((candidate) => (
    candidate.subjectType === "customer"
    && candidate.customerId === customerId
    && candidate.trigger?.type === trigger
    && candidate.writebackPreview?.[target]
  ));
  assert.ok(item, `missing customer suggestion ${customerId}/${trigger}/${target}`);
  assert.match(item.sourceDigest, DIGEST_PATTERN);
  assert.equal(item.customerSubject?.version, item.subjectVersion);
  assert.equal(item.customerSubject?.sourceDigest, item.sourceDigest);
  return item;
}

async function createPreview(suggestion, target, idempotencyKey) {
  const result = await asOwner(`/api/assistant/proactive/${suggestion.id}/previews`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ target }),
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.item.suggestionId, suggestion.id);
  assert.equal(result.body.item.target, target);
  assert.equal(result.body.item.status, "open");
  assert.match(result.body.item.previewDigest, DIGEST_PATTERN);
  return result.body.item;
}

function confirmationBody(preview) {
  return {
    confirmationPreviewId: preview.id,
    target: preview.target,
    customerId: preview.customerId,
    opportunityId: preview.opportunityId,
    expectedOpportunityVersion: preview.opportunityVersion,
    expectedCustomerVersion: preview.customerVersion,
    previewDigest: preview.previewDigest,
    preview: preview.preview,
  };
}

async function confirm(suggestion, preview, idempotencyKey) {
  return asOwner(`/api/assistant/proactive/${suggestion.id}/confirm`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(confirmationBody(preview)),
  });
}

async function editReviewFields(suggestion, fields, idempotencyKey) {
  const result = await asOwner(`/api/assistant/proactive/${suggestion.id}/fields`, {
    method: "PATCH",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ ...fields, expectedVersion: suggestion.version }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.item.version, suggestion.version + 1);
  return result.body.item;
}

function mutateOpportunity(id, changes) {
  const db = createConnection({ databaseUrl });
  try {
    db.prepare(`
      UPDATE opportunities
         SET version = version + 1,
             next = COALESCE($next, next),
             updated_at = $updatedAt
       WHERE id = $id
    `).run({
      $id: id,
      $next: changes.next ?? null,
      $updatedAt: changes.updatedAt,
    });
  } finally {
    db.close();
  }
}

function assertStaleSubject(result, previousSubject, currentSubject) {
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error.code, "PROACTIVE_SUBJECT_STALE");
  assert.equal(result.body.error.fields.expectedVersion, previousSubject.version);
  assert.equal(result.body.error.fields.expectedSourceDigest, previousSubject.sourceDigest);
  assert.equal(result.body.error.fields.currentVersion, currentSubject.version);
  assert.equal(result.body.error.fields.currentSourceDigest, currentSubject.sourceDigest);
}

describe("v0.12.0 customer proactive writeback HTTP acceptance", () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sentelligent-proactive-customer-writeback-http-"));
    databaseUrl = join(tempDir, "proactive-customer-writeback.sqlite");
    server = createServer({
      databaseUrl,
      seed: false,
      nodeEnv: "test",
      authRequired: true,
      authAccount: OWNER,
      authPassword: "",
      authPasswordHash: await hashPassword(LOGIN_PASSWORD, { salt: Buffer.alloc(16, 91) }),
      authSessionSecret: Buffer.alloc(32, 92).toString("base64url"),
      authCookieSecure: false,
      aiAnalysisMode: "mock",
      proactiveAssistantAutoRun: false,
      proactiveNotificationAutoRun: false,
      hospitalTenderAutoRun: false,
      actionReminderAutoRun: false,
      invoiceEscalationAutoRun: false,
      dailyDigestAutoRun: false,
      weixinAgentApiToken: "",
      weixinAgentOwner: "",
      assistantClock: () => new Date(NOW),
      proactiveAssistantClock: () => new Date(NOW),
      proactiveNotificationClock: () => new Date(NOW),
    });

    const db = createConnection({ databaseUrl });
    try {
      seedSyntheticData(db);
    } finally {
      db.close();
    }

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    asOwner = authenticatedRequest(await login());

    server.proactiveScanRepository.updateState({ batchSize: 100, intervalSeconds: 30 });
    const scan = await server.proactiveAssistantWorker.runOnce({ force: true });
    assert.equal(scan.status, "success");
    assert.equal(scan.objectCount, 6);
    assert.equal(scan.customerScan.failedCount, 0);
    assert.equal(scan.customerScan.succeededCount, 6);
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects an old customer preview after subject revision and digest changes", async () => {
    const oldPreviewSuggestion = await customerSuggestion(
      "stale-preview-customer",
      "missing_next_step",
      "action",
    );
    const oldPreviewSubject = server.customerProactiveSubjectService.getSubject({
      owner: OWNER,
      customerId: oldPreviewSuggestion.customerId,
    });

    mutateOpportunity("stale-preview-opportunity", {
      next: "安排客户需求澄清会",
      updatedAt: "2026-09-06T04:01:00.000Z",
    });
    const previewRefresh = server.customerProactiveSubjectService.syncCustomer({
      owner: OWNER,
      customerId: oldPreviewSuggestion.customerId,
      includeExtendedSignals: true,
    });
    assert.equal(previewRefresh.subject.version, oldPreviewSubject.version + 1);
    assert.notEqual(previewRefresh.subject.sourceDigest, oldPreviewSubject.sourceDigest);

    const stalePreview = await asOwner(`/api/assistant/proactive/${oldPreviewSuggestion.id}/previews`, {
      method: "POST",
      headers: { "Idempotency-Key": "customer-subject-stale-preview" },
      body: JSON.stringify({ target: "action" }),
    });
    assertStaleSubject(stalePreview, oldPreviewSubject, previewRefresh.subject);
  });

  it("rejects an old customer confirmation after subject revision and digest changes", async () => {
    const oldConfirmSuggestion = await customerSuggestion(
      "stale-confirm-customer",
      "missing_next_step",
      "action",
    );
    const oldConfirmSubject = server.customerProactiveSubjectService.getSubject({
      owner: OWNER,
      customerId: oldConfirmSuggestion.customerId,
    });
    const durablePreview = await createPreview(
      oldConfirmSuggestion,
      "action",
      "customer-subject-stale-confirm-preview",
    );

    mutateOpportunity("stale-confirm-opportunity", {
      updatedAt: "2026-09-06T04:02:00.000Z",
    });
    const confirmRefresh = server.customerProactiveSubjectService.syncCustomer({
      owner: OWNER,
      customerId: oldConfirmSuggestion.customerId,
      includeExtendedSignals: true,
    });
    assert.equal(confirmRefresh.subject.version, oldConfirmSubject.version + 1);
    assert.notEqual(confirmRefresh.subject.sourceDigest, oldConfirmSubject.sourceDigest);

    const staleConfirmation = await confirm(
      oldConfirmSuggestion,
      durablePreview,
      "customer-subject-stale-confirm",
    );
    assertStaleSubject(staleConfirmation, oldConfirmSubject, confirmRefresh.subject);
  });

  it("writes reviewed action fields and preserves provenance and digest across exact and stable replays", async () => {
    const suggestion = await customerSuggestion(
      "reviewed-action-customer",
      "missing_next_step",
      "action",
    );
    const edited = await editReviewFields(suggestion, {
      assignee: OWNER,
      dueDate: "2026-09-20",
      priority: "high",
      expectedResult: "客户书面确认下一次会议时间和交付边界",
    }, "customer-action-review-fields");
    assert.deepEqual(edited.reviewFields, {
      assignee: OWNER,
      dueDate: "2026-09-20",
      priority: "高",
      expectedResult: "客户书面确认下一次会议时间和交付边界",
    });

    const preview = await createPreview(edited, "action", "customer-action-preview");
    const created = await confirm(edited, preview, "customer-action-confirm");
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.item.replayed, false);
    const action = created.body.item.action;
    assert.equal(action.expectedResult, edited.reviewFields.expectedResult);
    assert.equal(action.assignee, OWNER);
    assert.equal(action.due, "2026-09-20");
    assert.equal(action.priority, "高");
    assert.equal(action.sourceType, "proactive_assistant");
    assert.equal(action.sourceId, edited.id);
    assert.equal(action.sourceProactiveId, edited.id);
    assert.match(action.writebackDigest, DIGEST_PATTERN);

    const exactReplay = await confirm(edited, preview, "customer-action-confirm");
    assert.equal(exactReplay.response.status, 201);
    assert.deepEqual(exactReplay.body, created.body);

    const stableReplay = await confirm(edited, preview, "customer-action-confirm-stable-replay");
    assert.equal(stableReplay.response.status, 200);
    assert.equal(stableReplay.body.item.replayed, true);
    assert.equal(stableReplay.body.item.action.id, action.id);
    assert.equal(stableReplay.body.item.action.writebackDigest, action.writebackDigest);
    assert.equal(stableReplay.body.item.action.sourceType, "proactive_assistant");
    assert.equal(stableReplay.body.item.action.sourceId, edited.id);
    assert.equal(stableReplay.body.item.action.sourceProactiveId, edited.id);

    const db = createConnection({ databaseUrl });
    try {
      const row = db.prepare("SELECT * FROM action_items WHERE id = $id").get({ $id: action.id });
      assert.equal(row.expected_result, edited.reviewFields.expectedResult);
      assert.equal(row.source_type, "proactive_assistant");
      assert.equal(row.source_id, edited.id);
      assert.equal(row.source_proactive_id, edited.id);
      assert.equal(row.writeback_digest, action.writebackDigest);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM action_items WHERE source_proactive_id = $id").get({ $id: edited.id }).count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'action.create' AND entity_id = $id").get({ $id: action.id }).count, 1);
      const audit = db.prepare(`
        SELECT metadata_json FROM audit_logs
         WHERE action = 'proactive_assistant.confirm'
           AND entity_id = $id
         ORDER BY created_at, id
         LIMIT 1
      `).get({ $id: edited.id });
      assert.equal(JSON.parse(audit.metadata_json).writebackDigest, action.writebackDigest);
    } finally {
      db.close();
    }
  });

  it("preserves omitted review fields, clears only explicit nulls, and audits actual changes", async () => {
    const suggestion = await customerSuggestion(
      "partial-fields-customer",
      "missing_next_step",
      "action",
    );
    const noOp = await asOwner(`/api/assistant/proactive/${suggestion.id}/fields`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "customer-action-review-fields-no-op" },
      body: JSON.stringify({ expectedVersion: suggestion.version }),
    });
    assert.equal(noOp.response.status, 200, JSON.stringify(noOp.body));
    assert.equal(noOp.body.item.version, suggestion.version);
    assert.deepEqual(noOp.body.item.reviewFields, suggestion.reviewFields);

    const initial = await editReviewFields(suggestion, {
      assignee: OWNER,
      dueDate: "2026-09-22",
      priority: "high",
      expectedResult: "保留其余人工审核字段",
    }, "customer-action-review-fields-initial");
    const dueOnly = await editReviewFields(initial, {
      dueDate: "2026-09-23",
    }, "customer-action-review-fields-due-only");
    assert.deepEqual(dueOnly.reviewFields, {
      assignee: OWNER,
      dueDate: "2026-09-23",
      priority: "高",
      expectedResult: "保留其余人工审核字段",
    });

    const cleared = await editReviewFields(dueOnly, {
      priority: null,
    }, "customer-action-review-fields-clear-priority");
    assert.deepEqual(cleared.reviewFields, {
      assignee: OWNER,
      dueDate: "2026-09-23",
      priority: null,
      expectedResult: "保留其余人工审核字段",
    });

    const db = createConnection({ databaseUrl });
    try {
      const audits = db.prepare(`
        SELECT metadata_json FROM audit_logs
         WHERE action = 'proactive_assistant.fields.update'
           AND entity_id = $id
         ORDER BY id ASC
      `).all({ $id: suggestion.id }).map((row) => JSON.parse(row.metadata_json));
      assert.equal(audits.length, 3);
      assert.ok(audits.some((audit) => JSON.stringify(audit.changedFields) === JSON.stringify(["dueDate"])));
      assert.ok(audits.some((audit) => JSON.stringify(audit.changedFields) === JSON.stringify(["priority"])));
    } finally {
      db.close();
    }
  });

  it("rejects a fresh-key stable replay after the persisted action changes", async () => {
    const suggestion = await customerSuggestion(
      "mutated-replay-customer",
      "missing_next_step",
      "action",
    );
    const edited = await editReviewFields(suggestion, {
      assignee: OWNER,
      dueDate: "2026-09-24",
      priority: "medium",
      expectedResult: "保持原始确认内容",
    }, "customer-action-mutated-replay-fields");
    const preview = await createPreview(edited, "action", "customer-action-mutated-replay-preview");
    const created = await confirm(edited, preview, "customer-action-mutated-replay-confirm");
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const action = created.body.item.action;

    const changed = await asOwner(`/api/actions/${action.id}`, {
      method: "PATCH",
      headers: { "If-Match": `"${action.version}"` },
      body: JSON.stringify({ due: "2026-09-30" }),
    });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
    assert.notEqual(changed.body.item.writebackDigest, action.writebackDigest);

    const replay = await confirm(edited, preview, "customer-action-mutated-replay-fresh-key");
    assert.equal(replay.response.status, 409, JSON.stringify(replay.body));
    assert.equal(replay.body.error.code, "PROACTIVE_PREVIEW_STALE");
    assert.equal(replay.body.error.fields.currentVersion, changed.body.item.version);

    const db = createConnection({ databaseUrl });
    try {
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM idempotency_keys
         WHERE key = 'customer-action-mutated-replay-fresh-key'
      `).get().count, 0);
    } finally {
      db.close();
    }
  });

  it("maps reviewed risk priority to severity and preserves complete provenance and digest across replays", async () => {
    const suggestion = await customerSuggestion(
      "reviewed-risk-customer",
      "risk_open",
      "risk",
    );
    const edited = await editReviewFields(suggestion, {
      assignee: OWNER,
      dueDate: "2026-09-21",
      priority: "low",
      expectedResult: "获得书面预算窗口、审批链和最终拍板人",
    }, "customer-risk-review-fields");
    assert.equal(edited.reviewFields.priority, "低");

    const preview = await createPreview(edited, "risk", "customer-risk-preview");
    const created = await confirm(edited, preview, "customer-risk-confirm");
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.item.replayed, false);
    const risk = created.body.item.risk;
    assert.equal(risk.severity, "低");
    assert.equal(risk.assignee, OWNER);
    assert.equal(risk.due, "2026-09-21");
    assert.equal(risk.expectedResult, edited.reviewFields.expectedResult);
    assert.equal(risk.sourceType, "proactive_assistant");
    assert.equal(risk.sourceId, edited.id);
    assert.equal(risk.sourceProactiveId, edited.id);
    assert.match(risk.writebackDigest, DIGEST_PATTERN);

    const exactReplay = await confirm(edited, preview, "customer-risk-confirm");
    assert.equal(exactReplay.response.status, 201);
    assert.deepEqual(exactReplay.body, created.body);

    const stableReplay = await confirm(edited, preview, "customer-risk-confirm-stable-replay");
    assert.equal(stableReplay.response.status, 200);
    assert.equal(stableReplay.body.item.replayed, true);
    assert.equal(stableReplay.body.item.risk.id, risk.id);
    assert.equal(stableReplay.body.item.risk.severity, "低");
    assert.equal(stableReplay.body.item.risk.writebackDigest, risk.writebackDigest);
    assert.equal(stableReplay.body.item.risk.sourceType, "proactive_assistant");
    assert.equal(stableReplay.body.item.risk.sourceId, edited.id);
    assert.equal(stableReplay.body.item.risk.sourceProactiveId, edited.id);

    const db = createConnection({ databaseUrl });
    try {
      const row = db.prepare("SELECT * FROM risk_items WHERE id = $id").get({ $id: risk.id });
      assert.equal(row.severity, "低");
      assert.equal(row.expected_result, edited.reviewFields.expectedResult);
      assert.equal(row.source_type, "proactive_assistant");
      assert.equal(row.source_id, edited.id);
      assert.equal(row.source_proactive_id, edited.id);
      assert.equal(row.writeback_digest, risk.writebackDigest);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM risk_items WHERE source_proactive_id = $id").get({ $id: edited.id }).count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'risk.create' AND entity_id = $id").get({ $id: risk.id }).count, 1);
      const audit = db.prepare(`
        SELECT metadata_json FROM audit_logs
         WHERE action = 'proactive_assistant.confirm'
           AND entity_id = $id
         ORDER BY created_at, id
         LIMIT 1
      `).get({ $id: edited.id });
      assert.equal(JSON.parse(audit.metadata_json).writebackDigest, risk.writebackDigest);
    } finally {
      db.close();
    }
  });
});
