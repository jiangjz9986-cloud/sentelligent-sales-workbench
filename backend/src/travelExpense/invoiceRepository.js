import { randomUUID } from "node:crypto";

import { withImmediateTransaction } from "../db/transaction.js";
import {
  decodeDocumentBlob,
  documentBlobId,
  DocumentBlobIntegrityError,
} from "./documentBlobCodec.js";
import {
  assertDocumentBlobReadOutsideTransaction,
  putDocumentBlob,
  withDocumentBlobWritePreflightSync,
} from "./documentBlobStore.js";
import { inspectInvoiceFile } from "./invoiceRecognition.js";
import { chooseBestInvoiceReplacement } from "./invoiceReplacement.js";

const SOURCES = new Set(["manual", "weixin"]);
const STATUSES = new Set(["received", "processing", "review_required", "unmatched", "matched", "rejected"]);
const CATEGORIES = new Set(["breakfast", "lunch", "dinner", "lodging", "transport", "hospitality", "other"]);
const MATCH_METHODS = new Set(["manual_code", "manual_selection", "rule_candidate"]);
const MATCH_STATES = new Set(["suggested", "confirmed", "rejected", "revoked"]);
const CANDIDATE_STATUSES = new Set(["suggested", "accepted", "rejected", "expired"]);
const FIELD_KEYS = new Set([
  "invoiceCode",
  "invoiceNumber",
  "issuedOn",
  "sellerName",
  "buyerName",
  "amountExTaxCents",
  "taxCents",
  "totalCents",
  "suggestedCategory",
]);

export class InvoiceNotFoundError extends Error {
  constructor(message = "Invoice was not found") {
    super(message);
    this.name = "InvoiceNotFoundError";
    this.code = "NOT_FOUND";
  }
}

export class InvoiceVersionConflictError extends Error {
  constructor(currentVersion) {
    super("Invoice was updated by another request");
    this.name = "InvoiceVersionConflictError";
    this.code = "VERSION_CONFLICT";
    this.currentVersion = currentVersion;
  }
}

export class InvoiceDuplicateError extends Error {
  constructor(existingInvoiceId) {
    super("The same invoice file has already been uploaded");
    this.name = "InvoiceDuplicateError";
    this.code = "DUPLICATE_INVOICE";
    this.existingInvoiceId = existingInvoiceId;
  }
}

export class InvoiceMatchConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InvoiceMatchConflictError";
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

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("expectedVersion must be a positive integer");
  return value;
}

