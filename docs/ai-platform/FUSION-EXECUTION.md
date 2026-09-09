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
- Platform shutdown stops admission and claiming before waiting for attempts
  and usage settlement. A drain timeout must not close a database still in use,
  clear an unknown charge or allow a second worker to start.
- Production diagnosis uses read-only connections. Failed customer events must
  be traced before a corrective production mutation; no bulk clearing/requeue.
- No iCloud access. SSH uses the supplied Desktop key. iPhone acceptance is
  excluded; Mac Google Chrome functional acceptance remains required.
- Shared Caddy and Qingyang stay protected. PushPlus remains retired.

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
