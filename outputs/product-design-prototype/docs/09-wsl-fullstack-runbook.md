# WSL Full-Stack Runbook

## Purpose

This mode runs the backend service and production frontend from WSL-controlled processes.

It differs from local development mode:

- `dev:start` uses Vite dev server on Windows.
- `wsl:stack:start` builds production frontend assets and serves `dist/` through a WSL Node static server.
- The frontend build receives `VITE_API_BASE_URL` at build time.
- The backend uses the WSL service and SQLite runtime root from `08-wsl-service-runbook.md`.

## Commands

Run from the Windows workspace root:

```powershell
cd C:\Users\50159\Desktop\森特智行
npm run wsl:stack:start
npm run wsl:stack:health
npm run wsl:stack:status
npm run wsl:stack:stop
```

Default URLs:

```text
Backend:  http://127.0.0.1:8897
Frontend: http://127.0.0.1:8088
```

Temporary test runtime:

```powershell
npm run wsl:stack:start -- --runtime-root=/tmp/sent-zx-fullstack-test --backend-port=8921 --frontend-port=8091
npm run wsl:stack:health -- --runtime-root=/tmp/sent-zx-fullstack-test --backend-port=8921 --frontend-port=8091
npm run wsl:stack:stop -- --runtime-root=/tmp/sent-zx-fullstack-test --backend-port=8921 --frontend-port=8091
```

## What Starts

Backend:

- WSL command: `backend/scripts/service.mjs start`
- Database: `runtimeRoot/data/sales-workbench.sqlite`
- Log: `runtimeRoot/logs/backend.log`
- State: `runtimeRoot/runtime/backend-service.json`

Frontend:

- Windows build command: `npm run build` in `outputs/product-design-prototype`
- Build env: `VITE_API_BASE_URL=http://127.0.0.1:<backend-port>`
- WSL command: `outputs/product-design-prototype/scripts/static-server.mjs start`
- Static dist: `outputs/product-design-prototype/dist`
- Log: `runtimeRoot/logs/frontend-static.log`
- State: `runtimeRoot/runtime/frontend-static.json`

## Health

Backend health:

```text
GET /api/health
```

Frontend health:

```text
GET /_health
```

Expected frontend health includes:

```json
{
  "status": "ok",
  "apiBaseUrl": "http://127.0.0.1:8897"
}
```

## Verification

Run after any production-stack script change:

```powershell
npm run test:deploy
cd outputs\product-design-prototype
npm run qa:local
npm run qa:integration
```

Live full-stack smoke:

```powershell
npm run wsl:stack:start -- --runtime-root=/tmp/sent-zx-fullstack-test --backend-port=8921 --frontend-port=8091
npm run wsl:stack:health -- --runtime-root=/tmp/sent-zx-fullstack-test --backend-port=8921 --frontend-port=8091
npm run wsl:stack:stop -- --runtime-root=/tmp/sent-zx-fullstack-test --backend-port=8921 --frontend-port=8091
wsl.exe bash -lc "rm -rf /tmp/sent-zx-fullstack-test"
```

## Rules

- Stop the stack before restoring the database.
- Do not run production stack on the same frontend port as Vite dev server.
- Do not commit `dist/` as source of truth; rebuild it from the app.
- Do not write model keys into the frontend build environment.
