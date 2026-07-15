export const AUTH_SESSION_STORAGE_KEY = "sentelligent.salesWorkbench.login";
export const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createAuthSession({ account, displayName, token, expiresAt, now = Date.now() }) {
  const normalizedAccount = String(account ?? "").trim();
  const localExpiresAt = now + AUTH_SESSION_TTL_MS;
  const issuedExpiresAt = Number.isFinite(expiresAt) ? expiresAt : localExpiresAt;
  return {
    account: normalizedAccount,
    displayName: String(displayName ?? normalizedAccount).trim() || normalizedAccount,
    token: String(token ?? ""),
    createdAt: now,
    expiresAt: Math.min(issuedExpiresAt, localExpiresAt),
  };
}

export function writeCachedAuthSession(storage, session) {
  storage?.setItem?.(AUTH_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearCachedAuthSession(storage) {
  storage?.removeItem?.(AUTH_SESSION_STORAGE_KEY);
}

export function readCachedAuthSession(storage, now = Date.now()) {
  const raw = storage?.getItem?.(AUTH_SESSION_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid session");
    if (!parsed.account || !parsed.token || !Number.isFinite(parsed.expiresAt)) throw new Error("Invalid session");
    if (parsed.expiresAt <= now) {
      clearCachedAuthSession(storage);
      return null;
    }
    return parsed;
  } catch {
    clearCachedAuthSession(storage);
    return null;
  }
}
