import { createHash, randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";
import { resolveShortcutCategory } from "./shortcutBookkeeping.js";

const COMPLETED_STATUSES = new Set(["accepted", "review_required", "rejected"]);
const FUNDING_SOURCES = new Set(["personal", "company", "advance"]);
const PAYMENT_METHODS = new Set(["wechat", "alipay", "card", "cash", "other"]);
const REMOTE_COMPLETION_STATUSES = new Set([
  "pending",
  "processing",
  "review",
  "confirmed",
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requiredText(value, name, max = 5_000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function optionalText(value, name, max = 5_000) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized || null;
}

function hashValue(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Value(value, name) {
  const normalized = requiredText(value, name, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new TypeError(`${name} must be a SHA-256 hex digest`);
  }
  return normalized;
}

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
  return date.toISOString();
}

function dateOnly(value, name, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError(`${name} must use YYYY-MM-DD format`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${name} must be a real calendar date`);
  }
  return value;
}

function dateTime(value, name, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO date-time`);
  }
  return value.trim();
}

function nonNegativeCents(value, name, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer number of cents`);
  }
  return value;
}

function positiveCents(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer number of cents`);
  }
  return value;
}

function generatedId(idFactory, label) {
  return requiredText(idFactory(), label, 200);
}

function referenceCode(occurredOn, id) {
  return `EXP-${occurredOn.replaceAll("-", "")}-${hashValue(id).slice(0, 8).toUpperCase()}`;
}

function legacyCategory({ ledgerName, entryType, category, subcategory }) {
  if (entryType === "income") return "other";
  if (ledgerName === "出差报销") {
    if (category === "餐饮") {
      return subcategory === "早餐" ? "breakfast"
        : subcategory === "午餐" ? "lunch"
          : subcategory === "晚餐" ? "dinner"
            : "other";
    }
    if (category === "住宿费") return "lodging";
    if (category === "交通" || category === "汽车维修") return "transport";
    if (category === "招待/礼品") return "hospitality";
  }
  return "other";
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function itemFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    actor: row.actor,
    targetSystem: row.target_system,
    ledgerName: row.ledger_name,
    entryType: row.entry_type,
    category: row.category,
    subcategory: row.subcategory,
    note: row.note,
    sourceId: row.source_id,
    rawText: row.raw_text,
    capturedAt: row.captured_at,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    analysisProvider: row.analysis_provider,
    analysisModel: row.analysis_model,
    analysis: parseJson(row.analysis_json, null),
    warnings: parseJson(row.warnings_json, []),
    occurredOn: row.occurred_on,
    amountCents: row.amount_cents === null || row.amount_cents === undefined
      ? null
      : Number(row.amount_cents),
    merchant: row.merchant,
    purpose: row.purpose,
    expenseId: row.expense_id,
    paymentId: row.payment_id,
    expenseReferenceCode: row.expense_reference_code ?? null,
    remoteId: row.remote_id,
    remoteReference: row.remote_reference,
    remoteStatus: row.remote_status,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSource(value) {
  if (!isPlainObject(value)) return { provider: "rules", model: null };
  return {
    provider: requiredText(value.provider ?? "rules", "analysis.source.provider", 200),
    model: optionalText(value.model, "analysis.source.model", 200),
  };
}

function normalizeWarnings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 50).map(
    (item, index) => requiredText(item, `analysis.warnings[${index}]`, 500),
  ))];
}

