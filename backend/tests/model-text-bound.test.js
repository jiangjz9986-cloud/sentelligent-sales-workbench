import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_MODEL_TEXT_CHARS, boundModelText } from "../src/travelExpense/modelTextBound.js";

describe("model text boundary", () => {
  it("keeps ordinary OCR text unchanged", () => {
    assert.deepEqual(boundModelText("  invoice text  "), {
      text: "invoice text",
      truncated: false,
    });
  });

  it("caps oversized OCR text while preserving a truncation signal", () => {
    const result = boundModelText(`头${"x".repeat(MAX_MODEL_TEXT_CHARS)}尾`);

    assert.equal(result.truncated, true);
    assert.equal(result.text.length, MAX_MODEL_TEXT_CHARS);
    assert.equal(result.text, `头${"x".repeat(MAX_MODEL_TEXT_CHARS - 1)}`);
  });
});
