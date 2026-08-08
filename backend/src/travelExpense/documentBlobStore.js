import { createHash } from "node:crypto";

import {
  decodeDocumentBlob,
  DocumentBlobIntegrityError,
  documentBlobId,
  encodeDocumentBlob,
  encodeDocumentBlobAsync,
} from "./documentBlobCodec.js";

const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
const PREPARED_DOCUMENT_BLOBS = new WeakMap();

export class DocumentBlobPreflightStaleError extends Error {
  constructor(message = "Document blob write preflight is stale") {
    super(message);
    this.name = "DocumentBlobPreflightStaleError";
    this.code = "DOCUMENT_BLOB_PREFLIGHT_STALE";
  }
}

function requiredDb(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
  return db;
}

export function assertDocumentBlobReadOutsideTransaction(dbValue) {
  const db = requiredDb(dbValue);
  if (db.isTransaction) {
    throw new TypeError("document blob content must be read outside SQLite transactions");
  }
  return db;
}

function requiredText(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function requiredContent(value) {
  const content = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : null;
  if (!content || content.length < 1 || content.length > MAX_DOCUMENT_BYTES) {
    throw new TypeError("document content must contain between 1 byte and 12 MiB");
  }
  return content;
}

function timestamp(value) {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError("createdAt must be an ISO date-time");
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function preparedRecord(value, content, { allowUnprepared = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("encoded document blob is invalid");
  }
  const preparedState = PREPARED_DOCUMENT_BLOBS.get(value);
  if (preparedState) {
    const encoded = {
      ...preparedState.encoded,
      content: Buffer.from(preparedState.encoded.content),
    };
    if (
      encoded.originalSizeBytes !== content.length
      || encoded.sha256 !== sha256(content)
      || encoded.content.length !== encoded.storedSizeBytes
    ) {
      throw new TypeError("prepared document blob does not match original content");
    }
    return {
      encoded,
      prevalidated: preparedState.prevalidated,
    };
  }
  const encoded = {
    encoding: value.encoding,
    originalSizeBytes: value.originalSizeBytes,
    storedSizeBytes: value.storedSizeBytes,
    sha256: value.sha256,
    content: Buffer.isBuffer(value.content)
      ? Buffer.from(value.content)
      : value.content instanceof Uint8Array
        ? Buffer.from(value.content)
        : value.content,
  };
  if (!allowUnprepared) {
    throw new TypeError(
      "document blob must be prepared before starting a SQLite write transaction",
    );
  }
  const restored = decodeDocumentBlob(encoded);
  if (!restored.equals(content)) {
    throw new TypeError("encoded document blob does not match original content");
  }
  return { encoded, prevalidated: null };
}

function freezePreparedDocumentBlob(encoded, prevalidated = null) {
  const prepared = {
    ...encoded,
    content: Buffer.from(encoded.content),
  };
  PREPARED_DOCUMENT_BLOBS.set(prepared, Object.freeze({
    encoded: Object.freeze({
      ...encoded,
      content: Buffer.from(encoded.content),
    }),
    prevalidated,
  }));
  return Object.freeze(prepared);
}

function verifiedPreparedDocumentBlob(content, encoded) {
  const restored = decodeDocumentBlob(encoded);
  if (!restored.equals(content)) {
    throw new Error("Prepared document blob does not preserve the original bytes");
  }
  return freezePreparedDocumentBlob(encoded);
}

export function prepareDocumentBlobSync(contentValue) {
  const content = requiredContent(contentValue);
  return verifiedPreparedDocumentBlob(content, encodeDocumentBlob(content));
}

export async function prepareDocumentBlob(contentValue) {
  const content = requiredContent(contentValue);
  return verifiedPreparedDocumentBlob(content, await encodeDocumentBlobAsync(content));
}

function storedRecord(row) {
  return {
    encoding: row.encoding,
    originalSizeBytes: Number(row.original_size_bytes),
    storedSizeBytes: Number(row.stored_size_bytes),
    sha256: row.sha256,
    content: row.content_blob,
  };
}

function publicRecord(row) {
  return {
    id: row.id,
    owner: row.owner,
    sha256: row.sha256,
    encoding: row.encoding,
    originalSizeBytes: Number(row.original_size_bytes),
    storedSizeBytes: Number(row.stored_size_bytes),
    createdAt: row.created_at,
  };
}

function storedRowMatchesEncoded(row, { id, owner, encoded }) {
  return row.id === id
    && row.owner === owner
    && row.sha256 === encoded.sha256
    && row.encoding === encoded.encoding
    && Number(row.original_size_bytes) === encoded.originalSizeBytes
    && Number(row.stored_size_bytes) === encoded.storedSizeBytes
    && Buffer.from(row.content_blob).equals(encoded.content);
}

function storedSnapshot(row) {
  return Object.freeze({
    id: row.id,
    owner: row.owner,
    sha256: row.sha256,
    encoding: row.encoding,
    originalSizeBytes: Number(row.original_size_bytes),
    storedSizeBytes: Number(row.stored_size_bytes),
    content: Buffer.from(row.content_blob),
    createdAt: row.created_at,
  });
}

function storedRowMatchesSnapshot(row, snapshot) {
  return row.id === snapshot.id
    && row.owner === snapshot.owner
    && row.sha256 === snapshot.sha256
    && row.encoding === snapshot.encoding
    && Number(row.original_size_bytes) === snapshot.originalSizeBytes
    && Number(row.stored_size_bytes) === snapshot.storedSizeBytes
    && Buffer.from(row.content_blob).equals(snapshot.content)
    && row.created_at === snapshot.createdAt;
}

function prevalidatePreparedDocumentBlob(db, { owner, content, encoded }) {
  const id = documentBlobId(owner, encoded.sha256);
  const row = db.prepare(`
    SELECT id, owner, sha256, encoding, original_size_bytes, stored_size_bytes,
           content_blob, created_at
    FROM document_blobs
    WHERE owner = $owner AND sha256 = $sha256
  `).get({ $owner: owner, $sha256: encoded.sha256 });
  let existing = null;
  if (row) {
    if (row.id !== id) {
      throw new DocumentBlobIntegrityError("Stored document content address does not match");
    }
    const restored = decodeDocumentBlob(storedRecord(row));
    if (!restored.equals(content)) {
      throw new DocumentBlobIntegrityError(
        "Stored document content does not match the requested original bytes",
      );
    }
    existing = storedSnapshot(row);
  }
  return freezePreparedDocumentBlob(encoded, Object.freeze({ owner, existing }));
}

function writePreparationInputs(dbValue, { owner: ownerValue, content: contentValue } = {}) {
  const db = requiredDb(dbValue);
  if (db.isTransaction) {
    throw new TypeError(
      "document blob must be prepared before starting a SQLite write transaction",
    );
  }
  return {
    db,
    owner: requiredText(ownerValue, "owner"),
    content: requiredContent(contentValue),
  };
}

export function prepareDocumentBlobForWriteSync(dbValue, options = {}) {
  const { db, owner, content } = writePreparationInputs(dbValue, options);
  const prepared = options.encoded === undefined
    ? prepareDocumentBlobSync(content)
    : freezePreparedDocumentBlob(preparedRecord(options.encoded, content).encoded);
  return prevalidatePreparedDocumentBlob(db, { owner, content, encoded: prepared });
}

export async function prepareDocumentBlobForWrite(dbValue, options = {}) {
  const { db, owner, content } = writePreparationInputs(dbValue, options);
  const prepared = options.encoded === undefined
    ? await prepareDocumentBlob(content)
    : freezePreparedDocumentBlob(preparedRecord(options.encoded, content).encoded);
  return prevalidatePreparedDocumentBlob(db, { owner, content, encoded: prepared });
}

function requiredWrite(work) {
  if (typeof work !== "function") throw new TypeError("document blob write callback is required");
  return work;
}

function completedWrite(work, prepared) {
  const result = work(prepared);
  if (
    result !== null
    && (typeof result === "object" || typeof result === "function")
    && typeof result.then === "function"
  ) {
    throw new TypeError("document blob write callback must be synchronous");
  }
  return result;
}

export function withDocumentBlobWritePreflightSync(dbValue, options = {}, workValue) {
  const db = requiredDb(dbValue);
  const work = requiredWrite(workValue);
  let encoded = options.encoded;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = prepareDocumentBlobForWriteSync(db, { ...options, encoded });
    try {
      return completedWrite(work, prepared);
    } catch (error) {
      if (!(error instanceof DocumentBlobPreflightStaleError) || attempt === 1) throw error;
      encoded = prepared;
    }
  }
  throw new Error("Document blob write preflight retry exhausted unexpectedly");
}

export async function withDocumentBlobWritePreflight(dbValue, options = {}, workValue) {
  const db = requiredDb(dbValue);
  const work = requiredWrite(workValue);
  let encoded = options.encoded;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = await prepareDocumentBlobForWrite(db, { ...options, encoded });
    try {
      return completedWrite(work, prepared);
    } catch (error) {
      if (!(error instanceof DocumentBlobPreflightStaleError) || attempt === 1) throw error;
      encoded = prepared;
    }
  }
  throw new Error("Document blob write preflight retry exhausted unexpectedly");
}

