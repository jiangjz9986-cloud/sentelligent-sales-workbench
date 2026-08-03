import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function read(path) {
  return readFileSync(resolve(path), "utf8");
}

describe("list page action layout", () => {
  it("supports a shared action slot in panel headers", () => {
    const source = read("src/components/primitives.jsx");
    assert.match(source, /export function Panel\(\{ title, meta, action,/);
    assert.match(source, /className="panel-title-action"/);
  });

  it("places every list create action inside its content panel", () => {
    const pages = read("src/features/salesWorkbench/pages.jsx");
    const itinerary = read("src/features/visitItinerary/VisitItineraryPage.jsx");
    const app = read("src/App.jsx");

    for (const testId of [
      "customer-create-detail",
      "opportunity-create-detail",
      "knowledge-create-detail",
    ]) {
      assert.match(pages, new RegExp(`<Panel[\\s\\S]{0,500}data-testid="${testId}"`));
    }
    assert.match(itinerary, /className="itinerary-list-panel"[\s\S]{0,500}data-testid="itinerary-create-detail"/);
    assert.doesNotMatch(app, /const headingAction/);
  });

  it("renders semantic month, day, and weekday date parts", () => {
    const source = read("src/features/visitItinerary/VisitItineraryPage.jsx");
    assert.match(source, /formatVisitDateParts/);
    assert.match(source, /<time[\s\S]*?className="itinerary-date-tile"/);
    assert.match(source, /itinerary-date-month/);
    assert.match(source, /itinerary-date-day/);
    assert.match(source, /itinerary-date-weekday/);
    assert.doesNotMatch(source, /visitDate\.slice\(5\)/);
  });
});
