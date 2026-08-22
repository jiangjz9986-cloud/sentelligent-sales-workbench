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
import { createAssistantToolHandlers } from "../src/assistant/runtimeHandlers.js";

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

function confirmationAttemptDigest(parts) {
  const encoded = Buffer.concat(parts.map((part) => {
    const value = Buffer.from(part, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.byteLength);
    return Buffer.concat([length, value]);
  }));
  return createHmac("sha256", confirmationSecret).update(encoded).digest("hex");
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
  it("uses the persisted runtime model-key provider for assistant quick-record previews", async () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({
      owner: "owner-a",
      channel: "weixin",
      conversationId: "wx-runtime-provider",
    });
    sessions.appendDraftPart(conversation.id, { role: "user", text: "客户需要确认预算和决策链" });
    let authorization;
    const handlers = createAssistantToolHandlers({
      db,
      config: {
        aiAnalysisMode: "model",
        modelProvider: "deepseek",
        modelApiKey: "unit-fixture-key",
        modelApiKeyProvider: () => "stored-fixture",
        modelBaseUrl: "https://example.invalid",
        modelName: "deepseek-v4-flash",
      },
      sessionRepository: sessions,
      fetchImpl: async (_url, options) => {
        authorization = options.headers.Authorization;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        };
      },
    });

    await handlers["visit-capture.preview"]({}, {
      owner: "owner-a",
      channel: "weixin",
      conversation: "wx-runtime-provider",
    });
    assert.equal(authorization, "Bearer stored-fixture");
  });

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

  it("persists the latest selected customer and project context with the conversation", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-context-1" });
    sessions.appendDraftPart(conversation.id, {
      role: "assistant",
      text: "项目分析已生成",
      metadata: { assistantContext: { customerId: "customer-1", opportunityId: "opportunity-1" } },
    });
    assert.deepEqual(sessions.getContext(conversation.id), {
      customerId: "customer-1",
      opportunityId: "opportunity-1",
    });

    db.close();
    db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const restarted = createAssistantSessionRepository(db, { clock: now });
    const loaded = restarted.getByExternalId({ owner: "owner-a", channel: "weixin", conversationId: "wx-context-1" });
    assert.deepEqual(restarted.getContext(loaded.id), {
      customerId: "customer-1",
      opportunityId: "opportunity-1",
    });
  });

  it("fails closed for oversized, reserved, or control-character context identifiers", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "wx-context-invalid" });
    sessions.appendDraftPart(conversation.id, {
      role: "assistant",
      text: "忽略不安全上下文",
      metadata: {
        assistantContext: {
          customerId: `${"x".repeat(201)}`,
          opportunityId: "synthetic:opportunity:1",
        },
      },
    });
    assert.deepEqual(sessions.getContext(conversation.id), {});
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
      () => actions.confirm(action.id, {
        owner: "owner-a", channel: "weixin", conversationId: conversation.id, confirmationCode,
      }),
      (error) => error instanceof HttpError && error.status === 410 && error.code === "ASSISTANT_ACTION_EXPIRED",
    );
    assert.equal(actions.get(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
    }).status, "expired");
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
      () => actions.confirm(action.id, {
        owner: "owner-b", channel: "weixin", conversationId: conversation.id, confirmationCode: "482913",
      }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    assert.equal(actions.get(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
    }).status, "pending");
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

  it("finds one active action by exact conversation scope and expires elapsed confirmation windows", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "synthetic-active" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"), clock: now, confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
      actionType: "create_expense", payload: { amountCents: 12850 },
      confirmationCode: "482913", expiresAt: "2026-08-09T01:00:30.000Z",
    });

    assert.equal(actions.findActiveByConversation({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
    }).id, action.id);
    assert.equal(actions.findActiveByConversation({
      owner: "owner-b", channel: "weixin", conversationId: conversation.id,
    }), null);
    assert.equal(actions.findActiveByConversation({
      owner: "owner-a", channel: "other", conversationId: conversation.id,
    }), null);

    clockNow = "2026-08-09T01:01:00.000Z";
    assert.equal(actions.findActiveByConversation({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
    }), null);
    assert.equal(actions.get(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
    }).status, "expired");

    db.exec("DROP INDEX idx_assistant_actions_one_active_per_conversation");
    const insert = db.prepare(`
      INSERT INTO assistant_pending_actions (
        id, owner, channel, conversation_id, action_type, payload_json, plan_digest,
        status, confirmation_code_hash, expires_at, created_at, updated_at
      ) VALUES ($id, 'owner-a', 'weixin', $conversationId, 'create_expense', '{}', $digest,
        'pending', $codeHash, '2026-08-09T02:00:00.000Z', $now, $now)
    `);
    for (const id of ["invariant-a", "invariant-b"]) {
      insert.run({
        $id: id,
        $conversationId: conversation.id,
        $digest: sha256("{}"),
        $codeHash: confirmationDigest("482913"),
        $now: clockNow,
      });
    }
    assert.throws(
      () => actions.findActiveByConversation({
        owner: "owner-a", channel: "weixin", conversationId: conversation.id,
      }),
      (error) => error instanceof HttpError
        && error.status === 500
        && error.code === "ASSISTANT_ACTION_INVARIANT",
    );
  });

  it("normalizes offset expiry timestamps before active conversation lookup", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "synthetic-offset-expiry" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"), clock: now, confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
      actionType: "create_expense", payload: { amountCents: 12850 },
      confirmationCode: "482913", expiresAt: "2026-08-09T02:00:30.000+01:00",
    });
    assert.equal(action.expiresAt, "2026-08-09T01:00:30.000Z");

    clockNow = "2026-08-09T01:01:00.000Z";
    assert.equal(actions.findActiveByConversation({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
    }), null);
  });

  it("deduplicates confirmation attempts and locks the fifth distinct wrong delivery", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "synthetic-attempts" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"), clock: now, confirmationSecret,
    });
    const payload = { plan: { toolName: "create_expense", arguments: { amountCents: 12850 } } };
    const action = actions.create({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
      actionType: "create_expense", payload, confirmationCode: "482913",
      expiresAt: "2026-08-09T01:10:00.000Z",
    });

    assert.throws(
      () => actions.confirm(action.id, {
        owner: "owner-a", channel: "weixin", conversationId: conversation.id,
        confirmationCode: "not-six-digits",
      }),
      TypeError,
    );
    assert.equal(db.prepare("SELECT confirmation_attempts FROM assistant_pending_actions WHERE id = $id").get({ $id: action.id }).confirmation_attempts, 0);
    assert.throws(
      () => actions.recordConfirmationFailure("different-action", {
        owner: "owner-a", channel: "weixin", conversationId: conversation.id, eventId: "synthetic-delivery-missing",
      }),
      (error) => error instanceof HttpError && error.status === 404,
    );

    const first = actions.recordConfirmationFailure(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, eventId: "synthetic-delivery-1",
    });
    const retry = actions.recordConfirmationFailure(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, eventId: "synthetic-delivery-1",
    });
    assert.deepEqual({ counted: first.counted, locked: first.locked }, { counted: true, locked: false });
    assert.deepEqual({ counted: retry.counted, locked: retry.locked }, { counted: false, locked: false });
    assert.equal(db.prepare("SELECT confirmation_attempts FROM assistant_pending_actions WHERE id = $id").get({ $id: action.id }).confirmation_attempts, 1);

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      actions.recordConfirmationFailure(action.id, {
        owner: "owner-a", channel: "weixin", conversationId: conversation.id,
        eventId: `synthetic-delivery-${attempt}`,
      });
    }
    const stored = db.prepare("SELECT * FROM assistant_pending_actions WHERE id = $id").get({ $id: action.id });
    assert.equal(stored.confirmation_attempts, 5);
    assert.equal(stored.status, "failed");
    assert.equal(stored.error_code, "ASSISTANT_CONFIRMATION_LOCKED");
    assert.equal(stored.confirmation_locked_at, clockNow);
    assert.equal(stored.lease_token_hash, null);
    assert.equal(stored.lease_expires_at, null);
    assert.equal(stored.payload_json, JSON.stringify(payload));
    assert.equal(stored.plan_digest, action.planDigest);
    assert.throws(
      () => actions.confirm(action.id, {
        owner: "owner-a", channel: "weixin", conversationId: conversation.id, confirmationCode: "111222",
      }),
      (error) => error instanceof HttpError && error.status === 409 && error.code === "ASSISTANT_CONFIRMATION_LOCKED",
    );

    const attempts = db.prepare("SELECT * FROM assistant_confirmation_attempts ORDER BY created_at, event_id_hash").all();
    assert.equal(attempts.length, 5);
    assert.equal(attempts.every((row) => /^[0-9a-f]{64}$/u.test(row.event_id_hash)), true);
    assert.equal(attempts.some((row) => row.event_id_hash === confirmationAttemptDigest([
      "sentelligent/assistant-confirmation-attempt/v1", "owner-a", "weixin", conversation.id, "synthetic-delivery-1",
    ])), true);
    assert.equal(JSON.stringify(attempts).includes("synthetic-delivery-"), false);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM audit_logs").all()).includes("synthetic-delivery-"), false);
    for (const projection of [action, first.item, retry.item, actions.get(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
    })]) {
      assert.equal(Object.hasOwn(projection, "confirmationAttempts"), false);
      assert.equal(Object.hasOwn(projection, "confirmationLockedAt"), false);
      assert.equal(Object.hasOwn(projection, "confirmationCodeHash"), false);
      assert.equal(Object.hasOwn(projection, "eventIdHash"), false);
    }
  });

  it("hashes exact opaque event ids and rejects confirmation codes wrapped in whitespace", () => {
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"), clock: now, confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a", channel: "weixin", actionType: "create_expense",
      payload: { amountCents: 12850 }, confirmationCode: "482913",
      expiresAt: "2026-08-09T01:10:00.000Z",
    });

    assert.throws(
      () => actions.confirm(action.id, {
        owner: "owner-a", channel: "weixin", conversationId: null, confirmationCode: " 482913 ",
      }),
      TypeError,
    );
    const first = actions.recordConfirmationFailure(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: null, eventId: "synthetic-opaque-delivery",
    });
    const distinct = actions.recordConfirmationFailure(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: null, eventId: " synthetic-opaque-delivery ",
    });
    assert.equal(first.counted, true);
    assert.equal(distinct.counted, true);

    const rows = db.prepare(`
      SELECT event_id_hash FROM assistant_confirmation_attempts
      WHERE action_id = $actionId ORDER BY event_id_hash
    `).all({ $actionId: action.id });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.event_id_hash).sort(), [
      confirmationAttemptDigest([
        "sentelligent/assistant-confirmation-attempt/v1", "owner-a", "weixin", "", "synthetic-opaque-delivery",
      ]),
      confirmationAttemptDigest([
        "sentelligent/assistant-confirmation-attempt/v1", "owner-a", "weixin", "", " synthetic-opaque-delivery ",
      ]),
    ].sort());
  });

  it("requires an explicit null conversation scope for null-scoped action methods", () => {
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"), clock: now, confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a", channel: "weixin", actionType: "create_expense",
      payload: { amountCents: 12850 }, confirmationCode: "482913",
      expiresAt: "2026-08-09T01:10:00.000Z",
    });
    const omitted = { owner: "owner-a", channel: "weixin" };

    assert.throws(() => actions.get(action.id, omitted), /conversationId is required/);
    assert.throws(
      () => actions.confirm(action.id, { ...omitted, confirmationCode: "482913" }),
      /conversationId is required/,
    );
    assert.throws(
      () => actions.recordConfirmationFailure(action.id, { ...omitted, eventId: "synthetic-omitted-scope" }),
      /conversationId is required/,
    );
    assert.throws(
      () => actions.renewConfirmation(action.id, { ...omitted, confirmationCode: "731604" }),
      /conversationId is required/,
    );
    assert.throws(() => actions.cancel(action.id, omitted), /conversationId is required/);
    assert.throws(() => actions.claimExecution(action.id, omitted), /conversationId is required/);
    const unchanged = db.prepare(`
      SELECT status, confirmation_attempts, confirmation_code_hash
      FROM assistant_pending_actions WHERE id = $id
    `).get({ $id: action.id });
    assert.equal(unchanged.status, "pending");
    assert.equal(unchanged.confirmation_attempts, 0);
    assert.equal(unchanged.confirmation_code_hash, confirmationDigest("482913"));

    actions.confirm(action.id, { ...omitted, conversationId: null, confirmationCode: "482913" });
    const claimed = actions.claimExecution(action.id, { ...omitted, conversationId: null, leaseMs: 60_000 });
    assert.throws(
      () => actions.completeExecution(action.id, { ...omitted, leaseToken: claimed.leaseToken, result: {} }),
      /conversationId is required/,
    );
    assert.throws(
      () => actions.releaseExecution(action.id, { ...omitted, leaseToken: claimed.leaseToken }),
      /conversationId is required/,
    );
    assert.equal(actions.completeExecution(action.id, {
      ...omitted, conversationId: null, leaseToken: claimed.leaseToken, result: { ok: true },
    }).item.status, "executed");
  });

  it("rejects wrong owner channel or conversation for confirmation closure mutations", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "synthetic-mutation-scope" });
    const otherConversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "synthetic-other-scope" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"), clock: now, confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
      actionType: "create_expense", payload: { amountCents: 12850 }, confirmationCode: "482913",
      expiresAt: "2026-08-09T01:10:00.000Z",
    });
    const wrongScopes = [
      { owner: "owner-b", channel: "weixin", conversationId: conversation.id },
      { owner: "owner-a", channel: "other", conversationId: conversation.id },
      { owner: "owner-a", channel: "weixin", conversationId: otherConversation.id },
    ];
    const mutations = [
      (scopeValue, index) => actions.recordConfirmationFailure(action.id, {
        ...scopeValue, eventId: `synthetic-wrong-scope-${index}`,
      }),
      (scopeValue) => actions.cancel(action.id, scopeValue),
      (scopeValue) => actions.renewConfirmation(action.id, { ...scopeValue, confirmationCode: "731604" }),
    ];
    for (const [scopeIndex, scopeValue] of wrongScopes.entries()) {
      for (const mutation of mutations) {
        assert.throws(
          () => mutation(scopeValue, scopeIndex),
          (error) => error instanceof HttpError && error.status === 404,
        );
      }
    }
    const stored = db.prepare(`
      SELECT status, confirmation_attempts, confirmation_code_hash
      FROM assistant_pending_actions WHERE id = $id
    `).get({ $id: action.id });
    assert.equal(stored.status, "pending");
    assert.equal(stored.confirmation_attempts, 0);
    assert.equal(stored.confirmation_code_hash, confirmationDigest("482913"));
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM assistant_confirmation_attempts WHERE action_id = $id
    `).get({ $id: action.id }).count, 0);
  });

  it("cancels pending or confirmed actions but protects an active processing lease", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"), clock: now, confirmationSecret,
    });
    const makeAction = (externalId, code) => {
      const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: externalId });
      const action = actions.create({
        owner: "owner-a", channel: "weixin", conversationId: conversation.id,
        actionType: "create_expense", payload: { amountCents: 5000 }, confirmationCode: code,
        expiresAt: "2026-08-09T01:10:00.000Z",
      });
      return { action, conversation };
    };

    const pending = makeAction("synthetic-cancel-pending", "111222");
    assert.equal(actions.cancel(pending.action.id, {
      owner: "owner-a", channel: "weixin", conversationId: pending.conversation.id,
    }).item.status, "cancelled");
    assert.equal(actions.cancel(pending.action.id, {
      owner: "owner-a", channel: "weixin", conversationId: pending.conversation.id,
    }).replayed, true);

    const confirmed = makeAction("synthetic-cancel-confirmed", "222333");
    actions.confirm(confirmed.action.id, {
      owner: "owner-a", channel: "weixin", conversationId: confirmed.conversation.id,
      confirmationCode: "222333",
    });
    assert.equal(actions.cancel(confirmed.action.id, {
      owner: "owner-a", channel: "weixin", conversationId: confirmed.conversation.id,
    }).item.status, "cancelled");

    const leased = makeAction("synthetic-cancel-processing", "333444");
    actions.confirm(leased.action.id, {
      owner: "owner-a", channel: "weixin", conversationId: leased.conversation.id, confirmationCode: "333444",
    });
    actions.claimExecution(leased.action.id, {
      owner: "owner-a", channel: "weixin", conversationId: leased.conversation.id, leaseMs: 60_000,
    });
    assert.throws(
      () => actions.cancel(leased.action.id, {
        owner: "owner-a", channel: "weixin", conversationId: leased.conversation.id,
      }),
      (error) => error instanceof HttpError && error.status === 409 && error.code === "ASSISTANT_ACTION_IN_PROGRESS",
    );
    clockNow = "2026-08-09T01:02:00.000Z";
    const reclaimed = actions.cancel(leased.action.id, {
      owner: "owner-a", channel: "weixin", conversationId: leased.conversation.id,
    });
    assert.equal(reclaimed.item.status, "cancelled");
    const stored = db.prepare("SELECT lease_token_hash, lease_expires_at FROM assistant_pending_actions WHERE id = $id").get({ $id: leased.action.id });
    assert.equal(stored.lease_token_hash, null);
    assert.equal(stored.lease_expires_at, null);
  });

  it("renews confirmation without changing expiry attempts lock payload or plan digest", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "synthetic-renew-state" });
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"), clock: now, confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
      actionType: "create_expense", payload: { amountCents: 5000 }, confirmationCode: "482913",
      expiresAt: "2026-08-09T01:10:00.000Z",
    });
    actions.recordConfirmationFailure(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, eventId: "synthetic-renew-attempt",
    });
    const before = db.prepare("SELECT * FROM assistant_pending_actions WHERE id = $id").get({ $id: action.id });
    const renewed = actions.renewConfirmation(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, confirmationCode: "731604",
    });
    const after = db.prepare("SELECT * FROM assistant_pending_actions WHERE id = $id").get({ $id: action.id });
    assert.equal(renewed.confirmationCode, "731604");
    assert.equal(after.confirmation_code_hash, confirmationDigest("731604"));
    assert.notEqual(after.confirmation_code_hash, before.confirmation_code_hash);
    for (const column of ["expires_at", "confirmation_attempts", "confirmation_locked_at", "payload_json", "plan_digest"]) {
      assert.equal(after[column], before[column]);
    }
    assert.throws(
      () => actions.confirm(action.id, {
        owner: "owner-a", channel: "weixin", conversationId: conversation.id, confirmationCode: "482913",
      }),
      (error) => error instanceof HttpError && error.code === "ASSISTANT_CONFIRMATION_INVALID",
    );
    assert.equal(actions.confirm(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, confirmationCode: "731604",
    }).item.status, "confirmed");
  });

  it("rejects non-exact renewal confirmation codes without changing the stored code", () => {
    const actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"), clock: now, confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a", channel: "weixin", actionType: "create_expense",
      payload: { amountCents: 5000 }, confirmationCode: "482913",
      expiresAt: "2026-08-09T01:10:00.000Z",
    });
    const before = db.prepare(`
      SELECT status, expires_at, confirmation_attempts, confirmation_locked_at,
             confirmation_code_hash, payload_json, plan_digest
      FROM assistant_pending_actions WHERE id = $id
    `).get({ $id: action.id });

    for (const confirmationCode of [" 731604 ", "731604\n", "７３１６０４", "731604 extra", "extra731604"]) {
      assert.throws(
        () => actions.renewConfirmation(action.id, {
          owner: "owner-a", channel: "weixin", conversationId: null, confirmationCode,
        }),
        TypeError,
      );
    }

    const after = db.prepare(`
      SELECT status, expires_at, confirmation_attempts, confirmation_locked_at,
             confirmation_code_hash, payload_json, plan_digest
      FROM assistant_pending_actions WHERE id = $id
    `).get({ $id: action.id });
    assert.deepEqual(after, before);
    assert.equal(actions.confirm(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: null, confirmationCode: "482913",
    }).item.status, "confirmed");
  });

  it("preserves confirmation attempts renewed HMAC and lease behavior across restart", () => {
    const sessions = createAssistantSessionRepository(db, { idFactory: () => nextId("session"), clock: now });
    const conversation = sessions.getOrCreate({ owner: "owner-a", channel: "weixin", conversationId: "synthetic-restart-state" });
    let actions = createAssistantPendingActionRepository(db, {
      idFactory: () => nextId("action"), clock: now, confirmationSecret,
    });
    const action = actions.create({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
      actionType: "create_expense", payload: { amountCents: 5000 }, confirmationCode: "482913",
      expiresAt: "2026-08-09T01:10:00.000Z",
    });
    actions.recordConfirmationFailure(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, eventId: "synthetic-restart-attempt",
    });
    actions.renewConfirmation(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, confirmationCode: "731604",
    });
    actions.confirm(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, confirmationCode: "731604",
    });
    const firstLease = actions.claimExecution(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, leaseMs: 60_000,
    });
    db.close();

    db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    actions = createAssistantPendingActionRepository(db, { clock: now, confirmationSecret });
    assert.equal(actions.findActiveByConversation({
      owner: "owner-a", channel: "weixin", conversationId: conversation.id,
    }).status, "processing");
    const stored = db.prepare("SELECT confirmation_attempts, confirmation_code_hash FROM assistant_pending_actions WHERE id = $id").get({ $id: action.id });
    assert.equal(stored.confirmation_attempts, 1);
    assert.equal(stored.confirmation_code_hash, confirmationDigest("731604"));
    assert.equal(actions.claimExecution(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, leaseMs: 60_000,
    }).inProgress, true);

    clockNow = "2026-08-09T01:02:00.000Z";
    const replacementLease = actions.claimExecution(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: conversation.id, leaseMs: 60_000,
    });
    assert.notEqual(replacementLease.leaseToken, firstLease.leaseToken);
    assert.throws(
      () => actions.completeExecution(action.id, {
        owner: "owner-a", channel: "weixin", conversationId: conversation.id,
        leaseToken: firstLease.leaseToken, result: { expenseId: "stale" },
      }),
      (error) => error instanceof HttpError && error.code === "ASSISTANT_ACTION_LEASE_LOST",
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
    actions.confirm(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: null, confirmationCode: "482913",
    });
    const executed = actions.markExecuted(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: null,
      result: { expenseId: "expense-1" },
    });
    assert.equal(executed.item.status, "executed");
    assert.deepEqual(executed.item.result, { expenseId: "expense-1" });
    const replay = actions.markExecuted(action.id, {
      owner: "owner-a",
      channel: "weixin",
      conversationId: null,
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
    for (const hiddenField of [
      "confirmationAttempts",
      "confirmationLockedAt",
      "confirmationCodeHash",
      "eventIdHash",
      "leaseTokenHash",
      "leaseExpiresAt",
    ]) {
      assert.equal(Object.hasOwn(first.item, hiddenField), false);
    }
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
      () => actions.get(action.id, { owner: "owner-a", channel: "weixin" }),
      /conversationId is required/,
    );
    assert.throws(
      () => actions.confirm(action.id, {
        owner: "owner-a",
        channel: "weixin",
        conversationId: secondConversation.id,
        confirmationCode: "482913",
      }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    assert.throws(
      () => actions.confirm(action.id, {
        owner: "owner-a", channel: "weixin", confirmationCode: "482913",
      }),
      /conversationId is required/,
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
      conversationId: null,
      confirmationCode: "731604",
    });
    assert.equal(renewed.confirmationCode, "731604");
    assert.equal(renewed.item.status, "pending");
    const stored = db.prepare("SELECT * FROM assistant_pending_actions WHERE id = $id").get({ $id: action.id });
    assert.doesNotMatch(JSON.stringify(stored), /731604/);
    assert.throws(
      () => actions.confirm(action.id, {
        owner: "owner-a", channel: "weixin", conversationId: null, confirmationCode: "482913",
      }),
      (error) => error instanceof HttpError && error.status === 409,
    );
    assert.doesNotThrow(() => actions.confirm(action.id, {
      owner: "owner-a", channel: "weixin", conversationId: null, confirmationCode: "731604",
    }));
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
