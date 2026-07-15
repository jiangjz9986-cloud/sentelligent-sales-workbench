const rizhaoAnalysis = {
  source: "mock",
  confidence: 88,
  customer: {
    id: "rizhao",
    value: "日照中医医院",
    meta: "置信度 91%",
    tone: "blue",
  },
  opportunity: {
    id: "op-rizhao-plan",
    value: "日照中医医院十五五规划",
    meta: "置信度 84%",
    tone: "green",
  },
  weekly: {
    value: "周三 / 06-03",
    meta: "本周记录",
    tone: "amber",
  },
  summary: {
    request: {
      title: "客户诉求",
      text: "补齐本地数据中心健壮度，未来将移动云作为灾备中心。",
    },
    feedback: {
      title: "客户反馈",
      text: "移动云计费、平台封闭、数据导出和后台管理权存在明显顾虑。",
    },
    risk: {
      title: "风险点",
      text: "预算路径未确认，方案输出质量会影响后续推进。",
    },
    action: {
      title: "建议动作",
      text: "写入客户画像、同步商机、生成规划材料大纲并进入周三周报。",
    },
  },
};

const huangdaoTcmAnalysis = {
  source: "mock",
  confidence: 82,
  customer: {
    id: "huangdao-tcm",
    value: "黄岛区中医院",
    meta: "置信度 86%",
    tone: "green",
  },
  opportunity: {
    id: "op-huangdao-tcm",
    value: "黄岛区中医院双活机房建设",
    meta: "置信度 80%",
    tone: "green",
  },
  weekly: {
    value: "周五 / 06-05",
    meta: "本周记录",
    tone: "amber",
  },
  summary: {
    request: {
      title: "客户诉求",
      text: "下周带售前完成新院区双活机房调研，输出整体规划。",
    },
    feedback: {
      title: "客户反馈",
      text: "客户多次索要架构参考材料，需要用案例和调研清单推进。",
    },
    risk: {
      title: "风险点",
      text: "需要确认决策链和金通电脑影响，售前调研深度会影响后续立项。",
    },
    action: {
      title: "建议动作",
      text: "同步到客户画像和商机档案，并写入本周周报草稿的下周动作。",
    },
  },
};

const genericAnalysis = {
  source: "mock",
  confidence: 55,
  customer: {
    id: null,
    value: "待匹配客户",
    meta: "需人工选择",
    tone: "gray",
  },
  opportunity: {
    id: null,
    value: "待确认商机",
    meta: "建议新建或关联",
    tone: "amber",
  },
  weekly: {
    value: "本周待归档",
    meta: "需确认日期",
    tone: "blue",
  },
  summary: {
    request: {
      title: "客户诉求",
      text: "记录中出现预算、方案或后续沟通线索，建议先补齐客户、商机和日期。",
    },
    feedback: {
      title: "客户反馈",
      text: "客户意见尚未形成稳定结论，需要销售补充关键人、场景和原话来源。",
    },
    risk: {
      title: "风险点",
      text: "客户名称、商机阶段或预算路径不完整，直接写入可能污染业务档案。",
    },
    action: {
      title: "建议动作",
      text: "先人工选择客户和商机，再确认是否进入本周周报草稿。",
    },
  },
};

export function buildQuickRecordAnalysis(rawContent) {
  const text = String(rawContent ?? "").trim();
  if (!text) return null;

  if (text.includes("日照中医") || text.includes("移动云") || text.includes("十五五")) {
    return structuredClone(rizhaoAnalysis);
  }

  if (text.includes("黄岛区中医院") || text.includes("双活机房") || text.includes("机房调研")) {
    return structuredClone(huangdaoTcmAnalysis);
  }

  return structuredClone(genericAnalysis);
}
