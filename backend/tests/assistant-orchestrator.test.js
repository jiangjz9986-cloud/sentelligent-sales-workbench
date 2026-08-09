import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { createAssistantOrchestrator } from "../src/assistant/orchestrator.js";

function fakeRuntime() {
  const events = new Map();
  const pending = new Map();
  const parts = [];
  let sequence = 0;
  const eventRepository = {
    receive(input) {
      const key = `${input.owner}:${input.channel}:${input.eventId}`;
      const existing = events.get(key);
      if (existing) return { item: existing, replayed: true };
      const item = { id: `event-${++sequence}`, status: "received", response: null };
      events.set(key, item);
      return { item, replayed: false };
    },
    claim(id) {
      const item = [...events.values()].find((event) => event.id === id);
      if (item.status === "completed" || item.status === "failed") return { item, replayed: true };
      item.status = "processing";
      return { item, replayed: false, leaseToken: `lease-${id}` };
    },
    complete(id, { response, responseStatus, leaseToken }) {
      const item = [...events.values()].find((event) => event.id === id);
      assert.equal(leaseToken, `lease-${id}`);
      item.status = "completed";
      item.response = response;
      item.responseStatus = responseStatus;
      return { item, replayed: false };
    },
    fail(id, { response, responseStatus, leaseToken, errorCode }) {
      const item = [...events.values()].find((event) => event.id === id);
      assert.equal(leaseToken, `lease-${id}`);
      item.status = "failed";
      item.response = response;
      item.responseStatus = responseStatus;
      item.errorCode = errorCode;
      return { item, replayed: false };
    },
  };
  const sessionRepository = {
    getOrCreate(input) { return { id: `${input.owner}:${input.channel}:${input.conversationId}` }; },
    appendDraftPart(conversationId, part) { parts.push({ conversationId, ...part }); },
  };
  const pendingActionRepository = {
    create(input) {
      const action = { id: `action-${++sequence}`, ...input, status: "pending" };
      pending.set(action.id, action);
      return action;
    },
    get(id, scope) {
      const action = pending.get(id);
      const conversationId = scope.conversationId ?? scope.conversation;
      return action
        && action.owner === scope.owner
        && action.channel === scope.channel
        && (conversationId === undefined || action.conversationId === conversationId)
        ? action
        : null;
    },
    confirm(id, { owner, channel, conversationId, confirmationCode }) {
      const action = this.get(id, { owner, channel, conversationId });
      if (!action || action.confirmationCode !== confirmationCode) throw Object.assign(new Error("invalid"), { status: 409 });
      if (action.status === "processing") return { item: action, replayed: true, inProgress: true };
      if (action.status === "executed") return { item: action, replayed: true };
      action.status = "confirmed";
      return { item: action, replayed: false };
    },
    renewConfirmation(id, { owner, channel, conversationId, confirmationCode }) {
      const action = this.get(id, { owner, channel, conversationId });
      if (!action) throw Object.assign(new Error("missing"), { status: 404 });
      action.confirmationCode = confirmationCode;
      action.status = "pending";
      return { item: action, confirmationCode };
    },
    claimExecution(id, { owner, channel, conversationId }) {
      const action = this.get(id, { owner, channel, conversationId });
      if (!action) throw Object.assign(new Error("missing"), { status: 404 });
      if (action.status === "executed") return { item: action, replayed: true };
      if (action.status === "processing") return { item: action, replayed: false, inProgress: true };
      if (action.status !== "confirmed") throw Object.assign(new Error("not-confirmed"), { status: 409 });
      action.status = "processing";
      action.leaseToken = `action-lease-${id}`;
      return { item: action, replayed: false, leaseToken: action.leaseToken };
    },
    completeExecution(id, { owner, channel, conversationId, leaseToken, result }) {
      const action = this.get(id, { owner, channel, conversationId });
      if (!action) throw Object.assign(new Error("missing"), { status: 404 });
      if (action.status === "executed") return { item: action, replayed: true };
      if (action.status !== "processing" || action.leaseToken !== leaseToken) throw Object.assign(new Error("lease"), { status: 409 });
      action.status = "executed";
      action.result = result;
      return { item: action, replayed: false };
    },
    releaseExecution(id, { owner, channel, conversationId, leaseToken }) {
      const action = this.get(id, { owner, channel, conversationId });
      if (!action || action.status !== "processing" || action.leaseToken !== leaseToken) return { replayed: true, item: action };
      action.status = "confirmed";
      return { replayed: false, item: action };
    },
    markExecuted(id, { owner, channel, conversationId, result }) {
      const action = this.get(id, { owner, channel, conversationId });
      if (!action) throw Object.assign(new Error("missing"), { status: 404 });
      if (action.status === "executed") return { item: action, replayed: true };
      action.status = "executed";
      action.result = result;
      return { item: action, replayed: false };
    },
  };
  return { eventRepository, sessionRepository, pendingActionRepository, parts };
}

