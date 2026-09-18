import assert from "node:assert/strict";
import { test } from "node:test";
import { priceAtAttempt, normalizePriceCalendar } from "../src/budgets/priceCalendar.js";
import { calculateCostMicro } from "../src/budgets/ledger.js";
import {
  DEEPSEEK_FLASH_PRICE_CALENDAR,
  DEEPSEEK_FLASH_PRICING_MICRO_CNY_PER_1K,
} from "../../shared/deepseekContract.mjs";

const peak = {
  input_micro_per_1k: DEEPSEEK_FLASH_PRICING_MICRO_CNY_PER_1K.peak.input,
  output_micro_per_1k: DEEPSEEK_FLASH_PRICING_MICRO_CNY_PER_1K.peak.output,
  cached_input_micro_per_1k: DEEPSEEK_FLASH_PRICING_MICRO_CNY_PER_1K.peak.cachedInput,
  audio_micro_per_minute: 0,
  image_micro_per_page: 0,
};
const calendar = structuredClone(DEEPSEEK_FLASH_PRICE_CALENDAR);

test("immutable price policy uses supplier-attempt time and Shanghai weekday boundaries", () => {
  const price = { ...peak, pricing_policy_json: JSON.stringify(calendar) };
  for (const [instant, tier] of [
    ["2026-09-10T00:59:59Z", "off-peak"], ["2026-09-10T01:00:00Z", "peak"],
    ["2026-09-10T04:00:00Z", "off-peak"], ["2026-09-10T06:00:00Z", "peak"],
    ["2026-09-10T10:00:00Z", "off-peak"], ["2026-09-12T02:00:00Z", "off-peak"],
  ]) assert.equal(priceAtAttempt(price, instant).pricingTier, tier);
  const usage = { inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 1000 };
  assert.equal(calculateCostMicro(usage, priceAtAttempt(price, "2026-09-10T02:00:00Z")).costMicro, 10040);
  assert.equal(calculateCostMicro(usage, priceAtAttempt(price, "2026-09-10T12:00:00Z")).costMicro, 5020);
  assert.equal(price.input_micro_per_1k, 2000);
  assert.equal(calendar.offPeakRates.input_micro_per_1k, 1000);
  assert.equal(calendar.offPeakRates.output_micro_per_1k, 4000);
  assert.equal(calendar.offPeakRates.cached_input_micro_per_1k, 20);
  assert.throws(() => normalizePriceCalendar({ ...calendar, offPeakRates: { ...calendar.offPeakRates, input_micro_per_1k: 3000 } }, peak), /invalid/);
});
