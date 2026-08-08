import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { createConnection } from "../src/db/connection.js";
import { apply as applyTravelExpenses } from "../src/db/migrations/0007_travel_expenses.mjs";
import { apply as applyExpenseIngestionInvoices } from "../src/db/migrations/0008_expense_ingestion_invoices.mjs";
import { apply as applyLosslessDocumentBlobs } from "../src/db/migrations/0009_lossless_document_blobs.mjs";
import {
  decodeDocumentBlob,
  documentBlobId,
  encodeDocumentBlob,
} from "../src/travelExpense/documentBlobCodec.js";
import { VALID_PNG } from "./helpers/image-fixtures.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function seedLegacyTables(db, { corruptInvoiceHash = false } = {}) {
  applyTravelExpenses(db);
  applyExpenseIngestionInvoices(db);
  for (const owner of ["owner-a", "owner-b"]) {
    db.prepare(`
      INSERT INTO travel_expenses (
        id, reference_code, owner, occurred_on, category, purpose, created_by, updated_by
      ) VALUES (
        $id, $referenceCode, $owner, '2026-08-04', 'other', '迁移测试', $owner, $owner
      )
    `).run({
      $id: `expense-${owner}`,
      $referenceCode: `EXP-20260804-${owner === "owner-a" ? "A001" : "B001"}`,
      $owner: owner,
    });
  }
  db.prepare(`
    INSERT INTO travel_expense_payments (
      id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents,
      funding_source, payment_method
    ) VALUES (
      'payment-a', 'expense-owner-a', 1, '2026-08-04T12:00:00+08:00',
      100, 100, 'personal', 'wechat'
    )
  `).run();
  for (const owner of ["owner-a", "owner-b"]) {
    db.prepare(`
      INSERT INTO travel_expense_attachments (
        id, expense_id, sequence, kind, file_name, media_type, size_bytes,
        content, covered_cents, created_by
      ) VALUES (
        $id, $expenseId, 1, 'invoice', 'same.png', 'image/png', $sizeBytes,
        $content, 0, $owner
      )
    `).run({
      $id: `attachment-${owner}`,
      $expenseId: `expense-${owner}`,
      $sizeBytes: VALID_PNG.length,
      $content: VALID_PNG,
      $owner: owner,
    });
  }
  db.prepare(`
    INSERT INTO travel_expense_attachment_payments (attachment_id, payment_id)
    VALUES ('attachment-owner-a', 'payment-a')
  `).run();

  db.prepare(`
    INSERT INTO travel_expense_document_inbox (
      id, owner, actor, source, document_kind, file_name, media_type,
      size_bytes, sha256, content_blob
    ) VALUES (
      'inbox-a', 'owner-a', 'owner-a', 'manual', 'invoice', 'same.png', 'image/png',
      $sizeBytes, $sha256, $content
    )
  `).run({
    $sizeBytes: VALID_PNG.length,
    $sha256: sha256(VALID_PNG),
    $content: VALID_PNG,
  });

  for (const owner of ["owner-a", "owner-b"]) {
    db.prepare(`
      INSERT INTO invoice_documents (
        id, owner, source, file_name, media_type, size_bytes, sha256, content_blob,
        status, created_by, updated_by
      ) VALUES (
        $id, $owner, 'manual', 'same.png', 'image/png', $sizeBytes, $sha256, $content,
        'unmatched', $owner, $owner
      )
    `).run({
      $id: `invoice-${owner}`,
      $owner: owner,
      $sizeBytes: VALID_PNG.length,
      $sha256: corruptInvoiceHash && owner === "owner-a" ? "0".repeat(64) : sha256(VALID_PNG),
      $content: VALID_PNG,
    });
  }
}

function decodeRow(row) {
  return decodeDocumentBlob({
    encoding: row.encoding,
    originalSizeBytes: Number(row.original_size_bytes),
    storedSizeBytes: Number(row.stored_size_bytes),
    sha256: row.sha256,
    content: row.content_blob,
  });
}

