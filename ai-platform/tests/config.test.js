import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadAiPlatformConfig } from "../src/config.js";

describe("AI platform target configuration", () => {
  it("defaults to the fixed logical target and local simulation", () => {
    const config = loadAiPlatformConfig({ databasePath: ":memory:" }, {});

    assert.equal(config.targetModel, "gpt-5.6-luna");
    assert.equal(config.targetReasoningEffort, "max");
    assert.equal(config.executionMode, "local-simulated");
    assert.equal(config.proactiveScheduleOwner, "backend");
  });

  it("rejects attempts to change the target model or reasoning effort", () => {
    assert.throws(
      () => loadAiPlatformConfig({ databasePath: ":memory:", targetModel: "forged-model" }, {}),
      /AI_PLATFORM_TARGET_MODEL must be gpt-5\.6-luna/u,
    );
    assert.throws(
      () => loadAiPlatformConfig({ databasePath: ":memory:", targetReasoningEffort: "low" }, {}),
      /AI_PLATFORM_TARGET_REASONING_EFFORT must be max/u,
    );
    assert.throws(
      () => loadAiPlatformConfig({}, { AI_PLATFORM_TARGET_MODEL: "forged-model" }),
      /AI_PLATFORM_TARGET_MODEL must be gpt-5\.6-luna/u,
    );
    assert.throws(
      () => loadAiPlatformConfig({}, { AI_PLATFORM_PROACTIVE_SCHEDULE_OWNER: "ai-platform" }),
      /AI_PLATFORM_PROACTIVE_SCHEDULE_OWNER must be backend/u,
    );
  });
});
