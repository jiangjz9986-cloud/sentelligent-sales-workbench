import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const source = readFileSync(resolve("src/features/salesWorkbench/VisitTemperatureSuggestionsPanel.jsx"), "utf8");
const quickRecordPageSource = readFileSync(resolve("src/features/salesWorkbench/pages/QuickRecordPage.jsx"), "utf8");

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
    assert.match(source, /setItems\(\[\]\)/u);
    assert.match(source, /setLoading\(false\)/u);
    assert.match(source, /setPendingId\(null\)/u);
  });

  it("keeps actions single-item and fail-closed for missing evidence", () => {
    assert.match(source, /确认此条/u);
    assert.match(source, /取消此条/u);
    assert.doesNotMatch(source, /全部确认/u);
    assert.match(source, /temperatureCanAct\(item\)/u);
    assert.match(source, /status: authoritativeStatus, suggestion: authoritative, writeback: false/u);
    assert.doesNotMatch(source, /outcome\.status === "conflict"\) await reload/u);
  });

  it("renders every temperature proposal through the shared AI card with a pinned read-only draft", () => {
    assert.match(source, /import \{ AiResultCard \}/u);
    assert.match(source, /temperatureSuggestionToAiCard\(item, customerName\)/u);
    assert.match(source, /draftMode="readonly"/u);
    assert.match(source, /historyReadOnly=\{historyReadOnly \|\| temperatureIsReadOnly\(item\)\}/u);
    assert.doesNotMatch(source, /className=\{`temperature-card/u);
  });

  it("keeps historical records read-only, including temperature generation and actions", () => {
    assert.match(source, /historyReadOnly = false/u);
    assert.match(source, /const canGenerate = !historyReadOnly/u);
    assert.match(source, /if \(historyReadOnly \|\| !quickRecord\?\.id \|\| !canGenerate\) return/u);
    assert.match(source, /if \(historyReadOnly \|\| !isCurrentItem \|\| !temperatureCanAct\(item\) \|\| pendingId\) return/u);
    assert.match(source, /item\?\.visitId === visitId && item\?\.customerId === customerId/u);
    assert.match(source, /historyReadOnly=\{historyReadOnly \|\| temperatureIsReadOnly\(item\)\}/u);
    assert.match(quickRecordPageSource, /<VisitTemperatureSuggestionsPanel[\s\S]*historyReadOnly=\{historyReadOnly\}/u);
  });

  it("uses completed V2 confirmation preview eligibility while excluding analyzed-only records", () => {
    assert.match(source, /quickRecord\.status === "confirmed"\s*\|\|\s*\(quickRecord\.status === "analyzed"\s*&&\s*quickRecord\.confirmationPreviewStatus === "completed"\)/u);
    assert.match(source, /Boolean\(quickRecord\?\.id\)/u);
    assert.match(source, /Boolean\(quickRecord\?\.customerId\)/u);
    assert.doesNotMatch(source, /quickRecord\.status === "confirmed"\s*\|\|\s*quickRecord\.confirmationPreviewStatus/u);
    assert.doesNotMatch(source, /quickRecord\.status === "draft"/u);
  });

  it("refreshes authoritative state after HTTP conflicts and uses currentCustomer on a conflict outcome", () => {
    assert.match(source, /apiClient\.getVisitTemperatureSuggestion\(item\.id, \{ signal: controller\.signal \}\)/u);
    assert.match(source, /const authoritativeStatus = \["confirmed", "cancelled", "expired"\]\.includes\(authoritative\.status\)/u);
    assert.match(source, /mergeTemperatureOutcome\(candidate, \{ status: authoritativeStatus, suggestion: authoritative, writeback: false \}\)/u);
    assert.match(source, /outcome\.status === "conflict"\s*\? outcome\.currentCustomer\s*:\s*outcome\.customer/u);
    assert.doesNotMatch(source, /candidate\.id === item\.id \? \{ \.\.\.candidate, status: "conflict"/u);
  });
});