describe("lossless document blob migration", () => {
  it("backfills three legacy BLOB sources with same-owner deduplication and owner isolation", () => {
    const db = createConnection({ databaseUrl: ":memory:" });
    try {
      seedLegacyTables(db);

      applyLosslessDocumentBlobs(db);

      const blobs = db.prepare("SELECT * FROM document_blobs ORDER BY owner").all();
      assert.equal(blobs.length, 2);
      assert.deepEqual(blobs.map((row) => row.owner), ["owner-a", "owner-b"]);
      assert.deepEqual(decodeRow(blobs[0]), VALID_PNG);
      assert.deepEqual(decodeRow(blobs[1]), VALID_PNG);

      const attachmentA = db.prepare(
        "SELECT document_blob_id FROM travel_expense_attachments WHERE id = 'attachment-owner-a'",
      ).get();
      const inboxA = db.prepare(
        "SELECT document_blob_id FROM travel_expense_document_inbox WHERE id = 'inbox-a'",
      ).get();
      const invoiceA = db.prepare(
        "SELECT document_blob_id FROM invoice_documents WHERE id = 'invoice-owner-a'",
      ).get();
      const attachmentB = db.prepare(
        "SELECT document_blob_id FROM travel_expense_attachments WHERE id = 'attachment-owner-b'",
      ).get();
      assert.equal(attachmentA.document_blob_id, inboxA.document_blob_id);
      assert.equal(attachmentA.document_blob_id, invoiceA.document_blob_id);
      assert.notEqual(attachmentA.document_blob_id, attachmentB.document_blob_id);

      assert.equal(columns(db, "travel_expense_attachments").includes("content"), false);
      assert.equal(columns(db, "travel_expense_document_inbox").includes("content_blob"), false);
      assert.equal(columns(db, "invoice_documents").includes("content_blob"), false);
      assert.equal(columns(db, "travel_expense_attachments").includes("document_blob_id"), true);
      assert.equal(columns(db, "travel_expense_document_inbox").includes("document_blob_id"), true);
      assert.equal(columns(db, "invoice_documents").includes("document_blob_id"), true);

      assert.deepEqual(
        db.prepare("SELECT attachment_id, payment_id FROM travel_expense_attachment_payments").all()
          .map((row) => ({ attachment_id: row.attachment_id, payment_id: row.payment_id })),
        [{ attachment_id: "attachment-owner-a", payment_id: "payment-a" }],
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  });

  it("allows new PDF payment-proof metadata up to 12 MiB after rebuilding attachments", () => {
    const db = createConnection({ databaseUrl: ":memory:" });
    try {
      seedLegacyTables(db);
      applyLosslessDocumentBlobs(db);
      const maximumBytes = Buffer.alloc(12 * 1024 * 1024, 0x41);
      const encoded = encodeDocumentBlob(maximumBytes);
      const blobId = documentBlobId("owner-a", encoded.sha256);
      db.prepare(`
        INSERT INTO document_blobs (
          id, owner, sha256, encoding, original_size_bytes, stored_size_bytes, content_blob
        ) VALUES (
          $id, 'owner-a', $sha256, $encoding, $originalSizeBytes, $storedSizeBytes, $content
        )
      `).run({
        $id: blobId,
        $sha256: encoded.sha256,
        $encoding: encoded.encoding,
        $originalSizeBytes: encoded.originalSizeBytes,
        $storedSizeBytes: encoded.storedSizeBytes,
        $content: encoded.content,
      });

      db.prepare(`
        INSERT INTO travel_expense_attachments (
          id, expense_id, sequence, kind, file_name, media_type, size_bytes,
          document_blob_id, covered_cents, created_by
        ) VALUES (
          'pdf-proof', 'expense-owner-a', 2, 'payment_proof', 'proof.pdf',
          'application/pdf', 12582912, $blobId, 0, 'owner-a'
        )
      `).run({ $blobId: blobId });

      assert.equal(
        db.prepare("SELECT media_type, size_bytes FROM travel_expense_attachments WHERE id = 'pdf-proof'").get().media_type,
        "application/pdf",
      );
      assert.throws(() => db.prepare(`
        INSERT INTO travel_expense_attachments (
          id, expense_id, sequence, kind, file_name, media_type, size_bytes,
          document_blob_id, covered_cents, created_by
        ) VALUES (
          'too-large', 'expense-owner-a', 3, 'payment_proof', 'proof.pdf',
          'application/pdf', 12582913, $blobId, 0, 'owner-a'
        )
      `).run({ $blobId: blobId }), /constraint|mismatch/i);
    } finally {
      db.close();
    }
  });

  it("rolls back all schema and data changes when a legacy SHA-256 does not match its content", () => {
    const db = createConnection({ databaseUrl: ":memory:" });
    try {
      seedLegacyTables(db, { corruptInvoiceHash: true });
      db.exec("BEGIN IMMEDIATE");
      assert.throws(() => applyLosslessDocumentBlobs(db), /SHA-256/i);
      db.exec("ROLLBACK");

      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'document_blobs'").get().count,
        0,
      );
      assert.equal(columns(db, "invoice_documents").includes("content_blob"), true);
      assert.deepEqual(
        Buffer.from(db.prepare("SELECT content_blob FROM invoice_documents WHERE id = 'invoice-owner-a'").get().content_blob),
        VALID_PNG,
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  });
});
