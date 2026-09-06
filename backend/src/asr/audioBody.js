import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline as nodePipeline } from "node:stream/promises";

import { ASR_LIMITS, AsrContractError } from "./contracts.js";

const REQUEST_DIRECTORY_PATTERN = /^request-[A-Za-z0-9_-]{6,128}$/u;
export const ASR_SWEEP_RESIDUAL_PATHS = Symbol("asr.sweepResidualPaths");

function contractError(code, status, message) {
  return new AsrContractError(code, status, message);
}

function currentUidValue(value = process.getuid?.()) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("current uid must be a non-negative safe integer");
  }
  return value;
}

function modeBits(stat) {
  return stat.mode & 0o777;
}

function assertProtectedDirectory(stat, uid, label) {
  if (
    !stat
    || typeof stat.isDirectory !== "function"
    || !stat.isDirectory()
    || stat.isSymbolicLink?.()
    || stat.uid !== uid
    || modeBits(stat) !== 0o700
  ) {
    throw contractError("ASR_NOT_CONFIGURED", 503, `${label} is not protected`);
  }
  return stat;
}

export function assertProtectedRegularFile(stat, uid, label = "ASR temporary file") {
  if (
    !stat
    || typeof stat.isFile !== "function"
    || !stat.isFile()
    || stat.isSymbolicLink?.()
    || stat.uid !== uid
    || modeBits(stat) !== 0o600
    || stat.nlink !== 1
  ) {
    throw contractError("ASR_NOT_CONFIGURED", 503, `${label} is not protected`);
  }
  return stat;
}

