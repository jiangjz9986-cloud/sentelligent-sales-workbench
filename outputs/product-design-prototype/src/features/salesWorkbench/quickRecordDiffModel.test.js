import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  QUICK_RECORD_DIFF_STATUS,
  cancelQuickRecordDiffSelection,
  clearQuickRecordDiffSelection,
  createQuickRecordDiffConfirmationPayload,
  normalizeQuickRecordDiffPreview,
  selectAllQuickRecordDiffItems,
  toggleQuickRecordDiffSelection,
} from "./quickRecordDiffModel.js";

const DIGEST = "a".repeat(64);

function serverPreview(overrides = {}) {
  return {
    quickRecord: { id: "quick-record-1", version: 7 },
    analysisVersionId: "analysis-9",
    previewDigest: DIGEST,
    status: "pending",
    targetVersions: {
      customer: 3,
      opportunity: 4,
      weekly: 2,
      customer_temperature: 7,
    },
    confirmationPreview: {
      changes: [
        {
          id: "customer-profile",
          target: "customer",
          field: "summary",
          label: "客户画像摘要",
          before: "关注影像平台",
          after: "关注影像平台与双活存储",
          status: "pending",
          canBatchConfirm: true,
        },
        {
          id: "opportunity-next",
          target: "opportunity",
          field: "next",
          label: "商机下一步",
          before: "补齐需求",
          after: "安排方案评审",
          status: "confirmed",
          canBatchConfirm: true,
        },
        {
          id: "weekly-draft",
          target: "weekly",
          field: "sourceRefs",
          label: "周报素材",
          before: [],
          after: ["quick-record-1"],
          status: "pending",
          batchConfirmable: true,
        },
        {
          id: "visit-temperature",
          target: "customer_temperature",
          kind: "visit_temperature_suggestion",
          field: "relation",
          label: "客户温度建议",
          before: 42,
          after: 68,
          status: "pending",
          canBatchConfirm: true,
        },
      ],
    },
    ...overrides,
  };
}

describe("quick record diff preview normalization", () => {
  it("normalizes the server before/after preview without retaining or mutating caller data", () => {
    const source = serverPreview();
    const original = structuredClone(source);
    const model = normalizeQuickRecordDiffPreview(source);

    assert.deepEqual(source, original);
    assert.equal(model.quickRecordId, "quick-record-1");
    assert.equal(model.quickRecordVersion, 7);
    assert.equal(model.analysisVersionId, "analysis-9");
    assert.equal(model.previewDigest, DIGEST);
    assert.equal(model.status, QUICK_RECORD_DIFF_STATUS.PENDING);
    assert.equal(model.requiresHumanConfirmation, true);
    assert.deepEqual(model.selectedIds, []);
    assert.deepEqual(model.items.map((item) => ({
      id: item.id,
      target: item.target,
      field: item.field,
      before: item.before,
      after: item.after,
      status: item.status,
    })), [
      {
        id: "customer-profile",
        target: "customer",
        field: "summary",
        before: "关注影像平台",
        after: "关注影像平台与双活存储",
        status: "pending",
      },
      {
        id: "opportunity-next",
        target: "opportunity",
        field: "next",
        before: "补齐需求",
        after: "安排方案评审",
        status: "confirmed",
      },
      {
        id: "weekly-draft",
        target: "weekly",
        field: "sourceRefs",
        before: [],
        after: ["quick-record-1"],
        status: "pending",
      },
      {
        id: "visit-temperature",
        target: "customer_temperature",
        field: "relation",
        before: 42,
        after: 68,
        status: "pending",
      },
    ]);

    model.items[0].after = "本地改动";
    assert.equal(source.confirmationPreview.changes[0].after, "关注影像平台与双活存储");
  });

  it("accepts writebackPreview items and derives stable fallback ids from target and field", () => {
    const input = {
      quickRecordId: "quick-record-2",
      quickRecordVersion: 2,
      writebackPreview: {
        items: [{
          targetId: "customer",
          name: "tags",
          title: "客户标签",
          from: ["重点客户"],
          to: ["重点客户", "PACS"],
        }],
      },
    };
    const first = normalizeQuickRecordDiffPreview(input);
    const second = normalizeQuickRecordDiffPreview(structuredClone(input));

    assert.equal(first.items[0].id, "customer:tags");
    assert.equal(first.items[0].label, "客户标签");
    assert.deepEqual(first.items[0].before, ["重点客户"]);
    assert.deepEqual(first.items[0].after, ["重点客户", "PACS"]);
    assert.deepEqual(first, second);
  });

  it("marks temperature suggestions as individual-only even when the server asks for batching", () => {
    const model = normalizeQuickRecordDiffPreview(serverPreview(), {
      selectedIds: ["visit-temperature"],
    });
    const temperature = model.items.find((item) => item.id === "visit-temperature");

    assert.equal(temperature.temperatureSuggestion, true);
    assert.equal(temperature.requiresIndividualConfirmation, true);
    assert.equal(temperature.batchConfirmable, false);
    assert.equal(temperature.selectable, false);
    assert.equal(temperature.selected, false);
    assert.equal(model.selectedIds.includes(temperature.id), false);
  });
});

