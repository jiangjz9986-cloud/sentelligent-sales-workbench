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
 * Resolve the authenticated WeChat machine identity to the business owner
 * stored on sales records. The mapping is deliberately exact and closed:
 * missing configuration or an unexpected account never falls back to a
 * global/all-owner query.
 */
export function createBusinessOwnerResolver({ businessOwner = "" } = {}) {
  const configuredOwner = normalizeOwner(businessOwner);
  return (account) => {
    const normalizedAccount = normalizeOwner(account);
    if (!configuredOwner || !normalizedAccount || normalizedAccount !== configuredOwner) return null;
    return configuredOwner;
  };
}

export function isValidBusinessOwner(value) {
  return Boolean(normalizeOwner(value));
}

export { MAX_OWNER_LENGTH, normalizeOwner };
