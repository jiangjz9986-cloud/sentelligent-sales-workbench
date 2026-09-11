import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PLATFORM_SOCKET_GROUP,
  platformStaticDirectoryForRelease,
  rolloutControlsForPhase,
  validateRolloutConfiguration,
  validateRolloutRuntime,
  p2AcceptanceRequiredForRollout,
  validateTransitionManifest,
  validateP2AcceptanceReport,
  transitionIdentityDigest,
  renderPlatformUnit,
  PRODUCTION_ROOT,
} from "./production-contract.mjs";
import { platformUnitReleasePath } from "./production-host.mjs";

const evidence = PRODUCTION_ROOT + "/evidence/fusion-test";
const manifest = {
  schemaVersion: 1, id: "fusion-test", hostname: "test-host", machineId: "a".repeat(32),
  oldRelease: PRODUCTION_ROOT + "/releases/v0.12.3-test", oldCommit: "b".repeat(40),
  newRelease: PRODUCTION_ROOT + "/releases/v0.13.0-test", newCommit: "c".repeat(40),
  evidenceDir: evidence, backupDir: PRODUCTION_ROOT + "/backups/fusion-test",
  platformEnvCandidate: evidence + "/platform.env", backendEnvCandidate: evidence + "/backend.env",
  platformEnvSha256: "d".repeat(64), backendEnvSha256: "e".repeat(64),
  corePreflight: evidence + "/core.json", corePreflightSha256: "f".repeat(64),
  policyFile: evidence + "/policy.json", policySha256: "1".repeat(64), phase: "canary",
  newArchive: evidence + "/release.tar.gz", newArchiveSha256: "2".repeat(64),
  qualityReport: evidence + "/quality.json", qualityReportSha256: "3".repeat(64),
  p2AcceptanceReport: evidence + "/p2-acceptance.json", p2AcceptanceReportSha256: "4".repeat(64),
};
test("transition identities are exact and cannot expand services, releases or state paths", () => {
  assert.equal(validateTransitionManifest(manifest).newCommit, manifest.newCommit);
  for (const changed of [
    { newRelease: PRODUCTION_ROOT + "/current" },
    { newRelease: PRODUCTION_ROOT + "/releases/nested/release" },
    { backendEnvCandidate: "/etc/environment" },
    { policyFile: evidence + "/../policy.json" },
    { newCommit: "main" },
    { services: ["qingyang-store.service"] },
  ]) assert.throws(() => validateTransitionManifest({ ...manifest, ...changed }));
});
test("unit uses the exact release, direct Node, isolated account and CentOS 7 compatible protection", () => {
  const template = readFileSync(new URL("./systemd/sentelligent-ai-platform.service.template", import.meta.url), "utf8");
  const rendered = renderPlatformUnit(template, manifest.newRelease);
  assert.match(rendered, /User=sentai/);
  assert.match(rendered, new RegExp(`Group=${PLATFORM_SOCKET_GROUP}`));
  assert.match(rendered, /Type=simple/);
  assert.match(rendered, /RuntimeDirectoryMode=0710/);
  assert.match(rendered, /ReadWriteDirectories=\/run\/sentelligent-ai-platform \/var\/lib\/sentelligent-ai-platform/);
  assert.match(rendered, /UMask=0077/);
  assert.doesNotMatch(rendered, /Group=sentai|Group=sentzx/);
  assert.ok(rendered.includes(manifest.newRelease + "/ai-platform/src/cli.js serve"));
  assert.doesNotMatch(rendered, /Type=forking|PIDFile=|ExecStop=|ReadWritePaths=/);
  assert.match(renderPlatformUnit(template, manifest.newRelease, { serviceGroup: "sentai" }), /Group=sentai/);
});

test("platform static assets are bound to the immutable candidate release", () => {
  assert.equal(
    platformStaticDirectoryForRelease(manifest.newRelease),
    manifest.newRelease + "/outputs/ai-platform-admin",
  );
  assert.throws(() => platformStaticDirectoryForRelease(PRODUCTION_ROOT + "/current"));
});