describe("quick record diff selection", () => {
  it("selects and cancels one eligible pending item immutably", () => {
    const original = normalizeQuickRecordDiffPreview(serverPreview());
    const selected = toggleQuickRecordDiffSelection(original, "customer-profile");
    const cancelled = cancelQuickRecordDiffSelection(selected, "customer-profile");

    assert.deepEqual(original.selectedIds, []);
    assert.deepEqual(selected.selectedIds, ["customer-profile"]);
    assert.equal(selected.items.find((item) => item.id === "customer-profile").selected, true);
    assert.deepEqual(cancelled.selectedIds, []);
    assert.equal(cancelled.items.find((item) => item.id === "customer-profile").selected, false);
  });

  it("ignores confirmed, temperature, unknown, and explicitly non-batch items", () => {
    const model = normalizeQuickRecordDiffPreview(serverPreview({
      confirmationPreview: {
        changes: [
          ...serverPreview().confirmationPreview.changes,
          {
            id: "manual-risk",
            target: "risk",
            field: "status",
            before: "open",
            after: "handled",
            batchConfirmable: true,
          },
          {
            id: "customer-manual",
            target: "customer",
            field: "owner",
            before: "owner-a",
            after: "owner-b",
            batchConfirmable: false,
          },
        ],
      },
    }));

    for (const id of [
      "opportunity-next",
      "visit-temperature",
      "manual-risk",
      "customer-manual",
      "missing-item",
    ]) {
      assert.equal(toggleQuickRecordDiffSelection(model, id), model);
    }
  });

  it("selects all only from batch-safe pending items and clears the selection", () => {
    const model = normalizeQuickRecordDiffPreview(serverPreview());
    const selected = selectAllQuickRecordDiffItems(model);

    assert.deepEqual(selected.selectedIds, ["customer-profile", "weekly-draft"]);
    assert.equal(selected.items.find((item) => item.id === "opportunity-next").selected, false);
    assert.equal(selected.items.find((item) => item.id === "visit-temperature").selected, false);
    assert.deepEqual(clearQuickRecordDiffSelection(selected).selectedIds, []);
  });
});

