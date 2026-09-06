const MAX_OWNER_LENGTH = 200;

function normalizeOwner(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_OWNER_LENGTH
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) return "";
  return normalized;
}

/**
 * Resolve an account to the business owner stored on sales records. The
 * mapping is deliberately exact and closed (v0.9.3: backed by the live
 * weixin_bindings table instead of a configured single owner): an account
 * without an active binding resolves to null and never falls back to a
 * global/all-owner query.
 */
export function createBusinessOwnerResolver({ hasActiveBinding } = {}) {
  if (typeof hasActiveBinding !== "function") {
    throw new TypeError("hasActiveBinding must be a function");
  }
  return (account) => {
    const normalizedAccount = normalizeOwner(account);
    if (!normalizedAccount || hasActiveBinding(normalizedAccount) !== true) return null;
    return normalizedAccount;
  };
}

export function isValidBusinessOwner(value) {
  return Boolean(normalizeOwner(value));
}

export { MAX_OWNER_LENGTH, normalizeOwner };
