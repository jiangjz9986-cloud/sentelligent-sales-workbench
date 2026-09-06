// Pure two-way mapping between a visit itinerary and the travel-expense page's
// draft-prefill URL filters (v0.8.3 itinerary→expense link). Values ride the
// routes.js filter mechanism as single-element string arrays (≤512 chars, no
// control characters); the consumer fails closed on anything malformed so a
// hand-edited URL can never produce a broken drawer draft.

import { orderedVisitStops } from "./visitItineraryModel.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_PURPOSE_LENGTH = 100;
const MAX_REGION_LENGTH = 100;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRealDateOnly(value) {
  if (!DATE_ONLY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function purposeOf(item, stops) {
  const names = stops.map((stop) => cleanText(stop?.customerName)).filter(Boolean);
  if (names.length === 0) {
    return (cleanText(item?.title) || "拜访行程").slice(0, MAX_PURPOSE_LENGTH);
  }
  const joined = names.slice(0, 2).join("、");
  const suffix = names.length > 2 ? "等" : "";
  return `拜访 ${joined}${suffix}`.slice(0, MAX_PURPOSE_LENGTH);
}

export function expenseDraftFiltersFromItinerary(item) {
  const visitDate = cleanText(item?.visitDate);
  if (!isRealDateOnly(visitDate)) return null;

  const planStops = orderedVisitStops(item);
  const stops = planStops.length > 0
    ? planStops
    : Array.isArray(item?.request?.stops) ? item.request.stops : [];

  const filters = { draftDate: [visitDate] };
  const itineraryId = cleanText(item?.id);
  if (itineraryId) filters.draftItinerary = [itineraryId];
  const customerId = stops.map((stop) => cleanText(stop?.customerId)).find(Boolean);
  if (customerId) filters.draftCustomer = [customerId];
  filters.draftPurpose = [purposeOf(item, stops)];
  const region = stops.map((stop) => cleanText(stop?.city)).find(Boolean);
  if (region) filters.draftRegion = [region.slice(0, MAX_REGION_LENGTH)];
  return filters;
}

function filterValue(filters, key) {
  const values = filters?.[key];
  const value = Array.isArray(values) ? values[0] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

export function expenseDraftFromFilters(filters) {
  const occurredOn = filterValue(filters, "draftDate");
  if (!isRealDateOnly(occurredOn)) return null;
  return {
    occurredOn,
    itineraryId: filterValue(filters, "draftItinerary") || null,
    customerId: filterValue(filters, "draftCustomer") || null,
    purpose: filterValue(filters, "draftPurpose").slice(0, MAX_PURPOSE_LENGTH),
    region: filterValue(filters, "draftRegion").slice(0, MAX_REGION_LENGTH) || null,
  };
}
