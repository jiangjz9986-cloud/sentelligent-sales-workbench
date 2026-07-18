import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createServer } from "vite";

const chromePath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean).find((candidate) => existsSync(candidate));

if (!chromePath) {
  throw new Error("Chrome or Edge executable was not found. Set CHROME_PATH to run StageStrip tests.");
}

let vite;
let fixtureBaseUrl;

function renderFixture(name) {
  const userDataDir = mkdtempSync(join(tmpdir(), "stage-strip-test-"));

  return new Promise((resolveRender, rejectRender) => {
    const browser = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${userDataDir}`,
        "--dump-dom",
        `${fixtureBaseUrl}?fixture=${encodeURIComponent(name)}`,
      ],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";

    browser.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    browser.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    browser.on("error", rejectRender);
    browser.on("close", (code) => {
      rmSync(userDataDir, { force: true, recursive: true });
      if (code !== 0) {
        rejectRender(new Error(`Headless browser exited with ${code}: ${stderr}`));
        return;
      }

      const encodedSnapshot = stdout.match(/data-stage-strip-snapshot="([^"]+)"/)?.[1];
      if (!encodedSnapshot) {
        rejectRender(new Error(`StageStrip fixture did not render. Browser output: ${stdout}\n${stderr}`));
        return;
      }

      resolveRender(JSON.parse(decodeURIComponent(encodedSnapshot)));
    });
  });
}

before(async () => {
  vite = await createServer({
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });
  await vite.listen();
  const address = vite.httpServer.address();
  fixtureBaseUrl = `http://127.0.0.1:${address.port}/scripts/fixtures/stage-strip.html`;
});

after(async () => {
  await vite?.close();
});

describe("StageStrip business data", () => {
  it("renders zero for stages absent from the backend and no fabricated amounts", async () => {
    const rows = await renderFixture("missing");

    assert.equal(rows.find(({ stage }) => stage === "线索")?.count, "2");
    assert.ok(
      rows
        .filter(({ stage }) => stage !== "线索")
        .every(({ count }) => count === "0"),
    );
    assert.ok(rows.every(({ amount }) => amount === null));
  });

  it("renders an amount only when the backend provides it", async () => {
    const rows = await renderFixture("real-amount");

    assert.equal(rows.find(({ stage }) => stage === "线索")?.amount, "真实金额 680 万");
    assert.ok(
      rows
        .filter(({ stage }) => stage !== "线索")
        .every(({ amount }) => amount === null),
    );
  });
});
