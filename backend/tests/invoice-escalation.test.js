import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import {
  createInvoiceEscalationOutboxRenderer,
  DEFAULT_INVOICE_ESCALATION_LEVELS,
  evaluateInvoiceEscalationGap,
  invoiceEscalationIdempotencyKey,
  renderInvoiceEscalationMessage,
  shanghaiDateOnly,
} from "../src/travelExpense/invoiceEscalation.js";
import { createInvoiceEscalationScheduler } from "../src/travelExpense/invoiceEscalationScheduler.js";
import { createWeixinConfirmationOutboxRepository } from "../src/weixin/outboxRepository.js";

const OWNER_A = "invoice-owner-a";
const OWNER_B = "invoice-owner-b";

let db;
let now;
let deliveries;
let gapsByOwner;
let outboxSequence;

function gap(overrides = {}) {
  return {
    owner: OWNER_A,
    expenseId: "expense-a-1",
    expenseReference: "EXP-20260825-A1B2C3D4",
    revision: 1,
    missingCents: 12_800,
    startedOn: "2026-08-25",
    serverConfirmed: true,
    noInvoiceConfirmed: false,
    ...overrides,
  };
}

function outboxRows() {
  return db.prepare("SELECT * FROM weixin_confirmation_outbox ORDER BY created_at, id").all();
}

function createOutbox(overrides = {}) {
  return createWeixinConfirmationOutboxRepository(db, {
    clock: () => new Date(now),
    idFactory: () => `invoice-outbox-${++outboxSequence}`,
    ...overrides,
  });
}

function makeScheduler(overrides = {}) {
  const outboxRepository = overrides.outboxRepository ?? createOutbox();
  const scheduler = createInvoiceEscalationScheduler({
    outboxRepository,
    listInvoiceGaps: ({ owner, limit, afterExpenseId = null }) => (gapsByOwner.get(owner) ?? [])
      .toSorted((left, right) => left.expenseId.localeCompare(right.expenseId))
      .filter((item) => afterExpenseId === null || item.expenseId > afterExpenseId)
      .slice(0, limit),
    resolveDeliveries: () => deliveries,
    deliveryReady: () => true,
    clock: () => new Date(now),
    pollMs: 60_000,
    batchLimit: 50,
    ...overrides,
  });
  return { scheduler, outboxRepository };
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  now = "2026-08-28T01:00:00.000Z"; // 09:00 Asia/Shanghai, three calendar days open.
  deliveries = [{ account: OWNER_A, conversationId: "conversation-a" }];
  gapsByOwner = new Map([[OWNER_A, [gap()]]]);
  outboxSequence = 0;
});

afterEach(() => {
  db.close();
});

