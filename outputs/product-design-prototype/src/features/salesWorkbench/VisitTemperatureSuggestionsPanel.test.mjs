import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const source = readFileSync(resolve("src/features/salesWorkbench/VisitTemperatureSuggestionsPanel.jsx"), "utf8");

describe("visit temperature suggestion panel wiring", () => {
  it("scopes history to the selected customer and selected visit", () => {
    assert.match(source, /listVisitTemperatureSuggestions\(\{ customerId, limit: 50, signal: requestSignal \}\)/u);
    assert.match(source, /result\.items\.filter\(\(item\) => item\.visitId === visitId\)/u);
    assert.match(source, /if \(!customerId \|\|/u);
  });

  it("cancels stale requests when the record changes or the panel unmounts", () => {
    assert.match(source, /new AbortController\(\)/u);
    assert.match(source, /requestRef\.current\?\.abort\(\)/u);
    assert.match(source, /generationRef\.current \+= 1/u);
    assert.match(source, /!requestSignal\?\.aborted/u);
  });

  it("keeps actions single-item and fail-closed for missing evidence", () => {
    assert.match(source, /确认此条/u);
    assert.match(source, /取消此条/u);
    assert.doesNotMatch(source, /全部确认/u);
    assert.match(source, /暂无可验证来源/u);
    assert.match(source, /sourceRefs\(item\)\.length > 0/u);
    assert.match(source, /status: "conflict", writeback: false/u);
    assert.doesNotMatch(source, /outcome\.status === "conflict"\) await reload/u);
  });
});
