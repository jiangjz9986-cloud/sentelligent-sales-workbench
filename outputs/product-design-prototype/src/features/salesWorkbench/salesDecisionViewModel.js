const DECISION_LABELS = Object.freeze({
  advance: "重点推进",
  advance_with_conditions: "有条件推进",
  validate: "继续验证",
  nurture: "转入培育",
  pause: "暂时暂停",
  disqualify: "建议退出",
  escalate_review: "升级审查",
});

const DECISION_TONES = Object.freeze({
  advance: "green",
  advance_with_conditions: "amber",
  validate: "blue",
  nurture: "gray",
  pause: "amber",
  disqualify: "red",
  escalate_review: "red",
});

const STAGE_LABELS = Object.freeze({
  lead: "线索",
  initial_discovery: "初步发现",
  deep_discovery: "深度发现",
  solution_validation: "方案验证",
  commercial_progress: "商务推进",
  decision_commitment: "决策承诺",
  won: "赢单",
  lost: "输单",
  paused: "暂停",
});

export function decisionLabel(code) {
  return DECISION_LABELS[code] ?? "待判断";
}

export function decisionTone(code) {
  return DECISION_TONES[code] ?? "blue";
}

export function stageLabel(stage) {
  return STAGE_LABELS[stage] ?? "待确认阶段";
}

export function salesDecisionHistoryLabel(item) {
  const date = item?.createdAt ? new Date(item.createdAt) : null;
  const dateLabel = date && !Number.isNaN(date.getTime())
    ? `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    : "未记录日期";
  const analysis = item?.analysis ?? {};
  return `${dateLabel} · ${decisionLabel(analysis.decision?.code)} · ${analysis.score?.total ?? 0}分`;
}

export function salesDecisionViewModel(item) {
  const analysis = item?.analysis ?? {};
  return {
    decisionLabel: decisionLabel(analysis.decision?.code),
    decisionTone: decisionTone(analysis.decision?.code),
    scoreLabel: `${analysis.score?.total ?? 0} / 100`,
    stageLabel: stageLabel(analysis.stage?.recommended ?? analysis.stage?.current),
    unknownCount: Array.isArray(analysis.unknowns) ? analysis.unknowns.length : 0,
    riskCount: Array.isArray(analysis.risks) ? analysis.risks.length : 0,
    actionCount: Array.isArray(analysis.nextActions) ? analysis.nextActions.length : 0,
    requiresHumanConfirmation: analysis.writebackPreview?.requiresHumanConfirmation !== false,
    complianceLabel: analysis.compliance?.requiresEscalation ? "需要审查" : "未发现红线",
  };
}
