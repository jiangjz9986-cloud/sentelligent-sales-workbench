import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../src/http/errors.js";
import {
  createVisitTemperatureSuggestionHttpHandlers,
} from "../src/assistant/visitTemperatureHttp.js";
import { VisitTemperatureSuggestionError } from "../src/assistant/visitTemperatureSuggestion.js";

const USER_A = Object.freeze({ kind: "user", account: "owner-a" });
const COLLECTION = "/api/visit-temperature-suggestions";
const SUGGESTION_ID = "temperature-suggestion-1";
const ITEM = `${COLLECTION}/${SUGGESTION_ID}`;
const IDENTITY = "a".repeat(64);

function createHarness(overrides = {}) {
  const calls = [];
  const service = {
    async suggest(input) {
      calls.push(["suggest", structuredClone(input)]);
      return {
        id: SUGGESTION_ID,
        identity: IDENTITY,
        status: "pending",
        owner: input.owner,
        visitId: input.visitId,
        customerVersion: 7,
        previousValue: 42,
        suggestedValue: 68,
        requiresHumanConfirmation: true,
      };
    },
    get(input) {
      calls.push(["get", structuredClone(input)]);
      return { id: input.suggestionId, owner: input.owner, status: "pending" };
    },
    history(input) {
      calls.push(["history", structuredClone(input)]);
      return { items: [], input, truncated: false };
    },
    confirm(input) {
      calls.push(["confirm", structuredClone(input)]);
      return { status: "confirmed", writeback: true, input };
    },
    cancel(input) {
      calls.push(["cancel", structuredClone(input)]);
      return { status: "cancelled", input };
    },
    ...overrides,
  };
  return {
    calls,
    service,
    handlers: createVisitTemperatureSuggestionHttpHandlers({ service }),
  };
}

function isHttpError(status, code) {
  return (error) => error instanceof HttpError && error.status === status && error.code === code;
}

