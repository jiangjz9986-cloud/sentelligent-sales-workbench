# List Actions and Itinerary Date Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the customer, opportunity, itinerary, and knowledge create actions into their list cards and make itinerary dates easier to scan on desktop and mobile.

**Architecture:** Extend the shared `Panel` primitive with an optional header action slot, let each list page own its create action, and add a timezone-safe date-parts formatter to the itinerary model. Keep business handlers and test IDs unchanged while removing the empty page-level action row.

**Tech Stack:** React, CSS, Node test runner.

---

## Task 1: Lock the requested layout and date behavior with tests

- [x] Add model tests for valid, invalid, and timezone-safe itinerary date parts.
- [x] Add a static UI test that requires all four list actions inside card headers.
- [x] Run the new tests and confirm they fail for the missing implementation.

## Task 2: Move list actions into their content cards

- [x] Add an optional `action` slot to `Panel` with accessible responsive styling.
- [x] Render customer, opportunity, and knowledge create buttons in their panel headers.
- [x] Add the itinerary header, count, and create action to the itinerary panel.
- [x] Remove the list-only page-level action row while preserving subview headings.

## Task 3: Refine the itinerary date presentation

- [x] Add a local-calendar `formatVisitDateParts` helper without UTC date shifting.
- [x] Replace the split `07-29` tile with month, day, and weekday semantics.
- [x] Add compact desktop and mobile styles with clear hierarchy and no overflow.

## Task 4: Verify visually and functionally

- [x] Run focused model, static page, and interaction tests.
- [x] Build production assets and run the full frontend local QA gate.
- [x] Open the local app in the in-app browser and inspect desktop and mobile layouts.
- [x] Run integration and WebKit QA, then review the final diff and worktree status.
