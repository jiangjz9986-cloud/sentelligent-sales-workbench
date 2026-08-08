# iCost Acceptance Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-local, fail-closed cleanup tool that removes exactly one manifested iCost production-acceptance ingestion and only the financial rows created exclusively by that ingestion.

**Architecture:** Export a synchronous cleanup function from a dedicated backend script and keep the CLI as a thin manifest-file adapter. The function verifies the file-backed database identity before opening a write transaction, then validates the ingestion, owner, source ID, actor, financial relationships, audit rows, and absence of unrelated foreign-key dependents before deleting by exact primary keys. Database integrity checks run before commit, and the returned report contains counts and booleans only.

**Tech Stack:** Node.js ESM, built-in `node:test`, synchronous SQLite adapter already used by the backend, existing database identity and immediate-transaction helpers.

---

### Task 1: Lock the exact cleanup contract in tests

**Files:**
- Create: `backend/tests/icost-acceptance-cleanup.test.js`
- Test: `backend/tests/icost-acceptance-cleanup.test.js`

- [ ] **Step 1: Write a successful accepted-ingestion fixture test**

Create a migrated temporary file database, insert one `travel_expense_ingestions` row with `owner = 'jiangjz'`, `source = 'icost'`, `actor = 'icost-webhook'`, and a unique `ACCEPTANCE-<UUID>` source ID, plus its exact expense, payment, and two ingestion audit rows. Call the wished-for API:

```js
const report = cleanupIcostAcceptance({
  databaseUrl,
  authSessionSecret: "<set-in-production>",
  manifest: {
    owner: "jiangjz",
    source_id: sourceId,
    ingestion_id: ingestionId,
    expense_id: expenseId,
    payment_id: paymentId,
    database_identity: "<server-generated-database-identity>",
  },
});
```

Assert exact deletion counts, zero residual rows, `quickCheck === 'ok'`, zero foreign-key violations, and no IDs, source text, owner, path, or secrets in the serialized report.

- [ ] **Step 2: Add fail-closed safety cases**

Add independent tests proving the transaction preserves all rows when the manifest has a wrong database identity, missing ingestion, mismatched owner/source ID/expense/payment, a duplicate exact source ID in another owner, a forged actor or source, an extra payment, another ingestion referencing the expense or payment, another business table referencing either financial row, incomplete/extra ingestion audit rows, or a forced mid-delete failure.

- [ ] **Step 3: Add review-required coverage**

Insert a manifested `review_required` ingestion with no financial IDs and its exact receive/review audit pair. Verify the cleanup removes only the ingestion and audits and rejects supplied expense/payment IDs.

- [ ] **Step 4: Run the new test to verify RED**

Run:

```powershell
node --test backend/tests/icost-acceptance-cleanup.test.js
```

Expected: FAIL because `backend/scripts/icost-acceptance-cleanup.mjs` does not exist yet.

### Task 2: Implement exact transactional cleanup

**Files:**
- Create: `backend/scripts/icost-acceptance-cleanup.mjs`
- Test: `backend/tests/icost-acceptance-cleanup.test.js`

- [ ] **Step 1: Normalize the manifest before opening SQLite**

Require exactly `owner`, `source_id`, `ingestion_id`, `database_identity`, and optional paired `expense_id`/`payment_id`. Reject unknown keys, control characters, non-acceptance source IDs, non-file databases, and invalid database identity formats.

- [ ] **Step 2: Verify the database identity with the existing helper**

Use `readProductionDatabaseIdentity()` from `production-smoke-cleanup.mjs`, compare identities with `timingSafeEqual`, and never include the secret, manifest values, database path, or identity value in the report.

- [ ] **Step 3: Validate ownership and relationships inside `BEGIN IMMEDIATE`**

Select the ingestion by exact ID; require `owner`, `source = 'icost'`, `source_id`, and `actor = 'icost-webhook'`. Require the source ID to identify exactly one iCost ingestion across owners. For accepted rows, require the exact manifested expense/payment pair, an expense owned and created by the integration owner/actor, and a payment belonging to that expense. For review rows, require both links and both optional manifest IDs to be absent.

- [ ] **Step 4: Reject every unrelated dependent**

Inspect foreign keys that reference the manifested expense/payment. Allow only the manifested payment and ingestion references; reject additional payments, ingestions, attachments, invoice matches, no-invoice confirmations, match candidates, inbox matches, or any future foreign-key dependent before deletion. Require exactly the expected ingestion audit actions with matching actor, request ID, entity type, and entity ID.

- [ ] **Step 5: Delete exact rows and verify integrity**

Delete exact audit primary keys, the ingestion primary key, then the optional payment and expense primary keys. Assert zero residual rows for those primary keys. Run `PRAGMA foreign_key_check` and `PRAGMA quick_check` before commit and return only status, deletion counts, verification booleans, and integrity counts.

- [ ] **Step 6: Add the manifest-file CLI**

When invoked directly, require one `--manifest=<path>` argument, read `DATABASE_URL` and `AUTH_SESSION_SECRET` only from the process environment, parse the JSON manifest, call the exported function, and print only the sanitized report. Reject extra CLI arguments.

- [ ] **Step 7: Run the new test to verify GREEN**

Run:

```powershell
node --test backend/tests/icost-acceptance-cleanup.test.js
```

Expected: all tests pass with zero failures.

### Task 3: Document the server-local workflow

**Files:**
- Modify: `integrations/icost-shortcut/README.md`

- [ ] **Step 1: Add a placeholder manifest example**

Document an example JSON containing only placeholder owner, acceptance source ID, ingestion ID, optional financial IDs, and database identity. State that accepted responses require both financial IDs and review-required responses omit both.

- [ ] **Step 2: Add an environment-backed command example**

Document this shape without real values:

```powershell
node --env-file=<private-backend-env-path> backend/scripts/icost-acceptance-cleanup.mjs `
  --manifest=<server-local-acceptance-manifest.json>
```

State that cleanup is server-local, requires an offline backup first, never accepts text/date/amount matching, and does not expose a deletion HTTP endpoint.

### Task 4: Verify the isolated change

**Files:**
- Test: `backend/tests/icost-acceptance-cleanup.test.js`
- Test: `backend/tests/production-smoke-cleanup.test.js`
- Test: `backend/tests/travel-expense-ingestion-repository.test.js`

- [ ] **Step 1: Run targeted and safety regression tests**

Run:

```powershell
node --test backend/tests/icost-acceptance-cleanup.test.js backend/tests/production-smoke-cleanup.test.js backend/tests/travel-expense-ingestion-repository.test.js
```

Expected: zero failed tests.

- [ ] **Step 2: Check formatting and scope**

Run:

```powershell
git diff --check -- backend/scripts/icost-acceptance-cleanup.mjs backend/tests/icost-acceptance-cleanup.test.js integrations/icost-shortcut/README.md docs/superpowers/plans/2026-08-05-icost-acceptance-cleanup.md
git status --short
```

Expected: no whitespace errors, and no frontend, release-manifest, or production-preflight file was changed by this task.
