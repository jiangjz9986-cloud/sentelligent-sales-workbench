import { createExecutionDrain } from "../services/executionDrain.js";
import {
  DEFAULT_INVOICE_ESCALATION_LEVELS,
  evaluateInvoiceEscalationGap,
  invoiceEscalationIdempotencyKey,
  normalizeInvoiceEscalationLevels,
  renderInvoiceEscalationMessage,
  shanghaiDateOnly,
} from "./invoiceEscalation.js";

const MAX_TIMER_DELAY = 2 ** 31 - 1;
const BUSINESS_TIME_ZONE = "Asia/Shanghai";

function validClockDate(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
  return date;
}

function normalizeDeliveries(value) {
  if (!Array.isArray(value)) return [];
  const byOwner = new Map();
  for (const target of value) {
    const owner = String(target?.account ?? target?.owner ?? "").trim();
    const conversationId = String(target?.conversationId ?? "").trim();
    if (owner && conversationId && !byOwner.has(owner)) byOwner.set(owner, { owner, conversationId });
  }
  return [...byOwner.values()];
}

function emptyCounts() {
  return {
    enqueuedCount: 0,
    alreadyEnqueuedCount: 0,
    notDueCount: 0,
    resolvedCount: 0,
    failedCount: 0,
    truncatedOwnerCount: 0,
  };
}

