export function getBookkeepingCategoryCounts(items = [], entryType) {
  const matching = items.filter((item) => item.entryType === entryType);
  return {
    all: matching.length,
    active: matching.filter((item) => item.status === "active").length,
    archived: matching.filter((item) => item.status === "archived").length,
  };
}

export function filterBookkeepingCategories(items = [], {
  entryType,
  status = "active",
  query = "",
} = {}) {
  const normalizedQuery = String(query).trim().toLocaleLowerCase("zh-CN");
  return items.filter((item) => {
    if (item.entryType !== entryType) return false;
    if (status !== "all" && item.status !== status) return false;
    if (!normalizedQuery) return true;
    const searchable = [item.name, ...(item.subcategories ?? []), ...(item.aliases ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("zh-CN");
    return searchable.includes(normalizedQuery);
  });
}
