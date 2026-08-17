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
  itineraries: Object.freeze({ active: "itinerary", defaultMode: "list", readOnly: false }),
  "travel-expenses": Object.freeze({ active: "expense", defaultMode: "index", readOnly: false }),
  "weekly-reports": Object.freeze({ active: "weekly", defaultMode: "index", readOnly: false }),
  risks: Object.freeze({ active: "risk", defaultMode: "list", readOnly: false }),
  knowledge: Object.freeze({ active: "knowledge", defaultMode: "list", readOnly: false }),
  kanban: Object.freeze({ active: "kanban", defaultMode: "index", readOnly: false }),
  "settings/weixin": Object.freeze({ active: "weixin", defaultMode: "index", readOnly: false }),
  "settings/shortcuts": Object.freeze({ active: "shortcut", defaultMode: "index", readOnly: false }),
  "settings/config": Object.freeze({ active: "settings", defaultMode: "index", readOnly: false }),
  "hospital-tenders": Object.freeze({ active: "hospital-tenders", defaultMode: "index", readOnly: true }),
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
  if (page === "customers" || page === "opportunities" || page === "knowledge" || page === "itineraries") {
    return matchEntityRoute(page, segments, { allowNew: true });
  }
  if (page === "actions" || page === "risks") {
    return matchEntityRoute(page, segments);
  }
  if (
    (page === "travel-expenses" || page === "weekly-reports" || page === "kanban" || page === "hospital-tenders") &&
    segments.length === 1
  ) {
    return routeState(page, "index");
  }
  if (page === "settings" && segments.length === 2 && segments[1] === "weixin") {
    return routeState("settings/weixin", "index");
  }
  if (page === "settings" && segments.length === 2 && segments[1] === "shortcuts") {
    return routeState("settings/shortcuts", "index");
  }
  if (page === "settings" && segments.length === 2 && segments[1] === "config") {
    return routeState("settings/config", "index");
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
    Object.getPrototypeOf(values) !== Array.prototype
  ) {
    throw new TypeError(`Invalid query filter: ${key}`);
  }

  const ownKeys = Reflect.ownKeys(values);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(values, "length");
  const length = lengthDescriptor?.value;
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    ownKeys.length !== length + 1
  ) {
    throw new TypeError(`Invalid query filter: ${key}`);
  }

  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const propertyKey = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(values, propertyKey);
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      !isLegalFilterValue(descriptor.value)
    ) {
      throw new TypeError(`Invalid query filter: ${key}`);
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
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
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new TypeError("Invalid route URL");
  }
  return splitPathSearchHash(value);
}

function canonicalizeRawPathname(pathname) {
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
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
  const encodedSegments = rawSegments.map((segment) =>
    encodeURIComponent(decodePathSegment(segment, "route segment")),
  );
  const trailingSlash = pathname.length > 1 && pathname.endsWith("/") ? "/" : "";
  return encodedSegments.length ? `/${encodedSegments.join("/")}${trailingSlash}` : "/";
}

function rawLocationParts(input) {
  if (typeof input === "string") {
    return rawPartsFromString(input);
  }

  if (
    !input ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError("Invalid route URL");
  }

  const parts = Object.assign(Object.create(null), {
    pathname: "/",
    search: "",
    hash: "",
  });
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !Object.hasOwn(parts, key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      throw new TypeError("Invalid route URL");
    }
    parts[key] = descriptor.value;
  }

  if (
    (parts.search && !parts.search.startsWith("?")) ||
    (parts.hash && !parts.hash.startsWith("#"))
  ) {
    throw new TypeError("Invalid route URL");
  }
  return parts;
}

function extractLocation(input) {
  const raw = rawLocationParts(input);
  const pathname = canonicalizeRawPathname(raw.pathname);
  return {
    pathname,
    originalPathSearch: `${raw.pathname}${raw.search}`,
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
  const { pathname, originalPathSearch, rawSearch, rawHash } = extracted;

  let rawRelativePath = relativePath(pathname, normalizedBasePath);
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
      canonicalUrl !== originalPathSearch,
  };
}

function snapshotRouteState(route) {
  if (
    !route ||
    typeof route !== "object" ||
    Object.getPrototypeOf(route) !== Object.prototype
  ) {
    throw new TypeError("Invalid route state");
  }

  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(route)) {
    const descriptor = Object.getOwnPropertyDescriptor(route, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("Invalid route state");
    }
    snapshot[key] = descriptor.value;
  }
  if (!Object.hasOwn(snapshot, "page")) throw new TypeError("Invalid route page");
  return snapshot;
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
  const { page } = route;
  if (!Object.hasOwn(PAGE_META, page)) throw new TypeError("Invalid route page");
  const meta = PAGE_META[page];
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
  if (page === "customers" || page === "opportunities" || page === "knowledge" || page === "itineraries") {
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
    (page === "travel-expenses" || page === "weekly-reports" || page === "kanban" || page === "settings/weixin" || page === "settings/shortcuts" || page === "settings/config" || page === "hospital-tenders") &&
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
  const state = snapshotRouteState(route);
  const pathname = `${normalizedBasePath}${pathForRoute(state)}`;
  return `${pathname}${filterSearch(state.filters)}`;
}
