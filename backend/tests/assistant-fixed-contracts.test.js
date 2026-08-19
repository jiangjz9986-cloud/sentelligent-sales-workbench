import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAgentManifestRegistry } from "../src/assistant/agentManifest.js";
import { createAgentRegistry } from "../src/assistant/agentRegistry.js";
import { createAssistantToolHandlers } from "../src/assistant/runtimeHandlers.js";
import { createAssistantSessionRepository } from "../src/assistant/sessionRepository.js";

const ASSISTANT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/assistant");

function adapterFile(agentId) {
  const stem = agentId.split("-").map((part, index) => index === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`).join("");
  return join(ASSISTANT_DIR, `${stem}AssistantAdapter.js`);
}

describe("fixed assistant contract wiring", () => {
  it("keeps active manifests, adapters, tool definitions, and runtime handlers aligned", () => {
    const agentRegistry = createAgentRegistry();
    const manifestRegistry = createAgentManifestRegistry({ registry: agentRegistry });
    const db = openDatabase({ databaseUrl: ":memory:" });
    try {
      const sessions = createAssistantSessionRepository(db);
      const handlers = createAssistantToolHandlers({
        db,
        config: { aiAnalysisMode: "mock" },
        sessionRepository: sessions,
      });
      const manifests = manifestRegistry.list();
      const activeWithTools = manifests.filter((manifest) => manifest.lifecycle === "active" && manifest.tools.length > 0);

      for (const manifest of activeWithTools) {
        assert.equal(existsSync(adapterFile(manifest.id)), true, `${manifest.id} adapter module`);
        for (const toolName of manifest.tools) {
          const tool = agentRegistry.getTool(toolName);
          assert.ok(tool, `${manifest.id} tool definition ${toolName}`);
          assert.equal(tool.agentId, manifest.id, `${toolName} owner`);
          assert.equal(typeof handlers[toolName], "function", `${toolName} runtime handler`);
        }
      }

      for (const manifest of manifests.filter((item) => item.lifecycle !== "active")) {
        assert.deepEqual(manifest.tools, [], `${manifest.id} must not expose tools while ${manifest.lifecycle}`);
      }

      for (const [handlerName, handler] of Object.entries(handlers)) {
        assert.equal(typeof handler, "function", `${handlerName} handler`);
        const tool = agentRegistry.getTool(handlerName);
        assert.ok(tool, `${handlerName} must have a tool definition`);
        assert.equal(manifestRegistry.get(tool.agentId).lifecycle, "active", `${handlerName} agent lifecycle`);
      }
    } finally {
      db.close();
    }
  });
});
