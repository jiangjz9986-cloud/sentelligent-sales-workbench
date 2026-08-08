import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import {
  InvoiceDuplicateError,
  InvoiceNotFoundError,
  InvoiceVersionConflictError,
  createInvoiceRepository,
} from "../src/travelExpense/invoiceRepository.js";
import { DocumentBlobIntegrityError } from "../src/travelExpense/documentBlobCodec.js";
import { VALID_PDF, VALID_PNG } from "./helpers/image-fixtures.js";

const PDF = VALID_PDF;

let db;
let repository;
let idCounter;
let now;

function recognition(overrides = {}) {
  return {
    status: "review_required",
    extractedText: "发票日期 2026-08-04 价税合计 100.00元",
    ocr: {
      invoiceCode: "044002100111",
      invoiceNumber: "12345678",
      issuedOn: "2026-08-03",
      sellerName: "示例酒店有限公司",
      buyerName: "森特公司",
      amountExTaxCents: 9434,
      taxCents: 566,
      totalCents: 9900,
      suggestedCategory: "lodging",
    },
    model: {
      invoiceCode: "044002100111",
      invoiceNumber: "12345678",
      issuedOn: "2026-08-04",
      sellerName: "示例酒店有限公司",
      buyerName: "森特公司",
      amountExTaxCents: 9434,
      taxCents: 566,
      totalCents: 10000,
      suggestedCategory: "lodging",
    },
    fields: {
      invoiceCode: "044002100111",
      invoiceNumber: "12345678",
      issuedOn: null,
      sellerName: "示例酒店有限公司",
      buyerName: "森特公司",
      amountExTaxCents: 9434,
      taxCents: 566,
      totalCents: null,
      suggestedCategory: "lodging",
    },
    conflicts: [
      { field: "issuedOn", ocrValue: "2026-08-03", modelValue: "2026-08-04" },
      { field: "totalCents", ocrValue: 9900, modelValue: 10000 },
    ],
    warnings: [],
    ...overrides,
  };
}

function invoiceInput(overrides = {}) {
  return {
    owner: "owner-a",
    actor: "owner-a",
    source: "manual",
    sourceRef: null,
    fileName: "住宿发票.pdf",
    mediaType: "application/pdf",
    content: PDF,
    recognition: recognition(),
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  idCounter = 0;
  now = "2026-08-04T08:00:00.000Z";
  repository = createInvoiceRepository(db, {
    idFactory: () => `invoice-${++idCounter}`,
    clock: () => new Date(now),
  });
});

afterEach(() => db.close());

