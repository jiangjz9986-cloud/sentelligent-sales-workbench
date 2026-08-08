import { createHash } from "node:crypto";

import { documentBlobId } from "../../travelExpense/documentBlobCodec.js";

const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;

function bytes(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`${label} content is not binary`);
  }
  return Buffer.from(value);
}

function assertLegacySize(row, content, label) {
  const declared = Number(row.size_bytes);
  if (!Number.isSafeInteger(declared) || declared !== content.length) {
    throw new Error(`${label} size does not match its stored content`);
  }
  if (declared < 1 || declared > MAX_DOCUMENT_BYTES) {
    throw new Error(`${label} exceeds the 12 MiB document limit`);
  }
}

function identityDocumentBlob(content) {
  return {
    encoding: "identity",
    originalSizeBytes: content.length,
    storedSizeBytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    content: Buffer.from(content),
  };
}

function createBlobTable(db) {
  db.exec(`
    CREATE TABLE document_blobs (
      id TEXT PRIMARY KEY NOT NULL CHECK (
        length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'
      ),
      owner TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK (
        length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      encoding TEXT NOT NULL CHECK (encoding IN ('identity', 'br')),
      original_size_bytes INTEGER NOT NULL CHECK (
        original_size_bytes BETWEEN 1 AND 12582912
      ),
      stored_size_bytes INTEGER NOT NULL CHECK (
        stored_size_bytes BETWEEN 1 AND original_size_bytes
      ),
      content_blob BLOB NOT NULL CHECK (length(content_blob) = stored_size_bytes),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (owner, sha256),
      CHECK (
        (encoding = 'identity' AND stored_size_bytes = original_size_bytes)
        OR (encoding = 'br' AND stored_size_bytes < original_size_bytes)
      )
    );

    CREATE INDEX idx_document_blobs_owner_created
      ON document_blobs(owner, created_at, id);

    CREATE TEMP TABLE document_blob_migration_map (
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      document_blob_id TEXT NOT NULL,
      PRIMARY KEY (source_table, source_id)
    );
  `);
}

