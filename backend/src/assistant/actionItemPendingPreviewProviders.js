import { reminderDisplayOf } from "../actionReminders/reminderScheduler.js";
import { parseSpokenInstant } from "./spokenTime.js";
import { weixinCard, weixinClip, weixinShortId } from "./weixinCard.js";

// Pending-action preview providers for the todo tools (v0.7.5). They run
// inside the orchestrator before a pending action exists: create pins the
// parsed schedule and optional customer attachment, complete/defer/delete
// resolve the target item and pin the optimistic-lock version. The factory
// signature and return contract ({ block, text, bodyStatus, status } |
// { arguments, previewText, previewSummary }) mirror
// createCustomerPendingPreviewProviders (v0.7.2).

const PREVIEW_SUMMARY_MAX = 2_000;
const ID_SUFFIX = /^[A-Za-z0-9-]{6,64}$/u;
const NIGHT_START_HOUR = 20;
const NIGHT_END_HOUR = 9;

function block(text, { bodyStatus = "clarify", status = 200 } = {}) {
  return { block: true, text, bodyStatus, status };
}

function previewSummaryOf(previewText) {
  return String(previewText).slice(0, PREVIEW_SUMMARY_MAX);
}

function shanghaiHourOf(iso) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const hour = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed).find((part) => part.type === "hour")?.value;
  return hour === undefined ? null : Number(hour);
}

function candidateCard(matches) {
  return weixinCard("找到多个待办", matches.slice(0, 5).map((item, index) => [
    `${index + 1}`,
    `${weixinClip(item.title, 24)}  ${weixinShortId(item.id)}`,
  ]), "请用编号后 6 位重试，例如「完成待办 a1b2c3」。");
}

