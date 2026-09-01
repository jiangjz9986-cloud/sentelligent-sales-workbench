import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertVisitTemperatureSuggestion,
  createSalesWorkbenchApi,
  normalizeVisitTemperatureError,
} from "./salesWorkbenchApi.js";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function suggestion(overrides = {}) {
  return {
    id: "suggestion-1",
    identity: "a".repeat(64),
    owner: "owner-a",
    status: "pending",
    visitId: "visit-1",
    customerId: "customer-1",
    customerVersion: 3,
    previousValue: 40,
    suggestedValue: 46,
    delta: 6,
    confidence: 82,
    facts: [{ key: "current_relation", label: "当前客户温度", value: 40, confidence: 100, sourceRefs: [{ type: "customer", id: "customer-1" }] }],
    inferences: [{ claim: "建议小幅上调", basis: "当前客户温度：40", confidence: 82, sourceRefs: [] }],
    sourceRefs: [{ type: "quick_record", id: "visit-1" }],
    requiresHumanConfirmation: true,
    writebackAllowed: false,
    createdAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-09-03T00:00:00.000Z",
    confirmedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe("visit temperature API client", () => {
  it("uses the server owner scope and exact create/list/get routes", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.includes("/api/visit-temperature-suggestions") && (options.method ?? "GET") === "GET" && !url.includes("suggestion-1")) {
          return response({ item: { items: [suggestion()], truncated: false } });
        }
        return response({ item: suggestion() });
      },
    });
    const created = await api.createVisitTemperatureSuggestion("visit-1");
    await api.listVisitTemperatureSuggestions({ customerId: "customer-1", limit: 9 });
    await api.getVisitTemperatureSuggestion("suggestion-1");
    assert.equal(created.id, "suggestion-1");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), { visitId: "visit-1" });
    assert.match(calls[1].url, /customerId=customer-1&limit=9/);
    assert.equal(JSON.stringify(calls).includes("owner"), false);
  });

  it("pins identity, customer version and previous value for confirm, and cancel is single-item", async () => {
    const calls = [];
    const item = suggestion();
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return response({ item: { status: options.body.includes("confirm") ? "confirmed" : "cancelled", suggestion: { ...item, status: options.body.includes("confirm") ? "confirmed" : "cancelled" }, writeback: options.body.includes("confirm") } });
      },
    });
    const confirmed = await api.confirmVisitTemperatureSuggestion(item);
    const cancelled = await api.cancelVisitTemperatureSuggestion(item);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(cancelled.status, "cancelled");
    const confirmPayload = JSON.parse(calls[0].options.body);
    const cancelPayload = JSON.parse(calls[1].options.body);
    assert.deepEqual(confirmPayload, {
      suggestionIdentity: item.identity,
      expectedCustomerVersion: item.customerVersion,
      previousValue: item.previousValue,
      confirm: true,
    });
    assert.deepEqual(cancelPayload, { suggestionIdentity: item.identity, cancel: true });
    assert.equal(Object.hasOwn(confirmPayload, "owner"), false);
    assert.equal(Object.hasOwn(cancelPayload, "owner"), false);
  });

  it("distinguishes auth, conflict, timeout and internal errors without exposing body", () => {
    assert.equal(normalizeVisitTemperatureError({ status: 401, message: "private" }).code, "AUTH_REQUIRED");
    assert.equal(normalizeVisitTemperatureError({ status: 409, message: "private" }).code, "CONFLICT");
    assert.equal(normalizeVisitTemperatureError({ name: "TimeoutError", message: "private" }).code, "TIMEOUT");
    const internal = normalizeVisitTemperatureError({ status: 500, message: "private stack" });
    assert.equal(internal.code, "INTERNAL_ERROR");
    assert.doesNotMatch(internal.message, /private stack/);
  });

  it("rejects unknown statuses, oversized identifiers, null numeric fields and missing evidence", () => {
    assert.throws(() => assertVisitTemperatureSuggestion(suggestion({ status: "unknown" })), /status: invalid/);
    assert.throws(() => assertVisitTemperatureSuggestion(suggestion({ id: "x".repeat(2_001) })), /missing identity/);
    assert.throws(() => assertVisitTemperatureSuggestion(suggestion({ previousValue: null })), /previousValue: invalid/);
    assert.throws(() => assertVisitTemperatureSuggestion(suggestion({ sourceRefs: [] })), /evidence is required/);
    assert.throws(() => assertVisitTemperatureSuggestion(suggestion({ facts: [{ ...suggestion().facts[0], confidence: "100" }] })), /facts: invalid evidence/);
    assert.throws(() => assertVisitTemperatureSuggestion(suggestion({ sourceRefs: [{ type: "bad id", id: "visit-1" }] })), /list contains invalid item/);
  });

  it("enforces a bounded request timeout and preserves external abort", async () => {
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    });
    await assert.rejects(
      api.getVisitTemperatureSuggestion("suggestion-1", { timeoutMs: 5 }),
      (error) => error.code === "TIMEOUT",
    );
    const controller = new AbortController();
    const pending = api.getVisitTemperatureSuggestion("suggestion-1", { signal: controller.signal, timeoutMs: 100 });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === "ABORTED");
  });
});
