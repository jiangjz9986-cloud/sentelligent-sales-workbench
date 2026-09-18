import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { cleanupV0120ProductionAcceptance } from "../scripts/v0120-production-acceptance-cleanup.mjs";
import { openDatabase } from "../src/db.js";
import { createDatabaseIdentity } from "../src/db/databaseIdentity.js";

const OWNER = "v0120-cleanup-owner";
const MACHINE = "hospital-tender-monitor";
const TEST_SESSION_VALUE = "fixture-session-secret-placeholder-value";
const temporaryDirectories = [];

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sessionHash(cookie) {
  return createHmac("sha256", TEST_SESSION_VALUE).update(`session-store:v1:${cookie}`).digest("base64url");
}

function databaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), "sentelligent-v0120-cleanup-"));
  temporaryDirectories.push(directory);
  const databaseUrl = join(directory, "acceptance.sqlite");
  const db = openDatabase({ databaseUrl });
  const runId = randomUUID();
  const marker = `[v0.12:${runId}]`;
  const ids = {
    customer: `customer-${runId}`,
    opportunity: `opportunity-${runId}`,
    action: `action-${runId}`,
    risk: `risk-${runId}`,
    batch: `batch-${runId}`,
    row: `row-${runId}`,
    notice: `notice-${runId}`,
    canonical: `canonical-${runId}`,
    snapshot: `2026-09-13T00:00:00.000Z`,
    bridge: `bridge-${runId}`,
    suggestion: `suggestion-${runId}`,
    subject: `subject-${runId}`,
    preview: `preview-${runId}`,
    notification: `notification-${runId}`,
    outbox: `outbox-${runId}`,
    auditSeed: `audit-seed-${runId}`,
    auditSuggestion: `audit-suggestion-${runId}`,
    auditPreview: `audit-preview-${runId}`,
    auditWriteback: `audit-writeback-${runId}`,
    auditSnapshot: `audit-snapshot-${runId}`,
    session: `session-${runId}`,
  };
  const now = "2026-09-13T00:00:00.000Z";
  db.prepare(`
    INSERT INTO customers (id, name, owner, summary, created_at, updated_at)
    VALUES ($id, $name, $owner, $summary, $now, $now)
  `).run({ $id: ids.customer, $name: `${marker} 客户`, $owner: OWNER, $summary: marker, $now: now });
  db.prepare(`
    INSERT INTO opportunities (id, customer_id, name, owner, source_record, next, created_at, updated_at)
    VALUES ($id, $customerId, $name, $owner, $sourceRecord, $next, $now, $now)
  `).run({
    $id: ids.opportunity,
    $customerId: ids.customer,
    $name: `${marker} 商机`,
    $owner: OWNER,
    $sourceRecord: marker,
    $next: marker,
    $now: now,
  });
  db.prepare(`
    INSERT INTO action_items (id, customer_id, opportunity_id, title, reason, expected_result, source_proactive_id, owner, created_at, updated_at)
    VALUES ($id, $customerId, $opportunityId, $title, $reason, $expectedResult, $sourceProactiveId, $owner, $now, $now)
  `).run({
    $id: ids.action,
    $customerId: ids.customer,
    $opportunityId: ids.opportunity,
    $title: `${marker} action`,
    $reason: marker,
    $expectedResult: marker,
    $sourceProactiveId: ids.suggestion,
    $owner: OWNER,
    $now: now,
  });
  db.prepare(`
    INSERT INTO risk_items (id, customer_id, opportunity_id, title, target, evidence, action, expected_result, source_proactive_id, owner, created_at, updated_at)
    VALUES ($id, $customerId, $opportunityId, $title, $target, $evidence, $action, $expectedResult, $sourceProactiveId, $owner, $now, $now)
  `).run({
    $id: ids.risk,
    $customerId: ids.customer,
    $opportunityId: ids.opportunity,
    $title: `${marker} risk`,
    $target: marker,
    $evidence: marker,
    $action: marker,
    $expectedResult: marker,
    $sourceProactiveId: ids.suggestion,
    $owner: OWNER,
    $now: now,
  });
  db.prepare(`
    INSERT INTO customer_import_batches (id, owner, idempotency_key, file_name, media_type, file_size_bytes, file_sha256, created_at, updated_at)
    VALUES ($id, $owner, $key, $fileName, 'text/csv', 1, $fileSha256, $now, $now)
  `).run({
    $id: ids.batch,
    $owner: OWNER,
    $key: `v0120:${runId}:import`,
    $fileName: `${marker}.csv`,
    $fileSha256: sha256(marker),
    $now: now,
  });
  db.prepare(`
    INSERT INTO customer_import_rows (id, batch_id, owner, row_number, canonical_name, customer_id, normalized_json, row_digest, created_at, updated_at)
    VALUES ($id, $batchId, $owner, 1, $canonicalName, $customerId, '{}', $rowDigest, $now, $now)
  `).run({
    $id: ids.row,
    $batchId: ids.batch,
    $owner: OWNER,
    $canonicalName: `${marker} 客户`,
    $customerId: ids.customer,
    $rowDigest: sha256(`${marker}:row`),
    $now: now,
  });
  db.prepare(`
    INSERT INTO hospital_tender_notices (
      id, identity_key, source_id, source_name, title, url, published_at, notice_type,
      content_text, hospital_names_json, content_sha256, relevance, match_customer_ids_json,
      canonical_notice_id, canonical_revision, canonical_digest, first_seen_at, last_seen_at
    ) VALUES ($id, $identityKey, 'source', 'source', $title, 'https://example.invalid/tender', $now,
      'bid_result', $contentText, $hospitalNames, $contentSha256, 'high', $matchedCustomerIds,
      $canonicalId, 1, $canonicalDigest, $now, $now)
  `).run({
    $id: ids.notice,
    $identityKey: `${marker}:notice`,
    $title: `${marker} tender`,
    $contentText: marker,
    $hospitalNames: JSON.stringify([`${marker} 客户`]),
    $contentSha256: sha256(marker),
    $matchedCustomerIds: JSON.stringify([ids.customer]),
    $canonicalId: ids.canonical,
    $canonicalDigest: sha256(`${marker}:canonical`),
    $now: now,
  });
  db.prepare(`
    INSERT INTO hospital_tender_bridges (id, owner, canonical_notice_id, customer_id, status, notice_digest, preview_digest, created_at, updated_at)
    VALUES ($id, $owner, $canonicalId, $customerId, 'confirmed', $noticeDigest, $previewDigest, $now, $now)
  `).run({
    $id: ids.bridge,
    $owner: OWNER,
    $canonicalId: ids.canonical,
    $customerId: ids.customer,
    $noticeDigest: sha256(`${marker}:notice`),
    $previewDigest: sha256(`${marker}:preview`),
    $now: now,
  });
  const sourceRefs = JSON.stringify([{ type: "customer", id: ids.customer, label: marker }, { type: "opportunity", id: ids.opportunity, label: marker }]);
  db.prepare(`
    INSERT INTO proactive_subjects (id, owner, subject_type, subject_id, subject_key, customer_id, source_digest, source_refs_json, created_at, updated_at)
    VALUES ($id, $owner, 'customer', $customerId, $subjectKey, $customerId, $sourceDigest, $sourceRefs, $now, $now)
  `).run({
    $id: ids.subject,
    $owner: OWNER,
    $customerId: ids.customer,
    $subjectKey: `customer:${OWNER}:${ids.customer}`,
    $sourceDigest: sha256(`${marker}:subject`),
    $sourceRefs: sourceRefs,
    $now: now,
  });
  const suggestionContent = JSON.stringify({ marker, trigger: { type: "risk_open" }, customerId: ids.customer, opportunityId: ids.opportunity });
  db.prepare(`
    INSERT INTO ai_suggestions (
      id, owner, type, title, status, content, draft_content, source_refs, source_id,
      proactive_trigger, proactive_subject_type, proactive_subject_id, proactive_subject_key,
      proactive_subject_version, proactive_source_digest, proactive_source_refs,
      proactive_customer_id, proactive_opportunity_id, proactive_dedupe_key,
      proactive_status, proactive_generated_at, proactive_last_seen_at, proactive_payload_hash,
      created_at, updated_at
    ) VALUES ($id, $owner, 'opportunity_push', $title, 'pending', $content, $content, $sourceRefs,
      $customerId, 'risk_open', 'customer', $customerId, $subjectKey, 1, $sourceDigest, $sourceRefs,
      $customerId, $opportunityId, $dedupeKey, 'pending', $now, $now, $payloadHash, $now, $now)
  `).run({
    $id: ids.suggestion,
    $owner: OWNER,
    $title: `${marker} suggestion`,
    $content: suggestionContent,
    $sourceRefs: sourceRefs,
    $customerId: ids.customer,
    $opportunityId: ids.opportunity,
    $subjectKey: `customer:${OWNER}:${ids.customer}`,
    $sourceDigest: sha256(`${marker}:subject`),
    $dedupeKey: `v0120:${runId}:suggestion`,
    $payloadHash: sha256(suggestionContent),
    $now: now,
  });
  const previewJson = JSON.stringify({ customerId: ids.customer, opportunityId: ids.opportunity, previewDigest: sha256(`${marker}:preview`) });
  db.prepare(`
    INSERT INTO proactive_confirmation_previews (
      id, owner, suggestion_id, target, revision, status, customer_id, opportunity_id,
      opportunity_version, customer_version, preview_digest, preview_json, snapshot_json,
      created_at, updated_at, expires_at
    ) VALUES ($id, $owner, $suggestionId, 'risk', 1, 'completed', $customerId, $opportunityId,
      1, 1, $previewDigest, $previewJson, $previewJson, $now, $now, '2099-01-01T00:00:00.000Z')
  `).run({
    $id: ids.preview,
    $owner: OWNER,
    $suggestionId: ids.suggestion,
    $customerId: ids.customer,
    $opportunityId: ids.opportunity,
    $previewDigest: sha256(`${marker}:preview`),
    $previewJson: previewJson,
    $now: now,
  });
  const payload = JSON.stringify({ kind: "proactive_suggestion", suggestionId: ids.suggestion, title: `${marker} suggestion`, trigger: "risk_open", status: "pending", priority: 80, summary: marker });
  db.prepare(`
    INSERT INTO weixin_confirmation_outbox (
      id, owner, conversation_id, idempotency_key_hash, payload_json, payload_hash, status,
      attempt_count, available_at, created_at, updated_at
    ) VALUES ($id, $owner, 'v0120-conversation', $keyHash, $payload, $payloadHash, 'queued', 0, $now, $now, $now)
  `).run({
    $id: ids.outbox,
    $owner: OWNER,
    $keyHash: sha256(`${marker}:outbox-key`),
    $payload: payload,
    $payloadHash: sha256(payload),
    $now: now,
  });
  db.prepare(`
    INSERT INTO proactive_notifications (
      id, owner, suggestion_id, suggestion_version, channel, status, title, trigger, priority,
      summary, outbox_id, attempt_count, available_at, created_at, updated_at
    ) VALUES ($id, $owner, $suggestionId, 1, 'weixin', 'queued', $title, 'risk_open', 80,
      $summary, $outboxId, 0, $now, $now, $now)
  `).run({
    $id: ids.notification,
    $owner: OWNER,
    $suggestionId: ids.suggestion,
    $title: `${marker} notification`,
    $summary: marker,
    $outboxId: ids.outbox,
    $now: now,
  });

  const auditRows = [
    [ids.auditSeed, "v0120.production_acceptance.seed", "risk", ids.risk, OWNER],
    [ids.auditSuggestion, "proactive_assistant.preview.create", "proactive_assistant_suggestion", ids.suggestion, OWNER],
    [ids.auditPreview, "proactive_assistant.preview.create", "proactive_confirmation_preview", ids.preview, OWNER],
    [ids.auditWriteback, "proactive_assistant.confirm", "proactive_assistant_writeback", ids.suggestion, OWNER],
    [ids.auditSnapshot, "hospital_tender.sync", "hospital_tender_snapshot", ids.snapshot, MACHINE],
  ];
  for (const [id, action, entityType, entityId, actor] of auditRows) {
    db.prepare(`
      INSERT INTO audit_logs (id, action, entity_type, entity_id, actor, metadata_json, before_json, after_json, request_id, entity_version, created_at)
      VALUES ($id, $action, $entityType, $entityId, $actor, $metadata, '{}', $after, $requestId, 1, $now)
    `).run({
      $id: id,
      $action: action,
      $entityType: entityType,
      $entityId: entityId,
      $actor: actor,
      $metadata: JSON.stringify({ marker }),
      $after: JSON.stringify({ marker, id: entityId }),
      $requestId: runId,
      $now: now,
    });
  }
  const sessionCookie = "a".repeat(43);
  db.prepare(`
    INSERT INTO auth_sessions (id, token_hash, account, expires_at, created_at)
    VALUES ($id, $tokenHash, $account, '2099-01-01T00:00:00.000Z', $now)
  `).run({ $id: ids.session, $tokenHash: sessionHash(sessionCookie), $account: OWNER, $now: now });
  const idempotencyKey = `v0120:${runId}:import`;
  db.prepare(`
    INSERT INTO idempotency_keys (actor, method, request_path, key, request_hash, state, response_status, response_json, created_at, expires_at)
    VALUES ($actor, 'POST', '/api/customer-imports/preview', $key, 'hash', 'completed', 201, '{}', $now, '2099-01-01T00:00:00.000Z')
  `).run({ $actor: OWNER, $key: idempotencyKey, $now: now });
  db.close();

  const manifest = {
    schemaVersion: 1,
    runId,
    owner: OWNER,
    databaseIdentity: createDatabaseIdentity({ databaseUrl, secret: TEST_SESSION_VALUE }),
    sessionCookie,
    customerIds: [ids.customer],
    importBatchIds: [ids.batch],
    importRowIds: [ids.row],
    opportunityIds: [ids.opportunity],
    quickRecordIds: [],
    solutionDraftIds: [],
    actionIds: [ids.action],
    riskIds: [ids.risk],
    noticeIds: [ids.notice],
    canonicalNoticeIds: [ids.canonical],
    snapshotIds: [ids.snapshot],
    bridgeIds: [ids.bridge],
    suggestionIds: [ids.suggestion],
    subjectIds: [ids.subject],
    confirmationPreviewIds: [ids.preview],
    notificationIds: [ids.notification],
    outboxIds: [ids.outbox],
    auditIds: auditRows.map(([id]) => id),
    idempotencyKeys: [{ actor: OWNER, method: "POST", requestPath: "/api/customer-imports/preview", key: idempotencyKey }],
  };
  return { databaseUrl, manifest, ids };
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

