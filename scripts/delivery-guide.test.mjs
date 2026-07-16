import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const guidePath = resolve("docs", "正式交付验收手册.md");

function literalPattern(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

describe("formal delivery guide", () => {
  const content = readFileSync(guidePath, "utf8");

  it("documents the runtime, QA, security, and audit handoff commands", () => {
    for (const required of [
      "http://127.0.0.1:5184",
      "http://127.0.0.1:8897",
      "npm run dev:start",
      "npm run dev:status",
      "npm run dev:stop",
      "npm run qa:full",
      "npm run scan:secrets",
      "backend .env",
      "DeepSeek-V4-Flash",
      "/api/audit-logs",
      "npm run wsl:stack:smoke",
    ]) {
      assert.match(content, literalPattern(required));
    }
  });

  it("does not contain provider keys", () => {
    assert.doesNotMatch(content, /\bsk-[A-Za-z0-9_-]{20,}\b/);
  });

  it("documents the Phase 1 authentication, database recovery, and rollback procedure", () => {
    for (const required of [
      "npm --prefix backend run auth:hash",
      "AUTH_PASSWORD_HASH",
      "AUTH_SESSION_SECRET",
      "AUTH_COOKIE_SECURE=true",
      "CORS_ALLOWED_ORIGINS",
      "npm --prefix backend run db:check",
      "schema_migrations",
      "SHA-256",
      "PRAGMA quick_check",
      "PRAGMA foreign_key_check",
      "npm run wsl:db:backup -- --label=phase1-complete",
      "npm run wsl:db:restore",
      "X-CSRF-Token",
      "HttpOnly",
      "Authorization",
      "query token",
      "sentelligent",
      "加法迁移",
      "应用回滚",
    ]) {
      assert.match(content, literalPattern(required));
    }
  });
});
