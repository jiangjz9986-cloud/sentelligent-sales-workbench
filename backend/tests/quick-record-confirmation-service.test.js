import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  QuickRecordConfirmationError,
  createQuickRecordConfirmationService,
} from "../src/quickRecords/confirmationService.js";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const keyFor = (item) => `${item.target}:${item.entityId}:${item.field}`;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function identityDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function recomputeStoredIdentities(preview) {
  for (const item of preview.items) {
    item.identity = identityDigest({
      schemaVersion: preview.schemaVersion,
      previewId: preview.id,
      owner: preview.owner,
      quickRecordId: preview.quickRecordId,
      analysisVersionId: preview.analysisVersionId,
      id: item.id,
      target: item.target,
      entityId: item.entityId,
      field: item.field,
      label: item.label,
      before: item.before,
      after: item.after,
      entityVersion: item.entityVersion,
      evidenceKeys: item.evidenceKeys,
      confirmationMode: item.confirmationMode,
      bulkEligible: item.bulkEligible,
      status: item.status,
      confirmedAt: item.confirmedAt,
      confirmedBy: item.confirmedBy,
      receipt: item.receipt,
      confirmationRequest: item.confirmationRequest,
    });
  }
  preview.identity = identityDigest({
    schemaVersion: preview.schemaVersion,
    id: preview.id,
    owner: preview.owner,
    quickRecordId: preview.quickRecordId,
    quickRecordVersion: preview.quickRecordVersion,
    quickRecordStatus: preview.quickRecordStatus,
    analysisVersionId: preview.analysisVersionId,
    analysisStatus: preview.analysisStatus,
    summaryHash: preview.summaryHash,
    evidenceHash: preview.evidenceHash,
    draftHash: preview.draftHash,
    status: preview.status,
    revision: preview.revision,
    itemIdentities: preview.items.map((item) => item.identity),
    requiresHumanConfirmation: preview.requiresHumanConfirmation,
    automaticWriteAllowed: preview.automaticWriteAllowed,
    createdWithUnsavedChanges: preview.createdWithUnsavedChanges,
    createdAt: preview.createdAt,
    updatedAt: preview.updatedAt,
    completedAt: preview.completedAt,
    cancelledAt: preview.cancelledAt,
    cancelledBy: preview.cancelledBy,
    cancellationRequestIdentity: preview.cancellationRequestIdentity,
  });
  return preview;
}

function errorCode(code) {
  return (error) => error instanceof QuickRecordConfirmationError && error.code === code;
}

