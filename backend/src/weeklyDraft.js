function knowledgeLines(knowledge) {
  if (!knowledge?.length) return "暂无已确认引用的知识库材料。";
  return knowledge
    .map((item, index) => {
      const tags = item.tags?.length ? ` / ${item.tags.join("、")}` : "";
      const summary = item.summary ?? item.content ?? "暂无摘要。";
      return `${index + 1}. ${item.title}（${item.category ?? "未分类"}${tags}）：${summary}`;
    })
    .join("\n");
}

export function buildWeeklyDraft({ owner, periodStart, periodEnd, records, knowledge = [] }) {
  const lines = records.map((record, index) => {
    const insight = record.analysis;
    const customer = insight?.customer?.value ?? "待确认客户";
    const opportunity = insight?.opportunity?.value ?? "待确认商机";
    const action = insight?.summary?.action?.text ?? "需人工补充下一步动作。";
    return `${index + 1}. ${customer} - ${opportunity}：${action}`;
  });

  const content = [
    `# ${owner} 销售周报草稿`,
    "",
    `周期：${periodStart} 至 ${periodEnd}`,
    "",
    "## 本周重点进展",
    lines.length > 0 ? lines.join("\n") : "暂无已确认进入周报的快速记录。",
    "",
    "## 风险与需协调事项",
    records
      .map((record, index) => {
        const risk = record.analysis?.summary?.risk?.text ?? "风险信息待补充。";
        return `${index + 1}. ${risk}`;
      })
      .join("\n") || "暂无风险事项。",
    "",
    "## 知识库引用",
    knowledgeLines(knowledge),
    "",
    "## 下周动作",
    records
      .map((record, index) => {
        const action = record.analysis?.summary?.action?.text ?? "下周动作待补充。";
        return `${index + 1}. ${action}`;
      })
      .join("\n") || "暂无下周动作。",
  ].join("\n");

  const sourceRefs = [
    ...records.map((record) => ({
      type: "quick_record",
      id: record.id,
      occurredAt: record.occurredAt,
      sourceChannel: record.sourceChannel,
    })),
    ...knowledge.map((item) => ({ type: "knowledge", id: item.id, title: item.title })),
  ];

  return { content, sourceRefs };
}
