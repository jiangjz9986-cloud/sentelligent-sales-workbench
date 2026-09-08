import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const scriptPath = new URL("./deploy/ops-inspect.sh", import.meta.url);

describe("ops inspection script", () => {
  it("ignores lifecycle-terminal outbox rows when advancing the failed watermark", async () => {
    const source = await readFile(scriptPath, "utf8");
    const query = source.split("\n").find((line) => line.includes("SELECT COALESCE(MAX(updated_at)"));
    assert.ok(query, "failed-watermark query must remain present");
    for (const code of [
      "WEIXIN_OUTBOX_STALE",
      "WEIXIN_OUTBOX_SUPERSEDED",
      "WEIXIN_OUTBOX_CANCELLED",
    ]) {
      assert.match(query, new RegExp(code, "u"));
    }
    assert.match(query, /COALESCE\(last_error_code,''\) NOT IN/u);
  });

  it("remains valid bash after the watermark query changes", () => {
    const result = spawnSync("bash", ["-n", scriptPath.pathname], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
});
