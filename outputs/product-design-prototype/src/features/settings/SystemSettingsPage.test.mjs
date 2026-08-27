import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("./SystemSettingsPage.jsx", import.meta.url);
const appPath = new URL("../../App.jsx", import.meta.url);
const stylesPath = new URL("../../styles/global.css", import.meta.url);

test("system settings renders one focused child page for each grouped settings route", async () => {
  const [source, appSource] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  assert.match(source, /section\s*=\s*"security"/);
  assert.match(source, /section\s*===\s*"security"/);
  assert.match(source, /section\s*===\s*"notifications"/);
  assert.match(source, /section\s*===\s*"tender-schedule"/);
  assert.match(source, /data-testid="settings-security-section"/);
  assert.match(source, /data-testid="settings-notifications-section"/);
  assert.match(source, /data-testid="settings-tender-schedule-section"/);
  assert.match(appSource, /<SystemSettingsPage[\s\S]*?section=\{settingsSection\}/);
});

test("tender schedule settings expose the existing scheduler controls without showing secrets", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /updateHospitalTenderScheduler/);
  assert.match(source, /runHospitalTenderScheduler/);
  assert.match(source, /intervalMinutes/);
  assert.match(source, /batchSize/);
  assert.match(source, /cycleNumber/);
  assert.match(source, /lastFinishedAt/);
  assert.match(source, /nextRunAt/);
  assert.match(source, /立即检测下一批/);
  assert.match(source, /启用自动轮巡/);
  assert.doesNotMatch(source, /name="intervalMinutes"/);
  assert.doesNotMatch(source, /name="batchSize"/);
  assert.doesNotMatch(source, /JSON\.stringify\s*\(/);
});

test("grouped settings navigation and controls keep responsive accessible styling", async () => {
  const styles = await readFile(stylesPath, "utf8");

  assert.match(styles, /\.module-subnav-item\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.module-subnav-context button\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.module-subnav-item:focus-visible/);
  assert.match(styles, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.module-subnav-list\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.match(styles, /\.settings-scheduler-form[^}]*\{/);
});
