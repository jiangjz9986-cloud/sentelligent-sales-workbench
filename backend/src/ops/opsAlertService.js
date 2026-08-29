// Machine-facing ops-alert intake. Validation is fail-closed (unknown fields
// rejected), storm control is the hour-keyed outbox idempotency key, and the
// WeChat outbox stays the primary channel with PushPlus as the in-request
// fallback while WeChat delivery is not bound.

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
  weixinDeliveryReady,
  pushplusNotify = null,
  recordAudit = null,
  clock = () => new Date(),
} = {}) {
  if (!outboxRepository || typeof outboxRepository.enqueue !== "function") {
    throw new TypeError("outboxRepository is required");
  }
  if (typeof resolveDeliveries !== "function") {
    throw new TypeError("resolveDeliveries is required");
  }
  if (typeof weixinDeliveryReady !== "function") throw new TypeError("weixinDeliveryReady is required");
  if (pushplusNotify !== null && typeof pushplusNotify !== "function") {
    throw new TypeError("pushplusNotify must be a function");
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
    let pushplusFallback = false;
    // v0.9.3 多播：目标=active admin 绑定（告警非订阅内容，无视 digest_enabled）；
    // 幂等键加 owner 后缀。无 admin 绑定时落 PushPlus 兜底分支。
    let targets = [];
    if (weixinDeliveryReady()) {
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
      if (!pushplusNotify) {
        throw new HttpError(503, "OPS_ALERT_DELIVERY_UNAVAILABLE", "No ops alert delivery channel is available");
      }
      try {
        await pushplusNotify({
          title: `【${input.severity === "critical" ? "严重" : "警告"}】${input.summary}`.slice(0, 200),
          content: [
            `来源：${input.source}`,
            `时间：${payload.occurredAt}`,
            `摘要：${input.summary}`,
            ...(input.detail ? [`详情：${input.detail}`] : []),
          ].join("\n"),
        });
      } catch {
        throw new HttpError(503, "OPS_ALERT_DELIVERY_UNAVAILABLE", "No ops alert delivery channel is available");
      }
      item = { id: null, status: "pushplus_delivered", replayed: false };
      delivery = "pushplus";
      pushplusFallback = true;
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
      // failure; the outbox/PushPlus side effect already happened.
    }
    return { item: { ...item, pushplusFallback } };
  }

  return Object.freeze({ receive });
}