function createHarness() {
  let now = new Date("2026-08-31T08:00:00.000Z");
  let sequence = 0;
  let failAudit = false;
  let failApplyTarget = null;
  let applyConflictCurrent = null;
  let applyReceipt;
  let auditAckId;
  const counters = {
    previewCreates: 0,
    previewReplaces: 0,
    transactions: 0,
    audits: 0,
    businessReads: 0,
    actorResolutions: 0,
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
        status: "ready_for_confirmation",
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
        status: "ready_for_confirmation",
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
      if (applyConflictCurrent) {
        return { conflict: true, current: clone(applyConflictCurrent) };
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
        receipt: applyReceipt === undefined ? { key, version: updated.version } : clone(applyReceipt),
      };
    },
  };
  const auditRepository = {
    append(entry) {
      if (failAudit) throw new Error("injected confirmation audit failure");
      counters.audits += 1;
      const stored = { id: auditAckId ?? `audit-${audits.length + 1}`, ...clone(entry) };
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

  const resolveAuthenticatedActor = ({ owner, actor }) => {
    counters.actorResolutions += 1;
    if (!actor || typeof actor.sessionId !== "string") return null;
    if (actor.sessionId === `authenticated-session:${owner}`) {
      return { id: owner, owner, authenticated: true };
    }
    if (actor.sessionId === `authenticated-session:${owner}:reviewer`) {
      return { id: "reviewer", owner, authenticated: true };
    }
    return null;
  };

  const service = createQuickRecordConfirmationService({
    draftRepository,
    previewRepository,
    writeRepository,
    auditRepository,
    runInTransaction,
    resolveAuthenticatedActor,
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
    setApplyConflictCurrent(value) { applyConflictCurrent = clone(value); },
    setApplyReceipt(value) { applyReceipt = clone(value); },
    setAuditAckId(value) { auditAckId = clone(value); },
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
    actor: { sessionId: `authenticated-session:${preview.owner}` },
    ...overrides,
  };
}

function cancelPins(preview, overrides = {}) {
  return {
    owner: preview.owner,
    previewId: preview.id,
    suggestionIdentity: preview.identity,
    actor: { sessionId: `authenticated-session:${preview.owner}` },
    cancel: true,
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

    assert.throws(() => createQuickRecordConfirmationService({
      draftRepository: { get: noop },
      previewRepository: { findByDraft: noop, create: noop, get: noop, replace: noop },
      writeRepository: { read: noop, apply: noop },
      auditRepository: { append: noop },
      runInTransaction: (work) => work(),
    }), {
      name: "TypeError",
      message: "resolveAuthenticatedActor must be a function",
    });
  });

  it("builds a durable item-by-item before/after preview without business writes", () => {
    const harness = createHarness();
    const before = snapshotBusiness(harness);

    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const replay = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });

    assert.equal(preview.schemaVersion, "quick-record-confirmation-v2");
    assert.equal(preview.status, "open");
    assert.equal(preview.quickRecordVersion, 4);
    assert.equal(preview.analysisVersionId, "analysis-a");
    assert.equal(preview.analysisStatus, "ready_for_confirmation");
    assert.match(preview.identity, /^[0-9a-f]{64}$/u);
    assert.match(preview.summaryHash, /^[0-9a-f]{64}$/u);
    assert.match(preview.evidenceHash, /^[0-9a-f]{64}$/u);
    assert.equal(preview.items.length, 6);
    assert.deepEqual(preview.items[0].before, ["原诉求"]);
    assert.deepEqual(preview.items[0].after, ["原诉求", "补齐本地灾备规划"]);
    assert.equal(preview.items.find((item) => item.target === "customer").confirmationMode, "explicit");
    assert.deepEqual(preview.items.map((item) => [item.target, item.field]), [
      ["customer", "needs"],
      ["opportunity", "requirements"],
      ["weekly", "entries"],
      ["customer_temperature", "relation"],
      ["action", "title"],
      ["financial", "amountCents"],
    ]);
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

  it("allows preview and confirmation only from explicit confirmable record and analysis states", () => {
    for (const [kind, terminalStatus, code] of [
      ["quick-record", "recorded", "QUICK_RECORD_NOT_CONFIRMABLE"],
      ["quick-record", "confirmed", "QUICK_RECORD_NOT_CONFIRMABLE"],
      ["analysis", "draft", "ANALYSIS_NOT_CONFIRMABLE"],
      ["analysis", "confirmed", "ANALYSIS_NOT_CONFIRMABLE"],
    ]) {
      const harness = createHarness();
      const draft = harness.drafts.get("quick-record-a");
      if (kind === "quick-record") draft.quickRecord.status = terminalStatus;
      else draft.analysis.status = terminalStatus;

      assert.throws(
        () => harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" }),
        errorCode(code),
        `${kind}:${terminalStatus}`,
      );
      assert.equal(harness.counters.previewCreates, 0, `${kind}:${terminalStatus}`);
      assert.equal(harness.counters.businessReads, 0, `${kind}:${terminalStatus}`);
      assert.equal(totalWrites(harness), 0, `${kind}:${terminalStatus}`);
      assert.equal(harness.counters.audits, 0, `${kind}:${terminalStatus}`);
    }

    {
      const harness = createHarness();
      delete harness.drafts.get("quick-record-a").analysis.status;
      assert.throws(
        () => harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" }),
        errorCode("DRAFT_DATA_INVALID"),
      );
      assert.equal(harness.counters.previewCreates, 0);
      assert.equal(totalWrites(harness), 0);
    }

    for (const [kind, terminalStatus, reason] of [
      ["quick-record", "confirmed", "quick_record_not_confirmable"],
      ["analysis", "confirmed", "analysis_not_confirmable"],
    ]) {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const item = preview.items[0];
      const draft = harness.drafts.get("quick-record-a");
      if (kind === "quick-record") draft.quickRecord.status = terminalStatus;
      else draft.analysis.status = terminalStatus;

      const result = harness.service.confirmItem({
        ...pins(preview),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      });
      assert.equal(result.status, "conflict", kind);
      assert.equal(result.reason, reason, kind);
      assert.deepEqual(result.details, { currentStatus: terminalStatus }, kind);
      assert.equal(harness.counters.businessReads, 0, kind);
      assert.equal(totalWrites(harness), 0, kind);
      assert.equal(harness.counters.audits, 0, kind);
    }
  });

  it("fails closed unless every target and field pair is explicitly allowlisted", () => {
    const cases = [
      ["customer", "temperature"],
      ["opportunity", "status"],
      ["weekly", "owner"],
      ["customer_temperature", "needs"],
      ["action", "amountCents"],
      ["financial", "title"],
      ["unknown_target", "entries"],
    ];

    for (const [target, field] of cases) {
      const harness = createHarness();
      const draft = harness.drafts.get("quick-record-a");
      draft.analysis.changes = [{
        ...clone(draft.analysis.changes[0]),
        id: `forbidden-${target}-${field}`,
        target,
        field,
        entityId: `${target}-entity`,
        before: "before",
        after: "after",
        entityVersion: 1,
      }];

      assert.throws(
        () => harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" }),
        errorCode("DRAFT_DATA_INVALID"),
        `${target}.${field}`,
      );
      assert.equal(harness.counters.previewCreates, 0, `${target}.${field}`);
      assert.equal(harness.counters.businessReads, 0, `${target}.${field}`);
      assert.equal(totalWrites(harness), 0, `${target}.${field}`);
      assert.equal(harness.counters.audits, 0, `${target}.${field}`);
    }
  });

  it("cancels and replays a preview without touching any business target", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const customerItem = preview.items.find((item) => item.target === "customer");
    const before = snapshotBusiness(harness);
    const cancelInput = cancelPins(preview);

    assert.throws(() => harness.service.cancel({
      owner: "owner-a",
      previewId: preview.id,
      suggestionIdentity: preview.identity,
    }), errorCode("EXPLICIT_CANCELLATION_REQUIRED"));

    const cancelled = harness.service.cancel(cancelInput);
    const replay = harness.service.cancel(cancelInput);
    const refreshedReplay = harness.service.cancel({
      ...cancelInput,
      suggestionIdentity: cancelled.identity,
    });

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelledBy, "owner-a");
    assert.ok(cancelled.items.every((item) => item.status === "cancelled"));
    assert.equal(Object.hasOwn(cancelled, "cancellationRequestIdentity"), false);
    assert.equal(replay.replayed, true);
    assert.equal(refreshedReplay.replayed, true);
    assert.equal(replay.identity, cancelled.identity);
    assert.equal(harness.counters.previewReplaces, 1);
    assert.equal(harness.counters.businessReads, 0);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 1);
    assert.equal(harness.audits[0].action, "quick_record.confirmation.cancelled");
    assert.equal(harness.audits[0].cancelledBy, "owner-a");
    assert.equal(harness.counters.actorResolutions, 3);
    assert.deepEqual(snapshotBusiness(harness), before);
    assert.throws(() => harness.service.cancel({
      ...cancelInput,
      actor: { sessionId: "authenticated-session:owner-a:reviewer" },
    }), errorCode("CANCELLATION_ACTOR_MISMATCH"));
    assert.throws(() => harness.service.cancel({
      ...cancelInput,
      suggestionIdentity: cancelled.identity,
      actor: { sessionId: "authenticated-session:owner-a:reviewer" },
    }), errorCode("CANCELLATION_ACTOR_MISMATCH"));
    assert.equal(harness.counters.audits, 1);
    assert.throws(() => harness.service.confirmItem({
      ...pins(preview),
      itemId: customerItem.id,
      itemIdentity: customerItem.identity,
      confirm: true,
    }), errorCode("SUGGESTION_IDENTITY_MISMATCH"));
  });

  it("requires a canonical authenticated actor for cancellation and rejects self-reported identities", () => {
    const attempts = [
      { actor: null },
      { actor: { sessionId: "authenticated-session:owner-b" } },
      { cancelledBy: "forged-user" },
      { confirmedBy: "forged-user" },
    ];

    for (const override of attempts) {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });

      assert.throws(
        () => harness.service.cancel(cancelPins(preview, override)),
        errorCode("UNTRUSTED_CANCELLATION_ACTOR"),
      );
      assert.equal(harness.counters.previewReplaces, 0);
      assert.equal(harness.counters.businessReads, 0);
      assert.equal(totalWrites(harness), 0);
      assert.equal(harness.counters.audits, 0);
      assert.equal(
        harness.counters.actorResolutions,
        Object.hasOwn(override, "cancelledBy") || Object.hasOwn(override, "confirmedBy") ? 0 : 1,
      );
    }
  });

  it("rolls back cancellation state when its actor audit cannot be persisted", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const before = snapshotBusiness(harness);
    harness.setFailAudit(true);

    assert.throws(
      () => harness.service.cancel(cancelPins(preview)),
      /injected confirmation audit failure/u,
    );
    const stored = harness.service.get({ owner: preview.owner, previewId: preview.id });
    assert.equal(stored.status, "open");
    assert.equal(stored.cancelledAt, null);
    assert.equal(stored.cancelledBy, null);
    assert.ok(stored.items.every((item) => item.status === "pending"));
    assert.deepEqual(snapshotBusiness(harness), before);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
  });

  it("returns cancelled for item and bulk confirmation after cancellation without a business read", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const item = preview.items.find((candidate) => candidate.target === "customer");
    const cancelled = harness.service.cancel(cancelPins(preview));
    const cancelledItem = cancelled.items.find((candidate) => candidate.id === item.id);

    const itemResult = harness.service.confirmItem({
      ...pins(cancelled),
      itemId: item.id,
      itemIdentity: cancelledItem.identity,
      confirm: true,
    });
    const allResult = harness.service.confirmAll({ ...pins(cancelled), confirm: true });

    assert.equal(itemResult.status, "cancelled");
    assert.equal(itemResult.writeback, false);
    assert.equal(itemResult.replayed, true);
    assert.equal(allResult.status, "cancelled");
    assert.equal(allResult.writeback, false);
    assert.equal(allResult.replayed, true);
    assert.equal(harness.counters.businessReads, 0);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 1);
  });

  it("requires explicit confirmation, confirms one item once, and replays without another write", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const customerItem = preview.items.find((item) => item.target === "customer");
    const input = pins(preview, {
      itemId: customerItem.id,
      itemIdentity: customerItem.identity,
    });

    assert.throws(() => harness.service.confirmItem(input), errorCode("EXPLICIT_CONFIRMATION_REQUIRED"));
    assert.equal(totalWrites(harness), 0);

    const confirmationInput = { ...input, confirm: true };
    const confirmed = harness.service.confirmItem(confirmationInput);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.writeback, true);
    assert.equal(confirmed.replayed, false);
    assert.deepEqual(harness.business.get(keyFor(customerItem)).value, customerItem.after);
    assert.equal(harness.business.get(keyFor(customerItem)).version, customerItem.entityVersion + 1);
    assert.equal(harness.counters.businessWrites.customer, 1);
    assert.equal(harness.counters.audits, 1);
    assert.equal(harness.audits[0].confirmedBy, "owner-a");

    const confirmedItem = confirmed.preview.items.find((item) => item.id === customerItem.id);
    assert.notEqual(confirmed.preview.identity, preview.identity);
    assert.notEqual(confirmedItem.identity, customerItem.identity);
    assert.equal(confirmed.preview.revision, preview.revision + 1);
    assert.equal(confirmedItem.confirmedBy, "owner-a");
    assert.equal(Object.hasOwn(confirmedItem, "confirmationRequest"), false);
    const replay = harness.service.confirmItem(confirmationInput);
    const refreshedReplay = harness.service.confirmItem({
      ...pins(confirmed.preview),
      itemId: confirmedItem.id,
      itemIdentity: confirmedItem.identity,
      confirm: true,
    });
    assert.equal(replay.status, "confirmed");
    assert.equal(replay.replayed, true);
    assert.equal(replay.writeback, false);
    assert.equal(refreshedReplay.replayed, true);
    assert.equal(refreshedReplay.writeback, false);
    assert.equal(harness.counters.businessWrites.customer, 1);
    assert.equal(harness.counters.audits, 1);
    assert.equal(harness.counters.businessReads, 1);
    assert.equal(harness.counters.previewReplaces, 1);

    const opportunityItem = preview.items.find((item) => item.target === "opportunity");
    assert.throws(() => harness.service.confirmItem({
      ...pins(preview),
      itemId: opportunityItem.id,
      itemIdentity: opportunityItem.identity,
      confirm: true,
    }), errorCode("SUGGESTION_IDENTITY_MISMATCH"));
    assert.throws(
      () => harness.service.cancel(cancelPins(preview)),
      errorCode("SUGGESTION_IDENTITY_MISMATCH"),
    );
    assert.equal(harness.counters.businessWrites.customer, 1);
    assert.equal(harness.counters.businessWrites.opportunity, 0);
    assert.equal(harness.counters.audits, 1);
  });

  it("treats the rotated identity as an already-applied result without changing the original actor", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const customerItem = preview.items.find((item) => item.target === "customer");
    const originalInput = {
      ...pins(preview),
      itemId: customerItem.id,
      itemIdentity: customerItem.identity,
      confirm: true,
    };
    const confirmed = harness.service.confirmItem(originalInput);
    const confirmedItem = confirmed.preview.items.find((item) => item.id === customerItem.id);
    const originalReceipt = clone(confirmedItem.receipt);

    assert.throws(() => harness.service.confirmItem({
      ...originalInput,
      actor: { sessionId: "authenticated-session:owner-a:reviewer" },
    }), errorCode("SUGGESTION_IDENTITY_MISMATCH"));
    assert.equal(harness.counters.businessWrites.customer, 1);
    assert.equal(harness.counters.businessReads, 1);
    assert.equal(harness.counters.audits, 1);
    assert.equal(harness.counters.previewReplaces, 1);

    const alreadyApplied = harness.service.confirmItem({
      ...pins(confirmed.preview, {
        actor: { sessionId: "authenticated-session:owner-a:reviewer" },
      }),
      itemId: confirmedItem.id,
      itemIdentity: confirmedItem.identity,
      confirm: true,
    });
    const replayedItem = alreadyApplied.preview.items.find((item) => item.id === customerItem.id);

    assert.equal(alreadyApplied.status, "confirmed");
    assert.equal(alreadyApplied.replayed, true);
    assert.equal(alreadyApplied.writeback, false);
    assert.equal(alreadyApplied.preview.status, confirmed.preview.status);
    assert.equal(replayedItem.confirmedBy, "owner-a");
    assert.deepEqual(replayedItem.receipt, originalReceipt);
    assert.equal(harness.counters.businessWrites.customer, 1);
    assert.equal(harness.counters.businessReads, 1);
    assert.equal(harness.counters.audits, 1);
    assert.equal(harness.counters.previewReplaces, 1);
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

  it("requires a canonical actor resolved from authenticated context before confirmation", () => {
    const attempts = [
      { actor: null },
      { actor: { sessionId: "authenticated-session:owner-b" } },
      { confirmedBy: "forged-user" },
      { cancelledBy: "forged-user" },
    ];

    for (const override of attempts) {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const item = preview.items[0];

      assert.throws(() => harness.service.confirmItem({
        ...pins(preview, override),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      }), errorCode("UNTRUSTED_CONFIRMATION_ACTOR"));
      assert.equal(harness.counters.businessReads, 0);
      assert.equal(totalWrites(harness), 0);
      assert.equal(harness.counters.audits, 0);
    }
  });

  it("confirms explicit allowlisted items while excluding temperature, action, and finance", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const confirmationInput = {
      ...pins(preview),
      confirm: true,
    };

    const confirmed = harness.service.confirmAll(confirmationInput);

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

    const temperature = confirmed.preview.items.find((item) => item.target === "customer_temperature");
    assert.throws(() => harness.service.confirmItem({
      ...pins(confirmed.preview),
      itemId: temperature.id,
      itemIdentity: temperature.identity,
      confirm: true,
    }), errorCode("INDEPENDENT_CONFIRMATION_REQUIRED"));
    for (const target of ["action", "financial"]) {
      const item = confirmed.preview.items.find((candidate) => candidate.target === target);
      assert.throws(() => harness.service.confirmItem({
        ...pins(confirmed.preview),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      }), errorCode("TARGET_NOT_CONFIRMABLE"));
    }
    assert.equal(totalWrites(harness), 3);

    const replay = harness.service.confirmAll(confirmationInput);
    const refreshedReplay = harness.service.confirmAll({
      ...pins(confirmed.preview),
      confirm: true,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.writeback, false);
    assert.equal(refreshedReplay.replayed, true);
    assert.equal(refreshedReplay.writeback, false);
    assert.equal(totalWrites(harness), 3);
    assert.equal(harness.counters.audits, 1);
    assert.equal(harness.counters.businessReads, 3);
    assert.equal(harness.counters.previewReplaces, 1);

    const customer = preview.items.find((item) => item.target === "customer");
    assert.throws(() => harness.service.confirmItem({
      ...pins(preview),
      itemId: customer.id,
      itemIdentity: customer.identity,
      confirm: true,
    }), errorCode("SUGGESTION_IDENTITY_MISMATCH"));

    assert.equal(totalWrites(harness), 3);
  });

  it("fails closed on a coherently rehashed partial bulk-confirmation state", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const originalStored = clone(harness.previews.get(preview.id));
    const originalRehash = recomputeStoredIdentities(clone(originalStored));
    assert.equal(originalRehash.identity, originalStored.identity);
    assert.deepEqual(
      originalRehash.items.map((item) => item.identity),
      originalStored.items.map((item) => item.identity),
    );
    const confirmationInput = { ...pins(preview), confirm: true };
    harness.service.confirmAll(confirmationInput);
    const stored = harness.previews.get(preview.id);
    const pendingOpportunity = originalStored.items.find((item) => item.target === "opportunity");
    const opportunityIndex = stored.items.findIndex((item) => item.target === "opportunity");
    stored.items[opportunityIndex] = clone(pendingOpportunity);
    stored.status = "open";
    stored.completedAt = null;
    recomputeStoredIdentities(stored);
    const writesBeforeReplay = totalWrites(harness);
    const auditsBeforeReplay = harness.counters.audits;

    assert.throws(
      () => harness.service.confirmAll(confirmationInput),
      errorCode("PREVIEW_DATA_INVALID"),
    );
    assert.equal(totalWrites(harness), writesBeforeReplay);
    assert.equal(harness.counters.audits, auditsBeforeReplay);
  });

  it("does not report confirmed when a preview contains only excluded targets", () => {
    const harness = createHarness();
    const draft = harness.drafts.get("quick-record-a");
    draft.analysis.changes = draft.analysis.changes.filter((item) => (
      ["customer_temperature", "action", "financial"].includes(item.target)
    ));
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });

    assert.equal(preview.status, "open");
    assert.throws(
      () => harness.service.confirmAll({ ...pins(preview), confirm: true }),
      errorCode("NO_BULK_CONFIRMABLE_ITEMS"),
    );
    assert.equal(harness.service.get({ owner: preview.owner, previewId: preview.id }).status, "open");
    assert.equal(harness.counters.businessReads, 0);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
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
    assert.throws(
      () => harness.service.confirmAll({ ...pins(preview), confirm: true }),
      errorCode("SUGGESTION_IDENTITY_MISMATCH"),
    );
    const remaining = harness.service.confirmAll({ ...pins(first.preview), confirm: true });

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
        ...pins(preview, {
          owner: "owner-b",
          actor: { sessionId: "authenticated-session:owner-b" },
        }),
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

  it("owner-validates and redacts apply-conflict details before returning them", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const item = preview.items[0];
    harness.setApplyConflictCurrent({
      owner: "owner-b",
      entityId: item.entityId,
      field: item.field,
      version: 99,
      value: "owner-b-private-value",
    });

    const result = harness.service.confirmItem({
      ...pins(preview),
      itemId: item.id,
      itemIdentity: item.identity,
      confirm: true,
    });

    assert.equal(result.status, "conflict");
    assert.equal(result.reason, "target_changed");
    assert.deepEqual(result.details, { itemId: item.id });
    assert.equal(JSON.stringify(result).includes("owner-b-private-value"), false);
    assert.equal(JSON.stringify(result).includes("owner-b"), false);
    assert.equal(totalWrites(harness), 0);
    assert.equal(harness.counters.audits, 0);
  });

  it("derives a narrow receipt from the verified write instead of returning repository plaintext", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const item = preview.items[0];
    harness.setApplyReceipt({
      owner: "owner-b",
      plaintext: "owner-b-private-receipt",
      nested: { account: "owner-b" },
    });

    const result = harness.service.confirmItem({
      ...pins(preview),
      itemId: item.id,
      itemIdentity: item.identity,
      confirm: true,
    });
    const expectedReceipt = {
      entityId: item.entityId,
      field: item.field,
      version: item.entityVersion + 1,
    };

    assert.deepEqual(result.confirmedItems[0].receipt, expectedReceipt);
    assert.deepEqual(result.preview.items[0].receipt, expectedReceipt);
    assert.deepEqual(harness.previews.get(preview.id).items[0].receipt, expectedReceipt);
    assert.equal(JSON.stringify(result).includes("owner-b-private-receipt"), false);
    assert.equal(JSON.stringify(result).includes("owner-b"), false);
    assert.equal(JSON.stringify(harness.audits).includes("owner-b-private-receipt"), false);
  });

  it("keeps the repository audit acknowledgement internal instead of returning its raw id", () => {
    const harness = createHarness();
    const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
    const item = preview.items[0];
    harness.setAuditAckId("owner-b:private-audit-ack");

    const result = harness.service.confirmItem({
      ...pins(preview),
      itemId: item.id,
      itemIdentity: item.identity,
      confirm: true,
    });

    assert.equal(result.status, "confirmed");
    assert.equal(result.writeback, true);
    assert.equal(Object.hasOwn(result, "auditId"), false);
    assert.equal(JSON.stringify(result).includes("owner-b:private-audit-ack"), false);
    assert.equal(harness.counters.audits, 1);
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

    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const item = preview.items[0];
      const beforeBusiness = snapshotBusiness(harness);
      const beforePreview = clone(harness.previews.get(preview.id));
      harness.setAuditAckId({ owner: "owner-b", plaintext: "private-audit-ack" });

      assert.throws(() => harness.service.confirmItem({
        ...pins(preview),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      }), errorCode("AUDIT_WRITE_INVALID"));
      assert.deepEqual(snapshotBusiness(harness), beforeBusiness);
      assert.deepEqual(harness.previews.get(preview.id), beforePreview);
    }
  });

  it("fails closed on an unknown stored schema before any write", () => {
    for (const schemaVersion of ["quick-record-confirmation-v1", "quick-record-confirmation-v999"]) {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      harness.previews.get(preview.id).schemaVersion = schemaVersion;

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
        schemaVersion,
      );
      assert.equal(totalWrites(harness), 0);
      assert.equal(harness.counters.audits, 0);
    }
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

  it("binds revision and every terminal item and preview field into rotating identities", () => {
    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      harness.previews.get(preview.id).revision += 1;

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
      );
    }

    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const stored = harness.previews.get(preview.id);
      stored.revision += 1;
      stored.updatedAt = "2026-08-31T08:01:00.000Z";
      stored.items[0].status = "confirmed";
      stored.items[0].confirmedAt = "2026-08-31T08:01:00.000Z";
      stored.items[0].confirmedBy = "owner-a";
      stored.items[0].receipt = { version: 6 };

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
      );
    }

    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const item = preview.items[0];
      const confirmed = harness.service.confirmItem({
        ...pins(preview),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      });
      const stored = harness.previews.get(preview.id);
      stored.items[0].receipt = {
        entityId: item.entityId,
        field: item.field,
        version: item.entityVersion + 1,
        owner: "owner-b",
        plaintext: "owner-b-private-stored-receipt",
      };
      recomputeStoredIdentities(stored);

      assert.notEqual(confirmed.preview.identity, preview.identity);
      assert.notEqual(confirmed.preview.items[0].identity, item.identity);
      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
      );
      assert.equal(harness.counters.businessWrites.customer, 1);
      assert.equal(harness.counters.audits, 1);
    }

    for (const terminalField of ["confirmedAt", "confirmedBy"]) {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const item = preview.items[0];
      harness.service.confirmItem({
        ...pins(preview),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      });
      const storedItem = harness.previews.get(preview.id).items[0];
      storedItem[terminalField] = terminalField === "confirmedAt"
        ? "2026-08-31T08:02:00.000Z"
        : "forged-actor";

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
        terminalField,
      );
    }

    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const item = preview.items[0];
      harness.service.confirmItem({
        ...pins(preview),
        itemId: item.id,
        itemIdentity: item.identity,
        confirm: true,
      });
      harness.previews.get(preview.id).items[0].confirmationRequest.mode = "all";

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
        "confirmationRequest.mode",
      );
    }

    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      harness.service.confirmAll({ ...pins(preview), confirm: true });
      harness.previews.get(preview.id).completedAt = "2026-08-31T08:03:00.000Z";

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
        "completedAt",
      );
    }

    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      harness.service.cancel(cancelPins(preview));
      harness.previews.get(preview.id).cancelledAt = "2026-08-31T08:03:00.000Z";

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
        "cancelledAt",
      );
    }

    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      harness.service.cancel(cancelPins(preview));
      harness.previews.get(preview.id).cancellationRequestIdentity = "0".repeat(64);

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
        "cancellationRequestIdentity",
      );
    }

    {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      harness.service.cancel(cancelPins(preview));
      harness.previews.get(preview.id).cancelledBy = "forged-actor";

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
        "cancelledBy",
      );
    }
  });

  it("rejects coherently rehashed stored confirmations for temperature, action, and finance", () => {
    for (const target of ["customer_temperature", "action", "financial"]) {
      const harness = createHarness();
      const preview = harness.service.preview({ owner: "owner-a", quickRecordId: "quick-record-a" });
      const stored = harness.previews.get(preview.id);
      const item = stored.items.find((candidate) => candidate.target === target);
      const oldItemIdentity = item.identity;
      item.status = "confirmed";
      item.confirmedAt = "2026-08-31T08:01:00.000Z";
      item.confirmedBy = "owner-a";
      item.receipt = {
        entityId: item.entityId,
        field: item.field,
        version: item.entityVersion + 1,
      };
      item.confirmationRequest = {
        mode: "item",
        suggestionIdentity: stored.identity,
        itemIdentity: oldItemIdentity,
      };
      recomputeStoredIdentities(stored);

      assert.throws(
        () => harness.service.get({ owner: "owner-a", previewId: preview.id }),
        errorCode("PREVIEW_DATA_INVALID"),
        target,
      );
      assert.equal(totalWrites(harness), 0, target);
      assert.equal(harness.counters.audits, 0, target);
    }
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
