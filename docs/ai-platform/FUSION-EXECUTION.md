# Production Fusion Execution

## Ownership And Baseline

- Execution owner: main task `01a07521-3776-7b00-bcb7-559545c7c4a3`.
- Worktree: `.worktrees/ai-platform-production-integration-20260909`.
- Integration baseline: `4cfdcdb9d3f499056c45a7c83434d3fa7b96d3cd`.
- Production baseline verified on 2026-09-10 at 00:57 Asia/Shanghai:
  `3209a073486e22370307a6f46021ac9cf2ec71d1` / v0.12.3.
- The previous AI task has stopped. Its uncommitted drain timeout configuration
  is retained. The main task owns all integration files and serializes shared
  configuration, server, contract, migration and release edits.
- The user authorized complete development and controlled production delivery.
  Previous local-only authorization notes are historical and do not revoke
  this authorization. Existing technical release gates remain mandatory.

## Frozen Boundaries

- Backend owns business records, identity, confirmation, version checks,
  proactive scheduling and notification outbox. Platform owns AI execution,
  attempts, budgets, usage and Agent configuration.
- Preserve production v0.12.2 notification expiry/session recovery and v0.12.3
  quick-record thinking behavior. Do not rewrite immutable release tags.
- The development model setting does not select a business provider. Production
  model policies must name the actual configured supplier/model and price;
  logical target metadata never establishes live provider readiness.
- Keep the task/result schemas compatible. Additive operational interfaces use
  explicit scopes and request authentication, without exposing internal secrets.
- Business migrations 0042-0045 and platform migrations 0001-0002 stay immutable.
  Platform migration 0003 is reserved for operational pause/generation and its
  audit ledger. The live production has no platform database/service installed;
  business migration numbers are not consumed by this change.
- Platform migration 0004 reserves a hashed request-nonce ledger. Production
  service credentials bind method, full path/query, exact body bytes and
  idempotency key; one nonce is consumed once even across process restarts.
- Platform migration 0005 reserves owner-scoped encrypted temporary media
  metadata, task binding, expiry and deletion tombstones. Raw bytes are kept
  outside the task database and release, encrypted with a separate media key.
- Platform migration 0006 reserves immutable price calendars and deployment
  policy publication evidence. Preview is zero-write; publication requires a
  paused, empty queue and a fresh generation/digest, and advances that generation.
- Platform migration 0007 reserves encrypted provider credentials and revision
  audit. A cleared row overrides environment credentials across restarts.
- Platform shutdown stops admission and claiming before waiting for attempts
  and usage settlement. A drain timeout must not close a database still in use,
  clear an unknown charge or allow a second worker to start.
- Production diagnosis uses read-only connections. Failed customer events must
  be traced before a corrective production mutation; no bulk clearing/requeue.
- No iCloud access. SSH uses the supplied Desktop key. iPhone acceptance is
  excluded; Mac Google Chrome functional acceptance remains required.
- Shared Caddy and Qingyang stay protected. PushPlus remains retired.

## Current Evidence Override (2026-09-11)

The ordered implementation notes below retain their historical checkpoint
language. The following is the current production evidence and takes
precedence when describing deployment state:

- The production `current` release is
  `/opt/sentelligent-sales-workbench/releases/sentelligent-sales-workbench-d38a89144b66`,
  bound to source commit `d38a89144b660e6ace213c9d32787e3870006667`.
- Backend, frontend, WeChat agent, AI Platform and shared Caddy services are
  active. HTTPS, application health, database `quick_check` and foreign-key
  checks passed. The current branch contains later documentation-only commits
  and has not been redeployed.
- The released configuration keeps AI Platform `disabled` with
  `local-simulated` execution, keeps Backend as the sole proactive scheduler,
  and keeps proactive assistant/notification auto-run disabled. This is a
  controlled integration release, not proof of live supplier routing or live
  proactive notification delivery.
- The production environment retains the fixed `60`-minute/`10`-customer
  tender baseline, while the durable scheduler row currently records an
  enabled `120`-minute/`10`-customer runtime. The scheduler implementation
  treats an existing persisted row as authoritative over initialization
  defaults; this was verified read-only and was not changed during the
  integration.
- Mac Google Chrome production acceptance is recorded as 32/32 checks passed,
  32 screenshots, 7 write requests, zero failed requests and zero console
  errors. The formal report is in
  `/Users/jiangjizhen/Documents/森特智行/.runtime/production-browser-evidence/2026-09-11T09-03-16-819Z/report.json`.
- Historical production smoke rows were removed by the protected server-local
  cleanup path; residual smoke rows are zero and database integrity remains
  clean.
