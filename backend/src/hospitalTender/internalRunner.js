import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeHospitalTenderSyncPayload } from "./sync.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_COLLECTOR_ROOT = resolve(MODULE_DIR, "../../vendor/hospital-tender-monitor");

export class InternalHospitalTenderRunError extends Error {
  constructor(message = "Internal hospital tender monitor failed", options = {}) {
    super(message, options);
    this.name = "InternalHospitalTenderRunError";
    this.code = "HOSPITAL_TENDER_INTERNAL_RUN_FAILED";
  }
}

function safePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function commandEnvironment({ collectorRoot, dataDir, env = process.env }) {
  // Only pass runtime basics. In particular, do not inherit sync URLs, bearer
  // tokens, PushPlus credentials, cookies, or model keys into the collector.
  const path = typeof env.PATH === "string" ? env.PATH : "";
  const pythonPath = join(collectorRoot, "src");
  return {
    PATH: path,
    PYTHONPATH: pythonPath,
    PYTHONIOENCODING: "utf-8",
    HOSPITAL_TENDER_MONITOR_DISABLE_NOTIFICATIONS: "1",
    HOSPITAL_TENDER_MONITOR_DATA_DIR: dataDir,
  };
}

function collectOutput(child) {
  return new Promise((resolveOutput, rejectOutput) => {
    let stderr = "";
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    child.once("error", (error) => rejectOutput(error));
    child.once("close", (code, signal) => resolveOutput({ code, signal, stderr }));
  });
}

/**
 * Run the bundled public-source collector and return a validated snapshot.
 * The child process is intentionally one-shot and receives no user secrets.
 */
export function createInternalHospitalTenderRunner(options = {}) {
  const collectorRoot = resolve(options.collectorRoot ?? DEFAULT_COLLECTOR_ROOT);
  const pythonExecutable = options.pythonExecutable ?? "python3";
  const timeoutMs = safePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const environment = options.environment ?? process.env;

  return {
    collectorRoot,
    async run({ signal } = {}) {
      const runDir = await mkdtemp(join(tmpdir(), "sentelligent-hospital-tender-"));
      const dataDir = join(runDir, "data");
      const outputPath = join(runDir, "snapshot.json");
      const child = spawnImpl(
        pythonExecutable,
        ["-m", "hospital_tender_monitor.cli", "--project-root", collectorRoot, "run-and-export", "--output", outputPath],
        {
          cwd: collectorRoot,
          env: commandEnvironment({ collectorRoot, dataDir, env: environment }),
          stdio: ["ignore", "ignore", "pipe"],
          signal,
        },
      );
      let timer;
      try {
        timer = setTimeout(() => child.kill?.("SIGTERM"), timeoutMs);
        const result = await collectOutput(child);
        if (result.code !== 0 || result.signal) {
          throw new InternalHospitalTenderRunError("Internal hospital tender monitor failed");
        }
        let payload;
        try {
          payload = JSON.parse(await readFile(outputPath, "utf8"));
        } catch {
          throw new InternalHospitalTenderRunError("Internal hospital tender snapshot is invalid");
        }
        try {
          payload = normalizeHospitalTenderSyncPayload(payload);
        } catch {
          throw new InternalHospitalTenderRunError("Internal hospital tender snapshot is invalid");
        }
        return { payload, source: "internal" };
      } catch (error) {
        if (error instanceof InternalHospitalTenderRunError) throw error;
        throw new InternalHospitalTenderRunError("Internal hospital tender monitor failed", { cause: error });
      } finally {
        if (timer) clearTimeout(timer);
        await rm(runDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

export const internalHospitalTenderCollectorRoot = DEFAULT_COLLECTOR_ROOT;
