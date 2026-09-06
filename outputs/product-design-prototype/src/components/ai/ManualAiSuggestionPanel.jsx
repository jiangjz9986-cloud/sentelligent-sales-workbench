import {
  Bot,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { assertBackendReady } from "../../app/workbenchState.js";
import { AiResultCard } from "./AiResultCard.jsx";
import { createAiSuggestionRequestFence } from "./aiSuggestionRequestFence.js";
import {
  aiSuggestionHistoryLabel,
  aiSuggestionHistoryIsReadOnly,
  aiSuggestionToCardResult,
  upsertAiSuggestion,
} from "./manualAiSuggestionModel.js";

const AI_SUGGESTION_TIMEOUT_MS = 15_000;

function safeSuggestionError(error, fallback, timedOut = false) {
  if (timedOut) return "请求已超时，请检查连接后重试";
  if (error?.status === 401) return "登录状态已失效，请重新登录后重试";
  if (error?.status === 409 || [
    "VERSION_CONFLICT",
    "SUGGESTION_NOT_PENDING",
    "SUGGESTION_ALREADY_CONFIRMED",
  ].includes(error?.code)) return "建议状态已经变化，已锁定当前卡片，请刷新后核对";
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") return "请求已取消，请重试";
  return fallback;
}

function historyStatus(item) {
  if (!item) return "暂无历史建议，可明确点击生成一份新建议";
  return aiSuggestionHistoryIsReadOnly(item)
    ? "已载入历史终态；只读展示，不会重新调用模型"
    : "已恢复待确认建议；不会重新调用模型，可继续编辑、确认或取消";
}

function failClosedReviewResult(current, error) {
  if (!current || (error?.status !== 409 && ![
    "VERSION_CONFLICT",
    "SUGGESTION_NOT_PENDING",
    "SUGGESTION_ALREADY_CONFIRMED",
  ].includes(error?.code))) return current;
  return {
    ...current,
    status: "conflict",
    errorMessage: "建议状态已经变化，请刷新后核对最新结果",
  };
}

export function ManualAiSuggestionPanel({
  title,
  description,
  type,
  sourceId,
  context,
  apiClient,
  backendStatus,
  compact = false,
}) {
  const [history, setHistory] = useState([]);
  const [activeResult, setActiveResult] = useState(null);
  const [historyReadOnly, setHistoryReadOnly] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [status, setStatus] = useState("正在读取已有建议");
  const requestFenceRef = useRef(null);
  if (!requestFenceRef.current) requestFenceRef.current = createAiSuggestionRequestFence();
  const sourceKey = `${type ?? ""}:${sourceId ?? ""}`;
  const currentSourceKeyRef = useRef(sourceKey);
  currentSourceKeyRef.current = sourceKey;
  const cardResult = useMemo(() => aiSuggestionToCardResult(activeResult), [activeResult]);
  const panelBusy = historyLoading || generating || reviewing;

  function startRequest() {
    return requestFenceRef.current.start(sourceKey, AI_SUGGESTION_TIMEOUT_MS);
  }

  function finishRequest(request) {
    requestFenceRef.current.finish(request);
  }

  function requestIsCurrent(request) {
    return requestFenceRef.current.isCurrent(request, currentSourceKeyRef.current);
  }

  function requestOwnsPanel(request) {
    return requestFenceRef.current.owns(request, currentSourceKeyRef.current);
  }

  useEffect(() => () => requestFenceRef.current.dispose(), []);

  useEffect(() => {
    requestFenceRef.current.resume();
    let cancelled = false;
    setHistory([]);
    setActiveResult(null);
    setHistoryReadOnly(false);
    setHistoryLoading(false);
    setGenerating(false);
    setReviewing(false);
    if (!sourceId || !type || !apiClient?.listAiSuggestions) {
      setStatus("当前业务对象就绪后可生成建议");
      return () => {
        cancelled = true;
      };
    }
    const request = startRequest();
    setHistoryLoading(true);
    setStatus("正在读取已有建议");
    apiClient.listAiSuggestions({ type, sourceId, limit: 5 }, { signal: request.controller.signal })
      .then((response) => {
        if (cancelled || !requestIsCurrent(request)) return;
        const items = Array.isArray(response?.items) ? response.items : [];
        const active = items[0] ?? null;
        setHistory(items);
        setActiveResult(active);
        setHistoryReadOnly(active ? aiSuggestionHistoryIsReadOnly(active) : false);
        setStatus(historyStatus(active));
      })
      .catch((error) => {
        if (!cancelled && requestOwnsPanel(request)) {
          setStatus(safeSuggestionError(error, "历史建议读取失败，请稍后重试", request.timedOut));
        }
      })
      .finally(() => {
        const current = requestOwnsPanel(request);
        finishRequest(request);
        if (!cancelled && current) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
      finishRequest(request);
      request.controller.abort();
    };
  }, [apiClient, sourceId, type]);

  async function generateSuggestion() {
    if (panelBusy || !sourceId || !apiClient?.generateAiSuggestion) return;
    try {
      assertBackendReady({ isEnabled: apiClient.isEnabled, status: backendStatus }, title);
    } catch (error) {
      setStatus("服务尚未就绪，请恢复连接后重试");
      return;
    }
    setGenerating(true);
    setStatus("正在依据当前业务快照生成新建议");
    const request = startRequest();
    try {
      const created = await apiClient.generateAiSuggestion({ type, title, context }, { signal: request.controller.signal });
      if (!requestIsCurrent(request)) return;
      setHistory((items) => upsertAiSuggestion(items, created));
      setActiveResult(created);
      setHistoryReadOnly(false);
      setStatus("建议已生成；可编辑草稿，只有明确确认才会保存人工审核结果");
    } catch (error) {
      if (requestOwnsPanel(request)) {
        setStatus(safeSuggestionError(error, "建议生成失败，请稍后重试", request.timedOut));
      }
    } finally {
      const current = requestOwnsPanel(request);
      finishRequest(request);
      if (current) setGenerating(false);
    }
  }

  function openHistory(item) {
    setActiveResult(item);
    setHistoryReadOnly(aiSuggestionHistoryIsReadOnly(item));
    setStatus(historyStatus(item));
  }

  async function confirmSuggestion(request) {
    if (!activeResult?.id || panelBusy || !request?.draft || !apiClient?.confirmAiSuggestion) return;
    setReviewing(true);
    setStatus("正在保存人工确认草稿");
    const reviewRequest = startRequest();
    try {
      const confirmed = await apiClient.confirmAiSuggestion(activeResult.id, {
        draft: request.draft,
        version: activeResult.version,
      }, { signal: reviewRequest.controller.signal });
      if (!requestIsCurrent(reviewRequest)) return;
      setActiveResult(confirmed);
      setHistory((items) => upsertAiSuggestion(items, confirmed));
      setHistoryReadOnly(true);
      setStatus("人工确认草稿已保存；客户、商机和知识库均未自动修改");
    } catch (error) {
      if (requestOwnsPanel(reviewRequest)) {
        setActiveResult((current) => failClosedReviewResult(current, error));
        setStatus(safeSuggestionError(error, "人工确认保存失败，请检查最新状态", reviewRequest.timedOut));
      }
    } finally {
      const current = requestOwnsPanel(reviewRequest);
      finishRequest(reviewRequest);
      if (current) setReviewing(false);
    }
  }

  async function cancelSuggestion() {
    if (!activeResult?.id || panelBusy || !apiClient?.cancelAiSuggestion) return;
    setReviewing(true);
    setStatus("正在取消本次建议");
    const request = startRequest();
    try {
      const cancelled = await apiClient.cancelAiSuggestion(activeResult.id, {
        version: activeResult.version,
      }, { signal: request.controller.signal });
      if (!requestIsCurrent(request)) return;
      setActiveResult(cancelled);
      setHistory((items) => upsertAiSuggestion(items, cancelled));
      setHistoryReadOnly(true);
      setStatus("本次建议已取消；没有写入任何业务档案");
    } catch (error) {
      if (requestOwnsPanel(request)) {
        setActiveResult((current) => failClosedReviewResult(current, error));
        setStatus(safeSuggestionError(error, "取消失败，请检查最新状态", request.timedOut));
      }
    } finally {
      const current = requestOwnsPanel(request);
      finishRequest(request);
      if (current) setReviewing(false);
    }
  }

  return (
    <section
      className={`manual-ai-suggestion-panel ${compact ? "compact" : ""}`}
      data-testid={`manual-ai-suggestion-${type}`}
    >
      <div className="manual-ai-suggestion-toolbar">
        <div className="manual-ai-suggestion-intro">
          <Bot size={18} />
          <span>
            <strong>{title}</strong>
            <small>{description}</small>
          </span>
        </div>
        <button
          className="primary-button"
          type="button"
          data-testid={`ai-suggestion-generate-${type}`}
          disabled={panelBusy || !sourceId}
          onClick={generateSuggestion}
        >
          <RefreshCw size={15} className={generating ? "spin" : ""} />
          {generating ? "生成中" : "生成新建议"}
        </button>
      </div>

      {history.length > 0 ? (
        <div className="manual-ai-suggestion-history" data-testid={`ai-suggestion-history-${type}`}>
          {history.slice(0, 5).map((item) => (
            <button
              className={`manual-ai-suggestion-history-item ${activeResult?.id === item.id && historyReadOnly ? "selected" : ""}`}
              key={item.id}
              type="button"
              disabled={panelBusy}
              aria-pressed={activeResult?.id === item.id && historyReadOnly}
              onClick={() => openHistory(item)}
            >
              <span>{aiSuggestionHistoryLabel(item)}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      ) : null}

      {cardResult ? (
        <AiResultCard
          result={cardResult}
          historyReadOnly={historyReadOnly}
          busy={panelBusy}
          confirmLabel="保存人工确认草稿"
          cancelLabel="取消本次建议"
          onConfirm={confirmSuggestion}
          onCancel={cancelSuggestion}
        />
      ) : (
        <div className="manual-ai-suggestion-empty" data-testid={`ai-suggestion-empty-${type}`}>
          <Bot size={22} />
          <strong>{historyLoading ? "正在读取历史建议" : "暂无建议结果"}</strong>
          <span>生成动作只会创建一份待审核建议，不会自动改业务档案。</span>
        </div>
      )}

      <p className="editor-status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}
