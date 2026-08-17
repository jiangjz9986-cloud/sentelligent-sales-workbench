import { randomUUID } from "node:crypto";

import { ingestHospitalTenderSnapshot, customerSnapshotFromRow } from "./sync.js";

const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LOCK_LEASE_MS = 15 * 60 * 1000;

function validClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid Date");
  return value;
}

function customerId(customer) {
  return String(customer?.id ?? "").trim();
}

function compareCustomerIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableCustomers(customers) {
  if (!Array.isArray(customers)) throw new TypeError("customers must be an array");
  const seen = new Set();
  return customers
    .filter((customer) => customer && customerId(customer))
    .map((customer) => ({ ...customer, id: customerId(customer) }))
    .filter((customer) => {
      if (seen.has(customer.id)) return false;
      seen.add(customer.id);
      return true;
    })
    .sort((left, right) => compareCustomerIds(left.id, right.id));
}

function nextCustomers(customers, cursorCustomerId, batchSize) {
  const cursor = cursorCustomerId ? String(cursorCustomerId) : "";
  const start = cursor
    ? customers.findIndex((customer) => compareCustomerIds(customer.id, cursor) > 0)
    : 0;
  if (start < 0) return [];
  return customers.slice(start, start + batchSize);
}

function addMinutes(isoDate, minutes) {
  return new Date(Date.parse(isoDate) + minutes * 60_000).toISOString();
}

function collectorCustomers(customers) {
  const seenNames = new Set();
  return customers.flatMap((customer) => {
    const snapshot = customerSnapshotFromRow(customer);
    const name = String(snapshot.name ?? "").trim();
    const normalizedName = name.toLocaleLowerCase();
    if (!name || seenNames.has(normalizedName)) return [];
    seenNames.add(normalizedName);
    const aliases = [];
    const seenAliases = new Set();
    for (const value of [
      ...(Array.isArray(customer.aliases) ? customer.aliases : []),
      ...(Array.isArray(customer.needs) ? customer.needs : []),
    ]) {
      const alias = typeof value === "string" ? value.trim().slice(0, 200) : "";
      const normalizedAlias = alias.toLocaleLowerCase();
      if (!alias || normalizedAlias === normalizedName || seenAliases.has(normalizedAlias)) continue;
      seenAliases.add(normalizedAlias);
      aliases.push(alias);
      if (aliases.length === 30) break;
    }
    return [{
      ...snapshot,
      name,
      region: String(customer.region ?? customer.city ?? "全国").slice(0, 100),
      status: "direct",
      source_ids: [],
      aliases,
    }];
  });
}

function safeError(error, fallback = "医院招标轮巡失败") {
  const message = String(error?.message ?? "").trim();
  if (!message || message.length > 500 || /token|secret|bearer|password|key/i.test(message)) return fallback;
  return message;
}

function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

/**
 * Hourly, resumable customer-batch scheduler for the built-in tender runner.
 * The public-source snapshot is collected once per cycle and reused while the
 * cursor advances through stable customer ids in bounded batches.
 */
