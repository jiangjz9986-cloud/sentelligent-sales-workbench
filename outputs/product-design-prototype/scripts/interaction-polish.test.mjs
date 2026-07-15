import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const css = readFileSync(resolve("src/styles/global.css"), "utf8");

const focusSelectors = [
  ".primary-button:focus-visible",
  ".ghost-button:focus-visible",
  ".nav-item:focus-visible",
  ".segmented button:focus-visible",
  ".list-row-main:focus-visible",
];

describe("interaction polish CSS", () => {
  it("gives every primary interactive control family a visible keyboard focus ring", () => {
    for (const selector of focusSelectors) {
      assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `Missing focus style for ${selector}`);
    }
  });

  it("honors reduced-motion preferences for hover and transition effects", () => {
    assert.match(css, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
    assert.match(css, /transition(?:-duration)?\s*:\s*(?:none|0(?:ms|s)?)/);
    assert.match(css, /transform\s*:\s*none/);
  });
});
