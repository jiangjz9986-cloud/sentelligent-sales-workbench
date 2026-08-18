import assert from "node:assert/strict";
import test from "node:test";

import { createShortcutBookkeepingAssistantRuntime } from "../src/assistant/shortcutBookkeepingRuntime.js";

const fixtureMaterial = Buffer.alloc(32, 0x41);

function makeRuntimeHarness() {
  const state = {
    action: {
      id: "action-1",
      owner: "assistant-owner",
      channel: "weixin",
      conversationId: "conversation-1",
      actionType: "shortcut-bookkeeping.confirm",
      status: "pending",
      version: 1,
      payload: { entryId: "entry-1" },
    },
    entry: {
      id: "entry-1",
      owner: "assistant-owner",
      status: "review_required",
      amountCents: 1280,
      analysis: {
        status: "ready",
        warnings: [],
        expense: {
          occurredOn: "2026-08-18",
          amountCents: 1280,
          purpose: "客户拜访交通",
        },
      },
      expenseId: null,
      paymentId: null,
    },
    completeExecutionCalls: 0,
    completeLocalCalls: 0,
    acceptedOutbox: [],
  };

  const pendingActionRepository = {
    confirm() {
      if (state.action.status === "pending") state.action.status = "confirmed";
      return { item: structuredClone(state.action), replayed: true };
    },
    claimExecution() {
      return { item: structuredClone(state.action), replayed: false, inProgress: false, leaseToken: "test-token" };
    },
    completeExecution() {
      state.completeExecutionCalls += 1;
      if (state.completeExecutionCalls === 1) {
        throw new Error("simulated pending action completion failure");
      }
      state.action.status = "executed";
      return { item: structuredClone(state.action), replayed: false };
    },
    releaseExecution() {
      state.action.status = "confirmed";
      return { item: structuredClone(state.action), replayed: false };
    },
  };

  const shortcutBookkeepingRepository = {
    getReview() {
      return structuredClone(state.entry);
    },
    claimReview() {
      return { item: structuredClone(state.entry), leaseToken: "test-token", replayed: false };
    },
    completeLocal() {
      state.completeLocalCalls += 1;
      state.entry = {
        ...state.entry,
        status: "accepted",
        expenseId: "expense-1",
        paymentId: "payment-1",
      };
      return { item: structuredClone(state.entry), replayed: false };
    },
    release() {
      return { item: structuredClone(state.entry), replayed: true };
    },
  };

  const outboxRepository = {
    enqueue(input) {
      if (input.payload?.kind === "accepted") state.acceptedOutbox.push(input);
      return { id: `outbox-${state.acceptedOutbox.length}`, status: "queued" };
    },
  };

  const runtime = createShortcutBookkeepingAssistantRuntime({
    db: {},
    config: {
      shortcutWeixinConfirmationEnabled: true,
      weixinBookkeepingSenderId: "sender-1",
      weixinBookkeepingOwner: "assistant-owner",
    },
    shortcutBookkeepingRepository,
    pendingActionRepository,
    sessionRepository: {},
    outboxRepository,
      confirmationSecret: fixtureMaterial,
  });

  return { runtime, state };
}

test("reconciles an accepted financial entry after pending action completion fails", async () => {
  const { runtime, state } = makeRuntimeHarness();
  const input = {
    action: state.action,
    scope: { owner: "assistant-owner", channel: "weixin", conversationId: "conversation-1" },
    context: { owner: "assistant-owner" },
    text: "123456",
    textClassification: { kind: "code", code: "123456" },
    confirmationCode: "123456",
  };

  await assert.rejects(() => runtime.handlePending(input), /simulated pending action completion failure/);
  assert.equal(state.completeLocalCalls, 1);
  assert.equal(state.entry.status, "accepted");
  assert.equal(state.action.status, "confirmed");

  const replay = await runtime.handlePending(input);
  assert.equal(replay.status, 200);
  assert.match(replay.body.text, /已经完成|已确认并录入/);
  assert.equal(state.completeLocalCalls, 1, "recovery must not duplicate the financial write");
  assert.equal(state.completeExecutionCalls, 2);
  assert.equal(state.action.status, "executed");
  assert.equal(state.acceptedOutbox.length, 1, "recovery must enqueue the accepted receipt exactly once");
  assert.equal(state.acceptedOutbox[0].payload.entryId, "entry-1");
  assert.equal(state.acceptedOutbox[0].payload.kind, "accepted");
});
