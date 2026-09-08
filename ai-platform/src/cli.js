import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadAiPlatformConfig } from "./config.js";
import { openAiPlatformDatabase } from "./db/index.js";
import { createServer, PACKAGE_VERSION } from "./server.js";

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
  const server = createServer({ config, autoStart: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  process.stdout.write(`AI platform listening on http://${config.host}:${address.port}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.closeAiPlatform(() => process.exit(0));
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
