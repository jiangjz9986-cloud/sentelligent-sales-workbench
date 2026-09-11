import { createHash } from "node:crypto";
import { posix } from "node:path";

export const PRODUCTION_ROOT = "/opt/sentelligent-sales-workbench";
export const PLATFORM_SERVICE = "sentelligent-ai-platform.service";
export const PLATFORM_DATABASE = "/var/lib/sentelligent-ai-platform/ai-platform.sqlite";
export const PLATFORM_USER = "sentai";
// The platform never joins the business service group.  This dedicated group
// is the only shared boundary needed for Backend -> AI Platform socket access.
export const PLATFORM_SOCKET_GROUP = "sentelligent-ai";
export const PROJECT_NODE = PRODUCTION_ROOT + "/runtime/node-v24/bin/node";
export const PROTECTED_UNITS = ["sentelligent-caddy.service", "qingyang-store.service"];
export const CORE_UNITS = ["sentelligent-backend.service", "sentelligent-frontend.service", "sentelligent-weixin-agent.service"];
export const PLATFORM_ENV = PRODUCTION_ROOT + "/config/ai-platform.env";
export const BUSINESS_ENV = PRODUCTION_ROOT + "/config/backend.env";
export const BUSINESS_DATABASE = "/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite";
export const WEIXIN_SESSION = PRODUCTION_ROOT + "/weixin-session";
export const ROLLOUT_PHASES = Object.freeze(["P1", "P2", "P3", "P4", "P5", "P6"]);
export const AI_PREFLIGHT_CHECKS = Object.freeze([
  "host.identity", "release.archive", "environment.binding", "supplier.acceptance",
  "resources.acceptance", "platform.service", "platform.database", "platform.runtime", "core.preflight",
]);

const ROLLOUT_PHASE_ORDER = Object.freeze(Object.fromEntries(ROLLOUT_PHASES.map((phase, index) => [phase, index + 1])));

export function normalizeRolloutPhase(value) {
  if (typeof value !== "string" || !ROLLOUT_PHASES.includes(value)) throw new Error("invalid rollout phase");
  return value;
}

export function rolloutPhaseForManifest(manifest) {
  if (manifest?.rolloutPhase) return normalizeRolloutPhase(manifest.rolloutPhase);
  if (manifest?.phase === "platform") return "P6";
  if (manifest?.phase === "canary") return "P3";
  return "P1";
}

export function routingPhaseForRollout(value) {
  const phase = normalizeRolloutPhase(value);
  return phase === "P6" ? "platform" : phase === "P1" || phase === "P2" ? "legacy" : "canary";
}

export function compareRolloutPhase(left, right) {
  const leftOrder = ROLLOUT_PHASE_ORDER[normalizeRolloutPhase(left)];
  const rightOrder = ROLLOUT_PHASE_ORDER[normalizeRolloutPhase(right)];
  return Math.sign(leftOrder - rightOrder);
}

export function transitionIdentityDigest(manifest) {
  return hashBytes(JSON.stringify({
    schemaVersion: manifest.schemaVersion, id: manifest.id, hostname: manifest.hostname,
    machineId: manifest.machineId, oldRelease: manifest.oldRelease, oldCommit: manifest.oldCommit,
    newRelease: manifest.newRelease, newCommit: manifest.newCommit, newArchive: manifest.newArchive,
    newArchiveSha256: manifest.newArchiveSha256, evidenceDir: manifest.evidenceDir, backupDir: manifest.backupDir,
  }));
}

export function hashBytes(value) { return createHash("sha256").update(value).digest("hex"); }
export function requireDigest(value, name, length = 64) {
  if (typeof value !== "string" || !new RegExp("^[0-9a-f]{" + length + "}$").test(value)) throw new Error(name + " must be an exact digest");
  return value;
}
export function controlledPath(value, root, name) {
  if (typeof value !== "string" || value !== posix.normalize(value) || !value.startsWith(root + "/")
    || !/^[A-Za-z0-9_./-]+$/u.test(value) || value.split("/").includes("..")) throw new Error(name + " must be a canonical controlled path");
  return value;
}
export function releasePath(value) {
  controlledPath(value, PRODUCTION_ROOT + "/releases", "release");
  if (posix.dirname(value) !== PRODUCTION_ROOT + "/releases") throw new Error("release must be immutable and directly under releases");
  return value;
}

export function platformStaticDirectoryForRelease(release) {
  releasePath(release);
  return release + "/outputs/ai-platform-admin";
}

export function validateTransitionManifest(input) {
  const allowed = ["schemaVersion", "id", "hostname", "machineId", "oldRelease", "oldCommit", "newRelease", "newCommit", "newArchive", "newArchiveSha256", "evidenceDir", "backupDir", "platformEnvCandidate", "backendEnvCandidate", "platformEnvSha256", "backendEnvSha256", "corePreflight", "corePreflightSha256", "policyFile", "policySha256", "qualityReport", "qualityReportSha256", "phase", "rolloutPhase"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))
    || input.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(input.id)
    || !/^[A-Za-z0-9.-]{1,253}$/u.test(input.hostname)
    || !/^[0-9a-f]{32}$/u.test(input.machineId)
    || !["legacy", "canary", "platform"].includes(input.phase)) throw new Error("invalid transition manifest");
  if (input.rolloutPhase !== undefined) normalizeRolloutPhase(input.rolloutPhase);
  const rolloutPhase = rolloutPhaseForManifest(input);
  if (routingPhaseForRollout(rolloutPhase) !== input.phase && !(input.phase === "legacy" && ["P1", "P2"].includes(rolloutPhase))) {
    throw new Error("rollout and routing phases do not match");
  }
  releasePath(input.oldRelease); releasePath(input.newRelease);
  if (input.oldRelease === input.newRelease) throw new Error("new and old releases must differ");
  requireDigest(input.oldCommit, "oldCommit", 40); requireDigest(input.newCommit, "newCommit", 40);
  controlledPath(input.evidenceDir, PRODUCTION_ROOT + "/evidence", "evidenceDir");
  controlledPath(input.backupDir, PRODUCTION_ROOT + "/backups", "backupDir");
  for (const field of ["platformEnvCandidate", "backendEnvCandidate", "corePreflight", "policyFile", "newArchive", "qualityReport"]) {
    controlledPath(input[field], input.evidenceDir, field);
  }
  for (const field of ["platformEnvSha256", "backendEnvSha256", "corePreflightSha256", "policySha256", "newArchiveSha256", "qualityReportSha256"]) requireDigest(input[field], field);
  return Object.freeze({ ...input, rolloutPhase });
}

export function renderPlatformUnit(template, release, { serviceGroup = PLATFORM_SOCKET_GROUP } = {}) {
  releasePath(release);
  if (typeof serviceGroup !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(serviceGroup)) {
    throw new Error("invalid platform service group");
  }
  const substitutions = {
    PROJECT_ROOT: release, NODE_BIN: PROJECT_NODE,
    SERVICE_USER: PLATFORM_USER, SERVICE_GROUP: serviceGroup,
    RUNTIME_DIR: "/run/sentelligent-ai-platform", DATABASE_DIR: "/var/lib/sentelligent-ai-platform",
  };
  const result = template.replace(/@([A-Z_]+)@/gu, (_match, key) => {
    if (!Object.hasOwn(substitutions, key)) throw new Error("unknown systemd template placeholder");
    return substitutions[key];
  });
  if (!result.includes("Type=simple") || !result.includes("KillMode=control-group")
    || result.includes("ReadWritePaths=") || result.includes("/current/")) throw new Error("invalid platform unit");
  return result;
}
