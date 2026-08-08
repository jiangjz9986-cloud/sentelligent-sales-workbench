import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPaymentProofSelection,
  togglePaymentProofPayment,
  validatePaymentProofSelection,
} from "./paymentProofModel.js";

const expense = {
  id: "expense-1",
  payments: [
    { id: "payment-1" },
    { id: "payment-2" },
  ],
};

describe("payment proof selection", () => {
  it("starts empty instead of silently selecting every payment", () => {
    assert.deepEqual(createPaymentProofSelection(expense), []);
  });

  it("adds and removes only the payment explicitly chosen by the user", () => {
    const one = togglePaymentProofPayment([], "payment-1", expense);
    const two = togglePaymentProofPayment(one, "payment-2", expense);
    const removed = togglePaymentProofPayment(two, "payment-1", expense);

    assert.deepEqual(one, ["payment-1"]);
    assert.deepEqual(two, ["payment-1", "payment-2"]);
    assert.deepEqual(removed, ["payment-2"]);
  });

  it("rejects empty and unknown payment selections before upload", () => {
    assert.throws(
      () => validatePaymentProofSelection([], expense),
      /至少选择一笔付款/,
    );
    assert.throws(
      () => validatePaymentProofSelection(["payment-missing"], expense),
      /付款记录不存在/,
    );
    assert.deepEqual(
      validatePaymentProofSelection(["payment-2", "payment-1", "payment-2"], expense),
      ["payment-1", "payment-2"],
    );
  });
});
