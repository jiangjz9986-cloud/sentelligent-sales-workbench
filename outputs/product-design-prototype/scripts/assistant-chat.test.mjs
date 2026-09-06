import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  appendMessage,
  mergeHistoryMessages,
  shouldRefreshBootstrap,
} from "../src/components/assistant/assistantChatModel.js";
import {
  appendAssistantErrorBubble,
  appendTranscriptToDraftValue,
} from "../src/app/useAssistantChat.js";

const confirmSource = readFileSync(resolve("src/components/assistant/AssistantConfirmCard.jsx"), "utf8");
const hookSource = readFileSync(resolve("src/app/useAssistantChat.js"), "utf8");
const panelSource = readFileSync(resolve("src/components/assistant/AssistantChatPanel.jsx"), "utf8");
const shellSource = readFileSync(resolve("src/app/SalesWorkbenchShell.jsx"), "utf8");

describe("assistantChatModel", () => {
  it("merges remote history without duplicating local ids", () => {
    const local = [{ id: "assistant-1", role: "assistant", text: "本地" }];
    const remote = [{ role: "user", text: "帮助", at: "2026-08-30T00:00:00.000Z" }];
    const merged = mergeHistoryMessages(local, remote);
    assert.equal(merged.length, 2);
  });

  it("appends messages immutably", () => {
    const first = appendMessage([], { id: "1", role: "user", text: "你好" });
    const second = appendMessage(first, { id: "2", role: "assistant", text: "在" });
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
  });

  it("flags write tools that should refresh bootstrap", () => {
    assert.equal(shouldRefreshBootstrap("customer.update"), true);
    assert.equal(shouldRefreshBootstrap("dashboard.summary"), false);
  });
});

describe("AssistantConfirmCard", () => {
  it("renders confirm actions for R1/R2/R3 cards", () => {
    assert.match(confirmSource, /assistant-confirm-submit/);
    assert.match(confirmSource, /确认删除/);
    assert.match(confirmSource, /danger-button/);
  });

  it("falls back to preformatted text when card parsing fails", () => {
    assert.match(confirmSource, /assistant-confirm-fallback/);
  });

  it("does not reference confirmationCode", () => {
    assert.doesNotMatch(confirmSource, /confirmationCode/);
  });

  it("exposes cancel and confirm handlers", () => {
    assert.match(confirmSource, /onCancel/);
    assert.match(confirmSource, /onConfirm/);
  });
});

describe("useAssistantChat error responses", () => {
  it("appends a denied assistant bubble from only the 403 top-level message", () => {
    const prior = [{ id: "user-1", role: "user", text: "记一笔午餐 50", status: "ok" }];
    const error = Object.assign(new Error("Request failed with 403: provider-secret"), {
      status: 403,
      body: {
        status: "error",
        message: "该操作请使用微信小小。",
        error: { message: "nested-provider-secret" },
        providerBody: "raw-provider-body",
      },
    });
    const next = appendAssistantErrorBubble(prior, error);
    assert.equal(next.length, 2);
    assert.equal(next[1].role, "assistant");
    assert.equal(next[1].status, "denied");
    assert.equal(next[1].text, "该操作请使用微信小小。");
    assert.doesNotMatch(JSON.stringify(next[1]), /provider-secret|raw-provider-body/u);
  });

  it("uses a fixed 403 fallback instead of nested error or provider bodies", () => {
    const error = {
      status: 403,
      message: "provider-secret",
      body: { error: { message: "nested-provider-secret" }, providerBody: "raw-provider-body" },
    };
    const next = appendAssistantErrorBubble([], error);
    assert.equal(next[0].status, "denied");
    assert.equal(next[0].text, "该操作当前不可用。");
    assert.doesNotMatch(JSON.stringify(next[0]), /provider-secret|raw-provider-body/u);
  });
});

