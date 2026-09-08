// Deterministic WeChat card for queued ops-alert outbox payloads. The
// renderer is pure and fail-closed on malformed payloads so the delivery
// worker never sends an empty or unbounded message — the same contract as
// the tender-notice, action-reminder, and digest renderers.

import { weixinCard, weixinClip } from "../assistant/weixinCard.js";

const SEVERITY_LABELS = Object.freeze({ critical: "严重", warning: "警告" });
const ORIGIN_RE = /^[A-Za-z0-9:._@-]{1,100}$/u;
const MAX_SUMMARY_CHARS = 300;
const MAX_DETAIL_CHARS = 2000;

export const OPS_ALERT_MAX_QUEUE_AGE_MS = 15 * 60 * 1000;

function timestamp(value, name) {
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} is invalid`);
  return parsed;
}

function staleOpsAlertError() {
  return Object.assign(new Error("ops alert outbox item is stale"), {
    code: "WEIXIN_OUTBOX_STALE",
  });
}

function shanghaiMinuteLabel(value, name) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} is invalid`);
  // Render in +08:00 without a timezone dependency: shift then format as UTC.
  const shifted = new Date(parsed + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 16).replace("T", " ")}（+08:00）`;
}

export function renderOpsAlertMessage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.kind !== "ops_alert") {
    throw new TypeError("ops alert payload is invalid");
  }
  const severityLabel = SEVERITY_LABELS[payload.severity];
  if (!severityLabel) throw new TypeError("ops alert severity is invalid");
  const origin = String(payload.origin ?? "").trim();
  if (!ORIGIN_RE.test(origin)) throw new TypeError("ops alert origin is invalid");
  const summary = String(payload.summary ?? "").trim();
  if (!summary || summary.length > MAX_SUMMARY_CHARS) throw new TypeError("ops alert summary is invalid");
  const detail = payload.detail === null || payload.detail === undefined
    ? ""
    : String(payload.detail).trim();
  if (detail.length > MAX_DETAIL_CHARS) throw new TypeError("ops alert detail is invalid");
  const timeLabel = shanghaiMinuteLabel(payload.occurredAt, "ops alert occurredAt");

  return weixinCard(
    "小小运维告警",
    [
      ["级别", severityLabel],
      ["来源", origin],
      ["时间", timeLabel],
      ["摘要", summary],
      ...(detail ? [["详情", weixinClip(detail, 300)]] : []),
    ],
    "同一来源一小时内只提醒一次；处理后无需回复。排查：journalctl -u <单元名>",
  );
}

export function renderOpsAlertOutboxMessage(outboxItem, {
  clock = () => new Date(),
  maxQueueAgeMs = OPS_ALERT_MAX_QUEUE_AGE_MS,
} = {}) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(maxQueueAgeMs) || maxQueueAgeMs <= 0) {
    throw new TypeError("maxQueueAgeMs is invalid");
  }
  const nowMs = timestamp(clock(), "clock");
  const createdAtMs = timestamp(outboxItem?.createdAt, "ops alert createdAt");
  if (nowMs - createdAtMs > maxQueueAgeMs) throw staleOpsAlertError();
  return renderOpsAlertMessage(outboxItem?.payload);
}
