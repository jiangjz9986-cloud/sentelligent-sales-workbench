import { execFileSync } from "node:child_process";
import { billingSha256 } from "./p2-billing-aggregate.mjs";

// Compare complete source scopes, including runners and their dependencies.
// A shared business runtime alone cannot prove an unchanged acceptance runner.
const SCOPES = ["ai-platform", "backend", "shared", "scripts", "package.json", "package-lock.json"];
const COMMIT = /^[0-9a-f]{40}$/u;
function fail(code) { throw Object.assign(new Error(code), { code }); }

export function assessP2SourceProvenance({ repositoryRoot, originalCommit, targetCommit, checkpointBytes } = {}) {
  if (!COMMIT.test(originalCommit ?? "") || !COMMIT.test(targetCommit ?? "") || !Buffer.isBuffer(checkpointBytes)) {
    fail("P2_PROVENANCE_INPUT_INVALID");
  }
  let checkpoint;
  try { checkpoint = JSON.parse(checkpointBytes.toString("utf8")); } catch { fail("P2_PROVENANCE_INPUT_INVALID"); }
  if (checkpoint.sourceCommit !== originalCommit || typeof checkpoint.runId !== "string") fail("P2_PROVENANCE_SOURCE_MISMATCH");
  const git = (args, input) => execFileSync("git", ["-C", repositoryRoot, ...args], {
    input, maxBuffer: 128 * 1024 * 1024, timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
  });
  const entries = (commit) => {
    const records = git(["ls-tree", "-r", "-z", commit, "--", ...SCOPES]).toString("utf8").split("\0").filter(Boolean);
    const result = new Map();
    for (const record of records) {
      const match = record.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u);
      if (!match) fail("P2_PROVENANCE_SOURCE_INVALID");
      const [, mode, oid, path] = match;
      if (/\.(test|spec)\.[cm]?[jt]sx?$/u.test(path) || /(^|\/)(test|tests|__tests__)(\/|$)/u.test(path)) continue;
      result.set(path, { mode, oid });
    }
    if (!result.has("scripts/ai-platform/p2-acceptance.mjs") || !result.has("ai-platform/package-lock.json")) fail("P2_PROVENANCE_SOURCE_INVALID");
    return result;
  };
  const original = entries(originalCommit);
  const target = entries(targetCommit);
  const oids = [...new Set([...original.values(), ...target.values()].map((entry) => entry.oid))];
  const batch = git(["cat-file", "--batch"], oids.join("\n") + "\n");
  const hashes = new Map();
  let offset = 0;
  for (const oid of oids) {
    const end = batch.indexOf(10, offset);
    const header = batch.subarray(offset, end).toString("ascii").match(/^([0-9a-f]{40}) blob ([0-9]+)$/u);
    if (!header || header[1] !== oid) fail("P2_PROVENANCE_SOURCE_INVALID");
    const length = Number(header[2]);
    if (!Number.isSafeInteger(length) || end + 1 + length >= batch.length || batch[end + 1 + length] !== 10) fail("P2_PROVENANCE_SOURCE_INVALID");
    hashes.set(oid, billingSha256(batch.subarray(end + 1, end + 1 + length)));
    offset = end + length + 2;
  }
  if (offset !== batch.length) fail("P2_PROVENANCE_SOURCE_INVALID");
  const files = [...new Set([...original.keys(), ...target.keys()])].sort().map((path) => ({
    path,
    originalSha256: original.has(path) ? hashes.get(original.get(path).oid) : null,
    targetSha256: target.has(path) ? hashes.get(target.get(path).oid) : null,
    originalMode: original.get(path)?.mode ?? null,
    targetMode: target.get(path)?.mode ?? null,
  }));
  const changedPaths = files.filter((file) => file.originalSha256 !== file.targetSha256 || file.originalMode !== file.targetMode).map((file) => file.path);
  const result = {
    schemaVersion: 1, kind: "p2-source-equivalence-assessment", runId: checkpoint.runId,
    originalCommit, targetCommit, originalCheckpointSha256: billingSha256(checkpointBytes),
    scope: SCOPES, files, filesDigest: billingSha256(JSON.stringify(files)), changedPaths,
    equivalent: changedPaths.length === 0,
    reuseStatus: changedPaths.length === 0 ? "eligible-for-bound-review" : "blocked",
    code: changedPaths.length === 0 ? "P2_SOURCE_BYTES_EQUAL" : "P2_SOURCE_NOT_EQUIVALENT",
  };
  // This is an assessment, never a rewritten acceptance report or an override
  // for production-contract's exact report/source/policy binding.
  return { ...result, digest: billingSha256(JSON.stringify(result)) };
}