export function putDocumentBlob(dbValue, {
  owner: ownerValue,
  content: contentValue,
  encoded: encodedValue,
  createdAt,
} = {}) {
  const db = requiredDb(dbValue);
  const owner = requiredText(ownerValue, "owner");
  const content = requiredContent(contentValue);
  let encoded;
  let prevalidated;
  if (encodedValue === undefined) {
    if (db.isTransaction) {
      throw new TypeError(
        "document blob must be prepared before starting a SQLite write transaction",
      );
    }
    encoded = encodeDocumentBlob(content);
    prevalidated = null;
  } else {
    const prepared = preparedRecord(encodedValue, content, {
      allowUnprepared: !db.isTransaction,
    });
    encoded = prepared.encoded;
    prevalidated = prepared.prevalidated;
  }
  if (prevalidated !== null && prevalidated.owner !== owner) {
    throw new TypeError("prepared document blob owner does not match the write owner");
  }
  const id = documentBlobId(owner, encoded.sha256);
  const inserted = db.prepare(`
    INSERT INTO document_blobs (
      id, owner, sha256, encoding, original_size_bytes, stored_size_bytes,
      content_blob, created_at
    ) VALUES (
      $id, $owner, $sha256, $encoding, $originalSizeBytes, $storedSizeBytes,
      $content, $createdAt
    )
    ON CONFLICT(owner, sha256) DO NOTHING
  `).run({
    $id: id,
    $owner: owner,
    $sha256: encoded.sha256,
    $encoding: encoded.encoding,
    $originalSizeBytes: encoded.originalSizeBytes,
    $storedSizeBytes: encoded.storedSizeBytes,
    $content: encoded.content,
    $createdAt: timestamp(createdAt),
  });

  const row = db.prepare(`
    SELECT id, owner, sha256, encoding, original_size_bytes, stored_size_bytes,
           content_blob, created_at
    FROM document_blobs
    WHERE owner = $owner AND sha256 = $sha256
  `).get({ $owner: owner, $sha256: encoded.sha256 });
  if (!row || row.id !== id) throw new Error("Document content address could not be resolved");
  if (inserted.changes === 1) {
    if (!storedRowMatchesEncoded(row, { id, owner, encoded })) {
      throw new Error("Stored document metadata does not match the prepared document blob");
    }
  } else if (
    prevalidated?.existing
    && storedRowMatchesSnapshot(row, prevalidated.existing)
  ) {
    // Existing bytes were fully decoded and verified before BEGIN IMMEDIATE.
  } else if (storedRowMatchesEncoded(row, { id, owner, encoded })) {
    // A concurrent writer may have inserted the same deterministic encoding.
  } else if (db.isTransaction) {
    throw new DocumentBlobPreflightStaleError(
      "Stored document content changed after write preflight",
    );
  } else {
    const restored = decodeDocumentBlob(storedRecord(row));
    if (!restored.equals(content)) {
      throw new Error("Stored document content does not match the requested original bytes");
    }
  }
  return publicRecord(row);
}

