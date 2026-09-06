import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSalesWorkbenchApi } from "./salesWorkbenchApi.js";

function headers(values = {}) {
  const entries = new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), String(value)]));
  return { get: (name) => entries.get(String(name).toLowerCase()) ?? null };
}

function response(item) {
  return {
    ok: true,
    status: 200,
    headers: headers(),
    text: async () => JSON.stringify({ item }),
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: "proactive-assistant-v1",
    modelVersion: "rules/proactive-v1",
    source: "persisted",
    generatedAt: "2026-09-05T06:00:00.000Z",
    staleDays: 21,
    limit: 100,
    items: [],
    counts: { total: 0 },
    truncated: false,
    writebackPolicy: { requiresHumanConfirmation: true, automaticWriteAllowed: false },
    ...overrides,
  };
}

function notification(overrides = {}) {
  return {
    id: "notification-1",
    owner: "must-not-enter-browser-state",
    suggestionId: "shared-suggestion",
    suggestionVersion: 3,
    channel: "weixin",
    status: "sent",
    title: "补充下一步",
    trigger: "missing_next_step",
    priority: 80,
    summary: "补充下一步",
    outboxId: "must-not-enter-browser-state",
    attemptCount: 1,
    availableAt: "2026-09-05T06:00:00.000Z",
    lastErrorCode: null,
    deliveryStartedAt: "2026-09-05T06:00:01.000Z",
    sentAt: "2026-09-05T06:00:02.000Z",
    readAt: null,
    createdAt: "2026-09-05T06:00:00.000Z",
    updatedAt: "2026-09-05T06:00:02.000Z",
    futureSensitiveField: "must-not-enter-browser-state",
    ...overrides,
  };
}

describe("proactive assistant API query contract", () => {
  it("forwards every durable-ledger scope, lifecycle, pagination, and history parameter in a stable order", async () => {
    const calls = [];
    const controller = new AbortController();
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test/",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return response(snapshot({ limit: 37 }));
      },
    });

    const result = await api.getProactiveAssistant({
      limit: 37,
      offset: 74,
      status: "deferred",
      trigger: "missing_next_step",
      subjectId: "subject:cross-entry",
      customerId: "customer.cross-entry",
      opportunityId: "opportunity_cross-entry",
      includeHistory: true,
      signal: controller.signal,
    });

    assert.equal(result.source, "persisted");
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://example.test/api/assistant/proactive?limit=37&offset=74&status=deferred&trigger=missing_next_step&subjectId=subject%3Across-entry&customerId=customer.cross-entry&opportunityId=opportunity_cross-entry&includeHistory=true",
    );
    assert.equal(calls[0].options.method ?? "GET", "GET");
    assert.equal(calls[0].options.signal, controller.signal);
  });

  it("omits false history and empty optional filters instead of widening them into text values", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return response(snapshot({ limit: 100 }));
      },
    });

    await api.getProactiveAssistant({
      limit: 100,
      offset: 0,
      status: "",
      customerId: undefined,
      opportunityId: null,
      includeHistory: false,
    });

    assert.equal(calls[0].url, "https://example.test/api/assistant/proactive?limit=100&offset=0");
    assert.doesNotMatch(calls[0].url, /includeHistory|undefined|null|status=/u);
  });

  it("lists a bounded notification view and preserves queued/sent as unread", async () => {
    const calls = [];
    const controller = new AbortController();
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          headers: headers(),
          text: async () => JSON.stringify({ items: [notification()], total: 1 }),
        };
      },
    });

    const result = await api.getProactiveNotifications({ limit: 25, offset: 50, signal: controller.signal });
    assert.equal(calls[0].url, "https://example.test/api/assistant/proactive/notifications?limit=25&offset=50");
    assert.equal(calls[0].options.signal, controller.signal);
    assert.deepEqual(Object.keys(result.items[0]).sort(), [
      "attemptCount", "availableAt", "channel", "createdAt", "id", "lastErrorCode", "priority", "readAt",
      "sentAt", "status", "suggestionId", "suggestionVersion", "summary", "title", "trigger", "updatedAt",
    ].sort());
    assert.equal(result.items[0].status, "sent");
    assert.equal(result.items[0].readAt, null);
    assert.equal("owner" in result.items[0], false);
    assert.equal("outboxId" in result.items[0], false);
    assert.equal("futureSensitiveField" in result.items[0], false);
  });

  it("marks one notification read with an explicit POST and accepts only a read timestamp", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return response(notification({ status: "read", readAt: "2026-09-05T06:05:00.000Z" }));
      },
    });
    api.setSession({ csrfToken: "fixture-token" });

    const result = await api.markProactiveNotificationRead("notification/1");
    assert.equal(result.status, "read");
    assert.equal(result.readAt, "2026-09-05T06:05:00.000Z");
    assert.equal(calls[0].url, "https://example.test/api/assistant/proactive/notifications/notification%2F1/read");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.body, "{}");
    assert.equal(calls[0].options.headers["X-CSRF-Token"], "fixture-token");
  });

  it("rejects a queued delivery falsely carrying a read timestamp", async () => {
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: headers(),
        text: async () => JSON.stringify({
          items: [notification({ status: "queued", readAt: "2026-09-05T06:05:00.000Z", sentAt: null })],
          total: 1,
        }),
      }),
    });
    await assert.rejects(() => api.getProactiveNotifications(), /unread status cannot have readAt/u);
  });
});
