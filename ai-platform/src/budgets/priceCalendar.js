const RATE_FIELDS = ["input_micro_per_1k", "output_micro_per_1k", "cached_input_micro_per_1k", "audio_micro_per_minute", "image_micro_per_page"];

export function normalizePriceCalendar(value, peakPrice) {
  if (value === null || value === undefined) return null;
  const invalid = () => { throw Object.assign(new Error("invalid immutable price calendar"), { code: "invalid_price_calendar" }); };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["schemaVersion", "timeZone", "weekdays", "peakWindows", "offPeakRates"].includes(key))
    || value.schemaVersion !== "price-calendar-v1" || value.timeZone !== "Asia/Shanghai"
    || !Array.isArray(value.weekdays) || value.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    || !Array.isArray(value.peakWindows) || value.peakWindows.length < 1 || value.peakWindows.length > 4
    || !value.offPeakRates || Object.keys(value.offPeakRates).some((key) => !RATE_FIELDS.includes(key))) invalid();
  for (const window of value.peakWindows) {
    if (!window || Object.keys(window).some((key) => !["startMinute", "endMinute"].includes(key))
      || !Number.isInteger(window.startMinute) || !Number.isInteger(window.endMinute)
      || window.startMinute < 0 || window.endMinute > 1440 || window.startMinute >= window.endMinute) invalid();
  }
  for (const key of RATE_FIELDS) {
    if (!Number.isSafeInteger(value.offPeakRates[key]) || value.offPeakRates[key] < 0
      || value.offPeakRates[key] > Number(peakPrice[key] ?? 0)) invalid();
  }
  return JSON.parse(JSON.stringify(value));
}

export function priceAtAttempt(price, at) {
  if (!price?.pricing_policy_json) return price;
  const calendar = normalizePriceCalendar(JSON.parse(price.pricing_policy_json), price);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: calendar.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const peak = calendar.weekdays.includes(day) && calendar.peakWindows.some((window) => minute >= window.startMinute && minute < window.endMinute);
  return { ...price, ...(!peak ? calendar.offPeakRates : {}), pricingTier: peak ? "peak" : "off-peak" };
}
