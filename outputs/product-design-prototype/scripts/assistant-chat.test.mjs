import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  appendMessage,
  mergeHistoryMessages,
  shouldRefreshBootstrap,
} from "../src/components/assistant/assistantChatModel.js";
import { appendAssistantErrorBubble } from "../src/app/useAssistantChat.js";

const confirmSource = readFileSync(resolve("src/components/assistant/AssistantConfirmCard.jsx"), "utf8");

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
