import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const guidePath = resolve("docs", "正式交付验收手册.md");
const releaseGuidePath = resolve("docs", "发布与回滚操作手册.md");

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

  it("documents the isolated Node 24 and shared Caddy production boundaries", () => {
    for (const required of [
      "/opt/sentelligent-sales-workbench/runtime/node-v24/bin/node",
      "sentzx",
      "/usr/local/bin/caddy run --config /etc/caddy/Caddyfile",
      "共享 Caddy",
      "不得包含 sentelligent-caddy.service",
    ]) {
      assert.match(content, literalPattern(required));
    }
  });
});

describe("production release staging guide", () => {
  const content = readFileSync(releaseGuidePath, "utf8");

  it("stages and preserves releases as root-owned immutable trees", () => {
    for (const required of [
      "install -d -o root -g root -m 0755",
      "--no-same-owner",
      "--no-same-permissions",
      "chown -R root:root",
      "trusted_manifest_sha=",
      "旧生产 release",
      "重新执行 24/24",
    ]) {
      assert.match(content, literalPattern(required));
    }
    assert.doesNotMatch(content, /install -d -o sentzx -g sentzx/);
  });
});
