# Bundled hospital tender collector

This runtime is vendored from the local `hospital-it-tender-monitor` collector
at the reviewed snapshot used by the hospital tender integration. The backend
invokes it as a one-shot subprocess through
`backend/src/hospitalTender/internalRunner.js`.

The internal invocation sets `HOSPITAL_TENDER_MONITOR_DISABLE_NOTIFICATIONS=1`
and writes a bounded, credential-free snapshot to a private temporary file.
It does not use the collector's external sync URL/token bridge or PushPlus.
Python 3.11 or newer is required.
