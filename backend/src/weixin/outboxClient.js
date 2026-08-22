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
        // A correction/cancellation can supersede a queued item immediately
        // after it is leased. Re-check the fence before handing the rendered
        // message to the provider so the common race is discarded locally.
        if (typeof repository.isLeaseCurrent === "function"
          && !repository.isLeaseCurrent(lease.item.id, lease.leaseToken)) {
          return { item: repository.get?.(lease.item.id) ?? lease.item, superseded: true };
        }
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
