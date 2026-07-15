import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeDatabase = resolve(backendRoot, "data", "smoke.sqlite");

function runSmoke() {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["scripts/smoke.mjs"], {
      cwd: backendRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
    child.on("error", (error) => resolveRun({ status: 1, stdout, stderr: error.message }));
  });
}

test("smoke script removes its temporary sqlite database", () => {
  rmSync(smokeDatabase, { force: true });

  const result = spawnSync(process.execPath, ["scripts/smoke.mjs"], {
    cwd: backendRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"statusCode":200/);
  assert.equal(existsSync(smokeDatabase), false);
});

test("smoke script can run concurrently without sharing a repository database", async () => {
  rmSync(smokeDatabase, { force: true });

  const results = await Promise.all([runSmoke(), runSmoke(), runSmoke()]);

  assert.deepEqual(
    results.map((result) => result.status),
    [0, 0, 0],
    JSON.stringify(results, null, 2),
  );
  assert.equal(existsSync(smokeDatabase), false);
});
