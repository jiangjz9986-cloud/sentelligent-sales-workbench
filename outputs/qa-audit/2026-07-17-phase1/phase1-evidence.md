# Phase 1 Security And Recovery Evidence

- Evidence date: 2026-07-17 (Asia/Shanghai)
- Branch: `codex/phase-1-security-data`
- Base revision: `f6f5dec62e77`
- Windows Node: `v24.14.1`
- WSL Node: `v24.14.1`
- Production deployment: not performed

## Authentication And Browser Evidence

Command: `npm --prefix outputs/product-design-prototype run qa:integration`

Result: PASS across desktop, tablet, narrow window, iPhone, and Android-small viewports.

- Login created an HttpOnly session Cookie with `Max-Age=604800`.
- No login, session, CSRF, or token value was persisted in localStorage or sessionStorage.
- A full reload restored the protected application through `GET /api/auth/session`: HTTP 200.
- Browser business writes carried `X-CSRF-Token` and no `Authorization` header.
- Weekly Word export completed through authenticated fetch; its URL contained no query token.
- Logout called `POST /api/auth/logout`: HTTP 204.
- Reusing the pre-logout Cookie returned HTTP 401.
- Reloading protected UI after logout called `GET /api/auth/session`: HTTP 401 and displayed login.
- Existing 409 conflict recovery remained valid and retained the local unsaved customer draft.
- Every viewport reported zero horizontal page overflow.
- Isolated browser profile count before/after the final run: 201 / 201 (`delta=0`).

The integration backend used `NODE_ENV=test`, exact `CORS_ALLOWED_ORIGINS`, `AUTH_COOKIE_SECURE=false`, and an in-memory generated scrypt test hash. No plaintext authentication environment variable was passed to WSL.

## Runtime Isolation Evidence

- Every direct structured WSL command uses `wsl.exe --exec`; the bounded ownership-check script uses non-login `bash -c` so user logout hooks cannot alter its exit status.
- Local Windows process shutdown requires executable and command-line fingerprint agreement before PID termination.
- WSL listener shutdown requires all of: expected backend working directory, `node src/server.js`, and the exact temporary `DATABASE_URL` environment fingerprint.
- Broad Node termination, whole-stack shutdown, and unrelated service restart/stop patterns are rejected by `scripts/release-boundary.test.mjs`.
- Old runtime records without a fingerprint are treated as unverified and are never terminated by PID alone.
- Browser profile removal waits for file release and fails QA instead of hiding cleanup errors.

## Database Backup

- Source database: `/home/hermes/.sentelligent-sales-workbench-phase1-20260717/data/sales-workbench.sqlite`
- Backup: `/home/hermes/.sentelligent-sales-workbench-phase1-20260717/backups/2026-07-16T18-31-30-976Z-phase1-complete.sqlite`
- Size: 245760 bytes
- SHA-256: `248c5363170213a908bd1db0c0cc571d489fd66e04bf2be9055c8e08b50ec523`
- Backup is outside the Git worktree and was not committed.

The first source inspection correctly returned `DATABASE_BUSY` because the completed seed process left WAL/SHM sidecars. `lsof` showed no holder. The dedicated evidence database was checkpointed and switched to DELETE journal mode, then rechecked successfully. No production or default runtime database was touched.

Final source and backup checks:

- `status`: `ready`
- `PRAGMA quick_check`: `ok`
- `PRAGMA foreign_key_check`: 0 violations
- Missing required tables: 0
- `foreign_keys`: 1
- `journal_mode`: `delete`
- `busy_timeout`: 5000 ms

## Twelve Business Table Counts

| Table | Source | Backup | Restored |
| --- | ---: | ---: | ---: |
| customers | 2 | 2 | 2 |
| opportunities | 2 | 2 | 2 |
| quick_records | 0 | 0 | 0 |
| ai_insights | 0 | 0 | 0 |
| manual_confirmations | 0 | 0 | 0 |
| weekly_reports | 0 | 0 | 0 |
| solution_drafts | 0 | 0 | 0 |
| ai_suggestions | 0 | 0 | 0 |
| action_items | 2 | 2 | 2 |
| risk_items | 3 | 3 | 3 |
| knowledge_items | 4 | 4 | 4 |
| audit_logs | 0 | 0 | 0 |

## Migration Checksums

| Version | SHA-256 checksum |
| --- | --- |
| 0001 | `82e61d6bb338cf03fd7d8b7eb096ae058721bd80b59314f8a01b8cf558307a81` |
| 0002 | `700ca2a5feec8567a8d85bcb76d195388a53790b0e30f38f0ba3be2c3be0c4f6` |
| 0003 | `ec7df596f7fa76966e3ff17e53e0a207266ed68da516dee52f22300f99f6563a` |

The restored database reported the same ordered versions and checksums.

## Restore Test

- Restore target: `/home/hermes/.sentelligent-sales-workbench-phase1-20260717/restore/restore-test.sqlite`
- Restore result: `restored`
- Post-restore status: `ready`
- Post-restore `quick_check`: `ok`
- Post-restore foreign-key violations: 0
- Post-restore table counts: identical for all 12 business tables
- Post-restore migration versions/checksums: identical
- Restore sidecars: none

## Automated Gates

| Gate | Result |
| --- | --- |
| `npm run test:deploy` | PASS, 25/25; 127 project files scanned, zero secret findings |
| `npm --prefix backend test` | PASS, 209/209 |
| `npm --prefix outputs/product-design-prototype run qa:local` | PASS; build succeeded; API 37/37; 126 frontend files scanned |
| `npm --prefix outputs/product-design-prototype run qa:integration` | PASS; full business and auth flow on 5 viewports |
| WSL SQLite/concurrency/audit matrix | PASS, 51/51 |
| `git diff --check` | PASS |

## Cleanup Evidence

- Project-matching Windows Chrome, Node, cmd, and WSL processes: 0.
- WSL Node listeners after integration: 0.
- `/tmp/sent-zx-integration-*.sqlite`, WAL, and SHM files: 0.
- `.runtime/local-dev.json`: absent.
- Browser profiles created by the final QA run: 0 retained.
