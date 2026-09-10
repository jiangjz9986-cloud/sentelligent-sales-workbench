import { hashBytes, validateTransitionManifest } from "./production-contract.mjs";

export async function runProductionTransition(input, adapter, { clock = () => new Date(), onEvent = () => {} } = {}) {
  const manifest = validateTransitionManifest(input);
  const report = {
    schemaVersion: 1, transitionId: manifest.id, manifestDigest: hashBytes(JSON.stringify(manifest)),
    startedAt: clock().toISOString(), oldCommit: manifest.oldCommit, newCommit: manifest.newCommit,
    phase: manifest.phase, rolloutPhase: manifest.rolloutPhase,
    status: "running", rollbackStatus: "not-required", steps: [],
  };
  let captured = false;
  let mutationStarted = false;
  let backendChangeAttempted = false;
  let locked = false;
  async function step(name, operation) {
    const item = { name, startedAt: clock().toISOString(), status: "running" };
    report.steps.push(item);
    onEvent({ step: name, status: "running" });
    try {
      const value = await operation();
      item.status = "passed";
      item.finishedAt = clock().toISOString();
      onEvent({ step: name, status: "passed" });
      return value;
    } catch (error) {
      item.status = "failed";
      item.finishedAt = clock().toISOString();
      item.errorCode = /^[A-Za-z0-9_.:-]{1,100}$/u.test(error?.code ?? "") ? error.code : "TRANSITION_STEP_FAILED";
      onEvent({ step: name, status: "failed", errorCode: item.errorCode });
      throw error;
    }
  }
  try {
    await step("lock", () => adapter.acquireLock(manifest));
    locked = true;
    await step("inspect", () => adapter.inspect(manifest, "old"));
    await step("preflight", () => adapter.verifyPreflight(manifest));
    await step("capture", () => adapter.captureState(manifest));
    captured = true;
    mutationStarted = true;
    await step("platform-drain", () => adapter.drainPlatform(manifest));
    await step("platform-backup", () => adapter.backupPlatform(manifest));
    backendChangeAttempted = true;
    await step("backend-config", () => adapter.stageBackendConfig(manifest));
    await step("core-cutover", () => adapter.cutoverCore(manifest));
    await step("new-identity", () => adapter.inspect(manifest, "new"));
    await step("platform-ready", () => adapter.resumePlatform(manifest));
    await step("event-reconciliation", () => adapter.reconcileProactiveEvents(manifest));
    await step("postflight", () => adapter.verifyPostflight(manifest));
    report.status = "passed";
  } catch {
    report.status = "failed";
    if (mutationStarted && captured) {
      report.rollbackStatus = "running";
      try {
        await step("rollback-platform-drain", () => adapter.drainPlatform(manifest));
        await step("rollback-credentials", () => adapter.reconcileCredentials(manifest));
        if (backendChangeAttempted) {
          await step("rollback-config", () => adapter.restoreBackendConfig(manifest));
          await step("rollback-core", () => adapter.rollbackCore(manifest));
        }
        await step("rollback-platform", () => adapter.rollbackPlatform(manifest));
        await step("rollback-identity", () => adapter.inspect(manifest, "old"));
        report.rollbackStatus = "passed";
      } catch {
        report.rollbackStatus = "failed";
      }
    }
  } finally {
    report.finishedAt = clock().toISOString();
    if (locked) {
      try { await adapter.releaseLock(manifest); }
      catch { report.status = "failed"; report.lockReleaseFailed = true; }
    }
  }
  return report;
}

export async function runProductionRollback(input, adapter, { clock = () => new Date(), onEvent = () => {} } = {}) {
  const manifest = validateTransitionManifest(input);
  const report = {
    schemaVersion: 1,
    transitionId: manifest.id,
    manifestDigest: hashBytes(JSON.stringify(manifest)),
    startedAt: clock().toISOString(),
    phase: manifest.phase,
    rolloutPhase: manifest.rolloutPhase,
    status: "running",
    rollbackStatus: "running",
    steps: [],
  };
  let locked = false;
  async function step(name, operation) {
    const item = { name, startedAt: clock().toISOString(), status: "running" };
    report.steps.push(item);
    onEvent({ step: name, status: "running" });
    try {
      const value = await operation();
      item.status = "passed";
      item.finishedAt = clock().toISOString();
      onEvent({ step: name, status: "passed" });
      return value;
    } catch (error) {
      item.status = "failed";
      item.finishedAt = clock().toISOString();
      item.errorCode = /^[A-Za-z0-9_.:-]{1,100}$/u.test(error?.code ?? "") ? error.code : "ROLLBACK_STEP_FAILED";
      onEvent({ step: name, status: "failed", errorCode: item.errorCode });
      throw error;
    }
  }
  try {
    await step("lock", () => adapter.acquireLock(manifest));
    locked = true;
    await step("rollback-state", () => adapter.verifyRollbackState(manifest));
    await step("rollback-platform-drain", () => adapter.drainPlatform(manifest));
    await step("rollback-credentials", () => adapter.reconcileCredentials(manifest));
    await step("rollback-config", () => adapter.restoreBackendConfig(manifest));
    await step("rollback-core", () => adapter.rollbackCore(manifest));
    await step("rollback-platform", () => adapter.rollbackPlatform(manifest));
    await step("rollback-identity", () => adapter.inspect(manifest, "old"));
    if (adapter.verifyRollback) await step("rollback-postflight", () => adapter.verifyRollback(manifest));
    report.status = "passed";
    report.rollbackStatus = "passed";
  } catch {
    report.status = "failed";
    report.rollbackStatus = "failed";
  } finally {
    report.finishedAt = clock().toISOString();
    if (locked) {
      try { await adapter.releaseLock(manifest); }
      catch { report.status = "failed"; report.rollbackStatus = "failed"; report.lockReleaseFailed = true; }
    }
  }
  return report;
}
