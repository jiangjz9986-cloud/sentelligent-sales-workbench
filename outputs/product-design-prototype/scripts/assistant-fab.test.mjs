import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { readAppSource } from "./app-source.mjs";

const root = resolve(".");
const appSource = readAppSource(root);
const panelSource = readFileSync(resolve("src/components/assistant/AssistantChatPanel.jsx"), "utf8");

describe("assistant entry points", () => {
  it("renders desktop assistant fab when mobile shell is off", () => {
    assert.match(appSource, /data-testid="assistant-fab"/);
    assert.match(appSource, /!mobileShell \? \(/);
  });

  it("renders mobile topbar assistant button", () => {
    assert.match(appSource, /data-testid="assistant-topbar-button"/);
    assert.match(appSource, /mobileShell \? \(/);
  });

  it("wires the more drawer assistant backup entry", () => {
    assert.match(appSource, /onOpenAssistant=\{assistantChat\.openChat\}/);
    const drawer = readFileSync(resolve("src/components/MobileMoreDrawer.jsx"), "utf8");
    assert.match(drawer, /assistant-chat/);
    assert.match(drawer, /onOpenAssistant/);
  });

  it("supports enter to send and escape to close in the chat panel", () => {
    assert.match(panelSource, /event\.key === "Enter"/);
    assert.match(panelSource, /event\.key === "Escape"/);
    assert.match(panelSource, /role="dialog"/);
  });
});
