import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServer } from "../src/server.js";
import { start as startVendoredWeixin } from "../vendor/weixin-agent-sdk/dist/index.mjs";

const owner = "synthetic-owner";
const sender = "synthetic-weixin-user";
const shortcutCredential = ["synthetic", "shortcut", "credential"].join("-");
const machineCredential = ["synthetic", "machine", "credential"].join("-");
const contextCredential = ["synthetic", "context", "credential", "never-log"].join("-");

function analysis() {
  return {
    status: "ready",
    confidence: 0.99,
    expense: {
      occurredOn: "2026-08-21",
      amountCents: 1880,
      reimbursementCents: 1880,
      purpose: "synthetic transport",
      merchant: "synthetic merchant",
      paidAt: "2026-08-21T09:30:00+08:00",
      fundingSource: "personal",
      paymentMethod: "wechat",
    },
    warnings: [],
    source: { provider: "test", model: null },
  };
}

function shortcutBody() {
  return {
    text: "2026-08-21 打车 18.80元",
    selection_path: "出差报销 · 支出 · 交通 · 打车",
    note: "synthetic restart delivery",
    idempotency_key: "synthetic-restart-delivery",
    source: "shortcut",
  };
}

async function json(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

test("worker restores the encrypted context token after restart and delivers a real backend outbox", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "weixin-worker-delivery-integration-"));
  const stateDir = join(tempDir, "state");
  const accountId = "synthetic-account";
  const accountDir = join(stateDir, "openclaw-weixin", "accounts");
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const providerFetch = globalThis.fetch;
  const backendFetch = globalThis.fetch.bind(globalThis);
  let server;
  try {
    await mkdir(accountDir, { recursive: true });
    await writeFile(join(stateDir, "openclaw-weixin", "accounts.json"), JSON.stringify([accountId]));
    await writeFile(join(accountDir, `${accountId}.json`), JSON.stringify({
      token: ["synthetic", "provider", "credential"].join("-"),
      baseUrl: "https://synthetic-weixin.invalid",
      userId: sender,
    }));
    process.env.OPENCLAW_STATE_DIR = stateDir;

    server = createServer({
      databaseUrl: join(tempDir, "backend.sqlite"),
      seed: false,
      nodeEnv: "test",
      authRequired: false,
      shortcutWebhookToken: shortcutCredential,
      shortcutWebhookOwner: owner,
      shortcutWeixinConfirmationEnabled: true,
      weixinAgentApiToken: machineCredential,
      weixinAgentOwner: owner,
      weixinBookkeepingOwner: owner,
      weixinBookkeepingSenderId: sender,
      weixinAllowedSenderIds: sender,
      weixinAllowGroups: false,
      weixinOutboxPollMs: 500,
      assistantConfirmationSecret: Buffer.alloc(32, 0x51),
      shortcutBookkeepingIdFactory: () => "synthetic-entry",
      shortcutBookkeepingAssistantIdFactory: () => "synthetic-action",
      weixinConfirmationOutboxIdFactory: () => "synthetic-outbox",
      travelExpenseAnalyzer: async () => analysis(),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const workerConfig = {
      nodeEnv: "test",
      authRequired: false,
      authSessionSecret: Buffer.alloc(32, 0x52).toString("base64url"),
      weixinAgentApiToken: machineCredential,
      weixinAgentBackendUrl: baseUrl,
      weixinAgentOwner: owner,
      shortcutWeixinConfirmationEnabled: true,
      weixinBookkeepingOwner: owner,
      weixinBookkeepingSenderId: sender,
      weixinAllowedSenderIds: [sender],
      weixinAllowGroups: false,
      weixinOutboxPollMs: 500,
    };

    const activationAbort = new AbortController();
    let activationPolls = 0;
    globalThis.fetch = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith("/getupdates")) {
        activationPolls += 1;
        if (activationPolls === 1) {
          return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "synthetic-activation-cursor",
            msgs: [{
              from_user_id: sender,
              message_id: "synthetic-activation-message",
              create_time_ms: 1787280000000,
              context_token: contextCredential,
              item_list: [{ type: 1, text_item: { text: "帮助" } }],
            }],
          }), { status: 200 });
        }
        if (activationPolls === 2) {
          await new Promise((resolve) => setTimeout(resolve, 650));
          return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "synthetic-activation-cursor-2",
            msgs: [],
          }), { status: 200 });
        }
        activationAbort.abort();
        throw new DOMException("aborted", "AbortError");
      }
      if (endpoint.endsWith("/getconfig")) {
        return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
      }
      if (endpoint.endsWith("/sendmessage")) {
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }
      throw new Error(`unexpected activation endpoint: ${endpoint}`);
    };
    const { runWeixinWorker } = await import("../src/weixin/worker.js");
    await runWeixinWorker(["start"], {
      sdk: {
        start(agent, options) {
          return startVendoredWeixin(agent, { ...options, accountId, abortSignal: activationAbort.signal });
        },
      },
      fetchImpl: backendFetch,
      configOverrides: workerConfig,
    });

    const contextPath = join(accountDir, `${accountId}.context.json`);
    const encryptedRecord = await readFile(contextPath, "utf8");
    assert.doesNotMatch(encryptedRecord, /synthetic-context-token-never-log|synthetic-weixin-user/u);
    assert.equal((await stat(contextPath)).mode & 0o777, 0o600);

    const verified = await json(await backendFetch(`${baseUrl}/api/integrations/shortcut/verify`, {
      headers: { Authorization: `Bearer ${shortcutCredential}`, "X-Shortcut-Verification-Mode": "explain" },
    }));
    assert.equal(verified.body.bookkeepingReady, true);
    assert.deepEqual(verified.body.confirmationDelivery, { status: "ready" });

    const created = await json(await backendFetch(`${baseUrl}/api/integrations/shortcut/bookkeeping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutCredential}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody()),
    }));
    assert.equal(created.response.status, 202);
    assert.equal(created.body.item.confirmationDelivery.status, "queued");

    const deliveryAbort = new AbortController();
    const proactiveBodies = [];
    let releaseProviderSend;
    const providerSent = new Promise((resolve) => { releaseProviderSend = resolve; });
    globalThis.fetch = async (url, init) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith("/getupdates")) {
        await providerSent;
        deliveryAbort.abort();
        throw new DOMException("aborted", "AbortError");
      }
      if (endpoint.endsWith("/sendmessage")) {
        proactiveBodies.push(JSON.parse(init.body));
        releaseProviderSend();
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }
      throw new Error(`unexpected delivery endpoint: ${endpoint}`);
    };
    await runWeixinWorker(["start"], {
      sdk: {
        start(agent, options) {
          return startVendoredWeixin(agent, { ...options, accountId, abortSignal: deliveryAbort.signal });
        },
      },
      fetchImpl: backendFetch,
      configOverrides: workerConfig,
    });
    assert.equal(proactiveBodies.length, 1);
    assert.equal(proactiveBodies[0].msg.to_user_id, sender);
    assert.equal(proactiveBodies[0].msg.context_token, contextCredential);

    const status = await json(await backendFetch(
      `${baseUrl}/api/integrations/shortcut/bookkeeping/status?entryId=${created.body.item.id}`,
      { headers: { Authorization: `Bearer ${shortcutCredential}` } },
    ));
    assert.equal(status.response.status, 200);
    assert.equal(status.body.item.confirmationDelivery.status, "sent");
  } finally {
    globalThis.fetch = providerFetch;
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});
