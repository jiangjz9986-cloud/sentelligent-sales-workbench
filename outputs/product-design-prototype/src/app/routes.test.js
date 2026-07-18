import assert from "node:assert/strict";
import { describe, it } from "node:test";

const routeModule = await import("./routes.js").catch(() => ({}));
const viteConfigModule = await import("../../vite.config.mjs").catch(() => ({}));

function requireFunction(module, name) {
  assert.equal(typeof module[name], "function", `${name} must be exported`);
  return module[name];
}

function expectedRoute(overrides = {}) {
  return {
    page: "overview",
    active: "overview",
    mode: "index",
    entityId: null,
    filters: {},
    readOnly: false,
    replace: false,
    ...overrides,
  };
}

const routeCases = [
  ["/overview", expectedRoute(), "/overview"],
  [
    "/quick-records",
    expectedRoute({ page: "quick-records", active: "quick", mode: "new" }),
    "/quick-records",
  ],
  [
    "/quick-records/record%20one",
    expectedRoute({
      page: "quick-records",
      active: "quick",
      mode: "history",
      entityId: "record one",
    }),
    "/quick-records/record%20one",
  ],
  [
    "/customers",
    expectedRoute({ page: "customers", active: "customer", mode: "list" }),
    "/customers",
  ],
  [
    "/customers/new",
    expectedRoute({ page: "customers", active: "customer", mode: "new" }),
    "/customers/new",
  ],
  [
    "/customers/customer-1",
    expectedRoute({
      page: "customers",
      active: "customer",
      mode: "detail",
      entityId: "customer-1",
    }),
    "/customers/customer-1",
  ],
  [
    "/customers/customer-1/edit",
    expectedRoute({
      page: "customers",
      active: "customer",
      mode: "edit",
      entityId: "customer-1",
    }),
    "/customers/customer-1/edit",
  ],
  [
    "/opportunities",
    expectedRoute({ page: "opportunities", active: "opportunity", mode: "list" }),
    "/opportunities",
  ],
  [
    "/opportunities/new",
    expectedRoute({ page: "opportunities", active: "opportunity", mode: "new" }),
    "/opportunities/new",
  ],
  [
    "/opportunities/opportunity-1",
    expectedRoute({
      page: "opportunities",
      active: "opportunity",
      mode: "detail",
      entityId: "opportunity-1",
    }),
    "/opportunities/opportunity-1",
  ],
  [
    "/opportunities/opportunity-1/edit",
    expectedRoute({
      page: "opportunities",
      active: "opportunity",
      mode: "edit",
      entityId: "opportunity-1",
    }),
    "/opportunities/opportunity-1/edit",
  ],
  [
    "/actions",
    expectedRoute({ page: "actions", active: "actions", mode: "list" }),
    "/actions",
  ],
  [
    "/actions/action-1",
    expectedRoute({
      page: "actions",
      active: "actions",
      mode: "detail",
      entityId: "action-1",
    }),
    "/actions/action-1",
  ],
  [
    "/actions/action-1/edit",
    expectedRoute({
      page: "actions",
      active: "actions",
      mode: "edit",
      entityId: "action-1",
    }),
    "/actions/action-1/edit",
  ],
  [
    "/weekly-reports",
    expectedRoute({ page: "weekly-reports", active: "weekly" }),
    "/weekly-reports",
  ],
  [
    "/risks",
    expectedRoute({ page: "risks", active: "risk", mode: "list" }),
    "/risks",
  ],
  [
    "/risks/risk-1",
    expectedRoute({ page: "risks", active: "risk", mode: "detail", entityId: "risk-1" }),
    "/risks/risk-1",
  ],
  [
    "/risks/risk-1/edit",
    expectedRoute({ page: "risks", active: "risk", mode: "edit", entityId: "risk-1" }),
    "/risks/risk-1/edit",
  ],
  [
    "/knowledge",
    expectedRoute({ page: "knowledge", active: "knowledge", mode: "list" }),
    "/knowledge",
  ],
  [
    "/knowledge/new",
    expectedRoute({ page: "knowledge", active: "knowledge", mode: "new" }),
    "/knowledge/new",
  ],
  [
    "/knowledge/knowledge-1",
    expectedRoute({
      page: "knowledge",
      active: "knowledge",
      mode: "detail",
      entityId: "knowledge-1",
    }),
    "/knowledge/knowledge-1",
  ],
  [
    "/knowledge/knowledge-1/edit",
    expectedRoute({
      page: "knowledge",
      active: "knowledge",
      mode: "edit",
      entityId: "knowledge-1",
    }),
    "/knowledge/knowledge-1/edit",
  ],
  ["/kanban", expectedRoute({ page: "kanban", active: "kanban" }), "/kanban"],
  [
    "/settings/weixin",
    expectedRoute({ page: "settings/weixin", active: "weixin" }),
    "/settings/weixin",
  ],
  [
    "/solutions",
    expectedRoute({ page: "solutions", active: "solution", mode: "list", readOnly: true }),
    "/solutions",
  ],
  [
    "/solutions/solution-1",
    expectedRoute({
      page: "solutions",
      active: "solution",
      mode: "detail",
      entityId: "solution-1",
      readOnly: true,
    }),
    "/solutions/solution-1",
  ],
];

