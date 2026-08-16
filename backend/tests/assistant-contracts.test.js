import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AssistantContractError,
  validateToolInvocation,
} from "../src/assistant/contracts.js";
import {
  classifyWeixinConfirmationText,
  validateWeixinAssistantEvent,
} from "../src/assistant/weixinEvent.js";

describe("assistant tool contracts", () => {
  it("normalizes a safe tool invocation", () => {
    const result = validateToolInvocation({
      agentId: "customer",
      toolName: "customer.search",
      arguments: { query: "医院" },
    });
    assert.deepEqual(result, {
      agentId: "customer",
      toolName: "customer.search",
      arguments: { query: "医院" },
    });
  });

  it("rejects model-controlled identity, transport, query, and path fields", () => {
    for (const key of ["owner", "actor", "token", "url", "httpMethod", "sql", "filePath"]) {
      assert.throws(
        () => validateToolInvocation({ agentId: "customer", toolName: "customer.search", arguments: { query: "x", [key]: "unsafe" } }),
        AssistantContractError,
      );
    }
  });

  it("rejects path-like argument values and non-plain argument objects", () => {
    assert.throws(
      () => validateToolInvocation({ agentId: "invoice", toolName: "invoice.ingest", arguments: { document: "C:\\secret\\invoice.pdf" } }),
      /path|unsafe/i,
    );
    assert.throws(
      () => validateToolInvocation({ agentId: "customer", toolName: "customer.search", arguments: [] }),
      AssistantContractError,
    );
  });

  it("rejects prototype-pollution keys at any argument depth", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const argumentsValue = JSON.parse(`{"safe":{"${key}":{"polluted":true}}}`);
      assert.throws(
        () => validateToolInvocation({ agentId: "customer", toolName: "customer.search", arguments: argumentsValue }),
        (error) => error instanceof AssistantContractError && error.code === "forbidden_field",
      );
    }
  });
});

describe("weixin confirmation text contracts", () => {
  it("classifies only exact raw ASCII confirmation commands", () => {
    const cases = [
      ["012345", { kind: "code", code: "012345" }],
      ["取消", { kind: "cancel" }],
      ["重发确认码", { kind: "resend" }],
      [" 012345", { kind: "ordinary" }],
      ["012345\n", { kind: "ordinary" }],
      ["１２３４５６", { kind: "ordinary" }],
      ["确认 012345", { kind: "ordinary" }],
      ["0123457", { kind: "ordinary" }],
    ];

    for (const [rawText, expected] of cases) {
      assert.deepEqual(classifyWeixinConfirmationText(rawText), expected, JSON.stringify(rawText));
    }
  });

  it("returns the original bounded event text while identifiers remain normalized", async () => {
    const event = await validateWeixinAssistantEvent({
      conversationId: " conversation-a ",
      text: "  保留原文\n",
      sourceMessageId: " source-a ",
      senderId: " sender-a ",
    });

    assert.equal(event.text, "  保留原文\n");
    assert.equal(event.conversationId, "conversation-a");
    assert.equal(event.sourceMessageId, "source-a");
    assert.equal(event.senderId, "sender-a");
    assert.equal(Object.hasOwn(event, "rawText"), false);
  });

  it("rejects structured confirmation codes unless the raw field is exactly six ASCII digits", async () => {
    for (const confirmationCode of [" 482913", "482913\n", "４８２９１３", "4829137"] ) {
      await assert.rejects(
        validateWeixinAssistantEvent({
          conversationId: "conversation-a",
          text: "confirm",
          sourceMessageId: "source-a",
          senderId: "sender-a",
          confirmationCode,
        }),
        (error) => error?.status === 422 && error?.fields?.confirmationCode === "format",
      );
    }
  });
});