describe("invoice escalation core", () => {
  it("publishes immutable explicit 3/7/14-day defaults", () => {
    assert.deepEqual(DEFAULT_INVOICE_ESCALATION_LEVELS, [
      { level: 1, days: 3 },
      { level: 2, days: 7 },
      { level: 3, days: 14 },
    ]);
    assert.equal(Object.isFrozen(DEFAULT_INVOICE_ESCALATION_LEVELS), true);
    assert.equal(DEFAULT_INVOICE_ESCALATION_LEVELS.every(Object.isFrozen), true);
  });

  it("anchors the business date to the Asia/Shanghai midnight boundary", () => {
    assert.equal(shanghaiDateOnly(new Date("2026-08-27T15:59:59.999Z")), "2026-08-27");
    assert.equal(shanghaiDateOnly(new Date("2026-08-27T16:00:00.000Z")), "2026-08-28");

    const before = evaluateInvoiceEscalationGap({
      gap: gap(),
      now: new Date("2026-08-27T15:59:59.999Z"),
    });
    assert.deepEqual(before, { status: "not_due", asOfDate: "2026-08-27", daysOpen: 2 });

    const at = evaluateInvoiceEscalationGap({
      gap: gap(),
      now: new Date("2026-08-27T16:00:00.000Z"),
    });
    assert.equal(at.status, "due");
    assert.equal(at.level.level, 1);
    assert.equal(at.daysOpen, 3);
  });

  it("chooses only the highest currently due level and supports validated custom levels", () => {
    const daySeven = evaluateInvoiceEscalationGap({ gap: gap(), now: new Date("2026-09-01T04:00:00.000Z") });
    assert.equal(daySeven.level.level, 2);
    const dayTwenty = evaluateInvoiceEscalationGap({ gap: gap(), now: new Date("2026-09-14T04:00:00.000Z") });
    assert.equal(dayTwenty.level.level, 3, "an offline restart must not create a three-message catch-up burst");

    const custom = evaluateInvoiceEscalationGap({
      gap: gap(),
      now: new Date("2026-08-30T04:00:00.000Z"),
      levels: [{ level: 1, days: 2 }, { level: 2, days: 5 }],
    });
    assert.equal(custom.level.level, 2);
    assert.throws(
      () => evaluateInvoiceEscalationGap({ gap: gap(), now: new Date(now), levels: [{ level: 2, days: 7 }, { level: 1, days: 3 }] }),
      /levels/i,
    );
  });

  it("uses owner, expense, revision, and level in a bounded stable logical key", () => {
    const input = { gap: gap(), level: { level: 2, days: 7 } };
    const first = invoiceEscalationIdempotencyKey(input);
    assert.equal(first, invoiceEscalationIdempotencyKey(input));
    assert.match(first, /^invoice-gap-escalation:v1:[a-f0-9]{64}:level-2$/);
    assert.ok(first.length < 100);
    assert.notEqual(first, invoiceEscalationIdempotencyKey({ ...input, gap: gap({ owner: OWNER_B }) }));
    assert.notEqual(first, invoiceEscalationIdempotencyKey({ ...input, gap: gap({ revision: 2 }) }));
    assert.notEqual(first, invoiceEscalationIdempotencyKey({ gap: gap(), level: { level: 3, days: 14 } }));
    assert.equal(first.includes(OWNER_A), false);
    assert.equal(first.includes("expense-a-1"), false);
  });

  it("stops resolved or manually acknowledged gaps and rejects unconfirmed source data", () => {
    assert.deepEqual(
      evaluateInvoiceEscalationGap({ gap: gap({ missingCents: 0 }), now: new Date(now) }),
      { status: "resolved", reason: "fully_invoiced", asOfDate: "2026-08-28" },
    );
    assert.deepEqual(
      evaluateInvoiceEscalationGap({ gap: gap({ noInvoiceConfirmed: true }), now: new Date(now) }),
      { status: "resolved", reason: "no_invoice_confirmed", asOfDate: "2026-08-28" },
    );
    assert.throws(
      () => evaluateInvoiceEscalationGap({ gap: gap({ serverConfirmed: false }), now: new Date(now) }),
      /serverConfirmed/i,
    );
    assert.throws(
      () => evaluateInvoiceEscalationGap({ gap: gap({ missingCents: 1.5 }), now: new Date(now) }),
      /missingCents/i,
    );
  });

  it("renders a human-only reminder that cannot imply an automatic financial write", () => {
    const decision = evaluateInvoiceEscalationGap({ gap: gap(), now: new Date(now) });
    const message = renderInvoiceEscalationMessage(decision.payload);
    assert.match(message, /发票缺口提醒/);
    assert.match(message, /128\.00/);
    assert.match(message, /请人工补充并匹配发票，或由本人确认无票/);
    assert.match(message, /只负责提醒/);
    assert.match(message, /不会自动接收发票、确认无票或修改财务账/);
    assert.equal(decision.payload.humanActionRequired, true);
    assert.equal(decision.payload.automaticFinancialAction, false);
    assert.equal(Object.hasOwn(decision.payload, "owner"), false);
    assert.equal(Object.hasOwn(decision.payload, "actor"), false);
  });

  it("fences stale queued reminders against the current server gap at render time", () => {
    let current = gap();
    const renderer = createInvoiceEscalationOutboxRenderer({
      getInvoiceGap: ({ owner, expenseId }) => current.owner === owner && current.expenseId === expenseId ? current : null,
    });
    const payload = evaluateInvoiceEscalationGap({ gap: current, now: new Date(now) }).payload;
    assert.match(renderer({ owner: OWNER_A, payload }), /发票缺口提醒/);

    current = gap({ missingCents: 0 });
    assert.throws(
      () => renderer({ owner: OWNER_A, payload }),
      (error) => error?.code === "WEIXIN_OUTBOX_STALE",
    );
  });
});

