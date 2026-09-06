# v0.12.0 Upgrade Freeze

## Freeze Record

- Release: `v0.12.0`
- Baseline commit: `3370b9451f390cfcfa56bf8c4eb9b2df31c43a68`
- Contract date/version: `2026-09-06`
- Shared contract release constant: `SALES_WORKBENCH_API_CONTRACT_RELEASE = "v0.12.0"`
- Migration range: `0042` through `0045`
- Runtime boundary: local SQLite and loopback HTTP only during this upgrade
- Prohibited: iCloud reads, production database access, production services,
  production notifications, and production migration execution

This document is the implementation freeze for the v0.12.0 work. Feature
threads may add implementation details inside their ownership boundary, but
they must not change the identities, request/response shapes, state machines,
or migration semantics below without a main-control review.

## Shared API Contract

The source of truth is `../../shared/salesWorkbenchApiContract.mjs`.

Existing `SALES_WORKBENCH_API_CONTRACT_VERSION` remains `2026-09-06` for
backward compatibility. The additive release marker is
`SALES_WORKBENCH_API_CONTRACT_RELEASE = "v0.12.0"`.

### Customer proactive subjects

`proactiveAssistant` may expose `subjectTypes` and
`customerSubjectCount`. A customer subject is represented by
`proactiveAssistantSubject`:

- `identity`: `customer:<owner>:<customerId>`
- `owner`: server-resolved business owner
- `subjectType`: `customer`
- `subjectId`: customer id
- `customerId`: same customer id
- `version`: monotonically increasing subject revision
- `sourceDigest`: SHA-256 of the canonical source reference set
- `sourceRefs`: bounded, non-sensitive source references
- `suggestionCount`: number of current suggestions for the subject
- `updatedAt`: UTC timestamp

Customer proactive scanning aggregates all eligible opportunities, actions,
risks, interactions, itineraries, and matched tender notices belonging to the
same owner/customer. A customer-level signal is one suggestion subject, even
when several opportunities contribute evidence. Opportunity-level signals
remain supported for existing behavior; they must not be duplicated as
customer cards for the same trigger and evidence set.

The customer subject revision advances only when canonical source references
or their provenance change. Scan timestamps, cache hits, and model telemetry
do not change the source digest. Customer subjects are always owner-scoped by
the server; a request body or query parameter cannot select another owner.

### Action and risk writeback

The additive action/risk fields preserve the exact human-reviewed draft and
its provenance:

- action: `expectedResult`, `sourceType`, `sourceId`, `sourceProactiveId`,
  `writebackDigest`
- risk: `expectedResult`, `sourceProactiveId`, `writebackDigest`

The confirmation boundary must write the complete reviewed values for
assignee, due date, priority/severity/score where applicable, expected result,
source identity, proactive suggestion id, and writeback digest. Defaults are
allowed only when the preview did not contain an editable value; they must not
overwrite a value explicitly reviewed by the user. `writebackDigest` is the
SHA-256 digest of the canonical writeback payload and is used for idempotent
replay/audit verification.

### Hospital tender canonical bridge

`hospitalTenderNotice` may expose:

- `canonicalNoticeId`
- `canonicalRevision`
- `canonicalDigest`
- `bridgeStatus`
- `bridgeRefs`

The canonical identity is stable across source duplicates and source updates.
The canonical digest is a SHA-256 digest of the normalized persisted notice
snapshot. If a legacy row has no `content_sha256`, the bridge computes a
digest from normalized content and metadata before creating or confirming a
bridge. `canonicalRevision` starts at `1` and increases only when the
canonical digest changes.

`hospitalTenderBridge` is unique on `(owner, canonicalNoticeId, customerId)`.
Its status is one of `unconverted`, `previewed`, `confirmed`, `cancelled`, or
`conflict`. Preview and confirm must compare both revision and digest. A stale
notice, changed match evidence, changed customer, or changed opportunity
invalidates the preview with a conflict response. A confirmed bridge may be
replayed only when its owner, canonical identity, customer, revision, digest,
and audit receipt all match.

### Customer file import

The customer import API is an explicit preview/confirm workflow. The exact
HTTP route family is:

- `POST /api/customer-imports/preview`
- `GET /api/customer-imports/:batchId`
- `POST /api/customer-imports/:batchId/confirm`
- `POST /api/customer-imports/:batchId/cancel`

The request uses `multipart/form-data` with one file field named `file` and an
optional JSON `mapping` field. Supported formats are UTF-8/BOM CSV (including
CRLF, quoted fields, and embedded newlines) and XLSX. The server derives
owner from the authenticated session. `owner` in a body, form field, or file
content is never authoritative and is rejected or ignored according to the
request validator.

The preview response contains a `customerImportBatch` plus ordered
`customerImportRow` records. The parser is bounded by the implementation
limits documented in the import module; it must reject oversized files,
excessive rows, excessive field lengths, malformed CSV/XLSX, and unsupported
media types before persistence. The original file bytes are never stored.

Each row is normalized to the customer write shape, retains a row digest, and
has one action: `create`, `merge`, `skip`, or `reject`. Required-name errors,
same-owner canonical-name/alias duplicates, and invalid field values are
visible in `errors`. The preview is deterministic for the same owner, file
digest, mapping, and current customer snapshot.

