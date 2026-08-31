import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  QuickRecordConfirmationError,
  createQuickRecordConfirmationService,
} from "../src/quickRecords/confirmationService.js";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const keyFor = (item) => `${item.target}:${item.entityId}:${item.field}`;

function errorCode(code) {
  return (error) => error instanceof QuickRecordConfirmationError && error.code === code;
}

function createHarness() {
  let now = new Date("2026-08-31T08:00:00.000Z");
  let sequence = 0;
  let failAudit = false;
  let failApplyTarget = null;
  const counters = {
    previewCreates: 0,
    previewReplaces: 0,
    transactions: 0,
    audits: 0,
    businessReads: 0,
    businessWrites: {
      customer: 0,
      opportunity: 0,
      weekly: 0,
      customer_temperature: 0,
      action: 0,
      financial: 0,
    },
  };
  const drafts = new Map([
    ["quick-record-a", {
      owner: "owner-a",
      hasUnsavedChanges: false,
      quickRecord: {
        id: "quick-record-a",
        owner: "owner-a",
        version: 4,
        status: "analyzed",
      },
      analysis: {
        id: "analysis-a",
        summary: {
          request: { title: "客户诉求", text: "补齐本地灾备规划。" },
          feedback: { title: "客户反馈", text: "客户同意安排技术交流。" },
          risk: { title: "风险点", text: "预算窗口仍需确认。" },
          action: { title: "建议动作", text: "下周提交规划清单。" },
        },
        evidence: [
          {
            key: "request",
            label: "客户诉求原文",
            value: "客户明确提出补齐本地灾备规划。",
            sourceRef: { type: "quick_record", id: "quick-record-a" },
          },
          {
            key: "feedback",
            label: "客户反馈原文",
            value: "客户同意安排下一次技术交流。",
            sourceRef: { type: "quick_record_insight", id: "analysis-a" },
          },
        ],
        changes: [
          {
            id: "customer-needs",
            target: "customer",
            entityId: "customer-a",
            field: "needs",
            label: "客户诉求",
            before: ["原诉求"],
            after: ["原诉求", "补齐本地灾备规划"],
            entityVersion: 5,
            evidenceKeys: ["request"],
          },
          {
            id: "opportunity-requirements",
            target: "opportunity",
            entityId: "opportunity-a",
            field: "requirements",
            label: "商机需求",
            before: ["旧需求"],
            after: ["补齐本地灾备规划"],
            entityVersion: 3,
            evidenceKeys: ["request"],
          },
          {
            id: "weekly-entry",
            target: "weekly",
            entityId: "weekly-a",
            field: "entries",
            label: "周报条目",
            before: [],
            after: ["客户同意安排技术交流"],
            entityVersion: 2,
            evidenceKeys: ["feedback"],
          },
          {
            id: "customer-temperature",
            target: "customer_temperature",
            entityId: "customer-a",
            field: "relation",
            label: "客户温度",
            before: 42,
            after: 68,
            entityVersion: 5,
            evidenceKeys: ["feedback"],
          },
          {
            id: "action-draft",
            target: "action",
            entityId: "action-a",
            field: "title",
            label: "待办草稿",
            before: "旧待办",
            after: "安排技术交流",
            entityVersion: 1,
            evidenceKeys: ["feedback"],
          },
          {
            id: "financial-draft",
            target: "financial",
            entityId: "expense-a",
            field: "amountCents",
            label: "财务草稿",
            before: 0,
            after: 10000,
            entityVersion: 1,
            evidenceKeys: ["request"],
          },
        ],
      },
    }],
    ["quick-record-b", {
      owner: "owner-b",
      hasUnsavedChanges: false,
      quickRecord: {
        id: "quick-record-b",
        owner: "owner-b",
        version: 2,
        status: "analyzed",
      },
      analysis: {
        id: "analysis-b",
        summary: { request: { title: "诉求", text: "另一个账号的数据" } },
        evidence: [{
          key: "request",
          label: "诉求",
          value: "另一个账号的数据",
          sourceRef: { type: "quick_record", id: "quick-record-b" },
        }],
        changes: [{
          id: "weekly-b",
          target: "weekly",
          entityId: "weekly-b",
          field: "entries",
          label: "周报条目",
          before: [],
          after: ["另一个账号的数据"],
          entityVersion: 1,
          evidenceKeys: ["request"],
        }],
      },
    }],
  ]);
  const business = new Map([
    ["customer:customer-a:needs", { owner: "owner-a", entityId: "customer-a", field: "needs", version: 5, value: ["原诉求"] }],
    ["opportunity:opportunity-a:requirements", { owner: "owner-a", entityId: "opportunity-a", field: "requirements", version: 3, value: ["旧需求"] }],
    ["weekly:weekly-a:entries", { owner: "owner-a", entityId: "weekly-a", field: "entries", version: 2, value: [] }],
    ["customer_temperature:customer-a:relation", { owner: "owner-a", entityId: "customer-a", field: "relation", version: 5, value: 42 }],
    ["action:action-a:title", { owner: "owner-a", entityId: "action-a", field: "title", version: 1, value: "旧待办" }],
    ["financial:expense-a:amountCents", { owner: "owner-a", entityId: "expense-a", field: "amountCents", version: 1, value: 0 }],
    ["weekly:weekly-b:entries", { owner: "owner-b", entityId: "weekly-b", field: "entries", version: 1, value: [] }],
  ]);
  const previews = new Map();
  const audits = [];

  const draftRepository = {
    get({ owner, quickRecordId }) {
      const item = drafts.get(quickRecordId);
      return item?.owner === owner ? clone(item) : null;
    },
  };
  const previewRepository = {
    findByDraft({ owner, quickRecordId, draftHash }) {
      const item = [...previews.values()].find((candidate) => (
        candidate.owner === owner
        && candidate.quickRecordId === quickRecordId
        && candidate.draftHash === draftHash
      ));
      return item ? clone(item) : null;
    },
    create(item) {
      const existing = [...previews.values()].find((candidate) => (
        candidate.owner === item.owner
        && candidate.quickRecordId === item.quickRecordId
        && candidate.draftHash === item.draftHash
      ));
      if (existing) return { item: clone(existing), replayed: true };
      counters.previewCreates += 1;
      previews.set(item.id, clone(item));
      return { item: clone(item), replayed: false };
    },
    get({ owner, previewId }) {
      const item = previews.get(previewId);
      return item?.owner === owner ? clone(item) : null;
    },
    replace({ owner, previewId, identity, expectedRevision, item }) {
      const current = previews.get(previewId);
      if (
        !current
        || current.owner !== owner
        || current.identity !== identity
        || current.revision !== expectedRevision
      ) return null;
      counters.previewReplaces += 1;
      const next = { ...clone(item), revision: current.revision + 1 };
      previews.set(previewId, next);
      return clone(next);
    },
  };
  const writeRepository = {
    read({ owner, item }) {
      counters.businessReads += 1;
      const current = business.get(keyFor(item));
      return current?.owner === owner ? clone(current) : null;
    },
    apply({ owner, item, expectedVersion, expectedValue, value }) {
      const key = keyFor(item);
      const current = business.get(key);
      if (!current || current.owner !== owner) return { notFound: true };
      if (
        current.version !== expectedVersion
        || JSON.stringify(current.value) !== JSON.stringify(expectedValue)
      ) return { conflict: true, current: clone(current) };
      if (failApplyTarget === item.target) {
        const error = new Error(`injected ${item.target} conflict`);
        error.code = "VERSION_CONFLICT";
        throw error;
      }
      counters.businessWrites[item.target] += 1;
      const updated = {
        ...current,
        version: current.version + 1,
        value: clone(value),
      };
      business.set(key, updated);
      return {
        item: clone(updated),
        receipt: { key, version: updated.version },
      };
    },
  };
  const auditRepository = {
    append(entry) {
      if (failAudit) throw new Error("injected confirmation audit failure");
      counters.audits += 1;
      const stored = { id: `audit-${audits.length + 1}`, ...clone(entry) };
      audits.push(stored);
      return clone(stored);
    },
  };
  const runInTransaction = (work) => {
    counters.transactions += 1;
    const previewSnapshot = clone([...previews.entries()]);
    const businessSnapshot = clone([...business.entries()]);
    const auditSnapshot = clone(audits);
    try {
      const result = work();
      assert.equal(result && typeof result.then, "undefined", "transaction work must stay synchronous");
      return result;
    } catch (error) {
      previews.clear();
      business.clear();
      audits.splice(0, audits.length, ...auditSnapshot);
      for (const [key, value] of previewSnapshot) previews.set(key, value);
      for (const [key, value] of businessSnapshot) business.set(key, value);
      throw error;
    }
  };

  const service = createQuickRecordConfirmationService({
    draftRepository,
    previewRepository,
    writeRepository,
    auditRepository,
    runInTransaction,
    idFactory: () => `quick-confirmation-${++sequence}`,
    clock: () => new Date(now),
  });

  return {
    service,
    drafts,
    business,
    previews,
    audits,
    counters,
    advance(ms) { now = new Date(now.getTime() + ms); },
    setFailAudit(value) { failAudit = value; },
    setFailApplyTarget(value) { failApplyTarget = value; },
  };
}

