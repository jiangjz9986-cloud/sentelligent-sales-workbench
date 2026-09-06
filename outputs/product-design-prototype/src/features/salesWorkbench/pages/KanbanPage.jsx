import { ChevronLeft, ChevronRight } from "lucide-react";
import { kanbanStages, statusTone } from "../../../data/salesWorkbenchData.js";
import { useToast } from "../../../components/toast.jsx";
import { useNavigation } from "../../../app/useWorkbenchNavigation.jsx";
import { useWorkbenchActions } from "../../../app/useWorkbenchHandlers.jsx";
import { useWorkbenchData } from "../../../app/useWorkbenchData.jsx";

export function KanbanPage({ opportunitiesList = [] }) {
  const toast = useToast();
  const { navigateTo: setActive, setSelectedOpportunityId, openOpportunityDetail } = useNavigation();
  const { handleSaveOpportunity } = useWorkbenchActions();
  const { backendStatus } = useWorkbenchData();
  const knownStages = kanbanStages.map(([stage]) => stage);
  const extraStages = [...new Set(opportunitiesList.map((item) => item.stage).filter(Boolean))]
    .filter((stage) => !knownStages.includes(stage));
  const stages = [...knownStages, ...extraStages];

  async function moveOpportunity(item, direction) {
    if (!handleSaveOpportunity || backendStatus !== "connected") return;
    const currentIndex = stages.indexOf(item.stage);
    const nextStage = stages[currentIndex + direction];
    if (!nextStage) return;
    try {
      await handleSaveOpportunity({
        id: item.id,
        stage: nextStage,
      });
      toast({ tone: "success", title: "看板已更新", description: `${item.name} → ${nextStage}，已同步到商机档案` });
    } catch (error) {
      toast({ tone: "error", title: "看板阶段更新失败", description: error.message || "请稍后重试" });
    }
  }

  return (
    <div className="kanban-page">
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
