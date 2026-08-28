import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  confirmationRequestDigest,
  createAssistantOrchestrator,
} from "../src/assistant/orchestrator.js";

const confirmationSecret = Buffer.alloc(32, 0x41);

function lengthPrefixed(parts) {
  return Buffer.concat(parts.map((part) => {
    const value = Buffer.from(part, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  }));
}

function fakeRuntime() {
  const events = new Map();
  const pending = new Map();
  const confirmationCodes = new Map();
  const confirmationAttempts = new Map();
  const confirmationFailures = [];
  const conversationContexts = new Map();
  const parts = [];
  let sequence = 0;
  const eventRepository = {
    receive(input) {
      const key = `${input.owner}:${input.channel}:${input.eventId}`;
      const existing = events.get(key);
      if (existing) return { item: existing, replayed: true };
      const item = { id: `event-${++sequence}`, status: "received", response: null, received: structuredClone(input) };
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
    getContext(conversationId) { return conversationContexts.get(conversationId) ?? {}; },
    appendDraftPart(conversationId, part) {
      parts.push({ conversationId, ...part });
      if (part.metadata?.assistantContext) conversationContexts.set(conversationId, structuredClone(part.metadata.assistantContext));
    },
  };
  const pendingActionRepository = {
    create(input) {
      const planDigest = createHash("sha256").update(JSON.stringify(input.payload?.plan ?? input.payload), "utf8").digest("hex");
      const action = { id: `action-${++sequence}`, ...input, planDigest, status: "pending" };
      confirmationCodes.set(action.id, action.confirmationCode);
      confirmationAttempts.set(action.id, 0);
      delete action.confirmationCode;
      pending.set(action.id, action);
      return action;
    },
    get(id, scope) {
      if (!Object.hasOwn(scope, "conversationId")) throw new TypeError("conversationId is required");
      const action = pending.get(id);
      return action
        && action.owner === scope.owner
        && action.channel === scope.channel
        && action.conversationId === scope.conversationId
        ? action
        : null;
    },
    findActiveByConversation({ owner, channel, conversationId }) {
      const matches = [...pending.values()].filter((action) => (
        action.owner === owner
        && action.channel === channel
        && action.conversationId === conversationId
        && ["pending", "confirmed", "processing"].includes(action.status)
      ));
      if (matches.length > 1) throw Object.assign(new Error("invariant"), { status: 500 });
      return matches[0] ?? null;
    },
    confirm(id, { owner, channel, conversationId, confirmationCode }) {
      const action = this.get(id, { owner, channel, conversationId });
      if (!action || confirmationCodes.get(id) !== confirmationCode) throw Object.assign(new Error("invalid"), { status: 409, code: "ASSISTANT_CONFIRMATION_INVALID" });
      if (action.status === "processing") return { item: action, replayed: true, inProgress: true };
      if (action.status === "executed") return { item: action, replayed: true };
      action.status = "confirmed";
      return { item: action, replayed: false };
    },
    recordConfirmationFailure(id, { owner, channel, conversationId, eventId }) {
      const action = this.get(id, { owner, channel, conversationId });
      if (!action) throw Object.assign(new Error("missing"), { status: 404 });
      if (confirmationFailures.some((entry) => entry.id === id && entry.eventId === eventId)) {
        return { item: action, counted: false, locked: false };
      }
      confirmationFailures.push({ id, owner, channel, conversationId, eventId });
      confirmationAttempts.set(id, confirmationAttempts.get(id) + 1);
      return { item: action, counted: true, locked: false };
    },
    cancel(id, { owner, channel, conversationId }) {
      const action = this.get(id, { owner, channel, conversationId });
      if (!action) throw Object.assign(new Error("missing"), { status: 404 });
      action.status = "cancelled";
      return { item: action, replayed: false };
    },
    renewConfirmation(id, { owner, channel, conversationId, confirmationCode }) {
      const action = this.get(id, { owner, channel, conversationId });
      if (!action) throw Object.assign(new Error("missing"), { status: 404 });
      confirmationCodes.set(id, confirmationCode);
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
  return {
    eventRepository,
    sessionRepository,
    pendingActionRepository,
    confirmationSecret,
    events,
    pending,
    parts,
    confirmationAttempts,
    confirmationFailures,
    conversationContexts,
  };
}

const context = Object.freeze({ owner: "owner-a", channel: "weixin", conversation: "conversation-a", event: "event-a", requestId: "request-a" });

function registryFor(toolName, risk, confirmation = "none") {
  const tool = { name: toolName, agentId: "test-agent", description: "确认写入拜访记录", arguments: { value: { type: "string", required: true } }, policy: { risk, confirmation } };
  return { getTool(name) { return name === toolName ? tool : null; } };
}

function routerFor(plan) { return { route() { return { ...plan }; } }; }

describe("assistant orchestrator", () => {
  it("binds confirmation request digests to the exact scoped code and media domain", () => {
    const input = {
      owner: "owner-a",
      channel: "weixin",
      conversation: "conversation-a",
      code: "482913",
      mediaSha256: "a".repeat(64),
      confirmationSecret,
    };
    const expected = createHmac("sha256", confirmationSecret).update(lengthPrefixed([
      "sentelligent/assistant-confirmation-request/v1",
      input.owner,
      input.channel,
      input.conversation,
      input.code,
      input.mediaSha256,
    ])).digest("hex");

    assert.equal(confirmationRequestDigest(input), expected);
    assert.notEqual(confirmationRequestDigest({ ...input, conversation: "conversation-b" }), expected);
    assert.notEqual(confirmationRequestDigest({ ...input, mediaSha256: null }), expected);
  });

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

  it("passes the persisted entity context to the next turn without trusting caller input", async () => {
    const runtime = fakeRuntime();
    const tools = new Map([
      ["customer.detail", { name: "customer.detail", agentId: "customer", description: "客户详情", arguments: {}, policy: { risk: "R0", confirmation: "none" } }],
      ["action-risk.summary", { name: "action-risk.summary", agentId: "action-risk", description: "动作风险", arguments: {}, policy: { risk: "R0", confirmation: "none" } }],
    ]);
    const seenContexts = [];
    const plans = [
      { status: "planned", toolName: "customer.detail", agentId: "customer", arguments: { customerId: "customer-a" }, risk: "R0" },
      { status: "planned", toolName: "action-risk.summary", agentId: "action-risk", arguments: { customerId: "customer-a" }, risk: "R0" },
    ];
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: { getTool(name) { return tools.get(name) ?? null; } },
      router: { route(input) { seenContexts.push(input.context); return plans.shift(); } },
      toolHandlers: {
        "customer.detail": () => ({ status: "ok", customer: { id: "customer-a" } }),
        "action-risk.summary": () => ({ status: "ok", summary: {} }),
      },
    });
    await orchestrator.handle({ context, input: { text: "客户详情" } });
    await orchestrator.handle({
      context: { ...context, event: "event-context-follow-up", requestId: "request-context-follow-up" },
      input: { text: "还有哪些跟进动作？", context: { customerId: "attacker-owned-customer" } },
    });
    assert.deepEqual(seenContexts, [{}, { customerId: "customer-a" }]);
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

  it("shows the first confirmation code live once while persisting only safe projections", async () => {
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
    assert.equal(pending.body.text, [
      "【待确认】",
      "操作：确认写入拜访记录",
      "确认码：482913",
      "",
      "请回复这六位数字，或回复“取消”。",
    ].join("\n"));
    assert.equal(calls, 0);
    assert.equal(JSON.stringify([...runtime.events.values()]).includes("482913"), false);
    assert.equal(JSON.stringify([...runtime.pending.values()]).includes("482913"), false);
    assert.equal(JSON.stringify(runtime.parts).includes("482913"), false);

    const replay = await orchestrator.handle({ context, input: { text: "save" } });
    assert.equal(Object.hasOwn(replay.body, "confirmationCode"), false);
    assert.equal(replay.body.text, "确认码不会重复展示，请在同一会话回复“重发确认码”或“取消”。");
    assert.equal(JSON.stringify(replay.body).includes("482913"), false);

    const confirmed = await orchestrator.handle({ context: { ...context, event: "event-b", requestId: "request-b" }, input: { text: "482913" } });
    assert.deepEqual(confirmed.body.result, { saved: true });
    assert.equal(calls, 1);
    assert.equal(runtime.parts.at(-1).text, "确认信息已处理。");
    assert.equal(JSON.stringify([...runtime.events.values()]).includes("482913"), false);
    assert.equal(JSON.stringify(runtime.parts).includes("482913"), false);
  });

  it("does not create a generic six-digit confirmation for direct Shortcut bookkeeping plans", async () => {
    const runtime = fakeRuntime();
    const plan = {
      status: "planned",
      toolName: "shortcut-bookkeeping.confirm",
      agentId: "test-agent",
      arguments: { value: "entry-1" },
      risk: "R3",
    };
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R3", "explicit_code"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => ({ saved: true }) },
    });
    const response = await orchestrator.handle({ context, input: { text: "快捷记账" } });
    assert.equal(response.status, 409);
    assert.equal(response.body.status, "clarify");
    assert.equal(Object.hasOwn(response.body, "confirmationCode"), false);
    assert.equal(runtime.pending.size, 0);
  });

  it("reissues a scoped code without changing expiry or attempts and stores no code", async () => {
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
    const before = structuredClone(runtime.pending.get(pending.body.actionId));
    const renewed = await orchestrator.handle({
      context: { ...context, event: "event-renew-code", requestId: "request-renew-code" },
      input: { text: "重发确认码" },
    });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.status, "confirmation_required");
    assert.equal(renewed.body.confirmationCode, "731604");
    assert.match(renewed.body.text, /确认码：731604/);
    assert.equal(runtime.pending.get(pending.body.actionId).expiresAt, before.expiresAt);
    assert.equal(runtime.confirmationAttempts.get(pending.body.actionId), 0);
    assert.equal(JSON.stringify([...runtime.events.values()]).includes("731604"), false);
    assert.equal(JSON.stringify(runtime.parts).includes("731604"), false);
    const confirmed = await orchestrator.handle({
      context: { ...context, event: "event-renew-confirm", requestId: "request-renew-confirm" },
      input: { text: "731604" },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(calls, 1);
  });

  it("does not treat near-match text as confirmation or increment attempts", async () => {
    for (const [index, text] of [" 482913", "482913 ", "４８２９１３", "确认 482913"].entries()) {
      const runtime = fakeRuntime();
      const plan = { status: "unknown", toolName: null, agentId: "system-router", arguments: {} };
      const orchestrator = createAssistantOrchestrator({ ...runtime, router: routerFor(plan) });
      runtime.pendingActionRepository.create({
        owner: context.owner,
        channel: context.channel,
        conversationId: `${context.owner}:${context.channel}:${context.conversation}`,
        actionType: "visit-capture.confirm",
        payload: { plan: { status: "confirmation_required", toolName: "visit-capture.confirm", agentId: "test-agent", arguments: { value: "draft-1" }, risk: "R2" } },
        confirmationCode: "482913",
        expiresAt: "2026-08-12T01:10:00.000Z",
      });
      const result = await orchestrator.handle({
        context: { ...context, event: `ordinary-${index}`, requestId: `ordinary-${index}` },
        input: { text },
      });
      assert.equal(result.body.status, "unknown");
      assert.equal(runtime.confirmationFailures.length, 0);
    }
  });

  it("counts one wrong strict scoped code per event and returns only the generic failure", async () => {
    const runtime = fakeRuntime();
    const plan = { status: "confirmation_required", toolName: "visit-capture.confirm", agentId: "test-agent", arguments: { value: "draft-1" }, risk: "R2", confirmation: "simple" };
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => ({ saved: true }) },
    });
    await orchestrator.handle({ context, input: { text: "save" } });
    const failed = await orchestrator.handle({
      context: { ...context, event: "wrong-code-event", requestId: "wrong-code-event" },
      input: { text: "111222" },
    });
    assert.equal(failed.status, 409);
    assert.deepEqual(failed.body, { status: "error", message: "确认信息无效或已过期，请重新发起操作。" });
    assert.equal(runtime.confirmationFailures.length, 1);
    assert.equal(runtime.confirmationFailures[0].eventId, "wrong-code-event");
    await orchestrator.handle({
      context: { ...context, event: "wrong-code-event", requestId: "wrong-code-event" },
      input: { text: "111222" },
    });
    assert.equal(runtime.confirmationFailures.length, 1);
  });

  it("stores only safe draft and event projections when confirmed execution fails", async () => {
    const runtime = fakeRuntime();
    const plan = { status: "confirmation_required", toolName: "visit-capture.confirm", agentId: "test-agent", arguments: { value: "draft-1" }, risk: "R2", confirmation: "simple" };
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => { throw new Error("secret internal failure"); } },
    });
    await orchestrator.handle({ context, input: { text: "save" } });
    const failed = await orchestrator.handle({
      context: { ...context, event: "confirmed-failure", requestId: "confirmed-failure" },
      input: { text: "482913" },
    });
    assert.equal(failed.status, 500);
    assert.equal(runtime.parts.at(-1).text, "确认信息已处理。");
    assert.equal(JSON.stringify([...runtime.events.values()]).includes("482913"), false);
    assert.doesNotMatch(JSON.stringify([...runtime.events.values()]), /secret internal failure/);
  });

  it("cancels a scoped active action and otherwise preserves ordinary draft-clear cancellation", async () => {
    const runtime = fakeRuntime();
    const plan = { status: "confirmation_required", toolName: "visit-capture.confirm", agentId: "test-agent", arguments: { value: "draft-1" }, risk: "R2", confirmation: "simple" };
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
    });
    const pending = await orchestrator.handle({ context, input: { text: "save" } });
    const cancelled = await orchestrator.handle({
      context: { ...context, event: "cancel-action", requestId: "cancel-action" },
      input: { text: "取消" },
    });
    assert.equal(cancelled.body.status, "cancel");
    assert.equal(runtime.pending.get(pending.body.actionId).status, "cancelled");

    const emptyRuntime = fakeRuntime();
    const empty = createAssistantOrchestrator({ ...emptyRuntime, router: routerFor({ status: "cancelled", agentId: "system-router", arguments: {} }) });
    const cleared = await empty.handle({ context: { ...context, event: "cancel-empty", requestId: "cancel-empty" }, input: { text: "取消" } });
    assert.equal(cleared.body.status, "cancel");
    assert.equal(cleared.body.message, "已取消当前操作。");
  });

  it("rejects mismatched structured action and strict structured code without trying either code", async () => {
    const runtime = fakeRuntime();
    const plan = { status: "confirmation_required", toolName: "visit-capture.confirm", agentId: "test-agent", arguments: { value: "draft-1" }, risk: "R2", confirmation: "simple" };
    let calls = 0;
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => { calls += 1; return { saved: true }; } },
    });
    const pending = await orchestrator.handle({ context, input: { text: "save" } });
    for (const [index, input] of [
      { text: "482913", pendingActionId: "different-action", confirmationCode: "482913" },
      { text: "482913", pendingActionId: pending.body.actionId, confirmationCode: " 482913" },
      { text: "482913", pendingActionId: pending.body.actionId, confirmationCode: "731604" },
    ].entries()) {
      const result = await orchestrator.handle({
        context: { ...context, event: `structured-${index}`, requestId: `structured-${index}` },
        input,
      });
      assert.equal(result.status, 409);
      assert.equal(result.body.message, "确认信息无效或已过期，请重新发起操作。");
    }
    assert.equal(calls, 0);
    assert.equal(runtime.confirmationFailures.length, 0);
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
    const planDigest = runtime.pending.get(pending.body.actionId).planDigest;
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
    assert.equal(runtime.pending.get(pending.body.actionId).planDigest, planDigest);
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

    const wrong = await orchestrator.handle({
      context: { ...context, event: "event-confirm-replay-wrong", requestId: "request-confirm-replay-wrong" },
      input: { text: "111222", pendingActionId: pending.body.actionId },
    });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.message, "确认信息无效或已过期，请重新发起操作。");

    const cancelled = await orchestrator.handle({
      context: { ...context, event: "event-confirm-replay-cancel", requestId: "request-confirm-replay-cancel" },
      input: { text: "取消", pendingActionId: pending.body.actionId },
    });
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.body.message, "确认信息无效或已过期，请重新发起操作。");
  });

  it("lets a pending preview provider block without creating an action or code", async () => {
    const runtime = fakeRuntime();
    const plan = { status: "confirmation_required", toolName: "customer.update", agentId: "customer", arguments: { query: "同名", changes: { level: "A" } }, risk: "R2", confirmation: "explicit_code" };
    let handlerCalls = 0;
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "explicit_code"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => { handlerCalls += 1; return { saved: true }; } },
      pendingPreviewProviders: {
        "customer.update": () => ({ block: true, text: "找到 2 个客户，请确认。" }),
      },
    });
    const result = await orchestrator.handle({ context, input: { text: "修改客户 同名，级别A" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "clarify");
    assert.equal(result.body.message, "找到 2 个客户，请确认。");
    assert.equal(runtime.pending.size, 0);
    assert.equal(handlerCalls, 0);
    assert.equal(JSON.stringify([...runtime.events.values()]).includes("482913"), false);
  });

  it("stores provider-enriched arguments and executes them after confirmation", async () => {
    const runtime = fakeRuntime();
    const plan = { status: "confirmation_required", toolName: "customer.update", agentId: "customer", arguments: { query: "示例医院", changes: { level: "A" } }, risk: "R2", confirmation: "explicit_code" };
    let handlerArgs = null;
    const previewText = "【客户改档待确认】示例医院 [customer-1]（当前 v3）\n级别：重点 → A";
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "explicit_code"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: {
        [plan.toolName]: (args) => { handlerArgs = args; return { updated: true }; },
      },
      pendingPreviewProviders: {
        "customer.update": ({ arguments: argumentsValue }) => ({
          arguments: {
            customerId: "customer-1",
            expectedVersion: 3,
            changes: argumentsValue.changes,
          },
          previewText,
        }),
      },
    });
    const pending = await orchestrator.handle({ context, input: { text: "修改客户 示例医院，级别A" } });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    assert.ok(pending.body.text.startsWith(previewText), "live text must begin with the preview card");
    assert.match(pending.body.text, /确认码：482913/);
    const storedAction = runtime.pending.get(pending.body.actionId);
    assert.deepEqual(storedAction.payload.plan.arguments, {
      customerId: "customer-1",
      expectedVersion: 3,
      changes: { level: "A" },
    });
    assert.equal(storedAction.payload.preview, previewText);
    assert.equal(JSON.stringify([...runtime.events.values()]).includes("482913"), false);
    const storedEvent = [...runtime.events.values()].find((event) => JSON.stringify(event.response ?? {}).includes("confirmation_required"));
    assert.ok(storedEvent);
    assert.equal(JSON.stringify(storedEvent.response).includes("【客户改档待确认】"), false);

    const confirmed = await orchestrator.handle({
      context: { ...context, event: "event-preview-confirm", requestId: "request-preview-confirm" },
      input: { text: "482913" },
    });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(handlerArgs, {
      customerId: "customer-1",
      expectedVersion: 3,
      changes: { level: "A" },
    });
  });

  it("re-sends the stored preview with a renewed confirmation code", async () => {
    const runtime = fakeRuntime();
    const plan = { status: "confirmation_required", toolName: "customer.delete", agentId: "customer", arguments: { query: "测试医院" }, risk: "R3", confirmation: "explicit_code" };
    const codes = ["482913", "731604"];
    const previewText = "【客户删档待确认】测试医院 [customer-9]（当前 v5）";
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R3", "explicit_code"),
      router: routerFor(plan),
      confirmationCodeFactory: () => codes.shift(),
      toolHandlers: { [plan.toolName]: () => ({ deleted: true }) },
      pendingPreviewProviders: {
        "customer.delete": () => ({
          arguments: { customerId: "customer-9", expectedVersion: 5 },
          previewText,
        }),
      },
    });
    await orchestrator.handle({ context, input: { text: "删除客户 测试医院" } });
    const renewed = await orchestrator.handle({
      context: { ...context, event: "event-preview-renew", requestId: "request-preview-renew" },
      input: { text: "重发确认码" },
    });
    assert.equal(renewed.status, 200);
    assert.ok(renewed.body.text.startsWith(previewText), "renewed text must repeat the preview card");
    assert.match(renewed.body.text, /确认码：731604/);
    assert.equal(JSON.stringify([...runtime.events.values()]).includes("731604"), false);
  });

  it("fails closed when a pending preview provider throws", async () => {
    const runtime = fakeRuntime();
    const plan = { status: "confirmation_required", toolName: "customer.update", agentId: "customer", arguments: { query: "示例医院", changes: { level: "A" } }, risk: "R2", confirmation: "explicit_code" };
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "explicit_code"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => ({ saved: true }) },
      pendingPreviewProviders: {
        "customer.update": () => { throw new Error("secret provider failure"); },
      },
    });
    const result = await orchestrator.handle({ context, input: { text: "修改客户 示例医院，级别A" } });
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "处理失败，请稍后重试。");
    assert.equal(runtime.pending.size, 0);
    assert.doesNotMatch(JSON.stringify([...runtime.events.values()]), /secret provider failure/);
  });

  it("keeps confirmation flows without a provider byte-identical to the previous contract", async () => {
    const runtime = fakeRuntime();
    const plan = { status: "confirmation_required", toolName: "visit-capture.confirm", agentId: "test-agent", arguments: { value: "draft-1" }, risk: "R2", confirmation: "simple" };
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: routerFor(plan),
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => ({ saved: true }) },
      pendingPreviewProviders: {
        "customer.update": () => { throw new Error("must not be called for other tools"); },
      },
    });
    const pending = await orchestrator.handle({ context, input: { text: "save" } });
    assert.equal(pending.body.text, [
      "【待确认】",
      "操作：确认写入拜访记录",
      "确认码：482913",
      "",
      "请回复这六位数字，或回复“取消”。",
    ].join("\n"));
    assert.equal(Object.hasOwn(runtime.pending.get(pending.body.actionId).payload, "preview"), false);
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

