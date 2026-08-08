import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import { createSalesWorkbenchWeixinAgent } from "../src/weixin/agentBridge.js";

const machineToken = "wx-http-integration-token";
let tempDir;
let server;
let baseUrl;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-weixin-http-"));
  server = createServer({
    databaseUrl: join(tempDir, "assistant.sqlite"),
    seed: true,
    nodeEnv: "test",
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: true,
    authAccount: "weixin-owner",
    authPassword: "",
    authPasswordHash: await hashPassword("unit-password", { salt: Buffer.alloc(16, 8) }),
    authSessionSecret: Buffer.alloc(32, 9).toString("base64url"),
    authCookieSecure: false,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: "weixin-owner",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("WeChat agent HTTP integration", () => {
  it("allows the authenticated machine to preview a visit draft", async () => {
    const agent = createSalesWorkbenchWeixinAgent({
      backendUrl: baseUrl,
      apiToken: machineToken,
      now: () => new Date("2026-08-09T09:00:00.000Z"),
    });

    await agent.chat({
      conversationId: "wx-preview-integration",
      text: "拜访日照中医医院，客户希望补齐十五五规划材料。",
    });
    const preview = await agent.chat({
      conversationId: "wx-preview-integration",
      text: "记录",
    });

    assert.match(preview.text, /待确认记录/);
    assert.match(preview.text, /日照中医医院/);
  });
});
