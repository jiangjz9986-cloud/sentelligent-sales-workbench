import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { kanbanStages, statusTone } from "../../../data/salesWorkbenchData.js";

export function KanbanPage({
  opportunitiesList = [],
  setActive,
  setSelectedOpportunityId,
  openOpportunityDetail,
  onSaveOpportunity,
  backendStatus,
}) {
  const [statusMessage, setStatusMessage] = useState("看板阶段变更会同步到商机档案。");
  const knownStages = kanbanStages.map(([stage]) => stage);
  const extraStages = [...new Set(opportunitiesList.map((item) => item.stage).filter(Boolean))]
    .filter((stage) => !knownStages.includes(stage));
  const stages = [...knownStages, ...extraStages];

  async function moveOpportunity(item, direction) {
    if (!onSaveOpportunity) return;
    const currentIndex = stages.indexOf(item.stage);
    const nextStage = stages[currentIndex + direction];
    if (!nextStage) return;
    setStatusMessage("正在更新看板阶段");
    try {
      await onSaveOpportunity({
        id: item.id,
        stage: nextStage,
      });
            setStatusMessage("看板已更新，并同步到商机档案");
    } catch (error) {
      setStatusMessage(error.message || "看板阶段更新失败");
    }
  }

  return (
    <div className="kanban-page">
      <p className="kanban-status">{statusMessage}</p>
      <div className="kanban-board">
        {stages.map((stage) => {
          const cards = opportunitiesList.filter((item) => item.stage === stage);
          return (
          <section className="kanban-col" key={stage}>
            <h3>
              <span>{stage}</span>
              <b>{cards.length}</b>
            </h3>
            {cards.length === 0 ? <p className="kanban-empty">暂无商机</p> : null}
            {cards.map((item) => {
              const stageIndex = stages.indexOf(item.stage);
              const canMoveBack = stageIndex > 0;
              const canMoveForward = stageIndex >= 0 && stageIndex < stages.length - 1;
              return (
                <article className="deal-card" key={item.id}>
                  <button
                    className="deal-card-main"
                    type="button"
                    data-testid="kanban-open-opportunity"
                    onClick={() => {
                      if (openOpportunityDetail) openOpportunityDetail(item.id);
                      else {
                        setSelectedOpportunityId(item.id);
                        setActive("opportunity");
                      }
                    }}
                  >
                    <strong>{item.name}</strong>
                    <small>{item.customer}</small>
                    <span className={`pill ${statusTone[item.tone ?? "blue"]}`}>{stage}</span>
                  </button>
                  <div className="kanban-card-actions">
                    <button
                      className="ghost-button compact-icon"
                      type="button"
                      data-testid="kanban-stage-back"
                      disabled={!canMoveBack}
                      title="回退阶段"
                      onClick={() => moveOpportunity(item, -1)}
                    >
                      <ChevronLeft size={15} />
                      回退
                    </button>
                    <button
                      className="ghost-button compact-icon"
                      type="button"
                      data-testid="kanban-stage-forward"
                      disabled={!canMoveForward}
                      title="推进阶段"
                      onClick={() => moveOpportunity(item, 1)}
                    >
                      推进
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
          );
        })}
      </div>
    </div>
  );
}
