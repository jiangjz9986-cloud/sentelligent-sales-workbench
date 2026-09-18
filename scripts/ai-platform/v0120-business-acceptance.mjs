import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_REPORT = resolve(ROOT, ".runtime/evidence/v0120-business-acceptance/report.json");

export const ACCEPTANCE_STAGES = Object.freeze([
  Object.freeze({
    id: "customer-import",
    files: Object.freeze([
      "backend/tests/customer-import-http.test.js",
      "outputs/product-design-prototype/src/api/customerImportApi.test.js",
    ]),
  }),
  Object.freeze({
    id: "hospital-tender-bridge",
    files: Object.freeze([
      "backend/tests/hospital-tender-lead-conversion-api.integration.test.js",
      "backend/tests/hospital-tender-bridge-http.test.js",
    ]),
  }),
  Object.freeze({
    id: "action-risk-writeback",
    files: Object.freeze([
      "backend/tests/action-risk-writeback.test.js",
      "backend/tests/proactive-customer-writeback-http.test.js",
      "backend/tests/assistant-proactive-auth-http.test.js",
    ]),
  }),
  Object.freeze({
    id: "contract-wiring",
    files: Object.freeze([
      "backend/tests/v0120-server-wiring.test.js",
      "backend/tests/hospital-tender-canonical-bridge.test.js",
      "backend/tests/customer-import.test.js",
    ]),
  }),
]);

function parseOption(value, name) {
  if (!value.startsWith(`${name}=`)) return null;
  const result = value.slice(name.length + 1).trim();
  if (!result) throw new TypeError(`${name} requires a value`);
  return result;
}

export function parseArguments(argv = []) {
  let reportPath = DEFAULT_REPORT;
  for (const argument of argv) {
    const report = parseOption(argument, "--report");
    if (report !== null) {
      reportPath = resolve(report);
      continue;
    }
    if (argument === "--help") return Object.freeze({ help: true, reportPath });
    throw new TypeError(`Unsupported argument: ${argument}`);
  }
  return Object.freeze({ help: false, reportPath });
}

function sourceCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function buildReport({ startedAt, finishedAt, stages, commit = sourceCommit() }) {
  const passed = stages.filter((stage) => stage.status === "passed").length;
  const failed = stages.filter((stage) => stage.status === "failed").length;
  return Object.freeze({
    schemaVersion: 1,
    runner: "sentelligent-v0120-business-acceptance",
    scope: "local-isolated-tests",
    sourceCommit: commit,
    startedAt,
    finishedAt,
    status: failed === 0 && passed === stages.length ? "passed" : "failed",
    summary: { total: stages.length, passed, failed },
    stages,
    boundaries: Object.freeze({
      productionNetwork: false,
      externalProviderCalls: false,
      realNotifications: false,
      iphoneDeviceAcceptance: false,
    }),
  });
}

function runStage(stage) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--test", ...stage.files], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "inherit",
  });
  return {
    id: stage.id,
    command: [process.execPath, "--test", ...stage.files],
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs: Date.now() - started,
  };
}

export function runAcceptance({ reportPath = DEFAULT_REPORT, now = () => new Date() } = {}) {
  const startedAt = now();
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.valueOf())) {
    throw new TypeError("Acceptance clock must return a valid Date");
  }
  const stages = ACCEPTANCE_STAGES.map(runStage);
  const finishedAt = now();
  if (!(finishedAt instanceof Date) || Number.isNaN(finishedAt.valueOf())) {
    throw new TypeError("Acceptance clock must return a valid Date");
  }
  const report = buildReport({
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    stages,
  });
  mkdirSync(dirname(resolve(reportPath)), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/ai-platform/v0120-business-acceptance.mjs [--report=/path/report.json]\n");
    return;
  }
  const report = runAcceptance(options);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    sourceCommit: report.sourceCommit,
    summary: report.summary,
    reportPath: resolve(options.reportPath),
  })}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}

const directEntry = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (directEntry) main();
