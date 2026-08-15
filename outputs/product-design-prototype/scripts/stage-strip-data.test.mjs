import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createServer } from "vite";

import {
  resolveStageStripBrowserTimeoutMs,
  waitForChildProcess,
} from "./stage-strip-timeout.mjs";

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

async function terminateChildProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    await new Promise((resolveTermination) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        killer.off("close", finish);
        killer.off("error", finish);
        resolveTermination();
      };
      const timeout = setTimeout(() => {
        killer.kill();
        finish();
      }, 2_000);
      killer.once("close", finish);
      killer.once("error", finish);
    });
    return;
  }

  await new Promise((resolveTermination) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child.off("close", finish);
      child.off("error", finish);
      resolveTermination();
    };
    const timeout = setTimeout(finish, 2_000);
    child.once("close", finish);
    child.once("error", finish);
    if (!child.kill("SIGKILL")) finish();
  });
}

async function renderFixture(name) {
  const browserTimeoutMs = resolveStageStripBrowserTimeoutMs();
  const userDataDir = mkdtempSync(join(tmpdir(), "stage-strip-test-"));
  const cleanup = () => rmSync(userDataDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 50,
  });
  let browser;

  try {
    browser = spawn(
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
  } catch (error) {
    cleanup();
    throw error;
  }

  let stdout = "";
  let stderr = "";
  const snapshotPattern = /data-stage-strip-snapshot="([^"]+)"/;
  let resolveSnapshotOutput;
  const snapshotOutput = new Promise((resolve) => {
    resolveSnapshotOutput = resolve;
  });

  browser.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (snapshotPattern.test(stdout)) resolveSnapshotOutput();
  });
  browser.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const completion = waitForChildProcess(browser, {
    timeoutMs: browserTimeoutMs,
    cleanup,
    successSignal: snapshotOutput,
    terminate: () => terminateChildProcess(browser),
  });

  const code = await completion;
  if (code !== 0) {
    throw new Error(`Headless browser exited with ${code}: ${stderr}`);
  }

  const encodedSnapshot = stdout.match(snapshotPattern)?.[1];
  if (!encodedSnapshot) {
    throw new Error(`StageStrip fixture did not render. Browser output: ${stdout}\n${stderr}`);
  }

  return JSON.parse(decodeURIComponent(encodedSnapshot));
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

  it("keeps unknown and unset stage counts visible without changing the total", async () => {
    const rows = await renderFixture("mixed");
    const renderedTotal = rows.reduce((total, { count }) => total + Number(count), 0);

    assert.deepEqual(rows.find(({ stage }) => stage === "招投标"), {
      stage: "招投标",
      count: "3",
      amount: "真实金额 120 万",
    });
    assert.deepEqual(rows.find(({ stage }) => stage === "未设置"), {
      stage: "未设置",
      count: "7",
      amount: null,
    });
    assert.equal(rows.find(({ stage }) => stage === "初步沟通")?.count, "0");
    assert.equal(renderedTotal, 12);
  });
});

describe("browser process lifecycle", () => {
  it("cleans once after a normal close without terminating an exited process", async () => {
    const child = new EventEmitter();
    let cleanupCalls = 0;
    let terminateCalls = 0;
    const completion = waitForChildProcess(child, {
      timeoutMs: 20,
      cleanup: async () => {
        cleanupCalls += 1;
      },
      terminate: async () => {
        terminateCalls += 1;
      },
    });

    child.emit("close", 0);

    assert.equal(await completion, 0);
    child.emit("close", 0);
    assert.equal(cleanupCalls, 1);
    assert.equal(terminateCalls, 0);
  });

  it("terminates and cleans once after a child-process error", async () => {
    const child = new EventEmitter();
    let cleanupCalls = 0;
    let terminateCalls = 0;
    const completion = waitForChildProcess(child, {
      timeoutMs: 20,
      cleanup: async () => {
        cleanupCalls += 1;
      },
      terminate: async () => {
        terminateCalls += 1;
      },
    });

    child.emit("error", new Error("spawn failed"));

    await assert.rejects(completion, /spawn failed/);
    child.emit("close", 1);
    assert.equal(cleanupCalls, 1);
    assert.equal(terminateCalls, 1);
  });

  it("terminates and cleans once when the child process times out", async () => {
    const child = new EventEmitter();
    let cleanupCalls = 0;
    let terminateCalls = 0;
    const completion = waitForChildProcess(child, {
      timeoutMs: 10,
      cleanup: async () => {
        cleanupCalls += 1;
      },
      terminate: async () => {
        terminateCalls += 1;
      },
    });

    await assert.rejects(completion, /timed out after 10 ms/);
    child.emit("close", 1);
    assert.equal(cleanupCalls, 1);
    assert.equal(terminateCalls, 1);
  });
});
