# Backend Implementation Plan

## Goal

Build a lightweight deployable backend for the 森特智行 AI 销售作战台 MVP. The first backend version stores customers, opportunities, quick records, mock AI analysis results, manual write confirmations, and weekly report drafts in SQLite.

## Architecture

- Runtime: Node.js 24+ running inside WSL Ubuntu-24.04.
- Database: SQLite through Node's built-in `node:sqlite`; no system `sqlite3` binary is required.
- Server: native `node:http` with small route handlers, no framework dependency for the MVP.
- Configuration: backend-only `.env`; model provider keys must not be committed or placed in frontend files.

## Directory Layout

- `backend/package.json`: scripts for test, migration, seed, and local server start.
- `backend/README.md`: runbook, API list, WSL commands, and secret-handling rules.
- `backend/src/config.js`: reads environment variables without exposing secrets.
- `backend/src/db.js`: opens SQLite, runs schema, and exposes query helpers.
- `backend/src/schema.sql`: minimal SQLite tables and indexes.
- `backend/src/seed.js`: seed data aligned with the current prototype data shape.
- `backend/src/quickRecordAnalysis.js`: deterministic AI analysis mock for quick records.
- `backend/src/weeklyDraft.js`: weekly draft builder with source references.
- `backend/src/server.js`: HTTP routes and JSON request/response handling.
- `backend/tests/api.test.js`: end-to-end API contract tests against a temporary SQLite database.

## Minimal Schema

- `customers`: customer profile, stakeholders, decision chain, infrastructure, needs, risks, opportunities as JSON text.
- `opportunities`: opportunity card with customer link, stage, amount, probability, requirements, competitors, solution direction, risk, and next action.
- `quick_records`: raw sales notes and current workflow status.
- `ai_insights`: mock analysis result linked to a quick record, preserving source and confidence.
- `manual_confirmations`: human confirmations for `customer`, `opportunity`, and `weekly` write targets.
- `action_items`: next actions generated only after manual confirmation, traceable to quick records through `source_record_id`.
- `weekly_reports`: draft report content and traceable source references.
- `solution_drafts`: generated solution material drafts with customer, opportunity, and action source references.

## MVP API

- `GET /api/health`
- `GET /api/customers`
- `POST /api/customers`
- `GET /api/customers/:id`
- `GET /api/opportunities`
- `POST /api/opportunities`
- `GET /api/opportunities/:id`
- `GET /api/actions`
- `POST /api/quick-records`
- `GET /api/quick-records`
- `POST /api/quick-records/:id/analyze`
- `POST /api/quick-records/:id/confirm`
- `POST /api/reports/weekly/draft`
- `GET /api/reports/weekly/:id`
- `POST /api/solutions/draft`
- `GET /api/solutions/:id`

## Implementation Steps

1. Write failing API tests for health, seeded customers/opportunities, quick-record analysis, manual confirmations, and weekly draft generation.
2. Implement schema and database helpers.
3. Implement mock analysis and weekly draft builders.
4. Implement HTTP server routes.
5. Verify with Node tests and a WSL start command.

## Verification Commands

Run in WSL from the repository root:

```bash
cd /mnt/c/Users/50159/Desktop/森特智行/backend
npm test
npm run migrate
npm run seed
npm start
```
