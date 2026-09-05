import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/db.js";
import {
  PREVIEW_TTL_MS,
  createProactiveConfirmationPreviewRepository,
} from "../src/assistant/proactiveConfirmationRepository.js";

function makePreview(overrides = {}) {
  return {
    owner: "jiangjz",
    suggestionId: "proactive-missing-next-step-1",
    target: "action",
    customerId: "customer-1",
    opportunityId: "opportunity-1",
    opportunityVersion: 2,
    customerVersion: 3,
    previewDigest: "a".repeat(64),
    preview: { title: "补充下一步", reason: "没有未完成行动" },
    snapshot: {
      schemaVersion: "proactive-confirmation-preview-v1",
      suggestionId: "proactive-missing-next-step-1",
      target: "action",
      previewDigest: "a".repeat(64),
      evidenceRefs: [{ type: "opportunity", id: "opportunity-1" }],
    },
    ...overrides,
  };
}

test("proactive confirmation previews persist revisions, lifecycle, and exact snapshots", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  let now = new Date("2026-09-05T00:00:00.000Z");
  let nextId = 1;
  const repository = createProactiveConfirmationPreviewRepository(db, {
    clock: () => now,
    idFactory: () => `preview-${nextId++}`,
  });

  try {
    const created = repository.create({ ...makePreview(), now });
    assert.equal(created.id, "preview-1");
    assert.equal(created.status, "open");
    assert.equal(created.revision, 1);
    assert.equal(created.replayed, false);
    assert.equal(Date.parse(created.expiresAt) - Date.parse(created.createdAt), PREVIEW_TTL_MS);
    assert.deepEqual(created.preview, { title: "补充下一步", reason: "没有未完成行动" });
    assert.equal(created.snapshot.evidenceRefs[0].id, "opportunity-1");

    const replay = repository.create({ ...makePreview(), now: new Date(now.getTime() + 1_000) });
    assert.equal(replay.id, created.id);
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, 1);

    const listed = repository.listForSuggestion(created.suggestionId, created.owner, { now });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);

    const completed = repository.complete(created.id, created.owner, {
      resultItemId: "action-1",
      confirmedBy: created.owner,
      now: new Date(now.getTime() + 2_000),
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.resultItemId, "action-1");
    assert.equal(completed.confirmedBy, "jiangjz");
    assert.ok(completed.confirmedAt);

    now = new Date(now.getTime() + PREVIEW_TTL_MS + 1_000);
    const nextRevision = repository.create({
      ...makePreview({
        target: "risk",
        previewDigest: "b".repeat(64),
        preview: { title: "阶段证据不足", action: "补录证据" },
        snapshot: { ...makePreview().snapshot, target: "risk", previewDigest: "b".repeat(64) },
      }),
      now,
    });
    assert.equal(nextRevision.id, "preview-2");
    assert.equal(nextRevision.revision, 1);
    assert.equal(nextRevision.target, "risk");

    const cancelled = repository.cancel(nextRevision.id, nextRevision.owner, { now });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(repository.get(nextRevision.id, nextRevision.owner, { now }).status, "cancelled");
    assert.equal(repository.get(nextRevision.id, "other-owner", { now }), null);
  } finally {
    db.close();
  }
});

test("open previews expire on reads and never remain attachable", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  let now = new Date("2026-09-05T00:00:00.000Z");
  const repository = createProactiveConfirmationPreviewRepository(db, {
    clock: () => now,
    idFactory: () => "preview-expiring",
  });
  try {
    const created = repository.create({ ...makePreview({ previewDigest: "c".repeat(64), snapshot: { ...makePreview().snapshot, previewDigest: "c".repeat(64) } }), now });
    now = new Date(Date.parse(created.expiresAt) + 1);
    const expired = repository.get(created.id, created.owner, { now });
    assert.equal(expired.status, "expired");
    assert.deepEqual(repository.listOpenBySuggestionIds([created.suggestionId], created.owner, { now }), []);
  } finally {
    db.close();
  }
});
