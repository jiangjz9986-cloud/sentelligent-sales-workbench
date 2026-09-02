import { LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiResultCard } from "../../components/ai/AiResultCard.jsx";
import {
  mergeTemperatureOutcome,
  temperatureCanAct,
  temperatureErrorMessage,
  temperatureIsReadOnly,
  temperatureSuggestionToAiCard,
} from "./visitTemperatureSuggestionModel.js";

export function VisitTemperatureSuggestionsPanel({
  apiClient,
  backendStatus,
  quickRecord,
  customers = [],
  historyReadOnly = false,
  onCustomerUpdated,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState(null);
  const [message, setMessage] = useState("");
  const requestRef = useRef(null);
  const generationRef = useRef(0);
  const customerId = quickRecord?.customerId ?? null;
  const visitId = quickRecord?.id ?? null;
  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === quickRecord?.customerId),
    [customers, quickRecord?.customerId],
  );

  const reload = useCallback(async (requestSignal) => {
    if (!customerId || !apiClient?.isEnabled || backendStatus !== "connected") {
      if (!customerId) setItems([]);
      return;
    }
    const generation = generationRef.current;
    setLoading(true);
    setMessage("");
    try {
      const result = await apiClient.listVisitTemperatureSuggestions({ customerId, limit: 50, signal: requestSignal });
      if (generation === generationRef.current && !requestSignal?.aborted) {
        setItems(result.items.filter((item) => item.visitId === visitId));
      }
    } catch (error) {
      if (!requestSignal?.aborted && generation === generationRef.current) setMessage(temperatureErrorMessage(error, "温度建议读取"));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [apiClient, backendStatus, customerId, visitId]);

  useEffect(() => {
    generationRef.current += 1;
    requestRef.current?.abort();
    setItems([]);
    setLoading(false);
    setPendingId(null);
    setMessage("");
    const controller = new AbortController();
    requestRef.current = controller;
    void reload(controller.signal);
    return () => {
      generationRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [reload]);

  const selectedSuggestion = items.find((item) => item.visitId === visitId);
  const canGenerate = !historyReadOnly
    && Boolean(quickRecord?.id)
    && Boolean(quickRecord?.customerId)
    && (quickRecord.status === "confirmed"
      || (quickRecord.status === "analyzed" && quickRecord.confirmationPreviewStatus === "completed"))
    && !selectedSuggestion;

  async function generate() {
    if (historyReadOnly || !quickRecord?.id || !canGenerate) return;
    const generation = generationRef.current;
    setPendingId("generate");
    setMessage("");
    try {
      const controller = new AbortController();
      requestRef.current?.abort();
      requestRef.current = controller;
      const created = await apiClient.createVisitTemperatureSuggestion(quickRecord.id, { signal: controller.signal });
      if (!controller.signal.aborted && generation === generationRef.current) {
        setItems([created]);
        setMessage("温度建议已生成，请逐项核对后确认");
      }
    } catch (error) {
      if (generation === generationRef.current && error?.code !== "ABORTED" && error?.name !== "AbortError") setMessage(temperatureErrorMessage(error, "温度建议生成"));
    } finally {
      if (generation === generationRef.current) setPendingId(null);
    }
  }

  async function act(item, action) {
    const isCurrentItem = item?.visitId === visitId && item?.customerId === customerId;
    if (historyReadOnly || !isCurrentItem || !temperatureCanAct(item) || pendingId) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    setPendingId(item.id);
    setMessage("");
    try {
      requestRef.current?.abort();
      requestRef.current = controller;
      const outcome = action === "confirm"
        ? await apiClient.confirmVisitTemperatureSuggestion(item, { signal: controller.signal })
        : await apiClient.cancelVisitTemperatureSuggestion(item, { signal: controller.signal });
      if (!controller.signal.aborted && generation === generationRef.current) setItems((current) => current.map((candidate) => (
        candidate.id === item.id ? mergeTemperatureOutcome(candidate, outcome) : candidate
      )));
      const authoritativeCustomer = outcome.status === "conflict"
        ? outcome.currentCustomer
        : outcome.customer;
      if (!controller.signal.aborted && generation === generationRef.current && authoritativeCustomer) {
        onCustomerUpdated?.(authoritativeCustomer);
      }
      if (generation === generationRef.current) setMessage(outcome.status === "conflict"
        ? "此建议与当前数据不一致，已停止写回，请保留只读并重新核对拜访/客户数据"
        : action === "confirm" ? "已确认并写回客户温度" : "已取消该温度建议");
    } catch (error) {
      if (generation === generationRef.current && error?.status === 409) {
        try {
          const authoritative = await apiClient.getVisitTemperatureSuggestion(item.id, { signal: controller.signal });
          if (!controller.signal.aborted && generation === generationRef.current) {
            const authoritativeStatus = ["confirmed", "cancelled", "expired"].includes(authoritative.status)
              ? authoritative.status
              : "conflict";
            setItems((current) => current.map((candidate) => (
              candidate.id === item.id
                ? mergeTemperatureOutcome(candidate, { status: authoritativeStatus, suggestion: authoritative, writeback: false })
                : candidate
            )));
            setMessage(authoritativeStatus === "conflict"
              ? "此建议与当前数据不一致，已重新读取权威状态并停止写回，请重新核对拜访/客户数据"
              : authoritativeStatus === "confirmed"
                ? "此建议已在其他端确认，当前显示为只读结果"
                : authoritativeStatus === "cancelled"
                  ? "此建议已在其他端取消，当前显示为只读结果"
                  : "此建议已过期，当前显示为只读结果");
          }
        } catch (refreshError) {
          if (generation === generationRef.current && refreshError?.code !== "ABORTED" && refreshError?.name !== "AbortError") {
            setMessage(temperatureErrorMessage(refreshError, "温度建议状态刷新"));
          }
        }
      } else if (generation === generationRef.current && error?.code !== "ABORTED" && error?.name !== "AbortError") {
        setMessage(temperatureErrorMessage(error, action === "confirm" ? "温度建议确认" : "温度建议取消"));
      }
    } finally {
      if (generation === generationRef.current) setPendingId(null);
    }
  }

  return (
    <section className="temperature-suggestions-panel" data-testid="visit-temperature-suggestions">
      <div className="temperature-panel-head">
        <div>
          <span className="eyebrow">拜访温度</span>
          <h3>客户温度建议</h3>
          <p>建议只读展示拜访证据，确认后才会更新客户温度。</p>
        </div>
        <button className="ghost-button" type="button" onClick={() => void reload(requestRef.current?.signal)} disabled={loading || pendingId !== null}>
          <RefreshCw size={15} /> 刷新
        </button>
      </div>
      {message ? <p className="temperature-feedback" role="status">{message}</p> : null}
      {loading ? <p className="temperature-empty"><LoaderCircle className="state-spinner" size={16} /> 正在读取温度建议</p> : null}
      {!loading && items.length === 0 ? (
        <div className="temperature-empty">
          <Sparkles size={18} />
          <span>暂无拜访温度建议。已确认的拜访记录可生成一条建议。</span>
          {canGenerate ? <button className="primary-button" type="button" onClick={generate} disabled={pendingId !== null}>生成当前拜访建议</button> : null}
        </div>
      ) : null}
      {items.length > 0 ? (
        <div className="temperature-list">
          {items.map((item) => {
            const customerName = customers.find((customer) => customer.id === item.customerId)?.name ?? item.customerId;
            const actionable = !historyReadOnly && temperatureCanAct(item);
            return (
              <div className="temperature-ai-card" key={item.id} data-testid={`temperature-suggestion-${item.id}`}>
                <AiResultCard
                  result={temperatureSuggestionToAiCard(item, customerName)}
                  draftMode="readonly"
                  historyReadOnly={historyReadOnly || temperatureIsReadOnly(item)}
                  busy={pendingId !== null}
                  confirmLabel="确认此条"
                  cancelLabel="取消此条"
                  onConfirm={actionable ? () => void act(item, "confirm") : undefined}
                  onCancel={actionable ? () => void act(item, "cancel") : undefined}
                />
              </div>
            );
          })}
        </div>
      ) : null}
      {items.length > 0 && canGenerate ? <button className="ghost-button temperature-generate" type="button" onClick={generate} disabled={pendingId !== null}>为当前已确认拜访生成建议</button> : null}
      {selectedCustomer ? <span className="temperature-context">当前记录客户：{selectedCustomer.name}</span> : null}
    </section>
  );
}
