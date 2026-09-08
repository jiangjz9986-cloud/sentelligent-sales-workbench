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
