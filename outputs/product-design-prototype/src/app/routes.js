const ROUTE_ORIGIN = "https://workbench.invalid";
const RESERVED_FILTER_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED_ENTITY_IDS = new Set(["new", "edit"]);
const FILTER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

const PAGE_META = Object.freeze({
  overview: Object.freeze({ active: "overview", defaultMode: "index", readOnly: false }),
  "quick-records": Object.freeze({ active: "quick", defaultMode: "new", readOnly: false }),
  customers: Object.freeze({ active: "customer", defaultMode: "list", readOnly: false }),
  opportunities: Object.freeze({ active: "opportunity", defaultMode: "list", readOnly: false }),
  actions: Object.freeze({ active: "actions", defaultMode: "list", readOnly: false }),
  "weekly-reports": Object.freeze({ active: "weekly", defaultMode: "index", readOnly: false }),
  risks: Object.freeze({ active: "risk", defaultMode: "list", readOnly: false }),
  knowledge: Object.freeze({ active: "knowledge", defaultMode: "list", readOnly: false }),
  kanban: Object.freeze({ active: "kanban", defaultMode: "index", readOnly: false }),
  "settings/weixin": Object.freeze({ active: "weixin", defaultMode: "index", readOnly: false }),
  solutions: Object.freeze({ active: "solution", defaultMode: "list", readOnly: true }),
});

function assertSafeDecodedSegment(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\ufffd") ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function decodePathSegment(rawSegment, label = "route segment") {
  try {
    return assertSafeDecodedSegment(decodeURIComponent(rawSegment), label);
  } catch (error) {
    if (error instanceof URIError) throw new TypeError(`Invalid ${label}`);
    throw error;
  }
}

function encodeEntityId(entityId) {
  const value = assertSafeDecodedSegment(entityId, "entity id");
  if (RESERVED_ENTITY_IDS.has(value)) throw new TypeError("Invalid entity id");
  return encodeURIComponent(value);
}

export function normalizeBasePath(basePath = "/") {
  if (basePath == null || basePath === "") return "/";
  if (typeof basePath !== "string") throw new TypeError("Invalid base path");
  if (CONTROL_CHARACTER_PATTERN.test(basePath)) throw new TypeError("Invalid base path");

  const value = basePath.trim();
  if (value === "") return "/";
  if (
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    throw new TypeError("Invalid base path");
  }

  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  const rawSegments = withLeadingSlash.split("/").filter(Boolean);
  if (rawSegments.length === 0) return "/";

  const encodedSegments = rawSegments.map((segment) =>
    encodeURIComponent(decodePathSegment(segment, "base path segment")),
  );
  const normalized = `/${encodedSegments.join("/")}/`;
  if (normalized.length > 1024) throw new TypeError("Invalid base path");
  return normalized;
}

function routeState(page, mode, entityId = null, filters = {}, replace = false) {
  const meta = PAGE_META[page];
  return {
    page,
    active: meta.active,
    mode,
    entityId,
    filters,
    readOnly: meta.readOnly,
    replace,
  };
}

function overviewFallback() {
  return routeState("overview", "index", null, {}, true);
}

function matchEntityRoute(page, segments, { allowNew = false, detailMode = "detail" } = {}) {
  if (segments.length === 1) return routeState(page, PAGE_META[page].defaultMode);
  if (allowNew && segments.length === 2 && segments[1] === "new") {
    return routeState(page, "new");
  }
  if (
    segments.length === 2 &&
    !RESERVED_ENTITY_IDS.has(segments[1])
  ) {
    return routeState(page, detailMode, segments[1]);
  }
  if (
    segments.length === 3 &&
    segments[2] === "edit" &&
    !RESERVED_ENTITY_IDS.has(segments[1])
  ) {
    return routeState(page, "edit", segments[1]);
  }
  return null;
}

