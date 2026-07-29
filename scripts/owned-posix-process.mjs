import { readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";

function executableName(value) {
  return basename(String(value ?? "").trim());
}

function isProcessGone(error) {
  return error?.code === "ENOENT" || error?.code === "ESRCH";
}

export function matchesPosixProcessFingerprint(processInfo, fingerprint) {
  if (
    !processInfo ||
    !fingerprint?.executable ||
    !fingerprint?.cwd ||
    !Array.isArray(fingerprint.commandTokens) ||
    fingerprint.commandTokens.length === 0 ||
    !Array.isArray(processInfo.commandTokens)
  ) {
    return false;
  }
  if (String(processInfo.cwd) !== String(fingerprint.cwd)) return false;

  if (!fingerprint.commandTokens.every((token) => processInfo.commandTokens.includes(String(token)))) {
    return false;
  }

  const executableMatches =
    executableName(processInfo.executable) === executableName(fingerprint.executable);
  if (executableMatches) return true;
  return fingerprint.allowExecutableWrapper === true && fingerprint.commandTokens.length >= 2;
}

async function inspectPosixProcess(pid) {
  try {
    const [executable, commandBuffer, cwd] = await Promise.all([
      readlink(`/proc/${pid}/exe`),
      readFile(`/proc/${pid}/cmdline`),
      readlink(`/proc/${pid}/cwd`),
    ]);
    const commandTokens = commandBuffer.toString("utf8").split("\0").filter(Boolean);
    return {
      executable,
      commandLine: commandTokens.join(" "),
      commandTokens,
      cwd,
    };
  } catch (error) {
    if (isProcessGone(error)) return null;
    throw error;
  }
}

async function terminateProcessGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isProcessGone(error)) throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (isProcessGone(error)) return true;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return false;
}

export async function stopOwnedPosixProcess(runtimeProcess, dependencies = {}) {
  const pid = Number(runtimeProcess?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: "not_running", pid: runtimeProcess?.pid ?? null };
  }
  if (!runtimeProcess?.fingerprint) return { status: "ownership_unverified", pid };

  const inspectProcess = dependencies.inspectProcess ?? inspectPosixProcess;
  const terminateGroup = dependencies.terminateProcessGroup ?? terminateProcessGroup;
  const waitForGroupExit = dependencies.waitForProcessGroupExit ?? waitForProcessGroupExit;

  let processInfo;
  try {
    processInfo = await inspectProcess(pid);
  } catch (error) {
    return { status: "inspection_failed", pid, message: error.message };
  }
  if (!processInfo) return { status: "not_running", pid };
  if (!matchesPosixProcessFingerprint(processInfo, runtimeProcess.fingerprint)) {
    return { status: "ownership_mismatch", pid };
  }

  try {
    await terminateGroup(pid);
    if (!(await waitForGroupExit(pid))) {
      throw new Error(`Process group ${pid} did not exit after verified termination`);
    }
    return { status: "terminated", pid };
  } catch (error) {
    return { status: "termination_failed", pid, message: error.message };
  }
}
