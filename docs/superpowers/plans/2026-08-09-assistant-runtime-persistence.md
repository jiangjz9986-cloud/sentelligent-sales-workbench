# Assistant Runtime Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development and verification-before-completion when changing this slice.

**Goal:** Provide durable SQLite storage for Clawbot assistant events, conversations, drafts, pending confirmations, and tool runs.

**Architecture:** `0011` adds the five runtime tables and indexes under the existing migration checksum/transaction runner. Three focused repositories expose synchronous, transaction-safe operations: inbound events and tool runs; conversations and draft parts; pending actions and confirmation expiry. External identifiers, request identifiers, lease tokens, and confirmation codes are stored as SHA-256 hashes where applicable; response and draft content remains restart-readable JSON/text.

**Tech Stack:** Node.js `node:test`, `node:sqlite`, existing `withImmediateTransaction`, `HttpError`, and `insertAudit` helpers.

---

### Task 1: Persistence contract tests

**Files:**
- Create: `backend/tests/assistant-runtime-persistence.test.js`

- [x] Write tests for same-event replay, changed-request `409`, expired lease takeover and stale-token fencing.
- [x] Write tests for tool-run uniqueness by owner/channel/event hash/tool name.
- [x] Write a file-backed restart test for conversation and draft-part recovery.
- [x] Write tests proving pending-action expiry and confirmation-code hash storage without plaintext.
- [x] Run `& 'C:\Users\50159\.workbuddy\binaries\node\versions\22.22.2\node.exe' --test tests/assistant-runtime-persistence.test.js` and observe the missing-module red failure before implementing repositories.

### Task 2: SQLite migration 0011

**Files:**
- Create: `backend/src/db/migrations/0011_assistant_runtime_persistence.mjs`
- Modify: `backend/src/db/migrate.js`
- Modify: `backend/tests/migrations.test.js`

- [x] Register the next available version after `0010`.
- [x] Create `assistant_inbound_events`, `assistant_conversations`, `assistant_draft_parts`, `assistant_pending_actions`, and `assistant_tool_runs` with owner/channel/event hashes, versions, statuses, lease fields, expiry fields, and confirmation-code hash constraints.
- [x] Add foreign keys, uniqueness constraints, and status indexes.
- [x] Extend migration expectations to include `0011` and its checksum.

### Task 3: Repositories

**Files:**
- Create: `backend/src/assistant/eventRepository.js`
- Create: `backend/src/assistant/sessionRepository.js`
- Create: `backend/src/assistant/pendingActionRepository.js`

- [x] Implement event receive/claim/complete with replay and request-hash conflict semantics; retain only hashed event and lease identity.
- [x] Implement tool-run create/claim/complete with event-scoped deduplication and lease fencing.
- [x] Implement conversation get-or-create, draft append, list, and external-ID hash lookup.
- [x] Implement pending-action create, confirmation-code hash validation, expiry transition, and safe public projections.
- [x] Use existing immediate transactions and audit sanitizer; never return or persist plaintext confirmation codes or lease tokens.

### Task 4: Verification

**Files:** none

- [x] Run focused persistence and migration tests: 17/17 passing.
- [x] Run all backend tests: 531/531 passing, 0 failures.
- [x] Run `git diff --check` with no whitespace errors.

Known boundary: HTTP integration, Clawbot worker wiring, model calls, and production deployment remain in the parent integration slice.
