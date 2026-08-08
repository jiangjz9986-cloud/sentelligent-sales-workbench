import { createHash, randomUUID } from "node:crypto";

import { withImmediateTransaction } from "../db/transaction.js";
import {
  decodeDocumentBlob,
  documentBlobId,
  DocumentBlobIntegrityError,
} from "./documentBlobCodec.js";
import {
  assertDocumentBlobReadOutsideTransaction,
  deleteDocumentBlobIfUnreferenced,
  putDocumentBlob,
  withDocumentBlobWritePreflightSync,
} from "./documentBlobStore.js";
import { detectDocumentType, validateDocumentFileName } from "./invoiceRecognition.js";

const CATEGORIES = new Set(["breakfast", "lunch", "dinner", "lodging", "transport", "hospitality", "other"]);
const FUNDING_SOURCES = new Set(["personal", "company", "advance"]);
const PAYMENT_METHODS = new Set(["wechat", "alipay", "card", "cash", "other"]);
const ATTACHMENT_KINDS = new Set(["payment_proof", "invoice", "substitute"]);
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const ADVANCE_STATUSES = new Set(["draft", "requested", "received", "closed"]);
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

export class TravelExpenseNotFoundError extends Error {
  constructor(message = "Travel expense record was not found") {
    super(message);
    this.name = "TravelExpenseNotFoundError";
    this.code = "NOT_FOUND";
  }
}

export class TravelExpenseVersionConflictError extends Error {
  constructor(currentVersion) {
    super("Travel expense record was updated by another request");
    this.name = "TravelExpenseVersionConflictError";
    this.code = "VERSION_CONFLICT";
    this.currentVersion = currentVersion;
  }
}

export class TravelExpenseDependencyConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TravelExpenseDependencyConflictError";
    this.code = code;
  }
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

function cents(value, name, fallback) {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${name} must be a non-negative integer number of cents`);
  }
  return normalized;
}

function dateOnly(value, name, { nullable = false, monday = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${name} must use YYYY-MM-DD format`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${name} must be a real calendar date`);
  }
  if (monday && date.getUTCDay() !== 1) throw new TypeError(`${name} must be a Monday`);
  return value;
}

function dateTime(value, name) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO date-time`);
  }
  return value.trim();
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("expectedVersion must be a positive safe integer");
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
  const suffix = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8).toUpperCase();
  return `EXP-${day}-${suffix}`;
}

function ownerAndActor(input) {
  const actor = requiredText(input.actor, "actor", 200);
  const owner = requiredText(input.owner ?? actor, "owner", 200);
  if (owner !== actor) throw new TypeError("owner must match actor for a personal expense record");
  return { actor, owner };
}

function runTransaction(db, work) {
  return db.isTransaction ? work() : withImmediateTransaction(db, work);
}

