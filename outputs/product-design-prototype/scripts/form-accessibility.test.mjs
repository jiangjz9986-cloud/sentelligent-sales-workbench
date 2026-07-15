import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const pageSource = readFileSync(resolve("src/features/salesWorkbench/pages.jsx"), "utf8");

function tagByTestId(testId) {
  return controlContaining(`data-testid="${testId}"`);
}

function textareaByPlaceholder(placeholderStart) {
  return controlContaining(`placeholder="${placeholderStart}`);
}

function controlContaining(fragment) {
  const position = pageSource.indexOf(fragment);
  if (position === -1) return "";

  const start = Math.max(
    pageSource.lastIndexOf("<input", position),
    pageSource.lastIndexOf("<textarea", position),
    pageSource.lastIndexOf("<select", position),
  );
  const end = pageSource.indexOf("/>", position);
  if (start === -1 || end === -1) return "";
  return pageSource.slice(start, end + 2);
}

describe("form accessibility", () => {
  it("gives every page-local search field an explicit accessible name", () => {
    const searchFields = [
      "customer-local-search",
      "opportunity-local-search",
      "actions-local-search",
      "risk-local-search",
    ];

    for (const testId of searchFields) {
      assert.match(tagByTestId(testId), /\baria-label=/, `${testId} needs aria-label`);
    }
    assert.match(controlContaining('placeholder="搜索移动云'), /\baria-label=/, "knowledge search needs aria-label");
  });

  it("names quick-record and generated-summary textareas without relying on placeholder text", () => {
    assert.match(textareaByPlaceholder("粘贴拜访记录"), /\baria-label=/);
    assert.match(pageSource, /data-testid=\{fieldKey \? `analysis-summary-\$\{fieldKey\}` : undefined\}[\s\S]*?\baria-label=/);
  });
});
