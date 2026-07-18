import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const stateModule = await import("./workbenchState.js").catch(() => ({}));

const collectionKeys = [
  "customers",
  "opportunities",
  "actions",
  "risks",
  "knowledge",
  "quickRecords",
  "solutionDocs",
];

function requireFunction(name) {
  assert.equal(typeof stateModule[name], "function", `${name} must be exported`);
  return stateModule[name];
}

function businessCollections(state) {
  return Object.fromEntries(collectionKeys.map((key) => [key, state[key]]));
}

function emptyCollections() {
  return Object.fromEntries(collectionKeys.map((key) => [key, []]));
}

function salesDataImports(source) {
  const importedNames = source.match(
    /import\s*\{([^}]*)\}\s*from\s*"[^"]*salesWorkbenchData\.js";/,
  )?.[1] ?? "";
  return importedNames
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

describe("workbench bootstrap state", () => {
  it("starts in an explicit loading state with no business records", () => {
    const createLoadingWorkbenchState = requireFunction("createLoadingWorkbenchState");

    assert.deepEqual(createLoadingWorkbenchState(), {
      status: "loading",
      ...emptyCollections(),
      summary: null,
      errorMessage: "",
      canRetry: false,
    });
  });

  it("keeps every valid empty backend collection empty", () => {
    const normalizeBootstrapData = requireFunction("normalizeBootstrapData");
    const bootstrap = {
      ...emptyCollections(),
      summary: { metrics: {} },
    };

    const state = normalizeBootstrapData(bootstrap);

    assert.equal(state.status, "empty");
    assert.deepEqual(businessCollections(state), emptyCollections());
    for (const key of collectionKeys) {
      assert.strictEqual(state[key], bootstrap[key], `${key} must not be replaced`);
    }
    assert.strictEqual(state.summary, bootstrap.summary);
    assert.equal(state.errorMessage, "");
    assert.equal(state.canRetry, false);
  });

  it("uses ready only when normalized bootstrap contains business records", () => {
    const normalizeBootstrapData = requireFunction("normalizeBootstrapData");
    const customer = { id: "customer-live", name: "真实客户" };

    const state = normalizeBootstrapData({
      ...emptyCollections(),
      customers: [customer],
      summary: null,
    });

    assert.equal(state.status, "ready");
    assert.deepEqual(state.customers, [customer]);
    assert.deepEqual(state.opportunities, []);
    assert.deepEqual(state.actions, []);
    assert.deepEqual(state.risks, []);
    assert.deepEqual(state.knowledge, []);
  });

  it("turns bootstrap failure into retryable error state without business records", () => {
    const createErrorWorkbenchState = requireFunction("createErrorWorkbenchState");

    const state = createErrorWorkbenchState(new Error("业务数据加载失败"));

    assert.equal(state.status, "error");
    assert.deepEqual(businessCollections(state), emptyCollections());
    assert.equal(state.summary, null);
    assert.equal(state.errorMessage, "业务数据加载失败");
    assert.equal(state.canRetry, true);
  });

  it("declares the complete loading-ready-empty-error lifecycle", () => {
    assert.deepEqual(
      stateModule.WORKBENCH_STATUSES,
      ["loading", "ready", "empty", "error"],
    );
  });

  it("increments bootstrap retry attempts through a pure helper", () => {
    const incrementBootstrapAttempt = requireFunction("incrementBootstrapAttempt");

    assert.equal(incrementBootstrapAttempt(0), 1);
    assert.equal(incrementBootstrapAttempt(4), 5);
    assert.equal(incrementBootstrapAttempt(-1), 1);
    assert.equal(incrementBootstrapAttempt("2"), 1);
  });

  it("accepts results only from the current non-aborted bootstrap generation", () => {
    const isCurrentBootstrapAttempt = requireFunction("isCurrentBootstrapAttempt");
    const activeSignal = new AbortController().signal;
    const aborted = new AbortController();
    aborted.abort();

    assert.equal(isCurrentBootstrapAttempt(3, 3, activeSignal), true);
    assert.equal(isCurrentBootstrapAttempt(4, 3, activeSignal), false);
    assert.equal(isCurrentBootstrapAttempt(3, 3, aborted.signal), false);
  });

  it("removes a deleted entity from the latest collection without dropping newer records", () => {
    const removeEntityById = requireFunction("removeEntityById");
    const latestCollection = [
      { id: "created-while-delete-was-pending", version: 1 },
      { id: "delete-me", version: 2 },
      { id: "keep-me", version: 4 },
    ];

    assert.deepEqual(removeEntityById(latestCollection, "delete-me"), [
      latestCollection[0],
      latestCollection[2],
    ]);
    assert.strictEqual(removeEntityById(latestCollection, "missing"), latestCollection);
  });

  it("rejects offline writes without mutating the loaded state", () => {
    const assertBackendReady = requireFunction("assertBackendReady");
    const normalizeBootstrapData = requireFunction("normalizeBootstrapData");
    const state = normalizeBootstrapData({
      ...emptyCollections(),
      customers: [{ id: "customer-live", name: "真实客户" }],
    });
    const before = structuredClone(state);

    assert.throws(
      () => assertBackendReady({ isEnabled: false, status: "offline" }, "保存客户"),
      /业务服务未连接/,
    );
    assert.deepEqual(state, before);
  });

  it("does not import static demo collections into production workbench state", () => {
    const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    const pagesSource = readFileSync(
      new URL("../features/salesWorkbench/pages.jsx", import.meta.url),
      "utf8",
    );
    const forbiddenImports = [
      "actionSeeds",
      "customers",
      "opportunities",
      "risks",
      "knowledgeItems",
      "quickRecords",
      "solutionDocs",
      "weeklyDays",
    ];

    assert.deepEqual(
      salesDataImports(appSource).filter((name) => forbiddenImports.includes(name)),
      [],
    );
    assert.deepEqual(
      salesDataImports(pagesSource).filter((name) => forbiddenImports.includes(name)),
      [],
    );
    assert.doesNotMatch(appSource, /normalizeLocal[A-Z]/);
    assert.doesNotMatch(pagesSource, /fallbackSuggestion|local-suggestion/);
    assert.doesNotMatch(
      pagesSource,
      /日照中医医院|胜利油田中心医院|黄岛区中医院|黄岛中心医院/,
    );
    assert.match(pagesSource, /\{item\.artifactType\}\s*\/\s*\{item\.status\}/);
    assert.doesNotMatch(pagesSource, /\{item\.type\}\s*\/\s*\{item\.source\}/);
  });

  it("does not embed demo customers in the opportunity timeline", () => {
    const primitivesSource = readFileSync(
      new URL("../components/primitives.jsx", import.meta.url),
      "utf8",
    );

    assert.match(
      primitivesSource,
      /export function Timeline\(\{\s*items\s*=\s*\[\]\s*\}\)/,
    );
    assert.doesNotMatch(
      primitivesSource,
      /日照中医医院|胜利油田中心医院|黄岛区中医院|黄岛中心医院/,
    );
  });

  it("wires loading, empty, error, and retry states into the workbench shell", () => {
    const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

    for (const testId of [
      "workbench-loading",
      "workbench-empty",
      "workbench-error",
      "bootstrap-retry",
    ]) {
      assert.match(appSource, new RegExp(`data-testid="${testId}"`));
    }
    assert.match(appSource, /setBootstrapAttempt\(incrementBootstrapAttempt\)/);
    assert.doesNotMatch(
      appSource,
      /data\.(customers|opportunities|actions|risks|knowledge)\.length\s*>\s*0/,
    );
  });

  it("applies every asynchronous deletion to the latest React collection state", () => {
    const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    for (const setter of [
      "setWorkbenchCustomers",
      "setWorkbenchOpportunities",
      "setWorkbenchKnowledge",
      "setWorkbenchActions",
      "setWorkbenchRisks",
    ]) {
      assert.match(
        appSource,
        new RegExp(`${setter}\\(\\(current\\) => removeEntityById\\(current, id\\)\\)`),
      );
    }
    assert.doesNotMatch(
      appSource,
      /const remaining(?:Customers|Opportunities|Knowledge|Actions|Risks)\s*=/,
    );
  });
});
