import { fileURLToPath } from "node:url";

import { openDatabase, run } from "./db.js";
import { loadConfig } from "./config.js";

const customers = [
  {
    id: "rizhao",
    name: "日照中医医院",
    region: "日照",
    type: "医疗 KA",
    level: "重点推进",
    owner: "继振",
    contact: "梁斌 / 信息主管",
    relation: 82,
    stakeholders: [
      { name: "王院长", role: "最终拍板", influence: "高影响" },
      { name: "李主任", role: "信息中心", influence: "关键推动" },
      { name: "梁斌", role: "主管工程师", influence: "技术评估" },
    ],
    decisionChain: ["信息中心形成技术建议", "分管院长确认建设必要性", "财务口径评估预算窗口", "院长办公会最终拍板"],
    historyProjects: ["核心业务虚拟化平台", "本地存储扩容", "移动云灾备试用", "十五五规划材料沟通"],
    infrastructure: ["VMware 虚拟化承载核心业务", "本地数据中心为主运行环境", "移动云作为灾备方向但体验偏弱"],
    syncPreview: ["补充移动云使用反馈", "沉淀本地数据中心健壮度诉求", "标记预算路径待确认"],
    budget: "Q3 预算窗口",
    summary: "客户希望先补齐本地数据中心基础架构健壮度，确保业务稳定快速运行，再将移动云作为灾备中心。",
    needs: ["本地数据中心健壮度提升", "移动云灾备可控性评估", "未来 3-5 年规划材料"],
    risks: ["移动云体验差", "数据自主权弱", "预算路径待确认"],
    opportunities: ["日照中医医院十五五规划", "数据中心双活与灾备建设"],
  },
  {
    id: "huangdao-tcm",
    name: "黄岛区中医院",
    region: "青岛黄岛",
    type: "三级甲等",
    level: "高潜商机",
    owner: "继振",
    contact: "吕宜明 / 王滨",
    relation: 79,
    stakeholders: [
      { name: "吕宜明", role: "信息负责人", influence: "关键需求" },
      { name: "王滨", role: "项目沟通", influence: "资料接口" },
      { name: "分管院长", role: "建设方向", influence: "高影响" },
    ],
    decisionChain: ["信息负责人提出架构参考需求", "售前调研补齐新院区场景", "分管院长确认建设范围"],
    historyProjects: ["青医架构图参考", "胜利油田架构图参考", "新院区双活机房沟通"],
    infrastructure: ["新院区机房规划待调研", "双活数据中心是主要方向", "信创与 AI 算力规划可作为扩展议题"],
    syncPreview: ["写入下周机房调研动作", "关联双活机房建设商机", "补充金通电脑影响"],
    budget: "预算 3000 万",
    summary: "新院区双活机房规划进入调研机会，客户多次索要青医和胜利油田架构图。",
    needs: ["新院区双活机房整体规划", "信创与 AI 算力规划", "架构参考材料"],
    risks: ["金通电脑关系切入", "需售前深度调研", "决策链需要确认"],
    opportunities: ["数据中心双活机房建设", "新院区未来规划"],
  },
];

const opportunities = [
  {
    id: "op-rizhao-plan",
    customerId: "rizhao",
    name: "日照中医医院十五五规划",
    customer: "日照中医医院",
    stage: "方案输出",
    amount: "规划类",
    owner: "继振",
    probability: 66,
    days: 3,
    requirements: ["十五五年度规划材料", "本地数据中心健壮度评估", "移动云灾备模式重新论证"],
    competitors: ["移动云", "院内自建方案待比较"],
    solutionDirection: ["本地核心业务优先稳态运行", "移动云作为灾备中心而非主承载", "形成自建与混合灾备对比材料"],
    sourceRecord: "06-03 现场拜访记录，来自快速记录识别结果",
    risk: "移动云体验和数据自主权是核心矛盾，预算路径还未闭环。",
    next: "补齐规划材料，形成基础架构健壮度、灾备中心和运维自主权三段式方案。",
    tone: "blue",
  },
  {
    id: "op-huangdao-tcm",
    customerId: "huangdao-tcm",
    name: "黄岛区中医院双活机房建设",
    customer: "黄岛区中医院",
    stage: "调研机会",
    amount: "3000 万",
    owner: "继振",
    probability: 72,
    days: 5,
    requirements: ["新院区双活机房调研", "架构图参考材料", "信创与 AI 算力规划"],
    competitors: ["金通电脑", "既有合作关系"],
    solutionDirection: ["下周带售前做机房调研", "输出双活机房整体规划", "用青医和胜利油田案例做背书"],
    sourceRecord: "06-05 再次拜访记录，来自快速记录识别结果",
    risk: "客户需要架构图与深度调研，金通电脑存在关系基础。",
    next: "下周带售前做机房调研，输出新院区双活机房整体规划。",
    tone: "green",
  },
];