function paymentFromRow(row) {
  return {
    id: row.id,
    expenseId: row.expense_id,
    sequence: Number(row.sequence),
    paidAt: row.paid_at,
    merchant: row.merchant,
    amountCents: Number(row.amount_cents),
    reimbursementCents: Number(row.reimbursement_cents),
    fundingSource: row.funding_source,
    paymentMethod: row.payment_method,
    accountLast4: row.account_last4,
    differenceReason: row.difference_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row, paymentIds = []) {
  return {
    id: row.id,
    expenseId: row.expense_id,
    paymentIds,
    sequence: Number(row.sequence),
    kind: row.kind,
    fileName: row.file_name,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    coveredCents: Number(row.covered_cents),
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    contentUrl: `/api/travel-expense-attachments/${encodeURIComponent(row.id)}/content`,
  };
}

function advanceFromRow(row) {
  if (!row) return null;
  const item = {
    id: row.id,
    version: Number(row.version),
    owner: row.owner,
    weekStart: row.week_start,
    status: row.status,
    requestedCents: Number(row.requested_cents),
    receivedCents: Number(row.received_cents),
    requestedOn: row.requested_on,
    receivedOn: row.received_on,
    purpose: row.purpose,
    notes: row.notes,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.deleted_at) {
    item.deletedAt = row.deleted_at;
    item.deletedBy = row.deleted_by;
  }
  return item;
}

function normalizePayment(input, index, idFactory) {
  const amountCents = cents(input?.amountCents, `payments[${index}].amountCents`);
  const reimbursementCents = cents(input?.reimbursementCents, `payments[${index}].reimbursementCents`);
  if (reimbursementCents > amountCents) {
    throw new TypeError(`payments[${index}].reimbursementCents cannot exceed amountCents`);
  }
  const differenceReason = optionalText(input?.differenceReason, `payments[${index}].differenceReason`, 2000);
  if (amountCents !== reimbursementCents && !differenceReason) {
    throw new TypeError(`payments[${index}].differenceReason is required when amounts differ`);
  }
  const accountLast4 = optionalText(input?.accountLast4, `payments[${index}].accountLast4`, 4);
  if (accountLast4 && !/^\d{1,4}$/.test(accountLast4)) {
    throw new TypeError(`payments[${index}].accountLast4 must contain up to four digits`);
  }
  return {
    id: input?.id ? requiredText(input.id, `payments[${index}].id`, 200) : generatedId(idFactory, "generated payment id"),
    sequence: index + 1,
    paidAt: dateTime(input?.paidAt, `payments[${index}].paidAt`),
    merchant: optionalText(input?.merchant, `payments[${index}].merchant`, 500),
    amountCents,
    reimbursementCents,
    fundingSource: enumValue(input?.fundingSource, FUNDING_SOURCES, `payments[${index}].fundingSource`),
    paymentMethod: enumValue(input?.paymentMethod, PAYMENT_METHODS, `payments[${index}].paymentMethod`, "other"),
    accountLast4,
    differenceReason,
  };
}

function normalizeExpense(input, idFactory) {
  const { actor, owner } = ownerAndActor(input);
  if (!Array.isArray(input.payments) || input.payments.length < 1 || input.payments.length > 25) {
    throw new TypeError("payments must contain between 1 and 25 items");
  }
  const payments = input.payments.map((item, index) => normalizePayment(item, index, idFactory));
  if (new Set(payments.map((item) => item.id)).size !== payments.length) {
    throw new TypeError("payment ids must be unique");
  }
  return {
    actor,
    owner,
    occurredOn: dateOnly(input.occurredOn, "occurredOn"),
    category: enumValue(input.category, CATEGORIES, "category"),
    purpose: requiredText(input.purpose, "purpose", 1000),
    merchant: optionalText(input.merchant, "merchant", 500),
    itineraryId: optionalText(input.itineraryId, "itineraryId", 200),
    customerId: optionalText(input.customerId, "customerId", 200),
    notes: optionalText(input.notes, "notes", 5000),
    payments,
  };
}

function normalizeAdvance(input) {
  const { actor, owner } = ownerAndActor(input);
  return {
    actor,
    owner,
    weekStart: dateOnly(input.weekStart, "weekStart", { monday: true }),
    status: enumValue(input.status, ADVANCE_STATUSES, "status", "draft"),
    requestedCents: cents(input.requestedCents, "requestedCents", 0),
    receivedCents: cents(input.receivedCents, "receivedCents", 0),
    requestedOn: dateOnly(input.requestedOn, "requestedOn", { nullable: true }),
    receivedOn: dateOnly(input.receivedOn, "receivedOn", { nullable: true }),
    purpose: requiredText(input.purpose, "purpose", 1000),
    notes: optionalText(input.notes, "notes", 5000),
  };
}

export function createTravelExpenseRepository(db, {
  idFactory = randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const activeExpense = db.prepare(
    "SELECT * FROM travel_expenses WHERE id = $id AND owner = $owner AND deleted_at IS NULL",
  );
  const anyExpense = db.prepare("SELECT * FROM travel_expenses WHERE id = $id AND owner = $owner");
  const expensePayments = db.prepare(
    "SELECT * FROM travel_expense_payments WHERE expense_id = $expenseId ORDER BY sequence, id",
  );
  const expenseAttachments = db.prepare(
    "SELECT id, expense_id, sequence, kind, file_name, media_type, size_bytes, covered_cents, notes, created_by, created_at FROM travel_expense_attachments WHERE expense_id = $expenseId ORDER BY sequence, id",
  );
  const attachmentPaymentIds = db.prepare(
    "SELECT payment_id FROM travel_expense_attachment_payments WHERE attachment_id = $attachmentId ORDER BY payment_id",
  );

  function hydrateExpense(row) {
    if (!row) return null;
    const payments = expensePayments.all({ $expenseId: row.id }).map(paymentFromRow);
    const attachments = expenseAttachments.all({ $expenseId: row.id }).map((attachment) => attachmentFromRow(
      attachment,
      attachmentPaymentIds.all({ $attachmentId: attachment.id }).map((item) => item.payment_id),
    ));
    const item = {
      id: row.id,
      referenceCode: row.reference_code,
      version: Number(row.version),
      owner: row.owner,
      occurredOn: row.occurred_on,
      category: row.category,
      purpose: row.purpose,
      merchant: row.merchant,
      itineraryId: row.itinerary_id,
      customerId: row.customer_id,
      invoiceStatus: row.invoice_status,
      notes: row.notes,
      payments,
      attachments,
      actualPaidCents: payments.reduce((sum, item) => sum + item.amountCents, 0),
      reimbursementCents: payments.reduce((sum, item) => sum + item.reimbursementCents, 0),
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.deleted_at) {
      item.deletedAt = row.deleted_at;
      item.deletedBy = row.deleted_by;
    }
    return item;
  }

  function expenseMutationFailure(id, owner) {
    const current = anyExpense.get({ $id: id, $owner: owner });
    if (!current || current.deleted_at) throw new TravelExpenseNotFoundError();
    throw new TravelExpenseVersionConflictError(Number(current.version));
  }

  function confirmedExpenseCoverageCents(expenseId) {
    return Number(db.prepare(`
      SELECT COALESCE(SUM(match.allocated_cents), 0) AS total
      FROM invoice_matches match
      JOIN invoice_documents invoice
        ON invoice.id = match.invoice_id
       AND invoice.owner = match.owner
       AND invoice.deleted_at IS NULL
      JOIN travel_expenses expense
        ON expense.id = match.expense_id
       AND expense.owner = match.owner
       AND expense.deleted_at IS NULL
      WHERE match.expense_id = $expenseId AND match.state = 'confirmed'
    `).get({ $expenseId: expenseId }).total);
  }

  function confirmedPaymentCoverageCents(paymentId) {
    return Number(db.prepare(`
      SELECT COALESCE(SUM(match.allocated_cents), 0) AS total
      FROM invoice_matches match
      JOIN invoice_documents invoice
        ON invoice.id = match.invoice_id
       AND invoice.owner = match.owner
       AND invoice.deleted_at IS NULL
      JOIN travel_expenses expense
        ON expense.id = match.expense_id
       AND expense.owner = match.owner
       AND expense.deleted_at IS NULL
      WHERE match.payment_id = $paymentId AND match.state = 'confirmed'
    `).get({ $paymentId: paymentId }).total);
  }

  function derivedInvoiceStatus(expenseId, reimbursementCents) {
    const confirmed = confirmedExpenseCoverageCents(expenseId);
    const noInvoiceCount = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM travel_expense_no_invoice_confirmations
      WHERE expense_id = $expenseId AND revoked_at IS NULL
    `).get({ $expenseId: expenseId }).count);
    return reimbursementCents > 0 && confirmed >= reimbursementCents
      ? "covered"
      : confirmed > 0
        ? "partial"
        : noInvoiceCount > 0
          ? "missing"
          : "pending";
  }

  function paymentDependency(paymentId) {
    return db.prepare(`
      SELECT dependency FROM (
        SELECT 'attachment' AS dependency
        FROM travel_expense_attachment_payments WHERE payment_id = $paymentId
        UNION ALL
        SELECT 'invoice_match'
        FROM invoice_matches WHERE payment_id = $paymentId
        UNION ALL
        SELECT 'no_invoice_confirmation'
        FROM travel_expense_no_invoice_confirmations WHERE payment_id = $paymentId
        UNION ALL
        SELECT 'match_candidate'
        FROM invoice_match_candidates WHERE payment_id = $paymentId
        UNION ALL
        SELECT 'ingestion'
        FROM travel_expense_ingestions WHERE payment_id = $paymentId
        UNION ALL
        SELECT 'document_inbox'
        FROM travel_expense_document_inbox WHERE matched_payment_id = $paymentId
      )
      LIMIT 1
    `).get({ $paymentId: paymentId });
  }

  function validatePaymentMutation(expenseId, payments) {
    const currentRows = expensePayments.all({ $expenseId: expenseId });
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    const nextById = new Map(payments.map((item) => [item.id, item]));

    for (const row of currentRows) {
      if (nextById.has(row.id)) continue;
      const dependency = paymentDependency(row.id);
      if (dependency) {
        throw new TravelExpenseDependencyConflictError(
          "PAYMENT_HAS_DEPENDENCIES",
          `Payment ${row.id} cannot be deleted while ${dependency.dependency} records are linked`,
        );
      }
    }

    for (const payment of payments) {
      if (!currentById.has(payment.id)) continue;
      const confirmed = confirmedPaymentCoverageCents(payment.id);
      if (payment.reimbursementCents < confirmed) {
        throw new TravelExpenseDependencyConflictError(
          "REIMBURSEMENT_BELOW_CONFIRMED_COVERAGE",
          `Payment ${payment.id} reimbursement cannot be lower than confirmed invoice coverage`,
        );
      }
    }

    const reimbursementCents = payments.reduce(
      (sum, payment) => sum + payment.reimbursementCents,
      0,
    );
    if (reimbursementCents < confirmedExpenseCoverageCents(expenseId)) {
      throw new TravelExpenseDependencyConflictError(
        "REIMBURSEMENT_BELOW_CONFIRMED_COVERAGE",
        "Expense reimbursement cannot be lower than confirmed invoice coverage",
      );
    }

    const reimbursementChanged = currentRows.length !== payments.length || payments.some((payment) => {
      const current = currentById.get(payment.id);
      return current && Number(current.reimbursement_cents) !== payment.reimbursementCents;
    });
    if (reimbursementChanged) {
      const activeNoInvoice = db.prepare(`
        SELECT 1
        FROM travel_expense_no_invoice_confirmations
        WHERE expense_id = $expenseId AND revoked_at IS NULL
        LIMIT 1
      `).get({ $expenseId: expenseId });
      if (activeNoInvoice) {
        throw new TravelExpenseDependencyConflictError(
          "EXPENSE_HAS_ACTIVE_NO_INVOICE_CONFIRMATION",
          "Revoke the active no-invoice confirmation before changing reimbursement amounts",
        );
      }
      const activeCandidate = db.prepare(`
        SELECT 1
        FROM invoice_match_candidates
        WHERE expense_id = $expenseId AND status = 'suggested'
        LIMIT 1
      `).get({ $expenseId: expenseId });
      if (activeCandidate) {
        throw new TravelExpenseDependencyConflictError(
          "EXPENSE_HAS_ACTIVE_CANDIDATES",
          "Resolve active invoice match candidates before changing reimbursement amounts",
        );
      }
    }

    return {
      invoiceStatus: derivedInvoiceStatus(expenseId, reimbursementCents),
    };
  }

  function activeExpenseInvoiceDependency(expenseId) {
    return db.prepare(`
      SELECT dependency FROM (
        SELECT 'invoice_match' AS dependency
        FROM invoice_matches
        WHERE expense_id = $expenseId AND state IN ('suggested', 'confirmed')
        UNION ALL
        SELECT 'no_invoice_confirmation'
        FROM travel_expense_no_invoice_confirmations
        WHERE expense_id = $expenseId AND revoked_at IS NULL
        UNION ALL
        SELECT 'match_candidate'
        FROM invoice_match_candidates
        WHERE expense_id = $expenseId AND status = 'suggested'
        UNION ALL
        SELECT 'ingestion'
        FROM travel_expense_ingestions
        WHERE expense_id = $expenseId
        UNION ALL
        SELECT 'document_inbox'
        FROM travel_expense_document_inbox
        WHERE matched_expense_id = $expenseId
      )
      LIMIT 1
    `).get({ $expenseId: expenseId });
  }

  function persistPayments(expenseId, payments, timestamp) {
    const currentRows = expensePayments.all({ $expenseId: expenseId });
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    const nextIds = new Set(payments.map((item) => item.id));

    for (const row of currentRows) {
      if (nextIds.has(row.id)) continue;
      const linkedAttachment = db.prepare(`
        SELECT attachment_id
        FROM travel_expense_attachment_payments
        WHERE payment_id = $paymentId
        LIMIT 1
      `).get({ $paymentId: row.id });
      if (linkedAttachment) {
        throw new TypeError(`Payment ${row.id} cannot be deleted while attachments are linked`);
      }
    }

    for (const payment of payments) {
      const existing = db.prepare("SELECT expense_id FROM travel_expense_payments WHERE id = $id").get({ $id: payment.id });
      if (existing && existing.expense_id !== expenseId) throw new TypeError("payment id belongs to another expense");
    }

    if (currentRows.length > 0) {
      const highestSequence = Math.max(
        ...currentRows.map((row) => Number(row.sequence)),
        ...payments.map((payment) => payment.sequence),
      );
      db.prepare(`
        UPDATE travel_expense_payments
        SET sequence = sequence + $offset
        WHERE expense_id = $expenseId
      `).run({ $offset: highestSequence + 1, $expenseId: expenseId });
    }

    for (const payment of payments) {
      const params = {
        $id: payment.id,
        $expenseId: expenseId,
        $sequence: payment.sequence,
        $paidAt: payment.paidAt,
        $merchant: payment.merchant,
        $amountCents: payment.amountCents,
        $reimbursementCents: payment.reimbursementCents,
        $fundingSource: payment.fundingSource,
        $paymentMethod: payment.paymentMethod,
        $accountLast4: payment.accountLast4,
        $differenceReason: payment.differenceReason,
        $now: timestamp,
      };
      if (currentById.has(payment.id)) {
        db.prepare(`
          UPDATE travel_expense_payments
          SET sequence = $sequence, paid_at = $paidAt, merchant = $merchant,
              amount_cents = $amountCents, reimbursement_cents = $reimbursementCents,
              funding_source = $fundingSource, payment_method = $paymentMethod,
              account_last4 = $accountLast4, difference_reason = $differenceReason,
              updated_at = $now
          WHERE id = $id AND expense_id = $expenseId
        `).run(params);
      } else {
        db.prepare(`
          INSERT INTO travel_expense_payments (
            id, expense_id, sequence, paid_at, merchant, amount_cents, reimbursement_cents,
            funding_source, payment_method, account_last4, difference_reason, created_at, updated_at
          ) VALUES (
            $id, $expenseId, $sequence, $paidAt, $merchant, $amountCents, $reimbursementCents,
            $fundingSource, $paymentMethod, $accountLast4, $differenceReason, $now, $now
          )
        `).run(params);
      }
    }

    for (const row of currentRows) {
      if (!nextIds.has(row.id)) {
        db.prepare("DELETE FROM travel_expense_payments WHERE id = $id AND expense_id = $expenseId")
          .run({ $id: row.id, $expenseId: expenseId });
      }
    }
  }

  function getExpense(id, { owner } = {}) {
    return hydrateExpense(activeExpense.get({
      $id: requiredText(id, "id", 200),
      $owner: requiredText(owner, "owner", 200),
    }));
  }

  function listExpenses({ owner, weekStart } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedWeekStart = dateOnly(weekStart, "weekStart", { monday: true });
    return db.prepare(`
      SELECT * FROM travel_expenses
      WHERE owner = $owner
        AND deleted_at IS NULL
        AND occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')
      ORDER BY occurred_on, created_at, id
    `).all({ $owner: normalizedOwner, $weekStart: normalizedWeekStart }).map(hydrateExpense);
  }

  function createExpense(input = {}) {
    const id = generatedId(idFactory, "generated expense id");
    const normalized = normalizeExpense(input, idFactory);
    const expenseReferenceCode = referenceCode(normalized.occurredOn, id);
    const now = nowIso(clock);
    return runTransaction(db, () => {
      db.prepare(`
        INSERT INTO travel_expenses (
          id, reference_code, owner, occurred_on, category, purpose, merchant, itinerary_id, customer_id,
          invoice_status, notes, created_by, updated_by, created_at, updated_at
        ) VALUES (
          $id, $referenceCode, $owner, $occurredOn, $category, $purpose, $merchant, $itineraryId, $customerId,
          'pending', $notes, $actor, $actor, $now, $now
        )
      `).run({
        $id: id,
        $referenceCode: expenseReferenceCode,
        $owner: normalized.owner,
        $occurredOn: normalized.occurredOn,
        $category: normalized.category,
        $purpose: normalized.purpose,
        $merchant: normalized.merchant,
        $itineraryId: normalized.itineraryId,
        $customerId: normalized.customerId,
        $notes: normalized.notes,
        $actor: normalized.actor,
        $now: now,
      });
      persistPayments(id, normalized.payments, now);
      return hydrateExpense(anyExpense.get({ $id: id, $owner: normalized.owner }));
    });
  }

  function updateExpense(id, input = {}) {
    const expenseId = requiredText(id, "id", 200);
    const normalized = normalizeExpense(input, idFactory);
    const version = positiveVersion(input.expectedVersion);
    const now = nowIso(clock);
    return runTransaction(db, () => {
      const current = anyExpense.get({ $id: expenseId, $owner: normalized.owner });
      if (!current || current.deleted_at) throw new TravelExpenseNotFoundError();
      if (Number(current.version) !== version) {
        throw new TravelExpenseVersionConflictError(Number(current.version));
      }
      const mutation = validatePaymentMutation(expenseId, normalized.payments);
      const result = db.prepare(`
        UPDATE travel_expenses
        SET occurred_on = $occurredOn, category = $category, purpose = $purpose,
            merchant = $merchant, itinerary_id = $itineraryId, customer_id = $customerId,
            invoice_status = $invoiceStatus, notes = $notes, updated_by = $actor,
            updated_at = $now, version = version + 1
        WHERE id = $id AND owner = $owner AND version = $expectedVersion AND deleted_at IS NULL
      `).run({
        $id: expenseId,
        $owner: normalized.owner,
        $expectedVersion: version,
        $occurredOn: normalized.occurredOn,
        $category: normalized.category,
        $purpose: normalized.purpose,
        $merchant: normalized.merchant,
        $itineraryId: normalized.itineraryId,
        $customerId: normalized.customerId,
        $invoiceStatus: mutation.invoiceStatus,
        $notes: normalized.notes,
        $actor: normalized.actor,
        $now: now,
      });
      if (result.changes !== 1) expenseMutationFailure(expenseId, normalized.owner);
      persistPayments(expenseId, normalized.payments, now);
      return hydrateExpense(anyExpense.get({ $id: expenseId, $owner: normalized.owner }));
    });
  }

  function softDeleteExpense(id, input = {}) {
    const expenseId = requiredText(id, "id", 200);
    const { owner, actor } = ownerAndActor(input);
    const version = positiveVersion(input.expectedVersion);
    const now = nowIso(clock);
    return runTransaction(db, () => {
      const current = anyExpense.get({ $id: expenseId, $owner: owner });
      if (!current || current.deleted_at) throw new TravelExpenseNotFoundError();
      if (Number(current.version) !== version) {
        throw new TravelExpenseVersionConflictError(Number(current.version));
      }
      const dependency = activeExpenseInvoiceDependency(expenseId);
      if (dependency) {
        throw new TravelExpenseDependencyConflictError(
          "EXPENSE_HAS_ACTIVE_INVOICE_STATE",
          `Expense cannot be deleted while ${dependency.dependency} records are active`,
        );
      }
      const result = db.prepare(`
        UPDATE travel_expenses
        SET deleted_at = $now, deleted_by = $actor, updated_by = $actor,
            updated_at = $now, version = version + 1
        WHERE id = $id AND owner = $owner AND version = $expectedVersion AND deleted_at IS NULL
      `).run({ $id: expenseId, $owner: owner, $expectedVersion: version, $actor: actor, $now: now });
      if (result.changes !== 1) expenseMutationFailure(expenseId, owner);
      return hydrateExpense(anyExpense.get({ $id: expenseId, $owner: owner }));
    });
  }

  function bumpExpenseVersion(expenseId, owner, actor, expectedVersion, now) {
    const result = db.prepare(`
      UPDATE travel_expenses
      SET updated_by = $actor, updated_at = $now, version = version + 1
      WHERE id = $id AND owner = $owner AND version = $expectedVersion AND deleted_at IS NULL
    `).run({
      $id: expenseId,
      $owner: owner,
      $actor: actor,
      $now: now,
      $expectedVersion: expectedVersion,
    });
    if (result.changes !== 1) expenseMutationFailure(expenseId, owner);
  }

  function addAttachment(expenseIdValue, input = {}) {
    const expenseId = requiredText(expenseIdValue, "expenseId", 200);
    const { owner, actor } = ownerAndActor(input);
    const version = positiveVersion(input.expectedVersion);
    const kind = enumValue(input.kind, ATTACHMENT_KINDS, "kind");
    const mediaType = enumValue(input.mediaType, MEDIA_TYPES, "mediaType");
    const fileName = validateDocumentFileName(input.fileName);
    const content = Buffer.isBuffer(input.content)
      ? Buffer.from(input.content)
      : input.content instanceof Uint8Array
        ? Buffer.from(input.content)
        : null;
    if (!content || content.length < 1 || content.length > MAX_ATTACHMENT_BYTES) {
      throw new TypeError("content must contain between 1 byte and 12 MiB");
    }
    if (detectDocumentType(content) !== mediaType) {
      throw new TypeError("content signature does not match mediaType");
    }
    if (!Array.isArray(input.paymentIds ?? [])) throw new TypeError("paymentIds must be an array");
    const paymentIds = [...new Set((input.paymentIds ?? []).map((value, index) => (
      requiredText(value, `paymentIds[${index}]`, 200)
    )))];
    if (paymentIds.length > 25) throw new TypeError("paymentIds contains too many items");
    if (kind === "payment_proof" && paymentIds.length === 0) {
      throw new TypeError("paymentIds must contain at least one item for payment_proof");
    }
    const coveredCents = cents(input.coveredCents, "coveredCents", 0);
    const notes = optionalText(input.notes, "notes", 2000);
    const id = generatedId(idFactory, "generated attachment id");
    const now = nowIso(clock);
    const write = (encodedDocumentBlob) => runTransaction(db, () => {
      for (const paymentId of paymentIds) {
        const payment = db.prepare(
          "SELECT id FROM travel_expense_payments WHERE id = $id AND expense_id = $expenseId",
        ).get({ $id: paymentId, $expenseId: expenseId });
        if (!payment) throw new TravelExpenseNotFoundError("Payment was not found for this expense");
      }
      bumpExpenseVersion(expenseId, owner, actor, version, now);
      const documentBlob = putDocumentBlob(db, {
        owner,
        content,
        encoded: encodedDocumentBlob,
        createdAt: now,
      });
      const sequence = Number(db.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM travel_expense_attachments WHERE expense_id = $expenseId",
      ).get({ $expenseId: expenseId }).next_sequence);
      db.prepare(`
        INSERT INTO travel_expense_attachments (
          id, expense_id, sequence, kind, file_name, media_type, size_bytes,
          document_blob_id, covered_cents, notes, created_by, created_at
        ) VALUES (
          $id, $expenseId, $sequence, $kind, $fileName, $mediaType, $sizeBytes,
          $documentBlobId, $coveredCents, $notes, $actor, $now
        )
      `).run({
        $id: id,
        $expenseId: expenseId,
        $sequence: sequence,
        $kind: kind,
        $fileName: fileName,
        $mediaType: mediaType,
        $sizeBytes: content.length,
        $documentBlobId: documentBlob.id,
        $coveredCents: coveredCents,
        $notes: notes,
        $actor: actor,
        $now: now,
      });
      const linkPayment = db.prepare(`
        INSERT INTO travel_expense_attachment_payments (attachment_id, payment_id)
        VALUES ($attachmentId, $paymentId)
      `);
      for (const paymentId of paymentIds) {
        linkPayment.run({ $attachmentId: id, $paymentId: paymentId });
      }
      return hydrateExpense(anyExpense.get({ $id: expenseId, $owner: owner }));
    });
    if (db.isTransaction) return write(input.encodedDocumentBlob);
    return withDocumentBlobWritePreflightSync(db, {
      owner,
      content,
      encoded: input.encodedDocumentBlob,
    }, write);
  }

  function getAttachmentContent(id, { owner } = {}) {
    assertDocumentBlobReadOutsideTransaction(db);
    const normalizedOwner = requiredText(owner, "owner", 200);
    const row = db.prepare(`
      SELECT a.id, a.file_name, a.media_type, a.size_bytes, a.document_blob_id,
             b.encoding, b.original_size_bytes, b.stored_size_bytes, b.sha256, b.content_blob
      FROM travel_expense_attachments a
      JOIN travel_expenses e ON e.id = a.expense_id
      JOIN document_blobs b ON b.id = a.document_blob_id AND b.owner = e.owner
      WHERE a.id = $id AND e.owner = $owner AND e.deleted_at IS NULL
    `).get({ $id: requiredText(id, "id", 200), $owner: normalizedOwner });
    if (!row) return null;
    const sizeBytes = Number(row.size_bytes);
    const originalSizeBytes = Number(row.original_size_bytes);
    if (sizeBytes !== originalSizeBytes) {
      throw new DocumentBlobIntegrityError("Attachment and stored document lengths do not match");
    }
    const content = decodeDocumentBlob({
      encoding: row.encoding,
      originalSizeBytes,
      storedSizeBytes: Number(row.stored_size_bytes),
      sha256: row.sha256,
      content: row.content_blob,
    });
    if (row.document_blob_id !== documentBlobId(normalizedOwner, row.sha256)) {
      throw new DocumentBlobIntegrityError("Attachment document content address does not match its SHA-256");
    }
    return {
      id: row.id,
      fileName: row.file_name,
      mediaType: row.media_type,
      sizeBytes,
      content,
    };
  }

  function deleteAttachment(id, input = {}) {
    const attachmentId = requiredText(id, "id", 200);
    const { owner, actor } = ownerAndActor(input);
    const version = positiveVersion(input.expectedVersion);
    const now = nowIso(clock);
    return runTransaction(db, () => {
      const row = db.prepare(`
        SELECT a.expense_id, a.document_blob_id
        FROM travel_expense_attachments a
        JOIN travel_expenses e ON e.id = a.expense_id
        WHERE a.id = $id AND e.owner = $owner AND e.deleted_at IS NULL
      `).get({ $id: attachmentId, $owner: owner });
      if (!row) throw new TravelExpenseNotFoundError("Attachment was not found");
      bumpExpenseVersion(row.expense_id, owner, actor, version, now);
      db.prepare("DELETE FROM travel_expense_attachments WHERE id = $id").run({ $id: attachmentId });
      deleteDocumentBlobIfUnreferenced(db, { id: row.document_blob_id, owner });
      return hydrateExpense(anyExpense.get({ $id: row.expense_id, $owner: owner }));
    });
  }

  const activeAdvance = db.prepare(
    "SELECT * FROM travel_expense_advances WHERE id = $id AND owner = $owner AND deleted_at IS NULL",
  );
  const anyAdvance = db.prepare("SELECT * FROM travel_expense_advances WHERE id = $id AND owner = $owner");

  function advanceMutationFailure(id, owner) {
    const current = anyAdvance.get({ $id: id, $owner: owner });
    if (!current || current.deleted_at) throw new TravelExpenseNotFoundError("Travel expense advance was not found");
    throw new TravelExpenseVersionConflictError(Number(current.version));
  }

  function listAdvances({ owner, weekStart } = {}) {
    return db.prepare(`
      SELECT * FROM travel_expense_advances
      WHERE owner = $owner AND week_start = $weekStart AND deleted_at IS NULL
      ORDER BY created_at, id
    `).all({
      $owner: requiredText(owner, "owner", 200),
      $weekStart: dateOnly(weekStart, "weekStart", { monday: true }),
    }).map(advanceFromRow);
  }

  function createAdvance(input = {}) {
    const normalized = normalizeAdvance(input);
    const id = generatedId(idFactory, "generated advance id");
    const now = nowIso(clock);
    db.prepare(`
      INSERT INTO travel_expense_advances (
        id, owner, week_start, status, requested_cents, received_cents, requested_on,
        received_on, purpose, notes, created_by, updated_by, created_at, updated_at
      ) VALUES (
        $id, $owner, $weekStart, $status, $requestedCents, $receivedCents, $requestedOn,
        $receivedOn, $purpose, $notes, $actor, $actor, $now, $now
      )
    `).run({
      $id: id,
      $owner: normalized.owner,
      $weekStart: normalized.weekStart,
      $status: normalized.status,
      $requestedCents: normalized.requestedCents,
      $receivedCents: normalized.receivedCents,
      $requestedOn: normalized.requestedOn,
      $receivedOn: normalized.receivedOn,
      $purpose: normalized.purpose,
      $notes: normalized.notes,
      $actor: normalized.actor,
      $now: now,
    });
    return advanceFromRow(anyAdvance.get({ $id: id, $owner: normalized.owner }));
  }

  function updateAdvance(id, input = {}) {
    const advanceId = requiredText(id, "id", 200);
    const normalized = normalizeAdvance(input);
    const version = positiveVersion(input.expectedVersion);
    const now = nowIso(clock);
    const result = db.prepare(`
      UPDATE travel_expense_advances
      SET week_start = $weekStart, status = $status, requested_cents = $requestedCents,
          received_cents = $receivedCents, requested_on = $requestedOn, received_on = $receivedOn,
          purpose = $purpose, notes = $notes, updated_by = $actor, updated_at = $now,
          version = version + 1
      WHERE id = $id AND owner = $owner AND version = $expectedVersion AND deleted_at IS NULL
    `).run({
      $id: advanceId,
      $owner: normalized.owner,
      $expectedVersion: version,
      $weekStart: normalized.weekStart,
      $status: normalized.status,
      $requestedCents: normalized.requestedCents,
      $receivedCents: normalized.receivedCents,
      $requestedOn: normalized.requestedOn,
      $receivedOn: normalized.receivedOn,
      $purpose: normalized.purpose,
      $notes: normalized.notes,
      $actor: normalized.actor,
      $now: now,
    });
    if (result.changes !== 1) advanceMutationFailure(advanceId, normalized.owner);
    return advanceFromRow(anyAdvance.get({ $id: advanceId, $owner: normalized.owner }));
  }

  function softDeleteAdvance(id, input = {}) {
    const advanceId = requiredText(id, "id", 200);
    const { owner, actor } = ownerAndActor(input);
    const version = positiveVersion(input.expectedVersion);
    const now = nowIso(clock);
    const result = db.prepare(`
      UPDATE travel_expense_advances
      SET deleted_at = $now, deleted_by = $actor, updated_by = $actor,
          updated_at = $now, version = version + 1
      WHERE id = $id AND owner = $owner AND version = $expectedVersion AND deleted_at IS NULL
    `).run({ $id: advanceId, $owner: owner, $expectedVersion: version, $actor: actor, $now: now });
    if (result.changes !== 1) advanceMutationFailure(advanceId, owner);
    return advanceFromRow(anyAdvance.get({ $id: advanceId, $owner: owner }));
  }

  return {
    addAttachment,
    createAdvance,
    createExpense,
    deleteAttachment,
    getAttachmentContent,
    getExpense,
    listAdvances,
    listExpenses,
    softDeleteAdvance,
    softDeleteExpense,
    updateAdvance,
    updateExpense,
  };
}
