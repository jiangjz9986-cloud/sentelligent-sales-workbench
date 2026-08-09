# Clawbot Assistant Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the persistent WeChat Clawbot runtime safe to merge by binding confirmations to their stored plans, enforcing owner isolation, preventing duplicate execution, and requiring strong production-only secrets and HTTPS transport.

**Architecture:** Keep the existing SQLite repositories and deterministic router, extending the pending-action row with an execution lease/plan digest and adding the missing owner boundary to legacy quick records. The orchestrator will execute only the persisted, atomically claimed action; configuration and the remote adapter will reject weak or plaintext production wiring.

**Tech Stack:** Node.js 24, built-in `node:test`, SQLite migrations, HTTP integration tests, GitHub Actions.

---

### Task 1: Reproduce and lock down confirmation binding and replay races

**Files:**
- Modify: `backend/tests/assistant-orchestrator.test.js`
- Modify: `backend/tests/assistant-runtime-persistence.test.js`

- [x] **Step 1: Write failing tests** for a confirmation request whose new text/arguments differ from the stored plan, for a replayed confirmation that must not invoke the handler, and for two concurrent confirmations where only one can claim execution.
- [x] **Step 2: Run the focused tests** with the bundled Node executable and confirm the new assertions fail for the current implementation.

### Task 2: Persist and atomically claim the exact pending action

**Files:**
- Add: `backend/src/db/migrations/0012_assistant_owner_and_plan_digest.mjs`
- Modify: `backend/src/assistant/pendingActionRepository.js`
- Modify: `backend/src/assistant/orchestrator.js`

- [x] **Step 1: Add the minimal schema fields** for a canonical plan digest and a short-lived execution lease, preserving existing rows through nullable/backfill-safe migration logic.
- [x] **Step 2: Store a canonical digest at creation** and expose a repository method that atomically transitions a confirmed action to `processing`, returning `replayed`/`in-progress` states without revealing the code hash.
- [x] **Step 3: Make confirmation validate the request against the stored plan** and make the orchestrator execute the stored invocation only after a successful claim; persist the result and release the lease transactionally.
- [x] **Step 4: Run the focused persistence/orchestrator tests, then the assistant HTTP integration tests.**

### Task 3: Enforce owner-scoped sales data

**Files:**
- Modify: `backend/src/schema.sql`
- Modify: `backend/src/assistant/runtimeHandlers.js`
- Modify: `backend/tests/assistant-http-integration.test.js`
- Modify: `backend/tests/migrations.test.js`

- [x] **Step 1: Add a failing owner-isolation test** showing customer search and sales-week reporting cannot return another owner’s rows.
- [x] **Step 2: Add/backfill `quick_records.owner`** using the existing seed/legacy ownership convention, with an explicit safe fallback for historical rows.
- [x] **Step 3: Add owner predicates to assistant queries and write the context owner on new visit records.**
- [x] **Step 4: Run migration, isolation, and full backend tests.**

### Task 4: Harden production configuration and remote transport

**Files:**
- Modify: `backend/src/config.js`
- Modify: `backend/src/weixin/remoteAgent.js`
- Modify: `backend/tests/config.test.js`
- Modify: `backend/tests/weixin-remote-agent.test.js`
- Modify: `docs/微信Clawbot助手集成.md`

- [x] **Step 1: Add failing tests** for weak production machine/confirmation tokens and an `http://` remote backend URL.
- [x] **Step 2: Require canonical high-entropy independent secrets in production** without printing their values, and reject non-HTTPS remote URLs except an explicitly permitted loopback test URL.
- [x] **Step 3: Run focused config/adapter tests and the complete backend suite.**

### Task 5: Release verification and GitHub handoff

**Files:**
- Modify: `docs/releases/v0.5.0.md`

- [x] **Step 1: Run secret scanning, backend tests, release tests, and the frontend QA gates using the bundled runtimes.**
- [ ] **Step 2: Inspect the diff and PR checks; push only the verified commits.**
- [x] **Step 3: Record remaining production prerequisites without including any token, password, key, cookie, or database content.**

Implementation note: published migrations `0001` through `0011` remain byte-stable. The plan digest and owner backfill are shipped in the new forward-only migration `0012_assistant_owner_and_plan_digest`.