function backfillBlobs(db) {
  const insertBlob = db.prepare(`
    INSERT INTO document_blobs (
      id, owner, sha256, encoding, original_size_bytes, stored_size_bytes,
      content_blob, created_at
    ) VALUES (
      $id, $owner, $sha256, $encoding, $originalSizeBytes, $storedSizeBytes,
      $content, $createdAt
    )
    ON CONFLICT(owner, sha256) DO NOTHING
  `);
  const selectBlob = db.prepare(`
    SELECT id, owner, sha256, encoding, original_size_bytes, stored_size_bytes, content_blob
    FROM document_blobs
    WHERE owner = $owner AND sha256 = $sha256
  `);
  const insertMap = db.prepare(`
    INSERT INTO document_blob_migration_map (source_table, source_id, document_blob_id)
    VALUES ($sourceTable, $sourceId, $documentBlobId)
  `);

  function addRow({ sourceTable, sourceId, owner, content, expectedSha256, createdAt }) {
    const encoded = identityDocumentBlob(content);
    if (expectedSha256 && encoded.sha256 !== expectedSha256) {
      throw new Error(`${sourceTable} ${sourceId} SHA-256 does not match its stored content`);
    }
    const id = documentBlobId(owner, encoded.sha256);
    insertBlob.run({
      $id: id,
      $owner: owner,
      $sha256: encoded.sha256,
      $encoding: encoded.encoding,
      $originalSizeBytes: encoded.originalSizeBytes,
      $storedSizeBytes: encoded.storedSizeBytes,
      $content: encoded.content,
      $createdAt: createdAt,
    });
    const stored = selectBlob.get({ $owner: owner, $sha256: encoded.sha256 });
    if (!stored || stored.id !== id) {
      throw new Error(`Could not resolve content address for ${sourceTable} ${sourceId}`);
    }
    if (
      stored.owner !== owner
      || stored.sha256 !== encoded.sha256
      || stored.encoding !== "identity"
      || Number(stored.original_size_bytes) !== encoded.originalSizeBytes
      || Number(stored.stored_size_bytes) !== encoded.storedSizeBytes
      || !Buffer.from(stored.content_blob).equals(encoded.content)
    ) {
      throw new Error(`${sourceTable} ${sourceId} failed lossless backfill verification`);
    }
    insertMap.run({
      $sourceTable: sourceTable,
      $sourceId: sourceId,
      $documentBlobId: id,
    });
  }

  for (const row of db.prepare(`
    SELECT a.id, e.owner, a.size_bytes, a.content, a.created_at
    FROM travel_expense_attachments a
    JOIN travel_expenses e ON e.id = a.expense_id
    ORDER BY a.id
  `).all()) {
    const content = bytes(row.content, `travel_expense_attachments ${row.id}`);
    assertLegacySize(row, content, `travel_expense_attachments ${row.id}`);
    addRow({
      sourceTable: "travel_expense_attachments",
      sourceId: row.id,
      owner: row.owner,
      content,
      createdAt: row.created_at,
    });
  }

  for (const row of db.prepare(`
    SELECT id, owner, size_bytes, sha256, content_blob, created_at
    FROM travel_expense_document_inbox
    ORDER BY id
  `).all()) {
    const content = bytes(row.content_blob, `travel_expense_document_inbox ${row.id}`);
    assertLegacySize(row, content, `travel_expense_document_inbox ${row.id}`);
    addRow({
      sourceTable: "travel_expense_document_inbox",
      sourceId: row.id,
      owner: row.owner,
      content,
      expectedSha256: row.sha256,
      createdAt: row.created_at,
    });
  }

  for (const row of db.prepare(`
    SELECT id, owner, size_bytes, sha256, content_blob, created_at
    FROM invoice_documents
    ORDER BY id
  `).all()) {
    const content = bytes(row.content_blob, `invoice_documents ${row.id}`);
    assertLegacySize(row, content, `invoice_documents ${row.id}`);
    addRow({
      sourceTable: "invoice_documents",
      sourceId: row.id,
      owner: row.owner,
      content,
      expectedSha256: row.sha256,
      createdAt: row.created_at,
    });
  }
}

function rebuildTravelExpenseAttachments(db) {
  db.exec(`
    CREATE TEMP TABLE travel_expense_attachment_payments_backup AS
      SELECT attachment_id, payment_id
      FROM travel_expense_attachment_payments;

    DROP TABLE travel_expense_attachment_payments;

    CREATE TABLE travel_expense_attachments_new (
      id TEXT PRIMARY KEY NOT NULL,
      expense_id TEXT NOT NULL REFERENCES travel_expenses(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      kind TEXT NOT NULL CHECK (kind IN ('payment_proof', 'invoice', 'substitute')),
      file_name TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (
        media_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
      ),
      size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 12582912),
      document_blob_id TEXT NOT NULL REFERENCES document_blobs(id) ON DELETE RESTRICT,
      covered_cents INTEGER NOT NULL DEFAULT 0 CHECK (covered_cents >= 0),
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (expense_id, sequence)
    );

    INSERT INTO travel_expense_attachments_new (
      id, expense_id, sequence, kind, file_name, media_type, size_bytes,
      document_blob_id, covered_cents, notes, created_by, created_at
    )
    SELECT
      a.id, a.expense_id, a.sequence, a.kind, a.file_name, a.media_type, a.size_bytes,
      m.document_blob_id, a.covered_cents, a.notes, a.created_by, a.created_at
    FROM travel_expense_attachments a
    JOIN document_blob_migration_map m
      ON m.source_table = 'travel_expense_attachments' AND m.source_id = a.id;

    DROP TABLE travel_expense_attachments;
    ALTER TABLE travel_expense_attachments_new RENAME TO travel_expense_attachments;

    CREATE TABLE travel_expense_attachment_payments (
      attachment_id TEXT NOT NULL REFERENCES travel_expense_attachments(id) ON DELETE CASCADE,
      payment_id TEXT NOT NULL REFERENCES travel_expense_payments(id) ON DELETE CASCADE,
      PRIMARY KEY (attachment_id, payment_id)
    );

    INSERT INTO travel_expense_attachment_payments (attachment_id, payment_id)
      SELECT attachment_id, payment_id
      FROM travel_expense_attachment_payments_backup;

    DROP TABLE travel_expense_attachment_payments_backup;

    CREATE INDEX idx_travel_expense_attachments_expense
      ON travel_expense_attachments(expense_id, sequence);
    CREATE INDEX idx_travel_expense_attachments_blob
      ON travel_expense_attachments(document_blob_id, expense_id);
    CREATE INDEX idx_travel_expense_attachment_payments_payment
      ON travel_expense_attachment_payments(payment_id, attachment_id);

    CREATE TRIGGER trg_travel_expense_attachments_blob_insert
    BEFORE INSERT ON travel_expense_attachments
    WHEN NOT EXISTS (
      SELECT 1
      FROM travel_expenses e
      JOIN document_blobs b
        ON b.id = NEW.document_blob_id
       AND b.owner = e.owner
       AND b.original_size_bytes = NEW.size_bytes
      WHERE e.id = NEW.expense_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'travel expense attachment document blob mismatch');
    END;

    CREATE TRIGGER trg_travel_expense_attachments_blob_update
    BEFORE UPDATE OF expense_id, size_bytes, document_blob_id ON travel_expense_attachments
    WHEN NOT EXISTS (
      SELECT 1
      FROM travel_expenses e
      JOIN document_blobs b
        ON b.id = NEW.document_blob_id
       AND b.owner = e.owner
       AND b.original_size_bytes = NEW.size_bytes
      WHERE e.id = NEW.expense_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'travel expense attachment document blob mismatch');
    END;
  `);
}

