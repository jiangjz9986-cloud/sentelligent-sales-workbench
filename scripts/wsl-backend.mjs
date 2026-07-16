import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { toWslPath } from "./local-dev.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(here, "..");
const serviceCommands = new Set(["start", "stop", "status", "health", "restart", "config"]);
const databaseCommands = new Set(["backup", "restore", "info"]);

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

export function createWslBackendConfig(overrides = {}) {
  const workspaceRoot = resolve(overrides.workspaceRoot ?? defaultWorkspaceRoot);
  const backendDir = resolve(workspaceRoot, "backend");
  return {
    workspaceRoot,
    backendDir,
    backendWslPath: toWslPath(backendDir),
    command: overrides.command ?? "status",
    port: overrides.port ?? process.env.SENT_ZX_BACKEND_PORT,
    host: overrides.host ?? process.env.SENT_ZX_BACKEND_HOST,
    runtimeRoot: overrides.runtimeRoot ?? process.env.SENT_ZX_RUNTIME_ROOT,
    databaseUrl: overrides.databaseUrl ?? process.env.SENT_ZX_DATABASE_URL,
    backupDir: overrides.backupDir ?? process.env.SENT_ZX_BACKUP_DIR,
    backupPath: overrides.backupPath,
    label: overrides.label,
    seed: overrides.seed,
  };
}

function pushEnv(args, key, value) {
  if (value !== undefined && value !== "") args.push(`${key}=${value}`);
}

function pushOption(args, key, value) {
  if (value !== undefined && value !== "") args.push(`--${key}=${value}`);
}

export function buildWslBackendCommand(config) {
  const script = serviceCommands.has(config.command)
    ? "scripts/service.mjs"
    : databaseCommands.has(config.command)
      ? "scripts/db-maintenance.mjs"
      : null;
  if (!script) throw new Error(`Unknown WSL backend command: ${config.command}`);

  const args = ["--cd", config.backendWslPath, "--exec", "env"];
  pushEnv(args, "PORT", config.port);
  pushEnv(args, "HOST", config.host);
  pushEnv(args, "SENT_ZX_RUNTIME_ROOT", config.runtimeRoot);
  pushEnv(args, "DATABASE_URL", config.databaseUrl);
  pushEnv(args, "SENT_ZX_BACKUP_DIR", config.backupDir);
  args.push("node", script, config.command);
  pushOption(args, "backup-path", config.backupPath);
  pushOption(args, "label", config.label);
  pushOption(args, "seed", config.seed);

  return {
    command: "wsl.exe",
    args,
  };
}

function runProcess(commandSpec) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(commandSpec.command, commandSpec.args, {
      env: process.env,
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

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const config = createWslBackendConfig({
    command,
    port: options.port,
    host: options.host,
    runtimeRoot: options.runtime_root,
    databaseUrl: options.database_url,
    backupDir: options.backup_dir,
    backupPath: options.backup_path,
    label: options.label,
    seed: options.seed,
  });
  const result = await runProcess(buildWslBackendCommand(config));
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
