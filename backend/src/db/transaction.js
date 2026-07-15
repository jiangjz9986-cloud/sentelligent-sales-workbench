function isThenable(value) {
  return value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function";
}

export function withImmediateTransaction(db, work) {
  if (!db || typeof db.exec !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
  if (typeof work !== "function") {
    throw new TypeError("Transaction work must be a function");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    if (isThenable(result)) {
      throw new TypeError("Transaction work must be synchronous and must not return a Promise or thenable");
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      if (error instanceof Error) {
        try {
          Object.defineProperty(error, "rollbackError", {
            value: rollbackError,
            configurable: true,
          });
        } catch {
          // Preserve the original error even when it cannot be extended.
        }
      }
    }
    throw error;
  }
}
