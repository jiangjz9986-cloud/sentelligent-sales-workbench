import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

import { assertWeixinGroupAllowed } from "../assistant/weixinEvent.js";
import { loadConfig } from "../config.js";
import { shortcutBookkeepingConversationId } from "./bookkeepingDeliveryScope.js";
import { createRemoteClawbotAgent } from "./remoteAgent.js";
import { createWeixinOutboxHttpClient, runWeixinOutboxPump } from "./outboxWorker.js";

// v0.9.3 多绑定就绪哨兵：目标可达性判定移到逐条投递期，不再有全局唯一 scope。
const WEIXIN_MULTI_DELIVERY_SCOPE = "weixin:multi:v1";

function backendUrlFromConfig(config) {
  return config.weixinAgentBackendUrl || `http://${config.host}:${config.port}`;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  npm run weixin:login",
      "  npm run weixin:start",
      "  npm run weixin:login-start",
      "",
      "Required for start:",
      "  WEIXIN_AGENT_API_TOKEN",
      "Optional:",
      "  WEIXIN_AGENT_BACKEND_URL",
    ].join("\n") + "\n",
  );
}

export function deriveWeixinDeliveryKey(apiToken) {
  return createHmac("sha256", Buffer.from(apiToken, "utf8"))
    .update("sentelligent/weixin-delivery-key/v1", "utf8")
    .digest();
}

export function deriveWeixinProviderClientId(deliveryKey, outboxId) {
  if (!(deliveryKey instanceof Uint8Array) || deliveryKey.byteLength !== 32) {
    throw new TypeError("deliveryKey must contain exactly 32 bytes");
  }
  const id = String(outboxId ?? "").trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(id)) {
    throw new TypeError("outboxId is invalid");
  }
  return `sentelligent:${createHmac("sha256", Buffer.from(deliveryKey))
    .update("sentelligent/weixin-provider-client-id/v1", "utf8")
    .update("\0", "utf8")
    .update(id, "utf8")
    .digest("hex")}`;
}

// v0.9.3：sender 白名单入 DB（bindings 表），worker 不再本地判 sender——未绑定
// sender 的消息交由后端入口闸回固定绑定引导；群规则本地保留（生产强制无群）。
function isInboundAllowed(config, metadata) {
  try {
    assertWeixinGroupAllowed(config, metadata);
    return true;
  } catch (error) {
    if (error?.code === "WEIXIN_GROUP_NOT_ALLOWED") return false;
    throw error;
  }
}

// 第二道保险（§4.2）：worker 本地重算 hash(owner, targetSenderId)，要求与
// deliveryScope、conversationId 三者一致；不满足（后端伪造/错配/缺目标）即
// fail-closed 终态 WEIXIN_DELIVERY_SCOPE_MISMATCH。
export function authorizeWeixinBoundDelivery(item) {
  try {
    const target = typeof item?.targetSenderId === "string" ? item.targetSenderId.trim() : "";
    if (!target) return false;
    const recomputed = shortcutBookkeepingConversationId(item.owner, target);
    return recomputed === item.deliveryScope && item.deliveryScope === item.conversationId;
  } catch {
    return false;
  }
}

async function loadSdk() {
  return import("weixin-agent-sdk");
}

export async function runWeixinWorker(argv = process.argv.slice(2), options = {}) {
  const command = argv[0] ?? "start";
  if (command === "help" || argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return { status: "help" };
  }

  const sdk = options.sdk ?? (await loadSdk());
  const config = loadConfig(options.configOverrides ?? {});

  if (command === "login" || command === "login-start") {
    process.stdout.write("Starting WeChat login. Scan the QR code shown in this terminal.\n");
    await sdk.login();
    process.stdout.write("WeChat login completed.\n");
    if (command === "login") return { status: "logged_in" };
  }

  if (command !== "start" && command !== "login-start") {
    throw new Error(`Unknown WeChat worker command: ${command}`);
  }

  if (!config.weixinAgentApiToken) {
    throw new Error("WEIXIN_AGENT_API_TOKEN is required before starting the WeChat worker");
  }
  const deliveryKey = deriveWeixinDeliveryKey(config.weixinAgentApiToken);

  const remoteAgent = createRemoteClawbotAgent({
    backendUrl: backendUrlFromConfig(config),
    apiToken: config.weixinAgentApiToken,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  const agent = {
    async chat(request) {
      return remoteAgent.chat(request);
    },
  };
  const bot = sdk.start(agent, {
    deliveryKey,
    authorizeInbound: (metadata) => isInboundAllowed(config, metadata),
  });
  // v0.9.3：env 绑定闭包退役。ready = 登录态 ∧ SDK 支持定向投递 ∧ runtime 确认面
  // 启用；recipient_mismatch 三态原因退役为逐条投递期判定（一个不可达目标不再
  // 全局熄火）。
  const sdkSupportsBoundDelivery = typeof bot.getDeliveryStatus === "function"
    && typeof bot.isDeliveryTarget === "function"
    && typeof bot.sendMessageTo === "function";
  const outboxBot = {
    async sendMessage(message, outboxId, { targetSenderId } = {}) {
      const target = typeof targetSenderId === "string" ? targetSenderId.trim() : "";
      if (!sdkSupportsBoundDelivery || !target) {
        const error = new Error("WeChat proactive delivery target is not bound");
        error.code = "WEIXIN_DELIVERY_SCOPE_MISMATCH";
        throw error;
      }
      let reachable = false;
      try {
        reachable = bot.isDeliveryTarget(target) === true;
      } catch {
        reachable = false;
      }
      if (!reachable) {
        // 联系人同步中/对方暂不可达不应终态：可重试，8 次耗尽自然 failed。
        const error = new Error("WeChat delivery target is not reachable yet");
        error.code = "WEIXIN_CONTEXT_NOT_READY";
        throw error;
      }
      return bot.sendMessageTo(target, message, {
        clientId: deriveWeixinProviderClientId(deliveryKey, outboxId),
      });
    },
    getDeliveryStatus() {
      if (!config.weixinBookkeepingConfirmationEnabled) {
        return { ready: false, status: "not_ready", reason: "bookkeeping_not_configured" };
      }
      if (!sdkSupportsBoundDelivery) {
        return { ready: false, status: "not_ready", reason: "sdk_status_unavailable" };
      }
      return { ...bot.getDeliveryStatus(), deliveryScope: WEIXIN_MULTI_DELIVERY_SCOPE };
    },
  };
  process.stdout.write(`WeChat worker started. Backend: ${backendUrlFromConfig(config)}\n`);
  const pumpAbort = new AbortController();
  const outboxClient = createWeixinOutboxHttpClient({
    backendUrl: backendUrlFromConfig(config),
    apiToken: config.weixinAgentApiToken,
    fetchImpl: options.fetchImpl ?? fetch,
    workerId: config.weixinAgentOwner || "weixin-worker",
  });
  const pump = runWeixinOutboxPump({
    client: outboxClient,
    bot: outboxBot,
    authorizeDelivery: authorizeWeixinBoundDelivery,
    pollMs: config.weixinOutboxPollMs,
    abortSignal: pumpAbort.signal,
    log: (message) => process.stdout.write(`${message}\n`),
  });
  try {
    await bot.wait();
  } finally {
    pumpAbort.abort();
    await pump.catch(() => {});
  }
  return { status: "stopped" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWeixinWorker().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
