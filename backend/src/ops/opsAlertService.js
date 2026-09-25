// Machine-facing ops-alert intake. Validation is fail-closed (unknown fields
// rejected), and the persisted notification adapter owns idempotency.

import { HttpError } from "../http/errors.js";

const SOURCE_RE = /^[A-Za-z0-9:._@-]{1,100}$/u;
const EVENT_ID_RE = /^[A-Za-z0-9:._@-]{1,200}$/u;
const SEVERITIES = new Set(["critical", "warning"]);
const ALLOWED_FIELDS = new Set(["source", "severity", "summary", "detail", "occurredAt", "eventId"]);
const MAX_SUMMARY_CHARS = 300;
const MAX_DETAIL_CHARS = 2000;

function validationError(details) {
  return new HttpError(422, "VALIDATION_ERROR", "Request validation failed", details);
}

function boundedText(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw validationError({ [name]: "required" });
    return null;
  }
  if (typeof value !== "string") throw validationError({ [name]: "invalid" });
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw validationError({ [name]: "required" });
    return null;
  }
  if (normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw validationError({ [name]: "invalid" });
  }
  return normalized;
}

function validateAlertInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw validationError({ body: "invalid" });
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) throw validationError({ [key]: "unknown_field" });
  }
  const source = boundedText(body.source, "source", 100, { required: true });
  if (!SOURCE_RE.test(source)) throw validationError({ source: "invalid" });
  const severity = boundedText(body.severity, "severity", 20, { required: true });
  if (!SEVERITIES.has(severity)) throw validationError({ severity: "invalid" });
  const summary = boundedText(body.summary, "summary", MAX_SUMMARY_CHARS, { required: true });
  const detail = boundedText(body.detail, "detail", MAX_DETAIL_CHARS);
  const occurredAtRaw = boundedText(body.occurredAt, "occurredAt", 64);
  let occurredAt = null;
  if (occurredAtRaw !== null) {
    const parsed = Date.parse(occurredAtRaw);
    if (!Number.isFinite(parsed)) throw validationError({ occurredAt: "invalid" });
    occurredAt = new Date(parsed).toISOString();
  }
  const eventId = boundedText(body.eventId, "eventId", 200);
  if (eventId !== null && !EVENT_ID_RE.test(eventId)) throw validationError({ eventId: "invalid" });
  return { source, severity, summary, detail, occurredAt, eventId };
}

export function createOpsAlertService({
  outboxRepository,
  resolveDeliveries,
  deliveryMode = "weixin_outbox",
  recordAudit = null,
  clock = () => new Date(),
} = {}) {
  if (!outboxRepository || typeof outboxRepository.enqueue !== "function") {
    throw new TypeError("outboxRepository is required");
  }
  if (typeof resolveDeliveries !== "function") {
    throw new TypeError("resolveDeliveries is required");
  }
  if (recordAudit !== null && typeof recordAudit !== "function") {
    throw new TypeError("recordAudit must be a function");
  }

  async function receive(body, { actor, requestId = null } = {}) {
    const input = validateAlertInput(body);
    const now = clock();
    const nowDate = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(nowDate.getTime())) throw new TypeError("clock must return a valid Date");
    const nowIso = nowDate.toISOString();
    // Script-originated failures carry a stable event id so an accepted POST
    // whose HTTP response is lost can be retried after a restart or hour roll
    // without a duplicate outbox row. Older callers retain the source/hour
    // storm gate and therefore still re-alert persistent faults hourly.
    const hourKey = nowIso.slice(0, 13);
    const idempotencyKey = input.eventId
      ? `ops-alert:event:${input.eventId}`
      : `ops-alert:${input.source}:${hourKey}`;
    const payload = {
      kind: "ops_alert",
      // The `source` input is renamed `origin` at rest: the outbox payload
      // inspector rejects any key containing the "source" substring.
      origin: input.source,
      severity: input.severity,
      summary: input.summary,
      ...(input.detail ? { detail: input.detail } : {}),
      occurredAt: input.occurredAt ?? nowIso,
    };

    let item;
    let delivery;
    // 运维告警进入 active admin 的站内通知中心，不依赖微信绑定或订阅设置。
    // 幂等键按 owner 隔离；没有 active admin 时明确失败。
    let targets = [];
    try {
      targets = (resolveDeliveries() ?? [])
        .map((target) => ({
          owner: String(target?.account ?? target?.owner ?? "").trim(),
          conversationId: String(target?.conversationId ?? "in-app").trim(),
        }))
        .filter((target) => target.owner && target.conversationId);
    } catch {
      targets = [];
    }
    if (targets.length > 0) {
      let firstQueued = null;
      let anyNew = false;
      for (const target of targets) {
        let queued;
        try {
          queued = outboxRepository.enqueue({
            owner: target.owner,
            conversationId: target.conversationId,
            idempotencyKey: `${idempotencyKey}:${target.owner}`,
            payload,
          });
        } catch (error) {
          // Same source/event gate but with different content (for example a
          // fresh journal tail): the gate must still hold, so report a replay
          // instead of surfacing the outbox idempotency 409.
          if (error?.code !== "WEIXIN_OUTBOX_IDEMPOTENCY_CONFLICT") throw error;
          queued = null;
        }
        if (queued && !queued.replayed) anyNew = true;
        if (queued && !firstQueued) firstQueued = queued;
      }
      item = firstQueued
        ? { id: firstQueued.id, status: firstQueued.status, replayed: !anyNew }
        : { id: null, status: "deduplicated", replayed: true };
      delivery = deliveryMode;
    } else {
      throw new HttpError(503, "OPS_ALERT_DELIVERY_UNAVAILABLE", "No active admin in-app notification recipient is available");
    }

    try {
      recordAudit?.({
        actor,
        requestId,
        entityId: idempotencyKey,
        metadata: { severity: input.severity, delivery, replayed: item.replayed },
      });
    } catch {
      // Auditing must never turn a delivered alert into a caller-visible
      // failure; the outbox side effect already happened.
    }
    return { item };
  }

  return Object.freeze({ receive });
}
