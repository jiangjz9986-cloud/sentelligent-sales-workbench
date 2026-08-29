import {
  countOpportunityReferences,
  findActiveOpportunityByExactName,
  findOpportunityByIdSuffix,
} from "../opportunities/opportunityStore.js";
import { KNOWN_STAGES, isKnownStage, normalizeStageText, stageDirection } from "../opportunities/stageVocabulary.js";
import { weixinCard, weixinClip, weixinShortId } from "./weixinCard.js";

/**
 * Pending-action preview providers for the five opportunity write tools
 * (v0.7.6). They run inside the orchestrator before a pending action exists:
 * they gate direct-chat/owner scope, disambiguate the target opportunity
 * (name/customer-name search, id-suffix reference, conversation context), pin
 * the optimistic-lock version into the stored arguments, and render the
 * weixinCard preview. The factory signature and return contract
 * ({ block, text, bodyStatus, status } | { arguments, previewText,
 * previewSummary }) mirror createCustomerPendingPreviewProviders (v0.7.2).
 */

const PREVIEW_SUMMARY_MAX = 2_000;
const ID_SUFFIX = /^[A-Za-z0-9-]{6,64}$/u;
const SAFE_IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u;
const FIELD_LABELS = Object.freeze({ amount: "金额", name: "名称", risk: "风险" });
const UPDATE_CHANGEABLE = new Set(["amount", "name", "risk"]);
const TARGET_HINT = "请说明商机名称或编号，例如「把日照的商机推进到方案交流」。";
const VERSION_MISSING = "商机资料版本无法确认，请稍后在系统网页中处理。";

function block(text, { bodyStatus = "clarify", status = 200 } = {}) {
  return { block: true, text, bodyStatus, status };
}

function previewSummaryOf(previewText) {
  return String(previewText).slice(0, PREVIEW_SUMMARY_MAX);
}

function displayValue(value, empty = "（空）") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || empty;
}

function opportunityCandidateCard(matches, title = "找到多个商机") {
  return weixinCard(title, matches.slice(0, 5).map((item, index) => [
    `${index + 1}`,
    `${item.name ?? "名称待确认"} ${weixinShortId(item.id)} ｜ ${item.stage ?? "阶段待确认"} ｜ ${item.amount ?? "金额待确认"}`,
  ]), "回复更完整名称或编号后 6 位重试。");
}

function customerCandidateCard(matches) {
  return weixinCard("找到多个客户", matches.slice(0, 5).map((item, index) => [
    `${index + 1}`,
    `${item.name ?? "名称待确认"}  ${item.region ?? ""}`.trim(),
  ]), "请用更完整客户名称重试。");
}

