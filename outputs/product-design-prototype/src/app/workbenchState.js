export const WORKBENCH_STATUSES = Object.freeze([
  "loading",
  "ready",
  "empty",
  "error",
]);

const BUSINESS_COLLECTION_KEYS = Object.freeze([
  "customers",
  "opportunities",
  "actions",
  "risks",
  "knowledge",
]);

function emptyBusinessCollections() {
  return Object.fromEntries(BUSINESS_COLLECTION_KEYS.map((key) => [key, []]));
}

export function createLoadingWorkbenchState() {
  return {
    status: "loading",
    ...emptyBusinessCollections(),
    summary: null,
    errorMessage: "",
    canRetry: false,
  };
}

export function normalizeBootstrapData(bootstrap = {}) {
  const collections = Object.fromEntries(
    BUSINESS_COLLECTION_KEYS.map((key) => [
      key,
      Array.isArray(bootstrap[key]) ? bootstrap[key] : [],
    ]),
  );
  const hasBusinessRecords = BUSINESS_COLLECTION_KEYS.some(
    (key) => collections[key].length > 0,
  );

  return {
    status: hasBusinessRecords ? "ready" : "empty",
    ...collections,
    summary: bootstrap.summary ?? null,
    errorMessage: "",
    canRetry: false,
  };
}

export function createErrorWorkbenchState(error) {
  return {
    status: "error",
    ...emptyBusinessCollections(),
    summary: null,
    errorMessage: String(error?.message ?? "").trim() || "业务数据加载失败，请稍后重试。",
    canRetry: true,
  };
}
