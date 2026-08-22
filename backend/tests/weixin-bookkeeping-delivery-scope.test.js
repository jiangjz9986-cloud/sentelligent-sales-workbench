import assert from "node:assert/strict";
import test from "node:test";

import {
  isShortcutBookkeepingDeliveryScope,
  shortcutBookkeepingConversationId,
} from "../src/weixin/bookkeepingDeliveryScope.js";

test("Shortcut Weixin delivery scope is deterministic and owner-bound", () => {
  const deliveryScope = shortcutBookkeepingConversationId("owner-a", "sender-a");
  assert.match(deliveryScope, /^weixin:shortcut:v1:[0-9a-f]{64}$/u);
  assert.equal(
    isShortcutBookkeepingDeliveryScope(
      { owner: "owner-a", deliveryScope },
      { owner: "owner-a", senderId: "sender-a" },
    ),
    true,
  );
  assert.equal(
    isShortcutBookkeepingDeliveryScope(
      { owner: "owner-b", deliveryScope },
      { owner: "owner-a", senderId: "sender-a" },
    ),
    false,
  );
  assert.equal(
    isShortcutBookkeepingDeliveryScope(
      { owner: "owner-a", deliveryScope },
      { owner: "owner-a", senderId: "sender-b" },
    ),
    false,
  );
});
