import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(here, "..");
const runtimeDir = resolve(defaultWorkspaceRoot, ".runtime");
const runtimePath = resolve(runtimeDir, "local-dev.json");

export function toWslPath(windowsPath) {
  const normalized = resolve(windowsPath).replaceAll("\\", "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return normalized;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

export function createConfig(overrides = {}) {
  const workspaceRoot = resolve(overrides.workspaceRoot ?? defaultWorkspaceRoot);
  const backendPort = Number(overrides.backendPort ?? process.env.SENT_ZX_BACKEND_PORT ?? 8897);
  const frontendPort = Number(overrides.frontendPort ?? process.env.SENT_ZX_FRONTEND_PORT ?? 5184);
  const databaseUrl = String(overrides.databaseUrl ?? process.env.SENT_ZX_DATABASE_URL ?? "/tmp/sent-zx-local-dev.sqlite");
  const backendDir = resolve(workspaceRoot, "backend");
  const frontendDir = resolve(workspaceRoot, "outputs", "product-design-prototype");

  return {
    workspaceRoot,
    backendDir,
    frontendDir,
    backendWslPath: toWslPath(backendDir),
    backendPort,
    frontendPort,
    backendUrl: `http://127.0.0.1:${backendPort}`,
    frontendUrl: `http://127.0.0.1:${frontendPort}`,
    databaseUrl,
    runtimePath: resolve(workspaceRoot, ".runtime", "local-dev.json"),
  };
}

export function buildBackendSeedCommand(config) {
  return {
    command: "wsl.exe",
    args: [
      "--cd",
      config.backendWslPath,
      "env",
      `DATABASE_URL=${config.databaseUrl}`,
      "npm",
      "run",
      "seed",
    ],
  };
}

export function buildBackendCommand(config) {
  return {
    command: "wsl.exe",
    args: [
      "--cd",
      config.backendWslPath,
      "env",
      `PORT=${config.backendPort}`,
      `DATABASE_URL=${config.databaseUrl}`,
      "node",
      "src/server.js",
    ],
  };
}

export function buildFrontendCommand(config) {
  return {
    command: "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      "npm.cmd",
      "run",
      "dev",
      "--",
      "--port",
      String(config.frontendPort),
      "--strictPort",
    ],
    cwd: config.frontendDir,
    env: {
      VITE_API_BASE_URL: config.backendUrl,
    },
  };
}

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const options = {};
  for (const arg of rest) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    options[match[1].replaceAll("-", "_")] = match[2];
  }
  return {
    command,
    options: {
      backendPort: options.backend_port,
      frontendPort: options.frontend_port,
      databaseUrl: options.database_url,
    },
  };
}

function spawnProcess(commandSpec) {
  const child = spawn(commandSpec.command, commandSpec.args, {
    cwd: commandSpec.cwd,
    env: { ...process.env, ...(commandSpec.env ?? {}) },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function runProcess(commandSpec) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: commandSpec.cwd,
      env: { ...process.env, ...(commandSpec.env ?? {}) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${commandSpec.command} ${commandSpec.args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function waitForJson(url, timeoutMs = 25000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

async function waitForHttp(url, timeoutMs = 25000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.status;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

function writeRuntime(runtime) {
  mkdirSync(dirname(runtime.runtimePath), { recursive: true });
  writeFileSync(runtime.runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
}

function readRuntime(config) {
  if (!existsSync(config.runtimePath)) return null;
  return JSON.parse(readFileSync(config.runtimePath, "utf8"));
}

async function taskkill(pid) {
  if (!pid) return;
  await runProcess({
    command: "taskkill.exe",
    args: ["/PID", String(pid), "/T", "/F"],
  }).catch(() => {});
}

async function start(config) {
  await runProcess(buildBackendSeedCommand(config));
  const backendPid = spawnProcess(buildBackendCommand(config));
  const backendHealth = await waitForJson(`${config.backendUrl}/api/health`);
  const frontendPid = spawnProcess(buildFrontendCommand(config));
  await waitForHttp(config.frontendUrl);

  const runtime = {
    runtimePath: config.runtimePath,
    backendPid,
    frontendPid,
    backendUrl: config.backendUrl,
    frontendUrl: config.frontendUrl,
    backendPort: config.backendPort,
    frontendPort: config.frontendPort,
    databaseUrl: config.databaseUrl,
    startedAt: new Date().toISOString(),
  };
  writeRuntime(runtime);

  return {
    status: "started",
    backend: backendHealth,
    backendUrl: config.backendUrl,
    frontendUrl: config.frontendUrl,
    runtimePath: config.runtimePath,
  };
}

async function health(config) {
  const runtime = readRuntime(config);
  const backendUrl = runtime?.backendUrl ?? config.backendUrl;
  const frontendUrl = runtime?.frontendUrl ?? config.frontendUrl;
  const backend = await waitForJson(`${backendUrl}/api/health`, 5000);
  const frontendStatus = await waitForHttp(frontendUrl, 5000);
  return {
    status: "ok",
    backend,
    backendUrl,
    frontendUrl,
    frontendStatus,
  };
}

async function status(config) {
  const runtime = readRuntime(config);
  if (!runtime) return { status: "stopped", runtimePath: config.runtimePath };
  try {
    return await health(config);
  } catch (error) {
    return {
      status: "unhealthy",
      message: error.message,
      backendUrl: runtime.backendUrl,
      frontendUrl: runtime.frontendUrl,
      runtimePath: config.runtimePath,
    };
  }
}

export async function stop(config) {
  const runtime = readRuntime(config);
  if (!runtime) return { status: "stopped", runtimePath: config.runtimePath };
  await taskkill(runtime.frontendPid);
  await taskkill(runtime.backendPid);
  rmSync(runtime.runtimePath ?? config.runtimePath, { force: true });
  return {
    status: "stopped",
    backendUrl: runtime.backendUrl,
    frontendUrl: runtime.frontendUrl,
    runtimePath: config.runtimePath,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const config = createConfig(options);
  let result;

  if (command === "start") result = await start(config);
  else if (command === "health") result = await health(config);
  else if (command === "status") result = await status(config);
  else if (command === "stop") result = await stop(config);
  else if (command === "config") result = config;
  else throw new Error(`Unknown command: ${command}`);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