test("platform unit adoption only extracts direct immutable release paths", () => {
  const template = readFileSync(new URL("./systemd/sentelligent-ai-platform.service.template", import.meta.url), "utf8");
  const rendered = renderPlatformUnit(template, manifest.oldRelease);
  assert.equal(platformUnitReleasePath(rendered), manifest.oldRelease);
  assert.equal(
    platformUnitReleasePath(rendered.replace(`WorkingDirectory=${manifest.oldRelease}`, `WorkingDirectory=${PRODUCTION_ROOT}/current`)),
    null,
  );
  assert.equal(
    platformUnitReleasePath(rendered.replace(`WorkingDirectory=${manifest.oldRelease}`, `${manifest.oldRelease}/nested`)),
    null,
  );
});

test("rollout phases preserve the lower-level routing contract", () => {
  assert.deepEqual(rolloutControlsForPhase("P1"), {
    rolloutPhase: "P1", routingPhase: "legacy", executionMode: "local-simulated",
    externalProvidersEnabled: false, taskAdmissionEnabled: false, queuePaused: true,
    businessAdmission: false, singleConcurrency: true, taskConcurrency: 1, taskOwnerConcurrency: 1,
  });
  assert.deepEqual(rolloutControlsForPhase("P2"), {
    rolloutPhase: "P2", routingPhase: "legacy", executionMode: "external-provider",
    externalProvidersEnabled: true, taskAdmissionEnabled: true, queuePaused: false,
    businessAdmission: false, singleConcurrency: true, taskConcurrency: 1, taskOwnerConcurrency: 1,
  });
  assert.deepEqual(rolloutControlsForPhase("P3"), {
    rolloutPhase: "P3", routingPhase: "canary", executionMode: "external-provider",
    externalProvidersEnabled: true, taskAdmissionEnabled: true, queuePaused: false,
    businessAdmission: true, singleConcurrency: false, taskConcurrency: null, taskOwnerConcurrency: null,
  });
  assert.equal(p2AcceptanceRequiredForRollout("P1"), false);
  assert.equal(p2AcceptanceRequiredForRollout("P2"), false);
  assert.equal(p2AcceptanceRequiredForRollout("P3"), true);
  assert.equal(validateTransitionManifest({ ...manifest, phase: "legacy", rolloutPhase: "P1" }).rolloutPhase, "P1");
  assert.equal(validateTransitionManifest({ ...manifest, phase: "legacy", rolloutPhase: "P2" }).rolloutPhase, "P2");
  assert.equal(validateTransitionManifest({ ...manifest, phase: "canary", rolloutPhase: "P4" }).rolloutPhase, "P4");
  assert.equal(validateTransitionManifest({ ...manifest, phase: "platform", rolloutPhase: "P6" }).rolloutPhase, "P6");
  assert.throws(() => validateTransitionManifest({ ...manifest, phase: "legacy", rolloutPhase: "P5" }));
  assert.doesNotThrow(() => validateTransitionManifest({
    ...manifest,
    phase: "legacy",
    rolloutPhase: "P1",
    p2AcceptanceReport: undefined,
    p2AcceptanceReportSha256: undefined,
  }));
  assert.throws(() => validateTransitionManifest({
    ...manifest,
    p2AcceptanceReport: undefined,
    p2AcceptanceReportSha256: undefined,
  }), /p2 acceptance binding is required/u);
  assert.throws(() => validateTransitionManifest({
    ...manifest,
    p2AcceptanceReport: undefined,
  }), /p2 acceptance binding is incomplete/u);
});

