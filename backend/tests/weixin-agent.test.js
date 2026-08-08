import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createSalesWorkbenchWeixinAgent } from "../src/weixin/agentBridge.js";
import { minimalPdf, VALID_PNG } from "./helpers/image-fixtures.js";

const tempDirectories = [];

async function createMediaFile(fileName, content) {
  const directory = await mkdtemp(join(tmpdir(), "sentelligent-weixin-media-"));
  tempDirectories.push(directory);
  const filePath = join(directory, fileName);
  await writeFile(filePath, content);
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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

  it("uploads a validated payment proof from the SDK-decrypted file path with an explicit expense reference", async () => {
    const filePath = await createMediaFile("payment-proof.png", VALID_PNG);
    const calls = [];
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      now: () => new Date("2026-08-05T02:00:00.000Z"),
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return jsonResponse({
          item: {
            status: "review_required",
            expenseReferenceCode: "EXP-20260804-A1",
            recognition: {
              evidence: { amountCents: 4850, occurredOn: "2026-08-04", paidTime: "18:23" },
              warnings: [],
            },
            candidates: [
              { paymentId: "payment-1", paidAt: "2026-08-04T18:23:00+08:00", amountCents: 4850 },
            ],
          },
        }, 201);
      },
    });

    const reply = await agent.chat({
      conversationId: "wx-user-1",
      messageId: "wx-message-1",
      text: "/付款凭证 EXP-20260804-A1 8月4日 18:23 48.50元",
      media: { type: "image", filePath, mimeType: "image/*", fileName: "付款截图.png" },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://sales.example.test/api/travel-expense-document-inbox");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers.Authorization, "Bearer machine-token");
    assert.match(calls[0].options.headers["Idempotency-Key"], /^weixin:[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      expenseReferenceCode: "EXP-20260804-A1",
      fileName: "付款截图.png",
      mediaType: "image/png",
      contentBase64: VALID_PNG.toString("base64"),
      sourceRef: "wx-message-1",
      textHint: "8月4日 18:23 48.50元",
      amountCents: 4850,
      occurredOn: "2026-08-04",
      paidTime: "18:23",
      matchMode: "expense_reference",
    });
    assert.match(reply.text, /付款凭证已上传/);
    assert.match(reply.text, /候选付款 1 笔/);
    assert.match(reply.text, /尚未自动关联/);
    assert.match(reply.text, /已识别.*¥48\.50.*2026-08-04.*18:23/);
  });

  it("reports a uniquely matched payment proof as already linked", async () => {
    const filePath = await createMediaFile("matched-payment-proof.png", VALID_PNG);
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      now: () => new Date("2026-08-05T02:00:00.000Z"),
      fetchImpl: async () => jsonResponse({
        item: {
          status: "matched",
          attachmentId: "attachment-1",
          matchedPaymentId: "payment-1",
          expenseReferenceCode: "EXP-20260804-A1",
          candidates: [
            { paymentId: "payment-1", paidAt: "2026-08-04T18:23:00+08:00", amountCents: 4850 },
          ],
        },
      }, 201),
    });

    const reply = await agent.chat({
      conversationId: "wx-user-matched",
      messageId: "wx-message-matched",
      text: "/付款凭证 EXP-20260804-A1 8月4日 18:23 48.50元",
      media: { type: "image", filePath, mimeType: "image/*", fileName: "付款截图.png" },
    });

    assert.match(reply.text, /已自动关联/);
    assert.match(reply.text, /payment-1/);
    assert.doesNotMatch(reply.text, /尚未自动关联/);
  });

  it("does not expose internal recognition codes when a payment proof needs manual review", async () => {
    const filePath = await createMediaFile("unrecognized-payment-proof.png", VALID_PNG);
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      now: () => new Date("2026-08-05T02:00:00.000Z"),
      fetchImpl: async () => jsonResponse({
        item: {
          status: "review_required",
          errorCode: "OCR_UNAVAILABLE",
          recognition: {
            evidence: null,
            warnings: ["OCR_UNAVAILABLE", "MODEL_TIMEOUT"],
          },
          candidates: [],
        },
      }, 202),
    });

    const reply = await agent.chat({
      conversationId: "wx-user-recognition-failed",
      messageId: "wx-message-recognition-failed",
      text: "/付款凭证",
      media: { type: "image", filePath, mimeType: "image/*", fileName: "付款截图.png" },
    });

    assert.match(reply.text, /自动识别未完成/);
    assert.match(reply.text, /原件已无损保留/);
    assert.doesNotMatch(reply.text, /OCR_UNAVAILABLE|MODEL_TIMEOUT|errorCode|warning/i);
  });

  it("extracts amount and time hints without an EXP reference and requests candidates only", async () => {
    const filePath = await createMediaFile("sdk-image.bin", VALID_PNG);
    const calls = [];
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      now: () => new Date("2026-08-05T02:00:00.000Z"),
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return jsonResponse({
          item: {
            status: "candidate_review",
            expenseReferenceCode: null,
            candidates: [
              { paymentId: "payment-candidate", paidAt: "2026-08-04T18:23:00+08:00", amountCents: 4850 },
              { paymentId: "payment-candidate-2", paidAt: "2026-08-04T18:24:00+08:00", amountCents: 4850 },
              { paymentId: "payment-candidate-3", paidAt: "2026-08-04T18:25:00+08:00", amountCents: 4850 },
              { paymentId: "payment-candidate-4", paidAt: "2026-08-04T18:26:00+08:00", amountCents: 4850 },
              { paymentId: "payment-candidate-5", paidAt: "2026-08-04T18:27:00+08:00", amountCents: 4850 },
              { paymentId: "payment-candidate-6", paidAt: "2026-08-04T18:28:00+08:00", amountCents: 4850 },
            ],
          },
        }, 201);
      },
    });

    const reply = await agent.chat({
      conversationId: "wx-user-2",
      text: "/付款凭证 8月4日 18:23 48.50元",
      media: { type: "image", filePath, mimeType: "image/*" },
    });

    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.expenseReferenceCode, null);
    assert.equal(payload.amountCents, 4850);
    assert.equal(payload.occurredOn, "2026-08-04");
    assert.equal(payload.paidTime, "18:23");
    assert.equal(payload.matchMode, "candidates_only");
    assert.match(payload.fileName, /^weixin-[0-9a-f]{16}\.png$/);
    assert.match(payload.sourceRef, /^weixin:[0-9a-f]{64}$/);
    assert.match(reply.text, /未提供 EXP 编号/);
    assert.match(reply.text, /候选付款 6 笔/);
    assert.match(reply.text, /未自动关联/);
  });

  it("uploads an invoice PDF directly to the invoice repository without requiring an expense match", async () => {
    const pdf = minimalPdf("weixin-invoice");
    const filePath = await createMediaFile("invoice.pdf", pdf);
    const calls = [];
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return jsonResponse({ item: { id: "invoice-1", status: "review_required" } }, 201);
      },
    });

    const reply = await agent.chat({
      conversationId: "wx-user-3",
      messageId: "wx-invoice-message-1",
      text: "/发票",
      media: { type: "file", filePath, mimeType: "application/pdf", fileName: "住宿发票.pdf" },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://sales.example.test/api/invoices");
    assert.match(calls[0].options.headers["Idempotency-Key"], /^weixin:[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      fileName: "住宿发票.pdf",
      mediaType: "application/pdf",
      contentBase64: pdf.toString("base64"),
      sourceRef: "wx-invoice-message-1",
    });
    assert.match(reply.text, /发票已存入发票仓库/);
    assert.match(reply.text, /无需先匹配费用/);
  });

  it("returns recoverable Chinese guidance for missing media, unsupported media, and missing files", async () => {
    let fetchCalls = 0;
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not run");
      },
    });

    const noMedia = await agent.chat({ conversationId: "wx-user-4", text: "/付款凭证 EXP-1" });
    const wrongType = await agent.chat({
      conversationId: "wx-user-4",
      text: "/发票",
      media: { type: "audio", filePath: "C:\\private\\voice.wav", mimeType: "audio/wav" },
    });
    const missingFile = await agent.chat({
      conversationId: "wx-user-4",
      text: "/发票",
      media: { type: "file", filePath: "C:\\private\\missing-secret.pdf", mimeType: "application/pdf" },
    });

    assert.match(noMedia.text, /请把图片或 PDF 和命令一起发送/);
    assert.match(wrongType.text, /只支持 JPG、PNG、WebP 图片或 PDF/);
    assert.match(missingFile.text, /文件读取失败，请重新发送/);
    assert.doesNotMatch(missingFile.text, /private|missing-secret|C:\\/i);
    assert.equal(fetchCalls, 0);
  });

  it("rejects oversized, unsafe-name, and MIME or magic mismatched media before upload", async () => {
    const oversizedPath = await createMediaFile("oversized.png", Buffer.alloc(1));
    const oversizedHandle = await open(oversizedPath, "r+");
    await oversizedHandle.truncate(12 * 1024 * 1024 + 1);
    await oversizedHandle.close();
    const pngPath = await createMediaFile("actual.png", VALID_PNG);
    const fakePath = await createMediaFile("fake.png", Buffer.from("not an image", "utf8"));
    let fetchCalls = 0;
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not run");
      },
    });

    const oversized = await agent.chat({
      text: "/发票",
      media: { type: "image", filePath: oversizedPath, mimeType: "image/*" },
    });
    const unsafeName = await agent.chat({
      text: "/发票",
      media: { type: "image", filePath: pngPath, mimeType: "image/*", fileName: "../secret.png" },
    });
    const mismatch = await agent.chat({
      text: "/发票",
      media: { type: "file", filePath: pngPath, mimeType: "application/pdf", fileName: "wrong.pdf" },
    });
    const badMagic = await agent.chat({
      text: "/发票",
      media: { type: "image", filePath: fakePath, mimeType: "image/*" },
    });

    assert.match(oversized.text, /文件不能超过 12 MiB/);
    assert.match(unsafeName.text, /文件名无效，请重命名后重新发送/);
    assert.match(mismatch.text, /文件类型与实际内容不一致/);
    assert.match(badMagic.text, /无法识别文件内容/);
    assert.equal(fetchCalls, 0);
  });

  it("sanitizes backend failures for media commands without leaking internal details", async () => {
    const filePath = await createMediaFile("invoice.png", VALID_PNG);
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "machine-token",
      fetchImpl: async () => jsonResponse({ message: "internal-backend-sentinel C:\\secret\\invoice.png token=abc" }, 500),
    });

    const reply = await agent.chat({
      text: "/发票",
      media: { type: "image", filePath, mimeType: "image/*" },
    });

    assert.match(reply.text, /暂时上传失败，请稍后重试/);
    assert.doesNotMatch(reply.text, /internal-backend-sentinel|secret|token=|invoice\.png/i);
  });
});
