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
});
