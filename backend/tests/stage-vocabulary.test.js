import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KNOWN_STAGES,
  isKnownStage,
  normalizeStageText,
  stageDirection,
  stageIndex,
} from "../src/opportunities/stageVocabulary.js";

describe("opportunity stage vocabulary", () => {
  it("mirrors the web kanban order exactly", () => {
    assert.deepEqual([...KNOWN_STAGES], [
      "线索", "初步沟通", "调研机会", "方案输出", "方案交流", "预算确认", "暂停观察",
    ]);
    assert.ok(Object.isFrozen(KNOWN_STAGES));
  });

  it("indexes known stages and returns -1 for unknown or non-string values", () => {
    assert.equal(stageIndex("线索"), 0);
    assert.equal(stageIndex(" 预算确认 "), 5);
    assert.equal(stageIndex("投标"), -1);
    assert.equal(stageIndex(null), -1);
    assert.equal(isKnownStage("暂停观察"), true);
    assert.equal(isKnownStage("投标"), false);
  });

  it("derives forward/backward/same and fails closed to unknown", () => {
    assert.equal(stageDirection("方案输出", "方案交流"), "forward");
    assert.equal(stageDirection("线索", "预算确认"), "forward");
    assert.equal(stageDirection("方案交流", "调研机会"), "backward");
    assert.equal(stageDirection("方案输出", "方案输出"), "same");
    assert.equal(stageDirection("方案输出", "投标"), "unknown");
    assert.equal(stageDirection("投标", "方案输出"), "unknown");
    assert.equal(stageDirection(null, "线索"), "unknown");
    assert.equal(stageDirection("预算确认", "暂停观察"), "forward", "暂停观察 is the last column by index");
  });

  it("normalizes spoken targets by stripping punctuation and mood particles", () => {
    assert.equal(normalizeStageText("投标了"), "投标");
    assert.equal(normalizeStageText("方案交流吧！"), "方案交流");
    assert.equal(normalizeStageText("  预算 确认  "), "预算 确认");
    assert.equal(normalizeStageText("投标啦。"), "投标");
    assert.equal(normalizeStageText("了"), "");
    assert.equal(normalizeStageText(""), "");
    assert.equal(normalizeStageText(null), "");
    assert.equal(normalizeStageText(`${"长".repeat(101)}`), "");
  });
});
