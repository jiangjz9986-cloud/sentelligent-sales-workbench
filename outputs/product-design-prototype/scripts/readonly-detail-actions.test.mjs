import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const pageSource = readFileSync(resolve("src/features/salesWorkbench/pages.jsx"), "utf8");

describe("readonly detail action model", () => {
  it("keeps detail views read-only until the user explicitly clicks modify", () => {
    assert.match(pageSource, /viewMode === "edit"/);
    assert.doesNotMatch(pageSource, /initialMode=\{viewMode === "create" \? "new" : "edit"\}/);
  });

  it("exposes modify and delete actions for manually maintained business modules", () => {
    const modules = ["customer", "opportunity", "knowledge", "action", "risk"];

    for (const module of modules) {
      assert.match(pageSource, new RegExp(`data-testid="${module}-edit-detail"`), `${module} needs a modify button`);
      assert.match(pageSource, new RegExp(`data-testid="${module}-delete-detail"`), `${module} needs a delete button`);
    }
  });

  it("keeps edit sessions cancellable before saving", () => {
    const modules = ["customer", "opportunity", "knowledge"];

    for (const module of modules) {
      assert.match(pageSource, new RegExp(`data-testid="${module}-cancel-edit"`), `${module} edit form needs cancel`);
    }
  });
});
