import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFile(filePath = resolve(process.cwd(), ".env")) {
  if (!existsSync(filePath)) return {};

  const entries = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }

  return entries;
}

export function loadConfig(overrides = {}) {
  const envFile = loadEnvFile(overrides.envFile);
  const env = { ...envFile, ...process.env, ...overrides };

  return {
    host: env.host ?? env.HOST ?? "127.0.0.1",
    port: Number(env.port ?? env.PORT ?? 8787),
    databaseUrl: env.databaseUrl ?? env.DATABASE_URL ?? "./data/sales-workbench.sqlite",
    aiAnalysisMode: env.aiAnalysisMode ?? env.AI_ANALYSIS_MODE ?? "mock",
    modelProvider: env.modelProvider ?? env.MODEL_PROVIDER ?? "deepseek",
    modelApiKey: env.modelApiKey ?? env.MODEL_API_KEY ?? env.DEEPSEEK_API_KEY ?? "",
    modelBaseUrl: env.modelBaseUrl ?? env.MODEL_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    modelName: env.modelName ?? env.MODEL_NAME ?? env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    modelTimeoutMs: Number(env.modelTimeoutMs ?? env.MODEL_TIMEOUT_MS ?? 30000),
    authAccount: env.authAccount ?? env.AUTH_ACCOUNT ?? "",
    authPassword: env.authPassword ?? env.AUTH_PASSWORD ?? "",
    authSessionSecret: env.authSessionSecret ?? env.AUTH_SESSION_SECRET ?? "",
    weixinAgentApiToken: env.weixinAgentApiToken ?? env.WEIXIN_AGENT_API_TOKEN ?? "",
    weixinAgentBackendUrl: env.weixinAgentBackendUrl ?? env.WEIXIN_AGENT_BACKEND_URL ?? "",
    weixinAgentOwner: env.weixinAgentOwner ?? env.WEIXIN_AGENT_OWNER ?? env.AUTH_ACCOUNT ?? env.authAccount ?? "",
    weixinAgentSessionHome: env.weixinAgentSessionHome ?? env.WEIXIN_AGENT_SESSION_HOME ?? "",
  };
}
