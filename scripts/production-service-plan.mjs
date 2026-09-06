import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validatePlannedCommands,
  validateProjectServices,
  validateServiceSnapshot,
  validatesUnrelatedProtection,
} from "./production-preflight.mjs";

export const PROJECT_ROOT = "/opt/sentelligent-sales-workbench";
export const EVIDENCE_ROOT = `${PROJECT_ROOT}/evidence`;
export const CURRENT_RELEASE_PATH = `${PROJECT_ROOT}/current`;
export const RELEASES_ROOT = `${PROJECT_ROOT}/releases`;
export const BACKEND_ENVIRONMENT_FILE = `${PROJECT_ROOT}/config/backend.env`;
export const FRONTEND_ENVIRONMENT_FILE = `${PROJECT_ROOT}/config/frontend.env`;
export const CADDY_CONFIG_PATH = "/etc/caddy/Caddyfile";
export const MACHINE_ID_PATH = "/etc/machine-id";

export const PROJECT_SERVICES = Object.freeze([
  "sentelligent-backend.service",
  "sentelligent-frontend.service",
  "sentelligent-caddy.service",
  "sentelligent-weixin-agent.service",
]);

// CodexAccountVault (codex-account-vault-cloud + codex-vault-mihomo, listener
// 4876) was retired by owner-approved surgery on 2026-08-28; the co-located
// inventory keeps only the Qingyang store.
export const PROTECTED_SERVICES = Object.freeze([
  Object.freeze({
    name: "qingyang-store.service",
    protectionId: "qingyang",
  }),
]);

export const PROTECTED_LISTENERS = Object.freeze([
  Object.freeze({
    port: 8797,
    owner: "qingyang",
    service: "qingyang-store.service",
  }),
]);

const PLANNED_ACTIONS = Object.freeze([
  Object.freeze({ action: "restart", service: "sentelligent-backend.service" }),
  Object.freeze({ action: "restart", service: "sentelligent-frontend.service" }),
  Object.freeze({ action: "restart", service: "sentelligent-weixin-agent.service" }),
  Object.freeze({ action: "status", service: "sentelligent-caddy.service" }),
]);

const EMPTY_SYSTEMD_ARRAY_FIELDS = Object.freeze([
  "ExecCondition",
  "ExecStartPre",
  "ExecStartPost",
  "ExecStop",
  "DropInPaths",
  "BindPaths",
  "BindReadOnlyPaths",
  "ReadWritePaths",
  "ReadOnlyPaths",
  "InaccessiblePaths",
  "ExecPaths",
  "NoExecPaths",
  "TemporaryFileSystem",
]);

const PROJECT_SYSTEMD_PROPERTIES = new Set([
  "Id",
  "FragmentPath",
  "ExecStart",
  "ExecReload",
  "User",
  "Group",
  "SupplementaryGroups",
  "DynamicUser",
  "WorkingDirectory",
  "Environment",
  "EnvironmentFile",
  "EnvironmentFiles",
  "RootDirectory",
  "RootImage",
  "ProtectSystem",
  "ProtectHome",
  "PrivateTmp",
  "PrivateDevices",
  "MainPID",
  "ActiveEnterTimestamp",
  ...EMPTY_SYSTEMD_ARRAY_FIELDS,
]);

const PROTECTED_SYSTEMD_PROPERTIES = new Set([
  "Id",
  "FragmentPath",
  "MainPID",
  "ActiveEnterTimestamp",
]);

const EXPECTED_ENVIRONMENT = Object.freeze({
  "sentelligent-backend.service": "",
  "sentelligent-frontend.service": "",
  "sentelligent-caddy.service":
    "HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/etc/caddy",
  "sentelligent-weixin-agent.service":
    `HOME=${PROJECT_ROOT}/weixin-session`,
});

const EXPECTED_ENVIRONMENT_FILE = Object.freeze({
  "sentelligent-backend.service": BACKEND_ENVIRONMENT_FILE,
  "sentelligent-frontend.service": FRONTEND_ENVIRONMENT_FILE,
  "sentelligent-caddy.service": "",
  "sentelligent-weixin-agent.service": BACKEND_ENVIRONMENT_FILE,
});

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9_.@-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MACHINE_ID_PATTERN = /^[a-f0-9]{32}$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const FORBIDDEN_OUTPUT_KEY = /(?:raw|dump|stdout|stderr|password|secret|token|cookie|api.?key)/i;