describe("assistant transcript draft merge", () => {
  it("writes a transcript into an empty draft", () => {
    assert.deepEqual(appendTranscriptToDraftValue("", "拜访记录"), {
      accepted: true,
      draft: "拜访记录",
      message: "已转成文字，请确认后发送",
    });
  });

  it("uses exactly one newline for a non-empty draft", () => {
    assert.deepEqual(appendTranscriptToDraftValue("已有内容", "补充内容"), {
      accepted: true,
      draft: "已有内容\n补充内容",
      message: "已转成文字，请确认后发送",
    });
  });

  it("rejects empty and non-string transcript payloads without false success feedback", () => {
    const existing = "原稿\n保持逐字不变";
    for (const transcript of [undefined, null, "", " \n"]) {
      assert.deepEqual(appendTranscriptToDraftValue(existing, transcript), {
        accepted: false,
        draft: existing,
        message: "转写结果没有有效文字，请重新录音",
      });
    }
  });

  it("accepts a single transcript of exactly 2000 characters", () => {
    const transcript = "语".repeat(2000);
    const result = appendTranscriptToDraftValue("", transcript);
    assert.equal(result.accepted, true);
    assert.equal(result.draft, transcript);
  });

  it("rejects a single transcript of 2001 characters without changing the draft", () => {
    const existing = "原稿\n保持逐字不变";
    const result = appendTranscriptToDraftValue(existing, "语".repeat(2001));
    assert.deepEqual(result, {
      accepted: false,
      draft: existing,
      message: "录音内容过长，请缩短重录",
    });
  });

  it("accepts a merged draft of exactly 2000 characters", () => {
    const existing = "已".repeat(1998);
    const result = appendTranscriptToDraftValue(existing, "补");
    assert.equal(result.accepted, true);
    assert.equal(result.draft, `${existing}\n补`);
    assert.equal(result.draft.length, 2000);
  });

  it("rejects a merged draft of 2001 characters without changing the draft", () => {
    const existing = "已".repeat(1999);
    const result = appendTranscriptToDraftValue(existing, "补");
    assert.equal(result.accepted, false);
    assert.equal(result.draft, existing);
    assert.equal(result.draft.length, 1999);
    assert.equal(result.message, "录音内容过长，请缩短重录");
  });
});

describe("assistant voice capture source contract", () => {
  it("merges against the latest draft with a functional composer update", () => {
    assert.match(hookSource, /setComposer\(\(current\) =>/u);
    assert.match(hookSource, /current \+ \(current && text \? "\\n" : ""\) \+ text/u);
  });

  it("wires the shared control for assistant_chat without auto-sending", () => {
    assert.match(panelSource, /VoiceCaptureControl/u);
    assert.match(panelSource, /purpose="assistant_chat"/u);
    assert.match(panelSource, /onTranscript=\{appendTranscriptToDraft\}/u);
    assert.match(panelSource, /active=\{open\}/u);
    assert.match(panelSource, /disabled=\{busy \|\| Boolean\(pending\) \|\| !online\}/u);

    const appendStart = hookSource.indexOf("const appendTranscriptToDraft");
    const sendStart = hookSource.indexOf("const sendMessage", appendStart);
    assert.notEqual(appendStart, -1);
    assert.notEqual(sendStart, -1);
    assert.doesNotMatch(hookSource.slice(appendStart, sendStart), /postAssistantChat/u);
  });

  it("passes online and session lifecycle fences from the shell", () => {
    assert.match(shellSource, /apiClient=\{apiClient\}/u);
    assert.match(shellSource, /online=\{assistantOnline\}/u);
    assert.match(shellSource, /sessionEpoch=\{authSession\?\.account \?\? null\}/u);
    assert.match(shellSource, /appendTranscriptToDraft=\{assistantChat\.appendTranscriptToDraft\}/u);
  });

  it("does not add audio persistence, playback, download, or object URLs", () => {
    assert.doesNotMatch(panelSource, /<audio\b|URL\.createObjectURL|IndexedDB|CacheStorage/u);
    assert.doesNotMatch(panelSource, /录音已保存|查看录音|播放|下载|历史录音/u);
  });
});
