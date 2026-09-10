import * as fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  ASR_SWEEP_RESIDUAL_PATHS,
  createUploadCapacity,
  createWorkspace,
  removeWorkspaceAndVerify,
  sweepTempRoot,
  writeAudioBody,
} from "./audioBody.js";
import { assertAudioMagic } from "./audioValidation.js";
import {
  ASR_CONFIG_DEFAULTS,
  ASR_LIMITS,
  AsrContractError,
  canonicalizeAsrMediaType,
  normalizeAsrTranscript,
  parseAsrPurpose,
} from "./contracts.js";
import { createAsrFingerprint, createAsrIdempotencyCache } from "./idempotencyCache.js";
import {
  probeAudio,
  terminateMediaChild,
  transcodeToCanonicalWav,
} from "./mediaTools.js";
import { createAsrMetrics } from "./metrics.js";
import {
  ASR_PROVIDER_RESOURCE_LIFECYCLE,
  createOpenAiCompatibleProvider,
} from "./providers/openAiCompatible.js";

function contractError(code, status, message) {
  return new AsrContractError(code, status, message);
}

const AI_PLATFORM_MODES = new Set(["disabled", "optional", "required"]);
const AI_PLATFORM_PROVIDER_ID = "ai-platform";
const AI_PLATFORM_TASK_TYPE = "asr.transcribe";
const AI_PLATFORM_FEATURE = "asr";

function normalizeAiPlatformMode(value) {
  const mode = value === undefined || value === null || value === ""
    ? "disabled"
    : String(value).trim().toLowerCase();
  if (!AI_PLATFORM_MODES.has(mode)) throw new TypeError("AI platform mode is invalid");
  return mode;
}

function aiPlatformIsConfigured(aiPlatformRuntime) {
  if (!aiPlatformRuntime) return false;
  try {
    if (typeof aiPlatformRuntime.configured === "function") {
      return aiPlatformRuntime.configured() === true;
    }
    return aiPlatformRuntime.configured === true;
  } catch {
    return false;
  }
}

function aiPlatformState(mode, aiPlatformRuntime) {
  const configured = aiPlatformIsConfigured(aiPlatformRuntime);
  const selected = mode === "required" || (mode === "optional" && configured);
  return Object.freeze({
    mode,
    configured,
    selected,
    ready: !selected
      || (configured && typeof aiPlatformRuntime?.runTask === "function"),
  });
}

function safePlatformDescriptor({ uploaded, normalized, purpose, language }) {
  if (
    !Number.isSafeInteger(normalized?.byteLength)
    || normalized.byteLength <= 0
    || !Number.isSafeInteger(normalized?.durationMs)
    || normalized.durationMs <= 0
    || typeof uploaded?.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(uploaded.sha256)
    || language !== ASR_CONFIG_DEFAULTS.language
  ) {
    throw contractError("ASR_TRANSCODE_FAILED", 500, "ASR audio normalization failed");
  }
  return Object.freeze({
    mediaType: "audio/wav",
    byteLength: normalized.byteLength,
    durationMs: normalized.durationMs,
    purpose,
    language,
    sha256: uploaded.sha256,
  });
}

function platformTranscript(value) {
  const compatibility = value?.result?.metadata?.compatibility;
  const candidates = [
    value?.transcript,
    value?.text,
    value?.result?.transcript,
    value?.result?.text,
    value?.result?.metadata?.transcript,
    value?.result?.metadata?.payload?.text,
    compatibility?.text,
    value?.task?.result?.metadata?.compatibility?.text,
  ];
  return candidates.find((candidate) => typeof candidate === "string") ?? null;
}

function mapAiPlatformError(error) {
  if (error instanceof AsrContractError || error?.name === "AbortError") return error;
  const code = typeof error?.code === "string" ? error.code.trim().toLowerCase() : "";
  if (["cancelled", "canceled", "task_cancelled", "ai_platform_aborted"].includes(code) || error?.status === 499) {
    return new DOMException("ASR platform task was cancelled", "AbortError");
  }
  if (
    [
      "ai_platform_not_configured",
      "ai_platform_disabled",
      "invalid_runtime",
      "agent_not_configured",
      "configuration_error",
      "provider_disabled",
      "price_not_configured",
      "provider_policy_blocked",
    ].includes(code)
  ) {
    return contractError("ASR_NOT_CONFIGURED", 503, "ASR platform is not configured");
  }
  if (
    [
      "asr_timeout",
      "ai_platform_timeout",
      "timeout",
      "task_pending",
      "expired",
      "deadline_exceeded",
      "request_timeout",
    ].includes(code)
    || error?.name === "TimeoutError"
    || error?.status === 504
  ) {
    return contractError("ASR_TIMEOUT", 504, "ASR processing timed out");
  }
  if (["rate_limited", "queue_full", "capacity_exceeded"].includes(code) || error?.status === 429) {
    return contractError("ASR_CAPACITY_EXCEEDED", 429, "ASR processing capacity is exhausted");
  }
  return contractError("ASR_PROVIDER_BAD_RESPONSE", 502, "ASR platform request failed");
}

function capacityError() {
  return contractError("ASR_CAPACITY_EXCEEDED", 429, "ASR processing capacity is exhausted");
}

function safePositiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new TypeError(`${name} must be a bounded positive safe integer`);
  }
  return value;
}

function boundedString(value, name, maxLength = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function terminateUnreadRequestBody(body) {
  if (!body || body.destroyed === true) return false;
  try {
    if (typeof body.destroy === "function") {
      body.destroy();
      return true;
    }
    if (typeof body.cancel === "function") {
      Promise.resolve(body.cancel()).catch(() => {
        // The fixed request rejection remains authoritative.
      });
      return true;
    }
  } catch {
    // The fixed request rejection remains authoritative.
  }
  return false;
}

function settleWithin(promise, timeoutMs, setTimeoutImpl, clearTimeoutImpl) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      resolve(status);
    };
    const timer = setTimeoutImpl(() => finish("timeout"), timeoutMs);
    Promise.resolve(promise).then(
      () => finish("fulfilled"),
      () => finish("rejected"),
    );
  });
}

export function createProcessingCapacity({
  ownerMax = ASR_LIMITS.ownerProcessingMax,
  globalMax = ASR_LIMITS.globalProcessingMax,
} = {}) {
  safePositiveInteger(ownerMax, "ownerMax");
  safePositiveInteger(globalMax, "globalMax");
  let globalActive = 0;
  const owners = new Map();
  return Object.freeze({
    acquire(owner) {
      const normalizedOwner = boundedString(owner, "owner");
      const ownerActive = owners.get(normalizedOwner) ?? 0;
      if (globalActive >= globalMax || ownerActive >= ownerMax) throw capacityError();
      globalActive += 1;
      owners.set(normalizedOwner, ownerActive + 1);
      let released = false;
      return Object.freeze({
        release() {
          if (released) return false;
          released = true;
          globalActive -= 1;
          const nextOwner = (owners.get(normalizedOwner) ?? 1) - 1;
          if (nextOwner === 0) owners.delete(normalizedOwner);
          else owners.set(normalizedOwner, nextOwner);
          return true;
        },
      });
    },
    snapshot() {
      return Object.freeze({ globalActive, activeOwners: owners.size, ownerMax, globalMax });
    },
  });
}

