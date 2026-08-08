import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { after, test } from "node:test";

const require = createRequire(import.meta.url);
const zlib = require("node:zlib");
const originalBrotliCompressSync = zlib.brotliCompressSync;
const originalBrotliDecompressSync = zlib.brotliDecompressSync;
let activeDb;

function identityEncoded(content) {
  return {
    encoding: "identity",
    originalSizeBytes: content.length,
    storedSizeBytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    content: Buffer.from(content),
  };
}

function outsideWriteTransaction(operation, implementation) {
  return (...args) => {
    assert.equal(
      activeDb?.isTransaction ?? false,
      false,
      `${operation} must not run while a SQLite write transaction is active`,
    );
    return implementation(...args);
  };
}

zlib.brotliCompressSync = outsideWriteTransaction(
  "synchronous Brotli compression",
  originalBrotliCompressSync,
);
zlib.brotliDecompressSync = outsideWriteTransaction(
  "synchronous Brotli decompression",
  originalBrotliDecompressSync,
);
syncBuiltinESMExports();

const [
  { openDatabase },
  { createConnection },
  { withImmediateTransaction },
  documentBlobStore,
  { createTravelExpenseRepository },
  { createInvoiceRepository },
  { apply: applyTravelExpenses },
  { apply: applyExpenseIngestionInvoices },
  { apply: applyLosslessDocumentBlobs },
  { VALID_PDF, VALID_PNG },
] = await Promise.all([
  import("../src/db.js?document-blob-transaction-test"),
  import("../src/db/connection.js?document-blob-transaction-test"),
  import("../src/db/transaction.js?document-blob-transaction-test"),
  import("../src/travelExpense/documentBlobStore.js?document-blob-transaction-test"),
  import("../src/travelExpense/repository.js?document-blob-transaction-test"),
  import("../src/travelExpense/invoiceRepository.js?document-blob-transaction-test"),
  import("../src/db/migrations/0007_travel_expenses.mjs?document-blob-transaction-test"),
  import("../src/db/migrations/0008_expense_ingestion_invoices.mjs?document-blob-transaction-test"),
  import("../src/db/migrations/0009_lossless_document_blobs.mjs?document-blob-transaction-test"),
  import("./helpers/image-fixtures.js?document-blob-transaction-test"),
]);

after(() => {
  zlib.brotliCompressSync = originalBrotliCompressSync;
  zlib.brotliDecompressSync = originalBrotliDecompressSync;
  syncBuiltinESMExports();
});