describe("invoice repository", () => {
  it("stores the original securely while list and detail metadata omit the blob", () => {
    const created = repository.createInvoice(invoiceInput());

    assert.equal(created.id, "invoice-1");
    assert.equal(created.version, 1);
    assert.equal(created.status, "review_required");
    assert.equal(created.sizeBytes, PDF.length);
    assert.match(created.sha256, /^[0-9a-f]{64}$/);
    assert.equal(created.content, undefined);
    assert.equal(created.contentBlob, undefined);
    assert.deepEqual(created.conflicts.map((item) => item.field), ["issuedOn", "totalCents"]);

    const listed = repository.listInvoices({ owner: "owner-a" });
    assert.deepEqual(listed, [created]);
    assert.equal(JSON.stringify(listed).includes(PDF.toString("base64")), false);
    assert.deepEqual(repository.getInvoice(created.id, { owner: "owner-a" }), created);

    const content = repository.getInvoiceContent(created.id, { owner: "owner-a" });
    assert.equal(content.fileName, "住宿发票.pdf");
    assert.equal(content.mediaType, "application/pdf");
    assert.deepEqual(content.content, PDF);
    assert.equal(repository.getInvoiceContent(created.id, { owner: "owner-b" }), null);
  });

  it("rejects a duplicate content hash per owner and reveals only the existing id", () => {
    const first = repository.createInvoice(invoiceInput());

    assert.throws(
      () => repository.createInvoice(invoiceInput({ fileName: "duplicate.pdf" })),
      (error) => error instanceof InvoiceDuplicateError
        && error.existingInvoiceId === first.id
        && !String(error.message).includes(first.sha256),
    );

    const otherOwner = repository.createInvoice(invoiceInput({ owner: "owner-b", actor: "owner-b" }));
    assert.equal(otherOwner.owner, "owner-b");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_blobs").get().count, 2);
  });

  it("rolls back a newly stored blob when invoice metadata insertion fails", () => {
    const first = repository.createInvoice(invoiceInput());
    const conflictingRepository = createInvoiceRepository(db, {
      idFactory: () => first.id,
      clock: () => new Date(now),
    });

    assert.throws(
      () => conflictingRepository.createInvoice(invoiceInput({
        fileName: "different.png",
        mediaType: "image/png",
        content: VALID_PNG,
        recognition: recognition({ status: "unmatched", conflicts: [] }),
      })),
      /UNIQUE constraint failed/i,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_documents").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_blobs").get().count, 1);
  });

  it("rejects corrupted stored invoice bytes before returning content", () => {
    const created = repository.createInvoice(invoiceInput());
    const row = db.prepare("SELECT document_blob_id FROM invoice_documents WHERE id = $id")
      .get({ $id: created.id });
    db.prepare("UPDATE document_blobs SET content_blob = zeroblob(stored_size_bytes) WHERE id = $id")
      .run({ $id: row.document_blob_id });

    assert.throws(
      () => repository.getInvoiceContent(created.id, { owner: "owner-a" }),
      (error) => error instanceof DocumentBlobIntegrityError,
    );
  });

  it("rejects stored invoice when blob digest metadata disagrees with invoice digest", () => {
    const created = repository.createInvoice(invoiceInput());
    const row = db.prepare("SELECT document_blob_id FROM invoice_documents WHERE id = $id")
      .get({ $id: created.id });
    db.prepare("UPDATE document_blobs SET sha256 = $sha256 WHERE id = $id")
      .run({ $id: row.document_blob_id, $sha256: "0".repeat(64) });

    assert.throws(
      () => repository.getInvoiceContent(created.id, { owner: "owner-a" }),
      (error) => error instanceof DocumentBlobIntegrityError,
    );
  });

  it("rejects stored invoice content whose blob id is not its deterministic content address", () => {
    const created = repository.createInvoice(invoiceInput());
    const row = db.prepare("SELECT document_blob_id FROM invoice_documents WHERE id = $id")
      .get({ $id: created.id });
    const corruptId = "f".repeat(64);
    assert.notEqual(corruptId, row.document_blob_id);
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.prepare("UPDATE document_blobs SET id = $corruptId WHERE id = $id")
        .run({ $corruptId: corruptId, $id: row.document_blob_id });
      db.prepare("UPDATE invoice_documents SET document_blob_id = $corruptId WHERE id = $id")
        .run({ $corruptId: corruptId, $id: created.id });
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }

    assert.throws(
      () => repository.getInvoiceContent(created.id, { owner: "owner-a" }),
      (error) => error instanceof DocumentBlobIntegrityError,
    );
  });

  it("allows an authenticated owner to resolve conflicts with optimistic locking", () => {
    const created = repository.createInvoice(invoiceInput());
    now = "2026-08-04T09:00:00.000Z";
    const finalized = repository.finalizeReview(created.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
      fields: {
        invoiceCode: "044002100111",
        invoiceNumber: "12345678",
        issuedOn: "2026-08-04",
        sellerName: "示例酒店有限公司",
        buyerName: "森特公司",
        amountExTaxCents: 9434,
        taxCents: 566,
        totalCents: 10000,
        suggestedCategory: "lodging",
      },
    });

    assert.equal(finalized.version, 2);
    assert.equal(finalized.status, "unmatched");
    assert.equal(finalized.issuedOn, "2026-08-04");
    assert.equal(finalized.totalCents, 10000);
    assert.deepEqual(finalized.conflicts, []);
    assert.equal(finalized.updatedAt, now);

    assert.throws(
      () => repository.finalizeReview(created.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: 1,
        fields: recognition().fields,
      }),
      (error) => error instanceof InvoiceVersionConflictError && error.currentVersion === 2,
    );
  });

  it("isolates owners and soft-deletes without losing the retained original", () => {
    const created = repository.createInvoice(invoiceInput({
      fileName: "餐饮发票.png",
      mediaType: "image/png",
      content: VALID_PNG,
      recognition: recognition({ status: "unmatched", conflicts: [] }),
    }));

    assert.equal(repository.getInvoice(created.id, { owner: "owner-b" }), null);
    assert.throws(
      () => repository.finalizeReview(created.id, {
        owner: "owner-b",
        actor: "owner-b",
        expectedVersion: 1,
        fields: recognition().fields,
      }),
      InvoiceNotFoundError,
    );

    const deleted = repository.softDeleteInvoice(created.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
    });
    assert.equal(deleted.version, 2);
    assert.ok(deleted.deletedAt);
    assert.equal(repository.getInvoice(created.id, { owner: "owner-a" }), null);
    assert.deepEqual(repository.listInvoices({ owner: "owner-a" }), []);
    assert.equal(repository.getInvoiceContent(created.id, { owner: "owner-a" }), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_blobs").get().count, 1);
  });

  it("allows the same bytes to be uploaded again after the prior invoice is tombstoned", () => {
    const input = invoiceInput({
      fileName: "可重传发票.png",
      mediaType: "image/png",
      content: VALID_PNG,
      recognition: recognition({ status: "unmatched", conflicts: [] }),
    });
    const original = repository.createInvoice(input);
    repository.softDeleteInvoice(original.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: original.version,
    });

    const replacement = repository.createInvoice(input);

    assert.equal(replacement.id, original.id);
    assert.equal(replacement.version, 3);
    assert.equal(replacement.sha256, original.sha256);
    assert.equal(repository.getInvoice(original.id, { owner: "owner-a" }).id, original.id);
    assert.equal(repository.listInvoices({ owner: "owner-a" }).length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_blobs").get().count, 1);
  });
});
