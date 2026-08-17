import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { hostname as readHostname } from "node:os";
import { fileURLToPath } from "node:url";

import { REQUIRED_ENV_NAMES } from "./release-package.mjs";

// v0.6.0 added the encrypted settings key and hospital-tender scheduler
// settings to the manifest contract. A pre-cutover report must still be able
// to authenticate the already-running v0.5.7 schema-3 release, but that
// relaxed set is valid only for the canonical current release path. Candidate
// releases always use the complete current REQUIRED_ENV_NAMES contract.
const V060_REQUIRED_ENV_NAMES = new Set([
  "SETTINGS_ENCRYPTION_KEY",
  "HOSPITAL_TENDER_PYTHON",
  "HOSPITAL_TENDER_AUTO_RUN",
  "HOSPITAL_TENDER_INTERVAL_MINUTES",
  "HOSPITAL_TENDER_BATCH_SIZE",
]);
const LEGACY_CURRENT_REQUIRED_ENV_NAMES = Object.freeze(
  REQUIRED_ENV_NAMES.filter((name) => !V060_REQUIRED_ENV_NAMES.has(name)),
);

export const REQUIRED_PROJECT_SERVICES = Object.freeze([
  "sentelligent-backend.service",
  "sentelligent-frontend.service",
  "sentelligent-caddy.service",
  "sentelligent-weixin-agent.service",
]);

const ALLOWED_SERVICE_ACTIONS = Object.freeze([
  "enable",
  "is-active",
  "is-enabled",
  "restart",
  "start",
  "status",
  "stop",
]);
const REQUIRED_PROTECTED_OBJECTS = Object.freeze([
  "account-vault",
  "qingyang",
  "proxy",
]);
const REQUIRED_PROTECTED_LISTENERS = Object.freeze([
  {
    port: 4876,
    owner: "account-vault",
    service: "codex-account-vault-cloud.service",
  },
  {
    port: 8797,
    owner: "qingyang",
    service: "qingyang-store.service",
  },
]);
const SHARED_CADDY_MUTATING_ACTIONS = Object.freeze([
  "enable",
  "restart",
  "start",
  "stop",
]);
const REQUIRED_PROTECTED_SERVICES = Object.freeze([
  {
    name: "codex-account-vault-cloud.service",
    protectionId: "account-vault",
  },
  { name: "qingyang-store.service", protectionId: "qingyang" },
  { name: "codex-vault-mihomo.service", protectionId: "proxy" },
]);
const DEFAULT_PROJECT_PATH = "/opt/sentelligent-sales-workbench";
const PROJECT_CURRENT_PATH = `${DEFAULT_PROJECT_PATH}/current`;
const PROJECT_RELEASES_PATH = `${DEFAULT_PROJECT_PATH}/releases`;
const FRONTEND_ENVIRONMENT_FILE = `${DEFAULT_PROJECT_PATH}/config/frontend.env`;
const CADDY_CONFIG_PATH = "/etc/caddy/Caddyfile";
const PROJECT_NODE_EXECUTABLE =
  `${DEFAULT_PROJECT_PATH}/runtime/node-v24/bin/node`;
const RELEASE_MANIFEST_SCHEMA_VERSION = 3;
const RELEASE_PRODUCT = "sentelligent-sales-workbench";
const RELEASE_MANIFEST_FILE = "release-manifest.json";
const RELEASE_BUILD_PREFIX = "outputs/product-design-prototype/dist/";
const RELEASE_MIGRATION_PREFIX = "backend/src/db/migrations/";
const RELEASE_PRODUCTION_DEPENDENCY_PREFIX = "backend/node_modules/";
const PORTABLE_NODE_EXECUTABLE = "/usr/bin/node";
const CENTOS_LEGACY_NODE_EXECUTABLE = "/usr/local/bin/node";
const CADDY_EXECUTABLES = new Set([
  "/usr/bin/caddy",
  "/usr/local/bin/caddy",
]);
const SERVICE_USERS = Object.freeze({
  "sentelligent-backend.service": new Set(["root", "sentelligent", "sentzx"]),
  "sentelligent-frontend.service": new Set(["root", "sentelligent", "sentzx"]),
  "sentelligent-caddy.service": new Set(["root", "caddy", "sentelligent"]),
  "sentelligent-weixin-agent.service": new Set(["root", "sentelligent", "sentzx"]),
});
const REQUIRED_PROJECT_SERVICE_NAMES = new Set(REQUIRED_PROJECT_SERVICES);
const BACKEND_ENVIRONMENT_SERVICES = Object.freeze([
  "sentelligent-backend.service",
  "sentelligent-weixin-agent.service",
]);
const APPROVED_MODEL_PROVIDER = "deepseek";
const APPROVED_MODEL_NAME = "deepseek-v4-flash";
const APPROVED_MODEL_BASE_URL = "https://api.deepseek.com";
const IMMUTABLE_RELEASE_SERVICE_ENTRIES = Object.freeze({
  "sentelligent-backend.service": {
    entryPath: "backend/src/server.js",
    workingDirectoryPath: "backend",
    trailingArguments: [],
  },
  "sentelligent-frontend.service": {
    entryPath:
      "outputs/product-design-prototype/scripts/static-server.mjs",
    workingDirectoryPath: "outputs/product-design-prototype",
    trailingArguments: ["serve"],
  },
  "sentelligent-weixin-agent.service": {
    entryPath: "backend/src/weixin/worker.js",
    workingDirectoryPath: "backend",
    trailingArguments: ["start"],
  },
});

function parseEnvFile(content) {
  const entries = {};
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[name] = value;
  }
  return entries;
}

function decodeCanonicalBase64Url(value, expectedLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) return null;
  if (expectedLength !== undefined && decoded.length !== expectedLength) return null;
  return decoded;
}

function isCanonicalPasswordHash(value) {
  if (typeof value !== "string" || value.length > 256) return false;
  const parts = value.split("$");
  if (parts.length !== 6) return false;
  const [name, n, r, p, salt, hash] = parts;
  return (
    name === "scrypt" &&
    n === "16384" &&
    r === "8" &&
    p === "1" &&
    decodeCanonicalBase64Url(salt, 16) !== null &&
    decodeCanonicalBase64Url(hash, 64) !== null
  );
}

function isStrongSessionValue(value) {
  const decoded = decodeCanonicalBase64Url(value);
  return decoded !== null && decoded.length >= 32;
}

function isStrongAssistantSecret(value) {
  return isStrongSessionValue(value) || (typeof value === "string" && /^[A-Za-z0-9_-]{64,}$/.test(value));
}

function hasAssistantSecretConfiguration(environment) {
  const session = environment.AUTH_SESSION_SECRET;
  const machine = environment.WEIXIN_AGENT_API_TOKEN;
  const confirmation = environment.ASSISTANT_CONFIRMATION_SECRET;
  const settings = environment.SETTINGS_ENCRYPTION_KEY;
  const tenderSync = environment.HOSPITAL_TENDER_SYNC_TOKEN;
  const tenderSyncConfigured = typeof tenderSync === "string" && tenderSync.length > 0;
  const independentSecrets = [
    session,
    machine,
    confirmation,
    settings,
    ...(tenderSyncConfigured ? [tenderSync] : []),
  ];
  return (
    isStrongAssistantSecret(machine) &&
    isStrongAssistantSecret(confirmation) &&
    decodeCanonicalBase64Url(settings, 32) !== null &&
    (!tenderSyncConfigured || isStrongAssistantSecret(tenderSync)) &&
    new Set(independentSecrets).size === independentSecrets.length &&
    machine !== environment.MODEL_API_KEY &&
    machine !== environment.ICOST_WEBHOOK_TOKEN &&
    confirmation !== environment.MODEL_API_KEY &&
    confirmation !== environment.ICOST_WEBHOOK_TOKEN &&
    settings !== environment.MODEL_API_KEY &&
    settings !== environment.ICOST_WEBHOOK_TOKEN &&
    (!tenderSyncConfigured || (
      tenderSync !== environment.MODEL_API_KEY &&
      tenderSync !== environment.ICOST_WEBHOOK_TOKEN
    ))
  );
}

function hasWeixinOwnerConfiguration(environment, database) {
  const owner = environment.WEIXIN_AGENT_OWNER;
  return (
    typeof owner === "string" &&
    owner.length > 0 &&
    owner.length <= 200 &&
    owner === owner.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(owner) &&
    Array.isArray(database?.businessOwners) &&
    database.businessOwners.includes(owner)
  );
}

function hasHospitalTenderSchedulerConfiguration(environment) {
  return (
    environment.HOSPITAL_TENDER_AUTO_RUN === "true" &&
    environment.HOSPITAL_TENDER_INTERVAL_MINUTES === "60" &&
    environment.HOSPITAL_TENDER_BATCH_SIZE === "10"
  );
}

function isPositiveSafeIntegerText(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function isIcostWebhookToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{64}$/.test(value);
}

function hasIcostWebhookConfiguration(environment) {
  const owner = environment.ICOST_WEBHOOK_OWNER;
  return (
    isIcostWebhookToken(environment.ICOST_WEBHOOK_TOKEN) &&
    typeof owner === "string" &&
    owner.length > 0 &&
    owner.length <= 200 &&
    owner === owner.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(owner) &&
    owner === environment.AUTH_ACCOUNT &&
    isPositiveSafeIntegerText(environment.ICOST_WEBHOOK_RATE_LIMIT) &&
    isPositiveSafeIntegerText(environment.ICOST_WEBHOOK_WINDOW_MS)
  );
}

function isProductionModelKey(value) {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 4096 &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f-\u009f]/u.test(value)
  );
}

function hasProductionModelConfiguration(environment) {
  const modelKey = environment.MODEL_API_KEY;
  const baseUrl = typeof environment.MODEL_BASE_URL === "string"
    ? environment.MODEL_BASE_URL.replace(/\/+$/, "")
    : "";
  const isolated = [
    environment.AUTH_SESSION_SECRET,
    environment.WEIXIN_AGENT_API_TOKEN,
    environment.ASSISTANT_CONFIRMATION_SECRET,
    environment.ICOST_WEBHOOK_TOKEN,
    environment.SETTINGS_ENCRYPTION_KEY,
    environment.HOSPITAL_TENDER_SYNC_TOKEN,
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .every((value) => value !== modelKey);
  return (
    environment.AI_ANALYSIS_MODE === "model" &&
    environment.MODEL_PROVIDER === APPROVED_MODEL_PROVIDER &&
    environment.MODEL_NAME === APPROVED_MODEL_NAME &&
    baseUrl === APPROVED_MODEL_BASE_URL &&
    isPositiveSafeIntegerText(environment.MODEL_TIMEOUT_MS) &&
    isProductionModelKey(modelKey) &&
    isolated
  );
}

function hasIsolatedIcostWebhookToken(environment) {
  const token = environment.ICOST_WEBHOOK_TOKEN;
  if (!isIcostWebhookToken(token)) return false;
  return [
    environment.AUTH_SESSION_SECRET,
    environment.MODEL_API_KEY,
    environment.DEEPSEEK_API_KEY,
    environment.WEIXIN_AGENT_API_TOKEN,
    environment.ASSISTANT_CONFIRMATION_SECRET,
    environment.SETTINGS_ENCRYPTION_KEY,
    environment.HOSPITAL_TENDER_SYNC_TOKEN,
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .every((value) => value !== token);
}

function isProductionToolCommand(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f\s]/u.test(value)
  ) {
    return false;
  }
  const segmentPattern = /^[A-Za-z0-9._+-]+$/;
  if (!value.includes("/")) return segmentPattern.test(value);
  if (!value.startsWith("/")) return false;
  const segments = value.slice(1).split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      segmentPattern.test(segment),
  );
}

