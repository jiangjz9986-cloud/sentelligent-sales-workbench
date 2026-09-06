import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ToastProvider } from "../../src/components/toast.jsx";
import { AssistantChatPanel } from "../../src/components/assistant/AssistantChatPanel.jsx";
import { ProactiveAssistantPanel } from "../../src/features/salesWorkbench/components/ProactiveAssistantPanel.jsx";

const CUSTOMER_ID = "cross-customer";
const OPPORTUNITY_ID = "cross-opportunity";
const SHARED_ID = "shared-suggestion";

function makeSuggestion(index, overrides = {}) {
  const id = index === 0 ? SHARED_ID : `paged-suggestion-${String(index).padStart(3, "0")}`;
  return {
    id,
    version: 1,
    lifecycleVersion: 1,
    lifecycleStatus: "pending",
    proactiveStatus: "pending",
    status: "pending",
    schemaVersion: "proactive-assistant-v1",
    modelVersion: "rules/proactive-v1",
    subjectType: "opportunity",
    subjectId: OPPORTUNITY_ID,
    customerId: CUSTOMER_ID,
    opportunityId: OPPORTUNITY_ID,
    opportunityVersion: 1,
    customerVersion: 1,
    title: index === 0 ? "同一条跨入口建议" : `分页建议 ${index}`,
    conclusion: "所有入口必须读取同一个持久账本。",
    facts: [],
    inferences: [],
    unknowns: [],
    risks: [],
    nextActions: [],
    evidenceRefs: [],
    sourceRefs: [],
    confidence: null,
    confidenceLevel: "unverified",
    confidenceCalibrated: false,
    priority: null,
    priorityCalibrated: false,
    trigger: { type: "missing_next_step", reason: "next 为空", detectedAt: "2026-09-05T06:00:00.000Z" },
    source: "persisted",
    fallbackReason: null,
    confirmationStatus: "not_started",
    writebackPreview: { requiresHumanConfirmation: true, automaticWriteAllowed: false, action: null, risk: null },
    previewDigests: {},
    writebackAllowed: false,
    createdAt: "2026-09-05T06:00:00.000Z",
    updatedAt: "2026-09-05T06:00:00.000Z",
    ...overrides,
  };
}

function assistantSnapshot(items) {
  const lifecycle = {};
  for (const item of items) {
    const status = item.proactiveStatus ?? item.status ?? "pending";
    lifecycle[status] = (lifecycle[status] ?? 0) + 1;
  }
  return {
    schemaVersion: "proactive-assistant-v1",
    modelVersion: "rules/proactive-v1",
    source: "persisted",
    generatedAt: items[0]?.updatedAt ?? "2026-09-05T06:00:00.000Z",
    staleDays: 21,
    limit: items.length || 1,
    offset: 0,
    items,
    counts: { total: items.length, lifecycle },
    lifecycleCounts: { total: items.length, ...lifecycle },
    truncated: false,
    writebackPolicy: { requiresHumanConfirmation: true, automaticWriteAllowed: false },
  };
}

const initialLedger = [
  ...Array.from({ length: 101 }, (_, index) => makeSuggestion(index)),
  makeSuggestion(102, {
    id: "other-suggestion",
    customerId: "other-customer",
    opportunityId: "other-opportunity",
    subjectId: "other-opportunity",
    title: "其他范围建议",
  }),
];

const initialNotifications = [{
  id: "shared-notification-v1",
  suggestionId: SHARED_ID,
  suggestionVersion: 1,
  channel: "weixin",
  status: "queued",
  title: "同一条跨入口建议",
  trigger: "missing_next_step",
  priority: 80,
  summary: "同一条跨入口建议",
  attemptCount: 0,
  availableAt: "2026-09-05T06:00:00.000Z",
  lastErrorCode: null,
  sentAt: null,
  readAt: null,
  createdAt: "2026-09-05T06:00:00.000Z",
  updatedAt: "2026-09-05T06:00:00.000Z",
}];