export function readDocumentBlob(dbValue, { id: idValue, owner: ownerValue } = {}) {
  const db = assertDocumentBlobReadOutsideTransaction(dbValue);
  const id = requiredText(idValue, "id", 64);
  const owner = requiredText(ownerValue, "owner");
  const row = db.prepare(`
    SELECT id, owner, sha256, encoding, original_size_bytes, stored_size_bytes,
           content_blob, created_at
    FROM document_blobs
    WHERE id = $id AND owner = $owner
  `).get({ $id: id, $owner: owner });
  if (!row) return null;
  if (row.id !== documentBlobId(owner, row.sha256)) {
    throw new DocumentBlobIntegrityError(
      "Stored document content address does not match its SHA-256",
    );
  }
  return decodeDocumentBlob(storedRecord(row));
}

export function deleteDocumentBlobIfUnreferenced(dbValue, {
  id: idValue,
  owner: ownerValue,
} = {}) {
  const db = requiredDb(dbValue);
  const id = requiredText(idValue, "id", 64);
  const owner = requiredText(ownerValue, "owner");
  const result = db.prepare(`
    DELETE FROM document_blobs
    WHERE id = $id AND owner = $owner
      AND NOT EXISTS (
        SELECT 1 FROM travel_expense_attachments WHERE document_blob_id = $id
      )
      AND NOT EXISTS (
        SELECT 1 FROM travel_expense_document_inbox WHERE document_blob_id = $id
      )
      AND NOT EXISTS (
        SELECT 1 FROM invoice_documents WHERE document_blob_id = $id
      )
  `).run({ $id: id, $owner: owner });
  return result.changes === 1;
}