describe("workbench route parser and builder", () => {
  it("maps every supported canonical URL to one stable route state", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");

    for (const [url, expected] of routeCases) {
      assert.deepEqual(parseWorkbenchRoute(url), expected, url);
    }
  });

  it("builds the canonical URL for every supported route state", () => {
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");

    for (const [, state, canonicalUrl] of routeCases) {
      assert.equal(buildWorkbenchUrl(state), canonicalUrl, JSON.stringify(state));
    }
  });

  it("round-trips safely encoded Unicode and URL-delimiter identifiers", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");
    const state = expectedRoute({
      page: "customers",
      active: "customer",
      mode: "detail",
      entityId: "客户 A?#%",
    });

    const url = buildWorkbenchUrl(state, { basePath: "/sentelligent/" });

    assert.equal(
      url,
      "/sentelligent/customers/%E5%AE%A2%E6%88%B7%20A%3F%23%25",
    );
    assert.deepEqual(
      parseWorkbenchRoute(url, { basePath: "/sentelligent/" }),
      state,
    );
  });

  it("preserves legal repeated query filters and emits them canonically", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");
    const parsed = parseWorkbenchRoute(
      "/customers?empty=&q=%E6%A3%AE%E7%89%B9&status=open&status=won&tag=sales+ai",
    );

    assert.deepEqual(parsed.filters, {
      empty: [""],
      q: ["森特"],
      status: ["open", "won"],
      tag: ["sales ai"],
    });
    assert.equal(parsed.replace, false);
    assert.equal(
      buildWorkbenchUrl(parsed),
      "/customers?empty=&q=%E6%A3%AE%E7%89%B9&status=open&status=won&tag=sales+ai",
    );
  });

  it("drops illegal or malformed filters and marks the URL for replacement", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");
    const parsed = parseWorkbenchRoute(
      "/customers?q=kept&bad.key=x&__proto__=x&broken=%ZZ",
    );

    assert.equal(parsed.page, "customers");
    assert.deepEqual(parsed.filters, { q: ["kept"] });
    assert.equal(parsed.replace, true);
  });

  it("falls back to overview for unknown, malformed, or ambiguous paths", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");
    const invalidUrls = [
      "/not-a-page",
      "/customers/customer-1/extra",
      "/customers//edit",
      "/customers/%ZZ",
      "/customers/%2Fetc",
      "/actions/new",
      "/solutions/solution-1/edit",
    ];

    for (const url of invalidUrls) {
      assert.deepEqual(
        parseWorkbenchRoute(url),
        expectedRoute({ replace: true }),
        url,
      );
    }
  });

  it("does not mistake a path outside the configured base for an app route", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");

    assert.deepEqual(
      parseWorkbenchRoute("/customers/customer-1", { basePath: "/sentelligent/" }),
      expectedRoute({ replace: true }),
    );
    assert.deepEqual(
      parseWorkbenchRoute("/sentelligent-other/customers", {
        basePath: "/sentelligent/",
      }),
      expectedRoute({ replace: true }),
    );
  });

  it("accepts the base root as an overview alias and requests its canonical replacement", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");

    assert.deepEqual(
      parseWorkbenchRoute("https://workbench.example/sentelligent/", {
        basePath: "/sentelligent/",
      }),
      expectedRoute({ replace: true }),
    );
  });

  it("accepts one trailing slash but marks it for canonical replacement", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");

    assert.deepEqual(
      parseWorkbenchRoute("/sentelligent/customers/?q=test", {
        basePath: "/sentelligent/",
      }),
      expectedRoute({
        page: "customers",
        active: "customer",
        mode: "list",
        filters: { q: ["test"] },
        replace: true,
      }),
    );
  });

  it("rejects route states that cannot produce an unambiguous URL", () => {
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");

    assert.throws(() => buildWorkbenchUrl({ page: "missing", mode: "index" }), /route/i);
    assert.throws(
      () => buildWorkbenchUrl({ page: "customers", mode: "detail", entityId: "" }),
      /entity/i,
    );
    assert.throws(
      () => buildWorkbenchUrl({ page: "customers", mode: "detail", entityId: "a/b" }),
      /entity/i,
    );
    assert.throws(
      () => buildWorkbenchUrl({ page: "actions", mode: "new" }),
      /mode/i,
    );
  });
});

describe("public base path", () => {
  it("normalizes the root and a deploy prefix deterministically", () => {
    const normalizeBasePath = requireFunction(routeModule, "normalizeBasePath");

    assert.equal(normalizeBasePath(), "/");
    assert.equal(normalizeBasePath(""), "/");
    assert.equal(normalizeBasePath("/"), "/");
    assert.equal(normalizeBasePath("sentelligent"), "/sentelligent/");
    assert.equal(normalizeBasePath(" /sentelligent// "), "/sentelligent/");
  });

  it("rejects base values that contain URL metadata or traversal", () => {
    const normalizeBasePath = requireFunction(routeModule, "normalizeBasePath");

    for (const value of [
      "https://example.com/sentelligent/",
      "/sentelligent/?tenant=one",
      "/sentelligent/#app",
      "/../sentelligent/",
      "/sentelligent/%2Fadmin/",
      "\\sentelligent\\",
    ]) {
      assert.throws(() => normalizeBasePath(value), /base path/i, value);
    }
  });

  it("uses the same normalization for Vite's default and production base", () => {
    const resolvePublicBasePath = requireFunction(
      viteConfigModule,
      "resolvePublicBasePath",
    );

    assert.equal(resolvePublicBasePath(), "/");
    assert.equal(resolvePublicBasePath("/sentelligent/"), "/sentelligent/");
    assert.equal(resolvePublicBasePath("sentelligent"), "/sentelligent/");
    assert.throws(() => resolvePublicBasePath("https://example.com/"), /base path/i);
  });
});
