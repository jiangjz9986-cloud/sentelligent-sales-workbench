import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/db.js";
import {
  createWeixinConfirmationOutboxRepository,
} from "../src/weixin/outboxRepository.js";
import { createWeixinOutboxClient } from "../src/weixin/outboxClient.js";

function makeClock(start = "2026-08-18T00:00:00.000Z") {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

async function withDatabase(callback) {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    return await callback(db);
  } finally {
    db.close();
  }
}

test("0019 creates a durable, credential-free confirmation outbox", () => {
  withDatabase((db) => {
    const columns = db.prepare("PRAGMA table_info(weixin_confirmation_outbox)").all().map((row) => row.name);
    assert.deepEqual(columns, [
      "id", "owner", "conversation_id", "idempotency_key_hash", "payload_json", "payload_hash",
      "status", "attempt_count", "available_at", "lease_proof_hash", "lease_until", "last_error_code",
      "provider_message_id", "created_at", "updated_at", "sent_at",
    ]);
    assert.equal(columns.some((name) => /confirmation.?code|token|secret|credential/i.test(name)), false);
    assert.equal(db.prepare("SELECT version FROM schema_migrations WHERE version = '0019'").get().version, "0019");
  });
});

test("enqueue is idempotent, hashes the key, and rejects confirmation secrets", () => {
  withDatabase((db) => {
    const clock = makeClock();
    const repository = createWeixinConfirmationOutboxRepository(db, { clock: clock.now, idFactory: () => "outbox-1" });
    const payload = { merchant: "济南医院", amountCents: 12800, occurredOn: "2026-08-17", category: "餐饮" };
    const first = repository.enqueue({
      owner: "owner-1",
      conversationId: "conversation-1",
      idempotencyKey: "shortcut-event-1",
      payload,
    });
    const replay = repository.enqueue({
      owner: "owner-1",
      conversationId: "conversation-1",
      idempotencyKey: "shortcut-event-1",
      payload,
    });
    assert.equal(first.id, "outbox-1");
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    assert.equal(db.prepare("SELECT idempotency_key_hash FROM weixin_confirmation_outbox").get().idempotency_key_hash.length, 64);
    assert.equal(db.prepare("SELECT payload_json FROM weixin_confirmation_outbox").get().payload_json.includes("shortcut-event-1"), false);
    assert.throws(
      () => repository.enqueue({ owner: "owner-2", conversationId: "conversation-2", idempotencyKey: "shortcut-event-2", payload: { confirmationCode: "123456" } }),
      /sensitive|confirmation/i,
    );
    assert.throws(
      () => repository.enqueue({ owner: "owner-1", conversationId: "conversation-1", idempotencyKey: "shortcut-event-1", payload: { ...payload, amountCents: 9900 } }),
      /idempotency/i,
    );
  });
});

test("lease renders only in memory, fences concurrent workers, and acknowledges success", () => {
  withDatabase((db) => {
    const clock = makeClock();
    const repository = createWeixinConfirmationOutboxRepository(db, { clock: clock.now, leaseMs: 30_000, idFactory: () => "outbox-2" });
    repository.enqueue({ owner: "owner-1", conversationId: "conversation-1", idempotencyKey: "shortcut-event-3", payload: { amountCents: 12800 } });
    let rendered;
    const lease = repository.leaseNext({ workerId: "weixin-worker-1", renderMessage: (item) => {
      rendered = item;
      return `请确认：${item.payload.amountCents}分`;
    } });
    assert.equal(lease.item.status, "processing");
    assert.equal(lease.message, "请确认：12800分");
    assert.equal(rendered.payload.amountCents, 12800);
    assert.equal(repository.leaseNext({ workerId: "weixin-worker-2", renderMessage: () => "不应发送" }), null);
    const raw = db.prepare("SELECT * FROM weixin_confirmation_outbox WHERE id = 'outbox-2'").get();
    assert.equal(raw.payload_json.includes("请确认"), false);
    assert.equal(raw.payload_json.includes("123456"), false);
    const sent = repository.ackSuccess("outbox-2", { leaseToken: lease.leaseToken, providerMessageId: "wx-message-1" });
    assert.equal(sent.status, "sent");
    assert.equal(sent.providerMessageId, "wx-message-1");
    assert.equal(repository.ackSuccess("outbox-2", { leaseToken: lease.leaseToken }).status, "sent");
  });
});

