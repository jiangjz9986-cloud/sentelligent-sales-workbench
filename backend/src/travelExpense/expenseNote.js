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
  purpose = null,
} = {}) {
  const date = validDate(occurredOn);
  if (!date) return null;
  const region = normalizedRegion(tripRegion);
  if (category === "lodging") {
    const nights = Number.isSafeInteger(lodgingNights) && lodgingNights > 0 ? lodgingNights : 1;
    return `${region ?? ""}出差住宿${nights}晚`;
  }
  const meal = MEAL_LABELS[category];
  if (meal) return `${monthDay(date)}${region ?? ""}出差${meal}`;
  const normalizedPurpose = typeof purpose === "string"
    ? purpose.normalize("NFKC").trim()
      .replace(/^(?:\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?\s*)?(?:[\p{Script=Han}]{2,8})?(?:出差|差旅)\s*/u, "")
      .replace(/^[，,。；;：:\s]+|[，,。；;：:\s]+$/gu, "")
    : "";
  if (!normalizedPurpose || normalizedPurpose.length > 80
    || /^(?:其他|其他费用|出差消费|差旅消费|出差用餐|差旅用餐|消费|支出|费用|付款|支付)$/u.test(normalizedPurpose)) return null;
  return `${monthDay(date)}${region ?? ""}出差${normalizedPurpose}`;
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