describe("quick record diff confirmation boundary", () => {
  it("blocks selection and payload creation while the analysis draft has unsaved changes", () => {
    const model = normalizeQuickRecordDiffPreview(serverPreview(), {
      hasUnsavedDraftChanges: true,
      selectedIds: ["customer-profile"],
    });

    assert.equal(model.blocked, true);
    assert.deepEqual(model.blocker, {
      code: "UNSAVED_DRAFT_CHANGES",
      message: "请先保存快速记录分析修改，再确认写入业务数据",
    });
    assert.deepEqual(model.selectedIds, []);
    assert.equal(model.canConfirmSelected, false);
    assert.equal(model.canConfirmAll, false);
    assert.equal(toggleQuickRecordDiffSelection(model, "customer-profile"), model);
    assert.equal(selectAllQuickRecordDiffItems(model), model);
    assert.equal(createQuickRecordDiffConfirmationPayload(model), null);
    assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
  });

  it("keeps history, confirmed, cancelled, expired, and conflict previews read only", () => {
    const cases = [
      { status: "confirmed", expected: QUICK_RECORD_DIFF_STATUS.CONFIRMED },
      { status: "cancelled", expected: QUICK_RECORD_DIFF_STATUS.CANCELLED },
      { status: "expired", expected: QUICK_RECORD_DIFF_STATUS.EXPIRED },
      { status: "conflict", expected: QUICK_RECORD_DIFF_STATUS.CONFLICT },
    ];
    for (const current of cases) {
      const model = normalizeQuickRecordDiffPreview(serverPreview({ status: current.status }), {
        selectedIds: ["customer-profile"],
      });
      assert.equal(model.status, current.expected);
      assert.equal(model.readOnly, true);
      assert.deepEqual(model.selectedIds, []);
      assert.equal(toggleQuickRecordDiffSelection(model, "customer-profile"), model);
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
    }

    const history = normalizeQuickRecordDiffPreview(serverPreview(), {
      historyReadOnly: true,
      selectedIds: ["customer-profile"],
    });
    assert.equal(history.status, QUICK_RECORD_DIFF_STATUS.HISTORY_READONLY);
    assert.equal(history.readOnly, true);
    assert.deepEqual(history.selectedIds, []);
    assert.equal(createQuickRecordDiffConfirmationPayload(history, { confirmAll: true }), null);
  });

  it("builds a stable minimal payload from selected eligible targets only", () => {
    let model = normalizeQuickRecordDiffPreview(serverPreview());
    model = toggleQuickRecordDiffSelection(model, "weekly-draft");
    model = toggleQuickRecordDiffSelection(model, "customer-profile");

    const first = createQuickRecordDiffConfirmationPayload(model);
    const second = createQuickRecordDiffConfirmationPayload(model);
    assert.deepEqual(first, {
      quickRecordId: "quick-record-1",
      quickRecordVersion: 7,
      analysisVersionId: "analysis-9",
      previewDigest: DIGEST,
      targets: ["customer", "weekly"],
      targetVersions: { customer: 3, weekly: 2 },
    });
    assert.deepEqual(second, first);
    assert.equal(Object.hasOwn(first, "items"), false);
    assert.equal(Object.hasOwn(first, "changes"), false);
    assert.equal(Object.hasOwn(first, "before"), false);
    assert.equal(Object.hasOwn(first, "after"), false);
    assert.equal(JSON.stringify(first).includes("customer_temperature"), false);
  });

  it("builds confirm-all from all and only batch-safe unconfirmed targets", () => {
    const model = normalizeQuickRecordDiffPreview(serverPreview(), {
      selectedIds: ["customer-profile"],
    });
    assert.deepEqual(
      createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }),
      {
        quickRecordId: "quick-record-1",
        quickRecordVersion: 7,
        analysisVersionId: "analysis-9",
        previewDigest: DIGEST,
        targets: ["customer", "weekly"],
        targetVersions: { customer: 3, weekly: 2 },
      },
    );
  });

  it("returns no payload when there is no explicit selectable target", () => {
    const model = normalizeQuickRecordDiffPreview(serverPreview());
    assert.equal(createQuickRecordDiffConfirmationPayload(model), null);

    const temperatureOnly = normalizeQuickRecordDiffPreview(serverPreview({
      confirmationPreview: {
        changes: [serverPreview().confirmationPreview.changes.at(-1)],
      },
    }));
    assert.equal(createQuickRecordDiffConfirmationPayload(temperatureOnly, { confirmAll: true }), null);
  });
});

describe("quick record diff model side-effect boundary", () => {
  it("contains no transport, API client, timer, storage, or business-write dependency", () => {
    const source = readFileSync(resolve("src/features/salesWorkbench/quickRecordDiffModel.js"), "utf8");
    assert.doesNotMatch(
      source,
      /\bfetch\b|XMLHttpRequest|axios|apiClient|requestApi|salesWorkbenchApi|\/api\/|WebSocket/u,
    );
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage|setTimeout|setInterval|customerStore|opportunityStore|actionItemStore/u,
    );
  });
});
