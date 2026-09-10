import Ajv from "ajv";
import { AiPlatformError } from "../errors.js";
import { stableJson } from "../../../shared/aiPlatformContract.mjs";

const cache = new Map();
const UNSUPPORTED = new Set(["$ref", "$dynamicRef", "$recursiveRef", "$async", "$data", "pattern", "patternProperties"]);

export function compileAgentSchema(schema = {}) {
  const key = stableJson(schema);
  if (Buffer.byteLength(key) > 32 * 1024) throw new AiPlatformError("Agent schema is too large", { code: "agent_schema_invalid", status: 422 });
  let nodes = 0;
  function inspect(value, depth = 0) {
    if (++nodes > 2000 || depth > 20) throw new Error("schema complexity limit");
    if (!value || typeof value !== "object") return;
    for (const [name, child] of Object.entries(value)) {
      if (UNSUPPORTED.has(name)) throw new Error("unsupported schema execution feature");
      inspect(child, depth + 1);
    }
  }
  if (cache.has(key)) return cache.get(key);
  try {
    inspect(schema);
    const ajv = new Ajv({ strict: true, strictRequired: false, validateFormats: false, ownProperties: true, allErrors: false });
    const validate = ajv.compile(schema);
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(key, validate);
    return validate;
  } catch {
    throw new AiPlatformError("Agent schema is invalid or unsupported", { code: "agent_schema_invalid", status: 422 });
  }
}

export function assertAgentSchema(value, schema, kind) {
  const validate = compileAgentSchema(schema);
  if (!validate(value)) throw new AiPlatformError("AI task does not satisfy its pinned schema", {
    code: kind === "input" ? "task_input_invalid" : "invalid_result",
    status: kind === "input" ? 422 : 502,
  });
}
