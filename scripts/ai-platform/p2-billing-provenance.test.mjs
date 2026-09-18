import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assessP2SourceProvenance } from "./p2-billing-provenance.mjs";
import { billingSha256 } from "./p2-billing-aggregate.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const head = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const oldCommit = "aa443cc63430185650c01e0811ddc96fa27c6172";
const candidateCommit = "bd1df151968d0b092de117f873ca7378ed1943a7";
const checkpoint = (sourceCommit) => Buffer.from(JSON.stringify({ runId: "original-run", sourceCommit }));

test("source assessment binds immutable commit bytes and original checkpoint without rewriting the run", () => {
  const bytes = checkpoint(head);
  const proof = assessP2SourceProvenance({ repositoryRoot, originalCommit: head, targetCommit: head, checkpointBytes: bytes });
  assert.equal(proof.equivalent, true);
  assert.equal(proof.reuseStatus, "eligible-for-bound-review");
  assert.equal(proof.originalCheckpointSha256, billingSha256(bytes));
  assert.ok(proof.files.some((file) => file.path === "scripts/ai-platform/p2-acceptance.mjs" && file.originalSha256 === file.targetSha256));
  assert.ok(proof.files.some((file) => file.path === "ai-platform/package-lock.json"));
  assert.deepEqual(JSON.parse(bytes), { runId: "original-run", sourceCommit: head });
});

test("historical aa443cc and bd1df15 differ in acceptance runner and remain blocked", (context) => {
  try {
    for (const commit of [oldCommit, candidateCommit]) execFileSync("git", ["-C", repositoryRoot, "cat-file", "-e", commit], { stdio: "ignore" });
  } catch { context.skip("historical revisions unavailable in this checkout"); return; }
  const proof = assessP2SourceProvenance({ repositoryRoot, originalCommit: oldCommit, targetCommit: candidateCommit, checkpointBytes: checkpoint(oldCommit) });
  assert.equal(proof.equivalent, false);
  assert.equal(proof.reuseStatus, "blocked");
  assert.equal(proof.code, "P2_SOURCE_NOT_EQUIVALENT");
  assert.ok(proof.changedPaths.includes("scripts/ai-platform/p2-acceptance.mjs"));
  assert.ok(proof.changedPaths.includes("scripts/ai-platform/production-contract.mjs"));
});

test("source assessment rejects checkpoint relabeling and non-commit input", () => {
  assert.throws(() => assessP2SourceProvenance({ repositoryRoot, originalCommit: head, targetCommit: head, checkpointBytes: checkpoint("e".repeat(40)) }), { code: "P2_PROVENANCE_SOURCE_MISMATCH" });
  assert.throws(() => assessP2SourceProvenance({ repositoryRoot, originalCommit: "HEAD", targetCommit: head, checkpointBytes: checkpoint(head) }), { code: "P2_PROVENANCE_INPUT_INVALID" });
});
