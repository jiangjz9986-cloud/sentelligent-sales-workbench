import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateUsage, calculateCostMicro } from "../src/budgets/ledger.js";

test("reservation covers the configured output cap and media units", () => {
  const input = { input: { media: { durationMs: 61_001, pageCount: 3 } }, systemPrompt: "test instructions" };
  const estimate = estimateUsage({ input, maxTokens: 12_000 });
  assert.equal(estimate.outputTokens, 12_000);
  assert.equal(estimate.inputTokens, Buffer.byteLength(JSON.stringify(input)));
  assert.equal(estimate.audioSeconds, 62);
  assert.equal(estimate.imagePages, 3);
});

test("cost calculation rounds integer units without floating-point undercount", () => {
  assert.equal(calculateCostMicro({ inputTokens: 1001, outputTokens: 2, cachedInputTokens: 500, audioSeconds: 61, imagePages: 2 }, {
    input_micro_per_1k: 100, output_micro_per_1k: 1000, cached_input_micro_per_1k: 10,
    audio_micro_per_minute: 60, image_micro_per_page: 20,
  }).costMicro, 101 + 2 + 5 + 61 + 40);
  assert.throws(() => calculateCostMicro({ inputTokens: Number.MAX_SAFE_INTEGER }, {
    input_micro_per_1k: Number.MAX_SAFE_INTEGER,
  }), (error) => error.code === "invalid_cost");
});