export function createActionItemPendingPreviewProviders({
  store,
  customerAdapter,
  resolveBusinessOwner,
  clock = () => new Date(),
} = {}) {
  if (!store || typeof store.findByIdSuffix !== "function") {
    throw new TypeError("an action item store is required");
  }
  if (!customerAdapter || typeof customerAdapter.analyze !== "function") {
    throw new TypeError("customer adapter is required");
  }
  if (typeof resolveBusinessOwner !== "function") throw new TypeError("resolveBusinessOwner must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  function writeGate({ context, serverData }) {
    if (serverData?.auditMetadata?.chatType !== "direct") {
      return { blocked: block("待办功能仅支持与小小的私聊。") };
    }
    const owner = resolveBusinessOwner(context.owner);
    if (typeof owner !== "string" || !owner.trim()) {
      return { blocked: block("当前账号未绑定业务负责人，暂不能使用待办功能。") };
    }
    return { owner: owner.trim() };
  }

  function resolveTarget({ owner, query }) {
    const normalized = String(query ?? "").trim();
    if (!normalized) return { blocked: block("请带上待办编号或标题，例如「完成待办 a1b2c3」。") };
    if (ID_SUFFIX.test(normalized)) {
      const { matches } = store.findByIdSuffix({ owner, suffix: normalized });
      if (matches.length === 1) return { item: matches[0] };
      if (matches.length > 1) return { blocked: block(candidateCard(matches).replace("【找到多个待办】", "【编号命中多条】")) };
    }
    const { matches } = store.findByTitleQuery({ owner, query: normalized });
    if (matches.length === 0) {
      return { blocked: block(`没有找到与“${normalized}”匹配的待办。发送“我的待办”可查看清单。`) };
    }
    if (matches.length > 1) return { blocked: block(candidateCard(matches)) };
    return { item: matches[0] };
  }

  async function attachCustomer({ context, customerQuery }) {
    if (!customerQuery) return null;
    try {
      const result = await customerAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "detail",
        query: customerQuery,
      });
      // Attachment is a bonus, never a blocker: ambiguous or missing
      // candidates simply leave the todo unattached (design §3.7).
      if (result.status === "ok" && result.customer) {
        return { customerId: result.customer.id, customerName: result.customer.name ?? null };
      }
    } catch {
      return null;
    }
    return null;
  }

  return Object.freeze({
    async "action-risk.create"({ arguments: argumentsValue, context, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const title = typeof argumentsValue.title === "string" ? argumentsValue.title.trim().slice(0, 80) : "";
      if (!title) return block("请补充待办内容，例如「提醒我周五前给王工送方案」。");
      const remindAt = typeof argumentsValue.remindAt === "string" && Number.isFinite(Date.parse(argumentsValue.remindAt))
        ? new Date(argumentsValue.remindAt).toISOString()
        : null;
      const due = typeof argumentsValue.due === "string" && argumentsValue.due.trim()
        ? argumentsValue.due.trim().slice(0, 50)
        : null;
      const priority = argumentsValue.priority === "高" ? "高" : "中";
      const attached = await attachCustomer({ context, customerQuery: argumentsValue.customerQuery });
      const hour = remindAt ? shanghaiHourOf(remindAt) : null;
      const nightHint = hour !== null && (hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR);
      const previewText = weixinCard("小小提醒！新建待办", [
        ["内容", title],
        ["提醒", remindAt ? reminderDisplayOf(remindAt) : "未设置（未识别到明确时间，创建后可在系统补充）"],
        ...(due ? [["原话", due]] : []),
        ["优先级", priority],
        ["客户", attached?.customerName ?? "未挂接"],
        ...(nightHint ? [["注意", "提醒时间在夜间/清晨，如无必要建议调整"]] : []),
      ]);
      return {
        arguments: {
          title,
          ...(remindAt ? { remindAt } : {}),
          ...(due ? { due } : {}),
          priority,
          ...(attached ? { customerId: attached.customerId, customerName: attached.customerName ?? undefined } : {}),
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "action-risk.complete"({ arguments: argumentsValue, context, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const target = resolveTarget({ owner: gate.owner, query: argumentsValue.query ?? argumentsValue.actionItemId });
      if (target.blocked) return target.blocked;
      const item = target.item;
      if (item.status === "done") return block("该待办已是完成状态。");
      if (!item.owner) return block("这条待办由系统写回创建且未归属微信账号，请在系统网页中处理。");
      const previewText = weixinCard("小小提醒！完成待办", [
        ["编号", weixinShortId(item.id)],
        ["内容", weixinClip(item.title, 60)],
        ["提醒", item.remindAt ? reminderDisplayOf(item.remindAt) : "未设置"],
        ["说明", "完成后不再提醒，周报推进项自动纳入"],
      ]);
      return {
        arguments: { actionItemId: item.id, expectedVersion: item.version },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "action-risk.defer"({ arguments: argumentsValue, context, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const target = resolveTarget({ owner: gate.owner, query: argumentsValue.query ?? argumentsValue.actionItemId });
      if (target.blocked) return target.blocked;
      const item = target.item;
      if (!item.owner) return block("这条待办由系统写回创建且未归属微信账号，请在系统网页中处理。");
      const newTime = typeof argumentsValue.newTime === "string" ? argumentsValue.newTime.trim() : "";
      const instant = parseSpokenInstant(newTime, clock());
      if (!instant.matched) {
        return block(`没听懂新的提醒时间「${newTime || "（空）"}」。请用“明天上午十点”“周五前”或 2026-09-01 这样的说法。`);
      }
      const previewText = weixinCard("小小提醒！推迟待办", [
        ["编号", weixinShortId(item.id)],
        ["内容", weixinClip(item.title, 60)],
        ["提醒", `${item.remindAt ? reminderDisplayOf(item.remindAt) : "未设置"} → ${instant.displayText}`],
      ]);
      return {
        arguments: {
          actionItemId: item.id,
          expectedVersion: item.version,
          remindAt: instant.iso,
          due: newTime.slice(0, 50),
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "action-risk.delete"({ arguments: argumentsValue, context, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const target = resolveTarget({ owner: gate.owner, query: argumentsValue.query ?? argumentsValue.actionItemId });
      if (target.blocked) return target.blocked;
      const item = target.item;
      if (!item.owner) return block("这条待办由系统写回创建且未归属微信账号，请在系统网页中处理。");
      const statusLabels = { pending: "待办", in_progress: "进行中", done: "已完成", deferred: "已推迟" };
      const previewText = weixinCard("小小提醒！删除待办", [
        ["编号", weixinShortId(item.id)],
        ["内容", weixinClip(item.title, 60)],
        ["状态", statusLabels[item.status] ?? item.status],
        ["提醒", item.remindAt ? reminderDisplayOf(item.remindAt) : "未设置"],
        ["说明", "软删除，可由管理员恢复"],
      ]);
      return {
        arguments: { actionItemId: item.id, expectedVersion: item.version },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },
  });
}
