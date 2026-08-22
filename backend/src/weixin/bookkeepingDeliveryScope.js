import { createHash } from "node:crypto";

function identityText(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

export function shortcutBookkeepingConversationId(ownerValue, senderIdValue) {
  const owner = identityText(ownerValue, "owner");
  const senderId = identityText(senderIdValue, "senderId");
  const digest = createHash("sha256")
    .update(`${owner}\u0000${senderId}`, "utf8")
    .digest("hex");
  return `weixin:shortcut:v1:${digest}`;
}

export function isShortcutBookkeepingDeliveryScope(item, { owner, senderId } = {}) {
  if (!item || typeof item !== "object") return false;
  try {
    return item.owner === identityText(owner, "owner")
      && item.deliveryScope === shortcutBookkeepingConversationId(owner, senderId);
  } catch {
    return false;
  }
}
