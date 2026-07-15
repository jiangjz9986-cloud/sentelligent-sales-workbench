import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { all, openDatabase } from "../src/db.js";
import {
  createRuntimeConfig,
  ensureRuntimeDirs,
  parseOptions,
} from "./runtime-config.mjs";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function labelPart(value = "manual") {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "manual";
}

export function backupDatabase({ databaseUrl, backupDir, label } = {}) {
  const config = createRuntimeConfig({ databaseUrl, backupDir });
  ensureRuntimeDirs(config);
  const backupPath = join(config.backupDir, `${timestamp()}-${labelPart(label)}.sqlite`);

  const db = openDatabase({ databaseUrl: config.databaseUrl });
  try {
    db.prepare("VACUUM INTO ?").run(backupPath);
  } finally {
    db.close();
  }

  return {
    status: "backed_up",
    databasePath: config.databaseUrl,
    backupPath,
    bytes: statSync(backupPath).size,
  };
}

export function restoreDatabase({ databaseUrl, backupPath, backupDir } = {}) {
  if (!backupPath) throw new Error("backupPath is required for restore");
  if (!existsSync(backupPath)) throw new Error(`Backup does not exist: ${backupPath}`);

  const config = createRuntimeConfig({ databaseUrl, backupDir });
  ensureRuntimeDirs(config);
  mkdirSync(dirname(config.databaseUrl), { recursive: true });

  let preRestoreBackupPath = null;
  if (existsSync(config.databaseUrl)) {
    preRestoreBackupPath = join(config.backupDir, `${timestamp()}-pre-restore.sqlite`);
    copyFileSync(config.databaseUrl, preRestoreBackupPath);
  }

  copyFileSync(backupPath, config.databaseUrl);
  const info = inspectDatabase({ databaseUrl: config.databaseUrl });

  return {
    status: "restored",
    databasePath: config.databaseUrl,
    backupPath,
    preRestoreBackupPath,
    tables: info.tables,
  };
}

export function inspectDatabase({ databaseUrl } = {}) {
  const config = createRuntimeConfig({ databaseUrl });
  ensureRuntimeDirs(config);
  const db = openDatabase({ databaseUrl: config.databaseUrl });
  try {
    const tableNames = [
      "customers",
      "opportunities",
      "quick_records",
      "ai_insights",
      "manual_confirmations",
      "weekly_reports",
      "solution_drafts",
      "action_items",
    ];
    const tables = Object.fromEntries(
      tableNames.map((table) => [
        table,
        all(db, `SELECT COUNT(*) AS count FROM ${table}`)[0].count,
      ]),
    );
    return {
      status: "ready",
      databasePath: config.databaseUrl,
      exists: existsSync(config.databaseUrl),
      bytes: existsSync(config.databaseUrl) ? statSync(config.databaseUrl).size : 0,
      tables,
    };
  } finally {
    db.close();
  }
}

async function main() {
  const { command, options } = parseOptions(process.argv.slice(2));
  const config = createRuntimeConfig(options);
  let result;

  if (command === "backup") {
    result = backupDatabase(config);
  } else if (command === "restore") {
    result = restoreDatabase(config);
  } else if (command === "info") {
    result = inspectDatabase(config);
  } else {
    throw new Error(`Unknown database command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
