const AMAP_ORIGIN = "https://restapi.amap.com";
const MAX_ROUTE_LOCATIONS = 9;
const MAX_RESPONSE_BYTES = 512 * 1024;

async function readBoundedResponseText(response) {
  const contentLength = response?.headers?.get?.("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
    try { await response?.body?.cancel?.(); } catch {}
    throw new Error("response too large");
  }
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(String(text ?? ""), "utf8") > MAX_RESPONSE_BYTES) throw new Error("response too large");
    return String(text ?? "");
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("invalid response");
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error("response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export class AmapServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AmapServiceError";
    this.code = code;
  }
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function positiveInteger(value, name) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function finiteNumber(value, name, { minimum = -Infinity, maximum = Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new AmapServiceError("AMAP_INVALID_RESPONSE", `Amap returned an invalid ${name}`);
  }
  return parsed;
}

function normalizeLocation(value, name = "location") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must contain numeric lng and lat values`);
  }
  const lng = Number(value.lng);
  const lat = Number(value.lat);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new TypeError(`${name} must contain numeric lng and lat values`);
  }
  return { lng, lat };
}

function parseLocation(value, name = "location") {
  const [lng, lat, ...rest] = String(value ?? "").split(",");
  if (rest.length > 0 || lng === undefined || lat === undefined) {
    throw new AmapServiceError("AMAP_INVALID_RESPONSE", `Amap returned an invalid ${name}`);
  }
  return {
    lng: finiteNumber(lng, `${name} longitude`, { minimum: -180, maximum: 180 }),
    lat: finiteNumber(lat, `${name} latitude`, { minimum: -90, maximum: 90 }),
  };
}

function formatLocation(value) {
  const normalized = normalizeLocation(value);
  return `${normalized.lng},${normalized.lat}`;
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function componentString(value) {
  if (Array.isArray(value)) return safeString(value.find((item) => safeString(item)));
  return safeString(value);
}

function normalizePolyline(steps) {
  const points = [];
  for (const step of steps) {
    for (const rawPoint of String(step?.polyline ?? "").split(";")) {
      if (!rawPoint.trim()) continue;
      const point = parseLocation(rawPoint, "route polyline");
      const previous = points.at(-1);
      if (!previous || previous.lng !== point.lng || previous.lat !== point.lat) {
        points.push(point);
      }
    }
  }
  return points;
}

function serviceError(code, message) {
  return new AmapServiceError(code, message);
}

export function createAmapClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const credential = requiredText(apiKey, "AMAP_WEB_SERVICE_KEY");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const requestTimeoutMs = positiveInteger(timeoutMs, "AMAP_TIMEOUT_MS");

  async function request(pathname, params) {
    const url = new URL(pathname, AMAP_ORIGIN);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    url.searchParams.set("key", credential);

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof AmapServiceError) throw error;
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw serviceError("AMAP_TIMEOUT", "Amap service request timed out");
      }
      throw serviceError("AMAP_NETWORK_ERROR", "Amap service request failed");
    }

    if (!response?.ok) {
      throw serviceError("AMAP_HTTP_ERROR", "Amap service request failed");
    }

    let body;
    try {
      body = JSON.parse(await readBoundedResponseText(response));
    } catch {
      throw serviceError("AMAP_INVALID_RESPONSE", "Amap returned an invalid response");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw serviceError("AMAP_INVALID_RESPONSE", "Amap returned an invalid response");
    }
    if (String(body.status) !== "1") {
      throw serviceError("AMAP_PROVIDER_ERROR", "Amap service rejected the request");
    }
    return body;
  }

  async function geocode({ address, city } = {}) {
    const body = await request("/v3/geocode/geo", {
      address: requiredText(address, "address"),
      city: safeString(city) || undefined,
      output: "json",
    });
    const match = Array.isArray(body.geocodes) ? body.geocodes[0] : null;
    if (!match) throw serviceError("AMAP_NO_RESULT", "No matching location was found");

    return {
      formattedAddress: safeString(match.formatted_address),
      province: safeString(match.province),
      city: safeString(match.city),
      district: safeString(match.district),
      adcode: safeString(match.adcode),
      location: parseLocation(match.location, "geocode location"),
    };
  }

  async function reverseGeocode({ location } = {}) {
    const normalizedLocation = normalizeLocation(location);
    const body = await request("/v3/geocode/regeo", {
      location: formatLocation(normalizedLocation),
      extensions: "base",
      output: "json",
    });
    const match = body.regeocode;
    if (!match || typeof match !== "object" || Array.isArray(match)) {
      throw serviceError("AMAP_NO_RESULT", "No matching location was found");
    }
    const component = match.addressComponent;
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      throw serviceError("AMAP_INVALID_RESPONSE", "Amap returned an invalid reverse geocode");
    }

    return {
      formattedAddress: safeString(match.formatted_address),
      province: componentString(component.province),
      city: componentString(component.city),
      district: componentString(component.district),
      adcode: componentString(component.adcode),
      location: normalizedLocation,
    };
  }

  async function drivingMatrix({ locations } = {}) {
    if (!Array.isArray(locations) || locations.length < 2 || locations.length > MAX_ROUTE_LOCATIONS) {
      throw new TypeError(`locations must contain between 2 and ${MAX_ROUTE_LOCATIONS} items`);
    }
    const normalizedLocations = locations.map((item, index) => normalizeLocation(item, `locations[${index}]`));
    const origins = normalizedLocations.map(formatLocation).join("|");
    const destinationResults = await Promise.all(normalizedLocations.map((destination) => request("/v3/distance", {
      origins,
      destination: formatLocation(destination),
      type: 1,
      output: "json",
    })));
    const distances = Array.from({ length: locations.length }, () => Array(locations.length));
    const durations = Array.from({ length: locations.length }, () => Array(locations.length));

    destinationResults.forEach((body, destinationIndex) => {
      if (!Array.isArray(body.results) || body.results.length !== locations.length) {
        throw serviceError("AMAP_INVALID_RESPONSE", "Amap returned an incomplete distance matrix");
      }
      for (const [fallbackIndex, item] of body.results.entries()) {
        const providerIndex = Number(item?.origin_id);
        const originIndex = Number.isInteger(providerIndex) && providerIndex >= 1
          ? providerIndex - 1
          : fallbackIndex;
        if (originIndex < 0 || originIndex >= locations.length || distances[originIndex][destinationIndex] !== undefined) {
          throw serviceError("AMAP_INVALID_RESPONSE", "Amap returned an invalid distance matrix");
        }
        distances[originIndex][destinationIndex] = finiteNumber(item?.distance, "distance", { minimum: 0 });
        durations[originIndex][destinationIndex] = finiteNumber(item?.duration, "duration", { minimum: 0 });
      }
    });

    return { distances, durations };
  }

  async function drivingRoute({ origin, destination, waypoints = [] } = {}) {
    const normalizedOrigin = normalizeLocation(origin, "origin");
    const normalizedDestination = normalizeLocation(destination, "destination");
    if (!Array.isArray(waypoints) || waypoints.length + 2 > MAX_ROUTE_LOCATIONS) {
      throw new TypeError(`route must contain between 2 and ${MAX_ROUTE_LOCATIONS} locations`);
    }
    const normalizedWaypoints = waypoints.map((item, index) => normalizeLocation(item, `waypoints[${index}]`));
    const body = await request("/v5/direction/driving", {
      origin: formatLocation(normalizedOrigin),
      destination: formatLocation(normalizedDestination),
      waypoints: normalizedWaypoints.map(formatLocation).join(";") || undefined,
      strategy: 32,
      show_fields: "cost,navi,polyline",
      output: "json",
    });
    const path = Array.isArray(body.route?.paths) ? body.route.paths[0] : null;
    if (!path) throw serviceError("AMAP_NO_ROUTE", "No driving route was found");
    const rawSteps = Array.isArray(path.steps) ? path.steps : [];

    return {
      distanceMeters: finiteNumber(path.distance, "route distance", { minimum: 0 }),
      durationSeconds: finiteNumber(path.cost?.duration ?? path.duration, "route duration", { minimum: 0 }),
      tollsCny: finiteNumber(path.cost?.tolls ?? path.tolls ?? 0, "route tolls", { minimum: 0 }),
      trafficLights: finiteNumber(path.cost?.traffic_lights ?? path.traffic_lights ?? 0, "traffic light count", { minimum: 0 }),
      polyline: normalizePolyline(rawSteps),
      steps: rawSteps.map((step) => ({
        instruction: safeString(step?.instruction),
        roadName: safeString(step?.road_name ?? step?.road),
        distanceMeters: finiteNumber(step?.distance ?? 0, "step distance", { minimum: 0 }),
        durationSeconds: finiteNumber(step?.cost?.duration ?? step?.duration ?? 0, "step duration", { minimum: 0 }),
      })),
    };
  }

  return { geocode, reverseGeocode, drivingMatrix, drivingRoute };
}
