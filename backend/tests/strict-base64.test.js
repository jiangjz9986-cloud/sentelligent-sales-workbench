import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Base64DecodingError,
  decodeCanonicalBase64,
} from "../src/http/strictBase64.js";

describe("strict Base64 decoding", () => {
  it("decodes a canonical 12 MiB payload without regular-expression stack overflow", () => {
    const original = Buffer.alloc(12 * 1024 * 1024, 0x41);

    const decoded = decodeCanonicalBase64(original.toString("base64"), {
      maxDecodedBytes: original.length,
    });

    assert.deepEqual(decoded, original);
  });

  it("rejects non-canonical alphabet, padding, and trailing bits", () => {
    for (const value of ["not base64!", "=AAA", "AA=A", "AAAA=", "AB=="]) {
      assert.throws(
        () => decodeCanonicalBase64(value, { maxDecodedBytes: 1024 }),
        (error) => error instanceof Base64DecodingError && error.reason === "base64",
      );
    }
  });

  it("rejects encoded input that cannot fit within the decoded byte ceiling", () => {
    const value = Buffer.alloc(1025, 0x41).toString("base64");

    assert.throws(
      () => decodeCanonicalBase64(value, { maxDecodedBytes: 1024 }),
      (error) => error instanceof Base64DecodingError && error.reason === "maxDecodedBytes",
    );
  });
});
