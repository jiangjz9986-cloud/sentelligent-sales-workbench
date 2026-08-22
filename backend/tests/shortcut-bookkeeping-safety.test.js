import assert from "node:assert/strict";
import test from "node:test";

import {
  createShortcutBookkeepingAssistantRuntime,
  deriveShortcutConfirmationCode,
} from "../src/assistant/shortcutBookkeepingRuntime.js";

const fixtureMaterial = Buffer.alloc(32, 0x41);

function makeRuntimeHarness({
  failCompletionOnce = true,
  failAcceptedEnqueueOnce = false,
  failDraftUpdateOnce = false,
} = {}) {
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
    failAcceptedEnqueueOnce,
    failDraftUpdateOnce,
    currentCode: deriveShortcutConfirmationCode("action-1", 1, fixtureMaterial),
  };

  const pendingActionRepository = {
    confirm(_id, input) {
      if (input.confirmationCode !== state.currentCode) {
        const error = new Error("invalid confirmation code");
        error.code = "ASSISTANT_CONFIRMATION_INVALID";
        throw error;
      }
      if (state.action.status === "pending") state.action.status = "confirmed";
      return { item: structuredClone(state.action), replayed: true };
    },
    claimExecution() {
      return { item: structuredClone(state.action), replayed: false, inProgress: false, leaseToken: "test-token" };
    },
    completeExecution() {
      state.completeExecutionCalls += 1;
      if (failCompletionOnce && state.completeExecutionCalls === 1) {
        throw new Error("simulated pending action completion failure");
      }
      state.action.status = "executed";
      return { item: structuredClone(state.action), replayed: false };
    },
    releaseExecution() {
      state.action.status = "confirmed";
      return { item: structuredClone(state.action), replayed: false };
    },
    renewConfirmation(_id, input) {
      state.action.status = "pending";
      state.action.version += 1;
      state.currentCode = input.confirmationCode;
      return { item: structuredClone(state.action), confirmationCode: input.confirmationCode };
    },
  };

  const shortcutBookkeepingRepository = {
    getReview() {
      return structuredClone(state.entry);
    },
    claimReview() {
      return { item: structuredClone(state.entry), leaseToken: "test-token", replayed: false };
    },
    completeLocal(_id, input = {}) {
      if (input.reviewPatch && state.failDraftUpdateOnce) {
        state.failDraftUpdateOnce = false;
        throw new Error("simulated draft update failure");
      }
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
      if (input.payload?.kind === "accepted") {
        if (state.failAcceptedEnqueueOnce) {
          state.failAcceptedEnqueueOnce = false;
          throw new Error("simulated accepted outbox failure");
        }
        const existing = state.acceptedOutbox.find((item) => item.idempotencyKey === input.idempotencyKey);
        if (existing) return { ...existing, replayed: true };
        state.acceptedOutbox.push(input);
      }
      return { id: `outbox-${state.acceptedOutbox.length}`, status: "queued" };
    },
  };

  const db = {
    prepare() {
      return {
        all() {
          if (state.action.status !== "executed" || state.entry.status !== "accepted") return [];
          return [{
            action_id: state.action.id,
            owner: state.action.owner,
            conversation_id: state.action.conversationId,
            version: state.action.version,
            action_status: state.action.status,
            entry_id: state.entry.id,
            entry_status: state.entry.status,
          }];
        },
      };
    },
  };

  const runtime = createShortcutBookkeepingAssistantRuntime({
    db,
    config: {
      shortcutWeixinConfirmationEnabled: true,
      weixinBookkeepingSenderId: "sender-1",
      weixinBookkeepingOwner: "assistant-owner",
      weixinAllowedSenderIds: ["sender-1"],
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
    text: deriveShortcutConfirmationCode("action-1", 1, fixtureMaterial),
    textClassification: { kind: "code" },
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
  assert.equal(state.acceptedOutbox[0].idempotencyKey, "shortcut-bookkeeping:entry-1:accepted:v1");
});

test("reconciles a missing accepted receipt after action completion without duplicating it", async () => {
  const { runtime, state } = makeRuntimeHarness({
    failCompletionOnce: false,
    failAcceptedEnqueueOnce: true,
  });
  const code = deriveShortcutConfirmationCode("action-1", 1, fixtureMaterial);
  const result = await runtime.handlePending({
    action: state.action,
    scope: { owner: "assistant-owner", channel: "weixin", conversationId: "conversation-1" },
    context: { owner: "assistant-owner" },
    text: code,
    textClassification: { kind: "code" },
  });
  assert.equal(result.status, 200);
  assert.equal(state.action.status, "executed");
  assert.equal(state.entry.status, "accepted");
  assert.equal(state.acceptedOutbox.length, 0);

  runtime.reconcileAcceptedReceipts();
  runtime.reconcileAcceptedReceipts();
  assert.equal(state.acceptedOutbox.length, 1);
  assert.equal(state.acceptedOutbox[0].idempotencyKey, "shortcut-bookkeeping:entry-1:accepted:v1");
});

test("rotates the confirmation code before a draft update can fail", async () => {
  const { runtime, state } = makeRuntimeHarness({
    failCompletionOnce: false,
    failDraftUpdateOnce: true,
  });
  const oldCode = state.currentCode;
  await assert.rejects(() => runtime.handlePending({
    action: state.action,
    scope: { owner: "assistant-owner", channel: "weixin", conversationId: "conversation-1" },
    context: { owner: "assistant-owner" },
    text: "金额改为 18.50 元",
    textClassification: { kind: "ordinary" },
  }), /simulated draft update failure/u);
  assert.notEqual(state.currentCode, oldCode);
  assert.equal(state.action.version, 2);

  const stale = await runtime.handlePending({
    action: state.action,
    scope: { owner: "assistant-owner", channel: "weixin", conversationId: "conversation-1" },
    context: { owner: "assistant-owner" },
    text: oldCode,
    textClassification: { kind: "code" },
  });
  assert.equal(stale.status, 409);
  assert.equal(state.entry.status, "review_required");
  assert.equal(state.completeLocalCalls, 0);
});
