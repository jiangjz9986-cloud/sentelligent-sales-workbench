import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

// v0.10.0 总览重排守护：今日焦点全端置顶（DOM 序=视觉序=读屏序，不用 CSS
// order），hero 大卡及其三条写死统计整体退役，KPI 卡带可点击示能。

const overviewSource = readFileSync(resolve("src/features/salesWorkbench/pages/OverviewPage.jsx"), "utf8");
const proactiveSource = readFileSync(resolve("src/features/salesWorkbench/components/ProactiveAssistantPanel.jsx"), "utf8");
const primitivesSource = readFileSync(resolve("src/components/primitives.jsx"), "utf8");
const css = readFileSync(resolve("src/styles/global.css"), "utf8");

describe("overview layout (v0.10.0 rearrangement)", () => {
  it("renders today-focus and weekly-trend before the KPI metric cards in DOM order", () => {
    const overviewBody = overviewSource.slice(overviewSource.indexOf("export function Overview"));
    const todayFocusAt = overviewBody.indexOf("<TodayFocusCard");
    const trendAt = overviewBody.indexOf("<WeeklyTrendCard");
    const firstKpiAt = overviewBody.indexOf("<MetricCard");
    assert.ok(todayFocusAt > -1 && trendAt > -1 && firstKpiAt > -1, "overview keeps all three block kinds");
    assert.ok(todayFocusAt < trendAt, "today focus renders before the weekly trend");
    assert.ok(trendAt < firstKpiAt, "weekly trend renders before the KPI cards");
  });

  it("does not reorder visually with the CSS order property", () => {
    assert.doesNotMatch(css, /^\s*order\s*:/m, "the stylesheet must not rely on CSS order");
  });

  it("retires the hero card together with its three hardcoded stats", () => {
    assert.doesNotMatch(overviewSource, /hero-card|overview-hero|hero-stat-grid|hero-actions/);
    assert.doesNotMatch(overviewSource, /天记录视图|路业务同步|套销售数据/);
    assert.doesNotMatch(overviewSource, /查看本周七天记录/);
  });

  it("removes every hero CSS rule instead of hiding it", () => {
    assert.doesNotMatch(css, /\.hero-card|\.overview-hero|\.hero-stat-grid|\.hero-actions/);
  });

  it("reflows the freed columns into priority (7) and health (5)", () => {
    assert.match(css, /\.overview-priority \{\n  grid-column: span 7;/);
    assert.match(css, /\.overview-health \{\n  grid-column: span 5;/);
  });

  it("gives clickable KPI cards a chevron affordance", () => {
    assert.match(primitivesSource, /\{onClick \? <ChevronRight className="metric-chevron" size=\{15\} \/> : null\}/);
    assert.match(css, /\.metric-card \.metric-chevron \{/);
  });

  it("keeps proactive writeback behind explicit per-target confirmation buttons", () => {
    assert.match(overviewSource, /onConfirmWriteback=\{handleConfirmProactiveWriteback\}/);
    assert.match(proactiveSource, /data-testid=\{`proactive-confirm-\$\{target\}`\}/);
    assert.match(proactiveSource, /确认创建\$\{targetLabel\}/);
    assert.match(proactiveSource, /onConfirmWriteback\(\{ item, target, preview, confirmationPreview \}\)/);
    assert.match(overviewSource, /onCreatePreview=\{handleCreateProactiveConfirmationPreview\}/);
    assert.match(proactiveSource, /保存预览，不写回/);
    assert.match(proactiveSource, /status === "pending"/);
    assert.match(proactiveSource, /商机数据刚刚发生变化/);
  });
});