export function createInvoiceEscalationScheduler({
  outboxRepository,
  listInvoiceGaps,
  resolveDeliveries,
  deliveryReady,
  clock = () => new Date(),
  levels = DEFAULT_INVOICE_ESCALATION_LEVELS,
  pollMs = 60_000,
  batchLimit = 50,
} = {}) {
  if (!outboxRepository || typeof outboxRepository.hasKey !== "function"
    || typeof outboxRepository.enqueue !== "function") {
    throw new TypeError("outboxRepository with hasKey and enqueue is required");
  }
  if (typeof listInvoiceGaps !== "function") throw new TypeError("listInvoiceGaps must be a function");
  if (typeof resolveDeliveries !== "function") throw new TypeError("resolveDeliveries must be a function");
  if (typeof deliveryReady !== "function") throw new TypeError("deliveryReady must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(pollMs) || pollMs < 1_000 || pollMs > 3_600_000) throw new TypeError("pollMs is invalid");
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) throw new TypeError("batchLimit is invalid");
  const normalizedLevels = normalizeInvoiceEscalationLevels(levels);

  let timer = null;
  let ticking = false;
  let stopped = true;
  let inFlight = null;
  // The adapter contract is a stable lexical expenseId page. Keeping only one
  // cursor per bound owner is bounded by the number of delivery targets and
  // lets later gaps make progress without ever loading an unbounded result.
  const cursorByOwner = new Map();
  const state = {
    lastTickAt: null,
    lastStatus: null,
    lastAsOfDate: null,
    lastCounts: emptyCounts(),
  };

  const execution = createExecutionDrain();
  function executeRunOnce() { return execution.run(performRunOnce); }
  async function performRunOnce() {
    let now;
    try {
      now = validClockDate(clock);
    } catch {
      const counts = { ...emptyCounts(), failedCount: 1 };
      state.lastStatus = "failed";
      state.lastCounts = counts;
      return { status: "failed", ...counts };
    }
    const asOfDate = shanghaiDateOnly(now);
    state.lastTickAt = now.toISOString();
    state.lastAsOfDate = asOfDate;

    try {
      if (!(await deliveryReady())) {
        state.lastStatus = "skipped";
        state.lastCounts = emptyCounts();
        return { status: "skipped", reason: "delivery_not_ready" };
      }
    } catch {
      const counts = { ...emptyCounts(), failedCount: 1 };
      state.lastStatus = "failed";
      state.lastCounts = counts;
      return { status: "failed", asOfDate, ...counts };
    }

    let deliveries;
    try {
      deliveries = normalizeDeliveries(await resolveDeliveries());
    } catch {
      deliveries = [];
    }
    const activeOwners = new Set(deliveries.map((delivery) => delivery.owner));
    for (const owner of cursorByOwner.keys()) {
      if (!activeOwners.has(owner)) cursorByOwner.delete(owner);
    }
    if (deliveries.length === 0) {
      state.lastStatus = "skipped";
      state.lastCounts = emptyCounts();
      return { status: "skipped", reason: "no_delivery_targets" };
    }

    const counts = emptyCounts();
    for (const delivery of deliveries) {
      let listed;
      const afterExpenseId = cursorByOwner.get(delivery.owner) ?? null;
      try {
        listed = await listInvoiceGaps({
          owner: delivery.owner,
          limit: batchLimit + 1,
          afterExpenseId,
        });
        if (!Array.isArray(listed)) throw new TypeError("listInvoiceGaps must return an array");
      } catch {
        counts.failedCount += 1;
        continue;
      }
      const page = listed.slice(0, batchLimit);
      let previousExpenseId = afterExpenseId;
      let pageContractValid = true;
      for (const gap of page) {
        const expenseId = typeof gap?.expenseId === "string" ? gap.expenseId.trim() : "";
        if (!expenseId || (previousExpenseId !== null && expenseId <= previousExpenseId)) {
          pageContractValid = false;
          break;
        }
        previousExpenseId = expenseId;
      }
      if (!pageContractValid) {
        counts.failedCount += 1;
        cursorByOwner.delete(delivery.owner);
        continue;
      }
      if (listed.length > batchLimit) {
        counts.truncatedOwnerCount += 1;
        cursorByOwner.set(delivery.owner, previousExpenseId);
      } else {
        cursorByOwner.delete(delivery.owner);
      }
      for (const gap of page) {
        if (typeof gap?.owner !== "string" || gap.owner.trim() !== delivery.owner) {
          counts.failedCount += 1;
          continue;
        }
        try {
          const decision = evaluateInvoiceEscalationGap({ gap, now, levels: normalizedLevels });
          if (decision.status === "resolved") {
            counts.resolvedCount += 1;
            continue;
          }
          if (decision.status === "not_due") {
            counts.notDueCount += 1;
            continue;
          }

          renderInvoiceEscalationMessage(decision.payload);
          const idempotencyKey = invoiceEscalationIdempotencyKey({ gap, level: decision.level });
          if (await outboxRepository.hasKey({ owner: delivery.owner, idempotencyKey })) {
            counts.alreadyEnqueuedCount += 1;
            continue;
          }
          const enqueued = await outboxRepository.enqueue({
            owner: delivery.owner,
            conversationId: delivery.conversationId,
            idempotencyKey,
            payload: decision.payload,
          });
          if (enqueued?.replayed === true) counts.alreadyEnqueuedCount += 1;
          else counts.enqueuedCount += 1;
        } catch {
          counts.failedCount += 1;
        }
      }
    }

    const usefulCount = counts.enqueuedCount + counts.alreadyEnqueuedCount
      + counts.notDueCount + counts.resolvedCount;
    const status = counts.failedCount === 0 ? "success" : usefulCount > 0 ? "partial" : "failed";
    state.lastStatus = status;
    state.lastCounts = { ...counts };
    return { status, asOfDate, ...counts };
  }

  function runOnce() {
    if (inFlight) return inFlight;
    ticking = true;
    const operation = executeRunOnce();
    inFlight = operation.finally(() => {
      ticking = false;
      inFlight = null;
    });
    return inFlight;
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await runOnce();
      } finally {
        scheduleNext();
      }
    }, Math.min(pollMs, MAX_TIMER_DELAY));
    timer.unref?.();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    scheduleNext();
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function status() {
    return {
      running: !stopped,
      ticking,
      pollMs,
      batchLimit,
      businessTimeZone: BUSINESS_TIME_ZONE,
      lastTickAt: state.lastTickAt,
      lastStatus: state.lastStatus,
      lastAsOfDate: state.lastAsOfDate,
      cursorOwnerCount: cursorByOwner.size,
      ...state.lastCounts,
    };
  }

  return Object.freeze({ start, stop, runOnce, status, drain(options) { stop(); return execution.drain(options); } });
}
