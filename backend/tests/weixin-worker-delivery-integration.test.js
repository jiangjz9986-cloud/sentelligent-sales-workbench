import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import { start as startVendoredWeixin } from "../vendor/weixin-agent-sdk/dist/index.mjs";
import { seedWeixinBinding } from "./helpers/weixin-binding-fixtures.js";

const owner = "syntheticowner";
const sender = "synthetic-weixin-user";
const machineCredential = ["synthetic", "machine", "credential"].join("-");
const contextCredential = ["synthetic", "context", "credential", "never-log"].join("-");
const contextTokenTtlMs = 23 * 60 * 60 * 1000;

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
      weixinBookkeepingConfirmationEnabled: true,
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
    {
      const seedDb = openDatabase({ databaseUrl: join(tempDir, "backend.sqlite") });
      try {
        seedWeixinBinding(seedDb, { account: owner, senderId: sender, financialEnabled: true });
      } finally {
        seedDb.close();
      }
    }
    const workerConfig = {
      nodeEnv: "test",
      authRequired: false,
      authSessionSecret: Buffer.alloc(32, 0x52).toString("base64url"),
      weixinAgentApiToken: machineCredential,
      weixinAgentBackendUrl: baseUrl,
      weixinAgentOwner: owner,
      weixinBookkeepingConfirmationEnabled: true,
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

    const created = await json(await backendFetch(`${baseUrl}/api/integrations/weixin-agent/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${machineCredential}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "weixin:synthetic-restart-delivery",
      },
      body: JSON.stringify({
        conversationId: "synthetic-restart-delivery",
        text: "支出 2026-08-21 打车 18.80元 synthetic restart delivery",
        sourceMessageId: "synthetic-restart-delivery",
        senderId: sender,
        chatType: "direct",
      }),
    }));
    assert.equal(created.response.status, 200);
    assert.equal(created.body.status, "ok");

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
        return new Response('{"message_id":1234567890123456789}', { status: 200 });
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

    const db = openDatabase({ databaseUrl: join(tempDir, "backend.sqlite") });
    const delivered = db.prepare(
      "SELECT status, attempt_count FROM weixin_confirmation_outbox WHERE id = 'synthetic-outbox'",
    ).get();
    assert.equal(delivered.status, "sent");
    assert.equal(delivered.attempt_count, 0);
    db.close();

    const verificationAbort = new AbortController();
    let replayedProviderSends = 0;
    globalThis.fetch = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith("/getupdates")) {
        await new Promise((resolve) => setTimeout(resolve, 650));
        verificationAbort.abort();
        throw new DOMException("aborted", "AbortError");
      }
      if (endpoint.endsWith("/getconfig")) {
        return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
      }
      if (endpoint.endsWith("/sendmessage")) {
        replayedProviderSends += 1;
        return new Response('{"message_id":1234567890123456789}', { status: 200 });
      }
      throw new Error(`unexpected verification endpoint: ${endpoint}`);
    };
    await runWeixinWorker(["start"], {
      sdk: {
        start(agent, options) {
          return startVendoredWeixin(agent, { ...options, accountId, abortSignal: verificationAbort.signal });
        },
      },
      fetchImpl: backendFetch,
      configOverrides: workerConfig,
    });
    assert.equal(replayedProviderSends, 0);
  } finally {
    globalThis.fetch = providerFetch;
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("worker keeps queued outbox across context expiry and resumes it once after a real inbound context refresh", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "weixin-worker-context-refresh-integration-"));
  const stateDir = join(tempDir, "state");
  const accountId = "synthetic-context-refresh-account";
  const accountDir = join(stateDir, "openclaw-weixin", "accounts");
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const providerFetch = globalThis.fetch;
  const backendFetch = globalThis.fetch.bind(globalThis.fetch);
  const previousDateNow = Date.now;
  const initialNow = Date.parse("2026-09-14T00:00:00.000Z");
  let fakeNow = initialNow;
  let server;
  let workerPromise;
  let abortController;
  let allowOutboxAdvance;
  let allowRefreshInbound;
  let resolveInitialInbound;
  let resolveExpiredReadiness;
  let resolveProactiveAck;
  const initialInbound = new Promise((resolve) => { resolveInitialInbound = resolve; });
  const expiredReadiness = new Promise((resolve) => { resolveExpiredReadiness = resolve; });
  const proactiveAcked = new Promise((resolve) => { resolveProactiveAck = resolve; });
  const outboxAdvance = new Promise((resolve) => { allowOutboxAdvance = resolve; });
  const refreshInbound = new Promise((resolve) => { allowRefreshInbound = resolve; });
  const oldContextToken = "synthetic-old-context-token";
  const newContextToken = "synthetic-new-context-token";
  const proactiveBodies = [];
  const inboundReplyBodies = [];
  const readyReports = [];
  let queueCreated = false;
  let outboxGateArmed = false;
  let getUpdatesCalls = 0;

  const waitForGate = (gate, signal) => {
    if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    return Promise.race([
      gate,
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    ]);
  };

  try {
    Date.now = () => fakeNow;
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
      weixinBookkeepingConfirmationEnabled: true,
      weixinAgentApiToken: machineCredential,
      weixinAgentOwner: owner,
      weixinBookkeepingOwner: owner,
      weixinBookkeepingSenderId: sender,
      weixinAllowedSenderIds: sender,
      weixinAllowGroups: false,
      weixinOutboxPollMs: 500,
      assistantConfirmationSecret: Buffer.alloc(32, 0x53),
      shortcutBookkeepingIdFactory: () => "synthetic-context-refresh-entry",
      shortcutBookkeepingAssistantIdFactory: () => "synthetic-context-refresh-action",
      weixinConfirmationOutboxIdFactory: () => "synthetic-context-refresh-outbox",
      travelExpenseAnalyzer: async () => analysis(),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    {
      const seedDb = openDatabase({ databaseUrl: join(tempDir, "backend.sqlite") });
      try {
        seedWeixinBinding(seedDb, { account: owner, senderId: sender, financialEnabled: true });
      } finally {
        seedDb.close();
      }
    }
    const workerConfig = {
      nodeEnv: "test",
      authRequired: false,
      authSessionSecret: Buffer.alloc(32, 0x54).toString("base64url"),
      weixinAgentApiToken: machineCredential,
      weixinAgentBackendUrl: baseUrl,
      weixinAgentOwner: owner,
      weixinBookkeepingConfirmationEnabled: true,
      weixinBookkeepingOwner: owner,
      weixinBookkeepingSenderId: sender,
      weixinAllowedSenderIds: [sender],
      weixinAllowGroups: false,
      weixinOutboxPollMs: 500,
    };

    const workerFetch = async (url, init = {}) => {
      const endpoint = new URL(url).pathname;
      const method = init.method ?? "GET";
      if (endpoint.endsWith("/confirmation-outbox") && method === "GET") {
        const deliveryStatus = init.headers?.["X-Weixin-Delivery-Status"] ?? "";
        const deliveryReason = init.headers?.["X-Weixin-Delivery-Reason"] ?? "";
        if (deliveryStatus === "ready") readyReports.push({ deliveryStatus, deliveryReason });
        // Keep the pump from leasing the item before the synthetic clock is
        // advanced. The real backend is exercised once the queued item exists.
        if (!queueCreated) return new Response(null, { status: 204 });
        if (deliveryStatus === "ready" && !outboxGateArmed) {
          outboxGateArmed = true;
          await outboxAdvance;
          return new Response(null, { status: 204 });
        }
        const response = await backendFetch(url, init);
        if (deliveryReason === "context_token_expired") resolveExpiredReadiness();
        return response;
      }
      const response = await backendFetch(url, init);
      if (endpoint.endsWith("/confirmation-outbox") && method === "POST") {
        const body = JSON.parse(init.body);
        if (body.ok === true && body.id === "synthetic-context-refresh-outbox") resolveProactiveAck();
      }
      return response;
    };

    abortController = new AbortController();
    globalThis.fetch = async (url, init = {}) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith("/getupdates")) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "synthetic-context-refresh-cursor-1",
            msgs: [{
              from_user_id: sender,
              message_id: "synthetic-context-refresh-old-message",
              create_time_ms: initialNow,
              context_token: oldContextToken,
              item_list: [{ type: 1, text_item: { text: "帮助" } }],
            }],
          }), { status: 200 });
        }
        if (getUpdatesCalls === 2) {
          await waitForGate(expiredReadiness, abortController.signal);
          await waitForGate(refreshInbound, abortController.signal);
          return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "synthetic-context-refresh-cursor-2",
            msgs: [],
          }), { status: 200 });
        }
        if (getUpdatesCalls === 3) {
          return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "synthetic-context-refresh-cursor-3",
            msgs: [{
              from_user_id: sender,
              message_id: "synthetic-context-refresh-new-message",
              create_time_ms: initialNow + contextTokenTtlMs + 1,
              context_token: newContextToken,
              item_list: [{ type: 1, text_item: { text: "帮助" } }],
            }],
          }), { status: 200 });
        }
        await waitForGate(proactiveAcked, abortController.signal);
        abortController.abort();
        throw new DOMException("aborted", "AbortError");
      }
      if (endpoint.endsWith("/getconfig")) {
        return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
      }
      if (endpoint.endsWith("/sendmessage")) {
        const body = JSON.parse(init.body);
        if (body.msg?.client_id?.startsWith("sentelligent:")) proactiveBodies.push(body);
        else {
          inboundReplyBodies.push(body);
          if (inboundReplyBodies.length === 1) resolveInitialInbound();
        }
        return new Response('{"ret":0}', { status: 200 });
      }
      throw new Error(`unexpected context-refresh provider endpoint: ${endpoint}`);
    };

    const { runWeixinWorker } = await import("../src/weixin/worker.js");
    workerPromise = runWeixinWorker(["start"], {
      sdk: {
        start(agent, options) {
          return startVendoredWeixin(agent, { ...options, accountId, abortSignal: abortController.signal });
        },
      },
      fetchImpl: workerFetch,
      configOverrides: workerConfig,
    });

    await initialInbound;
    const created = await json(await backendFetch(`${baseUrl}/api/integrations/weixin-agent/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${machineCredential}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "weixin:synthetic-context-refresh-queued",
      },
      body: JSON.stringify({
        conversationId: "synthetic-context-refresh-queued",
        text: "支出 2026-08-21 打车 18.80元 synthetic context refresh",
        sourceMessageId: "synthetic-context-refresh-queued",
        senderId: sender,
        chatType: "direct",
      }),
    }));
    assert.equal(created.response.status, 200);
    assert.equal(created.body.status, "ok");
    queueCreated = true;

    fakeNow = initialNow + contextTokenTtlMs + 1;
    allowOutboxAdvance();
    await expiredReadiness;
    {
      const db = openDatabase({ databaseUrl: join(tempDir, "backend.sqlite") });
      try {
        const queued = db.prepare(
          "SELECT status, attempt_count FROM weixin_confirmation_outbox WHERE id = 'synthetic-context-refresh-outbox'",
        ).get();
        assert.equal(queued.status, "queued");
        assert.equal(queued.attempt_count, 0);
      } finally {
        db.close();
      }
    }
    allowRefreshInbound();
    await workerPromise;

    assert.ok(readyReports.length >= 1, "the old context must be reported ready before expiry");
    assert.equal(inboundReplyBodies[0].msg.context_token, oldContextToken);
    assert.equal(proactiveBodies.length, 1, "the queued item must be sent exactly once");
    assert.equal(proactiveBodies[0].msg.to_user_id, sender);
    assert.equal(proactiveBodies[0].msg.context_token, newContextToken);

    const db = openDatabase({ databaseUrl: join(tempDir, "backend.sqlite") });
    try {
      const delivered = db.prepare(
        "SELECT status, attempt_count, provider_message_id FROM weixin_confirmation_outbox WHERE id = 'synthetic-context-refresh-outbox'",
      ).get();
      assert.equal(delivered.status, "sent");
      assert.equal(delivered.attempt_count, 0);
      assert.match(delivered.provider_message_id, /^sentelligent:[0-9a-f]{64}$/u);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox WHERE id = 'synthetic-context-refresh-outbox'").get().count,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    allowOutboxAdvance?.();
    allowRefreshInbound?.();
    abortController?.abort();
    await workerPromise?.catch(() => {});
    globalThis.fetch = providerFetch;
    Date.now = previousDateNow;
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});