function pins(preview, overrides = {}) {
  return {
    owner: preview.owner,
    previewId: preview.id,
    suggestionIdentity: preview.identity,
    expectedQuickRecordVersion: preview.quickRecordVersion,
    analysisVersionId: preview.analysisVersionId,
    summaryHash: preview.summaryHash,
    evidenceHash: preview.evidenceHash,
    ...overrides,
  };
}

function snapshotBusiness(harness) {
  return clone([...harness.business.entries()]);
}

function totalWrites(harness) {
  return Object.values(harness.counters.businessWrites).reduce((total, value) => total + value, 0);
}

describe("quick-record confirmation preview core", () => {
  it("requires a real injected transaction boundary", () => {
    const noop = () => null;
    assert.throws(() => createQuickRecordConfirmationService({
      draftRepository: { get: noop },
      previewRepository: { findByDraft: noop, create: noop, get: noop, replace: noop },
      writeRepository: { read: noop, apply: noop },
      auditRepository: { append: noop },
    }), {
      name: "TypeError",
      message: "runInTransaction must be a function",
    });
  });

  it("builds a durable item-by-item before/after preview without business writes", () => {
    const harness = createHarness();
    const before = snapshotBusiness(harness);

    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const replay = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });

    assert.equal(preview.schemaVersion, "quick-record-confirmation-v1");
    assert.equal(preview.status, "open");
    assert.equal(preview.quickRecordVersion, 4);
    assert.equal(preview.analysisVersionId, "analysis-a");
    assert.match(preview.identity, /^[0-9a-f]{64}$/u);
    assert.match(preview.summaryHash, /^[0-9a-f]{64}$/u);
    assert.match(preview.evidenceHash, /^[0-9a-f]{64}$/u);
    assert.equal(preview.items.length, 6);
    assert.deepEqual(preview.items[0].before, ["原诉求"]);
    assert.deepEqual(preview.items[0].after, ["原诉求", "补齐本地灾备规划"]);
    assert.equal(preview.items.find((item) => item.target === "customer").confirmationMode, "explicit");
    assert.equal(preview.items.find((item) => item.target === "customer_temperature").confirmationMode, "independent");
    assert.equal(preview.items.find((item) => item.target === "customer_temperature").bulkEligible, false);
    assert.equal(preview.items.find((item) => item.target === "action").confirmationMode, "unsupported");
    assert.equal(preview.items.find((item) => item.target === "financial").confirmationMode, "unsupported");
    assert.ok(preview.items[0].sourceRefs.some((item) => item.type === "quick_record" && item.id === "quick-record-a"));
    assert.equal(replay.id, preview.id);
    assert.equal(replay.replayed, true);
    assert.equal(harness.counters.previewCreates, 1);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
    assert.deepEqual(snapshotBusiness(harness), before);

    preview.items[0].before.push("tampered");
    assert.deepEqual(
      harness.service.get({ owner: "owner-a", previewId: preview.id }).items[0].before,
      ["原诉求"],
    );
  });

  it("treats a cross-owner preview lookup as missing before creating or reading business data", () => {
    const harness = createHarness();

    assert.throws(
      () => harness.service.preview({ owner: "owner-b", quickRecordId: "quick-record-a" }),
      errorCode("NOT_FOUND"),
    );
    assert.equal(harness.counters.previewCreates, 0);
    assert.equal(harness.counters.businessReads, 0);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
  });

  it("cancels and replays a preview without touching any business target", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const before = snapshotBusiness(harness);

    assert.throws(() => harness.service.cancel({
      owner: "owner-a",
      previewId: preview.id,
      suggestionIdentity: preview.identity,
    }), errorCode("EXPLICIT_CANCELLATION_REQUIRED"));

    const cancelled = harness.service.cancel({
      owner: "owner-a",
      previewId: preview.id,
      suggestionIdentity: preview.identity,
      cancel: true,
    });
    const replay = harness.service.cancel({
      owner: "owner-a",
      previewId: preview.id,
      suggestionIdentity: preview.identity,
      cancel: true,
    });

    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.items.every((item) => item.status === "cancelled"));
    assert.equal(replay.replayed, true);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
    assert.deepEqual(snapshotBusiness(harness), before);
  });

  it("returns cancelled for item and bulk confirmation after cancellation without a business read", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const item = preview.items.find((candidate) => candidate.target === "customer");
    harness.service.cancel({
      owner: preview.owner,
      previewId: preview.id,
      suggestionIdentity: preview.identity,
      cancel: true,
    });

    const itemResult = harness.service.confirmItem({
      ...pins(preview),
      itemId: item.id,
      itemIdentity: item.identity,
      confirm: true,
    });
    const allResult = harness.service.confirmAll({ ...pins(preview), confirm: true });

    assert.equal(itemResult.status, "cancelled");
    assert.equal(itemResult.writeback, false);
    assert.equal(itemResult.replayed, true);
    assert.equal(allResult.status, "cancelled");
    assert.equal(allResult.writeback, false);
    assert.equal(allResult.replayed, true);
    assert.equal(harness.counters.businessReads, 0);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
  });

  it("requires explicit confirmation, confirms one item once, and replays without another write", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const customerItem = preview.items.find((item) => item.target === "customer");
    const input = pins(preview, {
      itemId: customerItem.id,
      itemIdentity: customerItem.identity,
      confirmedBy: "owner-a",
    });

    assert.throws(() => harness.service.confirmItem(input), errorCode("EXPLICIT_CONFIRMATION_REQUIRED"));
    assert.equal(totalWrites(harness), 0);

    const confirmed = harness.service.confirmItem({ ...input, confirm: true });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.writeback, true);
    assert.equal(confirmed.replayed, false);
    assert.deepEqual(harness.business.get(keyFor(customerItem)).value, customerItem.after);
    assert.equal(harness.business.get(keyFor(customerItem)).version, customerItem.entityVersion + 1);
    assert.equal(harness.counters.businessWrites.customer, 1);
    assert.equal(harness.counters.audits, 1);

    const replay = harness.service.confirmItem({ ...input, confirm: true });
    assert.equal(replay.status, "confirmed");
    assert.equal(replay.replayed, true);
    assert.equal(replay.writeback, false);
    assert.equal(harness.counters.businessWrites.customer, 1);
    assert.equal(harness.counters.audits, 1);
  });

  it("rejects a forged item identity before any business read or write", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const item = preview.items.find((candidate) => candidate.target === "customer");

    assert.throws(() => harness.service.confirmItem({
      ...pins(preview),
      itemId: item.id,
      itemIdentity: "0".repeat(64),
      confirm: true,
    }), errorCode("ITEM_IDENTITY_MISMATCH"));
    assert.equal(harness.counters.businessReads, 0);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
  });

  it("confirms all eligible items atomically while excluding temperature, action, and finance", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });

    const confirmed = harness.service.confirmAll({
      ...pins(preview),
      confirmedBy: "owner-a",
      confirm: true,
    });

    assert.equal(confirmed.status, "confirmed");
    assert.deepEqual(confirmed.confirmedItems.map((item) => item.target), ["customer", "opportunity", "weekly"]);
    assert.deepEqual(
      confirmed.excludedItems.map((item) => [item.target, item.reason]),
      [
        ["customer_temperature", "independent_confirmation_required"],
        ["action", "target_not_confirmable"],
        ["financial", "target_not_confirmable"],
      ],
    );
    assert.equal(harness.counters.businessWrites.customer, 1);
    assert.equal(harness.counters.businessWrites.opportunity, 1);
    assert.equal(harness.counters.businessWrites.weekly, 1);
    assert.equal(harness.counters.businessWrites.customer_temperature, 0);
    assert.equal(harness.counters.businessWrites.action, 0);
    assert.equal(harness.counters.businessWrites.financial, 0);
    assert.equal(harness.counters.audits, 1);

    const replay = harness.service.confirmAll({
      ...pins(preview),
      confirmedBy: "owner-a",
      confirm: true,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.writeback, false);
    assert.equal(totalWrites(harness), 3);
    assert.equal(harness.counters.audits, 1);

    const temperature = preview.items.find((item) => item.target === "customer_temperature");
    assert.throws(() => harness.service.confirmItem({
      ...pins(preview),
      itemId: temperature.id,
      itemIdentity: temperature.identity,
      confirm: true,
    }), errorCode("INDEPENDENT_CONFIRMATION_REQUIRED"));
    for (const target of ["action", "financial"]) {
      const item = preview.items.find((candidate) => candidate.target === target);
      assert.throws(() => harness.service.confirmItem({
        ...pins(preview),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      }), errorCode("TARGET_NOT_CONFIRMABLE"));
    }
    assert.equal(totalWrites(harness), 3);
  });

  it("confirms only the remaining eligible items after one item was confirmed separately", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const customer = preview.items.find((item) => item.target === "customer");

    const first = harness.service.confirmItem({
      ...pins(preview),
      itemId: customer.id,
      itemIdentity: customer.identity,
      confirm: true,
    });
    const remaining = harness.service.confirmAll({ ...pins(preview), confirm: true });

    assert.deepEqual(first.confirmedItems.map((item) => item.target), ["customer"]);
    assert.deepEqual(remaining.confirmedItems.map((item) => item.target), ["opportunity", "weekly"]);
    assert.deepEqual(
      remaining.excludedItems.map((item) => item.target),
      ["customer_temperature", "action", "financial"],
    );
    assert.equal(harness.counters.businessWrites.customer, 1);
    assert.equal(harness.counters.businessWrites.opportunity, 1);
    assert.equal(harness.counters.businessWrites.weekly, 1);
    assert.equal(harness.counters.businessWrites.customer_temperature, 0);
    assert.equal(harness.counters.businessWrites.action, 0);
    assert.equal(harness.counters.businessWrites.financial, 0);
    assert.equal(harness.counters.audits, 2);
    assert.equal(totalWrites(harness), 3);
  });

  it("revalidates owner, suggestion identity, pins, record version, summary, and evidence", () => {
    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const item = preview.items[0];
      assert.throws(
        () => harness.service.get({ owner: "owner-b", previewId: preview.id }),
        errorCode("NOT_FOUND"),
      );
      assert.throws(() => harness.service.confirmItem({
        ...pins(preview, { owner: "owner-b" }),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      }), errorCode("NOT_FOUND"));
      assert.throws(() => harness.service.confirmItem({
        ...pins(preview, { suggestionIdentity: "0".repeat(64) }),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      }), errorCode("SUGGESTION_IDENTITY_MISMATCH"));
      assert.throws(() => harness.service.confirmItem({
        ...pins(preview, { expectedQuickRecordVersion: preview.quickRecordVersion + 1 }),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      }), errorCode("PREVIEW_INPUT_MISMATCH"));
      assert.equal(totalWrites(harness), 0);
    }

    for (const drift of ["record", "analysis", "summary", "evidence"]) {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const item = preview.items[0];
      const draft = harness.drafts.get("quick-record-a");
      if (drift === "record") draft.quickRecord.version += 1;
      if (drift === "analysis") draft.analysis.id = "analysis-a-v2";
      if (drift === "summary") draft.analysis.summary.request.text = "已保存摘要后来变化";
      if (drift === "evidence") draft.analysis.evidence[0].value = "已保存证据后来变化";
      const result = harness.service.confirmItem({
        ...pins(preview),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      });
      assert.equal(result.status, "conflict", drift);
      assert.equal(
        result.reason,
        drift === "record" ? "quick_record_changed" : drift === "analysis" ? "analysis_changed" : "draft_changed",
        drift,
      );
      assert.equal(totalWrites(harness), 0, drift);
      assert.equal(harness.counters.audits, 0, drift);
    }
  });

  it("rejects confirmation while the analysis draft has unsaved edits", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const item = preview.items[0];
    harness.drafts.get("quick-record-a").hasUnsavedChanges = true;

    assert.throws(() => harness.service.confirmItem({
      ...pins(preview),
      itemId: item.id,
      itemIdentity: item.identity,
      confirm: true,
    }), errorCode("UNSAVED_DRAFT_CHANGES"));
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
    assert.equal(harness.previews.get(preview.id).items[0].status, "pending");
  });

  it("returns a real conflict instead of reporting success when a target changed", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const item = preview.items[0];
    const current = harness.business.get(keyFor(item));
    current.version += 1;
    current.value = ["其他请求已经写入的新值"];

    const result = harness.service.confirmItem({
      ...pins(preview),
      itemId: item.id,
      itemIdentity: item.identity,
      confirm: true,
    });

    assert.equal(result.status, "conflict");
    assert.equal(result.reason, "target_changed");
    assert.equal(result.writeback, false);
    assert.deepEqual(harness.business.get(keyFor(item)).value, ["其他请求已经写入的新值"]);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
    assert.equal(harness.previews.get(preview.id).items[0].status, "pending");
  });

  it("rolls back every business write and preview state on apply or audit failure", () => {
    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const beforeBusiness = snapshotBusiness(harness);
      const beforePreview = clone(harness.previews.get(preview.id));
      harness.setFailApplyTarget("opportunity");

      const result = harness.service.confirmAll({ ...pins(preview), confirm: true });
      assert.equal(result.status, "conflict");
      assert.equal(result.reason, "target_changed");
      assert.deepEqual(snapshotBusiness(harness), beforeBusiness);
      assert.deepEqual(harness.previews.get(preview.id), beforePreview);
      assert.equal(harness.counters.audits, 0);
    }

    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const item = preview.items[0];
      const beforeBusiness = snapshotBusiness(harness);
      const beforePreview = clone(harness.previews.get(preview.id));
      harness.setFailAudit(true);

      assert.throws(() => harness.service.confirmItem({
        ...pins(preview),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      }), /injected confirmation audit failure/u);
      assert.deepEqual(snapshotBusiness(harness), beforeBusiness);
      assert.deepEqual(harness.previews.get(preview.id), beforePreview);
      assert.equal(harness.audits.length, 0);
    }
  });

  it("fails closed on an unknown stored schema before any write", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    harness.previews.get(preview.id).schemaVersion = "quick-record-confirmation-v999";

    assert.throws(
      () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
      errorCode("PREVIEW_DATA_INVALID"),
    );
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
  });

  it("maps damaged stored source references to a bounded preview-data error", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    harness.previews.get(preview.id).items[0].sourceRefs = undefined;

    assert.throws(
      () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
      errorCode("PREVIEW_DATA_INVALID"),
    );
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
  });

  it("fails closed on impossible stored confirmation states before any write", () => {
    const mutations = [
      (stored) => {
        stored.items[0].status = "confirmed";
        stored.items[0].confirmedAt = "2026-08-31T08:01:00.000Z";
        stored.items[0].receipt = null;
      },
      (stored) => {
        stored.items[0].confirmedAt = "2026-08-31T08:01:00.000Z";
        stored.items[0].receipt = { version: 6 };
      },
      (stored) => {
        stored.status = "cancelled";
        stored.cancelledAt = "2026-08-31T08:01:00.000Z";
      },
      (stored) => {
        stored.status = "completed";
        stored.completedAt = "2026-08-31T08:01:00.000Z";
      },
    ];

    for (const mutate of mutations) {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      mutate(harness.previews.get(preview.id));

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
      );
      assert.equal(totalWrites(harness), 0);
      assert.equal(harness.counters.audits, 0);
    }
  });
});
