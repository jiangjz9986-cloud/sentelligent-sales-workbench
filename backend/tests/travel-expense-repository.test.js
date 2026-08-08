import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import {
  TravelExpenseDependencyConflictError,
  TravelExpenseNotFoundError,
  TravelExpenseVersionConflictError,
  createTravelExpenseRepository,
} from "../src/travelExpense/repository.js";
import { DocumentBlobIntegrityError } from "../src/travelExpense/documentBlobCodec.js";
import {
  SHORT_JPEG_ENVELOPE,
  SHORT_PNG_SIGNATURE,
  SHORT_WEBP_CONTAINER,
  VALID_JPEG,
  VALID_PDF,
  VALID_PNG,
  VALID_WEBP,
} from "./helpers/image-fixtures.js";

let db;
let repository;
let idCounter;
let now;

function payment(overrides = {}) {
  return {
    id: overrides.id,
    paidAt: "2026-08-04T12:30:00+08:00",
    merchant: "示例餐厅",
    amountCents: 4800,
    reimbursementCents: 4500,
    fundingSource: "personal",
    paymentMethod: "wechat",
    accountLast4: "1234",
    differenceReason: "个人饮品不计入报销",
    ...overrides,
  };
}

function expense(overrides = {}) {
  return {
    actor: "owner-a",
    occurredOn: "2026-08-04",
    category: "lunch",
    purpose: "济宁出差午餐",
    merchant: "示例餐厅",
    notes: "规则待配置",
    payments: [payment(), payment({ amountCents: 1200, reimbursementCents: 1200, fundingSource: "advance", accountLast4: "" })],
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  idCounter = 0;
  now = "2026-08-04T03:00:00.000Z";
  repository = createTravelExpenseRepository(db, {
    idFactory: () => `travel-${++idCounter}`,
    clock: () => new Date(now),
  });
});

afterEach(() => db.close());