function genericFailure(label) {
  return new Error(`${label} could not be collected safely`);
}

function defaultCommandRunner(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      SYSTEMD_COLORS: "0",
      SYSTEMD_PAGER: "cat",
    },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("read-only command failed");
  }
  return result.stdout;
}

function runReadOnlyCommand(runner, command, args, label) {
  try {
    const output = runner(command, args);
    if (
      typeof output !== "string" ||
      Buffer.byteLength(output, "utf8") > MAX_COMMAND_OUTPUT_BYTES ||
      output.includes("\0")
    ) {
      throw new Error("invalid command output");
    }
    return output;
  } catch {
    throw genericFailure(label);
  }
}

function stableReadRegularFile(path, { maxBytes = MAX_EVIDENCE_FILE_BYTES } = {}) {
  const absolutePath = resolve(path);
  const lexical = lstatSync(absolutePath, { bigint: true });
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw new Error("evidence path is not a regular file");
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maxBytes)) {
      throw new Error("evidence file size is invalid");
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) {
      if (before[field] !== after[field]) {
        throw new Error("evidence file changed while reading");
      }
    }
    const lexicalAfter = lstatSync(absolutePath, { bigint: true });
    if (!lexicalAfter.isFile() || lexicalAfter.isSymbolicLink()) {
      throw new Error("evidence path changed while reading");
    }
    for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) {
      if (after[field] !== lexicalAfter[field]) {
        throw new Error("evidence path identity changed while reading");
      }
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function defaultFileHasher(path) {
  return createHash("sha256")
    .update(stableReadRegularFile(path))
    .digest("hex");
}

function defaultMachineIdReader() {
  return stableReadRegularFile(MACHINE_ID_PATH, { maxBytes: 256 })
    .toString("utf8")
    .trim()
    .toLowerCase();
}

function defaultCurrentReleaseResolver() {
  return realpathSync.native(CURRENT_RELEASE_PATH);
}

function parseSystemctlShow(output, serviceName, allowedProperties) {
  const properties = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw genericFailure(`${serviceName} systemd snapshot`);
    const name = line.slice(0, separator);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
      throw genericFailure(`${serviceName} systemd snapshot`);
    }
    if (!allowedProperties.has(name)) continue;
    const values = properties.get(name) ?? [];
    values.push(line.slice(separator + 1));
    properties.set(name, values);
  }

  const ids = properties.get("Id") ?? [];
  if (ids.length !== 1 || ids[0] !== serviceName) {
    throw genericFailure(`${serviceName} systemd identity`);
  }
  return properties;
}

function exactProperty(properties, name, label) {
  const values = properties.get(name) ?? [];
  if (values.length !== 1) throw genericFailure(label);
  return values[0];
}

function exactExpectedProperty(properties, name, expected, label) {
  const values = properties.get(name) ?? [];
  if (expected === "") {
    if (values.length > 1 || (values.length === 1 && values[0] !== "")) {
      throw genericFailure(label);
    }
    return "";
  }
  if (values.length !== 1 || values[0] !== expected) {
    throw genericFailure(label);
  }
  return expected;
}

function optionalProperty(properties, name, label) {
  const values = properties.get(name) ?? [];
  if (values.length > 1) throw genericFailure(label);
  return values[0] ?? "";
}

function normalizeStructuredCommand(value, label) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) {
    throw genericFailure(label);
  }
  if (!value.startsWith("{")) return value;
  if ((value.match(/\{ path=/g) ?? []).length !== 1) {
    throw genericFailure(label);
  }
  const match = value.match(
    /^\{ path=([^ ;]+) ; argv\[\]=([^;]+?) ; ignore_errors=no ; [^{}]*\}$/u,
  );
  if (!match) throw genericFailure(label);
  const executable = match[1];
  const command = match[2].trim();
  if (command !== executable && !command.startsWith(`${executable} `)) {
    throw genericFailure(label);
  }
  return command;
}

function normalizeTimestamp(value, label) {
  if (typeof value !== "string") throw genericFailure(label);
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed) && new Date(parsed).toISOString() === value) {
    return value;
  }

  const match = value.match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/u,
  );
  if (!match) throw genericFailure(label);
  const expectedPrefix = `${match[1]}T${match[2]}`;
  const normalized = new Date(`${expectedPrefix}Z`).toISOString();
  if (!normalized.startsWith(`${expectedPrefix}.`)) throw genericFailure(label);
  return normalized;
}