export function createHospitalTenderScheduler({
  db,
  repository,
  tenderRepository,
  runner,
  customersProvider,
  notifier = null,
  clock = () => new Date(),
  idFactory = randomUUID,
  intervalMinutes = DEFAULT_INTERVAL_MINUTES,
  batchSize = DEFAULT_BATCH_SIZE,
  lockLeaseMs = DEFAULT_LOCK_LEASE_MS,
} = {}) {
  if (!db || !repository || !tenderRepository || !runner || typeof runner.run !== "function") {
    throw new TypeError("db, repository, tenderRepository, and runner are required");
  }
  if (typeof customersProvider !== "function") throw new TypeError("customersProvider is required");
  if (typeof notifier !== "function" && notifier !== null) throw new TypeError("notifier must be a function");
  const configuredInterval = Number.isSafeInteger(intervalMinutes) && intervalMinutes > 0
    ? intervalMinutes
    : DEFAULT_INTERVAL_MINUTES;
  const configuredBatchSize = Number.isSafeInteger(batchSize) && batchSize > 0
    ? batchSize
    : DEFAULT_BATCH_SIZE;
  const leaseMs = Number.isSafeInteger(lockLeaseMs) && lockLeaseMs > 0 ? lockLeaseMs : DEFAULT_LOCK_LEASE_MS;
  let timer = null;
  let started = false;

  function now() {
    return validClock(clock);
  }

  function currentCustomers() {
    return stableCustomers(customersProvider());
  }

  function state() {
    return repository.getState();
  }

  function ensureDefaults() {
    const current = state();
    if (!current) throw new Error("hospital tender scheduler state is not initialized");
    // Migration defaults are authoritative once persisted. Explicit options are
    // only used when an older database has no usable values.
    if (!Number.isSafeInteger(current.intervalMinutes) || current.intervalMinutes <= 0
      || !Number.isSafeInteger(current.batchSize) || current.batchSize <= 0) {
      return repository.updateState({ intervalMinutes: configuredInterval, batchSize: configuredBatchSize });
    }
    return current;
  }

  function scheduleNext(minimumDelayMs = 0) {
    if (!started) return;
    if (timer) clearTimeout(timer);
    const current = ensureDefaults();
    if (!current.enabled) {
      started = false;
      timer = null;
      return;
    }
    const currentTime = now();
    const nextAt = current.nextRunAt
      ? Date.parse(current.nextRunAt)
      : Date.parse(repository.updateState({
        nextRunAt: addMinutes(currentTime.toISOString(), current.intervalMinutes),
      }).nextRunAt);
    const delay = Math.max(
      Math.max(0, minimumDelayMs),
      Math.max(0, Math.min(nextAt - currentTime.getTime(), 2 ** 31 - 1)),
    );
    timer = setTimeout(async () => {
      let retryDelayMs = 0;
      try {
        const result = await runNext();
        if (result.status === "skipped" && result.reason === "locked") retryDelayMs = 60_000;
      } catch {
        // The state and next_run_at are persisted by runNext. The timer must
        // remain alive even when a source or notification fails.
      } finally {
        scheduleNext(retryDelayMs);
      }
    }, delay);
    timer.unref?.();
  }

  async function runNext({ force = false } = {}) {
    const owner = `hospital-tender-scheduler-${idFactory()}`;
    const startedAt = now().toISOString();
    const lockedUntil = new Date(Date.parse(startedAt) + leaseMs).toISOString();
    if (!repository.tryAcquireLock(owner, lockedUntil)) {
      return { status: "skipped", reason: "locked", state: state() };
    }
    let runId = null;
    try {
      let current = ensureDefaults();
      if (!current.enabled && !force) {
        const disabled = repository.updateState({ lastStatus: "disabled", nextRunAt: null });
        return { status: "disabled", state: disabled };
      }
      const nowIso = startedAt;
      if (!force && current.nextRunAt && Date.parse(current.nextRunAt) > Date.parse(nowIso)) {
        return { status: "waiting", state: current };
      }

      let customers = currentCustomers();
      if (customers.length === 0) {
        const pendingSnapshot = current.snapshotId ? repository.getSnapshot(current.snapshotId) : null;
        if (pendingSnapshot?.status === "pending") {
          repository.updateSnapshot(pendingSnapshot.id, { status: "completed", completedAt: nowIso });
        }
        const empty = repository.updateState({
          snapshotId: null,
          cursorCustomerId: null,
          lastStartedAt: nowIso,
          lastFinishedAt: nowIso,
          lastStatus: "success",
          lastError: null,
          cycleCustomerCount: 0,
          cycleProcessedCount: 0,
          lastBatchCount: 0,
          lastHighRelevanceCount: 0,
          notificationCount: 0,
          nextRunAt: addMinutes(nowIso, current.intervalMinutes),
        });
        return { status: "success", batchCount: 0, state: empty };
      }

      let snapshot = current.snapshotId ? repository.getSnapshot(current.snapshotId) : null;
      if (!snapshot || snapshot.status !== "pending") {
        const cycleNumber = current.cycleNumber + 1;
        repository.updateState({
          lastStartedAt: nowIso,
          lastStatus: "running",
          lastError: null,
          cycleNumber,
          cycleCustomerCount: customers.length,
          cycleProcessedCount: 0,
        });
        let collected;
        try {
          collected = await runner.run({
            // Pass the complete unique-name registry so the collector retains
            // customer-aware keyword context while the main system performs
            // the durable ten-customer matching batches below.
            customerHospitals: collectorCustomers(customers),
          });
        } catch (error) {
          const finishedAt = now().toISOString();
          const errorText = safeError(error);
          repository.recordRun({
            cycleNumber,
            batchCount: 0,
            startedAt: nowIso,
            finishedAt,
            status: "failed",
            errorText,
          });
          repository.updateState({
            lastStartedAt: nowIso,
            lastFinishedAt: finishedAt,
            lastStatus: "failed",
            lastError: errorText,
            lastHighRelevanceCount: 0,
            notificationCount: 0,
            nextRunAt: addMinutes(finishedAt, current.intervalMinutes),
          });
          throw error;
        }
        snapshot = repository.saveSnapshot({
          cycleNumber,
          generatedAt: collected.payload.generatedAt,
          payload: collected.payload,
          status: "pending",
        });
        current = repository.updateState({
          cycleNumber,
          snapshotId: snapshot.id,
          cursorCustomerId: null,
          cycleCustomerCount: customers.length,
          cycleProcessedCount: 0,
          lastStartedAt: nowIso,
          lastStatus: "running",
          lastError: null,
        });
      }

      customers = currentCustomers();
      const batch = nextCustomers(customers, current.cursorCustomerId, current.batchSize);
      if (batch.length === 0) {
        const finishedAt = now().toISOString();
        repository.updateSnapshot(snapshot.id, { status: "completed", completedAt: finishedAt });
        const completed = repository.updateState({
          snapshotId: null,
          cursorCustomerId: null,
          lastFinishedAt: finishedAt,
          lastStatus: "success",
          lastError: null,
          cycleCustomerCount: customers.length,
          cycleProcessedCount: Math.min(current.cycleProcessedCount, customers.length),
          nextRunAt: addMinutes(finishedAt, current.intervalMinutes),
        });
        return { status: "success", batchCount: 0, state: completed };
      }

      runId = idFactory();
      repository.recordRun({
        id: runId,
        cycleNumber: current.cycleNumber,
        snapshotId: snapshot.id,
        batchStartCustomerId: batch[0].id,
        batchEndCustomerId: batch.at(-1).id,
        batchCount: batch.length,
        startedAt: nowIso,
        status: "running",
      });
      repository.updateState({
        lastStartedAt: nowIso,
        lastStatus: "running",
        lastError: null,
        lastBatchStartCustomerId: batch[0].id,
        lastBatchEndCustomerId: batch.at(-1).id,
        lastBatchCount: batch.length,
        cycleCustomerCount: customers.length,
      });

      let result;
      try {
        result = transaction(db, () => ingestHospitalTenderSnapshot({
          repository: tenderRepository,
          payload: snapshot.payload,
          customers: batch,
          // The first batch starts a fresh match sidecar for the new source
          // snapshot. Later batches merge into that same cycle only.
          mergeMatches: Boolean(current.cursorCustomerId),
          persistSources: !current.cursorCustomerId,
          persistRuns: !current.cursorCustomerId,
          persistAggregateRun: !current.cursorCustomerId,
        }));
      } catch (error) {
        const finishedAt = now().toISOString();
        repository.updateRun(runId, {
          finishedAt,
          status: "failed",
          errorText: safeError(error),
        });
        repository.updateState({
          lastFinishedAt: finishedAt,
          lastStatus: "failed",
          lastError: safeError(error),
          nextRunAt: addMinutes(finishedAt, current.intervalMinutes),
        });
        throw error;
      }

      if (result.rejectedCount > 0) {
        const finishedAt = now().toISOString();
        const errorText = "部分公告未能入库";
        repository.updateRun(runId, {
          finishedAt,
          status: "partial",
          acceptedCount: result.acceptedCount,
          rejectedCount: result.rejectedCount,
          errorText,
        });
        repository.updateState({
          lastFinishedAt: finishedAt,
          lastStatus: "partial",
          lastError: errorText,
          lastAcceptedCount: result.acceptedCount,
          lastRejectedCount: result.rejectedCount,
          lastHighRelevanceCount: 0,
          notificationCount: 0,
          nextRunAt: addMinutes(finishedAt, current.intervalMinutes),
        });
        return {
          status: "partial",
          error: errorText,
          acceptedCount: result.acceptedCount,
          rejectedCount: result.rejectedCount,
          state: state(),
        };
      }

      const batchCustomerIds = new Set(batch.map((item) => item.id));
      const retryingNotification = current.lastStatus === "partial"
        && current.lastError === "招标通知发送失败"
        && current.lastBatchStartCustomerId === batch[0].id
        && current.lastBatchEndCustomerId === batch.at(-1).id;
      const newHighNotices = result.notices.filter((notice) => (
        notice.relevance === "high"
        && (notice.firstSeenAt === notice.lastSeenAt || retryingNotification)
        && notice.match?.matchedCustomerIds?.some((id) => batchCustomerIds.has(id))
      ));
      let notificationCount = 0;
      if (notifier && newHighNotices.length > 0) {
        try {
          const notified = await notifier({
            cycleNumber: current.cycleNumber,
            batchCustomerIds: batch.map((item) => item.id),
            notices: newHighNotices,
          });
          notificationCount = Number.isSafeInteger(notified) && notified >= 0
            ? notified
            : newHighNotices.length;
        } catch (error) {
          const finishedAt = now().toISOString();
          // Notification provider details stay out of persisted state and API
          // responses; the batch remains retryable on the next tick.
          const errorText = "招标通知发送失败";
          repository.updateRun(runId, {
            finishedAt,
            status: "partial",
            acceptedCount: result.acceptedCount,
            rejectedCount: result.rejectedCount,
            highRelevanceCount: newHighNotices.length,
            errorText,
          });
          repository.updateState({
            lastFinishedAt: finishedAt,
            lastStatus: "partial",
            lastError: errorText,
            lastAcceptedCount: result.acceptedCount,
            lastRejectedCount: result.rejectedCount,
            lastHighRelevanceCount: newHighNotices.length,
            notificationCount: 0,
            nextRunAt: addMinutes(finishedAt, current.intervalMinutes),
          });
          return { status: "partial", error: errorText, acceptedCount: result.acceptedCount, rejectedCount: result.rejectedCount, state: state() };
        }
      }

      const finishedAt = now().toISOString();
      const hasNext = customers.some((customer) => compareCustomerIds(customer.id, batch.at(-1).id) > 0);
      if (!hasNext) {
        repository.updateSnapshot(snapshot.id, { status: "completed", completedAt: finishedAt });
      }
      const updated = repository.updateState({
        snapshotId: hasNext ? snapshot.id : null,
        cursorCustomerId: hasNext ? batch.at(-1).id : null,
        lastFinishedAt: finishedAt,
        lastStatus: "success",
        lastError: null,
        lastBatchStartCustomerId: batch[0].id,
        lastBatchEndCustomerId: batch.at(-1).id,
        lastBatchCount: batch.length,
        lastAcceptedCount: result.acceptedCount,
        lastRejectedCount: result.rejectedCount,
        lastHighRelevanceCount: newHighNotices.length,
        notificationCount,
        cycleProcessedCount: Math.min(
          customers.length,
          current.cycleProcessedCount + batch.length,
        ),
        nextRunAt: addMinutes(finishedAt, current.intervalMinutes),
      });
      repository.updateRun(runId, {
        finishedAt,
        status: "success",
        acceptedCount: result.acceptedCount,
        rejectedCount: result.rejectedCount,
        highRelevanceCount: newHighNotices.length,
        notificationCount,
        errorText: null,
      });
      return {
        status: "success",
        cycleNumber: current.cycleNumber,
        batchCustomerIds: batch.map((item) => item.id),
        acceptedCount: result.acceptedCount,
        rejectedCount: result.rejectedCount,
        notificationCount,
        state: updated,
      };
    } catch (error) {
      if (error?.code === "HOSPITAL_TENDER_INTERNAL_RUN_FAILED") throw error;
      throw error;
    } finally {
      repository.releaseLock(owner);
    }
  }

  function start() {
    if (started) return;
    if (!ensureDefaults().enabled) return;
    started = true;
    scheduleNext();
  }

  function stop() {
    started = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    runNext,
    start,
    stop,
    isStarted: () => started,
    getState: state,
    listRuns: repository.listRuns,
  };
}

export { collectorCustomers, nextCustomers, stableCustomers };