describe("travel expense repository", () => {
  it("creates a versioned expense with multiple actual payments and lists it by natural week", () => {
    const created = repository.createExpense(expense());

    assert.equal(created.id, "travel-1");
    assert.match(created.referenceCode, /^EXP-20260804-[A-F0-9]{8}$/);
    assert.equal(created.version, 1);
    assert.equal(created.owner, "owner-a");
    assert.equal(created.payments.length, 2);
    assert.deepEqual(created.payments.map((item) => item.id), ["travel-2", "travel-3"]);
    assert.equal(created.actualPaidCents, 6000);
    assert.equal(created.reimbursementCents, 5700);
    assert.deepEqual(created.attachments, []);
    assert.deepEqual(repository.listExpenses({ owner: "owner-a", weekStart: "2026-08-03" }), [created]);
    assert.deepEqual(repository.listExpenses({ owner: "owner-a", weekStart: "2026-07-27" }), []);
    assert.deepEqual(repository.listExpenses({ owner: "owner-b", weekStart: "2026-08-03" }), []);
  });

  it("always creates an ordinary expense with pending invoice status", () => {
    const created = repository.createExpense(expense({ invoiceStatus: "covered" }));

    assert.equal(created.invoiceStatus, "pending");
  });

  it("recomputes invoice status instead of preserving a forged stored value", () => {
    for (const derivedStatus of ["missing", "partial", "covered"]) {
      const created = repository.createExpense(expense());
      db.prepare("UPDATE travel_expenses SET invoice_status = $status WHERE id = $id")
        .run({ $id: created.id, $status: derivedStatus });

      const updated = repository.updateExpense(created.id, expense({
        owner: "owner-a",
        expectedVersion: 1,
        purpose: `Updated while ${derivedStatus}`,
        invoiceStatus: "pending",
        payments: created.payments.map((item) => payment({
          id: item.id,
          paidAt: item.paidAt,
          merchant: item.merchant,
          amountCents: item.amountCents,
          reimbursementCents: item.reimbursementCents,
          fundingSource: item.fundingSource,
          paymentMethod: item.paymentMethod,
          accountLast4: item.accountLast4 ?? "",
          differenceReason: item.differenceReason ?? "",
        })),
      }));

      assert.equal(updated.invoiceStatus, "pending");
    }
  });

  it("updates payments atomically, preserves supplied payment ids, and rejects a stale version", () => {
    const created = repository.createExpense(expense());
    now = "2026-08-04T04:00:00.000Z";
    const updated = repository.updateExpense(created.id, expense({
      owner: "owner-a",
      expectedVersion: 1,
      purpose: "调整后的午餐记录",
      payments: [payment({
        id: created.payments[0].id,
        amountCents: 5000,
        reimbursementCents: 5000,
        differenceReason: "",
      })],
    }));

    assert.equal(updated.version, 2);
    assert.equal(updated.purpose, "调整后的午餐记录");
    assert.deepEqual(updated.payments.map((item) => item.id), [created.payments[0].id]);
    assert.equal(updated.actualPaidCents, 5000);
    assert.equal(updated.updatedAt, now);

    assert.throws(
      () => repository.updateExpense(created.id, expense({ owner: "owner-a", expectedVersion: 1 })),
      (error) => error instanceof TravelExpenseVersionConflictError && error.currentVersion === 2,
    );
    assert.deepEqual(repository.getExpense(created.id, { owner: "owner-a" }), updated);
  });

  it("preserves payment ids when existing payments exchange sequence positions", () => {
    const created = repository.createExpense(expense());

    const updated = repository.updateExpense(created.id, expense({
      owner: "owner-a",
      expectedVersion: 1,
      payments: [
        payment({
          id: created.payments[1].id,
          amountCents: 1200,
          reimbursementCents: 1200,
          fundingSource: "advance",
          accountLast4: "",
          differenceReason: "",
        }),
        payment({ id: created.payments[0].id }),
      ],
    }));

    assert.deepEqual(updated.payments.map((item) => item.id), [
      created.payments[1].id,
      created.payments[0].id,
    ]);
    assert.deepEqual(updated.payments.map((item) => item.sequence), [1, 2]);
  });

  it("rolls back an update that removes a payment with a linked payment proof", () => {
    const created = repository.createExpense(expense());
    const withAttachment = repository.addAttachment(created.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
      paymentIds: [created.payments[1].id],
      kind: "payment_proof",
      fileName: "second-payment.png",
      mediaType: "image/png",
      content: VALID_PNG,
      coveredCents: created.payments[1].reimbursementCents,
      notes: "Linked only to the second payment",
    });

    now = "2026-08-04T05:00:00.000Z";
    assert.throws(
      () => repository.updateExpense(created.id, expense({
        owner: "owner-a",
        expectedVersion: withAttachment.version,
        purpose: "This change must roll back",
        payments: [payment({
          id: created.payments[0].id,
          amountCents: 5000,
          reimbursementCents: 5000,
          differenceReason: "",
        })],
      })),
      (error) => (
        error instanceof TravelExpenseDependencyConflictError
        && error.code === "PAYMENT_HAS_DEPENDENCIES"
        && error.message.includes(created.payments[1].id)
      ),
    );

    assert.deepEqual(repository.getExpense(created.id, { owner: "owner-a" }), withAttachment);
  });

  it("rejects a payment proof without a linked payment before changing the expense", () => {
    const created = repository.createExpense(expense());

    assert.throws(
      () => repository.addAttachment(created.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: created.version,
        paymentIds: [],
        kind: "payment_proof",
        fileName: "unlinked-proof.png",
        mediaType: "image/png",
        content: VALID_PNG,
      }),
      /paymentIds must contain at least one item for payment_proof/,
    );
    assert.deepEqual(repository.getExpense(created.id, { owner: "owner-a" }), created);
  });

  it("adds authenticated image content, bumps the expense version, and removes it safely", () => {
    const created = repository.createExpense(expense({ payments: [
      payment(),
      payment({ amountCents: 1200, reimbursementCents: 1200, differenceReason: "" }),
    ] }));
    const content = VALID_PNG;
    const withAttachment = repository.addAttachment(created.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
      paymentIds: [created.payments[1].id],
      kind: "payment_proof",
      fileName: "付款凭证.png",
      mediaType: "image/png",
      content,
      coveredCents: 0,
      notes: "第一张",
    });

    assert.equal(withAttachment.version, 2);
    assert.equal(withAttachment.attachments.length, 1);
    assert.deepEqual(withAttachment.attachments[0].paymentIds, [created.payments[1].id]);
    assert.equal(withAttachment.attachments[0].contentUrl, `/api/travel-expense-attachments/${withAttachment.attachments[0].id}/content`);
    const stored = repository.getAttachmentContent(withAttachment.attachments[0].id, { owner: "owner-a" });
    assert.equal(stored.mediaType, "image/png");
    assert.deepEqual(stored.content, content);
    assert.equal(repository.getAttachmentContent(withAttachment.attachments[0].id, { owner: "owner-b" }), null);

    const withoutAttachment = repository.deleteAttachment(withAttachment.attachments[0].id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 2,
    });
    assert.equal(withoutAttachment.version, 3);
    assert.deepEqual(withoutAttachment.attachments, []);
  });

  it("rejects short magic-byte shells and structurally truncated image attachments", () => {
    const cases = [
      {
        fileName: "signature-only.png",
        mediaType: "image/png",
        content: SHORT_PNG_SIGNATURE,
      },
      {
        fileName: "truncated.png",
        mediaType: "image/png",
        content: VALID_PNG.subarray(0, VALID_PNG.length - 5),
      },
      {
        fileName: "envelope-only.jpg",
        mediaType: "image/jpeg",
        content: SHORT_JPEG_ENVELOPE,
      },
      {
        fileName: "truncated.jpg",
        mediaType: "image/jpeg",
        content: Buffer.concat([
          VALID_JPEG.subarray(0, Math.floor(VALID_JPEG.length / 2)),
          Buffer.from([0xff, 0xd9]),
        ]),
      },
      {
        fileName: "container-only.webp",
        mediaType: "image/webp",
        content: SHORT_WEBP_CONTAINER,
      },
      {
        fileName: "truncated.webp",
        mediaType: "image/webp",
        content: VALID_WEBP.subarray(0, VALID_WEBP.length - 5),
      },
    ];

    for (const item of cases) {
      const created = repository.createExpense(expense());
      assert.throws(
        () => repository.addAttachment(created.id, {
          owner: "owner-a",
          actor: "owner-a",
          expectedVersion: 1,
          paymentIds: created.payments.map((paymentItem) => paymentItem.id),
          kind: "payment_proof",
          ...item,
        }),
        /content signature does not match mediaType/,
      );
    }
  });

  it("accepts structurally valid JPEG, WebP, and PDF attachments", () => {
    const cases = [
      {
        fileName: "proof.jpg",
        mediaType: "image/jpeg",
        content: VALID_JPEG,
      },
      {
        fileName: "proof.webp",
        mediaType: "image/webp",
        content: VALID_WEBP,
      },
      {
        fileName: "proof.pdf",
        mediaType: "application/pdf",
        content: VALID_PDF,
      },
    ];

    for (const item of cases) {
      const created = repository.createExpense(expense());
      const updated = repository.addAttachment(created.id, {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: 1,
        paymentIds: created.payments.map((paymentItem) => paymentItem.id),
        kind: "payment_proof",
        ...item,
      });
      const stored = repository.getAttachmentContent(updated.attachments[0].id, { owner: "owner-a" });

      assert.equal(stored.mediaType, item.mediaType);
      assert.deepEqual(stored.content, item.content);
    }
  });

  it("deduplicates repeated attachments and removes the blob only after the last hard reference", () => {
    const created = repository.createExpense(expense());
    const withFirst = repository.addAttachment(created.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
      paymentIds: [],
      kind: "invoice",
      fileName: "first.png",
      mediaType: "image/png",
      content: VALID_PNG,
    });
    const withSecond = repository.addAttachment(created.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 2,
      paymentIds: [],
      kind: "invoice",
      fileName: "second.png",
      mediaType: "image/png",
      content: VALID_PNG,
    });

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_blobs WHERE owner = 'owner-a'").get().count, 1);
    const afterFirstDelete = repository.deleteAttachment(withFirst.attachments[0].id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: withSecond.version,
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_blobs WHERE owner = 'owner-a'").get().count, 1);
    repository.deleteAttachment(withSecond.attachments[1].id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: afterFirstDelete.version,
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_blobs WHERE owner = 'owner-a'").get().count, 0);
  });

  it("rejects corrupted stored attachment bytes before returning content", () => {
    const created = repository.createExpense(expense());
    const updated = repository.addAttachment(created.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
      paymentIds: [],
      kind: "invoice",
      fileName: "proof.png",
      mediaType: "image/png",
      content: VALID_PNG,
    });
    const attachmentId = updated.attachments[0].id;
    const blob = db.prepare(
      "SELECT document_blob_id FROM travel_expense_attachments WHERE id = $id",
    ).get({ $id: attachmentId });
    db.prepare("UPDATE document_blobs SET content_blob = zeroblob(stored_size_bytes) WHERE id = $id")
      .run({ $id: blob.document_blob_id });

    assert.throws(
      () => repository.getAttachmentContent(attachmentId, { owner: "owner-a" }),
      (error) => error instanceof DocumentBlobIntegrityError,
    );
  });

  it("rejects attachment business length drift before returning bytes", () => {
    const created = repository.createExpense(expense());
    const updated = repository.addAttachment(created.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
      paymentIds: [],
      kind: "invoice",
      fileName: "proof.png",
      mediaType: "image/png",
      content: VALID_PNG,
    });
    const attachmentId = updated.attachments[0].id;

    db.exec("DROP TRIGGER trg_travel_expense_attachments_blob_update");
    db.prepare(`
      UPDATE travel_expense_attachments
      SET size_bytes = size_bytes + 1
      WHERE id = $id
    `).run({ $id: attachmentId });
    assert.throws(
      () => repository.getAttachmentContent(attachmentId, { owner: "owner-a" }),
      (error) => error instanceof DocumentBlobIntegrityError,
    );
  });

  it("rejects attachment content-address drift before returning bytes", () => {
    const created = repository.createExpense(expense());
    const updated = repository.addAttachment(created.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
      paymentIds: [],
      kind: "invoice",
      fileName: "proof.png",
      mediaType: "image/png",
      content: VALID_PNG,
    });
    const attachmentId = updated.attachments[0].id;
    const blob = db.prepare(`
      SELECT document_blob_id
      FROM travel_expense_attachments
      WHERE id = $id
    `).get({ $id: attachmentId });

    const replacement = Buffer.alloc(VALID_PNG.length, 0x41);
    const replacementSha = createHash("sha256").update(replacement).digest("hex");
    db.prepare(`
      UPDATE document_blobs
      SET sha256 = $sha256,
          encoding = 'identity',
          original_size_bytes = $sizeBytes,
          stored_size_bytes = $sizeBytes,
          content_blob = $content
      WHERE id = $id
    `).run({
      $id: blob.document_blob_id,
      $sha256: replacementSha,
      $sizeBytes: replacement.length,
      $content: replacement,
    });
    assert.throws(
      () => repository.getAttachmentContent(attachmentId, { owner: "owner-a" }),
      (error) => error instanceof DocumentBlobIntegrityError,
    );
  });

  it("records multiple advances and keeps company settlement data isolated by owner", () => {
    const first = repository.createAdvance({
      actor: "owner-a",
      weekStart: "2026-08-03",
      status: "received",
      requestedCents: 100000,
      receivedCents: 80000,
      requestedOn: "2026-08-01",
      receivedOn: "2026-08-02",
      purpose: "济宁出差请款",
      notes: "人工录入",
    });
    const second = repository.createAdvance({
      actor: "owner-a",
      weekStart: "2026-08-03",
      status: "received",
      requestedCents: 20000,
      receivedCents: 20000,
      requestedOn: "2026-08-03",
      receivedOn: "2026-08-03",
      purpose: "临时补充请款",
      notes: "",
    });

    assert.deepEqual(repository.listAdvances({ owner: "owner-a", weekStart: "2026-08-03" }), [first, second]);
    assert.deepEqual(repository.listAdvances({ owner: "owner-b", weekStart: "2026-08-03" }), []);

    const updated = repository.updateAdvance(first.id, {
      owner: "owner-a",
      actor: "owner-a",
      expectedVersion: 1,
      weekStart: "2026-08-03",
      status: "closed",
      requestedCents: 100000,
      receivedCents: 80000,
      requestedOn: "2026-08-01",
      receivedOn: "2026-08-02",
      purpose: "济宁出差请款",
      notes: "已结算",
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.status, "closed");
  });

  it("soft-deletes expenses and advances without exposing retained rows", () => {
    const created = repository.createExpense(expense());
    const advance = repository.createAdvance({
      actor: "owner-a",
      weekStart: "2026-08-03",
      status: "draft",
      requestedCents: 0,
      receivedCents: 0,
      requestedOn: null,
      receivedOn: null,
      purpose: "未提交请款",
      notes: "",
    });

    const deletedExpense = repository.softDeleteExpense(created.id, {
      owner: "owner-a", actor: "owner-a", expectedVersion: 1,
    });
    const deletedAdvance = repository.softDeleteAdvance(advance.id, {
      owner: "owner-a", actor: "owner-a", expectedVersion: 1,
    });

    assert.equal(deletedExpense.version, 2);
    assert.equal(deletedAdvance.version, 2);
    assert.equal(repository.getExpense(created.id, { owner: "owner-a" }), null);
    assert.deepEqual(repository.listAdvances({ owner: "owner-a", weekStart: "2026-08-03" }), []);
    assert.throws(
      () => repository.softDeleteExpense(created.id, { owner: "owner-a", actor: "owner-a", expectedVersion: 2 }),
      TravelExpenseNotFoundError,
    );
  });
});
