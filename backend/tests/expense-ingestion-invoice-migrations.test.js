import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { all, openDatabase, run } from "../src/db.js";
import { createConnection } from "../src/db/connection.js";
import { apply as applyTravelExpenses } from "../src/db/migrations/0007_travel_expenses.mjs";
import { apply as applyExpenseIngestionInvoices } from "../src/db/migrations/0008_expense_ingestion_invoices.mjs";
import { documentBlobId, encodeDocumentBlob } from "../src/travelExpense/documentBlobCodec.js";

function columnNames(db, table) {
  return all(db, `PRAGMA table_info(${table})`).map((row) => row.name);
}

describe("expense ingestion and invoice migration", () => {
  it("creates durable ingestion, document inbox, invoice, match, confirmation, and candidate tables", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const tables = all(db, `
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'travel_expense_ingestions',
            'travel_expense_document_inbox',
            'invoice_documents',
            'invoice_matches',
            'travel_expense_no_invoice_confirmations',
            'invoice_match_candidates'
          )
        ORDER BY name
      `).map((row) => row.name);

      assert.deepEqual(tables, [
        "invoice_documents",
        "invoice_match_candidates",
        "invoice_matches",
        "travel_expense_document_inbox",
        "travel_expense_ingestions",
        "travel_expense_no_invoice_confirmations",
      ]);
      assert.equal(columnNames(db, "travel_expenses").includes("reference_code"), true);
      assert.deepEqual(columnNames(db, "travel_expense_ingestions"), [
        "id", "owner", "actor", "source", "idempotency_key_hash", "request_hash",
        "source_id", "raw_text", "captured_at", "status", "attempt_count", "lease_started_at",
        "analysis_provider", "analysis_model", "analysis_json", "warnings_json", "expense_id",
        "payment_id", "error_code", "created_at", "updated_at",
      ]);
      assert.deepEqual(columnNames(db, "invoice_documents"), [
        "id", "version", "owner", "source", "source_ref", "file_name", "media_type",
        "size_bytes", "sha256", "status", "extracted_text", "ocr_json",
        "model_json", "conflict_json", "invoice_code", "invoice_number", "issued_on",
        "seller_name", "buyer_name", "amount_ex_tax_cents", "tax_cents", "total_cents",
        "suggested_category", "created_by", "updated_by", "created_at", "updated_at",
        "deleted_at", "deleted_by", "document_blob_id",
      ]);
      assert.equal(
        all(db, "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '0008'")[0].count,
        1,
      );
    } finally {
      db.close();
    }
  });

  it("backfills stable visible expense codes for existing rows", () => {
    const db = createConnection({ databaseUrl: ":memory:" });
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyTravelExpenses(db);
      run(db, `
        INSERT INTO travel_expenses (
          id, owner, occurred_on, category, purpose, created_by, updated_by
        ) VALUES (
          'legacy-expense-a', 'owner-a', '2026-08-04', 'lunch', '客户午餐', 'owner-a', 'owner-a'
        )
      `);
      run(db, `
        INSERT INTO travel_expenses (
          id, owner, occurred_on, category, purpose, created_by, updated_by
        ) VALUES (
          'legacy-expense-b', 'owner-a', '2026-08-04', 'transport', '出租车', 'owner-a', 'owner-a'
        )
      `);

      applyExpenseIngestionInvoices(db);

      const rows = all(db, "SELECT id, reference_code FROM travel_expenses ORDER BY id");
      assert.equal(rows.length, 2);
      assert.match(rows[0].reference_code, /^EXP-20260804-[A-F0-9]{4,12}$/);
      assert.match(rows[1].reference_code, /^EXP-20260804-[A-F0-9]{4,12}$/);
      assert.notEqual(rows[0].reference_code, rows[1].reference_code);
      assert.throws(
        () => run(
          db,
          "UPDATE travel_expenses SET reference_code = $referenceCode WHERE id = $id",
          { $referenceCode: rows[0].reference_code, $id: rows[1].id },
        ),
        /UNIQUE constraint failed/i,
      );
    } finally {
      db.close();
    }
  });

  it("enforces ingestion idempotency, invoice hashes, file types, and money constraints", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      run(db, `
        INSERT INTO travel_expense_ingestions (
          id, owner, actor, source, idempotency_key_hash, request_hash, raw_text, status
        ) VALUES (
          'ingestion-1', 'owner-a', 'icost-webhook', 'icost', '${"1".repeat(64)}',
          '${"2".repeat(64)}', '午餐 20 元', 'received'
        )
      `);
      assert.throws(() => run(db, `
        INSERT INTO travel_expense_ingestions (
          id, owner, actor, source, idempotency_key_hash, request_hash, raw_text, status
        ) VALUES (
          'ingestion-2', 'owner-a', 'icost-webhook', 'icost', '${"1".repeat(64)}',
          '${"3".repeat(64)}', '午餐 30 元', 'received'
        )
      `), /UNIQUE constraint failed/i);

      const original = Buffer.from("%PDF-1.7\n%%EOF", "utf8");
      const encoded = encodeDocumentBlob(original);
      const blobId = documentBlobId("owner-a", encoded.sha256);
      run(db, `
        INSERT INTO document_blobs (
          id, owner, sha256, encoding, original_size_bytes, stored_size_bytes, content_blob
        ) VALUES (
          $id, 'owner-a', $sha256, $encoding, $originalSizeBytes, $storedSizeBytes, $content
        )
      `, {
        $id: blobId,
        $sha256: encoded.sha256,
        $encoding: encoded.encoding,
        $originalSizeBytes: encoded.originalSizeBytes,
        $storedSizeBytes: encoded.storedSizeBytes,
        $content: encoded.content,
      });
      const invoiceParams = {
        $id: "invoice-1",
        $owner: "owner-a",
        $source: "manual",
        $fileName: "invoice.pdf",
        $mediaType: "application/pdf",
        $sizeBytes: original.length,
        $sha256: encoded.sha256,
        $blobId: blobId,
        $actor: "owner-a",
      };
      run(db, `
        INSERT INTO invoice_documents (
          id, owner, source, file_name, media_type, size_bytes, sha256, document_blob_id,
          status, created_by, updated_by
        ) VALUES (
          $id, $owner, $source, $fileName, $mediaType, $sizeBytes, $sha256, $blobId,
          'unmatched', $actor, $actor
        )
      `, invoiceParams);
      assert.throws(() => run(db, `
        INSERT INTO invoice_documents (
          id, owner, source, file_name, media_type, size_bytes, sha256, document_blob_id,
          status, created_by, updated_by
        ) VALUES (
          $id, $owner, $source, $fileName, $mediaType, $sizeBytes, $sha256, $blobId,
          'unmatched', $actor, $actor
        )
      `, { ...invoiceParams, $id: "invoice-duplicate" }), /UNIQUE constraint failed/i);
      assert.throws(() => run(db, `
        INSERT INTO invoice_documents (
          id, owner, source, file_name, media_type, size_bytes, sha256, document_blob_id,
          status, created_by, updated_by
        ) VALUES (
          'invoice-html', 'owner-a', 'manual', 'invoice.html', 'text/html', $sizeBytes,
          $sha256, $blobId, 'unmatched', 'owner-a', 'owner-a'
        )
      `, {
        $sizeBytes: invoiceParams.$sizeBytes,
        $sha256: invoiceParams.$sha256,
        $blobId: invoiceParams.$blobId,
      }), /CHECK constraint failed/i);

      run(db, `
        INSERT INTO travel_expenses (
          id, reference_code, owner, occurred_on, category, purpose, created_by, updated_by
        ) VALUES (
          'expense-1', 'EXP-20260804-TEST', 'owner-a', '2026-08-04', 'lunch', '客户午餐', 'owner-a', 'owner-a'
        )
      `);
      assert.throws(() => run(db, `
        INSERT INTO invoice_matches (
          id, owner, invoice_id, expense_id, allocated_cents, match_method, state, created_by
        ) VALUES (
          'match-invalid', 'owner-a', 'invoice-1', 'expense-1', -1,
          'manual_selection', 'confirmed', 'owner-a'
        )
      `), /CHECK constraint failed/i);
    } finally {
      db.close();
    }
  });
});
