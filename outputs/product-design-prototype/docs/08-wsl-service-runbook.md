# WSL Backend Service Runbook

## Purpose

This runbook promotes the backend from temporary local development into a lightweight WSL service mode.

The service mode keeps these files under one WSL runtime root:

- SQLite database: `data/sales-workbench.sqlite`
- Service state: `runtime/backend-service.json`
- Backend log: `logs/backend.log`
- Backups: `backups/*.sqlite`

Default runtime root:

```text
~/.sentelligent-sales-workbench
```

## Root Commands

Run from the Windows workspace root:

```powershell
cd C:\Users\50159\Desktop\森特智行
npm run wsl:backend:start
npm run wsl:backend:status
npm run wsl:backend:health
npm run wsl:backend:stop
```

Database maintenance:

```powershell
npm run wsl:db:info
npm run wsl:db:backup -- --label=before-demo
npm run wsl:db:restore -- --backup-path=/home/<user>/.sentelligent-sales-workbench/backups/<file>.sqlite
```

Use a temporary runtime for test runs:

```powershell
npm run wsl:backend:start -- --runtime-root=/tmp/sent-zx-service-test --port=8920
npm run wsl:backend:health -- --runtime-root=/tmp/sent-zx-service-test --port=8920
npm run wsl:db:backup -- --runtime-root=/tmp/sent-zx-service-test --label=smoke
npm run wsl:backend:stop -- --runtime-root=/tmp/sent-zx-service-test --port=8920
```

## Rules

- Do not put model keys in frontend files, design docs, screenshots, logs, or API responses.
- The service state file contains only PID, host, port, database path, and log path.
- The service script seeds demo customers only with `INSERT OR IGNORE`, so existing records are not overwritten.
- Stop the backend service before restore if this is a real environment.
- `backup` uses SQLite `VACUUM INTO`, not a blind file copy.
- `restore` creates a `*-pre-restore.sqlite` snapshot before replacing the active database.

## Health

The service health endpoint is:

```text
GET http://127.0.0.1:8897/api/health
```

Expected body:

```json
{
  "status": "ok",
  "database": "ready",
  "aiAnalysisMode": "mock"
}
```

## Verification

Run these gates after changing service or database scripts:

```powershell
npm run test:deploy
cd backend
npm test
wsl.exe --cd /mnt/c/Users/50159/Desktop/森特智行/backend bash -lc "npm test && npm run smoke"
```

For a live service smoke test:

```powershell
npm run wsl:backend:start -- --runtime-root=/tmp/sent-zx-service-test --port=8920
npm run wsl:backend:health -- --runtime-root=/tmp/sent-zx-service-test --port=8920
npm run wsl:db:backup -- --runtime-root=/tmp/sent-zx-service-test --label=service-smoke
npm run wsl:db:info -- --runtime-root=/tmp/sent-zx-service-test
npm run wsl:backend:stop -- --runtime-root=/tmp/sent-zx-service-test --port=8920
```
