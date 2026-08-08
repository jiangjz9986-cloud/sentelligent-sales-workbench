import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../src/http/errors.js";
import {
  MAX_TRAVEL_EXPENSE_ATTACHMENT_BYTES,
  validateTravelExpenseAdvancePayload,
  validateTravelExpenseAttachmentPayload,
  validateTravelExpensePayload,
  validateTravelExpenseWeekStart,
} from "../src/travelExpense/validation.js";
import {
  PDF_PREFIX_SHELL,
  PDF_XREF_STREAM_SHELL,
  PDF_WITHOUT_OBJECTS,
  SHORT_JPEG_ENVELOPE,
  SHORT_PNG_SIGNATURE,
  SHORT_WEBP_CONTAINER,
  TRUNCATED_PDF,
  VALID_JPEG,
  VALID_PDF,
  VALID_PNG,
  VALID_WEBP,
  paddedPng,
} from "./helpers/image-fixtures.js";

function payment(overrides = {}) {
  return {
    paidAt: "2026-08-04T12:30:00+08:00",
    merchant: "Example restaurant",
    amountCents: 4800,
    reimbursementCents: 4500,
    fundingSource: "personal",
    paymentMethod: "wechat",
    accountLast4: "1234",
    differenceReason: "Personal drink excluded",
    ...overrides,
  };
}

function expense(overrides = {}) {
  return {
    occurredOn: "2026-08-04",
    category: "lunch",
    purpose: "Business trip lunch",
    merchant: "Example restaurant",
    notes: "Manual entry",
    payments: [payment()],
    ...overrides,
  };
}

function advance(overrides = {}) {
  return {
    weekStart: "2026-08-03",
    status: "received",
    requestedCents: 100000,
    receivedCents: 80000,
    requestedOn: "2026-08-01",
    receivedOn: "2026-08-02",
    purpose: "Weekly travel advance",
    notes: "Manual entry",
    ...overrides,
  };
}

function attachment(overrides = {}) {
  return {
    paymentIds: ["payment-1", "payment-2"],
    kind: "payment_proof",
    fileName: "payment.png",
    mediaType: "image/png",
    contentBase64: VALID_PNG.toString("base64"),
    coveredCents: 4500,
    notes: "First screenshot",
    ...overrides,
  };
}

function assertValidation(fn, field) {
  assert.throws(fn, (error) => (
    error instanceof HttpError
    && error.status === 422
    && error.code === "VALIDATION_ERROR"
    && typeof error.fields?.[field] === "string"
  ));
}

