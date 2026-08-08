# Production Preflight Final Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use systematic-debugging, test-driven-development, and verification-before-completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the final production-release trust gaps so v0.4.0 can prove it will execute only the reviewed release, environment, database, tools, and three allowed project services.

**Architecture:** Freeze the complete release after dependency installation, bind evidence to one host and one opened file identity, validate complete systemd units rather than selected properties, and treat all Git checkout customization and executable tools as untrusted inputs. Keep Caddy, Qingyang, account-vault, Mihomo, and port 8797 strictly outside the mutation boundary.

**Tech Stack:** Node.js, Git, systemd, SQLite, SHA-256 manifests, POSIX shell, Tesseract, Poppler.

---

### Task 1: Define a manifest-covered production dependency tree

**Files:**
- Modify: `scripts/release-package.mjs`
- Modify: `scripts/release-package.test.mjs`
- Modify: `scripts/production-preflight.mjs`
- Modify: `scripts/production-preflight.test.mjs`
- Modify: `docs/发布与回滚操作手册.md`

- [ ] Package or hash the installed production dependency tree and include it in the release manifest.
- [ ] Make post-deploy preflight accept only that exact tree; arbitrary `backend/node_modules/**` additions or changes must fail.

### Task 2: Freeze and verify immutable release ownership and modes

**Files:**
- Modify: `scripts/production-cutover.sh`
- Modify: `scripts/production-cutover.test.mjs`
- Modify: `scripts/production-preflight.mjs`
- Modify: `scripts/production-preflight.test.mjs`

- [ ] After dependency installation, recursively set release directories/files to root ownership and remove write access for runtime users.
- [ ] Verify realpath ancestors, uid/gid, mode, regular-file type, and `nlink === 1` before service restart.

### Task 3: Validate complete systemd execution surfaces

**Files:**
- Modify: `scripts/production-preflight.mjs`
- Modify: `scripts/production-preflight.test.mjs`
- Modify: `scripts/production-cutover.sh`

- [ ] Capture and reject unexpected `ExecStartPre`, `ExecStartPost`, `ExecStop`, `ExecReload`, drop-ins, `Environment`, `EnvironmentFile`, and path/sandbox directives.
- [ ] Prefer version-controlled exact unit templates and manifest hashes over copying mutable installed units.

### Task 4: Bind the protection plan to this host and exact unrelated services

- [ ] Verify hostname/machine-id against an explicit expected value.
- [ ] Require exact service names `codex-account-vault-cloud.service`, `qingyang-store.service`, and `codex-vault-mihomo.service` with unit hashes, state, PID/start timestamp, and listener ownership evidence.

### Task 5: Validate the actual production environment contract from one read

- [ ] Open/read the env once, parse and hash the same bytes, and verify every manifest-required variable is present.
- [ ] Reject frontend/Caddy consumption of the private business env file.

### Task 6: Bind env, database, and backups to stable file identities

- [ ] Use one buffer or fixed descriptor per validation, compare pre/post `fstat`, and reject symlinks/hardlinks.
- [ ] Resolve and check SQLite sidecars beside the real database target, not the lexical path.

### Task 7: Verify actual OCR/PDF and service Node executables

- [ ] Pin approved package/binary identities and hashes; do not trust self-reported version strings alone.
- [ ] Execute the exact Node binary from every service `ExecStart` and verify its version and hash.

### Task 8: Eliminate Git checkout command-execution inputs

- [ ] Add a RED test proving a configured smudge filter can execute during `git worktree add`.
- [ ] Replace checkout materialization with a no-hook/no-filter blob materializer, or explicitly reject every active filter/submodule/external checkout driver before worktree creation.
- [ ] Re-run the ignored-file, hook, line-ending, filter, blob-byte, and worktree-cleanup adversarial tests.

### Task 9: Full release rehearsal

- [ ] Run fresh release, preflight, cutover, rollback, secret-scan, backend, frontend, Chromium, and WebKit suites.
- [ ] Create an archive twice from the same commit/timestamp and assert identical SHA-256.
- [ ] Run pre-deploy and post-deploy preflight against an isolated production-shaped directory before touching the live server.
