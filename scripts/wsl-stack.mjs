import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  joinWorkspacePath,
  resolveWorkspacePath,
  toWslPath,
} from "./local-dev.mjs";
import {
  buildWslBackendCommand,
  createWslBackendConfig,
} from "./wsl-backend.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(here, "..");

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const options = {};
  for (const arg of rest) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    options[match[1].replaceAll("-", "_")] = match[2];
  }
  return { command, options };
}

export function createWslStackConfig(overrides = {}) {
  const workspaceRoot = resolveWorkspacePath(overrides.workspaceRoot ?? defaultWorkspaceRoot);
  const frontendDir = joinWorkspacePath(workspaceRoot, "outputs", "product-design-prototype");
  const backendPort = Number(overrides.backendPort ?? process.env.SENT_ZX_BACKEND_PORT ?? 8897);
  const frontendPort = Number(overrides.frontendPort ?? process.env.SENT_ZX_FRONTEND_PORT ?? 8088);
  const runtimeRoot = overrides.runtimeRoot ?? process.env.SENT_ZX_RUNTIME_ROOT;
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;

  return {
    workspaceRoot,
    frontendDir,
    frontendWslPath: toWslPath(frontendDir),
    command: overrides.command ?? "status",
    backendPort,
    frontendPort,
    runtimeRoot,
    backendUrl,
    frontendUrl,
  };
}

export function buildFrontendBuildCommand(config) {
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", "run", "build"],
    cwd: config.frontendDir,
    env: {
      VITE_API_BASE_URL: config.backendUrl,
    },
  };
}

function pushEnv(args, key, value) {
  if (value !== undefined && value !== "") args.push(`${key}=${value}`);
}

export function buildStaticServerCommand(config, command) {
  const args = ["--cd", config.frontendWslPath, "--exec", "env"];
  pushEnv(args, "PORT", config.frontendPort);
  pushEnv(args, "SENT_ZX_RUNTIME_ROOT", config.runtimeRoot);
  pushEnv(args, "API_BASE_URL", config.backendUrl);
  args.push("node", "scripts/static-server.mjs", command);

  return {
    command: "wsl.exe",
    args,
  };
}

function buildBackendStackCommand(config, command) {
  return buildWslBackendCommand(createWslBackendConfig({
    workspaceRoot: config.workspaceRoot,
    command,
    port: config.backendPort,
    runtimeRoot: config.runtimeRoot,
  }));
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

function parseJsonOutput(result) {
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : {};
}

async function startStack(config) {
  let backend;
  try {
    backend = parseJsonOutput(await runProcess(buildBackendStackCommand(config, "start")));
    await runProcess(buildFrontendBuildCommand(config));
    const frontend = parseJsonOutput(await runProcess(buildStaticServerCommand(config, "start")));
    return {
      status: "started",
      backend,
      frontend,
      backendUrl: config.backendUrl,
      frontendUrl: config.frontendUrl,
    };
  } catch (error) {
    await runProcess(buildStaticServerCommand(config, "stop")).catch(() => {});
    await runProcess(buildBackendStackCommand(config, "stop")).catch(() => {});
    throw error;
  }
}

async function stopStack(config) {
  const frontend = parseJsonOutput(await runProcess(buildStaticServerCommand(config, "stop")));
  const backend = parseJsonOutput(await runProcess(buildBackendStackCommand(config, "stop")));
  return {
    status: "stopped",
    frontend,
    backend,
    backendUrl: config.backendUrl,
    frontendUrl: config.frontendUrl,
  };
}

async function healthStack(config) {
  const backend = parseJsonOutput(await runProcess(buildBackendStackCommand(config, "health")));
  const frontend = parseJsonOutput(await runProcess(buildStaticServerCommand(config, "health")));
  return {
    status: "ok",
    backend,
    frontend,
    backendUrl: config.backendUrl,
    frontendUrl: config.frontendUrl,
  };
}

async function statusStack(config) {
  const backend = parseJsonOutput(await runProcess(buildBackendStackCommand(config, "status")));
  const frontend = parseJsonOutput(await runProcess(buildStaticServerCommand(config, "status")));
  return {
    status: backend.status === "running" && frontend.status === "running" ? "running" : "partial",
    backend,
    frontend,
    backendUrl: config.backendUrl,
    frontendUrl: config.frontendUrl,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const config = createWslStackConfig({
    command,
    backendPort: options.backend_port,
    frontendPort: options.frontend_port,
    runtimeRoot: options.runtime_root,
  });
  let result;

  if (command === "start") result = await startStack(config);
  else if (command === "stop") result = await stopStack(config);
  else if (command === "health") result = await healthStack(config);
  else if (command === "status") result = await statusStack(config);
  else if (command === "restart") {
    await stopStack(config);
    result = await startStack(config);
  } else if (command === "config") result = config;
  else throw new Error(`Unknown WSL stack command: ${command}`);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
