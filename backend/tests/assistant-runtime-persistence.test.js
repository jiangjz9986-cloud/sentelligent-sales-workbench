import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { HttpError } from "../src/http/errors.js";
import { createAssistantEventRepository } from "../src/assistant/eventRepository.js";
import { createAssistantSessionRepository } from "../src/assistant/sessionRepository.js";
import { createAssistantPendingActionRepository } from "../src/assistant/pendingActionRepository.js";

let db;
let tempDir;
let clockNow;
let idCounter;
const confirmationSecret = "test-machine-machine-secret-token";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function confirmationDigest(value) {
  return createHmac("sha256", confirmationSecret).update(value, "utf8").digest("hex");
}

function nextId(prefix = "assistant") {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function now() {
  return new Date(clockNow);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "sentelligent-assistant-"));
  clockNow = "2026-08-09T01:00:00.000Z";
  idCounter = 0;
  db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
});

afterEach(() => {
  db?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("assistant runtime persistence", () => {
  it("replays an inbound event and rejects the same event with a changed request hash", () => {
    const repository = createAssistantEventRepository(db, { idFactory: () => nextId("event"), clock: now });
    const input = {
      owner: "owner-a",
      channel: "weixin",
      eventId: "wx-event-001",
      requestHash: sha256("request-a"),
      payload: { text: "记录今天的午餐" },
    };

    const first = repository.receive(input);
    const replay = repository.receive(input);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.item.id, first.item.id);

    assert.throws(
      () => repository.receive({ ...input, requestHash: sha256("request-b") }),
      (error) => error instanceof HttpError
        && error.status === 409
        && error.code === "ASSISTANT_EVENT_CONFLICT"
        && error.fields.existingId === first.item.id,
    );

    const stored = db.prepare("SELECT * FROM assistant_inbound_events WHERE id = $id").get({ $id: first.item.id });
    assert.equal(stored.event_id_hash, sha256(input.eventId));
    assert.equal(stored.request_hash, input.requestHash);
    assert.equal(JSON.stringify(stored).includes(input.eventId), false);
    assert.equal(JSON.stringify(stored).includes("记录今天的午餐"), true);
  });

  it("takes over an expired inbound event lease and fences the stale token", () => {
    const repository = createAssistantEventRepository(db, { idFactory: () => nextId("event"), clock: now });
    const event = repository.receive({
      owner: "owner-a", channel: "weixin", eventId: "wx-event-lease",
      requestHash: sha256("lease-request"), payload: { text: "待处理" },
    }).item;
    const firstClaim = repository.claim(event.id, { leaseMs: 60_000 });
    assert.equal(firstClaim.item.status, "processing");
    assert.throws(
      () => repository.claim(event.id, { leaseMs: 60_000 }),
      (error) => error instanceof HttpError && error.status === 409 && error.code === "ASSISTANT_EVENT_IN_PROGRESS",
    );

    clockNow = "2026-08-09T01:01:01.000Z";
    const takeover = repository.claim(event.id, { leaseMs: 60_000 });
    assert.equal(takeover.replayed, false);
    assert.notEqual(takeover.leaseToken, firstClaim.leaseToken);
    assert.throws(
      () => repository.complete(event.id, { leaseToken: firstClaim.leaseToken, responseStatus: 200, response: { ok: true } }),
      (error) => error instanceof HttpError && error.status === 409 && error.code === "ASSISTANT_EVENT_LEASE_LOST",
    );
    const completed = repository.complete(event.id, {
      leaseToken: takeover.leaseToken, responseStatus: 200, response: { ok: true },
    });
    assert.equal(completed.item.status, "completed");
  });

  it("keeps case-sensitive event identities distinct and requires a canonical request digest", () => {
    const repository = createAssistantEventRepository(db, { idFactory: () => nextId("event"), clock: now });
    const requestHash = sha256("same-request");
    const upper = repository.receive({
      owner: "owner-a", channel: "weixin", eventId: "WX-Event-A", requestHash, payload: { text: "A" },
    });
    const lower = repository.receive({
      owner: "owner-a", channel: "weixin", eventId: "wx-event-a", requestHash, payload: { text: "A" },
    });

    assert.notEqual(lower.item.id, upper.item.id);
    assert.throws(
      () => repository.receive({
        owner: "owner-a", channel: "weixin", eventId: "bad-request-hash", requestHash: "not-a-digest", payload: {},
      }),
      /requestHash must be a lowercase SHA-256 digest/,
    );
  });

  it("deduplicates tool runs by owner, channel, event hash, and tool name", () => {
    const repository = createAssistantEventRepository(db, { idFactory: () => nextId("tool"), clock: now });
    const input = {
      owner: "owner-a", channel: "weixin", eventId: "wx-event-tool",
      toolName: "travel_expense.list", requestHash: sha256("tool-request"), input: { weekStart: "2026-08-03" },
    };
    const first = repository.createToolRun(input);
    const replay = repository.createToolRun(input);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.item.id, first.item.id);
    assert.throws(
      () => repository.createToolRun({ ...input, requestHash: sha256("changed-tool-request") }),
      (error) => error instanceof HttpError && error.status === 409 && error.code === "ASSISTANT_TOOL_RUN_CONFLICT",
    );
  });

  it("persists a conversation and draft parts that can be read after restart", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-user-1" });
    sessions.appendDraftPart(conversation.id, { role: "user", text: "下周一拜访客户" });
    sessions.appendDraftPart(conversation.id, { role: "assistant", text: "已记录待确认" });
    db.close();

    db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const restarted = createAssistantSessionRepository(db, { clock: now });
    const loaded = restarted.getByExternalId({ owner: "owner-a", channel: "weixin", conversationId: "wx-user-1" });
    assert.equal(loaded.id, conversation.id);
    assert.deepEqual(restarted.listDraftParts(loaded.id).map((part) => part.text), ["下周一拜访客户", "已记录待确认"]);
  });

  it("expires pending actions and stores only the confirmation-code hash", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-user-action" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"),
      clock: now,
      confirmationSecret,
    });
    const confirmationCode = "482913";
    const action = actions.create({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
      actionType: "create_expense", payload: { amountCents: 12850 },
      confirmationCode, expiresAt: "2026-08-09T01:00:30.000Z",
    });
    const stored = db.prepare("SELECT * FROM assistant_pending_actions WHERE id = $id").get({ $id: action.id });
    assert.equal(stored.confirmation_code_hash, confirmationDigest(confirmationCode));
    assert.notEqual(stored.confirmation_code_hash, sha256(confirmationCode));
    assert.equal(JSON.stringify(stored).includes(confirmationCode), false);

    clockNow = "2026-08-09T01:01:00.000Z";
    assert.throws(
      () => actions.confirm(action.id, { owner: "owner-a", channel: "weixin", confirmationCode }),
      (error) => error instanceof HttpError && error.status === 410 && error.code === "ASSISTANT_ACTION_EXPIRED",
    );
    assert.equal(actions.get(action.id, { owner: "owner-a", channel: "weixin" }).status, "expired");
  });

  it("scopes pending actions to their owner and conversation and keeps audit writes atomic", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-secure-action" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"),
      clock: now,
      confirmationSecret,
    });
    const baseAction = {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      actionType: "create_expense",
      payload: { amountCents: 12850 },
      confirmationCode: "482913",
      expiresAt: "2026-08-09T01:05:00.000Z",
    };
    const action = actions.create(baseAction);

    assert.throws(
      () => actions.confirm(action.id, { owner: "owner-b", channel: "weixin", confirmationCode: "482913" }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    assert.equal(actions.get(action.id, { owner: "owner-a", channel: "weixin" }).status, "pending");
    assert.throws(
      () => actions.create({ ...baseAction, confirmationCode: "111222" }),
      (error) => error instanceof HttpError && error.status === 409 && error.code === "ASSISTANT_ACTION_PENDING",
    );
    assert.throws(
      () => actions.create({ ...baseAction, owner: "owner-b", confirmationCode: "333444" }),
      (error) => error instanceof HttpError && error.status === 404,
    );

    db.exec(`
      CREATE TRIGGER fail_assistant_action_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'assistant.action.create'
      BEGIN
        SELECT RAISE(ABORT, 'forced assistant audit failure');
      END;
    `);
    const otherConversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-audit-action" });
    assert.throws(() => actions.create({
      ...baseAction,
      conversationId: otherConversation.id,
      confirmationCode: "555666",
    }), /forced assistant audit failure/);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM assistant_pending_actions WHERE conversation_id = $conversationId").get({ $conversationId: otherConversation.id }).count,
      0,
    );
  });

  it("marks a confirmed action executed exactly once and persists its result", () => {
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"),
      clock: now,
      confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a",
      channel: "weixin",
      actionType: "create_expense",
      payload: { amountCents: 5000 },
      confirmationCode: "482913",
      expiresAt: "2026-08-09T01:05:00.000Z",
    });
    actions.confirm(action.id, { owner: "owner-a", channel: "weixin", confirmationCode: "482913" });
    const executed = actions.markExecuted(action.id, {
      owner: "owner-a",
      channel: "weixin",
      result: { expenseId: "expense-1" },
    });
    assert.equal(executed.item.status, "executed");
    assert.deepEqual(executed.item.result, { expenseId: "expense-1" });
    const replay = actions.markExecuted(action.id, {
      owner: "owner-a",
      channel: "weixin",
      result: { expenseId: "expense-2" },
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.item.result, { expenseId: "expense-1" });
  });

  it("atomically leases a confirmed action and fences a second executor", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-lease-action" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"),
      clock: now,
      confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      actionType: "create_expense",
      payload: { plan: { toolName: "create_expense", arguments: { amountCents: 5000 } } },
      confirmationCode: "482913",
      expiresAt: "2026-08-09T01:05:00.000Z",
    });
    actions.confirm(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      confirmationCode: "482913",
    });

    const first = actions.claimExecution(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      leaseMs: 60_000,
    });
    assert.equal(first.replayed, false);
    assert.equal(first.item.status, "processing");
    const second = actions.claimExecution(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      leaseMs: 60_000,
    });
    assert.equal(second.inProgress, true);

    const completed = actions.completeExecution(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      leaseToken: first.leaseToken,
      result: { expenseId: "expense-1" },
    });
    assert.equal(completed.item.status, "executed");
    const replay = actions.claimExecution(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      leaseMs: 60_000,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.item.result, { expenseId: "expense-1" });
  });

  it("reclaims an expired execution lease through confirmation", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-expired-lease" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"),
      clock: now,
      confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      actionType: "create_expense",
      payload: { plan: { toolName: "create_expense", arguments: { amountCents: 5000 } } },
      confirmationCode: "482913",
      expiresAt: "2026-08-09T01:05:00.000Z",
    });
    actions.confirm(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      confirmationCode: "482913",
    });
    const first = actions.claimExecution(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      leaseMs: 60_000,
    });
    clockNow = "2026-08-09T01:02:00.000Z";

    const reconfirmed = actions.confirm(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      confirmationCode: "482913",
    });
    assert.equal(reconfirmed.inProgress, false);
    const reclaimed = actions.claimExecution(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      leaseMs: 60_000,
    });
    assert.equal(reclaimed.replayed, false);
    assert.equal(reclaimed.inProgress, undefined);
    assert.notEqual(reclaimed.leaseToken, first.leaseToken);
    assert.throws(
      () => actions.completeExecution(action.id, {
        owner: "owner-a",
        channel: "weixin",
        conversationId: conversation.id,
        leaseToken: first.leaseToken,
        result: { expenseId: "stale" },
      }),
      /lease/i,
    );
    const completed = actions.completeExecution(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      leaseToken: reclaimed.leaseToken,
      result: { expenseId: "expense-reclaimed" },
    });
    assert.equal(completed.item.status, "executed");
  });

  it("reissues a lost confirmation code after an execution lease expires", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-expired-renew" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"),
      clock: now,
      confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      actionType: "create_expense",
      payload: { plan: { toolName: "create_expense", arguments: { amountCents: 5000 } } },
      confirmationCode: "482913",
      expiresAt: "2026-08-09T01:05:00.000Z",
    });
    actions.confirm(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      confirmationCode: "482913",
    });
    actions.claimExecution(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      leaseMs: 60_000,
    });
    clockNow = "2026-08-09T01:02:00.000Z";

    const renewed = actions.renewConfirmation(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      confirmationCode: "731604",
    });
    assert.equal(renewed.item.status, "pending");
    assert.throws(
      () => actions.confirm(action.id, {
        owner: "owner-a",
        channel: "weixin",
        conversationId: conversation.id,
        confirmationCode: "482913",
      }),
      /invalid/i,
    );
    const confirmed = actions.confirm(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: conversation.id,
      confirmationCode: "731604",
    });
    assert.equal(confirmed.item.status, "confirmed");
  });

  it("does not expose a conversation-bound action through another conversation", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const firstConversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-owner-scope-a" });
    const secondConversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-owner-scope-b" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"),
      clock: now,
      confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a",
      channel: "weixin",
      conversationId: firstConversation.id,
      actionType: "create_expense",
      payload: { amountCents: 5000 },
      confirmationCode: "482913",
      expiresAt: "2026-08-09T01:05:00.000Z",
    });
    assert.equal(actions.get(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: secondConversation.id,
    }), null);
    assert.throws(
      () => actions.confirm(action.id, {
        owner: "owner-a",
        channel: "weixin",
        conversationId: secondConversation.id,
        confirmationCode: "482913",
      }),
      (error) => error instanceof HttpError && error.status === 404,
    );
  });

  it("issues a replacement confirmation code without persisting it in plaintext", () => {
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"),
      clock: now,
      confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a",
      channel: "weixin",
      actionType: "create_expense",
      payload: { amountCents: 5000 },
      confirmationCode: "482913",
      expiresAt: "2026-08-09T01:05:00.000Z",
    });
    const renewed = actions.renewConfirmation(action.id, {
      owner: "owner-a",
      channel: "weixin",
      confirmationCode: "731604",
    });
    assert.equal(renewed.confirmationCode, "731604");
    assert.equal(renewed.item.status, "pending");
    const stored = db.prepare("SELECT * FROM assistant_pending_actions WHERE id = $id").get({ $id: action.id });
    assert.doesNotMatch(JSON.stringify(stored), /731604/);
    assert.throws(
      () => actions.confirm(action.id, { owner: "owner-a", channel: "weixin", confirmationCode: "482913" }),
      (error) => error instanceof HttpError && error.status === 409,
    );
    assert.doesNotThrow(() => actions.confirm(action.id, { owner: "owner-a", channel: "weixin", confirmationCode: "731604" }));
  });

  it("clears a completed conversation draft without deleting the conversation identity", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-clear-draft" });
    sessions.appendDraftPart(conversation.id, { role: "user", text: "已完成的拜访" });
    assert.equal(sessions.listDraftParts(conversation.id).length, 1);
    const cleared = sessions.clearDraftParts(conversation.id);
    assert.equal(cleared, 1);
    assert.equal(sessions.listDraftParts(conversation.id).length, 0);
    assert.equal(sessions.get(conversation.id).id, conversation.id);
  });
});
