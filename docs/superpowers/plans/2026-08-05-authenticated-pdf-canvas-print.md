# Authenticated PDF Canvas Print Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development and systematic-debugging task-by-task. This shared worktree must not be committed, pushed, or deployed from this task.

**Goal:** Render protected invoice PDFs into print-safe canvases before enabling four-up printing, while preserving global 401 session invalidation and strict browser security headers.

**Architecture:** The API client owns authenticated invoice-content requests and session invalidation. `authenticatedPdf.js` validates the successful response as a non-redirected PDF Blob. `AuthenticatedPdfFrame.jsx` uses PDF.js to render page one into a fixed high-resolution Canvas and publishes `ready` only after `page.render(...).promise` resolves; cancellation destroys the PDF.js tasks. No PDF iframe or Blob frame is used.

**Tech Stack:** React 19, Vite 6, Playwright 1.61, PDF.js `pdfjs-dist` 5.6.205, Node test runner.

---

### Task 1: Lock the real render and session contracts

**Files:**
- Modify: `outputs/product-design-prototype/scripts/authenticated-pdf-browser.test.mjs`
- Modify: `outputs/product-design-prototype/scripts/fixtures/authenticated-pdf-harness.jsx`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.test.js`

- [ ] Assert the browser harness contains a rendered Canvas with non-zero dimensions, no iframe, and reports `ready` only after PDF.js paints the valid fixture PDF.
- [ ] Assert `getInvoiceContentResponse()` sends Cookie credentials and `Accept: application/pdf`, rejects HTTP 401 as a structured API error, clears only the matching session generation, and calls `onUnauthorized` once.
- [ ] Run both tests and confirm they fail against the fetch-ready iframe implementation.

### Task 2: Route invoice bytes through the API client

**Files:**
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/authenticatedPdf.js`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/authenticatedPdf.test.js`

- [ ] Add `getInvoiceContentResponse(invoiceId, { signal })`, using the configured `fetchImpl`, Cookie credentials, `redirect: "error"`, `Accept: application/pdf`, structured non-2xx errors, and existing generation-aware `invalidateSession()` handling.
- [ ] Replace URL/object-URL loading with `loadAuthenticatedPdfBlob(loadResponse, { signal })`; require a 2xx, non-redirected `application/pdf` response and return the validated Blob.
- [ ] Run API and helper tests and confirm all pass.

### Task 3: Render PDF.js Canvas before publishing ready

**Files:**
- Modify: `outputs/product-design-prototype/package.json`
- Modify: `outputs/product-design-prototype/package-lock.json`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/AuthenticatedPdfFrame.jsx`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/InvoiceManager.jsx`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/InvoicePrintPreview.jsx`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/travelExpense.css`

- [ ] Add exact dependency `pdfjs-dist@5.6.205` and configure the Vite worker URL.
- [ ] Render the requested PDF page into a Canvas at 1440 px print width (1200 px detail width), keep `loading` until `renderTask.promise` resolves, then publish `ready`.
- [ ] On retry, source change, or unmount, abort fetch, cancel render, destroy the PDF loading task/document, and ignore stale completions.
- [ ] Pass stable invoice resource keys and API-client response loaders from detail and four-up print views.
- [ ] Run the browser render test and the full travel-expense test command.

### Task 4: Tighten CSP and perform release-level verification

**Files:**
- Modify: `outputs/product-design-prototype/scripts/static-server.mjs`
- Modify: `outputs/product-design-prototype/scripts/static-server.test.mjs`

- [ ] Remove the no-longer-needed `frame-src 'self' blob:` directive while keeping `frame-ancestors 'none'`, `object-src 'none'`, and `X-Frame-Options: DENY` under explicit tests.
- [ ] Run the production build, targeted backend security/invoice tests, travel-expense tests, integration QA, WebKit QA, project history secret scan, and `git diff --check`.
- [ ] Report the existing bundle-size warning separately; do not commit, push, or deploy.