function migrateDirectDocumentTable(db, {
  table,
  triggerPrefix,
}) {
  db.exec(`ALTER TABLE ${table} ADD COLUMN document_blob_id TEXT REFERENCES document_blobs(id) ON DELETE RESTRICT`);
  db.prepare(`
    UPDATE ${table}
    SET document_blob_id = (
      SELECT document_blob_id
      FROM document_blob_migration_map m
      WHERE m.source_table = $sourceTable AND m.source_id = ${table}.id
    )
  `).run({ $sourceTable: table });
  const missing = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE document_blob_id IS NULL`).get();
  if (Number(missing.count) !== 0) throw new Error(`${table} document BLOB backfill is incomplete`);
  db.exec(`ALTER TABLE ${table} DROP COLUMN content_blob`);
  db.exec(`
    CREATE INDEX idx_${table}_blob
      ON ${table}(document_blob_id, owner);

    CREATE TRIGGER ${triggerPrefix}_blob_insert
    BEFORE INSERT ON ${table}
    WHEN NEW.document_blob_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM document_blobs b
      WHERE b.id = NEW.document_blob_id
        AND b.owner = NEW.owner
        AND b.sha256 = NEW.sha256
        AND b.original_size_bytes = NEW.size_bytes
    )
    BEGIN
      SELECT RAISE(ABORT, '${table} document blob mismatch');
    END;

    CREATE TRIGGER ${triggerPrefix}_blob_update
    BEFORE UPDATE OF owner, sha256, size_bytes, document_blob_id ON ${table}
    WHEN NEW.document_blob_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM document_blobs b
      WHERE b.id = NEW.document_blob_id
        AND b.owner = NEW.owner
        AND b.sha256 = NEW.sha256
        AND b.original_size_bytes = NEW.size_bytes
    )
    BEGIN
      SELECT RAISE(ABORT, '${table} document blob mismatch');
    END;
  `);
}

export function apply(db) {
  createBlobTable(db);
  backfillBlobs(db);
  rebuildTravelExpenseAttachments(db);
  migrateDirectDocumentTable(db, {
    table: "travel_expense_document_inbox",
    triggerPrefix: "trg_travel_expense_document_inbox",
  });
  migrateDirectDocumentTable(db, {
    table: "invoice_documents",
    triggerPrefix: "trg_invoice_documents",
  });
  db.exec("DROP TABLE document_blob_migration_map");

  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`Lossless document migration left ${violations.length} foreign key violation(s)`);
  }
}
