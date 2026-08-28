import { Panel } from "../../../components/primitives.jsx";
import { DraftPreview, sourceRefText } from "./shared.jsx";

export function SolutionPage({ selected, onSelect, solutionDocs = [] }) {
  const currentSolution = selected ?? solutionDocs[0] ?? null;
  const sourceRefs = currentSolution?.sourceRefs ?? [];
  const historicalContent = selected?.content ?? currentSolution?.content ?? "";

  return (
    <div
      className="solution-workbench list-detail-grid"
      data-testid="solution-history-view"
    >
      <Panel title="历史方案" meta={`${solutionDocs.length} 份`} className="list-panel">
        <div className="related-docs" data-testid="solution-history-list">
          {solutionDocs.map((item) => (
            <button
              className={currentSolution?.id === item.id ? "selected" : ""}
              key={item.id}
              type="button"
              onClick={() => onSelect?.(item.id)}
            >
              <strong>{item.title}</strong>
              <small>{item.artifactType} / {item.status}</small>
            </button>
          ))}
          {solutionDocs.length === 0 ? (
            <p className="empty-list">暂无已保存的方案历史。</p>
          ) : null}
        </div>
      </Panel>
      <section
        className="detail-surface paper-like solution-detail"
        data-testid="solution-history-detail"
      >
        {currentSolution ? (
          <>
            <div className="solution-detail-head">
              <div>
                <span className="eyebrow">历史方案 / 只读</span>
                <h2>{currentSolution.title}</h2>
                <p>{currentSolution.artifactType} / {currentSolution.status}</p>
              </div>
            </div>
            <div className="draft-source-strip">
              <span>客户 ID：{currentSolution.customerId}</span>
              <span>商机 ID：{currentSolution.opportunityId}</span>
              <span>状态：{currentSolution.status}</span>
            </div>
            <Panel title="来源与引用" meta={`${sourceRefs.length} 个来源`}>
              <div className="source-ref-list">
                {sourceRefs.map((ref, index) => (
                  <span key={`${ref.type}-${ref.id ?? index}`}>{sourceRefText(ref)}</span>
                ))}
                {sourceRefs.length === 0 ? <p className="empty-list">暂无来源引用。</p> : null}
              </div>
            </Panel>
            <DraftPreview
              draft={{ ...currentSolution, content: historicalContent }}
              emptyText="该历史方案没有正文内容。"
            />
          </>
        ) : (
          <p className="empty-list">选择一份历史方案后查看只读详情。</p>
        )}
      </section>
    </div>
  );
}
