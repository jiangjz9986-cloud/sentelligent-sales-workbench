const STORAGE_PREFIX = "sentelligent_assistant_messages_v1:";
const CONVERSATION_PREFIX = "sentelligent_assistant_conversation_v1:";

export function conversationStorageKey(account) {
  return `${CONVERSATION_PREFIX}${account}`;
}

export function messagesStorageKey(account, conversationId) {
  return `${STORAGE_PREFIX}${account}:${conversationId}`;
}

export function readStoredConversationId(account) {
  if (!account || typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(conversationStorageKey(account))
    ?? localStorage.getItem(conversationStorageKey(account));
}

export function writeStoredConversationId(account, conversationId) {
  if (!account || !conversationId) return;
  localStorage.setItem(conversationStorageKey(account), conversationId);
}

export function readSessionMessages(account, conversationId) {
  if (!account || !conversationId || typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(messagesStorageKey(account, conversationId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeSessionMessages(account, conversationId, messages) {
  if (!account || !conversationId || typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(messagesStorageKey(account, conversationId), JSON.stringify(messages));
}

export function mergeHistoryMessages(localMessages, remoteItems) {
  if (!Array.isArray(remoteItems) || remoteItems.length === 0) return localMessages;
  const remote = remoteItems.map((item) => ({
    id: `${item.role}-${item.at}`,
    role: item.role,
    text: item.text,
    status: item.status ?? "ok",
    at: item.at,
  }));
  if (!localMessages?.length) return remote;
  const seen = new Set(localMessages.map((item) => item.id));
  const merged = [...localMessages];
  for (const item of remote) {
    if (!seen.has(item.id)) merged.push(item);
  }
  return merged;
}

export function appendMessage(messages, message) {
  return [...(messages ?? []), message];
}

export function shouldRefreshBootstrap(toolName) {
  return [
    "action-risk.create",
    "action-risk.complete",
    "action-risk.defer",
    "action-risk.delete",
    "customer.create",
    "customer.update",
    "customer.delete",
    "opportunity.create",
    "opportunity.update",
    "opportunity.delete",
    "opportunity.update-stage",
    "opportunity.update-next",
  ].includes(toolName);
}
