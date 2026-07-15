# Local WSL Runbook

## Purpose

This project uses a lightweight local stack for development and QA:

- WSL Ubuntu-24.04 backend.
- Node 24 with built-in `node:sqlite`.
- SQLite database in WSL `/tmp` by default.
- Vite frontend on Windows, connected through `VITE_API_BASE_URL`.

Use the root orchestration script instead of hand-written one-off commands.

## Commands

Run from the workspace root:

```powershell
cd C:\Users\50159\Desktop\森特智行
npm run dev:start
npm run dev:status
npm run dev:health
npm run dev:stop
```

Optional port/database overrides:

```powershell
npm run dev:start -- --backend-port=8911 --frontend-port=5191 --database-url=/tmp/sent-zx-local-dev.sqlite
npm run dev:health -- --backend-port=8911 --frontend-port=5191 --database-url=/tmp/sent-zx-local-dev.sqlite
npm run dev:stop -- --backend-port=8911 --frontend-port=5191 --database-url=/tmp/sent-zx-local-dev.sqlite
```

## Default Ports

- Backend: `http://127.0.0.1:8897`
- Frontend: `http://127.0.0.1:5184`

Do not assume port `8787` belongs to this project. It has been observed to host another local service.

## Runtime File

The script writes:

```text
.runtime/local-dev.json
```

It contains only local process IDs, ports, URLs, and the WSL database path. It must not contain secrets.

Running `npm run dev:stop` removes this file after the recorded processes are stopped. If this file remains, treat it as stale state and rerun `npm run dev:status` before using the URLs.

## Database

Default local database:

```text
/tmp/sent-zx-local-dev.sqlite
```

This keeps local dev data inside WSL temporary storage and avoids writing runtime SQLite files into the repository.

Backend `npm run smoke` uses an OS temporary directory for its self-check database and removes that directory before exit. It should not leave `backend/data/smoke.sqlite`.

## Health Gates

Backend health:

```text
GET /api/health
```

Expected body:

```json
{
  "status": "ok",
  "database": "ready",
  "aiAnalysisMode": "mock"
}
```

Frontend health:

```text
GET http://127.0.0.1:5184
```

Expected status: `200`.

## Verification

Run these before handing the project to another session:

```powershell
npm run test:deploy
cd outputs\product-design-prototype
npm run qa:local
npm run qa:integration
cd ..\..\backend
npm test
wsl.exe bash -lc "cd '/mnt/c/Users/50159/Desktop/森特智行/backend' && npm test && npm run smoke"
```

## WSL Mount Troubleshooting

If WSL can read `/home` or `/tmp` but `/mnt/c` returns `Input/output error`, the project code is not the root cause. The Windows drive mount is unhealthy.

Use:

```powershell
wsl.exe --shutdown
```

Then retry:

```powershell
wsl.exe bash -lc "ls -ld /mnt/c && cd '/mnt/c/Users/50159/Desktop/森特智行/backend' && head -n 3 package.json"
```

Only continue WSL verification after `/mnt/c` is readable again.