describe("travel expense request validation", () => {
  it("accepts the documented expense payload and preserves integer-cent values", () => {
    const result = validateTravelExpensePayload(expense());

    assert.equal(result.occurredOn, "2026-08-04");
    assert.equal(result.payments[0].amountCents, 4800);
    assert.equal(result.payments[0].reimbursementCents, 4500);
    assert.equal(Object.hasOwn(result, "owner"), false);
  });

  it("rejects client-controlled ownership and unknown nested payment fields", () => {
    assertValidation(() => validateTravelExpensePayload(expense({ owner: "other-user" })), "owner");
    assertValidation(() => validateTravelExpensePayload(expense({ actor: "other-user" })), "actor");
    assertValidation(
      () => validateTravelExpensePayload(expense({ payments: [payment({ unexpected: true })] })),
      "payments[0].unexpected",
    );
  });

  it("rejects client-controlled invoice status", () => {
    assertValidation(
      () => validateTravelExpensePayload(expense({ invoiceStatus: "covered" })),
      "invoiceStatus",
    );
  });

  it("rejects invalid dates, enums, unsafe cents, and inconsistent payment amounts", () => {
    const cases = [
      [expense({ occurredOn: "2026-02-30" }), "occurredOn"],
      [expense({ category: "snack" }), "category"],
      [expense({ payments: [payment({ paidAt: "not-a-date" })] }), "payments[0].paidAt"],
      [expense({ payments: [payment({ paidAt: "2026-02-30T12:30:00+08:00" })] }), "payments[0].paidAt"],
      [expense({ payments: [payment({ amountCents: -1 })] }), "payments[0].amountCents"],
      [expense({ payments: [payment({ amountCents: 12.5 })] }), "payments[0].amountCents"],
      [expense({ payments: [payment({ amountCents: Number.MAX_SAFE_INTEGER + 1 })] }), "payments[0].amountCents"],
      [expense({ payments: [payment({ reimbursementCents: 4900 })] }), "payments[0].reimbursementCents"],
      [expense({ payments: [payment({ differenceReason: "" })] }), "payments[0].differenceReason"],
      [expense({ payments: [payment({ accountLast4: "12ab" })] }), "payments[0].accountLast4"],
    ];

    for (const [body, field] of cases) assertValidation(() => validateTravelExpensePayload(body), field);
  });

  it("requires one to twenty-five uniquely identified payments", () => {
    assertValidation(() => validateTravelExpensePayload(expense({ payments: [] })), "payments");
    assertValidation(
      () => validateTravelExpensePayload(expense({
        payments: Array.from({ length: 26 }, (_, index) => payment({ id: `p-${index}` })),
      })),
      "payments",
    );
    assertValidation(
      () => validateTravelExpensePayload(expense({
        payments: [payment({ id: "same" }), payment({ id: "same" })],
      })),
      "payments",
    );
  });

  it("validates natural-week advance dates and non-negative integer cents", () => {
    assert.deepEqual(validateTravelExpenseAdvancePayload(advance()), advance());
    assert.equal(validateTravelExpenseWeekStart("2026-08-03"), "2026-08-03");

    for (const [body, field] of [
      [advance({ weekStart: "2026-08-04" }), "weekStart"],
      [advance({ weekStart: "2026-02-30" }), "weekStart"],
      [advance({ requestedCents: -1 }), "requestedCents"],
      [advance({ receivedCents: 1.5 }), "receivedCents"],
      [advance({ receivedOn: "2026-02-30" }), "receivedOn"],
      [advance({ owner: "other-user" }), "owner"],
    ]) {
      assertValidation(() => validateTravelExpenseAdvancePayload(body), field);
    }
    assertValidation(() => validateTravelExpenseWeekStart("2026-08-04"), "weekStart");
  });

  it("decodes PNG, JPEG, WebP, and PDF payloads only when media type matches real magic bytes", () => {
    for (const [mediaType, content] of [
      ["image/png", VALID_PNG],
      ["image/jpeg", VALID_JPEG],
      ["image/webp", VALID_WEBP],
      ["application/pdf", VALID_PDF],
    ]) {
      const result = validateTravelExpenseAttachmentPayload(attachment({
        mediaType,
        fileName: `proof.${mediaType.split("/")[1]}`,
        contentBase64: content.toString("base64"),
      }));
      assert.deepEqual(result.content, content);
      assert.equal(Object.hasOwn(result, "contentBase64"), false);
    }

    assertValidation(
      () => validateTravelExpenseAttachmentPayload(attachment({ mediaType: "image/jpeg" })),
      "contentBase64",
    );
    assertValidation(
      () => validateTravelExpenseAttachmentPayload(attachment({ mediaType: "application/pdf" })),
      "contentBase64",
    );
    assertValidation(
      () => validateTravelExpenseAttachmentPayload(attachment({
        mediaType: "image/png",
        fileName: "invoice.png",
        contentBase64: VALID_PDF.toString("base64"),
      })),
      "contentBase64",
    );
    assertValidation(
      () => validateTravelExpenseAttachmentPayload(attachment({
        mediaType: "image/jpeg",
        fileName: "truncated.jpg",
        contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
      })),
      "contentBase64",
    );
    assertValidation(
      () => validateTravelExpenseAttachmentPayload(attachment({ contentBase64: "not base64!" })),
      "contentBase64",
    );
    assertValidation(
      () => validateTravelExpenseAttachmentPayload(attachment({ mediaType: "image/gif" })),
      "mediaType",
    );
  });

  it("requires payment proofs to target a payment while allowing unlinked invoice uploads", () => {
    assertValidation(
      () => validateTravelExpenseAttachmentPayload(attachment({ paymentIds: [] })),
      "paymentIds",
    );

    const withoutPaymentIds = attachment();
    delete withoutPaymentIds.paymentIds;
    assertValidation(
      () => validateTravelExpenseAttachmentPayload(withoutPaymentIds),
      "paymentIds",
    );

    const invoice = validateTravelExpenseAttachmentPayload(attachment({
      kind: "invoice",
      paymentIds: [],
    }));
    assert.deepEqual(invoice.paymentIds, []);
  });

  it("rejects short magic-byte shells and structurally truncated images", () => {
    const cases = [
      ["image/png", SHORT_PNG_SIGNATURE],
      ["image/png", VALID_PNG.subarray(0, VALID_PNG.length - 5)],
      ["image/jpeg", SHORT_JPEG_ENVELOPE],
      [
        "image/jpeg",
        Buffer.concat([VALID_JPEG.subarray(0, Math.floor(VALID_JPEG.length / 2)), Buffer.from([0xff, 0xd9])]),
      ],
      ["image/webp", SHORT_WEBP_CONTAINER],
      ["image/webp", VALID_WEBP.subarray(0, VALID_WEBP.length - 5)],
    ];

    for (const [mediaType, content] of cases) {
      assertValidation(
        () => validateTravelExpenseAttachmentPayload(attachment({
          mediaType,
          fileName: `invalid.${mediaType.split("/")[1]}`,
          contentBase64: content.toString("base64"),
        })),
        "contentBase64",
      );
    }
  });

  it("rejects PDF prefix shells, truncation, and missing object structure for payment proofs", () => {
    for (const content of [
      PDF_PREFIX_SHELL,
      TRUNCATED_PDF,
      PDF_WITHOUT_OBJECTS,
      PDF_XREF_STREAM_SHELL,
    ]) {
      assertValidation(
        () => validateTravelExpenseAttachmentPayload(attachment({
          mediaType: "application/pdf",
          fileName: "invalid.pdf",
          contentBase64: content.toString("base64"),
        })),
        "contentBase64",
      );
    }
  });

  it("accepts exactly 12 MiB and rejects larger decoded documents and unknown fields", () => {
    assert.equal(MAX_TRAVEL_EXPENSE_ATTACHMENT_BYTES, 12 * 1024 * 1024);
    const maximum = paddedPng(MAX_TRAVEL_EXPENSE_ATTACHMENT_BYTES);
    const accepted = validateTravelExpenseAttachmentPayload(attachment({
      kind: "invoice",
      paymentIds: [],
      contentBase64: maximum.toString("base64"),
    }));
    assert.equal(accepted.content.length, MAX_TRAVEL_EXPENSE_ATTACHMENT_BYTES);

    assertValidation(
      () => validateTravelExpenseAttachmentPayload(attachment({
        kind: "invoice",
        paymentIds: [],
        mediaType: "image/png",
        contentBase64: paddedPng(MAX_TRAVEL_EXPENSE_ATTACHMENT_BYTES + 1).toString("base64"),
      })),
      "contentBase64",
    );
    assertValidation(
      () => validateTravelExpenseAttachmentPayload(attachment({ owner: "other-user" })),
      "owner",
    );
  });
});
