const CURSOR_FIELDS = new Set(["categoryIndex", "hospitalIndex", "page", "pageIndex", "branchIndex", "itemIndex"]);

export function normalizeCollectionProgress(value = []) {
  if (!Array.isArray(value) || value.length > 200) throw new TypeError("collectionProgress is invalid");
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((key) => !["sourceId", "configurationDigest", "cursor"].includes(key))) {
      throw new TypeError("collectionProgress item is invalid");
    }
    const sourceId = item.sourceId;
    if (typeof sourceId !== "string" || !sourceId.trim() || sourceId.length > 200
      || /[\u0000-\u001f\u007f-\u009f]/u.test(sourceId) || seen.has(sourceId)) {
      throw new TypeError("collectionProgress sourceId is invalid");
    }
    seen.add(sourceId);
    if (typeof item.configurationDigest !== "string" || !/^[0-9a-f]{64}$/u.test(item.configurationDigest)) {
      throw new TypeError("collectionProgress configurationDigest is invalid");
    }
    const cursor = item.cursor;
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)
      || Object.keys(cursor).length > CURSOR_FIELDS.size
      || Object.entries(cursor).some(([key, position]) => !CURSOR_FIELDS.has(key)
        || !Number.isSafeInteger(position) || position < 0 || position > 1_000_000)) {
      throw new TypeError("collectionProgress cursor is invalid");
    }
    return { sourceId, configurationDigest: item.configurationDigest, cursor: { ...cursor } };
  });
}
