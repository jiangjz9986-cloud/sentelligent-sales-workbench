import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderOpsAlertMessage } from "../src/ops/opsAlertMessage.js";

function payload(overrides = {}) {
  return {
    kind: "ops_alert",
    origin: "systemd:sentelligent-backend.service",
    severity: "critical",
    summary: "sentelligent-backend.service 进入 failed 状态",
    detail: "journal tail line 1\njournal tail line 2",
    occurredAt: "2026-08-28T17:05:00.000Z",
    ...overrides,
  };
}

describe("ops alert WeChat card renderer", () => {
  it("renders the three-part card with +08:00 time and severity label", () => {
    const message = renderOpsAlertMessage(payload());
    const lines = message.split("\n");
    assert.equal(lines[0], "【小小运维告警】");
    assert.equal(lines[1], "级别：严重");
    assert.equal(lines[2], "来源：systemd:sentelligent-backend.service");
    assert.equal(lines[3], "时间：2026-08-29 01:05（+08:00）");
    assert.equal(lines[4], "摘要：sentelligent-backend.service 进入 failed 状态");
    assert.match(message, /详情：journal tail line 1 journal tail line 2/u);
    assert.match(message, /同一来源一小时内只提醒一次；处理后无需回复。排查：journalctl -u <单元名>/u);
  });

  it("labels warning severity and omits the detail line when absent", () => {
    const message = renderOpsAlertMessage(payload({ severity: "warning", detail: undefined }));
    assert.match(message, /级别：警告/u);
    assert.doesNotMatch(message, /详情：/u);
  });

  it("clips an oversized detail to a bounded line", () => {
    const message = renderOpsAlertMessage(payload({ detail: "x".repeat(1200) }));
    const detailLine = message.split("\n").find((line) => line.startsWith("详情："));
    assert.ok(detailLine.length <= 3 + 300 + 1);
    assert.match(detailLine, /…$/u);
  });

  it("fails closed on malformed payloads", () => {
    assert.throws(() => renderOpsAlertMessage(null), TypeError);
    assert.throws(() => renderOpsAlertMessage(payload({ kind: "daily_digest" })), TypeError);
    assert.throws(() => renderOpsAlertMessage(payload({ severity: "fatal" })), TypeError);
    assert.throws(() => renderOpsAlertMessage(payload({ origin: "bad origin with spaces" })), TypeError);
    assert.throws(() => renderOpsAlertMessage(payload({ summary: "" })), TypeError);
    assert.throws(() => renderOpsAlertMessage(payload({ summary: "x".repeat(301) })), TypeError);
    assert.throws(() => renderOpsAlertMessage(payload({ occurredAt: "not-a-date" })), TypeError);
  });
});
