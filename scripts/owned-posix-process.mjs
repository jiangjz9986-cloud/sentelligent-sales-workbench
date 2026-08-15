import { readFile, readlink } from "node:fs/promises";
import { basename, resolve } from "node:path";

const ownedPosixChildren = new WeakMap();

function executableName(value) {
  return basename(String(value ?? "").trim());
}

function isProcessGone(error) {
  return error?.code === "ENOENT" || error?.code === "ESRCH";
}

function isOrderedSubsequence(expected, actual) {
  let cursor = 0;
  return expected.every((token) => {
    const index = actual.indexOf(String(token), cursor);
    if (index < 0) return false;
    cursor = index + 1;
    return true;
  });
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

function waitForChildClose(child, timeoutMs) {
  const record = ownedPosixChildren.get(child);
  if (record?.closed) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolveWait(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    if (record?.closed) finish(true);
  });
}

function destroyOwnedChildIo(child) {
  const failures = [];
  for (const [label, stream] of [["stdout", child?.stdout], ["stderr", child?.stderr]]) {
    try {
      stream?.destroy?.();
    } catch (error) {
      failures.push(`${label} destroy: ${error?.message ?? "failed"}`);
    }
  }
  return failures;
}

export function registerOwnedPosixChildProcess(child, {
  detached,
  pgid,
  cwd,
  executable,
  commandTokens,
} = {}) {
  const pid = Number(child?.pid);
  const resolvedCwd = typeof cwd === "string" ? resolve(cwd) : "";
  const valid = Number.isSafeInteger(pid) && pid > 0
    && typeof child?.once === "function"
    && detached === true
    && pgid === pid
    && cwd === resolvedCwd && resolvedCwd.length > 0
    && typeof executable === "string" && executable.length > 0
    && Array.isArray(commandTokens) && commandTokens.length > 0
    && commandTokens.every((token) =>
      !/(?:password|secret|token|api[_-]?key|authorization)=/i.test(String(token)))
    && executableName(child?.spawnfile) === executableName(executable)
    && isOrderedSubsequence(commandTokens, child?.spawnargs ?? []);
  if (!valid) throw new TypeError("Owned POSIX child metadata is invalid");

  const record = {
    pid,
    pgid,
    detached: true,
    cwd: resolvedCwd,
    executable,
    commandTokens: Object.freeze(commandTokens.map(String)),
    exited: child.exitCode !== null || child.signalCode !== null,
    closed: false,
    stopOperation: null,
  };
  child.once("exit", () => {
    record.exited = true;
  });
  child.once("close", () => {
    record.exited = true;
    record.closed = true;
  });
  ownedPosixChildren.set(child, record);
  return child;
}

export async function stopOwnedPosixChildProcess(child, dependencies = {}) {
  const record = ownedPosixChildren.get(child);
  const pid = Number(child?.pid);
  if (!record) {
    return { status: "ownership_unverified", pid: Number.isSafeInteger(pid) ? pid : null };
  }
  if (record.stopOperation) return record.stopOperation;

  record.stopOperation = Promise.resolve().then(async () => {
    let result;
    try {
      if (pid !== record.pid || record.pgid !== record.pid || record.detached !== true) {
        result = { status: "ownership_unverified", pid: Number.isSafeInteger(pid) ? pid : null };
      } else if (record.closed) {
        const timeoutMs = dependencies.timeoutMs ?? 2_000;
        const waitForGroup = dependencies.waitForProcessGroupExit ?? waitForProcessGroupExit;
        const groupGone = await waitForGroup(record.pgid, timeoutMs);
        result = groupGone
          ? { status: "already_closed", pid }
          : { status: "termination_failed", pid, message: "Owned process group did not close" };
      } else if (record.exited || child.exitCode !== null || child.signalCode !== null) {
        const timeoutMs = dependencies.timeoutMs ?? 2_000;
        const waitForGroup = dependencies.waitForProcessGroupExit ?? waitForProcessGroupExit;
        const groupGone = await waitForGroup(record.pgid, timeoutMs);
        result = groupGone
          ? { status: "ownership_lost", pid }
          : { status: "termination_failed", pid, message: "Owned process group did not close" };
      } else {
        const timeoutMs = dependencies.timeoutMs ?? 2_000;
        const killProcess = dependencies.killProcess ?? process.kill;
        const waitForClose = dependencies.waitForChildClose ?? waitForChildClose;
        const waitForGroup = dependencies.waitForProcessGroupExit ?? waitForProcessGroupExit;
        let signaled = false;
        try {
          killProcess(-record.pgid, "SIGKILL");
          signaled = true;
        } catch (error) {
          if (!isProcessGone(error)) {
            result = { status: "termination_failed", pid, message: error.message };
          }
        }
        if (!result) {
          const closed = await waitForClose(child, timeoutMs);
          const groupGone = closed && await waitForGroup(record.pgid, timeoutMs);
          result = closed && groupGone
            ? { status: signaled ? "terminated" : "already_closed", pid }
            : { status: "termination_failed", pid, message: "Owned process group did not close" };
        }
      }
    } catch (error) {
      result = { status: "termination_failed", pid, message: error.message };
    }

    const ioFailures = destroyOwnedChildIo(child);
    if (ioFailures.length > 0) {
      return {
        status: "termination_failed",
        pid: Number.isSafeInteger(pid) ? pid : record.pid,
        message: [result?.message, ...ioFailures].filter(Boolean).join("; "),
      };
    }
    return result;
  });
  return record.stopOperation;
}

export async function stopOwnedPosixProcess(runtimeProcess, dependencies = {}) {
  const pid = Number(runtimeProcess?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: "not_running", pid: runtimeProcess?.pid ?? null };
  }
  if (!runtimeProcess?.fingerprint) return { status: "ownership_unverified", pid };

  const platform = dependencies.platform ?? process.platform;
  if (platform !== "linux" && (dependencies.platform !== undefined || dependencies.inspectProcess === undefined)) {
    return { status: "inspection_unsupported", pid };
  }

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
