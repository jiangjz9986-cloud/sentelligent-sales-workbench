import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function read(path) {
  return readFileSync(resolve(path), "utf8");
}

describe("visit itinerary page delivery", () => {
  it("implements list, read-only detail, new, edit, and delete-confirmation states", () => {
    const source = read("src/features/visitItinerary/VisitItineraryPage.jsx");
    assert.match(source, /export function VisitItineraryPage/);
    for (const testId of [
      "itinerary-list-view",
      "itinerary-detail-view",
      "itinerary-form-view",
      "itinerary-delete-confirmation",
    ]) {
      assert.match(source, new RegExp(`data-testid="${testId}"`));
    }
    assert.match(source, /viewMode === "new"/);
    assert.match(source, /viewMode === "edit"/);
    assert.match(source, /onSave/);
    assert.match(source, /onDelete/);
  });

  it("keeps itinerary search local and every form field explicitly labelled", () => {
    const source = read("src/features/visitItinerary/VisitItineraryPage.jsx");
    assert.match(source, /data-testid="itinerary-local-search"[\s\S]*?aria-label=/);
    assert.match(source, /visitItineraryMatches/);
    assert.doesNotMatch(source, /setGlobalSearch|globalSearch/);
    for (const field of [
      "行程名称",
      "拜访日期",
      "出发时间",
      "出发地址",
      "客户名称",
      "客户地址",
      "停留时长",
    ]) {
      assert.match(source, new RegExp(`<span>${field}</span>`));
    }
  });

  it("renders a usable route timeline when the map SDK is unavailable", () => {
    const page = read("src/features/visitItinerary/VisitItineraryPage.jsx");
    const map = read("src/features/visitItinerary/AmapRouteMap.jsx");
    const loader = read("src/features/visitItinerary/amapLoader.js");
    assert.match(page, /<AmapRouteMap/);
    assert.match(page, /orderedVisitStops/);
    assert.match(page, /buildAmapNavigationUrl/);
    assert.match(map, /data-testid="itinerary-map-fallback"/);
    assert.match(map, /map\.destroy\(\)/);
    assert.match(map, /setFitView/);
    assert.match(loader, /VITE_AMAP_WEB_JS_KEY/);
    assert.match(loader, /VITE_AMAP_SECURITY_CODE/);
    assert.match(loader, /https:\/\/webapi\.amap\.com\/maps/);
    assert.doesNotMatch(`${page}\n${map}\n${loader}`, /[a-f0-9]{32}/i);
  });

  it("resolves browser map coordinates before sending a save request", () => {
    const page = read("src/features/visitItinerary/VisitItineraryPage.jsx");
    assert.match(page, /geocodeVisitItineraryPayload/);
    assert.match(
      page,
      /await geocodeVisitItineraryPayload\(visitItineraryPayload\(draft\)\)[\s\S]*?await onSave/,
    );
  });
});
