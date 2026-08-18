export function createWeixinOutboxClient({
  repository,
  workerId = "weixin-worker",
  renderMessage,
  sendMessage,
} = {}) {
  if (!repository || typeof repository.leaseNext !== "function") throw new TypeError("repository is required");
  if (typeof renderMessage !== "function" || typeof sendMessage !== "function") throw new TypeError("renderMessage and sendMessage are required");
  return Object.freeze({
    async deliverNext() {
      const lease = repository.leaseNext({ workerId, renderMessage });
      if (!lease) return null;
      try {
        const result = await sendMessage({
          owner: lease.item.owner,
          conversationId: lease.item.conversationId,
          message: lease.message,
        });
        return { item: repository.ackSuccess(lease.item.id, { leaseToken: lease.leaseToken, providerMessageId: result?.providerMessageId ?? null }) };
      } catch {
        return { item: repository.ackFailure(lease.item.id, { leaseToken: lease.leaseToken, errorCode: "WEIXIN_SEND_FAILED" }) };
      }
    },
  });
}