function normalizedConfig(config, aiPlatformMode = config.aiPlatformMode) {
  const mode = config.asrMode ?? config.mode ?? ASR_CONFIG_DEFAULTS.mode;
  const providerName = config.asrProvider ?? config.provider ?? ASR_CONFIG_DEFAULTS.provider;
  if (!new Set(["disabled", "live"]).has(mode)) throw new TypeError("ASR mode is invalid");
  if (providerName !== "openai-compatible") throw new TypeError("ASR provider is invalid");
  const uploadMaxBytes = safePositiveInteger(
    config.asrUploadMaxBytes ?? config.uploadMaxBytes ?? ASR_CONFIG_DEFAULTS.uploadMaxBytes,
    "ASR upload maximum",
    ASR_LIMITS.uploadMaxBytes,
  );
  const quickMaxDurationMs = safePositiveInteger(
    config.asrQuickMaxDurationMs ?? config.quickMaxDurationMs ?? ASR_CONFIG_DEFAULTS.quickMaxDurationMs,
    "ASR quick duration maximum",
    ASR_CONFIG_DEFAULTS.quickMaxDurationMs,
  );
  const assistantMaxDurationMs = safePositiveInteger(
    config.asrAssistantMaxDurationMs
      ?? config.assistantMaxDurationMs
      ?? ASR_CONFIG_DEFAULTS.assistantMaxDurationMs,
    "ASR assistant duration maximum",
    ASR_CONFIG_DEFAULTS.assistantMaxDurationMs,
  );
  if (assistantMaxDurationMs > quickMaxDurationMs) {
    throw new TypeError("ASR assistant duration cannot exceed quick duration");
  }
  return Object.freeze({
    mode,
    providerName,
    aiPlatformMode: config.aiPlatformRoutingPolicy?.phase === "canary" ? "disabled" : normalizeAiPlatformMode(aiPlatformMode),
    baseUrl: config.asrBaseUrl ?? config.baseUrl ?? ASR_CONFIG_DEFAULTS.baseUrl,
    model: config.asrModel ?? config.model ?? ASR_CONFIG_DEFAULTS.model,
    providerTimeoutMs: config.asrTimeoutMs ?? config.timeoutMs ?? ASR_CONFIG_DEFAULTS.timeoutMs,
    uploadMaxBytes,
    quickMaxDurationMs,
    assistantMaxDurationMs,
    ffprobeCommand: config.asrFfprobeCommand ?? config.ffprobeCommand ?? ASR_CONFIG_DEFAULTS.ffprobeCommand,
    ffmpegCommand: config.asrFfmpegCommand ?? config.ffmpegCommand ?? ASR_CONFIG_DEFAULTS.ffmpegCommand,
    tempRoot: config.asrTempRoot ?? config.tempRoot ?? ASR_CONFIG_DEFAULTS.tempRoot,
    reuseModelCredential: config.asrReuseModelCredential
      ?? config.reuseModelCredential
      ?? ASR_CONFIG_DEFAULTS.reuseModelCredential,
    authSessionSecret: config.authSessionSecret ?? config.sessionSecret ?? "",
  });
}

function resultOutcome(error) {
  if (!error) return { outcome: "success", errorCode: "" };
  if (error?.name === "AbortError") return { outcome: "cancelled", errorCode: "CANCELLED" };
  return {
    outcome: "error",
    errorCode: typeof error?.code === "string" ? error.code : "ASR_INTERNAL_ERROR",
  };
}

function externalAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

