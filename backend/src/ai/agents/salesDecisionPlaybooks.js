const PLAYBOOKS = {
  general: {
    id: "general",
    label: "复杂型 B2B 销售",
    focus: ["客户结果", "决策链", "预算与采购路径", "对等承诺"],
  },
  medical: {
    id: "medical",
    label: "医疗信息化",
    focus: ["临床连续性", "数据安全与合规", "院内决策链", "验收与运维责任"],
  },
  government: {
    id: "government",
    label: "政企与招采",
    focus: ["立项与预算归口", "采购方式", "评审标准", "合规红线"],
  },
  cloud: {
    id: "cloud",
    label: "云与平台",
    focus: ["控制权与迁移", "成本基线", "服务等级", "数据出口"],
  },
  datacenter: {
    id: "datacenter",
    label: "数据中心",
    focus: ["容量与可用性", "灾备目标", "架构评估", "交付与验收"],
  },
  xinchuang: {
    id: "xinchuang",
    label: "信创与基础设施",
    focus: ["兼容适配", "目录与认证", "迁移风险", "技术与采购标准"],
  },
};

export const SALES_DECISION_PLAYBOOKS = Object.freeze(
  Object.fromEntries(Object.entries(PLAYBOOKS).map(([key, value]) => [key, Object.freeze({ ...value, focus: Object.freeze([...value.focus]) })])),
);

const INDUSTRY_ALIASES = new Map([
  ["医疗", "medical"],
  ["医院", "medical"],
  ["政企", "government"],
  ["政府", "government"],
  ["招采", "government"],
  ["云", "cloud"],
  ["数据中心", "datacenter"],
  ["信创", "xinchuang"],
  ["基础设施", "xinchuang"],
]);

export function resolveSalesDecisionPlaybook(industry, context = {}) {
  const normalized = String(industry ?? "").trim().toLowerCase();
  if (SALES_DECISION_PLAYBOOKS[normalized]) return SALES_DECISION_PLAYBOOKS[normalized];
  const haystack = [
    industry,
    context.customer?.type,
    context.customer?.summary,
    context.opportunity?.name,
    ...(context.opportunity?.requirements ?? []),
    context.rawContent,
  ].filter(Boolean).join(" ");
  for (const [keyword, key] of INDUSTRY_ALIASES) {
    if (haystack.includes(keyword)) return SALES_DECISION_PLAYBOOKS[key];
  }
  return SALES_DECISION_PLAYBOOKS.general;
}
