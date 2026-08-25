import assert from "node:assert/strict";
import test from "node:test";

import { createShortcutBookkeepingAssistantRuntime } from "../src/assistant/shortcutBookkeepingRuntime.js";

const fixtureMaterial = Buffer.alloc(32, 0x41);

function makeRuntimeHarness({
  failCompletionOnce = true,
  failAcceptedEnqueueOnce = false,
  failDraftUpdateOnce = false,
  failFinancialWriteOnce = false,
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
      ledgerName: "出差报销",
      entryType: "expense",
      category: "交通",
      subcategory: null,
      note: null,
      amountCents: 1280,
      analysis: {
        status: "ready",
        category: "交通",
        subcategory: null,
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
    failFinancialWriteOnce,
    currentStateCredential: null,
    deliveredDraftVersion: 1,
  };

  const pendingActionRepository = {
    confirm(_id, input) {
      assert.match(input.confirmationCode, /^\d{6}$/u, "the repository compatibility credential stays internal");
      if (state.currentStateCredential && input.confirmationCode !== state.currentStateCredential) {
        const error = new Error("invalid internal state credential");
        error.code = "ASSISTANT_CONFIRMATION_INVALID";
        throw error;
      }
      state.currentStateCredential = input.confirmationCode;
      const replayed = state.action.status !== "pending";
      if (!replayed) state.action = { ...state.action, status: "confirmed", version: state.action.version + 1 };
      return { item: structuredClone(state.action), replayed };
    },
    claimExecution() {
      if (state.action.status === "executed") {
        return { item: structuredClone(state.action), replayed: true, inProgress: false };
      }
      state.action = { ...state.action, status: "processing", version: state.action.version + 1 };
      return { item: structuredClone(state.action), replayed: false, inProgress: false, leaseToken: "test-token" };
    },
    completeExecution() {
      state.completeExecutionCalls += 1;
      if (failCompletionOnce && state.completeExecutionCalls === 1) {
        throw new Error("simulated pending action completion failure");
      }
      state.action = { ...state.action, status: "executed", version: state.action.version + 1 };
      return { item: structuredClone(state.action), replayed: false };
    },
    releaseExecution() {
      state.action = { ...state.action, status: "confirmed", version: state.action.version + 1 };
      return { item: structuredClone(state.action), replayed: false };
    },
    renewConfirmation(_id, input) {
      state.action = { ...state.action, status: "pending", version: state.action.version + 1 };
      state.currentStateCredential = input.confirmationCode;
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
      if (!input.reviewPatch && state.failFinancialWriteOnce) {
        state.failFinancialWriteOnce = false;
        throw new Error("simulated financial write failure");
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
      if (["confirmation", "correction"].includes(input.payload?.kind)) {
        state.deliveredDraftVersion = input.payload.version;
      }
      return { id: `outbox-${state.acceptedOutbox.length}`, status: "queued" };
    },
    latestForEntry() {
      return {
        status: "sent",
        payload: {
          actionId: state.action.id,
          entryId: state.entry.id,
          version: state.deliveredDraftVersion,
          kind: "confirmation",
        },
      };
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
      weixinBookkeepingConfirmationEnabled: true,
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

function pendingInput(state, text) {
  return {
    action: structuredClone(state.action),
    scope: { owner: "assistant-owner", channel: "weixin", conversationId: "conversation-1" },
    context: { owner: "assistant-owner" },
    text,
    textClassification: { kind: "ordinary" },
  };
}

test("reconciles an accepted financial entry after pending action completion fails", async () => {
  const { runtime, state } = makeRuntimeHarness();
  await assert.rejects(() => runtime.handlePending(pendingInput(state, "确认")), /simulated pending action completion failure/);
  assert.equal(state.completeLocalCalls, 1);
  assert.equal(state.entry.status, "accepted");
  assert.equal(state.action.status, "confirmed");

  const replay = await runtime.handlePending(pendingInput(state, "确认"));
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
  const result = await runtime.handlePending(pendingInput(state, "确认"));
  assert.equal(result.status, 200);
  assert.equal(state.action.status, "executed");
  assert.equal(state.entry.status, "accepted");
  assert.equal(state.acceptedOutbox.length, 0);

  runtime.reconcileAcceptedReceipts();
  runtime.reconcileAcceptedReceipts();
  assert.equal(state.acceptedOutbox.length, 1);
  assert.equal(state.acceptedOutbox[0].idempotencyKey, "shortcut-bookkeeping:entry-1:accepted:v1");
});

test("blocks confirmation when a failed modification has no delivered current-version draft", async () => {
  const { runtime, state } = makeRuntimeHarness({
    failCompletionOnce: false,
    failDraftUpdateOnce: true,
  });
  const originalDraftVersion = state.deliveredDraftVersion;
  await assert.rejects(() => runtime.handlePending(
    pendingInput(state, "修改金额为 18.50 元"),
  ), /simulated draft update failure/u);
  assert.match(state.currentStateCredential, /^\d{6}$/u);
  assert.equal(state.action.version, 2);
  assert.equal(state.deliveredDraftVersion, originalDraftVersion);

  const blocked = await runtime.handlePending(pendingInput(state, "确认"));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.status, "review_required");
  assert.match(blocked.body.text, /最新记账草稿/u);
  assert.equal(state.entry.status, "review_required");
  assert.equal(state.completeLocalCalls, 0);
});

test("retries a transient financial write from the already confirmed delivered draft", async () => {
  const { runtime, state } = makeRuntimeHarness({
    failCompletionOnce: false,
    failFinancialWriteOnce: true,
  });
  await assert.rejects(
    () => runtime.handlePending(pendingInput(state, "确认")),
    /simulated financial write failure/u,
  );
  assert.equal(state.entry.status, "review_required");
  assert.equal(state.action.status, "confirmed");
  assert.ok(state.action.version > state.deliveredDraftVersion);

  const recovered = await runtime.handlePending(pendingInput(state, "确认"));
  assert.equal(recovered.status, 200);
  assert.equal(state.entry.status, "accepted");
  assert.equal(state.action.status, "executed");
  assert.equal(state.completeLocalCalls, 1);
});
