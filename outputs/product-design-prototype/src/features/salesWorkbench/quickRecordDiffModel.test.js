import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  QUICK_RECORD_DIFF_STATUS,
  cancelQuickRecordDiffSelection,
  clearQuickRecordDiffSelection,
  createQuickRecordDiffCancellationPayload,
  createQuickRecordDiffConfirmationPayload,
  normalizeQuickRecordDiffPreview,
  selectAllQuickRecordDiffItems,
  toggleQuickRecordDiffSelection,
} from "./quickRecordDiffModel.js";

const DIGEST = "a".repeat(64);
const SUGGESTION_IDENTITY = "b".repeat(64);
const SUMMARY_HASH = "c".repeat(64);
const EVIDENCE_HASH = "d".repeat(64);

function confirmationServicePreview(overrides = {}) {
  const base = {
    schemaVersion: "quick-record-confirmation-v2",
    id: "preview-1",
    identity: SUGGESTION_IDENTITY,
    owner: "owner-a",
    status: "open",
    revision: 2,
    quickRecordId: "quick-record-1",
    quickRecordVersion: 7,
    quickRecordStatus: "analyzed",
    analysisVersionId: "analysis-9",
    analysisStatus: "ready_for_confirmation",
    summary: { next: "安排方案评审" },
    evidence: [{
      key: "evidence-1",
      label: "拜访纪要",
      value: "拜访纪要",
      sourceRef: { type: "quick_record", id: "quick-record-1" },
    }],
    summaryHash: SUMMARY_HASH,
    evidenceHash: EVIDENCE_HASH,
    draftHash: "e".repeat(64),
    items: [
      {
        id: "customer-profile",
        identity: "1".repeat(64),
        target: "customer",
        entityId: "customer-1",
        field: "needs",
        label: "客户需求",
        before: ["关注影像平台"],
        after: ["关注影像平台", "双活存储"],
        entityVersion: 3,
        evidenceKeys: ["evidence-1"],
        sourceRefs: [{ type: "quick_record", id: "quick-record-1" }],
        confirmationMode: "explicit",
        bulkEligible: true,
        status: "pending",
        confirmedAt: null,
        confirmedBy: null,
        receipt: null,
      },
      {
        id: "opportunity-next",
        identity: "2".repeat(64),
        target: "opportunity",
        entityId: "opportunity-1",
        field: "requirements",
        label: "商机需求",
        before: ["补齐需求"],
        after: ["补齐需求", "安排方案评审"],
        entityVersion: 4,
        evidenceKeys: ["evidence-1"],
        sourceRefs: [{ type: "quick_record", id: "quick-record-1" }],
        confirmationMode: "explicit",
        bulkEligible: true,
        status: "confirmed",
        confirmedAt: "2026-08-31T08:01:00.000Z",
        confirmedBy: "operator-a",
        receipt: {
          entityId: "opportunity-1",
          field: "requirements",
          version: 5,
        },
      },
      {
        id: "weekly-draft",
        identity: "3".repeat(64),
        target: "weekly",
        entityId: "weekly-1",
        field: "entries",
        label: "周报素材",
        before: [],
        after: ["quick-record-1"],
        entityVersion: 2,
        evidenceKeys: ["evidence-1"],
        sourceRefs: [{ type: "quick_record", id: "quick-record-1" }],
        confirmationMode: "explicit",
        bulkEligible: true,
        status: "pending",
        confirmedAt: null,
        confirmedBy: null,
        receipt: null,
      },
      {
        id: "visit-temperature",
        identity: "4".repeat(64),
        target: "customer_temperature",
        entityId: "customer-1",
        field: "relation",
        label: "客户温度建议",
        before: 42,
        after: 68,
        entityVersion: 3,
        evidenceKeys: ["evidence-1"],
        sourceRefs: [{ type: "quick_record", id: "quick-record-1" }],
        confirmationMode: "independent",
        bulkEligible: false,
        status: "pending",
        confirmedAt: null,
        confirmedBy: null,
        receipt: null,
      },
      {
        id: "action-draft",
        identity: "5".repeat(64),
        target: "action",
        entityId: "action-1",
        field: "title",
        label: "待办建议",
        before: "原待办",
        after: "新待办",
        entityVersion: 1,
        evidenceKeys: ["evidence-1"],
        sourceRefs: [{ type: "quick_record", id: "quick-record-1" }],
        confirmationMode: "unsupported",
        bulkEligible: false,
        status: "pending",
        confirmedAt: null,
        confirmedBy: null,
        receipt: null,
      },
      {
        id: "financial-draft",
        identity: "6".repeat(64),
        target: "financial",
        entityId: "financial-1",
        field: "amountCents",
        label: "财务建议",
        before: 100,
        after: 120,
        entityVersion: 1,
        evidenceKeys: ["evidence-1"],
        sourceRefs: [{ type: "quick_record", id: "quick-record-1" }],
        confirmationMode: "unsupported",
        bulkEligible: false,
        status: "pending",
        confirmedAt: null,
        confirmedBy: null,
        receipt: null,
      },
    ],
    requiresHumanConfirmation: true,
    automaticWriteAllowed: false,
    createdWithUnsavedChanges: false,
    createdAt: "2026-08-31T08:00:00.000Z",
    updatedAt: "2026-08-31T08:01:00.000Z",
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    confirmationBlocked: false,
    bulkEligibleItemIds: ["customer-profile", "weekly-draft"],
  };
  return { ...base, ...overrides };
}

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
  it("normalizes a fixture matching the current confirmation preview and preserves every pin", () => {
    const source = confirmationServicePreview();
    const original = structuredClone(source);
    const model = normalizeQuickRecordDiffPreview(source, {
      selectedIds: ["customer-profile", "visit-temperature", "action-draft"],
    });

    assert.deepEqual(source, original);
    assert.equal(model.schemaVersion, "quick-record-confirmation-v2");
    assert.equal(model.previewId, "preview-1");
    assert.equal(model.suggestionIdentity, SUGGESTION_IDENTITY);
    assert.equal(model.quickRecordId, "quick-record-1");
    assert.equal(model.quickRecordVersion, 7);
    assert.equal(model.quickRecordStatus, "analyzed");
    assert.equal(model.analysisVersionId, "analysis-9");
    assert.equal(model.analysisStatus, "ready_for_confirmation");
    assert.equal(model.revision, 2);
    assert.equal(model.summaryHash, SUMMARY_HASH);
    assert.equal(model.evidenceHash, EVIDENCE_HASH);
    assert.equal(model.cancelledBy, null);
    assert.equal(model.status, QUICK_RECORD_DIFF_STATUS.PENDING);
    assert.deepEqual(model.selectedIds, ["customer-profile"]);
    assert.deepEqual(model.batchConfirmableIds, ["customer-profile", "weekly-draft"]);

    const customer = model.items.find((item) => item.id === "customer-profile");
    assert.equal(customer.identity, "1".repeat(64));
    assert.equal(customer.entityId, "customer-1");
    assert.equal(customer.confirmationMode, "explicit");
    assert.equal(customer.bulkEligible, true);
    assert.deepEqual(customer.before, ["关注影像平台"]);
    assert.deepEqual(customer.after, ["关注影像平台", "双活存储"]);
    assert.equal(customer.batchConfirmable, true);
    assert.equal(customer.selectable, true);

    const temperature = model.items.find((item) => item.id === "visit-temperature");
    assert.equal(temperature.confirmationMode, "independent");
    assert.equal(temperature.bulkEligible, false);
    assert.equal(temperature.requiresIndividualConfirmation, true);
    assert.equal(temperature.batchConfirmable, false);
    assert.equal(temperature.selectable, false);

    const action = model.items.find((item) => item.id === "action-draft");
    assert.equal(action.confirmationMode, "unsupported");
    assert.equal(action.bulkEligible, false);
    assert.equal(action.requiresIndividualConfirmation, false);
    assert.equal(action.selectable, false);

    const confirmedOpportunity = model.items.find((item) => item.id === "opportunity-next");
    assert.deepEqual(confirmedOpportunity.receipt, {
      entityId: "opportunity-1",
      field: "requirements",
      version: 5,
    });

    const financial = model.items.find((item) => item.id === "financial-draft");
    assert.equal(financial.confirmationMode, "unsupported");
    assert.equal(financial.batchConfirmable, false);
    assert.equal(financial.selectable, false);
  });

  it("accepts a confirmation result or API item wrapper around the real preview", () => {
    const direct = normalizeQuickRecordDiffPreview(confirmationServicePreview());
    const resultWrapped = normalizeQuickRecordDiffPreview({
      status: "confirmed",
      preview: confirmationServicePreview(),
      writeback: true,
    });
    const itemWrapped = normalizeQuickRecordDiffPreview({ item: confirmationServicePreview() });

    assert.equal(resultWrapped.previewId, direct.previewId);
    assert.equal(resultWrapped.suggestionIdentity, direct.suggestionIdentity);
    assert.deepEqual(resultWrapped.items, direct.items);
    assert.equal(itemWrapped.previewId, direct.previewId);
    assert.deepEqual(itemWrapped.items, direct.items);
  });

  it("accepts the redacted effectivePreview shape without internal replay credentials", () => {
    const source = confirmationServicePreview();
    assert.equal(Object.hasOwn(source, "cancellationRequestIdentity"), false);
    assert.equal(source.items.some((item) => Object.hasOwn(item, "confirmationRequest")), false);
    assert.equal(source.cancelledBy, null);

    const model = normalizeQuickRecordDiffPreview(source, {
      selectedIds: ["customer-profile"],
    });

    assert.equal(model.confirmationContractValid, true);
    assert.equal(model.readOnly, false);
    assert.equal(model.blocked, false);
    assert.deepEqual(model.selectedIds, ["customer-profile"]);
    assert.equal(Object.hasOwn(model, "cancellationRequestIdentity"), false);
    assert.equal(model.items.some((item) => Object.hasOwn(item, "confirmationRequest")), false);
    assert.equal(model.cancelledBy, null);
    assert.deepEqual(
      createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }),
      {
        confirm: true,
        previewId: "preview-1",
        suggestionIdentity: SUGGESTION_IDENTITY,
        expectedQuickRecordVersion: 7,
        analysisVersionId: "analysis-9",
        summaryHash: SUMMARY_HASH,
        evidenceHash: EVIDENCE_HASH,
      },
    );
  });

  it("keeps v1 and unknown schema previews displayable but never confirmable", () => {
    for (const schemaVersion of ["quick-record-confirmation-v1", "quick-record-confirmation-v999", undefined]) {
      const source = confirmationServicePreview();
      if (schemaVersion === undefined) delete source.schemaVersion;
      else source.schemaVersion = schemaVersion;
      const model = normalizeQuickRecordDiffPreview(source, {
        selectedIds: ["customer-profile"],
      });

      assert.equal(model.items.length, 6, String(schemaVersion));
      assert.equal(model.confirmationContractValid, false, String(schemaVersion));
      assert.equal(model.readOnly, true, String(schemaVersion));
      assert.equal(model.blocked, true, String(schemaVersion));
      assert.deepEqual(model.selectedIds, [], String(schemaVersion));
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
      assert.equal(createQuickRecordDiffCancellationPayload(model), null);
    }
  });

  it("accepts rotated v2 identities in valid completed and cancelled terminal previews", () => {
    const completedBase = confirmationServicePreview();
    const completed = {
      ...completedBase,
      identity: "a".repeat(64),
      status: "completed",
      revision: 3,
      updatedAt: "2026-08-31T08:02:00.000Z",
      completedAt: "2026-08-31T08:02:00.000Z",
      items: completedBase.items.map((item, index) => (
        item.confirmationMode === "explicit"
          ? {
            ...item,
            identity: ((index + 7) % 16).toString(16).repeat(64),
            status: "confirmed",
            confirmedAt: "2026-08-31T08:02:00.000Z",
            confirmedBy: "operator-a",
            receipt: {
              entityId: item.entityId,
              field: item.field,
              version: item.entityVersion + 1,
            },
          }
          : item
      )),
      bulkEligibleItemIds: [],
    };
    const cancelledBase = confirmationServicePreview();
    const cancelled = {
      ...cancelledBase,
      identity: "f".repeat(64),
      status: "cancelled",
      revision: 3,
      updatedAt: "2026-08-31T08:03:00.000Z",
      cancelledAt: "2026-08-31T08:03:00.000Z",
      cancelledBy: "operator-a",
      items: cancelledBase.items.map((item, index) => (
        item.status === "pending"
          ? {
            ...item,
            identity: ((index + 9) % 16).toString(16).repeat(64),
            status: "cancelled",
          }
          : item
      )),
      bulkEligibleItemIds: [],
    };

    for (const [source, expectedStatus] of [
      [completed, QUICK_RECORD_DIFF_STATUS.CONFIRMED],
      [cancelled, QUICK_RECORD_DIFF_STATUS.CANCELLED],
    ]) {
      const model = normalizeQuickRecordDiffPreview(source, {
        selectedIds: ["customer-profile"],
      });
      assert.equal(model.confirmationContractValid, true);
      assert.equal(model.status, expectedStatus);
      assert.equal(model.readOnly, true);
      assert.equal(model.blocked, false);
      assert.deepEqual(model.selectedIds, []);
      assert.equal(
        model.cancelledBy,
        expectedStatus === QUICK_RECORD_DIFF_STATUS.CANCELLED ? "operator-a" : null,
      );
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
      assert.equal(createQuickRecordDiffCancellationPayload(model), null);
    }
  });

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
    assert.equal(model.confirmationContractValid, false);
    assert.equal(model.readOnly, true);
    assert.equal(model.blocked, true);
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

  it("marks temperature suggestions as independent and never batch-selectable", () => {
    const model = normalizeQuickRecordDiffPreview(confirmationServicePreview(), {
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
    const original = normalizeQuickRecordDiffPreview(confirmationServicePreview());
    const selected = toggleQuickRecordDiffSelection(original, "customer-profile");
    const cancelled = cancelQuickRecordDiffSelection(selected, "customer-profile");

    assert.deepEqual(original.selectedIds, []);
    assert.deepEqual(selected.selectedIds, ["customer-profile"]);
    assert.equal(selected.items.find((item) => item.id === "customer-profile").selected, true);
    assert.deepEqual(cancelled.selectedIds, []);
    assert.equal(cancelled.items.find((item) => item.id === "customer-profile").selected, false);
  });

  it("ignores confirmed, temperature, unknown, and explicitly non-batch items", () => {
    const model = normalizeQuickRecordDiffPreview(confirmationServicePreview());

    for (const id of [
      "opportunity-next",
      "visit-temperature",
      "action-draft",
      "financial-draft",
      "missing-item",
    ]) {
      assert.equal(toggleQuickRecordDiffSelection(model, id), model);
    }
  });

  it("selects all only from batch-safe pending items and clears the selection", () => {
    const model = normalizeQuickRecordDiffPreview(confirmationServicePreview());
    const selected = selectAllQuickRecordDiffItems(model);

    assert.deepEqual(selected.selectedIds, ["customer-profile", "weekly-draft"]);
    assert.equal(selected.items.find((item) => item.id === "opportunity-next").selected, false);
    assert.equal(selected.items.find((item) => item.id === "visit-temperature").selected, false);
    assert.deepEqual(clearQuickRecordDiffSelection(selected).selectedIds, []);
  });
});

