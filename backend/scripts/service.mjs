import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../src/db.js";
import { seedDatabase } from "../src/seed.js";
import {
  buildServiceEnvironment,
  createRuntimeConfig,
  ensureRuntimeDirs,
  parseOptions,
  publicConfig,
} from "./runtime-config.mjs";

function readState(config) {
  if (!existsSync(config.statePath)) return null;
  return JSON.parse(readFileSync(config.statePath, "utf8"));
}

function writeState(config, state) {
  writeFileSync(config.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function removeState(config) {
  rmSync(config.statePath, { force: true });
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(config, timeoutMs = 15000) {
  const url = `http://${config.host}:${config.port}/api/health`;
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

function prepareDatabase(config) {
  const db = openDatabase({ databaseUrl: config.databaseUrl });
  try {
    if (config.seed) seedDatabase(db);
  } finally {
    db.close();
  }
}

export async function startService(config) {
  ensureRuntimeDirs(config);
  const current = readState(config);

  if (current?.pid && isProcessRunning(current.pid)) {
    try {
      const health = await waitForHealth(config, 2000);
      return {
        status: "already_running",
        pid: current.pid,
        health,
        ...publicConfig(config),
      };
    } catch {
      removeState(config);
    }
  }

  prepareDatabase(config);
  const logFd = openSync(config.logPath, "a");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
    detached: true,
    env: {
      ...process.env,
      ...buildServiceEnvironment(config),
    },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  const state = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    host: config.host,
    port: config.port,
    databaseUrl: config.databaseUrl,
    logPath: config.logPath,
  };
  writeState(config, state);

  try {
    const health = await waitForHealth(config);
    return {
      status: "started",
      pid: child.pid,
      health,
      ...publicConfig(config),
    };
  } catch (error) {
    await stopService(config);
    throw error;
  }
}

export async function stopService(config) {
  ensureRuntimeDirs(config);
  const state = readState(config);
  if (!state?.pid) {
    removeState(config);
    return { status: "stopped", ...publicConfig(config) };
  }

  if (isProcessRunning(state.pid)) {
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {}
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    if (isProcessRunning(state.pid)) {
      try {
        process.kill(-state.pid, "SIGKILL");
      } catch {
        try {
          process.kill(state.pid, "SIGKILL");
        } catch {}
      }
    }
  }

  removeState(config);
  return {
    status: "stopped",
    pid: state.pid,
    ...publicConfig(config),
  };
}

export async function statusService(config) {
  ensureRuntimeDirs(config);
  const state = readState(config);
  if (!state?.pid) return { status: "stopped", ...publicConfig(config) };
  if (!isProcessRunning(state.pid)) return { status: "stale", pid: state.pid, ...publicConfig(config) };

  try {
    const health = await waitForHealth(config, 2000);
    return {
      status: "running",
      pid: state.pid,
      startedAt: state.startedAt,
      health,
      ...publicConfig(config),
    };
  } catch (error) {
    return {
      status: "unhealthy",
      pid: state.pid,
      message: error.message,
      ...publicConfig(config),
    };
  }
}

export async function healthService(config) {
  const health = await waitForHealth(config, 5000);
  return {
    status: "ok",
    health,
    ...publicConfig(config),
  };
}

async function main() {
  const { command, options } = parseOptions(process.argv.slice(2));
  const config = createRuntimeConfig(options);
  let result;

  if (command === "start") result = await startService(config);
  else if (command === "stop") result = await stopService(config);
  else if (command === "status") result = await statusService(config);
  else if (command === "health") result = await healthService(config);
  else if (command === "restart") {
    await stopService(config);
    result = await startService(config);
  } else if (command === "config") result = publicConfig(config);
  else throw new Error(`Unknown service command: ${command}`);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