test("v0.12.0 cleanup removes exact synthetic rows and leaves a healthy database", () => {
  const fixture = databaseFixture();
  const report = cleanupV0120ProductionAcceptance({ databaseUrl: fixture.databaseUrl, authSessionSecret: TEST_SESSION_VALUE, manifest: fixture.manifest });
  assert.equal(report.status, "clean");
  assert.equal(report.integrity.quickCheck, "ok");
  assert.equal(report.integrity.foreignKeyViolations, 0);
  assert.deepEqual(Object.values(report.residual), Array(Object.keys(report.residual).length).fill(0));
});

test("v0.12.0 cleanup source has no fuzzy SQL selector", () => {
  const source = readFileSync(new URL("../scripts/v0120-production-acceptance-cleanup.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:LIKE|GLOB)\b|\binstr\s*\(/iu);
});

test("v0.12.0 cleanup rejects a wrong database identity before deleting", () => {
  const fixture = databaseFixture();
  assert.throws(
    () => cleanupV0120ProductionAcceptance({
      databaseUrl: fixture.databaseUrl,
      authSessionSecret: TEST_SESSION_VALUE,
      manifest: { ...fixture.manifest, databaseIdentity: "b".repeat(43) },
    }),
    /database identity/i,
  );
  const db = openDatabase({ databaseUrl: fixture.databaseUrl });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers WHERE id = $id").get({ $id: fixture.ids.customer }).count, 1);
  } finally {
    db.close();
  }
});

test("v0.12.0 cleanup fails closed for an owner mismatch and preserves all rows", () => {
  const fixture = databaseFixture();
  const db = openDatabase({ databaseUrl: fixture.databaseUrl });
  db.prepare("UPDATE risk_items SET owner = 'foreign-owner' WHERE id = $id").run({ $id: fixture.ids.risk });
  db.close();
  assert.throws(
    () => cleanupV0120ProductionAcceptance({ databaseUrl: fixture.databaseUrl, authSessionSecret: TEST_SESSION_VALUE, manifest: fixture.manifest }),
    /risk ownership/i,
  );
  const verify = openDatabase({ databaseUrl: fixture.databaseUrl });
  try {
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM customers WHERE id = $id").get({ $id: fixture.ids.customer }).count, 1);
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM risk_items WHERE id = $id").get({ $id: fixture.ids.risk }).count, 1);
  } finally {
    verify.close();
  }
});

test("v0.12.0 cleanup does not delete a copied marker row outside the manifest", () => {
  const fixture = databaseFixture();
  const db = openDatabase({ databaseUrl: fixture.databaseUrl });
  db.prepare("INSERT INTO customers (id, name, owner, summary) VALUES ('unrelated-copy', $name, $owner, $summary)")
    .run({ $name: `${fixture.manifest.runId} copied marker`, $owner: OWNER, $summary: fixture.manifest.runId });
  db.close();
  const report = cleanupV0120ProductionAcceptance({ databaseUrl: fixture.databaseUrl, authSessionSecret: TEST_SESSION_VALUE, manifest: fixture.manifest });
  assert.equal(report.status, "clean");
  const verify = openDatabase({ databaseUrl: fixture.databaseUrl });
  try {
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM customers WHERE id = 'unrelated-copy'").get().count, 1);
  } finally {
    verify.close();
  }
});

test("v0.12.0 cleanup rolls back when an exact FK dependent is omitted", () => {
  const fixture = databaseFixture();
  const db = openDatabase({ databaseUrl: fixture.databaseUrl });
  db.prepare(`
    INSERT INTO solution_drafts (id, owner, title, customer_id, opportunity_id, content)
    VALUES ('unlisted-dependent', 'foreign-owner', 'unlisted dependent', $customerId, $opportunityId, 'must remain')
  `).run({ $customerId: fixture.ids.customer, $opportunityId: fixture.ids.opportunity });
  db.close();
  assert.throws(
    () => cleanupV0120ProductionAcceptance({ databaseUrl: fixture.databaseUrl, authSessionSecret: TEST_SESSION_VALUE, manifest: fixture.manifest }),
    /unrelated|dependent|solution_drafts/i,
  );
  const verify = openDatabase({ databaseUrl: fixture.databaseUrl });
  try {
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM customers WHERE id = $id").get({ $id: fixture.ids.customer }).count, 1);
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM solution_drafts WHERE id = 'unlisted-dependent'").get().count, 1);
  } finally {
    verify.close();
  }
});

test("v0.12.0 cleanup rolls back when an audit manifest row is missing", () => {
  const fixture = databaseFixture();
  const incomplete = { ...fixture.manifest, auditIds: fixture.manifest.auditIds.slice(1) };
  assert.throws(
    () => cleanupV0120ProductionAcceptance({ databaseUrl: fixture.databaseUrl, authSessionSecret: TEST_SESSION_VALUE, manifest: incomplete }),
    /audit log/i,
  );
  const verify = openDatabase({ databaseUrl: fixture.databaseUrl });
  try {
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM customers WHERE id = $id").get({ $id: fixture.ids.customer }).count, 1);
  } finally {
    verify.close();
  }
});
