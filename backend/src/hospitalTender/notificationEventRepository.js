import { createHash } from "node:crypto";

import { withImmediateTransaction } from "../db/transaction.js";
import { normalizeCollectionProgress } from "./collectionProgress.js";
import { prepareHospitalTenderPushplusNotices } from "./notificationMessage.js";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function freezeNotice(notice) {
  return Object.fromEntries([
    "id", "identityKey", "canonicalNoticeId", "sourceId", "sourceName", "title", "url",
    "publishedAt", "budgetText", "matchedCustomerNames", "match",
  ].map((key) => [key, notice[key]]));
}

export function createHospitalTenderNotificationEventRepository(db, { clock = () => new Date() } = {}) {
  const now = () => new Date(clock()).toISOString();
  const write = (work) => db.isTransaction ? work() : withImmediateTransaction(db, work);
  const selectEvent = db.prepare("SELECT id FROM hospital_tender_notification_events WHERE id = ?");
  const insertEvent = db.prepare(`
    INSERT INTO hospital_tender_notification_events
      (id, canonical_notice_id, customer_id, batch_id, status, created_at, acknowledged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  function enqueue({ notices, sourceNotices, customers, batchCustomerIds, cycleNumber, enabled } = {}) {
    if (!db.isTransaction) throw new TypeError("Tender notifications must be enqueued inside notice ingestion");
    const batchIds = new Set(batchCustomerIds);
    const prepared = prepareHospitalTenderPushplusNotices({ notices, sourceNotices, customers });
    if (prepared.length > 500) throw new TypeError("Tender notification batch contains too many notices");
    const events = [];
    const seenEvents = new Set();
    const selected = [];
    const names = new Map(customers.map((customer) => [String(customer.id), customer.name]));
    for (const notice of prepared) {
      const canonicalId = notice.canonicalNoticeId || notice.identityKey;
      if (!canonicalId) continue;
      const newIds = [...new Set(notice.match?.matchedCustomerIds ?? [])].filter((customerId) => {
        if (!batchIds.has(customerId)) return false;
        const id = digest([canonicalId, customerId]);
        if (selectEvent.get(id) || seenEvents.has(id)) return false;
        seenEvents.add(id);
        events.push({ id, canonicalId, customerId });
        return true;
      });
      if (!newIds.length) continue;
      selected.push(freezeNotice({
        ...notice,
        match: { matchedCustomerIds: newIds },
        matchedCustomerNames: newIds.map((id) => names.get(id)).filter(Boolean),
      }));
    }
    const createdAt = now();
    const batchId = enabled && events.length ? digest(events.map((event) => event.id).sort()) : null;
    if (batchId) {
      const payload = JSON.stringify({ cycleNumber, batchCustomerIds: [...batchIds], notices: selected });
      if (Buffer.byteLength(payload) > 5 * 1024 * 1024) throw new TypeError("Tender notification batch is too large");
      db.prepare(`INSERT INTO hospital_tender_notification_batches
        (id, cycle_number, payload_json, status, created_at) VALUES (?, ?, ?, 'pending', ?)`)
        .run(batchId, cycleNumber, payload, createdAt);
    }
    for (const event of events) {
      insertEvent.run(event.id, event.canonicalId, event.customerId, batchId,
        enabled ? "pending" : "suppressed", createdAt, enabled ? null : createdAt);
    }
    return { batchId, noticeCount: selected.length };
  }

  function pending({ activeCustomerIds, limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Notification limit is invalid");
    const active = new Set(activeCustomerIds);
    return write(() => {
      const pending = [];
      let cursor = null;
      while (pending.length < limit) {
        const rows = db.prepare(`
          SELECT id, created_at, payload_json FROM hospital_tender_notification_batches
          WHERE status = 'pending' AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
          ORDER BY created_at, id LIMIT ?
        `).all(cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.created_at ?? null,
          cursor?.id ?? null, limit - pending.length);
        if (!rows.length) break;
        for (const row of rows) {
          cursor = row;
          const payload = JSON.parse(row.payload_json);
          if (payload.notices.some((notice) => notice.match.matchedCustomerIds.some((id) => active.has(id)))) {
            pending.push({ id: row.id, payload });
          } else {
            settle(row.id, "cancelled");
          }
        }
      }
      return pending;
    });
  }

  function settle(id, status = "acknowledged") {
    if (!["acknowledged", "cancelled"].includes(status)) throw new TypeError("Notification batch status is invalid");
    return write(() => {
      const stamp = now();
      db.prepare(`UPDATE hospital_tender_notification_batches SET status = ?, acknowledged_at = ?
        WHERE id = ? AND status = 'pending'`).run(status, stamp, id);
      db.prepare(`UPDATE hospital_tender_notification_events SET status = ?, acknowledged_at = ?
        WHERE batch_id = ? AND status = 'pending'`).run(status, stamp, id);
    });
  }

  function collectionProgress() {
    return normalizeCollectionProgress(db.prepare(`
      SELECT source_id, configuration_digest, cursor_json FROM hospital_tender_collector_progress ORDER BY source_id
    `).all().map((row) => ({
      sourceId: row.source_id,
      configurationDigest: row.configuration_digest,
      cursor: JSON.parse(row.cursor_json),
    })));
  }

  function saveCollectionProgress(value) {
    const items = normalizeCollectionProgress(value);
    return write(() => {
      db.prepare("DELETE FROM hospital_tender_collector_progress").run();
      const insert = db.prepare(`INSERT INTO hospital_tender_collector_progress
        (source_id, configuration_digest, cursor_json, updated_at) VALUES (?, ?, ?, ?)`);
      for (const item of items) insert.run(item.sourceId, item.configurationDigest, JSON.stringify(item.cursor), now());
    });
  }

  return Object.freeze({ enqueue, pending, settle, collectionProgress, saveCollectionProgress });
}
