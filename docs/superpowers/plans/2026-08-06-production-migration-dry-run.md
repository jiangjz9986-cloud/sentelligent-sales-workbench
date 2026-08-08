# Production Migration Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block production cutover before any service mutation unless the candidate release migrations succeed on an isolated copy of a verified SQLite backup and pass SQLite integrity checks.

**Architecture:** Extend the controlled cutover script with a pre-mutation migration rehearsal. Create a consistent backup from a read-only connection to the live database, verify that backup, clone it into an isolated rehearsal database, run the candidate release's own `backend/src/db.js --migrate` entry against only that clone, checkpoint it, and require `PRAGMA quick_check` plus `PRAGMA foreign_key_check` to pass before the existing service-stop phase.

**Tech Stack:** Bash, Node.js 24 `node:sqlite`, Node test runner.

---

### Task 1: Prove the migration rehearsal contract

**Files:**
- Modify: `scripts/production-cutover.test.mjs`

- [x] **Step 1: Write a failing execution test**

  Add a fixture release containing a real migration entry and a source SQLite database. Invoke the wished-for rehearsal function with a fake `systemctl` in `PATH`, then assert that the candidate migration exists only in the rehearsal copy, the source database remains unchanged, both integrity pragmas pass, and no systemd command was called.

- [x] **Step 2: Write a failing ordering test**

  Parse `main()` and assert that `rehearse_candidate_migrations` appears after release verification but before `stop_writers_and_lock_database` and therefore before the first service mutation.

- [x] **Step 3: Run the focused tests and verify RED**

  Run: `node --test scripts/production-cutover.test.mjs`

  Expected: the new tests fail because `rehearse_candidate_migrations` does not exist.

### Task 2: Implement the smallest safe rehearsal

**Files:**
- Modify: `scripts/production-cutover.sh`

- [x] **Step 1: Create and verify a consistent pre-cutover backup**

  Open the live source with `DatabaseSync(..., { readOnly: true })`, use `VACUUM INTO` to create a new file under the current run backup directory, and require `quick_check=ok` and zero foreign-key violations.

- [x] **Step 2: Clone and migrate only the isolated rehearsal database**

  Copy the verified backup to a second new file, set `DATABASE_URL` to that file, and execute `$NEW_RELEASE/backend/src/db.js --migrate` with `$NODE_BIN`.

- [x] **Step 3: Checkpoint and verify the migrated rehearsal database**

  Checkpoint WAL, switch to DELETE journal mode, reject sidecars, then require `quick_check=ok` and zero foreign-key violations.

- [x] **Step 4: Gate service mutation**

  Call `rehearse_candidate_migrations` from `main()` after manifest/protected-state validation and before `stop_writers_and_lock_database`.

- [x] **Step 5: Run the focused tests and verify GREEN**

  Run: `node --test scripts/production-cutover.test.mjs`

  Expected: all tests pass with zero failures.

### Task 3: Verify scope and shell safety

**Files:**
- Verify: `scripts/production-cutover.sh`
- Verify: `scripts/production-cutover.test.mjs`

- [x] **Step 1: Run Bash syntax validation**

  Run: `bash -n scripts/production-cutover.sh`

  Expected: exit code 0.

- [x] **Step 2: Run deploy-script focused tests**

  Run: `node --test scripts/production-cutover.test.mjs`

  Expected: all tests pass with zero failures.

- [x] **Step 3: Inspect the final diff**

  Confirm no changes to `scripts/release-package.mjs`, `backend/src/services/idempotency.js`, production configuration, Git history, or deployed services.
