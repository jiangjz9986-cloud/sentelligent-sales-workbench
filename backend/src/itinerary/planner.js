import { enhanceItineraryOrderWithModel } from "../modelAnalysis.js";
import { AmapServiceError } from "../maps/amapClient.js";
import { buildVisitSchedule, optimizeVisitOrder } from "./optimizer.js";

const MAX_STOPS = 8;
const PRIORITIES = new Set(["low", "normal", "medium", "high"]);

function requiredText(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${path} is required`);
  return value.trim();
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function dateTime(value, path, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${path} must be a valid date-time`);
  return new Date(parsed).toISOString();
}

function optionalLocation(value, path) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must contain numeric lng and lat values`);
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("lng") || !keys.includes("lat")) {
    throw new TypeError(`${path} must contain only lng and lat values`);
  }
  const lng = Number(value.lng);
  const lat = Number(value.lat);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new TypeError(`${path} must contain numeric lng and lat values`);
  }
  return { lng, lat };
}

function cityMatches(expectedCity, geocode) {
  if (!expectedCity) return true;
  const expected = expectedCity.replace(/\s+/g, "").replace(/(?:特别行政区|自治州|地区|盟|市|区|县)$/u, "");
  if (!expected) return true;
  return [geocode.province, geocode.city, geocode.district, geocode.formattedAddress]
    .some((value) => String(value ?? "").replace(/\s+/g, "").includes(expected));
}

async function resolvePlace(place, amapClient) {
  if (!place.location) {
    return amapClient.geocode({ address: place.address, city: place.city ?? undefined });
  }
  if (typeof amapClient.reverseGeocode !== "function") {
    throw new TypeError("amapClient.reverseGeocode must be a function for browser-resolved locations");
  }
  const geocode = await amapClient.reverseGeocode({ location: place.location });
  if (!cityMatches(place.city, geocode)) {
    throw new AmapServiceError("AMAP_LOCATION_MISMATCH", "Resolved location does not match the requested city");
  }
  return { ...geocode, location: place.location };
}

function normalizeRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("itinerary request is required");
  if (!Array.isArray(input.stops) || input.stops.length < 1 || input.stops.length > MAX_STOPS) {
    throw new TypeError(`stops must contain between 1 and at most ${MAX_STOPS} visits`);
  }
  const ids = new Set();
  const stops = input.stops.map((stop, index) => {
    if (!stop || typeof stop !== "object" || Array.isArray(stop)) throw new TypeError(`stops[${index}] must be an object`);
    const id = requiredText(stop.id, `stops[${index}].id`);
    if (ids.has(id)) throw new TypeError("stop ids must be unique");
    ids.add(id);
    const priority = stop.priority ?? "normal";
    if (!PRIORITIES.has(priority)) throw new TypeError(`stops[${index}].priority is invalid`);
    const visitMinutes = Number(stop.visitMinutes);
    if (!Number.isSafeInteger(visitMinutes) || visitMinutes < 1 || visitMinutes > 480) {
      throw new TypeError(`stops[${index}].visitMinutes must be an integer between 1 and 480`);
    }
    return {
      id,
      customerId: optionalText(stop.customerId),
      customerName: requiredText(stop.customerName, `stops[${index}].customerName`),
      address: requiredText(stop.address, `stops[${index}].address`),
      city: optionalText(stop.city),
      priority,
      visitMinutes,
      appointmentAt: dateTime(stop.appointmentAt, `stops[${index}].appointmentAt`, { optional: true }),
      notes: optionalText(stop.notes),
      location: optionalLocation(stop.location, `stops[${index}].location`),
    };
  });
  return {
    title: optionalText(input.title) ?? "客户拜访行程",
    departureAddress: requiredText(input.departureAddress, "departureAddress"),
    departureCity: optionalText(input.departureCity),
    departureLocation: optionalLocation(input.departureLocation, "departureLocation"),
    departureAt: dateTime(input.departureAt, "departureAt"),
    stops,
  };
}

function deterministicEnhancement(baseline) {
  return {
    orderedStopIds: baseline.orderedStopIds,
    summary: "已按预约时间、客户优先级和预计行车时长生成拜访顺序。",
    advice: ["出发前再次确认预约时间和停车入口。"],
    source: "deterministic",
  };
}

function isGuardedOrder(candidate, baseline) {
  if (candidate.totals.lateMinutes > baseline.totals.lateMinutes) return false;
  const allowedDriveSeconds = baseline.totals.driveSeconds + Math.max(900, baseline.totals.driveSeconds * 0.2);
  return candidate.totals.driveSeconds <= allowedDriveSeconds;
}

function assertAmapClient(client) {
  for (const method of ["geocode", "drivingMatrix", "drivingRoute"]) {
    if (typeof client?.[method] !== "function") throw new TypeError(`amapClient.${method} must be a function`);
  }
}

export async function planVisitItinerary(input, {
  amapClient,
  modelConfig = {},
  fetchImpl,
  clock = () => new Date(),
  enhanceOrder = enhanceItineraryOrderWithModel,
} = {}) {
  const request = normalizeRequest(input);
  assertAmapClient(amapClient);

  const [departureGeocode, ...stopGeocodes] = await Promise.all([
    resolvePlace({
      address: request.departureAddress,
      city: request.departureCity,
      location: request.departureLocation,
    }, amapClient),
    ...request.stops.map((stop) => resolvePlace(stop, amapClient)),
  ]);
  const departure = {
    address: request.departureAddress,
    formattedAddress: departureGeocode.formattedAddress,
    location: departureGeocode.location,
  };
  const stops = request.stops.map((stop, index) => ({
    ...stop,
    formattedAddress: stopGeocodes[index].formattedAddress,
    location: stopGeocodes[index].location,
  }));
  const locations = [departure.location, ...stops.map((stop) => stop.location)];
  const matrix = await amapClient.drivingMatrix({ locations });
  const optimizerInput = {
    departureAt: request.departureAt,
    stops,
    durationMatrix: matrix.durations,
  };
  const baseline = optimizeVisitOrder(optimizerInput);
  const fallback = deterministicEnhancement(baseline);

  let enhanced = fallback;
  try {
    enhanced = await enhanceOrder(fallback, {
      departureAt: request.departureAt,
      stops: stops.map(({ location: _location, ...stop }) => stop),
      durationMatrix: matrix.durations,
      distanceMatrix: matrix.distances,
    }, modelConfig, { fetchImpl });
  } catch {
    enhanced = fallback;
  }

  let selectedSchedule = baseline;
  let selectedEnhancement = fallback;
  try {
    const candidate = buildVisitSchedule({ ...optimizerInput, orderedStopIds: enhanced.orderedStopIds });
    if (isGuardedOrder(candidate, baseline)) {
      selectedSchedule = candidate;
      selectedEnhancement = enhanced;
    }
  } catch {
    selectedSchedule = baseline;
    selectedEnhancement = fallback;
  }

  const stopById = new Map(stops.map((stop) => [stop.id, stop]));
  const orderedStops = selectedSchedule.orderedStopIds.map((id) => stopById.get(id));
  const route = await amapClient.drivingRoute({
    origin: departure.location,
    waypoints: orderedStops.slice(0, -1).map((stop) => stop.location),
    destination: orderedStops.at(-1).location,
  });

  return {
    generatedAt: clock().toISOString(),
    title: request.title,
    departureAt: request.departureAt,
    departure,
    stops,
    orderedStopIds: selectedSchedule.orderedStopIds,
    schedule: selectedSchedule.schedule,
    matrix,
    route,
    summary: selectedEnhancement.summary,
    advice: Array.isArray(selectedEnhancement.advice) ? selectedEnhancement.advice : [],
    optimization: {
      source: selectedEnhancement.source ?? "deterministic",
      baselineOrderedStopIds: baseline.orderedStopIds,
    },
    totals: {
      ...selectedSchedule.totals,
      distanceMeters: route.distanceMeters,
      routeDurationSeconds: route.durationSeconds,
      tollsCny: route.tollsCny,
      trafficLights: route.trafficLights,
    },
  };
}