describe("affirm-language confirmations (v0.7.3)", () => {
  const capturePlan = Object.freeze({
    status: "confirmation_required",
    toolName: "visit-capture.capture",
    agentId: "test-agent",
    arguments: { value: "今天拜访了日照中医医院" },
    risk: "R1",
    confirmation: "affirm_language",
  });

  function affirmOrchestrator(runtime, { handler, previewProvider, plan = capturePlan } = {}) {
    return createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, plan.risk, plan.confirmation ?? "affirm_language"),
      router: routerFor(plan),
      confirmationCodeFactory: () => {
        throw new Error("affirm tools must not consume the user-facing code factory");
      },
      toolHandlers: { [plan.toolName]: handler ?? (() => ({ recorded: true })) },
      ...(previewProvider ? { pendingPreviewProviders: { [plan.toolName]: previewProvider } } : {}),
    });
  }

  it("creates an affirm pending action without any code and stores the same body", async () => {
    const runtime = fakeRuntime();
    const orchestrator = affirmOrchestrator(runtime, {
      previewProvider: async () => ({
        arguments: { value: "今天拜访了日照中医医院" },
        previewText: "【拜访记录待确认】\n诉求：补齐材料",
      }),
    });
    const response = await orchestrator.handle({ context, input: { text: "记一下：今天拜访了日照中医医院" } });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "confirmation_required");
    assert.equal(Object.hasOwn(response.body, "confirmationCode"), false, "no code key in the live body");
    assert.match(response.body.text, /【拜访记录待确认】/);
    assert.match(response.body.text, /请回复“确认”或“取消”。/);
    assert.equal(/(?<!\d)\d{6}(?!\d)/u.test(response.body.text), false, "no six-digit code in the live text");
    const stored = [...runtime.events.values()][0];
    assert.deepEqual(stored.response, response.body, "stored body equals public body, nothing to scrub");
    const action = runtime.pending.get(response.body.actionId);
    assert.equal(action.actionType, "visit-capture.capture");
    assert.equal(action.status, "pending");
  });

  it("executes on a bare 确认 and replays the identical event response", async () => {
    const runtime = fakeRuntime();
    let calls = 0;
    const orchestrator = affirmOrchestrator(runtime, {
      handler: (args, handlerContext) => {
        calls += 1;
        return { recorded: true, actionId: handlerContext.actionId, value: args.value };
      },
    });
    const pending = await orchestrator.handle({ context, input: { text: "记一下：今天拜访了日照中医医院" } });
    const confirmed = await orchestrator.handle({
      context: { ...context, event: "event-affirm-confirm", requestId: "request-affirm-confirm" },
      input: { text: "确认" },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.status, "ok");
    assert.equal(confirmed.body.result.recorded, true);
    assert.equal(confirmed.body.result.actionId, pending.body.actionId);
    assert.equal(calls, 1);
    assert.equal(runtime.pending.get(pending.body.actionId).status, "executed");

    const replay = await orchestrator.handle({
      context: { ...context, event: "event-affirm-confirm", requestId: "request-affirm-confirm" },
      input: { text: "确认" },
    });
    assert.deepEqual(replay.body, confirmed.body);
    assert.equal(calls, 1, "the event replay must not run the handler again");
  });

  it("guides six-digit texts and resend without counting confirmation failures", async () => {
    const runtime = fakeRuntime();
    const orchestrator = affirmOrchestrator(runtime, {
      previewProvider: async () => ({
        arguments: { value: "今天拜访了日照中医医院" },
        previewText: "【拜访记录待确认】",
      }),
    });
    const pending = await orchestrator.handle({ context, input: { text: "记一下：今天拜访了日照中医医院" } });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const guided = await orchestrator.handle({
        context: { ...context, event: `event-affirm-code-${attempt}`, requestId: `request-affirm-code-${attempt}` },
        input: { text: "123456" },
      });
      assert.equal(guided.status, 200);
      assert.equal(guided.body.status, "clarify");
      assert.match(guided.body.text, /本操作无需确认码/);
    }
    assert.equal(runtime.confirmationFailures.length, 0, "guidance must not count as wrong codes");
    assert.equal(runtime.confirmationAttempts.get(pending.body.actionId), 0);

    const resent = await orchestrator.handle({
      context: { ...context, event: "event-affirm-resend", requestId: "request-affirm-resend" },
      input: { text: "重发确认码" },
    });
    assert.equal(resent.body.status, "confirmation_required");
    assert.match(resent.body.text, /【拜访记录待确认】/, "resend replays the preview card");
    assert.match(resent.body.text, /请回复“确认”或“取消”。/);
    assert.equal(Object.hasOwn(resent.body, "confirmationCode"), false);

    const stillConfirmable = await orchestrator.handle({
      context: { ...context, event: "event-affirm-final-confirm", requestId: "request-affirm-final-confirm" },
      input: { text: "确认" },
    });
    assert.equal(stillConfirmable.body.status, "ok", "the pending action stays confirmable after code texts");
  });

  it("cancels an affirm pending action with the generic 取消", async () => {
    const runtime = fakeRuntime();
    const orchestrator = affirmOrchestrator(runtime);
    const pending = await orchestrator.handle({ context, input: { text: "记一下：今天拜访了日照中医医院" } });
    const cancelled = await orchestrator.handle({
      context: { ...context, event: "event-affirm-cancel", requestId: "request-affirm-cancel" },
      input: { text: "取消" },
    });
    assert.equal(cancelled.body.status, "cancel");
    assert.equal(runtime.pending.get(pending.body.actionId).status, "cancelled");
  });

  it("keeps a bare 确认 on the router path while a code-confirmed action is pending", async () => {
    const runtime = fakeRuntime();
    const plan = {
      status: "confirmation_required",
      toolName: "visit-capture.confirm",
      agentId: "test-agent",
      arguments: { value: "draft-1" },
      risk: "R2",
      confirmation: "simple",
    };
    let routedTexts = [];
    const orchestrator = createAssistantOrchestrator({
      ...runtime,
      registry: registryFor(plan.toolName, "R2", "simple"),
      router: { route(input) { routedTexts.push(input.text); return input.text === "确认" ? { status: "clarify", question: "当前没有待确认的操作。" } : { ...plan }; } },
      confirmationCodeFactory: () => "482913",
      toolHandlers: { [plan.toolName]: () => ({ saved: true }) },
    });
    const pending = await orchestrator.handle({ context, input: { text: "录入" } });
    assert.equal(pending.body.status, "confirmation_required");
    const bareAffirm = await orchestrator.handle({
      context: { ...context, event: "event-code-bare-affirm", requestId: "request-code-bare-affirm" },
      input: { text: "确认" },
    });
    assert.equal(bareAffirm.body.status, "clarify");
    assert.equal(bareAffirm.body.message, "当前没有待确认的操作。");
    assert.deepEqual(routedTexts, ["录入", "确认"], "bare 确认 falls through to the router for code tools");
    assert.equal(runtime.pending.get(pending.body.actionId).status, "pending", "the code action is untouched");
  });

  it("fails safely when the affirm preview provider throws", async () => {
    const runtime = fakeRuntime();
    const orchestrator = affirmOrchestrator(runtime, {
      previewProvider: async () => { throw new Error("provider exploded"); },
    });
    const response = await orchestrator.handle({ context, input: { text: "记一下：今天拜访了日照中医医院" } });
    assert.equal(response.status, 500);
    assert.equal(response.body.message, "处理失败，请稍后重试。");
    assert.equal(runtime.pending.size, 0, "no pending action is created on provider failure");
  });
});