test("failed delivery retries with exponential backoff and then becomes terminal", () => {
  withDatabase((db) => {
    const clock = makeClock();
    const repository = createWeixinConfirmationOutboxRepository(db, {
      clock: clock.now,
      leaseMs: 20_000,
      retryBaseMs: 1_000,
      maxAttempts: 2,
      idFactory: () => `outbox-${Math.random()}`,
    });
    const created = repository.enqueue({ owner: "owner-1", conversationId: "conversation-1", idempotencyKey: "shortcut-event-4", payload: { amountCents: 1 } });
    const first = repository.leaseNext({ workerId: "worker-1", renderMessage: () => "confirm" });
    const queued = repository.ackFailure(created.id, { leaseToken: first.leaseToken, errorCode: "SEND_FAILED" });
    assert.equal(queued.status, "queued");
    assert.equal(queued.attemptCount, 1);
    assert.equal(queued.lastErrorCode, "SEND_FAILED");
    assert.equal(repository.leaseNext({ workerId: "worker-2", renderMessage: () => "too early" }), null);
    clock.advance(1_000);
    const second = repository.leaseNext({ workerId: "worker-2", renderMessage: () => "retry" });
    assert.ok(second);
    const failed = repository.ackFailure(created.id, { leaseToken: second.leaseToken, errorCode: "SEND_FAILED" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.attemptCount, 2);
    assert.equal(repository.leaseNext({ workerId: "worker-3", renderMessage: () => "never" }), null);
  });
});

test("expired processing lease is recovered without overlap and stale acknowledgements are fenced", () => {
  withDatabase((db) => {
    const clock = makeClock();
    const repository = createWeixinConfirmationOutboxRepository(db, { clock: clock.now, leaseMs: 10_000, idFactory: () => "outbox-5" });
    repository.enqueue({ owner: "owner-1", conversationId: "conversation-1", idempotencyKey: "shortcut-event-5", payload: { amountCents: 3 } });
    const first = repository.leaseNext({ workerId: "worker-1", renderMessage: () => "first" });
    clock.advance(10_001);
    const second = repository.leaseNext({ workerId: "worker-2", renderMessage: () => "recovered" });
    assert.equal(second.message, "recovered");
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.throws(() => repository.ackSuccess("outbox-5", { leaseToken: first.leaseToken }), /lease|processing|current/i);
    assert.equal(repository.ackFailure("outbox-5", { leaseToken: second.leaseToken, errorCode: "SEND_FAILED" }).status, "queued");
  });
});

test("worker client sends a rendered lease and always records an ack", async () => {
  await withDatabase(async (db) => {
    const clock = makeClock();
    const repository = createWeixinConfirmationOutboxRepository(db, { clock: clock.now, idFactory: () => "outbox-6" });
    repository.enqueue({ owner: "owner-1", conversationId: "conversation-1", idempotencyKey: "shortcut-event-6", payload: { amountCents: 6 } });
    const sent = [];
    const client = createWeixinOutboxClient({
      repository,
      workerId: "worker-client-1",
      renderMessage: (item) => `金额 ${item.payload.amountCents}`,
      sendMessage: async ({ owner, conversationId, message }) => {
        sent.push({ owner, conversationId, message });
        return { providerMessageId: "wx-1" };
      },
    });
    const result = await client.deliverNext();
    assert.equal(result.item.status, "sent");
    assert.deepEqual(sent, [{ owner: "owner-1", conversationId: "conversation-1", message: "金额 6" }]);
    assert.equal(await client.deliverNext(), null);
  });
});

test("worker client maps sender errors to a retryable code without persisting error text", async () => {
  await withDatabase(async (db) => {
    const clock = makeClock();
    const repository = createWeixinConfirmationOutboxRepository(db, { clock: clock.now, idFactory: () => "outbox-7" });
    repository.enqueue({ owner: "owner-1", conversationId: "conversation-1", idempotencyKey: "shortcut-event-7", payload: { amountCents: 7 } });
    const client = createWeixinOutboxClient({
      repository,
      workerId: "worker-client-2",
      renderMessage: () => "金额 7",
      sendMessage: async () => { throw new Error("provider credentials must never be stored"); },
    });
    const result = await client.deliverNext();
    assert.equal(result.item.status, "queued");
    assert.equal(result.item.lastErrorCode, "WEIXIN_SEND_FAILED");
    assert.equal(db.prepare("SELECT * FROM weixin_confirmation_outbox").get().last_error_code, "WEIXIN_SEND_FAILED");
    assert.equal(JSON.stringify(result).includes("provider credentials"), false);
  });
});