const context = Object.freeze({ owner: "owner-a", channel: "weixin", conversation: "conversation-a", event: "event-a", requestId: "request-a" });

function registryFor(toolName, risk, confirmation = "none") {
  const tool = { name: toolName, agentId: "test-agent", arguments: { value: { type: "string", required: true } }, policy: { risk, confirmation } };
  return { getTool(name) { return name === toolName ? tool : null; } };
}

function routerFor(plan) { return { route() { return { ...plan }; } }; }

describe("assistant orchestrator", () => {
  it("uses only server context and executes an R0 tool with immutable context", async () => {
    const runtime = fakeRuntime();
    let received;
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor("customer.search", "R0"),
      router: routerFor({ status: "planned", toolName: "customer.search", agentId: "test-agent", arguments: { value: "hospital" }, risk: "R0" }),
      toolHandlers: { "customer.search": (args, safeContext) => { received = { args, safeContext }; return { matches: 1 }; } },
    });
    const response = await orchestrator.handle({ context, input: { text: "search", owner: "attacker", channel: "other" } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.result, { matches: 1 });
    assert.equal(received.safeContext.owner, "owner-a");
    assert.equal(received.safeContext.channel, "weixin");
    assert.equal(received.safeContext.requestId, "request-a");
    assert.equal(received.safeContext.owner, context.owner);
  });

  it("returns the stored response for a replay without running the handler twice", async () => {
    const runtime = fakeRuntime();
    let calls = 0;
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor("customer.search", "R0"),
      router: routerFor({ status: "planned", toolName: "customer.search", agentId: "test-agent", arguments: { value: "hospital" }, risk: "R0" }),
      toolHandlers: { "customer.search": () => { calls += 1; return { ok: true }; } },
    });
    const first = await orchestrator.handle({ context, input: { text: "search" } });
    const replay = await orchestrator.handle({ context, input: { text: "search" } });
    assert.deepEqual(replay.body, first.body);
    assert.equal(calls, 1);
  });

  it("creates one pending action for unconfirmed R2 and executes only after confirmation", async () => {
    const runtime = fakeRuntime();
    let calls = 0;
    const plan = { status: "confirmation_required", toolName: "visit-capture.confirm", agentId: "test-agent", arguments: { value: "draft-1" }, risk: "R2", confirmation: "simple" };
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => { calls += 1; return { saved: true }; } },
    });
    const pending = await orchestrator.handle({ context, input: { text: "save" } });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.confirmationCode, "482913");
    assert.equal(calls, 0);
    const confirmed = await orchestrator.handle({ context: { ...context, event: "event-b", requestId: "request-b" }, input: { text: "confirm", pendingActionId: pending.body.actionId, confirmationCode: "482913" } });
    assert.deepEqual(confirmed.body.result, { saved: true });
    assert.equal(calls, 1);
  });

  it("reissues a lost confirmation code through a new scoped event", async () => {
    const runtime = fakeRuntime();
    const plan = { status: "confirmation_required", toolName: "visit-capture.confirm", agentId: "test-agent", arguments: { value: "draft-1" }, risk: "R2", confirmation: "simple" };
    const codes = ["482913", "731604"];
    let calls = 0;
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => codes.shift(),
      toolHandlers: { [plan.toolName]: () => { calls += 1; return { saved: true }; } },
    });
    const pending = await orchestrator.handle({ context, input: { text: "save" } });
    const renewed = await orchestrator.handle({
      context: { ...context, event: "event-renew-code", requestId: "request-renew-code" },
      input: { text: "confirm", pendingActionId: pending.body.actionId },
    });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.status, "confirmation_required");
    assert.equal(renewed.body.confirmationCode, "731604");
    const confirmed = await orchestrator.handle({
      context: { ...context, event: "event-renew-confirm", requestId: "request-renew-confirm" },
      input: { text: "confirm", pendingActionId: pending.body.actionId, confirmationCode: "731604" },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(calls, 1);
  });

  it("executes the persisted confirmation plan even when the confirmation text tries to change it", async () => {
    const runtime = fakeRuntime();
    const storedPlan = {
      status: "confirmation_required",
      toolName: "visit-capture.confirm",
      agentId: "test-agent",
      arguments: { value: "draft-original" },
      risk: "R2",
      confirmation: "simple",
    };
    let handlerArgs;
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(storedPlan.toolName, "R2", "simple"),
      router: {
        route({ text }) {
          if (text === "save") return { ...storedPlan };
          return {
            ...storedPlan,
            status: "planned",
            confirmed: true,
            arguments: { value: "draft-attacker" },
          };
        },
      },
      confirmationCodeFactory: () => "482913",
      toolHandlers: {
        [storedPlan.toolName]: (args) => {
          handlerArgs = args;
          return { saved: true };
        },
      },
    });

    const pending = await orchestrator.handle({ context, input: { text: "save" } });
    const confirmed = await orchestrator.handle({
      context: { ...context, event: "event-confirm-bound", requestId: "request-confirm-bound" },
      input: {
        text: "把另一个草稿写入系统",
        pendingActionId: pending.body.actionId,
        confirmationCode: "482913",
      },
    });

    assert.equal(confirmed.status, 200);
    assert.deepEqual(handlerArgs, { value: "draft-original" });
  });

  it("returns a controlled conflict while a confirmed action is leased by another request", async () => {
    const runtime = fakeRuntime();
    const plan = {
      status: "confirmation_required",
      toolName: "visit-capture.confirm",
      agentId: "test-agent",
      arguments: { value: "draft-1" },
      risk: "R2",
      confirmation: "simple",
    };
    let release;
    const firstStarted = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: {
        [plan.toolName]: async () => {
          calls += 1;
          await firstStarted;
          return { saved: true };
        },
      },
    });
    const pending = await orchestrator.handle({ context, input: { text: "save" } });
    const first = orchestrator.handle({
      context: { ...context, event: "event-confirm-lease-1", requestId: "request-confirm-lease-1" },
      input: { text: "confirm", pendingActionId: pending.body.actionId, confirmationCode: "482913" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = orchestrator.handle({
      context: { ...context, event: "event-confirm-lease-2", requestId: "request-confirm-lease-2" },
      input: { text: "confirm", pendingActionId: pending.body.actionId, confirmationCode: "482913" },
    });
    release();
    const firstResult = await first;
    const secondResult = await second;
    assert.equal(firstResult.status, 200);
    assert.equal(secondResult.status, 409);
    assert.equal(calls, 1);
  });

  it("replays an executed confirmation without invoking the write handler twice", async () => {
    const runtime = fakeRuntime();
    let calls = 0;
    const plan = { status: "confirmation_required", toolName: "visit-capture.confirm", agentId: "test-agent", arguments: { value: "draft-1" }, risk: "R2", confirmation: "simple" };
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => { calls += 1; return { saved: true }; } },
    });
    const pending = await orchestrator.handle({ context, input: { text: "save" } });
    const first = await orchestrator.handle({
      context: { ...context, event: "event-confirm-once", requestId: "request-confirm-once" },
      input: { text: "confirm", pendingActionId: pending.body.actionId, confirmationCode: "482913" },
    });
    const replay = await orchestrator.handle({
      context: { ...context, event: "event-confirm-replay", requestId: "request-confirm-replay" },
      input: { text: "confirm", pendingActionId: pending.body.actionId, confirmationCode: "482913" },
    });
    assert.deepEqual(first.body.result, { saved: true });
    assert.deepEqual(replay.body.result, { saved: true });
    assert.equal(calls, 1);
  });

  it("keeps help, cancel, clarify, and unknown as safe text responses", async () => {
    for (const status of ["help", "cancelled", "clarify", "unknown"]) {
      const runtime = fakeRuntime();
      let calls = 0;
      const orchestrator = createAssistantOrchestrator({ ...runtime, router: routerFor({ status, message: "safe", question: "safe" }), toolHandlers: { "customer.search": () => { calls += 1; } } });
      const result = await orchestrator.handle({ context: { ...context, event: `event-${status}`, requestId: `request-${status}` }, input: { text: status } });
      assert.equal(result.status, 200);
      assert.equal(result.body.status, status === "cancelled" ? "cancel" : status);
      assert.equal(calls, 0);
    }
  });

  it("fails closed when a planned tool is not registered or its handler throws", async () => {
    const runtime = fakeRuntime();
    const orchestrator = createAssistantOrchestrator({ ...runtime, registry: registryFor("customer.search", "R0"), router: routerFor({ status: "planned", toolName: "customer.search", agentId: "test-agent", arguments: { value: "x" }, risk: "R0" }), toolHandlers: { "customer.search": () => { throw new Error("secret internals"); } } });
    const result = await orchestrator.handle({ context: { ...context, event: "event-fail", requestId: "request-fail" }, input: { text: "run" } });
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "处理失败，请稍后重试。");
    assert.doesNotMatch(JSON.stringify(result.body), /secret internals/);
  });

  it("passes only server-owned media metadata to a tool handler", async () => {
    const runtime = fakeRuntime();
    let received;
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor("invoice.ingest", "R1"),
      router: routerFor({ status: "planned", toolName: "invoice.ingest", agentId: "test-agent", arguments: { value: "media-1" }, risk: "R1" }),
      toolHandlers: {
        "invoice.ingest": (args, safeContext, serverData) => {
          received = { args, safeContext, serverData };
          return { accepted: true };
        },
      },
    });
    const result = await orchestrator.handle({
      context,
      input: { text: "/发票 attacker-path", owner: "attacker" },
      serverData: { media: { sourceRef: "media-1", sha256: "a".repeat(64), contentBase64: "AA==" } },
    });
    assert.equal(result.status, 200);
    assert.equal(received.args.value, "media-1");
    assert.deepEqual(received.serverData, { media: { sourceRef: "media-1", sha256: "a".repeat(64), contentBase64: "AA==" } });
    assert.equal(received.safeContext.owner, context.owner);
    assert.doesNotMatch(JSON.stringify(received.serverData), /attacker-path/);
  });

  it("records and completes one durable tool run for an executable event", async () => {
    const runtime = fakeRuntime();
    const runs = [];
    let runSequence = 0;
    runtime.eventRepository.createToolRun = (input) => {
      runs.push(["create", input]);
      return { item: { id: `tool-run-${++runSequence}`, status: "queued" }, replayed: false };
    };
    runtime.eventRepository.claimToolRun = (id) => {
      runs.push(["claim", id]);
      return { item: { id, status: "running" }, replayed: false, leaseToken: `lease-${id}` };
    };
    runtime.eventRepository.completeToolRun = (id, input) => {
      runs.push(["complete", id, input]);
      return { item: { id, status: "completed", output: input.output }, replayed: false };
    };
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor("customer.search", "R0"),
      router: routerFor({ status: "planned", toolName: "customer.search", agentId: "test-agent", arguments: { value: "hospital" }, risk: "R0" }),
      toolHandlers: { "customer.search": () => ({ matches: 1 }) },
    });
    const result = await orchestrator.handle({ context, input: { text: "search" } });
    assert.equal(result.status, 200);
    assert.deepEqual(runs.map(([kind]) => kind), ["create", "claim", "complete"]);
    assert.equal(runs[2][2].leaseToken, "lease-tool-run-1");
  });

  it("uses the pending action identity as the durable tool-run key", async () => {
    const runtime = fakeRuntime();
    const plan = {
      status: "confirmation_required",
      toolName: "visit-capture.confirm",
      agentId: "test-agent",
      arguments: { value: "draft-1" },
      risk: "R2",
      confirmation: "simple",
    };
    let createdInput;
    runtime.eventRepository.createToolRun = (input) => {
      createdInput = input;
      return { item: { id: "tool-run-action", status: "queued" }, replayed: false };
    };
    runtime.eventRepository.claimToolRun = () => ({
      item: { id: "tool-run-action", status: "running" },
      replayed: false,
      leaseToken: "test-machine-token",
    });
    runtime.eventRepository.completeToolRun = () => ({
      item: { id: "tool-run-action", status: "completed", output: { saved: true } },
      replayed: false,
    });
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => ({ saved: true }) },
    });
    const pending = await orchestrator.handle({ context, input: { text: "save" } });
    await orchestrator.handle({
      context: { ...context, event: "event-action-tool-run", requestId: "request-action-tool-run" },
      input: { text: "confirm", pendingActionId: pending.body.actionId, confirmationCode: "482913" },
    });
    assert.equal(createdInput.eventId, `assistant-action:${pending.body.actionId}`);
    assert.match(createdInput.requestHash, /^[0-9a-f]{64}$/);
  });

  it("marks a confirmed action executed when its durable tool result is replayed", async () => {
    const runtime = fakeRuntime();
    const plan = {
      status: "confirmation_required",
      toolName: "visit-capture.confirm",
      agentId: "test-agent",
      arguments: { value: "draft-1" },
      risk: "R2",
      confirmation: "simple",
    };
    let handlerCalls = 0;
    runtime.eventRepository.createToolRun = () => ({
      item: { id: "tool-run-completed", status: "completed", output: { saved: true } },
      replayed: true,
    });
    runtime.eventRepository.claimToolRun = () => {
      throw new Error("a completed tool run must not be claimed again");
    };
    runtime.eventRepository.completeToolRun = () => {
      throw new Error("a completed tool run must not be completed again");
    };
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: {
        [plan.toolName]: () => {
          handlerCalls += 1;
          return { saved: false };
        },
      },
    });

    const pending = await orchestrator.handle({ context, input: { text: "save" } });
    const replay = await orchestrator.handle({
      context: { ...context, event: "event-confirm-tool-replay", requestId: "request-confirm-tool-replay" },
      input: {
        text: "confirm",
        pendingActionId: pending.body.actionId,
        confirmationCode: "482913",
      },
    });

    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.result, { saved: true });
    assert.equal(handlerCalls, 0);
    assert.equal(
      runtime.pendingActionRepository.get(pending.body.actionId, {
        owner: context.owner,
        channel: context.channel,
        conversationId: `${context.owner}:${context.channel}:${context.conversation}`,
      }).status,
      "executed",
    );
  });
});
