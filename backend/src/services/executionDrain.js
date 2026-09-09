export function createExecutionDrain() {
  const pending = new Set();
  let paused = false;
  function run(work) {
    if (paused) return Promise.reject(Object.assign(new Error("background execution is draining"), { code: "BACKGROUND_DRAINING" }));
    let operation;
    try { operation = Promise.resolve(work()); } catch (error) { return Promise.reject(error); }
    pending.add(operation);
    const cleanup = () => pending.delete(operation);
    operation.then(cleanup, cleanup);
    return operation;
  }
  async function drain({ timeoutMs = 180_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) throw new TypeError("invalid drain timeout");
    paused = true;
    let timeout;
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Object.assign(new Error("background drain timed out"), { code: "BACKGROUND_DRAIN_TIMEOUT" })), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  return { run, drain, status: () => ({ paused, pending: pending.size }) };
}
