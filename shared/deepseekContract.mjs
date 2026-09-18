export const DEEPSEEK_FLASH_MODEL = "deepseek-flash";
export const DEEPSEEK_PRICING_SOURCE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";

// DeepSeek publishes prices per million tokens. The platform ledger stores
// integer micro-CNY per 1K tokens so reservations and settlements stay exact.
export const DEEPSEEK_FLASH_PRICING_MICRO_CNY_PER_1K = Object.freeze({
  peak: Object.freeze({
    input: 2_000,
    output: 8_000,
    cachedInput: 40,
  }),
  offPeak: Object.freeze({
    input: 1_000,
    output: 4_000,
    cachedInput: 20,
  }),
});

export const DEEPSEEK_FLASH_PRICE_CALENDAR = Object.freeze({
  schemaVersion: "price-calendar-v1",
  timeZone: "Asia/Shanghai",
  weekdays: Object.freeze([1, 2, 3, 4, 5]),
  peakWindows: Object.freeze([
    Object.freeze({ startMinute: 540, endMinute: 720 }),
    Object.freeze({ startMinute: 840, endMinute: 1080 }),
  ]),
  offPeakRates: Object.freeze({
    input_micro_per_1k: 1_000,
    output_micro_per_1k: 4_000,
    cached_input_micro_per_1k: 20,
    audio_micro_per_minute: 0,
    image_micro_per_page: 0,
  }),
});
