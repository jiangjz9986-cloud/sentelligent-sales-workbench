import { validateToolName } from "./contracts.js";
import { TOOL_DEFINITIONS } from "./agentRegistry.js";

export { TOOL_DEFINITIONS };

export function createToolRegistry({ tools = TOOL_DEFINITIONS } = {}) {
  const map = new Map(tools.map((entry) => [validateToolName(entry.name), Object.freeze({ ...entry })]));
  return Object.freeze({
    listTools: () => [...map.values()],
    getTool: (name) => map.get(name) ?? null,
  });
}
