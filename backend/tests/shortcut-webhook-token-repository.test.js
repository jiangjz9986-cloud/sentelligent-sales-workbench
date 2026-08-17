import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createShortcutWebhookTokenRepository, tokenHash } from "../src/integrations/shortcutWebhookTokenRepository.js";

let tempDir;
let db;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "shortcut-webhook-token-repository-"));
  db = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
});

afterEach(async () => {
  db?.close();
  db = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe("Shortcut webhook token repository", () => {
  it("generates a token, stores only its hash, and resolves the owning account", () => {
    const expectedValue = "A".repeat(43);
    const repository = createShortcutWebhookTokenRepository(db, {
      tokenFactory: () => expectedValue,
      idFactory: () => "token-1",
      clock: () => new Date("2026-08-16T12:00:00.000Z"),
    });
    const created = repository.create({ account: "jiangjz", label: "iPhone" });

    assert.equal(created.token, expectedValue);
    assert.equal(created.account, "jiangjz");
    assert.equal(created.tokenPrefix, expectedValue.slice(0, 8));
    assert.equal(db.prepare("SELECT token_hash FROM shortcut_webhook_tokens WHERE id = 'token-1'").get().token_hash, tokenHash(expectedValue));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_webhook_tokens WHERE token_hash = $hash").get({ $hash: expectedValue }).count, 0);

    const resolved = repository.resolve(expectedValue);
    assert.equal(resolved.account, "jiangjz");
    assert.equal(resolved.tokenId, "token-1");
    assert.equal(resolved.lastUsedAt, "2026-08-16T12:00:00.000Z");
    assert.equal(repository.resolve("B".repeat(43)), null);
  });

  it("lists only the current account and revocation immediately disables a token", () => {
    let next = 0;
    const repository = createShortcutWebhookTokenRepository(db, {
      tokenFactory: () => (next++ === 0 ? "A".repeat(43) : "B".repeat(43)),
      idFactory: () => `token-${next}`,
    });
    repository.create({ account: "owner-a", label: "A" });
    repository.create({ account: "owner-b", label: "B" });
    assert.deepEqual(repository.list({ account: "owner-a" }).map((item) => item.account), ["owner-a"]);

    const revoked = repository.revoke({ account: "owner-a", id: "token-1" });
    assert.equal(revoked.revokedAt !== null, true);
    assert.equal(repository.resolve("A".repeat(43)), null);
    assert.equal(repository.revoke({ account: "owner-b", id: "token-1" }), null);
  });
});