function parsePositivePid(value, label) {
  if (!/^[1-9][0-9]*$/.test(value)) throw genericFailure(label);
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw genericFailure(label);
  return pid;
}

function parseYesNo(value, label, { allowMissing = false } = {}) {
  if (allowMissing && value === "") return false;
  if (value === "yes") return true;
  if (value === "no") return false;
  throw genericFailure(label);
}

function parseSafeName(value, label, { allowEmpty = false } = {}) {
  if (allowEmpty && value === "") return "";
  if (!SAFE_NAME.test(value)) throw genericFailure(label);
  return value;
}

function parseSafeNameList(value, label) {
  if (value === "") return [];
  const values = value.split(/\s+/);
  if (values.length === 0 || values.some((entry) => !SAFE_NAME.test(entry))) {
    throw genericFailure(label);
  }
  return values;
}

function collectServiceState(runner, serviceName) {
  const active = runReadOnlyCommand(
    runner,
    "systemctl",
    ["is-active", serviceName],
    `${serviceName} active state`,
  ).trim();
  const enabled = runReadOnlyCommand(
    runner,
    "systemctl",
    ["is-enabled", serviceName],
    `${serviceName} enabled state`,
  ).trim();
  if (active !== "active" || enabled !== "enabled") {
    throw genericFailure(`${serviceName} readiness`);
  }
  return { active: true, enabled: true };
}

function expectedUnitPaths(serviceName) {
  return new Set([
    `/etc/systemd/system/${serviceName}`,
    `/lib/systemd/system/${serviceName}`,
    `/usr/lib/systemd/system/${serviceName}`,
  ]);
}

function validateUnitPath(value, serviceName) {
  if (!expectedUnitPaths(serviceName).has(value)) {
    throw genericFailure(`${serviceName} unit path`);
  }
  return value;
}

function normalizeEnvironment(properties, serviceName) {
  const expected = EXPECTED_ENVIRONMENT[serviceName];
  exactExpectedProperty(
    properties,
    "Environment",
    expected,
    `${serviceName} environment surface`,
  );
  return expected ? [expected] : [];
}

function normalizeEnvironmentFiles(properties, serviceName) {
  const values = [
    ...(properties.get("EnvironmentFiles") ?? []),
    ...(properties.get("EnvironmentFile") ?? []),
  ];
  const expectedPath = EXPECTED_ENVIRONMENT_FILE[serviceName];
  if (!expectedPath) {
    if (values.length > 1 || (values.length === 1 && values[0] !== "")) {
      throw genericFailure(`${serviceName} environment-file surface`);
    }
    return {
      EnvironmentFile: "",
      EnvironmentFiles: [],
    };
  }
  const expectedValue = `${expectedPath} (ignore_errors=no)`;
  if (values.length !== 1 || values[0] !== expectedValue) {
    throw genericFailure(`${serviceName} environment-file surface`);
  }
  return {
    EnvironmentFile: expectedPath,
    EnvironmentFiles: expectedPath ? [expectedPath] : [],
  };
}

function normalizeEmptyExecutionSurface(properties, serviceName) {
  return Object.fromEntries(
    EMPTY_SYSTEMD_ARRAY_FIELDS.map((field) => {
      const value = optionalProperty(
        properties,
        field,
        `${serviceName} ${field} surface`,
      );
      if (value !== "") throw genericFailure(`${serviceName} ${field} surface`);
      return [field, []];
    }),
  );
}