describe("invoice escalation scheduler", () => {
  it("enqueues one level-one reminder at day three using only the server gap adapter", async () => {
    const { scheduler } = makeScheduler();
    const result = await scheduler.runOnce();
    assert.equal(result.status, "success");
    assert.equal(result.enqueuedCount, 1);
    assert.equal(result.asOfDate, "2026-08-28");
    const rows = outboxRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner, OWNER_A);
    assert.equal(rows[0].conversation_id, "conversation-a");
    const payload = JSON.parse(rows[0].payload_json);
    assert.equal(payload.kind, "invoice_gap_escalation");
    assert.equal(payload.level, 1);
    assert.equal(payload.missingCents, 12_800);
    assert.equal(payload.startedOn, "2026-08-25");
    assert.equal(Object.hasOwn(payload, "owner"), false);
  });

  it("does not enqueue before the first threshold", async () => {
    now = "2026-08-27T15:59:59.999Z";
    const { scheduler } = makeScheduler();
    const result = await scheduler.runOnce();
    assert.equal(result.enqueuedCount, 0);
    assert.equal(result.notDueCount, 1);
    assert.equal(outboxRows().length, 0);
  });

  it("deduplicates repeated ticks and a restarted scheduler through the durable outbox key", async () => {
    const outboxRepository = createOutbox();
    const first = makeScheduler({ outboxRepository });
    assert.equal((await first.scheduler.runOnce()).enqueuedCount, 1);
    assert.equal((await first.scheduler.runOnce()).alreadyEnqueuedCount, 1);
    const restarted = makeScheduler({ outboxRepository });
    assert.equal((await restarted.scheduler.runOnce()).alreadyEnqueuedCount, 1);
    assert.equal(outboxRows().length, 1);
  });

  it("progresses once at 3, 7, and 14 days without lower-level catch-up bursts", async () => {
    const { scheduler } = makeScheduler();
    assert.equal((await scheduler.runOnce()).enqueuedCount, 1);
    now = "2026-09-01T04:00:00.000Z";
    assert.equal((await scheduler.runOnce()).enqueuedCount, 1);
    now = "2026-09-08T04:00:00.000Z";
    assert.equal((await scheduler.runOnce()).enqueuedCount, 1);
    now = "2026-09-20T04:00:00.000Z";
    assert.equal((await scheduler.runOnce()).alreadyEnqueuedCount, 1);
    assert.deepEqual(outboxRows().map((row) => JSON.parse(row.payload_json).level), [1, 2, 3]);

    const offlineDb = openDatabase({ databaseUrl: ":memory:" });
    try {
      const offlineOutbox = createWeixinConfirmationOutboxRepository(offlineDb, { clock: () => new Date(now) });
      const offline = createInvoiceEscalationScheduler({
        outboxRepository: offlineOutbox,
        listInvoiceGaps: () => [gap()],
        resolveDeliveries: () => deliveries,
        deliveryReady: () => true,
        clock: () => new Date(now),
      });
      assert.equal((await offline.runOnce()).enqueuedCount, 1);
      assert.deepEqual(
        offlineDb.prepare("SELECT payload_json FROM weixin_confirmation_outbox").all().map((row) => JSON.parse(row.payload_json).level),
        [3],
      );
    } finally {
      offlineDb.close();
    }
  });

  it("recalculates a changed gap under a new revision and fences the old queued payload", async () => {
    now = "2026-09-01T04:00:00.000Z";
    const outboxRepository = createOutbox();
    const { scheduler } = makeScheduler({ outboxRepository });
    assert.equal((await scheduler.runOnce()).enqueuedCount, 1);
    gapsByOwner.set(OWNER_A, [gap({ revision: 2, missingCents: 4_000 })]);
    assert.equal((await scheduler.runOnce()).enqueuedCount, 1);
    assert.equal(outboxRows().length, 2);

    const renderer = createInvoiceEscalationOutboxRenderer({
      getInvoiceGap: ({ owner, expenseId }) => (gapsByOwner.get(owner) ?? []).find((item) => item.expenseId === expenseId) ?? null,
    });
    assert.equal(outboxRepository.leaseNext({ renderMessage: renderer }), null, "revision 1 is discarded as stale");
    const next = outboxRepository.leaseNext({ renderMessage: renderer });
    assert.ok(next);
    assert.equal(next.item.payload.missingCents, 4_000);
    const raw = outboxRows();
    assert.equal(raw[0].status, "failed");
    assert.equal(raw[0].last_error_code, "WEIXIN_OUTBOX_STALE");
  });

  it("stops on full invoice coverage or explicit no-invoice confirmation and discards a stale pending row", async () => {
    const outboxRepository = createOutbox();
    const { scheduler } = makeScheduler({ outboxRepository });
    assert.equal((await scheduler.runOnce()).enqueuedCount, 1);

    gapsByOwner.set(OWNER_A, [gap({ revision: 2, missingCents: 0 })]);
    const resolved = await scheduler.runOnce();
    assert.equal(resolved.resolvedCount, 1);
    assert.equal(resolved.enqueuedCount, 0);
    const renderer = createInvoiceEscalationOutboxRenderer({
      getInvoiceGap: ({ owner, expenseId }) => (gapsByOwner.get(owner) ?? []).find((item) => item.expenseId === expenseId) ?? null,
    });
    assert.equal(outboxRepository.leaseNext({ renderMessage: renderer }), null);
    assert.equal(outboxRows()[0].status, "failed");

    gapsByOwner.set(OWNER_A, [gap({ expenseId: "expense-a-2", revision: 1, noInvoiceConfirmed: true })]);
    const acknowledged = await scheduler.runOnce();
    assert.equal(acknowledged.resolvedCount, 1);
    assert.equal(outboxRows().length, 1);
  });

  it("does not manufacture a second logical reminder when provider delivery becomes terminal", async () => {
    const outboxRepository = createOutbox({ maxAttempts: 1 });
    const { scheduler } = makeScheduler({ outboxRepository });
    await scheduler.runOnce();
    const renderer = createInvoiceEscalationOutboxRenderer({ getInvoiceGap: () => gap() });
    const lease = outboxRepository.leaseNext({ renderMessage: renderer });
    const failed = outboxRepository.ackFailure(lease.item.id, {
      leaseToken: lease.leaseToken,
      errorCode: "WEIXIN_SEND_FAILED",
    });
    assert.equal(failed.status, "failed");
    const restarted = makeScheduler({ outboxRepository });
    assert.equal((await restarted.scheduler.runOnce()).alreadyEnqueuedCount, 1);
    assert.equal(outboxRows().length, 1);
  });

  it("retries a pre-commit enqueue failure without creating a duplicate row", async () => {
    const real = createOutbox();
    let fail = true;
    const flaky = {
      hasKey: (input) => real.hasKey(input),
      enqueue: (input) => {
        if (fail) throw new Error("outbox unavailable");
        return real.enqueue(input);
      },
    };
    const { scheduler } = makeScheduler({ outboxRepository: flaky });
    const first = await scheduler.runOnce();
    assert.equal(first.status, "failed");
    assert.equal(first.failedCount, 1);
    assert.equal(outboxRows().length, 0);
    fail = false;
    const retried = await scheduler.runOnce();
    assert.equal(retried.enqueuedCount, 1);
    assert.equal(outboxRows().length, 1);
  });

  it("fails closed on a cross-owner gap while continuing the correctly scoped owner", async () => {
    deliveries = [
      { account: OWNER_A, conversationId: "conversation-a" },
      { account: OWNER_B, conversationId: "conversation-b" },
    ];
    gapsByOwner = new Map([
      [OWNER_A, [gap({ owner: OWNER_B, expenseId: "malicious-cross-owner" })]],
      [OWNER_B, [gap({ owner: OWNER_B, expenseId: "expense-b-1" })]],
    ]);
    const { scheduler } = makeScheduler();
    const result = await scheduler.runOnce();
    assert.equal(result.status, "partial");
    assert.equal(result.failedCount, 1);
    assert.equal(result.enqueuedCount, 1);
    const rows = outboxRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner, OWNER_B);
    assert.equal(JSON.parse(rows[0].payload_json).expenseId, "expense-b-1");
  });

  it("skips when delivery is unavailable or no account target is bound", async () => {
    const unavailable = makeScheduler({ deliveryReady: () => false });
    assert.deepEqual(await unavailable.scheduler.runOnce(), { status: "skipped", reason: "delivery_not_ready" });
    deliveries = [];
    const empty = makeScheduler();
    assert.deepEqual(await empty.scheduler.runOnce(), { status: "skipped", reason: "no_delivery_targets" });
    assert.equal(outboxRows().length, 0);
  });

  it("bounds each owner scan, deduplicates owner targets, and exposes start-stop status", async () => {
    deliveries = [
      { account: OWNER_A, conversationId: "conversation-a" },
      { account: OWNER_A, conversationId: "conversation-duplicate" },
    ];
    gapsByOwner.set(OWNER_A, Array.from({ length: 3 }, (_, index) => gap({ expenseId: `expense-${index}` })));
    const { scheduler } = makeScheduler({ batchLimit: 2 });
    const result = await scheduler.runOnce();
    assert.equal(result.enqueuedCount, 2);
    assert.equal(result.truncatedOwnerCount, 1);
    assert.equal(outboxRows().length, 2);
    assert.equal(scheduler.status().running, false);
    scheduler.start();
    assert.equal(scheduler.status().running, true);
    scheduler.stop();
    assert.equal(scheduler.status().running, false);
    assert.equal(scheduler.status().businessTimeZone, "Asia/Shanghai");
  });

  it("advances a stable per-owner cursor so later gaps are never starved", async () => {
    gapsByOwner.set(OWNER_A, Array.from({ length: 5 }, (_, index) => gap({
      expenseId: `expense-${String(index).padStart(2, "0")}`,
    })));
    const { scheduler } = makeScheduler({ batchLimit: 2 });

    const first = await scheduler.runOnce();
    assert.equal(first.enqueuedCount, 2);
    assert.equal(first.truncatedOwnerCount, 1);
    assert.equal(scheduler.status().cursorOwnerCount, 1);
    const second = await scheduler.runOnce();
    assert.equal(second.enqueuedCount, 2);
    assert.equal(second.truncatedOwnerCount, 1);
    const third = await scheduler.runOnce();
    assert.equal(third.enqueuedCount, 1);
    assert.equal(third.truncatedOwnerCount, 0);
    assert.equal(scheduler.status().cursorOwnerCount, 0);
    assert.deepEqual(
      outboxRows().map((row) => JSON.parse(row.payload_json).expenseId).toSorted(),
      ["expense-00", "expense-01", "expense-02", "expense-03", "expense-04"],
    );
  });

  it("continues past an already-enqueued first page after a scheduler restart", async () => {
    gapsByOwner.set(OWNER_A, Array.from({ length: 3 }, (_, index) => gap({
      expenseId: `expense-${String(index).padStart(2, "0")}`,
    })));
    const outboxRepository = createOutbox();
    const first = makeScheduler({ batchLimit: 2, outboxRepository });
    assert.equal((await first.scheduler.runOnce()).enqueuedCount, 2);

    const restarted = makeScheduler({ batchLimit: 2, outboxRepository });
    const replayedFrontPage = await restarted.scheduler.runOnce();
    assert.equal(replayedFrontPage.alreadyEnqueuedCount, 2);
    assert.equal(replayedFrontPage.truncatedOwnerCount, 1);
    const laterPage = await restarted.scheduler.runOnce();
    assert.equal(laterPage.enqueuedCount, 1);
    assert.equal(outboxRows().length, 3);
  });

  it("drops a saved cursor when its owner delivery target is unbound", async () => {
    gapsByOwner.set(OWNER_A, Array.from({ length: 3 }, (_, index) => gap({
      expenseId: `expense-${String(index).padStart(2, "0")}`,
    })));
    const { scheduler } = makeScheduler({ batchLimit: 2 });
    assert.equal((await scheduler.runOnce()).truncatedOwnerCount, 1);
    assert.equal(scheduler.status().cursorOwnerCount, 1);

    deliveries = [];
    assert.deepEqual(await scheduler.runOnce(), { status: "skipped", reason: "no_delivery_targets" });
    assert.equal(scheduler.status().cursorOwnerCount, 0);
  });

  it("single-flights overlapping public ticks and reports ticking accurately", async () => {
    let releaseList;
    let listCallCount = 0;
    const listGate = new Promise((resolve) => { releaseList = resolve; });
    const { scheduler } = makeScheduler({
      listInvoiceGaps: async ({ owner, limit, afterExpenseId = null }) => {
        listCallCount += 1;
        await listGate;
        return (gapsByOwner.get(owner) ?? [])
          .toSorted((left, right) => left.expenseId.localeCompare(right.expenseId))
          .filter((item) => afterExpenseId === null || item.expenseId > afterExpenseId)
          .slice(0, limit);
      },
    });

    const first = scheduler.runOnce();
    const overlapping = scheduler.runOnce();
    assert.equal(first, overlapping);
    assert.equal(scheduler.status().ticking, true);
    releaseList();
    const [firstResult, overlappingResult] = await Promise.all([first, overlapping]);
    assert.deepEqual(overlappingResult, firstResult);
    assert.equal(listCallCount, 1);
    assert.equal(outboxRows().length, 1);
    assert.equal(scheduler.status().ticking, false);
  });
});
