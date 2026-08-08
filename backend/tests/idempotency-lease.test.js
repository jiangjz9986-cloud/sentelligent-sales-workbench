import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import * as idempotency from "../src/services/idempotency.js";

function requestScope(now) {
  return {
    actor: "upload-owner",
    method: "POST",
    path: "/api/invoices",
    key: "stale-upload-claim",
    hash: idempotency.requestHash({ fileName: "invoice.pdf" }),
    now,
  };
}

describe("idempotency processing leases", () => {
  it("reclaims a stale upload claim and fences the previous worker from completion or release", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const first = idempotency.claimIdempotency(
        db,
        requestScope("2026-08-06T00:00:00.000Z"),
      );
      assert.equal(first.replay, false);
      assert.match(first.claimToken, /^[0-9a-f-]{36}$/u);

      assert.throws(
        () => idempotency.claimIdempotency(
          db,
          requestScope("2026-08-06T00:04:59.999Z"),
        ),
        (error) => error.status === 409 && error.code === "REQUEST_IN_PROGRESS",
      );

      const reclaimed = idempotency.claimIdempotency(
        db,
        requestScope("2026-08-06T00:05:00.000Z"),
      );
      assert.equal(reclaimed.replay, false);
      assert.match(reclaimed.claimToken, /^[0-9a-f-]{36}$/u);
      assert.notEqual(reclaimed.claimToken, first.claimToken);

      assert.throws(
        () => idempotency.completeIdempotency(db, {
          ...requestScope("2026-08-06T00:05:01.000Z"),
          claimToken: first.claimToken,
          status: 201,
          body: { item: { id: "stale-result" } },
        }),
        /claim is no longer current/i,
      );

      assert.equal(typeof idempotency.releaseIdempotencyClaim, "function");
      assert.equal(idempotency.releaseIdempotencyClaim(db, {
        ...requestScope("2026-08-06T00:05:01.000Z"),
        claimToken: first.claimToken,
      }), false);

      const processing = db.prepare(`
        SELECT state, claim_token
        FROM idempotency_keys
        WHERE actor = 'upload-owner'
          AND method = 'POST'
          AND request_path = '/api/invoices'
          AND key = 'stale-upload-claim'
      `).get();
      assert.equal(processing.state, "processing");
      assert.equal(processing.claim_token, reclaimed.claimToken);

      idempotency.completeIdempotency(db, {
        ...requestScope("2026-08-06T00:05:02.000Z"),
        claimToken: reclaimed.claimToken,
        status: 201,
        body: { item: { id: "current-result" } },
      });
      const replay = idempotency.claimIdempotency(
        db,
        requestScope("2026-08-06T00:05:03.000Z"),
      );
      assert.deepEqual(replay, {
        replay: true,
        status: 201,
        body: { item: { id: "current-result" } },
      });
    } finally {
      db.close();
    }
  });
});