function inspectSecureExecutable(value) {
  try {
    const resolvedPath = realpathSync.native(value);
    const metadata = statSync(resolvedPath);
    return {
      regularFile: metadata.isFile(),
      secureOwnership:
        metadata.uid === 0 &&
        (metadata.mode & 0o022) === 0,
      resolvedPath,
    };
  } catch {
    return {
      regularFile: false,
      secureOwnership: false,
      resolvedPath: "",
    };
  }
}

export function inspectCanonicalSecureExecutable(
  value,
  {
    lstat = lstatSync,
    realpath = realpathSync.native,
    resolvePath = resolve,
    dirnamePath = dirname,
  } = {},
) {
  const failed = {
    regularFile: false,
    secureOwnership: false,
    canonicalPath: false,
    secureAncestors: false,
    resolvedPath: "",
  };
  try {
    if (
      typeof value !== "string" ||
      !isAbsolute(value) ||
      resolvePath(value) !== value
    ) {
      return failed;
    }
    const lexical = lstat(value);
    const resolvedPath = realpath(value);
    const canonicalPath =
      resolvedPath === value &&
      lexical.isFile() &&
      !lexical.isSymbolicLink();
    const secureOwnership =
      canonicalPath && lexical.uid === 0 && (lexical.mode & 0o6022) === 0;
    if (!canonicalPath || !secureOwnership) {
      return { ...failed, canonicalPath, secureOwnership };
    }

    let directory = dirnamePath(value);
    let secureAncestors = true;
    while (true) {
      const directoryMetadata = lstat(directory);
      if (
        realpath(directory) !== directory ||
        !directoryMetadata.isDirectory() ||
        directoryMetadata.isSymbolicLink() ||
        directoryMetadata.uid !== 0 ||
        (directoryMetadata.mode & 0o022) !== 0
      ) {
        secureAncestors = false;
        break;
      }
      const parent = dirnamePath(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return {
      regularFile: true,
      secureOwnership: true,
      canonicalPath: true,
      secureAncestors,
      resolvedPath: value,
    };
  } catch {
    return failed;
  }
}

function failedToolRun() {
  return { status: null, stdout: "", stderr: "" };
}

function resolveRunuserExecutable() {
  for (const candidate of ["/usr/sbin/runuser", "/sbin/runuser"]) {
    const inspection = inspectSecureExecutable(candidate);
    if (inspection.regularFile && inspection.secureOwnership) {
      return inspection.resolvedPath;
    }
  }
  return "";
}

export function runToolAsServiceUser(
  { user, command, args },
  {
    platform = process.platform,
    currentUid = typeof process.getuid === "function" ? process.getuid() : null,
    resolveRunuser = resolveRunuserExecutable,
    spawn = spawnSync,
  } = {},
) {
  if (
    platform !== "linux" ||
    currentUid !== 0 ||
    typeof user !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(user) ||
    !Array.isArray(args) ||
    args.some((value) => typeof value !== "string")
  ) {
    return failedToolRun();
  }
  const runuser = resolveRunuser();
  if (!runuser) return failedToolRun();
  const result = spawn(
    runuser,
    ["-u", user, "--", command, ...args],
    {
      cwd: "/",
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
      },
      input: "",
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function successfulToolRun(result) {
  return isRecord(result) && result.status === 0;
}

function parsePythonRuntimeEvidence(output) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|([0-9a-f]+)$/iu.exec(
    String(output ?? "").trim(),
  );
  if (!match) {
    return { versionAtLeast311: false, serviceIdentityPreserved: false };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const realUid = Number(match[3]);
  const effectiveUid = Number(match[4]);
  const realGid = Number(match[5]);
  const effectiveGid = Number(match[6]);
  const versionAtLeast311 = major > 3 || (major === 3 && minor >= 11);
  const serviceIdentityPreserved =
    Number.isSafeInteger(realUid) &&
    realUid === effectiveUid &&
    Number.isSafeInteger(realGid) &&
    realGid === effectiveGid &&
    /^0+$/u.test(match[7]);
  return { versionAtLeast311, serviceIdentityPreserved };
}

export function inspectHospitalTenderPython(
  request,
  {
    inspectSecureExecutable: inspect = inspectCanonicalSecureExecutable,
    runAsServiceUser = runToolAsServiceUser,
  } = {},
) {
  const emptyEvidence = {
    serviceIdentityResolved: false,
    regularFile: false,
    executableByServiceUser: false,
    identity: "unknown",
    versionAtLeast311: false,
    serviceIdentityPreserved: false,
  };
  const backendService = request?.backendService;
  if (
    !isRecord(request) ||
    !isRecord(backendService) ||
    typeof backendService.user !== "string" ||
    backendService.dynamicUser !== false ||
    !["", backendService.user].includes(backendService.group) ||
    !Array.isArray(backendService.supplementaryGroups) ||
    backendService.supplementaryGroups.length !== 0 ||
    typeof request.command !== "string"
  ) {
    return emptyEvidence;
  }

  let inspection;
  try {
    inspection = inspect(request.command);
  } catch {
    return emptyEvidence;
  }
  const regularFile =
    isRecord(inspection) &&
    inspection.regularFile === true &&
    inspection.secureOwnership === true &&
    inspection.canonicalPath === true &&
    inspection.secureAncestors === true &&
    typeof inspection.resolvedPath === "string" &&
    inspection.resolvedPath.length > 0;
  if (!regularFile) return emptyEvidence;

  const executableByServiceUser = successfulToolRun(runAsServiceUser({
    user: backendService.user,
    command: "/usr/bin/test",
    args: ["-x", inspection.resolvedPath],
  }));
  const version = executableByServiceUser
    ? runAsServiceUser({
        user: backendService.user,
        command: inspection.resolvedPath,
        args: [
          "-I",
          "-S",
          "-c",
          "import os,sys; lines=open('/proc/self/status',encoding='ascii').read().splitlines(); cap=next((line.split(':',1)[1].strip() for line in lines if line.startswith('CapEff:')),''); print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}|{os.getuid()}|{os.geteuid()}|{os.getgid()}|{os.getegid()}|{cap}')",
        ],
      })
    : failedToolRun();
  const versionOutput = `${version.stdout}\n${version.stderr}`.trim();
  const runtimeEvidence = successfulToolRun(version)
    ? parsePythonRuntimeEvidence(versionOutput)
    : { versionAtLeast311: false, serviceIdentityPreserved: false };
  const versionAtLeast311 =
    runtimeEvidence.versionAtLeast311 && runtimeEvidence.serviceIdentityPreserved;
  return {
    serviceIdentityResolved: executableByServiceUser,
    regularFile: true,
    executableByServiceUser,
    identity: versionAtLeast311 ? "python" : "unknown",
    versionAtLeast311,
    serviceIdentityPreserved: runtimeEvidence.serviceIdentityPreserved,
  };
}

function listedTesseractLanguages(output) {
  return new Set(
    String(output ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z0-9_.-]+$/.test(line)),
  );
}

export function inspectInvoiceExtractionTools(
  request,
  {
    inspectSecureExecutable: inspect = inspectSecureExecutable,
    runAsServiceUser = runToolAsServiceUser,
  } = {},
) {
  const emptyEvidence = {
    serviceIdentityResolved: false,
    ocr: {
      regularFile: false,
      executableByServiceUser: false,
      identity: "unknown",
      requiredLanguagesAvailable: false,
    },
    pdfText: {
      regularFile: false,
      executableByServiceUser: false,
      identity: "unknown",
    },
  };
  const backendService = request?.backendService;
  if (
    !isRecord(request) ||
    !isRecord(backendService) ||
    typeof backendService.user !== "string" ||
    backendService.dynamicUser !== false ||
    !["", backendService.user].includes(backendService.group) ||
    !Array.isArray(backendService.supplementaryGroups) ||
    backendService.supplementaryGroups.length !== 0 ||
    !isRecord(request.ocr) ||
    typeof request.ocr.command !== "string" ||
    !Array.isArray(request.ocr.requiredLanguages) ||
    !request.ocr.requiredLanguages.every(
      (language) =>
        typeof language === "string" &&
        /^[A-Za-z0-9_.-]+$/.test(language),
    ) ||
    !isRecord(request.pdfText) ||
    typeof request.pdfText.command !== "string"
  ) {
    return emptyEvidence;
  }

  let ocrInspection;
  let pdfInspection;
  try {
    ocrInspection = inspect(request.ocr.command);
    pdfInspection = inspect(request.pdfText.command);
  } catch {
    return emptyEvidence;
  }
  const ocrRegular =
    isRecord(ocrInspection) &&
    ocrInspection.regularFile === true &&
    ocrInspection.secureOwnership === true &&
    typeof ocrInspection.resolvedPath === "string" &&
    ocrInspection.resolvedPath.length > 0;
  const pdfRegular =
    isRecord(pdfInspection) &&
    pdfInspection.regularFile === true &&
    pdfInspection.secureOwnership === true &&
    typeof pdfInspection.resolvedPath === "string" &&
    pdfInspection.resolvedPath.length > 0;
  if (!ocrRegular || !pdfRegular) {
    return {
      ...emptyEvidence,
      ocr: { ...emptyEvidence.ocr, regularFile: ocrRegular },
      pdfText: { ...emptyEvidence.pdfText, regularFile: pdfRegular },
    };
  }

  const ocrExecutable = successfulToolRun(runAsServiceUser({
    user: backendService.user,
    command: "/usr/bin/test",
    args: ["-x", ocrInspection.resolvedPath],
  }));
  const pdfExecutable = successfulToolRun(runAsServiceUser({
    user: backendService.user,
    command: "/usr/bin/test",
    args: ["-x", pdfInspection.resolvedPath],
  }));
  const serviceIdentityResolved = ocrExecutable || pdfExecutable;
  const ocrVersion = ocrExecutable
    ? runAsServiceUser({
        user: backendService.user,
        command: ocrInspection.resolvedPath,
        args: ["--version"],
      })
    : failedToolRun();
  const ocrLanguages = ocrExecutable
    ? runAsServiceUser({
        user: backendService.user,
        command: ocrInspection.resolvedPath,
        args: ["--list-langs"],
      })
    : failedToolRun();
  const pdfVersion = pdfExecutable
    ? runAsServiceUser({
        user: backendService.user,
        command: pdfInspection.resolvedPath,
        args: ["-v"],
      })
    : failedToolRun();
  const ocrIdentity =
    successfulToolRun(ocrVersion) &&
    /^tesseract\s+\d/iu.test(`${ocrVersion.stdout}\n${ocrVersion.stderr}`.trim());
  const pdfIdentity =
    successfulToolRun(pdfVersion) &&
    /^pdftotext version\s+\d/iu.test(`${pdfVersion.stdout}\n${pdfVersion.stderr}`.trim());
  const availableLanguages = successfulToolRun(ocrLanguages)
    ? listedTesseractLanguages(`${ocrLanguages.stdout}\n${ocrLanguages.stderr}`)
    : new Set();

  return {
    serviceIdentityResolved,
    ocr: {
      regularFile: true,
      executableByServiceUser: ocrExecutable,
      identity: ocrIdentity ? "tesseract" : "unknown",
      requiredLanguagesAvailable:
        ocrIdentity &&
        request.ocr.requiredLanguages.every((language) =>
          availableLanguages.has(language),
        ),
    },
    pdfText: {
      regularFile: true,
      executableByServiceUser: pdfExecutable,
      identity: pdfIdentity ? "poppler-pdftotext" : "unknown",
    },
  };
}

function parseInvoiceOcrLanguages(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    !/^[A-Za-z0-9_.-]+(?:\+[A-Za-z0-9_.-]+)*$/.test(value)
  ) {
    return null;
  }
  return value.split("+");
}

function backendServiceInspectionIdentity(servicePlan) {
  const services = Array.isArray(servicePlan?.projectServices)
    ? servicePlan.projectServices
    : [];
  const matches = services.filter(
    (service) => service?.name === "sentelligent-backend.service",
  );
  if (
    matches.length !== 1 ||
    typeof matches[0]?.User !== "string" ||
    typeof matches[0]?.Group !== "string" ||
    !Array.isArray(matches[0]?.SupplementaryGroups) ||
    !matches[0].SupplementaryGroups.every(
      (value) => typeof value === "string",
    ) ||
    typeof matches[0]?.DynamicUser !== "boolean"
  ) {
    return null;
  }
  const service = matches[0];
  return {
    user: service.User,
    group: service.Group,
    supplementaryGroups: [...service.SupplementaryGroups],
    dynamicUser: service.DynamicUser,
  };
}

function hasInvoiceExtractionConfiguration(
  environment,
  servicePlan,
  invoiceToolInspector = inspectInvoiceExtractionTools,
) {
  const requiredLanguages = parseInvoiceOcrLanguages(
    environment.INVOICE_OCR_LANGUAGES,
  );
  const backendService = backendServiceInspectionIdentity(servicePlan);
  if (
    !isProductionToolCommand(environment.INVOICE_OCR_COMMAND) ||
    !environment.INVOICE_OCR_COMMAND.startsWith("/") ||
    !isProductionToolCommand(environment.INVOICE_PDF_TEXT_COMMAND) ||
    !environment.INVOICE_PDF_TEXT_COMMAND.startsWith("/") ||
    requiredLanguages === null ||
    !isPositiveSafeIntegerText(environment.INVOICE_TEXT_EXTRACTION_TIMEOUT_MS) ||
    backendService === null ||
    typeof invoiceToolInspector !== "function"
  ) {
    return false;
  }

  try {
    const evidence = invoiceToolInspector({
      backendService,
      ocr: {
        command: environment.INVOICE_OCR_COMMAND,
        requiredLanguages,
      },
      pdfText: {
        command: environment.INVOICE_PDF_TEXT_COMMAND,
      },
    });
    return (
      isRecord(evidence) &&
      evidence.serviceIdentityResolved === true &&
      isRecord(evidence.ocr) &&
      evidence.ocr.regularFile === true &&
      evidence.ocr.executableByServiceUser === true &&
      evidence.ocr.identity === "tesseract" &&
      evidence.ocr.requiredLanguagesAvailable === true &&
      isRecord(evidence.pdfText) &&
      evidence.pdfText.regularFile === true &&
      evidence.pdfText.executableByServiceUser === true &&
      evidence.pdfText.identity === "poppler-pdftotext"
    );
  } catch {
    return false;
  }
}

function hasHospitalTenderPythonRuntime(
  environment,
  servicePlan,
  inspector = inspectHospitalTenderPython,
) {
  const command = environment.HOSPITAL_TENDER_PYTHON;
  const backendService = backendServiceInspectionIdentity(servicePlan);
  if (
    !isProductionToolCommand(command) ||
    !command.startsWith("/") ||
    backendService === null ||
    typeof inspector !== "function"
  ) {
    return false;
  }
  try {
    const evidence = inspector({ backendService, command });
    return (
      isRecord(evidence) &&
      evidence.serviceIdentityResolved === true &&
      evidence.regularFile === true &&
      evidence.executableByServiceUser === true &&
      evidence.identity === "python" &&
      evidence.versionAtLeast311 === true &&
      evidence.serviceIdentityPreserved === true
    );
  } catch {
    return false;
  }
}

function canonicalOrigins(values) {
  const origins = new Set();
  for (const value of values) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin === "null"
    ) {
      throw new Error("Production CORS values must be exact HTTPS origins");
    }
    origins.add(url.origin);
  }
  return [...origins].sort();
}