function collectProjectService(runner, serviceName) {
  const state = collectServiceState(runner, serviceName);
  const output = runReadOnlyCommand(
    runner,
    "systemctl",
    ["show", serviceName],
    `${serviceName} systemd snapshot`,
  );
  const properties = parseSystemctlShow(
    output,
    serviceName,
    PROJECT_SYSTEMD_PROPERTIES,
  );
  const fragmentPath = validateUnitPath(
    exactProperty(properties, "FragmentPath", `${serviceName} unit path`),
    serviceName,
  );
  const execStart = normalizeStructuredCommand(
    exactProperty(properties, "ExecStart", `${serviceName} ExecStart`),
    `${serviceName} ExecStart`,
  );
  const execReloadRaw = optionalProperty(
    properties,
    "ExecReload",
    `${serviceName} ExecReload`,
  );
  const execReload = serviceName === "sentelligent-caddy.service"
    ? [normalizeStructuredCommand(execReloadRaw, `${serviceName} ExecReload`)]
    : [];
  if (serviceName !== "sentelligent-caddy.service" && execReloadRaw !== "") {
    throw genericFailure(`${serviceName} ExecReload`);
  }

  const rootDirectory = optionalProperty(
    properties,
    "RootDirectory",
    `${serviceName} RootDirectory`,
  );
  const rootImage = optionalProperty(
    properties,
    "RootImage",
    `${serviceName} RootImage`,
  );
  if (rootDirectory !== "" || rootImage !== "") {
    throw genericFailure(`${serviceName} root isolation surface`);
  }

  const protectSystem = exactProperty(
    properties,
    "ProtectSystem",
    `${serviceName} ProtectSystem`,
  );
  const protectHome = exactProperty(
    properties,
    "ProtectHome",
    `${serviceName} ProtectHome`,
  );
  if (protectSystem !== "no" || protectHome !== "no") {
    throw genericFailure(`${serviceName} protection surface`);
  }

  const privateTmp = parseYesNo(
    exactProperty(properties, "PrivateTmp", `${serviceName} PrivateTmp`),
    `${serviceName} PrivateTmp`,
  );
  const privateDevices = parseYesNo(
    exactProperty(properties, "PrivateDevices", `${serviceName} PrivateDevices`),
    `${serviceName} PrivateDevices`,
  );
  if (
    privateTmp !== (serviceName !== "sentelligent-caddy.service") ||
    privateDevices !== false
  ) {
    throw genericFailure(`${serviceName} private namespace surface`);
  }

  const dynamicUser = parseYesNo(
    optionalProperty(properties, "DynamicUser", `${serviceName} DynamicUser`),
    `${serviceName} DynamicUser`,
    { allowMissing: true },
  );
  if (dynamicUser) throw genericFailure(`${serviceName} DynamicUser`);

  const environmentFiles = normalizeEnvironmentFiles(properties, serviceName);
  return {
    name: serviceName,
    ...state,
    mainPid: parsePositivePid(
      exactProperty(properties, "MainPID", `${serviceName} MainPID`),
      `${serviceName} MainPID`,
    ),
    activeEnterTimestamp: normalizeTimestamp(
      exactProperty(
        properties,
        "ActiveEnterTimestamp",
        `${serviceName} activation timestamp`,
      ),
      `${serviceName} activation timestamp`,
    ),
    FragmentPath: fragmentPath,
    ExecStart: execStart,
    User: parseSafeName(
      exactProperty(properties, "User", `${serviceName} User`),
      `${serviceName} User`,
    ),
    Group: parseSafeName(
      exactProperty(properties, "Group", `${serviceName} Group`),
      `${serviceName} Group`,
      { allowEmpty: true },
    ),
    SupplementaryGroups: parseSafeNameList(
      exactExpectedProperty(
        properties,
        "SupplementaryGroups",
        "",
        `${serviceName} SupplementaryGroups`,
      ),
      `${serviceName} SupplementaryGroups`,
    ),
    DynamicUser: false,
    WorkingDirectory: serviceName === "sentelligent-caddy.service"
      ? exactExpectedProperty(
          properties,
          "WorkingDirectory",
          "",
          `${serviceName} WorkingDirectory`,
        )
      : exactProperty(
          properties,
          "WorkingDirectory",
          `${serviceName} WorkingDirectory`,
        ),
    ...normalizeEmptyExecutionSurface(properties, serviceName),
    ExecReload: execReload,
    Environment: normalizeEnvironment(properties, serviceName),
    ...environmentFiles,
    RootDirectory: "",
    RootImage: "",
    ProtectSystem: "no",
    ProtectHome: "no",
    PrivateTmp: privateTmp,
    PrivateDevices: false,
  };
}