- The remaining blockers are the absence of a Clawbot context renewal/rebind
  protocol for indefinite proactive delivery, and separate Linux/x64 plus
  real-supplier quality/cost evidence. None of these may be inferred from a
  health response or local simulated tests.

## Ordered Work

1. Drain/settlement lifecycle and complete adapter-test coverage.
2. Real provider/media transport, immutable model/price policies and budgets.
3. Production identity/admin proxy, admission controls and explicit staged routing.
4. Proactive stale-event handling, business worker drain and result idempotency.
5. Independent systemd service, dual database snapshots and controlled transition.
6. Full local/CI/browser/provider validation and immutable release.
7. Fresh production gates, controlled cutover, observation and rollback evidence.

The full operational plan is
`/Users/jiangjizhen/Documents/Codex/outputs/ai-platform-v2-production-fusion-20260909/PLAN.md`.
Items above describe the implementation contract, not completed acceptance.

## Operational API Contract

- `GET /internal/ai/v1/operations` requires `ai:ops:read`.
- `POST /internal/ai/v1/operations/drain` and `/resume` require
  `ai:ops:write`, with JSON `{expectedGeneration: <integer>}`.
- Drain persists the pause, blocks new acceptance/claims and waits for local
  execution. Any other running database attempt prevents successful drain.
- Resume rejects stale generations and unfinished attempts. Pause state and
  operational audit survive a restart; HTTP readiness is false while paused.
- Production request binding cannot be disabled. Backend mints a new short-lived
  signed credential for each request; retries retain the business idempotency
  key while using a new request nonce.
- Production admission starts closed unless explicitly configured or resumed
  by an authenticated operator. Health is distinct from task readiness.
- Unknown paid failures/expired leases are terminal and retain budget until
  reconciliation, without automatic supplier retry. Recovery uses the original
  price currency. Reservations cover full output and media limits.

The production transition tool, real suppliers/media, management proxy, staged
routing and business-event remediation are still outstanding.

## Integration Progress

- Registered text providers now load from approved runtime policies and
  credential environment references. The default service uses the registry,
  not only a test injection. Vendor requests pin actual models, output limits
  and supported reasoning options; usage distinguishes cached input and retains
  request identity on malformed completion. Local HTTP supplier tests pass;
  no real supplier has been called by this implementation stage.
- Business-admin session proxy and console use `/api/ai-platform/admin/*`
  and `/api/ai-platform/console/`. Internal request signatures are generated
  by Backend; member sessions, missing CSRF and logged-out sessions are rejected.
  The security settings page links to the authenticated console.
- Production read-only diagnosis at 2026-09-10 01:28 Asia/Shanghai found all
  40 failing customer references missing (none active/deleted/cross-owner).
  Their origin is not established as test data. Background processing now
  independently rechecks owner-scoped availability and completes unavailable
  references with `PROACTIVE_SUBJECT_UNAVAILABLE`, preserving event records.
  Active-customer service failures stay retryable. Production rows have not
  been modified by this work.
- All six Backend background schedulers expose drain, and Backend closes its
  database after HTTP, ASR and background work settle. Direct service startup
  now handles SIGTERM/SIGINT through this shutdown path.
- Real media transport, provider/price publication, staged routing, transition
  tooling and final acceptance remain outstanding.

## Validation At This Checkpoint

- `npm --prefix backend test`: 2067 passed, 0 failed, 240 suites.
- `npm run test:ai-platform`: platform 73 passed and adapters 34 passed;
  the subsequently added long-wait runtime case passed separately.
- Background scheduler and dual-service regression: 104 passed.
- Admin proxy, execution drain and ASR shutdown integration: 17 passed.
- Security settings source regressions: 7 passed; frontend production build passed.
- Full backend output is in ignored `.runtime/fusion-backend-20260910-r2.log`.
  These are local tests, not production acceptance or real supplier quality.

## Media And Pricing Progress

- Signed binary uploads, encrypted temporary blobs, owner/task binding, expiry,
  terminal cleanup and replay-safe media references are implemented.
- Vision and ASR use real provider HTTP protocols; local HTTP fixtures verify
  image content, WAV multipart content, cross-owner rejection, usage and cleanup.
- Existing financial prompts and the bounded PDF renderer are shared by both
  Backend and Platform. PDF cancellation waits for the child to exit before
  workspace removal. Failed/expired objects retain metadata tombstones.
- Existing supplier/model/CNY pricing was checked read-only; see
  [PROVIDER-BASELINE-20260910.md](PROVIDER-BASELINE-20260910.md).
