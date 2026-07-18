# Sentelligent Release Candidate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the verified Phase 1 security foundation into a truthful, device-compatible release candidate that can replace the June production build without losing data or affecting unrelated services.

**Architecture:** Keep React 19 + Vite, Node 24, and SQLite. Remove frontend demo fallbacks, make URL state authoritative, preserve audio and WeChat workflow state through explicit backend resources, and deploy under a dedicated `/sentelligent/` public prefix while leaving other Caddy routes untouched. Production remains single-account and cookie authenticated.

**Tech Stack:** React 19, Vite 6, Lucide React, Node.js 24 `node:http` and `node:sqlite`, `weixin-agent-sdk`, Caddy, systemd, Playwright/Chrome integration QA.

---

## File Ownership

- Frontend shell and routing: `outputs/product-design-prototype/src/App.jsx`, `src/app/*`, `src/data/salesWorkbenchData.js`.
- Frontend pages and API: `src/features/salesWorkbench/pages.jsx`, `src/api/salesWorkbenchApi.js`, focused tests under `src/**/*.test.js` and `scripts/*.test.mjs`.
- Backend schema and HTTP: `backend/src/db/migrations/*`, `backend/src/server.js`, `backend/src/config.js`, focused modules under `backend/src/voice/*` and `backend/src/weixin/*`.
- Release and migration: root `scripts/*`, `docs/正式交付验收手册.md`, final handoff documents.
- Production files are changed only after all local gates pass and a production database backup is verified.

## Task 1: Truthful Empty-State Data Boundary

**Files:**
- Create: `outputs/product-design-prototype/src/app/workbenchState.js`
- Create: `outputs/product-design-prototype/src/app/workbenchState.test.js`
- Modify: `outputs/product-design-prototype/src/App.jsx`
- Modify: `outputs/product-design-prototype/src/data/salesWorkbenchData.js`
- Modify: `outputs/product-design-prototype/package.json`

- [ ] Write a failing test proving empty backend arrays stay empty, failed bootstrap renders an error/retry state, and no static customer/opportunity/risk/knowledge record becomes active data.
- [ ] Run `npm --prefix outputs/product-design-prototype run test:state` and confirm the new assertions fail against the current fallback behavior.
- [ ] Add a small state normalizer with explicit `loading`, `ready`, `empty`, and `error` states; initialize business arrays as empty and keep only presentation constants in the static data module.
- [ ] Update `App.jsx` to use the normalizer, render bounded loading/empty/error states, and never substitute sample records after a valid empty response.
- [ ] Run `test:state`, `test:api`, `test:modules`, and `npm run build` until all pass.

## Task 2: Deferred Solution Assistant And Navigation Contract

**Files:**
- Create: `backend/tests/solution-feature-flag.test.js`
- Modify: `backend/src/config.js`
- Modify: `backend/.env.example`
- Modify: `backend/src/server.js`
- Modify: `outputs/product-design-prototype/src/data/salesWorkbenchData.js`
- Modify: `outputs/product-design-prototype/src/App.jsx`
- Modify: `outputs/product-design-prototype/scripts/module-coverage.test.mjs`

- [ ] Write failing backend tests for `SOLUTION_WRITES_ENABLED=false`: solution list/detail reads remain compatible while generate/update routes return `403 FEATURE_DISABLED` without a model call or write.
- [ ] Write a failing frontend coverage test proving Solution Assistant is absent from PC/mobile primary navigation and no generate/edit control is exposed.
- [ ] Implement the strict boolean config and route guard, defaulting production writes to disabled.
- [ ] Remove the primary navigation entry and retain only a read-only historical compatibility route/state.
- [ ] Run the focused backend and frontend tests, then the complete backend suite.

## Task 3: URL-Authoritative Navigation And CRUD State

**Files:**
- Create: `outputs/product-design-prototype/src/app/routes.js`
- Create: `outputs/product-design-prototype/src/app/routes.test.js`
- Modify: `outputs/product-design-prototype/src/App.jsx`
- Modify: `outputs/product-design-prototype/src/features/salesWorkbench/pages.jsx`
- Modify: `outputs/product-design-prototype/scripts/integration-qa.mjs`

- [ ] Write route parser/builder tests for overview, quick records, customers, opportunities, actions, weekly reports, risks, knowledge, Kanban, WeChat settings, and read-only historical solutions.
- [ ] Verify the route tests fail because `active` and view modes are currently React-only state.
- [ ] Implement History API navigation with one canonical route state, `popstate` handling, safe unknown-route fallback, and a configurable public base prefix.
- [ ] Connect list, blank create, read-only detail, explicit edit, cancel, save, delete confirmation, filters, and browser Back/Forward to canonical URLs while preserving list scroll/filter state.
- [ ] Extend integration QA to refresh and deep-link into representative list/detail/edit/new routes on desktop and mobile.
- [ ] Run route tests, interaction tests, build, and integration QA.

