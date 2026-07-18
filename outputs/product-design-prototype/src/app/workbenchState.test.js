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
    ];

    assert.deepEqual(
      salesDataImports(appSource).filter((name) => forbiddenImports.includes(name)),
      [],
    );
    assert.deepEqual(
      salesDataImports(pagesSource).filter((name) => forbiddenImports.includes(name)),
      [],
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
    assert.doesNotMatch(
      appSource,
      /data\.(customers|opportunities|actions|risks|knowledge)\.length\s*>\s*0/,
    );
  });
});
