function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validTimestamp(value) {
  const text = normalizedText(value);
  if (!text) return null;
  const timestamp = new Date(text);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function shortDate(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).format(timestamp).replaceAll("/", "-");
}

function dateTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

export function buildOpportunityTimeline(selected) {
  if (!selected || typeof selected !== "object") return [];

  const opportunityId = normalizedText(selected.id) || "opportunity";
  const sourceRecord = normalizedText(selected.sourceRecord);
  const createdAt = validTimestamp(selected.createdAt);
  const updatedAt = validTimestamp(selected.updatedAt);
  const items = [];

  if (createdAt) {
    items.push({
      id: `${opportunityId}-created`,
      date: shortDate(createdAt),
      title: "商机创建",
      description: `创建于 ${dateTime(createdAt)}`,
    });
  }

  if (sourceRecord || updatedAt) {
    const eventTimestamp = updatedAt ?? createdAt;
    const isSameAsCreated = createdAt
      && updatedAt
      && createdAt.getTime() === updatedAt.getTime();

    if (sourceRecord || !isSameAsCreated) {
      items.push({
        id: `${opportunityId}-${sourceRecord ? "source" : "updated"}`,
        date: eventTimestamp ? shortDate(eventTimestamp) : "来源",
        title: sourceRecord ? "来源记录" : "最近更新",
        description: sourceRecord || `更新于 ${dateTime(updatedAt)}`,
      });
    }
  }

  return items;
}
