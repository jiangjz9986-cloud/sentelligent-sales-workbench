import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

import { assertWeixinSenderAllowed } from "../assistant/weixinEvent.js";
import { loadConfig } from "../config.js";
import {
  isShortcutBookkeepingDeliveryScope,
  shortcutBookkeepingConversationId,
} from "./bookkeepingDeliveryScope.js";
import { createRemoteClawbotAgent } from "./remoteAgent.js";
import { createWeixinOutboxHttpClient, runWeixinOutboxPump } from "./outboxWorker.js";

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

function isInboundAllowed(config, metadata) {
  try {
    assertWeixinSenderAllowed(config, metadata);
    return true;
  } catch (error) {
    if (["WEIXIN_SENDER_NOT_ALLOWED", "WEIXIN_GROUP_NOT_ALLOWED"].includes(error?.code)) return false;
    throw error;
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
  const configuredBookkeepingDeliveryScope = config.shortcutWeixinConfirmationEnabled
    && config.weixinBookkeepingOwner
    && config.weixinBookkeepingSenderId
    && isInboundAllowed(config, {
      senderId: config.weixinBookkeepingSenderId,
      chatType: "direct",
    })
    ? {
        owner: config.weixinBookkeepingOwner,
        senderId: config.weixinBookkeepingSenderId,
      }
    : null;
  const sdkSupportsBoundDelivery = typeof bot.getDeliveryStatus === "function"
    && typeof bot.isDeliveryTarget === "function"
    && typeof bot.sendMessageTo === "function";
  const deliveryTargetMatches = () => {
    if (!configuredBookkeepingDeliveryScope || !sdkSupportsBoundDelivery) return false;
    try {
      return bot.isDeliveryTarget(configuredBookkeepingDeliveryScope.senderId) === true;
    } catch {
      return false;
    }
  };
  const bookkeepingDeliveryScope = deliveryTargetMatches()
    ? configuredBookkeepingDeliveryScope
    : null;
  const bookkeepingDeliveryScopeId = bookkeepingDeliveryScope
    ? shortcutBookkeepingConversationId(
        bookkeepingDeliveryScope.owner,
        bookkeepingDeliveryScope.senderId,
      )
    : null;
  const outboxBot = {
    async sendMessage(message) {
      if (!bookkeepingDeliveryScope || !deliveryTargetMatches()) {
        const error = new Error("WeChat proactive delivery target is not bound");
        error.code = "WEIXIN_DELIVERY_SCOPE_MISMATCH";
        throw error;
      }
      return bot.sendMessageTo(bookkeepingDeliveryScope.senderId, message);
    },
    getDeliveryStatus() {
      if (!configuredBookkeepingDeliveryScope) {
        return { ready: false, status: "not_ready", reason: "bookkeeping_not_configured" };
      }
      if (!sdkSupportsBoundDelivery) {
        return { ready: false, status: "not_ready", reason: "sdk_status_unavailable" };
      }
      if (!bookkeepingDeliveryScope || !deliveryTargetMatches()) {
        return { ready: false, status: "not_ready", reason: "recipient_mismatch" };
      }
      return { ...bot.getDeliveryStatus(), deliveryScope: bookkeepingDeliveryScopeId };
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
    authorizeDelivery: (item) => isShortcutBookkeepingDeliveryScope(
      item,
      bookkeepingDeliveryScope ?? {},
    ),
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
