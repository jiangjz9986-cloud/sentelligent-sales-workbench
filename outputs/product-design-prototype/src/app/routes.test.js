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
    "/travel-expenses",
    expectedRoute({ page: "travel-expenses", active: "expense", mode: "index" }),
    "/travel-expenses",
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
    "/hospital-tenders",
    expectedRoute({ page: "hospital-tenders", active: "hospital-tenders", readOnly: true }),
    "/hospital-tenders",
  ],
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
  [
    "/itineraries",
    expectedRoute({ page: "itineraries", active: "itinerary", mode: "list" }),
    "/itineraries",
  ],
  [
    "/itineraries/new",
    expectedRoute({ page: "itineraries", active: "itinerary", mode: "new" }),
    "/itineraries/new",
  ],
  [
    "/itineraries/itinerary-1",
    expectedRoute({ page: "itineraries", active: "itinerary", mode: "detail", entityId: "itinerary-1" }),
    "/itineraries/itinerary-1",
  ],
  [
    "/itineraries/itinerary-1/edit",
    expectedRoute({ page: "itineraries", active: "itinerary", mode: "edit", entityId: "itinerary-1" }),
    "/itineraries/itinerary-1/edit",
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

  it("rejects raw and encoded traversal in root-relative string paths", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");
    const traversalCases = [
      ["/customers/../actions", {}],
      ["/customers/%2e%2e/actions", {}],
      ["/%2E/customers", {}],
      ["/outside/../sentelligent/customers", { basePath: "/sentelligent/" }],
      ["/outside/%2E%2E/sentelligent/customers", { basePath: "/sentelligent/" }],
    ];

    for (const [input, options] of traversalCases) {
      assert.deepEqual(
        parseWorkbenchRoute(input, options),
        expectedRoute({ replace: true }),
        typeof input === "string" ? input : JSON.stringify(input),
      );
    }
  });

  it("rejects internal empty path segments before URL normalization", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");

    for (const url of [
      "/customers//customer-1",
      "/customers///customer-1",
      "/sentelligent//customers",
    ]) {
      assert.deepEqual(
        parseWorkbenchRoute(url, {
          basePath: url.startsWith("/sentelligent") ? "/sentelligent/" : "/",
        }),
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
      parseWorkbenchRoute(
        {
          pathname: "/sentelligent/",
          search: "",
          hash: "",
        },
        {
          basePath: "/sentelligent/",
        },
      ),
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

  it("matches a safely encoded base prefix after canonicalizing path segments", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");

    assert.deepEqual(
      parseWorkbenchRoute("/%73entelligent/customers", {
        basePath: "/sentelligent/",
      }),
      expectedRoute({
        page: "customers",
        active: "customer",
        mode: "list",
        replace: true,
      }),
    );
  });

  it("rejects every complete URL string and normalized URL instance", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");

    for (const input of [
      "customers",
      "https:customers",
      "https:/customers",
      "https:../customers",
      "//workbench.invalid/customers",
      "https://sales.example.com/customers",
      "https://workbench.invalid/customers",
      new URL("https://sales.example.com/customers"),
      new URL("https://workbench.invalid/customers"),
      new URL("https://workbench.invalid/customers/../actions"),
    ]) {
      assert.deepEqual(
        parseWorkbenchRoute(input),
        expectedRoute({ replace: true }),
        String(input),
      );
    }
  });

  it("accepts only plain location snapshots with own enumerable data fields", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");

    assert.deepEqual(
      parseWorkbenchRoute({ pathname: "/customers" }),
      expectedRoute({ page: "customers", active: "customer", mode: "list" }),
    );
    assert.deepEqual(
      parseWorkbenchRoute({
        pathname: "/customers",
        search: "?q=safe",
        hash: "",
      }),
      expectedRoute({
        page: "customers",
        active: "customer",
        mode: "list",
        filters: { q: ["safe"] },
      }),
    );

    let getterCalls = 0;
    const ownGetter = { search: "", hash: "" };
    Object.defineProperty(ownGetter, "pathname", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "/customers";
      },
    });
    const inheritedGetter = Object.create({
      get pathname() {
        getterCalls += 1;
        return "/customers";
      },
    });
    const customPrototype = Object.assign(Object.create({ custom: true }), {
      pathname: "/customers",
      search: "",
      hash: "",
    });
    const hiddenPathname = { search: "", hash: "" };
    Object.defineProperty(hiddenPathname, "pathname", {
      configurable: true,
      enumerable: false,
      value: "/customers",
      writable: true,
    });

    for (const input of [
      ownGetter,
      inheritedGetter,
      customPrototype,
      hiddenPathname,
      { pathname: undefined, search: "?q=must-not-survive", hash: "" },
    ]) {
      assert.deepEqual(
        parseWorkbenchRoute(input),
        expectedRoute({ replace: true }),
      );
    }
    assert.equal(getterCalls, 0);
  });

  it("marks raw query controls invalid before URL strips them", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");

    for (const control of ["\t", "\n", "\r"]) {
      const parsed = parseWorkbenchRoute(
        `/customers?q=kept&broken=left${control}right&status=open`,
      );
      assert.deepEqual(
        parsed,
        expectedRoute({
          page: "customers",
          active: "customer",
          mode: "list",
          filters: { q: ["kept"], status: ["open"] },
          replace: true,
        }),
        JSON.stringify(control),
      );
    }
  });

  it("rejects C1 controls in parsed path and query data", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");

    for (const url of [
      "/customers/customer%C2%80one",
      "/customers/customer%C2%85one",
      "/customers/customer%C2%9Fone",
    ]) {
      assert.deepEqual(
        parseWorkbenchRoute(url),
        expectedRoute({ replace: true }),
        url,
      );
    }

    assert.deepEqual(
      parseWorkbenchRoute("/customers?q=kept&status=bad%C2%85value"),
      expectedRoute({
        page: "customers",
        active: "customer",
        mode: "list",
        filters: { q: ["kept"] },
        replace: true,
      }),
    );
    assert.deepEqual(
      parseWorkbenchRoute(`/customers?q=left\u009fright`),
      expectedRoute({
        page: "customers",
        active: "customer",
        mode: "list",
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

  it("defaults only an undefined mode and rejects null", () => {
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");

    assert.equal(buildWorkbenchUrl({ page: "customers", mode: undefined }), "/customers");
    assert.equal(buildWorkbenchUrl({ page: "customers" }), "/customers");
    assert.throws(
      () => buildWorkbenchUrl({ page: "customers", mode: null }),
      /mode/i,
    );
  });

  it("rejects stale entity identifiers on routes that do not address an entity", () => {
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");
    const invalidStates = [
      { page: "overview", mode: "index", entityId: "stale" },
      { page: "quick-records", mode: "new", entityId: "stale" },
      { page: "customers", mode: "list", entityId: "stale" },
      { page: "customers", mode: "new", entityId: "stale" },
      { page: "weekly-reports", mode: "index", entityId: "stale" },
      { page: "settings/weixin", mode: "index", entityId: "stale" },
      { page: "solutions", mode: "list", entityId: "stale" },
    ];

    for (const state of invalidStates) {
      assert.throws(() => buildWorkbenchUrl(state), /entity/i, JSON.stringify(state));
    }
  });

  it("rejects contradictory canonical active and read-only metadata", () => {
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");

    assert.throws(
      () => buildWorkbenchUrl({ page: "solutions", mode: "list", readOnly: false }),
      /read.?only/i,
    );
    assert.throws(
      () => buildWorkbenchUrl({ page: "customers", mode: "list", readOnly: true }),
      /read.?only/i,
    );
    assert.throws(
      () => buildWorkbenchUrl({ page: "customers", mode: "list", active: "actions" }),
      /active/i,
    );
    assert.equal(
      buildWorkbenchUrl({
        page: "solutions",
        mode: "list",
        active: "solution",
        readOnly: true,
      }),
      "/solutions",
    );
  });

  it("accepts only plain filter records containing non-empty string arrays", () => {
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");
    const inheritedFilters = Object.create({ q: ["inherited"] });
    const nullPrototypeFilters = Object.create(null);
    nullPrototypeFilters.q = ["value"];

    for (const filters of [
      new Date(),
      new Map([["q", ["value"]]]),
      inheritedFilters,
      nullPrototypeFilters,
      { q: [] },
      { q: "value" },
    ]) {
      assert.throws(
        () => buildWorkbenchUrl({ page: "customers", mode: "list", filters }),
        /filter/i,
      );
    }

    assert.equal(
      buildWorkbenchUrl({
        page: "customers",
        mode: "list",
        filters: { q: ["value"], status: ["open", "won"] },
      }),
      "/customers?q=value&status=open&status=won",
    );
  });

  it("snapshots filter arrays from own enumerable data descriptors", () => {
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");
    let getterCalls = 0;
    const accessorValues = ["safe"];
    Object.defineProperty(accessorValues, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? "safe" : "bad\u0085value";
      },
    });

    const sparseValues = [];
    sparseValues.length = 1;
    const extendedValues = ["safe"];
    extendedValues.extra = "unexpected";
    const hiddenValues = ["safe"];
    Object.defineProperty(hiddenValues, "0", {
      configurable: true,
      enumerable: false,
      value: "safe",
      writable: true,
    });

    for (const values of [accessorValues, sparseValues, extendedValues, hiddenValues]) {
      assert.throws(
        () =>
          buildWorkbenchUrl({
            page: "customers",
            mode: "list",
            filters: { q: values },
          }),
        /filter/i,
      );
    }
    assert.equal(getterCalls, 0);
  });

  it("accepts route state only from own enumerable data descriptors", () => {
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");
    let getterCalls = 0;
    const accessorRoute = { mode: "list" };
    Object.defineProperty(accessorRoute, "page", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "customers";
      },
    });

    for (const route of [
      Object.create({ page: "customers", mode: "list" }),
      Object.assign(Object.create({ mode: "list" }), { page: "customers" }),
      accessorRoute,
    ]) {
      assert.throws(() => buildWorkbenchUrl(route), /route/i);
    }
    assert.equal(getterCalls, 0);

    assert.equal(
      buildWorkbenchUrl({
        page: "customers",
        mode: "list",
        active: "customer",
        readOnly: false,
        filters: { q: ["safe"] },
      }),
      "/customers?q=safe",
    );
  });

  it("rejects C1 controls when building entity, filter, and base paths", () => {
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");
    const normalizeBasePath = requireFunction(routeModule, "normalizeBasePath");

    for (const control of ["\u0080", "\u0085", "\u009f"]) {
      assert.throws(
        () =>
          buildWorkbenchUrl({
            page: "customers",
            mode: "detail",
            entityId: `customer${control}one`,
          }),
        /entity/i,
      );
      assert.throws(
        () =>
          buildWorkbenchUrl({
            page: "customers",
            mode: "list",
            filters: { q: [`left${control}right`] },
          }),
        /filter/i,
      );
      assert.throws(() => normalizeBasePath(`/sent${control}elligent/`), /base path/i);
    }
  });

  it("strictly round-trips every canonical route state", () => {
    const parseWorkbenchRoute = requireFunction(routeModule, "parseWorkbenchRoute");
    const buildWorkbenchUrl = requireFunction(routeModule, "buildWorkbenchUrl");

    for (const [, state] of routeCases) {
      assert.deepEqual(parseWorkbenchRoute(buildWorkbenchUrl(state)), state);
    }
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
      "/sentelligent/%C2%85admin/",
      "\t/sentelligent/\n",
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
