import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { webkit } from "playwright";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const componentPath = path.join(projectRoot, "src/components/audio/VoiceCaptureControl.jsx");
const hookPath = path.join(projectRoot, "src/audio/useServerTranscription.js");
const quickRecordPagePath = path.join(projectRoot, "src/features/salesWorkbench/pages/QuickRecordPage.jsx");
const browserHarnessPath = path.join(os.tmpdir(), `asr-hook-harness-${process.pid}.jsx`);

let vite;
let viteBaseUrl;
let VoiceCaptureControlView;
let beginTouchCapture;
let cancelTouchGesture;
let finishTouchCapture;
let finishTouchGesture;
let consumeSyntheticClickToken;
let moveTouchGesture;
let releaseTouchGesture;
let runPrimaryKeyboardAction;
let updateSyntheticClickToken;
let appendQuickRecordTranscript;
let QUICK_RECORD_TRANSCRIPT_LIMIT;
let QUICK_RECORD_CONTENT_LIMIT;
let quickRecordHistoryView;
let quickRecordNeedsConfirmation;

before(async () => {
  await writeFile(browserHarnessPath, String.raw`
import React, { StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { useServerTranscription } from "/src/audio/useServerTranscription.js";

let nowValue = 10_000;
let timerId = 0;
const timers = new Map();
const scheduledDelays = [];
const requests = [];
const callbacks = [];
const commitResolvedRequests = new Set();
const tracks = [];
const recorders = [];
let uuid = 0;

function setTimeoutImpl(callback, delay = 0) {
  const id = ++timerId;
  const boundedDelay = Math.max(0, Number(delay) || 0);
  timers.set(id, { callback, at: nowValue + boundedDelay });
  scheduledDelays.push(boundedDelay);
  return id;
}

function clearTimeoutImpl(id) {
  timers.delete(id);
}

class FakeTrack {
  constructor() { this.stopCalls = 0; tracks.push(this); }
  stop() { this.stopCalls += 1; }
}

class FakeMediaRecorder {
  static isTypeSupported(value) { return value === "audio/webm;codecs=opus"; }
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || "audio/webm;codecs=opus";
    this.state = "inactive";
    recorders.push(this);
  }
  start() { this.state = "recording"; }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const ondataavailable = this.ondataavailable;
    const onstop = this.onstop;
    queueMicrotask(() => {
      ondataavailable?.({ data: new Blob(["synthetic-audio"], { type: this.mimeType }) });
      onstop?.();
    });
  }
}

const mediaDevices = {
  async getUserMedia() {
    const trackA = new FakeTrack();
    const trackB = new FakeTrack();
    return { getTracks: () => [trackA, trackB] };
  },
};

const apiClient = {
  transcribeAudio(input) {
    return new Promise((resolve, reject) => {
      requests.push({ input, resolve, reject });
    });
  },
};

let props = {
  purpose: "quick_record",
  callbackLabel: "quick-initial",
  disabled: false,
  active: true,
  sessionEpoch: 0,
  resolveOnCommitIndex: null,
};

function publicSnapshot(transcription) {
  return {
    status: transcription.status,
    purpose: transcription.purpose,
    recordingGeneration: transcription.recordingGeneration,
    errorCode: transcription.errorCode,
  };
}

function Harness(currentProps) {
  const transcription = useServerTranscription({
    purpose: currentProps.purpose,
    disabled: currentProps.disabled,
    active: currentProps.active,
    sessionEpoch: currentProps.sessionEpoch,
    mediaDevices,
    MediaRecorderImpl: FakeMediaRecorder,
    SpeechRecognitionImpl: undefined,
    BlobImpl: Blob,
    AbortControllerImpl: AbortController,
    cryptoImpl: {
      randomUUID() {
        uuid += 1;
        return "00000000-0000-4000-8000-" + String(uuid).padStart(12, "0");
      },
    },
    now: () => nowValue,
    setTimeoutImpl,
    clearTimeoutImpl,
    apiClient,
    onTranscript(text) { callbacks.push(currentProps.callbackLabel + ":" + text); },
  });
  useLayoutEffect(() => {
    const index = currentProps.resolveOnCommitIndex;
    if (!Number.isInteger(index) || commitResolvedRequests.has(index) || !requests[index]) return;
    commitResolvedRequests.add(index);
    const request = requests[index];
    request.resolve({
      requestId: "commit-request-" + index,
      item: {
        transcript: "COMMIT_SHOULD_NOT_APPLY",
        language: "zh-CN",
        durationMs: request.input.durationMs,
        source: "server_asr",
        replayed: false,
      },
    });
  }, [currentProps.resolveOnCommitIndex]);
  window.__asrCurrent = transcription;
  window.__asrRenderedProps = { ...currentProps };
  return React.createElement("output", {
    id: "snapshot",
    "data-status": transcription.status,
    "data-purpose": transcription.purpose,
  }, transcription.status);
}

const root = createRoot(document.getElementById("root"));
function render(next = {}) {
  props = { ...props, ...next };
  root.render(React.createElement(StrictMode, null, React.createElement(Harness, props)));
}

window.__asrTest = {
  render,
  start: () => window.__asrCurrent.startCapture(),
  stop: () => window.__asrCurrent.stopCapture(),
  advance(milliseconds) { nowValue += milliseconds; },
  snapshot: () => publicSnapshot(window.__asrCurrent),
  renderedProps: () => ({ ...window.__asrRenderedProps }),
  requestCount: () => requests.length,
  request(index) {
    const request = requests[index];
    return request ? {
      purpose: request.input.purpose,
      durationMs: request.input.durationMs,
      key: request.input.idempotencyKey,
      aborted: request.input.signal.aborted,
      abortReason: request.input.signal.reason ?? null,
    } : null;
  },
  resolve(index, transcript) {
    const request = requests[index];
    request.resolve({
      requestId: "request-" + index,
      item: {
        transcript,
        language: "zh-CN",
        durationMs: request.input.durationMs,
        source: "server_asr",
        replayed: false,
      },
    });
  },
  callbacks: () => [...callbacks],
  pendingTimers: () => timers.size,
  scheduledDelays: () => [...scheduledDelays],
  allTracksStopped: () => tracks.length > 0 && tracks.every((track) => track.stopCalls === 1),
  recorderCount: () => recorders.length,
};
render();
`, "utf8");
  vite = await createServer({
    root: projectRoot,
    configFile: path.join(projectRoot, "vite.config.mjs"),
    logLevel: "silent",
    plugins: [{
      name: "asr-hook-browser-harness",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/__asr-hook-test") {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(
            `<div id="root"></div><script type="module" src="/@fs${browserHarnessPath}"></script>`,
          );
        });
      },
    }],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      fs: { allow: [projectRoot, os.tmpdir()] },
    },
    appType: "custom",
  });
  await vite.listen();
  const address = vite.httpServer.address();
  viteBaseUrl = `http://127.0.0.1:${address.port}`;
  ({
    VoiceCaptureControlView,
    beginTouchCapture,
    cancelTouchGesture,
    finishTouchCapture,
    finishTouchGesture,
    consumeSyntheticClickToken,
    moveTouchGesture,
    releaseTouchGesture,
    runPrimaryKeyboardAction,
    updateSyntheticClickToken,
  } = await vite.ssrLoadModule("/src/components/audio/VoiceCaptureControl.jsx"));
  ({
    appendQuickRecordTranscript,
    QUICK_RECORD_TRANSCRIPT_LIMIT,
    QUICK_RECORD_CONTENT_LIMIT,
    quickRecordHistoryView,
    quickRecordNeedsConfirmation,
  } = await vite.ssrLoadModule("/src/features/salesWorkbench/pages/QuickRecordPage.jsx"));
});