function Harness() {
  const ledgerRef = useRef(initialLedger);
  const notificationsRef = useRef(initialNotifications);
  const [view, setView] = useState("overview");
  const [sessionEpoch, setSessionEpoch] = useState(1);
  const [overviewAssistant, setOverviewAssistant] = useState(() => assistantSnapshot(ledgerRef.current.slice(0, 50)));
  const apiClient = useMemo(() => ({
    async getProactiveAssistant(filters = {}) {
      const call = Object.fromEntries(Object.entries(filters).filter(([key]) => key !== "signal"));
      window.__proactiveCalls.push(call);
      let rows = ledgerRef.current;
      if (filters.customerId) rows = rows.filter((item) => item.customerId === filters.customerId);
      if (filters.opportunityId) rows = rows.filter((item) => item.opportunityId === filters.opportunityId);
      const offset = filters.offset ?? 0;
      const limit = filters.limit ?? 50;
      const pageItems = rows.slice(offset, offset + limit);
      return {
        ...assistantSnapshot(pageItems),
        limit,
        offset,
        counts: { ...assistantSnapshot(rows).counts, total: rows.length },
        lifecycleCounts: assistantSnapshot(rows).lifecycleCounts,
        truncated: offset + pageItems.length < rows.length,
      };
    },
    async getProactiveNotifications(filters = {}) {
      const call = Object.fromEntries(Object.entries(filters).filter(([key]) => key !== "signal"));
      window.__proactiveNotificationCalls.push({ type: "list", ...call });
      const offset = filters.offset ?? 0;
      const limit = filters.limit ?? 50;
      return {
        items: notificationsRef.current.slice(offset, offset + limit),
        total: notificationsRef.current.length,
      };
    },
    async markProactiveNotificationRead(notificationId) {
      window.__proactiveNotificationCalls.push({ type: "read", notificationId });
      const updated = notificationsRef.current.find((item) => item.id === notificationId);
      if (!updated) throw new Error("notification not found");
      const read = {
        ...updated,
        status: "read",
        readAt: "2026-09-05T06:05:00.000Z",
        updatedAt: "2026-09-05T06:05:00.000Z",
      };
      notificationsRef.current = notificationsRef.current.map((item) => item.id === notificationId ? read : item);
      return read;
    },
  }), []);

  function updateShared(next) {
    ledgerRef.current = ledgerRef.current.map((item) => item.id === SHARED_ID ? { ...item, ...next } : item);
    setOverviewAssistant(assistantSnapshot(ledgerRef.current.slice(0, 50)));
    return ledgerRef.current.find((item) => item.id === SHARED_ID);
  }

  async function changeLifecycle({ item, status }) {
    return updateShared({
      version: item.version + 1,
      lifecycleVersion: item.version + 1,
      lifecycleStatus: status,
      proactiveStatus: status,
      status,
      updatedAt: `2026-09-05T06:0${item.version}:00.000Z`,
    });
  }

  async function refreshLedger() {
    const item = ledgerRef.current.find((candidate) => candidate.id === SHARED_ID);
    updateShared({
      version: item.version + 1,
      lifecycleVersion: item.version + 1,
      updatedAt: `2026-09-05T06:0${item.version}:30.000Z`,
    });
    return { refreshed: true };
  }

  function relogin() {
    setSessionEpoch((value) => value + 1);
    setView("opportunity");
    setOverviewAssistant(assistantSnapshot(ledgerRef.current.slice(0, 50)));
  }

  const common = {
    assistant: overviewAssistant,
    apiClient,
    backendStatus: "connected",
    onLifecycleChange: changeLifecycle,
    onUpdateSuggestion: async () => null,
    onRefresh: refreshLedger,
  };

  return (
    <ToastProvider>
      <nav aria-label="测试入口">
        <button data-testid="show-overview" type="button" onClick={() => setView("overview")}>总览</button>
        <button data-testid="show-customer" type="button" onClick={() => setView("customer")}>客户详情</button>
        <button data-testid="show-opportunity" type="button" onClick={() => setView("opportunity")}>商机详情</button>
        <button data-testid="show-chat" type="button" onClick={() => setView("chat")}>小小</button>
        <button data-testid="relogin" type="button" onClick={relogin}>重新登录</button>
      </nav>
      <main key={`${sessionEpoch}:${view}`} data-testid={`view-${view}`}>
        {view === "overview" ? <ProactiveAssistantPanel {...common} title="总览主动建议" /> : null}
        {view === "customer" ? (
          <ProactiveAssistantPanel {...common} scope={{ customerId: CUSTOMER_ID }} title="客户主动建议" />
        ) : null}
        {view === "opportunity" ? (
          <ProactiveAssistantPanel {...common} scope={{ opportunityId: OPPORTUNITY_ID }} title="商机主动建议" />
        ) : null}
        {view === "chat" ? (
          <AssistantChatPanel
            open
            messages={[]}
            pending={null}
            draft=""
            busy={false}
            apiClient={apiClient}
            online={false}
            sessionEpoch={sessionEpoch}
            appendTranscriptToDraft={() => {}}
            voiceFeedback=""
            draftFocusToken={0}
            onDraftChange={() => {}}
            onSend={() => {}}
            onClose={() => {}}
            onConfirm={() => {}}
            onCancelPending={() => {}}
            proactiveAssistant={overviewAssistant}
            onOpenProactiveOverview={() => setView("overview")}
            onOpenProactiveOpportunity={() => setView("opportunity")}
          />
        ) : null}
      </main>
      <output data-testid="session-epoch">{sessionEpoch}</output>
    </ToastProvider>
  );
}

window.__proactiveCalls = [];
window.__proactiveNotificationCalls = [];
createRoot(document.getElementById("root")).render(<Harness />);