function matchRoute(segments) {
  if (segments.length === 0) return routeState("overview", "index");

  const [page] = segments;
  if (page === "overview" && segments.length === 1) {
    return routeState("overview", "index");
  }
  if (page === "quick-records") {
    if (segments.length === 1) return routeState(page, "new");
    if (segments.length === 2 && !RESERVED_ENTITY_IDS.has(segments[1])) {
      return routeState(page, "history", segments[1]);
    }
    return null;
  }
  if (page === "customers" || page === "opportunities" || page === "knowledge") {
    return matchEntityRoute(page, segments, { allowNew: true });
  }
  if (page === "actions" || page === "risks") {
    return matchEntityRoute(page, segments);
  }
  if (
    (page === "weekly-reports" || page === "kanban") &&
    segments.length === 1
  ) {
    return routeState(page, "index");
  }
  if (page === "settings" && segments.length === 2 && segments[1] === "weixin") {
    return routeState("settings/weixin", "index");
  }
  if (page === "solutions") {
    if (segments.length === 1) return routeState(page, "list");
    if (segments.length === 2 && !RESERVED_ENTITY_IDS.has(segments[1])) {
      return routeState(page, "detail", segments[1]);
    }
  }
  return null;
}

function decodeQueryComponent(rawValue) {
  try {
    const value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    if (value.includes("\ufffd")) throw new TypeError("Invalid query filter");
    return value;
  } catch (error) {
    if (error instanceof URIError) throw new TypeError("Invalid query filter");
    throw error;
  }
}

function isLegalFilterKey(key) {
  return FILTER_KEY_PATTERN.test(key) && !RESERVED_FILTER_KEYS.has(key.toLowerCase());
}

function isLegalFilterValue(value) {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    !value.includes("\ufffd") &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function parseFilters(search) {
  if (!search) return { filters: {}, invalid: false };
  const body = search.startsWith("?") ? search.slice(1) : search;
  if (!body) return { filters: {}, invalid: true };

  const entries = [];
  let invalid = false;
  for (const pair of body.split("&")) {
    if (!pair) {
      invalid = true;
      continue;
    }

    const separatorIndex = pair.indexOf("=");
    const rawKey = separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : pair.slice(separatorIndex + 1);
    try {
      const key = decodeQueryComponent(rawKey);
      const value = decodeQueryComponent(rawValue);
      if (!isLegalFilterKey(key) || !isLegalFilterValue(value)) {
        invalid = true;
        continue;
      }
      entries.push([key, value]);
      if (separatorIndex === -1) invalid = true;
    } catch {
      invalid = true;
    }
  }

  entries.sort(([left], [right]) => left.localeCompare(right, "en"));
  const filters = {};
  for (const [key, value] of entries) {
    if (!Object.hasOwn(filters, key)) filters[key] = [];
    filters[key].push(value);
  }
  return { filters, invalid };
}

function plainFilterEntries(filters) {
  if (
    typeof filters !== "object" ||
    filters === null ||
    Object.getPrototypeOf(filters) !== Object.prototype
  ) {
    throw new TypeError("Invalid query filters");
  }

  const ownKeys = Reflect.ownKeys(filters);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError("Invalid query filters");
  }

  return ownKeys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(filters, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Invalid query filters");
    }
    return [key, descriptor.value];
  });
}

function assertFilterValues(values, key) {
  if (
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype ||
    values.length === 0 ||
    Object.keys(values).length !== values.length
  ) {
    throw new TypeError(`Invalid query filter: ${key}`);
  }

  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index) || !isLegalFilterValue(values[index])) {
      throw new TypeError(`Invalid query filter: ${key}`);
    }
  }
  return values;
}