test("prepared duplicate blobs do not synchronously decompress inside the write transaction", async () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    const content = Buffer.from("prepared duplicate invoice bytes\n".repeat(2048), "utf8");
    const encoded = await documentBlobStore.prepareDocumentBlob(content);

    withImmediateTransaction(db, () => {
      documentBlobStore.putDocumentBlob(db, { owner: "owner-a", content, encoded });
    });
    const stored = withImmediateTransaction(db, () => documentBlobStore.putDocumentBlob(db, {
      owner: "owner-a",
      content,
      encoded,
    }));

    assert.deepEqual(
      documentBlobStore.readDocumentBlob(db, { id: stored.id, owner: "owner-a" }),
      content,
    );
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("repository fallback prepares the blob before opening its write transaction", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    let idCounter = 0;
    const repository = createTravelExpenseRepository(db, {
      idFactory: () => `transaction-${++idCounter}`,
      clock: () => new Date("2026-08-05T01:00:00.000Z"),
    });
    const expense = repository.createExpense({
      actor: "owner-a",
      occurredOn: "2026-08-05",
      category: "lunch",
      purpose: "Transaction boundary regression",
      merchant: "Example merchant",
      payments: [{
        paidAt: "2026-08-05T12:00:00+08:00",
        merchant: "Example merchant",
        amountCents: 100,
        reimbursementCents: 100,
        fundingSource: "personal",
        paymentMethod: "wechat",
      }],
    });

    const updated = repository.addAttachment(expense.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: expense.version,
      paymentIds: [],
      kind: "invoice",
      fileName: "invoice.png",
      mediaType: "image/png",
      content: VALID_PNG,
    });

    const stored = repository.getAttachmentContent(updated.attachments[0].id, { owner: "owner-a" });
    assert.deepEqual(stored.content, VALID_PNG);
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("invoice repository fallback prepares the blob before opening its write transaction", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    const repository = createInvoiceRepository(db, {
      idFactory: () => "invoice-transaction-1",
      clock: () => new Date("2026-08-05T01:00:00.000Z"),
    });
    const invoice = repository.createInvoice({
      owner: "owner-a",
      actor: "owner-a",
      source: "manual",
      fileName: "invoice.pdf",
      mediaType: "application/pdf",
      content: VALID_PDF,
      recognition: {},
    });

    const stored = repository.getInvoiceContent(invoice.id, { owner: "owner-a" });
    assert.deepEqual(stored.content, VALID_PDF);
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("low-level document content reads are rejected inside SQLite transactions", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    const content = Buffer.from("transactional document read bytes\n".repeat(2048), "utf8");
    const stored = documentBlobStore.putDocumentBlob(db, { owner: "owner-a", content });

    assert.throws(
      () => withImmediateTransaction(db, () => documentBlobStore.readDocumentBlob(db, {
        id: stored.id,
        owner: "owner-a",
      })),
      /document blob content must be read outside SQLite transactions/,
    );
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("travel expense attachment content reads are rejected inside SQLite transactions", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    let idCounter = 0;
    const repository = createTravelExpenseRepository(db, {
      idFactory: () => `read-transaction-${++idCounter}`,
      clock: () => new Date("2026-08-05T01:00:00.000Z"),
    });
    const expense = repository.createExpense({
      actor: "owner-a",
      occurredOn: "2026-08-05",
      category: "lunch",
      purpose: "Read transaction regression",
      payments: [{
        paidAt: "2026-08-05T12:00:00+08:00",
        merchant: "Example merchant",
        amountCents: 100,
        reimbursementCents: 100,
        fundingSource: "personal",
        paymentMethod: "wechat",
      }],
    });
    const updated = repository.addAttachment(expense.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: expense.version,
      paymentIds: [],
      kind: "invoice",
      fileName: "invoice.png",
      mediaType: "image/png",
      content: VALID_PNG,
    });

    assert.throws(
      () => withImmediateTransaction(db, () => repository.getAttachmentContent(
        updated.attachments[0].id,
        { owner: "owner-a" },
      )),
      /document blob content must be read outside SQLite transactions/,
    );
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("invoice content reads are rejected inside SQLite transactions", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    const repository = createInvoiceRepository(db, {
      idFactory: () => "invoice-read-transaction-1",
      clock: () => new Date("2026-08-05T01:00:00.000Z"),
    });
    const invoice = repository.createInvoice({
      owner: "owner-a",
      actor: "owner-a",
      source: "manual",
      fileName: "invoice.pdf",
      mediaType: "application/pdf",
      content: VALID_PDF,
      recognition: {},
    });

    assert.throws(
      () => withImmediateTransaction(db, () => repository.getInvoiceContent(invoice.id, {
        owner: "owner-a",
      })),
      /document blob content must be read outside SQLite transactions/,
    );
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("unprepared low-level fallback is rejected before synchronous compression can enter a transaction", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    assert.throws(
      () => withImmediateTransaction(db, () => documentBlobStore.putDocumentBlob(db, {
        owner: "owner-a",
        content: VALID_PNG,
      })),
      /must be prepared before starting a SQLite write transaction/,
    );
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("transaction-time deduplication accepts a prevalidated blob with a different lossless encoding", async () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    const content = Buffer.from("legacy identity invoice bytes\n".repeat(2048), "utf8");
    const legacy = documentBlobStore.putDocumentBlob(db, {
      owner: "owner-a",
      content,
      encoded: identityEncoded(content),
    });

    const prepared = await documentBlobStore.prepareDocumentBlobForWrite(db, {
      owner: "owner-a",
      content,
    });
    assert.equal(prepared.encoding, "br");
    const replay = withImmediateTransaction(db, () => documentBlobStore.putDocumentBlob(db, {
      owner: "owner-a",
      content,
      encoded: prepared,
    }));

    assert.equal(replay.id, legacy.id);
    assert.deepEqual(documentBlobStore.readDocumentBlob(db, {
      id: replay.id,
      owner: "owner-a",
    }), content);
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("a changed deduplication row is reported as stale and succeeds after outside-transaction refresh", async () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    const content = Buffer.from("preflight race invoice bytes\n".repeat(2048), "utf8");
    const prepared = await documentBlobStore.prepareDocumentBlobForWrite(db, {
      owner: "owner-a",
      content,
    });
    documentBlobStore.putDocumentBlob(db, {
      owner: "owner-a",
      content,
      encoded: identityEncoded(content),
    });

    assert.throws(
      () => withImmediateTransaction(db, () => documentBlobStore.putDocumentBlob(db, {
        owner: "owner-a",
        content,
        encoded: prepared,
      })),
      (error) => error?.code === "DOCUMENT_BLOB_PREFLIGHT_STALE",
    );

    const refreshed = await documentBlobStore.prepareDocumentBlobForWrite(db, {
      owner: "owner-a",
      content,
      encoded: prepared,
    });
    const replay = withImmediateTransaction(db, () => documentBlobStore.putDocumentBlob(db, {
      owner: "owner-a",
      content,
      encoded: refreshed,
    }));
    assert.deepEqual(documentBlobStore.readDocumentBlob(db, {
      id: replay.id,
      owner: "owner-a",
    }), content);
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("write preflight retries one stale transaction with a refreshed snapshot", async () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    const content = Buffer.from("retryable preflight invoice bytes\n".repeat(2048), "utf8");
    db.exec(`
      CREATE TABLE retry_business_write (id TEXT PRIMARY KEY);
      CREATE TABLE retry_audit_write (id TEXT PRIMARY KEY);
      CREATE TABLE retry_idempotency_completion (id TEXT PRIMARY KEY);
    `);
    let attempts = 0;
    const stored = await documentBlobStore.withDocumentBlobWritePreflight(db, {
      owner: "owner-a",
      content,
    }, (prepared) => {
      attempts += 1;
      if (attempts === 1) {
        documentBlobStore.putDocumentBlob(db, {
          owner: "owner-a",
          content,
          encoded: identityEncoded(content),
        });
      }
      return withImmediateTransaction(db, () => {
        db.prepare("INSERT INTO retry_business_write (id) VALUES ('business-1')").run();
        db.prepare("INSERT INTO retry_audit_write (id) VALUES ('audit-1')").run();
        const result = documentBlobStore.putDocumentBlob(db, {
          owner: "owner-a",
          content,
          encoded: prepared,
        });
        db.prepare("INSERT INTO retry_idempotency_completion (id) VALUES ('complete-1')").run();
        return result;
      });
    });

    assert.equal(attempts, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM retry_business_write").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM retry_audit_write").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM retry_idempotency_completion").get().count, 1);
    assert.deepEqual(documentBlobStore.readDocumentBlob(db, {
      id: stored.id,
      owner: "owner-a",
    }), content);
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("opaque preflight keeps verified encoded bytes isolated from the public buffer copy", async () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    const content = Buffer.from("opaque preflight invoice bytes\n".repeat(2048), "utf8");
    const prepared = await documentBlobStore.prepareDocumentBlobForWrite(db, {
      owner: "owner-a",
      content,
    });
    prepared.content.fill(0);

    const stored = withImmediateTransaction(db, () => documentBlobStore.putDocumentBlob(db, {
      owner: "owner-a",
      content,
      encoded: prepared,
    }));

    assert.deepEqual(documentBlobStore.readDocumentBlob(db, {
      id: stored.id,
      owner: "owner-a",
    }), content);
  } finally {
    activeDb = undefined;
    db.close();
  }
});

test("lossless migration backfills identity bytes without synchronous Brotli inside its write transaction", () => {
  const db = createConnection({ databaseUrl: ":memory:" });
  activeDb = db;
  try {
    applyTravelExpenses(db);
    applyExpenseIngestionInvoices(db);
    db.prepare(`
      INSERT INTO travel_expenses (
        id, reference_code, owner, occurred_on, category, purpose, created_by, updated_by
      ) VALUES (
        'expense-1', 'EXP-20260805-0001', 'owner-a', '2026-08-05', 'other',
        'Migration transaction regression', 'owner-a', 'owner-a'
      )
    `).run();
    db.prepare(`
      INSERT INTO travel_expense_attachments (
        id, expense_id, sequence, kind, file_name, media_type, size_bytes,
        content, covered_cents, created_by
      ) VALUES (
        'attachment-1', 'expense-1', 1, 'invoice', 'invoice.png', 'image/png',
        $sizeBytes, $content, 0, 'owner-a'
      )
    `).run({
      $sizeBytes: VALID_PNG.length,
      $content: VALID_PNG,
    });

    withImmediateTransaction(db, () => applyLosslessDocumentBlobs(db));

    const row = db.prepare("SELECT * FROM document_blobs").get();
    assert.equal(row.encoding, "identity");
    assert.equal(Number(row.original_size_bytes), VALID_PNG.length);
    assert.deepEqual(Buffer.from(row.content_blob), VALID_PNG);
  } finally {
    activeDb = undefined;
    db.close();
  }
});
