import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { readSalesWorkbenchPagesSource } from "./pages-source.mjs";

const pageSource = readSalesWorkbenchPagesSource();
const entityWorkspaceSource = readFileSync(resolve("src/features/salesWorkbench/pages/EntityWorkspace.jsx"), "utf8");
const combinedSource = `${pageSource}\n${entityWorkspaceSource}`;

describe("readonly detail action model", () => {
  it("keeps detail views read-only until the user explicitly clicks modify", () => {
    assert.match(pageSource, /viewMode === "edit"/);
    assert.doesNotMatch(pageSource, /initialMode=\{viewMode === "create" \? "new" : "edit"\}/);
  });

  it("exposes modify and delete actions for manually maintained business modules", () => {
    const modules = ["customer", "opportunity", "knowledge", "action", "risk"];

    for (const module of modules) {
      const hasEdit = new RegExp(`data-testid="${module}-edit-detail"`).test(combinedSource)
        || new RegExp(`editDetailTestId:\\s*"${module}-edit-detail"`).test(pageSource);
      const hasDelete = new RegExp(`data-testid="${module}-delete-detail"`).test(combinedSource)
        || new RegExp(`deleteDetailTestId:\\s*"${module}-delete-detail"`).test(pageSource);
      assert.equal(hasEdit, true, `${module} needs a modify button`);
      assert.equal(hasDelete, true, `${module} needs a delete button`);
    }
    assert.match(entityWorkspaceSource, /data-testid=\{config\.editDetailTestId\}/);
    assert.match(entityWorkspaceSource, /data-testid=\{config\.deleteDetailTestId\}/);
  });

  it("keeps edit sessions cancellable before saving", () => {
    const modules = ["customer", "opportunity", "knowledge"];

    for (const module of modules) {
      assert.match(pageSource, new RegExp(`data-testid="${module}-cancel-edit"`), `${module} edit form needs cancel`);
    }
  });
});
