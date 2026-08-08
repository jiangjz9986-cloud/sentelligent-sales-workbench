const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL_IDENTIFIER = /^[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/;

// These fields are deliberately never accepted from model-produced arguments.
const FORBIDDEN_KEYS = new Set([
  "owner", "actor", "token", "authorization", "url", "uri", "httpmethod",
  "method", "headers", "sql", "querysql", "filepath", "file_path", "path",
  "absolutepath", "workingdirectory", "command", "shell", "database",
  "__proto__", "prototype", "constructor",
]);

export class AssistantContractError extends Error {
  constructor(message, code = "invalid_contract") {
    super(message);
    this.name = "AssistantContractError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function looksLikePath(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return /^(?:[a-z]:[\\/]|\\\\|\/|\.\.?(?:[\\/]|$))/.test(text)
    || /[\\/]\.\.?[\\/]/.test(text)
    || /(?:^|[\\/])[^\\/]+\.(?:pdf|png|jpe?g|webp|csv|xlsx?)$/i.test(text);
}

function inspectArguments(value, location = "arguments") {
  if (typeof value === "string") {
    if (looksLikePath(value)) throw new AssistantContractError(`${location} contains an unsafe path value`, "unsafe_path");
    return value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item, index) => inspectArguments(item, `${location}[${index}]`));
  if (!isPlainObject(value)) throw new AssistantContractError(`${location} must be JSON data`, "invalid_arguments");

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/[\s-]/g, "").toLowerCase();
    if (FORBIDDEN_KEYS.has(normalizedKey) || /(?:^|_)(?:owner|actor|token|url|uri|sql|path|command|shell|database)(?:$|_)/i.test(key)) {
      throw new AssistantContractError(`${location}.${key} is not model-controlled`, "forbidden_field");
    }
    result[key] = inspectArguments(item, `${location}.${key}`);
  }
  return result;
}

export function validateAgentId(value) {
  const id = String(value ?? "").trim();
  if (!IDENTIFIER.test(id)) throw new AssistantContractError("agentId is invalid", "invalid_agent_id");
  return id;
}

export function validateToolName(value) {
  const name = String(value ?? "").trim();
  if (!TOOL_IDENTIFIER.test(name)) throw new AssistantContractError("toolName is invalid", "invalid_tool_name");
  return name;
}

export function validateToolInvocation(input) {
  if (!isPlainObject(input)) throw new AssistantContractError("tool invocation must be an object", "invalid_contract");
  const keys = Object.keys(input);
  for (const key of keys) {
    if (!["agentId", "toolName", "arguments"].includes(key)) {
      throw new AssistantContractError(`unexpected invocation field: ${key}`, "forbidden_field");
    }
  }
  const agentId = validateAgentId(input.agentId);
  const toolName = validateToolName(input.toolName);
  const argumentsValue = input.arguments === undefined ? {} : input.arguments;
  if (!isPlainObject(argumentsValue)) throw new AssistantContractError("arguments must be a plain object", "invalid_arguments");
  return { agentId, toolName, arguments: inspectArguments(argumentsValue) };
}

export const validateAssistantRequest = validateToolInvocation;
export const isSafeArgumentValue = (value) => {
  try { inspectArguments(value); return true; } catch { return false; }
};