function matchesExactCors(value, expectedOrigins) {
  try {
    const configured = String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const expected = canonicalOrigins(expectedOrigins);
    if (configured.length === 0 || expected.length === 0) return false;
    return JSON.stringify(canonicalOrigins(configured)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function nodeMajor(version) {
  const match = String(version ?? "").trim().match(/^v?(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : 0;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const defaultStableFileSystem = Object.freeze({
  close: closeSync,
  fstat: fstatSync,
  lstat: lstatSync,
  open: openSync,
  read(fileDescriptor) {
    return readFileSync(fileDescriptor);
  },
  realpath(filePath) {
    return realpathSync.native(filePath);
  },
});

function sameStableIdentity(left, right) {
  return [
    "dev",
    "ino",
    "mode",
    "nlink",
    "uid",
    "gid",
    "size",
    "mtimeNs",
    "ctimeNs",
  ].every((field) => left?.[field] === right?.[field]);
}

export function readStableRegularFile(
  filePath,
  { fileSystem: overrides = {}, validate, label = "file" } = {},
) {
  const fileSystem = { ...defaultStableFileSystem, ...overrides };
  const absolutePath = resolve(filePath);
  const lexical = fileSystem.lstat(absolutePath, { bigint: true });
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symbolic file`);
  }
  const realPath = fileSystem.realpath(absolutePath);
  const noFollow = Number(constants.O_NOFOLLOW ?? 0);
  const fileDescriptor = fileSystem.open(
    realPath,
    Number(constants.O_RDONLY) | noFollow,
  );
  try {
    const before = fileSystem.fstat(fileDescriptor, { bigint: true });
    if (!before.isFile()) {
      throw new Error(`${label} descriptor must identify a regular file`);
    }
    if (before.nlink !== 1n) {
      throw new Error(`${label} must have exactly one hard link`);
    }
    const content = fileSystem.read(fileDescriptor);
    if (!Buffer.isBuffer(content) || BigInt(content.length) !== before.size) {
      throw new Error(`${label} changed while it was read`);
    }
    const validation = typeof validate === "function"
      ? validate({ content, realPath, metadata: before })
      : undefined;
    const after = fileSystem.fstat(fileDescriptor, { bigint: true });
    const lexicalAfter = fileSystem.lstat(realPath, { bigint: true });
    if (
      !sameStableIdentity(before, after) ||
      lexicalAfter.isSymbolicLink() ||
      lexicalAfter.dev !== before.dev ||
      lexicalAfter.ino !== before.ino ||
      lexicalAfter.nlink !== 1n
    ) {
      throw new Error(`${label} identity changed during validation`);
    }
    return {
      content,
      realPath,
      sha256: createHash("sha256").update(content).digest("hex"),
      metadata: before,
      validation,
    };
  } finally {
    fileSystem.close(fileDescriptor);
  }
}

export async function inspectSqlite(
  filePath,
  { requireNoSidecars = false } = {},
) {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    return {
      quickCheck: "error",
      foreignKeyViolations: null,
      sha256: "",
      error: "database file is missing",
    };
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const stable = readStableRegularFile(resolvedPath, {
      label: "database file",
      validate({ realPath }) {
        const sidecars = [
          `${realPath}-wal`,
          `${realPath}-shm`,
          `${realPath}-journal`,
        ].filter(existsSync);
        if (requireNoSidecars && sidecars.length > 0) {
          throw new Error("database has active sidecar files");
        }
        const database = new DatabaseSync(realPath, { readOnly: true });
        try {
          const quickRows = database.prepare("PRAGMA quick_check").all();
          const quickCheck =
            quickRows.length === 1 && quickRows[0].quick_check === "ok"
              ? "ok"
              : quickRows.map((row) => row.quick_check).join("; ") || "no result";
          const foreignKeyViolations = database
            .prepare("PRAGMA foreign_key_check")
            .all();
          const tableNames = new Set(database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((row) => row.name));
          const businessOwners = tableNames.has("customers") || tableNames.has("opportunities")
            ? [...new Set([
                ...(tableNames.has("customers")
                  ? database.prepare("SELECT owner FROM customers WHERE owner IS NOT NULL AND owner <> ''").all().map((row) => row.owner)
                  : []),
                ...(tableNames.has("opportunities")
                  ? database.prepare("SELECT owner FROM opportunities WHERE owner IS NOT NULL AND owner <> ''").all().map((row) => row.owner)
                  : []),
              ])].sort()
            : [];
          return {
            quickCheck,
            foreignKeyViolations: foreignKeyViolations.length,
            businessOwners,
          };
        } finally {
          database.close();
        }
      },
    });
    return {
      ...stable.validation,
      sha256: stable.sha256,
      realPath: stable.realPath,
      error: null,
    };
  } catch (error) {
    const safeReason = /(?:hard link|link count|single link|sidecar|changed during validation)/iu.test(
      String(error?.message ?? ""),
    )
      ? String(error.message)
      : "database inspection failed";
    return {
      quickCheck: "error",
      foreignKeyViolations: null,
      sha256: "",
      error: safeReason,
    };
  }
}

function normalizedNativePath(realPath) {
  return process.platform === "win32" ? realPath.toLowerCase() : realPath;
}

function reliableIdentityValue(value) {
  if (typeof value === "bigint") return value > 0n;
  return Number.isSafeInteger(value) && value > 0;
}

const defaultIdentityFileSystem = Object.freeze({
  realpath(filePath) {
    return realpathSync.native(filePath);
  },
  stat(filePath) {
    return statSync(filePath, { bigint: true });
  },
});

export function compareDatabaseIdentity(
  databasePath,
  backupPath,
  fileSystem = defaultIdentityFileSystem,
) {
  try {
    if (
      typeof fileSystem?.realpath !== "function" ||
      typeof fileSystem?.stat !== "function"
    ) {
      return { distinct: false, verifiedBy: "unavailable" };
    }
    const resolvedDatabasePath = resolve(databasePath);
    const resolvedBackupPath = resolve(backupPath);
    const primaryPath = normalizedNativePath(
      fileSystem.realpath(resolvedDatabasePath),
    );
    const candidatePath = normalizedNativePath(
      fileSystem.realpath(resolvedBackupPath),
    );
    if (primaryPath === candidatePath) {
      return { distinct: false, verifiedBy: "resolved-path" };
    }

    const primary = fileSystem.stat(resolvedDatabasePath);
    const candidate = fileSystem.stat(resolvedBackupPath);
    const identityAvailable =
      reliableIdentityValue(primary?.dev) &&
      reliableIdentityValue(primary?.ino) &&
      reliableIdentityValue(candidate?.dev) &&
      reliableIdentityValue(candidate?.ino);
    if (!identityAvailable) {
      return { distinct: false, verifiedBy: "unavailable" };
    }
    if (
      primary.dev === candidate.dev &&
      primary.ino === candidate.ino
    ) {
      return { distinct: false, verifiedBy: "device-and-inode" };
    }
    return { distinct: true, verifiedBy: "device-and-inode" };
  } catch {
    return { distinct: false, verifiedBy: "unavailable" };
  }
}

function isEnabled(value) {
  return value === true || value === "enabled";
}

function isActive(value) {
  return value === true || value === "active";
}

function parsePlannedCommand(command) {
  if (typeof command !== "string" || /[\r\n;&|`$<>(){}]/.test(command)) {
    return null;
  }
  const services = REQUIRED_PROJECT_SERVICES
    .map((service) => service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `^systemctl\\s+(${ALLOWED_SERVICE_ACTIONS.join("|")})\\s+` +
      `(${services})$`,
  );
  const match = command.trim().match(pattern);
  return match ? { action: match[1], service: match[2] } : null;
}

export function validatePlannedCommands(plan) {
  const commands = Array.isArray(plan?.plannedCommands)
    ? plan.plannedCommands
    : [];
  const actions = Array.isArray(plan?.plannedActions) ? plan.plannedActions : [];
  if (commands.length === 0 || commands.length !== actions.length) return false;
  const parsed = commands.map(parsePlannedCommand);
  if (parsed.some((command) => command === null)) return false;
  if (parsed.some((command) => !REQUIRED_PROJECT_SERVICE_NAMES.has(command.service))) {
    return false;
  }
  if (parsed.some(
    (command) =>
      command.service === "sentelligent-caddy.service" &&
      SHARED_CADDY_MUTATING_ACTIONS.includes(command.action),
  )) {
    return false;
  }
  const commandKeys = parsed
    .map((command) => `${command.action}:${command.service}`)
    .sort();
  const actionKeys = actions
    .map((action) => {
      if (
        !ALLOWED_SERVICE_ACTIONS.includes(action?.action) ||
        !REQUIRED_PROJECT_SERVICE_NAMES.has(action?.service)
      ) {
        return null;
      }
      return `${action.action}:${action.service}`;
    })
    .sort();
  return !actionKeys.includes(null) &&
    JSON.stringify(commandKeys) === JSON.stringify(actionKeys);
}

function approvedProjectPaths(plan) {
  if (!Array.isArray(plan?.projectPaths)) return null;
  const paths = [];
  for (const entry of plan.projectPaths) {
    const value = entry?.path;
    if (
      entry?.approved !== true ||
      typeof value !== "string" ||
      !posix.isAbsolute(value) ||
      value.split("/").includes("..")
    ) {
      return null;
    }
    const normalized = posix.normalize(value);
    const path = normalized.replace(/\/$/, "");
    if (
      path !== DEFAULT_PROJECT_PATH &&
      !pathWithin(path, PROJECT_CURRENT_PATH) &&
      !pathWithin(path, PROJECT_RELEASES_PATH) &&
      path !== CADDY_CONFIG_PATH
    ) {
      return null;
    }
    paths.push(path);
  }
  if (
    !paths.includes(DEFAULT_PROJECT_PATH) ||
    !paths.includes(CADDY_CONFIG_PATH)
  ) {
    return null;
  }
  return [...new Set(paths)];
}

function pathWithin(candidate, root) {
  const value = posix.normalize(candidate);
  return value === root || value.startsWith(`${root}/`);
}

function isReleaseEntryPath(candidate, entryPath) {
  if (candidate === `${DEFAULT_PROJECT_PATH}/${entryPath}`) return true;
  if (candidate === `${PROJECT_CURRENT_PATH}/${entryPath}`) return true;
  if (!candidate.startsWith(`${PROJECT_RELEASES_PATH}/`)) return false;
  const relativePath = candidate.slice(`${PROJECT_RELEASES_PATH}/`.length);
  const separator = relativePath.indexOf("/");
  if (separator <= 0) return false;
  const releaseId = relativePath.slice(0, separator);
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId) &&
    !releaseId.includes("..") &&
    relativePath.slice(separator + 1) === entryPath
  );
}

function exactExecTokens(command) {
  if (
    typeof command !== "string" ||
    command !== command.trim() ||
    /[\0\r\n;&|`$<>(){}[\]!'"\\]/.test(command)
  ) {
    return null;
  }
  const tokens = command.split(/[ \t]+/);
  return tokens.length > 0 && tokens.every(Boolean) ? tokens : null;
}

function immutableReleaseRoot(manifestPath) {
  if (
    typeof manifestPath !== "string" ||
    manifestPath !== posix.normalize(manifestPath) ||
    posix.basename(manifestPath) !== "release-manifest.json"
  ) {
    return null;
  }
  const releaseRoot = posix.dirname(manifestPath);
  if (!releaseRoot.startsWith(`${PROJECT_RELEASES_PATH}/`)) return null;
  const releaseId = releaseRoot.slice(`${PROJECT_RELEASES_PATH}/`.length);
  if (
    releaseId.includes("/") ||
    releaseId.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)
  ) {
    return null;
  }
  return releaseRoot;
}

function immutableServiceReleaseRoot(serviceName, command) {
  const profile = IMMUTABLE_RELEASE_SERVICE_ENTRIES[serviceName];
  const tokens = exactExecTokens(command);
  if (
    !profile ||
    tokens === null ||
    tokens[0] !== PROJECT_NODE_EXECUTABLE ||
    tokens.length !== 2 + profile.trailingArguments.length ||
    JSON.stringify(tokens.slice(2)) !==
      JSON.stringify(profile.trailingArguments)
  ) {
    return null;
  }
  const suffix = `/${profile.entryPath}`;
  if (!tokens[1].endsWith(suffix)) return null;
  const releaseRoot = tokens[1].slice(0, -suffix.length);
  return immutableReleaseRoot(`${releaseRoot}/release-manifest.json`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isCanonicalReleaseFilePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !posix.isAbsolute(value) &&
    value === posix.normalize(value) &&
    value.split("/").every((segment) => segment && segment !== "." && segment !== "..")
  );
}

function isCanonicalIsoTimestamp(value) {
  const timestamp = Date.parse(value);
  return (
    typeof value === "string" &&
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
}

function sourceTreeSha256(files) {
  const index = Object.entries(files)
    .sort(([left], [right]) => compareUtf8Paths(left, right))
    .map(([file, hash]) => `${hash}  ${file}\n`)
    .join("");
  return createHash("sha256").update(index, "utf8").digest("hex");
}

function compareSameFileIdentity(
  configuredPath,
  inspectedPath,
  fileSystem = defaultIdentityFileSystem,
) {
  try {
    if (
      typeof fileSystem?.realpath !== "function" ||
      typeof fileSystem?.stat !== "function"
    ) {
      return { matches: false, verifiedBy: "unavailable" };
    }
    const configuredAbsolute = resolve(configuredPath);
    const inspectedAbsolute = resolve(inspectedPath);
    const configuredRealPath = normalizedNativePath(
      fileSystem.realpath(configuredAbsolute),
    );
    const inspectedRealPath = normalizedNativePath(
      fileSystem.realpath(inspectedAbsolute),
    );
    if (configuredRealPath === inspectedRealPath) {
      return { matches: true, verifiedBy: "resolved-path" };
    }
    const configured = fileSystem.stat(configuredAbsolute);
    const inspected = fileSystem.stat(inspectedAbsolute);
    const identityAvailable =
      reliableIdentityValue(configured?.dev) &&
      reliableIdentityValue(configured?.ino) &&
      reliableIdentityValue(inspected?.dev) &&
      reliableIdentityValue(inspected?.ino);
    if (!identityAvailable) {
      return { matches: false, verifiedBy: "unavailable" };
    }
    return {
      matches:
        configured.dev === inspected.dev && configured.ino === inspected.ino,
      verifiedBy: "device-and-inode",
    };
  } catch {
    return { matches: false, verifiedBy: "unavailable" };
  }
}

function configuredDatabasePath(databaseUrl, servicePlan) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) return null;
  const value = databaseUrl.trim();
  if (value === ":memory:") return null;
  if (value.startsWith("file:")) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  if (isAbsolute(value)) return resolve(value);
  const backendServices = Array.isArray(servicePlan?.projectServices)
    ? servicePlan.projectServices.filter(
        (service) => service?.name === "sentelligent-backend.service",
      )
    : [];
  const workingDirectory = backendServices[0]?.WorkingDirectory;
  if (
    backendServices.length !== 1 ||
    typeof workingDirectory !== "string" ||
    !isAbsolute(workingDirectory)
  ) {
    return null;
  }
  return resolve(workingDirectory, value);
}

function serviceEnvironmentBindingMatches(
  servicePlan,
  envFilePath,
  envFileSha256,
  fileSystem = defaultIdentityFileSystem,
) {
  if (
    typeof envFilePath !== "string" ||
    !envFilePath ||
    !/^[a-f0-9]{64}$/.test(String(envFileSha256 ?? ""))
  ) {
    return false;
  }
  const services = Array.isArray(servicePlan?.projectServices)
    ? servicePlan.projectServices
    : [];
  let expectedRealPath;
  try {
    expectedRealPath = normalizedNativePath(fileSystem.realpath(resolve(envFilePath)));
  } catch {
    return false;
  }
  return BACKEND_ENVIRONMENT_SERVICES.every((serviceName) => {
    const matches = services.filter((service) => service?.name === serviceName);
    if (matches.length !== 1) return false;
    const service = matches[0];
    if (
      typeof service.EnvironmentFile !== "string" ||
      service.EnvironmentFileSha256 !== envFileSha256
    ) {
      return false;
    }
    try {
      return normalizedNativePath(
        fileSystem.realpath(resolve(service.EnvironmentFile)),
      ) === expectedRealPath;
    } catch {
      return false;
    }
  });
}

function hasRequiredEnvironmentContract(value) {
  if (!Array.isArray(value) || value.length !== REQUIRED_ENV_NAMES.length) {
    return false;
  }
  const names = new Set(value);
  return (
    names.size === REQUIRED_ENV_NAMES.length &&
    REQUIRED_ENV_NAMES.every((name) => names.has(name))
  );
}

function hasLegacyCurrentEnvironmentContract(value) {
  if (
    !Array.isArray(value) ||
    value.length !== LEGACY_CURRENT_REQUIRED_ENV_NAMES.length
  ) {
    return false;
  }
  const names = new Set(value);
  return (
    names.size === LEGACY_CURRENT_REQUIRED_ENV_NAMES.length &&
    LEGACY_CURRENT_REQUIRED_ENV_NAMES.every((name) => names.has(name))
  );
}

function hasExactFrontendBuildProvenance(manifest) {
  const frontend = manifest?.buildProvenance?.frontend;
  const lockfile = frontend?.lockfile;
  const runtime = frontend?.runtime;
  const install = frontend?.install;
  const environment = frontend?.environment;
  const allowedNames = Array.isArray(environment?.allowedNames)
    ? environment.allowedNames
    : [];
  const lockfilePath = "outputs/product-design-prototype/package-lock.json";
  return (
    isRecord(frontend) &&
    isRecord(lockfile) &&
    lockfile.path === lockfilePath &&
    /^[a-f0-9]{64}$/.test(lockfile.sha256) &&
    lockfile.lockfileVersion === 3 &&
    isRecord(manifest.sourceHashes?.files) &&
    manifest.sourceHashes.files[lockfilePath] === lockfile.sha256 &&
    isRecord(runtime) &&
    nodeMajor(runtime.node) >= 24 &&
    /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(runtime.npm) &&
    [
      "SENTELLIGENT_RELEASE_NPM_CLI",
      "npm_execpath",
      "node-adjacent",
      "node-lib-adjacent",
      "PATH",
    ].includes(runtime.npmResolutionSource) &&
    ["win32", "linux", "darwin"].includes(runtime.platform) &&
    typeof runtime.architecture === "string" &&
    /^[A-Za-z0-9_-]{1,32}$/.test(runtime.architecture) &&
    isRecord(install) &&
    install.command === "npm ci" &&
    install.ignoreScripts === true &&
    install.includeDev === true &&
    isRecord(environment) &&
    environment.identity === "sentelligent-release-frontend-v1" &&
    allowedNames.length > 0 &&
    new Set(allowedNames).size === allowedNames.length &&
    allowedNames.every(
      (name) =>
        typeof name === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) &&
        !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(name),
    ) &&
    allowedNames.includes("NODE_ENV") &&
    allowedNames.includes("PATH") &&
    allowedNames.includes("SENTELLIGENT_RELEASE_BUILD_ENV")
  );
}

function hasExactBackendDependencyProvenance(manifest) {
  const backend = manifest?.buildProvenance?.backend;
  const lockfile = backend?.lockfile;
  const runtime = backend?.runtime;
  const install = backend?.install;
  const lockfilePath = "backend/package-lock.json";
  return (
    isRecord(backend) &&
    isRecord(lockfile) &&
    lockfile.path === lockfilePath &&
    /^[a-f0-9]{64}$/.test(lockfile.sha256) &&
    lockfile.lockfileVersion === 3 &&
    isRecord(manifest.sourceHashes?.files) &&
    manifest.sourceHashes.files[lockfilePath] === lockfile.sha256 &&
    isRecord(runtime) &&
    nodeMajor(runtime.node) >= 24 &&
    /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(runtime.npm) &&
    [
      "SENTELLIGENT_RELEASE_NPM_CLI",
      "npm_execpath",
      "node-adjacent",
      "node-lib-adjacent",
      "PATH",
    ].includes(runtime.npmResolutionSource) &&
    runtime.platform === "linux" &&
    runtime.architecture === "x64" &&
    isRecord(install) &&
    install.command === "npm ci" &&
    install.ignoreScripts === true &&
    install.omitDev === true
  );
}

function manifestShapeError(
  manifest,
  expectedCommit,
  { allowLegacyCurrentEnvironmentNames = false } = {},
) {
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION ||
    manifest.product !== RELEASE_PRODUCT
  ) {
    return "Release manifest schemaVersion and product must match the release packager contract.";
  }
  if (
    !isRecord(manifest.source) ||
    manifest.source.commit !== expectedCommit ||
    manifest.source.clean !== true
  ) {
    return "Release manifest source must identify the exact commit and a clean packaged worktree.";
  }
  if (
    !(
      allowLegacyCurrentEnvironmentNames
        ? hasLegacyCurrentEnvironmentContract(manifest.requiredEnvNames)
        : hasRequiredEnvironmentContract(manifest.requiredEnvNames)
    )
  ) {
    return "Release manifest required environment names must exactly match the release packager contract.";
  }
  if (!hasExactFrontendBuildProvenance(manifest)) {
    return "Release manifest must bind the frontend build to its committed lockfile, npm runtime, isolated install, and allowlisted environment.";
  }
  if (!hasExactBackendDependencyProvenance(manifest)) {
    return "Release manifest must bind the packaged backend production dependency tree to its committed lockfile and isolated production-only install.";
  }
  if (
    !isCanonicalIsoTimestamp(manifest.createdAt) ||
    !isRecord(manifest.archive) ||
    manifest.archive.format !== "tar.gz" ||
    manifest.archive.rootDirectory !==
      `${RELEASE_PRODUCT}-${expectedCommit.slice(0, 12)}` ||
    !Number.isSafeInteger(manifest.archive.packagedFiles) ||
    manifest.archive.packagedFiles < 2
  ) {
    return "Release manifest timestamp and archive metadata must match the release packager contract.";
  }
  return null;
}

export function validateImmutableReleaseEntryMetadata(
  metadata,
  { directory, enforcePosix = process.platform !== "win32" } = {},
) {
  if (
    !metadata ||
    typeof metadata.isDirectory !== "function" ||
    typeof metadata.isFile !== "function" ||
    typeof metadata.isSymbolicLink !== "function" ||
    metadata.isSymbolicLink()
  ) {
    return false;
  }
  if (directory ? !metadata.isDirectory() : !metadata.isFile()) return false;
  if (!directory && metadata.nlink !== 1n && metadata.nlink !== 1) return false;
  if (!enforcePosix) return true;
  const uid = typeof metadata.uid === "bigint" ? metadata.uid : BigInt(metadata.uid);
  const gid = typeof metadata.gid === "bigint" ? metadata.gid : BigInt(metadata.gid);
  const mode = typeof metadata.mode === "bigint" ? metadata.mode : BigInt(metadata.mode);
  return uid === 0n && gid === 0n && (mode & 0o022n) === 0n;
}

function collectReleaseFiles(
  releaseDirectoryPath,
  { enforcePosix = process.platform !== "win32" } = {},
) {
  const requestedRoot = resolve(releaseDirectoryPath);
  const root = realpathSync.native(requestedRoot);
  if (normalizedNativePath(root) !== normalizedNativePath(requestedRoot)) {
    throw new Error("release root or one of its ancestors is redirected");
  }
  const rootMetadata = lstatSync(root, { bigint: true });
  const validRoot = validateImmutableReleaseEntryMetadata(rootMetadata, {
    directory: true,
    enforcePosix,
  });
  if (!validRoot) {
    throw new Error("release root is not a directory");
  }
  const files = [];

  function visit(directoryPath, relativeDirectory = "") {
    const entries = readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => compareUtf8Paths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (!isCanonicalReleaseFilePath(relativePath) || entry.isSymbolicLink()) {
        throw new Error("release contains an unsafe path");
      }
      const filePath = resolve(directoryPath, entry.name);
      const realFilePath = realpathSync.native(filePath);
      const escaped = relative(root, realFilePath);
      if (
        escaped === ".." ||
        escaped.startsWith(`..${sep}`) ||
        isAbsolute(escaped)
      ) {
        throw new Error("release entry escaped its immutable root");
      }
      const metadata = lstatSync(filePath, { bigint: true });
      if (entry.isDirectory()) {
        const validDirectory = validateImmutableReleaseEntryMetadata(metadata, {
          directory: true,
          enforcePosix,
        });
        if (!validDirectory) {
          throw new Error("release contains a mutable directory");
        }
        visit(filePath, relativePath);
      } else if (entry.isFile()) {
        const validFile = validateImmutableReleaseEntryMetadata(metadata, {
          directory: false,
          enforcePosix,
        });
        if (!validFile) {
          throw new Error("release contains a mutable or hard-linked file");
        }
        files.push(relativePath);
      } else {
        throw new Error("release contains a non-regular file");
      }
    }
  }

  visit(root);
  return {
    root,
    files: files.sort(compareUtf8Paths),
  };
}

function validHashSection(section, pathIsAllowed) {
  if (
    !isRecord(section) ||
    section.algorithm !== "sha256" ||
    !isRecord(section.files)
  ) {
    return false;
  }
  const entries = Object.entries(section.files);
  return (
    entries.length > 0 &&
    entries.every(
      ([file, hash]) =>
        isCanonicalReleaseFilePath(file) &&
        pathIsAllowed(file) &&
        /^[a-f0-9]{64}$/.test(hash),
    )
  );
}

function sameFileHashes(expected, actual) {
  const expectedFiles = Object.keys(expected).sort(compareUtf8Paths);
  const actualFiles = Object.keys(actual).sort(compareUtf8Paths);
  return (
    JSON.stringify(expectedFiles) === JSON.stringify(actualFiles) &&
    actualFiles.every((file) => expected[file] === actual[file])
  );
}

function verifyReleaseContents(
  manifest,
  releaseDirectoryPath,
  { enforcePosix = process.platform !== "win32" } = {},
) {
  try {
    const buildSection = manifest.buildHashes;
    const migrationSection = manifest.migrationChecksums;
    const dependencySection = manifest.productionDependencyHashes;
    const sourceSection = manifest.sourceHashes;
    if (
      !validHashSection(
        buildSection,
        (file) => file.startsWith(RELEASE_BUILD_PREFIX),
      ) ||
      !validHashSection(
        migrationSection,
        (file) => file.startsWith(RELEASE_MIGRATION_PREFIX),
      ) ||
      !validHashSection(
        dependencySection,
        (file) => file.startsWith(RELEASE_PRODUCTION_DEPENDENCY_PREFIX),
      ) ||
      !/^[a-f0-9]{64}$/.test(dependencySection.treeSha256) ||
      !validHashSection(
        sourceSection,
        (file) =>
          file !== RELEASE_MANIFEST_FILE &&
          !file.startsWith(RELEASE_BUILD_PREFIX) &&
          !file.startsWith(RELEASE_PRODUCTION_DEPENDENCY_PREFIX),
      ) ||
      !/^[a-f0-9]{64}$/.test(sourceSection.treeSha256)
    ) {
      return {
        valid: false,
        message: "Release manifest hash sections must match the release packager contract.",
      };
    }

    const { root, files } = collectReleaseFiles(releaseDirectoryPath, {
      enforcePosix,
    });
    if (
      !files.includes(RELEASE_MANIFEST_FILE) ||
      manifest.archive.packagedFiles !== files.length
    ) {
      return {
        valid: false,
        message: "Release manifest packaged file count does not match the release directory.",
      };
    }
    const packagedFiles = files.filter((file) => file !== RELEASE_MANIFEST_FILE);
    const buildFiles = packagedFiles.filter((file) =>
      file.startsWith(RELEASE_BUILD_PREFIX)
    );
    const migrationFiles = packagedFiles.filter((file) =>
      file.startsWith(RELEASE_MIGRATION_PREFIX)
    );
    const dependencyFiles = packagedFiles.filter((file) =>
      file.startsWith(RELEASE_PRODUCTION_DEPENDENCY_PREFIX)
    );
    const sourceFiles = packagedFiles.filter(
      (file) =>
        !file.startsWith(RELEASE_BUILD_PREFIX) &&
        !file.startsWith(RELEASE_PRODUCTION_DEPENDENCY_PREFIX),
    );
    const actualHashes = Object.fromEntries(
      packagedFiles.map((file) => [
        file,
        readStableRegularFile(resolve(root, ...file.split("/")), {
          label: `release file ${file}`,
        }).sha256,
      ]),
    );
    const actualBuildHashes = Object.fromEntries(
      buildFiles.map((file) => [file, actualHashes[file]]),
    );
    const actualMigrationHashes = Object.fromEntries(
      migrationFiles.map((file) => [file, actualHashes[file]]),
    );
    const actualDependencyHashes = Object.fromEntries(
      dependencyFiles.map((file) => [file, actualHashes[file]]),
    );
    const actualSourceHashes = Object.fromEntries(
      sourceFiles.map((file) => [file, actualHashes[file]]),
    );
    const serviceEntriesPresent = Object.values(
      IMMUTABLE_RELEASE_SERVICE_ENTRIES,
    ).every(({ entryPath }) => Object.hasOwn(actualSourceHashes, entryPath));
    if (
      !serviceEntriesPresent ||
      !sameFileHashes(buildSection.files, actualBuildHashes) ||
      !sameFileHashes(migrationSection.files, actualMigrationHashes) ||
      !sameFileHashes(dependencySection.files, actualDependencyHashes) ||
      dependencySection.treeSha256 !==
        sourceTreeSha256(actualDependencyHashes) ||
      !sameFileHashes(sourceSection.files, actualSourceHashes) ||
      sourceSection.treeSha256 !== sourceTreeSha256(actualSourceHashes)
    ) {
      return {
        valid: false,
        message: "Release build, source, migration, or production dependency files do not match the manifest SHA-256 inventory.",
      };
    }
    return { valid: true };
  } catch {
    return {
      valid: false,
      message: "Release directory could not be read as a complete regular-file package.",
    };
  }
}

function verifyLegacyReleaseContents(
  manifest,
  releaseDirectoryPath,
  { enforcePosix = process.platform !== "win32" } = {},
) {
  try {
    const buildSection = manifest.buildHashes;
    const migrationSection = manifest.migrationChecksums;
    const sourceSection = manifest.sourceHashes;
    if (
      !validHashSection(buildSection, (file) =>
        file.startsWith(RELEASE_BUILD_PREFIX),
      ) ||
      !validHashSection(migrationSection, (file) =>
        file.startsWith(RELEASE_MIGRATION_PREFIX),
      ) ||
      !validHashSection(sourceSection, (file) =>
        file !== RELEASE_MANIFEST_FILE &&
        !file.startsWith(RELEASE_BUILD_PREFIX),
      )
    ) {
      return { valid: false, message: "Legacy release manifest hash sections are invalid." };
    }
    const { root, files } = collectReleaseFiles(releaseDirectoryPath, {
      enforcePosix,
    });
    if (
      !files.includes(RELEASE_MANIFEST_FILE) ||
      manifest.archive?.packagedFiles !== files.length
    ) {
      return {
        valid: false,
        message: "Legacy release manifest packaged file count does not match the release directory.",
      };
    }
    const packagedFiles = new Set(files.filter((file) => file !== RELEASE_MANIFEST_FILE));
    const expectedFiles = new Set([
      ...Object.keys(buildSection.files),
      ...Object.keys(migrationSection.files),
      ...Object.keys(sourceSection.files),
    ]);
    const unexpectedFiles = [...packagedFiles].filter(
      (file) => !expectedFiles.has(file),
    );
    if (unexpectedFiles.length > 0) {
      return { valid: false, message: "Legacy release contains files outside its verified hash inventory." };
    }
    const hashFor = (file) =>
      readStableRegularFile(resolve(root, ...file.split("/")), {
        label: `legacy release file ${file}`,
      }).sha256;
    const actualBuild = Object.fromEntries(
      Object.keys(buildSection.files).map((file) => [file, hashFor(file)]),
    );
    const actualMigration = Object.fromEntries(
      Object.keys(migrationSection.files).map((file) => [file, hashFor(file)]),
    );
    const actualSource = Object.fromEntries(
      Object.keys(sourceSection.files).map((file) => [file, hashFor(file)]),
    );
    if (
      !sameFileHashes(buildSection.files, actualBuild) ||
      !sameFileHashes(migrationSection.files, actualMigration) ||
      !sameFileHashes(sourceSection.files, actualSource) ||
      !Object.hasOwn(actualSource, "backend/src/server.js") ||
      !Object.hasOwn(actualSource, "backend/src/weixin/worker.js") ||
      !Object.hasOwn(actualSource, "outputs/product-design-prototype/scripts/static-server.mjs")
    ) {
      return { valid: false, message: "Legacy release file hashes do not match the manifest inventory." };
    }
    if (
      sourceSection.treeSha256 &&
      sourceSection.treeSha256 !== sourceTreeSha256(actualSource)
    ) {
      return { valid: false, message: "Legacy release source tree hash does not match the manifest inventory." };
    }
    return { valid: true };
  } catch {
    return {
      valid: false,
      message: "Legacy release directory could not be read as a complete regular-file package.",
    };
  }
}

export function validateReleaseIdentity({
  manifest,
  manifestPath,
  releaseDirectoryPath,
  expectedCommit,
  servicePlan,
  enforcePosix = process.platform !== "win32",
  allowLegacyCurrent = false,
  currentReleasePath = "",
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(String(expectedCommit ?? ""))) {
    return {
      valid: false,
      message: "Expected release commit must be exactly 40 lowercase hexadecimal characters.",
    };
  }
  if (!isRecord(manifest) || manifest.source?.commit !== expectedCommit) {
    return {
      valid: false,
      message: "Release manifest source commit must exactly match the expected commit.",
    };
  }
  const releasePath = immutableReleaseRoot(manifestPath);
  if (releasePath === null) {
    return {
      valid: false,
      message:
        "Release manifest must resolve to /opt/sentelligent-sales-workbench/releases/<safe-id>/release-manifest.json.",
    };
  }
  const legacySchema2 =
    allowLegacyCurrent &&
    manifest.schemaVersion === 2 &&
    currentReleasePath === releasePath;
  const legacySchema3 =
    allowLegacyCurrent &&
    manifest.schemaVersion === RELEASE_MANIFEST_SCHEMA_VERSION &&
    currentReleasePath === releasePath &&
    hasLegacyCurrentEnvironmentContract(manifest.requiredEnvNames);
  if (!legacySchema2 && !legacySchema3) {
    const shapeError = manifestShapeError(manifest, expectedCommit);
    if (shapeError !== null) {
      return { valid: false, message: shapeError };
    }
  } else if (legacySchema2) {
    if (
      manifest.product !== RELEASE_PRODUCT ||
      !isRecord(manifest.source) ||
      manifest.source.commit !== expectedCommit ||
      manifest.source.clean !== true ||
      !isRecord(manifest.archive) ||
      manifest.archive.format !== "tar.gz" ||
      manifest.archive.rootDirectory !==
        `${RELEASE_PRODUCT}-${expectedCommit.slice(0, 12)}` ||
      !Number.isSafeInteger(manifest.archive.packagedFiles)
    ) {
      return {
        valid: false,
        message: "Legacy current release identity is incomplete.",
      };
    }
  } else {
    const shapeError = manifestShapeError(manifest, expectedCommit, {
      allowLegacyCurrentEnvironmentNames: true,
    });
    if (shapeError !== null) {
      return { valid: false, message: shapeError };
    }
  }

  const services = Array.isArray(servicePlan?.projectServices)
    ? servicePlan.projectServices
    : [];
  for (const serviceName of Object.keys(IMMUTABLE_RELEASE_SERVICE_ENTRIES)) {
    const profile = IMMUTABLE_RELEASE_SERVICE_ENTRIES[serviceName];
    const matchingServices = services.filter(
      (service) => service?.name === serviceName,
    );
    const service = matchingServices[0];
    if (
      matchingServices.length !== 1 ||
      immutableServiceReleaseRoot(
        serviceName,
        service?.ExecStart,
      ) !== releasePath ||
      service?.WorkingDirectory !==
        `${releasePath}/${profile.workingDirectoryPath}`
    ) {
      return {
        valid: false,
        message:
          "Backend, frontend, and WeChat ExecStart and WorkingDirectory values must use the project Node 24 runtime and the same immutable release real path as the manifest.",
      };
    }
  }

  const releaseContents = (legacySchema2 ? verifyLegacyReleaseContents : verifyReleaseContents)(
    manifest,
    releaseDirectoryPath ?? dirname(resolve(manifestPath)),
    { enforcePosix },
  );
  if (!releaseContents.valid) return releaseContents;

  return {
    valid: true,
    message:
      "Release manifest, commit, and application service paths identify one immutable release.",
    details: {
      commit: expectedCommit,
      releasePath,
    },
  };
}

function isCurrentCentosFrontendCommand(tokens) {
  return JSON.stringify(tokens) === JSON.stringify([
    "/usr/local/bin/node",
    `${DEFAULT_PROJECT_PATH}/frontend/scripts/static-server.mjs`,
    "serve",
    "--host=0.0.0.0",
    "--port=8088",
    `--dist-path=${DEFAULT_PROJECT_PATH}/frontend/dist`,
    "--api-base-url=https://82.156.210.199",
  ]);
}

function isAllowedNodeEntry(
  executable,
  candidate,
  entryPath,
  { allowCentosLegacy = false } = {},
) {
  if (
    executable === PORTABLE_NODE_EXECUTABLE ||
    executable === PROJECT_NODE_EXECUTABLE
  ) {
    return isReleaseEntryPath(candidate, entryPath);
  }
  return (
    allowCentosLegacy &&
    executable === CENTOS_LEGACY_NODE_EXECUTABLE &&
    candidate === `${DEFAULT_PROJECT_PATH}/${entryPath}`
  );
}

export function validateProjectServiceExecStart(serviceName, command) {
  const tokens = exactExecTokens(command);
  if (tokens === null) return false;

  if (serviceName === "sentelligent-backend.service") {
    return (
      tokens.length === 2 &&
      isAllowedNodeEntry(tokens[0], tokens[1], "backend/src/server.js", {
        allowCentosLegacy: true,
      })
    );
  }
  if (serviceName === "sentelligent-frontend.service") {
    return isCurrentCentosFrontendCommand(tokens) || (
      tokens.length === 3 &&
      isAllowedNodeEntry(
        tokens[0],
        tokens[1],
        "outputs/product-design-prototype/scripts/static-server.mjs",
      ) &&
      tokens[2] === "serve"
    );
  }
  if (serviceName === "sentelligent-caddy.service") {
    return (
      (tokens.length === 4 ||
        tokens.length === 6 &&
          tokens[4] === "--adapter" &&
          tokens[5] === "caddyfile") &&
      CADDY_EXECUTABLES.has(tokens[0]) &&
      tokens[1] === "run" &&
      tokens[2] === "--config" &&
      tokens[3] === CADDY_CONFIG_PATH
    );
  }
  if (serviceName === "sentelligent-weixin-agent.service") {
    return (
      tokens.length === 3 &&
      isAllowedNodeEntry(tokens[0], tokens[1], "backend/src/weixin/worker.js", {
        allowCentosLegacy: true,
      }) &&
      tokens[2] === "start"
    );
  }
  return false;
}

export function validateServiceSnapshot(
  plan,
  referenceTime,
  expectedHostIdentity,
  actualHostIdentity,
) {
  const generatedAt = Date.parse(plan?.snapshotGeneratedAt ?? "");
  const reference = Date.parse(referenceTime);
  const age = reference - generatedAt;
  const expectedHostname = expectedHostIdentity?.hostname;
  const expectedMachineId = expectedHostIdentity?.machineId;
  return (
    Number.isFinite(generatedAt) &&
    Number.isFinite(reference) &&
    age >= -5 * 60_000 &&
    age <= 24 * 60 * 60_000 &&
    typeof expectedHostname === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(expectedHostname) &&
    typeof expectedMachineId === "string" &&
    /^[a-f0-9]{32}$/.test(expectedMachineId) &&
    actualHostIdentity?.hostname === expectedHostname &&
    actualHostIdentity?.machineId === expectedMachineId &&
    plan?.hostname === expectedHostname &&
    plan?.machineId === expectedMachineId &&
    approvedProjectPaths(plan) !== null
  );
}

export function inspectHostIdentity({
  hostnameReader = readHostname,
  machineIdPath = "/etc/machine-id",
} = {}) {
  try {
    const hostname = String(hostnameReader()).trim();
    const machineId = readStableRegularFile(machineIdPath, {
      label: "host machine identity",
    }).content.toString("utf8").trim().toLowerCase();
    return { hostname, machineId };
  } catch {
    return null;
  }
}

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

export function validateSystemdExecutionSurface(service) {
  if (
    !isRecord(service) ||
    !EMPTY_SYSTEMD_ARRAY_FIELDS.every(
      (field) => Array.isArray(service[field]) && service[field].length === 0,
    ) ||
    service.RootDirectory !== "" ||
    service.RootImage !== "" ||
    service.ProtectSystem !== "no" ||
    service.ProtectHome !== "no" ||
    (service.name === "sentelligent-caddy.service"
      ? service.PrivateTmp !== false
      : service.PrivateTmp !== true) ||
    service.PrivateDevices !== false ||
    !Array.isArray(service.EnvironmentFiles)
  ) {
    return false;
  }
  const reloads = Array.isArray(service.ExecReload) ? service.ExecReload : null;
  if (reloads === null) return false;
  if (service.name === "sentelligent-caddy.service") {
    const allowedReloads = new Set([
      "/usr/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force",
      "/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force",
    ]);
    const reload = reloads[0] ?? "";
    const structuredReload = reload.match(
      /^\{ path=(\/usr\/(?:local\/)?bin\/caddy) ; argv\[\]=(.+?) ; ignore_errors=no ; .* \}$/u,
    );
    if (
      reloads.length !== 1 ||
      (!allowedReloads.has(reload) &&
        !(structuredReload &&
          allowedReloads.has(`${structuredReload[1]} ${structuredReload[2]}`)))
    ) {
      return false;
    }
  } else if (reloads.length !== 0) {
    return false;
  }
  const environment = Array.isArray(service.Environment)
    ? service.Environment
    : null;
  const expectedEnvironment =
    service.name === "sentelligent-weixin-agent.service"
      ? ["HOME=/opt/sentelligent-sales-workbench/weixin-session"]
      : service.name === "sentelligent-caddy.service"
        ? [
            "HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/etc/caddy",
          ]
        : [];
  if (
    environment === null ||
    JSON.stringify(environment) !== JSON.stringify(expectedEnvironment)
  ) {
    return false;
  }
  if (BACKEND_ENVIRONMENT_SERVICES.includes(service.name)) {
    if (service.EnvironmentFile === undefined) {
      return service.EnvironmentFiles.length === 0;
    }
    return (
      typeof service.EnvironmentFile === "string" &&
      service.EnvironmentFile.length > 0 &&
      service.EnvironmentFiles.length === 1 &&
      service.EnvironmentFiles[0] === service.EnvironmentFile
    );
  }
  if (service.name === "sentelligent-frontend.service") {
    if (
      typeof service.EnvironmentFile !== "string" ||
      service.EnvironmentFile !== FRONTEND_ENVIRONMENT_FILE
    ) {
      return false;
    }
    return (
      service.EnvironmentFiles.length === 1 &&
      service.EnvironmentFiles[0] === service.EnvironmentFile
    );
  }
  return (
    (service.EnvironmentFile === undefined || service.EnvironmentFile === "") &&
    service.EnvironmentFiles.length === 0
  );
}

export function validateProjectServices(plan) {
  const services = Array.isArray(plan?.projectServices)
    ? plan.projectServices
    : [];
  if (approvedProjectPaths(plan) === null) return false;
  const serviceNames = services.map((service) => service?.name);
  if (
    services.length !== REQUIRED_PROJECT_SERVICES.length ||
    new Set(serviceNames).size !== REQUIRED_PROJECT_SERVICES.length ||
    !serviceNames.every((name) => REQUIRED_PROJECT_SERVICE_NAMES.has(name))
  ) {
    return false;
  }
  const serviceMap = new Map(services.map((service) => [service?.name, service]));
  const requiredReady = REQUIRED_PROJECT_SERVICES.every((name) => {
    const service = serviceMap.get(name);
    const fragmentPath = posix.normalize(service?.FragmentPath ?? "");
    const fragmentOwned = [
      `/etc/systemd/system/${name}`,
      `/lib/systemd/system/${name}`,
      `/usr/lib/systemd/system/${name}`,
    ].includes(fragmentPath);
    const workingDirectory = service?.WorkingDirectory;
    const workingDirectoryOwned = name === "sentelligent-caddy.service"
      ? workingDirectory === "" ||
        typeof workingDirectory === "string" &&
          pathWithin(workingDirectory, DEFAULT_PROJECT_PATH)
      : typeof service?.WorkingDirectory === "string" &&
        pathWithin(service.WorkingDirectory, DEFAULT_PROJECT_PATH);
    const execStartOwned =
      typeof service?.ExecStart === "string" &&
      validateProjectServiceExecStart(name, service.ExecStart);
    return (
      service &&
      isEnabled(service.enabled) &&
      isActive(service.active) &&
      fragmentOwned &&
      execStartOwned &&
      SERVICE_USERS[name]?.has(service.User) &&
      workingDirectoryOwned &&
      validateSystemdExecutionSurface(service)
    );
  });
  return requiredReady;
}

export function validatesUnrelatedProtection(plan) {
  const unrelated = Array.isArray(plan?.unrelatedServices)
    ? plan.unrelatedServices
    : [];
  const actions = Array.isArray(plan?.plannedActions) ? plan.plannedActions : [];
  const protectedObjects = new Set(
    Array.isArray(plan?.protectedObjects) ? plan.protectedObjects : [],
  );
  const listeners = Array.isArray(plan?.listeners) ? plan.listeners : [];
  if (
    unrelated.length !== REQUIRED_PROTECTED_SERVICES.length ||
    !REQUIRED_PROTECTED_OBJECTS.every((name) => protectedObjects.has(name))
  ) {
    return false;
  }
  const protectedNames = new Set(unrelated.map((service) => service?.name));
  const inventoryProtected = REQUIRED_PROTECTED_SERVICES.every(
    (required) => {
      const matches = unrelated.filter(
        (service) => service?.name === required.name,
      );
      const service = matches[0];
      return (
        matches.length === 1 &&
        service?.protectionId === required.protectionId &&
        service.protected === true &&
        service.active === true &&
        service.enabled === true &&
        Number.isSafeInteger(service.mainPid) &&
        service.mainPid > 0 &&
        isCanonicalIsoTimestamp(service.activeEnterTimestamp) &&
        [
          `/etc/systemd/system/${required.name}`,
          `/lib/systemd/system/${required.name}`,
          `/usr/lib/systemd/system/${required.name}`,
        ].includes(service.FragmentPath) &&
        /^[a-f0-9]{64}$/.test(String(service.UnitFileSha256 ?? ""))
      );
    },
  );
  const requiredObjectsInventoried = REQUIRED_PROTECTED_OBJECTS.every((name) =>
    unrelated.some((service) => service?.protectionId === name),
  );
  const listenersProtected = listeners.length > 0 && listeners.every(
    (listener) => {
      const service = unrelated.find(
        (candidate) => candidate?.name === listener?.service,
      );
      return (
        Number.isInteger(listener?.port) &&
        listener.port > 0 &&
        listener.port <= 65_535 &&
        listener.protected === true &&
        protectedObjects.has(listener?.owner) &&
        service?.protectionId === listener.owner &&
        service.mainPid === listener.mainPid
      );
    },
  );
  const requiredListenersPresent = REQUIRED_PROTECTED_LISTENERS.every(
    (required) =>
      listeners.some(
        (listener) =>
          listener?.port === required.port &&
          listener?.owner === required.owner &&
          listener?.service === required.service,
      ),
  );
  const actionsIsolated = actions.every(
    (action) => !protectedNames.has(action?.service),
  );
  return (
    inventoryProtected &&
    requiredObjectsInventoried &&
    listenersProtected &&
    requiredListenersPresent &&
    actionsIsolated
  );
}

function makeCheck(id, passed, passedMessage, failedMessage, details) {
  return {
    id,
    status: passed ? "passed" : "failed",
    message: passed ? passedMessage : failedMessage,
    ...(details === undefined ? {} : { details }),
  };
}

function safeReadEnvironment(envFile) {
  try {
    const stable = readStableRegularFile(envFile, {
      label: "production environment snapshot",
    });
    return {
      value: parseEnvFile(stable.content.toString("utf8")),
      path: stable.realPath,
      sha256: stable.sha256,
      error: null,
    };
  } catch {
    return {
      value: {},
      path: "",
      sha256: "",
      error: "production environment snapshot could not be read",
    };
  }
}

function safeReadServicePlan(servicePlanPath) {
  try {
    const stable = readStableRegularFile(servicePlanPath, {
      label: "service protection plan",
    });
    return {
      value: JSON.parse(stable.content.toString("utf8")),
      error: null,
    };
  } catch {
    return { value: {}, error: "service protection plan could not be read" };
  }
}

function safeReadReleaseManifest(releaseManifestPath) {
  try {
    if (typeof releaseManifestPath !== "string" || !releaseManifestPath) {
      throw new Error("release manifest path is missing");
    }
    const stable = readStableRegularFile(releaseManifestPath, {
      label: "release manifest",
    });
    return {
      value: JSON.parse(stable.content.toString("utf8")),
      manifestPath: stable.realPath,
      error: null,
    };
  } catch {
    return {
      value: {},
      manifestPath: "",
      error: "release manifest could not be read and parsed",
    };
  }
}

export async function runProductionPreflight({
  envFile,
  databasePath,
  backupPath,
  expectedBackupSha256,
  expectedOrigins,
  servicePlanPath,
  releaseManifestPath,
  expectedCommit,
  nodeVersion = process.versions.node,
  createdAt = new Date().toISOString(),
  invoiceToolInspector = inspectInvoiceExtractionTools,
  hospitalTenderPythonInspector = inspectHospitalTenderPython,
  expectedHostIdentity,
  hostIdentityInspector = inspectHostIdentity,
} = {}) {
  const environmentResult = safeReadEnvironment(envFile);
  const environment = environmentResult.value;
  const servicePlanResult = safeReadServicePlan(servicePlanPath);
  const servicePlan = servicePlanResult.value;
  const releaseManifestResult = safeReadReleaseManifest(releaseManifestPath);
  let currentReleasePath = "";
  try {
    currentReleasePath = realpathSync.native(PROJECT_CURRENT_PATH);
  } catch {
    currentReleasePath = "";
  }
  const releaseIdentity = releaseManifestResult.error === null
    ? validateReleaseIdentity({
        manifest: releaseManifestResult.value,
        manifestPath: releaseManifestResult.manifestPath,
        expectedCommit,
        servicePlan,
        allowLegacyCurrent: true,
        currentReleasePath,
      })
    : {
        valid: false,
        message: releaseManifestResult.error,
      };
  const database = await inspectSqlite(databasePath ?? "");
  const backup = await inspectSqlite(backupPath ?? "", {
    requireNoSidecars: true,
  });
  const databaseIdentity = compareDatabaseIdentity(
    databasePath ?? "",
    backupPath ?? "",
  );
  const environmentDatabasePath = configuredDatabasePath(
    environment.DATABASE_URL,
    servicePlan,
  );
  const environmentDatabaseIdentity = environmentDatabasePath === null
    ? { matches: false, verifiedBy: "unavailable" }
    : compareSameFileIdentity(environmentDatabasePath, databasePath ?? "");
  const serviceEnvironmentBound = serviceEnvironmentBindingMatches(
    servicePlan,
    environmentResult.path,
    environmentResult.sha256,
  );
  const environmentDatabaseBound =
    environmentResult.error === null &&
    environmentDatabaseIdentity.matches &&
    serviceEnvironmentBound;
  let actualHostIdentity = null;
  try {
    actualHostIdentity = await hostIdentityInspector();
  } catch {
    actualHostIdentity = null;
  }
  const serviceSnapshotValid =
    servicePlanResult.error === null &&
    validateServiceSnapshot(
      servicePlan,
      createdAt,
      expectedHostIdentity,
      actualHostIdentity,
    );

  const actualBackupSha256 = backup.sha256 ?? "";
  const expectedHashValid = /^[a-f0-9]{64}$/i.test(
    String(expectedBackupSha256 ?? ""),
  );
  const backupHashMatches =
    expectedHashValid &&
    actualBackupSha256 === String(expectedBackupSha256).toLowerCase();
  const expectedOriginList = Array.isArray(expectedOrigins)
    ? expectedOrigins
    : [];
  const hospitalTenderPythonRuntimeValid = hasHospitalTenderPythonRuntime(
    environment,
    servicePlan,
    hospitalTenderPythonInspector,
  );

  const checks = [
    makeCheck(
      "release.identity",
      releaseIdentity.valid,
      releaseIdentity.message,
      releaseIdentity.message,
      releaseIdentity.valid ? releaseIdentity.details : undefined,
    ),
    makeCheck(
      "node.version",
      nodeMajor(nodeVersion) >= 24 && hospitalTenderPythonRuntimeValid,
      "Node.js is version 24 or newer and hospital tender Python 3.11+ is executable by the backend service user.",
      "Node.js 24+ and an absolute, protected Python 3.11+ executable available to the backend service user are required.",
    ),
    makeCheck(
      "env.production",
      environmentResult.error === null &&
        environment.NODE_ENV === "production" &&
        hasHospitalTenderSchedulerConfiguration(environment),
      "Environment is explicitly production with the v0.6.0 automatic tender schedule enabled at 60 minutes and 10 customers.",
      environmentResult.error ??
        "NODE_ENV must be production and hospital tender auto-run must be true with the fixed 60-minute/10-customer schedule.",
    ),
    makeCheck(
      "env.authRequired",
      environment.AUTH_REQUIRED === "true",
      "Authentication is required.",
      "AUTH_REQUIRED must be true.",
    ),
    makeCheck(
      "env.authHash",
      Boolean(environment.AUTH_ACCOUNT) &&
        !environment.AUTH_PASSWORD &&
        isCanonicalPasswordHash(environment.AUTH_PASSWORD_HASH),
      "Account authentication uses a canonical scrypt hash without plaintext fallback.",
      "Production authentication requires an account and canonical scrypt hash, with no plaintext password.",
    ),
    makeCheck(
      "env.sessionSecret",
      isStrongSessionValue(environment.AUTH_SESSION_SECRET),
      "Session signing value is canonical base64url with at least 32 bytes.",
      "Session signing value must be canonical base64url with at least 32 bytes.",
    ),
    makeCheck(
      "env.assistantSecrets",
      hasAssistantSecretConfiguration(environment) && hasWeixinOwnerConfiguration(environment, database),
      "WeChat machine owner and assistant secrets are explicitly configured, strong, independent, and match a historical business owner.",
      "WEIXIN_AGENT_OWNER must be explicit and match a historical customer or opportunity owner; machine, confirmation, settings, and optional tender secrets must also be canonical strong independent values.",
    ),
    makeCheck(
      "env.secureCookie",
      environment.AUTH_COOKIE_SECURE === "true",
      "Secure cookies are enabled.",
      "AUTH_COOKIE_SECURE must be true.",
    ),
    makeCheck(
      "env.cors",
      matchesExactCors(environment.CORS_ALLOWED_ORIGINS, expectedOriginList),
      "CORS is restricted to the exact expected HTTPS origin set.",
      "CORS must exactly match the expected HTTPS origin set.",
    ),
    makeCheck(
      "env.solutionWrites",
      environment.SOLUTION_WRITES_ENABLED === "false",
      "Solution write operations are disabled.",
      "SOLUTION_WRITES_ENABLED must be false.",
    ),
    makeCheck(
      "env.aiModel",
      hasProductionModelConfiguration(environment),
      "Expense automation uses the approved production model configuration and an isolated API key.",
      "Production expense automation requires model mode, the approved DeepSeek provider, endpoint and model, a positive timeout, and an isolated non-empty MODEL_API_KEY.",
    ),
    makeCheck(
      "env.icostWebhook",
      hasIcostWebhookConfiguration(environment),
      "The iCost write-only webhook has a strong token, bound owner, and positive rate limits.",
      "The iCost write-only webhook requires a 64-character token, the authenticated owner, and positive integer rate limits.",
    ),
    makeCheck(
      "env.icostIsolation",
      hasIsolatedIcostWebhookToken(environment),
      "The iCost webhook token is isolated from other project credentials.",
      "The iCost webhook token must not reuse the session, model, or WeChat credential.",
    ),
    makeCheck(
      "env.invoiceExtraction",
      hasInvoiceExtractionConfiguration(
        environment,
        servicePlan,
        invoiceToolInspector,
      ),
      "Invoice OCR and PDF extraction tools are executable files with safe settings.",
      "Invoice OCR/PDF commands must be absolute executable files, with safe OCR languages and a positive extraction timeout.",
    ),
    makeCheck(
      "database.environmentBinding",
      environmentDatabaseBound,
      "DATABASE_URL, the inspected database, and backend service EnvironmentFile snapshots identify the same production configuration.",
      "DATABASE_URL must explicitly identify the inspected database, and backend/WeChat services must snapshot the same environment file path and SHA-256.",
      {
        databaseVerifiedBy: environmentDatabaseIdentity.verifiedBy,
        serviceBindings: serviceEnvironmentBound
          ? BACKEND_ENVIRONMENT_SERVICES.length
          : 0,
      },
    ),
    makeCheck(
      "database.quickCheck",
      database.quickCheck === "ok",
      "Primary database PRAGMA quick_check returned ok.",
      database.error ?? "Primary database PRAGMA quick_check failed.",
    ),
    makeCheck(
      "database.foreignKeys",
      database.foreignKeyViolations === 0,
      "Primary database has no foreign key violations.",
      "Primary database has foreign key violations or could not be inspected.",
      database.foreignKeyViolations === null
        ? undefined
        : { violations: database.foreignKeyViolations },
    ),
    makeCheck(
      "backup.identity",
      databaseIdentity.distinct,
      "Backup resolves to a different file identity from the primary database.",
      "Backup must not be the primary database, a symlink to it, or a hard link to it.",
      { verifiedBy: databaseIdentity.verifiedBy },
    ),
    makeCheck(
      "backup.sha256",
      backupHashMatches,
      "Backup SHA-256 matches the separately recorded value.",
      "Backup SHA-256 is missing, malformed, or does not match.",
      actualBackupSha256 ? { actualSha256: actualBackupSha256 } : undefined,
    ),
    makeCheck(
      "backup.quickCheck",
      backup.quickCheck === "ok",
      "Backup database PRAGMA quick_check returned ok.",
      backup.error ?? "Backup database PRAGMA quick_check failed.",
    ),
    makeCheck(
      "backup.foreignKeys",
      backup.foreignKeyViolations === 0,
      "Backup database has no foreign key violations.",
      "Backup database has foreign key violations or could not be inspected.",
      backup.foreignKeyViolations === null
        ? undefined
        : { violations: backup.foreignKeyViolations },
    ),
    makeCheck(
      "services.snapshot",
      serviceSnapshotValid,
      "Service inventory is a current, host-identified read-only snapshot with approved project paths.",
      servicePlanResult.error ??
        "Service snapshot requires a recent snapshotGeneratedAt, hostname, and approved project paths.",
    ),
    makeCheck(
      "services.project",
      servicePlanResult.error === null && validateProjectServices(servicePlan),
      "All required project services are active, enabled, and exclusively targeted.",
      servicePlanResult.error ??
        "Required project services must be active, enabled, and the only action targets.",
    ),
    makeCheck(
      "services.commands",
      servicePlanResult.error === null &&
        validatePlannedCommands(servicePlan),
      "Every planned command exactly matches one allowed systemctl action for one project service.",
      servicePlanResult.error ??
        "Planned commands must use the exact single-service systemctl allowlist without shell syntax.",
    ),
    makeCheck(
      "services.unrelatedProtection",
      servicePlanResult.error === null &&
        validatesUnrelatedProtection(servicePlan),
      "Unrelated services are inventoried, protected, and excluded from every planned action.",
      servicePlanResult.error ??
        "Unrelated services must be protected and broad process or service commands are forbidden.",
    ),
  ];
  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.length - passed;
  return {
    schemaVersion: 2,
    product: RELEASE_PRODUCT,
    generatedAt: new Date(createdAt).toISOString(),
    status: failed === 0 ? "passed" : "failed",
    scope: {
      releasePath: releaseIdentity.valid
        ? releaseIdentity.details.releasePath
        : null,
      expectedCommit: releaseIdentity.valid ? expectedCommit : null,
      databasePath: environmentDatabaseBound ? database.realPath : null,
      hostname: serviceSnapshotValid ? expectedHostIdentity.hostname : null,
      machineIdSha256: serviceSnapshotValid
        ? createHash("sha256")
            .update(expectedHostIdentity.machineId)
            .digest("hex")
        : null,
    },
    summary: {
      total: checks.length,
      passed,
      failed,
    },
    checks,
  };
}

function parseArguments(argv) {
  const options = { expectedOrigins: [] };
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (name === "env-file") options.envFile = value;
    else if (name === "database") options.databasePath = value;
    else if (name === "backup") options.backupPath = value;
    else if (name === "backup-sha256") options.expectedBackupSha256 = value;
    else if (name === "expected-origin") options.expectedOrigins.push(value);
    else if (name === "service-plan") options.servicePlanPath = value;
    else if (name === "release-manifest") options.releaseManifestPath = value;
    else if (name === "expected-commit") options.expectedCommit = value;
    else if (name === "expected-hostname") options.expectedHostname = value;
    else if (name === "expected-machine-id") options.expectedMachineId = value;
    else if (name === "report") options.reportPath = value;
    else throw new Error(`Unknown argument: --${name}`);
  }
  for (const name of [
    "envFile",
    "databasePath",
    "backupPath",
    "expectedBackupSha256",
    "servicePlanPath",
    "releaseManifestPath",
    "expectedCommit",
    "expectedHostname",
    "expectedMachineId",
  ]) {
    if (!options[name]) throw new Error(`Missing required preflight option: ${name}`);
  }
  if (options.expectedOrigins.length === 0) {
    throw new Error("At least one --expected-origin is required");
  }
  return options;
}

async function main() {
  const {
    reportPath,
    expectedHostname,
    expectedMachineId,
    ...options
  } = parseArguments(process.argv.slice(2));
  const report = await runProductionPreflight({
    ...options,
    expectedHostIdentity: {
      hostname: expectedHostname,
      machineId: expectedMachineId,
    },
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    const absoluteReportPath = resolve(reportPath);
    mkdirSync(dirname(absoluteReportPath), { recursive: true });
    writeFileSync(absoluteReportPath, output, { flag: "wx", mode: 0o600 });
  }
  if (report.status === "passed") process.stdout.write(output);
  else {
    process.stderr.write(output);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
