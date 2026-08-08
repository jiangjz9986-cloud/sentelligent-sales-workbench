import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { all, migrateDatabase, openDatabase, run } from "../src/db.js";
import { documentBlobId, encodeDocumentBlob } from "../src/travelExpense/documentBlobCodec.js";

function columns(db, table) {
  return all(db, `PRAGMA table_info(${table})`);
}

describe("travel expense migration", () => {
  it("creates expense, payment, attachment, and advance tables", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const tableNames = all(db, `
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'travel_expense%'
        ORDER BY name
      `).map((row) => row.name);

      assert.deepEqual(tableNames, [
        "travel_expense_advances",
        "travel_expense_attachment_payments",
        "travel_expense_attachments",
        "travel_expense_document_inbox",
        "travel_expense_ingestions",
        "travel_expense_no_invoice_confirmations",
        "travel_expense_payments",
        "travel_expenses",
      ]);

      assert.deepEqual(columns(db, "travel_expenses").map((column) => column.name), [
        "id", "version", "owner", "occurred_on", "category", "purpose", "merchant",
        "itinerary_id", "customer_id", "invoice_status", "notes", "created_by", "updated_by",
        "created_at", "updated_at", "deleted_at", "deleted_by", "reference_code",
      ]);
      assert.deepEqual(columns(db, "travel_expense_payments").map((column) => column.name), [
        "id", "expense_id", "sequence", "paid_at", "merchant", "amount_cents",
        "reimbursement_cents", "funding_source", "payment_method", "account_last4",
        "difference_reason", "created_at", "updated_at",
      ]);
      assert.deepEqual(columns(db, "travel_expense_attachments").map((column) => column.name), [
        "id", "expense_id", "sequence", "kind", "file_name", "media_type",
        "size_bytes", "document_blob_id", "covered_cents", "notes", "created_by", "created_at",
      ]);
      assert.deepEqual(columns(db, "travel_expense_attachment_payments").map((column) => column.name), [
        "attachment_id", "payment_id",
      ]);
      assert.deepEqual(columns(db, "travel_expense_advances").map((column) => column.name), [
        "id", "version", "owner", "week_start", "status", "requested_cents", "received_cents",
        "requested_on", "received_on", "purpose", "notes", "created_by", "updated_by",
        "created_at", "updated_at", "deleted_at", "deleted_by",
      ]);

      const migration = all(db, "SELECT version, checksum FROM schema_migrations WHERE version = '0007'");
      assert.equal(migration.length, 1);
      assert.match(migration[0].checksum, /^[a-f0-9]{64}$/);
      assert.equal(
        all(db, "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '0009'")[0].count,
        1,
      );
      assert.equal(
        all(db, "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'document_blobs'")[0].count,
        1,
      );
    } finally {
      db.close();
    }
  });

  it("enforces category, funding source, amount, and attachment constraints", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const expense = {
        $id: "expense-1",
        $referenceCode: "EXP-20260804-TEST0001",
        $owner: "owner-a",
        $occurredOn: "2026-08-04",
        $category: "lunch",
        $purpose: "出差午餐",
        $actor: "owner-a",
      };
      run(db, `
        INSERT INTO travel_expenses (
          id, reference_code, owner, occurred_on, category, purpose, created_by, updated_by
        ) VALUES ($id, $referenceCode, $owner, $occurredOn, $category, $purpose, $actor, $actor)
      `, expense);

      assert.throws(() => run(db, `
        INSERT INTO travel_expenses (
          id, reference_code, owner, occurred_on, category, purpose, created_by, updated_by
        ) VALUES ($id, $referenceCode, $owner, $occurredOn, $category, $purpose, $actor, $actor)
      `, {
        ...expense,
        $id: "bad-category",
        $referenceCode: "EXP-20260804-TEST0002",
        $category: "snack",
      }), /CHECK constraint failed/i);

      const payment = {
        $id: "payment-1",
        $expenseId: "expense-1",
        $paidAt: "2026-08-04T12:00:00+08:00",
        $amountCents: 1200,
        $reimbursementCents: 1200,
        $fundingSource: "personal",
      };
      run(db, `
        INSERT INTO travel_expense_payments (
          id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents, funding_source
        ) VALUES ($id, $expenseId, 1, $paidAt, $amountCents, $reimbursementCents, $fundingSource)
      `, payment);

      assert.throws(() => run(db, `
        INSERT INTO travel_expense_payments (
          id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents, funding_source
        ) VALUES ($id, $expenseId, 2, $paidAt, -1, 0, $fundingSource)
      `, {
        $id: "bad-amount",
        $expenseId: payment.$expenseId,
        $paidAt: payment.$paidAt,
        $fundingSource: payment.$fundingSource,
      }), /CHECK constraint failed/i);
      assert.throws(() => run(db, `
        INSERT INTO travel_expense_payments (
          id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents, funding_source
        ) VALUES ($id, $expenseId, 2, $paidAt, $amountCents, $reimbursementCents, 'friend')
      `, {
        $id: "bad-funding",
        $expenseId: payment.$expenseId,
        $paidAt: payment.$paidAt,
        $amountCents: payment.$amountCents,
        $reimbursementCents: payment.$reimbursementCents,
      }), /CHECK constraint failed/i);

      const encoded = encodeDocumentBlob(Buffer.from([0x01]));
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
      assert.throws(() => run(db, `
        INSERT INTO travel_expense_attachments (
          id, expense_id, sequence, kind, file_name, media_type, size_bytes,
          document_blob_id, created_by
        ) VALUES (
          'large', 'expense-1', 1, 'payment_proof', 'proof.pdf', 'application/pdf',
          12582913, $blobId, 'owner-a'
        )
      `, { $blobId: blobId }), /constraint|mismatch/i);
    } finally {
      db.close();
    }
  });

  it("is idempotent when migrations run again", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const before = all(db, "SELECT version, checksum FROM schema_migrations ORDER BY version");
      migrateDatabase(db);
      assert.deepEqual(all(db, "SELECT version, checksum FROM schema_migrations ORDER BY version"), before);
    } finally {
      db.close();
    }
  });
});
