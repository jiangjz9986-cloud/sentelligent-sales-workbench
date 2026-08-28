import { resolveSpokenDate, spokenDateToIso } from "./spokenDate.js";

// Pending-action preview providers for the quick-record tools (v0.7.3). They
// run inside the orchestrator immediately before a pending action exists:
// capture renders the AI summary card for the affirm-language confirmation,
// update/void resolve the target record, pin the optimistic-lock version and
// normalized changes, and render the six-digit-code preview card. The factory
// signature and return contract ({ block, text, bodyStatus, status } |
// { arguments, previewText, previewSummary }) mirror
// createCustomerPendingPreviewProviders (v0.7.2).

const PREVIEW_SUMMARY_MAX = 2_000;
const RAW_EXCERPT_MAX = 60;
const SUMMARY_TEXT_MAX = 160;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const SUMMARY_FIELD_LABELS = Object.freeze({
  request: "诉求",
  feedback: "反馈",
  risk: "风险",
  action: "建议动作",
});
const RECORD_STATUS_LABELS = Object.freeze({
  recorded: "待分析",
  analyzed: "已分析",
  confirmed: "已确认",
});

function block(text, { bodyStatus = "clarify", status = 200 } = {}) {
  return { block: true, text, bodyStatus, status };
}

function previewSummaryOf(previewText) {
  return String(previewText).slice(0, PREVIEW_SUMMARY_MAX);
}

function excerpt(value, max = RAW_EXCERPT_MAX) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function idSuffix(id) {
  const text = String(id ?? "");
  return text.length > 6 ? `…${text.slice(-6)}` : text;
}

