import { existsSync, chmodSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

import { loadAiPlatformConfig } from "./config.js";
import { openAiPlatformDatabase } from "./db/index.js";
import { createServer, PACKAGE_VERSION } from "./server.js";
import {
  AI_PLATFORM_SOCKET_MODE,
  assertAiPlatformSocket,
  assertAiPlatformSocketDirectory,
} from "../../shared/aiPlatformSocketTransport.mjs";

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const overrides = {};
  for (const item of rest) {
    const match = String(item).match(/^--([a-zA-Z][a-zA-Z0-9_-]*)=(.*)$/u);
    if (!match) continue;
    const key = match[1].replaceAll("-", "_");
    overrides[key] = match[2];
  }
  return { command, overrides };
}

function configFromOverrides(overrides) {
  return loadAiPlatformConfig({
    ...(overrides.host ? { host: overrides.host } : {}),
    ...(overrides.port ? { port: Number(overrides.port) } : {}),
    ...(overrides.database ? { databasePath: overrides.database } : {}),
    ...(overrides.database_path ? { databasePath: overrides.database_path } : {}),
    ...(overrides.static_directory ? { staticDirectory: overrides.static_directory } : {}),
  });
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function start(overrides) {
  const config = configFromOverrides(overrides);
  if (config.socketPath) {
    const parentPath = dirname(config.socketPath);
    const ownerUid = process.getuid?.();
    const groupGid = process.getegid?.();
    assertAiPlatformSocketDirectory(parentPath, { ownerUid, groupGid });
    if (existsSync(config.socketPath)) {
      const before = lstatSync(config.socketPath);
      if (!before.isSocket() || before.uid !== process.getuid?.()) throw new Error("AI socket identity is unsafe");
      const active = await new Promise((resolve, reject) => {
        const probe = createConnection(config.socketPath);
        probe.setTimeout(1000, () => probe.destroy(new Error("AI socket probe timed out")));
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", (error) => ["ECONNREFUSED", "ENOENT"].includes(error.code) ? resolve(false) : reject(error));
      });
      if (active) throw new Error("AI platform already owns the socket");
      if (existsSync(config.socketPath)) {
        const after = lstatSync(config.socketPath);
        if (after.ino !== before.ino || after.dev !== before.dev) throw new Error("AI socket changed during inspection");
        unlinkSync(config.socketPath);
      }
    }
  }
  const server = createServer({ config, autoStart: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (config.socketPath) server.listen(config.socketPath, resolve);
    else server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  if (config.socketPath) {
    try {
      chmodSync(config.socketPath, AI_PLATFORM_SOCKET_MODE);
      assertAiPlatformSocket(config.socketPath, { ownerUid: process.getuid?.(), groupGid: process.getegid?.() });
    } catch (error) {
      await server.closeAiPlatform().catch(() => {});
      throw error;
    }
  }
  process.stdout.write(config.socketPath ? "AI platform listening on its protected local socket\n" : `AI platform listening on http://${config.host}:${address.port}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.closeAiPlatform((error) => {
      if (error) {
        process.stderr.write("AI platform shutdown incomplete; task state retained\n");
        process.exitCode = 1;
        return;
      }
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return new Promise(() => {});
}

function migrate(overrides) {
  const config = configFromOverrides(overrides);
  const db = openAiPlatformDatabase(config.databasePath);
  const migrationCount = Number(db.prepare("SELECT COUNT(*) AS count FROM platform_migrations").get().count);
  const agentCount = Number(db.prepare("SELECT COUNT(*) AS count FROM agents").get().count);
  db.close();
  print({ status: "ok", version: PACKAGE_VERSION, database: config.databasePath, migrations: migrationCount, agents: agentCount });
}

function status(overrides) {
  const config = configFromOverrides(overrides);
  const exists = config.databasePath === ":memory:" ? true : existsSync(config.databasePath);
  if (!exists) {
    print({ status: "not_initialized", version: PACKAGE_VERSION, database: config.databasePath });
    return;
  }
  const db = openAiPlatformDatabase(config.databasePath);
  const counts = db.prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status").all();
  const migrations = Number(db.prepare("SELECT COUNT(*) AS count FROM platform_migrations").get().count);
  db.close();
  print({
    status: "ok",
    version: PACKAGE_VERSION,
    database: config.databasePath,
    migrations,
    tasks: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])),
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { command, overrides } = parseArgs(argv);
  if (command === "start" || command === "serve") return start(overrides);
  if (command === "migrate" || command === "seed") return migrate(overrides);
  if (command === "status") return status(overrides);
  throw new Error(`unknown AI platform command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
