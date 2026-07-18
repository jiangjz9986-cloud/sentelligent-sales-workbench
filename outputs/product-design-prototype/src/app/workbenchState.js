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
  "quickRecords",
  "solutionDocs",
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
  const source = bootstrap && typeof bootstrap === "object" ? bootstrap : {};
  const collections = Object.fromEntries(
    BUSINESS_COLLECTION_KEYS.map((key) => [
      key,
      Array.isArray(source[key]) ? source[key] : [],
    ]),
  );
  const hasBusinessRecords = BUSINESS_COLLECTION_KEYS.some(
    (key) => collections[key].length > 0,
  );

  return {
    status: hasBusinessRecords ? "ready" : "empty",
    ...collections,
    summary: source.summary ?? null,
    errorMessage: "",
    canRetry: false,
  };
}

export function incrementBootstrapAttempt(currentAttempt) {
  return Number.isInteger(currentAttempt) && currentAttempt >= 0 ? currentAttempt + 1 : 1;
}

export function assertBackendReady({ isEnabled, status }, operation = "执行此操作") {
  if (!isEnabled || status !== "connected") {
    throw new Error(`业务服务未连接，暂不能${operation}。请恢复连接后重试。`);
  }
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
