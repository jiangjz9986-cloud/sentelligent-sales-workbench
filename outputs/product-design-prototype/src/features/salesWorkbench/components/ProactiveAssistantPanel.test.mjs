import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PROACTIVE_LIFECYCLE,
  PROACTIVE_LIFECYCLE_ORDER,
  buildProactiveLifecycleCounts,
  buildProactiveReviewPreview,
  mergeProactiveSuggestionItems,
  normalizeProactiveEditableFields,
  normalizeProactiveLifecycleStatus,
  proactiveAssistantRevision,
  proactiveLifecycleFingerprint,
} from "./proactiveAssistantModel.js";

const panelSource = readFileSync(new URL("./ProactiveAssistantPanel.jsx", import.meta.url), "utf8");
const stylesheetSource = readFileSync(new URL("./ProactiveAssistantPanel.css", import.meta.url), "utf8");

function suggestion(overrides = {}) {
  return {
    id: "suggestion-1",
    title: "补充下一步",
    conclusion: "需要人工确认下一步",
    opportunityId: "opportunity-1",
    customerId: "customer-1",
    opportunityVersion: 4,
    customerVersion: 2,
    confirmationStatus: "not_started",
    writebackPreview: {
      action: {
        title: "补充回访行动",
        reason: "商机缺少下一步",
        opportunityId: "opportunity-1",
      },
    },
    ...overrides,
  };
}

test("normalizes the eight lifecycle states and compatibility aliases", () => {
  const aliases = {
    not_started: PROACTIVE_LIFECYCLE.PENDING,
    open: PROACTIVE_LIFECYCLE.PENDING,
    snoozed: PROACTIVE_LIFECYCLE.DEFERRED,
    dismissed: PROACTIVE_LIFECYCLE.IGNORED,
    closed: PROACTIVE_LIFECYCLE.RESOLVED,
    accepted: PROACTIVE_LIFECYCLE.CONFIRMED,
    completed: PROACTIVE_LIFECYCLE.EXECUTED,
    stale: PROACTIVE_LIFECYCLE.CONFLICT,
    error: PROACTIVE_LIFECYCLE.FAILED,
  };
  for (const [alias, expected] of Object.entries(aliases)) {
    assert.equal(normalizeProactiveLifecycleStatus(alias), expected, alias);
  }
  assert.deepEqual(
    PROACTIVE_LIFECYCLE_ORDER,
    ["pending", "deferred", "ignored", "resolved", "confirmed", "executed", "conflict", "failed"],
  );
  assert.equal(
    normalizeProactiveLifecycleStatus(suggestion({ lifecycleStatus: "ignored", status: "open" })),
    PROACTIVE_LIFECYCLE.IGNORED,
  );
  assert.equal(
    normalizeProactiveLifecycleStatus(suggestion({ confirmationPreviews: {
      action: { status: "completed", resultItemId: "action-1" },
    } })),
    PROACTIVE_LIFECYCLE.EXECUTED,
  );
  assert.equal(
    normalizeProactiveLifecycleStatus(suggestion({ confirmationPreviews: {
      action: { status: "completed" },
    } })),
    PROACTIVE_LIFECYCLE.CONFIRMED,
  );
  assert.equal(
    normalizeProactiveLifecycleStatus(suggestion({ lifecycleStatus: "pending", confirmationPreviews: {
      action: { status: "completed", resultItemId: "action-1" },
    } })),
    PROACTIVE_LIFECYCLE.PENDING,
  );
});

test("uses server lifecycle counts first and fills only missing buckets from rows", () => {
  const items = [
    suggestion({ id: "pending-1" }),
    suggestion({ id: "deferred-1", lifecycleStatus: "deferred" }),
    suggestion({ id: "failed-1", lifecycleStatus: "failed" }),
  ];
  const counts = buildProactiveLifecycleCounts({
    lifecycleCounts: { pending: 9, deferredCount: 6, total: 22 },
  }, items);
  assert.equal(counts.pending, 9);
  assert.equal(counts.deferred, 6);
  assert.equal(counts.ignored, 0);
  assert.equal(counts.failed, 1);
  assert.equal(counts.total, 22);

  const triggerOnlyCounts = buildProactiveLifecycleCounts({ counts: { total: 3 } }, items);
  assert.equal(triggerOnlyCounts.total, 3);
  assert.equal(triggerOnlyCounts.pending, 1);
  assert.equal(triggerOnlyCounts.deferred, 1);
  assert.equal(triggerOnlyCounts.failed, 1);
});

