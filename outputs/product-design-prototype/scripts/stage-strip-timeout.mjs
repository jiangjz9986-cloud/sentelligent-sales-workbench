export const DEFAULT_STAGE_STRIP_BROWSER_TIMEOUT_MS = 60_000;
const MIN_STAGE_STRIP_BROWSER_TIMEOUT_MS = 1_000;
const MAX_STAGE_STRIP_BROWSER_TIMEOUT_MS = 120_000;

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
