import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { readAppSource } from "./app-source.mjs";

const root = resolve(".");
const shellSource = readFileSync(resolve("src/components/MobileShell.jsx"), "utf8");
const drawerSource = readFileSync(resolve("src/components/MobileMoreDrawer.jsx"), "utf8");
const appSource = readAppSource(root);

describe("mobile shell", () => {
  it("defines four bottom navigation test ids and the quick-record fab", () => {
    for (const id of ["overview", "itinerary", "expense", "more"]) {
      assert.match(shellSource, new RegExp(`mobile-nav-\\$\\{item\\.id\\}|mobile-nav-${id}`));
    }
    assert.match(shellSource, /data-testid="mobile-fab-quick-record"/);
  });

  it("hides the desktop sidebar when the mobile shell is enabled", () => {
    assert.match(appSource, /className=\{`sidebar \$\{mobileShell \? "hidden" : ""\}`\}/);
    assert.match(appSource, /useMobileShellEnabled\(/);
  });

  it("renders the more panel as an accessible dialog", () => {
    assert.match(drawerSource, /role="dialog"/);
    assert.match(drawerSource, /aria-modal="true"/);
    assert.match(drawerSource, /data-testid="mobile-more-drawer"/);
  });

  it("hides duplicate topbar quick actions on mobile", () => {
    assert.match(appSource, /topbar-mobile-hidden/);
    assert.match(appSource, /data-testid="topbar-quick-record"/);
  });

  it("wraps content with pull-to-refresh only for the mobile shell", () => {
    assert.match(appSource, /<PullToRefresh onRefresh=\{handlePullRefresh\} disabled=\{!mobileShell\}>/);
  });

  it("routes the fab into quick record with voice mode", () => {
    assert.match(appSource, /quickSession\.setRecordMode\("voice"\)/);
    assert.match(appSource, /onQuickRecord=\{\(\) => \{/);
  });

  it("shows mobile badges from notification polling", () => {
    assert.match(appSource, /useNotificationBadges\(/);
    assert.match(shellSource, /mobile-nav-badge/);
  });

  it("announces offline snapshot refresh in pull-to-refresh", () => {
    const pullSource = readFileSync(resolve("src/components/PullToRefresh.jsx"), "utf8");
    assert.match(pullSource, /pull-to-refresh/);
    assert.match(appSource, /当前为离线快照/);
  });

  it("keeps the more tab from becoming the active parent highlight", () => {
    assert.match(shellSource, /item\.id !== "more" && activeParent === item\.id/);
  });

  it("groups overflow navigation inside the more panel", () => {
    assert.match(drawerSource, /客户画像/);
    assert.match(drawerSource, /周报与汇报/);
    assert.match(drawerSource, /系统配置/);
  });

  it("adds safe-area padding to the mobile content region", () => {
    const css = readFileSync(resolve("src/styles/global.css"), "utf8");
    assert.match(css, /mobile-shell-content[\s\S]*padding-bottom: calc\(88px \+ env\(safe-area-inset-bottom\)\)/);
  });
});
