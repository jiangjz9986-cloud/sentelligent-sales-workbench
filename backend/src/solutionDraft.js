function lines(items, fallback) {
  if (!items?.length) return fallback;
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export const SOLUTION_ARTIFACTS = {
  communication_outline: {
    label: "沟通提纲",
    suffix: "沟通提纲",
    action: "用于下一次客户会议",
  },
  presales_questions: {
    label: "售前问题清单",
    suffix: "售前问题清单",
    action: "用于售前调研",
  },
  solution_framework: {
    label: "方案框架",
    suffix: "方案框架",
    action: "用于方案成稿",
  },
  report_outline: {
    label: "汇报材料大纲",
    suffix: "汇报材料大纲",
    action: "用于领导汇报",
  },
  competitive_talk: {
    label: "竞品应对话术",
    suffix: "竞品应对话术",
    action: "用于客户异议处理",
  },
};

export function normalizeSolutionArtifactType(value) {
  return Object.hasOwn(SOLUTION_ARTIFACTS, value) ? value : "solution_framework";
}

export function isSolutionArtifactType(value) {
  return Object.hasOwn(SOLUTION_ARTIFACTS, value);
}

function titleFor({ customer, opportunity, artifactType }) {
  const meta = SOLUTION_ARTIFACTS[artifactType];
  return `${customer.name}${opportunity.name ? ` - ${opportunity.name}` : ""}${meta.suffix}`;
}

function actionLines(actions) {
  if (!actions?.length) return "暂无已确认动作，需销售手动补充下一步。";
  return actions
    .map((action, index) => `${index + 1}. ${action.title}（${action.due ?? "时间待确认"} / ${action.priority ?? "中"}）`)
    .join("\n");
}

function knowledgeLines(knowledge) {
  if (!knowledge?.length) return "暂无匹配知识库资料，需销售手动补充案例、模板或话术。";
  return knowledge
    .map((item, index) => {
      const tags = item.tags?.length ? ` / ${item.tags.join("、")}` : "";
      const summary = item.summary ?? item.content ?? "暂无摘要。";
      return `${index + 1}. ${item.title}（${item.category ?? "未分类"}${tags}）：${summary}`;
    })
    .join("\n");
}

function baseSourceRefs({ artifactType, customer, opportunity, actions, knowledge }) {
  return [
    { type: "artifact", id: artifactType, title: SOLUTION_ARTIFACTS[artifactType].label },
    { type: "customer", id: customer.id },
    { type: "opportunity", id: opportunity.id },
    ...actions.map((action) => ({ type: "action", id: action.id, sourceRecordId: action.sourceRecordId })),
    ...knowledge.map((item) => ({ type: "knowledge", id: item.id, title: item.title })),
  ];
}

function buildCommunicationOutline({ title, owner, customer, opportunity, actions, knowledge }) {
  return [
    `# ${title}`,
    "",
    `负责人：${owner}`,
    "",
    "## 会议目标",
    lines(
      [
        `确认${customer.name}在${opportunity.name}中的核心诉求、预算路径和决策链。`,
        "把移动云灾备、本地数据中心健壮度和业务连续性问题拆成可确认事项。",
        "明确下一次售前调研、材料输出和客户侧参与人。",
      ],
      "会议目标待销售确认。",
    ),
    "",
    "## 开场与背景确认",
    customer.summary ?? "客户背景待补充。",
    "",
    "## 本次重点沟通问题",
    lines([...(customer.needs ?? []), ...(opportunity.requirements ?? [])], "暂无已整理沟通问题。"),
    "",
    "## 需要客户确认",
    lines(
      [
        "预算来源、审批链、立项窗口和是否需要领导汇报材料。",
        "现有核心业务、停机窗口、数据迁移边界和回退要求。",
        "下一次会议参与人、售前资源、现场调研时间。",
      ],
      "",
    ),
    "",
    "## 会后动作",
    actionLines(actions),
    "",
    "## 可引用材料",
    knowledgeLines(knowledge),
  ].join("\n");
}

function buildPresalesQuestions({ title, owner, customer, opportunity, knowledge }) {
  return [
    `# ${title}`,
    "",
    `负责人：${owner}`,
    "",
    "## 基础架构问题",
    lines(customer.infrastructure, "需确认服务器、存储、网络、虚拟化、备份和现有灾备形态。"),
    "",
    "## 业务系统与数据",
    lines(
      [
        "核心业务系统清单、系统负责人、峰值访问和停机敏感度。",
        "数据量、数据增长、恢复时间目标 RTO、恢复点目标 RPO。",
        "是否存在信创、等保、院内网络隔离或数据出院限制。",
      ],
      "",
    ),
    "",
    "## 预算与审批",
    lines(
      [
        opportunity.amount ? `当前预算/金额参考：${opportunity.amount}` : "预算金额、预算来源和审批链待确认。",
        "确认采购节奏、招采方式、是否需要分阶段建设。",
        "确认客户侧最终拍板人与技术评审人。",
      ],
      "",
    ),
    "",
    "## 风险与边界",
    lines([...(customer.risks ?? []), opportunity.risk].filter(Boolean), "需确认迁移窗口、回退边界、资源配合和竞品影响。"),
    "",
    "## 参考材料",
    knowledgeLines(knowledge),
  ].join("\n");
}

function buildSolutionFramework({ title, owner, customer, opportunity, actions, knowledge }) {
  return [
    `# ${title}`,
    "",
    `负责人：${owner}`,
    "",
    "## 一、客户现状与痛点",
    customer.summary ?? "客户现状待补充。",
    "",
    "### 已确认需求",
    lines(customer.needs, "暂无已确认需求。"),
    "",
    "### 基础架构与历史项目",
    lines([...(customer.infrastructure ?? []), ...(customer.historyProjects ?? [])], "基础架构和历史项目待调研。"),
    "",
    "## 二、商机背景",
    `商机阶段：${opportunity.stage ?? "待确认"}`,
    `预算/金额：${opportunity.amount ?? "待确认"}`,
    "",
    "### 客户诉求",
    lines(opportunity.requirements, "暂无商机诉求。"),
    "",
    "### 竞争与风险",
    lines([...(opportunity.competitors ?? []).map((item) => `竞争对手：${item}`), opportunity.risk].filter(Boolean), "暂无竞争或风险信息。"),
    "",
    "## 三、方案方向",
    lines(opportunity.solutionDirection, "方案方向待售前补充。"),
    "",
    "## 四、下一步动作",
    actionLines(actions),
    "",
    "## 五、知识库引用",
    knowledgeLines(knowledge),
    "",
    "## 六、需客户确认事项",
    lines(
      [
        "确认预算路径、审批链和时间窗口。",
        "确认现有业务系统、停机窗口和数据迁移边界。",
        "确认售前调研参与人和下一次会议议题。",
      ],
      "",
    ),
  ].join("\n");
}

function buildReportOutline({ title, owner, customer, opportunity, actions, knowledge }) {
  return [
    `# ${title}`,
    "",
    `负责人：${owner}`,
    "",
    "## 汇报结构",
    lines(
      [
        "客户现状：业务连续性、数据中心健壮度和灾备诉求。",
        "问题判断：移动云体验、数据自主权、预算路径和资源配合。",
        "方案建议：本地核心稳态、混合灾备、分阶段建设。",
        "决策请求：是否进入售前调研、是否安排领导汇报和预算测算。",
      ],
      "",
    ),
    "",
    "## 领导关注",
    lines(
      [
        `客户级别：${customer.level ?? "待确认"}；关系强度：${customer.relation ?? 0}。`,
        `商机阶段：${opportunity.stage ?? "待确认"}；金额参考：${opportunity.amount ?? "待确认"}。`,
        "当前风险：预算、竞品、资源或数据迁移边界需要销售确认。",
      ],
      "",
    ),
    "",
    "## 客户价值表达",
    lines(opportunity.solutionDirection, "方案价值点需售前补充。"),
    "",
    "## 下一步推进",
    actionLines(actions),
    "",
    "## 可引用材料",
    knowledgeLines(knowledge),
  ].join("\n");
}

function buildCompetitiveTalk({ title, owner, customer, opportunity, knowledge }) {
  const competitors = opportunity.competitors?.length ? opportunity.competitors : ["现有供应商或云平台方案"];
  return [
    `# ${title}`,
    "",
    `负责人：${owner}`,
    "",
    "## 竞品态势",
    lines(competitors.map((item) => `竞品/替代方案：${item}`), "竞品信息待补充。"),
    "",
    "## 客户可能疑问",
    lines(
      [
        "为什么不继续沿用现有云平台或原厂方案？",
        "本地建设与混合灾备如何控制成本和运维复杂度？",
        "数据迁移、回退和后续服务由谁负责？",
      ],
      "",
    ),
    "",
    "## 应对话术",
    lines(
      [
        "先承认现有方案价值，再把客户反馈聚焦到数据自主权、后台管理、计费透明和业务连续性。",
        "用分阶段建设降低一次性投入，把核心业务稳态和灾备能力拆开评估。",
        "所有话术必须绑定客户已反馈事实，销售确认后再用于正式沟通。",
      ],
      "",
    ),
    "",
    "## 证据材料",
    knowledgeLines(knowledge),
  ].join("\n");
}

const builders = {
  communication_outline: buildCommunicationOutline,
  presales_questions: buildPresalesQuestions,
  solution_framework: buildSolutionFramework,
  report_outline: buildReportOutline,
  competitive_talk: buildCompetitiveTalk,
};

export function buildSolutionDraft({ owner, customer, opportunity, actions = [], knowledge = [], artifactType = "solution_framework" }) {
  const normalizedArtifactType = normalizeSolutionArtifactType(artifactType);
  const title = titleFor({ customer, opportunity, artifactType: normalizedArtifactType });
  const content = builders[normalizedArtifactType]({
    title,
    owner,
    customer,
    opportunity,
    actions,
    knowledge,
  });

  const sourceRefs = baseSourceRefs({
    artifactType: normalizedArtifactType,
    customer,
    opportunity,
    actions,
    knowledge,
  });

  return { artifactType: normalizedArtifactType, title, content, sourceRefs };
}