const actions = [
  {
    id: "a1",
    customerId: "rizhao",
    opportunityId: "op-rizhao-plan",
    title: "补齐日照中医医院十五五规划材料",
    customer: "日照中医医院",
    reason: "客户明确要求输出年度规划，需要把移动云问题转成可汇报的建设逻辑。",
    due: "今天 18:00",
    priority: "高",
    status: "pending",
    sourceRecordId: null,
    tone: "red",
  },
  {
    id: "a2",
    customerId: "huangdao-tcm",
    opportunityId: "op-huangdao-tcm",
    title: "约黄岛区中医院机房调研",
    customer: "黄岛区中医院",
    reason: "客户已释放下周调研机会，需要售前参与并形成整体规划。",
    due: "周一上午",
    priority: "高",
    status: "pending",
    sourceRecordId: null,
    tone: "amber",
  },
];

const riskItems = [
  {
    id: "risk-budget-path",
    customerId: "rizhao",
    opportunityId: "op-rizhao-plan",
    title: "预算路径未确认",
    target: "日照中医医院 / 十五五规划",
    score: 86,
    severity: "高",
    status: "open",
    evidence: "周报记录中多次出现预算未明确、仅做参考报价、需领导申请等反馈。",
    action: "下一次拜访必须确认预算来源、审批链和时间窗口。",
    assignee: "继振",
    due: "今天 18:00",
    sourceType: "opportunity",
    sourceId: "op-rizhao-plan",
    tone: "red",
  },
  {
    id: "risk-competitor-entry",
    customerId: "huangdao-tcm",
    opportunityId: "op-huangdao-tcm",
    title: "竞争对手关系切入",
    target: "黄岛区中医院 / 胜利油田中心医院",
    score: 72,
    severity: "中",
    status: "open",
    evidence: "客户多次提到金通电脑关系和既有架构图参考，需确认影响边界。",
    action: "补齐院内关系图，明确售前材料和客户背书的切入路径。",
    assignee: "继振",
    due: "周一上午",
    sourceType: "opportunity",
    sourceId: "op-huangdao-tcm",
    tone: "amber",
  },
  {
    id: "risk-presales-resource",
    customerId: "huangdao-tcm",
    opportunityId: "op-huangdao-tcm",
    title: "售前资源未锁定",
    target: "黄岛区中医院调研",
    score: 61,
    severity: "中",
    status: "open",
    evidence: "下周机房调研需要售前深度参与，目前还没有明确人员和时间。",
    action: "锁定售前负责人，提前准备机房调研问题清单和双活架构材料。",
    assignee: "继振",
    due: "周五 17:00",
    sourceType: "opportunity",
    sourceId: "op-huangdao-tcm",
    tone: "blue",
  },
];

const knowledgeItems = [
  {
    id: "k-active-active-hospital",
    title: "医疗行业双活建设案例",
    category: "成功案例",
    tags: ["医院", "双活", "灾备"],
    summary: "用于领导汇报和客户信任背书，重点说明业务连续性与回退策略。",
    content: "适合在双活数据中心、PACS 连续性、新院区机房规划场景中引用，强调本地核心业务稳态运行、故障切换和回退边界。",
    source: "销售知识库",
  },
  {
    id: "k-mobile-cloud-dr",
    title: "移动云灾备对比清单",
    category: "话术材料",
    tags: ["移动云", "计费", "数据自主权"],
    summary: "回应平台封闭、资源计费、后台管理权和数据导出配合度问题。",
    content: "从资源计费透明度、平台开放性、数据导出配合度、后台管理权和院内运维自主性五个维度做对比，适合日照中医医院十五五规划材料。",
    source: "销售知识库",
  },
  {
    id: "k-room-survey-template",
    title: "机房调研问题模板",
    category: "售前模板",
    tags: ["调研", "信创", "双活"],
    summary: "覆盖现有架构、业务系统、停机窗口、信创适配和预算节奏。",
    content: "调研问题包括现有服务器/存储/虚拟化、核心业务系统清单、RTO/RPO、停机窗口、信创适配、网络链路、预算窗口和验收口径。",
    source: "销售知识库",
  },
  {
    id: "k-ai-infra-intro",
    title: "AI 算力基础架构入门方案",
    category: "产品资料",
    tags: ["AI", "算力", "数据中心"],
    summary: "用于近期客户对 AI 基础架构观望时的轻量沟通入口。",
    content: "围绕训练/推理算力、GPU 资源池、存储吞吐、数据治理和运维监控做入门说明，适合非明确项目阶段的客户教育。",
    source: "销售知识库",
  },
];