function collectProtectedService(runner, profile) {
  const state = collectServiceState(runner, profile.name);
  const output = runReadOnlyCommand(
    runner,
    "systemctl",
    ["show", profile.name],
    `${profile.name} systemd snapshot`,
  );
  const properties = parseSystemctlShow(
    output,
    profile.name,
    PROTECTED_SYSTEMD_PROPERTIES,
  );
  return {
    name: profile.name,
    protectionId: profile.protectionId,
    protected: true,
    ...state,
    mainPid: parsePositivePid(
      exactProperty(properties, "MainPID", `${profile.name} MainPID`),
      `${profile.name} MainPID`,
    ),
    activeEnterTimestamp: normalizeTimestamp(
      exactProperty(
        properties,
        "ActiveEnterTimestamp",
        `${profile.name} activation timestamp`,
      ),
      `${profile.name} activation timestamp`,
    ),
    FragmentPath: validateUnitPath(
      exactProperty(properties, "FragmentPath", `${profile.name} unit path`),
      profile.name,
    ),
  };
}

function listenerRowsForPort(output, port) {
  const suffix = new RegExp(`(?:^|[:\\]])${port}$`);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[0] === "LISTEN" && fields.some((field) => suffix.test(field));
    });
}

function collectProtectedListeners(runner, protectedServices) {
  const output = runReadOnlyCommand(
    runner,
    "ss",
    ["-H", "-ltnp"],
    "protected listener snapshot",
  );
  return PROTECTED_LISTENERS.map((profile) => {
    const service = protectedServices.find(
      (candidate) => candidate.name === profile.service,
    );
    if (!service) throw genericFailure(`listener ${profile.port} owner`);
    const rows = listenerRowsForPort(output, profile.port);
    if (rows.length === 0) throw genericFailure(`listener ${profile.port}`);
    const pids = new Set();
    for (const row of rows) {
      for (const match of row.matchAll(/pid=([1-9][0-9]*)/g)) {
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid)) {
          throw genericFailure(`listener ${profile.port} owner`);
        }
        pids.add(pid);
      }
    }
    if (pids.size !== 1 || !pids.has(service.mainPid)) {
      throw genericFailure(`listener ${profile.port} owner`);
    }
    return {
      port: profile.port,
      owner: profile.owner,
      service: profile.service,
      mainPid: service.mainPid,
      protected: true,
    };
  });
}