function normalizeExpense(value, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new TypeError("analysis.expense is required");
    return null;
  }
  if (!isPlainObject(value)) throw new TypeError("analysis.expense must be an object");
  const occurredOn = value.occurredOn ?? value.occurred_on;
  const amountCents = value.amountCents ?? value.amount_cents;
  const reimbursementCents = value.reimbursementCents
    ?? value.reimbursement_cents
    ?? amountCents;
  const normalized = {
    occurredOn: dateOnly(occurredOn, "analysis.expense.occurredOn", { nullable: !required }),
    amountCents: required
      ? positiveCents(amountCents, "analysis.expense.amountCents")
      : nonNegativeCents(amountCents, "analysis.expense.amountCents", { nullable: true }),
    reimbursementCents: required
      ? nonNegativeCents(reimbursementCents, "analysis.expense.reimbursementCents")
      : nonNegativeCents(reimbursementCents, "analysis.expense.reimbursementCents", { nullable: true }),
    purpose: optionalText(value.purpose ?? value.description, "analysis.expense.purpose", 1_000),
    merchant: optionalText(value.merchant, "analysis.expense.merchant", 500),
    paidAt: dateTime(value.paidAt ?? value.paid_at, "analysis.expense.paidAt", { nullable: true }),
    fundingSource: value.fundingSource ?? value.funding_source ?? "personal",
    paymentMethod: value.paymentMethod ?? value.payment_method ?? "other",
  };
  if (!FUNDING_SOURCES.has(normalized.fundingSource)) normalized.fundingSource = "personal";
  if (!PAYMENT_METHODS.has(normalized.paymentMethod)) normalized.paymentMethod = "other";
  if (
    normalized.amountCents !== null
    && normalized.reimbursementCents !== null
    && normalized.reimbursementCents > normalized.amountCents
  ) {
    throw new TypeError("analysis.expense.reimbursementCents cannot exceed amountCents");
  }
  return normalized;
}

function normalizeAnalysis(value, row) {
  if (!isPlainObject(value)) throw new TypeError("analysis must be an object");
  const status = value.status === "ready" || value.status === "review_required"
    ? value.status
    : "review_required";
  const confidence = Number(value.confidence);
  const expense = normalizeExpense(value.expense, { required: status === "ready" });
  if (status === "ready" && !expense.purpose) {
    expense.purpose = `${row.category}${row.subcategory ? `-${row.subcategory}` : ""}`;
  }
  return {
    status,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    expense,
    warnings: normalizeWarnings(value.warnings),
    source: normalizeSource(value.source),
  };
}

export function applyShortcutSelectionAnalysis(value, selection) {
  const analysis = isPlainObject(value) ? { ...value } : {};
  const warnings = Array.isArray(analysis.warnings) ? [...analysis.warnings] : [];
  const expense = isPlainObject(analysis.expense) ? { ...analysis.expense } : {};
  expense.category = legacyCategory(selection);
  if (!expense.purpose || !String(expense.purpose).trim()) {
    expense.purpose = `${selection.category}${selection.subcategory ? `-${selection.subcategory}` : ""}`;
    const index = warnings.indexOf("missing_purpose");
    if (index >= 0) warnings.splice(index, 1);
  }
  const categoryWarning = warnings.indexOf("missing_category");
  if (categoryWarning >= 0) warnings.splice(categoryWarning, 1);
  const hasCoreFields = isPlainObject(analysis.expense)
    && (expense.occurredOn ?? expense.occurred_on)
    && (expense.amountCents ?? expense.amount_cents) !== null
    && (expense.amountCents ?? expense.amount_cents) !== undefined;
  return {
    ...analysis,
    status: hasCoreFields && warnings.length === 0 ? "ready" : "review_required",
    expense,
    warnings: [...new Set(warnings)],
  };
}