function filterSearch(filters = {}) {
  const entries = plainFilterEntries(filters).sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  );

  const params = new URLSearchParams();
  for (const [key, values] of entries) {
    if (!isLegalFilterKey(key)) throw new TypeError(`Invalid query filter: ${key}`);
    for (const value of assertFilterValues(values, key)) {
      params.append(key, value);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function splitPathSearchHash(value) {
  const hashIndex = value.indexOf("#");
  const hash = hashIndex === -1 ? "" : value.slice(hashIndex);
  const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const searchIndex = beforeHash.indexOf("?");
  const search = searchIndex === -1 ? "" : beforeHash.slice(searchIndex);
  const pathname = searchIndex === -1 ? beforeHash : beforeHash.slice(0, searchIndex);
  return { pathname: pathname || "/", search, hash };
}

function rawPartsFromString(value) {
  const schemeMatch = value.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//);
  const hasAuthority = Boolean(schemeMatch) || value.startsWith("//");
  if (!hasAuthority) return splitPathSearchHash(value);

  const authorityStart = schemeMatch ? schemeMatch[0].length : 2;
  const afterAuthorityStart = value.slice(authorityStart);
  const boundaryIndex = afterAuthorityStart.search(/[/?#]/);
  const authority =
    boundaryIndex === -1
      ? afterAuthorityStart
      : afterAuthorityStart.slice(0, boundaryIndex);
  if (
    !authority ||
    authority.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(authority)
  ) {
    throw new TypeError("Invalid route URL");
  }

  if (boundaryIndex === -1) return { pathname: "/", search: "", hash: "" };
  const remainder = afterAuthorityStart.slice(boundaryIndex);
  return splitPathSearchHash(remainder.startsWith("/") ? remainder : `/${remainder}`);
}

function assertRawPathname(pathname) {
  if (
    typeof pathname !== "string" ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    pathname.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(pathname)
  ) {
    throw new TypeError("Invalid route URL");
  }

  const rawSegments = (pathname || "/").split("/");
  if (pathname.startsWith("/")) rawSegments.shift();
  if (pathname.endsWith("/") && rawSegments.at(-1) === "") rawSegments.pop();
  if (rawSegments.some((segment) => segment === "")) {
    throw new TypeError("Invalid route URL");
  }
  for (const segment of rawSegments) decodePathSegment(segment, "route segment");
}

function rawLocationParts(input) {
  if (input instanceof URL) {
    return {
      source: input.href,
      pathname: input.pathname,
      search: input.search,
      hash: input.hash,
    };
  }
  if (input && typeof input === "object") {
    const pathname = input.pathname === undefined ? "/" : input.pathname;
    const search = input.search === undefined ? "" : input.search;
    const hash = input.hash === undefined ? "" : input.hash;
    if (
      typeof pathname !== "string" ||
      typeof search !== "string" ||
      typeof hash !== "string" ||
      (search && !search.startsWith("?")) ||
      (hash && !hash.startsWith("#"))
    ) {
      throw new TypeError("Invalid route URL");
    }
    return {
      source: `${pathname}${search}${hash}`,
      pathname,
      search,
      hash,
    };
  }

  const source = String(input ?? "/");
  return { source, ...rawPartsFromString(source) };
}

function extractLocation(input) {
  const raw = rawLocationParts(input);
  assertRawPathname(raw.pathname);
  return {
    location: new URL(raw.source, ROUTE_ORIGIN),
    rawSearch: raw.search,
    rawHash: raw.hash,
  };
}

function relativePath(pathname, basePath) {
  if (!pathname.startsWith("/")) return null;
  if (basePath === "/") return pathname.slice(1);

  const baseWithoutTrailingSlash = basePath.slice(0, -1);
  if (pathname === baseWithoutTrailingSlash || pathname === basePath) return "";
  if (!pathname.startsWith(basePath)) return null;
  return pathname.slice(basePath.length);
}

export function parseWorkbenchRoute(input, { basePath = "/" } = {}) {
  let extracted;
  let normalizedBasePath;
  try {
    normalizedBasePath = normalizeBasePath(basePath);
    extracted = extractLocation(input);
  } catch {
    return overviewFallback();
  }
  const { location, rawSearch, rawHash } = extracted;

  let rawRelativePath = relativePath(location.pathname, normalizedBasePath);
  if (rawRelativePath == null) return overviewFallback();

  const hadTrailingSlash = rawRelativePath.length > 0 && rawRelativePath.endsWith("/");
  if (hadTrailingSlash) rawRelativePath = rawRelativePath.slice(0, -1);

  let segments;
  try {
    segments = rawRelativePath
      ? rawRelativePath.split("/").map((segment) => decodePathSegment(segment))
      : [];
  } catch {
    return overviewFallback();
  }

  const matched = matchRoute(segments);
  if (!matched) return overviewFallback();

  const { filters, invalid: invalidFilters } = parseFilters(rawSearch);
  const state = { ...matched, filters };
  const canonicalUrl = buildWorkbenchUrl(state, { basePath: normalizedBasePath });
  return {
    ...state,
    replace:
      hadTrailingSlash ||
      invalidFilters ||
      Boolean(rawHash) ||
      canonicalUrl !== `${location.pathname}${location.search}`,
  };
}

function assertCanonicalRouteMetadata(route, meta) {
  if (route.active !== undefined && route.active !== meta.active) {
    throw new TypeError("Invalid route active state");
  }
  if (route.readOnly !== undefined && route.readOnly !== meta.readOnly) {
    throw new TypeError("Invalid route read-only state");
  }
}

function assertNoEntityId(route) {
  if (route.entityId !== undefined && route.entityId !== null) {
    throw new TypeError("Invalid entity id for route mode");
  }
}

function pathForRoute(route) {
  if (!route || typeof route !== "object") throw new TypeError("Invalid route state");
  const { page } = route;
  const meta = PAGE_META[page];
  if (!meta) throw new TypeError("Invalid route page");
  assertCanonicalRouteMetadata(route, meta);
  const mode = route.mode === undefined ? meta.defaultMode : route.mode;

  if (page === "overview" && mode === "index") {
    assertNoEntityId(route);
    return "overview";
  }
  if (page === "quick-records") {
    if (mode === "new") {
      assertNoEntityId(route);
      return page;
    }
    if (mode === "history") return `${page}/${encodeEntityId(route.entityId)}`;
    throw new TypeError("Invalid route mode");
  }
  if (page === "customers" || page === "opportunities" || page === "knowledge") {
    if (mode === "list") {
      assertNoEntityId(route);
      return page;
    }
    if (mode === "new") {
      assertNoEntityId(route);
      return `${page}/new`;
    }
    if (mode === "detail") return `${page}/${encodeEntityId(route.entityId)}`;
    if (mode === "edit") return `${page}/${encodeEntityId(route.entityId)}/edit`;
    throw new TypeError("Invalid route mode");
  }
  if (page === "actions" || page === "risks") {
    if (mode === "list") {
      assertNoEntityId(route);
      return page;
    }
    if (mode === "detail") return `${page}/${encodeEntityId(route.entityId)}`;
    if (mode === "edit") return `${page}/${encodeEntityId(route.entityId)}/edit`;
    throw new TypeError("Invalid route mode");
  }
  if (
    (page === "weekly-reports" || page === "kanban" || page === "settings/weixin") &&
    mode === "index"
  ) {
    assertNoEntityId(route);
    return page;
  }
  if (page === "solutions") {
    if (mode === "list") {
      assertNoEntityId(route);
      return page;
    }
    if (mode === "detail") return `${page}/${encodeEntityId(route.entityId)}`;
    throw new TypeError("Invalid route mode");
  }
  throw new TypeError("Invalid route mode");
}

export function buildWorkbenchUrl(route, { basePath = "/" } = {}) {
  const normalizedBasePath = normalizeBasePath(basePath);
  const pathname = `${normalizedBasePath}${pathForRoute(route)}`;
  return `${pathname}${filterSearch(route.filters)}`;
}
