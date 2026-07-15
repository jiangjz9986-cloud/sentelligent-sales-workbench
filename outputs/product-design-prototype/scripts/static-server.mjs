import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

function isPosixAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

function resolveRuntimePath(value) {
  return isPosixAbsolutePath(value) ? value : resolve(value);
}

function joinRuntimePath(root, ...parts) {
  return isPosixAbsolutePath(root) ? posix.join(root, ...parts) : join(root, ...parts);
}

function parseOptions(argv) {
  const [command = "status", ...rest] = argv;
  const options = {};
  for (const arg of rest) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    options[match[1].replaceAll("-", "_")] = match[2];
  }
  return { command, options };
}

export function createStaticServerConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const runtimeRoot = resolveRuntimePath(
    env.runtimeRoot ??
      env.SENT_ZX_RUNTIME_ROOT ??
      join(homedir(), ".sentelligent-sales-workbench"),
  );
  const runtimeDir = joinRuntimePath(runtimeRoot, "runtime");
  const logDir = joinRuntimePath(runtimeRoot, "logs");
  const distPath = resolveRuntimePath(env.distPath ?? env.DIST_PATH ?? resolve(appRoot, "dist"));

  return {
    runtimeRoot,
    runtimeDir,
    logDir,
    distPath,
    statePath: joinRuntimePath(runtimeDir, "frontend-static.json"),
    logPath: joinRuntimePath(logDir, "frontend-static.log"),
    host: env.host ?? env.HOST ?? "127.0.0.1",
    port: Number(env.port ?? env.PORT ?? 8088),
    apiBaseUrl: String(env.apiBaseUrl ?? env.API_BASE_URL ?? "").replace(/\/+$/, ""),
  };
}

function ensureDirs(config) {
  mkdirSync(config.runtimeDir, { recursive: true });
  mkdirSync(config.logDir, { recursive: true });
}

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

export function contentTypeFor(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
  }[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function injectRuntimeConfig(html, config) {
  const apiBaseUrl = String(config.apiBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!apiBaseUrl) return html;
  const script = `<script>window.__SENTELLIGENT_API_BASE_URL__ = ${JSON.stringify(apiBaseUrl)};</script>`;
  return html.includes("<head>") ? html.replace("<head>", `<head>${script}`) : `${script}${html}`;
}

export function resolveRequestPath(distPath, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath.split("?")[0]);
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const normalized = normalize(relative);
  if (normalized.startsWith("..") || normalized.includes(`..${sep}`)) return null;

  const root = resolveRuntimePath(distPath);
  const candidate = isPosixAbsolutePath(root)
    ? posix.join(root, normalized.replaceAll("\\", "/"))
    : resolve(root, normalized);
  if (!isPosixAbsolutePath(root) && !candidate.startsWith(root)) return null;
  if (isPosixAbsolutePath(root) && !candidate.startsWith(root)) return null;
  return candidate;
}

async function waitForHealth(config, timeoutMs = 10000) {
  const url = `http://${config.host}:${config.port}/_health`;
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

export function createStaticServer(config) {
  return createServer((request, response) => {
    if (request.url?.startsWith("/_health")) {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        status: "ok",
        apiBaseUrl: config.apiBaseUrl,
        distPath: config.distPath,
      }));
      return;
    }

    const requested = resolveRequestPath(config.distPath, request.url ?? "/");
    if (!requested) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    let filePath = requested;
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      filePath = resolveRequestPath(config.distPath, "/");
    }

    response.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (filePath.endsWith("index.html")) {
      response.end(injectRuntimeConfig(readFileSync(filePath, "utf8"), config));
      return;
    }
    createReadStream(filePath).pipe(response);
  });
}

export async function startStaticServer(config) {
  ensureDirs(config);
  if (!existsSync(resolveRequestPath(config.distPath, "/"))) {
    throw new Error(`Frontend dist is missing index.html: ${config.distPath}`);
  }

  const current = readState(config);
  if (current?.pid && isProcessRunning(current.pid)) {
    const health = await waitForHealth(config, 2000);
    return { status: "already_running", pid: current.pid, health, ...publicConfig(config) };
  }

  const logFd = openSync(config.logPath, "a");
  const child = spawn(process.execPath, [
    "scripts/static-server.mjs",
    "serve",
    `--host=${config.host}`,
    `--port=${config.port}`,
    `--dist-path=${config.distPath}`,
    `--api-base-url=${config.apiBaseUrl}`,
    `--runtime-root=${config.runtimeRoot}`,
  ], {
    cwd: appRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  writeState(config, {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    host: config.host,
    port: config.port,
    distPath: config.distPath,
    apiBaseUrl: config.apiBaseUrl,
    logPath: config.logPath,
  });

  try {
    const health = await waitForHealth(config);
    return { status: "started", pid: child.pid, health, ...publicConfig(config) };
  } catch (error) {
    await stopStaticServer(config);
    throw error;
  }
}

export async function stopStaticServer(config) {
  ensureDirs(config);
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }

  removeState(config);
  return { status: "stopped", pid: state.pid, ...publicConfig(config) };
}

export async function statusStaticServer(config) {
  ensureDirs(config);
  const state = readState(config);
  if (!state?.pid) return { status: "stopped", ...publicConfig(config) };
  if (!isProcessRunning(state.pid)) return { status: "stale", pid: state.pid, ...publicConfig(config) };
  try {
    const health = await waitForHealth(config, 2000);
    return { status: "running", pid: state.pid, health, ...publicConfig(config) };
  } catch (error) {
    return { status: "unhealthy", pid: state.pid, message: error.message, ...publicConfig(config) };
  }
}

export async function healthStaticServer(config) {
  const health = await waitForHealth(config, 3000);
  return { status: "ok", health, ...publicConfig(config) };
}

function publicConfig(config) {
  return {
    runtimeRoot: config.runtimeRoot,
    statePath: config.statePath,
    logPath: config.logPath,
    distPath: config.distPath,
    host: config.host,
    port: config.port,
    apiBaseUrl: config.apiBaseUrl,
  };
}

async function main() {
  const { command, options } = parseOptions(process.argv.slice(2));
  const config = createStaticServerConfig({
    runtimeRoot: options.runtime_root,
    distPath: options.dist_path,
    host: options.host,
    port: options.port,
    apiBaseUrl: options.api_base_url,
  });
  let result;

  if (command === "serve") {
    const server = createStaticServer(config);
    await new Promise((resolveListen) => server.listen(config.port, config.host, resolveListen));
    return;
  }
  if (command === "start") result = await startStaticServer(config);
  else if (command === "stop") result = await stopStaticServer(config);
  else if (command === "status") result = await statusStaticServer(config);
  else if (command === "health") result = await healthStaticServer(config);
  else if (command === "config") result = publicConfig(config);
  else throw new Error(`Unknown static server command: ${command}`);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
