# Project Sync And Versioned Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the complete Sentelligent Sales Workbench reproducible across devices, publish every formal version to GitHub with auditable metadata, and deploy the same immutable commit to the cloud with a verified rollback point.

**Architecture:** GitHub `main` remains the deployable source of truth. Formal `v*` tags rerun the quality gates, package the tracked source into an immutable archive, publish SHA-256 evidence, and create a GitHub Release. Production keeps versioned release directories and database backups outside Git; only project-owned services are restarted, while shared Caddy and unrelated services remain untouched.

**Tech Stack:** Git/GitHub Actions/GitHub Releases, Node.js 24, React 19 + Vite, Node `node:http`, SQLite, systemd, Caddy, DeepSeek, AMap, WeChat Agent.

---

### Task 1: Establish The Release Baseline

**Files:**
- Inspect: `README.md`
- Inspect: `CHANGELOG.md`
- Inspect: `CONTRIBUTING.md`
- Inspect: `SECURITY.md`
- Inspect: `docs/正式交付验收手册.md`

- [x] **Step 1:** Create `codex/project-sync-release` from `origin/main` in an ignored worktree.
- [x] **Step 2:** Install backend and frontend dependencies from their committed lockfiles.
- [x] **Step 3:** Run `npm run test:deploy`, backend tests, and frontend `qa:local` as the clean baseline.
- [x] **Step 4:** Record the current production release, service boundaries, backup evidence, and residual security item.

### Task 2: Add Automated Tag Releases

**Files:**
- Create: `scripts/github-release-workflow.test.mjs`
- Create: `.github/workflows/release.yml`

- [x] **Step 1:** Add a static test that requires a `v*` tag trigger, Node 24, clean dependency installs, all quality gates, immutable packaging, SHA-256 output, artifact upload, and `gh release create`.
- [x] **Step 2:** Run `node --test scripts/github-release-workflow.test.mjs` and confirm it fails because the workflow does not exist.
- [x] **Step 3:** Add the minimal release workflow that satisfies the test and validates the tag against `package.json`.
- [x] **Step 4:** Rerun the focused test and the complete root deployment test suite.

### Task 3: Publish Cross-Device Project Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/开发进度与路线图.md`
- Modify: `docs/开发日志.md`
- Create: `docs/项目架构与模块说明.md`
- Create: `docs/多设备开发与版本管理.md`
- Create: `docs/发布与回滚操作手册.md`
- Create: `docs/部署记录.md`
- Create: `docs/releases/v0.2.0.md`
- Create: `VERSION`

- [x] **Step 1:** Replace stale release-candidate wording with the verified production state and current limitations.
- [x] **Step 2:** Document every frontend, backend, data, AI, integration, security, and operations boundary.
- [x] **Step 3:** Document clean clone, branch/worktree, environment, test, PR, tag, release, and device handoff procedures.
- [x] **Step 4:** Document immutable deployment, backup, post-deploy verification, application rollback, and separately approved database restore.
- [x] **Step 5:** Record release contents with ISO 8601 timestamps and explicitly separate source, runtime data, credentials, and release evidence.

### Task 4: Align Version Metadata

**Files:**
- Modify: `package.json`
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Modify: `outputs/product-design-prototype/package.json`
- Modify: `outputs/product-design-prototype/package-lock.json`
- Modify: `VERSION`

- [x] **Step 1:** Set the unified formal version to `0.2.0` without creating a tag prematurely.
- [x] **Step 2:** Verify package lockfiles contain the same package version and no dependency drift.
- [x] **Step 3:** Run `git diff --check` and the secret scans.

### Task 5: Publish Through GitHub

**Files:**
- Review: all changed files

- [ ] **Step 1:** Run the complete release, backend, frontend, integration, build, and secret gates.
- [ ] **Step 2:** Stage only the intended governance, workflow, documentation, and version files.
- [ ] **Step 3:** Commit, push `codex/project-sync-release`, and open a reviewable PR to `main`.
- [ ] **Step 4:** Confirm CI succeeds, merge without force-pushing, and verify remote `main` SHA.
- [ ] **Step 5:** Create and push annotated tag `v0.2.0`, then verify the GitHub Release assets and checksums.

### Task 6: Deploy And Verify Production

**Files:**
- Generate outside Git: release archive, manifest, checksums, service snapshots, database backups, preflight reports

- [ ] **Step 1:** Build the release archive from the merged and tagged `origin/main` commit.
- [ ] **Step 2:** Create a transactionally consistent SQLite backup and verify `quick_check`, foreign keys, size, and SHA-256.
- [ ] **Step 3:** Run the 18-check production preflight against fresh evidence.
- [ ] **Step 4:** Install a new immutable release directory and repoint only project-owned systemd units to it.
- [ ] **Step 5:** Keep shared Caddy, account-vault, Qingyang, and Mihomo services unchanged.
- [ ] **Step 6:** Run public HTTPS smoke, login/session/security, AI, AMap, WeChat status, CRUD, audit, soft-delete, responsive browser, and service-log verification.
- [ ] **Step 7:** Record the previous release path, new release path, backup path/hash, deployed commit, exact deployment time, and rollback command in the GitHub Release and deployment evidence.