Confirmation requires the exact batch id, file digest, preview digest, and an
explicit `confirmed: true`. It is idempotent by `(owner, idempotency key)` and
commits all selected rows in one SQLite immediate transaction. A failed row or
conflict cannot leave a partial customer batch. A committed batch is replayed
only with the same digest and confirmed plan; a changed customer snapshot or
mapping requires a new preview. Batch and row audit records are retained.

## Migration Freeze

Migration files are forward-only and checksum-protected by the existing
`schema_migrations` ledger.

### `0042_customer_proactive_subjects.mjs`

- Adds `proactive_subjects` with owner, customer subject identity, revision,
  source digest, bounded source references, and timestamps.
- Adds nullable `proactive_subject_key`, `proactive_subject_version`,
  `proactive_source_digest`, and `proactive_source_refs` to `ai_suggestions`.
- Adds owner/customer and suggestion lookup indexes.
- Does not change or delete existing suggestion content.

### `0043_hospital_tender_canonical_bridge.mjs`

- Adds canonical identity/revision/digest, bridge status, and bridge refs to
  `hospital_tender_notices`.
- Backfills canonical identity from `identity_key`, revision `1`, and the
  existing content digest when present.
- Creates `hospital_tender_bridges` with an owner/canonical-notice/customer
  uniqueness constraint and revision/digest snapshot.
- Legacy null content digests are repaired by bridge code before a bridge row
  is written; the migration itself does not invent source content.

### `0044_action_risk_writeback_fields.mjs`

- Adds the additive action/risk provenance and expected-result columns.
- Backfills legacy action `source_record_id` to
  `source_type = "quick_record"` and `source_id = source_record_id`.
- Leaves existing business values, versions, and lifecycle states intact.

### `0045_customer_import_batches.mjs`

- Creates `customer_import_batches` for bounded file metadata, preview state,
  digests, counts, timestamps, and idempotency.
- Creates `customer_import_rows` for normalized row data, row actions,
  validation errors, row digests, and committed references.
- Deliberately does not create a raw-file/blob column.

All four migrations must apply on an empty database and upgrade a complete
`0041` database. Reopening the same database must be idempotent, and a
checksum mismatch must fail closed without changing schema or data.

## File Ownership Freeze

| Area | Main control | Feature owner | Boundary rule |
| --- | --- | --- | --- |
| Shared contract | `shared/salesWorkbenchApiContract.mjs` | Main control only | Feature threads propose fields; only main control edits and validates the contract. |
| Migration registry | `backend/src/db/migrate.js` | Main control only | Feature threads provide migration files; registry changes are integrated centrally. |
| `0042` migration | Review/integration | Customer proactive assistant | Migration file is frozen after schema review. |
| `0043` migration | Review/integration | Hospital tender bridge | Migration file is frozen after schema review. |
| `0044` migration | Review/integration | Action/risk writeback | Migration file is frozen after schema review. |
| `0045` migration | Review/integration | Customer import | Migration file is frozen after schema review. |
| Proactive assistant | Integration | `backend/src/assistant/**` and focused tests | No direct edits to `server.js`, shared contract, or frontend API client. |
| Hospital tender bridge | Integration | `backend/src/hospitalTender/**` and focused tests | No direct edits to `server.js`, shared contract, or frontend API client. |
| Action/risk writeback | Integration | New action/risk helper modules and focused tests | No direct edits to `server.js`, shared contract, or frontend API client. |
| Customer import parser/service | Integration | `backend/src/customerImport/**` and focused tests | No direct edits to `server.js`, shared contract, or frontend API client. |
| Backend HTTP wiring | Main control | `backend/src/server.js` | Central route registration, owner/auth wiring, and response mapping. |
| Frontend API client | Main control | `outputs/product-design-prototype/src/api/salesWorkbenchApi.js` | Central request allowlists and contract assertions. |
| Frontend shell/state | Main control | `src/App.jsx`, app state, package scripts | Feature UI exposes callbacks; shell integration is centralized. |
| Feature UI | Feature owner with review | Feature-specific `src/features/**` | Preserve nine-module information architecture and existing visual system. |
| Cross-feature QA | Main control | `scripts/**`, integration/browser tests | Final owner of full tests, local servers, and browser evidence. |

Any necessary boundary exception must be documented in the change and
reviewed by main control before merge. No feature thread may touch iCloud
paths, production configuration, or production services.

## Verification Gate

Before declaring v0.12.0 complete, main control must run the full local gate:

```text
npm run test:deploy
npm --prefix backend test
npm --prefix outputs/product-design-prototype run qa:local
npm --prefix outputs/product-design-prototype run qa:integration
npm --prefix outputs/product-design-prototype run qa:webkit
git diff --check
npm audit --omit=dev --json
```

Browser evidence uses only local loopback services and temporary SQLite at
viewports `1920x1080`, `1440x900`, `1366x768`, `1024x768`, `390x844`, and
`360x800`. Evidence must identify the final source commit and must not contain
real customer data, production URLs, production database paths, or outbound
notification attempts.
