import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSalesWorkbenchWeixinAgent } from "../src/weixin/agentBridge.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe("weixin sales workbench agent", () => {
  it("buffers multiple WeChat messages, analyzes on record command, accepts corrections, and writes only on enter command", async () => {
    const calls = [];
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      now: () => new Date("2026-06-10T09:30:00.000Z"),
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/quick-records/preview")) {
          return jsonResponse({
            item: {
              id: "preview-session-1",
              confidence: 90,
              customer: { value: "日照中医医院" },
              opportunity: { value: "十五五规划" },
              summary: {
                request: { text: "补齐十五五规划材料" },
                risk: { text: "预算路径待确认" },
                action: { text: "整理预算路径并输出材料" },
              },
            },
          });
        }
        if (url.endsWith("/api/quick-records")) {
          const payload = JSON.parse(options.body);
          return jsonResponse(
            {
              item: {
                id: "qr-weixin-session-1",
                rawContent: payload.rawContent,
                status: "recorded",
                sourceChannel: payload.sourceChannel,
              },
            },
            201,
          );
        }
        if (url.endsWith("/api/quick-records/qr-weixin-session-1/analyze")) {
          return jsonResponse(
            {
              item: {
                id: "insight-session-1",
                confidence: 90,
                customer: { value: "日照中医医院" },
                opportunity: { value: "十五五规划" },
                summary: {
                  request: { text: "补齐十五五规划材料" },
                  action: { text: "整理预算路径并输出材料" },
                },
              },
            },
            201,
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const first = await agent.chat({ conversationId: "wx-user-1", text: "今天拜访日照中医医院，客户要十五五规划材料。" });
    const second = await agent.chat({ conversationId: "wx-user-1", text: "客户还提到移动云体验差，预算路径需要确认。", media: { type: "audio" } });
    const preview = await agent.chat({ conversationId: "wx-user-1", text: "记录" });
    const corrected = await agent.chat({ conversationId: "wx-user-1", text: "修改：客户名称是日照中医医院，联系人是梁斌。" });
    const entered = await agent.chat({ conversationId: "wx-user-1", text: "录入" });

    assert.equal(calls.length, 4);
    assert.match(first.text, /已暂存/);
    assert.match(second.text, /已暂存/);
    assert.match(preview.text, /待确认/);
    assert.match(preview.text, /日照中医医院/);
    assert.match(corrected.text, /已更新/);
    assert.match(entered.text, /已录入系统/);
    assert.equal(calls[0].url, "https://sales.example.test/api/quick-records/preview");
    assert.equal(calls[1].url, "https://sales.example.test/api/quick-records/preview");
    assert.equal(calls[2].url, "https://sales.example.test/api/quick-records");
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      rawContent: [
        "今天拜访日照中医医院，客户要十五五规划材料。",
        "客户还提到移动云体验差，预算路径需要确认。",
        "修改：客户名称是日照中医医院，联系人是梁斌。",
      ].join("\n"),
      occurredAt: "2026-06-10T09:30:00.000Z",
      sourceChannel: "wechat_mixed",
    });
    assert.equal(calls[3].url, "https://sales.example.test/api/quick-records/qr-weixin-session-1/analyze");
  });

  it("searches customers with a natural query command instead of creating a draft record", async () => {
    const calls = [];
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return jsonResponse({
          items: [
            { id: "rizhao", name: "日照中医医院", region: "日照", owner: "继振", level: "重点推进", type: "医疗 KA" },
            { id: "huangdao", name: "黄岛区中医院", region: "青岛", owner: "王滨", level: "高潜商机", type: "医院" },
          ],
        });
      },
    });

    const reply = await agent.chat({
      conversationId: "wx-user-1",
      text: "查询日照中医医院",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://sales.example.test/api/customers");
    assert.match(reply.text, /日照中医医院/);
    assert.doesNotMatch(reply.text, /黄岛区中医院/);
  });

  it("creates and analyzes a quick record from an inbound WeChat text message", async () => {
    const calls = [];
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      now: () => new Date("2026-06-09T08:00:00.000Z"),
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/quick-records/preview")) {
          return jsonResponse({
            item: {
              customer: { value: "日照中医医院" },
              opportunity: { value: "十五五规划" },
              summary: {
                request: { text: "补齐规划材料" },
                risk: { text: "预算路径待确认" },
                action: { text: "生成材料大纲并人工确认入库" },
              },
            },
          });
        }
        if (url.endsWith("/api/quick-records")) {
          return jsonResponse(
            {
              item: {
                id: "qr-weixin-1",
                rawContent: "拜访日照中医医院，客户希望补齐十五五规划材料。",
                status: "recorded",
                sourceChannel: "wechat_text",
              },
            },
            201,
          );
        }
        if (url.endsWith("/api/quick-records/qr-weixin-1/analyze")) {
          return jsonResponse(
            {
              item: {
                id: "insight-1",
                confidence: 88,
                customer: { value: "日照中医医院" },
                opportunity: { value: "十五五规划" },
                summary: {
                  request: { text: "补齐规划材料" },
                  action: { text: "生成材料大纲并人工确认入库" },
                },
              },
            },
            201,
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const drafted = await agent.chat({
      conversationId: "wx-user-1",
      text: "拜访日照中医医院，客户希望补齐十五五规划材料。",
    });
    const preview = await agent.chat({
      conversationId: "wx-user-1",
      text: "记录",
    });
    const reply = await agent.chat({
      conversationId: "wx-user-1",
      text: "录入",
    });

    assert.equal(calls.length, 3);
    assert.match(drafted.text, /已暂存/);
    assert.match(preview.text, /待确认/);
    assert.equal(calls[0].url, "https://sales.example.test/api/quick-records/preview");
    assert.equal(calls[1].url, "https://sales.example.test/api/quick-records");
    assert.equal(calls[1].options.method, "POST");
    assert.equal(calls[1].options.headers.Authorization, "Bearer machine-token");
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      rawContent: "拜访日照中医医院，客户希望补齐十五五规划材料。",
      occurredAt: "2026-06-09T08:00:00.000Z",
      sourceChannel: "wechat_text",
    });
    assert.equal(calls[2].url, "https://sales.example.test/api/quick-records/qr-weixin-1/analyze");
    assert.match(reply.text, /已录入系统/);
    assert.match(reply.text, /日照中医医院/);
    assert.match(reply.text, /qr-weixin-1/);
  });

  it("uses WeChat voice transcription text as a voice quick record", async () => {
    const payloads = [];
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      now: () => new Date("2026-06-09T08:00:00.000Z"),
      fetchImpl: async (url, options = {}) => {
        if (url.endsWith("/api/quick-records/preview")) {
          return jsonResponse({
            item: {
              customer: { value: "待匹配客户" },
              opportunity: { value: "待确认商机" },
              summary: {
                request: { text: "已转写" },
                risk: { text: "待确认" },
                action: { text: "待确认" },
              },
            },
          });
        }
        if (url.endsWith("/api/quick-records")) {
          payloads.push(JSON.parse(options.body));
          return jsonResponse({ item: { id: "qr-voice-1" } }, 201);
        }
        return jsonResponse({ item: { summary: { request: { text: "已转写" }, action: { text: "待确认" } } } }, 201);
      },
    });

    const drafted = await agent.chat({
      conversationId: "wx-user-1",
      text: "语音转写后的拜访记录",
      media: { type: "audio", filePath: "/tmp/audio.wav", mimeType: "audio/wav" },
    });
    const preview = await agent.chat({ conversationId: "wx-user-1", text: "记录" });
    const reply = await agent.chat({ conversationId: "wx-user-1", text: "录入" });

    assert.match(drafted.text, /已暂存/);
    assert.match(preview.text, /待确认/);
    assert.equal(payloads[0].sourceChannel, "wechat_voice");
    assert.match(reply.text, /已录入系统/);
  });

  it("searches customers with a slash command instead of creating a new record", async () => {
    const calls = [];
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return jsonResponse({
          items: [
            { id: "rizhao", name: "日照中医医院", region: "日照", owner: "继振", level: "重点推进" },
            { id: "huangdao", name: "黄岛区中医院", region: "青岛", owner: "王滨", level: "高潜商机" },
          ],
        });
      },
    });

    const reply = await agent.chat({
      conversationId: "wx-user-1",
      text: "/客户 日照",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://sales.example.test/api/customers");
    assert.match(reply.text, /日照中医医院/);
    assert.doesNotMatch(reply.text, /黄岛区中医院/);
  });
});
