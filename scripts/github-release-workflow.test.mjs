import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);

describe("GitHub tagged release workflow", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  const readJob = (jobName) => {
    const lines = workflow.split(/\r?\n/);
    const start = lines.findIndex((line) => line === `  ${jobName}:`);
    assert.notEqual(start, -1, `missing ${jobName} job`);

    let end = start + 1;
    while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end])) {
      end += 1;
    }

    return lines.slice(start, end).join("\n");
  };

  it("runs only for formal version tags", () => {
    assert.match(workflow, /tags:\s*\n\s*- ["']v\*["']/);
  });

  it("isolates read-only verification from the write-enabled publish job", () => {
    const verifyJob = readJob("verify");
    const publishJob = readJob("publish");
    const workflowHeader = workflow.slice(0, workflow.indexOf("jobs:"));

    assert.match(verifyJob, /permissions:\s*\n\s+contents:\s*read/);
    assert.doesNotMatch(verifyJob, /contents:\s*write/);
    assert.match(verifyJob, /actions\/checkout@v4[\s\S]*persist-credentials:\s*false/);
    assert.doesNotMatch(workflowHeader, /contents:\s*write/);

    assert.match(publishJob, /needs:\s*verify/);
    assert.match(publishJob, /permissions:\s*\n\s+contents:\s*write/);
  });

  it("publishes only the artifact produced by verification without executing project code", () => {
    const verifyJob = readJob("verify");
    const publishJob = readJob("publish");
    const publishSteps = publishJob.match(/^ {6}- name:/gm) ?? [];

    assert.match(verifyJob, /actions\/upload-artifact@v4/);
    assert.match(
      verifyJob,
      /name:\s*["']?sentelligent-sales-workbench-\$\{\{ github\.ref_name \}\}/,
    );
    assert.equal(publishSteps.length, 2);
    assert.match(publishJob, /actions\/download-artifact@v4/);
    assert.match(publishJob, /GH_REPO:\s*\$\{\{ github\.repository \}\}/);
    assert.match(
      publishJob,
      /name:\s*["']?sentelligent-sales-workbench-\$\{\{ github\.ref_name \}\}/,
    );
    assert.match(publishJob, /gh release create/);
    assert.doesNotMatch(
      publishJob,
      /actions\/checkout|actions\/setup-node|\bnpm(?:\s|$)|node\s+scripts\//m,
    );
  });

  it("checks out full history and requires the tagged commit to belong to origin/main", () => {
    assert.match(workflow, /fetch-depth:\s*0/);
    assert.match(workflow, /GIT_AUTH_TOKEN:\s*\$\{\{ github\.token \}\}/);
    assert.match(workflow, /\+refs\/heads\/\*:refs\/remotes\/origin\/\*/);
    assert.match(workflow, /\+refs\/tags\/\*:refs\/tags\/\*/);
    assert.match(workflow, /\+refs\/notes\/\*:refs\/notes\/\*/);
    assert.match(workflow, /git show-ref --verify --quiet refs\/remotes\/origin\/main/);
    assert.match(workflow, /tag_commit="\$\(git rev-list -n 1 "\$GITHUB_REF_NAME"\)"/);
    assert.match(workflow, /git merge-base --is-ancestor "\$tag_commit" origin\/main/);
  });

  it("requires VERSION, package manifests, and package locks to share one version", () => {
    for (const releaseFile of [
      "VERSION",
      "package.json",
      "backend/package.json",
      "backend/package-lock.json",
      "outputs/product-design-prototype/package.json",
      "outputs/product-design-prototype/package-lock.json",
    ]) {
      assert.match(workflow, new RegExp(releaseFile.replaceAll("/", "\\/")));
    }
    assert.match(workflow, /packages\?\.\[""\]\?\.version/);
    assert.match(workflow, /Version mismatch/);
    assert.match(workflow, /GITHUB_REF_NAME/);
  });

  it("rebuilds and verifies the complete project on Node 24", () => {
    assert.match(workflow, /node-version:\s*24/);
    assert.match(workflow, /npm ci --prefix backend/);
    assert.match(workflow, /npm ci --prefix outputs\/product-design-prototype/);
    assert.match(workflow, /node --test scripts\/\*\.test\.mjs/);
    assert.doesNotMatch(workflow, /npm run test:deploy/);
    assert.match(workflow, /npm --prefix backend test/);
    assert.match(workflow, /npm --prefix outputs\/product-design-prototype run qa:local/);
  });

  it("scans the working tree and complete Git history before packaging", () => {
    const historyScans = workflow.match(/node scripts\/project-secret-scan\.mjs --history/g) ?? [];
    const secretGate = workflow.indexOf("node scripts/project-secret-scan.mjs --history");
    const packageBuild = workflow.indexOf("node scripts/release-package.mjs");

    assert.equal(historyScans.length, 1, "complete-history secret scan must run exactly once");
    assert.ok(secretGate >= 0, "missing complete-history secret gate");
    assert.ok(packageBuild > secretGate, "secret gate must run before packaging");
  });

  it("publishes an immutable archive and checksum as both an artifact and a GitHub Release", () => {
    assert.match(workflow, /node scripts\/release-package\.mjs/);
    assert.doesNotMatch(workflow, /npm run release:package/);
    assert.match(workflow, /JSON\.parse\(readFileSync\("dist\/release-result\.json"/);
    assert.match(workflow, /sha256sum .*SHA256SUMS/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
    assert.match(workflow, /gh release create/);
    assert.match(workflow, /release-result\.json/);
  });
});
