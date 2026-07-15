import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const uiFiles = [
  "src/features/salesWorkbench/pages.jsx",
  "src/components/primitives.jsx",
  "src/App.jsx",
];

const forbiddenCopy = [
  "Apple-style",
  "Manual AI",
  "Prototype",
  "prototype",
  "Demo",
  "demo",
  "原型",
  "mock",
  "Mock",
  "MOCK",
  "占位",
  "静态",
  "全局 AI",
  "抽屉",
  "后端",
  "WSL",
  "正式调用",
  "开发备注",
  "调试",
  "设计稿",
  "演示",
  "样子货",
];

describe("formal handoff UI copy", () => {
  it("uses readable Chinese terms for formal delivery copy rules", () => {
    for (const text of ["原型", "占位", "后端", "正式调用"]) {
      assert.equal(forbiddenCopy.includes(text), true, `Missing readable forbidden copy rule: ${text}`);
    }
  });

  it("keeps implementation notes and prototype wording out of user-facing UI files", () => {
    const source = uiFiles
      .map((file) => `${file}\n${readFileSync(resolve(file), "utf8")}`)
      .join("\n\n");

    for (const text of forbiddenCopy) {
      assert.equal(source.includes(text), false, `Remove user-facing implementation copy: ${text}`);
    }
  });

  it("opens quick record in voice mode with direct recording guidance", () => {
    const appSource = readFileSync(resolve("src/App.jsx"), "utf8");
    const pageSource = readFileSync(resolve("src/features/salesWorkbench/pages.jsx"), "utf8");

    assert.match(appSource, /const \[recordMode, setRecordMode\] = useState\("voice"\)/);
    assert.match(pageSource, /idle:\s*"待录入"/);
    assert.match(pageSource, /点击开始转写即可。/);
    assert.doesNotMatch(pageSource, /idle:\s*"可开始"/);
    assert.doesNotMatch(pageSource, /准备录入。/);
  });
});
