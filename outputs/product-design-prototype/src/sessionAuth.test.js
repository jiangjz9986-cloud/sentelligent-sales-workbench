import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as sessionAuth from "./sessionAuth.js";

describe("display-only login session", () => {
  it("exports only the legacy cleanup and display-session helpers", () => {
    assert.deepEqual(Object.keys(sessionAuth).sort(), [
      "AUTH_SESSION_STORAGE_KEY",
      "clearLegacyAuthSession",
      "createDisplaySession",
    ]);
  });

  it("removes only the legacy login key without reading or writing storage", () => {
    const removed = [];
    const storage = {
      getItem() {
        throw new Error("legacy cleanup must not read storage");
      },
      setItem() {
        throw new Error("legacy cleanup must not write storage");
      },
      removeItem(key) {
        removed.push(key);
      },
    };

    sessionAuth.clearLegacyAuthSession(storage);

    assert.deepEqual(removed, ["sentelligent.salesWorkbench.login"]);
  });

  it("creates a normalized display session and discards sensitive or extra fields", () => {
    const tokenField = ["tok", "en"].join("");
    const csrfField = ["csrf", "Token"].join("");
    const result = sessionAuth.createDisplaySession({
      account: "  jiangjz  ",
      displayName: "  姜继振  ",
      expiresAt: "2026-07-22T08:00:00+08:00",
      [tokenField]: "legacy-token",
      [csrfField]: "csrf-secret",
      createdAt: "2026-07-15T00:00:00.000Z",
      role: "admin",
    });

    assert.deepEqual(result, {
      account: "jiangjz",
      displayName: "姜继振",
      expiresAt: "2026-07-22T00:00:00.000Z",
    });
    assert.deepEqual(Object.keys(result).sort(), ["account", "displayName", "expiresAt"]);
    assert.equal(Object.hasOwn(result, "token"), false);
    assert.equal(Object.hasOwn(result, "csrfToken"), false);
    assert.equal(Object.hasOwn(result, "createdAt"), false);
  });

  it("falls back to the normalized account when displayName is blank", () => {
    assert.deepEqual(
      sessionAuth.createDisplaySession({
        account: "  jiangjz  ",
        displayName: "   ",
        expiresAt: "2026-07-22T00:00:00.000Z",
      }),
      {
        account: "jiangjz",
        displayName: "jiangjz",
        expiresAt: "2026-07-22T00:00:00.000Z",
      },
    );
  });
});
