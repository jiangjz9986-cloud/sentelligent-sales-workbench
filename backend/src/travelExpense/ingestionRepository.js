import { createHash, randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";

const SOURCES = new Set(["icost", "weixin", "manual"]);
const CATEGORIES = new Set([
  "breakfast",
  "lunch",
  "dinner",
  "lodging",
  "transport",
  "hospitality",
  "other",
]);
const FUNDING_SOURCES = new Set(["personal", "company", "advance"]);
const PAYMENT_METHODS = new Set(["wechat", "alipay", "card", "cash", "other"]);
const ANALYSIS_STATUSES = new Set(["ready", "review_required"]);
const COMPLETED_STATUSES = new Set(["accepted", "review_required"]);
const REVIEW_EXPENSE_FIELDS = new Set([
  "occurredOn",
  "category",
  "purpose",
  "merchant",
  "amountCents",
  "reimbursementCents",
  "paidAt",
  "fundingSource",
  "paymentMethod",
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function objectValue(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function requiredText(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function optionalText(value, name, max = 5000) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized || null;
}

function enumValue(value, allowed, name, fallback) {
  const normalized = value ?? fallback;
  if (!allowed.has(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function hashValue(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Value(value, name) {
  const normalized = requiredText(value, name, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new TypeError(`${name} must be a SHA-256 hex digest`);
  return normalized;
}

function dateOnly(value, name, { nullable = false } = {}) {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${name} must use YYYY-MM-DD format`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${name} must be a real calendar date`);
  }
  return value;
}

function dateTime(value, name, { nullable = false } = {}) {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO date-time`);
  }
  return value.trim();
}

function cents(value, name, { nullable = false, fallback } = {}) {
  const normalized = value ?? fallback;
  if (normalized === undefined || normalized === null) {
    if (nullable) return null;
    throw new TypeError(`${name} must be a non-negative safe integer number of cents`);
  }
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer number of cents`);
  }
  return normalized;
}

function confidence(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("analysis.confidence must be a number between 0 and 1");
  }
  return value;
}

function positiveDuration(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nowIso(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid Date");
  return value.toISOString();
}

function generatedId(idFactory, label) {
  return requiredText(idFactory(), label, 200);
}

function referenceCode(occurredOn, id) {
  const day = occurredOn.replaceAll("-", "");
  const suffix = hashValue(id).slice(0, 8).toUpperCase();
  return `EXP-${day}-${suffix}`;
}

function assertNoActiveTransaction(db, operation) {
  if (db.isTransaction) {
    throw new TypeError(`${operation} must start outside an existing SQLite transaction`);
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

function normalizeWarnings(value) {
  if (!Array.isArray(value)) throw new TypeError("analysis.warnings must be an array");
  if (value.length > 50) throw new TypeError("analysis.warnings contains too many items");
  return value.map((item, index) => requiredText(item, `analysis.warnings[${index}]`, 500));
}

function normalizeAnalysisSource(value) {
  const source = objectValue(value, "analysis.source");
  for (const key of Object.keys(source)) {
    if (key !== "provider" && key !== "model") throw new TypeError(`analysis.source.${key} is not allowed`);
  }
  return {
    provider: requiredText(source.provider, "analysis.source.provider", 200),
    model: optionalText(source.model, "analysis.source.model", 200),
  };
}

function normalizeReviewExpense(value) {
  if (value === undefined || value === null) return null;
  const expense = objectValue(value, "analysis.expense");
  for (const key of Object.keys(expense)) {
    if (!REVIEW_EXPENSE_FIELDS.has(key)) throw new TypeError(`analysis.expense.${key} is not allowed`);
  }

  const normalized = {};
  if (Object.hasOwn(expense, "occurredOn")) {
    normalized.occurredOn = dateOnly(expense.occurredOn, "analysis.expense.occurredOn", { nullable: true });
  }
  if (Object.hasOwn(expense, "category")) {
    normalized.category = expense.category === null
      ? null
      : enumValue(expense.category, CATEGORIES, "analysis.expense.category");
  }
  if (Object.hasOwn(expense, "purpose")) {
    normalized.purpose = optionalText(expense.purpose, "analysis.expense.purpose", 1000);
  }
  if (Object.hasOwn(expense, "merchant")) {
    normalized.merchant = optionalText(expense.merchant, "analysis.expense.merchant", 500);
  }
  if (Object.hasOwn(expense, "amountCents")) {
    normalized.amountCents = cents(expense.amountCents, "analysis.expense.amountCents", { nullable: true });
  }
  if (Object.hasOwn(expense, "reimbursementCents")) {
    normalized.reimbursementCents = cents(
      expense.reimbursementCents,
      "analysis.expense.reimbursementCents",
      { nullable: true },
    );
  }
  if (
    normalized.amountCents !== undefined
    && normalized.amountCents !== null
    && normalized.reimbursementCents !== undefined
    && normalized.reimbursementCents !== null
    && normalized.reimbursementCents > normalized.amountCents
  ) {
    throw new TypeError("analysis.expense.reimbursementCents cannot exceed amountCents");
  }
  if (Object.hasOwn(expense, "paidAt")) {
    normalized.paidAt = dateTime(expense.paidAt, "analysis.expense.paidAt", { nullable: true });
  }
  if (Object.hasOwn(expense, "fundingSource")) {
    normalized.fundingSource = expense.fundingSource === null
      ? null
      : enumValue(expense.fundingSource, FUNDING_SOURCES, "analysis.expense.fundingSource");
  }
  if (Object.hasOwn(expense, "paymentMethod")) {
    normalized.paymentMethod = expense.paymentMethod === null
      ? null
      : enumValue(expense.paymentMethod, PAYMENT_METHODS, "analysis.expense.paymentMethod");
  }
  return normalized;
}

function normalizeReadyExpense(value) {
  const expense = objectValue(value, "analysis.expense");
  for (const key of Object.keys(expense)) {
    if (!REVIEW_EXPENSE_FIELDS.has(key)) throw new TypeError(`analysis.expense.${key} is not allowed`);
  }

  const amountCents = cents(expense.amountCents, "analysis.expense.amountCents");
  const reimbursementCents = cents(
    expense.reimbursementCents,
    "analysis.expense.reimbursementCents",
    { fallback: amountCents },
  );
  if (reimbursementCents > amountCents) {
    throw new TypeError("analysis.expense.reimbursementCents cannot exceed amountCents");
  }
  return {
    occurredOn: dateOnly(expense.occurredOn, "analysis.expense.occurredOn"),
    category: enumValue(expense.category, CATEGORIES, "analysis.expense.category"),
    purpose: requiredText(expense.purpose, "analysis.expense.purpose", 1000),
    merchant: optionalText(expense.merchant, "analysis.expense.merchant", 500),
    amountCents,
    reimbursementCents,
    paidAt: dateTime(expense.paidAt, "analysis.expense.paidAt", { nullable: true }),
    fundingSource: enumValue(
      expense.fundingSource,
      FUNDING_SOURCES,
      "analysis.expense.fundingSource",
      "personal",
    ),
    paymentMethod: enumValue(
      expense.paymentMethod,
      PAYMENT_METHODS,
      "analysis.expense.paymentMethod",
      "other",
    ),
  };
}

function normalizeAnalysis(value) {
  const analysis = objectValue(value, "analysis");
  const status = enumValue(analysis.status, ANALYSIS_STATUSES, "analysis.status");
  const normalized = {
    status,
    confidence: confidence(analysis.confidence),
    expense: status === "ready"
      ? normalizeReadyExpense(analysis.expense)
      : normalizeReviewExpense(analysis.expense),
    warnings: normalizeWarnings(analysis.warnings),
    source: normalizeAnalysisSource(analysis.source),
  };
  return normalized;
}

function analysisForStorage(analysis) {
  return {
    status: analysis.status,
    confidence: analysis.confidence,
    expense: analysis.expense,
    source: analysis.source,
  };
}

function itemFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    actor: row.actor,
    source: row.source,
    sourceId: row.source_id,
    capturedAt: row.captured_at,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    analysisProvider: row.analysis_provider,
    analysisModel: row.analysis_model,
    analysis: parseJson(row.analysis_json, null),
    warnings: parseJson(row.warnings_json, []),
    expenseId: row.expense_id,
    paymentId: row.payment_id,
    expenseReferenceCode: row.expense_reference_code ?? null,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTravelExpenseIngestionRepository(db, {
  idFactory = randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const selectItemById = db.prepare(`
    SELECT ingestion.*, expense.reference_code AS expense_reference_code
    FROM travel_expense_ingestions ingestion
    LEFT JOIN travel_expenses expense ON expense.id = ingestion.expense_id
    WHERE ingestion.id = $id
  `);
  const selectItemByIdempotency = db.prepare(`
    SELECT ingestion.*, expense.reference_code AS expense_reference_code
    FROM travel_expense_ingestions ingestion
    LEFT JOIN travel_expenses expense ON expense.id = ingestion.expense_id
    WHERE ingestion.owner = $owner
      AND ingestion.source = $source
      AND ingestion.idempotency_key_hash = $idempotencyKeyHash
  `);

  function receive(input = {}) {
    assertNoActiveTransaction(db, "receive");
    const owner = requiredText(input.owner, "owner", 200);
    const actor = requiredText(input.actor, "actor", 200);
    const source = enumValue(input.source, SOURCES, "source");
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 512);
    const idempotencyKeyHash = hashValue(idempotencyKey);
    const requestHash = sha256Value(input.requestHash, "requestHash");
    const sourceId = optionalText(input.sourceId, "sourceId", 200);
    const rawText = requiredText(input.rawText, "rawText", 12000);
    const capturedAt = dateTime(input.capturedAt, "capturedAt", { nullable: true });
    const now = nowIso(clock);

    return withImmediateTransaction(db, () => {
      const existing = selectItemByIdempotency.get({
        $owner: owner,
        $source: source,
        $idempotencyKeyHash: idempotencyKeyHash,
      });
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new HttpError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key was already used for a different request",
            { existingId: existing.id },
          );
        }
        return { item: itemFromRow(existing), replayed: true };
      }

      const id = generatedId(idFactory, "generated ingestion id");
      db.prepare(`
        INSERT INTO travel_expense_ingestions (
          id, owner, actor, source, idempotency_key_hash, request_hash,
          source_id, raw_text, captured_at, status, created_at, updated_at
        ) VALUES (
          $id, $owner, $actor, $source, $idempotencyKeyHash, $requestHash,
          $sourceId, $rawText, $capturedAt, 'received', $now, $now
        )
      `).run({
        $id: id,
        $owner: owner,
        $actor: actor,
        $source: source,
        $idempotencyKeyHash: idempotencyKeyHash,
        $requestHash: requestHash,
        $sourceId: sourceId,
        $rawText: rawText,
        $capturedAt: capturedAt,
        $now: now,
      });
      insertAudit(db, {
        action: "travel_expense.ingestion.receive",
        entityType: "travel_expense_ingestion",
        entityId: id,
        actor,
        requestId: sourceId,
        before: null,
        after: { status: "received" },
        metadata: { owner, source },
      });
      return { item: itemFromRow(selectItemById.get({ $id: id })), replayed: false };
    });
  }

  function claim(idValue, { leaseMs = 5 * 60_000 } = {}) {
    assertNoActiveTransaction(db, "claim");
    const id = requiredText(idValue, "id", 200);
    const normalizedLeaseMs = positiveDuration(leaseMs, "leaseMs");
    const now = nowIso(clock);
    const nowMs = Date.parse(now);

    return withImmediateTransaction(db, () => {
      const current = selectItemById.get({ $id: id });
      if (!current) {
        throw new HttpError(404, "INGESTION_NOT_FOUND", "Travel expense ingestion was not found");
      }
      if (COMPLETED_STATUSES.has(current.status)) {
        return { item: itemFromRow(current), replayed: true };
      }
      if (current.status === "processing") {
        const leaseStartedAt = Date.parse(current.lease_started_at);
        if (Number.isFinite(leaseStartedAt) && nowMs - leaseStartedAt < normalizedLeaseMs) {
          throw new HttpError(
            409,
            "REQUEST_IN_PROGRESS",
            "The same expense ingestion is already being processed",
          );
        }
      } else if (current.status !== "received") {
        throw new HttpError(
          409,
          "INGESTION_STATE_CONFLICT",
          "Travel expense ingestion cannot be claimed from its current state",
          { status: current.status },
        );
      }

      db.prepare(`
        UPDATE travel_expense_ingestions
        SET status = 'processing', lease_started_at = $now, updated_at = $now
        WHERE id = $id
      `).run({ $id: id, $now: now });
      return {
        item: itemFromRow(selectItemById.get({ $id: id })),
        leaseToken: now,
        replayed: false,
      };
    });
  }

  function complete(idValue, { analysis: analysisValue, leaseToken: leaseTokenValue } = {}) {
    assertNoActiveTransaction(db, "complete");
    const id = requiredText(idValue, "id", 200);
    const leaseToken = dateTime(leaseTokenValue, "leaseToken", { nullable: true });
    // Model and OCR work must finish before this call. Normalization intentionally
    // happens before BEGIN IMMEDIATE so no SQLite transaction spans that work.
    const analysis = normalizeAnalysis(analysisValue);
    const storedAnalysis = JSON.stringify(analysisForStorage(analysis));
    const storedWarnings = JSON.stringify(analysis.warnings);
    const now = nowIso(clock);

    return withImmediateTransaction(db, () => {
      const current = selectItemById.get({ $id: id });
      if (!current) {
        throw new HttpError(404, "INGESTION_NOT_FOUND", "Travel expense ingestion was not found");
      }
      if (COMPLETED_STATUSES.has(current.status)) {
        return { item: itemFromRow(current), replayed: true };
      }
      if (
        current.status !== "processing"
        || leaseToken === null
        || current.lease_started_at !== leaseToken
      ) {
        throw new HttpError(
          409,
          "INGESTION_LEASE_LOST",
          "The expense ingestion processing lease is missing or no longer current",
        );
      }

      if (analysis.status === "review_required") {
        db.prepare(`
          UPDATE travel_expense_ingestions
          SET status = 'review_required', attempt_count = attempt_count + 1,
              lease_started_at = NULL, analysis_provider = $provider,
              analysis_model = $model, analysis_json = $analysisJson,
              warnings_json = $warningsJson, expense_id = NULL, payment_id = NULL,
              error_code = NULL, updated_at = $now
          WHERE id = $id
        `).run({
          $id: id,
          $provider: analysis.source.provider,
          $model: analysis.source.model,
          $analysisJson: storedAnalysis,
          $warningsJson: storedWarnings,
          $now: now,
        });
        insertAudit(db, {
          action: "travel_expense.ingestion.review_required",
          entityType: "travel_expense_ingestion",
          entityId: id,
          actor: current.actor,
          requestId: current.source_id,
          before: { status: current.status },
          after: { status: "review_required", warningCount: analysis.warnings.length },
          metadata: { owner: current.owner, source: current.source },
        });
        return { item: itemFromRow(selectItemById.get({ $id: id })), replayed: false };
      }

      const expenseId = generatedId(idFactory, "generated expense id");
      const paymentId = generatedId(idFactory, "generated payment id");
      const expenseReferenceCode = referenceCode(analysis.expense.occurredOn, expenseId);
      const paidAt = analysis.expense.paidAt
        ?? current.captured_at
        ?? `${analysis.expense.occurredOn}T12:00:00+08:00`;

      // This is the dedicated trusted ingestion entry point. It preserves the
      // integration actor while leaving the public owner === actor constraint intact.
      db.prepare(`
        INSERT INTO travel_expenses (
          id, reference_code, owner, occurred_on, category, purpose, merchant,
          invoice_status, created_by, updated_by, created_at, updated_at
        ) VALUES (
          $id, $referenceCode, $owner, $occurredOn, $category, $purpose, $merchant,
          'pending', $actor, $actor, $now, $now
        )
      `).run({
        $id: expenseId,
        $referenceCode: expenseReferenceCode,
        $owner: current.owner,
        $occurredOn: analysis.expense.occurredOn,
        $category: analysis.expense.category,
        $purpose: analysis.expense.purpose,
        $merchant: analysis.expense.merchant,
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
        $merchant: analysis.expense.merchant,
        $amountCents: analysis.expense.amountCents,
        $reimbursementCents: analysis.expense.reimbursementCents,
        $fundingSource: analysis.expense.fundingSource,
        $paymentMethod: analysis.expense.paymentMethod,
        $now: now,
      });
      db.prepare(`
        UPDATE travel_expense_ingestions
        SET status = 'accepted', attempt_count = attempt_count + 1,
            lease_started_at = NULL, analysis_provider = $provider,
            analysis_model = $model, analysis_json = $analysisJson,
            warnings_json = $warningsJson, expense_id = $expenseId,
            payment_id = $paymentId, error_code = NULL, updated_at = $now
        WHERE id = $id
      `).run({
        $id: id,
        $provider: analysis.source.provider,
        $model: analysis.source.model,
        $analysisJson: storedAnalysis,
        $warningsJson: storedWarnings,
        $expenseId: expenseId,
        $paymentId: paymentId,
        $now: now,
      });
      insertAudit(db, {
        action: "travel_expense.ingestion.accept",
        entityType: "travel_expense_ingestion",
        entityId: id,
        actor: current.actor,
        requestId: current.source_id,
        before: { status: current.status },
        after: {
          status: "accepted",
          expenseId,
          paymentId,
          amountCents: analysis.expense.amountCents,
          reimbursementCents: analysis.expense.reimbursementCents,
        },
        metadata: { owner: current.owner, source: current.source },
      });
      return { item: itemFromRow(selectItemById.get({ $id: id })), replayed: false };
    });
  }

  return { receive, claim, complete };
}