export function createShortcutBookkeepingRepository(db, {
  idFactory = randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const selectById = db.prepare(`
    SELECT entry.*, expense.reference_code AS expense_reference_code
    FROM shortcut_bookkeeping_entries entry
    LEFT JOIN travel_expenses expense ON expense.id = entry.expense_id
    WHERE entry.id = $id
  `);
  const selectByKey = db.prepare(`
    SELECT entry.*, expense.reference_code AS expense_reference_code
    FROM shortcut_bookkeeping_entries entry
    LEFT JOIN travel_expenses expense ON expense.id = entry.expense_id
    WHERE entry.owner = $owner AND entry.idempotency_key_hash = $idempotencyKeyHash
  `);

  function receive(input = {}) {
    const owner = requiredText(input.owner, "owner", 200);
    const actor = requiredText(input.actor, "actor", 200);
    const ledgerName = requiredText(input.ledgerName, "ledgerName", 50);
    const entryType = requiredText(input.entryType, "entryType", 20);
    const category = requiredText(input.category, "category", 100);
    const subcategory = optionalText(input.subcategory, "subcategory", 100);
    const resolved = resolveShortcutCategory({ ledgerName, entryType, category, subcategory });
    const idempotencyKeyHash = hashValue(requiredText(input.idempotencyKey, "idempotencyKey", 200));
    const normalizedRequestHash = sha256Value(input.requestHash, "requestHash");
    const rawText = requiredText(input.rawText, "rawText", 12_000);
    const note = optionalText(input.note, "note", 1_000);
    const sourceId = optionalText(input.sourceId, "sourceId", 200);
    const capturedAt = dateTime(input.capturedAt, "capturedAt", { nullable: true });
    const now = nowIso(clock);

    return withImmediateTransaction(db, () => {
      const existing = selectByKey.get({ $owner: owner, $idempotencyKeyHash: idempotencyKeyHash });
      if (existing) {
        if (existing.request_hash !== normalizedRequestHash) {
          throw new HttpError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key was already used for a different request",
          );
        }
        return { item: itemFromRow(existing), replayed: true };
      }
      const id = generatedId(idFactory, "generated shortcut bookkeeping id");
      db.prepare(`
        INSERT INTO shortcut_bookkeeping_entries (
          id, owner, actor, target_system, ledger_name, entry_type, category, subcategory,
          note, idempotency_key_hash, request_hash, source_id, raw_text, captured_at,
          status, created_at, updated_at
        ) VALUES (
          $id, $owner, $actor, $targetSystem, $ledgerName, $entryType, $category, $subcategory,
          $note, $idempotencyKeyHash, $requestHash, $sourceId, $rawText, $capturedAt,
          'received', $now, $now
        )
      `).run({
        $id: id,
        $owner: owner,
        $actor: actor,
        $targetSystem: resolved.targetSystem,
        $ledgerName: ledgerName,
        $entryType: entryType,
        $category: category,
        $subcategory: resolved.subcategory,
        $note: note,
        $idempotencyKeyHash: idempotencyKeyHash,
        $requestHash: normalizedRequestHash,
        $sourceId: sourceId,
        $rawText: rawText,
        $capturedAt: capturedAt,
        $now: now,
      });
      insertAudit(db, {
        action: "shortcut_bookkeeping.receive",
        entityType: "shortcut_bookkeeping_entry",
        entityId: id,
        actor,
        requestId: sourceId,
        before: null,
        after: {
          status: "received",
          ledgerName,
          entryType,
          category,
          subcategory: resolved.subcategory,
        },
        metadata: { owner, targetSystem: resolved.targetSystem },
      });
      return { item: itemFromRow(selectById.get({ $id: id })), replayed: false };
    });
  }

  function claim(idValue, { leaseMs = 5 * 60_000 } = {}) {
    const id = requiredText(idValue, "id", 200);
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new TypeError("leaseMs must be positive");
    }
    const now = nowIso(clock);
    return withImmediateTransaction(db, () => {
      const current = selectById.get({ $id: id });
      if (!current) {
        throw new HttpError(404, "SHORTCUT_BOOKKEEPING_NOT_FOUND", "Shortcut bookkeeping entry was not found");
      }
      if (COMPLETED_STATUSES.has(current.status)) {
        return { item: itemFromRow(current), replayed: true };
      }
      if (current.status === "processing") {
        const started = Date.parse(current.lease_started_at);
        if (Number.isFinite(started) && Date.parse(now) - started < leaseMs) {
          throw new HttpError(409, "REQUEST_IN_PROGRESS", "The same bookkeeping entry is already being processed");
        }
      } else if (current.status !== "received") {
        throw new HttpError(
          409,
          "SHORTCUT_BOOKKEEPING_STATE_CONFLICT",
          "Bookkeeping entry cannot be claimed from its current state",
        );
      }
      db.prepare(`
        UPDATE shortcut_bookkeeping_entries
        SET status = 'processing', lease_started_at = $now, updated_at = $now
        WHERE id = $id
      `).run({ $id: id, $now: now });
      return {
        item: itemFromRow(selectById.get({ $id: id })),
        leaseToken: now,
        replayed: false,
      };
    });
  }

  function listReview({ owner, status = "review_required", limit = 100 } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new TypeError("limit must be between 1 and 200");
    }
    const allowedStatuses = new Set(["review_required", "accepted", "rejected"]);
    if (!allowedStatuses.has(status)) throw new TypeError("status is invalid");
    const rows = db.prepare(`
      SELECT entry.*, expense.reference_code AS expense_reference_code
      FROM shortcut_bookkeeping_entries entry
      LEFT JOIN travel_expenses expense ON expense.id = entry.expense_id
      WHERE entry.owner = $owner AND entry.target_system = 'sentelligent' AND entry.status = $status
      ORDER BY entry.updated_at DESC, entry.id DESC
      LIMIT $limit
    `).all({ $owner: normalizedOwner, $status: status, $limit: limit });
    return rows.map(itemFromRow);
  }

  function getReview(idValue, { owner } = {}) {
    const id = requiredText(idValue, "id", 200);
    const normalizedOwner = requiredText(owner, "owner", 200);
    const row = db.prepare(`
      SELECT entry.*, expense.reference_code AS expense_reference_code
      FROM shortcut_bookkeeping_entries entry
      LEFT JOIN travel_expenses expense ON expense.id = entry.expense_id
      WHERE entry.id = $id AND entry.owner = $owner AND entry.target_system = 'sentelligent'
    `).get({ $id: id, $owner: normalizedOwner });
    return itemFromRow(row);
  }

  function claimReview(idValue, { owner, leaseMs = 5 * 60_000 } = {}) {
    const id = requiredText(idValue, "id", 200);
    const normalizedOwner = requiredText(owner, "owner", 200);
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError("leaseMs must be positive");
    const now = nowIso(clock);
    return withImmediateTransaction(db, () => {
      const current = selectById.get({ $id: id });
      if (!current || current.owner !== normalizedOwner || current.target_system !== "sentelligent") {
        throw new HttpError(404, "SHORTCUT_BOOKKEEPING_REVIEW_NOT_FOUND", "Shortcut review item was not found");
      }
      if (current.status === "accepted" || current.status === "rejected") {
        return { item: itemFromRow(current), replayed: true };
      }
      if (current.status !== "review_required") {
        throw new HttpError(409, "SHORTCUT_BOOKKEEPING_REVIEW_STATE_CONFLICT", "Shortcut review item is not awaiting review");
      }
      db.prepare(`
        UPDATE shortcut_bookkeeping_entries
        SET status = 'processing', lease_started_at = $now, updated_at = $now
        WHERE id = $id AND owner = $owner AND status = 'review_required'
      `).run({ $id: id, $owner: normalizedOwner, $now: now });
      return {
        item: itemFromRow(selectById.get({ $id: id })),
        leaseToken: now,
        replayed: false,
      };
    });
  }

  function rejectReview(idValue, { owner, actor, reason } = {}) {
    const id = requiredText(idValue, "id", 200);
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedActor = requiredText(actor ?? owner, "actor", 200);
    const normalizedReason = requiredText(reason, "reason", 1_000);
    return withImmediateTransaction(db, () => {
      const current = selectById.get({ $id: id });
      if (!current || current.owner !== normalizedOwner || current.target_system !== "sentelligent") {
        throw new HttpError(404, "SHORTCUT_BOOKKEEPING_REVIEW_NOT_FOUND", "Shortcut review item was not found");
      }
      if (current.status === "rejected") return { item: itemFromRow(current), replayed: true };
      if (current.status !== "review_required") {
        throw new HttpError(409, "SHORTCUT_BOOKKEEPING_REVIEW_STATE_CONFLICT", "Shortcut review item is not awaiting review");
      }
      const now = nowIso(clock);
      db.prepare(`
        UPDATE shortcut_bookkeeping_entries
        SET status = 'rejected', lease_started_at = NULL, error_code = 'MANUAL_REJECTED',
            updated_at = $now, warnings_json = json_insert(warnings_json, '$[#]', $reason)
        WHERE id = $id AND owner = $owner AND status = 'review_required'
      `).run({ $id: id, $owner: normalizedOwner, $now: now, $reason: normalizedReason });
      insertAudit(db, {
        action: "shortcut_bookkeeping.manual_reject",
        entityType: "shortcut_bookkeeping_entry",
        entityId: id,
        actor: normalizedActor,
        requestId: current.source_id,
        before: { status: current.status },
        after: { status: "rejected", reason: normalizedReason },
        metadata: { owner: normalizedOwner, ledgerName: current.ledger_name },
      });
      return { item: itemFromRow(selectById.get({ $id: id })), replayed: false };
    });
  }

  function retryReview(idValue, { owner, actor } = {}) {
    const id = requiredText(idValue, "id", 200);
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedActor = requiredText(actor ?? owner, "actor", 200);
    return withImmediateTransaction(db, () => {
      const current = selectById.get({ $id: id });
      if (!current || current.owner !== normalizedOwner || current.target_system !== "sentelligent") {
        throw new HttpError(404, "SHORTCUT_BOOKKEEPING_REVIEW_NOT_FOUND", "Shortcut review item was not found");
      }
      if (current.status === "accepted") return { item: itemFromRow(current), replayed: true };
      if (current.status === "rejected") {
        throw new HttpError(409, "SHORTCUT_BOOKKEEPING_REVIEW_TERMINAL", "Rejected shortcut review item cannot be retried");
      }
      if (current.status !== "review_required") {
        throw new HttpError(409, "SHORTCUT_BOOKKEEPING_REVIEW_STATE_CONFLICT", "Shortcut review item is not awaiting review");
      }
      const now = nowIso(clock);
      db.prepare(`
        UPDATE shortcut_bookkeeping_entries
        SET status = 'received', lease_started_at = NULL, error_code = NULL,
            updated_at = $now
        WHERE id = $id AND owner = $owner AND status = 'review_required'
      `).run({ $id: id, $owner: normalizedOwner, $now: now });
      insertAudit(db, {
        action: "shortcut_bookkeeping.manual_retry",
        entityType: "shortcut_bookkeeping_entry",
        entityId: id,
        actor: normalizedActor,
        requestId: current.source_id,
        before: { status: current.status },
        after: { status: "received" },
        metadata: { owner: normalizedOwner, ledgerName: current.ledger_name },
      });
      return { item: itemFromRow(selectById.get({ $id: id })), replayed: false };
    });
  }

  function currentProcessing(idValue, leaseTokenValue, expectedTarget) {
    const id = requiredText(idValue, "id", 200);
    const leaseToken = dateTime(leaseTokenValue, "leaseToken", { nullable: true });
    const current = selectById.get({ $id: id });
    if (!current) {
      throw new HttpError(404, "SHORTCUT_BOOKKEEPING_NOT_FOUND", "Shortcut bookkeeping entry was not found");
    }
    if (COMPLETED_STATUSES.has(current.status)) return { id, current, replayed: true };
    if (
      current.status !== "processing"
      || !leaseToken
      || current.lease_started_at !== leaseToken
      || current.target_system !== expectedTarget
    ) {
      throw new HttpError(
        409,
        "SHORTCUT_BOOKKEEPING_LEASE_LOST",
        "The bookkeeping processing lease is missing or no longer current",
      );
    }
    return { id, current, replayed: false };
  }

  function completeLocal(idValue, { analysis: analysisValue, leaseToken } = {}) {
    return withImmediateTransaction(db, () => {
      const state = currentProcessing(idValue, leaseToken, "sentelligent");
      if (state.replayed) return { item: itemFromRow(state.current), replayed: true };
      const { id, current } = state;
      if (current.ledger_name !== "出差报销" || current.entry_type !== "expense") {
        throw new TypeError("Sentelligent Shortcut bookkeeping only supports 出差报销 expense entries");
      }
      const analysis = normalizeAnalysis(analysisValue, current);
      const now = nowIso(clock);
      const stored = {
        $id: id,
        $provider: analysis.source.provider,
        $model: analysis.source.model,
        $analysisJson: JSON.stringify(analysis),
        $warningsJson: JSON.stringify(analysis.warnings),
        $occurredOn: analysis.expense?.occurredOn ?? null,
        $amountCents: analysis.expense?.amountCents ?? null,
        $merchant: analysis.expense?.merchant ?? null,
        $purpose: analysis.expense?.purpose ?? null,
        $now: now,
      };
      if (analysis.status === "review_required") {
        db.prepare(`
          UPDATE shortcut_bookkeeping_entries
          SET status = 'review_required', attempt_count = attempt_count + 1,
              lease_started_at = NULL, analysis_provider = $provider, analysis_model = $model,
              analysis_json = $analysisJson, warnings_json = $warningsJson,
              occurred_on = $occurredOn, amount_cents = $amountCents,
              merchant = $merchant, purpose = $purpose, error_code = NULL, updated_at = $now
          WHERE id = $id
        `).run(stored);
        insertAudit(db, {
          action: "shortcut_bookkeeping.review_required",
          entityType: "shortcut_bookkeeping_entry",
          entityId: id,
          actor: current.actor,
          requestId: current.source_id,
          before: { status: current.status },
          after: { status: "review_required", warningCount: analysis.warnings.length },
          metadata: { owner: current.owner, ledgerName: current.ledger_name, targetSystem: current.target_system },
        });
        return { item: itemFromRow(selectById.get({ $id: id })), replayed: false };
      }

      const expense = analysis.expense;
      const expenseId = generatedId(idFactory, "generated expense id");
      const paymentId = generatedId(idFactory, "generated payment id");
      const paidAt = expense.paidAt ?? current.captured_at ?? `${expense.occurredOn}T12:00:00+08:00`;
      db.prepare(`
          INSERT INTO travel_expenses (
            id, reference_code, owner, occurred_on, category, purpose, merchant,
            invoice_status, notes, created_by, updated_by, created_at, updated_at
          ) VALUES (
            $id, $referenceCode, $owner, $occurredOn, $category, $purpose, $merchant,
            'pending', $notes, $actor, $actor, $now, $now
          )
      `).run({
          $id: expenseId,
          $referenceCode: referenceCode(expense.occurredOn, expenseId),
          $owner: current.owner,
          $occurredOn: expense.occurredOn,
          $category: legacyCategory(current),
          $purpose: expense.purpose,
          $merchant: expense.merchant,
          $notes: current.note,
          $actor: current.actor,
          $now: now,
      });
      db.prepare(`
          INSERT INTO travel_expense_payments (
            id, expense_id, sequence, paid_at, merchant, amount_cents,
            reimbursement_cents, funding_source, payment_method, created_at, updated_at
          ) VALUES (
            $id, $expenseId, 1, $paidAt, $merchant, $amountCents,
            $reimbursementCents, $fundingSource, $paymentMethod, $now, $now
          )
      `).run({
          $id: paymentId,
          $expenseId: expenseId,
          $paidAt: paidAt,
          $merchant: expense.merchant,
          $amountCents: expense.amountCents,
          $reimbursementCents: expense.reimbursementCents,
          $fundingSource: expense.fundingSource,
          $paymentMethod: expense.paymentMethod,
          $now: now,
      });
      db.prepare(`
        UPDATE shortcut_bookkeeping_entries
        SET status = 'accepted', attempt_count = attempt_count + 1, lease_started_at = NULL,
            analysis_provider = $provider, analysis_model = $model,
            analysis_json = $analysisJson, warnings_json = $warningsJson,
            occurred_on = $occurredOn, amount_cents = $amountCents,
            merchant = $merchant, purpose = $purpose,
            expense_id = $expenseId, payment_id = $paymentId,
            error_code = NULL, updated_at = $now
        WHERE id = $id
      `).run({ ...stored, $expenseId: expenseId, $paymentId: paymentId });
      insertAudit(db, {
        action: "shortcut_bookkeeping.accept",
        entityType: "shortcut_bookkeeping_entry",
        entityId: id,
        actor: current.actor,
        requestId: current.source_id,
        before: { status: current.status },
        after: { status: "accepted", expenseId, paymentId, amountCents: expense.amountCents },
        metadata: {
          owner: current.owner,
          targetSystem: current.target_system,
          ledgerName: current.ledger_name,
          entryType: current.entry_type,
          category: current.category,
          subcategory: current.subcategory,
        },
      });
      return { item: itemFromRow(selectById.get({ $id: id })), replayed: false };
    });
  }

  function completeRemote(idValue, { remote, leaseToken } = {}) {
    return withImmediateTransaction(db, () => {
      const state = currentProcessing(idValue, leaseToken, "qingyang");
      if (state.replayed) return { item: itemFromRow(state.current), replayed: true };
      if (!isPlainObject(remote)) throw new TypeError("remote result must be an object");
      const remoteId = requiredText(remote.id, "remote.id", 200);
      const remoteReference = requiredText(remote.reference, "remote.reference", 200);
      const remoteStatus = requiredText(remote.status, "remote.status", 50);
      if (!REMOTE_COMPLETION_STATUSES.has(remoteStatus)) {
        throw new TypeError(
          "remote.status must be pending, processing, review, or confirmed; "
          + "failed must be released and rejected/voided must use completeRemoteTerminal",
        );
      }
      const now = nowIso(clock);
      const localStatus = remoteStatus === "confirmed" ? "accepted" : "review_required";
      db.prepare(`
        UPDATE shortcut_bookkeeping_entries
        SET status = $localStatus, attempt_count = attempt_count + 1,
            lease_started_at = NULL, remote_id = $remoteId,
            remote_reference = $remoteReference, remote_status = $remoteStatus,
            error_code = NULL, updated_at = $now
        WHERE id = $id
      `).run({
        $id: state.id,
        $localStatus: localStatus,
        $remoteId: remoteId,
        $remoteReference: remoteReference,
        $remoteStatus: remoteStatus,
        $now: now,
      });
      insertAudit(db, {
        action: "shortcut_bookkeeping.bridge_accept",
        entityType: "shortcut_bookkeeping_entry",
        entityId: state.id,
        actor: state.current.actor,
        requestId: state.current.source_id,
        before: { status: state.current.status },
        after: { status: localStatus, remoteId, remoteReference, remoteStatus },
        metadata: {
          owner: state.current.owner,
          targetSystem: state.current.target_system,
          ledgerName: state.current.ledger_name,
          entryType: state.current.entry_type,
          category: state.current.category,
          subcategory: state.current.subcategory,
        },
      });
      return { item: itemFromRow(selectById.get({ $id: state.id })), replayed: false };
    });
  }

  function completeRemoteTerminal(idValue, { remote, leaseToken } = {}) {
    return withImmediateTransaction(db, () => {
      const state = currentProcessing(idValue, leaseToken, "qingyang");
      if (state.replayed) return { item: itemFromRow(state.current), replayed: true };
      if (!isPlainObject(remote)) throw new TypeError("remote result must be an object");
      const remoteId = requiredText(remote.id, "remote.id", 200);
      const remoteReference = requiredText(remote.reference, "remote.reference", 200);
      const remoteStatus = requiredText(remote.status, "remote.status", 50);
      if (!new Set(["rejected", "voided"]).has(remoteStatus)) {
        throw new TypeError("remote.status must be rejected or voided");
      }
      const now = nowIso(clock);
      db.prepare(`
        UPDATE shortcut_bookkeeping_entries
        SET status = 'rejected', attempt_count = attempt_count + 1,
            lease_started_at = NULL, remote_id = $remoteId,
            remote_reference = $remoteReference, remote_status = $remoteStatus,
            error_code = 'QINGYANG_REMOTE_TERMINAL', updated_at = $now
        WHERE id = $id
      `).run({
        $id: state.id,
        $remoteId: remoteId,
        $remoteReference: remoteReference,
        $remoteStatus: remoteStatus,
        $now: now,
      });
      insertAudit(db, {
        action: "shortcut_bookkeeping.bridge_reject",
        entityType: "shortcut_bookkeeping_entry",
        entityId: state.id,
        actor: state.current.actor,
        requestId: state.current.source_id,
        before: { status: state.current.status },
        after: { status: "rejected", remoteId, remoteReference, remoteStatus },
        metadata: {
          owner: state.current.owner,
          targetSystem: state.current.target_system,
          ledgerName: state.current.ledger_name,
        },
      });
      return { item: itemFromRow(selectById.get({ $id: state.id })), replayed: false };
    });
  }

  function release(idValue, { leaseToken, errorCode = "PROCESSING_FAILED" } = {}) {
    return withImmediateTransaction(db, () => {
      const id = requiredText(idValue, "id", 200);
      const normalizedLease = dateTime(leaseToken, "leaseToken", { nullable: true });
      const normalizedError = requiredText(errorCode, "errorCode", 200);
      const current = selectById.get({ $id: id });
      if (!current || current.status !== "processing" || current.lease_started_at !== normalizedLease) {
        return false;
      }
      const now = nowIso(clock);
      db.prepare(`
        UPDATE shortcut_bookkeeping_entries
        SET status = 'received', attempt_count = attempt_count + 1,
            lease_started_at = NULL, error_code = $errorCode, updated_at = $now
        WHERE id = $id
      `).run({ $id: id, $errorCode: normalizedError, $now: now });
      insertAudit(db, {
        action: "shortcut_bookkeeping.processing_failed",
        entityType: "shortcut_bookkeeping_entry",
        entityId: id,
        actor: current.actor,
        requestId: current.source_id,
        before: { status: current.status },
        after: { status: "received", errorCode: normalizedError },
        metadata: { owner: current.owner, targetSystem: current.target_system },
      });
      return true;
    });
  }

  return {
    receive,
    claim,
    listReview,
    getReview,
    claimReview,
    rejectReview,
    retryReview,
    completeLocal,
    completeRemote,
    completeRemoteTerminal,
    release,
  };
}

export { legacyCategory };
