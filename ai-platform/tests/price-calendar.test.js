import assert from "node:assert/strict";
import { test } from "node:test";
import { priceAtAttempt, normalizePriceCalendar } from "../src/budgets/priceCalendar.js";
import { calculateCostMicro } from "../src/budgets/ledger.js";

const peak = { input_micro_per_1k: 3000, output_micro_per_1k: 9000, cached_input_micro_per_1k: 100, audio_micro_per_minute: 0, image_micro_per_page: 0 };
const calendar = {
  schemaVersion: "price-calendar-v1", timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5],
  peakWindows: [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1080 }],
  offPeakRates: { input_micro_per_1k: 1500, output_micro_per_1k: 4500, cached_input_micro_per_1k: 50, audio_micro_per_minute: 0, image_micro_per_page: 0 },
};

test("immutable price policy uses supplier-attempt time and Shanghai weekday boundaries", () => {
  const price = { ...peak, pricing_policy_json: JSON.stringify(calendar) };
  for (const [instant, tier] of [
    ["2026-09-10T00:59:59Z", "off-peak"], ["2026-09-10T01:00:00Z", "peak"],
    ["2026-09-10T04:00:00Z", "off-peak"], ["2026-09-10T06:00:00Z", "peak"],
    ["2026-09-10T10:00:00Z", "off-peak"], ["2026-09-12T02:00:00Z", "off-peak"],
  ]) assert.equal(priceAtAttempt(price, instant).pricingTier, tier);
  const usage = { inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 1000 };
  assert.equal(calculateCostMicro(usage, priceAtAttempt(price, "2026-09-10T02:00:00Z")).costMicro, 12100);
  assert.equal(calculateCostMicro(usage, priceAtAttempt(price, "2026-09-10T12:00:00Z")).costMicro, 6050);
  assert.equal(price.input_micro_per_1k, 3000);
  assert.throws(() => normalizePriceCalendar({ ...calendar, offPeakRates: { ...calendar.offPeakRates, input_micro_per_1k: 6000 } }, peak), /invalid/);
});
