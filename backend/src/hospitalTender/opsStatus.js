import { createHash } from "node:crypto";

export function hospitalTenderSourceStatus({ sources = [], customers = [] } = {}) {
  const observed = sources.filter((source) => ["healthy", "degraded", "error"].includes(source.status));
  const affected = observed.filter((source) => source.status !== "healthy");
  const sourceHealth = { total: observed.length, healthy: 0, degraded: 0, error: 0 };
  for (const source of observed) sourceHealth[source.status] += 1;
  const customerIds = new Map();
  for (const customer of customers) {
    for (const source of customer.tenderSources ?? []) {
      if (typeof source.url !== "string" || !source.url.trim()) continue;
      const digest = createHash("sha256").update(source.url.trim()).digest("hex").slice(0, 24);
      const id = `customer-url-${digest}`;
      if (!customerIds.has(id)) customerIds.set(id, new Set());
      customerIds.get(id).add(customer.id);
    }
  }
  const affectedSourceIds = affected.map((source) => source.sourceId).sort();
  const known = affectedSourceIds.every((id) => customerIds.has(id));
  const affectedCustomerCount = known
    ? new Set(affectedSourceIds.flatMap((id) => [...customerIds.get(id)])).size
    : null;
  return { sourceHealth, affectedSourceIds, affectedCustomerCount };
}