function safeInteger(value, name, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name} must be a safe integer at least ${min}`);
  }
  return value;
}

export function createUploadCapacity({
  activeUploadsMax = ASR_LIMITS.activeUploadsMax,
  aggregateTempMaxBytes = ASR_LIMITS.aggregateTempMaxBytes,
  onActiveUploadsChange = () => {},
  onTempBytesChange = () => {},
} = {}) {
  safeInteger(activeUploadsMax, "activeUploadsMax", { min: 1 });
  safeInteger(aggregateTempMaxBytes, "aggregateTempMaxBytes", { min: 1 });
  if (typeof onActiveUploadsChange !== "function" || typeof onTempBytesChange !== "function") {
    throw new TypeError("capacity callbacks must be functions");
  }
  let activeUploads = 0;
  let tempBytes = 0;

  function capacityExceeded() {
    throw contractError("ASR_CAPACITY_EXCEEDED", 429, "ASR upload capacity is exhausted");
  }

  function adjustTemp(delta) {
    const next = tempBytes + delta;
    if (!Number.isSafeInteger(next) || next < 0 || next > aggregateTempMaxBytes) {
      capacityExceeded();
    }
    tempBytes = next;
    onTempBytesChange(delta);
  }

  return Object.freeze({
    acquire(contentLength = null) {
      if (contentLength !== null) safeInteger(contentLength, "contentLength", { min: 1 });
      if (activeUploads >= activeUploadsMax) capacityExceeded();
      const initialBytes = contentLength ?? 0;
      if (tempBytes + initialBytes > aggregateTempMaxBytes) capacityExceeded();
      activeUploads += 1;
      onActiveUploadsChange(1);
      if (initialBytes > 0) adjustTemp(initialBytes);

      let active = true;
      let retained = initialBytes;
      let received = 0;
      let released = false;

      function endActive() {
        if (!active) return;
        active = false;
        activeUploads -= 1;
        onActiveUploadsChange(-1);
      }

      function releaseRetained() {
        if (retained > 0) {
          adjustTemp(-retained);
          retained = 0;
        }
      }

      return Object.freeze({
        reserveChunk(byteLength) {
          if (!active) throw new Error("upload reservation is no longer active");
          safeInteger(byteLength, "chunk byteLength", { min: 1 });
          const nextReceived = received + byteLength;
          if (!Number.isSafeInteger(nextReceived)) capacityExceeded();
          if (nextReceived > retained) {
            adjustTemp(nextReceived - retained);
            retained = nextReceived;
          }
          received = nextReceived;
          return received;
        },
        finishUpload(actualBytes) {
          if (!active) throw new Error("upload reservation is no longer active");
          safeInteger(actualBytes, "actualBytes");
          if (actualBytes !== received) throw new Error("upload byte accounting mismatch");
          if (retained > actualBytes) {
            adjustTemp(actualBytes - retained);
            retained = actualBytes;
          }
          endActive();
          return retained;
        },
        abort() {
          if (released) return;
          endActive();
          releaseRetained();
          released = true;
        },
        releaseTemp() {
          if (released) return;
          if (active) throw new Error("cannot release temporary bytes while upload is active");
          releaseRetained();
          released = true;
        },
        snapshot() {
          return Object.freeze({ active, retained, received, released });
        },
      });
    },
    snapshot() {
      return Object.freeze({
        activeUploads,
        tempBytes,
        activeUploadsMax,
        aggregateTempMaxBytes,
      });
    },
  });
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function createOperationGuard(signal) {
  let rejectGuard;
  const guard = new Promise((_, reject) => {
    rejectGuard = reject;
  });
  guard.catch(() => {
    // A deadline may fire before the first I/O promise is returned.
  });
  const onAbort = () => rejectGuard(abortError(signal));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return Object.freeze({
    race(promise) {
      return Promise.race([Promise.resolve(promise), guard]);
    },
    cleanup() {
      signal.removeEventListener("abort", onAbort);
    },
  });
}

function settleWithin(promise, timeoutMs, setTimeoutImpl, clearTimeoutImpl) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      resolve(value);
    };
    const timer = setTimeoutImpl(() => finish(false), timeoutMs);
    Promise.resolve(promise).then(() => finish(true), () => finish(false));
  });
}

function beginFileHandleClose(fileHandle) {
  return Promise.resolve().then(() => fileHandle.close());
}

function closeLateFileHandle(openPromise) {
  return Promise.resolve(openPromise).then((lateHandle) => {
    if (!lateHandle || typeof lateHandle.close !== "function") {
      throw new TypeError("late ASR upload file handle is invalid");
    }
    return beginFileHandleClose(lateHandle);
  }, () => {
    // A rejected open cannot materialize a file handle that still needs closing.
  });
}

async function detachFileWriteStream(stream) {
  if (!stream) return;
  if (stream.closed) return;
  await new Promise((resolve) => {
    stream.once("close", resolve);
    stream.destroy();
  });
}

export async function writeAudioBody({
  readable,
  outputPath,
  reservation,
  signal,
  maxBytes = ASR_LIMITS.uploadMaxBytes,
  magicMaxBytes = ASR_LIMITS.magicMaxBytes,
  wallTimeoutMs = ASR_LIMITS.uploadWallTimeoutMs,
  idleTimeoutMs = ASR_LIMITS.uploadIdleTimeoutMs,
  cleanupTimeoutMs = ASR_LIMITS.childKillGraceMs,
  currentUid = process.getuid?.(),
  openFile = fsPromises.open,
  pipelineImpl = nodePipeline,
  onPipelineStart,
  onLateResourceLifecycle,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (!readable || typeof readable.pipe !== "function") throw new TypeError("readable body is required");
  if (typeof outputPath !== "string" || outputPath.length === 0 || outputPath.includes("\0")) {
    throw new TypeError("outputPath must be a server-generated path");
  }
  if (!reservation || typeof reservation.reserveChunk !== "function") {
    throw new TypeError("upload capacity reservation is required");
  }
  safeInteger(maxBytes, "maxBytes", { min: 1 });
  safeInteger(magicMaxBytes, "magicMaxBytes", { min: 1 });
  safeInteger(wallTimeoutMs, "wallTimeoutMs", { min: 1 });
  safeInteger(idleTimeoutMs, "idleTimeoutMs", { min: 1 });
  safeInteger(cleanupTimeoutMs, "cleanupTimeoutMs", { min: 1 });
  if (
    onPipelineStart !== undefined
    && typeof onPipelineStart !== "function"
  ) {
    throw new TypeError("onPipelineStart must be a function");
  }
  if (
    onLateResourceLifecycle !== undefined
    && typeof onLateResourceLifecycle !== "function"
  ) {
    throw new TypeError("onLateResourceLifecycle must be a function");
  }
  const uid = currentUidValue(currentUid);
  if (signal?.aborted) {
    reservation.abort();
    throw abortError(signal);
  }

  const controller = new AbortController();
  let abortKind = null;
  const onExternalAbort = () => {
    if (abortKind !== null) return;
    abortKind = "external";
    controller.abort(signal?.reason);
  };
  const onRequestAborted = () => {
    if (abortKind !== null) return;
    abortKind = "external";
    controller.abort(new DOMException("Client disconnected", "AbortError"));
  };
  if (signal?.aborted) onExternalAbort();
  else signal?.addEventListener("abort", onExternalAbort, { once: true });
  readable.once?.("aborted", onRequestAborted);

  let idleTimer = null;
  function armIdleTimer() {
    if (idleTimer !== null) clearTimeoutImpl(idleTimer);
    idleTimer = setTimeoutImpl(() => {
      if (controller.signal.aborted || abortKind !== null) return;
      abortKind = "timeout";
      controller.abort(new DOMException("ASR upload idle timeout", "TimeoutError"));
    }, idleTimeoutMs);
  }
  const wallTimer = setTimeoutImpl(() => {
    if (controller.signal.aborted || abortKind !== null) return;
    abortKind = "timeout";
    controller.abort(new DOMException("ASR upload wall timeout", "TimeoutError"));
  }, wallTimeoutMs);
  armIdleTimer();
  const operationGuard = createOperationGuard(controller.signal);

  const hash = createHash("sha256");
  const magic = Buffer.alloc(magicMaxBytes);
  let magicBytes = 0;
  let byteLength = 0;
  let fileHandle = null;
  let writeStream = null;
  let openPromise = null;
  let openAccepted = false;
  let detachPromise = null;
  let closePromise = null;
  let detachCompleted = false;
  let closeCompleted = false;
  let completed = false;
  const registeredResourceLifecycles = new Set();
  function registerResourceLifecycle(lifecycle) {
    if (registeredResourceLifecycles.has(lifecycle)) return true;
    registeredResourceLifecycles.add(lifecycle);
    Promise.resolve(lifecycle).catch(() => {
      // The bounded cleanup result and service ledger own the failure.
    });
    try {
      onLateResourceLifecycle?.(lifecycle);
      return true;
    } catch {
      return false;
    }
  }
  try {
    openPromise = Promise.resolve().then(() => openFile(outputPath, "wx", 0o600));
    fileHandle = await operationGuard.race(openPromise);
    openAccepted = true;
    assertProtectedRegularFile(
      await operationGuard.race(Promise.resolve().then(() => fileHandle.stat())),
      uid,
    );
    writeStream = fileHandle.createWriteStream({ autoClose: false });
    const boundedHashTransform = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          armIdleTimer();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const next = byteLength + bytes.byteLength;
          if (!Number.isSafeInteger(next) || next > maxBytes) {
            abortKind ??= "failure";
            callback(contractError("AUDIO_TOO_LARGE", 413, "Audio exceeds the upload limit"));
            return;
          }
          reservation.reserveChunk(bytes.byteLength);
          if (magicBytes < magic.length) {
            const copied = Math.min(bytes.byteLength, magic.length - magicBytes);
            bytes.copy(magic, magicBytes, 0, copied);
            magicBytes += copied;
          }
          hash.update(bytes);
          byteLength = next;
          callback(null, bytes);
        } catch (error) {
          abortKind ??= "failure";
          callback(error);
        }
      },
    });
    let pipelinePromise;
    try {
      pipelinePromise = pipelineImpl(
        readable,
        boundedHashTransform,
        writeStream,
        { signal: controller.signal },
      );
    } catch (error) {
      throw error;
    }
    if (!pipelinePromise || typeof pipelinePromise.then !== "function") {
      throw new TypeError("pipelineImpl must return a promise");
    }
    if (onPipelineStart?.() === false) {
      pipelinePromise.catch(() => {});
      throw new DOMException("ASR body handoff was cancelled", "AbortError");
    }
    await operationGuard.race(pipelinePromise);
    if (controller.signal.aborted) throw abortError(signal ?? controller.signal);
    if (byteLength === 0) {
      throw contractError("AUDIO_BODY_REQUIRED", 400, "Audio body is required");
    }
    await operationGuard.race(Promise.resolve().then(() => fileHandle.sync()));
    detachPromise = detachFileWriteStream(writeStream);
    await operationGuard.race(detachPromise);
    detachCompleted = true;
    closePromise = beginFileHandleClose(fileHandle);
    await operationGuard.race(closePromise);
    closeCompleted = true;
    fileHandle = null;
    if (controller.signal.aborted) throw abortError(signal ?? controller.signal);
    reservation.finishUpload(byteLength);
    completed = true;
    return Object.freeze({
      byteLength,
      sha256: hash.digest("hex"),
      magicBytes: Uint8Array.from(magic.subarray(0, magicBytes)),
    });
  } catch (error) {
    let cleanupVerified = true;
    if (!openAccepted && openPromise) {
      const lifecycle = closeLateFileHandle(openPromise);
      if (!registerResourceLifecycle(lifecycle)) cleanupVerified = false;
      if (!await settleWithin(
        lifecycle,
        cleanupTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      )) {
        cleanupVerified = false;
      }
    }
    if (writeStream && !detachCompleted) {
      detachPromise ??= detachFileWriteStream(writeStream);
      if (!registerResourceLifecycle(detachPromise)) cleanupVerified = false;
      if (!await settleWithin(
        detachPromise,
        cleanupTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      )) {
        cleanupVerified = false;
      }
    }
    if (fileHandle && !closeCompleted) {
      closePromise ??= beginFileHandleClose(fileHandle);
      if (!registerResourceLifecycle(closePromise)) cleanupVerified = false;
      if (!await settleWithin(
        closePromise,
        cleanupTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      )) {
        cleanupVerified = false;
      } else {
        fileHandle = null;
      }
    }
    reservation.abort();
    if (!cleanupVerified) {
      throw contractError("ASR_CLEANUP_FAILED", 503, "ASR upload resource cleanup failed");
    }
    if (error instanceof AsrContractError) throw error;
    if (abortKind === "external" || signal?.aborted) throw abortError(signal ?? controller.signal);
    if (abortKind === "timeout") {
      throw contractError("ASR_TIMEOUT", 504, "ASR upload timed out");
    }
    throw error;
  } finally {
    clearTimeoutImpl(wallTimer);
    if (idleTimer !== null) clearTimeoutImpl(idleTimer);
    signal?.removeEventListener("abort", onExternalAbort);
    readable.removeListener?.("aborted", onRequestAborted);
    operationGuard.cleanup();
    if (!completed && !writeStream?.destroyed) writeStream?.destroy();
  }
}

export async function prepareTempRoot(tempRoot, {
  fsImpl = fsPromises,
  currentUid = process.getuid?.(),
  createIfMissing = true,
} = {}) {
  if (typeof tempRoot !== "string" || tempRoot.length === 0 || tempRoot.includes("\0")) {
    throw new TypeError("tempRoot must be a bounded path");
  }
  const uid = currentUidValue(currentUid);
  try {
    await fsImpl.lstat(tempRoot);
  } catch (error) {
    if (error?.code !== "ENOENT" || !createIfMissing) throw error;
    await fsImpl.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    await fsImpl.chmod(tempRoot, 0o700);
  }
  return assertProtectedDirectory(await fsImpl.lstat(tempRoot), uid, "ASR temporary root");
}

export async function createWorkspace(tempRoot, {
  fsImpl = fsPromises,
  currentUid = process.getuid?.(),
  onWorkspaceCreated,
  cleanupOnFailure = true,
} = {}) {
  const uid = currentUidValue(currentUid);
  if (onWorkspaceCreated !== undefined && typeof onWorkspaceCreated !== "function") {
    throw new TypeError("onWorkspaceCreated must be a function");
  }
  if (typeof cleanupOnFailure !== "boolean") {
    throw new TypeError("cleanupOnFailure must be a boolean");
  }
  await prepareTempRoot(tempRoot, { fsImpl, currentUid: uid });
  let workspace = null;
  try {
    workspace = await fsImpl.mkdtemp(join(tempRoot, "request-"));
    onWorkspaceCreated?.(workspace);
    await fsImpl.chmod(workspace, 0o700);
    assertProtectedDirectory(await fsImpl.lstat(workspace), uid, "ASR request workspace");
    return workspace;
  } catch (error) {
    let cleanupVerified = workspace === null || cleanupOnFailure === false;
    if (workspace && cleanupOnFailure) {
      try {
        const stat = await fsImpl.lstat(workspace);
        if (stat.isDirectory() && !stat.isSymbolicLink?.() && stat.uid === uid) {
          await fsImpl.rm(workspace, { recursive: true, force: true });
          try {
            await fsImpl.lstat(workspace);
          } catch (verifyError) {
            if (verifyError?.code === "ENOENT") cleanupVerified = true;
            else throw verifyError;
          }
        }
      } catch (cleanupError) {
        if (cleanupError?.code === "ENOENT") cleanupVerified = true;
      }
    }
    if (!cleanupVerified) {
      throw contractError("ASR_CLEANUP_FAILED", 503, "ASR workspace setup cleanup failed");
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function removeWorkspaceAndVerify(workspace, {
  fsImpl = fsPromises,
  currentUid = process.getuid?.(),
  attempts = [0, 50, 200, 1_000],
  sleepImpl = sleep,
} = {}) {
  const uid = currentUidValue(currentUid);
  if (!Array.isArray(attempts) || attempts.length === 0) {
    throw new TypeError("cleanup attempts must be a non-empty array");
  }
  let lastError = null;
  for (const delay of attempts) {
    safeInteger(delay, "cleanup delay");
    if (delay > 0) await sleepImpl(delay);
    try {
      let before;
      try {
        before = await fsImpl.lstat(workspace);
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        throw error;
      }
      assertProtectedDirectory(before, uid, "ASR request workspace");
      await fsImpl.rm(workspace, { recursive: true, force: true });
      try {
        await fsImpl.lstat(workspace);
        throw new Error("ASR request workspace still exists after cleanup");
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        throw error;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("ASR request workspace cleanup failed");
}

export async function sweepTempRoot(tempRoot, {
  fsImpl = fsPromises,
  currentUid = process.getuid?.(),
  mode = "startup",
  now = Date.now,
  maxAgeMs = 600_000,
  cleanupOptions = {},
  createIfMissing = true,
} = {}) {
  if (!new Set(["startup", "periodic"]).has(mode)) {
    throw new TypeError("sweep mode must be startup or periodic");
  }
  const uid = currentUidValue(currentUid);
  await prepareTempRoot(tempRoot, { fsImpl, currentUid: uid, createIfMissing });
  const entries = await fsImpl.readdir(tempRoot, { withFileTypes: true });
  let removedCount = 0;
  let staleCount = 0;
  let anomalyCount = 0;
  const residualDirectoryPaths = new Set();
  const isRealDirectory = (stat) => (
    stat?.isDirectory?.() === true && stat?.isSymbolicLink?.() !== true
  );
  for (const entry of entries) {
    const candidate = join(tempRoot, entry.name);
    const direntConfirmsDirectory = entry?.isDirectory?.() === true
      && entry?.isSymbolicLink?.() !== true;
    if (!REQUEST_DIRECTORY_PATTERN.test(entry.name)) {
      anomalyCount += 1;
      try {
        if (isRealDirectory(await fsImpl.lstat(candidate))) residualDirectoryPaths.add(candidate);
      } catch {
        if (direntConfirmsDirectory) residualDirectoryPaths.add(candidate);
      }
      continue;
    }
    let stat;
    try {
      stat = await fsImpl.lstat(candidate);
      assertProtectedDirectory(stat, uid, "ASR stale request workspace");
    } catch {
      anomalyCount += 1;
      if (isRealDirectory(stat) || (!stat && direntConfirmsDirectory)) {
        residualDirectoryPaths.add(candidate);
      }
      continue;
    }
    const ageMs = now() - stat.mtimeMs;
    const shouldRemove = mode === "startup" || ageMs > maxAgeMs;
    if (!shouldRemove) continue;
    staleCount += 1;
    try {
      await removeWorkspaceAndVerify(candidate, {
        fsImpl,
        currentUid: uid,
        ...cleanupOptions,
      });
      removedCount += 1;
    } catch {
      anomalyCount += 1;
      try {
        if (isRealDirectory(await fsImpl.lstat(candidate))) residualDirectoryPaths.add(candidate);
      } catch {
        if (direntConfirmsDirectory) residualDirectoryPaths.add(candidate);
      }
    }
  }
  const result = {
    ready: anomalyCount === 0,
    removedCount,
    staleCount,
    anomalyCount,
    residualDirectoryCount: residualDirectoryPaths.size,
  };
  Object.defineProperty(result, ASR_SWEEP_RESIDUAL_PATHS, {
    value: Object.freeze([...residualDirectoryPaths]),
    enumerable: false,
  });
  return Object.freeze(result);
}
