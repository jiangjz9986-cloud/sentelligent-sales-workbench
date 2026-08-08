import { createHash, randomUUID } from "node:crypto";

import { putDocumentBlob, readDocumentBlob } from "./documentBlobStore.js";
import { inspectInvoiceFile } from "./invoiceRecognition.js";

const DOCUMENT_KINDS = new Set(["payment_proof", "invoice"]);
const SOURCES = new Set(["manual", "weixin"]);

export class DocumentInboxDuplicateError extends Error {
  constructor(existingId) {
    super("The same document already exists in the inbox");
    this.name = "DocumentInboxDuplicateError";
    this.code = "DUPLICATE_DOCUMENT";
    this.existingId = existingId;
  }
}

export class DocumentInboxNotFoundError extends Error {
  constructor() {
    super("Document inbox item was not found");
    this.name = "DocumentInboxNotFoundError";
    this.code = "DOCUMENT_INBOX_NOT_FOUND";
  }
}

export class DocumentInboxVersionConflictError extends Error {
  constructor(currentVersion) {
    super("Document inbox item changed before this request was applied");
    this.name = "DocumentInboxVersionConflictError";
    this.code = "VERSION_CONFLICT";
    this.currentVersion = currentVersion;
  }
}

export class DocumentInboxStateConflictError extends Error {
  constructor(status) {
    super("Document inbox item is no longer awaiting review");
    this.name = "DocumentInboxStateConflictError";
    this.code = "DOCUMENT_INBOX_STATE_CONFLICT";
    this.status = status;
  }
}

