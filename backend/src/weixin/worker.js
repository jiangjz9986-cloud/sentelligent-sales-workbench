import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

import { assertWeixinSenderAllowed } from "../assistant/weixinEvent.js";
import { loadConfig } from "../config.js";
import { createRemoteClawbotAgent } from "./remoteAgent.js";

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
  process.stdout.write(`WeChat worker started. Backend: ${backendUrlFromConfig(config)}\n`);
  await bot.wait();
  return { status: "stopped" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWeixinWorker().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
