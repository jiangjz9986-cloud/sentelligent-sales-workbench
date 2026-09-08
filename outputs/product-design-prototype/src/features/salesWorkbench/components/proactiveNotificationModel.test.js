import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  latestNotificationForSuggestion,
  proactiveNotificationCounts,
  proactiveNotificationIsUnread,
  proactiveNotificationStatusMeta,
  replaceProactiveNotification,
} from "./proactiveNotificationModel.js";

function notification(status, overrides = {}) {
  return {
    id: `notification-${status}`,
    suggestionId: "suggestion-1",
    suggestionVersion: 2,
    channel: "weixin",
    status,
    readAt: status === "read" ? "2026-09-05T06:10:00.000Z" : null,
    updatedAt: "2026-09-05T06:00:00.000Z",
    ...overrides,
  };
}

test("keeps queued, processing, sent, and failed deliveries unread until an explicit read state", () => {
  for (const status of ["queued", "processing", "sent", "failed"]) {
    const item = notification(status);
    assert.equal(proactiveNotificationIsUnread(item), true, status);
    assert.equal(proactiveNotificationStatusMeta(item).unread, true, status);
  }
  assert.equal(proactiveNotificationIsUnread(notification("read")), false);
  assert.equal(proactiveNotificationStatusMeta(notification("queued")).label, "待发送");
  assert.equal(proactiveNotificationStatusMeta(notification("queued")).channelLabel, "微信");
  assert.match(proactiveNotificationStatusMeta(notification("queued")).description, /仍为未读/u);
});

test("labels normalized legacy notifications as a retired read-only channel", async () => {
  assert.deepEqual(
    proactiveNotificationStatusMeta(notification("sent", { channel: "retired" })),
    {
      label: "已送达",
      tone: "retired",
      description: "通知已送达，等待人工阅读。",
      status: "sent",
      channelLabel: "已退役通道",
      unread: true,
      readOnly: true,
    },
  );
  const styles = await readFile(new URL("../../../styles/global.css", import.meta.url), "utf8");
  assert.match(styles, /\.proactive-notification-state \.tone-retired ~ \.ghost-button\s*\{[^}]*display:\s*none;/s);
});

test("counts delivery state separately from explicit read state", () => {
  assert.deepEqual(proactiveNotificationCounts([
    notification("queued"),
    notification("sent", { id: "notification-sent" }),
    notification("failed", { id: "notification-failed" }),
    notification("read", { id: "notification-read" }),
  ]), {
    total: 4,
    unread: 3,
    queued: 1,
    processing: 0,
    sent: 1,
    failed: 1,
    read: 1,
  });
});

test("matches an exact suggestion revision and labels an older notification as historical", () => {
  const older = notification("sent", { id: "older", suggestionVersion: 1 });
  const current = notification("queued", { id: "current", suggestionVersion: 2 });
  assert.deepEqual(latestNotificationForSuggestion([older, current], { id: "suggestion-1", version: 2 }), {
    item: current,
    currentRevision: true,
  });
  assert.deepEqual(latestNotificationForSuggestion([older], { id: "suggestion-1", version: 2 }), {
    item: older,
    currentRevision: false,
  });
});

test("replaces only the explicitly returned notification after marking it read", () => {
  const queued = notification("queued");
  const other = notification("sent", { id: "other", suggestionId: "suggestion-2" });
  const read = { ...queued, status: "read", readAt: "2026-09-05T06:10:00.000Z" };
  assert.deepEqual(replaceProactiveNotification([queued, other], read), [read, other]);
});
