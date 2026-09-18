const MEAL_LABELS = Object.freeze({
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
});

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function normalizedRegion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized && normalized.length <= 100 ? normalized : null;
}

function monthDay(value) {
  return `${Number(value.slice(5, 7))}.${Number(value.slice(8, 10))}`;
}

export function buildAutomaticTravelExpenseNote({
  occurredOn,
  category,
  tripRegion = null,
  lodgingNights = 1,
} = {}) {
  const date = validDate(occurredOn);
  if (!date) return null;
  const region = normalizedRegion(tripRegion);
  if (category === "lodging") {
    const nights = Number.isSafeInteger(lodgingNights) && lodgingNights > 0 ? lodgingNights : 1;
    return `${region ?? ""}出差住宿${nights}晚`;
  }
  const meal = MEAL_LABELS[category];
  if (!meal) return null;
  return `${monthDay(date)}${region ?? ""}出差${meal}`;
}

export function resolveTravelExpenseNote({
  notes,
  occurredOn,
  category,
  tripRegion = null,
  lodgingNights = 1,
} = {}) {
  if (typeof notes === "string" && notes.trim()) return notes.trim();
  return buildAutomaticTravelExpenseNote({
    occurredOn,
    category,
    tripRegion,
    lodgingNights,
  });
}
