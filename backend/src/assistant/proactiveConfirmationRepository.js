import { randomUUID } from "node:crypto";

const PREVIEW_TTL_MS = 30 * 60 * 1000;

function parseJson(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value) {
  const date = validDate(value);
  return date ? date.toISOString() : null;
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
  return value;
}

function rowToItem(row, { replayed = false } = {}) {
  if (!row) return null;
  return {
    schemaVersion: "proactive-confirmation-preview-v1",
    id: row.id,
    owner: row.owner,
    suggestionId: row.suggestion_id,
    target: row.target,
    revision: Number(row.revision),
    status: row.status,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    opportunityVersion: Number(row.opportunity_version),
    customerVersion: Number(row.customer_version),
    previewDigest: row.preview_digest,
    preview: parseJson(row.preview_json, {}),
    snapshot: parseJson(row.snapshot_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at ?? null,
    confirmedBy: row.confirmed_by ?? null,
    resultItemId: row.result_item_id ?? null,
    replayed,
  };
}

function expiryDate(now) {
  const current = validDate(now ?? new Date());
  if (!current) throw new TypeError("now must be a valid date");
  return current;
}

export function createProactiveConfirmationPreviewRepository(db, {
  clock = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db must be a synchronous SQLite connection");

  function expire(now = clock()) {
    const current = expiryDate(now);
    const nowIso = current.toISOString();
    db.prepare(`
      UPDATE proactive_confirmation_previews
         SET status = 'expired', updated_at = $now
       WHERE status = 'open' AND expires_at <= $now
    `).run({ $now: nowIso });
    return nowIso;
  }

  function get(id, owner, { now = clock() } = {}) {
    const normalizedId = requiredText(id, "id");
    const normalizedOwner = requiredText(owner, "owner");
    expire(now);
    const row = db.prepare(`
      SELECT * FROM proactive_confirmation_previews
       WHERE id = $id AND owner = $owner
    `).get({ $id: normalizedId, $owner: normalizedOwner });
    return rowToItem(row);
  }

  function listForSuggestion(suggestionId, owner, { now = clock() } = {}) {
    const normalizedSuggestionId = requiredText(suggestionId, "suggestionId");
    const normalizedOwner = requiredText(owner, "owner");
    expire(now);
    return db.prepare(`
      SELECT * FROM proactive_confirmation_previews
       WHERE suggestion_id = $suggestionId AND owner = $owner
       ORDER BY target ASC, revision DESC
    `).all({ $suggestionId: normalizedSuggestionId, $owner: normalizedOwner }).map((row) => rowToItem(row));
  }

  function listOpenBySuggestionIds(suggestionIds, owner, { now = clock() } = {}) {
    const normalizedOwner = requiredText(owner, "owner");
    const ids = [...new Set((suggestionIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    expire(now);
    const placeholders = ids.map((_, index) => `$id${index}`).join(", ");
    const params = Object.fromEntries(ids.map((id, index) => [`$id${index}`, id]));
    params.$owner = normalizedOwner;
    return db.prepare(`
      SELECT * FROM proactive_confirmation_previews
       WHERE owner = $owner
         AND suggestion_id IN (${placeholders})
         AND status = 'open'
       ORDER BY suggestion_id, target, revision DESC
    `).all(params).map((row) => rowToItem(row));
  }

  function create({
    owner,
    suggestionId,
    target,
    customerId,
    opportunityId,
    opportunityVersion,
    customerVersion,
    previewDigest,
    preview,
    snapshot,
    now = clock(),
  }) {
    const normalizedOwner = requiredText(owner, "owner");
    const normalizedSuggestionId = requiredText(suggestionId, "suggestionId");
    const normalizedTarget = requiredText(target, "target");
    if (!new Set(["action", "risk"]).has(normalizedTarget)) throw new TypeError("target must be action or risk");
    const normalizedCustomerId = requiredText(customerId, "customerId");
    const normalizedOpportunityId = requiredText(opportunityId, "opportunityId");
    const normalizedOpportunityVersion = positiveInteger(opportunityVersion, "opportunityVersion");
    const normalizedCustomerVersion = positiveInteger(customerVersion, "customerVersion");
    const normalizedDigest = requiredText(previewDigest, "previewDigest");
    if (!/^[0-9a-f]{64}$/u.test(normalizedDigest)) throw new TypeError("previewDigest must be a SHA-256 digest");
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) throw new TypeError("preview must be an object");
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("snapshot must be an object");
    const current = expiryDate(now);
    const nowIso = current.toISOString();
    expire(current);

    const existing = db.prepare(`
      SELECT * FROM proactive_confirmation_previews
       WHERE owner = $owner
         AND suggestion_id = $suggestionId
         AND target = $target
         AND preview_digest = $previewDigest
       ORDER BY revision DESC
       LIMIT 1
    `).get({
      $owner: normalizedOwner,
      $suggestionId: normalizedSuggestionId,
      $target: normalizedTarget,
      $previewDigest: normalizedDigest,
    });
    // A preview can only be replayed while it is still open.  Completed
    // previews represent a finished human-confirmation transaction; a later
    // request with the same digest must receive a fresh revision rather than
    // being treated as a replay.  The HTTP idempotency table remains the
    // source of truth for replaying the exact same request key.
    if (existing?.status === "open") {
      return rowToItem(existing, { replayed: true });
    }

    const revision = Number(db.prepare(`
      SELECT COALESCE(MAX(revision), 0) AS revision
        FROM proactive_confirmation_previews
       WHERE owner = $owner AND suggestion_id = $suggestionId AND target = $target
    `).get({
      $owner: normalizedOwner,
      $suggestionId: normalizedSuggestionId,
      $target: normalizedTarget,
    }).revision) + 1;
    const id = requiredText(idFactory(), "id");
    const expiresAt = new Date(current.getTime() + PREVIEW_TTL_MS).toISOString();
    db.prepare(`
      INSERT INTO proactive_confirmation_previews (
        id, owner, suggestion_id, target, revision, status,
        customer_id, opportunity_id, opportunity_version, customer_version,
        preview_digest, preview_json, snapshot_json,
        created_at, updated_at, expires_at
      ) VALUES (
        $id, $owner, $suggestionId, $target, $revision, 'open',
        $customerId, $opportunityId, $opportunityVersion, $customerVersion,
        $previewDigest, $previewJson, $snapshotJson,
        $now, $now, $expiresAt
      )
    `).run({
      $id: id,
      $owner: normalizedOwner,
      $suggestionId: normalizedSuggestionId,
      $target: normalizedTarget,
      $revision: revision,
      $customerId: normalizedCustomerId,
      $opportunityId: normalizedOpportunityId,
      $opportunityVersion: normalizedOpportunityVersion,
      $customerVersion: normalizedCustomerVersion,
      $previewDigest: normalizedDigest,
      $previewJson: JSON.stringify(preview),
      $snapshotJson: JSON.stringify(snapshot),
      $now: nowIso,
      $expiresAt: expiresAt,
    });
    return rowToItem(db.prepare("SELECT * FROM proactive_confirmation_previews WHERE id = $id").get({ $id: id }));
  }

  function complete(id, owner, { resultItemId, confirmedBy, now = clock() } = {}) {
    const current = expiryDate(now);
    const row = db.prepare(`
      SELECT * FROM proactive_confirmation_previews
       WHERE id = $id AND owner = $owner
    `).get({ $id: requiredText(id, "id"), $owner: requiredText(owner, "owner") });
    if (!row) return null;
    if (row.status === "open") {
      db.prepare(`
        UPDATE proactive_confirmation_previews
           SET status = 'completed', updated_at = $now, confirmed_at = $now,
               confirmed_by = $confirmedBy, result_item_id = $resultItemId
         WHERE id = $id AND owner = $owner AND status = 'open'
      `).run({
        $id: row.id,
        $owner: row.owner,
        $now: current.toISOString(),
        $confirmedBy: confirmedBy ?? owner,
        $resultItemId: resultItemId ?? null,
      });
    }
    return rowToItem(db.prepare("SELECT * FROM proactive_confirmation_previews WHERE id = $id").get({ $id: row.id }));
  }

  function cancel(id, owner, { now = clock() } = {}) {
    const current = expiryDate(now);
    const result = db.prepare(`
      UPDATE proactive_confirmation_previews
         SET status = 'cancelled', updated_at = $now
       WHERE id = $id AND owner = $owner AND status = 'open'
    `).run({
      $id: requiredText(id, "id"),
      $owner: requiredText(owner, "owner"),
      $now: current.toISOString(),
    });
    if (result.changes !== 1) return get(id, owner, { now: current });
    return get(id, owner, { now: current });
  }

  function cancelOpenForSuggestion(suggestionId, owner, { now = clock() } = {}) {
    const current = expiryDate(now);
    const result = db.prepare(`
      UPDATE proactive_confirmation_previews
         SET status = 'cancelled', updated_at = $now
       WHERE suggestion_id = $suggestionId
         AND owner = $owner
         AND status = 'open'
    `).run({
      $suggestionId: requiredText(suggestionId, "suggestionId"),
      $owner: requiredText(owner, "owner"),
      $now: current.toISOString(),
    });
    return Number(result.changes);
  }

  return {
    create,
    get,
    listForSuggestion,
    listOpenBySuggestionIds,
    complete,
    cancel,
    cancelOpenForSuggestion,
    expire,
  };
}

export { PREVIEW_TTL_MS };
