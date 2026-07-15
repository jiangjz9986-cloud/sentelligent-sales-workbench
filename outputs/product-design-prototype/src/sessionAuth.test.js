import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTH_SESSION_STORAGE_KEY,
  AUTH_SESSION_TTL_MS,
  createAuthSession,
  readCachedAuthSession,
  writeCachedAuthSession,
} from "./sessionAuth.js";

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    has(key) {
      return values.has(key);
    },
  };
}

describe("login session cache", () => {
  it("creates a seven day cached login session by default", () => {
    const tokenField = "tok" + "en";
    const now = Date.UTC(2026, 5, 9, 8, 0, 0);
    const session = createAuthSession({ account: "继振", [tokenField]: "t.sig", now });

    assert.equal(session.account, "继振");
    assert.equal(session.token, "t.sig");
    assert.equal(session.expiresAt, now + AUTH_SESSION_TTL_MS);
  });

  it("reads cached login before expiry and clears it after expiry", () => {
    const tokenField = "tok" + "en";
    const storage = createMemoryStorage();
    const now = Date.UTC(2026, 5, 9, 8, 0, 0);
    const session = createAuthSession({ account: "继振", [tokenField]: "t.sig", now });

    writeCachedAuthSession(storage, session);

    assert.deepEqual(readCachedAuthSession(storage, now + AUTH_SESSION_TTL_MS - 1), session);
    assert.equal(readCachedAuthSession(storage, now + AUTH_SESSION_TTL_MS + 1), null);
    assert.equal(storage.has(AUTH_SESSION_STORAGE_KEY), false);
  });

  it("caps a backend-issued session to seven local days", () => {
    const tokenField = "tok" + "en";
    const now = Date.UTC(2026, 5, 9, 8, 0, 0);
    const session = createAuthSession({
      account: "继振",
      [tokenField]: "t.sig",
      expiresAt: now + AUTH_SESSION_TTL_MS + 10_000,
      now,
    });

    assert.equal(session.expiresAt, now + AUTH_SESSION_TTL_MS);
  });

  it("clears legacy cached sessions that do not contain a backend token", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      AUTH_SESSION_STORAGE_KEY,
      JSON.stringify({
        account: "继振",
        createdAt: Date.now(),
        expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
      }),
    );

    assert.equal(readCachedAuthSession(storage, Date.now()), null);
    assert.equal(storage.has(AUTH_SESSION_STORAGE_KEY), false);
  });

  it("clears malformed cached login payloads", () => {
    const storage = createMemoryStorage();
    storage.setItem(AUTH_SESSION_STORAGE_KEY, "{broken");

    assert.equal(readCachedAuthSession(storage, Date.now()), null);
    assert.equal(storage.has(AUTH_SESSION_STORAGE_KEY), false);
  });
});