function shanghaiDateOf(isoValue) {
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${valueOf("year")}-${valueOf("month")}-${valueOf("day")}`;
}

function summaryText(insight, key, fallback = "待补充") {
  const text = insight?.summary?.[key]?.text;
  const normalized = typeof text === "string" ? text.trim() : "";
  return normalized ? (normalized.length > SUMMARY_TEXT_MAX ? `${normalized.slice(0, SUMMARY_TEXT_MAX)}…` : normalized) : fallback;
}

function recordHeadline(record) {
  const date = record.occurredAt ? shanghaiDateOf(record.occurredAt) : shanghaiDateOf(record.createdAt);
  const customer = record.customerName ?? "（未挂客户）";
  return `${idSuffix(record.id)}(${date ?? "日期待确认"}，${customer}，当前 v${record.version})`;
}

export function createQuickRecordPendingPreviewProviders({
  visitCaptureAdapter,
  customerAdapter,
  snapshotAdapter,
  store,
  resolveBusinessOwner,
  clock = () => new Date(),
} = {}) {
  if (!visitCaptureAdapter || typeof visitCaptureAdapter.analyze !== "function") {
    throw new TypeError("visit-capture adapter is required");
  }
  if (!customerAdapter || typeof customerAdapter.analyze !== "function") {
    throw new TypeError("customer adapter is required");
  }
  if (!snapshotAdapter || typeof snapshotAdapter.opportunitySearch !== "function") {
    throw new TypeError("owner-scoped business snapshot adapter is required");
  }
  if (!store || typeof store.search !== "function") throw new TypeError("quick-record store is required");
  if (typeof resolveBusinessOwner !== "function") throw new TypeError("resolveBusinessOwner must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  function writeGate({ context, serverData }) {
    if (serverData?.auditMetadata?.chatType !== "direct") {
      return { blocked: block("拜访记录的写入与修改仅支持与小小的私聊。") };
    }
    const owner = resolveBusinessOwner(context.owner);
    if (typeof owner !== "string" || !owner.trim()) {
      return { blocked: block("当前账号未绑定业务负责人，暂不能记录或修改拜访记录。") };
    }
    return { owner: owner.trim() };
  }

  function resolveTargetRecord({ owner, quickRecordId }) {
    if (quickRecordId) {
      const { items } = store.findByIdSuffix({ owner, suffix: quickRecordId });
      if (items.length === 0) {
        return { blocked: block(`没有找到编号以 ${quickRecordId} 结尾的记录。可发送“最近的记录”查看可用记录。`) };
      }
      if (items.length > 1) {
        return {
          blocked: block([
            `编号 ${quickRecordId} 命中了 ${items.length} 条记录，请用更长的编号重试：`,
            ...items.slice(0, 5).map((item) => `- ${recordHeadline(item)} ${excerpt(item.rawContent, 30)}`),
          ].join("\n")),
        };
      }
      return { record: items[0] };
    }
    const latest = store.latestEditable({ owner, withinDays: 3 });
    if (!latest) {
      return { blocked: block("最近三天没有可修改的记录，请发送“最近的记录”查看并使用记录编号。") };
    }
    return { record: latest };
  }

  async function resolveCustomerChange({ context, value, record }) {
    const result = await customerAdapter.analyze({
      owner: context.owner,
      channel: context.channel,
      conversationId: context.conversation,
      eventId: context.event,
      taskType: "detail",
      query: value,
    });
    if (result.status === "clarify") {
      return {
        blocked: block([
          `找到 ${result.matches.length} 个客户，请确认：`,
          ...result.matches.slice(0, 5).map((item) => `- ${item.name ?? "名称待确认"} [${item.id}] / ${item.region ?? "-"}`),
          "请用更完整名称重试。",
        ].join("\n")),
      };
    }
    if (result.status === "not_found" || !result.customer) {
      return { blocked: block(`未找到客户：${value}。请先在系统或“新建客户 …”中建档后再挂接。`) };
    }
    if (record.opportunityId) {
      const opportunity = snapshotAdapter.opportunityDetail({ owner: context.owner, opportunityId: record.opportunityId });
      if (opportunity && opportunity.customerId !== result.customer.id) {
        return {
          blocked: block("该记录已挂接商机，且商机不属于新客户。请先修改记录的商机，或作废后重记。"),
        };
      }
    }
    return { customer: result.customer };
  }

  function resolveOpportunityChange({ context, value, record }) {
    const { items } = snapshotAdapter.opportunitySearch({ owner: context.owner, query: value });
    if (items.length === 0) {
      return { blocked: block(`未找到商机：${value}。请先在系统中创建商机后再挂接。`) };
    }
    if (items.length > 1) {
      return {
        blocked: block([
          `找到 ${items.length} 个商机，请确认：`,
          ...items.slice(0, 5).map((item) => `- ${item.name ?? "名称待确认"} [${item.id}]`),
          "请用更完整名称重试。",
        ].join("\n")),
      };
    }
    const opportunity = items[0];
    if (record.customerId && opportunity.customerId && opportunity.customerId !== record.customerId) {
      return { blocked: block("该商机不属于记录当前挂接的客户。请先修改记录的客户，或作废后重记。") };
    }
    return { opportunity };
  }

  function resolveOccurredAtChange(value, now) {
    const normalized = String(value ?? "").trim();
    if (ISO_DATE_TIME.test(normalized) && Number.isFinite(Date.parse(normalized))) {
      return { occurredAt: new Date(normalized).toISOString(), display: shanghaiDateOf(normalized) };
    }
    if (DATE_ONLY.test(normalized)) {
      const iso = spokenDateToIso(normalized);
      if (iso) return { occurredAt: iso, display: normalized };
    }
    const spoken = resolveSpokenDate(normalized, now);
    if (spoken) return { occurredAt: spokenDateToIso(spoken), display: `${normalized}（${spoken}）` };
    return { blocked: block(`无法识别时间「${normalized}」。请用“昨天”“上周三”“8月20日”或 2026-08-20 这样的说法。`) };
  }

  return Object.freeze({
    async "visit-capture.capture"({ arguments: argumentsValue, context, businessContext, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const rawContent = typeof argumentsValue.rawContent === "string" ? argumentsValue.rawContent.trim() : "";
      if (!rawContent) return block("请把拜访、电话或会议内容跟在“记一下：”后面一起发我。");
      const occurredAt = typeof argumentsValue.occurredAt === "string"
        && ISO_DATE_TIME.test(argumentsValue.occurredAt)
        && Number.isFinite(Date.parse(argumentsValue.occurredAt))
        ? new Date(argumentsValue.occurredAt).toISOString()
        : null;
      // The model call (<=30s, deterministic fallback inside the adapter) runs
      // here so the affirm card shows exactly what will be written. Any
      // adapter-level failure degrades to a no-analysis card instead of
      // blocking the capture (design 2.5/6.1-4).
      let analysis = null;
      try {
        analysis = await visitCaptureAdapter.analyze({
          owner: context.owner,
          channel: context.channel,
          conversationId: context.conversation,
          eventId: context.event,
          taskType: "preview",
          rawContent,
          occurredAt,
          sourceChannel: "微信助手",
          draftId: null,
          businessContext,
        });
      } catch {
        analysis = null;
      }
      const degraded = !analysis || analysis.status === "fallback";
      const customerCandidate = analysis?.customerCandidate;
      const opportunityCandidate = analysis?.opportunityCandidate;
      const customerLine = customerCandidate?.id
        ? `${customerCandidate.name} [服务端候选，待本人确认]`
        : "待匹配（写入后可在系统里挂接）";
      const opportunityLine = opportunityCandidate?.id
        ? `${opportunityCandidate.name} [服务端候选]`
        : "待确认";
      const candidateChecks = [
        customerCandidate?.status === "ambiguous" ? "客户候选不唯一" : null,
        opportunityCandidate?.status === "ambiguous" ? "商机候选不唯一" : null,
        opportunityCandidate?.status === "conflict" ? "客户与商机关系不一致，已忽略商机候选" : null,
      ].filter(Boolean).join("；");
      const previewText = [
        "【拜访记录待确认】",
        ...(degraded ? ["（AI 分析暂时不可用，以下为按原文整理的基础要点；写入后可在系统里重新分析。）"] : []),
        `时间：${occurredAt ? shanghaiDateOf(occurredAt) : "现在（发送时刻）"}`,
        `客户：${customerLine}`,
        `商机：${opportunityLine}`,
        `诉求：${summaryText(analysis, "request", excerpt(rawContent, SUMMARY_TEXT_MAX))}`,
        `风险：${summaryText(analysis, "risk", "待确认")}`,
        `建议动作：${summaryText(analysis, "action", "待确认")}`,
        ...(candidateChecks ? [`候选校验：${candidateChecks}`] : []),
        "写入后本条将自动进入本周周报素材；客户/商机档案不会被自动修改。",
      ].join("\n");
      return {
        arguments: { rawContent, ...(occurredAt ? { occurredAt } : {}) },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "visit-capture.update"({ arguments: argumentsValue, context, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const field = typeof argumentsValue.field === "string" ? argumentsValue.field : "";
      const value = typeof argumentsValue.value === "string" ? argumentsValue.value.trim() : "";
      if (!field || !value) return block("请说明要修改的字段与内容，例如“把那条记录的下一步改成 周三前发材料”。");
      const target = resolveTargetRecord({
        owner: gate.owner,
        quickRecordId: typeof argumentsValue.quickRecordId === "string" ? argumentsValue.quickRecordId.trim() : null,
      });
      if (target.blocked) return target.blocked;
      const loaded = store.getWithLatestInsight({ owner: gate.owner, id: target.record.id });
      if (!loaded) return block("记录不存在或已作废，无法修改。");
      const { record, insight } = loaded;

      const lines = [
        `【拜访记录修改待确认】${recordHeadline(record)}`,
        `原文：${excerpt(record.rawContent)}`,
      ];
      let changes = null;
      if (field === "occurredAt") {
        const resolved = resolveOccurredAtChange(value, clock());
        if (resolved.blocked) return resolved.blocked;
        const beforeDisplay = record.occurredAt ? shanghaiDateOf(record.occurredAt) : "（未记录）";
        if (record.occurredAt && new Date(record.occurredAt).toISOString() === resolved.occurredAt) {
          return block("内容与现有记录一致，无需修改。");
        }
        changes = { fields: { occurredAt: resolved.occurredAt } };
        lines.push(`发生时间：${beforeDisplay}`, `        → ${resolved.display}`);
      } else if (field === "customerQuery") {
        const resolved = await resolveCustomerChange({ context, value, record });
        if (resolved.blocked) return resolved.blocked;
        if (record.customerId === resolved.customer.id) return block("内容与现有记录一致，无需修改。");
        changes = { fields: { customerId: resolved.customer.id } };
        lines.push(`客户：${record.customerName ?? "（未挂客户）"}`, `    → ${resolved.customer.name} [${resolved.customer.id}]`);
      } else if (field === "opportunityQuery") {
        const resolved = resolveOpportunityChange({ context, value, record });
        if (resolved.blocked) return resolved.blocked;
        if (record.opportunityId === resolved.opportunity.id) return block("内容与现有记录一致，无需修改。");
        const fields = { opportunityId: resolved.opportunity.id };
        // A record without a customer inherits the opportunity's verified
        // customer, mirroring resolveQuickRecordLinks in the capture path.
        if (!record.customerId && resolved.opportunity.customerId) {
          fields.customerId = resolved.opportunity.customerId;
        }
        changes = { fields };
        lines.push(`商机：${record.opportunityId ? idSuffix(record.opportunityId) : "（未挂商机）"}`, `    → ${resolved.opportunity.name} [${resolved.opportunity.id}]`);
      } else if (field.startsWith("summary.")) {
        const key = field.slice("summary.".length);
        if (!Object.hasOwn(SUMMARY_FIELD_LABELS, key)) return block("暂不支持修改该字段。可改：发生时间/客户/商机/诉求/反馈/风险/建议动作。");
        if (!insight) return block("该记录尚无 AI 分析，无法修改分析文本。可先在系统里重新分析。");
        const before = typeof insight.summary?.[key]?.text === "string" ? insight.summary[key].text.trim() : "";
        if (before === value) return block("内容与现有分析一致，无需修改。");
        changes = { summaryPatch: { [key]: value } };
        lines.push(`${SUMMARY_FIELD_LABELS[key]}：${excerpt(before || "（空）", SUMMARY_TEXT_MAX)}`, `        → ${value}`);
      } else {
        return block("暂不支持修改该字段。可改：发生时间/客户/商机/诉求/反馈/风险/建议动作。");
      }
      lines.push("（原始拜访原文不可修改；如记录本身有误请作废后重记。）");
      const previewText = lines.join("\n");
      return {
        arguments: {
          quickRecordId: record.id,
          expectedVersion: record.version,
          changes,
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "visit-capture.void"({ arguments: argumentsValue, context, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const target = resolveTargetRecord({
        owner: gate.owner,
        quickRecordId: typeof argumentsValue.quickRecordId === "string" ? argumentsValue.quickRecordId.trim() : null,
      });
      if (target.blocked) return target.blocked;
      const record = target.record;
      const statusLabel = RECORD_STATUS_LABELS[record.status] ?? record.status;
      const previewText = [
        `【拜访记录作废待确认】${recordHeadline(record)}`,
        `原文：${excerpt(record.rawContent)}`,
        `状态：${statusLabel}${record.status === "confirmed" ? "（已确认写回的客户/商机内容不会回退）" : ""}`,
        "该记录将不再出现在记录列表、周报素材与项目分析中；已确认写回客户/商机的内容不会回退。作废后可由管理员在数据库层恢复。",
      ].join("\n");
      return {
        arguments: {
          quickRecordId: record.id,
          expectedVersion: record.version,
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },
  });
}
