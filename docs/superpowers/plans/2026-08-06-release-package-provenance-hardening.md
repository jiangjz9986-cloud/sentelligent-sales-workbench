# v0.4.0 Release Package Provenance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining v0.4.0 release blocker so an archive can be attributed to one exact Git commit, published atomically, and deployed only after production-user tool checks pass.

**Architecture:** Build the frontend only inside the detached commit checkout, install declared dependencies from the committed lockfile with `npm ci --ignore-scripts`, and pass a fixed allowlisted environment to build tools. Treat the generated `dist` tree as untrusted filesystem output: reject links and verify every real path remains below the checkout. Keep temporary Git worktrees and archive files under one cleanup boundary, and make production OCR/PDF validation use the backend service identity plus real tool capability probes.

**Tech Stack:** Node.js 24 ESM, `node:test`, Git worktrees, npm lockfile integrity, POSIX/systemd service snapshots, Tesseract and Poppler CLI probes.

---

### Task 1: Reject generated `dist` links and boundary escapes

**Files:**
- Modify: `scripts/release-package.test.mjs`
- Modify: `scripts/release-package.mjs`

- [ ] **Step 1: Write the failing test**

Add a release fixture whose committed build script replaces `dist` with a junction/symlink to an external directory containing a binary file. Assert `createReleasePackage()` rejects with a link/boundary error, produces no archive, and never records the external file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="rejects a generated dist root" scripts/release-package.test.mjs`

Expected: FAIL because the current traversal follows the `dist` root link and creates an archive.

- [ ] **Step 3: Write minimal implementation**

Add a real-path boundary guard used by `walkFiles()`:

```js
function assertPathWithinRealDirectory(rootRealPath, candidatePath, label) {
  const metadata = lstatSync(candidatePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Release packages do not accept symbolic links: ${label}`);
  }
  const candidateRealPath = realpathSync.native(candidatePath);
  const escaped = relative(rootRealPath, candidateRealPath);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`Release path escapes its generated dist directory: ${label}`);
  }
  return metadata;
}
```

Validate the root before `readdirSync`, then validate every directory and file before following or reading it.

- [ ] **Step 4: Run test to verify it passes**

Run the focused test, then `node --test scripts/release-package.test.mjs`.

Expected: focused test PASS and no existing release-package regressions.

### Task 2: Isolate frontend dependencies and build environment

**Files:**
- Modify: `scripts/release-package.test.mjs`
- Modify: `scripts/release-package.mjs`

- [ ] **Step 1: Write failing dependency and environment tests**

Add tests proving:

```js
// An ignored source-worktree node_modules helper must never be imported.
await assert.rejects(createReleasePackage(options), /build|module|dependency/i);

// A secret-like value present only in process.env must not appear in a NUL-bearing build asset.
assert.equal(packagedBinary.includes(Buffer.from(secret)), false);
```

Add a committed local-file dependency plus lockfile fixture and assert the package is built from that committed dependency, independent of ignored `node_modules` bytes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="ignored source node_modules|allowlisted build environment|committed lockfile" scripts/release-package.test.mjs`

Expected: ignored dependency and environment leakage tests FAIL against the current symlink/full-environment implementation.

- [ ] **Step 3: Implement isolated install and build provenance**

Replace the source `node_modules` junction with:

```js
npm ci --ignore-scripts --no-audit --no-fund --cache <temporaryRoot>/npm-cache
```

Run it only inside the detached frontend checkout, require a committed `package-lock.json` when dependencies are declared, and resolve npm from `SENTELLIGENT_RELEASE_NPM_CLI`, `npm_execpath`, a Node-adjacent npm CLI, or PATH. Spawn npm and the build with separate allowlists; the build receives only stable runtime variables such as `NODE_ENV=production`, a controlled `PATH`, OS-required variables, and an explicit build-environment identity. Do not pass provider keys, webhook tokens, session secrets, proxy credentials, or arbitrary caller variables.

Return and record provenance shaped as:

```js
{
  frontend: {
    lockfile: { path: "outputs/product-design-prototype/package-lock.json", sha256 },
    runtime: { node: process.version, npm: npmVersion },
    install: { command: "npm ci", ignoreScripts: true },
    environment: { identity: "sentelligent-release-frontend-v1", allowedNames }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run the focused tests and full release-package suite. Expected: source `node_modules` is never linked, environment-only secrets are absent, and manifest provenance matches the committed lockfile/runtime.

### Task 3: Clean failed commit worktrees without masking primary errors

**Files:**
- Modify: `scripts/release-package.test.mjs`
- Modify: `scripts/release-package.mjs`

- [ ] **Step 1: Write the failing test**

Install a failing `post-checkout` hook in a fixture, invoke packaging, and assert the Git worktree inventory contains only the original worktree after failure. Add a build-failure case asserting the original build error remains the surfaced error even if cleanup also reports a problem.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="cleans a worktree registration" scripts/release-package.test.mjs`

Expected: FAIL because the current create-stage failure leaves a prunable registration.

- [ ] **Step 3: Implement one idempotent cleanup boundary**

Make creation failures call the same `git worktree remove --force`, filesystem removal, and `git worktree prune` sequence used after successful creation. Preserve a primary checkout/build error; surface cleanup failure only when there is no earlier error.

- [ ] **Step 4: Run tests to verify they pass**

Run the focused test and complete release-package suite. Expected: no extra registered worktree and no masked primary error.

### Task 4: Publish archives atomically without overwrite

**Files:**
- Modify: `scripts/release-package.test.mjs`
- Modify: `scripts/release-package.mjs`

- [ ] **Step 1: Write failing atomic-publication tests**

Add a testable `publishArchiveAtomically()` helper. Inject a write operation that writes only a prefix and throws; assert neither the final archive nor a temporary sibling remains. Add an existing-final test whose sentinel bytes are unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="publishes an archive atomically|never overwrites" scripts/release-package.test.mjs`

Expected: FAIL because the current implementation writes directly to the final name.

- [ ] **Step 3: Implement atomic publication**

Create an exclusive temporary sibling, write the complete buffer, `fsync` and close it, atomically create the final name without overwrite using a same-filesystem hard link, then unlink the temporary name. Close descriptors and remove the temporary path in every error branch.

- [ ] **Step 4: Run tests to verify they pass**

Run focused and full release-package tests. Expected: interrupted writes leave no final/temporary file and existing archives are preserved byte-for-byte.

### Task 5: Bind default timestamp to the captured commit

**Files:**
- Modify: `scripts/release-package.test.mjs`
- Modify: `scripts/release-package.mjs`

- [ ] **Step 1: Write the failing test**

Create two commits with distinct commit timestamps, resolve the timestamp for the older captured commit while `HEAD` points at the newer commit, and assert the older commit time is used.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="captured commit time" scripts/release-package.test.mjs`

Expected: FAIL because the helper currently queries `HEAD`.

- [ ] **Step 3: Implement commit-bound lookup**

Change the lookup to `git show -s --format=%ct <source.commit>` and update the diagnostic label to refer to the release commit rather than HEAD.

- [ ] **Step 4: Run tests to verify they pass**

Run focused and full release-package tests.

### Task 6: Validate OCR/PDF tools as the backend service user and probe capabilities

**Files:**
- Modify: `scripts/production-preflight.test.mjs`
- Modify: `scripts/production-preflight.mjs`
- Modify: `docs/正式交付验收手册.md`

- [ ] **Step 1: Write failing preflight tests**

Cover three cases: a root-only `0700` executable rejected for backend user `sentelligent`/`sentzx`; a generic executable rejected when it is not Tesseract or `pdftotext`; and Tesseract rejected when configured languages are not reported by `--list-langs`. The tests must use the real default inspector or a structured inspector returning capability evidence, not the existing boolean-only wrapper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="backend service user|Tesseract identity|OCR languages" scripts/production-preflight.test.mjs`

Expected: FAIL because the current inspector checks only root-process `X_OK` and ordinary-file status.

- [ ] **Step 3: Implement service-user and capability inspection**

Derive the backend `User` from the validated service snapshot. Inspect ownership/mode bits for that identity, fail closed if the user/group cannot be resolved, and probe exact commands with bounded invocations:

```text
tesseract --version
tesseract --list-langs
pdftotext -v
```

Require the OCR binary to identify as Tesseract, require every configured `INVOICE_OCR_LANGUAGES` token to exist, require the PDF binary to identify as Poppler `pdftotext`, and return only boolean/categorical evidence without command paths or environment values in the report.

- [ ] **Step 4: Run tests to verify they pass**

Run focused and full production-preflight suites. Expected: root-only/generic/missing-language tools fail closed; valid fixtures and production snapshots pass.

### Task 7: Fresh review and release gates

**Files:**
- Verify only; do not edit unless a test exposes a new defect.

- [ ] **Step 1: Run release and preflight suites**

Run: `node --test scripts/release-package.test.mjs scripts/production-preflight.test.mjs scripts/production-cutover.test.mjs`

- [ ] **Step 2: Run project-wide automated gates**

Run backend tests, frontend build/tests, root deployment/security tests, Chromium integration QA, WebKit QA, Git-history secret scan, and `git diff --check`.

- [ ] **Step 3: Request an independent read-only safety review**

The reviewer must re-attempt the original junction, ignored dependency, binary environment leak, worktree-hook failure, partial archive, and root-only OCR/PDF adversarial cases.

- [ ] **Step 4: Perform Chrome acceptance**

Upload, preview, associate, print, and delete representative payment proof/PDF files in the real browser without deleting `.codex-tmp/chrome-acceptance` or `tmp/pdfs` until acceptance is recorded.

- [ ] **Step 5: Release only after all evidence is green**

Commit the complete v0.4.0 scope, push the branch, merge through GitHub, tag `v0.4.0`, publish the GitHub Release, run isolated production preflight/cutover, and verify the public health and authenticated workflows. Do not modify or restart shared Caddy, Qingyang, account-vault, Mihomo, or port `127.0.0.1:8797`.
