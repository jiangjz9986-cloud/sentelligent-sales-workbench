import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const controlFiles = [
  "src/App.jsx",
  "src/features/salesWorkbench/pages.jsx",
  "src/components/primitives.jsx",
  "src/features/visitItinerary/VisitItineraryPage.jsx",
];

function readUiSource() {
  return controlFiles
    .map((file) => `${file}\n${readFileSync(resolve(file), "utf8")}`)
    .join("\n\n");
}

function openingTags(source, tagName) {
  return source.match(new RegExp(`<${tagName}\\b[^>]*>`, "gs")) ?? [];
}

function normalizeTag(tag) {
  return tag.replace(/\s+/g, " ").trim();
}

describe("interactive control wiring", () => {
  it("keeps user-facing controls wired through React handlers instead of DOM listener refs", () => {
    const source = readUiSource();

    assert.doesNotMatch(source, /\.addEventListener\(\s*["']click["']/);
    assert.doesNotMatch(source, /\.removeEventListener\(\s*["']click["']/);
  });

  it("declares explicit button types so controls do not accidentally submit forms", () => {
    const missingType = openingTags(readUiSource(), "button").filter((tag) => !/\btype=/.test(tag));

    assert.deepEqual(missingType, []);
  });

  it("keeps every non-submit button tied to an explicit React action", () => {
    const inertButtons = openingTags(readUiSource(), "button")
      .map(normalizeTag)
      .filter((tag) => !/\btype=["']submit["']/.test(tag))
      .filter((tag) => !/\bonClick=/.test(tag));

    assert.deepEqual(inertButtons, []);
  });

  it("gives link-styled action buttons href, click handling, and disabled semantics", () => {
    const unsafeActionLinks = openingTags(readUiSource(), "a")
      .map(normalizeTag)
      .filter((tag) => /\brole=["']button["']/.test(tag))
      .filter((tag) => !/\bhref=/.test(tag) || !/\bonClick=/.test(tag) || !/\baria-disabled=/.test(tag));

    assert.deepEqual(unsafeActionLinks, []);
  });

  it("keeps non-native button roles keyboard reachable with explicit expanded state", () => {
    const unsafeRoleButtons = readUiSource()
      .match(/<section\s+className={\`day-card[\s\S]*?<\/section>/g)
      ?.map(normalizeTag)
      .filter((block) =>
        !/\btabIndex=/.test(block) ||
        !/\bonClick=/.test(block) ||
        !/\bonKeyDown=/.test(block) ||
        !/\baria-label=/.test(block) ||
        !/\baria-expanded=/.test(block),
      ) ?? [];

    assert.deepEqual(unsafeRoleButtons, []);
  });

  it("locks quick-record confirmation while synchronization, analysis save, or unsaved edits are active", () => {
    const pageSource = readFileSync(resolve("src/features/salesWorkbench/pages.jsx"), "utf8");
    const manualSync = pageSource.match(/<div className="manual-sync">[\s\S]*?<\/div>/)?.[0] ?? "";

    assert.match(pageSource, /createExclusiveAsyncGate/);
    assert.match(pageSource, /confirmationGateRef/);
    assert.match(
      manualSync,
      /disabled=\{confirmationPending \|\| analysisSavePending \|\| analysisDirty\}/,
    );
  });
});
