const MAX_STOPS = 8;
const PRIORITIES = new Set(["low", "normal", "medium", "high"]);
const STATUSES = new Set(["planned", "completed", "cancelled"]);

function defaultId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  throw new Error("A cryptographic random source is required for itinerary stops");
}

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function requiredText(value, name) {
  const normalized = text(value).trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function optionalText(value) {
  const normalized = text(value).trim();
  return normalized || null;
}

function isoDateTime(value, name) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid date-time`);
  return date.toISOString();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function formatVisitDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) return null;
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  return {
    isoDate: `${year}-${pad(month)}-${pad(day)}`,
    month: `${month}月`,
    day: pad(day),
    weekday,
    label: `${year}年${month}月${day}日 ${weekday}`,
  };
}

export function localDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join("T");
}

function emptyStop(createId) {
  return {
    id: requiredText(createId(), "generated stop id"),
    customerId: null,
    customerName: "",
    address: "",
    city: "",
    priority: "normal",
    visitMinutes: 60,
    appointmentAt: "",
    notes: "",
  };
}

export function createEmptyVisitItineraryDraft({ createId = defaultId } = {}) {
  return {
    id: null,
    version: null,
    title: "",
    visitDate: "",
    status: "planned",
    departureAddress: "",
    departureCity: "",
    departureAt: "",
    stops: [emptyStop(createId)],
  };
}

export function addVisitStop(draft, { createId = defaultId } = {}) {
  if (!Array.isArray(draft?.stops)) throw new TypeError("draft stops are required");
  if (draft.stops.length >= MAX_STOPS) throw new TypeError(`An itinerary supports at most ${MAX_STOPS} stops`);
  return { ...draft, stops: [...draft.stops, emptyStop(createId)] };
}

export function applyCustomerToVisitStop(draft, stopId, customer) {
  if (!customer?.id || !customer?.name) throw new TypeError("A customer selection is required");
  let matched = false;
  const stops = draft.stops.map((stop) => {
    if (stop.id !== stopId) return stop;
    matched = true;
    return {
      ...stop,
      customerId: customer.id,
      customerName: customer.name,
      address: text(customer.address).trim() || stop.address,
      city: text(customer.city).trim() || stop.city,
    };
  });
  if (!matched) throw new TypeError("The selected itinerary stop was not found");
  return { ...draft, stops };
}

export function draftFromVisitItinerary(item) {
  if (!item?.request || !Array.isArray(item.request.stops)) {
    throw new TypeError("Saved itinerary request is invalid");
  }
  return {
    id: item.id,
    version: item.version,
    title: text(item.request.title ?? item.title),
    visitDate: text(item.request.visitDate ?? item.visitDate),
    status: item.request.status ?? item.status ?? "planned",
    departureAddress: text(item.request.departureAddress),
    departureCity: text(item.request.departureCity),
    departureAt: localDateTimeInput(item.request.departureAt),
    stops: item.request.stops.map((stop) => ({
      id: text(stop.id),
      customerId: stop.customerId ?? null,
      customerName: text(stop.customerName),
      address: text(stop.address),
      city: text(stop.city),
      priority: stop.priority ?? "normal",
      visitMinutes: Number(stop.visitMinutes ?? 60),
      appointmentAt: localDateTimeInput(stop.appointmentAt),
      notes: text(stop.notes),
    })),
  };
}

export function visitItineraryPayload(draft) {
  if (!Array.isArray(draft?.stops) || draft.stops.length < 1 || draft.stops.length > MAX_STOPS) {
    throw new TypeError(`An itinerary must contain between 1 and at most ${MAX_STOPS} stops`);
  }
  const visitDate = requiredText(draft.visitDate, "visitDate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) throw new TypeError("visitDate is invalid");
  const status = draft.status ?? "planned";
  if (!STATUSES.has(status)) throw new TypeError("status is invalid");
  return {
    title: requiredText(draft.title, "title"),
    visitDate,
    status,
    departureAddress: requiredText(draft.departureAddress, "departureAddress"),
    departureCity: optionalText(draft.departureCity),
    departureAt: isoDateTime(draft.departureAt, "departureAt"),
    stops: draft.stops.map((stop, index) => {
      const priority = stop.priority ?? "normal";
      if (!PRIORITIES.has(priority)) throw new TypeError(`stops[${index}].priority is invalid`);
      const visitMinutes = Number(stop.visitMinutes);
      if (!Number.isSafeInteger(visitMinutes) || visitMinutes < 1 || visitMinutes > 480) {
        throw new TypeError(`stops[${index}].visitMinutes is invalid`);
      }
      return {
        id: requiredText(stop.id, `stops[${index}].id`),
        customerId: optionalText(stop.customerId),
        customerName: requiredText(stop.customerName, `stops[${index}].customerName`),
        address: requiredText(stop.address, `stops[${index}].address`),
        city: optionalText(stop.city),
        priority,
        visitMinutes,
        appointmentAt: stop.appointmentAt ? isoDateTime(stop.appointmentAt, `stops[${index}].appointmentAt`) : null,
        notes: optionalText(stop.notes),
      };
    }),
  };
}

export function orderedVisitStops(item) {
  const stops = Array.isArray(item?.plan?.stops) ? item.plan.stops : [];
  const orderedIds = Array.isArray(item?.plan?.orderedStopIds) ? item.plan.orderedStopIds : [];
  const stopById = new Map(stops.map((stop) => [stop.id, stop]));
  const scheduleById = new Map((item?.plan?.schedule ?? []).map((entry) => [entry.stopId, entry]));
  return orderedIds
    .map((id) => stopById.get(id))
    .filter(Boolean)
    .map((stop) => ({ ...stop, schedule: scheduleById.get(stop.id) ?? null }));
}

export function buildAmapNavigationUrl(stop) {
  const location = stop?.location;
  if (!Number.isFinite(location?.lng) || !Number.isFinite(location?.lat)) {
    throw new TypeError("A geocoded stop is required for navigation");
  }
  const url = new URL("https://uri.amap.com/navigation");
  url.searchParams.set("to", `${location.lng},${location.lat},${text(stop.customerName || stop.formattedAddress).trim()}`);
  url.searchParams.set("mode", "car");
  url.searchParams.set("policy", "1");
  url.searchParams.set("src", "sentelligent-sales-workbench");
  url.searchParams.set("coordinate", "gaode");
  url.searchParams.set("callnative", "0");
  return url.toString();
}

export function visitItineraryMatches(item, query) {
  const normalized = text(query).trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return true;
  const values = [
    item?.title,
    item?.visitDate,
    item?.status,
    item?.request?.departureAddress,
    ...(item?.request?.stops ?? []).flatMap((stop) => [stop.customerName, stop.address, stop.city]),
  ];
  return values.some((value) => text(value).toLocaleLowerCase("zh-CN").includes(normalized));
}