describe("visit temperature suggestion HTTP adapter", () => {
  it("requires a complete injected service", () => {
    assert.throws(
      () => createVisitTemperatureSuggestionHttpHandlers({ service: { suggest() {} } }),
      { name: "TypeError", message: "visit temperature suggestion service is required" },
    );
  });

  it("creates a read-only suggestion with owner injected from the user session", async () => {
    const harness = createHarness();
    const result = await harness.handlers.handle({
      method: "POST",
      pathname: COLLECTION,
      requestIdentity: USER_A,
      requestId: "req-temperature-suggest",
      body: { visitId: "visit-a" },
    });

    assert.equal(result.status, 200);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.body.requestId, "req-temperature-suggest");
    assert.equal(result.body.item.status, "pending");
    assert.equal(result.body.item.requiresHumanConfirmation, true);
    assert.deepEqual(harness.calls, [["suggest", { owner: "owner-a", visitId: "visit-a" }]]);
  });

  it("exposes owner-scoped item and history reads with bounded query parsing", async () => {
    const harness = createHarness();
    const item = await harness.handlers.handle({
      method: "GET",
      pathname: ITEM,
      requestIdentity: USER_A,
    });
    const history = await harness.handlers.handle({
      method: "GET",
      pathname: COLLECTION,
      query: new URLSearchParams({ customerId: "customer-a", limit: "7" }),
      requestIdentity: USER_A,
    });

    assert.equal(item.body.item.id, SUGGESTION_ID);
    assert.equal(history.body.item.input.limit, 7);
    assert.deepEqual(harness.calls, [
      ["get", { owner: "owner-a", suggestionId: SUGGESTION_ID }],
      ["history", { owner: "owner-a", customerId: "customer-a", limit: 7 }],
    ]);

    await assert.rejects(
      harness.handlers.handle({
        method: "GET",
        pathname: COLLECTION,
        query: { limit: "51" },
        requestIdentity: USER_A,
      }),
      (error) => isHttpError(422, "VALIDATION_ERROR")(error) && error.fields["query.limit"] === "integer",
    );
  });

  it("passes every pinned field to one explicit confirmation", async () => {
    const harness = createHarness();
    const result = await harness.handlers.handle({
      method: "POST",
      pathname: `${ITEM}/confirm`,
      requestIdentity: USER_A,
      body: {
        suggestionIdentity: IDENTITY,
        expectedCustomerVersion: 7,
        previousValue: 42,
        confirm: true,
      },
    });

    assert.equal(result.body.item.status, "confirmed");
    assert.equal(result.body.item.writeback, true);
    assert.deepEqual(harness.calls, [["confirm", {
      owner: "owner-a",
      suggestionId: SUGGESTION_ID,
      suggestionIdentity: IDENTITY,
      expectedCustomerVersion: 7,
      previousValue: 42,
      confirm: true,
    }]]);

    await assert.rejects(
      harness.handlers.handle({
        method: "POST",
        pathname: `${ITEM}/confirm`,
        requestIdentity: USER_A,
        body: {
          suggestionIdentity: IDENTITY,
          expectedCustomerVersion: 7,
          previousValue: 42,
        },
      }),
      isHttpError(409, "EXPLICIT_CONFIRMATION_REQUIRED"),
    );
    assert.equal(harness.calls.length, 1);
  });

  it("cancels only with an explicit flag and immutable identity", async () => {
    const harness = createHarness();
    const result = await harness.handlers.handle({
      method: "POST",
      pathname: `${ITEM}/cancel`,
      requestIdentity: USER_A,
      body: { suggestionIdentity: IDENTITY, cancel: true },
    });

    assert.equal(result.body.item.status, "cancelled");
    assert.deepEqual(harness.calls, [["cancel", {
      owner: "owner-a",
      suggestionId: SUGGESTION_ID,
      suggestionIdentity: IDENTITY,
      cancel: true,
    }]]);

    await assert.rejects(
      harness.handlers.handle({
        method: "POST",
        pathname: `${ITEM}/cancel`,
        requestIdentity: USER_A,
        body: { suggestionIdentity: IDENTITY, cancel: false },
      }),
      isHttpError(409, "EXPLICIT_CANCELLATION_REQUIRED"),
    );
    assert.equal(harness.calls.length, 1);
  });

  it("rejects unauthenticated, owner-forging, malformed identity, and wrong-method requests before service calls", async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.handlers.handle({
        method: "POST",
        pathname: COLLECTION,
        body: { visitId: "visit-a" },
      }),
      isHttpError(401, "UNAUTHORIZED"),
    );
    await assert.rejects(
      harness.handlers.handle({
        method: "POST",
        pathname: COLLECTION,
        requestIdentity: USER_A,
        body: { visitId: "visit-a", owner: "owner-b" },
      }),
      (error) => isHttpError(422, "VALIDATION_ERROR")(error) && error.fields.owner === "unknown",
    );
    await assert.rejects(
      harness.handlers.handle({
        method: "POST",
        pathname: `${ITEM}/confirm`,
        requestIdentity: USER_A,
        body: {
          suggestionIdentity: "not-a-digest",
          expectedCustomerVersion: 7,
          previousValue: 42,
          confirm: true,
        },
      }),
      isHttpError(422, "VALIDATION_ERROR"),
    );
    await assert.rejects(
      harness.handlers.handle({
        method: "PATCH",
        pathname: ITEM,
        requestIdentity: USER_A,
      }),
      (error) => isHttpError(405, "METHOD_NOT_ALLOWED")(error) && error.headers.Allow === "GET",
    );
    assert.equal(harness.calls.length, 0);
  });

  it("maps service-domain failures into bounded HTTP errors and leaves unknown failures intact", async () => {
    const domainFailure = new VisitTemperatureSuggestionError(
      "VISIT_NOT_CONFIRMED",
      "The visit is not confirmed",
      { status: 409, details: { visitId: "state" } },
    );
    const harness = createHarness({
      async suggest() { throw domainFailure; },
    });
    await assert.rejects(
      harness.handlers.handle({
        method: "POST",
        pathname: COLLECTION,
        requestIdentity: USER_A,
        body: { visitId: "visit-a" },
      }),
      (error) => isHttpError(409, "VISIT_NOT_CONFIRMED")(error)
        && error.fields.visitId === "state",
    );

    const unexpected = new Error("unexpected repository failure");
    const unknownHarness = createHarness({ get() { throw unexpected; } });
    await assert.rejects(
      unknownHarness.handlers.handle({ method: "GET", pathname: ITEM, requestIdentity: USER_A }),
      (error) => error === unexpected,
    );
  });

  it("returns null for unrelated paths so the main server can continue routing", async () => {
    const harness = createHarness();
    assert.equal(harness.handlers.matches(COLLECTION), true);
    assert.equal(harness.handlers.matches(ITEM), true);
    assert.equal(harness.handlers.matches("/api/quick-records"), false);
    assert.equal(await harness.handlers.handle({ pathname: "/api/quick-records" }), null);
  });
});