describe("quick record diff confirmation boundary", () => {
  const expectedPins = {
    confirm: true,
    previewId: "preview-1",
    suggestionIdentity: SUGGESTION_IDENTITY,
    expectedQuickRecordVersion: 7,
    analysisVersionId: "analysis-9",
    summaryHash: SUMMARY_HASH,
    evidenceHash: EVIDENCE_HASH,
  };

  it("builds the exact backend confirm-item payload for one explicit pending item", () => {
    const model = normalizeQuickRecordDiffPreview(confirmationServicePreview(), {
      selectedIds: ["customer-profile"],
    });

    const first = createQuickRecordDiffConfirmationPayload(model);
    const second = createQuickRecordDiffConfirmationPayload(model, { itemId: "customer-profile" });
    assert.deepEqual(first, {
      ...expectedPins,
      itemId: "customer-profile",
      itemIdentity: "1".repeat(64),
    });
    assert.deepEqual(second, first);
    for (const oldField of [
      "quickRecordId",
      "quickRecordVersion",
      "previewDigest",
      "targets",
      "targetVersions",
      "owner",
      "actor",
      "confirmedBy",
      "cancelledBy",
    ]) {
      assert.equal(Object.hasOwn(first, oldField), false);
    }
  });

  it("builds the exact backend confirm-all payload only when explicitly requested", () => {
    const model = normalizeQuickRecordDiffPreview(confirmationServicePreview(), {
      selectedIds: ["customer-profile"],
    });

    assert.deepEqual(
      createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }),
      expectedPins,
    );
    assert.deepEqual(model.batchConfirmableIds, ["customer-profile", "weekly-draft"]);
    assert.equal(model.batchConfirmableIds.includes("visit-temperature"), false);
    assert.equal(model.batchConfirmableIds.includes("action-draft"), false);
    assert.equal(model.batchConfirmableIds.includes("financial-draft"), false);
  });

  it("builds the exact backend cancellation payload without injecting owner data", () => {
    const model = normalizeQuickRecordDiffPreview(confirmationServicePreview());
    const payload = createQuickRecordDiffCancellationPayload(model);

    assert.deepEqual(payload, {
      cancel: true,
      previewId: "preview-1",
      suggestionIdentity: SUGGESTION_IDENTITY,
    });
    for (const actorField of ["owner", "actor", "confirmedBy", "cancelledBy"]) {
      assert.equal(Object.hasOwn(payload, actorField), false);
    }
  });

  it("returns no single-item payload for zero or multiple selections without an explicit item id", () => {
    const none = normalizeQuickRecordDiffPreview(confirmationServicePreview());
    assert.equal(createQuickRecordDiffConfirmationPayload(none), null);

    const multiple = selectAllQuickRecordDiffItems(none);
    assert.deepEqual(multiple.selectedIds, ["customer-profile", "weekly-draft"]);
    assert.equal(createQuickRecordDiffConfirmationPayload(multiple), null);
    assert.deepEqual(
      createQuickRecordDiffConfirmationPayload(multiple, { itemId: "weekly-draft" }),
      {
        ...expectedPins,
        itemId: "weekly-draft",
        itemIdentity: "3".repeat(64),
      },
    );
  });

  it("fails closed when any backend confirmation pin is absent", () => {
    for (const field of [
      "id",
      "identity",
      "quickRecordVersion",
      "analysisVersionId",
      "summaryHash",
      "evidenceHash",
    ]) {
      const source = confirmationServicePreview();
      delete source[field];
      const model = normalizeQuickRecordDiffPreview(source, {
        selectedIds: ["customer-profile"],
      });
      assert.equal(model.confirmationContractValid, false, field);
      assert.deepEqual(model.selectedIds, [], field);
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null, field);
    }
  });

  it("fails closed when a single item identity is absent", () => {
    const source = confirmationServicePreview();
    delete source.items[0].identity;
    const model = normalizeQuickRecordDiffPreview(source, {
      selectedIds: ["customer-profile"],
    });

    assert.equal(model.confirmationContractValid, false);
    assert.equal(model.blocked, true);
    assert.equal(createQuickRecordDiffConfirmationPayload(model, { itemId: "customer-profile" }), null);
    assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
  });

  it("blocks confirmation for every unsaved or server-blocked draft marker", () => {
    const cases = [
      ["hasUnsavedDraftChanges", true],
      ["analysisDirty", true],
      ["createdWithUnsavedChanges", true],
      ["confirmationBlocked", true],
    ];
    for (const [field, value] of cases) {
      const model = normalizeQuickRecordDiffPreview(confirmationServicePreview({ [field]: value }), {
        selectedIds: ["customer-profile"],
      });
      assert.equal(model.blocked, true, field);
      assert.equal(model.blocker.code, "UNSAVED_DRAFT_CHANGES", field);
      assert.deepEqual(model.selectedIds, [], field);
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null, field);
      assert.equal(selectAllQuickRecordDiffItems(model), model, field);
    }

    const optionBlocked = normalizeQuickRecordDiffPreview(confirmationServicePreview(), {
      hasUnsavedDraftChanges: true,
      selectedIds: ["customer-profile"],
    });
    assert.equal(optionBlocked.blocked, true);
    assert.equal(createQuickRecordDiffConfirmationPayload(optionBlocked), null);
  });

  it("keeps completed, cancelled, history, and unknown preview states read only", () => {
    const cases = [
      ["completed", QUICK_RECORD_DIFF_STATUS.CONFIRMED],
      ["cancelled", QUICK_RECORD_DIFF_STATUS.CANCELLED],
      ["unexpected", QUICK_RECORD_DIFF_STATUS.INVALID],
      [undefined, QUICK_RECORD_DIFF_STATUS.INVALID],
    ];
    for (const [status, expected] of cases) {
      const source = confirmationServicePreview();
      if (status === undefined) delete source.status;
      else source.status = status;
      const model = normalizeQuickRecordDiffPreview(source, {
        selectedIds: ["customer-profile"],
      });
      assert.equal(model.status, expected);
      assert.equal(model.readOnly, true);
      assert.deepEqual(model.selectedIds, []);
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
    }

    const history = normalizeQuickRecordDiffPreview(confirmationServicePreview(), {
      historyReadOnly: true,
      selectedIds: ["customer-profile"],
    });
    assert.equal(history.status, QUICK_RECORD_DIFF_STATUS.HISTORY_READONLY);
    assert.equal(history.readOnly, true);
    assert.deepEqual(history.selectedIds, []);
    assert.equal(createQuickRecordDiffConfirmationPayload(history, { confirmAll: true }), null);
  });

  it("fails closed for missing or unknown item states, duplicate ids, and policy mismatch", () => {
    const variants = [];

    const missingStatus = confirmationServicePreview();
    delete missingStatus.items[0].status;
    variants.push(missingStatus);

    const unknownStatus = confirmationServicePreview();
    unknownStatus.items[0].status = "unexpected";
    variants.push(unknownStatus);

    const duplicateId = confirmationServicePreview();
    duplicateId.items[1].id = duplicateId.items[0].id;
    variants.push(duplicateId);

    const policyMismatch = confirmationServicePreview();
    policyMismatch.items[0].bulkEligible = false;
    variants.push(policyMismatch);

    for (const source of variants) {
      const model = normalizeQuickRecordDiffPreview(source, {
        selectedIds: ["customer-profile"],
      });
      assert.equal(model.confirmationContractValid, false);
      assert.equal(model.blocked, true);
      assert.deepEqual(model.selectedIds, []);
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
    }
  });

  it("rejects every target and field combination outside the v2 backend whitelist", () => {
    const mismatches = [
      ["customer", "amountCents"],
      ["opportunity", "owner"],
      ["weekly", "requirements"],
      ["customer_temperature", "needs"],
      ["action", "entries"],
      ["financial", "title"],
    ];

    for (const [target, field] of mismatches) {
      const source = confirmationServicePreview();
      const item = source.items.find((candidate) => candidate.target === target);
      item.field = field;
      const model = normalizeQuickRecordDiffPreview(source, {
        selectedIds: [item.id],
      });

      assert.equal(model.confirmationContractValid, false, `${target}.${field}`);
      assert.equal(model.blocked, true, `${target}.${field}`);
      assert.deepEqual(model.selectedIds, [], `${target}.${field}`);
      assert.equal(
        createQuickRecordDiffConfirmationPayload(model, { itemId: item.id }),
        null,
        `${target}.${field}`,
      );
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
    }
  });

  it("requires the v2 confirmable quick-record and analysis states", () => {
    for (const override of [
      { quickRecordStatus: "confirmed" },
      { analysisStatus: "draft" },
      { revision: 0 },
    ]) {
      const model = normalizeQuickRecordDiffPreview(confirmationServicePreview(override), {
        selectedIds: ["customer-profile"],
      });
      assert.equal(model.confirmationContractValid, false);
      assert.equal(model.blocked, true);
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
    }
  });

  it("fails closed on impossible v2 terminal and confirmation evidence states", () => {
    const openWithTerminalTime = confirmationServicePreview({
      completedAt: "2026-08-31T08:02:00.000Z",
    });
    const pendingWithEvidence = confirmationServicePreview();
    pendingWithEvidence.items[0] = {
      ...pendingWithEvidence.items[0],
      confirmedAt: "2026-08-31T08:02:00.000Z",
      confirmedBy: "operator-a",
      receipt: { version: 4 },
    };
    const confirmedWithoutEvidence = confirmationServicePreview();
    confirmedWithoutEvidence.items[0] = {
      ...confirmedWithoutEvidence.items[0],
      status: "confirmed",
    };
    const completedWithPendingExplicit = confirmationServicePreview({
      status: "completed",
      completedAt: "2026-08-31T08:02:00.000Z",
    });
    const cancelledWithPending = confirmationServicePreview({
      status: "cancelled",
      cancelledAt: "2026-08-31T08:02:00.000Z",
      cancelledBy: "operator-a",
    });
    const openWithCancellationActor = confirmationServicePreview({ cancelledBy: "operator-a" });
    const completedWithCancellationActor = confirmationServicePreview({
      status: "completed",
      completedAt: "2026-08-31T08:02:00.000Z",
      cancelledBy: "operator-a",
    });
    const cancelledWithoutActor = confirmationServicePreview({
      status: "cancelled",
      cancelledAt: "2026-08-31T08:02:00.000Z",
      cancelledBy: null,
      items: confirmationServicePreview().items.map((item) => ({
        ...item,
        status: item.status === "pending" ? "cancelled" : item.status,
      })),
    });
    const missingCancellationActor = confirmationServicePreview();
    delete missingCancellationActor.cancelledBy;
    for (const source of [
      openWithTerminalTime,
      pendingWithEvidence,
      confirmedWithoutEvidence,
      completedWithPendingExplicit,
      cancelledWithPending,
      openWithCancellationActor,
      completedWithCancellationActor,
      cancelledWithoutActor,
      missingCancellationActor,
    ]) {
      const model = normalizeQuickRecordDiffPreview(source, {
        selectedIds: ["customer-profile"],
      });
      assert.equal(model.confirmationContractValid, false);
      assert.equal(model.blocked, true);
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
      assert.equal(createQuickRecordDiffCancellationPayload(model), null);
    }
  });

  it("accepts only the backend's narrow confirmed-write receipt and drops untrusted plaintext", () => {
    const canonical = normalizeQuickRecordDiffPreview(confirmationServicePreview());
    assert.deepEqual(canonical.items.find((item) => item.id === "opportunity-next").receipt, {
      entityId: "opportunity-1",
      field: "requirements",
      version: 5,
    });

    const invalidReceipts = [
      { entityId: "opportunity-1", field: "requirements", version: 5, plaintext: "private" },
      { entityId: "other-opportunity", field: "requirements", version: 5 },
      { entityId: "opportunity-1", field: "owner", version: 5 },
      { entityId: "opportunity-1", field: "requirements", version: 4 },
      { version: 5 },
    ];
    for (const receipt of invalidReceipts) {
      const source = confirmationServicePreview();
      source.items[1].receipt = receipt;
      const model = normalizeQuickRecordDiffPreview(source);
      assert.equal(model.confirmationContractValid, false, JSON.stringify(receipt));
      assert.equal(model.blocked, true, JSON.stringify(receipt));
      assert.equal(model.items[1].receipt, null, JSON.stringify(receipt));
      assert.equal(JSON.stringify(model).includes("private"), false, JSON.stringify(receipt));
    }
  });

  it("never accepts an independent or unsupported item as confirmed", () => {
    for (const itemId of ["visit-temperature", "action-draft", "financial-draft"]) {
      const source = confirmationServicePreview();
      const index = source.items.findIndex((item) => item.id === itemId);
      const item = source.items[index];
      source.items[index] = {
        ...item,
        status: "confirmed",
        confirmedAt: "2026-08-31T08:02:00.000Z",
        confirmedBy: "operator-a",
        receipt: {
          entityId: item.entityId,
          field: item.field,
          version: item.entityVersion + 1,
        },
      };

      const model = normalizeQuickRecordDiffPreview(source);
      assert.equal(model.confirmationContractValid, false, itemId);
      assert.equal(model.blocked, true, itemId);
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null, itemId);
      assert.equal(createQuickRecordDiffCancellationPayload(model), null, itemId);
    }
  });

  it("requires exact source references and never preserves transport plaintext", () => {
    const source = confirmationServicePreview();
    source.items[0].sourceRefs[0] = {
      ...source.items[0].sourceRefs[0],
      plaintext: "owner-b-private-source",
    };

    const model = normalizeQuickRecordDiffPreview(source);
    assert.equal(model.confirmationContractValid, false);
    assert.equal(model.blocked, true);
    assert.deepEqual(model.items[0].sourceRefs, [{
      type: "quick_record",
      id: "quick-record-1",
    }]);
    assert.equal(JSON.stringify(model).includes("owner-b-private-source"), false);
    assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
    assert.equal(createQuickRecordDiffCancellationPayload(model), null);
  });

  it("fails closed for oversized previews and invalid backend identifiers", () => {
    const oversized = confirmationServicePreview({
      items: Array.from({ length: 51 }, (_, index) => ({
        ...confirmationServicePreview().items[0],
        id: `customer-profile-${index}`,
        identity: index.toString(16).padStart(64, "0"),
        field: `field_${index}`,
      })),
    });
    const invalidIdentifier = confirmationServicePreview({ id: "preview id with spaces" });
    const numericVersionString = confirmationServicePreview({ quickRecordVersion: "7" });
    const unsafeNumber = confirmationServicePreview();
    unsafeNumber.items[0].after = 1.5;
    const tooDeep = confirmationServicePreview();
    let nested = "leaf";
    for (let index = 0; index < 9; index += 1) nested = { next: nested };
    tooDeep.items[0].after = nested;

    for (const source of [
      oversized,
      invalidIdentifier,
      numericVersionString,
      unsafeNumber,
      tooDeep,
    ]) {
      const model = normalizeQuickRecordDiffPreview(source, {
        selectedIds: ["customer-profile"],
      });
      assert.equal(model.confirmationContractValid, false);
      assert.equal(model.blocked, true);
      assert.deepEqual(model.selectedIds, []);
      assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
    }
  });

  it("keeps a legacy target/digest preview displayable but never confirmable", () => {
    const model = normalizeQuickRecordDiffPreview(serverPreview(), {
      selectedIds: ["customer-profile"],
    });

    assert.equal(model.items.length, 4);
    assert.equal(model.confirmationContractValid, false);
    assert.equal(model.readOnly, true);
    assert.deepEqual(model.selectedIds, []);
    assert.equal(createQuickRecordDiffConfirmationPayload(model, { confirmAll: true }), null);
    assert.equal(createQuickRecordDiffCancellationPayload(model), null);
  });

  it("returns no cancellation payload without both cancellation pins or outside an open preview", () => {
    for (const field of ["id", "identity"]) {
      const source = confirmationServicePreview();
      delete source[field];
      assert.equal(
        createQuickRecordDiffCancellationPayload(normalizeQuickRecordDiffPreview(source)),
        null,
      );
    }
    assert.equal(
      createQuickRecordDiffCancellationPayload(normalizeQuickRecordDiffPreview(
        confirmationServicePreview({ status: "completed" }),
      )),
      null,
    );
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
