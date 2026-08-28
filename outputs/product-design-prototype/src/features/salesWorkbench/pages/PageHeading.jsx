export function PageHeading({ active, activeMeta, headingContext, action, subView = false }) {
  const title = headingContext?.title ?? pageTitle(active);

  if (!subView) {
    if (!action) return null;
    return (
      <div className="page-heading action-only">
        <div className="page-heading-action">{action}</div>
      </div>
    );
  }

  return (
    <div className="page-heading compact-heading">
      <div>
        <span className="eyebrow">{activeMeta.label}</span>
        <h1>{title}</h1>
      </div>
      {action ? <div className="page-heading-action">{action}</div> : null}
    </div>
  );
}

function pageTitle(active) {
  const titles = {
    overview: "AI 销售作战台",
    quick: "语音 / 文本快速记录",
    customer: "客户画像",
    opportunity: "商机档案",
    actions: "下一步动作",
    solution: "历史方案",
    weekly: "周报与管理汇报",
    risk: "风险识别",
    knowledge: "销售知识库",
    kanban: "商机看板",
    weixin: "微信机器人绑定",
  };
  return titles[active];
}
