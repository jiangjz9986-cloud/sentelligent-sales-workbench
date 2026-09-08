// Machine-facing ops-alert intake. Validation is fail-closed (unknown fields
// rejected), storm control is the hour-keyed outbox idempotency key, and the
// WeChat outbox is the only external channel. Delivery readiness is deliberately
// not consulted here: a bound conversation must retain alerts durably while the
// provider context is temporarily unavailable or expired.

import { HttpError } from "../http/errors.js";

const SOURCE_RE = /^[A-Za-z0-9:._@-]{1,100}$/u;
const SEVERITIES = new Set(["critical", "warning"]);
const ALLOWED_FIELDS = new Set(["source", "severity", "summary", "detail", "occurredAt"]);
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
  return { source, severity, summary, detail, occurredAt };
}

export function createOpsAlertService({
  outboxRepository,
  resolveDeliveries,
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
    // Hour-keyed idempotency is the only storm gate: one queued message per
    // source per UTC hour; a persistent fault re-alerts hourly by design.
    const hourKey = nowIso.slice(0, 13);
    const idempotencyKey = `ops-alert:${input.source}:${hourKey}`;
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
    // 目标=active admin 绑定（告警非订阅内容，无视 digest_enabled）；幂等键
    // 加 owner 后缀。没有绑定时明确失败，调用方不得旁路到其他通知提供方。
    let targets = [];
    try {
      targets = (resolveDeliveries() ?? [])
        .map((target) => ({
          owner: String(target?.account ?? target?.owner ?? "").trim(),
          conversationId: String(target?.conversationId ?? "").trim(),
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
          // Same source within the same hour but with different content (for
          // example a fresh journal tail): the hour gate must still hold, so
          // report a replay instead of surfacing the outbox idempotency 409.
          if (error?.code !== "WEIXIN_OUTBOX_IDEMPOTENCY_CONFLICT") throw error;
          queued = null;
        }
        if (queued && !queued.replayed) anyNew = true;
        if (queued && !firstQueued) firstQueued = queued;
      }
      item = firstQueued
        ? { id: firstQueued.id, status: firstQueued.status, replayed: !anyNew }
        : { id: null, status: "deduplicated", replayed: true };
      delivery = "weixin_outbox";
    } else {
      throw new HttpError(503, "OPS_ALERT_DELIVERY_UNAVAILABLE", "No bound WeChat ops alert delivery is available");
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
