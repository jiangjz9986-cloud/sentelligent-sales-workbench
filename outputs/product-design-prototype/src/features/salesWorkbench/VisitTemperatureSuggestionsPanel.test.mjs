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
    assert.match(source, /status: "conflict", suggestion: authoritative, writeback: false/u);
    assert.doesNotMatch(source, /outcome\.status === "conflict"\) await reload/u);
  });

  it("uses completed V2 confirmation preview eligibility while excluding analyzed-only records", () => {
    assert.match(source, /quickRecord\.status === "confirmed" \|\| quickRecord\.confirmationPreviewStatus === "completed"/u);
    assert.match(source, /Boolean\(quickRecord\?\.id\)/u);
    assert.match(source, /Boolean\(quickRecord\?\.customerId\)/u);
    assert.doesNotMatch(source, /quickRecord\.status === "analyzed"/u);
  });

  it("refreshes authoritative state after HTTP conflicts and uses currentCustomer on a conflict outcome", () => {
    assert.match(source, /apiClient\.getVisitTemperatureSuggestion\(item\.id, \{ signal: controller\.signal \}\)/u);
    assert.match(source, /mergeTemperatureOutcome\(candidate, \{ status: "conflict", suggestion: authoritative, writeback: false \}\)/u);
    assert.match(source, /outcome\.status === "conflict"\s*\? outcome\.currentCustomer\s*:\s*outcome\.customer/u);
    assert.doesNotMatch(source, /candidate\.id === item\.id \? \{ \.\.\.candidate, status: "conflict"/u);
  });
});
