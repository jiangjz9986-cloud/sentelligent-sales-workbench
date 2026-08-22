const STATUS_VALUES = new Set(["ready", "not_ready"]);

function nowMs(clock) {
  const value = clock();
  const numeric = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new TypeError("clock must return a valid time");
  return numeric;
}

function reasonText(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{1,64}$/u.test(normalized)) return "status_unspecified";
  return normalized;
}

export function createWeixinDeliveryReadiness({
  clock = Date.now,
  staleMs = 30_000,
} = {}) {
  if (typeof clock !== "function") throw new TypeError("clock is required");
  if (!Number.isSafeInteger(staleMs) || staleMs < 1_000 || staleMs > 10 * 60_000) {
    throw new TypeError("staleMs is invalid");
  }
  let current = null;

  function report({ status, reason = null } = {}) {
    if (!STATUS_VALUES.has(status)) throw new TypeError("delivery status is invalid");
    const reportedAtMs = nowMs(clock);
    current = {
      status,
      reason: status === "ready" ? null : reasonText(reason),
      reportedAtMs,
    };
    return snapshot();
  }

  function snapshot() {
    const currentTimeMs = nowMs(clock);
    if (!current || currentTimeMs - current.reportedAtMs > staleMs) {
      return Object.freeze({ status: "not_ready", reason: "worker_unavailable" });
    }
    return Object.freeze({
      status: current.status,
      ...(current.reason ? { reason: current.reason } : {}),
      reportedAt: new Date(current.reportedAtMs).toISOString(),
    });
  }

  return Object.freeze({ report, snapshot });
}
