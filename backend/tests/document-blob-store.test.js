import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { DocumentBlobIntegrityError } from "../src/travelExpense/documentBlobCodec.js";
import {
  deleteDocumentBlobIfUnreferenced,
  putDocumentBlob,
  readDocumentBlob,
} from "../src/travelExpense/documentBlobStore.js";
import { VALID_PNG } from "./helpers/image-fixtures.js";

describe("document blob store", () => {
  it("persists a prepared lossless blob without recompressing inside the write transaction", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const content = Buffer.from("prepared invoice bytes\n".repeat(256), "utf8");
      const prepared = {
        encoding: "identity",
        originalSizeBytes: content.length,
        storedSizeBytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        content: Buffer.from(content),
      };

      const stored = putDocumentBlob(db, {
        owner: "owner-a",
        content,
        encoded: prepared,
      });

      assert.equal(stored.encoding, "identity");
      assert.deepEqual(readDocumentBlob(db, { id: stored.id, owner: "owner-a" }), content);
    } finally {
      db.close();
    }
  });

  it("deduplicates by owner and original SHA-256 while keeping accounts isolated", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const first = putDocumentBlob(db, {
        owner: "owner-a",
        content: VALID_PNG,
        createdAt: "2026-08-04T00:00:00.000Z",
      });
      const replay = putDocumentBlob(db, {
        owner: "owner-a",
        content: VALID_PNG,
        createdAt: "2026-08-04T00:01:00.000Z",
      });
      const isolated = putDocumentBlob(db, {
        owner: "owner-b",
        content: VALID_PNG,
        createdAt: "2026-08-04T00:02:00.000Z",
      });

      assert.equal(replay.id, first.id);
      assert.notEqual(isolated.id, first.id);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_blobs").get().count, 2);
      assert.deepEqual(readDocumentBlob(db, { id: first.id, owner: "owner-a" }), VALID_PNG);
      assert.equal(readDocumentBlob(db, { id: first.id, owner: "owner-b" }), null);
    } finally {
      db.close();
    }
  });

  it("revalidates an existing deduplicated row before accepting a replay", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const stored = putDocumentBlob(db, { owner: "owner-a", content: VALID_PNG });
      db.prepare("UPDATE document_blobs SET content_blob = zeroblob(stored_size_bytes) WHERE id = $id")
        .run({ $id: stored.id });

      assert.throws(
        () => putDocumentBlob(db, { owner: "owner-a", content: VALID_PNG }),
        (error) => error instanceof DocumentBlobIntegrityError,
      );
      assert.throws(
        () => readDocumentBlob(db, { id: stored.id, owner: "owner-a" }),
        (error) => error instanceof DocumentBlobIntegrityError,
      );
    } finally {
      db.close();
    }
  });

  it("rejects a stored blob whose id is not its deterministic content address", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const stored = putDocumentBlob(db, { owner: "owner-a", content: VALID_PNG });
      const corruptId = "f".repeat(64);
      assert.notEqual(corruptId, stored.id);
      db.prepare("UPDATE document_blobs SET id = $corruptId WHERE id = $id")
        .run({ $corruptId: corruptId, $id: stored.id });

      assert.throws(
        () => readDocumentBlob(db, { id: corruptId, owner: "owner-a" }),
        (error) => error instanceof DocumentBlobIntegrityError,
      );
    } finally {
      db.close();
    }
  });

  it("deletes only unreferenced blobs and retains invoice audit originals", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const orphan = putDocumentBlob(db, { owner: "owner-a", content: Buffer.from("orphan") });
      assert.equal(deleteDocumentBlobIfUnreferenced(db, { id: orphan.id, owner: "owner-a" }), true);
      assert.equal(readDocumentBlob(db, { id: orphan.id, owner: "owner-a" }), null);

      const referenced = putDocumentBlob(db, { owner: "owner-a", content: VALID_PNG });
      db.prepare(`
        INSERT INTO invoice_documents (
          id, owner, source, file_name, media_type, size_bytes, sha256,
          status, created_by, updated_by, document_blob_id
        ) VALUES (
          'invoice-1', 'owner-a', 'manual', 'invoice.png', 'image/png',
          $sizeBytes, $sha256, 'unmatched', 'owner-a', 'owner-a', $blobId
        )
      `).run({
        $sizeBytes: referenced.originalSizeBytes,
        $sha256: referenced.sha256,
        $blobId: referenced.id,
      });

      assert.equal(deleteDocumentBlobIfUnreferenced(db, { id: referenced.id, owner: "owner-a" }), false);
      assert.deepEqual(readDocumentBlob(db, { id: referenced.id, owner: "owner-a" }), VALID_PNG);
    } finally {
      db.close();
    }
  });
});