## Task 4: Behavior-Preserving Frontend Module Split

**Files:**
- Create/modify focused files under `outputs/product-design-prototype/src/features/{overview,quickRecords,customers,opportunities,actions,weeklyReports,risks,knowledge,kanban,weixin,solutions}/`
- Modify: `outputs/product-design-prototype/src/App.jsx`
- Modify: `outputs/product-design-prototype/src/features/salesWorkbench/pages.jsx`
- Modify: `outputs/product-design-prototype/src/styles/global.css`
- Modify: `outputs/product-design-prototype/scripts/module-coverage.test.mjs`

- [ ] Add an import/ownership test that requires one page entry per feature and rejects new business-page definitions in the legacy aggregate file.
- [ ] Move one feature at a time without changing copy, props, test IDs, or behavior; run its focused tests after every move.
- [ ] Split feature-specific CSS alongside its feature while retaining shared Apple Design tokens and shell styles centrally.
- [ ] Reduce `App.jsx` to shell/session/bootstrap/router coordination and leave each feature responsible for its own display and commands.
- [ ] Run `qa:local` and compare fresh desktop/mobile screenshots with the selected Style 1 references.

## Task 5: Persistent Voice Assets And Transcript Recovery

**Files:**
- Create: `backend/src/db/migrations/0004_voice_assets.mjs`
- Create: `backend/src/voice/voiceAssetRepository.js`
- Create: `backend/tests/voice-assets.test.js`
- Modify: `backend/src/config.js`
- Modify: `backend/.env.example`
- Modify: `backend/src/server.js`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`
- Modify: `outputs/product-design-prototype/src/features/quickRecords/*`
- Modify: `outputs/product-design-prototype/scripts/integration-qa.mjs`

- [ ] Write failing migration/repository/API tests for `voice_assets` and `transcription_jobs`, bounded audio upload, authenticated download, transcript update, quick-record linkage, missing asset, and restart persistence.
- [ ] Add an ignored runtime voice directory, collision-safe filenames, MIME allowlist, maximum bytes, atomic file creation, and cleanup when a transaction fails.
- [ ] Keep browser SpeechRecognition as the fast path; always permit MediaRecorder capture and upload. When live transcription is unsupported, retain playable audio and allow manual transcript completion before analysis.
- [ ] Ensure iPhone Safari and Android Chrome layouts expose the same record/stop/play/upload/retry states without relying on object URLs after reload.
- [ ] Add browser integration coverage for the non-SpeechRecognition fallback and reload recovery; run backend and frontend focused suites.

## Task 6: Persistent WeChat Binding, Events, And Drafts

**Files:**
- Create: `backend/src/db/migrations/0005_weixin_persistence.mjs`
- Create: `backend/src/weixin/weixinRepository.js`
- Create: `backend/tests/weixin-persistence.test.js`
- Modify: `backend/src/weixin/agentBridge.js`
- Modify: `backend/src/weixin/loginBinding.js`
- Modify: `backend/src/weixin/worker.js`
- Modify: `backend/src/server.js`
- Modify: `outputs/product-design-prototype/src/features/weixin/*`

- [ ] Write failing tests for `weixin_bindings`, `weixin_events`, and `weixin_conversation_drafts`, including restart recovery, duplicate event idempotency, correction flow, and explicit final write confirmation.
- [ ] Persist binding metadata without copying the SDK token into ordinary API responses or audit snapshots.
- [ ] Persist inbound event identity and buffered conversation drafts before analysis; acknowledge duplicates without repeating quick-record writes.
- [ ] Replace raw QR HTML injection with a safe image/blob or validated SVG rendering path.
- [ ] Add status, rebind, disconnect, and recover-draft UI states; run WeChat, security, and integration tests.

## Task 7: Portable Tooling And Release Artifacts

**Files:**
- Modify: `outputs/product-design-prototype/.npmrc`
- Create: `scripts/release-package.mjs`
- Create: `scripts/release-package.test.mjs`
- Create: `scripts/production-preflight.mjs`
- Create: `scripts/production-preflight.test.mjs`
- Modify: `package.json`
- Modify: `docs/正式交付验收手册.md`

- [ ] Write failing tests proving no tracked config contains a user-specific absolute cache path and release packages exclude `.env`, databases, logs, sessions, dependencies, and Codex metadata.
- [ ] Replace the absolute npm cache path with a portable project-relative or environment-controlled setting.
- [ ] Build a manifest containing branch, commit, build hashes, migration checksums, required environment variable names, and rollback instructions.
- [ ] Add production preflight checks for Node 24, production auth hash/secret/Secure Cookie/CORS, solution-write disablement, database integrity, backup hash, service ownership, and unrelated-service protection.
- [ ] Run package tests, secret scans, and verify a generated release archive by extraction into a temporary directory.

## Task 8: Full Local And Real-Browser Acceptance

**Files:**
- Modify: `outputs/product-design-prototype/scripts/integration-qa.mjs`
- Create: `outputs/qa-audit/2026-07-19-release-candidate/release-candidate-evidence.md`
- Modify: `docs/正式交付验收手册.md`

- [ ] Run `npm run qa:full` and archive exact pass counts.
- [ ] Run the WSL SQLite/concurrency/audit matrix and a backup/restore rehearsal against an isolated database.
- [ ] Use Chrome/browser inspection at 1440x900, 1366x768, 1024x768, 390x844, and 360x800 with 100% zoom; verify no page overflow, text collision, dead controls, or unbounded business-page scroll.
- [ ] Verify login survives reload for seven days through Cookie sessions, logout revokes it, and no secret/session value is in browser storage.
- [ ] Verify quick record voice fallback, all core CRUD paths, AI analysis/edit/confirm/writeback, weekly export, Kanban stage update, and WeChat binding/recovery.
- [ ] Run secret scan, `git diff --check`, and residue checks before declaring the branch releasable.

## Task 9: Production Backup, Isolated Deployment, And Rollback Proof

**Production scope:** only `sentelligent-*` units, `/opt/sentelligent-sales-workbench*`, `/var/lib/sentelligent-sales-workbench`, the dedicated Caddy `/sentelligent/` block, and project-owned backup/release directories.

- [ ] Record current service/unit/config/database hashes and create an online-consistent SQLite backup with `quick_check`, `foreign_key_check`, table counts, byte size, and SHA-256 evidence.
- [ ] Generate a production `.env` from the Phase 1 example using the existing account, a scrypt password hash, a strong session secret, exact HTTPS CORS origin, Secure Cookie, model variables, voice directory, WeChat variables, and disabled solution writes.
- [ ] Deploy to immutable release directories and switch a project-owned `current` pointer; do not overwrite the only old deployment.
- [ ] Add a dedicated `/sentelligent/` desktop/mobile route before the unrelated mobile root handler, preserving `/qingyang`, account-vault routes, and all non-project listeners/services.
- [ ] Migrate a restored copy first, then stop only project units for the final database swap; start enabled `sentelligent-*` units and verify health, login, read/write, AI, voice, weekly export, WeChat, and restart persistence.
- [ ] Reboot only if the user explicitly approves; otherwise prove enablement with `systemctl is-enabled`, project-unit restarts, and post-restart health.
- [ ] Execute a non-destructive application rollback rehearsal and confirm the production database remains forward-compatible.

## Task 10: Final Handoff And Device Migration Package

**Files:**
- Create: `docs/项目完整交接与迁移手册.md`
- Create outside Git: `.runtime/handoff/项目私密账密与环境清单.txt`
- Create outside Git: `.runtime/handoff/sentelligent-release-candidate.bundle`
- Create outside Git: `.runtime/handoff/SHA256SUMS.txt`

- [ ] Document product requirements, module-by-module status, architecture, schemas, APIs, environments, service ownership, public routing, test evidence, known deferred scope, and next roadmap from the actual released commit.
- [ ] Put unmasked credentials and session-transfer paths only in the ignored private inventory; verify secret scans still report zero tracked findings.
- [ ] Create and verify a Git bundle containing `main`, `codex/phase-1-security-data`, and `codex/release-candidate`; include exact clone/checkout commands and expected commit.
- [ ] Create a current database backup separately from source, record its hash, and document restore-to-temporary verification before any live restore.
- [ ] Verify every referenced path exists, every checksum matches, and a clean clone can install, build, and run the non-production test gate.

## Completion Gate

- No demo business data can appear when the backend is empty or unavailable.
- The primary UI contains no active Solution Assistant write path.
- Core list/detail/create/edit/delete paths are URL-addressable and survive refresh/back/forward.
- Voice recordings and WeChat drafts survive browser/service restart without exposing secrets.
- All local, WSL, browser, security, backup/restore, and release-package gates pass from the release commit.
- Production is backed up, uses Phase 1 cookie/CSRF security, works at one stable desktop/mobile HTTPS address, and does not disturb unrelated services.
- The handoff package can recreate the latest source and data on another device with verified hashes.
