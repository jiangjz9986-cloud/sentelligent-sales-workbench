import test from "node:test";
import assert from "node:assert/strict";

import { formatProactiveConfidence } from "./proactiveAssistantModel.js";

test("does not turn an uncalibrated confidence into a percentage", () => {
  assert.equal(formatProactiveConfidence({
    confidence: null,
    confidenceLevel: "unverified",
    confidenceCalibrated: false,
  }), "置信度未校准");
  assert.equal(formatProactiveConfidence({ confidence: 92 }), "置信度未校准");
});

test("renders a percentage only when the server marks it calibrated", () => {
  assert.equal(formatProactiveConfidence({ confidence: 92, confidenceCalibrated: true }), "置信度 92%");
  assert.equal(formatProactiveConfidence({ confidence: "92", confidenceCalibrated: true }), "置信度未校准");
});
