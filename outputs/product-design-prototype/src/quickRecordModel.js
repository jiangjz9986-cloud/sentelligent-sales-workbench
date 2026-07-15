const rizhaoAnalysis = {
  source: "mock",
  customer: {
    value: "日照中医医院",
    meta: "置信度 91%",
    tone: "blue",
  },
  opportunity: {
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

const genericAnalysis = {
  source: "mock",
  customer: {
    value: "待匹配客户",
    meta: "需人工选择",
    tone: "gray",
  },
  opportunity: {
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

export function buildQuickRecordAnalysis(input) {
  const text = input.trim();
  if (!text) return null;

  if (text.includes("日照中医") || text.includes("移动云") || text.includes("十五五")) {
    return rizhaoAnalysis;
  }

  return genericAnalysis;
}

export function getQuickRecordFlow({ hasInput, hasAnalysis, confirmedTargets }) {
  const confirmedCount = new Set(confirmedTargets).size;
  return [
    hasInput ? "done" : "active",
    hasAnalysis ? "done" : hasInput ? "active" : "idle",
    hasAnalysis && confirmedCount > 0 ? "done" : hasAnalysis ? "active" : "idle",
    confirmedCount >= getSyncTargets().length ? "done" : confirmedCount > 0 ? "active" : "idle",
  ];
}

export function createExclusiveAsyncGate() {
  let active = false;
  return {
    async run(work) {
      if (active) return { status: "busy" };
      active = true;
      try {
        return await work();
      } finally {
        active = false;
      }
    },
  };
}

export function mergeEntityByVersion(items, item) {
  if (!item?.id) return items;
  const current = items.find((candidate) => candidate.id === item.id);
  if (!current) return [item, ...items];

  const currentVersion = current.version;
  const incomingVersion = item.version;
  if (
    Number.isSafeInteger(currentVersion) &&
    Number.isSafeInteger(incomingVersion) &&
    incomingVersion < currentVersion
  ) {
    return items;
  }
  return items.map((candidate) => candidate.id === item.id ? item : candidate);
}

export async function confirmQuickRecordTarget({
  apiClient,
  attemptTracker,
  quickRecord,
  analysis,
  target,
  customers,
  opportunities,
  confirmedBy,
}) {
  const targetVersions = {};
  if (target.id === "customer") {
    const customerId = analysis?.customer?.id ?? quickRecord.customerId;
    const customer = customers?.find((item) => item.id === customerId);
    if (!Number.isSafeInteger(customer?.version) || customer.version <= 0) {
      return { status: "missing_version", entity: "customer" };
    }
    targetVersions.customer = customer.version;
  }
  if (target.id === "opportunity") {
    const opportunityId = analysis?.opportunity?.id ?? quickRecord.opportunityId;
    const opportunity = opportunities?.find((item) => item.id === opportunityId);
    if (!Number.isSafeInteger(opportunity?.version) || opportunity.version <= 0) {
      return { status: "missing_version", entity: "opportunity" };
    }
    targetVersions.opportunity = opportunity.version;
  }

  const idempotencyKey = attemptTracker.keyFor({
    quickRecordId: quickRecord.id,
    quickRecordVersion: quickRecord.version,
    analysisVersionId: analysis?.id ?? null,
    targets: [target.id],
    targetVersions,
  });
  try {
    const result = await apiClient.confirmQuickRecord(quickRecord.id, [target.id], {
      confirmedBy,
      note: target.status,
      idempotencyKey,
      quickRecordVersion: quickRecord.version,
      targetVersions,
      analysisVersionId: analysis?.id ?? null,
    });
    attemptTracker.complete(idempotencyKey);
    return { status: "confirmed", result, idempotencyKey };
  } catch (error) {
    if (error?.code !== "VERSION_CONFLICT") throw error;
    const refreshed = await apiClient.refreshQuickRecordConfirmationState(quickRecord.id);
    return { status: "conflict", error, refreshed, idempotencyKey };
  }
}

export function getSyncTargets() {
  return [
    {
      id: "customer",
      label: "确认写入客户画像",
      doneLabel: "已写入客户画像",
      status: "已由人工确认同步到客户画像",
    },
    {
      id: "opportunity",
      label: "同步到商机 / 项目",
      doneLabel: "已同步商机 / 项目",
      status: "已由人工确认同步到商机档案",
    },
    {
      id: "weekly",
      label: "进入周报草稿",
      doneLabel: "已进入周报草稿",
      status: "已由人工确认进入本周周报草稿",
    },
  ];
}
