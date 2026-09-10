import { AI_TASK_TYPES, sha256 } from "../../../shared/aiPlatformContract.mjs";

export function normalizeAiRoutingPolicy(value) {
  if (value === undefined || value === null || value === "") return null;
  let input = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 32 * 1024) throw new Error("AI_PLATFORM_ROUTING_POLICY is too large");
    try { input = JSON.parse(value); } catch { throw new Error("AI_PLATFORM_ROUTING_POLICY must be JSON"); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["version", "phase", "owners", "taskTypes"].includes(key))
    || typeof input.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/u.test(input.version)
    || !["legacy", "canary", "platform"].includes(input.phase)
    || !Array.isArray(input.owners) || input.owners.length > 100
    || input.owners.some((owner) => typeof owner !== "string" || owner !== owner.trim() || !owner || owner.length > 200 || /[\u0000-\u001f\u007f]/u.test(owner))
    || !Array.isArray(input.taskTypes) || input.taskTypes.length > AI_TASK_TYPES.length
    || input.taskTypes.some((type) => !AI_TASK_TYPES.includes(type))
    || (input.phase === "canary" && (!input.owners.length || !input.taskTypes.length || input.taskTypes.includes("asr.transcribe")))
    || (input.phase !== "canary" && (input.owners.length || input.taskTypes.length))) {
    throw new Error("AI_PLATFORM_ROUTING_POLICY is invalid");
  }
  return Object.freeze({
    version: input.version, phase: input.phase,
    owners: Object.freeze([...new Set(input.owners)].sort()),
    taskTypes: Object.freeze([...new Set(input.taskTypes)].sort()),
  });
}

export function usesPlatformForTask(config, { taskType, owner }) {
  if (config.aiPlatformMode === "disabled") return false;
  const policy = config.aiPlatformRoutingPolicy;
  if (!policy || policy.phase === "platform") return true;
  if (policy.phase === "legacy") return false;
  return policy.taskTypes.includes(taskType) && policy.owners.includes(owner);
}

export function configForAiTask(config, scope) {
  return usesPlatformForTask(config, scope) ? config : { ...config, aiPlatformMode: "disabled" };
}

export function routingPolicyStatus(config) {
  return {
    phase: config.aiPlatformRoutingPolicy?.phase ?? (config.aiPlatformMode === "disabled" ? "legacy" : "platform"),
    digest: config.aiPlatformRoutingPolicy ? sha256(config.aiPlatformRoutingPolicy) : null,
  };
}
