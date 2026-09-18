import { execFileSync } from "node:child_process";
import { constants, openSync, closeSync, writeFileSync, fsyncSync, renameSync, mkdirSync, lstatSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readStableRegularFile } from "../production-preflight.mjs";
import { createServiceToken } from "../../ai-platform/src/auth/internalAuth.js";
import { createRequestBinding } from "../../shared/aiPlatformRequestAuth.mjs";
import { hashBytes, PLATFORM_ENV } from "./production-contract.mjs";
import { readBoundedResponseText } from "../../backend/src/http/request.js";
import { socketFetch, PRODUCTION_AI_SOCKET } from "../../shared/aiPlatformSocketTransport.mjs";

const CLEAN_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
export function runCommand(command, args, { timeout = 30_000, env = {}, input, uid, gid } = {}) {
  return execFileSync(command, args, {
    encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...CLEAN_ENV, ...env }, input, uid, gid, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}
export function assertHost(manifest) {
  if (process.getuid?.() !== 0 || process.platform !== "linux" || Number(process.versions.node.split(".")[0]) < 24) throw new Error("production transition requires Linux root and Node 24");
  if (hostname() !== manifest.hostname || readFileSync("/etc/machine-id", "utf8").trim() !== manifest.machineId) throw new Error("production host identity mismatch");
}
export function privateFile(path, expectedSha, { ownerUid = 0, maxBytes = 256 * 1024 * 1024, requirePrivate = true } = {}) {
  if (lstatSync(path).size > maxBytes) throw new Error("protected file exceeds limit");
  const result = readStableRegularFile(path, {
    label: "protected deployment file",
    validate({ metadata, realPath }) {
      if (realPath !== path || metadata.uid !== BigInt(ownerUid) || (metadata.mode & (requirePrivate ? 0o077n : 0o022n)) !== 0n) throw new Error("unsafe protected deployment file");
    },
  });
  if (expectedSha && result.sha256 !== expectedSha) throw new Error("protected file digest mismatch");
  return result;
}
export function privateDirectory(path, { ownerUid = 0 } = {}) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path
    || info.uid !== ownerUid || (info.mode & 0o077) !== 0) throw new Error("unsafe private deployment directory");
}
export function writeExclusive(path, content) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  return hashBytes(Buffer.isBuffer(content) ? content : Buffer.from(content));
}

export function writeOnceOrVerify(path, content, { expectedSha = null, ...fileOptions } = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const digest = hashBytes(bytes);
  if (existsSync(path)) {
    const existing = privateFile(path, null, fileOptions);
    if (existing.sha256 !== digest && (!expectedSha || existing.sha256 !== expectedSha)) {
      throw new Error("protected file already exists with a different digest");
    }
    return existing.sha256;
  }
  return writeExclusive(path, bytes);
}

export function replacePrivateJson(path, value, expectedSha = null) {
  const content = JSON.stringify(value, null, 2) + "\n";
  if (!existsSync(path)) return writeExclusive(path, content);
  const current = privateFile(path);
  if (expectedSha && current.sha256 !== expectedSha) throw new Error("private state digest changed");
  atomicReplace(path, content, current.sha256);
  return hashBytes(content);
}
export function atomicReplace(path, content, expectedSha, fileOptions = {}) {
  if (existsSync(path) && !expectedSha) throw new Error("existing destination requires an expected digest");
  if (expectedSha) privateFile(path, expectedSha, fileOptions);
  const temporary = path + ".transition-" + randomUUID();
  writeExclusive(temporary, content);
  renameSync(temporary, path);
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function parseEnvironment(path) {
  return parseEnv(privateFile(path, null, { maxBytes: 128 * 1024 }).content.toString("utf8"));
}
export function inspectUnit(unit) {
  const fields = ["Id", "ActiveState", "SubState", "MainPID", "User", "Group", "ExecStart", "WorkingDirectory", "FragmentPath", "EnvironmentFiles", "TimeoutStopUSec"];
  const output = runCommand("/bin/systemctl", ["show", unit, ...fields.flatMap((field) => ["-p", field])]);
  const result = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}
export async function backupSqlite(path, destination) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || realpathSync(path) !== path) throw new Error("database identity is unsafe");
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    if (source.prepare("PRAGMA quick_check").get().quick_check !== "ok" || source.prepare("PRAGMA foreign_key_check").all().length) throw new Error("database integrity failed");
    source.exec("PRAGMA busy_timeout = 5000");
    writeExclusive(destination, "");
    // VACUUM INTO produces a standalone DELETE-journal snapshot. The online
    // backup API can preserve WAL sidecars at the destination, which makes
    // the snapshot unsuitable for the fail-closed production preflight.
    source.prepare("VACUUM INTO ?").run(destination);
  } finally { source.close(); }
  const check = new DatabaseSync(destination, { readOnly: true });
  try {
    if (check.prepare("PRAGMA quick_check").get().quick_check !== "ok" || check.prepare("PRAGMA foreign_key_check").all().length) throw new Error("backup integrity failed");
  } finally { check.close(); }
  return { path: destination, sha256: hashBytes(readFileSync(destination)) };
}
export async function platformRequest(path, { method = "GET", body = undefined, timeout = 200_000 } = {}) {
  if (!/^\/(?:operations(?:\/(?:drain|resume|policy|policy-preview))?)$/u.test(path)) throw new Error("unsupported deployment API operation");
  const retryableRead = method === "GET" && path === "/operations";
  const maxAttempts = retryableRead ? 3 : 1;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const env = parseEnvironment(PLATFORM_ENV);
      const target = "/internal/ai/v1" + path;
      const payload = body === undefined ? "" : JSON.stringify(body);
      const token = createServiceToken({
        secret: env.AI_PLATFORM_AUTH_SECRET,
        issuer: env.AI_PLATFORM_TRUSTED_ISSUER ?? "sentelligent-sales-backend",
        subject: "production-transition", owner: "production-transition", actor: "production-transition",
        scopes: ["ai:ops:read", "ai:ops:write"], ttlSeconds: 300,
        requestBinding: createRequestBinding({ method, path: target, body: payload }),
      });
      const response = await socketFetch(PRODUCTION_AI_SOCKET)("http://127.0.0.1:18997" + target, {
        method, signal: AbortSignal.timeout(timeout), redirect: "error",
        headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: payload }),
      });
      if (!response.ok) {
        await response.body?.cancel?.();
        throw Object.assign(new Error("platform operation failed"), { code: "PLATFORM_OPERATION_FAILED" });
      }
      const text = await readBoundedResponseText(response, { maxBytes: 1024 * 1024 });
      return JSON.parse(text).item;
    } catch (error) {
      lastError = error;
      const retryableCode = ["EPIPE", "ECONNRESET", "ECONNREFUSED", "UND_ERR_SOCKET"].includes(error?.code);
      if (!retryableRead || !retryableCode || attempt + 1 >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}
