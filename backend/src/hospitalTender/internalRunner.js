import { spawn as nodeSpawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeHospitalTenderSyncPayload } from "./sync.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CUSTOMER_HOSPITALS = 2_000;
const MAX_CUSTOMER_REGISTRY_BYTES = 8 * 1024 * 1024;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_COLLECTOR_ROOT = resolve(MODULE_DIR, "../../vendor/hospital-tender-monitor");

export class InternalHospitalTenderRunError extends Error {
  constructor(message = "Internal hospital tender monitor failed", options = {}) {
    const { stage = "runner", ...errorOptions } = options;
    super(message, errorOptions);
    this.name = "InternalHospitalTenderRunError";
    this.code = "HOSPITAL_TENDER_INTERNAL_RUN_FAILED";
    this.stage = stage;
  }
}

function safePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function commandEnvironment({ collectorRoot, dataDir, customerHospitalsPath, env = process.env }) {
  // This is an explicit allowlist. The collector has no notification client,
  // and must never inherit PushPlus credentials, sync URLs, bearer tokens,
  // cookies, or model keys from the backend process.
  const path = typeof env.PATH === "string" ? env.PATH : "";
  const pythonPath = join(collectorRoot, "src");
  return {
    PATH: path,
    PYTHONPATH: pythonPath,
    PYTHONIOENCODING: "utf-8",
    HOSPITAL_TENDER_MONITOR_DATA_DIR: dataDir,
    // Python's macOS urllib otherwise discovers and silently uses the host's
    // system proxy even though proxy URLs were excluded from this allowlist.
    // Public-source collection is deliberately direct and credential-free.
    NO_PROXY: "*",
    no_proxy: "*",
    ...(customerHospitalsPath
      ? { HOSPITAL_TENDER_MONITOR_CUSTOMER_HOSPITALS_PATH: customerHospitalsPath }
      : {}),
  };
}

function collectOutput(child, timeoutMs) {
  return new Promise((resolveOutput, rejectOutput) => {
    let stderr = "";
    let settled = false;
    let timer;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    child.once("error", (error) => settle(rejectOutput, error));
    child.once("close", (code, signal) => settle(resolveOutput, { code, signal, stderr }));
    timer = setTimeout(() => {
      // Do not wait for a misbehaving collector to honor SIGTERM. The HTTP
      // request must fail closed within the configured bound.
      try {
        child.kill?.("SIGTERM");
        child.kill?.("SIGKILL");
      } catch {
        // The process may already have exited; the timeout result is enough.
      }
      settle(rejectOutput, new InternalHospitalTenderRunError(
        "Internal hospital tender monitor timed out",
        { stage: "collector_timeout" },
      ));
    }, timeoutMs);
  });
}

/**
 * Run the bundled public-source collector and return a validated snapshot.
 * The child process is intentionally one-shot and receives no user secrets.
 */
export function createInternalHospitalTenderRunner(options = {}) {
  const collectorRoot = resolve(options.collectorRoot ?? DEFAULT_COLLECTOR_ROOT);
  const pythonExecutable = options.pythonExecutable ?? process.env.HOSPITAL_TENDER_PYTHON ?? "python3";
  const timeoutMs = safePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const environment = options.environment ?? process.env;

  return {
    collectorRoot,
    async run({ signal, customerHospitals } = {}) {
      const runDir = await mkdtemp(join(tmpdir(), "sentelligent-hospital-tender-"));
      const dataDir = join(runDir, "data");
      const outputPath = join(runDir, "snapshot.json");
      try {
        let customerHospitalsPath = "";
        if (customerHospitals !== undefined) {
          if (!Array.isArray(customerHospitals) || customerHospitals.length > MAX_CUSTOMER_HOSPITALS) {
            throw new InternalHospitalTenderRunError(
              "Internal hospital customer registry is invalid",
              { stage: "customer_registry" },
            );
          }
          const serializedCustomerHospitals = `${JSON.stringify({ hospitals: customerHospitals })}\n`;
          if (Buffer.byteLength(serializedCustomerHospitals, "utf8") > MAX_CUSTOMER_REGISTRY_BYTES) {
            throw new InternalHospitalTenderRunError(
              "Internal hospital customer registry is invalid",
              { stage: "customer_registry" },
            );
          }
          customerHospitalsPath = join(runDir, "customer_hospitals.json");
          await writeFile(
            customerHospitalsPath,
            serializedCustomerHospitals,
            { encoding: "utf8", mode: 0o600 },
          );
          await chmod(customerHospitalsPath, 0o600).catch(() => {});
        }
        let child;
        try {
          child = spawnImpl(
            pythonExecutable,
            ["-m", "hospital_tender_monitor.cli", "--project-root", collectorRoot, "run-and-export", "--output", outputPath],
            {
              cwd: collectorRoot,
              env: commandEnvironment({
                collectorRoot,
                dataDir,
                customerHospitalsPath,
                env: environment,
              }),
              stdio: ["ignore", "ignore", "pipe"],
              signal,
            },
          );
        } catch (error) {
          throw new InternalHospitalTenderRunError(
            "Internal hospital tender collector could not be started",
            { stage: "collector_spawn", cause: error },
          );
        }
        let result;
        try {
          result = await collectOutput(child, timeoutMs);
        } catch (error) {
          if (error instanceof InternalHospitalTenderRunError) throw error;
          throw new InternalHospitalTenderRunError(
            "Internal hospital tender collector process failed",
            { stage: "collector_process", cause: error },
          );
        }
        if (result.code !== 0 || result.signal) {
          throw new InternalHospitalTenderRunError(
            "Internal hospital tender collector exited unsuccessfully",
            { stage: "collector_exit" },
          );
        }
        let rawSnapshot;
        try {
          rawSnapshot = await readFile(outputPath, "utf8");
        } catch (error) {
          throw new InternalHospitalTenderRunError(
            "Internal hospital tender snapshot could not be read",
            { stage: "snapshot_read", cause: error },
          );
        }
        let payload;
        try {
          payload = JSON.parse(rawSnapshot);
        } catch (error) {
          throw new InternalHospitalTenderRunError(
            "Internal hospital tender snapshot is not valid JSON",
            { stage: "snapshot_parse", cause: error },
          );
        }
        try {
          payload = normalizeHospitalTenderSyncPayload(payload);
        } catch (error) {
          throw new InternalHospitalTenderRunError(
            "Internal hospital tender snapshot validation failed",
            { stage: "snapshot_normalize", cause: error },
          );
        }
        return { payload, source: "internal" };
      } catch (error) {
        if (error instanceof InternalHospitalTenderRunError) throw error;
        throw new InternalHospitalTenderRunError(
          "Internal hospital tender monitor failed",
          { stage: "runner", cause: error },
        );
      } finally {
        await rm(runDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

export const internalHospitalTenderCollectorRoot = DEFAULT_COLLECTOR_ROOT;
