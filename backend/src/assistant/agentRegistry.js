import { validateAgentId, validateToolName } from "./contracts.js";
import { getToolPolicy } from "./policy.js";

const agent = (id, description, instructions, enabled = true) => Object.freeze({
  id,
  description,
  instructions,
  enabled,
});

export const AGENT_DEFINITIONS = Object.freeze([
  agent("system-router", "确定性意图路由与安全门禁", "只负责识别意图、澄清歧义、处理帮助取消确认；不得直接写业务或绕过工具策略。"),
  agent("dashboard", "系统总览与待办", "汇总当前账号可见的业务总览、今日待办和风险摘要；只返回白名单字段，不执行写入。"),
  agent("visit-capture", "拜访记录采集与确认", "收集拜访电话会议内容，先生成可修改预览；只有本人明确确认后才能创建快速记录。"),
  agent("customer", "客户查询与维护", "查询客户详情和画像；新增修改删除必须生成变更摘要并经过本人确认。"),
  agent("opportunity", "商机信息与阶段", "查询商机阶段金额和下一步；阶段金额及删除属于敏感变更，必须确认并校验版本。"),
  agent("sales-decision", "销售决策分析", "基于系统证据生成销售诊断并区分事实推断未知；任何业务写回必须另行确认。"),
  agent("action-risk", "行动与风险提示", "查询行动和风险并给出处理建议；状态变更或删除必须先展示变更并确认。"),
  agent("itinerary", "行程规划", "查询和预览路线规划；保存修改删除行程必须确认，不能自行调用地图之外的地址。"),
  agent("travel-expense", "出差费用账本", "按自然周查询和整理费用、多笔实付；金额以本人录入为准，财务写入必须确认。"),
  agent("payment-proof", "实付凭证", "将微信原始图片或 PDF 无损送入待处理区并给出候选；正式关联、拒绝或删除必须确认。"),
  agent("invoice", "发票管理", "将原始发票无损送入仓库并给出识别候选；匹配替代无票确认和删除必须确认。"),
  agent("advance-settlement", "请款与多退少补", "读取 owner-scoped 请款、到账、费用、资金来源和票据证据，生成可追溯的结算方向预览；不得创建退款/补款流水或修改任何财务事实。"),
  agent("reimbursement-report", "报销周汇总与打印", "按自然周预览实付、缺票和打印准备数据；不得自行修改费用或公司规则。"),
  agent("sales-report", "销售周报", "生成销售业务周报预览并保留证据引用；保存发布或删除必须由本人确认。"),
  agent("knowledge", "知识检索", "只读检索知识并标明来源；新增修改删除知识条目必须确认。"),
  agent("solution", "方案草稿", "预留方案和会前大纲能力；功能开关关闭时只说明尚未启用，不得执行工具。", false),
  agent("personal-finance", "个人财务助手（预留）", "预留个人总账和自然周分析能力；数据模块完成前只说明尚未启用，不得创建记录。", false),
]);

const tool = (name, agentId, description, argumentsSchema) => Object.freeze({
  name, agentId, description, arguments: Object.freeze(argumentsSchema), policy: getToolPolicy(name),
});

export const TOOL_DEFINITIONS = Object.freeze([
  tool("dashboard.summary", "dashboard", "查询当前账号的业务战情总览", {}),
  tool("customer.search", "customer", "按关键词查询客户", { query: { type: "string", required: true } }),
  tool("customer.detail", "customer", "查询一个客户的限界详情", { customerId: { type: "string", required: true } }),
  tool("opportunity.detail", "opportunity", "查询一个商机的限界详情", { opportunityId: { type: "string", required: true } }),
  tool("sales-decision.preview", "sales-decision", "基于限界业务快照预览项目分析", { opportunityId: { type: "string", required: true } }),
  tool("action-risk.summary", "action-risk", "查询未完成动作和活跃风险摘要", {
    customerId: { type: "string", required: false },
    opportunityId: { type: "string", required: false },
  }),
  tool("itinerary.summary", "itinerary", "查询当前账号的行程摘要", {}),
  tool("travel-expense.summary", "travel-expense", "查询自然周差旅和报销金额摘要", {
    week: { type: "string", required: false },
    periodStart: { type: "string", required: false },
  }),
  tool("knowledge.search", "knowledge", "按关键词只读检索知识摘要", { query: { type: "string", required: true } }),
  tool("visit-capture.collect", "visit-capture", "创建拜访记录草稿", { text: { type: "string", required: true } }),
  tool("visit-capture.preview", "visit-capture", "预览拜访记录草稿", { draftId: { type: "string", required: true } }),
  tool("visit-capture.confirm", "visit-capture", "确认写入拜访记录", { draftId: { type: "string", required: true } }),
  tool("payment-proof.ingest", "payment-proof", "接收并识别实付凭证", { expenseId: { type: "string", required: false }, mediaRef: { type: "string", required: true } }),
  tool("invoice.ingest", "invoice", "接收并识别发票", { expenseId: { type: "string", required: false }, mediaRef: { type: "string", required: true } }),
  tool("reimbursement-report.preview", "reimbursement-report", "预览报销周汇总", { week: { type: "string", required: false }, periodStart: { type: "string", required: false }, periodEnd: { type: "string", required: false } }),
  tool("sales-report.preview", "sales-report", "预览销售业务周报", { week: { type: "string", required: false }, periodStart: { type: "string", required: false }, periodEnd: { type: "string", required: false } }),
  tool("advance-settlement.preview", "advance-settlement", "预览请款结算方向和多退少补金额", { week: { type: "string", required: false }, advanceId: { type: "string", required: false } }),
]);

export function createAgentRegistry({ agents = AGENT_DEFINITIONS, tools = TOOL_DEFINITIONS } = {}) {
  const agentMap = new Map(agents.map((entry) => [validateAgentId(entry.id), Object.freeze({ ...entry })]));
  const toolMap = new Map(tools.map((entry) => [validateToolName(entry.name), Object.freeze({ ...entry, policy: getToolPolicy(entry.name) })]));
  return Object.freeze({
    listAgents: () => [...agentMap.values()],
    getAgent: (id) => agentMap.get(id) ?? null,
    listTools: () => [...toolMap.values()],
    getTool: (name) => toolMap.get(name) ?? null,
  });
}