test("normalizes owner, date, priority, and expected-result fields", () => {
  const fields = normalizeProactiveEditableFields({
    lifecycle: { assignee: { displayName: "  李雷 " }, targetDate: "2026-09-15T09:00:00+08:00", priority: "high" },
    writebackPreview: { action: { expectedOutcome: "完成阶段证据确认" } },
  });
  assert.deepEqual(fields, {
    owner: "李雷",
    dueDate: "2026-09-15",
    priority: "高",
    expectedResult: "完成阶段证据确认",
  });
  assert.deepEqual(normalizeProactiveEditableFields({ priority: "low" }), {
    owner: "",
    dueDate: "",
    priority: "低",
    expectedResult: "",
  });
  assert.deepEqual(normalizeProactiveEditableFields({
    assignee: "旧负责人",
    due: "2026-01-01",
    priority: "低",
    expectedResult: "旧结果",
    reviewFields: {
      assignee: "李雷",
      dueDate: "2026-09-20",
      priority: "high",
      expectedResult: "人工确认结果",
    },
  }), {
    owner: "李雷",
    dueDate: "2026-09-20",
    priority: "高",
    expectedResult: "人工确认结果",
  });
  assert.deepEqual(normalizeProactiveEditableFields({
    assignee: "旧负责人",
    due: "2026-01-01",
    priority: "低",
    expectedResult: "旧结果",
    reviewFields: { assignee: null, dueDate: null, priority: null, expectedResult: null },
  }), {
    owner: "",
    dueDate: "",
    priority: "中",
    expectedResult: "",
  });
});

test("builds a non-mutating review preview with edited values", () => {
  const item = suggestion({ priority: "低", assigneeName: "王五" });
  const original = structuredClone(item);
  const preview = buildProactiveReviewPreview(item, {
    owner: "赵六",
    dueDate: "2026-09-18",
    priority: "高",
    expectedResult: "完成预算确认",
  });
  assert.deepEqual(item, original);
  assert.equal(preview.suggestionId, item.id);
  assert.equal(preview.owner, "赵六");
  assert.equal(preview.dueDate, "2026-09-18");
  assert.equal(preview.priority, "高");
  assert.equal(preview.expectedResult, "完成预算确认");
  assert.equal(preview.requiresHumanConfirmation, true);
});

test("merges current, history, lifecycle, and suggestion rows by stable id", () => {
  const merged = mergeProactiveSuggestionItems({
    items: [{ id: "a", title: "当前标题", conclusion: "当前结论" }],
    history: [{ suggestionId: "a", lifecycleStatus: "resolved" }, { id: "b", title: "历史建议" }],
    lifecycleItems: [{ proactiveId: "b", status: "failed" }],
    suggestions: [{ id: "c", title: "补充建议" }],
  });
  assert.deepEqual(merged.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(merged[0].title, "当前标题");
  assert.equal(merged[0].lifecycleStatus, "resolved");
  assert.equal(merged[1].status, "failed");
});

test("snapshot revision and lifecycle fingerprint fence refresh overrides", () => {
  const first = suggestion({ lifecycleVersion: 1, lifecycleStatus: "pending" });
  const next = suggestion({ lifecycleVersion: 2, lifecycleStatus: "resolved" });
  assert.equal(proactiveAssistantRevision({ generatedAt: "2026-09-05T10:00:00Z" }), "2026-09-05T10:00:00Z");
  assert.notEqual(proactiveLifecycleFingerprint(first), proactiveLifecycleFingerprint(next));
});

test("panel exposes all lifecycle filters, editable fields, persistence callbacks, and refresh", () => {
  assert.match(panelSource, /data-testid={`proactive-lifecycle-filter-\$\{status\}`}/);
  assert.match(panelSource, /data-testid={`proactive-lifecycle-action-\$\{status\}`}/);
  for (const status of PROACTIVE_LIFECYCLE_ORDER) assert.match(panelSource, new RegExp(`PROACTIVE_LIFECYCLE\\.${status.toUpperCase()}`));
  for (const field of ["负责人", "跟进日期", "优先级", "预期结果"]) assert.match(panelSource, new RegExp(field));
  for (const callback of ["onLifecycleChange", "onUpdateSuggestion", "onRefresh"]) assert.match(panelSource, new RegExp(callback));
  assert.match(panelSource, /previousSnapshot\.revision/);
  assert.match(panelSource, /setOptimisticOverrides\(\{\}\)/);
  assert.match(panelSource, /服务端回读/);
  assert.match(panelSource, /宿主尚未接入/);
  assert.match(stylesheetSource, /proactive-assistant-lifecycle-toolbar/);
  assert.match(stylesheetSource, /proactive-assistant-edit-grid/);
  assert.match(stylesheetSource, /\.proactive-assistant-lifecycle-actions \.ghost-button[\s\S]*min-height: 34px/);
  assert.match(stylesheetSource, /@media \(max-width: 620px\)[\s\S]*\.proactive-assistant-card\[data-suggestion-id\] \.proactive-assistant-card-actions \.ghost-button[\s\S]*min-height: 44px/);
});