function dateOnly(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${name} must use YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${name} must be a real calendar date`);
  }
  return value;
}

function nullableCents(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function positiveCents(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function mondayDate(value, name = "weekStart") {
  const normalized = dateOnly(value, name);
  if (new Date(`${normalized}T00:00:00.000Z`).getUTCDay() !== 1) {
    throw new TypeError(`${name} must be a Monday`);
  }
  return normalized;
}

function optionalMondayDate(value, name = "weekStart") {
  if (value === undefined || value === null || value === "") return null;
  return mondayDate(value, name);
}

function calendarDayDistance(first, second) {
  return Math.abs(
    Date.parse(`${first}T00:00:00.000Z`) - Date.parse(`${second}T00:00:00.000Z`),
  ) / 86_400_000;
}

function nowIso(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid Date");
  return value.toISOString();
}

function generatedId(idFactory) {
  return requiredText(idFactory(), "generated invoice id", 200);
}

function runTransaction(db, work) {
  return db.isTransaction ? work() : withImmediateTransaction(db, work);
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Stored invoice recognition JSON is invalid");
  }
}

function ownerAndActor(input) {
  const actor = requiredText(input.actor, "actor", 200);
  const owner = requiredText(input.owner ?? actor, "owner", 200);
  if (owner !== actor) throw new TypeError("owner must match actor for a personal invoice record");
  return { actor, owner };
}

function normalizeFields(value = {}, { requireKnownOnly = false } = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("fields must be an object");
  }
  if (requireKnownOnly) {
    for (const key of Object.keys(value)) {
      if (!FIELD_KEYS.has(key)) throw new TypeError(`${key} is not an invoice field`);
    }
  }
  return {
    invoiceCode: optionalText(value.invoiceCode, "invoiceCode", 100),
    invoiceNumber: optionalText(value.invoiceNumber, "invoiceNumber", 100),
    issuedOn: dateOnly(value.issuedOn, "issuedOn"),
    sellerName: optionalText(value.sellerName, "sellerName", 500),
    buyerName: optionalText(value.buyerName, "buyerName", 500),
    amountExTaxCents: nullableCents(value.amountExTaxCents, "amountExTaxCents"),
    taxCents: nullableCents(value.taxCents, "taxCents"),
    totalCents: nullableCents(value.totalCents, "totalCents"),
    suggestedCategory: value.suggestedCategory === undefined || value.suggestedCategory === null || value.suggestedCategory === ""
      ? null
      : enumValue(value.suggestedCategory, CATEGORIES, "suggestedCategory"),
  };
}

function normalizeRecognition(value = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("recognition must be an object");
  }
  const status = enumValue(value.status, new Set(["received", "review_required", "unmatched"]), "recognition.status", "received");
  const conflicts = value.conflicts ?? [];
  if (!Array.isArray(conflicts)) throw new TypeError("recognition.conflicts must be an array");
  return {
    status,
    extractedText: optionalText(value.extractedText, "recognition.extractedText", 200_000),
    ocr: value.ocr ?? null,
    model: value.model ?? null,
    conflicts,
    fields: normalizeFields(value.fields ?? {}),
  };
}

function fromRow(row) {
  if (!row) return null;
  const item = {
    id: row.id,
    version: Number(row.version),
    owner: row.owner,
    source: row.source,
    sourceRef: row.source_ref,
    fileName: row.file_name,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    status: row.status,
    extractedText: row.extracted_text,
    ocr: parseJson(row.ocr_json, null),
    model: parseJson(row.model_json, null),
    conflicts: parseJson(row.conflict_json, []),
    invoiceCode: row.invoice_code,
    invoiceNumber: row.invoice_number,
    issuedOn: row.issued_on,
    sellerName: row.seller_name,
    buyerName: row.buyer_name,
    amountExTaxCents: row.amount_ex_tax_cents === null ? null : Number(row.amount_ex_tax_cents),
    taxCents: row.tax_cents === null ? null : Number(row.tax_cents),
    totalCents: row.total_cents === null ? null : Number(row.total_cents),
    suggestedCategory: row.suggested_category,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentUrl: `/api/invoices/${encodeURIComponent(row.id)}/content`,
  };
  if (row.deleted_at) {
    item.deletedAt = row.deleted_at;
    item.deletedBy = row.deleted_by;
  }
  return item;
}

function matchFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version),
    owner: row.owner,
    invoiceId: row.invoice_id,
    expenseId: row.expense_id,
    paymentId: row.payment_id,
    allocatedCents: Number(row.allocated_cents),
    matchMethod: row.match_method,
    state: row.state,
    score: row.score === null ? null : Number(row.score),
    rationale: parseJson(row.rationale_json, []),
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function noInvoiceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version),
    owner: row.owner,
    expenseId: row.expense_id,
    paymentId: row.payment_id,
    amountSnapshotCents: Number(row.amount_snapshot_cents),
    reason: row.reason,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function candidateFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version),
    owner: row.owner,
    weekStart: row.week_start,
    invoiceId: row.invoice_id,
    expenseId: row.expense_id,
    paymentId: row.payment_id,
    proposedCents: Number(row.proposed_cents),
    score: Number(row.score),
    rationale: parseJson(row.rationale_json, []),
    status: row.status,
    acceptedMatchId: row.accepted_match_id,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createInvoiceRepository(db, {
  idFactory = randomUUID,
  matchIdFactory = randomUUID,
  confirmationIdFactory = randomUUID,
  candidateIdFactory = randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof matchIdFactory !== "function") throw new TypeError("matchIdFactory must be a function");
  if (typeof confirmationIdFactory !== "function") throw new TypeError("confirmationIdFactory must be a function");
  if (typeof candidateIdFactory !== "function") throw new TypeError("candidateIdFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const activeInvoice = db.prepare(
    "SELECT * FROM invoice_documents WHERE id = $id AND owner = $owner AND deleted_at IS NULL",
  );
  const anyInvoice = db.prepare("SELECT * FROM invoice_documents WHERE id = $id AND owner = $owner");

  function getInvoice(id, { owner } = {}) {
    return fromRow(activeInvoice.get({
      $id: requiredText(id, "id", 200),
      $owner: requiredText(owner, "owner", 200),
    }));
  }

  function listInvoices({ owner, status } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedStatus = status === undefined || status === null || status === ""
      ? null
      : enumValue(status, STATUSES, "status");
    return db.prepare(`
      SELECT * FROM invoice_documents
      WHERE owner = $owner
        AND deleted_at IS NULL
        AND ($status IS NULL OR status = $status)
      ORDER BY issued_on DESC, created_at DESC, id DESC
    `).all({ $owner: normalizedOwner, $status: normalizedStatus }).map(fromRow);
  }

  function createInvoice(input = {}) {
    const { owner, actor } = ownerAndActor(input);
    const source = enumValue(input.source, SOURCES, "source", "manual");
    const sourceRef = optionalText(input.sourceRef, "sourceRef", 500);
    const inspected = inspectInvoiceFile({
      fileName: input.fileName,
      mediaType: input.mediaType,
      buffer: input.content,
    });
    const recognition = normalizeRecognition(input.recognition ?? {});
    const timestamp = nowIso(clock);
    const write = (encodedDocumentBlob) => runTransaction(db, () => {
      const existing = db.prepare(
        "SELECT id, version, deleted_at FROM invoice_documents WHERE owner = $owner AND sha256 = $sha256",
      ).get({ $owner: owner, $sha256: inspected.sha256 });
      if (existing && !existing.deleted_at) throw new InvoiceDuplicateError(existing.id);
      const documentBlob = putDocumentBlob(db, {
        owner,
        content: inspected.buffer,
        encoded: encodedDocumentBlob,
        createdAt: timestamp,
      });
      const parameters = {
        $owner: owner,
        $source: source,
        $sourceRef: sourceRef,
        $fileName: inspected.fileName,
        $mediaType: inspected.mediaType,
        $sizeBytes: inspected.sizeBytes,
        $sha256: inspected.sha256,
        $documentBlobId: documentBlob.id,
        $status: recognition.status,
        $extractedText: recognition.extractedText,
        $ocrJson: recognition.ocr === null ? null : JSON.stringify(recognition.ocr),
        $modelJson: recognition.model === null ? null : JSON.stringify(recognition.model),
        $conflictJson: JSON.stringify(recognition.conflicts),
        $invoiceCode: recognition.fields.invoiceCode,
        $invoiceNumber: recognition.fields.invoiceNumber,
        $issuedOn: recognition.fields.issuedOn,
        $sellerName: recognition.fields.sellerName,
        $buyerName: recognition.fields.buyerName,
        $amountExTaxCents: recognition.fields.amountExTaxCents,
        $taxCents: recognition.fields.taxCents,
        $totalCents: recognition.fields.totalCents,
        $suggestedCategory: recognition.fields.suggestedCategory,
        $actor: actor,
        $now: timestamp,
      };
      if (existing?.deleted_at) {
        const restored = db.prepare(`
          UPDATE invoice_documents
          SET source = $source, source_ref = $sourceRef,
              file_name = $fileName, media_type = $mediaType,
              size_bytes = $sizeBytes, sha256 = $sha256, document_blob_id = $documentBlobId,
              status = $status, extracted_text = $extractedText,
              ocr_json = $ocrJson, model_json = $modelJson, conflict_json = $conflictJson,
              invoice_code = $invoiceCode, invoice_number = $invoiceNumber, issued_on = $issuedOn,
              seller_name = $sellerName, buyer_name = $buyerName,
              amount_ex_tax_cents = $amountExTaxCents, tax_cents = $taxCents,
              total_cents = $totalCents, suggested_category = $suggestedCategory,
              deleted_at = NULL, deleted_by = NULL,
              updated_by = $actor, updated_at = $now, version = version + 1
          WHERE id = $id AND owner = $owner AND version = $expectedVersion
            AND deleted_at IS NOT NULL
        `).run({
          ...parameters,
          $id: existing.id,
          $expectedVersion: Number(existing.version),
        });
        if (restored.changes !== 1) {
          const current = anyInvoice.get({ $id: existing.id, $owner: owner });
          if (current && !current.deleted_at) throw new InvoiceDuplicateError(existing.id);
          throw new InvoiceVersionConflictError(Number(current?.version ?? existing.version));
        }
        return fromRow(anyInvoice.get({ $id: existing.id, $owner: owner }));
      }

      const id = generatedId(idFactory);
      try {
        db.prepare(`
          INSERT INTO invoice_documents (
            id, owner, source, source_ref, file_name, media_type, size_bytes, sha256,
            document_blob_id, status, extracted_text, ocr_json, model_json, conflict_json,
            invoice_code, invoice_number, issued_on, seller_name, buyer_name,
            amount_ex_tax_cents, tax_cents, total_cents, suggested_category,
            created_by, updated_by, created_at, updated_at
          ) VALUES (
            $id, $owner, $source, $sourceRef, $fileName, $mediaType, $sizeBytes, $sha256,
            $documentBlobId, $status, $extractedText, $ocrJson, $modelJson, $conflictJson,
            $invoiceCode, $invoiceNumber, $issuedOn, $sellerName, $buyerName,
            $amountExTaxCents, $taxCents, $totalCents, $suggestedCategory,
            $actor, $actor, $now, $now
          )
        `).run({
          ...parameters,
          $id: id,
        });
      } catch (error) {
        if (/UNIQUE constraint failed: invoice_documents\.owner, invoice_documents\.sha256/i.test(String(error?.message))) {
          const duplicate = db.prepare(
            "SELECT id FROM invoice_documents WHERE owner = $owner AND sha256 = $sha256",
          ).get({ $owner: owner, $sha256: inspected.sha256 });
          if (duplicate) throw new InvoiceDuplicateError(duplicate.id);
        }
        throw error;
      }
      return fromRow(anyInvoice.get({ $id: id, $owner: owner }));
    });
    if (db.isTransaction) return write(input.encodedDocumentBlob);
    return withDocumentBlobWritePreflightSync(db, {
      owner,
      content: inspected.buffer,
      encoded: input.encodedDocumentBlob,
    }, write);
  }

  function currentOrFailure(id, owner, expectedVersion) {
    const current = anyInvoice.get({ $id: id, $owner: owner });
    if (!current || current.deleted_at) throw new InvoiceNotFoundError();
    if (Number(current.version) !== expectedVersion) {
      throw new InvoiceVersionConflictError(Number(current.version));
    }
    return current;
  }

  function assertInvoiceHasNoActiveMatches(id, owner) {
    const activeMatch = db.prepare(`
      SELECT 1
      FROM invoice_matches
      WHERE invoice_id = $id AND owner = $owner
        AND state IN ('suggested', 'confirmed')
      LIMIT 1
    `).get({ $id: id, $owner: owner });
    if (activeMatch) {
      throw new InvoiceMatchConflictError(
        "INVOICE_HAS_ACTIVE_MATCHES",
        "Revoke or reject active invoice matches before changing or deleting the invoice",
      );
    }
    const activeCandidate = db.prepare(`
      SELECT 1
      FROM invoice_match_candidates
      WHERE invoice_id = $id AND owner = $owner AND status = 'suggested'
      LIMIT 1
    `).get({ $id: id, $owner: owner });
    if (activeCandidate) {
      throw new InvoiceMatchConflictError(
        "INVOICE_HAS_ACTIVE_CANDIDATES",
        "Reject or regenerate active invoice candidates before changing or deleting the invoice",
      );
    }
  }

  function finalizeReview(idValue, input = {}) {
    const id = requiredText(idValue, "id", 200);
    const { owner, actor } = ownerAndActor(input);
    const expectedVersion = positiveVersion(input.expectedVersion);
    const fields = normalizeFields(input.fields, { requireKnownOnly: true });
    const timestamp = nowIso(clock);
    return runTransaction(db, () => {
      currentOrFailure(id, owner, expectedVersion);
      assertInvoiceHasNoActiveMatches(id, owner);
      const result = db.prepare(`
        UPDATE invoice_documents
        SET status = 'unmatched', conflict_json = '[]',
            invoice_code = $invoiceCode, invoice_number = $invoiceNumber, issued_on = $issuedOn,
            seller_name = $sellerName, buyer_name = $buyerName,
            amount_ex_tax_cents = $amountExTaxCents, tax_cents = $taxCents,
            total_cents = $totalCents, suggested_category = $suggestedCategory,
            updated_by = $actor, updated_at = $now, version = version + 1
        WHERE id = $id AND owner = $owner AND version = $expectedVersion AND deleted_at IS NULL
      `).run({
        $id: id,
        $owner: owner,
        $expectedVersion: expectedVersion,
        $invoiceCode: fields.invoiceCode,
        $invoiceNumber: fields.invoiceNumber,
        $issuedOn: fields.issuedOn,
        $sellerName: fields.sellerName,
        $buyerName: fields.buyerName,
        $amountExTaxCents: fields.amountExTaxCents,
        $taxCents: fields.taxCents,
        $totalCents: fields.totalCents,
        $suggestedCategory: fields.suggestedCategory,
        $actor: actor,
        $now: timestamp,
      });
      if (result.changes !== 1) currentOrFailure(id, owner, expectedVersion);
      return fromRow(anyInvoice.get({ $id: id, $owner: owner }));
    });
  }

  function getInvoiceContent(id, { owner } = {}) {
    assertDocumentBlobReadOutsideTransaction(db);
    const normalizedOwner = requiredText(owner, "owner", 200);
    const row = db.prepare(`
      SELECT i.id, i.file_name, i.media_type, i.size_bytes, i.sha256, i.document_blob_id,
              b.encoding, b.original_size_bytes, b.stored_size_bytes,
              b.sha256 AS blob_sha256, b.content_blob
      FROM invoice_documents i
      JOIN document_blobs b ON b.id = i.document_blob_id AND b.owner = i.owner
      WHERE i.id = $id AND i.owner = $owner AND i.deleted_at IS NULL
    `).get({
      $id: requiredText(id, "id", 200),
      $owner: normalizedOwner,
    });
    if (!row) return null;
    const sizeBytes = Number(row.size_bytes);
    const originalSizeBytes = Number(row.original_size_bytes);
    if (sizeBytes !== originalSizeBytes) {
      throw new DocumentBlobIntegrityError("Invoice and stored document lengths do not match");
    }
    if (row.sha256 !== row.blob_sha256) {
      throw new DocumentBlobIntegrityError("Invoice and stored document SHA-256 values do not match");
    }
    if (row.document_blob_id !== documentBlobId(normalizedOwner, row.blob_sha256)) {
      throw new DocumentBlobIntegrityError("Invoice document content address does not match its SHA-256");
    }
    return {
      id: row.id,
      fileName: row.file_name,
      mediaType: row.media_type,
      sizeBytes,
      sha256: row.sha256,
      content: decodeDocumentBlob({
        encoding: row.encoding,
        originalSizeBytes,
        storedSizeBytes: Number(row.stored_size_bytes),
        sha256: row.blob_sha256,
        content: row.content_blob,
      }),
    };
  }

  function softDeleteInvoice(idValue, input = {}) {
    const id = requiredText(idValue, "id", 200);
    const { owner, actor } = ownerAndActor(input);
    const expectedVersion = positiveVersion(input.expectedVersion);
    const timestamp = nowIso(clock);
    return runTransaction(db, () => {
      currentOrFailure(id, owner, expectedVersion);
      assertInvoiceHasNoActiveMatches(id, owner);
      const result = db.prepare(`
        UPDATE invoice_documents
        SET status = 'rejected', deleted_at = $now, deleted_by = $actor,
            updated_at = $now, updated_by = $actor, version = version + 1
        WHERE id = $id AND owner = $owner AND version = $expectedVersion AND deleted_at IS NULL
      `).run({
        $id: id,
        $owner: owner,
        $expectedVersion: expectedVersion,
        $actor: actor,
        $now: timestamp,
      });
      if (result.changes !== 1) currentOrFailure(id, owner, expectedVersion);
      return fromRow(anyInvoice.get({ $id: id, $owner: owner }));
    });
  }

  function activeExpenseById(id, owner) {
    return db.prepare(`
      SELECT * FROM travel_expenses
      WHERE id = $id AND owner = $owner AND deleted_at IS NULL
    `).get({ $id: id, $owner: owner });
  }

  function expenseByReference(referenceCode, owner) {
    return db.prepare(`
      SELECT * FROM travel_expenses
      WHERE reference_code = $referenceCode AND owner = $owner AND deleted_at IS NULL
    `).get({ $referenceCode: referenceCode, $owner: owner });
  }

  function expenseReimbursementCents(expenseId) {
    return Number(db.prepare(`
      SELECT COALESCE(SUM(reimbursement_cents), 0) AS total
      FROM travel_expense_payments
      WHERE expense_id = $expenseId
    `).get({ $expenseId: expenseId }).total);
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

  function confirmedInvoiceCoverageCents(invoiceId) {
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
      WHERE match.invoice_id = $invoiceId AND match.state = 'confirmed'
    `).get({ $invoiceId: invoiceId }).total);
  }

  function refreshExpenseInvoiceStatus(expenseId, owner, actor, timestamp) {
    const reimbursement = expenseReimbursementCents(expenseId);
    const confirmed = confirmedExpenseCoverageCents(expenseId);
    const noInvoiceCount = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM travel_expense_no_invoice_confirmations
      WHERE expense_id = $expenseId AND revoked_at IS NULL
    `).get({ $expenseId: expenseId }).count);
    const status = reimbursement > 0 && confirmed >= reimbursement
      ? "covered"
      : confirmed > 0
        ? "partial"
        : noInvoiceCount > 0
          ? "missing"
          : "pending";
    db.prepare(`
      UPDATE travel_expenses
      SET invoice_status = $status, updated_by = $actor, updated_at = $now, version = version + 1
      WHERE id = $id AND owner = $owner AND deleted_at IS NULL
    `).run({ $status: status, $actor: actor, $now: timestamp, $id: expenseId, $owner: owner });
  }

  function refreshInvoiceStatus(invoiceId, owner, actor, timestamp, expectedVersion) {
    const invoice = activeInvoice.get({ $id: invoiceId, $owner: owner });
    if (!invoice) return;
    const normalizedExpectedVersion = positiveVersion(expectedVersion);
    if (Number(invoice.version) !== normalizedExpectedVersion) {
      throw new InvoiceVersionConflictError(Number(invoice.version));
    }
    const total = invoice.total_cents === null ? null : Number(invoice.total_cents);
    const confirmed = confirmedInvoiceCoverageCents(invoiceId);
    const status = total !== null && total > 0 && confirmed >= total ? "matched" : "unmatched";
    const updated = db.prepare(`
      UPDATE invoice_documents
      SET status = $status, updated_by = $actor, updated_at = $now, version = version + 1
      WHERE id = $id AND owner = $owner AND version = $expectedVersion AND deleted_at IS NULL
    `).run({
      $status: status,
      $actor: actor,
      $now: timestamp,
      $id: invoiceId,
      $owner: owner,
      $expectedVersion: normalizedExpectedVersion,
    });
    if (updated.changes !== 1) {
      currentOrFailure(invoiceId, owner, normalizedExpectedVersion);
    }
  }

  function createConfirmedMatch(input = {}) {
    const { owner, actor } = ownerAndActor(input);
    const invoiceId = requiredText(input.invoiceId, "invoiceId", 200);
    const referenceCode = requiredText(input.expenseReferenceCode, "expenseReferenceCode", 200);
    const paymentId = optionalText(input.paymentId, "paymentId", 200);
    const allocatedCents = positiveCents(input.allocatedCents, "allocatedCents");
    const matchMethod = enumValue(input.matchMethod, MATCH_METHODS, "matchMethod", "manual_selection");
    const expectedInvoiceVersion = positiveVersion(input.expectedInvoiceVersion);
    const timestamp = nowIso(clock);

    return runTransaction(db, () => {
      const invoice = currentOrFailure(invoiceId, owner, expectedInvoiceVersion);
      if (invoice.total_cents === null || Number(invoice.total_cents) <= 0) {
        throw new InvoiceMatchConflictError("INVOICE_TOTAL_REQUIRED", "Invoice total must be confirmed before matching");
      }
      const expense = expenseByReference(referenceCode, owner);
      if (!expense) throw new InvoiceNotFoundError("Expense reference code was not found");

      let payment = null;
      if (paymentId) {
        payment = db.prepare(`
          SELECT * FROM travel_expense_payments
          WHERE id = $id AND expense_id = $expenseId
        `).get({ $id: paymentId, $expenseId: expense.id });
        if (!payment) throw new InvoiceNotFoundError("Payment was not found for the expense");
      }

      const duplicate = db.prepare(`
        SELECT id FROM invoice_matches
        WHERE invoice_id = $invoiceId AND expense_id = $expenseId
          AND (($paymentId IS NULL AND payment_id IS NULL) OR payment_id = $paymentId)
          AND state IN ('suggested', 'confirmed')
      `).get({ $invoiceId: invoiceId, $expenseId: expense.id, $paymentId: paymentId });
      if (duplicate) {
        throw new InvoiceMatchConflictError("MATCH_ALREADY_EXISTS", "An active invoice match already exists");
      }

      const invoiceRemaining = Number(invoice.total_cents) - confirmedInvoiceCoverageCents(invoiceId);
      if (allocatedCents > invoiceRemaining) {
        throw new InvoiceMatchConflictError("INVOICE_COVERAGE_EXCEEDED", "Allocated amount exceeds the invoice remainder");
      }
      const expenseRemaining = expenseReimbursementCents(expense.id) - confirmedExpenseCoverageCents(expense.id);
      if (allocatedCents > expenseRemaining) {
        throw new InvoiceMatchConflictError("EXPENSE_COVERAGE_EXCEEDED", "Allocated amount exceeds the expense remainder");
      }
      if (payment) {
        const paymentRemaining = Number(payment.reimbursement_cents) - confirmedPaymentCoverageCents(payment.id);
        if (allocatedCents > paymentRemaining) {
          throw new InvoiceMatchConflictError("EXPENSE_COVERAGE_EXCEEDED", "Allocated amount exceeds the payment remainder");
        }
      }

      const id = generatedId(matchIdFactory);
      db.prepare(`
        INSERT INTO invoice_matches (
          id, owner, invoice_id, expense_id, payment_id, allocated_cents,
          match_method, state, score, rationale_json, confirmed_by, confirmed_at,
          created_by, created_at, updated_at
        ) VALUES (
          $id, $owner, $invoiceId, $expenseId, $paymentId, $allocatedCents,
          $matchMethod, 'confirmed', NULL, '[]', $actor, $now,
          $actor, $now, $now
        )
      `).run({
        $id: id,
        $owner: owner,
        $invoiceId: invoiceId,
        $expenseId: expense.id,
        $paymentId: paymentId,
        $allocatedCents: allocatedCents,
        $matchMethod: matchMethod,
        $actor: actor,
        $now: timestamp,
      });
      refreshInvoiceStatus(invoiceId, owner, actor, timestamp, expectedInvoiceVersion);
      refreshExpenseInvoiceStatus(expense.id, owner, actor, timestamp);
      return matchFromRow(db.prepare("SELECT * FROM invoice_matches WHERE id = $id").get({ $id: id }));
    });
  }

  function listMatches({ owner, weekStart, invoiceId, expenseId, state } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedWeekStart = optionalMondayDate(weekStart);
    const normalizedInvoiceId = optionalText(invoiceId, "invoiceId", 200);
    const normalizedExpenseId = optionalText(expenseId, "expenseId", 200);
    const normalizedState = state === undefined || state === null || state === ""
      ? null
      : enumValue(state, MATCH_STATES, "state");
    return db.prepare(`
      SELECT match.*
      FROM invoice_matches match
      JOIN travel_expenses expense
        ON expense.id = match.expense_id
       AND expense.owner = match.owner
       AND expense.deleted_at IS NULL
      JOIN invoice_documents invoice
        ON invoice.id = match.invoice_id
       AND invoice.owner = match.owner
       AND invoice.deleted_at IS NULL
      WHERE match.owner = $owner
        AND ($weekStart IS NULL OR expense.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days'))
        AND ($invoiceId IS NULL OR match.invoice_id = $invoiceId)
        AND ($expenseId IS NULL OR match.expense_id = $expenseId)
        AND ($state IS NULL OR match.state = $state)
      ORDER BY match.created_at, match.id
    `).all({
      $owner: normalizedOwner,
      $weekStart: normalizedWeekStart,
      $invoiceId: normalizedInvoiceId,
      $expenseId: normalizedExpenseId,
      $state: normalizedState,
    }).map(matchFromRow);
  }

  function revokeMatch(idValue, input = {}) {
    const id = requiredText(idValue, "id", 200);
    const { owner, actor } = ownerAndActor(input);
    const expectedVersion = positiveVersion(input.expectedVersion);
    const timestamp = nowIso(clock);
    return runTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM invoice_matches WHERE id = $id AND owner = $owner
      `).get({ $id: id, $owner: owner });
      if (!current) throw new InvoiceNotFoundError("Invoice match was not found");
      if (Number(current.version) !== expectedVersion) {
        throw new InvoiceVersionConflictError(Number(current.version));
      }
      if (current.state === "revoked") return matchFromRow(current);
      const invoice = activeInvoice.get({ $id: current.invoice_id, $owner: owner });
      if (!invoice) throw new InvoiceNotFoundError();
      db.prepare(`
        UPDATE invoice_matches
        SET state = 'revoked', revoked_by = $actor, revoked_at = $now,
            updated_at = $now, version = version + 1
        WHERE id = $id AND owner = $owner AND version = $expectedVersion
      `).run({ $id: id, $owner: owner, $expectedVersion: expectedVersion, $actor: actor, $now: timestamp });
      refreshInvoiceStatus(current.invoice_id, owner, actor, timestamp, Number(invoice.version));
      refreshExpenseInvoiceStatus(current.expense_id, owner, actor, timestamp);
      return matchFromRow(db.prepare("SELECT * FROM invoice_matches WHERE id = $id").get({ $id: id }));
    });
  }

  function listNoInvoiceConfirmations({
    owner,
    weekStart,
    expenseId,
    paymentId,
    active,
  } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedWeekStart = optionalMondayDate(weekStart);
    const normalizedExpenseId = optionalText(expenseId, "expenseId", 200);
    const normalizedPaymentId = optionalText(paymentId, "paymentId", 200);
    if (active !== undefined && active !== null && typeof active !== "boolean") {
      throw new TypeError("active must be a boolean");
    }
    const normalizedActive = active === undefined || active === null ? null : active ? 1 : 0;
    return db.prepare(`
      SELECT confirmation.*
      FROM travel_expense_no_invoice_confirmations confirmation
      JOIN travel_expenses expense ON expense.id = confirmation.expense_id
      WHERE confirmation.owner = $owner
        AND ($weekStart IS NULL OR expense.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days'))
        AND ($expenseId IS NULL OR confirmation.expense_id = $expenseId)
        AND ($paymentId IS NULL OR confirmation.payment_id = $paymentId)
        AND (
          $active IS NULL
          OR ($active = 1 AND confirmation.revoked_at IS NULL)
          OR ($active = 0 AND confirmation.revoked_at IS NOT NULL)
        )
      ORDER BY confirmation.created_at, confirmation.id
    `).all({
      $owner: normalizedOwner,
      $weekStart: normalizedWeekStart,
      $expenseId: normalizedExpenseId,
      $paymentId: normalizedPaymentId,
      $active: normalizedActive,
    }).map(noInvoiceFromRow);
  }

  function confirmNoInvoice(input = {}) {
    const { owner, actor } = ownerAndActor(input);
    const expenseId = requiredText(input.expenseId, "expenseId", 200);
    const paymentId = optionalText(input.paymentId, "paymentId", 200);
    const reason = requiredText(input.reason, "reason", 1000);
    const timestamp = nowIso(clock);
    return runTransaction(db, () => {
      const expense = activeExpenseById(expenseId, owner);
      if (!expense) throw new InvoiceNotFoundError("Expense was not found");
      let payment = null;
      if (paymentId) {
        payment = db.prepare(`
          SELECT * FROM travel_expense_payments WHERE id = $id AND expense_id = $expenseId
        `).get({ $id: paymentId, $expenseId: expenseId });
        if (!payment) throw new InvoiceNotFoundError("Payment was not found for the expense");
      }
      const overlapping = db.prepare(`
        SELECT id FROM travel_expense_no_invoice_confirmations
        WHERE expense_id = $expenseId
          AND (payment_id IS NULL OR $paymentId IS NULL OR payment_id = $paymentId)
          AND revoked_at IS NULL
      `).get({ $expenseId: expenseId, $paymentId: paymentId });
      if (overlapping) {
        throw new InvoiceMatchConflictError(
          "NO_INVOICE_SCOPE_OVERLAP",
          "Expense-wide and payment-specific no-invoice confirmations cannot overlap",
        );
      }
      const expenseRemaining = expenseReimbursementCents(expenseId) - confirmedExpenseCoverageCents(expenseId);
      const paymentRemaining = payment
        ? Number(payment.reimbursement_cents) - confirmedPaymentCoverageCents(payment.id)
        : expenseRemaining;
      const amountSnapshotCents = Math.min(expenseRemaining, paymentRemaining);
      if (amountSnapshotCents <= 0) {
        throw new InvoiceMatchConflictError("NO_MISSING_INVOICE_AMOUNT", "No missing invoice amount remains");
      }
      const id = generatedId(confirmationIdFactory);
      db.prepare(`
        INSERT INTO travel_expense_no_invoice_confirmations (
          id, owner, expense_id, payment_id, amount_snapshot_cents, reason,
          confirmed_by, confirmed_at, created_at, updated_at
        ) VALUES (
          $id, $owner, $expenseId, $paymentId, $amountSnapshotCents, $reason,
          $actor, $now, $now, $now
        )
      `).run({
        $id: id,
        $owner: owner,
        $expenseId: expenseId,
        $paymentId: paymentId,
        $amountSnapshotCents: amountSnapshotCents,
        $reason: reason,
        $actor: actor,
        $now: timestamp,
      });
      refreshExpenseInvoiceStatus(expenseId, owner, actor, timestamp);
      return noInvoiceFromRow(db.prepare(`
        SELECT * FROM travel_expense_no_invoice_confirmations WHERE id = $id
      `).get({ $id: id }));
    });
  }

  function revokeNoInvoice(idValue, input = {}) {
    const id = requiredText(idValue, "id", 200);
    const { owner, actor } = ownerAndActor(input);
    const expectedExpenseId = input.expenseId === undefined
      ? null
      : requiredText(input.expenseId, "expenseId", 200);
    const expectedVersion = positiveVersion(input.expectedVersion);
    const timestamp = nowIso(clock);
    return runTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM travel_expense_no_invoice_confirmations
        WHERE id = $id AND owner = $owner
      `).get({ $id: id, $owner: owner });
      if (!current) throw new InvoiceNotFoundError("No-invoice confirmation was not found");
      if (expectedExpenseId && current.expense_id !== expectedExpenseId) {
        throw new InvoiceNotFoundError("No-invoice confirmation was not found");
      }
      if (Number(current.version) !== expectedVersion) {
        throw new InvoiceVersionConflictError(Number(current.version));
      }
      if (current.revoked_at) return noInvoiceFromRow(current);
      db.prepare(`
        UPDATE travel_expense_no_invoice_confirmations
        SET revoked_by = $actor, revoked_at = $now, updated_at = $now, version = version + 1
        WHERE id = $id AND owner = $owner AND version = $expectedVersion
      `).run({ $id: id, $owner: owner, $expectedVersion: expectedVersion, $actor: actor, $now: timestamp });
      refreshExpenseInvoiceStatus(current.expense_id, owner, actor, timestamp);
      return noInvoiceFromRow(db.prepare(`
        SELECT * FROM travel_expense_no_invoice_confirmations WHERE id = $id
      `).get({ $id: id }));
    });
  }

  function getWeekInvoiceCoverage({ owner, weekStart } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedWeekStart = mondayDate(weekStart);
    const expenses = db.prepare(`
      SELECT e.id, COALESCE(SUM(p.reimbursement_cents), 0) AS reimbursement_cents
      FROM travel_expenses e
      LEFT JOIN travel_expense_payments p ON p.expense_id = e.id
      WHERE e.owner = $owner AND e.deleted_at IS NULL
        AND e.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')
      GROUP BY e.id
      ORDER BY e.occurred_on, e.id
    `).all({ $owner: normalizedOwner, $weekStart: normalizedWeekStart });
    let reimbursementCents = 0;
    let confirmedCoverageCents = 0;
    let electronicInvoiceCoverageCents = 0;
    let substituteInvoiceCoverageCents = 0;
    let noInvoiceConfirmedCents = 0;
    for (const expense of expenses) {
      const reimbursement = Number(expense.reimbursement_cents);
      const methodCoverage = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN match.match_method = 'rule_candidate' THEN match.allocated_cents ELSE 0 END), 0) AS substitute_cents,
          COALESCE(SUM(CASE WHEN match.match_method <> 'rule_candidate' THEN match.allocated_cents ELSE 0 END), 0) AS electronic_cents
        FROM invoice_matches match
        JOIN invoice_documents invoice
          ON invoice.id = match.invoice_id
         AND invoice.owner = match.owner
         AND invoice.deleted_at IS NULL
        WHERE match.owner = $owner
          AND match.expense_id = $expenseId
          AND match.state = 'confirmed'
      `).get({ $owner: normalizedOwner, $expenseId: expense.id });
      const electronic = Number(methodCoverage.electronic_cents);
      const substitute = Number(methodCoverage.substitute_cents);
      const confirmed = Math.min(reimbursement, electronic + substitute);
      const missing = Math.max(0, reimbursement - confirmed);
      const acknowledged = Number(db.prepare(`
        SELECT COALESCE(SUM(amount_snapshot_cents), 0) AS total
        FROM travel_expense_no_invoice_confirmations
        WHERE expense_id = $expenseId AND revoked_at IS NULL
      `).get({ $expenseId: expense.id }).total);
      reimbursementCents += reimbursement;
      confirmedCoverageCents += confirmed;
      electronicInvoiceCoverageCents += Math.min(reimbursement, electronic);
      substituteInvoiceCoverageCents += Math.min(
        Math.max(0, reimbursement - Math.min(reimbursement, electronic)),
        substitute,
      );
      noInvoiceConfirmedCents += Math.min(missing, acknowledged);
    }
    const missingInvoiceCents = Math.max(0, reimbursementCents - confirmedCoverageCents);
    const invoiceWarehouseAvailableCents = Number(db.prepare(`
      SELECT COALESCE(SUM(
        MAX(0,
          invoice.total_cents
          - COALESCE((
              SELECT SUM(confirmed.allocated_cents)
              FROM invoice_matches confirmed
              WHERE confirmed.owner = invoice.owner
                AND confirmed.invoice_id = invoice.id
                AND confirmed.state = 'confirmed'
            ), 0)
          - COALESCE((
              SELECT SUM(candidate.proposed_cents)
              FROM invoice_match_candidates candidate
              WHERE candidate.owner = invoice.owner
                AND candidate.invoice_id = invoice.id
                AND candidate.status = 'suggested'
            ), 0)
        )
      ), 0) AS available_cents
      FROM invoice_documents invoice
      WHERE invoice.owner = $owner
        AND invoice.deleted_at IS NULL
        AND invoice.status IN ('unmatched', 'matched')
        AND invoice.total_cents > 0
    `).get({ $owner: normalizedOwner }).available_cents);
    return {
      weekStart: normalizedWeekStart,
      reimbursementCents,
      confirmedCoverageCents,
      electronicInvoiceCoverageCents,
      substituteInvoiceCoverageCents,
      missingInvoiceCents,
      noInvoiceConfirmedCents,
      unacknowledgedMissingCents: Math.max(0, missingInvoiceCents - noInvoiceConfirmedCents),
      invoiceWarehouseAvailableCents,
      expenseCount: expenses.length,
    };
  }

  function categoriesCompatible(invoiceCategory, expenseCategory) {
    if (!invoiceCategory || invoiceCategory === "other") return true;
    if (invoiceCategory === expenseCategory) return true;
    const dining = new Set(["breakfast", "lunch", "dinner", "hospitality"]);
    return dining.has(invoiceCategory) && dining.has(expenseCategory);
  }

  function generateMatchCandidates(input = {}) {
    const { owner, actor } = ownerAndActor(input);
    const weekStart = mondayDate(input.weekStart);
    const timestamp = nowIso(clock);
    return runTransaction(db, () => {
      db.prepare(`
        UPDATE invoice_match_candidates
        SET status = 'expired', updated_at = $now, version = version + 1
        WHERE owner = $owner AND week_start = $weekStart AND status = 'suggested'
      `).run({ $owner: owner, $weekStart: weekStart, $now: timestamp });

      const targets = db.prepare(`
        SELECT confirmation.expense_id, confirmation.payment_id, confirmation.amount_snapshot_cents,
               expense.occurred_on, expense.category
        FROM travel_expense_no_invoice_confirmations confirmation
        JOIN travel_expenses expense ON expense.id = confirmation.expense_id
        WHERE confirmation.owner = $owner AND confirmation.revoked_at IS NULL
          AND expense.deleted_at IS NULL
          AND expense.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')
        ORDER BY expense.occurred_on, confirmation.created_at, confirmation.id
      `).all({ $owner: owner, $weekStart: weekStart });
      const invoices = db.prepare(`
        SELECT invoice.*,
               COALESCE((
                 SELECT SUM(match.allocated_cents)
                 FROM invoice_matches match
                 WHERE match.owner = invoice.owner
                   AND match.invoice_id = invoice.id
                   AND match.state = 'confirmed'
               ), 0) AS confirmed_coverage_cents
        FROM invoice_documents invoice
        WHERE invoice.owner = $owner AND invoice.deleted_at IS NULL
          AND invoice.status = 'unmatched' AND invoice.total_cents > 0
          AND invoice.total_cents > COALESCE((
            SELECT SUM(match.allocated_cents)
            FROM invoice_matches match
            WHERE match.owner = invoice.owner
              AND match.invoice_id = invoice.id
              AND match.state = 'confirmed'
          ), 0)
          AND NOT EXISTS (
            SELECT 1
            FROM invoice_match_candidates candidate
            WHERE candidate.owner = invoice.owner
              AND candidate.invoice_id = invoice.id
              AND candidate.status = 'suggested'
          )
        ORDER BY invoice.issued_on, invoice.created_at, invoice.id
      `).all({ $owner: owner });
      const usedInvoiceIds = new Set();
      const expenseRemainders = new Map();
      const paymentRemainders = new Map();
      const created = [];

      for (const target of targets) {
        if (!expenseRemainders.has(target.expense_id)) {
          expenseRemainders.set(target.expense_id, Math.max(
            0,
            expenseReimbursementCents(target.expense_id) - confirmedExpenseCoverageCents(target.expense_id),
          ));
        }
        let remaining = Math.min(
          expenseRemainders.get(target.expense_id),
          Number(target.amount_snapshot_cents),
        );
        if (target.payment_id) {
          if (!paymentRemainders.has(target.payment_id)) {
            const payment = db.prepare(`
              SELECT reimbursement_cents
              FROM travel_expense_payments
              WHERE id = $id AND expense_id = $expenseId
            `).get({ $id: target.payment_id, $expenseId: target.expense_id });
            paymentRemainders.set(
              target.payment_id,
              payment
                ? Math.max(0, Number(payment.reimbursement_cents) - confirmedPaymentCoverageCents(target.payment_id))
                : 0,
            );
          }
          remaining = Math.min(remaining, paymentRemainders.get(target.payment_id));
        }
        if (remaining <= 0) continue;
        const ranked = invoices
          .filter((invoice) => !usedInvoiceIds.has(invoice.id))
          .filter((invoice) => invoice.issued_on && calendarDayDistance(invoice.issued_on, target.occurred_on) <= 31)
          .filter((invoice) => categoriesCompatible(invoice.suggested_category, target.category))
          .map((invoice) => {
            const dayDistance = calendarDayDistance(invoice.issued_on, target.occurred_on);
            const categoryExact = invoice.suggested_category === target.category;
            const invoiceRemaining = Number(invoice.total_cents) - Number(invoice.confirmed_coverage_cents);
            const amountFit = invoiceRemaining <= remaining;
            const score = Math.max(1, Math.min(100,
              50 - Math.min(31, dayDistance)
              + (categoryExact ? 30 : 15)
              + (amountFit ? 20 : 10)));
            const rationale = [
              `date_within_${dayDistance}_days`,
              categoryExact ? "category_exact" : "category_compatible",
              amountFit ? "amount_within_missing" : "partial_amount_only",
            ];
            return { invoice, invoiceRemaining, score, rationale };
          })
          .sort((first, second) => second.score - first.score
            || String(first.invoice.issued_on).localeCompare(String(second.invoice.issued_on))
            || String(first.invoice.id).localeCompare(String(second.invoice.id)));

        const replacement = chooseBestInvoiceReplacement({
          targetCents: remaining,
          target,
          invoices: ranked.map((item) => ({
            id: item.invoice.id,
            totalCents: item.invoiceRemaining,
            availableCents: item.invoiceRemaining,
            issuedOn: item.invoice.issued_on,
            suggestedCategory: item.invoice.suggested_category,
          })),
        });
        const selected = replacement
          ? (() => {
            const selectedRanked = replacement.invoiceIds
              .map((invoiceId) => ranked.find((item) => item.invoice.id === invoiceId))
              .filter(Boolean)
              .sort((left, right) => right.score - left.score
                || String(left.invoice.issued_on).localeCompare(String(right.invoice.issued_on))
                || String(left.invoice.id).localeCompare(String(right.invoice.id)));
            let allocationRemaining = remaining;
            return selectedRanked.map((rankedInvoice) => {
              const proposedCents = Math.min(allocationRemaining, rankedInvoice.invoiceRemaining);
              allocationRemaining -= proposedCents;
              return { rankedInvoice, proposedCents, combination: replacement };
            });
          })()
          : ranked.map((rankedInvoice) => ({
            rankedInvoice,
            proposedCents: Math.min(remaining, rankedInvoice.invoiceRemaining),
            combination: null,
          }));

        for (const selection of selected) {
          if (remaining <= 0) break;
          const rankedInvoice = selection.rankedInvoice;
          const proposedCents = Math.min(remaining, selection.proposedCents);
          if (proposedCents <= 0) continue;
          const id = generatedId(candidateIdFactory);
          db.prepare(`
            INSERT INTO invoice_match_candidates (
              id, owner, week_start, invoice_id, expense_id, payment_id,
              proposed_cents, score, rationale_json, status, created_by, created_at, updated_at
            ) VALUES (
              $id, $owner, $weekStart, $invoiceId, $expenseId, $paymentId,
              $proposedCents, $score, $rationaleJson, 'suggested', $actor, $now, $now
            )
          `).run({
            $id: id,
            $owner: owner,
            $weekStart: weekStart,
            $invoiceId: rankedInvoice.invoice.id,
            $expenseId: target.expense_id,
            $paymentId: target.payment_id,
            $proposedCents: proposedCents,
            $score: rankedInvoice.score,
            $rationaleJson: JSON.stringify([
              ...rankedInvoice.rationale,
              ...(selection.combination
                ? [
                    selection.combination.exact ? "combination_exact" : "combination_smallest_overage",
                    `combination_count_${selection.combination.invoiceCount}`,
                    `combination_waste_cents_${selection.combination.wasteCents}`,
                  ]
                : []),
            ]),
            $actor: actor,
            $now: timestamp,
          });
          usedInvoiceIds.add(rankedInvoice.invoice.id);
          remaining -= proposedCents;
          expenseRemainders.set(
            target.expense_id,
            expenseRemainders.get(target.expense_id) - proposedCents,
          );
          if (target.payment_id) {
            paymentRemainders.set(
              target.payment_id,
              paymentRemainders.get(target.payment_id) - proposedCents,
            );
          }
          created.push(candidateFromRow(db.prepare(`
            SELECT * FROM invoice_match_candidates WHERE id = $id
          `).get({ $id: id })));
        }
      }
      return created;
    });
  }

  function candidateCurrentOrFailure(id, owner, expectedVersion) {
    const current = db.prepare(`
      SELECT * FROM invoice_match_candidates WHERE id = $id AND owner = $owner
    `).get({ $id: id, $owner: owner });
    if (!current) throw new InvoiceNotFoundError("Invoice match candidate was not found");
    if (Number(current.version) !== expectedVersion) {
      throw new InvoiceVersionConflictError(Number(current.version));
    }
    return current;
  }

  function candidateAcceptanceContext(candidate, owner) {
    const invoice = activeInvoice.get({ $id: candidate.invoice_id, $owner: owner });
    const expense = activeExpenseById(candidate.expense_id, owner);
    if (!invoice || !expense) return null;
    if (
      !invoice.issued_on
      || calendarDayDistance(invoice.issued_on, expense.occurred_on) > 31
      || !categoriesCompatible(invoice.suggested_category, expense.category)
    ) {
      return null;
    }
    const weekEnd = new Date(`${candidate.week_start}T00:00:00.000Z`);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    if (
      expense.occurred_on < candidate.week_start
      || expense.occurred_on > weekEnd.toISOString().slice(0, 10)
    ) {
      return null;
    }
    const confirmation = db.prepare(`
      SELECT 1
      FROM travel_expense_no_invoice_confirmations
      WHERE owner = $owner AND expense_id = $expenseId AND revoked_at IS NULL
        AND (($paymentId IS NULL AND payment_id IS NULL) OR payment_id = $paymentId)
      LIMIT 1
    `).get({
      $owner: owner,
      $expenseId: candidate.expense_id,
      $paymentId: candidate.payment_id,
    });
    if (!confirmation) return null;
    const proposedCents = Number(candidate.proposed_cents);
    if (
      proposedCents <= 0
      || Number(invoice.total_cents ?? 0) - confirmedInvoiceCoverageCents(invoice.id) < proposedCents
      || expenseReimbursementCents(expense.id) - confirmedExpenseCoverageCents(expense.id) < proposedCents
    ) {
      return null;
    }
    if (candidate.payment_id) {
      const payment = db.prepare(`
        SELECT reimbursement_cents
        FROM travel_expense_payments
        WHERE id = $id AND expense_id = $expenseId
      `).get({ $id: candidate.payment_id, $expenseId: expense.id });
      if (
        !payment
        || Number(payment.reimbursement_cents) - confirmedPaymentCoverageCents(candidate.payment_id) < proposedCents
      ) {
        return null;
      }
    }
    return { expense, invoice };
  }

  function acceptMatchCandidate(idValue, input = {}) {
    const id = requiredText(idValue, "id", 200);
    const { owner, actor } = ownerAndActor(input);
    const expectedVersion = positiveVersion(input.expectedVersion);
    const timestamp = nowIso(clock);
    return runTransaction(db, () => {
      const current = candidateCurrentOrFailure(id, owner, expectedVersion);
      if (current.status !== "suggested") {
        throw new InvoiceMatchConflictError("CANDIDATE_NOT_SUGGESTED", "Invoice match candidate is not active");
      }
      const context = candidateAcceptanceContext(current, owner);
      if (!context) {
        throw new InvoiceMatchConflictError(
          "CANDIDATE_STALE",
          "Invoice match candidate no longer matches the current invoice and expense facts",
        );
      }
      const { expense, invoice } = context;
      const match = createConfirmedMatch({
        owner,
        actor,
        invoiceId: current.invoice_id,
        expectedInvoiceVersion: Number(invoice.version),
        expenseReferenceCode: expense.reference_code,
        paymentId: current.payment_id,
        allocatedCents: Number(current.proposed_cents),
        matchMethod: "rule_candidate",
      });
      const updated = db.prepare(`
        UPDATE invoice_match_candidates
        SET status = 'accepted', accepted_match_id = $matchId,
            decided_by = $actor, decided_at = $now,
            updated_at = $now, version = version + 1
        WHERE id = $id AND owner = $owner
          AND version = $expectedVersion AND status = 'suggested'
      `).run({
        $id: id,
        $owner: owner,
        $expectedVersion: expectedVersion,
        $matchId: match.id,
        $actor: actor,
        $now: timestamp,
      });
      if (updated.changes !== 1) candidateCurrentOrFailure(id, owner, expectedVersion);
      db.prepare(`
        UPDATE invoice_match_candidates
        SET status = 'expired', updated_at = $now, version = version + 1
        WHERE owner = $owner AND invoice_id = $invoiceId
          AND id <> $id AND status = 'suggested'
      `).run({ $owner: owner, $invoiceId: current.invoice_id, $id: id, $now: timestamp });
      return {
        candidate: candidateFromRow(db.prepare(`
          SELECT * FROM invoice_match_candidates WHERE id = $id AND owner = $owner
        `).get({ $id: id, $owner: owner })),
        match,
      };
    });
  }

  function rejectMatchCandidate(idValue, input = {}) {
    const id = requiredText(idValue, "id", 200);
    const { owner, actor } = ownerAndActor(input);
    const expectedVersion = positiveVersion(input.expectedVersion);
    const timestamp = nowIso(clock);
    return runTransaction(db, () => {
      const current = candidateCurrentOrFailure(id, owner, expectedVersion);
      if (current.status !== "suggested") {
        throw new InvoiceMatchConflictError("CANDIDATE_NOT_SUGGESTED", "Invoice match candidate is not active");
      }
      const updated = db.prepare(`
        UPDATE invoice_match_candidates
        SET status = 'rejected', decided_by = $actor, decided_at = $now,
            updated_at = $now, version = version + 1
        WHERE id = $id AND owner = $owner
          AND version = $expectedVersion AND status = 'suggested'
      `).run({
        $id: id,
        $owner: owner,
        $expectedVersion: expectedVersion,
        $actor: actor,
        $now: timestamp,
      });
      if (updated.changes !== 1) candidateCurrentOrFailure(id, owner, expectedVersion);
      return candidateFromRow(db.prepare(`
        SELECT * FROM invoice_match_candidates WHERE id = $id AND owner = $owner
      `).get({ $id: id, $owner: owner }));
    });
  }

  function listMatchCandidates({ owner, weekStart, invoiceId, expenseId, status = "suggested" } = {}) {
    const normalizedStatus = status === undefined || status === null || status === ""
      ? null
      : enumValue(status, CANDIDATE_STATUSES, "status");
    return db.prepare(`
      SELECT * FROM invoice_match_candidates
      WHERE owner = $owner AND week_start = $weekStart
        AND ($invoiceId IS NULL OR invoice_id = $invoiceId)
        AND ($expenseId IS NULL OR expense_id = $expenseId)
        AND ($status IS NULL OR status = $status)
      ORDER BY score DESC, created_at, id
    `).all({
      $owner: requiredText(owner, "owner", 200),
      $weekStart: mondayDate(weekStart),
      $invoiceId: optionalText(invoiceId, "invoiceId", 200),
      $expenseId: optionalText(expenseId, "expenseId", 200),
      $status: normalizedStatus,
    }).map(candidateFromRow);
  }

  return {
    acceptMatchCandidate,
    confirmNoInvoice,
    createConfirmedMatch,
    createInvoice,
    finalizeReview,
    generateMatchCandidates,
    getInvoice,
    getInvoiceContent,
    getWeekInvoiceCoverage,
    listInvoices,
    listMatchCandidates,
    listMatches,
    listNoInvoiceConfirmations,
    rejectMatchCandidate,
    revokeMatch,
    revokeNoInvoice,
    softDeleteInvoice,
  };
}