export function createAsrService(config = {}, dependencies = {}) {
  const aiPlatformRuntime = dependencies.aiPlatformRuntime ?? config.aiPlatformRuntime ?? null;
  const runtime = normalizedConfig(
    config,
    config.aiPlatformMode ?? aiPlatformRuntime?.mode,
  );
  const now = dependencies.now ?? Date.now;
  const fsImpl = dependencies.fsImpl ?? fsPromises;
  const currentUid = dependencies.currentUid ?? process.getuid?.();
  const metrics = dependencies.metrics ?? createAsrMetrics({ now });
  const processingCapacity = dependencies.processingCapacity ?? createProcessingCapacity();
  const uploadCapacity = dependencies.uploadCapacity ?? createUploadCapacity({
    onActiveUploadsChange: (delta) => metrics.adjustActiveUploads(delta),
    onTempBytesChange: (delta) => metrics.adjustTempBytes(delta),
  });
  const idempotency = dependencies.idempotencyCache ?? createAsrIdempotencyCache({
    secret: runtime.authSessionSecret,
    now,
  });
  const setTimeoutImpl = dependencies.setTimeoutImpl ?? globalThis.setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl ?? globalThis.clearTimeout;
  const setIntervalImpl = dependencies.setIntervalImpl ?? globalThis.setInterval;
  const clearIntervalImpl = dependencies.clearIntervalImpl ?? globalThis.clearInterval;
  const writeAudioBodyImpl = dependencies.writeAudioBodyImpl ?? writeAudioBody;
  const probeAudioImpl = dependencies.probeAudioImpl ?? probeAudio;
  const transcodeImpl = dependencies.transcodeImpl ?? transcodeToCanonicalWav;
  const createWorkspaceImpl = dependencies.createWorkspaceImpl ?? createWorkspace;
  const cleanupImpl = dependencies.cleanupImpl ?? removeWorkspaceAndVerify;
  const sweepImpl = dependencies.sweepImpl ?? sweepTempRoot;
  let provider = dependencies.provider ?? null;
  let useAiPlatform = false;
  let initialized = false;
  let initializing = null;
  let accepting = true;
  let degradedCode = null;
  let sweepTimer = null;
  let periodicSweepPromise = null;
  let closePromise = null;
  const activeControllers = new Set();
  const activeRequests = new Set();
  const activeMediaChildren = new Set();
  const activeMediaChildClosures = new Map();
  const activeMediaChildStates = new Map();
  const pendingWorkspaceLifecycles = new Set();
  const pendingWorkspaceLifecycleStates = new Map();
  const pendingResourceLifecycles = new Set();
  const pendingResourceLifecycleStates = new Map();
  let mediaChildTerminationFailed = false;
  let resourceCleanupFailed = false;
  let lateWorkspaceCleanupFailed = false;
  let unreadBodyTerminationFailed = false;
  const confirmedStaleWorkspacePaths = new Set();

  function markUnreadBodyTerminationFailure(state) {
    if (state?.failureRecorded === true) return;
    if (state) state.failureRecorded = true;
    metrics.recordCleanupFailure();
    unreadBodyTerminationFailed = true;
    degradedCode = "ASR_CLEANUP_DEGRADED";
  }

  function createUnreadBodyState(body, signal, deferTermination) {
    let handedOff = false;
    let terminationAttempted = false;
    let terminationPerformed = false;
    let registrationFailed = false;
    const failureState = { failureRecorded: false };
    const performTermination = () => {
      if (terminationPerformed) return false;
      terminationPerformed = true;
      return terminateUnreadRequestBody(body);
    };
    const terminate = () => {
      if (handedOff || terminationAttempted) return false;
      terminationAttempted = true;
      if (typeof deferTermination !== "function") return false;
      try {
        const registration = deferTermination(performTermination);
        if (registration && typeof registration.then === "function") {
          registrationFailed = true;
          markUnreadBodyTerminationFailure(failureState);
          Promise.resolve(registration).catch(() => {
            // The rejection is consumed; the fixed cleanup error remains authoritative.
          });
          return false;
        }
        if (registration === false) {
          registrationFailed = true;
          markUnreadBodyTerminationFailure(failureState);
          return false;
        }
        return true;
      } catch {
        registrationFailed = true;
        markUnreadBodyTerminationFailure(failureState);
        return false;
      }
    };
    const onAbort = () => terminate();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeoutImpl(
      terminate,
      dependencies.preflightBodyTimeoutMs ?? ASR_LIMITS.uploadWallTimeoutMs,
    );
    return Object.freeze({
      handOff() {
        if (terminationAttempted) return false;
        handedOff = true;
        clearTimeoutImpl(timer);
        signal?.removeEventListener("abort", onAbort);
        return true;
      },
      terminate,
      terminationFailed() {
        return registrationFailed;
      },
      cleanup() {
        clearTimeoutImpl(timer);
        signal?.removeEventListener("abort", onAbort);
      },
    });
  }

  function createStageGuard(controller, timeoutMs, timeoutMessage) {
    let timedOut = false;
    let rejectGuard;
    const guard = new Promise((_, reject) => {
      rejectGuard = reject;
    });
    guard.catch(() => {
      // The deadline may fire while an injected I/O promise is still being created.
    });
    const onAbort = () => rejectGuard(
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new DOMException("The operation was aborted", "AbortError"),
    );
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeoutImpl(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(new DOMException(timeoutMessage, "TimeoutError"));
    }, timeoutMs);
    return Object.freeze({
      timedOut: () => timedOut,
      race(promise) {
        return Promise.race([Promise.resolve(promise), guard]);
      },
      cleanup() {
        clearTimeoutImpl(timer);
        controller.signal.removeEventListener("abort", onAbort);
      },
    });
  }

  async function waitForRequestInitialization(signal) {
    let rejectGuard;
    const guard = new Promise((_, reject) => {
      rejectGuard = reject;
    });
    guard.catch(() => {
      // A shared initialization may settle after this request-local guard wins.
    });
    const onAbort = () => rejectGuard(externalAbortError(signal));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeoutImpl(() => {
      rejectGuard(contractError("ASR_TIMEOUT", 504, "ASR initialization timed out"));
    }, dependencies.preflightBodyTimeoutMs ?? ASR_LIMITS.uploadWallTimeoutMs);
    try {
      return await Promise.race([initialize(), guard]);
    } finally {
      clearTimeoutImpl(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function markWorkspaceResidueIfConfirmed(workspace, timeoutMs) {
    if (typeof workspace !== "string" || workspace.length === 0) return false;
    let stat = null;
    let missing = false;
    const inspection = Promise.resolve().then(() => fsImpl.lstat(workspace)).then(
      (value) => { stat = value; },
      (error) => {
        if (error?.code === "ENOENT") {
          missing = true;
          return;
        }
        throw error;
      },
    );
    const status = await settleWithin(
      inspection,
      Math.max(1, timeoutMs),
      setTimeoutImpl,
      clearTimeoutImpl,
    );
    const confirmed = status === "fulfilled"
      && !missing
      && stat?.isDirectory?.() === true
      && stat?.isSymbolicLink?.() !== true;
    if (confirmed) {
      if (!confirmedStaleWorkspacePaths.has(workspace)) {
        confirmedStaleWorkspacePaths.add(workspace);
        metrics.setStaleTempDirectories(
          metrics.snapshot().gauges.staleTempDirectories + 1,
        );
      }
    } else if (
      status === "fulfilled"
      && confirmedStaleWorkspacePaths.delete(workspace)
    ) {
      metrics.setStaleTempDirectories(Math.max(
        0,
        metrics.snapshot().gauges.staleTempDirectories - 1,
      ));
    }
    return confirmed;
  }

  function markLateWorkspaceCleanupFailure(state) {
    if (state?.failureRecorded === true) return;
    if (state) state.failureRecorded = true;
    lateWorkspaceCleanupFailed = true;
    degradedCode = "ASR_CLEANUP_DEGRADED";
    metrics.recordCleanupFailure();
  }

  function markResourceCleanupFailure({ record = true } = {}) {
    if (record) metrics.recordCleanupFailure();
    resourceCleanupFailed = true;
    degradedCode = "ASR_CLEANUP_DEGRADED";
  }

  function markTrackedResourceFailure(lifecycle) {
    const state = pendingResourceLifecycleStates.get(lifecycle);
    if (!state) {
      markResourceCleanupFailure();
      return;
    }
    if (!state.failureRecorded) {
      state.failureRecorded = true;
      markResourceCleanupFailure();
    } else {
      markResourceCleanupFailure({ record: false });
    }
    state.requestState.failed = true;
  }

  function trackLateWorkspaceLifecycle(workspacePromise) {
    const state = { kind: "cleanup", path: null, failureRecorded: false };
    const lifecycle = Promise.resolve(workspacePromise).then(async (lateWorkspace) => {
      if (typeof lateWorkspace !== "string" || lateWorkspace.length === 0) return;
      state.path = lateWorkspace;
      try {
        await Promise.resolve().then(() => cleanupImpl(lateWorkspace, {
          fsImpl,
          currentUid,
          ...dependencies.cleanupOptions,
        }));
        if (await markWorkspaceResidueIfConfirmed(
          lateWorkspace,
          dependencies.requestCleanupTimeoutMs ?? 2_000,
        )) {
          throw new Error("ASR late workspace cleanup left a directory behind");
        }
      } catch (error) {
        await markWorkspaceResidueIfConfirmed(
          lateWorkspace,
          dependencies.requestCleanupTimeoutMs ?? 2_000,
        );
        throw error;
      }
    }, () => {
      // A rejected creation cannot materialize a workspace after request completion.
    });
    pendingWorkspaceLifecycles.add(lifecycle);
    pendingWorkspaceLifecycleStates.set(lifecycle, state);
    lifecycle.then(
      () => {
        pendingWorkspaceLifecycles.delete(lifecycle);
        pendingWorkspaceLifecycleStates.delete(lifecycle);
      },
      () => {
        markLateWorkspaceCleanupFailure(state);
        pendingWorkspaceLifecycles.delete(lifecycle);
        pendingWorkspaceLifecycleStates.delete(lifecycle);
      },
    );
    return lifecycle;
  }

  function trackWorkspaceSettlement(workspacePromise) {
    const state = { kind: "settlement", path: null, failureRecorded: false };
    const lifecycle = Promise.resolve(workspacePromise).then(
      () => undefined,
      () => undefined,
    );
    pendingWorkspaceLifecycles.add(lifecycle);
    pendingWorkspaceLifecycleStates.set(lifecycle, state);
    lifecycle.finally(() => {
      pendingWorkspaceLifecycles.delete(lifecycle);
      pendingWorkspaceLifecycleStates.delete(lifecycle);
    });
    return lifecycle;
  }

  function trackResourceLifecycle(lifecycle, requestState, { workspacePath = null } = {}) {
    const source = Promise.resolve(lifecycle);
    const tracked = workspacePath === null ? source : source.then(
      async (value) => {
        if (await markWorkspaceResidueIfConfirmed(
          workspacePath,
          dependencies.requestCleanupTimeoutMs ?? 2_000,
        )) {
          throw new Error("ASR workspace cleanup left a directory behind");
        }
        return value;
      },
      async (error) => {
        await markWorkspaceResidueIfConfirmed(
          workspacePath,
          dependencies.requestCleanupTimeoutMs ?? 2_000,
        );
        throw error;
      },
    );
    const state = { failureRecorded: false, requestState, workspacePath };
    pendingResourceLifecycles.add(tracked);
    pendingResourceLifecycleStates.set(tracked, state);
    requestState.lifecycles.add(tracked);
    tracked.then(
      () => {
        pendingResourceLifecycles.delete(tracked);
        pendingResourceLifecycleStates.delete(tracked);
        requestState.lifecycles.delete(tracked);
      },
      () => {
        markTrackedResourceFailure(tracked);
        pendingResourceLifecycles.delete(tracked);
        pendingResourceLifecycleStates.delete(tracked);
        requestState.lifecycles.delete(tracked);
      },
    );
    return tracked;
  }

  function trackMediaChild(child, requestChildren, requestChildClosures) {
    if (!child || typeof child.once !== "function") {
      throw new TypeError("ASR media child must support lifecycle events");
    }
    const streamClosed = (stream) => (
      !stream
      || stream.destroyed === true
      || stream.readableEnded === true
      || stream.writableFinished === true
      || stream.closed === true
    );
    if (
      (child.exitCode !== null && child.exitCode !== undefined
        || child.signalCode !== null && child.signalCode !== undefined)
      && streamClosed(child.stdout)
      && streamClosed(child.stderr)
    ) return;
    let resolveClosed;
    let childClosed = false;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const childState = { failureRecorded: false };
    const onChildClose = () => {
      childClosed = true;
      release();
    };
    const release = () => {
      if (!childClosed || !streamClosed(child.stdout) || !streamClosed(child.stderr)) return;
      activeMediaChildren.delete(child);
      activeMediaChildClosures.delete(child);
      activeMediaChildStates.delete(child);
      requestChildren.delete(child);
      requestChildClosures.delete(child);
      child.removeListener?.("close", onChildClose);
      for (const stream of [child.stdout, child.stderr]) {
        stream?.removeListener?.("close", release);
        stream?.removeListener?.("end", release);
        stream?.removeListener?.("finish", release);
      }
      resolveClosed();
    };
    activeMediaChildren.add(child);
    activeMediaChildClosures.set(child, closed);
    activeMediaChildStates.set(child, childState);
    requestChildren.add(child);
    requestChildClosures.set(child, closed);
    child.once("close", onChildClose);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.once?.("close", release);
      stream?.once?.("end", release);
      stream?.once?.("finish", release);
    }
  }

  function markMediaChildFailure(child) {
    const state = activeMediaChildStates.get(child);
    if (state?.failureRecorded !== true) {
      if (state) state.failureRecorded = true;
      markResourceCleanupFailure();
    } else {
      markResourceCleanupFailure({ record: false });
    }
    mediaChildTerminationFailed = true;
  }

  function effectiveDuration(purpose) {
    return purpose === "quick_record"
      ? runtime.quickMaxDurationMs
      : runtime.assistantMaxDurationMs;
  }

  function createProviderIfNeeded() {
    if (provider) return provider;
    let keyProvider;
    if (runtime.reuseModelCredential === false) {
      if (typeof dependencies.asrApiKeyProvider !== "function") {
        throw contractError("ASR_NOT_CONFIGURED", 503, "ASR credential provider is unavailable");
      }
      keyProvider = dependencies.asrApiKeyProvider;
    } else {
      if (
        dependencies.modelCredentialReuseVerified !== true
        || dependencies.credentialCompatibility !== "model"
        || typeof dependencies.modelApiKeyProvider !== "function"
      ) {
        throw contractError("ASR_NOT_CONFIGURED", 503, "ASR credential reuse is not verified");
      }
      keyProvider = dependencies.modelApiKeyProvider;
    }
    provider = createOpenAiCompatibleProvider({
      baseUrl: runtime.baseUrl,
      model: runtime.model,
      timeoutMs: runtime.providerTimeoutMs,
      asrApiKeyProvider: keyProvider,
    }, dependencies.providerDependencies);
    return provider;
  }

  async function applySweepResult(result) {
    const knownPaths = [...confirmedStaleWorkspacePaths];
    for (const workspace of knownPaths) {
      await markWorkspaceResidueIfConfirmed(
        workspace,
        dependencies.requestCleanupTimeoutMs ?? 2_000,
      );
    }
    const sweptPaths = result?.[ASR_SWEEP_RESIDUAL_PATHS];
    if (Array.isArray(sweptPaths)) {
      for (const workspace of sweptPaths) {
        if (typeof workspace === "string" && workspace.length !== 0) {
          confirmedStaleWorkspacePaths.add(workspace);
        }
      }
      metrics.setStaleTempDirectories(confirmedStaleWorkspacePaths.size);
    } else {
      const counted = Number.isSafeInteger(result.residualDirectoryCount)
        && result.residualDirectoryCount >= 0
        ? result.residualDirectoryCount
        : Math.max(0, result.staleCount - result.removedCount);
      metrics.setStaleTempDirectories(Math.max(
        confirmedStaleWorkspacePaths.size,
        counted,
      ));
    }
    const remaining = metrics.snapshot().gauges.staleTempDirectories;
    if (!result.ready || remaining !== 0) {
      degradedCode = "ASR_TEMP_ROOT_DEGRADED";
      return false;
    }
    return true;
  }

  async function runStartupSweep({ createIfMissing }) {
    try {
      const result = await sweepImpl(runtime.tempRoot, {
        fsImpl,
        currentUid,
        mode: "startup",
        now,
        cleanupOptions: dependencies.cleanupOptions,
        createIfMissing,
      });
      await applySweepResult(result);
      return result;
    } catch (error) {
      if (!createIfMissing && error?.code === "ENOENT") {
        confirmedStaleWorkspacePaths.clear();
        metrics.setStaleTempDirectories(0);
        return null;
      }
      degradedCode = "ASR_TEMP_ROOT_DEGRADED";
      return false;
    }
  }

  function startPeriodicSweep() {
    if (!accepting || sweepTimer !== null) return;
    sweepTimer = setIntervalImpl(() => {
      if (periodicSweepPromise || !accepting) return;
      periodicSweepPromise = (async () => {
        try {
          const periodic = await sweepImpl(runtime.tempRoot, {
            fsImpl,
            currentUid,
            mode: "periodic",
            now,
            cleanupOptions: dependencies.cleanupOptions,
            createIfMissing: false,
          });
          await applySweepResult(periodic);
        } catch {
          degradedCode = "ASR_TEMP_ROOT_DEGRADED";
        }
      })().finally(() => {
        periodicSweepPromise = null;
      });
    }, dependencies.sweepIntervalMs ?? 300_000);
    sweepTimer.unref?.();
  }

  async function initialize() {
    if (!accepting) return readiness();
    if (initialized) return readiness();
    if (initializing) return initializing;
    initializing = (async () => {
      if (!accepting) return readiness();
      const existingStartup = await runStartupSweep({ createIfMissing: false });
      if (!accepting) return readiness();
      if (runtime.mode !== "live") {
        initialized = true;
        degradedCode = "ASR_DISABLED";
        return readiness();
      }
      if (existingStartup === false || existingStartup?.ready === false) {
        initialized = true;
        return readiness();
      }
      try {
        if (!accepting) return readiness();
        const platform = aiPlatformState(runtime.aiPlatformMode, aiPlatformRuntime);
        useAiPlatform = platform.selected;
        if (platform.selected) {
          if (!platform.ready) {
            throw contractError("ASR_NOT_CONFIGURED", 503, "ASR platform is not configured");
          }
        } else {
          const activeProvider = createProviderIfNeeded();
          const providerReadiness = activeProvider.readiness?.() ?? { ready: true, code: "READY" };
          if (providerReadiness.ready !== true) {
            throw contractError("ASR_NOT_CONFIGURED", 503, "ASR provider is not ready");
          }
        }
        if (existingStartup === null) {
          if (!accepting) return readiness();
          const createdStartup = await runStartupSweep({ createIfMissing: true });
          if (createdStartup === false || createdStartup?.ready === false) {
            initialized = true;
            return readiness();
          }
        }
        startPeriodicSweep();
      } catch {
        if (degradedCode !== "ASR_TEMP_ROOT_DEGRADED") {
          degradedCode = "ASR_NOT_CONFIGURED";
        }
      }
      initialized = true;
      return readiness();
    })();
    try {
      return await initializing;
    } finally {
      initializing = null;
    }
  }

  function readiness() {
    if (!accepting) return Object.freeze({ ready: false, code: "ASR_CLOSED" });
    if (!initialized) return Object.freeze({ ready: false, code: "ASR_INITIALIZING" });
    if (runtime.mode !== "live") return Object.freeze({ ready: false, code: "ASR_DISABLED" });
    if (degradedCode) return Object.freeze({ ready: false, code: degradedCode });
    return Object.freeze({ ready: true, code: "READY" });
  }

  async function runRequest(input, unreadBodyState) {
    await waitForRequestInitialization(input?.signal);
    if (!readiness().ready) {
      throw contractError("ASR_NOT_CONFIGURED", 503, "ASR is not configured");
    }
    const owner = boundedString(input?.owner, "owner");
    const idempotencyKey = boundedString(input?.idempotencyKey, "idempotencyKey", 128);
    const purpose = parseAsrPurpose(input?.purpose);
    const mediaType = canonicalizeAsrMediaType(input?.mediaType);
    const language = input?.language ?? ASR_CONFIG_DEFAULTS.language;
    if (!input?.body || typeof input.body.pipe !== "function") throw new TypeError("ASR body stream is required");
    const contentLength = input.contentLength ?? null;
    if (contentLength !== null) {
      safePositiveInteger(contentLength, "contentLength", runtime.uploadMaxBytes);
    }
    const requestId = boundedString(input.requestId ?? "server-asr-request", "requestId", 256);
    const startedAt = now();
    metrics.adjustInflight(1);
    const controller = new AbortController();
    activeControllers.add(controller);
    let processingTimedOut = false;
    let workspaceTimedOut = false;
    let processingGuard = null;
    const onExternalAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) onExternalAbort();
    else input.signal?.addEventListener("abort", onExternalAbort, { once: true });

    let workspace = null;
    let workspaceReady = false;
    let workspaceMaterializedPath = null;
    let reservation = null;
    let processingSlot = null;
    let claim = null;
    let result = null;
    let primaryError = null;
    let cleanupFailed = false;
    let cleanupVerified = false;
    let providerMs = null;
    let workspacePromise = null;
    let workspaceMaterializationPromise = null;
    let resolveWorkspaceMaterialization = null;
    let rejectWorkspaceMaterialization = null;
    let workspaceMaterializationSettled = false;
    let lateWorkspaceCleanupAttached = false;
    let workspaceSettlementAttached = false;
    const requestMediaChildren = new Set();
    const requestMediaChildClosures = new Map();
    const requestResourceState = { lifecycles: new Set(), failed: false };
    const onMediaChildSpawn = (child) => trackMediaChild(
      child,
      requestMediaChildren,
      requestMediaChildClosures,
    );
    const onLateResourceLifecycle = (lifecycle) => (
      trackResourceLifecycle(lifecycle, requestResourceState)
    );
    function attachLateWorkspaceCleanup() {
      if (workspaceReady || !workspacePromise) return;
      if (!workspaceSettlementAttached) {
        workspaceSettlementAttached = true;
        trackWorkspaceSettlement(workspacePromise);
      }
      if (workspaceMaterializedPath) {
        // mkdtemp has completed, so this request can own and verify cleanup in
        // its normal finally path without waiting for chmod/lstat readiness.
        workspace = workspaceMaterializedPath;
        return;
      }
      if (lateWorkspaceCleanupAttached) return;
      lateWorkspaceCleanupAttached = true;
      // A createWorkspace implementation can publish the mkdtemp path and then
      // block forever in chmod/lstat. Track materialization, not readiness, so
      // the published directory is removed even when workspacePromise never
      // settles. registerWorkspaceMaterialization also resolves this promise for
      // injected implementations that return normally without calling back.
      const cleanupSource = workspaceMaterializationPromise;
      trackLateWorkspaceLifecycle(cleanupSource);
    }
    function registerWorkspaceMaterialization(materializedWorkspace) {
      if (typeof materializedWorkspace !== "string" || materializedWorkspace.length === 0) {
        throw new TypeError("ASR workspace materialization path is invalid");
      }
      workspaceMaterializedPath ??= materializedWorkspace;
      if (!workspaceMaterializationSettled) {
        workspaceMaterializationSettled = true;
          resolveWorkspaceMaterialization(materializedWorkspace);
      }
      return materializedWorkspace;
    }
    function throwIfAborted() {
      if (!controller.signal.aborted) return;
      if (processingTimedOut || processingGuard?.timedOut() || workspaceTimedOut) {
        throw contractError("ASR_TIMEOUT", 504, "ASR processing timed out");
      }
      if (input.signal?.aborted) throw externalAbortError(input.signal);
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    try {
      throwIfAborted();
      if (idempotency.peek(owner, idempotencyKey) === "pending") {
        throw contractError("ASR_IN_PROGRESS", 409, "ASR request is already in progress");
      }
      reservation = uploadCapacity.acquire(contentLength);
      const workspaceGuard = createStageGuard(
        controller,
        dependencies.workspaceTimeoutMs ?? ASR_LIMITS.uploadWallTimeoutMs,
        "ASR workspace creation timed out",
      );
      try {
        workspaceMaterializationPromise = new Promise((resolve, reject) => {
          resolveWorkspaceMaterialization = resolve;
          rejectWorkspaceMaterialization = reject;
        });
        workspaceMaterializationPromise.catch(() => {
          // The late-workspace lifecycle owns the materialization outcome.
        });
        workspacePromise = Promise.resolve().then(() => createWorkspaceImpl(runtime.tempRoot, {
          fsImpl,
          currentUid,
          signal: controller.signal,
          onWorkspaceCreated: registerWorkspaceMaterialization,
          cleanupOnFailure: false,
        }));
        workspacePromise.then(
          (createdWorkspace) => {
            registerWorkspaceMaterialization(createdWorkspace);
          },
          (error) => {
            if (!workspaceMaterializationSettled) {
              workspaceMaterializationSettled = true;
              rejectWorkspaceMaterialization(error);
            }
          },
        ).catch(() => {
          // The guarded workspace promise and materialization lifecycle own this result.
        });
        const createdWorkspace = await workspaceGuard.race(workspacePromise);
        registerWorkspaceMaterialization(createdWorkspace);
        workspace = createdWorkspace;
        workspaceReady = true;
      } finally {
        workspaceTimedOut = workspaceGuard.timedOut();
        workspaceGuard.cleanup();
      }
      throwIfAborted();
      const uploadStarted = now();
      let bodyPipelineStarted = false;
      const onPipelineStart = () => {
        bodyPipelineStarted = true;
        return unreadBodyState.handOff();
      };
      const uploaded = await writeAudioBodyImpl({
        readable: input.body,
        outputPath: join(workspace, "input.audio"),
        reservation,
        signal: controller.signal,
        maxBytes: runtime.uploadMaxBytes,
        currentUid,
        setTimeoutImpl,
        clearTimeoutImpl,
        onPipelineStart,
        onLateResourceLifecycle,
      });
      if (!bodyPipelineStarted && !unreadBodyState.handOff()) {
        throw externalAbortError(controller.signal);
      }
      throwIfAborted();
      metrics.recordStageDuration({ stage: "upload", purpose, elapsedMs: Math.max(0, now() - uploadStarted) });
      assertAudioMagic(mediaType, uploaded.magicBytes);

      processingSlot = processingCapacity.acquire(owner);
      processingGuard = createStageGuard(
        controller,
        dependencies.processingTimeoutMs ?? ASR_LIMITS.processingTimeoutMs,
        "ASR processing timed out",
      );

      const probeStarted = now();
      const probe = await processingGuard.race(probeAudioImpl({
        inputPath: join(workspace, "input.audio"),
        mediaType,
        purpose,
        effectiveMaxDurationMs: effectiveDuration(purpose),
        ffprobeCommand: runtime.ffprobeCommand,
        signal: controller.signal,
        spawnImpl: dependencies.spawnImpl,
        onChildSpawn: onMediaChildSpawn,
        fsImpl,
      }));
      throwIfAborted();
      metrics.recordStageDuration({ stage: "probe", purpose, elapsedMs: Math.max(0, now() - probeStarted) });
      metrics.recordAudioDuration({ purpose, durationMs: probe.durationMs });

      const fingerprint = createAsrFingerprint({
        purpose,
        mediaType,
        audioSha256: uploaded.sha256,
        durationMs: probe.durationMs,
      });
      claim = idempotency.claim({ owner, key: idempotencyKey, fingerprint });
      if (claim.kind === "replay") {
        result = Object.freeze({ ...claim.value, replayed: true });
      } else {
        const transcodeStarted = now();
        const normalized = await processingGuard.race(transcodeImpl({
          inputPath: join(workspace, "input.audio"),
          outputPath: join(workspace, "normalized.wav"),
          purpose,
          originalDurationMs: probe.durationMs,
          effectiveMaxDurationMs: effectiveDuration(purpose),
          ffmpegCommand: runtime.ffmpegCommand,
          signal: controller.signal,
          spawnImpl: dependencies.spawnImpl,
          onChildSpawn: onMediaChildSpawn,
          onLateResourceLifecycle,
          fsImpl,
          currentUid,
          setTimeoutImpl,
          clearTimeoutImpl,
        }));
        throwIfAborted();
        metrics.recordStageDuration({
          stage: "transcode",
          purpose,
          elapsedMs: Math.max(0, now() - transcodeStarted),
        });

        const providerStarted = now();
        const providerId = useAiPlatform ? AI_PLATFORM_PROVIDER_ID : provider.id;
        try {
          let providerResult;
          if (useAiPlatform) {
            let descriptor = safePlatformDescriptor({
              uploaded,
              normalized,
              purpose,
              language,
            });
            if (typeof aiPlatformRuntime?.runTask !== "function") {
              throw contractError("ASR_NOT_CONFIGURED", 503, "ASR platform is not configured");
            }
            let uploadedMedia;
            try {
              if (config.aiPlatformExecutionMode === "external-provider") {
                if (typeof aiPlatformRuntime.uploadMedia !== "function") throw contractError("ASR_NOT_CONFIGURED", 503, "ASR media transport is unavailable");
                const audio = await processingGuard.race(fsImpl.readFile(normalized.outputPath));
                descriptor = { ...descriptor, sha256: createHash("sha256").update(audio).digest("hex") };
                uploadedMedia = await processingGuard.race(aiPlatformRuntime.uploadMedia({ bytes: audio, media: descriptor, owner, actor: owner, signal: controller.signal }));
              }
              const platformResult = await processingGuard.race(aiPlatformRuntime.runTask({
              taskType: AI_PLATFORM_TASK_TYPE,
              feature: AI_PLATFORM_FEATURE,
              channel: "web",
              owner,
              actor: owner,
              subject: { type: "asr_audio", id: `sha256-${descriptor.sha256}` },
              input: Object.freeze({ media: descriptor, ...(uploadedMedia ? { mediaRef: uploadedMedia.id } : {}) }),
              evidenceDigest: descriptor.sha256,
              priority: "interactive",
              idempotencyKey,
              signal: controller.signal,
            }));
              providerResult = { text: platformTranscript(platformResult) };
            } finally {
              if (uploadedMedia) await aiPlatformRuntime.discardMedia({ id: uploadedMedia.id, owner, actor: owner });
            }
          } else {
            providerResult = await processingGuard.race(provider.transcribe({
              audioPath: normalized.outputPath,
              mediaType: "audio/wav",
              language,
              durationMs: normalized.durationMs,
              purpose,
              signal: controller.signal,
              requestId,
              [ASR_PROVIDER_RESOURCE_LIFECYCLE]: onLateResourceLifecycle,
            }));
          }
          throwIfAborted();
          providerMs = Math.max(0, now() - providerStarted);
          const transcript = normalizeAsrTranscript(providerResult?.text, purpose);
          metrics.recordProviderCall({ provider: providerId, outcome: "success" });
          metrics.recordStageDuration({ stage: "provider", purpose, elapsedMs: providerMs });
          result = Object.freeze({
            transcript,
            language,
            durationMs: normalized.durationMs,
            source: "server_asr",
            replayed: false,
          });
        } catch (error) {
          providerMs = Math.max(0, now() - providerStarted);
          metrics.recordProviderCall({ provider: providerId, outcome: "error" });
          metrics.recordStageDuration({ stage: "provider", purpose, elapsedMs: providerMs });
          throw useAiPlatform ? mapAiPlatformError(error) : error;
        }
      }
    } catch (error) {
      attachLateWorkspaceCleanup();
      processingTimedOut ||= processingGuard?.timedOut() === true;
      if (error?.code === "ASR_CLEANUP_FAILED") {
        if (!requestResourceState.failed) {
          let assignedFailure = false;
          if (requestResourceState.lifecycles.size !== 0) {
            for (const lifecycle of requestResourceState.lifecycles) {
              markTrackedResourceFailure(lifecycle);
              assignedFailure = true;
            }
          } else {
            for (const child of requestMediaChildren) {
              markMediaChildFailure(child);
              assignedFailure = true;
            }
          }
          if (!assignedFailure) {
            markResourceCleanupFailure();
          }
        }
        requestResourceState.failed = true;
      }
      if ((processingTimedOut || workspaceTimedOut) && !(error instanceof AsrContractError)) {
        primaryError = contractError("ASR_TIMEOUT", 504, "ASR processing timed out");
      } else if (input.signal?.aborted && !(error instanceof AsrContractError)) {
        primaryError = externalAbortError(input.signal);
      } else {
        primaryError = error;
      }
    } finally {
      controller.abort(new DOMException("ASR request lifecycle ended", "AbortError"));
      await Promise.resolve();
      const cleanupStarted = now();
      const requestCleanupTimeoutMs = dependencies.requestCleanupTimeoutMs ?? 2_000;
      if (requestMediaChildren.size !== 0) {
        const children = [...requestMediaChildren];
        const terminationPromise = Promise.all(children.map((child) => terminateMediaChild(child, {
          graceMs: dependencies.childKillGraceMs ?? ASR_LIMITS.childKillGraceMs,
          setTimeoutImpl,
        }))).then(async (results) => {
          if (results.every((terminated) => terminated === true)) {
            await Promise.all(children.map((child) => (
              requestMediaChildClosures.get(child) ?? Promise.resolve()
            )));
          }
          return results;
        });
        for (const child of children) {
          child.stdout?.destroy?.();
          child.stderr?.destroy?.();
        }
        let childResults = null;
        const childStatus = await settleWithin(
          terminationPromise.then((results) => { childResults = results; }),
          requestCleanupTimeoutMs,
          setTimeoutImpl,
          clearTimeoutImpl,
        );
        if (
          childStatus !== "fulfilled"
          || childResults?.some((terminated) => terminated !== true)
          || requestMediaChildren.size !== 0
        ) {
          cleanupFailed = true;
          mediaChildTerminationFailed = true;
          for (let index = 0; index < children.length; index += 1) {
            if (
              childResults?.[index] !== true
              || requestMediaChildren.has(children[index])
            ) {
              markMediaChildFailure(children[index]);
            }
          }
        }
      }
      if (requestResourceState.lifecycles.size !== 0) {
        const lifecycleStatus = await settleWithin(
          Promise.all([...requestResourceState.lifecycles].map((lifecycle) => (
            lifecycle.catch(() => undefined)
          ))),
          requestCleanupTimeoutMs,
          setTimeoutImpl,
          clearTimeoutImpl,
        );
        if (
          lifecycleStatus !== "fulfilled"
          || requestResourceState.lifecycles.size !== 0
        ) {
          cleanupFailed = true;
          requestResourceState.failed = true;
          for (const lifecycle of requestResourceState.lifecycles) {
            markTrackedResourceFailure(lifecycle);
          }
        }
      }
      if (requestResourceState.failed) cleanupFailed = true;
      if (workspace) {
        const cleanupPromise = Promise.resolve().then(() => cleanupImpl(workspace, {
          fsImpl,
          currentUid,
          ...dependencies.cleanupOptions,
        }));
        const cleanupLifecycle = trackResourceLifecycle(
          cleanupPromise,
          requestResourceState,
          { workspacePath: workspace },
        );
        const cleanupStatus = await settleWithin(
          cleanupLifecycle,
          requestCleanupTimeoutMs,
          setTimeoutImpl,
          clearTimeoutImpl,
        );
        if (cleanupStatus === "fulfilled") {
          cleanupVerified = !cleanupFailed;
        } else {
          cleanupFailed = true;
          if (cleanupStatus === "timeout") {
            markTrackedResourceFailure(cleanupLifecycle);
          }
          await markWorkspaceResidueIfConfirmed(workspace, requestCleanupTimeoutMs);
        }
        /*
          cleanupPromise keeps its own resolve/reject handlers through settleWithin,
          so a late injected cleanup cannot become an unhandled rejection.
        */
      } else {
        cleanupVerified = !cleanupFailed && !lateWorkspaceCleanupAttached;
      }
      processingTimedOut ||= processingGuard?.timedOut() === true;
      processingGuard?.cleanup();
      metrics.recordStageDuration({
        stage: "cleanup",
        purpose,
        elapsedMs: Math.max(0, now() - cleanupStarted),
      });
      const reservationState = reservation?.snapshot?.();
      if (reservationState && !reservationState.released) {
        if (reservationState.active) reservation.abort();
        else reservation.releaseTemp();
      }
      processingSlot?.release();
      activeControllers.delete(controller);
      input.signal?.removeEventListener("abort", onExternalAbort);
      metrics.adjustInflight(-1);
    }

    if (!primaryError && (processingTimedOut || workspaceTimedOut)) {
      primaryError = contractError("ASR_TIMEOUT", 504, "ASR processing timed out");
      result = null;
    } else if (!primaryError && input.signal?.aborted) {
      primaryError = externalAbortError(input.signal);
      result = null;
    } else if (!primaryError && !accepting) {
      primaryError = new DOMException("ASR service is closing", "AbortError");
      result = null;
    }

    if (cleanupFailed) {
      if (claim?.kind === "claimed") idempotency.release(claim);
      primaryError = contractError("ASR_CLEANUP_FAILED", 503, "Temporary audio cleanup failed");
      result = null;
    } else if (primaryError && claim?.kind === "claimed") {
      idempotency.release(claim);
    } else if (!primaryError && claim?.kind === "claimed") {
      const completedValue = {
        transcript: result.transcript,
        language: result.language,
        durationMs: result.durationMs,
        source: result.source,
      };
      if (!idempotency.complete(claim, completedValue)) {
        primaryError = contractError("ASR_TIMEOUT", 504, "ASR idempotency reservation expired");
        result = null;
      }
    }

    if (primaryError) {
      unreadBodyState.terminate();
      if (unreadBodyState.terminationFailed()) {
        primaryError = contractError(
          "ASR_CLEANUP_FAILED",
          503,
          "ASR unread-body termination failed",
        );
        result = null;
        cleanupVerified = false;
      }
    }

    const { outcome, errorCode } = resultOutcome(primaryError);
    const providerId = useAiPlatform
      ? AI_PLATFORM_PROVIDER_ID
      : provider?.id ?? runtime.providerName;
    metrics.recordRequest({ purpose, provider: providerId, outcome, errorCode });
    metrics.recordCompletion({
      purpose,
      provider: providerId,
      outcome,
      errorCode,
      totalMs: Math.max(0, now() - startedAt),
      providerMs,
      cleanupVerified,
    });
    if (primaryError) throw primaryError;
    return result;
  }

  async function transcribe(input) {
    if (input?.body && typeof input.deferUnreadBodyTermination !== "function") {
      markUnreadBodyTerminationFailure();
      throw contractError(
        "ASR_NOT_CONFIGURED",
        503,
        "ASR unread-body termination integration is unavailable",
      );
    }
    const unreadBodyState = createUnreadBodyState(
      input?.body,
      input?.signal,
      input?.deferUnreadBodyTermination,
    );
    if (!accepting) {
      unreadBodyState.terminate();
      unreadBodyState.cleanup();
      if (unreadBodyState.terminationFailed()) {
        throw contractError("ASR_CLEANUP_FAILED", 503, "ASR unread-body termination failed");
      }
      throw contractError("ASR_NOT_CONFIGURED", 503, "ASR service is closed");
    }
    const request = runRequest(input, unreadBodyState).catch((error) => {
      unreadBodyState.terminate();
      if (unreadBodyState.terminationFailed()) {
        throw contractError("ASR_CLEANUP_FAILED", 503, "ASR unread-body termination failed");
      }
      throw error;
    }).finally(() => {
      unreadBodyState.cleanup();
    });
    activeRequests.add(request);
    try {
      return await request;
    } finally {
      activeRequests.delete(request);
    }
  }

  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      accepting = false;
      if (sweepTimer !== null) {
        clearIntervalImpl(sweepTimer);
        sweepTimer = null;
      }
      for (const controller of activeControllers) {
        controller.abort(new DOMException("ASR service is closing", "AbortError"));
      }
      const closeTimeoutMs = dependencies.closeTimeoutMs ?? 65_000;
      let timedOut = false;
      let closeTimer;
      const deadline = new Promise((resolve) => {
        closeTimer = setTimeoutImpl(() => {
          timedOut = true;
          resolve(false);
        }, closeTimeoutMs);
      });
      async function waitPhase(promise) {
        const completed = await Promise.race([Promise.resolve(promise).then(() => true), deadline]);
        if (!completed || timedOut) {
          throw contractError("ASR_TIMEOUT", 504, "ASR shutdown timed out");
        }
      }
      try {
        if (initializing) await waitPhase(initializing);
        if (sweepTimer !== null) {
          clearIntervalImpl(sweepTimer);
          sweepTimer = null;
        }
        if (periodicSweepPromise) await waitPhase(periodicSweepPromise);
        await waitPhase(Promise.allSettled([...activeRequests]));
        if (activeRequests.size !== 0 || activeControllers.size !== 0 || periodicSweepPromise) {
          throw contractError("ASR_TIMEOUT", 504, "ASR shutdown did not release all resources");
        }
        if (pendingWorkspaceLifecycles.size !== 0) {
          try {
            await waitPhase(Promise.allSettled([...pendingWorkspaceLifecycles]));
          } catch (error) {
            degradedCode = "ASR_CLEANUP_DEGRADED";
            await Promise.all([...pendingWorkspaceLifecycles].map(async (lifecycle) => {
              const state = pendingWorkspaceLifecycleStates.get(lifecycle);
              if (state?.kind === "cleanup") {
                markLateWorkspaceCleanupFailure(state);
                await markWorkspaceResidueIfConfirmed(
                  state.path,
                  dependencies.requestCleanupTimeoutMs ?? 2_000,
                );
              }
            }));
            throw error;
          }
        }
        if (pendingResourceLifecycles.size !== 0) {
          try {
            await waitPhase(Promise.allSettled([...pendingResourceLifecycles]));
          } catch (error) {
            for (const lifecycle of pendingResourceLifecycles) {
              markTrackedResourceFailure(lifecycle);
            }
            throw error;
          }
        }
        if (pendingResourceLifecycles.size !== 0) {
          for (const lifecycle of pendingResourceLifecycles) {
            markTrackedResourceFailure(lifecycle);
          }
          throw contractError("ASR_TIMEOUT", 504, "ASR shutdown did not settle resource cleanup");
        }
        if (pendingWorkspaceLifecycles.size !== 0) {
          for (const lifecycle of pendingWorkspaceLifecycles) {
            const state = pendingWorkspaceLifecycleStates.get(lifecycle);
            if (state?.kind === "cleanup") markLateWorkspaceCleanupFailure(state);
          }
          throw contractError("ASR_TIMEOUT", 504, "ASR shutdown did not settle late workspace cleanup");
        }
        if (activeMediaChildren.size !== 0) {
          const children = [...activeMediaChildren];
          const childResults = await Promise.race([
            Promise.all(children.map((child) => terminateMediaChild(child, {
              graceMs: dependencies.childKillGraceMs ?? ASR_LIMITS.childKillGraceMs,
              setTimeoutImpl,
            }))),
            deadline.then(() => { throw contractError("ASR_TIMEOUT", 504, "ASR shutdown timed out"); }),
          ]);
          if (childResults.some((terminated) => terminated !== true)) {
            mediaChildTerminationFailed = true;
            for (let index = 0; index < children.length; index += 1) {
              if (childResults[index] !== true) markMediaChildFailure(children[index]);
            }
          } else {
            await waitPhase(Promise.all(children.map((child) => (
              activeMediaChildClosures.get(child) ?? Promise.resolve()
            ))));
          }
        }
        if (mediaChildTerminationFailed || activeMediaChildren.size !== 0) {
          throw contractError("ASR_CLEANUP_FAILED", 503, "ASR media child cleanup failed");
        }
        try {
          let finalSweep;
          try {
            finalSweep = await Promise.race([
              sweepImpl(runtime.tempRoot, {
                fsImpl,
                currentUid,
                mode: "startup",
                now,
                cleanupOptions: dependencies.cleanupOptions,
                createIfMissing: false,
              }),
              deadline.then(() => { throw contractError("ASR_TIMEOUT", 504, "ASR shutdown timed out"); }),
            ]);
          } catch (error) {
            if (error?.code === "ENOENT") {
              confirmedStaleWorkspacePaths.clear();
              metrics.setStaleTempDirectories(0);
              finalSweep = null;
            } else {
              throw error;
            }
          }
          if (finalSweep) {
            const sweepReady = await applySweepResult(finalSweep);
            if (!sweepReady) {
              throw contractError("ASR_CLEANUP_FAILED", 503, "ASR shutdown cleanup failed");
            }
          }
          if (resourceCleanupFailed || lateWorkspaceCleanupFailed || unreadBodyTerminationFailed) {
            throw contractError("ASR_CLEANUP_FAILED", 503, "ASR lifecycle cleanup failed");
          }
        } catch (error) {
          if (error instanceof AsrContractError) throw error;
          degradedCode = "ASR_CLEANUP_DEGRADED";
          metrics.recordCleanupFailure();
          throw contractError("ASR_CLEANUP_FAILED", 503, "ASR shutdown cleanup failed");
        }
      } finally {
        clearTimeoutImpl(closeTimer);
      }
    })();
    return closePromise;
  }

  return Object.freeze({
    initialize,
    readiness,
    transcribe,
    close,
    metrics: Object.freeze({ snapshot: () => metrics.snapshot() }),
    capacitySnapshot() {
      return Object.freeze({
        uploads: uploadCapacity.snapshot(),
        processing: processingCapacity.snapshot(),
        idempotency: idempotency.snapshot(),
      });
    },
    lifecycleSnapshot() {
      return Object.freeze({
        accepting,
        initialized,
        activeRequests: activeRequests.size,
        activeControllers: activeControllers.size,
        activeMediaChildren: activeMediaChildren.size,
        pendingWorkspaceLifecycles: pendingWorkspaceLifecycles.size,
        pendingResourceLifecycles: pendingResourceLifecycles.size,
        mediaChildTerminationFailed,
        resourceCleanupFailed,
        lateWorkspaceCleanupFailed,
        unreadBodyTerminationFailed,
        intervalActive: sweepTimer !== null,
        periodicSweepActive: periodicSweepPromise !== null,
        closing: closePromise !== null,
      });
    },
  });
}