function json(value) {
  return JSON.stringify(value ?? []);
}

export function seedDatabase(db) {
  for (const customer of customers) {
    run(
      db,
      `INSERT OR IGNORE INTO customers (
        id, name, region, type, level, owner, contact, relation,
        stakeholders, decision_chain, history_projects, infrastructure,
        sync_preview, budget, summary, needs, risks, opportunities
      ) VALUES (
        $id, $name, $region, $type, $level, $owner, $contact, $relation,
        $stakeholders, $decisionChain, $historyProjects, $infrastructure,
        $syncPreview, $budget, $summary, $needs, $risks, $opportunities
      )`,
      {
        $id: customer.id,
        $name: customer.name,
        $region: customer.region,
        $type: customer.type,
        $level: customer.level,
        $owner: customer.owner,
        $contact: customer.contact,
        $relation: customer.relation,
        $stakeholders: json(customer.stakeholders),
        $decisionChain: json(customer.decisionChain),
        $historyProjects: json(customer.historyProjects),
        $infrastructure: json(customer.infrastructure),
        $syncPreview: json(customer.syncPreview),
        $budget: customer.budget,
        $summary: customer.summary,
        $needs: json(customer.needs),
        $risks: json(customer.risks),
        $opportunities: json(customer.opportunities),
      },
    );
  }

  for (const opportunity of opportunities) {
    run(
      db,
      `INSERT OR IGNORE INTO opportunities (
        id, customer_id, name, customer, stage, amount, owner, probability,
        days, requirements, competitors, solution_direction, source_record,
        risk, next, tone
      ) VALUES (
        $id, $customerId, $name, $customer, $stage, $amount, $owner, $probability,
        $days, $requirements, $competitors, $solutionDirection, $sourceRecord,
        $risk, $next, $tone
      )`,
      {
        $id: opportunity.id,
        $customerId: opportunity.customerId,
        $name: opportunity.name,
        $customer: opportunity.customer,
        $stage: opportunity.stage,
        $amount: opportunity.amount,
        $owner: opportunity.owner,
        $probability: opportunity.probability,
        $days: opportunity.days,
        $requirements: json(opportunity.requirements),
        $competitors: json(opportunity.competitors),
        $solutionDirection: json(opportunity.solutionDirection),
        $sourceRecord: opportunity.sourceRecord,
        $risk: opportunity.risk,
        $next: opportunity.next,
        $tone: opportunity.tone,
      },
    );
  }

  for (const action of actions) {
    run(
      db,
      `INSERT OR IGNORE INTO action_items (
        id, customer_id, opportunity_id, title, customer, reason, due,
        priority, status, source_record_id, tone
      ) VALUES (
        $id, $customerId, $opportunityId, $title, $customer, $reason, $due,
        $priority, $status, $sourceRecordId, $tone
      )`,
      {
        $id: action.id,
        $customerId: action.customerId,
        $opportunityId: action.opportunityId,
        $title: action.title,
        $customer: action.customer,
        $reason: action.reason,
        $due: action.due,
        $priority: action.priority,
        $status: action.status,
        $sourceRecordId: action.sourceRecordId,
        $tone: action.tone,
      },
    );
  }

  for (const item of riskItems) {
    run(
      db,
      `INSERT OR IGNORE INTO risk_items (
        id, customer_id, opportunity_id, title, target, score, severity,
        status, evidence, action, assignee, due, source_type, source_id, tone
      ) VALUES (
        $id, $customerId, $opportunityId, $title, $target, $score, $severity,
        $status, $evidence, $action, $assignee, $due, $sourceType, $sourceId, $tone
      )`,
      {
        $id: item.id,
        $customerId: item.customerId,
        $opportunityId: item.opportunityId,
        $title: item.title,
        $target: item.target,
        $score: item.score,
        $severity: item.severity,
        $status: item.status,
        $evidence: item.evidence,
        $action: item.action,
        $assignee: item.assignee,
        $due: item.due,
        $sourceType: item.sourceType,
        $sourceId: item.sourceId,
        $tone: item.tone,
      },
    );
  }

  for (const item of knowledgeItems) {
    run(
      db,
      `INSERT OR IGNORE INTO knowledge_items (
        id, title, category, tags, summary, content, source
      ) VALUES (
        $id, $title, $category, $tags, $summary, $content, $source
      )`,
      {
        $id: item.id,
        $title: item.title,
        $category: item.category,
        $tags: json(item.tags),
        $summary: item.summary,
        $content: item.content,
        $source: item.source,
      },
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDatabase({ databaseUrl: loadConfig().databaseUrl });
  seedDatabase(db);
  db.close();
  console.log("Database seeded");
}
