import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  deriveWebExplicitCredential,
  isWebClosedTool,
  mapAssistantWebResponse,
  safeWebPendingResponse,
} from "../src/assistant/webChannel.js";
import { parseWeixinCardText } from "../src/assistant/weixinCard.js";

const secret = Buffer.alloc(32, 7);

test("deriveWebExplicitCredential is deterministic for the same action id", () => {
  const first = deriveWebExplicitCredential(secret, "action-123");
  const second = deriveWebExplicitCredential(secret, "action-123");
  assert.match(first, /^\d{6}$/u);
  assert.equal(first, second);
  assert.notEqual(first, deriveWebExplicitCredential(secret, "action-456"));
});

test("deriveWebExplicitCredential differs from affirm credential domain", () => {
  const web = deriveWebExplicitCredential(secret, "shared-id");
  const affirm = String(createHmac("sha256", secret)
    .update(`sentelligent/assistant-affirm-confirmation/v1\u0000shared-id`, "utf8")
    .digest()
    .readUInt32BE(0) % 1_000_000).padStart(6, "0");
  assert.notEqual(web, affirm);
});

test("safeWebPendingResponse never includes confirmationCode", () => {
  const tool = { description: "更新客户" };
  const response = safeWebPendingResponse(tool, { preview: "【客户更新】\n名称：协和\n\n请确认。" });
  assert.equal(response.confirmationCode, undefined);
  assert.ok(response.card);
  assert.equal(response.card.title, "客户更新");
});

test("mapAssistantWebResponse strips confirmationCode and adds card", () => {
  const mapped = mapAssistantWebResponse({
    status: 200,
    body: {
      status: "confirmation_required",
      confirmationCode: "123456",
      text: "【待确认】\n操作：删除客户\n\n请回复六位码。",
    },
  });
  assert.equal(mapped.body.confirmationCode, undefined);
  assert.equal(mapped.body.card?.title, "待确认");
});

test("mapAssistantWebResponse safely flattens result text and card while preserving result", () => {
  const result = {
    text: "【客户】\n1：协和Web助手  北京",
    card: { title: "客户", fields: [["1", "协和Web助手  北京"]], footer: null },
    items: [{ id: "customer-1", name: "协和Web助手" }],
  };
  const mapped = mapAssistantWebResponse({
    status: 200,
    body: { status: "ok", toolName: "customer.search", result },
  });
  assert.equal(mapped.body.text, result.text);
  assert.deepEqual(mapped.body.card, result.card);
  assert.deepEqual(mapped.body.result, result);

  const unsafeResult = { text: { providerBody: "raw-text" }, card: "raw-card" };
  const unsafe = mapAssistantWebResponse({ status: 200, body: { status: "ok", result: unsafeResult } });
  assert.equal(unsafe.body.text, undefined);
  assert.equal(unsafe.body.card, undefined);
  assert.deepEqual(unsafe.body.result, unsafeResult);
});

test("isWebClosedTool opens only the explicit WEB_OPEN_TOOLS allowlist", () => {
  assert.equal(isWebClosedTool("bookkeeping.confirm"), true);
  assert.equal(isWebClosedTool("visit-capture.capture"), true);
  assert.equal(isWebClosedTool("itinerary.summary"), true, "registered but unopened tools fail closed");
  assert.equal(isWebClosedTool("unregistered.future-tool"), true, "unknown tools fail closed");
  assert.equal(isWebClosedTool(null), true, "null tools fail closed");
  assert.equal(isWebClosedTool("customer.search"), false);
});

test("parseWeixinCardText round-trips card titles and fields", () => {
  const parsed = parseWeixinCardText("【客户画像】\n名称：协和\n区域：北京\n\n请确认。");
  assert.deepEqual(parsed, {
    title: "客户画像",
    fields: [["名称", "协和"], ["区域", "北京"]],
    footer: "请确认。",
  });
});