export function createOpportunityPendingPreviewProviders({
  opportunityAdapter,
  customerAdapter,
  db,
  resolveBusinessOwner,
} = {}) {
  if (!opportunityAdapter || typeof opportunityAdapter.analyze !== "function") {
    throw new TypeError("opportunity adapter is required");
  }
  if (!customerAdapter || typeof customerAdapter.analyze !== "function") {
    throw new TypeError("customer adapter is required");
  }
  if (!db || typeof db.prepare !== "function") throw new TypeError("db must be a synchronous SQLite connection");
  if (typeof resolveBusinessOwner !== "function") throw new TypeError("resolveBusinessOwner must be a function");

  function writeGate({ context, serverData }) {
    if (context.channel !== "web" && serverData?.auditMetadata?.chatType !== "direct") {
      return { blocked: block("商机档案修改仅支持与小小的私聊。") };
    }
    const owner = context.channel === "web"
      ? (typeof context.owner === "string" ? context.owner.trim() : "")
      : resolveBusinessOwner(context.owner);
    if (typeof owner !== "string" || !owner.trim()) {
      return { blocked: block("当前账号未绑定业务负责人，暂不能修改商机档案。") };
    }
    return { owner: owner.trim() };
  }

  /**
   * Resolve the write target to a unique, relationship-valid opportunity via
   * the adapter (id direct hit → id-suffix expansion → name/customer-name
   * search → conversation context), then require the pinned version.
   */
  async function resolveOpportunityPreview({ owner, context, argumentsValue, businessContext, taskType, changes = null }) {
    const rawId = typeof argumentsValue.opportunityId === "string" ? argumentsValue.opportunityId.trim() : "";
    const rawQuery = typeof argumentsValue.query === "string" ? argumentsValue.query.trim() : "";
    let target = rawQuery || rawId;
    if (!target) {
      const contextId = typeof businessContext?.opportunityId === "string" ? businessContext.opportunityId.trim() : "";
      target = contextId;
    }
    if (!target) return { blocked: block(TARGET_HINT) };
    if (target.length > 200) return { blocked: block(TARGET_HINT) };
    let opportunityId = SAFE_IDENTIFIER.test(target) && !target.startsWith("synthetic:") ? target : null;
    if (ID_SUFFIX.test(target)) {
      const { matches } = findOpportunityByIdSuffix(db, { owner, suffix: target });
      if (matches.length === 1) opportunityId = matches[0].id;
      else if (matches.length > 1) return { blocked: block(opportunityCandidateCard(matches, "编号命中多个商机")) };
    }
    const result = await opportunityAdapter.analyze({
      owner: context.owner,
      channel: context.channel,
      conversationId: context.conversation,
      eventId: context.event,
      taskType,
      opportunityId,
      query: target,
      changes,
    });
    if (result.status === "clarify") {
      return { blocked: block(opportunityCandidateCard(result.matches)) };
    }
    if (result.status === "review_required" && !result.opportunity) {
      return { blocked: block("商机与客户关系无法核验，请先在系统网页中确认后重试。") };
    }
    if ((result.status === "not_found" || !result.opportunity) && result.status !== "review_required") {
      return { blocked: block(`未找到商机：${target}。可发送「${target}有哪些商机」或「商机列表」先查看候选。`) };
    }
    if (!result.opportunity) {
      return { blocked: block(`未找到商机：${target}。可发送「商机列表」先查看候选。`) };
    }
    if (!result.opportunity.version) {
      return { blocked: block(VERSION_MISSING) };
    }
    return { result, opportunity: result.opportunity, target };
  }

  return Object.freeze({
    async "opportunity.update-stage"({ arguments: argumentsValue, context, businessContext, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const stage = normalizeStageText(argumentsValue.stage);
      if (!stage) {
        return block(`请说明目标阶段。已知阶段：${KNOWN_STAGES.join("、")}。`);
      }
      const resolution = await resolveOpportunityPreview({
        owner: gate.owner,
        context,
        argumentsValue,
        businessContext,
        taskType: "detail",
      });
      if (resolution.blocked) return resolution.blocked;
      const opportunity = resolution.opportunity;
      if ((opportunity.stage ?? "") === stage) {
        return block(`该商机已处于「${stage}」阶段，无需修改。`);
      }
      const direction = stageDirection(opportunity.stage, stage);
      const willReview = direction === "forward" && stage !== "暂停观察";
      const previewText = weixinCard("小小提醒！修改商机阶段", [
        ["名称", opportunity.name],
        ["客户", opportunity.customer ?? "待确认"],
        ["阶段", `${displayValue(opportunity.stage)} → ${stage}`],
        ...(isKnownStage(stage)
          ? []
          : [["注意", `「${stage}」不在看板已知阶段（${KNOWN_STAGES.join("/")}），确认后看板将新增该列，且不触发升级检查`]]),
        ...(willReview ? [["联动", "确认后将自动运行阶段升级检查（销售决策分析）"]] : []),
        ...(direction === "backward" ? [["说明", "回退不触发升级检查"]] : []),
      ]);
      return {
        arguments: {
          opportunityId: opportunity.id,
          expectedVersion: opportunity.version,
          stage,
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "opportunity.update-next"({ arguments: argumentsValue, context, businessContext, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const next = typeof argumentsValue.next === "string" ? argumentsValue.next.replace(/\s+/gu, " ").trim() : "";
      if (!next) return block("请说明新的下一步动作，例如「把日照商机的下一步改成 下周带售前调研」。");
      if (next.length > 500) return block("下一步动作太长了，请精简到 500 字以内。");
      const resolution = await resolveOpportunityPreview({
        owner: gate.owner,
        context,
        argumentsValue,
        businessContext,
        taskType: "detail",
      });
      if (resolution.blocked) return resolution.blocked;
      const opportunity = resolution.opportunity;
      if ((opportunity.next ?? "") === next) {
        return block("下一步动作与现有内容一致，无需修改。");
      }
      const previewText = weixinCard("小小提醒！修改商机下一步", [
        ["名称", opportunity.name],
        ["客户", opportunity.customer ?? "待确认"],
        ["下一步", `${weixinClip(opportunity.next, 80, "（空）")} → ${weixinClip(next, 80)}`],
      ]);
      return {
        arguments: {
          opportunityId: opportunity.id,
          expectedVersion: opportunity.version,
          next,
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "opportunity.update"({ arguments: argumentsValue, context, businessContext, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const rawChanges = argumentsValue.changes && typeof argumentsValue.changes === "object" && !Array.isArray(argumentsValue.changes)
        ? argumentsValue.changes
        : null;
      if (!rawChanges || Object.keys(rawChanges).length === 0) {
        return block("请说明要修改的字段，微信端可改：金额/名称/风险；阶段请用「推进到…」，下一步请用「下一步改成…」。");
      }
      // The stage/next fields have dedicated tools with their own confirmation
      // levels; this R2 tool only accepts amount/name/risk.
      const changes = {};
      const outOfScope = [];
      for (const [key, value] of Object.entries(rawChanges)) {
        if (UPDATE_CHANGEABLE.has(key)) changes[key] = value;
        else outOfScope.push(key);
      }
      if (Object.keys(changes).length === 0) {
        return block("这里只能改金额/名称/风险；阶段请用「推进到…」，下一步请用「下一步改成…」，其余字段请在系统网页修改。");
      }
      const resolution = await resolveOpportunityPreview({
        owner: gate.owner,
        context,
        argumentsValue,
        businessContext,
        taskType: "change_preview",
        changes,
      });
      if (resolution.blocked) return resolution.blocked;
      const { result, opportunity } = resolution;
      const preview = result.changePreview;
      if (!preview) return block("变更预览生成失败，请稍后重试。");
      const rejectedLabels = [...new Set([...preview.rejectedFields, ...outOfScope])]
        .map((key) => FIELD_LABELS[key] ?? key);
      if (preview.changedFields.length === 0) {
        if (rejectedLabels.length > 0) {
          return block(`暂不支持修改：${rejectedLabels.join("、")}。微信端可改：金额/名称/风险，其余请在系统网页修改。`);
        }
        return block("内容与现有档案一致，无需修改。");
      }
      const changesToApply = Object.fromEntries(preview.changedFields.map((key) => [key, preview.after[key]]));
      const previewText = weixinCard("小小提醒！修改商机", [
        ["名称", opportunity.name],
        ["客户", opportunity.customer ?? "待确认"],
        ...preview.changedFields.map((key) => [
          FIELD_LABELS[key] ?? key,
          `${displayValue(preview.before[key])} → ${displayValue(preview.after[key])}`,
        ]),
        ...(rejectedLabels.length > 0 ? [["未改", `${rejectedLabels.join("、")}（请在网页改）`]] : []),
      ]);
      return {
        arguments: {
          opportunityId: opportunity.id,
          expectedVersion: preview.expectedVersion,
          changes: changesToApply,
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "opportunity.create"({ arguments: argumentsValue, context, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const name = typeof argumentsValue.name === "string" ? argumentsValue.name.replace(/\s+/gu, " ").trim() : "";
      if (!name || name.length > 300) {
        return block("请说明商机名称（300 字以内），例如「新建商机 黄岛人民医院AI算力项目，客户 黄岛人民医院」。");
      }
      const customerQuery = typeof argumentsValue.customerQuery === "string" && argumentsValue.customerQuery.trim()
        ? argumentsValue.customerQuery.trim()
        : (typeof argumentsValue.customerId === "string" ? argumentsValue.customerId.trim() : "");
      if (!customerQuery) {
        return block("请注明客户，例如「新建商机 黄岛人民医院AI算力项目，客户 黄岛人民医院」。");
      }
      let customerResult;
      try {
        customerResult = await customerAdapter.analyze({
          owner: context.owner,
          channel: context.channel,
          conversationId: context.conversation,
          eventId: context.event,
          taskType: "detail",
          customerId: SAFE_IDENTIFIER.test(customerQuery) && !customerQuery.startsWith("synthetic:") ? customerQuery : null,
          query: customerQuery,
        });
      } catch {
        return block(`没听懂客户「${customerQuery}」，请用客户名称重试。`);
      }
      if (customerResult.status === "clarify") {
        return block(customerCandidateCard(customerResult.matches));
      }
      if (customerResult.status === "not_found" || !customerResult.customer) {
        return block(`未找到客户：${customerQuery}。请先发送「新建客户 ${customerQuery}，区域…」建档后再建商机。`);
      }
      const customer = customerResult.customer;
      const duplicate = findActiveOpportunityByExactName(db, { customerId: customer.id, name });
      if (duplicate) {
        return block(`「${customer.name}」下已存在同名商机 ${weixinShortId(duplicate.id)}。如需更新请发送「把${name}的金额改成…」，或换个名称新建。`);
      }
      const stage = normalizeStageText(argumentsValue.stage ?? "") || null;
      const amount = typeof argumentsValue.amount === "string" && argumentsValue.amount.trim()
        ? argumentsValue.amount.replace(/\s+/gu, " ").trim().slice(0, 100)
        : null;
      const next = typeof argumentsValue.next === "string" && argumentsValue.next.trim()
        ? argumentsValue.next.replace(/\s+/gu, " ").trim().slice(0, 500)
        : null;
      const previewText = weixinCard("小小提醒！新建商机", [
        ["名称", name],
        ["客户", `${customer.name}（已核验）`],
        ["阶段", stage || "待补充"],
        ["金额", amount || "待补充"],
        ["下一步", next || "待补充"],
        ...(stage && !isKnownStage(stage)
          ? [["注意", `「${stage}」不在看板已知阶段，确认后看板将新增该列`]]
          : []),
      ]);
      return {
        arguments: {
          name,
          customerId: customer.id,
          ...(stage ? { stage } : {}),
          ...(amount ? { amount } : {}),
          ...(next ? { next } : {}),
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "opportunity.delete"({ arguments: argumentsValue, context, businessContext, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const resolution = await resolveOpportunityPreview({
        owner: gate.owner,
        context,
        argumentsValue,
        businessContext,
        taskType: "delete_preview",
      });
      if (resolution.blocked) return resolution.blocked;
      const opportunity = resolution.opportunity;
      const references = countOpportunityReferences(db, opportunity.id);
      const previewText = weixinCard("小小提醒！删除商机", [
        ["名称", opportunity.name],
        ["编号", weixinShortId(opportunity.id)],
        ["客户", opportunity.customer ?? "待确认"],
        ["阶段", opportunity.stage ?? "待确认"],
        ["金额", opportunity.amount ?? "待确认"],
        ["关联引用", `行动 ${references.actions} 条、风险 ${references.risks} 条、快速记录 ${references.quickRecords} 条、方案草稿 ${references.solutionDrafts} 条`],
        ["说明", "关联引用将失去商机挂接展示（数据保留）；软删除可由管理员恢复"],
      ], "请确认这不是误操作。");
      return {
        arguments: {
          opportunityId: opportunity.id,
          expectedVersion: opportunity.version,
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },
  });
}
