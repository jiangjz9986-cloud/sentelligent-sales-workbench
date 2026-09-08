import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { cleanupProductionSmokeRun as cleanupProductionSmokeRunRaw } from "../scripts/production-smoke-cleanup.mjs";
import { openDatabase } from "../src/db.js";
import { createDatabaseIdentity } from "../src/db/databaseIdentity.js";

const temporaryDirectories = [];
const TEST_SESSION_SECRET = "test-backend-session-private-secret";

function cleanupProductionSmokeRun(options = {}) {
  const expectedDatabaseIdentity = options.expectedDatabaseIdentity
    ?? (
      typeof options.databaseUrl === "string"
      && existsSync(options.databaseUrl)
      && typeof options.authSessionSecret === "string"
      && options.authSessionSecret.length >= 32
        ? createDatabaseIdentity({
            databaseUrl: options.databaseUrl,
            secret: options.authSessionSecret,
          })
        : "x".repeat(43)
    );
  return cleanupProductionSmokeRunRaw({ ...options, expectedDatabaseIdentity });
}

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "sent-zx-production-smoke-cleanup-"));
  temporaryDirectories.push(directory);
  const databaseUrl = join(directory, "workbench.sqlite");
  const db = openDatabase({ databaseUrl });
  return { db, databaseUrl };
}