after(async () => {
  await vite?.close();
  await rm(browserHarnessPath, { force: true });
});

function view(overrides = {}) {
  return {
    status: "idle",
    statusText: "可以开始录音",
    secondaryText: "录音完成后先回填文字草稿",
    supported: true,
    disabled: false,
    recordingGeneration: 0,
    sameBlobRetryCount: 0,
    retryCountdownSeconds: 0,
    rateLimitCountdownSeconds: 0,
    startCapture() {},
    stopCapture() {},
    cancelCapture() {},
    retry() {},
    reset() {},
    ...overrides,
  };
}

describe("VoiceCaptureControl real JSX transform and rendered contract", () => {
  it("loads through the existing Vite/React transform instead of source-only matching", () => {
    assert.equal(typeof VoiceCaptureControlView, "function");
    const html = renderToStaticMarkup(React.createElement(VoiceCaptureControlView, {
      transcription: view(),
    }));
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /aria-label="开始录音"/);
    assert.match(html, /可以开始录音/);
  });

  it("renders the one processing state and fixed privacy copy", () => {
    const html = renderToStaticMarkup(React.createElement(VoiceCaptureControlView, {
      transcription: view({
        status: "processing",
        statusText: "正在上传并转成文字",
        secondaryText: "音频只用于本次转写；完成后先回填草稿",
      }),
    }));
    assert.match(html, /正在上传并转成文字/);
    assert.match(html, /音频只用于本次转写；完成后先回填草稿/);
    assert.match(html, /aria-label="取消转写"/);
    assert.doesNotMatch(html, /正在上传<\/|正在转写<\/|上传进度/);
  });

  it("offers one explicit manual retry only in retryable_error", () => {
    const retryable = renderToStaticMarkup(React.createElement(VoiceCaptureControlView, {
      transcription: view({
        status: "retryable_error",
        statusText: "转写未完成",
        secondaryText: "可人工重试一次或改用文本",
        sameBlobRetryCount: 0,
      }),
    }));
    assert.match(retryable, />人工重试一次</);

    const rateLimited = renderToStaticMarkup(React.createElement(VoiceCaptureControlView, {
      transcription: view({
        status: "rate_limited",
        statusText: "请求过于频繁",
        secondaryText: "等待后重新录音",
        rateLimitCountdownSeconds: 300,
      }),
    }));
    assert.match(rateLimited, /300 秒/);
    assert.doesNotMatch(rateLimited, /人工重试当前录音|人工重试一次/);
  });

  it("renders Web Speech as an explicit temporary fallback without claiming server readiness", () => {
    const html = renderToStaticMarkup(React.createElement(VoiceCaptureControlView, {
      transcription: view({
        supported: false,
        status: "error",
        browserInterimAvailable: true,
        browserInterimActive: false,
        startBrowserInterim() {},
        stopBrowserInterim() {},
      }),
    }));
    assert.match(html, />浏览器临时识别</);
    assert.match(html, /disabled=""[^>]*>.*开始录音|<button[^>]*disabled=""/s);
    assert.doesNotMatch(html, /已完成服务端转写/);
  });

  it("publishes dynamic recording and cancel labels without color-only status", () => {
    const recording = renderToStaticMarkup(React.createElement(VoiceCaptureControlView, {
      transcription: view({
        status: "recording",
        statusText: "正在录音",
        secondaryText: "松开结束；最长 2 分钟",
      }),
    }));
    assert.match(recording, /aria-label="停止录音"/);
    assert.match(recording, />停止录音</);
    assert.match(recording, /role="status"/);
    assert.match(recording, /min-width:44px;min-height:44px/);
  });

  it("finishes touch capture by live controller state even when render-time permission state is stale", () => {
    const calls = [];
    assert.equal(finishTouchCapture({
      stopCapture() { calls.push("stop"); return false; },
      cancelCapture(reason) { calls.push(`cancel:${reason}`); return true; },
    }), true);
    assert.deepEqual(calls, ["stop", "cancel:pointer_up_before_permission"]);

    calls.length = 0;
    assert.equal(finishTouchCapture({
      stopCapture() { calls.push("stop"); return true; },
      cancelCapture(reason) { calls.push(`cancel:${reason}`); return true; },
    }), true);
    assert.deepEqual(calls, ["stop"]);
  });

  it("binds touch completion only to a pointer that started recording and cancels busy primary action", () => {
    const busyCalls = [];
    const busyGesture = { pointerId: null, startedCapture: false };
    assert.equal(beginTouchCapture(view({
      status: "processing",
      startCapture() { busyCalls.push("start"); },
      stopCapture() { busyCalls.push("stop"); return true; },
      cancelCapture(reason) { busyCalls.push(`cancel:${reason}`); return true; },
    }), busyGesture, 7), true);
    assert.deepEqual(busyCalls, ["cancel:pointer_busy_cancel"]);
    assert.deepEqual(busyGesture, { pointerId: 7, startedCapture: false });
    assert.equal(finishTouchGesture({
      stopCapture() { busyCalls.push("stop"); return true; },
      cancelCapture(reason) { busyCalls.push(`cancel:${reason}`); return true; },
    }, busyGesture, 7), false);
    assert.deepEqual(busyCalls, ["cancel:pointer_busy_cancel"]);

    const holdCalls = [];
    const holdGesture = { pointerId: null, startedCapture: false };
    assert.equal(beginTouchCapture(view({
      startCapture() { holdCalls.push("start"); },
    }), holdGesture, 8), true);
    assert.deepEqual(holdCalls, ["start"]);
    assert.equal(finishTouchGesture({
      stopCapture() { holdCalls.push("stop"); return true; },
      cancelCapture(reason) { holdCalls.push(`cancel:${reason}`); return true; },
    }, holdGesture, 8), true);
    assert.deepEqual(holdCalls, ["start", "stop"]);

    const cancelledGesture = { pointerId: 9, startedCapture: true };
    assert.equal(cancelTouchGesture({
      cancelCapture(reason) { holdCalls.push(`cancel:${reason}`); return true; },
    }, cancelledGesture, 9), true);
    assert.deepEqual(holdCalls, ["start", "stop", "cancel:pointer_cancel"]);
  });

  it("ignores repeated keyboard activation and scopes synthetic-click suppression to the touch gesture", () => {
    const actions = [];
    const repeated = {
      key: " ",
      repeat: true,
      preventDefault() { actions.push("prevent-repeat"); },
    };
    assert.equal(runPrimaryKeyboardAction(
      repeated,
      { cancelCapture(reason) { actions.push(`cancel:${reason}`); } },
      { action() { actions.push("primary"); } },
      false,
    ), false);
    assert.deepEqual(actions, ["prevent-repeat"]);

    const firstPress = {
      key: "Enter",
      repeat: false,
      preventDefault() { actions.push("prevent-enter"); },
    };
    assert.equal(runPrimaryKeyboardAction(
      firstPress,
      { cancelCapture(reason) { actions.push(`cancel:${reason}`); } },
      { action() { actions.push("primary"); } },
      false,
    ), true);
    assert.deepEqual(actions, ["prevent-repeat", "prevent-enter", "primary"]);

    const token = { current: null };
    assert.equal(updateSyntheticClickToken(token, { pointerType: "touch", pointerId: 31 }), true);
    // pointercancel/leave intentionally leave the token until either the
    // synthesized click or a new real mouse pointerdown resolves ownership.
    assert.equal(consumeSyntheticClickToken(token), true);
    assert.equal(consumeSyntheticClickToken(token), false);

    assert.equal(updateSyntheticClickToken(token, { pointerType: "pen", pointerId: 32 }), true);
    assert.deepEqual(token.current, { pointerType: "pen", pointerId: 32 });
    assert.equal(updateSyntheticClickToken(token, { pointerType: "mouse", pointerId: 1 }), false);
    assert.equal(token.current, null);
    assert.equal(consumeSyntheticClickToken(token), false);
  });

  it("cancels a captured touch when it leaves bounds and never uploads on its later pointerup", () => {
    const calls = [];
    const transcription = {
      stopCapture() { calls.push("stop"); return true; },
      cancelCapture(reason) { calls.push(`cancel:${reason}`); return true; },
    };
    const target = {
      getBoundingClientRect() {
        return { left: 10, right: 54, top: 20, bottom: 64 };
      },
    };
    const gesture = { pointerId: 41, startedCapture: true };
    assert.equal(moveTouchGesture(transcription, gesture, {
      pointerType: "touch",
      pointerId: 41,
      clientX: 80,
      clientY: 40,
      currentTarget: target,
    }), true);
    assert.deepEqual(calls, ["cancel:pointer_leave"]);
    assert.deepEqual(gesture, { pointerId: null, startedCapture: false });
    assert.equal(releaseTouchGesture(transcription, gesture, {
      pointerType: "touch",
      pointerId: 41,
      clientX: 80,
      clientY: 40,
      currentTarget: target,
    }), false);
    assert.deepEqual(calls, ["cancel:pointer_leave"]);

    const noMoveGesture = { pointerId: 42, startedCapture: true };
    assert.equal(releaseTouchGesture(transcription, noMoveGesture, {
      pointerType: "pen",
      pointerId: 42,
      clientX: 80,
      clientY: 40,
      currentTarget: target,
    }), true);
    assert.deepEqual(calls, ["cancel:pointer_leave", "cancel:pointer_leave"]);

    const insideGesture = { pointerId: 43, startedCapture: true };
    assert.equal(releaseTouchGesture(transcription, insideGesture, {
      pointerType: "touch",
      pointerId: 43,
      clientX: 30,
      clientY: 40,
      currentTarget: target,
    }), true);
    assert.deepEqual(calls, ["cancel:pointer_leave", "cancel:pointer_leave", "stop"]);
  });

  it("fences purpose changes, delegates same-purpose success to the latest callback, and cancels disabled work under StrictMode", async () => {
    const browser = await webkit.launch({ headless: true });
    const page = await browser.newPage();
    const browserDiagnostics = [];
    page.on("console", (message) => browserDiagnostics.push(`console:${message.type()}:${message.text()}`));
    page.on("pageerror", (error) => browserDiagnostics.push(`pageerror:${error.message}`));
    page.on("requestfailed", (request) => browserDiagnostics.push(
      `requestfailed:${request.url()}:${request.failure()?.errorText ?? "unknown"}`,
    ));
    try {
      await page.goto(`${viteBaseUrl}/__asr-hook-test`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => window.__asrTest?.snapshot?.().status === "idle",
        null,
        { timeout: 10_000 },
      ).catch((error) => {
        throw new Error(`${error.message}\n${browserDiagnostics.join("\n")}`);
      });

      assert.equal(await page.evaluate(() => window.__asrTest.start()), true);
      await page.waitForFunction(() => window.__asrTest.snapshot().status === "recording");
      await page.evaluate(() => {
        window.__asrTest.advance(500);
        window.__asrTest.stop();
      });
      await page.waitForFunction(() => window.__asrTest.requestCount() === 1);
      await page.evaluate(() => window.__asrTest.render({ callbackLabel: "quick-latest" }));
      await page.waitForFunction(() => window.__asrTest.renderedProps().callbackLabel === "quick-latest");
      await page.evaluate(() => window.__asrTest.resolve(0, "同用途最新回调"));
      await page.waitForFunction(() => window.__asrTest.snapshot().status === "succeeded");
      assert.deepEqual(
        await page.evaluate(() => window.__asrTest.callbacks()),
        ["quick-latest:同用途最新回调"],
      );

      assert.equal(await page.evaluate(() => window.__asrTest.start()), true);
      await page.waitForFunction(() => window.__asrTest.snapshot().status === "recording");
      await page.evaluate(() => {
        window.__asrTest.advance(500);
        window.__asrTest.stop();
      });
      await page.waitForFunction(() => window.__asrTest.requestCount() === 2);
      await page.evaluate(() => window.__asrTest.render({
        purpose: "assistant_chat",
        callbackLabel: "assistant-latest",
      }));
      await page.waitForFunction(() => {
        const snapshot = window.__asrTest.snapshot();
        return snapshot.purpose === "assistant_chat" && snapshot.status === "idle";
      });
      assert.deepEqual(await page.evaluate(() => window.__asrTest.request(1)), {
        purpose: "quick_record",
        durationMs: 500,
        key: "asr:00000000-0000-4000-8000-000000000002",
        aborted: true,
        abortReason: "unmount",
      });
      await page.evaluate(() => window.__asrTest.resolve(1, "旧用途迟到结果"));
      await page.waitForTimeout(20);
      assert.deepEqual(
        await page.evaluate(() => window.__asrTest.callbacks()),
        ["quick-latest:同用途最新回调"],
      );
      assert.deepEqual(await page.evaluate(() => window.__asrTest.snapshot()), {
        status: "idle",
        purpose: "assistant_chat",
        recordingGeneration: 0,
        errorCode: null,
      });

      assert.equal(await page.evaluate(() => window.__asrTest.start()), true);
      await page.waitForFunction(() => window.__asrTest.snapshot().status === "recording");
      const delays = await page.evaluate(() => window.__asrTest.scheduledDelays());
      assert.equal(delays.at(-1), 60_000);
      await page.evaluate(() => window.__asrTest.render({ disabled: true }));
      await page.waitForFunction(() => window.__asrTest.snapshot().status === "cancelled");
      assert.equal(await page.evaluate(() => window.__asrTest.pendingTimers()), 0);
      assert.equal(await page.evaluate(() => window.__asrTest.allTracksStopped()), true);

      await page.evaluate(() => window.__asrTest.render({ disabled: false }));
      await page.waitForFunction(() => window.__asrTest.renderedProps().disabled === false);
      assert.equal(await page.evaluate(() => window.__asrTest.start()), true);
      await page.waitForFunction(() => window.__asrTest.snapshot().status === "recording");
      await page.evaluate(() => {
        window.__asrTest.advance(500);
        window.__asrTest.stop();
      });
      await page.waitForFunction(() => window.__asrTest.requestCount() === 3);
      const processingRequest = await page.evaluate(() => window.__asrTest.request(2));
      assert.equal(processingRequest.purpose, "assistant_chat");
      assert.equal(processingRequest.durationMs, 500);
      assert.notEqual(processingRequest.key, "asr:00000000-0000-4000-8000-000000000002");
      await page.evaluate(() => window.__asrTest.render({ disabled: true }));
      await page.waitForFunction(() => window.__asrTest.snapshot().status === "cancelled");
      assert.equal((await page.evaluate(() => window.__asrTest.request(2))).aborted, true);
      assert.equal(await page.evaluate(() => window.__asrTest.pendingTimers()), 0);

      await page.evaluate(() => window.__asrTest.render({ disabled: false }));
      await page.waitForFunction(() => window.__asrTest.renderedProps().disabled === false);
      assert.equal(await page.evaluate(() => window.__asrTest.start()), true);
      await page.waitForFunction(() => window.__asrTest.snapshot().status === "recording");

      await page.evaluate(() => window.__asrTest.render({ active: false }));
      await page.waitForFunction(() => (
        window.__asrTest.renderedProps().active === false
        && window.__asrTest.snapshot().status === "cancelled"
      ));
      assert.equal(await page.evaluate(() => window.__asrTest.start()), false);
      assert.equal(await page.evaluate(() => window.__asrTest.pendingTimers()), 0);
      await page.evaluate(() => window.__asrTest.render({ active: true }));
      await page.waitForFunction(() => window.__asrTest.renderedProps().active === true);
      assert.equal(await page.evaluate(() => window.__asrTest.start()), true);
      await page.waitForFunction(() => window.__asrTest.snapshot().status === "recording");

      await page.evaluate(() => {
        window.__asrTest.advance(500);
        window.__asrTest.stop();
      });
      await page.waitForFunction(() => window.__asrTest.requestCount() === 4);
      await page.evaluate(() => window.__asrTest.render({
        sessionEpoch: 1,
        resolveOnCommitIndex: 3,
      }));
      await page.waitForFunction(() => (
        window.__asrTest.renderedProps().sessionEpoch === 1
        && window.__asrTest.snapshot().status === "cancelled"
      ));
      assert.deepEqual(await page.evaluate(() => window.__asrTest.callbacks()), [
        "quick-latest:同用途最新回调",
      ]);
      const logoutRequest = await page.evaluate(() => window.__asrTest.request(3));
      assert.equal(logoutRequest.aborted, true);
      assert.equal(logoutRequest.abortReason, "logout");
      assert.equal(await page.evaluate(() => window.__asrTest.pendingTimers()), 0);
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it("contains no playback, object URL, persistence, XHR, download, or audio-history path", async () => {
    const sources = `${await readFile(componentPath, "utf8")}\n${await readFile(hookPath, "utf8")}\n${await readFile(quickRecordPagePath, "utf8")}`;
    assert.doesNotMatch(sources, /<audio\b|createObjectURL|XMLHttpRequest|indexedDB|caches\.open|localStorage|sessionStorage/iu);
    assert.doesNotMatch(sources, /录音已保存|查看录音|播放录音|下载录音|历史录音/u);
    assert.doesNotMatch(sources, /uploading|transcribing/u);
  });

  it("connects quick record to the shared server control and removes its legacy Web Speech mainline", async () => {
    const source = await readFile(quickRecordPagePath, "utf8");
    assert.match(source, /import VoiceCaptureControl from ["']\.\.\/\.\.\/\.\.\/components\/audio\/VoiceCaptureControl\.jsx["']/);
    assert.match(source, /purpose="quick_record"/);
    assert.match(source, /onTranscript=\{handleServerTranscript\}/);
    assert.match(source, /key=\{`quick-record-voice-\$\{voiceSessionEpoch\}`\}/);
    assert.match(source, /active=\{recordMode === "voice"\}/);
    assert.doesNotMatch(source, /SpeechRecognition|webkitSpeechRecognition|getUserMedia|MediaRecorder/);
  });

  it("atomically appends a bounded server transcript and preserves original bytes on overflow", () => {
    assert.equal(QUICK_RECORD_TRANSCRIPT_LIMIT, 10_000);
    assert.equal(QUICK_RECORD_CONTENT_LIMIT, 50_000);
    assert.deepEqual(
      appendQuickRecordTranscript("", "服务端结果"),
      { accepted: true, candidate: "服务端结果", reason: null },
    );
    assert.deepEqual(
      appendQuickRecordTranscript("已有内容", "服务端结果"),
      { accepted: true, candidate: "已有内容\n服务端结果", reason: null },
    );
    assert.equal(
      appendQuickRecordTranscript("  原文  ", "结果").candidate,
      "  原文  \n结果",
    );

    const transcriptAtLimit = "字".repeat(QUICK_RECORD_TRANSCRIPT_LIMIT);
    const transcriptOverLimit = `${transcriptAtLimit}字`;
    assert.equal(appendQuickRecordTranscript("", transcriptAtLimit).accepted, true);
    assert.deepEqual(
      appendQuickRecordTranscript("原文", transcriptOverLimit),
      { accepted: false, candidate: "原文", reason: "transcript_too_long" },
    );

    const draftAtLimit = "字".repeat(QUICK_RECORD_CONTENT_LIMIT);
    assert.equal(appendQuickRecordTranscript(draftAtLimit, "").accepted, true);
    assert.deepEqual(
      appendQuickRecordTranscript(draftAtLimit, "后续"),
      { accepted: false, candidate: draftAtLimit, reason: "content_too_long" },
    );
  });

  it("uses the durable preview status for history labels and pending counts", () => {
    const base = {
      status: "analyzed",
      occurredAt: "2026-08-31T10:00:00+08:00",
      rawContent: "快速记录",
      confirmationPreviewId: null,
      confirmationPreviewStatus: null,
    };
    assert.equal(quickRecordHistoryView(base).status, "待生成预览");
    assert.equal(quickRecordNeedsConfirmation(base), true);
    assert.equal(quickRecordHistoryView({ ...base, confirmationPreviewStatus: "open" }).status, "待确认");
    assert.equal(quickRecordNeedsConfirmation({ ...base, confirmationPreviewStatus: "open" }), true);
    assert.equal(quickRecordHistoryView({ ...base, confirmationPreviewStatus: "completed" }).status, "已确认");
    assert.equal(quickRecordNeedsConfirmation({ ...base, confirmationPreviewStatus: "completed" }), false);
    assert.equal(quickRecordHistoryView({ ...base, confirmationPreviewStatus: "cancelled" }).status, "已取消");
    assert.equal(quickRecordNeedsConfirmation({ ...base, confirmationPreviewStatus: "cancelled" }), false);
    assert.equal(quickRecordNeedsConfirmation({ ...base, status: "confirmed" }), false);
  });

  it("keeps quick-record analysis human-gated and fences every draft-replacement path", async () => {
    const source = await readFile(quickRecordPagePath, "utf8");
    assert.match(source, /voiceApplyEpochRef\.current !== voiceSessionEpoch/);
    assert.match(source, /function startBlankRecord\(\) \{[\s\S]*?invalidateVoiceCapture\(\)/);
    assert.match(source, /function loadHistoricalRecord\(item\) \{[\s\S]*?invalidateVoiceCapture\(\)/);
    assert.match(source, /function switchToTextRecord\(\) \{[\s\S]*?invalidateVoiceCapture\(\)/);
    assert.match(source, /sourceChannel: voiceCapturedRef\.current \? "语音转写" : "快速记录"/);
    assert.match(source, /data-testid="confirm-ai-analysis"/);
    assert.match(source, /onClick=\{confirmAnalysis\}/);
    const transcriptHandler = source.slice(
      source.indexOf("function handleServerTranscript"),
      source.indexOf("useEffect(() => {", source.indexOf("function handleServerTranscript")),
    );
    assert.doesNotMatch(transcriptHandler, /analyzeQuickRecord|createQuickRecord|confirmAnalysis\(/);
  });

  it("keeps terminal history read-only and labels the manual confirmation log", async () => {
    const source = await readFile(quickRecordPagePath, "utf8");
    assert.match(
      source,
      /disabled=\{confirmationPending \|\| analysisSavePending \|\| pageReadOnly\}/,
      "supplement-and-reanalyze must be disabled for historical and terminal records",
    );
    assert.match(
      source,
      /<span>人工确认同步日志<\/span>/,
      "sync log title must identify human-confirmed writes",
    );
    assert.match(
      source,
      /<b>\{syncLog\.length\} 条<\/b>/,
      "sync log count must show the durable row count without a fixed denominator",
    );
    assert.doesNotMatch(source, /\{syncLog\.length\}\/3/);
  });
});