test("rollout configuration and runtime gates distinguish paused P1 from live-provider P2", () => {
  assert.deepEqual(validateRolloutConfiguration("P1", {
    executionMode: "local-simulated",
    externalProvidersEnabled: false,
    taskAdmissionEnabled: false,
    taskConcurrency: 1,
    taskOwnerConcurrency: 1,
  }), rolloutControlsForPhase("P1"));
  assert.deepEqual(validateRolloutConfiguration("P2", {
    executionMode: "external-provider",
    externalProvidersEnabled: true,
    taskAdmissionEnabled: true,
    taskConcurrency: 1,
    taskOwnerConcurrency: 1,
  }), rolloutControlsForPhase("P2"));
  assert.throws(() => validateRolloutConfiguration("P1", {
    executionMode: "local-simulated", externalProvidersEnabled: false, taskAdmissionEnabled: true,
    taskConcurrency: 1, taskOwnerConcurrency: 1,
  }), /ROLLOUT_TASK_ADMISSION_INVALID/u);
  assert.throws(() => validateRolloutConfiguration("P2", {
    executionMode: "local-simulated", externalProvidersEnabled: false, taskAdmissionEnabled: true,
    taskConcurrency: 1, taskOwnerConcurrency: 1,
  }), /ROLLOUT_EXECUTION_MODE_INVALID/u);

  const paused = { paused: true, executor: { admissionOpen: false }, queue: { running: 0, queued: 0 } };
  const open = { paused: false, executor: { admissionOpen: true }, queue: { running: 0, queued: 0 } };
  assert.equal(validateRolloutRuntime("P1", { operations: paused, requireQueueEmpty: true }).queuePaused, true);
  assert.equal(validateRolloutRuntime("P2", { operations: open, requireQueueEmpty: true }).queuePaused, false);
  assert.throws(() => validateRolloutRuntime("P1", { operations: open }), /ROLLOUT_QUEUE_MUST_BE_PAUSED/u);
  assert.throws(() => validateRolloutRuntime("P2", { operations: paused }), /ROLLOUT_BUSINESS_ADMISSION_REQUIRED/u);
  assert.throws(() => validateRolloutRuntime("P2", {
    operations: { ...open, queue: { running: 1, queued: 0 } }, requireQueueEmpty: true,
  }), /ROLLOUT_QUEUE_NOT_EMPTY/u);
});

test("P2 acceptance evidence is bound to the candidate commit, policy, provider policies, and reconciled samples", () => {
  const now = Date.parse("2026-09-11T12:00:00.000Z");
  const sourceCommit = "c".repeat(40);
  const policyDigest = "1".repeat(64);
  const providerDigest = "2".repeat(64);
  const generatedAt = "2026-09-11T10:00:00.000Z";
  const report = {
    schemaVersion: 1,
    status: "passed",
    phase: "P2",
    sourceCommit,
    policyDigest,
    providerPolicyDigest: providerDigest,
    generatedAt,
    observation: {
      startedAt: "2026-09-11T07:59:00.000Z",
      finishedAt: generatedAt,
      durationSeconds: 7_260,
    },
    summary: { total: 10, approved: 10, failed: 0 },
    failures: [],
    samples: Array.from({ length: 10 }, (_value, index) => ({
      approved: true,
      requestId: `p2-request-${index}`,
      providerRequestId: `provider-request-${index}`,
      priceVersion: `price-version-${index}`,
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: { micro: 1, currency: "CNY", status: "calculated" },
      billingReconciliation: {
        status: "reconciled", reference: `billing-${index}`, providerRequestId: `provider-request-${index}`,
        amountMicro: 1, currency: "CNY",
      },
    })),
    producerProvenance: {
      controlled: true,
      producerId: "ai-platform-p2-acceptance",
      producerVersion: "1",
      sourceCommit,
      generatedAt,
      runId: "p2-run-20260911",
    },
  };
  const normalized = validateP2AcceptanceReport(report, {
    sourceCommit,
    policyDigest,
    expectedProviderPolicyDigest: providerDigest,
    currency: "CNY",
    now,
  });
  assert.equal(normalized.sampleCount, 10);
  assert.equal(normalized.observationSeconds, 7_260);
  assert.throws(() => validateP2AcceptanceReport(report, {
    sourceCommit: "d".repeat(40),
    policyDigest,
    expectedProviderPolicyDigest: providerDigest,
    currency: "CNY",
    now,
  }), /P2_ACCEPTANCE_COMMIT_MISMATCH/u);
  assert.notEqual(
    transitionIdentityDigest(manifest),
    transitionIdentityDigest({ ...manifest, p2AcceptanceReportSha256: "5".repeat(64) }),
  );
});