function sessionHash(secret, cookie) {
  return createHmac("sha256", secret)
    .update(`session-store:v1:${cookie}`)
    .digest("base64url");
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function insertFixture(db, {
  runId,
  account = "jiangjz",
  sessionCookie,
  sessionSecret,
  includeUnrelatedDependent = false,
} = {}) {
  const marker = `[smoke:${runId}]`;
  const ids = {
    customer: randomUUID(),
    opportunity: randomUUID(),
    quickRecord: randomUUID(),
    insight: randomUUID(),
    salesDecision: randomUUID(),
    itinerary: randomUUID(),
    weeklyReport: randomUUID(),
    audit: randomUUID(),
    session: randomUUID(),
  };

  db.prepare(`
    INSERT INTO customers (id, name, owner, summary)
    VALUES ($id, $name, $owner, $summary)
  `).run({ $id: ids.customer, $name: `${marker} 客户`, $owner: account, $summary: marker });
  db.prepare(`
    INSERT INTO opportunities (id, customer_id, name, owner, risk, next)
    VALUES ($id, $customerId, $name, $owner, $risk, $next)
  `).run({
    $id: ids.opportunity,
    $customerId: ids.customer,
    $name: `${marker} 商机`,
    $owner: account,
    $risk: marker,
    $next: marker,
  });
  db.prepare(`
    INSERT INTO quick_records (
      id, owner, raw_content, source_channel, customer_id, opportunity_id, status
    ) VALUES ($id, $owner, $rawContent, $sourceChannel, $customerId, $opportunityId, 'analyzed')
  `).run({
    $id: ids.quickRecord,
    $owner: account,
    $rawContent: `${marker} 快速记录`,
    $sourceChannel: marker,
    $customerId: ids.customer,
    $opportunityId: ids.opportunity,
  });
  db.prepare(`
    INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
    VALUES ($id, $quickRecordId, 'deepseek', 90, $analysisJson)
  `).run({
    $id: ids.insight,
    $quickRecordId: ids.quickRecord,
    $analysisJson: JSON.stringify({ marker }),
  });
  db.prepare(`
    INSERT INTO sales_decision_analyses (
      id, analysis_type, industry, customer_id, opportunity_id, quick_record_id,
      input_json, analysis_json, source, created_by
    ) VALUES (
      $id, 'opportunity_diagnosis', 'medical', $customerId, $opportunityId,
      $quickRecordId, $inputJson, $analysisJson, 'deepseek', $createdBy
    )
  `).run({
    $id: ids.salesDecision,
    $customerId: ids.customer,
    $opportunityId: ids.opportunity,
    $quickRecordId: ids.quickRecord,
    $inputJson: JSON.stringify({ rawContent: marker }),
    $analysisJson: JSON.stringify({ decision: "validate" }),
    $createdBy: account,
  });
  db.prepare(`
    INSERT INTO visit_itineraries (
      id, title, visit_date, request_json, plan_json, created_by, updated_by
    ) VALUES ($id, $title, '2099-01-01', $requestJson, $planJson, $actor, $actor)
  `).run({
    $id: ids.itinerary,
    $title: `${marker} 行程`,
    $requestJson: JSON.stringify({ marker, stops: [] }),
    $planJson: JSON.stringify({ route: { distanceMeters: 1 } }),
    $actor: account,
  });
  db.prepare(`
    INSERT INTO weekly_reports (
      id, owner, period_start, period_end, content, source_refs
    ) VALUES ($id, $owner, '2099-01-01', '2099-01-07', $content, '[]')
  `).run({
    $id: ids.weeklyReport,
    $owner: `smoke:${runId}`,
    $content: marker,
  });
  db.prepare(`
    INSERT INTO audit_logs (
      id, action, entity_type, entity_id, actor, metadata_json,
      request_id, before_json, after_json, entity_version
    ) VALUES (
      $id, 'customer.create', 'customer', $entityId, $actor, $metadata,
      $requestId, '{}', $afterJson, 1
    )
  `).run({
    $id: ids.audit,
    $entityId: ids.customer,
    $actor: account,
    $metadata: JSON.stringify({ marker }),
    $requestId: randomUUID(),
    $afterJson: JSON.stringify({ id: ids.customer, marker }),
  });
  db.prepare(`
    INSERT INTO auth_sessions (id, token_hash, account, expires_at, revoked_at, created_at)
    VALUES ($id, $tokenHash, $account, '2099-01-01T00:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run({
    $id: ids.session,
    $tokenHash: sessionHash(sessionSecret, sessionCookie),
    $account: account,
  });
  db.prepare(`
    INSERT INTO idempotency_keys (
      actor, method, request_path, key, request_hash, state,
      response_status, response_json, created_at, expires_at
    ) VALUES (
      $actor, 'POST', '/api/quick-records', $key, 'hash', 'completed',
      201, '{}', CURRENT_TIMESTAMP, '2099-01-01T00:00:00.000Z'
    )
  `).run({ $actor: account, $key: `smoke:${runId}:quick-record` });

  if (includeUnrelatedDependent) {
    db.prepare(`
      INSERT INTO solution_drafts (
        id, owner, title, customer_id, opportunity_id, content
      ) VALUES ($id, 'real-user', '真实方案', $customerId, $opportunityId, '不得删除')
    `).run({
      $id: randomUUID(),
      $customerId: ids.customer,
      $opportunityId: ids.opportunity,
    });
  }

  return {
    ids,
    marker,
    createdIds: {
      customers: [ids.customer],
      opportunities: [ids.opportunity],
      quickRecords: [ids.quickRecord],
      aiInsights: [ids.insight],
      salesDecisions: [ids.salesDecision],
      itineraries: [ids.itinerary],
      weeklyReports: [ids.weeklyReport],
      auditLogs: [ids.audit],
    },
    idempotencyKeys: [{
      actor: account,
      method: "POST",
      requestPath: "/api/quick-records",
      key: `smoke:${runId}:quick-record`,
    }],
  };
}

function insertProactiveDerivatives(db, {
  fixture,
  account = "jiangjz",
  customerId = fixture.ids.customer,
  opportunityId = fixture.ids.opportunity,
  marker = fixture.marker,
  count = 4,
  includeSubject = true,
} = {}) {
  const now = "2099-01-03T02:00:00.000Z";
  const sourceRefs = JSON.stringify([
    { type: "customer", id: customerId, label: `${marker} 客户` },
    { type: "opportunity", id: opportunityId, label: `${marker} 商机` },
  ]);
  if (includeSubject) {
    db.prepare(`
      INSERT INTO proactive_subjects (
        id, owner, subject_type, subject_id, subject_key, customer_id,
        version, source_digest, source_refs_json, created_at, updated_at
      ) VALUES (
        $id, $owner, 'customer', $customerId, $subjectKey, $customerId,
        1, $sourceDigest, $sourceRefs, $now, $now
      )
    `).run({
      $id: randomUUID(),
      $owner: account,
      $customerId: customerId,
      $subjectKey: `customer:${account}:${customerId}`,
      $sourceDigest: sha256(`subject:${account}:${customerId}`),
      $sourceRefs: sourceRefs,
      $now: now,
    });
  }

  const result = { suggestions: [], notifications: [], outbox: [] };
  const triggers = [
    "budget_unknown",
    "decision_chain_unknown",
    "purchase_timing_unknown",
    "stage_evidence_mismatch",
  ];
  for (let index = 0; index < count; index += 1) {
    const suggestionId = randomUUID();
    const notificationId = randomUUID();
    const outboxId = randomUUID();
    const trigger = triggers[index % triggers.length];
    const title = `${marker} 主动建议 ${index + 1}`;
    const content = JSON.stringify({
      marker,
      subjectType: "customer",
      subjectId: customerId,
      customerId,
      opportunityId,
      title,
      trigger: { type: trigger },
    });
    db.prepare(`
      INSERT INTO ai_suggestions (
        id, version, owner, type, title, status, content, draft_content,
        confidence, source_id, source_refs, confirmation_preview, source,
        proactive_trigger, proactive_subject_type, proactive_subject_id,
        proactive_subject_key, proactive_subject_version, proactive_source_digest,
        proactive_source_refs, proactive_customer_id, proactive_opportunity_id,
        proactive_dedupe_key, proactive_rule_version, proactive_priority,
        proactive_status, proactive_generated_at, proactive_last_seen_at,
        proactive_payload_hash, created_at, updated_at
      ) VALUES (
        $id, 1, $owner, 'opportunity_push', $title, 'pending', $content, $content,
        80, $customerId, $sourceRefs, $confirmationPreview, 'deterministic',
        $trigger, 'customer', $customerId, $subjectKey, 1, $sourceDigest,
        $sourceRefs, $customerId, $opportunityId, $dedupeKey,
        'customer-proactive-subject-v1', 80, 'pending', $now, $now,
        $payloadHash, $now, $now
      )
    `).run({
      $id: suggestionId,
      $owner: account,
      $title: title,
      $content: content,
      $customerId: customerId,
      $opportunityId: opportunityId,
      $sourceRefs: sourceRefs,
      $confirmationPreview: JSON.stringify({ marker, customerId, opportunityId }),
      $trigger: trigger,
      $subjectKey: `customer:${account}:${customerId}`,
      $sourceDigest: sha256(`source:${suggestionId}`),
      $dedupeKey: `proactive:v1:${account}:${customerId}:${trigger}:${index}`,
      $payloadHash: sha256(content),
      $now: now,
    });

    const payload = canonicalJson({
      kind: "proactive_suggestion",
      suggestionId,
      title,
      trigger,
      status: "pending",
      priority: 80,
      summary: title,
    });
    const payloadJson = JSON.stringify(payload);
    db.prepare(`
      INSERT INTO weixin_confirmation_outbox (
        id, owner, conversation_id, idempotency_key_hash, payload_json,
        payload_hash, status, attempt_count, available_at, created_at, updated_at
      ) VALUES (
        $id, $owner, 'smoke-conversation', $keyHash, $payloadJson,
        $payloadHash, 'queued', 0, $now, $now, $now
      )
    `).run({
      $id: outboxId,
      $owner: account,
      $keyHash: sha256(`proactive-suggestion:${suggestionId}:v1`),
      $payloadJson: payloadJson,
      $payloadHash: sha256(payloadJson),
      $now: now,
    });
    db.prepare(`
      INSERT INTO proactive_notifications (
        id, owner, suggestion_id, suggestion_version, channel, status,
        title, trigger, priority, summary, outbox_id, attempt_count,
        available_at, created_at, updated_at
      ) VALUES (
        $id, $owner, $suggestionId, 1, 'weixin', 'queued',
        $title, $trigger, 80, $title, $outboxId, 0, $now, $now, $now
      )
    `).run({
      $id: notificationId,
      $owner: account,
      $suggestionId: suggestionId,
      $title: title,
      $trigger: trigger,
      $outboxId: outboxId,
      $now: now,
    });
    result.suggestions.push(suggestionId);
    result.notifications.push(notificationId);
    result.outbox.push(outboxId);
  }
  return result;
}

function count(db, table, where = "1 = 1", params = {}) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(params).count);
}

test("cleanup rejects an invalid run id before opening the database", () => {
  assert.throws(
    () => cleanupProductionSmokeRun({
      databaseUrl: "Z:/must-not-be-opened.sqlite",
      runId: "not-a-uuid",
      account: "jiangjz",
      sessionCookie: "a".repeat(43),
      authSessionSecret: TEST_SESSION_SECRET,
    }),
    /runId/i,
  );
});

test("cleanup implementation contains no fuzzy SQL selector", () => {
  const source = readFileSync(
    new URL("../scripts/production-smoke-cleanup.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\binstr\s*\(|\bLIKE\b|\bGLOB\b/iu);
});

test("cleanup removes only marker-owned smoke data and its exact session", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "a".repeat(43);
  const sessionSecret = TEST_SESSION_SECRET;
  const fixture = insertFixture(db, { runId, sessionCookie, sessionSecret });

  const realCustomerId = randomUUID();
  const otherSessionId = randomUUID();
  db.prepare("INSERT INTO customers (id, name, owner) VALUES ($id, '真实客户', 'jiangjz')")
    .run({ $id: realCustomerId });
  db.prepare(`
    INSERT INTO auth_sessions (id, token_hash, account, expires_at, created_at)
    VALUES ($id, $tokenHash, 'jiangjz', '2099-01-01T00:00:00.000Z', CURRENT_TIMESTAMP)
  `).run({ $id: otherSessionId, $tokenHash: "b".repeat(43) });
  db.close();

  const report = cleanupProductionSmokeRun({
    databaseUrl,
    runId,
    account: "jiangjz",
    sessionCookie,
    authSessionSecret: sessionSecret,
    createdIds: fixture.createdIds,
    idempotencyKeys: fixture.idempotencyKeys,
  });

  assert.equal(report.status, "clean");
  assert.equal(report.runId, runId);
  assert.equal(report.integrity.quickCheck, "ok");
  assert.equal(report.integrity.foreignKeyViolations, 0);
  assert.deepEqual(report.residual, {
    customers: 0,
    opportunities: 0,
    quickRecords: 0,
    aiInsights: 0,
    salesDecisions: 0,
    itineraries: 0,
    weeklyReports: 0,
    auditLogs: 0,
    proactiveSuggestions: 0,
    proactiveNotifications: 0,
    weixinConfirmationOutbox: 0,
    authSessions: 0,
    idempotencyKeys: 0,
  });
  assert.equal(report.deleted.customers, 1);
  assert.equal(report.deleted.authSessions, 1);

  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "customers", "id = $id", { $id: realCustomerId }), 1);
    assert.equal(count(verify, "auth_sessions", "id = $id", { $id: otherSessionId }), 1);
    for (const [table, id] of [
      ["customers", fixture.ids.customer],
      ["opportunities", fixture.ids.opportunity],
      ["quick_records", fixture.ids.quickRecord],
      ["ai_insights", fixture.ids.insight],
      ["sales_decision_analyses", fixture.ids.salesDecision],
      ["visit_itineraries", fixture.ids.itinerary],
      ["weekly_reports", fixture.ids.weeklyReport],
      ["audit_logs", fixture.ids.audit],
      ["auth_sessions", fixture.ids.session],
    ]) {
      assert.equal(count(verify, table, "id = $id", { $id: id }), 0, `${table} residue`);
    }
  } finally {
    verify.close();
  }
});

test("cleanup removes marker-owned proactive suggestions, notifications, and WeChat outbox rows", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "q".repeat(43);
  const fixture = insertFixture(db, {
    runId,
    sessionCookie,
    sessionSecret: TEST_SESSION_SECRET,
  });
  const derivatives = insertProactiveDerivatives(db, { fixture });
  db.close();

  const report = cleanupProductionSmokeRun({
    databaseUrl,
    runId,
    account: "jiangjz",
    sessionCookie,
    authSessionSecret: TEST_SESSION_SECRET,
    createdIds: fixture.createdIds,
    idempotencyKeys: fixture.idempotencyKeys,
  });

  assert.equal(report.status, "clean");
  assert.equal(report.discovered.proactiveSuggestions, 4);
  assert.equal(report.discovered.proactiveNotifications, 4);
  assert.equal(report.discovered.weixinConfirmationOutbox, 4);
  assert.equal(report.deleted.proactiveSuggestions, 4);
  assert.equal(report.deleted.proactiveNotifications, 4);
  assert.equal(report.deleted.weixinConfirmationOutbox, 4);
  assert.equal(report.residual.proactiveSuggestions, 0);
  assert.equal(report.residual.proactiveNotifications, 0);
  assert.equal(report.residual.weixinConfirmationOutbox, 0);
  assert.ok(Object.values(report.residual).every((value) => value === 0));
  assert.equal(report.integrity.quickCheck, "ok");
  assert.equal(report.integrity.foreignKeyViolations, 0);

  const verify = openDatabase({ databaseUrl });
  try {
    for (const id of derivatives.suggestions) {
      assert.equal(count(verify, "ai_suggestions", "id = $id", { $id: id }), 0);
    }
    for (const id of derivatives.notifications) {
      assert.equal(count(verify, "proactive_notifications", "id = $id", { $id: id }), 0);
    }
    for (const id of derivatives.outbox) {
      assert.equal(count(verify, "weixin_confirmation_outbox", "id = $id", { $id: id }), 0);
    }
    assert.equal(
      count(verify, "proactive_subjects", "customer_id = $id", { $id: fixture.ids.customer }),
      0,
    );
  } finally {
    verify.close();
  }
});

test("cleanup preserves copied markers when proactive data is bound to unrelated parents", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "r".repeat(43);
  const fixture = insertFixture(db, {
    runId,
    sessionCookie,
    sessionSecret: TEST_SESSION_SECRET,
  });
  const smokeDerivatives = insertProactiveDerivatives(db, { fixture });
  const realCustomerId = randomUUID();
  const realOpportunityId = randomUUID();
  db.prepare("INSERT INTO customers (id, name, owner) VALUES ($id, '真实客户', 'jiangjz')")
    .run({ $id: realCustomerId });
  db.prepare(`
    INSERT INTO opportunities (id, customer_id, name, owner)
    VALUES ($id, $customerId, '真实商机', 'jiangjz')
  `).run({ $id: realOpportunityId, $customerId: realCustomerId });
  const unrelated = insertProactiveDerivatives(db, {
    fixture,
    customerId: realCustomerId,
    opportunityId: realOpportunityId,
    count: 1,
  });
  db.close();

  const report = cleanupProductionSmokeRun({
    databaseUrl,
    runId,
    account: "jiangjz",
    sessionCookie,
    authSessionSecret: TEST_SESSION_SECRET,
    createdIds: fixture.createdIds,
    idempotencyKeys: fixture.idempotencyKeys,
  });

  assert.equal(report.deleted.proactiveSuggestions, 4);
  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "ai_suggestions", "id = $id", { $id: unrelated.suggestions[0] }), 1);
    assert.equal(
      count(verify, "proactive_notifications", "id = $id", { $id: unrelated.notifications[0] }),
      1,
    );
    assert.equal(
      count(verify, "weixin_confirmation_outbox", "id = $id", { $id: unrelated.outbox[0] }),
      1,
    );
    for (const id of smokeDerivatives.suggestions) {
      assert.equal(count(verify, "ai_suggestions", "id = $id", { $id: id }), 0);
    }
  } finally {
    verify.close();
  }
});

test("cleanup rejects proactive data owned by another account when it targets smoke parents", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "s".repeat(43);
  const fixture = insertFixture(db, {
    runId,
    sessionCookie,
    sessionSecret: TEST_SESSION_SECRET,
  });
  const forged = insertProactiveDerivatives(db, {
    fixture,
    account: "real-user",
    count: 1,
  });
  db.close();

  assert.throws(
    () => cleanupProductionSmokeRun({
      databaseUrl,
      runId,
      account: "jiangjz",
      sessionCookie,
      authSessionSecret: TEST_SESSION_SECRET,
      createdIds: fixture.createdIds,
      idempotencyKeys: fixture.idempotencyKeys,
    }),
    /unrelated proactive suggestion|owner|smoke customer/i,
  );

  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "customers", "id = $id", { $id: fixture.ids.customer }), 1);
    assert.equal(count(verify, "ai_suggestions", "id = $id", { $id: forged.suggestions[0] }), 1);
    assert.equal(
      count(verify, "proactive_notifications", "id = $id", { $id: forged.notifications[0] }),
      1,
    );
    assert.equal(count(verify, "weixin_confirmation_outbox", "id = $id", { $id: forged.outbox[0] }), 1);
  } finally {
    verify.close();
  }
});

test("cleanup rejects a forged proactive outbox envelope and preserves the transaction", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "t".repeat(43);
  const fixture = insertFixture(db, {
    runId,
    sessionCookie,
    sessionSecret: TEST_SESSION_SECRET,
  });
  const derivatives = insertProactiveDerivatives(db, { fixture, count: 1 });
  const row = db.prepare(`
    SELECT payload_json FROM weixin_confirmation_outbox WHERE id = $id
  `).get({ $id: derivatives.outbox[0] });
  const forgedPayload = {
    ...JSON.parse(row.payload_json),
    title: "真实业务通知",
    summary: "真实业务通知",
  };
  const forgedPayloadJson = JSON.stringify(canonicalJson(forgedPayload));
  db.prepare(`
    UPDATE weixin_confirmation_outbox
       SET payload_json = $payloadJson, payload_hash = $payloadHash
     WHERE id = $id
  `).run({
    $id: derivatives.outbox[0],
    $payloadJson: forgedPayloadJson,
    $payloadHash: sha256(forgedPayloadJson),
  });
  db.close();

  assert.throws(
    () => cleanupProductionSmokeRun({
      databaseUrl,
      runId,
      account: "jiangjz",
      sessionCookie,
      authSessionSecret: TEST_SESSION_SECRET,
      createdIds: fixture.createdIds,
      idempotencyKeys: fixture.idempotencyKeys,
    }),
    /unrelated.*outbox|unowned.*outbox|ownership/i,
  );

  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "customers", "id = $id", { $id: fixture.ids.customer }), 1);
    assert.equal(count(verify, "ai_suggestions", "id = $id", { $id: derivatives.suggestions[0] }), 1);
    assert.equal(
      count(verify, "proactive_notifications", "id = $id", { $id: derivatives.notifications[0] }),
      1,
    );
    assert.equal(
      count(verify, "weixin_confirmation_outbox", "id = $id", { $id: derivatives.outbox[0] }),
      1,
    );
  } finally {
    verify.close();
  }
});

test("cleanup aborts without deleting anything when unrelated data depends on smoke rows", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "c".repeat(43);
  const sessionSecret = TEST_SESSION_SECRET;
  const fixture = insertFixture(db, {
    runId,
    sessionCookie,
    sessionSecret,
    includeUnrelatedDependent: true,
  });
  db.close();

  assert.throws(
    () => cleanupProductionSmokeRun({
      databaseUrl,
      runId,
      account: "jiangjz",
      sessionCookie,
      authSessionSecret: sessionSecret,
      createdIds: fixture.createdIds,
      idempotencyKeys: fixture.idempotencyKeys,
    }),
    /unrelated|dependent|solution/i,
  );

  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "customers", "id = $id", { $id: fixture.ids.customer }), 1);
    assert.equal(count(verify, "opportunities", "id = $id", { $id: fixture.ids.opportunity }), 1);
    assert.equal(count(verify, "solution_drafts", "customer_id = $id", { $id: fixture.ids.customer }), 1);
  } finally {
    verify.close();
  }
});

test("cleanup never deletes a marker-bearing row outside the exact created id manifest", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "d".repeat(43);
  const sessionSecret = TEST_SESSION_SECRET;
  const fixture = insertFixture(db, { runId, sessionCookie, sessionSecret });
  const copiedMarkerCustomerId = randomUUID();
  db.prepare(`
    INSERT INTO customers (id, name, owner, summary)
    VALUES ($id, $name, 'real-user', 'This row is not owned by the smoke run')
  `).run({
    $id: copiedMarkerCustomerId,
    $name: `${fixture.marker} copied into unrelated data`,
  });
  db.close();

  const report = cleanupProductionSmokeRun({
    databaseUrl,
    runId,
    account: "jiangjz",
    sessionCookie,
    authSessionSecret: sessionSecret,
    createdIds: fixture.createdIds,
    idempotencyKeys: fixture.idempotencyKeys,
  });

  assert.equal(report.deleted.customers, 1);
  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "customers", "id = $id", { $id: copiedMarkerCustomerId }), 1);
    assert.equal(count(verify, "customers", "id = $id", { $id: fixture.ids.customer }), 0);
  } finally {
    verify.close();
  }
});

test("cleanup recovers a marker-owned row when the create response was lost", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "p".repeat(43);
  const fixture = insertFixture(db, {
    runId,
    sessionCookie,
    sessionSecret: TEST_SESSION_SECRET,
  });
  db.close();

  const report = cleanupProductionSmokeRun({
    databaseUrl,
    runId,
    account: "jiangjz",
    sessionCookie,
    authSessionSecret: TEST_SESSION_SECRET,
    createdIds: {
      ...fixture.createdIds,
      itineraries: [],
    },
    idempotencyKeys: fixture.idempotencyKeys,
  });

  assert.equal(report.status, "clean");
  assert.equal(report.discovered.itineraries, 1);
  assert.equal(report.deleted.itineraries, 1);
  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "visit_itineraries", "id = $id", { $id: fixture.ids.itinerary }), 0);
  } finally {
    verify.close();
  }
});

test("cleanup rejects a missing exact created id manifest", () => {
  const { db, databaseUrl } = temporaryDatabase();
  db.close();

  assert.throws(
    () => cleanupProductionSmokeRun({
      databaseUrl,
      runId: randomUUID(),
      account: "jiangjz",
      sessionCookie: "e".repeat(43),
      authSessionSecret: TEST_SESSION_SECRET,
      idempotencyKeys: [],
    }),
    /created id manifest/i,
  );
});

test("cleanup rejects a manifest id that does not exist and preserves the transaction", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "m".repeat(43);
  const fixture = insertFixture(db, {
    runId,
    sessionCookie,
    sessionSecret: TEST_SESSION_SECRET,
  });
  const missingItineraryId = randomUUID();
  db.close();

  assert.throws(
    () => cleanupProductionSmokeRun({
      databaseUrl,
      runId,
      account: "jiangjz",
      sessionCookie,
      authSessionSecret: TEST_SESSION_SECRET,
      createdIds: {
        ...fixture.createdIds,
        itineraries: [missingItineraryId],
      },
      idempotencyKeys: fixture.idempotencyKeys,
    }),
    /manifest|missing|discovered|expected/i,
  );

  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "customers", "id = $id", { $id: fixture.ids.customer }), 1);
    assert.equal(count(verify, "visit_itineraries", "id = $id", { $id: fixture.ids.itinerary }), 1);
    assert.equal(count(verify, "auth_sessions", "id = $id", { $id: fixture.ids.session }), 1);
  } finally {
    verify.close();
  }
});

test("cleanup rejects a complete manifest when pointed at a different database", () => {
  const source = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "n".repeat(43);
  const fixture = insertFixture(source.db, {
    runId,
    sessionCookie,
    sessionSecret: TEST_SESSION_SECRET,
  });
  source.db.close();

  const wrongTarget = temporaryDatabase();
  wrongTarget.db.close();

  assert.throws(
    () => cleanupProductionSmokeRun({
      databaseUrl: wrongTarget.databaseUrl,
      runId,
      account: "jiangjz",
      sessionCookie,
      authSessionSecret: TEST_SESSION_SECRET,
      createdIds: fixture.createdIds,
      idempotencyKeys: fixture.idempotencyKeys,
    }),
    /database|manifest|missing|discovered|expected/i,
  );

  const verify = openDatabase({ databaseUrl: source.databaseUrl });
  try {
    assert.equal(count(verify, "customers", "id = $id", { $id: fixture.ids.customer }), 1);
    assert.equal(count(verify, "visit_itineraries", "id = $id", { $id: fixture.ids.itinerary }), 1);
  } finally {
    verify.close();
  }
});

test("cleanup rejects a server-local database whose identity differs from the public backend", () => {
  const source = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "o".repeat(43);
  const fixture = insertFixture(source.db, {
    runId,
    sessionCookie,
    sessionSecret: TEST_SESSION_SECRET,
  });
  source.db.close();
  const publicDatabaseIdentity = createDatabaseIdentity({
    databaseUrl: source.databaseUrl,
    secret: TEST_SESSION_SECRET,
  });

  const wrongTarget = temporaryDatabase();
  wrongTarget.db.close();

  assert.throws(
    () => cleanupProductionSmokeRunRaw({
      databaseUrl: wrongTarget.databaseUrl,
      runId,
      account: "jiangjz",
      sessionCookie,
      authSessionSecret: TEST_SESSION_SECRET,
      expectedDatabaseIdentity: publicDatabaseIdentity,
      createdIds: fixture.createdIds,
      idempotencyKeys: fixture.idempotencyKeys,
    }),
    /database identity.*does not match|does not match.*database identity/i,
  );

  const verify = openDatabase({ databaseUrl: source.databaseUrl });
  try {
    assert.equal(count(verify, "customers", "id = $id", { $id: fixture.ids.customer }), 1);
    assert.equal(count(verify, "auth_sessions", "id = $id", { $id: fixture.ids.session }), 1);
  } finally {
    verify.close();
  }
});

test("cleanup never deletes an audit row outside the exact created id manifest", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "f".repeat(43);
  const sessionSecret = TEST_SESSION_SECRET;
  const fixture = insertFixture(db, { runId, sessionCookie, sessionSecret });
  const unrelatedAuditId = randomUUID();
  db.prepare(`
    INSERT INTO audit_logs (
      id, action, entity_type, entity_id, actor, metadata_json,
      request_id, before_json, after_json, entity_version
    ) VALUES (
      $id, 'customer.read', 'customer', $entityId, 'real-user', $metadata,
      $requestId, '{}', '{}', 1
    )
  `).run({
    $id: unrelatedAuditId,
    $entityId: randomUUID(),
    $metadata: JSON.stringify({ copiedText: fixture.marker }),
    $requestId: randomUUID(),
  });
  db.close();

  const report = cleanupProductionSmokeRun({
    databaseUrl,
    runId,
    account: "jiangjz",
    sessionCookie,
    authSessionSecret: sessionSecret,
    createdIds: fixture.createdIds,
    idempotencyKeys: fixture.idempotencyKeys,
  });

  assert.equal(report.deleted.auditLogs, 1);
  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "audit_logs", "id = $id", { $id: unrelatedAuditId }), 1);
    assert.equal(count(verify, "audit_logs", "id = $id", { $id: fixture.ids.audit }), 0);
  } finally {
    verify.close();
  }
});

test("cleanup deletes only the exact idempotency composite keys in the manifest", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "g".repeat(43);
  const sessionSecret = TEST_SESSION_SECRET;
  const fixture = insertFixture(db, { runId, sessionCookie, sessionSecret });
  const unrelatedKey = `smoke:${runId}:unlisted-real-request`;
  db.prepare(`
    INSERT INTO idempotency_keys (
      actor, method, request_path, key, request_hash, state,
      response_status, response_json, created_at, expires_at
    ) VALUES (
      'jiangjz', 'POST', '/api/unrelated', $key, 'real-hash', 'completed',
      201, '{}', CURRENT_TIMESTAMP, '2099-01-01T00:00:00.000Z'
    )
  `).run({ $key: unrelatedKey });
  db.close();

  const report = cleanupProductionSmokeRun({
    databaseUrl,
    runId,
    account: "jiangjz",
    sessionCookie,
    authSessionSecret: sessionSecret,
    createdIds: fixture.createdIds,
    idempotencyKeys: fixture.idempotencyKeys,
  });

  assert.equal(report.deleted.idempotencyKeys, 1);
  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "idempotency_keys", "key = $key", { $key: unrelatedKey }), 1);
    assert.equal(
      count(verify, "idempotency_keys", "key = $key", { $key: fixture.idempotencyKeys[0].key }),
      0,
    );
  } finally {
    verify.close();
  }
});

test("cleanup rejects a forged real-data id and preserves the entire transaction", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "h".repeat(43);
  const sessionSecret = TEST_SESSION_SECRET;
  const fixture = insertFixture(db, { runId, sessionCookie, sessionSecret });
  const realCustomerId = randomUUID();
  db.prepare(`
    INSERT INTO customers (id, name, owner, summary)
    VALUES ($id, 'Real customer', 'real-user', 'Must never be deleted')
  `).run({ $id: realCustomerId });
  db.close();

  assert.throws(
    () => cleanupProductionSmokeRun({
      databaseUrl,
      runId,
      account: "jiangjz",
      sessionCookie,
      authSessionSecret: sessionSecret,
      createdIds: {
        ...fixture.createdIds,
        customers: [...fixture.createdIds.customers, realCustomerId],
      },
      idempotencyKeys: fixture.idempotencyKeys,
    }),
    /ownership|marker|smoke run/i,
  );

  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "customers", "id = $id", { $id: realCustomerId }), 1);
    assert.equal(count(verify, "customers", "id = $id", { $id: fixture.ids.customer }), 1);
    assert.equal(count(verify, "opportunities", "id = $id", { $id: fixture.ids.opportunity }), 1);
    assert.equal(count(verify, "auth_sessions", "id = $id", { $id: fixture.ids.session }), 1);
  } finally {
    verify.close();
  }
});

test("cleanup rolls back every deletion when a mid-transaction delete fails", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "i".repeat(43);
  const sessionSecret = TEST_SESSION_SECRET;
  const fixture = insertFixture(db, { runId, sessionCookie, sessionSecret });
  db.exec(`
    CREATE TRIGGER force_smoke_cleanup_failure
    BEFORE DELETE ON quick_records
    WHEN OLD.id = '${fixture.ids.quickRecord}'
    BEGIN
      SELECT RAISE(ABORT, 'forced cleanup rollback');
    END;
  `);
  db.close();

  assert.throws(
    () => cleanupProductionSmokeRun({
      databaseUrl,
      runId,
      account: "jiangjz",
      sessionCookie,
      authSessionSecret: sessionSecret,
      createdIds: fixture.createdIds,
      idempotencyKeys: fixture.idempotencyKeys,
    }),
    /forced cleanup rollback/i,
  );

  const verify = openDatabase({ databaseUrl });
  try {
    for (const [table, id] of [
      ["customers", fixture.ids.customer],
      ["opportunities", fixture.ids.opportunity],
      ["quick_records", fixture.ids.quickRecord],
      ["ai_insights", fixture.ids.insight],
      ["sales_decision_analyses", fixture.ids.salesDecision],
      ["visit_itineraries", fixture.ids.itinerary],
      ["weekly_reports", fixture.ids.weeklyReport],
      ["audit_logs", fixture.ids.audit],
      ["auth_sessions", fixture.ids.session],
    ]) {
      assert.equal(count(verify, table, "id = $id", { $id: id }), 1, `${table} must roll back`);
    }
    assert.equal(
      count(verify, "idempotency_keys", "key = $key", { $key: fixture.idempotencyKeys[0].key }),
      1,
    );
  } finally {
    verify.close();
  }
});

test("cleanup keeps a concurrent smoke run with a different runId intact", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const firstRunId = randomUUID();
  const secondRunId = randomUUID();
  const sessionSecret = TEST_SESSION_SECRET;
  const first = insertFixture(db, {
    runId: firstRunId,
    sessionCookie: "j".repeat(43),
    sessionSecret,
  });
  const second = insertFixture(db, {
    runId: secondRunId,
    sessionCookie: "k".repeat(43),
    sessionSecret,
  });
  db.close();

  const report = cleanupProductionSmokeRun({
    databaseUrl,
    runId: firstRunId,
    account: "jiangjz",
    sessionCookie: "j".repeat(43),
    authSessionSecret: sessionSecret,
    createdIds: first.createdIds,
    idempotencyKeys: first.idempotencyKeys,
  });
  assert.equal(report.status, "clean");

  const verify = openDatabase({ databaseUrl });
  try {
    for (const [table, id] of [
      ["customers", second.ids.customer],
      ["opportunities", second.ids.opportunity],
      ["quick_records", second.ids.quickRecord],
      ["ai_insights", second.ids.insight],
      ["sales_decision_analyses", second.ids.salesDecision],
      ["visit_itineraries", second.ids.itinerary],
      ["weekly_reports", second.ids.weeklyReport],
      ["audit_logs", second.ids.audit],
      ["auth_sessions", second.ids.session],
    ]) {
      assert.equal(count(verify, table, "id = $id", { $id: id }), 1, `${table} concurrent residue`);
    }
    assert.equal(count(verify, "customers", "id = $id", { $id: first.ids.customer }), 0);
    assert.equal(
      count(verify, "idempotency_keys", "key = $key", { $key: second.idempotencyKeys[0].key }),
      1,
    );
  } finally {
    verify.close();
  }
});

test("cleanup rejects an audit id whose entity type is outside the smoke manifest", () => {
  const { db, databaseUrl } = temporaryDatabase();
  const runId = randomUUID();
  const sessionCookie = "l".repeat(43);
  const sessionSecret = TEST_SESSION_SECRET;
  const fixture = insertFixture(db, { runId, sessionCookie, sessionSecret });
  const forgedAuditId = randomUUID();
  db.prepare(`
    INSERT INTO audit_logs (
      id, action, entity_type, entity_id, actor, metadata_json,
      request_id, before_json, after_json, entity_version
    ) VALUES (
      $id, 'knowledge.read', 'knowledge', $entityId, 'jiangjz', '{}',
      $requestId, '{}', '{}', 1
    )
  `).run({
    $id: forgedAuditId,
    $entityId: fixture.ids.customer,
    $requestId: randomUUID(),
  });
  db.close();

  assert.throws(
    () => cleanupProductionSmokeRun({
      databaseUrl,
      runId,
      account: "jiangjz",
      sessionCookie,
      authSessionSecret: sessionSecret,
      createdIds: {
        ...fixture.createdIds,
        auditLogs: [...fixture.createdIds.auditLogs, forgedAuditId],
      },
      idempotencyKeys: fixture.idempotencyKeys,
    }),
    /audit log ownership|entity type|smoke run/i,
  );

  const verify = openDatabase({ databaseUrl });
  try {
    assert.equal(count(verify, "audit_logs", "id = $id", { $id: forgedAuditId }), 1);
    assert.equal(count(verify, "customers", "id = $id", { $id: fixture.ids.customer }), 1);
  } finally {
    verify.close();
  }
});
