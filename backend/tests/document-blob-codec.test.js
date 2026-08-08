import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  DocumentBlobIntegrityError,
  decodeDocumentBlob,
  documentBlobId,
  encodeDocumentBlob,
} from "../src/travelExpense/documentBlobCodec.js";
import * as documentBlobCodec from "../src/travelExpense/documentBlobCodec.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

describe("document blob codec", () => {
  it("stores compressible bytes with Brotli and restores the exact original bytes", () => {
    const original = Buffer.from("invoice-line-2026-08-04\n".repeat(4096), "utf8");

    const encoded = encodeDocumentBlob(original);

    assert.equal(encoded.encoding, "br");
    assert.equal(encoded.originalSizeBytes, original.length);
    assert.equal(encoded.storedSizeBytes, encoded.content.length);
    assert.ok(encoded.storedSizeBytes < encoded.originalSizeBytes);
    assert.equal(encoded.sha256, sha256(original));
    assert.deepEqual(decodeDocumentBlob(encoded), original);
  });

  it("provides an asynchronous encoder for request paths that must not hold SQLite locks", async () => {
    assert.equal(typeof documentBlobCodec.encodeDocumentBlobAsync, "function");
    const original = Buffer.from("async invoice-line\n".repeat(2048), "utf8");
    const encoded = await documentBlobCodec.encodeDocumentBlobAsync(original);

    assert.equal(encoded.sha256, sha256(original));
    assert.deepEqual(decodeDocumentBlob(encoded), original);
  });

  it("keeps original bytes when lossless compression would not reduce storage", () => {
    const original = Buffer.from([0x89]);

    const encoded = encodeDocumentBlob(original);

    assert.equal(encoded.encoding, "identity");
    assert.equal(encoded.originalSizeBytes, 1);
    assert.equal(encoded.storedSizeBytes, 1);
    assert.deepEqual(encoded.content, original);
    assert.notStrictEqual(encoded.content, original);
    assert.deepEqual(decodeDocumentBlob(encoded), original);
  });

  it("accepts Uint8Array input without retaining a mutable caller-owned view", () => {
    const input = new Uint8Array(Buffer.from("stable document bytes"));
    const expected = Buffer.from(input);

    const encoded = encodeDocumentBlob(input);
    input.fill(0);

    assert.deepEqual(decodeDocumentBlob(encoded), expected);
  });

  it("rejects unsupported input and invalid stored metadata", () => {
    assert.throws(() => encodeDocumentBlob("not bytes"), TypeError);
    assert.throws(() => encodeDocumentBlob(Buffer.alloc(0)), TypeError);

    const encoded = encodeDocumentBlob(Buffer.from("metadata integrity".repeat(64)));
    const invalidCases = [
      { ...encoded, encoding: "gzip" },
      { ...encoded, storedSizeBytes: encoded.storedSizeBytes + 1 },
      { ...encoded, originalSizeBytes: encoded.originalSizeBytes + 1 },
      { ...encoded, sha256: "0".repeat(64) },
      { ...encoded, content: encoded.content.subarray(0, Math.max(0, encoded.content.length - 1)) },
    ];

    for (const record of invalidCases) {
      assert.throws(
        () => decodeDocumentBlob(record),
        (error) => error instanceof DocumentBlobIntegrityError,
      );
    }
  });

  it("rejects identity records that do not preserve the exact original length", () => {
    const original = Buffer.from([0x01]);
    const encoded = encodeDocumentBlob(original);

    assert.throws(
      () => decodeDocumentBlob({ ...encoded, originalSizeBytes: 2 }),
      (error) => error instanceof DocumentBlobIntegrityError,
    );
  });

  it("derives a stable opaque content address that stays isolated by owner", () => {
    const digest = sha256(Buffer.from("same document"));

    const first = documentBlobId("owner-a", digest);

    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(documentBlobId("owner-a", digest), first);
    assert.notEqual(documentBlobId("owner-b", digest), first);
    assert.equal(first.includes("owner-a"), false);
    assert.throws(() => documentBlobId("", digest), TypeError);
    assert.throws(() => documentBlobId("owner-a", "not-a-digest"), TypeError);
  });
});