function requiredText(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function optionalText(value, name, max = 500) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function enumValue(value, allowed, name) {
  const normalized = requiredText(value, name, 50);
  if (!allowed.has(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function ownerAndActor(input) {
  const actor = requiredText(input.actor, "actor", 200);
  const owner = requiredText(input.owner ?? actor, "owner", 200);
  if (owner !== actor) throw new TypeError("owner must match actor for a personal document inbox record");
  return { actor, owner };
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.toISOString();
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("expectedVersion must be a positive integer");
  return value;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Stored document inbox recognition JSON is invalid");
  }
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version),
    owner: row.owner,
    source: row.source,
    sourceRef: row.source_message_id,
    documentKind: row.document_kind,
    fileName: row.file_name,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    status: row.status,
    extractedText: row.extracted_text,
    recognition: parseJson(row.recognition_json, null),
    matchedExpenseId: row.matched_expense_id,
    matchedPaymentId: row.matched_payment_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function candidateFromRow(row) {
  return {
    expenseId: row.expense_id,
    expenseReferenceCode: row.reference_code,
    expenseVersion: Number(row.expense_version),
    expenseOccurredOn: row.expense_occurred_on,
    category: row.category,
    purpose: row.purpose,
    paymentId: row.payment_id,
    paidAt: row.paid_at,
    merchant: row.payment_merchant ?? row.expense_merchant,
    amountCents: Number(row.amount_cents),
    reimbursementCents: Number(row.reimbursement_cents),
  };
}

function createBusinessTimeFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new TypeError("businessTimeZone must be a valid IANA time zone");
  }
}

function businessDateTime(paidAt, formatter) {
  const value = String(paidAt ?? "").trim();
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/u.exec(value);
  if (local) return { date: local[1], time: local[2] };

  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const fields = Object.fromEntries(
    formatter.formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${fields.year}-${fields.month}-${fields.day}`,
    time: `${fields.hour}:${fields.minute}`,
  };
}

export function createTravelExpenseDocumentInboxRepository(db, {
  idFactory = randomUUID,
  clock = () => new Date(),
  businessTimeZone = "Asia/Shanghai",
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const businessTimeFormatter = createBusinessTimeFormatter(businessTimeZone);

  function currentReviewItem(id, owner, expectedVersion) {
    const row = db.prepare(`
      SELECT * FROM travel_expense_document_inbox WHERE id = $id AND owner = $owner
    `).get({
      $id: requiredText(id, "id", 200),
      $owner: requiredText(owner, "owner", 200),
    });
    if (!row) throw new DocumentInboxNotFoundError();
    const currentVersion = Number(row.version);
    if (currentVersion !== positiveVersion(expectedVersion)) {
      throw new DocumentInboxVersionConflictError(currentVersion);
    }
    if (row.status !== "review_required") {
      throw new DocumentInboxStateConflictError(row.status);
    }
    return { row, item: fromRow(row) };
  }

  function findExpenseByReference({ owner, referenceCode } = {}) {
    const row = db.prepare(`
      SELECT id, reference_code, version
      FROM travel_expenses
      WHERE owner = $owner AND reference_code = $referenceCode AND deleted_at IS NULL
    `).get({
      $owner: requiredText(owner, "owner", 200),
      $referenceCode: requiredText(referenceCode, "referenceCode", 200),
    });
    return row ? {
      id: row.id,
      referenceCode: row.reference_code,
      version: Number(row.version),
    } : null;
  }

  function findPaymentCandidates({
    owner,
    expenseReferenceCode,
    amountCents,
    occurredOn,
    paidTime,
    limit = 10,
  } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedReference = optionalText(expenseReferenceCode, "expenseReferenceCode", 200);
    const normalizedDate = optionalText(occurredOn, "occurredOn", 10);
    const normalizedTime = optionalText(paidTime, "paidTime", 5);
    const normalizedAmount = amountCents === undefined || amountCents === null
      ? null
      : amountCents;
    if (normalizedAmount !== null && (!Number.isSafeInteger(normalizedAmount) || normalizedAmount <= 0)) {
      throw new TypeError("amountCents must be a positive integer");
    }
    if (!normalizedReference && normalizedAmount === null && !normalizedDate && !normalizedTime) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError("limit is invalid");

    return db.prepare(`
      SELECT expense.id AS expense_id,
             expense.reference_code,
             expense.version AS expense_version,
             expense.occurred_on AS expense_occurred_on,
             expense.category,
             expense.purpose,
             expense.merchant AS expense_merchant,
             payment.id AS payment_id,
             payment.paid_at,
             payment.merchant AS payment_merchant,
             payment.amount_cents,
             payment.reimbursement_cents
      FROM travel_expenses expense
      JOIN travel_expense_payments payment ON payment.expense_id = expense.id
      WHERE expense.owner = $owner
        AND expense.deleted_at IS NULL
        AND ($referenceCode IS NULL OR expense.reference_code = $referenceCode)
        AND ($amountCents IS NULL OR payment.amount_cents = $amountCents)
      ORDER BY payment.paid_at DESC, expense.created_at DESC, payment.sequence, payment.id
    `).all({
      $owner: normalizedOwner,
      $referenceCode: normalizedReference,
      $amountCents: normalizedAmount,
    })
      .map(candidateFromRow)
      .filter((candidate) => {
        if (!normalizedDate && !normalizedTime) return true;
        const local = businessDateTime(candidate.paidAt, businessTimeFormatter);
        return Boolean(
          local
          && (!normalizedDate || local.date === normalizedDate)
          && (!normalizedTime || local.time === normalizedTime),
        );
      })
      .slice(0, limit);
  }

  function createDocument(input = {}) {
    const { owner, actor } = ownerAndActor(input);
    const source = enumValue(input.source, SOURCES, "source");
    const sourceRef = optionalText(input.sourceRef, "sourceRef", 500);
    const documentKind = enumValue(input.documentKind, DOCUMENT_KINDS, "documentKind");
    const inspected = inspectInvoiceFile({
      fileName: input.fileName,
      mediaType: input.mediaType,
      buffer: input.content,
    });
    const existing = db.prepare(`
      SELECT id FROM travel_expense_document_inbox
      WHERE owner = $owner AND document_kind = $documentKind AND sha256 = $sha256
    `).get({
      $owner: owner,
      $documentKind: documentKind,
      $sha256: inspected.sha256,
    });
    if (existing) throw new DocumentInboxDuplicateError(existing.id);

    const status = enumValue(input.status, new Set(["received", "review_required", "matched", "failed"]), "status");
    const matchedExpenseId = optionalText(input.matchedExpenseId, "matchedExpenseId", 200);
    const matchedPaymentId = optionalText(input.matchedPaymentId, "matchedPaymentId", 200);
    if ((matchedExpenseId === null) !== (matchedPaymentId === null)) {
      throw new TypeError("matched expense and payment ids must be provided together");
    }
    if (status === "matched" && !matchedPaymentId) throw new TypeError("matched status requires a payment");
    if (status !== "matched" && matchedPaymentId) throw new TypeError("only matched documents may reference a payment");

    const id = requiredText(idFactory(), "generated document inbox id", 200);
    const now = timestamp(clock);
    const documentBlob = putDocumentBlob(db, {
      owner,
      content: inspected.buffer,
      encoded: input.encodedDocumentBlob,
      createdAt: now,
    });
    db.prepare(`
      INSERT INTO travel_expense_document_inbox (
        id, owner, actor, source, source_message_id, document_kind,
        file_name, media_type, size_bytes, sha256, document_blob_id,
        status, extracted_text, recognition_json, matched_expense_id,
        matched_payment_id, error_code, created_at, updated_at
      ) VALUES (
        $id, $owner, $actor, $source, $sourceRef, $documentKind,
        $fileName, $mediaType, $sizeBytes, $sha256, $documentBlobId,
        $status, $extractedText, $recognitionJson, $matchedExpenseId,
        $matchedPaymentId, $errorCode, $now, $now
      )
    `).run({
      $id: id,
      $owner: owner,
      $actor: actor,
      $source: source,
      $sourceRef: sourceRef,
      $documentKind: documentKind,
      $fileName: inspected.fileName,
      $mediaType: inspected.mediaType,
      $sizeBytes: inspected.sizeBytes,
      $sha256: inspected.sha256,
      $documentBlobId: documentBlob.id,
      $status: status,
      $extractedText: optionalText(input.extractedText, "extractedText", 200_000),
      $recognitionJson: input.recognition === undefined || input.recognition === null
        ? null
        : JSON.stringify(input.recognition),
      $matchedExpenseId: matchedExpenseId,
      $matchedPaymentId: matchedPaymentId,
      $errorCode: optionalText(input.errorCode, "errorCode", 80),
      $now: now,
    });
    return fromRow(db.prepare(`
      SELECT * FROM travel_expense_document_inbox WHERE id = $id AND owner = $owner
    `).get({ $id: id, $owner: owner }));
  }

  function listDocuments({ owner, status = null, documentKind = null, limit = 100 } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedStatus = status === null
      ? null
      : enumValue(status, new Set(["received", "processing", "review_required", "matched", "failed", "rejected"]), "status");
    const normalizedKind = documentKind === null
      ? null
      : enumValue(documentKind, DOCUMENT_KINDS, "documentKind");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError("limit is invalid");
    return db.prepare(`
      SELECT *
      FROM travel_expense_document_inbox
      WHERE owner = $owner
        AND ($status IS NULL OR status = $status)
        AND ($documentKind IS NULL OR document_kind = $documentKind)
      ORDER BY created_at DESC, id DESC
      LIMIT $limit
    `).all({
      $owner: normalizedOwner,
      $status: normalizedStatus,
      $documentKind: normalizedKind,
      $limit: limit,
    }).map(fromRow);
  }

  function getDocument(id, { owner } = {}) {
    return fromRow(db.prepare(`
      SELECT * FROM travel_expense_document_inbox WHERE id = $id AND owner = $owner
    `).get({
      $id: requiredText(id, "id", 200),
      $owner: requiredText(owner, "owner", 200),
    }));
  }

  function getDocumentContent(id, { owner } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const row = db.prepare(`
      SELECT id, file_name, media_type, size_bytes, sha256, document_blob_id
      FROM travel_expense_document_inbox
      WHERE id = $id AND owner = $owner
    `).get({
      $id: requiredText(id, "id", 200),
      $owner: normalizedOwner,
    });
    if (!row) return null;
    const content = readDocumentBlob(db, { id: row.document_blob_id, owner: normalizedOwner });
    if (!content) throw new Error("Document inbox content blob is missing");
    const sizeBytes = Number(row.size_bytes);
    if (content.length !== sizeBytes) throw new Error("Document inbox content length does not match metadata");
    if (createHash("sha256").update(content).digest("hex") !== row.sha256) {
      throw new Error("Document inbox content SHA-256 does not match metadata");
    }
    return {
      id: row.id,
      fileName: row.file_name,
      mediaType: row.media_type,
      sizeBytes,
      content,
    };
  }

  function markMatched(id, input = {}) {
    const { owner, actor } = ownerAndActor(input);
    const matchedExpenseId = requiredText(input.matchedExpenseId, "matchedExpenseId", 200);
    const matchedPaymentId = requiredText(input.matchedPaymentId, "matchedPaymentId", 200);
    const attachmentId = requiredText(input.attachmentId, "attachmentId", 200);
    const { item } = currentReviewItem(id, owner, input.expectedVersion);
    const recognition = item.recognition && typeof item.recognition === "object" && !Array.isArray(item.recognition)
      ? { ...item.recognition, attachmentId }
      : { attachmentId };
    const now = timestamp(clock);
    const result = db.prepare(`
      UPDATE travel_expense_document_inbox
      SET status = 'matched', matched_expense_id = $matchedExpenseId,
          matched_payment_id = $matchedPaymentId, recognition_json = $recognitionJson,
          error_code = NULL, actor = $actor, version = version + 1, updated_at = $now
      WHERE id = $id AND owner = $owner AND version = $expectedVersion
        AND status = 'review_required'
    `).run({
      $id: requiredText(id, "id", 200),
      $owner: owner,
      $actor: actor,
      $expectedVersion: input.expectedVersion,
      $matchedExpenseId: matchedExpenseId,
      $matchedPaymentId: matchedPaymentId,
      $recognitionJson: JSON.stringify(recognition),
      $now: now,
    });
    if (result.changes !== 1) currentReviewItem(id, owner, input.expectedVersion);
    return getDocument(id, { owner });
  }

  function rejectDocument(id, input = {}) {
    const { owner, actor } = ownerAndActor(input);
    currentReviewItem(id, owner, input.expectedVersion);
    const now = timestamp(clock);
    const result = db.prepare(`
      UPDATE travel_expense_document_inbox
      SET status = 'rejected', matched_expense_id = NULL, matched_payment_id = NULL,
          actor = $actor, version = version + 1, updated_at = $now
      WHERE id = $id AND owner = $owner AND version = $expectedVersion
        AND status = 'review_required'
    `).run({
      $id: requiredText(id, "id", 200),
      $owner: owner,
      $actor: actor,
      $expectedVersion: input.expectedVersion,
      $now: now,
    });
    if (result.changes !== 1) currentReviewItem(id, owner, input.expectedVersion);
    return getDocument(id, { owner });
  }

  return {
    createDocument,
    findExpenseByReference,
    findPaymentCandidates,
    getDocument,
    getDocumentContent,
    listDocuments,
    markMatched,
    rejectDocument,
  };
}
