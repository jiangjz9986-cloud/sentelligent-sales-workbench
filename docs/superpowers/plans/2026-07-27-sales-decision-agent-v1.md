# Sales Decision Agent V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independently callable, evidence-first sales decision diagnosis flow that uses the confirmed V1 rules without changing the existing quick-record analysis contract or performing automatic business writeback.

**Architecture:** Keep the V1 runtime modular: a short core system prompt, scenario/industry playbooks, a strict output normalizer, and deterministic fallback/eval fixtures. The backend builds context from authenticated customer, opportunity, quick-record, action, risk, and knowledge records; it persists immutable diagnosis snapshots and exposes read-only history. The frontend adds a focused diagnosis panel to opportunity detail with explicit analyze and history actions.

**Tech Stack:** Node.js 24, SQLite versioned migrations, native `node:test`, existing DeepSeek-compatible HTTP client conventions, React 19, Vite, Lucide icons, existing Apple-style workbench primitives.

---

### Task 1: Define the V1 runtime contract and deterministic evaluator

**Files:**
- Create: `backend/src/ai/agents/salesDecisionSchema.js`
- Create: `backend/src/ai/agents/salesDecisionPlaybooks.js`
- Create: `backend/src/ai/agents/salesDecisionAgent.js`
- Test: `backend/tests/sales-decision-agent.test.js`

- [x] **Step 1: Write failing tests** for the `sales-decision-v1` schema, valid decision codes, evidence/unknown separation, deterministic score caps, compliance escalation, and invalid model JSON fallback.
- [x] **Step 2: Run the focused test and confirm it fails** because the agent modules do not exist.
- [x] **Step 3: Implement the minimum schema, playbook selection, prompt builder, deterministic fallback, and strict model-output normalizer. The fallback must always set `writebackPreview.requiresHumanConfirmation` to `true` and must never invent missing stakeholders, budget, dates, or commitments.**
- [x] **Step 4: Run the focused test and confirm all cases pass.**

### Task 2: Bridge the agent into the model layer and persist immutable snapshots

**Files:**
- Modify: `backend/src/modelAnalysis.js`
- Modify: `backend/src/db/migrate.js`
- Create: `backend/src/db/migrations/0006_sales_decision_analyses.mjs`
- Modify: `backend/src/validation/requests.js`
- Modify: `shared/salesWorkbenchApiContract.mjs`
- Modify: `backend/src/server.js`
- Test: `backend/tests/sales-decision-api.test.js`
- Test: `backend/tests/sales-decision-migrations.test.js`

- [x] **Step 1: Write failing API and migration tests** covering authenticated creation, context loading by opportunity/quick-record IDs, model fallback, strict validation, immutable history reads, audit insertion, and no automatic customer/opportunity/action/risk writes.
- [x] **Step 2: Run the focused tests and confirm the expected route/table failures.**
- [x] **Step 3: Add migration `0006`, request validation, a model-layer `analyzeSalesDecision` bridge, and `POST/GET /api/ai/sales-decisions` plus `GET /api/ai/sales-decisions/:id`. Persist the input snapshot and normalized result; return only contract-safe fields.**
- [x] **Step 4: Run the focused backend tests and then the existing backend suite.**

### Task 3: Add the opportunity-detail diagnosis experience

**Files:**
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`
- Modify: `outputs/product-design-prototype/src/features/salesWorkbench/pages.jsx`
- Modify: `outputs/product-design-prototype/src/styles/global.css`
- Test: `outputs/product-design-prototype/src/api/salesWorkbenchApi.test.js`
- Test: `outputs/product-design-prototype/scripts/sales-decision-page.test.mjs`

- [x] **Step 1: Write failing API and page-contract tests** for filtered history loading, explicit analyze action, read-only history selection, loading/error/empty states, and mobile-safe control sizing.
- [x] **Step 2: Run the focused frontend tests and confirm they fail before implementation.**
- [x] **Step 3: Add a compact `SalesDecisionPanel` to opportunity detail. Show headline, decision, stage gate, score, unknowns, risks, next actions, and compliance; keep writeback as a clearly labeled human-confirmation boundary. Use existing panels, Lucide icons, semantic buttons, and responsive single-column behavior.**
- [x] **Step 4: Run focused frontend tests and the local frontend QA suite.**

### Task 4: Add real-browser coverage and documentation

**Files:**
- Modify: `outputs/product-design-prototype/scripts/integration-qa.mjs`
- Modify: `README.md`
- Modify: `docs/开发进度与路线图.md`
- Modify: `docs/开发日志.md`

- [x] **Step 1: Add an integration assertion** that opportunity detail can run a diagnosis, open a saved historical diagnosis without issuing a second analyze request, and exposes no automatic writeback request.
- [x] **Step 2: Run native Chrome integration at desktop, tablet, narrow-window, iPhone, and Android sizes.**
- [x] **Step 3: Document that V1 rules are active for diagnosis only, the current quick-record analyzer remains unchanged, and real-case calibration is required before changing stage/score weights.**

### Task 5: Final verification

- [x] Run backend tests, frontend build, frontend local QA, root release tests, project secret scan, `git diff --cached --check`, and real Chrome integration.
- [x] Review the staged file list to ensure no `.env`, dependency, build, or credential files are included.
- [x] Leave the branch staged but unpushed until the user approves integration and release.

**Known boundary:** `backend/src/ai/agents/sales-decision-agent-v1.md` is the approved full rule specification and is included as design documentation. Runtime requests load a compact prompt/playbook representation; the feature is active only for explicit sales-decision diagnosis and does not replace every existing AI workflow.
