import { randomUUID } from "node:crypto";

function requiredText(value, name, max = 500, { allowNewlines = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  const controls = allowNewlines
    ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u
    : /[\u0000-\u001f\u007f-\u009f]/u;
  if (normalized.length > max || controls.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function map(row) {
  if (!row) return null;
  return {
    id: row.id,
    deliveryKey: row.delivery_key,
    cycleNumber: Number(row.cycle_number),
    title: row.title,
    content: row.content,
    status: row.status,
    providerShortCode: row.provider_short_code ?? null,
    attemptCount: Number(row.attempt_count),
    lastErrorCode: row.last_error_code ?? null,
    nextCheckAt: row.next_check_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createHospitalTenderPushplusDeliveryRepository(db, {
  clock = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (!db?.prepare) throw new TypeError("A synchronous SQLite connection is required");
  const nowIso = () => {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
    return date.toISOString();
  };
  const selectByKey = db.prepare("SELECT * FROM hospital_tender_pushplus_deliveries WHERE delivery_key = $key");
  const selectById = db.prepare("SELECT * FROM hospital_tender_pushplus_deliveries WHERE id = $id");

  function enqueue({ deliveryKey, cycleNumber, title, content } = {}) {
    const key = requiredText(deliveryKey, "deliveryKey", 64);
    if (!/^[0-9a-f]{64}$/u.test(key)) throw new TypeError("deliveryKey is invalid");
    if (!Number.isSafeInteger(cycleNumber) || cycleNumber < 0) throw new TypeError("cycleNumber is invalid");
    const normalizedTitle = requiredText(title, "title", 200);
    const normalizedContent = requiredText(content, "content", 3500, { allowNewlines: true });
    const existing = selectByKey.get({ $key: key });
    if (existing) return { item: map(existing), replayed: true };
    const id = requiredText(idFactory(), "id", 200);
    const now = nowIso();
    db.prepare(`INSERT INTO hospital_tender_pushplus_deliveries
      (id, delivery_key, cycle_number, title, content, status, created_at, updated_at)
      VALUES ($id, $key, $cycle, $title, $content, 'queued', $now, $now)`).run({
      $id: id, $key: key, $cycle: cycleNumber, $title: normalizedTitle, $content: normalizedContent, $now: now,
    });
    return { item: map(selectById.get({ $id: id })), replayed: false };
  }

  function beginAttempt(idValue) {
    const id = requiredText(idValue, "id", 200);
    const now = nowIso();
    db.prepare(`UPDATE hospital_tender_pushplus_deliveries SET status='submitting',
      attempt_count=attempt_count+1,last_error_code=NULL,next_check_at=NULL,updated_at=$now
      WHERE id=$id AND status IN ('queued','failed')`).run({ $id: id, $now: now });
    return map(selectById.get({ $id: id }));
  }

  function setState(idValue, { status, shortCode = null, errorCode = null, nextCheckAt = null } = {}) {
    if (!["accepted", "sent", "failed", "uncertain"].includes(status)) throw new TypeError("status is invalid");
    const id = requiredText(idValue, "id", 200);
    const now = nowIso();
    db.prepare(`UPDATE hospital_tender_pushplus_deliveries SET status=$status,
      provider_short_code=$shortCode,last_error_code=$errorCode,next_check_at=$nextCheckAt,updated_at=$now
      WHERE id=$id`).run({
      $id: id,
      $status: status,
      $shortCode: shortCode ? requiredText(shortCode, "shortCode", 200) : null,
      $errorCode: errorCode ? requiredText(errorCode, "errorCode", 100) : null,
      $nextCheckAt: nextCheckAt ? new Date(nextCheckAt).toISOString() : null,
      $now: now,
    });
    return map(selectById.get({ $id: id }));
  }

  function dueResultChecks({ limit = 30 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit is invalid");
    return db.prepare(`SELECT * FROM hospital_tender_pushplus_deliveries
      WHERE status='accepted' AND next_check_at IS NOT NULL AND next_check_at <= $now
      ORDER BY next_check_at, created_at LIMIT $limit`).all({ $now: nowIso(), $limit: limit }).map(map);
  }

  function deferResultCheck(idValue, { delayMs = 60_000, errorCode = null } = {}) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 1_000 || delayMs > 86_400_000) throw new TypeError("delayMs is invalid");
    const now = nowIso();
    const nextCheckAt = new Date(Date.parse(now) + delayMs).toISOString();
    const id = requiredText(idValue, "id", 200);
    db.prepare(`UPDATE hospital_tender_pushplus_deliveries SET next_check_at=$next,
      last_error_code=$error,updated_at=$now WHERE id=$id AND status='accepted'`).run({
      $id: id, $next: nextCheckAt, $error: errorCode, $now: now,
    });
    return map(selectById.get({ $id: id }));
  }

  function markInterruptedAttemptsUncertain() {
    const now = nowIso();
    return Number(db.prepare(`UPDATE hospital_tender_pushplus_deliveries SET status='uncertain',
      last_error_code='PUSHPLUS_SUBMISSION_OUTCOME_UNKNOWN',updated_at=$now
      WHERE status='submitting'`).run({ $now: now }).changes);
  }

  function statusCounts() {
    const counts = { queued: 0, submitting: 0, accepted: 0, sent: 0, failed: 0, uncertain: 0 };
    for (const row of db.prepare(`SELECT status,COUNT(*) AS count
      FROM hospital_tender_pushplus_deliveries GROUP BY status`).all()) {
      if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count);
    }
    return { ...counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
  }

  return Object.freeze({ enqueue, beginAttempt, setState, dueResultChecks, deferResultCheck, markInterruptedAttemptsUncertain, statusCounts });
}
