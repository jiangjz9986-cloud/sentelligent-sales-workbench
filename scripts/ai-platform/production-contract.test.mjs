import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PLATFORM_SOCKET_GROUP,
  platformStaticDirectoryForRelease,
  validateTransitionManifest,
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
  assert.equal(validateTransitionManifest({ ...manifest, phase: "legacy", rolloutPhase: "P1" }).rolloutPhase, "P1");
  assert.equal(validateTransitionManifest({ ...manifest, phase: "legacy", rolloutPhase: "P2" }).rolloutPhase, "P2");
  assert.equal(validateTransitionManifest({ ...manifest, phase: "canary", rolloutPhase: "P4" }).rolloutPhase, "P4");
  assert.equal(validateTransitionManifest({ ...manifest, phase: "platform", rolloutPhase: "P6" }).rolloutPhase, "P6");
  assert.throws(() => validateTransitionManifest({ ...manifest, phase: "legacy", rolloutPhase: "P5" }));
});
