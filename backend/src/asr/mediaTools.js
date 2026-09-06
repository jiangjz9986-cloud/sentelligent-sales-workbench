import { spawn as nodeSpawn } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline as nodePipeline } from "node:stream/promises";

import { assertProtectedRegularFile } from "./audioBody.js";
import { validateAudioProbe } from "./audioValidation.js";
import {
  ASR_LIMITS,
  AsrContractError,
  durationLimitForPurpose,
  parseAsrPurpose,
} from "./contracts.js";

const WAV_HEADER_BYTES = 44;
const PCM_BYTES_PER_SECOND = 32_000;

function contractError(code, status, message) {
  return new AsrContractError(code, status, message);
}

function transcodeError() {
  return contractError("ASR_TRANSCODE_FAILED", 500, "ASR audio normalization failed");
}

function invalidAudio() {
  return contractError("AUDIO_INVALID", 422, "Audio metadata is invalid");
}

function mediaChildCleanupError() {
  return contractError("ASR_CLEANUP_FAILED", 503, "ASR media child termination failed");
}

function safeInteger(value, name, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name} must be a safe integer at least ${min}`);
  }
  return value;
}

function currentUidValue(value = process.getuid?.()) {
  return safeInteger(value, "current uid");
}

function delay(ms, setTimeoutImpl = globalThis.setTimeout) {
  return new Promise((resolve) => setTimeoutImpl(resolve, ms));
}

function childHasExited(child) {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}

function childExitPromise(child) {
  if (childHasExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal });
    };
    const fail = (sourceError) => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error("ASR media child process failed");
      error.code = sourceError?.code ?? "ASR_CHILD_PROCESS_ERROR";
      reject(error);
    };
    const cleanup = () => {
      child.removeListener?.("exit", finish);
      child.removeListener?.("close", finish);
      child.removeListener?.("error", fail);
    };
    child.once("exit", finish);
    child.once("close", finish);
    child.once("error", fail);
  });
}

function waitForChildExit(child, timeoutMs, setTimeoutImpl) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener?.("exit", onExit);
      child.removeListener?.("close", onExit);
      child.removeListener?.("error", onError);
    };
    const onExit = () => finish(true);
    const onError = () => finish(childHasExited(child));
    child.once?.("exit", onExit);
    child.once?.("close", onExit);
    child.once?.("error", onError);
    const timer = setTimeoutImpl(() => finish(childHasExited(child)), timeoutMs);
  });
}

export async function terminateMediaChild(child, {
  graceMs = ASR_LIMITS.childKillGraceMs,
  setTimeoutImpl = globalThis.setTimeout,
} = {}) {
  if (!child || typeof child.kill !== "function" || childHasExited(child)) return true;
  try {
    child.kill("SIGTERM");
  } catch {
    // Continue to bounded release; the fixed error mapping remains authoritative.
  }
  const exited = await waitForChildExit(child, graceMs, setTimeoutImpl);
  if (!exited && !childHasExited(child)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The caller still closes streams/fds and the service cleanup gate runs.
    }
    return waitForChildExit(child, graceMs, setTimeoutImpl);
  }
  return true;
}

async function collectBoundedText(stream, maxBytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";
  try {
    for await (const value of stream) {
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        const error = new Error("ASR media tool output exceeded its limit");
        error.code = "ASR_TOOL_OUTPUT_LIMIT";
        throw error;
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return { text, byteLength };
  } catch (error) {
    if (error?.code === "ASR_TOOL_OUTPUT_LIMIT") throw error;
    const wrapped = new Error("ASR media tool output was invalid");
    wrapped.code = "ASR_TOOL_OUTPUT_INVALID";
    throw wrapped;
  }
}

function createOperationGuard({ signal, timeoutMs, setTimeoutImpl, clearTimeoutImpl }) {
  let timedOut = false;
  let rejectGuard;
  const guard = new Promise((_, reject) => {
    rejectGuard = reject;
  });
  guard.catch(() => {
    // The real race observes the same rejection; this prevents a deadline that
    // fires during pre-spawn fd setup from becoming a transient unhandled one.
  });
  const onAbort = () => rejectGuard(signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeoutImpl(() => {
    timedOut = true;
    rejectGuard(new DOMException("ASR media operation timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    guard,
    timedOut: () => timedOut,
    race(promise) {
      return Promise.race([Promise.resolve(promise), guard]);
    },
    cleanup() {
      clearTimeoutImpl(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
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
      throw new TypeError("late ASR media file handle is invalid");
    }
    return beginFileHandleClose(lateHandle);
  }, () => {
    // A rejected open cannot materialize a file handle that still needs closing.
  });
}

function registerResourceLifecycle(lifecycle, onLateResourceLifecycle, registry) {
  if (registry.has(lifecycle)) return true;
  registry.add(lifecycle);
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

export function ffprobeArguments(inputPath) {
  return Object.freeze([
    "-v", "error",
    "-show_entries", "format=duration,format_name",
    "-show_entries", "stream=index,codec_type,codec_name,channels,sample_rate",
    "-of", "json",
    inputPath,
  ]);
}

export function ffmpegArguments(inputPath) {
  return Object.freeze([
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    "-f", "s16le",
    "pipe:1",
  ]);
}

export async function probeAudio({
  inputPath,
  mediaType,
  purpose,
  effectiveMaxDurationMs,
  ffprobeCommand = "/usr/bin/ffprobe",
  signal,
  spawnImpl = nodeSpawn,
  timeoutMs = ASR_LIMITS.probeTimeoutMs,
  outputMaxBytes = ASR_LIMITS.probeOutputMaxBytes,
  childKillGraceMs = ASR_LIMITS.childKillGraceMs,
  onChildSpawn,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  parseAsrPurpose(purpose);
  if (typeof inputPath !== "string" || inputPath.length === 0) throw new TypeError("inputPath is required");
  if (typeof ffprobeCommand !== "string" || ffprobeCommand.length === 0) {
    throw new TypeError("ffprobeCommand is required");
  }
  safeInteger(timeoutMs, "probe timeout", { min: 1 });
  safeInteger(outputMaxBytes, "probe output limit", { min: 1 });
  safeInteger(childKillGraceMs, "child kill grace", { min: 1 });
  if (onChildSpawn !== undefined && typeof onChildSpawn !== "function") {
    throw new TypeError("onChildSpawn must be a function");
  }
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
  let child;
  let childTerminationHandled = false;
  try {
    child = spawnImpl(ffprobeCommand, [...ffprobeArguments(inputPath)], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw contractError("ASR_NOT_CONFIGURED", 503, "ASR media tools are unavailable");
  }
  try {
    onChildSpawn?.(child);
  } catch {
    const childTerminationVerified = await terminateMediaChild(child, {
      graceMs: childKillGraceMs,
      setTimeoutImpl,
    });
    child.stdout?.destroy?.();
    child.stderr?.destroy?.();
    childTerminationHandled = true;
    if (!childTerminationVerified) throw mediaChildCleanupError();
    throw contractError("ASR_NOT_CONFIGURED", 503, "ASR media child tracking is unavailable");
  }
  const guard = createOperationGuard({
    signal,
    timeoutMs,
    setTimeoutImpl,
    clearTimeoutImpl,
  });
  try {
    const operation = Promise.all([
      childExitPromise(child),
      collectBoundedText(child.stdout, outputMaxBytes),
      collectBoundedText(child.stderr, outputMaxBytes),
    ]);
    const [exit, stdout] = await Promise.race([operation, guard.guard]);
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    if (exit.code !== 0 || exit.signal) throw invalidAudio();
    let probe;
    try {
      probe = JSON.parse(stdout.text);
    } catch {
      throw invalidAudio();
    }
    return validateAudioProbe(probe, {
      mediaType,
      purpose,
      effectiveMaxDurationMs,
    });
  } catch (error) {
    const childTerminationVerified = childTerminationHandled || await terminateMediaChild(child, {
      graceMs: childKillGraceMs,
      setTimeoutImpl,
    });
    child.stdout?.destroy?.();
    child.stderr?.destroy?.();
    if (!childTerminationVerified) throw mediaChildCleanupError();
    if (error instanceof AsrContractError) throw error;
    if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) {
      throw contractError("ASR_NOT_CONFIGURED", 503, "ASR media tools are unavailable");
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    throw invalidAudio();
  } finally {
    guard.cleanup();
  }
}

export function createCanonicalWavHeader(pcmBytes = 0) {
  safeInteger(pcmBytes, "pcmBytes");
  if (pcmBytes > 0xffffffff - 36) throw new RangeError("pcmBytes exceeds WAV limits");
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

export function createCanonicalWavPlaceholder() {
  const header = createCanonicalWavHeader(0);
  header.writeUInt32LE(0, 4);
  return header;
}

export function validateCanonicalWavHeader(header, pcmBytes) {
  if (!(header instanceof Uint8Array) || header.byteLength !== WAV_HEADER_BYTES) return false;
  const value = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
  return value.toString("ascii", 0, 4) === "RIFF"
    && value.readUInt32LE(4) === 36 + pcmBytes
    && value.toString("ascii", 8, 12) === "WAVE"
    && value.toString("ascii", 12, 16) === "fmt "
    && value.readUInt32LE(16) === 16
    && value.readUInt16LE(20) === 1
    && value.readUInt16LE(22) === 1
    && value.readUInt32LE(24) === 16_000
    && value.readUInt32LE(28) === PCM_BYTES_PER_SECOND
    && value.readUInt16LE(32) === 2
    && value.readUInt16LE(34) === 16
    && value.toString("ascii", 36, 40) === "data"
    && value.readUInt32LE(40) === pcmBytes;
}

async function writeExact(fileHandle, buffer, position, guard) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await guard.race(
      Promise.resolve().then(() => fileHandle.write(
        buffer,
        offset,
        buffer.byteLength - offset,
        position + offset,
      )),
    );
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw transcodeError();
    offset += bytesWritten;
  }
}

async function detachFileWriteStream(stream) {
  if (!stream || stream.closed) return;
  await new Promise((resolve) => {
    stream.once("close", resolve);
    stream.destroy();
  });
}

async function readExactHeader(outputPath, fsImpl, {
  guard,
  cleanupTimeoutMs,
  onLateResourceLifecycle,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  let handle = null;
  let openPromise = null;
  let openAccepted = false;
  let closePromise = null;
  const registeredResourceLifecycles = new Set();
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  try {
    openPromise = Promise.resolve().then(() => fsImpl.open(outputPath, "r"));
    handle = await guard.race(openPromise);
    openAccepted = true;
    let offset = 0;
    while (offset < header.length) {
      const { bytesRead } = await guard.race(
        Promise.resolve().then(() => handle.read(
          header,
          offset,
          header.length - offset,
          offset,
        )),
      );
      if (bytesRead <= 0) throw transcodeError();
      offset += bytesRead;
    }
    closePromise = beginFileHandleClose(handle);
    await guard.race(closePromise);
    handle = null;
    return header;
  } catch (error) {
    let cleanupVerified = true;
    if (!openAccepted && openPromise) {
      const lifecycle = closeLateFileHandle(openPromise);
      if (!registerResourceLifecycle(
        lifecycle,
        onLateResourceLifecycle,
        registeredResourceLifecycles,
      )) cleanupVerified = false;
      if (!await settleWithin(
        lifecycle,
        cleanupTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      )) {
        cleanupVerified = false;
      }
    }
    if (handle) {
      closePromise ??= beginFileHandleClose(handle);
      if (!registerResourceLifecycle(
        closePromise,
        onLateResourceLifecycle,
        registeredResourceLifecycles,
      )) cleanupVerified = false;
      if (!await settleWithin(
        closePromise,
        cleanupTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      )) cleanupVerified = false;
    }
    if (!cleanupVerified) throw mediaChildCleanupError();
    throw error;
  }
}

export async function transcodeToCanonicalWav({
  inputPath,
  outputPath,
  purpose,
  originalDurationMs,
  effectiveMaxDurationMs = durationLimitForPurpose(purpose),
  ffmpegCommand = "/usr/bin/ffmpeg",
  signal,
  spawnImpl = nodeSpawn,
  fsImpl = fsPromises,
  pipelineImpl = nodePipeline,
  currentUid = process.getuid?.(),
  timeoutMs = ASR_LIMITS.transcodeTimeoutMs,
  pcmMaxBytes = ASR_LIMITS.normalizedPcmMaxBytes,
  stderrMaxBytes = ASR_LIMITS.probeOutputMaxBytes,
  childKillGraceMs = ASR_LIMITS.childKillGraceMs,
  cleanupTimeoutMs = ASR_LIMITS.childKillGraceMs,
  onChildSpawn,
  onLateResourceLifecycle,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  const normalizedPurpose = parseAsrPurpose(purpose);
  if (typeof inputPath !== "string" || !inputPath) throw new TypeError("inputPath is required");
  if (typeof outputPath !== "string" || !outputPath) throw new TypeError("outputPath is required");
  if (typeof ffmpegCommand !== "string" || !ffmpegCommand) throw new TypeError("ffmpegCommand is required");
  if (typeof originalDurationMs !== "number" || !Number.isFinite(originalDurationMs) || originalDurationMs <= 0) {
    throw new TypeError("originalDurationMs must be a positive finite number");
  }
  safeInteger(effectiveMaxDurationMs, "effectiveMaxDurationMs", { min: ASR_LIMITS.minDurationMs });
  safeInteger(timeoutMs, "transcode timeout", { min: 1 });
  safeInteger(pcmMaxBytes, "PCM limit", { min: 1 });
  safeInteger(childKillGraceMs, "child kill grace", { min: 1 });
  safeInteger(cleanupTimeoutMs, "cleanup timeout", { min: 1 });
  if (onChildSpawn !== undefined && typeof onChildSpawn !== "function") {
    throw new TypeError("onChildSpawn must be a function");
  }
  if (
    onLateResourceLifecycle !== undefined
    && typeof onLateResourceLifecycle !== "function"
  ) {
    throw new TypeError("onLateResourceLifecycle must be a function");
  }
  const uid = currentUidValue(currentUid);
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
  let fileHandle = null;
  let writeStream = null;
  let child = null;
  let childTerminationHandled = false;
  let initialStat = null;
  let pcmBytes = 0;
  let spawnFailed = false;
  let openPromise = null;
  let openAccepted = false;
  let detachPromise = null;
  let closePromise = null;
  let detachCompleted = false;
  let closeCompleted = false;
  const registeredResourceLifecycles = new Set();
  const guard = createOperationGuard({
    signal,
    timeoutMs,
    setTimeoutImpl,
    clearTimeoutImpl,
  });

  try {
    openPromise = Promise.resolve().then(() => fsImpl.open(outputPath, "wx", 0o600));
    fileHandle = await guard.race(openPromise);
    openAccepted = true;
    initialStat = await guard.race(Promise.resolve().then(() => fileHandle.stat()));
    try {
      assertProtectedRegularFile(initialStat, uid, "ASR normalized WAV");
    } catch {
      throw transcodeError();
    }
    await writeExact(fileHandle, createCanonicalWavPlaceholder(), 0, guard);
    try {
      child = spawnImpl(ffmpegCommand, [...ffmpegArguments(inputPath)], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      spawnFailed = true;
      throw contractError("ASR_NOT_CONFIGURED", 503, "ASR media tools are unavailable");
    }
    try {
      onChildSpawn?.(child);
    } catch {
      const childTerminationVerified = await terminateMediaChild(child, {
        graceMs: childKillGraceMs,
        setTimeoutImpl,
      });
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      childTerminationHandled = true;
      if (!childTerminationVerified) throw mediaChildCleanupError();
      throw contractError("ASR_NOT_CONFIGURED", 503, "ASR media child tracking is unavailable");
    }

    const boundedPcm = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const next = pcmBytes + bytes.byteLength;
        if (!Number.isSafeInteger(next) || next > pcmMaxBytes) {
          callback(transcodeError());
          return;
        }
        pcmBytes = next;
        callback(null, bytes);
      },
    });
    writeStream = fileHandle.createWriteStream({ start: WAV_HEADER_BYTES, autoClose: false });
    const operation = Promise.all([
      childExitPromise(child),
      pipelineImpl(child.stdout, boundedPcm, writeStream),
      collectBoundedText(child.stderr, stderrMaxBytes),
    ]);
    const [exit] = await guard.race(operation);
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    if (exit.code !== 0 || exit.signal || pcmBytes === 0 || pcmBytes % 2 !== 0) {
      throw transcodeError();
    }
    const durationMs = pcmBytes / PCM_BYTES_PER_SECOND * 1_000;
    if (
      durationMs < ASR_LIMITS.minDurationMs
      || durationMs > effectiveMaxDurationMs
      || Math.abs(durationMs - originalDurationMs) > 500
    ) {
      throw transcodeError();
    }
    await writeExact(fileHandle, createCanonicalWavHeader(pcmBytes), 0, guard);
    await guard.race(Promise.resolve().then(() => fileHandle.sync()));
    detachPromise = detachFileWriteStream(writeStream);
    await guard.race(detachPromise);
    detachCompleted = true;
    closePromise = beginFileHandleClose(fileHandle);
    await guard.race(closePromise);
    closeCompleted = true;
    fileHandle = null;

    const finalStat = await guard.race(Promise.resolve().then(() => fsImpl.lstat(outputPath)));
    try {
      assertProtectedRegularFile(finalStat, uid, "ASR normalized WAV");
    } catch {
      throw transcodeError();
    }
    if (
      finalStat.dev !== initialStat.dev
      || finalStat.ino !== initialStat.ino
      || finalStat.size !== WAV_HEADER_BYTES + pcmBytes
    ) {
      throw transcodeError();
    }
    const header = await readExactHeader(outputPath, fsImpl, {
      guard,
      cleanupTimeoutMs,
      onLateResourceLifecycle,
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    if (!validateCanonicalWavHeader(header, pcmBytes)) throw transcodeError();
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    if (guard.timedOut()) {
      throw contractError("ASR_TIMEOUT", 504, "ASR audio normalization timed out");
    }
    return Object.freeze({
      outputPath,
      pcmBytes,
      durationMs: Math.round(durationMs),
      byteLength: WAV_HEADER_BYTES + pcmBytes,
    });
  } catch (error) {
    let childTerminationVerified = true;
    let fileCleanupVerified = true;
    if (child) {
      childTerminationVerified = childTerminationHandled || await terminateMediaChild(child, {
        graceMs: childKillGraceMs,
        setTimeoutImpl,
      });
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
    }
    if (!openAccepted && openPromise) {
      const lifecycle = closeLateFileHandle(openPromise);
      if (!registerResourceLifecycle(
        lifecycle,
        onLateResourceLifecycle,
        registeredResourceLifecycles,
      )) fileCleanupVerified = false;
      if (!await settleWithin(
        lifecycle,
        cleanupTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      )) {
        fileCleanupVerified = false;
      }
    }
    if (writeStream && !detachCompleted) {
      detachPromise ??= detachFileWriteStream(writeStream);
      if (!registerResourceLifecycle(
        detachPromise,
        onLateResourceLifecycle,
        registeredResourceLifecycles,
      )) fileCleanupVerified = false;
      if (!await settleWithin(
        detachPromise,
        cleanupTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      )) {
        fileCleanupVerified = false;
      }
    }
    if (fileHandle && !closeCompleted) {
      closePromise ??= beginFileHandleClose(fileHandle);
      if (!registerResourceLifecycle(
        closePromise,
        onLateResourceLifecycle,
        registeredResourceLifecycles,
      )) fileCleanupVerified = false;
      if (!await settleWithin(
        closePromise,
        cleanupTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      )) {
        fileCleanupVerified = false;
      } else {
        fileHandle = null;
      }
    }
    if (!childTerminationVerified || !fileCleanupVerified) throw mediaChildCleanupError();
    if (error instanceof AsrContractError) throw error;
    if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) {
      throw contractError("ASR_NOT_CONFIGURED", 503, "ASR media tools are unavailable");
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    if (guard.timedOut()) throw contractError("ASR_TIMEOUT", 504, "ASR audio normalization timed out");
    if (spawnFailed) throw contractError("ASR_NOT_CONFIGURED", 503, "ASR media tools are unavailable");
    throw transcodeError();
  } finally {
    guard.cleanup();
  }
}
