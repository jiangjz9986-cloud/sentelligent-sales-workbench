import {
  lstat,
  readdir,
  rm,
} from "node:fs/promises";
import { isAbsolute, normalize, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Versioned, server-local cleanup for the ASR runtime directory.
 *
 * The backend owns the same directory while it is running.  This utility is
 * deliberately small and fail-closed: it only removes an entry after an
 * individual lstat confirms a real, service-owned 0700 request directory.
 * It never shells out and never follows a symlink.  A non-request entry or an
 * ownership/permission anomaly is reported as degraded and is left in place
 * for an operator to inspect.
 */

export const ASR_RUNTIME_DIRECTORY = "/run/sentelligent-asr";
export const DEFAULT_RUNTIME_DIRECTORY = ASR_RUNTIME_DIRECTORY;
export const ASR_REQUEST_DIRECTORY_PATTERN = /^request-[A-Za-z0-9_-]{6,128}$/u;
export const REQUEST_DIRECTORY_PATTERN = ASR_REQUEST_DIRECTORY_PATTERN;
export const DEFAULT_MAX_AGE_MS = 10 * 60 * 1_000;
export const ASR_CLEANUP_MAX_AGE_MS = DEFAULT_MAX_AGE_MS;
export const ASR_RUNTIME_CLEANUP_REPORT_SCHEMA_VERSION = 1;
export const ASR_CLEANUP_MODES = Object.freeze(["startup", "periodic"]);
export const DEFAULT_CLEANUP_ATTEMPTS_MS = Object.freeze([0, 50, 200, 1_000]);

const MAX_PATH_LENGTH = 4_096;
const MAX_ENTRY_COUNT = 10_000;
const SAFE_DIRECTORY_MODE = 0o700;

function usageError(message) {
  const error = new Error(message);
  error.code = "USAGE";
  error.exitCode = 64;
  return error;
}

function boundedInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) {
    throw usageError(`${label} must be a non-negative integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw usageError(`${label} is outside the supported range`);
  }
  return parsed;
}

/** Validate a path before it can be passed to any filesystem operation. */
export function normalizeRuntimeDirectory(value, {
  allowDefault = true,
} = {}) {
  const candidate = value === undefined || value === null || value === ""
    ? (allowDefault ? DEFAULT_RUNTIME_DIRECTORY : "")
    : String(value);
  if (
    candidate.length === 0
    || candidate.length > MAX_PATH_LENGTH
    || candidate.includes("\0")
    || !isAbsolute(candidate)
    || normalize(candidate) !== candidate
    || candidate.endsWith("/")
    || candidate === "/"
  ) {
    throw usageError("runtime directory must be a normalized absolute path other than /");
  }
  return candidate;
}

function currentUidValue(value = process.getuid?.()) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("the current service uid is unavailable");
  }
  return value;
}

function modeBits(stat) {
  return Number(stat?.mode ?? 0) & 0o7777;
}

function isProtectedDirectory(stat, uid) {
  return Boolean(
    stat
    && typeof stat.isDirectory === "function"
    && stat.isDirectory()
    && typeof stat.isSymbolicLink === "function"
    && !stat.isSymbolicLink()
    && stat.uid === uid
    && modeBits(stat) === SAFE_DIRECTORY_MODE,
  );
}

function sameFilesystemIdentity(left, right) {
  return Number.isSafeInteger(left?.dev)
    && Number.isSafeInteger(left?.ino)
    && left.dev === right?.dev
    && left.ino === right?.ino;
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function safeAge(nowValue, mtimeMs) {
  if (!Number.isFinite(nowValue) || !Number.isFinite(mtimeMs)) return null;
  const age = nowValue - mtimeMs;
  return age >= 0 ? age : 0;
}

/**
 * Inspect descendants without following links.  A symlink anywhere inside a
 * request workspace makes that workspace an anomaly and therefore prevents
 * recursive deletion.  Regular files and nested directories are allowed.
 */
async function containsSymlink(path, fsImpl, visited = new Set()) {
  let stat;
  try {
    stat = await fsImpl.lstat(path);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink?.()) return true;
  if (!stat.isDirectory?.()) return false;
  const identity = `${stat.dev ?? ""}:${stat.ino ?? path}`;
  if (visited.has(identity)) return false;
  visited.add(identity);
  const entries = await fsImpl.readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (await containsSymlink(join(path, entry.name), fsImpl, visited)) return true;
  }
  return false;
}

async function assertRuntimeRoot(runtimeDirectory, fsImpl, uid) {
  let stat;
  try {
    stat = await fsImpl.lstat(runtimeDirectory);
  } catch (error) {
    if (isMissing(error)) {
      const wrapped = new Error("ASR runtime directory does not exist");
      wrapped.code = "ASR_RUNTIME_MISSING";
      throw wrapped;
    }
    throw error;
  }
  if (!isProtectedDirectory(stat, uid)) {
    const wrapped = new Error("ASR runtime directory is not a protected service directory");
    wrapped.code = "ASR_RUNTIME_UNSAFE";
    throw wrapped;
  }
  return stat;
}

function sleep(delayMs) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

/** Remove a workspace with bounded retries and an explicit ENOENT check. */
export async function removeAsrWorkspaceAndVerify(path, fsImpl, {
  attempts = DEFAULT_CLEANUP_ATTEMPTS_MS,
  sleepImpl = sleep,
  validate,
} = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    throw new TypeError("cleanup attempts must be a non-empty array");
  }
  if (typeof sleepImpl !== "function") throw new TypeError("sleepImpl must be a function");
  if (validate !== undefined && typeof validate !== "function") {
    throw new TypeError("validate must be a function");
  }
  let lastError = null;
  for (const delay of attempts) {
    if (!Number.isSafeInteger(delay) || delay < 0) {
      throw new TypeError("cleanup attempt delays must be non-negative integers");
    }
    if (delay > 0) await sleepImpl(delay);
    try {
      await validate?.();
      await fsImpl.rm(path, { recursive: true, force: true });
      try {
        await fsImpl.lstat(path);
      } catch (error) {
        if (isMissing(error)) return true;
        throw error;
      }
      const error = new Error("ASR request workspace still exists after cleanup");
      error.code = "ASR_CLEANUP_RESIDUAL";
      throw error;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("ASR request workspace cleanup failed");
}

/**
 * Sweep one ASR runtime directory.
 *
 * `startup` removes every valid request-* directory because no request can
 * survive a process restart. `periodic` removes only valid directories older
 * than `maxAgeMs`; fresh directories are treated as active and left alone.
 */
export async function cleanupAsrRuntime({
  runtimeDirectory = DEFAULT_RUNTIME_DIRECTORY,
  mode = "startup",
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now,
  currentUid = process.getuid?.(),
  fsImpl = { lstat, readdir, rm },
  cleanupAttempts = DEFAULT_CLEANUP_ATTEMPTS_MS,
  sleepImpl = sleep,
} = {}) {
  const root = normalizeRuntimeDirectory(runtimeDirectory);
  if (!ASR_CLEANUP_MODES.includes(mode)) {
    throw usageError("mode must be startup or periodic");
  }
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    throw usageError("maxAgeMs must be a non-negative integer");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const uid = currentUidValue(currentUid);
  const rootIdentity = await assertRuntimeRoot(root, fsImpl, uid);

  let entries = await fsImpl.readdir(root, { withFileTypes: true });
  const rootAfterRead = await assertRuntimeRoot(root, fsImpl, uid);
  if (!sameFilesystemIdentity(rootIdentity, rootAfterRead)) {
    const error = new Error("ASR runtime directory identity changed during inspection");
    error.code = "ASR_RUNTIME_IDENTITY_CHANGED";
    throw error;
  }
  if (!Array.isArray(entries)) entries = [...entries];
  if (entries.length > MAX_ENTRY_COUNT) {
    const error = new Error("ASR runtime directory contains too many entries");
    error.code = "ASR_RUNTIME_TOO_MANY_ENTRIES";
    throw error;
  }
  entries.sort((left, right) => String(left.name).localeCompare(String(right.name)));

  const report = {
    schemaVersion: ASR_RUNTIME_CLEANUP_REPORT_SCHEMA_VERSION,
    status: "clean",
    ready: true,
    runtimeDirectory: root,
    mode,
    scannedCount: 0,
    requestDirectoryCount: 0,
    staleCount: 0,
    removedCount: 0,
    retainedCount: 0,
    anomalyCount: 0,
    residualEntryCount: 0,
    residualDirectoryCount: 0,
  };
  const residualNames = [];
  const residualDirectoryNames = [];
  const retainedNames = new Set();
  const addResidual = (name, stat) => {
    residualNames.push(name);
    if (stat?.isDirectory?.() === true && stat?.isSymbolicLink?.() !== true) {
      residualDirectoryNames.push(name);
    }
  };
  const nowValue = Number(now());

  for (const entry of entries) {
    report.scannedCount += 1;
    const name = String(entry?.name ?? "");
    const candidate = join(root, name);
    let stat;
    try {
      // Always lstat the path, even when the dirent says it is a directory.
      // This closes the common readdir-to-delete symlink substitution gap.
      stat = await fsImpl.lstat(candidate);
    } catch (error) {
      if (!isMissing(error)) {
        report.anomalyCount += 1;
        addResidual(name, null);
      }
      // A request that disappeared concurrently is already cleaned.
      continue;
    }

    if (!ASR_REQUEST_DIRECTORY_PATTERN.test(name)) {
      report.anomalyCount += 1;
      addResidual(name, stat);
      continue;
    }
    report.requestDirectoryCount += 1;

    if (!isProtectedDirectory(stat, uid)) {
      report.anomalyCount += 1;
      addResidual(name, stat);
      continue;
    }

    // Recheck the complete tree before deleting.  lstat is used at every
    // step, so a symlink is observed rather than traversed.
    let hasSymlink = false;
    try {
      hasSymlink = await containsSymlink(candidate, fsImpl);
    } catch {
      report.anomalyCount += 1;
      addResidual(name, stat);
      continue;
    }
    if (hasSymlink) {
      report.anomalyCount += 1;
      addResidual(name, stat);
      continue;
    }

    const ageMs = safeAge(nowValue, Number(stat.mtimeMs));
    if (ageMs === null) {
      report.anomalyCount += 1;
      addResidual(name, stat);
      continue;
    }
    const stale = mode === "startup" || ageMs > maxAgeMs;
    if (!stale) {
      report.retainedCount += 1;
      retainedNames.add(name);
      continue;
    }
    report.staleCount += 1;

    try {
      // Re-lstat immediately before rm and refuse a swapped entry.
      const beforeRemove = await fsImpl.lstat(candidate);
      const rootBeforeRemove = await assertRuntimeRoot(root, fsImpl, uid);
      if (
        !sameFilesystemIdentity(rootIdentity, rootBeforeRemove)
        || !isProtectedDirectory(beforeRemove, uid)
        || !sameFilesystemIdentity(stat, beforeRemove)
      ) {
        throw new Error("ASR request workspace identity changed");
      }
      await removeAsrWorkspaceAndVerify(candidate, fsImpl, {
        attempts: cleanupAttempts,
        sleepImpl,
        validate: async () => {
          const currentRoot = await assertRuntimeRoot(root, fsImpl, uid);
          const currentCandidate = await fsImpl.lstat(candidate);
          if (
            !sameFilesystemIdentity(rootIdentity, currentRoot)
            || !isProtectedDirectory(currentCandidate, uid)
            || !sameFilesystemIdentity(stat, currentCandidate)
          ) {
            throw new Error("ASR request workspace identity changed");
          }
        },
      });
      report.removedCount += 1;
    } catch {
      report.anomalyCount += 1;
      addResidual(name, stat);
    }
  }

  // Close the sweep with one more root identity/read check.  This catches a
  // workspace (or operator-created anomaly) that appeared after the initial
  // readdir instead of silently claiming the root was clean.
  try {
    const finalRoot = await assertRuntimeRoot(root, fsImpl, uid);
    if (!sameFilesystemIdentity(rootIdentity, finalRoot)) {
      throw new Error("ASR runtime directory identity changed during cleanup");
    }
    const finalEntries = await fsImpl.readdir(root, { withFileTypes: true });
    for (const finalEntry of finalEntries) {
      const finalName = String(finalEntry?.name ?? "");
      if (retainedNames.has(finalName) || residualNames.includes(finalName)) continue;
      let finalStat = null;
      try {
        finalStat = await fsImpl.lstat(join(root, finalName));
      } catch (error) {
        if (isMissing(error)) continue;
      }
      report.anomalyCount += 1;
      addResidual(finalName, finalStat);
    }
  } catch (error) {
    report.anomalyCount += 1;
    // Keep the report bounded and avoid exposing filesystem details.  The
    // initial per-entry evidence remains available in residualNames.
  }

  report.residualEntryCount = residualNames.length;
  report.residualDirectoryCount = residualDirectoryNames.length;
  report.ready = report.anomalyCount === 0 && report.residualEntryCount === 0;
  report.status = report.ready ? "clean" : "degraded";
  Object.defineProperty(report, "residualNames", {
    value: Object.freeze([...residualNames]),
    enumerable: false,
  });
  return Object.freeze(report);
}

// Friendly aliases for callers that use the operation-oriented naming from
// the release runbook.
export const runAsrRuntimeCleanup = cleanupAsrRuntime;
export const sweepAsrRuntime = cleanupAsrRuntime;

export function parseCleanupArguments(argv = process.argv.slice(2), env = process.env) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const options = {
    runtimeDirectory: env.ASR_RUNTIME_DIRECTORY ?? env.ASR_TEMP_ROOT ?? DEFAULT_RUNTIME_DIRECTORY,
    mode: env.ASR_CLEANUP_MODE ?? "startup",
    maxAgeMs: env.ASR_CLEANUP_MAX_AGE_MS === undefined
      ? DEFAULT_MAX_AGE_MS
      : boundedInteger(env.ASR_CLEANUP_MAX_AGE_MS, "ASR_CLEANUP_MAX_AGE_MS"),
    json: false,
    help: false,
  };
  const readValue = (index, flag) => {
    if (index + 1 >= argv.length || String(argv[index + 1]).startsWith("-")) {
      throw usageError(`${flag} requires a value`);
    }
    return String(argv[index + 1]);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : null;
    if (["--root", "--runtime-directory", "--runtime-dir", "--temp-root"].includes(name)) {
      const value = inline ?? readValue(index, name);
      if (inline === null) index += 1;
      options.runtimeDirectory = value;
      continue;
    }
    if (name === "--mode") {
      const value = inline ?? readValue(index, name);
      if (inline === null) index += 1;
      options.mode = value;
      continue;
    }
    if (name === "--max-age-ms") {
      const value = inline ?? readValue(index, name);
      if (inline === null) index += 1;
      options.maxAgeMs = boundedInteger(value, "--max-age-ms");
      continue;
    }
    throw usageError(`unknown option: ${token}`);
  }
  options.runtimeDirectory = normalizeRuntimeDirectory(options.runtimeDirectory);
  if (!ASR_CLEANUP_MODES.includes(options.mode)) {
    throw usageError("mode must be startup or periodic");
  }
  return Object.freeze(options);
}

export const CLEANUP_USAGE = `Usage: node scripts/asr-runtime-cleanup.mjs [options]

Remove stale ASR request workspaces without following symlinks.

Options:
  --root=PATH, --runtime-directory=PATH  runtime directory (default ${DEFAULT_RUNTIME_DIRECTORY})
  --mode=startup|periodic                startup removes all valid requests (default startup)
  --max-age-ms=N                         periodic age threshold (default ${DEFAULT_MAX_AGE_MS})
  --json                                 emit a JSON report (the default output is JSON too)
  --help                                 show this message
`;

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseCleanupArguments(argv, env);
  } catch (error) {
    const payload = { status: "error", code: error.code ?? "ASR_CLEANUP_ERROR", message: error.message };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return error.exitCode ?? 1;
  }
  if (options.help) {
    process.stdout.write(CLEANUP_USAGE);
    return 0;
  }
  try {
    const report = await cleanupAsrRuntime(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.status === "clean" ? 0 : 1;
  } catch (error) {
    const payload = { status: "error", code: error.code ?? "ASR_CLEANUP_ERROR", message: error.message };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => {
    if (exitCode !== 0) process.exitCode = exitCode;
  });
}
