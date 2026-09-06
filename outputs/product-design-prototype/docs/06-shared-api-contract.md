# Shared API Contract

## Purpose

The frontend prototype and WSL backend now share a runtime-verifiable API field contract. This prevents feature sessions from silently changing backend response fields that the frontend depends on.

## Contract File

- Shared contract: `../../shared/salesWorkbenchApiContract.mjs`
- Contract version: `2026-09-06`
- Contract release: `v0.12.0`
- Owner: main control thread

## Covered Entities

- `customer`
- `opportunity`
- `actionItem`
- `riskItem`
- `knowledgeItem`
- `quickRecord`
- `aiInsight`
- `manualConfirmation`
- `weeklyReport`
- `solutionDraft`
- `proactiveAssistant`
- `proactiveAssistantSubject`
- `proactiveConfirmationPreview`
- `hospitalTenderNotice`
- `hospitalTenderBridge`
- `customerImportBatch`
- `customerImportRow`

`manualConfirmation.createdAt` is required because the quick-record UI renders a visible sync history after manual confirmation.
`actionItem.sourceRecordId` links generated next actions back to the confirmed quick record that created them.
`riskItem.sourceType` and `riskItem.sourceId` link generated risks back to the quick record, opportunity diagnosis, or later AI run that created them.
`riskItem.status` is a backend-controlled workflow state; current allowed values are `open`, `accepted`, `in_progress`, and `closed`.
`knowledgeItem.tags` and `knowledgeItem.content` are required by knowledge search and solution draft citation.
`solutionDraft.sourceRefs` is required so generated materials remain traceable to customer, opportunity, action, and knowledge records.

The v0.12.0 additive fields are frozen in `07-v0120-upgrade-freeze.md`.
Customer proactive subjects use the server-owned identity
`customer:<owner>:<customerId>` and a source digest/revision ledger. Hospital
tender bridge previews bind to canonical notice revision and digest. Action and
risk confirmations preserve the reviewed expected result, provenance, and
writeback digest. Customer CSV/XLSX import is preview/confirm/cancel based and
never persists original file bytes.

## Enforcement Points

Customer metadata is additive: `aliases` and `tags` are string arrays when
present; `createdAt` and `updatedAt` are strings or null when present. Legacy
projections may omit these four fields. Validation preserves omissions and
rejects malformed supplied types; it does not fabricate timestamps or expand
the frontend write allowlist. The current backend emits all four fields.
SQLite `CURRENT_TIMESTAMP` values are UTC. Customer presentation interprets
those values explicitly and displays instants in `Asia/Shanghai`.
`syncPreview` remains a synchronization summary, not import provenance.

- Frontend API runtime client validates backend responses in `src/api/salesWorkbenchApi.js`.
- Frontend API tests validate mocked responses in `src/api/salesWorkbenchApi.test.js`.
- Backend API tests validate real HTTP responses in `backend/tests/api.test.js`.
- Integration QA validates that the quick-record UI renders three visible sync-log entries after the three manual confirmations.
- Integration QA also validates that confirmed quick records write back to customer sync preview, opportunity source record, generated action items, generated risk items, and weekly draft source references.
- Integration QA validates risk status workflow by moving a risk through `in_progress` to `closed` from the browser UI.
- Integration QA validates explicit backend generation for weekly drafts and solution drafts from the UI.
- Integration QA validates knowledge creation/search through the UI and confirms solution drafts include matched knowledge citations.

## Required Verification

After changing any contracted field, run:

- Frontend: `npm run qa:local`
- Frontend integration: `npm run qa:integration`
- Backend on Windows: `npm test`
- Backend in WSL: `npm test`

## Change Rule

Feature threads must not change this contract independently. If a feature needs a new field or removes a field, main control should review the data model, frontend usage, backend mapping, and integration QA coverage in the same change set.
