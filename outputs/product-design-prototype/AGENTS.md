# Prototype Instructions

Run the local server yourself and open the preview in the in-app browser. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Multi-session development is coordinated by the main control thread. Feature threads must respect file ownership in `docs/04-模块化文件边界.md` and the orchestration plan in `docs/05-主控多会话开发计划.md`.

Do not let multiple feature threads expand their scope into the same files without main-control review. If a feature needs to touch shared files such as `src/App.jsx`, `src/components/primitives.jsx`, `src/styles/global.css`, `package.json`, or backend environment files, document the reason and run the full verification gate.

Deployment target is WSL Ubuntu-24.04. First backend/database implementation should stay lightweight with a Node backend and SQLite. Do not introduce PostgreSQL, Redis, queues, or heavy infrastructure until the main control thread explicitly approves that escalation.

For local WSL development, prefer the root orchestration commands in `../../package.json`: `npm run dev:start`, `npm run dev:status`, `npm run dev:health`, and `npm run dev:stop`. Do not hand-write temporary WSL/Vite launch commands unless debugging the orchestration script itself.

Model keys and production secrets must never be written to frontend code, screenshots, docs, logs, or committed examples. Use backend environment variables and `.env.example` placeholders only.

Shared API field contracts live at `../../shared/salesWorkbenchApiContract.mjs`. Treat this file as main-control owned. Any feature thread that changes customer, opportunity, quick-record, AI insight, manual confirmation, or weekly report fields must update the shared contract and run frontend `npm run qa:local`, frontend `npm run qa:integration`, and backend `npm test` in Windows and WSL.
