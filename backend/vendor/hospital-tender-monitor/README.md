# Bundled hospital tender collector

This runtime is vendored from the local `hospital-it-tender-monitor` collector
at the reviewed snapshot used by the hospital tender integration. The backend
invokes it as a one-shot subprocess through
`backend/src/hospitalTender/internalRunner.js`.

The collector has no outbound notification client. The internal invocation
uses an explicit, minimal environment allowlist and writes a bounded,
credential-free snapshot to a private temporary file. It does not inherit
PushPlus credentials, sync URLs, bearer tokens, cookies, or model keys.
Python 3.11 or newer is required.

## Partial collection and resume

Adapters retain validated notices when a later category, hospital, or page
fails. The repository exports that source as `degraded` and the aggregate run
as `partial`. A partial run with usable source results exits successfully so
the backend can import those notices. Failed and degraded sources both count
toward `failed_source_count`; only fully completed sources count as successful.
The existing notice identity and revision checks make repeated pages idempotent.

`run-and-export` accepts `--resume-progress=/absolute/private/progress.json`
after the command or before it. The file contains a JSON array, not an object
wrapper. The same array is exported as optional snapshot-v1 `collectionProgress`:

```json
[
  {
    "sourceId": "example-source",
    "configurationDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "cursor": {"categoryIndex": 1, "hospitalIndex": 0, "page": 2}
  }
]
```

The array has at most 200 entries with unique source IDs of at most 200 UTF-16
code units and lowercase SHA-256 digests. Cursor fields are restricted to
`categoryIndex`, `hospitalIndex`, `page`, `pageIndex`, `branchIndex`, and
`itemIndex`; values must be integers from 0 through 1,000,000. Boolean and
floating-point values, additional fields, duplicate JSON keys, symlinks, and
non-private files are rejected. The input file limit is 256 KiB, sufficient
for the maximum legal array including Unicode source IDs.

Python computes the digest from the source's canonical JSON configuration.
Only an exact digest match restores the position; changed configuration and
out-of-range adapter positions restart at the beginning. Partial runs preserve
the failed or next uncollected position. Complete success exports `cursor: {}`
so the next invocation scans from the beginning. ASP.NET sources fetch fresh
form state when resuming; URLs, form state, credentials, and notice content are
never stored in cursors. The Python API uses
`MonitorRunner.run(collection_progress=[...])`.

Collector-only SQLite schema version 2 adds progress and partial-health fields
without changing existing notices or their IDs. Standalone invocations restore
their repository progress when no external array was supplied, and remove
progress for sources no longer configured. Backend invocations use their own
private scratch database and receive the saved array from Node.

All listing and budget-detail requests share one source budget, capped at
45 seconds. Before each source the collector allocates
`min(45, remaining_seconds / remaining_source_count)`, preserving public-source
priority while reserving time for every pending source. Unused time is
reclaimed for later sources. Positive fractional-second budgets remain valid
so a late source is not skipped merely because its share is below one second.
The collector stops starting source requests after 270 seconds, leaving room
under the backend's default 300-second subprocess limit to save and export
results. Many slow sources therefore get smaller individual budgets and may
need more partial runs; their existing page cursors provide recovery. Page
caps also produce partial progress rather than reporting a complete scan.

The offline tests include multi-category, multi-hospital and paginated
interruptions, repeated resume, configuration changes, repository upgrades,
budget exhaustion, repeated fair allocation across up to 200 slow sources,
and an actual Node-to-Python subprocess round trip. The fairness regression
uses real adapters, HttpClient deadline/retry handling, and SQLite with an
injected resolver/opener and simulated time, without network or real sleeps.
The subprocess fixture serves requests in memory and disables socket connections.

## Source evidence and server smoke

The vendored fixtures are an offline parser contract. Run them without
network access from the repository root:

```sh
PYTHONPATH=backend/vendor/hospital-tender-monitor/src \
  python3.11 -m unittest discover \
  -s backend/vendor/hospital-tender-monitor/tests -p 'test_*.py'
```

On a candidate server, run the credential-free live smoke as the same service
user and with the exact absolute Python executable configured in
`HOSPITAL_TENDER_PYTHON`:

```sh
env -i PATH=/usr/bin:/bin PYTHONIOENCODING=utf-8 NO_PROXY='*' no_proxy='*' \
  PYTHONPATH=/opt/sentelligent-sales-workbench/backend/vendor/hospital-tender-monitor/src \
  /opt/sentelligent-tools/python3.12 -m hospital_tender_monitor.cli \
  --project-root /opt/sentelligent-sales-workbench/backend/vendor/hospital-tender-monitor \
  smoke
```

The smoke prints only `status`, source counts, and notice count. `ok` means
every enabled public source responded; `partial` means at least one source
responded and the failed source IDs should be checked in the persisted health
view; `failed` exits non-zero when all sources failed. It never writes the
collector database or performs notification delivery. A local DNS/egress block
is therefore a candidate-environment prerequisite, not a reason to relax the
public URL or resolved-destination SSRF checks.
