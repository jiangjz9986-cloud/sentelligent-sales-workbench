import { useCallback, useMemo, useState } from "react";
import {
  appendMessage,
  mergeHistoryMessages,
  readSessionMessages,
  readStoredConversationId,
  shouldRefreshBootstrap,
  writeSessionMessages,
  writeStoredConversationId,
} from "../components/assistant/assistantChatModel.js";

function messageFromResponse(role, body) {
  const text = body?.text ?? body?.message ?? body?.question ?? "";
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    status: body?.status ?? "ok",
    at: new Date().toISOString(),
  };
}

export function useAssistantChat({
  api,
  account,
  onRefreshBootstrap,
  onRefreshOverview,
  toast,
}) {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState(() => readStoredConversationId(account));
  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const hydrate = useCallback(async () => {
    if (!api || !account) return;
    const storedConversationId = readStoredConversationId(account);
    if (storedConversationId) {
      setConversationId(storedConversationId);
      const local = readSessionMessages(account, storedConversationId);
      if (local.length > 0) {
        setMessages(local);
        return;
      }
      try {
        const history = await api.getAssistantHistory(storedConversationId);
        const merged = mergeHistoryMessages([], history.items);
        setMessages(merged);
        writeSessionMessages(account, storedConversationId, merged);
      } catch {
        setMessages([]);
      }
    }
  }, [account, api]);

  const persistMessages = useCallback((nextMessages, nextConversationId = conversationId) => {
    setMessages(nextMessages);
    if (account && nextConversationId) {
      writeSessionMessages(account, nextConversationId, nextMessages);
      writeStoredConversationId(account, nextConversationId);
    }
  }, [account, conversationId]);

  const handleOpen = useCallback(async () => {
    setOpen(true);
    await hydrate();
  }, [hydrate]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const applyResponse = useCallback((body, priorMessages) => {
    const assistantMessage = messageFromResponse("assistant", body);
    const nextMessages = appendMessage(priorMessages, assistantMessage);
    if (body?.status === "confirmation_required" && body?.actionId) {
      setPending({
        actionId: body.actionId,
        conversationId: body.conversationId ?? conversationId,
        toolName: body.toolName,
        risk: body.risk,
        card: body.card,
        text: body.text ?? assistantMessage.text,
      });
    } else {
      setPending(null);
      if (body?.status === "ok" && shouldRefreshBootstrap(body.toolName)) {
        onRefreshBootstrap?.();
        onRefreshOverview?.();
        toast?.({ tone: "success", title: "已更新", description: assistantMessage.text.slice(0, 120) });
      }
    }
    if (body?.conversationId) {
      setConversationId(body.conversationId);
      writeStoredConversationId(account, body.conversationId);
    }
    persistMessages(nextMessages, body?.conversationId ?? conversationId);
  }, [account, conversationId, onRefreshBootstrap, onRefreshOverview, persistMessages, toast]);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text || !api || busy) return;
    const userMessage = messageFromResponse("user", { text, status: "ok" });
    const priorMessages = appendMessage(messages, userMessage);
    persistMessages(priorMessages);
    setDraft("");
    setBusy(true);
    try {
      const body = await api.postAssistantChat({
        message: text,
        conversationId: conversationId ?? undefined,
      });
      applyResponse(body, priorMessages);
    } catch (error) {
      toast?.({ tone: "error", title: "发送失败", description: error.message });
      setPending(null);
    } finally {
      setBusy(false);
    }
  }, [api, applyResponse, busy, conversationId, draft, messages, persistMessages, toast]);

  const confirmPending = useCallback(async () => {
    if (!api || !pending || busy) return;
    setBusy(true);
    try {
      const body = await api.postAssistantConfirm({
        pendingActionId: pending.actionId,
        conversationId: pending.conversationId,
        intent: "confirm",
      });
      setPending(null);
      applyResponse(body, messages);
    } catch (error) {
      toast?.({ tone: "error", title: "确认失败", description: error.message });
    } finally {
      setBusy(false);
    }
  }, [api, applyResponse, busy, messages, pending, toast]);

  const cancelPending = useCallback(async () => {
    if (!api || !pending || busy) return;
    setBusy(true);
    try {
      const body = await api.postAssistantConfirm({
        pendingActionId: pending.actionId,
        conversationId: pending.conversationId,
        intent: "cancel",
      });
      setPending(null);
      applyResponse(body, messages);
    } catch (error) {
      toast?.({ tone: "error", title: "取消失败", description: error.message });
    } finally {
      setBusy(false);
    }
  }, [api, applyResponse, busy, messages, pending, toast]);

  return useMemo(() => ({
    open,
    messages,
    pending,
    draft,
    busy,
    setDraft,
    openChat: handleOpen,
    closeChat: handleClose,
    sendMessage,
    confirmPending,
    cancelPending,
  }), [
    busy,
    cancelPending,
    confirmPending,
    draft,
    handleClose,
    handleOpen,
    messages,
    open,
    pending,
    sendMessage,
  ]);
}