function normalizeCurrentReleasePath(value) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    /[\r\n\t]/.test(value)
  ) {
    throw genericFailure("current release identity");
  }
  const normalized = resolve(value);
  const prefix = `${RELEASES_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    throw genericFailure("current release identity");
  }
  const releaseId = normalized.slice(prefix.length);
  if (
    releaseId.includes(sep) ||
    releaseId.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)
  ) {
    throw genericFailure("current release identity");
  }
  return normalized;
}

function collectHostIdentity(hostnameReader, machineIdReader) {
  let hostname;
  let machineId;
  try {
    hostname = String(hostnameReader()).trim();
    machineId = String(machineIdReader()).trim().toLowerCase();
  } catch {
    throw genericFailure("host identity");
  }
  if (!HOSTNAME_PATTERN.test(hostname) || !MACHINE_ID_PATTERN.test(machineId)) {
    throw genericFailure("host identity");
  }
  return { hostname, machineId };
}

function collectSnapshotPass(runner) {
  const projectServices = PROJECT_SERVICES.map((serviceName) =>
    collectProjectService(runner, serviceName));
  const unrelatedServices = PROTECTED_SERVICES.map((profile) =>
    collectProtectedService(runner, profile));
  const listeners = collectProtectedListeners(runner, unrelatedServices);
  return { projectServices, unrelatedServices, listeners };
}

function hashEvidencePaths(paths, hashFile) {
  return Object.fromEntries(paths.map((path) => {
    let hash;
    try {
      hash = String(hashFile(path)).toLowerCase();
    } catch {
      throw genericFailure(`file evidence for ${basename(path)}`);
    }
    if (!SHA256_PATTERN.test(hash)) {
      throw genericFailure(`file evidence for ${basename(path)}`);
    }
    return [path, hash];
  }));
}

function attachHashes(snapshot, hashes) {
  const projectServices = snapshot.projectServices.map((service) => ({
    ...service,
    UnitFileSha256: hashes[service.FragmentPath],
    ...(service.EnvironmentFile
      ? { EnvironmentFileSha256: hashes[service.EnvironmentFile] }
      : {}),
    ...(service.name === "sentelligent-caddy.service"
      ? { CaddyConfigSha256: hashes[CADDY_CONFIG_PATH] }
      : {}),
  }));
  const unrelatedServices = snapshot.unrelatedServices.map((service) => ({
    ...service,
    UnitFileSha256: hashes[service.FragmentPath],
  }));
  return { ...snapshot, projectServices, unrelatedServices };
}

function assertNoSensitiveOutputKeys(value) {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSensitiveOutputKeys(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEY.test(key)) {
      throw new Error("Service plan contains a forbidden evidence field");
    }
    assertNoSensitiveOutputKeys(entry);
  }
}

function assertValidatorCompatibility(plan) {
  const hostIdentity = {
    hostname: plan.hostname,
    machineId: plan.machineId,
  };
  if (
    !validateServiceSnapshot(
      plan,
      plan.snapshotGeneratedAt,
      hostIdentity,
      hostIdentity,
    ) ||
    !validateProjectServices(plan) ||
    !validatePlannedCommands(plan) ||
    !validatesUnrelatedProtection(plan)
  ) {
    throw new Error("Generated service plan does not satisfy the production preflight contract");
  }
}

export function createProductionServicePlan({
  runner = defaultCommandRunner,
  hostnameReader = osHostname,
  machineIdReader = defaultMachineIdReader,
  hashFile = defaultFileHasher,
  currentReleaseResolver = defaultCurrentReleaseResolver,
  now = () => new Date(),
} = {}) {
  const hostBefore = collectHostIdentity(hostnameReader, machineIdReader);
  const currentBefore = normalizeCurrentReleasePath(currentReleaseResolver());
  const firstSnapshot = collectSnapshotPass(runner);
  const evidencePaths = [...new Set([
    CADDY_CONFIG_PATH,
    BACKEND_ENVIRONMENT_FILE,
    FRONTEND_ENVIRONMENT_FILE,
    ...firstSnapshot.projectServices.map((service) => service.FragmentPath),
    ...firstSnapshot.unrelatedServices.map((service) => service.FragmentPath),
  ])];
  const hashesBefore = hashEvidencePaths(evidencePaths, hashFile);
  const secondSnapshot = collectSnapshotPass(runner);
  const hashesAfter = hashEvidencePaths(evidencePaths, hashFile);
  if (JSON.stringify(firstSnapshot) !== JSON.stringify(secondSnapshot)) {
    throw new Error("Service state changed while collecting the production snapshot");
  }
  if (JSON.stringify(hashesBefore) !== JSON.stringify(hashesAfter)) {
    throw new Error("Service-plan file evidence changed while hashing");
  }

  const hostAfter = collectHostIdentity(hostnameReader, machineIdReader);
  const currentAfter = normalizeCurrentReleasePath(currentReleaseResolver());
  if (
    JSON.stringify(hostBefore) !== JSON.stringify(hostAfter) ||
    currentBefore !== currentAfter
  ) {
    throw new Error("Host or current release identity changed while collecting evidence");
  }

  const timestamp = now();
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
    throw new Error("Service-plan timestamp is invalid");
  }
  const snapshot = attachHashes(firstSnapshot, hashesBefore);
  const plan = {
    schemaVersion: 1,
    product: "sentelligent-sales-workbench",
    snapshotGeneratedAt: timestamp.toISOString(),
    hostname: hostBefore.hostname,
    machineId: hostBefore.machineId,
    machineIdSha256: createHash("sha256")
      .update(hostBefore.machineId, "utf8")
      .digest("hex"),
    projectPaths: [
      { path: PROJECT_ROOT, approved: true },
      { path: CURRENT_RELEASE_PATH, approved: true },
      { path: currentBefore, approved: true },
      { path: CADDY_CONFIG_PATH, approved: true },
    ],
    projectServices: snapshot.projectServices,
    unrelatedServices: snapshot.unrelatedServices,
    protectedObjects: PROTECTED_SERVICES.map((service) => service.protectionId),
    listeners: snapshot.listeners,
    fileEvidence: {
      caddyConfig: {
        path: CADDY_CONFIG_PATH,
        sha256: hashesBefore[CADDY_CONFIG_PATH],
      },
      backendEnvironment: {
        path: BACKEND_ENVIRONMENT_FILE,
        sha256: hashesBefore[BACKEND_ENVIRONMENT_FILE],
      },
      frontendEnvironment: {
        path: FRONTEND_ENVIRONMENT_FILE,
        sha256: hashesBefore[FRONTEND_ENVIRONMENT_FILE],
      },
    },
    plannedActions: PLANNED_ACTIONS.map((action) => ({ ...action })),
    plannedCommands: PLANNED_ACTIONS.map(
      ({ action, service }) => `systemctl ${action} ${service}`,
    ),
  };

  assertNoSensitiveOutputKeys(plan);
  assertValidatorCompatibility(plan);
  return plan;
}

function validateControlledOutputPath(outputPath, allowedOutputRoot) {
  if (
    typeof outputPath !== "string" ||
    !outputPath ||
    !isAbsolute(outputPath) ||
    outputPath.includes("\0") ||
    /[\r\n\t]/.test(outputPath) ||
    outputPath.split(sep).includes("..")
  ) {
    throw new Error("Service-plan output must be a normalized absolute path");
  }
  const root = resolve(allowedOutputRoot);
  const target = resolve(outputPath);
  const escaped = relative(root, target);
  if (
    !escaped ||
    escaped === ".." ||
    escaped.startsWith(`..${sep}`) ||
    isAbsolute(escaped)
  ) {
    throw new Error("Service-plan output must remain under the evidence root");
  }
  return { root, target };
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("Service-plan output path could not be inspected safely");
  }
}

function prepareControlledDirectory(root, targetParent) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Service-plan evidence root must be a regular directory");
  }

  const escaped = relative(root, targetParent);
  const segments = escaped ? escaped.split(sep) : [];
  let current = root;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error("Service-plan output directory is invalid");
    }
    current = resolve(current, segment);
    if (!pathEntryExists(current)) mkdirSync(current, { mode: 0o700 });
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Service-plan output directories cannot contain symbolic links");
    }
  }
}

export function writeServicePlanAtomic(
  outputPath,
  plan,
  { allowedOutputRoot = EVIDENCE_ROOT } = {},
) {
  const { root, target } = validateControlledOutputPath(
    outputPath,
    allowedOutputRoot,
  );
  prepareControlledDirectory(root, dirname(target));
  const realRoot = realpathSync.native(root);
  const realParent = realpathSync.native(dirname(target));
  const parentEscape = relative(realRoot, realParent);
  if (
    parentEscape === ".." ||
    parentEscape.startsWith(`..${sep}`) ||
    isAbsolute(parentEscape)
  ) {
    throw new Error("Service-plan output parent escaped the evidence root");
  }
  if (pathEntryExists(target)) throw new Error("Service-plan output already exists");

  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  let targetLinked = false;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    linkSync(temporary, target);
    targetLinked = true;
    chmodSync(target, 0o600);
    const parentDescriptor = openSync(realParent, constants.O_RDONLY);
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } catch (error) {
    if (targetLinked && pathEntryExists(target)) unlinkSync(target);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return target;
}

export function parseServicePlanArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("Service-plan arguments must be an array");
  let outputPath;
  for (const argument of argv) {
    if (typeof argument !== "string" || !argument.startsWith("--output=")) {
      throw new Error("Unsupported service-plan argument");
    }
    if (outputPath !== undefined) {
      throw new Error("The service-plan output may be specified only once");
    }
    outputPath = argument.slice("--output=".length);
  }
  if (!outputPath) throw new Error("The --output argument is required");
  return { outputPath };
}

export function runProductionServicePlanCli(
  argv,
  {
    createPlan = createProductionServicePlan,
    writePlan = writeServicePlanAtomic,
    allowedOutputRoot = EVIDENCE_ROOT,
  } = {},
) {
  const { outputPath } = parseServicePlanArguments(argv);
  const plan = createPlan();
  const writtenPath = writePlan(outputPath, plan, { allowedOutputRoot });
  return {
    status: "created",
    outputPath: writtenPath,
    projectServices: plan.projectServices.length,
    protectedServices: plan.unrelatedServices.length,
    protectedListeners: plan.listeners.length,
  };
}

const directEntry = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;

if (directEntry) {
  try {
    process.umask(0o077);
    const result = runProductionServicePlanCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Service-plan generation failed";
    process.stderr.write(`${message.replace(/[\r\n]+/g, " ").slice(0, 300)}\n`);
    process.exitCode = 1;
  }
}