- No real completion was made during these checks. Live quality, cost
  reconciliation, routing/transition tools and final production acceptance
  remain pending.

## Media Checkpoint Evidence

- `npm run test:ai-platform`: 78 platform tests and 35 Backend adapter tests passed.
- Targeted ASR/vision/PDF Backend regression: 163 passed; broader media/ASR
  integration before the pricing additions: 235 passed.
- All suppliers in these test runs were local HTTP fixtures. Separate read-only
  production model/balance calls confirmed existing DeepSeek text/vision access
  and CNY availability, without invoking completions.
- New platform migrations 0005/0006 have not run in production.
- Remaining delivery work: policy-based routing and admission, independent
  systemd/transition tools and associated release contracts, provider quality
  smoke, load/backup/restore/browser/full QA, formal release, fresh production
  preflight/cutover/postflight, observation and rollback evidence.

## Routing Contract

- `AI_PLATFORM_ROUTING_POLICY` is a versioned JSON object with
  `version, phase, owners, taskTypes`.
- `legacy` requires `AI_PLATFORM_MODE=disabled`; `platform` and
  `canary` use required mode in production. Legacy/platform phases require
  empty selector arrays; canary requires explicit nonempty owner/task lists.
- Canary routes selected text, vision and bookkeeping calls exclusively through
  Platform; excluded calls use the existing provider explicitly. Platform
  errors never trigger an implicit legacy retry.
- ASR is not an owner-canary task: it retains its independent existing provider
  during canary and switches only in the full platform phase after ASR gates.
- Public health exposes only phase and policy digest, not owner selectors.
- Backend health now probes the real platform with a bounded cached request;
  mere credential configuration is not reported as platform readiness.
- Backend proactive model execution is classified as `proactive.analyze` with
  background priority, rather than merging its costs into interactive sales
  decisions. Scheduling ownership remains Backend.

## Remaining Production-Critical Checks

- Complete credential rotation/clear behavior across the legacy settings page
  and platform provider references. Full platform routing must not keep using
  a cleared credential or silently revive it on rollback.
- Complete cross-entry canary tests for vision/bookkeeping/ASR and ensure legacy
  ASR HTTP readiness uses the same routing decision as the ASR runtime.
- Build and test the independent systemd unit, transition manifest/tool,
  immutable release checks, environment migration/backup and rollback.
- Handle existing unavailable-customer events through the audited worker logic
  during the controlled window; none have been changed in production yet.
- Finish resource/media crash-cleanup tests, final shared QA, Mac Chrome
  acceptance, live provider quality/cost probes, CI/release and production gates.

## Credential Handoff

- The existing settings API now uses the platform vault when external platform
  routing is active, then mirrors the successful change into the existing
  encrypted Backend store. DeepSeek text/vision policies share one credential
  reference. Live ASR uses its separate `provider-asr` reference in full routing.
- The platform is changed first, so clear takes effect before a legacy mirror.
  A Backend database failure after platform acknowledgement is a partial
  synchronization failure, not permission to revive the old value.
- Rollback must compare credential revisions and reconcile the latest vault
  state into the legacy encrypted store, or remain blocked. It must not restore
  stale credential backups over a clear/rotation performed during the window.
- Current production ASR remains disabled/unconfigured; no live ASR credential
  has been invented or enabled by this work.

## Routing And Credential Checkpoint

- Platform 79/79 and Backend adapter 38/38 tests passed.
- Backend full regression passed 2067/2067 on the routing/credential wiring.
- The subsequently added proactive-event reconciliation regression passed
  separately. Preview is zero-write; execution requires an unchanged digest,
  preserves all event rows and retry counts, and adds an audit entry.
- No production mutation, service restart, completion or notification has been
  performed during these implementation checkpoints.
- Current work is still not a release candidate: transition tooling, credential
  reconciliation on rollback, full shared QA/browser/load/restore evidence and
  the production cutover/observation remain unfinished.

## Systemd Verification

- A temporary rendered unit referencing the existing immutable CLI path was
  uploaded to `/tmp/sentelligent-ai-platform-verification.service`.
- On the actual CentOS 7/systemd 219 host, `systemd-analyze verify` exited 0.
  No service was installed or started by this verification.
- Production unit uses Type=simple, direct Node, sentai, control-group shutdown,
  ReadWriteDirectories, 210-second stop timeout, 768M memory ceiling and one CPU.
  These are initial limits pending the required measured load gate.
- Development forked-process start/stop/restore scripts now reject production
  platform database paths; production uses the independent transition tool.
