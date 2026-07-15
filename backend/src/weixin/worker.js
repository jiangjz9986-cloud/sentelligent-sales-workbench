import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.js";
import { createSalesWorkbenchWeixinAgent } from "./agentBridge.js";

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
      "  WEIXIN_AGENT_OWNER",
    ].join("\n") + "\n",
  );
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

  const agent = createSalesWorkbenchWeixinAgent({
    backendUrl: backendUrlFromConfig(config),
    apiToken: config.weixinAgentApiToken,
    owner: config.weixinAgentOwner || config.authAccount || "weixin-agent",
  });
  const bot = sdk.start(agent);
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
