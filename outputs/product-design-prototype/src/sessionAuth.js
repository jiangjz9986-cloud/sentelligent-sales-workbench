export const AUTH_SESSION_STORAGE_KEY = "sentelligent.salesWorkbench.login";

export function clearLegacyAuthSession(storage) {
  storage?.removeItem?.(AUTH_SESSION_STORAGE_KEY);
}

export function createDisplaySession({ account, displayName, expiresAt } = {}) {
  const normalizedAccount = String(account ?? "").trim();
  const normalizedDisplayName = String(displayName ?? "").trim() || normalizedAccount;
  const normalizedExpiresAt = new Date(String(expiresAt ?? "")).toISOString();

  return {
    account: normalizedAccount,
    displayName: normalizedDisplayName,
    expiresAt: normalizedExpiresAt,
  };
}
