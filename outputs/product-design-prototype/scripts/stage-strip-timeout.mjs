export const DEFAULT_STAGE_STRIP_BROWSER_TIMEOUT_MS = 60_000;
const MIN_STAGE_STRIP_BROWSER_TIMEOUT_MS = 1_000;
const MAX_STAGE_STRIP_BROWSER_TIMEOUT_MS = 120_000;

export function waitForChildProcess(child, { timeoutMs, terminate, cleanup, successSignal }) {
  return new Promise((resolveCompletion, rejectCompletion) => {
    let settled = false;
    let timeout;
    const ignoreLateError = () => {};

    async function finish({ code, error, shouldTerminate = false }) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("close", handleClose);
      child.off("error", handleError);
      child.on("error", ignoreLateError);

      let finalError = error;
      if (shouldTerminate) {
        try {
          await terminate();
        } catch (terminationError) {
          finalError ??= terminationError;
        }
      }

      try {
        await cleanup();
      } catch (cleanupError) {
        finalError ??= cleanupError;
      }

      if (finalError) rejectCompletion(finalError);
      else resolveCompletion(code);
    }

    function handleClose(code) {
      queueMicrotask(() => {
        void finish({ code });
      });
    }

    function handleError(error) {
      queueMicrotask(() => {
        void finish({ error, shouldTerminate: true });
      });
    }

    child.once("close", handleClose);
    child.once("error", handleError);
    successSignal?.then(
      () => {
        void finish({ code: 0, shouldTerminate: true });
      },
      (error) => {
        void finish({ error, shouldTerminate: true });
      },
    );
    timeout = setTimeout(() => {
      void finish({
        error: new Error(`Headless browser timed out after ${timeoutMs} ms`),
        shouldTerminate: true,
      });
    }, timeoutMs);
  });
}

export function resolveStageStripBrowserTimeoutMs(environment = process.env) {
  const raw = environment?.STAGE_STRIP_BROWSER_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_STAGE_STRIP_BROWSER_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value)
    || value < MIN_STAGE_STRIP_BROWSER_TIMEOUT_MS
    || value > MAX_STAGE_STRIP_BROWSER_TIMEOUT_MS
  ) {
    throw new RangeError(
      `STAGE_STRIP_BROWSER_TIMEOUT_MS must be an integer between ${MIN_STAGE_STRIP_BROWSER_TIMEOUT_MS} and ${MAX_STAGE_STRIP_BROWSER_TIMEOUT_MS} milliseconds`,
    );
  }
  return value;
}
