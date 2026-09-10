import assert from "node:assert/strict";
import { test } from "node:test";
import { runProductionRollback, runProductionTransition } from "./transition-runner.mjs";
import { PRODUCTION_ROOT } from "./production-contract.mjs";

const evidence = PRODUCTION_ROOT + "/evidence/transition-test";
const manifest = {
  schemaVersion: 1, id: "transition-test", hostname: "test-host", machineId: "a".repeat(32),
  oldRelease: PRODUCTION_ROOT + "/releases/old", newRelease: PRODUCTION_ROOT + "/releases/new",
  oldCommit: "b".repeat(40), newCommit: "c".repeat(40), evidenceDir: evidence,
  backupDir: PRODUCTION_ROOT + "/backups/transition-test", phase: "canary",
  platformEnvCandidate: evidence + "/platform.env", backendEnvCandidate: evidence + "/backend.env",
  platformEnvSha256: "d".repeat(64), backendEnvSha256: "e".repeat(64),
  corePreflight: evidence + "/core.json", corePreflightSha256: "f".repeat(64),
  policyFile: evidence + "/policy.json", policySha256: "1".repeat(64),
  newArchive: evidence + "/release.tar.gz", newArchiveSha256: "2".repeat(64),
  qualityReport: evidence + "/quality.json", qualityReportSha256: "3".repeat(64),
};
const methods = ["acquireLock", "inspect", "verifyPreflight", "captureState", "drainPlatform", "backupPlatform", "stageBackendConfig", "resumePlatform", "cutoverCore", "reconcileProactiveEvents", "verifyPostflight", "reconcileCredentials", "restoreBackendConfig", "rollbackCore", "rollbackPlatform", "releaseLock", "verifyRollbackState", "verifyRollback"];
function fixture(failures = []) {
  const calls = [];
  let identity = "old";
  const adapter = Object.fromEntries(methods.map((method) => [method, async (_input, expected) => {
    calls.push(method);
    if (failures.includes(method)) throw Object.assign(new Error("private fixture details must not escape"), { code: "FIXTURE_FAILURE" });
    if (method === "cutoverCore") identity = "new";
    if (method === "rollbackCore") identity = "old";
    if (method === "inspect") assert.equal(identity, expected);
  }]));
  return { calls, adapter };
}
test("all gates precede mutation and platform admission opens only after core cutover", async () => {
  const { calls, adapter } = fixture();
  const result = await runProductionTransition(manifest, adapter);
  assert.equal(result.status, "passed");
  assert.equal(result.rollbackStatus, "not-required");
  assert.ok(calls.indexOf("verifyPreflight") < calls.indexOf("drainPlatform"));
  assert.ok(calls.indexOf("backupPlatform") < calls.indexOf("cutoverCore"));
  assert.ok(calls.indexOf("cutoverCore") < calls.indexOf("resumePlatform"));
  assert.equal(calls.includes("rollbackCore"), false);
  assert.equal(calls.at(-1), "releaseLock");
});
test("preflight failure makes no service or configuration mutations", async () => {
  const { calls, adapter } = fixture(["verifyPreflight"]);
  const result = await runProductionTransition(manifest, adapter);
  assert.equal(result.status, "failed");
  assert.equal(result.rollbackStatus, "not-required");
  assert.deepEqual(calls, ["acquireLock", "inspect", "verifyPreflight", "releaseLock"]);
  assert.equal(JSON.stringify(result).includes("private fixture"), false);
});
test("postflight failure reconciles credentials before restoring legacy service state", async () => {
  const { calls, adapter } = fixture(["verifyPostflight"]);
  const result = await runProductionTransition(manifest, adapter);
  assert.equal(result.status, "failed");
  assert.equal(result.rollbackStatus, "passed");
  assert.ok(calls.indexOf("reconcileCredentials") < calls.indexOf("restoreBackendConfig"));
  assert.ok(calls.indexOf("restoreBackendConfig") < calls.indexOf("rollbackCore"));
  assert.ok(calls.indexOf("rollbackCore") < calls.indexOf("rollbackPlatform"));
});
test("credential reconciliation failure prevents stale legacy credentials being restarted", async () => {
  const { calls, adapter } = fixture(["verifyPostflight", "reconcileCredentials"]);
  const result = await runProductionTransition(manifest, adapter);
  assert.equal(result.rollbackStatus, "failed");
  assert.equal(calls.includes("restoreBackendConfig"), false);
  assert.equal(calls.includes("rollbackCore"), false);
});

test("explicit rollback drains and reconciles before restoring the old core", async () => {
  const { calls, adapter } = fixture();
  const result = await runProductionRollback(manifest, adapter);
  assert.equal(result.status, "passed");
  assert.equal(result.rollbackStatus, "passed");
  assert.ok(calls.indexOf("verifyRollbackState") < calls.indexOf("drainPlatform"));
  assert.ok(calls.indexOf("drainPlatform") < calls.indexOf("reconcileCredentials"));
  assert.ok(calls.indexOf("reconcileCredentials") < calls.indexOf("restoreBackendConfig"));
  assert.ok(calls.indexOf("restoreBackendConfig") < calls.indexOf("rollbackCore"));
  assert.equal(calls.at(-1), "releaseLock");
});
