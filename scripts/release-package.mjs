import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { gzipSync } from "node:zlib";

const defaultRoot = resolve(import.meta.dirname, "..");
const GIT_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
const PRODUCT_FRONTEND_PATH = join("outputs", "product-design-prototype");
const PRODUCT_DIST_PATH = join(PRODUCT_FRONTEND_PATH, "dist");
const PRODUCT_DIST_PREFIX = "outputs/product-design-prototype/dist/";
const PRODUCT_NODE_MODULES_PREFIX = "outputs/product-design-prototype/node_modules/";
const PRODUCT_LOCKFILE_RELEASE_PATH = "outputs/product-design-prototype/package-lock.json";
const BACKEND_PATH = "backend";
const BACKEND_LOCKFILE_RELEASE_PATH = "backend/package-lock.json";
const BACKEND_NODE_MODULES_PATH = join(BACKEND_PATH, "node_modules");
const BACKEND_NODE_MODULES_PREFIX = "backend/node_modules/";
const FRONTEND_BUILD_ENVIRONMENT_IDENTITY = "sentelligent-release-frontend-v1";
const RELEASE_NPM_CLI_ENV = "SENTELLIGENT_RELEASE_NPM_CLI";
const WINDOWS_IMPLICIT_BUILD_ENV_NAMES = Object.freeze([
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "SYSTEMDRIVE",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
]);

export const REQUIRED_ENV_NAMES = Object.freeze([
  "NODE_ENV",
  "HOST",
  "PORT",
  "DATABASE_URL",
  "AUTH_REQUIRED",
  "AUTH_ACCOUNT",
  "AUTH_PASSWORD_HASH",
  "AUTH_SESSION_SECRET",
  "ASSISTANT_CONFIRMATION_SECRET",
  "AUTH_COOKIE_NAME",
  "AUTH_COOKIE_SECURE",
  "CORS_ALLOWED_ORIGINS",
  "JSON_BODY_LIMIT_BYTES",
  "SOLUTION_WRITES_ENABLED",
  "AI_ANALYSIS_MODE",
  "MODEL_PROVIDER",
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "MODEL_NAME",
  "MODEL_TIMEOUT_MS",
  "VOICE_RECORDINGS_DIR",
  "WEIXIN_AGENT_API_TOKEN",
  "WEIXIN_AGENT_BACKEND_URL",
  "WEIXIN_AGENT_OWNER",
  "WEIXIN_AGENT_SESSION_HOME",
  "ICOST_WEBHOOK_TOKEN",
  "ICOST_WEBHOOK_OWNER",
  "ICOST_WEBHOOK_RATE_LIMIT",
  "ICOST_WEBHOOK_WINDOW_MS",
  "INVOICE_OCR_COMMAND",
  "INVOICE_PDF_TEXT_COMMAND",
  "INVOICE_OCR_LANGUAGES",
  "INVOICE_TEXT_EXTRACTION_TIMEOUT_MS",
]);

const PROJECT_SERVICE_UNITS = Object.freeze([
  "sentelligent-backend.service",
  "sentelligent-frontend.service",
  "sentelligent-weixin-agent.service",
]);

const excludedDirectoryNames = new Set([
  ".agents",
  ".cache",
  ".codex",
  ".git",
  ".npm-cache",
  ".pnpm-store",
  ".runtime",
  ".worktrees",
  "audio-session",
  "audio-sessions",
  "build",
  "coverage",
  "log",
  "logs",
  "node_modules",
  "session",
  "sessions",
  "temp",
  "tmp",
  "runtime-audio",
  "runtime-audios",
  "voice-assets",
  "voice-recordings",
  "voice-session",
  "voice-sessions",
  "weixin-session",
  "weixin-session-home",
]);

const highRiskSecretPatterns = Object.freeze([
  { name: "provider-key", expression: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "aws-access-key", expression: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "github-token",
    expression: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  },
  { name: "google-api-key", expression: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  {
    name: "bearer-token",
    expression: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/gi,
  },
  {
    name: "private-key",
    expression: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
  },
]);

const sensitiveAssignmentPattern =
  /(?:^|[\r\n,{;])[ \t]*(?:(?:export[ \t]+)?(?:const|let|var)[ \t]+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|`((?:\\.|[^`\\$\r\n])*)`|([^,"'`\r\n\]#;]*))/g;

const explicitTextExtensions = new Set([
  ".cjs",
  ".conf",
  ".config",
  ".css",
  ".env",
  ".example",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".npmrc",
  ".properties",
  ".ps1",
  ".service",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const configurationAssignmentExtensions = new Set([
  ".conf",
  ".config",
  ".env",
  ".example",
  ".ini",
  ".json",
  ".npmrc",
  ".properties",
  ".toml",
  ".yaml",
  ".yml",
]);

function normalizeRelativePath(filePath) {
  return String(filePath)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function isCredentialTemplatePath(filePath) {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  const fileName = normalized.split("/").at(-1);
  if (fileName.endsWith(".env.example")) return true;
  const hasTemplateMarker =
    /(?:^|[._-])(?:example|sample|template)(?:[._-]|$)/.test(fileName);
  const hasCredentialMarker =
    /(?:credential|secret|token|password|private[._-]?key|api[._-]?key|auth|service[._-]?account|env|config)/.test(
      fileName,
    );
  return hasTemplateMarker && hasCredentialMarker;
}

function isSensitiveAssignmentName(name) {
  const compact = String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return [
    "credential",
    "password",
    "passwordhash",
    "passphrase",
    "secret",
    "secrethash",
    "token",
    "tokenhash",
    "accesstoken",
    "refreshtoken",
    "authtoken",
    "apitoken",
    "clientsecret",
    "apisecret",
    "apikey",
    "privatekey",
    "privatekeypem",
    "accesskey",
  ].some(
    (suffix) => compact === suffix || compact.endsWith(suffix),
  );
}

const testFixtureMarkers = new Set([
  "admin",
  "analysis",
  "audit",
  "blocked",
  "csrf",
  "dev",
  "development",
  "dummy",
  "example",
  "fake",
  "fixture",
  "local",
  "machine",
  "mock",
  "model",
  "password",
  "qa",
  "sample",
  "secret",
  "test",
  "token",
  "unit",
  "visual",
  "wrong",
]);

const placeholderLeadWords = new Set([
  "change",
  "dev",
  "development",
  "dummy",
  "example",
  "fake",
  "fixture",
  "invalid",
  "legacy",
  "local",
  "mock",
  "must",
  "not",
  "placeholder",
  "qa",
  "redacted",
  "replace",
  "rotated",
  "sample",
  "sentinel",
  "tbd",
  "test",
  "todo",
  "too",
  "unit",
  "unset",
  "warning",
  "wrong",
  "wx",
  "your",
]);

const placeholderWords = new Set([
  ...placeholderLeadWords,
  ...testFixtureMarkers,
  "a",
  "access",
  "api",
  "backend",
  "be",
  "client",
  "conflict",
  "credential",
  "current",
  "env",
  "existing",
  "expired",
  "expense",
  "error",
  "export",
  "extra",
  "failure",
  "for",
  "from",
  "hash",
  "here",
  "in",
  "icost",
  "key",
  "login",
  "logout",
  "me",
  "methods",
  "new",
  "old",
  "only",
  "plaintext",
  "private",
  "production",
  "provider",
  "restore",
  "restored",
  "session",
  "shared",
  "short",
  "stale",
  "tests",
  "used",
  "value",
  "webhook",
  "weixin",
]);

function isTestSourcePath(filePath) {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  return (
    /(?:^|\/)(?:__tests__|fixtures|test|tests)(?:\/|$)/.test(normalized) ||
    /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function placeholderParts(value) {
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  if (
    normalized.length > 96 ||
    !/^[A-Za-z0-9]+(?:[-_ ][A-Za-z0-9]+){0,7}$/.test(normalized)
  ) {
    return null;
  }
  const parts = normalized.toLowerCase().split(/[-_ ]/);
  return parts.every((part) =>
    /^\d+$/.test(part) ? part.length <= 4 : placeholderWords.has(part),
  )
    ? parts
    : null;
}

function isExplicitPlaceholderLabel(value) {
  const parts = placeholderParts(value);
  return parts !== null && placeholderLeadWords.has(parts[0]);
}

function isExplicitTestFixtureLabel(value, filePath) {
  if (!isTestSourcePath(filePath)) return false;
  const parts = placeholderParts(value);
  return parts !== null && parts.some((part) => testFixtureMarkers.has(part));
}

function isPlaceholderValue(rawValue, filePath) {
  const value = String(rawValue ?? "").trim();
  if (!value || /^(?:null|none|undefined)$/i.test(value)) return true;
  if (
    /^(?:<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\})$/.test(value) ||
    /^\$\{\{\s*(?:github|secrets|vars|env|inputs|runner|job|steps|needs|strategy|matrix)\.[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*\s*\}\}$/.test(value) ||
    isExplicitPlaceholderLabel(value) ||
    /^[x*._-]{4,}$/i.test(value) ||
    isExplicitTestFixtureLabel(value, filePath)
  ) {
    return true;
  }
  return false;
}

function isExplicitTextPath(filePath) {
  const fileName = basename(filePath).toLowerCase();
  return (
    explicitTextExtensions.has(extname(fileName)) ||
    ["caddyfile", "dockerfile", "license", "makefile"].includes(fileName)
  );
}

function isConfigurationAssignmentPath(filePath) {
  return (
    configurationAssignmentExtensions.has(extname(filePath).toLowerCase()) ||
    isCredentialTemplatePath(filePath)
  );
}

function decodeText(encoding, content) {
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
    content,
  );
}

function textContent(filePath, content) {
  if (!Buffer.isBuffer(content)) return null;
  const explicitText = isExplicitTextPath(filePath);
  let text;
  try {
    if (
      content.length >= 3 &&
      content[0] === 0xef &&
      content[1] === 0xbb &&
      content[2] === 0xbf
    ) {
      text = decodeText("utf-8", content.subarray(3));
    } else if (
      content.length >= 2 &&
      content[0] === 0xff &&
      content[1] === 0xfe
    ) {
      text = decodeText("utf-16le", content.subarray(2));
    } else if (
      content.length >= 2 &&
      content[0] === 0xfe &&
      content[1] === 0xff
    ) {
      text = decodeText("utf-16be", content.subarray(2));
    } else {
      if (content.includes(0)) {
        if (!explicitText) return null;
        throw new Error("NUL in explicit text");
      }
      text = decodeText("utf-8", content);
    }
  } catch {
    if (!explicitText) return null;
    throw new Error(
      `Release content secret gate could not safely decode ${filePath} (text-decoding)`,
    );
  }

  if (text.includes("\0")) {
    if (!explicitText) return null;
    throw new Error(
      `Release content secret gate could not safely decode ${filePath} (unexpected-nul)`,
    );
  }
  return text;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function assertNoReleaseSecrets(files, contentByPath) {
  for (const file of files) {
    const content = textContent(file, contentByPath.get(file));
    if (content === null) continue;

    for (const pattern of highRiskSecretPatterns) {
      pattern.expression.lastIndex = 0;
      const match = pattern.expression.exec(content);
      if (match) {
        throw new Error(
          `Release content secret gate rejected ${file}:${lineNumberAt(content, match.index)} (${pattern.name})`,
        );
      }
    }

    sensitiveAssignmentPattern.lastIndex = 0;
    for (const match of content.matchAll(sensitiveAssignmentPattern)) {
      const [, name, doubleQuoted, singleQuoted, templateQuoted, unquoted] = match;
      const value = doubleQuoted ?? singleQuoted ?? templateQuoted ?? unquoted ?? "";
      const quoted =
        doubleQuoted !== undefined ||
        singleQuoted !== undefined ||
        templateQuoted !== undefined;
      if (
        isSensitiveAssignmentName(name) &&
        (quoted || isConfigurationAssignmentPath(file)) &&
        !isPlaceholderValue(value, file)
      ) {
        const assignmentOffset = match[0].search(/[^\r\n]/);
        throw new Error(
          `Release content secret gate rejected ${file}:${lineNumberAt(content, match.index + Math.max(0, assignmentOffset))} (credential-assignment)`,
        );
      }
    }
  }
}

export function shouldExcludeReleasePath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (
    !normalized ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return true;
  }

  const parts = normalized.split("/");
  const lowerParts = parts.map((part) => part.toLowerCase());
  const lowerPath = lowerParts.join("/");
  const productDist = "outputs/product-design-prototype/dist";
  if (
    lowerParts.includes("dist") &&
    lowerPath !== productDist &&
    !lowerPath.startsWith(`${productDist}/`)
  ) {
    return true;
  }
  if (lowerParts.some((part) => excludedDirectoryNames.has(part))) return true;

  const fileName = lowerParts.at(-1);
  const isEnvironmentExample = fileName.endsWith(".env.example");
  const isEnvironmentFile =
    fileName === ".env" ||
    fileName.endsWith(".env") ||
    fileName.startsWith(".env.") ||
    fileName.includes(".env.");
  if (isEnvironmentFile && !isEnvironmentExample) return true;
  if (
    /\.(?:db|sqlite|sqlite3)(?:-(?:journal|shm|wal)|\.(?:bak|backup|copy|old|orig|save|snapshot|tmp)(?:\.[a-z0-9_-]+)*)?$/.test(
      fileName,
    )
  ) {
    return true;
  }
  if (/\.(?:log|pid)(?:\.|$)/.test(fileName)) return true;
  if (/\.(?:jks|kdbx|key|keystore|p12|pem|pfx|ppk|secret|secrets)$/.test(fileName)) {
    return true;
  }
  if (/^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/.test(fileName)) return true;
  const explicitTemplate = /(?:^|[._-])(?:example|sample|template)(?:[._-]|$)/.test(
    fileName,
  );
  if (
    !explicitTemplate &&
    /(?:^|[._-])(?:credentials?|secrets?|private[._-]?(?:key|secret)|service[._-]?account|client[._-]?secret|api[._-]?key|auth[._-]?token|access[._-]?token)(?:[._-]|$)/.test(
      fileName,
    ) &&
    /\.(?:conf|ini|json|properties|txt|xml|ya?ml)$/.test(fileName)
  ) {
    return true;
  }
  if (/\.(?:tar|tar\.gz|tgz|zip)$/.test(fileName)) return true;
  if (
    /\.(?:aac|bmp|docx?|flac|gif|heic|heif|jpe?g|m4a|mp3|ogg|pdf|png|pptx?|shortcut|tiff?|wav|webm|webp|xlsx?)$/.test(
      fileName,
    )
  ) {
    const allowedMedia =
      lowerPath.startsWith(`${productDist}/`) ||
      lowerPath.startsWith("outputs/product-design-prototype/public/") ||
      lowerPath.startsWith("outputs/logo/") ||
      lowerPath === "森特透明底logo 800 800.png" ||
      lowerPath ===
        "integrations/icost-shortcut/icost-dual-write.unsigned.shortcut";
    if (!allowedMedia) return true;
  }
  return false;
}

function hashBuffer(content) {
  return createHash("sha256").update(content).digest("hex");
}

function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function runGit(root, args) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    windowsHide: true,
  });
}

function gitPathList(root, args, label) {
  const result = runGit(root, args);
  if (result.status !== 0) {
    const message = result.stderr.toString("utf8").trim();
    throw new Error(`${label} failed${message ? `: ${message}` : ""}`);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRelativePath);
}

function gitFileContent(root, commit, file) {
  const result = runGit(root, ["show", `${commit}:${file}`]);
  if (result.status !== 0) {
    const message = result.error?.message || result.stderr.toString("utf8").trim();
    throw new Error(
      `Git blob read failed for ${file}${message ? `: ${message}` : ""}`,
    );
  }
  return result.stdout;
}

function isGitWorkTree(root) {
  const result = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.toString("utf8").trim() === "true";
}

function gitText(root, args, label) {
  const result = runGit(root, args);
  if (result.status !== 0) {
    const message = result.stderr.toString("utf8").trim();
    throw new Error(`${label} failed${message ? `: ${message}` : ""}`);
  }
  return result.stdout.toString("utf8").trim();
}

function detectGitInfo(root) {
  if (!isGitWorkTree(root)) {
    throw new Error("Release packages must be created from a Git worktree");
  }
  const commit = gitText(root, ["rev-parse", "HEAD"], "Git commit lookup");
  const clean = gitText(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "Git status lookup",
  ) === "";
  if (!clean) {
    throw new Error("Release worktree is dirty. Commit the release candidate before packaging.");
  }
  return {
    commit,
    clean,
  };
}

function normalizeGitInfo(gitInfo) {
  const commit = String(gitInfo?.commit ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(commit)) {
    throw new Error("Release manifest requires a full hexadecimal commit");
  }
  return {
    commit,
    clean: gitInfo?.clean === true,
  };
}

function assertSafeReleaseTraversalPath(rootRealPath, candidatePath, label) {
  const metadata = lstatSync(candidatePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Release packages do not accept symbolic links: ${label}`);
  }
  const candidateRealPath = realpathSync.native(candidatePath);
  const escaped = relative(rootRealPath, candidateRealPath);
  if (
    escaped === ".." ||
    escaped.startsWith(`..${sep}`) ||
    isAbsolute(escaped)
  ) {
    throw new Error(`Release path escapes its traversal boundary: ${label}`);
  }
  return metadata;
}

function walkFiles(root, current = root, files = [], rootRealPath) {
  const traversalRootRealPath = rootRealPath ?? realpathSync.native(root);
  const currentLabel = normalizeRelativePath(relative(root, current)) || ".";
  assertSafeReleaseTraversalPath(
    traversalRootRealPath,
    current,
    currentLabel,
  );
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    const relativePath = normalizeRelativePath(relative(root, fullPath));
    if (shouldExcludeReleasePath(relativePath)) continue;
    const metadata = assertSafeReleaseTraversalPath(
      traversalRootRealPath,
      fullPath,
      relativePath,
    );
    if (metadata.isDirectory()) {
      walkFiles(root, fullPath, files, traversalRootRealPath);
    } else if (metadata.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function walkAllRegularFiles(root, current = root, files = [], rootRealPath) {
  const traversalRootRealPath = rootRealPath ?? realpathSync.native(root);
  const currentLabel = normalizeRelativePath(relative(root, current)) || ".";
  assertSafeReleaseTraversalPath(
    traversalRootRealPath,
    current,
    currentLabel,
  );
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    const relativePath = normalizeRelativePath(relative(root, fullPath));
    // npm creates executable shims in node_modules/.bin as symbolic links on
    // POSIX hosts. Services invoke approved binaries directly, so these
    // platform-specific shims are not part of the immutable production tree.
    if (relativePath.split("/").includes(".bin")) continue;
    const metadata = assertSafeReleaseTraversalPath(
      traversalRootRealPath,
      fullPath,
      relativePath,
    );
    if (metadata.isDirectory()) {
      walkAllRegularFiles(root, fullPath, files, traversalRootRealPath);
    } else if (metadata.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function trackedFiles(root) {
  const result = runGit(root, [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "-z",
    "--cached",
  ]);
  if (result.status !== 0) {
    throw new Error(`Git file listing failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRelativePath);
}

function assertSafeCheckoutMaterialization(root) {
  const files = trackedFiles(root);
  const staged = runGit(root, [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "--stage",
    "-z",
  ]);
  if (staged.status !== 0) {
    throw new Error(
      `Git checkout materialization inventory failed: ${staged.stderr.toString("utf8").trim()}`,
    );
  }
  for (const entry of staged.stdout.toString("utf8").split("\0").filter(Boolean)) {
    if (entry.startsWith("160000 ")) {
      throw new Error(
        "Release checkout materialization does not allow Git submodules",
      );
    }
  }

  const attributes = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "core.quotepath=false",
      "check-attr",
      "-z",
      "--cached",
      "--stdin",
      "filter",
    ],
    {
      encoding: "buffer",
      input: Buffer.from(`${files.join("\0")}\0`, "utf8"),
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
    },
  );
  if (attributes.status !== 0) {
    const message = attributes.stderr.toString("utf8").trim();
    throw new Error(
      `Git checkout filter inspection failed${message ? `: ${message}` : ""}`,
    );
  }
  const fields = attributes.stdout.toString("utf8").split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [file, attribute, value] = fields.slice(index, index + 3);
    if (
      attribute === "filter" &&
      value !== "unspecified" &&
      value !== "unset"
    ) {
      throw new Error(
        `Release checkout materialization rejects active Git filters: ${normalizeRelativePath(file)}`,
      );
    }
  }
}

function assertExactCommitCheckout(checkoutRoot, commit) {
  const tracked = trackedFiles(checkoutRoot);
  for (const file of tracked) {
    const fullPath = join(checkoutRoot, file);
    let metadata;
    try {
      metadata = lstatSync(fullPath);
    } catch (error) {
      throw new Error(`Exact release commit checkout is missing tracked file: ${file}`, {
        cause: error,
      });
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Exact release commit checkout contains a non-regular tracked path: ${file}`);
    }
    const actual = readFileSync(fullPath);
    const expected = gitFileContent(checkoutRoot, commit, file);
    if (!actual.equals(expected)) {
      throw new Error(`Exact release commit checkout bytes differ from the Git blob: ${file}`);
    }
  }

  const unexpected = [
    ...gitPathList(
      checkoutRoot,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      "Exact release commit untracked-file verification",
    ),
    ...gitPathList(
      checkoutRoot,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      "Exact release commit ignored-file verification",
    ),
  ];
  if (unexpected.length > 0) {
    throw new Error(`Exact release commit checkout contains bytes outside Git: ${unexpected[0]}`);
  }
}

function createCommitWorktree(root, commit) {
  assertSafeCheckoutMaterialization(root);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "sentelligent-release-commit-"));
  const checkoutRoot = join(temporaryRoot, "checkout");
  const hooksRoot = join(temporaryRoot, "empty-git-hooks");
  mkdirSync(hooksRoot, { recursive: true });
  const worktree = { temporaryRoot, checkoutRoot };
  try {
    const result = runGit(root, [
      "-c",
      `core.hooksPath=${hooksRoot}`,
      "-c",
      "core.autocrlf=false",
      "worktree",
      "add",
      "--detach",
      checkoutRoot,
      commit,
    ]);
    if (result.status !== 0) {
      const message = result.stderr.toString("utf8").trim();
      throw new Error(
        `Exact release commit checkout failed${message ? `: ${message}` : ""}`,
      );
    }
    const checkedOutCommit = gitText(
      checkoutRoot,
      ["rev-parse", "HEAD"],
      "Release commit checkout verification",
    );
    if (checkedOutCommit !== commit) {
      throw new Error("Exact release commit checkout resolved to an unexpected commit");
    }
    assertExactCommitCheckout(checkoutRoot, commit);
    return worktree;
  } catch (error) {
    try {
      removeCommitWorktree(root, worktree);
    } catch {
      // Preserve the checkout failure while cleanup remains best-effort here.
    }
    throw error;
  }
}

function removeCommitWorktree(root, worktree) {
  const failures = [];
  const removeResult = runGit(root, [
    "worktree",
    "remove",
    "--force",
    worktree.checkoutRoot,
  ]);
  if (removeResult.status !== 0) {
    failures.push(removeResult.stderr.toString("utf8").trim());
  }
  try {
    rmSync(worktree.temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    failures.push(error.message);
  }
  const pruneResult = runGit(root, ["worktree", "prune"]);
  if (pruneResult.status !== 0) {
    failures.push(pruneResult.stderr.toString("utf8").trim());
  }
  if (failures.length > 0) {
    const message = failures.find(Boolean);
    throw new Error(
      `Exact release commit checkout cleanup failed${message ? `: ${message}` : ""}`,
    );
  }
}

function resolveDirectFrontendBuildInvocation(frontendRoot, buildScript, nodeExecutable) {
  if (buildScript === "vite build") {
    const viteEntry = join(frontendRoot, "node_modules", "vite", "bin", "vite.js");
    if (existsSync(viteEntry)) {
      return { command: nodeExecutable, args: [viteEntry, "build"] };
    }
  }

  const nodeScript = /^node ((?:\.\/)?[A-Za-z0-9._/-]+)$/u.exec(buildScript);
  if (nodeScript) {
    const segments = nodeScript[1].replace(/^\.\//u, "").split("/");
    if (segments.every((segment) => segment && segment !== "." && segment !== "..")) {
      const scriptPath = resolve(frontendRoot, ...segments);
      const relativePath = relative(frontendRoot, scriptPath);
      if (
        relativePath &&
        !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        relativePath !== ".." &&
        existsSync(scriptPath)
      ) {
        return { command: nodeExecutable, args: [scriptPath] };
      }
    }
  }
  return null;
}

function resolveNpmBuildInvocation(frontendRoot, buildScript, nodeExecutable) {
  const directInvocation = resolveDirectFrontendBuildInvocation(
    frontendRoot,
    buildScript,
    nodeExecutable,
  );
  if (directInvocation) return directInvocation;
  throw new Error(
    "Frontend production build must use the controlled `vite build` or `node <relative-script>` form",
  );
}

function frontendBuildEnvironment(nodeExecutable) {
  const environment = {
    NODE_ENV: "production",
    PATH: dirname(nodeExecutable),
    SENTELLIGENT_RELEASE_BUILD_ENV: FRONTEND_BUILD_ENVIRONMENT_IDENTITY,
  };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const actualName = Object.keys(process.env).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (actualName && process.env[actualName]) {
      environment[name] = process.env[actualName];
    }
  }
  return environment;
}

function frontendBuildAllowedNames(environment) {
  const names = new Set(Object.keys(environment));
  if (process.platform === "win32") {
    for (const name of WINDOWS_IMPLICIT_BUILD_ENV_NAMES) names.add(name);
  }
  return [...names].sort(compareUtf8Paths);
}

function packageDeclaresDependencies(packageJson) {
  return [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
  ].some(
    (section) =>
      section &&
      typeof section === "object" &&
      !Array.isArray(section) &&
      Object.keys(section).length > 0,
  );
}

function packageDeclaresProductionDependencies(packageJson) {
  return ["dependencies", "optionalDependencies"].some(
    (field) =>
      packageJson?.[field] &&
      typeof packageJson[field] === "object" &&
      Object.keys(packageJson[field]).length > 0,
  );
}

function pathEscapesRealRoot(rootRealPath, candidateRealPath) {
  const escaped = relative(rootRealPath, candidateRealPath);
  return (
    escaped === ".." ||
    escaped.startsWith(`..${sep}`) ||
    isAbsolute(escaped)
  );
}

function localDependencyTarget(frontendRoot, specification) {
  if (typeof specification !== "string") return null;
  if (specification.startsWith("file://")) {
    return fileURLToPath(new URL(specification));
  }
  if (specification.startsWith("file:")) {
    return resolve(frontendRoot, decodeURIComponent(specification.slice(5)));
  }
  if (specification.startsWith("link:")) {
    return resolve(frontendRoot, decodeURIComponent(specification.slice(5)));
  }
  return null;
}

function validateTrackedLocalDependencyTarget({
  checkoutRoot,
  frontendRoot,
  specification,
  tracked,
}) {
  const target = localDependencyTarget(frontendRoot, specification);
  if (target === null) return;
  const checkoutRealPath = realpathSync.native(checkoutRoot);
  let targetRealPath;
  let metadata;
  try {
    metadata = lstatSync(target);
    if (metadata.isSymbolicLink()) throw new Error("symbolic link");
    targetRealPath = realpathSync.native(target);
  } catch (error) {
    throw new Error("Frontend local dependency must resolve to a tracked checkout path", {
      cause: error,
    });
  }
  if (pathEscapesRealRoot(checkoutRealPath, targetRealPath)) {
    throw new Error(
      "Frontend local dependency escapes the exact release commit checkout",
    );
  }

  const targetFiles = metadata.isDirectory()
    ? walkAllRegularFiles(targetRealPath)
    : metadata.isFile()
      ? [""]
      : [];
  if (targetFiles.length === 0) {
    throw new Error("Frontend local dependency contains no tracked regular files");
  }
  for (const targetFile of targetFiles) {
    const fullPath = targetFile ? join(targetRealPath, targetFile) : targetRealPath;
    const releasePath = normalizeRelativePath(relative(checkoutRealPath, fullPath));
    if (!tracked.has(releasePath)) {
      throw new Error(
        "Frontend local dependency includes bytes outside the exact release commit",
      );
    }
  }
}

export function validateFrontendDependencyInputs({
  checkoutRoot,
  frontendRoot,
  packageJson,
  lockfile,
  tracked,
}) {
  if (!(tracked instanceof Set)) {
    throw new Error("Frontend dependency validation requires tracked file evidence");
  }
  for (const sectionName of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    const section = packageJson?.[sectionName];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    for (const specification of Object.values(section)) {
      validateTrackedLocalDependencyTarget({
        checkoutRoot,
        frontendRoot,
        specification,
        tracked,
      });
    }
  }

  if (!lockfile || typeof lockfile !== "object" || lockfile.lockfileVersion !== 3) {
    throw new Error("Frontend package-lock.json must use lockfileVersion 3");
  }
  if (!lockfile.packages || typeof lockfile.packages !== "object") {
    throw new Error("Frontend package-lock.json must contain package entries");
  }
  for (const [packagePath, entry] of Object.entries(lockfile.packages)) {
    if (!packagePath || !entry || typeof entry !== "object") continue;
    const resolvedValue = typeof entry.resolved === "string" ? entry.resolved : "";
    if (entry.link === true || /^(?:file|link):/u.test(resolvedValue)) {
      if (!resolvedValue) {
        throw new Error("Frontend linked lockfile dependency must identify its target");
      }
      validateTrackedLocalDependencyTarget({
        checkoutRoot,
        frontendRoot,
        specification: /^(?:file|link):/u.test(resolvedValue)
          ? resolvedValue
          : `file:${resolvedValue}`,
        tracked,
      });
      continue;
    }
    if (
      /^https?:/u.test(resolvedValue) &&
      (typeof entry.integrity !== "string" ||
        !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/u.test(entry.integrity))
    ) {
      throw new Error(
        "Frontend registry lockfile dependency must include integrity evidence",
      );
    }
  }
}

function environmentValue(name) {
  const actualName = Object.keys(process.env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return actualName ? process.env[actualName] : undefined;
}

function npmInstallEnvironment(cacheRoot, userConfigPath, globalConfigPath, nodeExecutable) {
  const environment = {
    PATH: dirname(nodeExecutable),
    npm_config_audit: "false",
    npm_config_cache: cacheRoot,
    npm_config_fund: "false",
    npm_config_globalconfig: globalConfigPath,
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: userConfigPath,
  };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = environmentValue(name);
    if (value) environment[name] = value;
  }
  return environment;
}

function npmCliInvocation(environment, nodeExecutable) {
  const configured = environmentValue(RELEASE_NPM_CLI_ENV);
  const inherited = environmentValue("npm_execpath");
  const adjacent = join(
    dirname(nodeExecutable),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const candidates = [
    configured ? { path: configured, source: RELEASE_NPM_CLI_ENV } : null,
    inherited ? { path: inherited, source: "npm_execpath" } : null,
    existsSync(adjacent) ? { path: adjacent, source: "node-adjacent" } : null,
  ].filter(Boolean);

  const posixAdjacent = resolve(
    dirname(nodeExecutable),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (existsSync(posixAdjacent)) {
    candidates.push({ path: posixAdjacent, source: "node-lib-adjacent" });
  }

  const pathEnvironment = environmentValue("PATH");
  for (const pathEntry of String(pathEnvironment ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const wrapperNames = process.platform === "win32"
      ? ["npm.cmd", "npm.exe", "npm"]
      : ["npm"];
    for (const wrapperName of wrapperNames) {
      const wrapperPath = join(pathEntry, wrapperName);
      if (!existsSync(wrapperPath)) continue;
      try {
        const wrapperRealPath = realpathSync.native(wrapperPath);
        if (basename(wrapperRealPath) === "npm-cli.js") {
          candidates.push({ path: wrapperRealPath, source: "PATH" });
        }
      } catch {
        // Continue with standard npm layouts below.
      }
      for (const candidatePath of [
        join(pathEntry, "node_modules", "npm", "bin", "npm-cli.js"),
        resolve(pathEntry, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      ]) {
        if (existsSync(candidatePath)) {
          candidates.push({ path: candidatePath, source: "PATH" });
        }
      }
    }
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const candidatePath = resolve(candidate.path);
    try {
      const resolvedPath = realpathSync.native(candidatePath);
      if (seen.has(resolvedPath)) continue;
      seen.add(resolvedPath);
      if (!lstatSync(resolvedPath).isFile()) throw new Error("not a file");
      const packagePath = resolve(dirname(resolvedPath), "..", "package.json");
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      if (
        packageJson?.name !== "npm" ||
        typeof packageJson?.version !== "string"
      ) {
        throw new Error("npm package identity is invalid");
      }
      const probe = spawnSync(nodeExecutable, [resolvedPath, "--version"], {
        encoding: "utf8",
        env: environment,
        timeout: 30_000,
        windowsHide: true,
      });
      const version = String(probe.stdout ?? "").trim();
      if (probe.status !== 0 || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
        throw new Error("version probe failed");
      }
      if (version !== packageJson.version) {
        throw new Error("npm CLI version does not match its package metadata");
      }
      return {
        command: nodeExecutable,
        argsPrefix: [resolvedPath],
        version,
        source: candidate.source,
      };
    } catch (error) {
      if (candidate.source === RELEASE_NPM_CLI_ENV) {
        throw new Error(
          `${RELEASE_NPM_CLI_ENV} must identify a working npm CLI file`,
          { cause: error },
        );
      }
    }
  }
  throw new Error(
    `Frontend dependencies require npm. Invoke packaging through npm or set ${RELEASE_NPM_CLI_ENV} to an npm CLI file.`,
  );
}

function installFrontendDependencies({
  checkoutRoot,
  commit,
  frontendRoot,
  packageJson,
  temporaryRoot,
  nodeExecutable,
}) {
  const lockfilePath = join(frontendRoot, "package-lock.json");
  const committedLockfile = existsSync(lockfilePath)
    ? gitFileContent(checkoutRoot, commit, PRODUCT_LOCKFILE_RELEASE_PATH)
    : null;
  let parsedLockfile = null;
  if (committedLockfile) {
    try {
      parsedLockfile = JSON.parse(committedLockfile.toString("utf8"));
    } catch (error) {
      throw new Error("Frontend package-lock.json must be valid JSON", {
        cause: error,
      });
    }
    validateFrontendDependencyInputs({
      checkoutRoot,
      frontendRoot,
      packageJson,
      lockfile: parsedLockfile,
      tracked: new Set(trackedFiles(checkoutRoot)),
    });
  }
  const declaresDependencies = packageDeclaresDependencies(packageJson);
  if (!declaresDependencies) {
    return {
      lockfile: committedLockfile
        ? {
            path: PRODUCT_LOCKFILE_RELEASE_PATH,
            sha256: hashBuffer(committedLockfile),
            lockfileVersion: parsedLockfile.lockfileVersion,
          }
        : null,
      runtime: {
        node: process.version,
        npm: null,
        npmResolutionSource: null,
        platform: process.platform,
        architecture: process.arch,
      },
      install: {
        command: null,
        ignoreScripts: true,
      },
    };
  }
  if (!existsSync(lockfilePath)) {
    throw new Error(
      `Frontend dependencies require the committed lockfile ${PRODUCT_LOCKFILE_RELEASE_PATH}`,
    );
  }

  const cacheRoot = join(temporaryRoot, "npm-cache");
  const userConfigPath = join(temporaryRoot, "empty-user-npmrc");
  const globalConfigPath = join(temporaryRoot, "empty-global-npmrc");
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(userConfigPath, "", { flag: "wx" });
  writeFileSync(globalConfigPath, "", { flag: "wx" });
  const installEnvironment = npmInstallEnvironment(
    cacheRoot,
    userConfigPath,
    globalConfigPath,
    nodeExecutable,
  );
  const npm = npmCliInvocation(installEnvironment, nodeExecutable);
  const result = spawnSync(
    npm.command,
    [
      ...npm.argsPrefix,
      "ci",
      "--ignore-scripts",
      "--include=dev",
      "--no-audit",
      "--no-fund",
      "--cache",
      cacheRoot,
      "--userconfig",
      userConfigPath,
      "--globalconfig",
      globalConfigPath,
    ],
    {
      cwd: frontendRoot,
      encoding: "utf8",
      env: npm.environment ?? installEnvironment,
      timeout: 300_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    const message = result.error?.message || result.stderr || result.stdout;
    throw new Error(
      `Frontend dependency installation from the committed lockfile failed${message ? `: ${String(message).trim()}` : ""}`,
    );
  }
  return {
    lockfile: {
      path: PRODUCT_LOCKFILE_RELEASE_PATH,
      sha256: hashBuffer(committedLockfile),
      lockfileVersion: parsedLockfile.lockfileVersion,
    },
    runtime: {
      node: process.version,
      npm: npm.version,
      npmResolutionSource: npm.source,
      platform: process.platform,
      architecture: process.arch,
    },
    install: {
      command: "npm ci",
      ignoreScripts: true,
      includeDev: true,
    },
  };
}

function installBackendProductionDependencies({
  checkoutRoot,
  commit,
  temporaryRoot,
  nodeExecutable,
}) {
  const backendRoot = join(checkoutRoot, BACKEND_PATH);
  const packagePath = join(backendRoot, "package.json");
  if (!existsSync(packagePath)) return null;

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error("Backend package.json must be valid JSON", { cause: error });
  }
  if (!packageDeclaresProductionDependencies(packageJson)) {
    return {
      lockfile: null,
      runtime: {
        node: process.version,
        npm: null,
        npmResolutionSource: null,
        platform: process.platform,
        architecture: process.arch,
      },
      install: {
        command: null,
        ignoreScripts: true,
        omitDev: true,
      },
    };
  }

  const lockfilePath = join(backendRoot, "package-lock.json");
  if (!existsSync(lockfilePath)) {
    throw new Error(
      `Backend production dependencies require the committed lockfile ${BACKEND_LOCKFILE_RELEASE_PATH}`,
    );
  }
  const committedLockfile = gitFileContent(
    checkoutRoot,
    commit,
    BACKEND_LOCKFILE_RELEASE_PATH,
  );
  let lockfile;
  try {
    lockfile = JSON.parse(committedLockfile.toString("utf8"));
  } catch (error) {
    throw new Error("Backend package-lock.json must be valid JSON", {
      cause: error,
    });
  }
  validateFrontendDependencyInputs({
    checkoutRoot,
    frontendRoot: backendRoot,
    packageJson,
    lockfile,
    tracked: new Set(trackedFiles(checkoutRoot)),
  });

  const cacheRoot = join(temporaryRoot, "backend-npm-cache");
  const userConfigPath = join(temporaryRoot, "empty-backend-user-npmrc");
  const globalConfigPath = join(temporaryRoot, "empty-backend-global-npmrc");
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(userConfigPath, "", { flag: "wx" });
  writeFileSync(globalConfigPath, "", { flag: "wx" });
  const installEnvironment = npmInstallEnvironment(
    cacheRoot,
    userConfigPath,
    globalConfigPath,
    nodeExecutable,
  );
  const npm = npmCliInvocation(installEnvironment, nodeExecutable);
  const result = spawnSync(
    npm.command,
    [
      ...npm.argsPrefix,
      "ci",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--cache",
      cacheRoot,
      "--userconfig",
      userConfigPath,
      "--globalconfig",
      globalConfigPath,
    ],
    {
      cwd: backendRoot,
      encoding: "utf8",
      env: npm.environment ?? installEnvironment,
      timeout: 300_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    const message = result.error?.message || result.stderr || result.stdout;
    throw new Error(
      `Backend production dependency installation from the committed lockfile failed${message ? `: ${String(message).trim()}` : ""}`,
    );
  }
  if (!existsSync(join(checkoutRoot, BACKEND_NODE_MODULES_PATH))) {
    throw new Error(
      "Backend production dependency installation did not create node_modules",
    );
  }
  return {
    lockfile: {
      path: BACKEND_LOCKFILE_RELEASE_PATH,
      sha256: hashBuffer(committedLockfile),
      lockfileVersion: lockfile.lockfileVersion,
    },
    runtime: {
      node: process.version,
      npm: npm.version,
      npmResolutionSource: npm.source,
      platform: process.platform,
      architecture: process.arch,
    },
    install: {
      command: "npm ci",
      ignoreScripts: true,
      omitDev: true,
    },
  };
}

function assertBuildDidNotMutateCommit(checkoutRoot, commit) {
  const checkedOutCommit = gitText(
    checkoutRoot,
    ["rev-parse", "HEAD"],
    "Release build commit verification",
  );
  if (checkedOutCommit !== commit) {
    throw new Error("Frontend build changed the checked-out release commit");
  }

  const changedTrackedFiles = gitPathList(
    checkoutRoot,
    ["diff", "--name-only", "-z", "HEAD", "--"],
    "Release build tracked-file verification",
  );
  const stagedFiles = gitPathList(
    checkoutRoot,
    ["diff", "--cached", "--name-only", "-z", "HEAD", "--"],
    "Release build staged-file verification",
  );
  const untrackedFiles = gitPathList(
    checkoutRoot,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "Release build untracked-file verification",
  );
  const ignoredFiles = gitPathList(
    checkoutRoot,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    "Release build ignored-file verification",
  );
  const unexpected = [
    ...changedTrackedFiles,
    ...stagedFiles,
    ...untrackedFiles,
    ...ignoredFiles,
  ].filter(
    (file) =>
      !file.startsWith(PRODUCT_DIST_PREFIX)
      && !file.startsWith(PRODUCT_NODE_MODULES_PREFIX),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Frontend build modified files outside its dist directory: ${unexpected[0]}`,
    );
  }
}

function buildFrontendFromCommit(checkoutRoot, commit, temporaryRoot, nodeExecutable) {
  const frontendRoot = join(checkoutRoot, PRODUCT_FRONTEND_PATH);
  const packagePath = join(frontendRoot, "package.json");
  if (!existsSync(packagePath)) {
    return false;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    throw new Error("Frontend package.json must be valid JSON before release packaging");
  }
  if (typeof packageJson.scripts?.build !== "string" || !packageJson.scripts.build.trim()) {
    throw new Error("Frontend package.json must define a production build script");
  }

  const distRoot = join(checkoutRoot, PRODUCT_DIST_PATH);
  rmSync(distRoot, { recursive: true, force: true });
  const buildEnvironment = frontendBuildEnvironment(nodeExecutable);
  let dependencyProvenance;
  let result;
  try {
    dependencyProvenance = installFrontendDependencies({
      checkoutRoot,
      commit,
      frontendRoot,
      packageJson,
      temporaryRoot,
      nodeExecutable,
    });
    const invocation = resolveNpmBuildInvocation(
      frontendRoot,
      packageJson.scripts.build.trim(),
      nodeExecutable,
    );
    result = spawnSync(invocation.command, invocation.args, {
      cwd: frontendRoot,
      encoding: "utf8",
      windowsHide: true,
      env: buildEnvironment,
      timeout: 180_000,
    });
  } finally {
    rmSync(join(frontendRoot, "node_modules"), {
      recursive: true,
      force: true,
    });
  }

  if (result.status !== 0) {
    const message = result.error?.message || result.stderr || result.stdout;
    throw new Error(
      `Frontend production build from exact commit ${commit.slice(0, 12)} failed${message ? `: ${String(message).trim()}` : ""}`,
    );
  }
  if (!existsSync(distRoot)) {
    throw new Error("Frontend production build did not create its dist directory");
  }
  assertBuildDidNotMutateCommit(checkoutRoot, commit);
  return {
    frontend: {
      ...dependencyProvenance,
      environment: {
        identity: FRONTEND_BUILD_ENVIRONMENT_IDENTITY,
        allowedNames: frontendBuildAllowedNames(buildEnvironment),
      },
    },
  };
}

function collectSourceFiles(root) {
  const candidates = isGitWorkTree(root) ? trackedFiles(root) : walkFiles(root);
  const buildRoot = join(root, PRODUCT_DIST_PATH);
  if (isGitWorkTree(root) && existsSync(buildRoot)) {
    candidates.push(...walkFiles(root, buildRoot));
  }
  const backendDependenciesRoot = join(root, BACKEND_NODE_MODULES_PATH);
  if (existsSync(backendDependenciesRoot)) {
    candidates.push(...walkAllRegularFiles(root, backendDependenciesRoot));
  }

  const unique = new Set();
  for (const relativePath of candidates) {
    if (
      shouldExcludeReleasePath(relativePath) &&
      !relativePath.startsWith(BACKEND_NODE_MODULES_PREFIX)
    ) {
      continue;
    }
    const fullPath = join(root, relativePath);
    if (!existsSync(fullPath)) continue;
    const stats = lstatSync(fullPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Release packages do not accept symbolic links: ${relativePath}`);
    }
    if (stats.isFile()) unique.add(relativePath);
  }
  return [...unique].sort(compareUtf8Paths);
}

function checksumsFor(files, contentByPath, prefix) {
  return Object.fromEntries(
    files
      .filter((file) => file.startsWith(prefix))
      .map((file) => [file, hashBuffer(contentByPath.get(file))]),
  );
}

function sourceTreeHash(files) {
  const index = Object.entries(files)
    .sort(([left], [right]) => compareUtf8Paths(left, right))
    .map(([file, hash]) => `${hash}  ${file}\n`)
    .join("");
  return hashBuffer(Buffer.from(index, "utf8"));
}

export function buildReleaseManifest({
  source,
  createdAt,
  files,
  contentByPath,
  rootDirectory,
  buildProvenance = null,
}) {
  const buildFiles = files.filter((file) =>
    file.startsWith("outputs/product-design-prototype/dist/"),
  );
  const migrationFiles = files.filter((file) =>
    file.startsWith("backend/src/db/migrations/"),
  );
  const productionDependencyFiles = files.filter((file) =>
    file.startsWith(BACKEND_NODE_MODULES_PREFIX),
  );
  const sourceFiles = files.filter(
    (file) =>
      !file.startsWith("outputs/product-design-prototype/dist/") &&
      !file.startsWith(BACKEND_NODE_MODULES_PREFIX),
  );
  if (buildFiles.length === 0) {
    throw new Error("Frontend build artifacts are missing; run the production build first");
  }
  if (migrationFiles.length === 0) {
    throw new Error("Database migration files are missing from the release package");
  }
  const sourceFileHashes = Object.fromEntries(
    sourceFiles.map((file) => [file, hashBuffer(contentByPath.get(file))]),
  );
  const serviceUnitList = PROJECT_SERVICE_UNITS.join(", ");

  return {
    schemaVersion: 3,
    product: "sentelligent-sales-workbench",
    createdAt,
    source,
    buildProvenance,
    archive: {
      format: "tar.gz",
      rootDirectory,
      packagedFiles: files.length + 1,
    },
    buildHashes: {
      algorithm: "sha256",
      files: checksumsFor(
        buildFiles,
        contentByPath,
        "outputs/product-design-prototype/dist/",
      ),
    },
    migrationChecksums: {
      algorithm: "sha256",
      files: checksumsFor(
        migrationFiles,
        contentByPath,
        "backend/src/db/migrations/",
      ),
    },
    productionDependencyHashes: {
      algorithm: "sha256",
      files: checksumsFor(
        productionDependencyFiles,
        contentByPath,
        BACKEND_NODE_MODULES_PREFIX,
      ),
      treeSha256: sourceTreeHash(
        checksumsFor(
          productionDependencyFiles,
          contentByPath,
          BACKEND_NODE_MODULES_PREFIX,
        ),
      ),
    },
    sourceHashes: {
      algorithm: "sha256",
      files: sourceFileHashes,
      treeSha256: sourceTreeHash(sourceFileHashes),
    },
    requiredEnvNames: [...REQUIRED_ENV_NAMES],
    exclusions: [
      "environment files except *.env.example",
      "SQLite databases, backups, copies, and sidecars",
      "logs, rotated logs, PID files, and PID rotations",
      "runtime voice recordings, voice assets, audio sessions, and other session state",
      "frontend/build dependencies, package caches, build folders, coverage, and non-product dist folders; backend production dependencies are included only through their manifest-covered tree",
      "Git, Codex, agent, worktree, and runtime metadata",
      "private keys and certificates",
    ],
    rollback: {
      strategy: "repin-systemd-units-to-immutable-release",
      serviceUnits: [...PROJECT_SERVICE_UNITS],
      releasePathPolicy:
        "Systemd units must use the previous verified immutable release real path. The current symlink is informational only and must not be used by ExecStart or WorkingDirectory.",
      instructions: [
        "Verify the pre-deployment database backup SHA-256 and integrity report.",
        "Verify the previous immutable release real path and its manifest checksums.",
        `Update ExecStart and WorkingDirectory in ${serviceUnitList} to that exact real path.`,
        "Run systemctl daemon-reload.",
        `Restart only ${serviceUnitList}; do not restart shared Caddy or unrelated services.`,
        "Run health, login, read, write, export, and audit smoke checks.",
      ],
      databasePolicy:
        "Database migrations are forward-only and additive. Do not silently roll back schema; restore data only through a separately approved, integrity-checked recovery.",
    },
  };
}

function writeTarString(target, value, offset, length, label) {
  const source = Buffer.from(value, "utf8");
  if (source.length > length) throw new Error(`${label} exceeds the tar field limit`);
  source.copy(target, offset);
}

function writeTarOctal(target, value, offset, length) {
  const octal = Math.max(0, Number(value)).toString(8);
  const encoded = `${octal.padStart(length - 1, "0")}\0`;
  writeTarString(target, encoded, offset, length, "Tar numeric value");
}

function splitTarPath(filePath) {
  if (Buffer.byteLength(filePath, "utf8") <= 100) {
    return { name: filePath, prefix: "" };
  }
  for (let index = filePath.lastIndexOf("/"); index > 0; index = filePath.lastIndexOf("/", index - 1)) {
    const prefix = filePath.slice(0, index);
    const name = filePath.slice(index + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
  }
  throw new Error(`Release path is too long for a portable ustar archive: ${filePath}`);
}

function tarHeader(filePath, size, mtimeSeconds, type = "0") {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(filePath);
  writeTarString(header, name, 0, 100, "Tar path");
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, mtimeSeconds, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeTarString(header, "ustar\0", 257, 6, "Tar magic");
  writeTarString(header, "00", 263, 2, "Tar version");
  writeTarString(header, "root", 265, 32, "Tar owner");
  writeTarString(header, "root", 297, 32, "Tar group");
  writeTarString(header, prefix, 345, 155, "Tar path prefix");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarString(
    header,
    `${checksum.toString(8).padStart(6, "0")}\0 `,
    148,
    8,
    "Tar checksum",
  );
  return header;
}

function paxRecord(name, value) {
  const body = Buffer.from(`${name}=${value}\n`, "utf8");
  let digitCount = 1;
  while (true) {
    const length = digitCount + 1 + body.length;
    const nextDigitCount = String(length).length;
    if (nextDigitCount === digitCount) {
      return Buffer.concat([Buffer.from(`${length} `, "ascii"), body]);
    }
    digitCount = nextDigitCount;
  }
}

function appendTarEntry(chunks, path, content, mtimeSeconds, type = "0") {
  chunks.push(tarHeader(path, content.length, mtimeSeconds, type));
  chunks.push(content);
  const padding = (512 - (content.length % 512)) % 512;
  if (padding) chunks.push(Buffer.alloc(padding));
}

function createTarGzip(entries, mtimeSeconds) {
  const chunks = [];
  entries.forEach((entry, index) => {
    const needsPaxPath =
      /[^\x20-\x7e]/.test(entry.path) ||
      Buffer.byteLength(entry.path, "utf8") > 100;
    let headerPath = entry.path;
    if (needsPaxPath) {
      const suffix = String(index).padStart(8, "0");
      appendTarEntry(
        chunks,
        `PaxHeaders/${suffix}`,
        paxRecord("path", entry.path),
        mtimeSeconds,
        "x",
      );
      headerPath = `PaxFiles/${suffix}`;
    }
    appendTarEntry(chunks, headerPath, entry.content, mtimeSeconds);
  });
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function safeArchiveName(value, fallback) {
  const archiveName = value ? String(value).trim() : fallback;
  if (
    !archiveName.endsWith(".tar.gz") ||
    archiveName !== basename(archiveName) ||
    archiveName.includes("..")
  ) {
    throw new Error("Archive name must be a plain .tar.gz file name");
  }
  return archiveName;
}

const defaultArchiveFileOperations = Object.freeze({
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
});

export function publishArchiveAtomically(
  archivePath,
  archive,
  operationOverrides = {},
) {
  if (existsSync(archivePath)) {
    throw new Error(`Release archive already exists: ${archivePath}`);
  }
  const operations = {
    ...defaultArchiveFileOperations,
    ...operationOverrides,
  };
  const temporaryPath = join(
    dirname(archivePath),
    `.${basename(archivePath)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  let fileDescriptor;
  let finalLinked = false;
  try {
    fileDescriptor = operations.openSync(temporaryPath, "wx", 0o600);
    operations.writeFileSync(fileDescriptor, archive);
    operations.fsyncSync(fileDescriptor);
    operations.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    try {
      operations.linkSync(temporaryPath, archivePath);
      finalLinked = true;
    } catch (error) {
      if (error?.code === "EEXIST" || existsSync(archivePath)) {
        throw new Error(`Release archive already exists: ${archivePath}`, {
          cause: error,
        });
      }
      throw error;
    }
    operations.unlinkSync(temporaryPath);
    return archivePath;
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        operations.closeSync(fileDescriptor);
      } catch {
        // Continue removing any partial file without replacing the primary error.
      }
    }
    if (finalLinked) {
      try {
        operations.unlinkSync(archivePath);
      } catch {
        // The original publication error remains the primary failure.
      }
    }
    try {
      operations.unlinkSync(temporaryPath);
    } catch {
      // The original write/publication error remains the primary failure.
    }
    throw error;
  }
}

function timestampFromEpochSeconds(value, label) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} must be a non-negative integer number of seconds`);
  }
  const milliseconds = Number(text) * 1000;
  const timestamp = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(timestamp.getTime())) {
    throw new Error(`${label} is outside the supported date range`);
  }
  return timestamp;
}

export function resolveReleaseTimestamp(root, commit, createdAt) {
  if (createdAt !== undefined) {
    const timestamp = new Date(createdAt);
    if (Number.isNaN(timestamp.getTime())) {
      throw new Error("createdAt must be an ISO date");
    }
    return timestamp;
  }
  if (process.env.SOURCE_DATE_EPOCH !== undefined) {
    return timestampFromEpochSeconds(
      process.env.SOURCE_DATE_EPOCH,
      "SOURCE_DATE_EPOCH",
    );
  }
  return timestampFromEpochSeconds(
    gitText(
      root,
      ["show", "-s", "--format=%ct", commit],
      "Git release commit time lookup",
    ),
    "Git release commit time",
  );
}

export async function createReleasePackage(options = {}) {
  if (Object.hasOwn(options, "allowDirty")) {
    throw new Error("allowDirty is unsupported; release packaging requires a clean Git worktree");
  }
  if (Object.hasOwn(options, "gitInfo")) {
    throw new Error("gitInfo is unsupported; release metadata must come from the source Git worktree");
  }
  const {
    sourceRoot = defaultRoot,
    outputDir = join(defaultRoot, ".runtime", "releases"),
    archiveName,
    createdAt,
    runtime = {},
  } = options;
  if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new TypeError("runtime must be an object");
  }
  const unexpectedRuntimeOptions = Object.keys(runtime).filter((name) => name !== "nodeExecutable");
  if (unexpectedRuntimeOptions.length > 0) {
    throw new Error(`Unsupported release runtime option: ${unexpectedRuntimeOptions[0]}`);
  }
  const requestedNodeExecutable = runtime.nodeExecutable ?? process.execPath;
  if (typeof requestedNodeExecutable !== "string" || !isAbsolute(requestedNodeExecutable)) {
    throw new TypeError("runtime.nodeExecutable must be an absolute file path");
  }
  const nodeExecutable = realpathSync.native(requestedNodeExecutable);
  if (!lstatSync(nodeExecutable).isFile()) {
    throw new TypeError("runtime.nodeExecutable must identify a regular file");
  }
  const root = resolve(sourceRoot);
  const destination = resolve(outputDir);
  const source = normalizeGitInfo(detectGitInfo(root));

  const timestamp = resolveReleaseTimestamp(root, source.commit, createdAt);
  const normalizedCreatedAt = timestamp.toISOString();
  const rootDirectory = `sentelligent-sales-workbench-${source.commit.slice(0, 12)}`;
  const worktree = createCommitWorktree(root, source.commit);
  let files;
  let contentByPath;
  let manifest;
  let packagingError;
  try {
    const frontendBuildProvenance = buildFrontendFromCommit(
      worktree.checkoutRoot,
      source.commit,
      worktree.temporaryRoot,
      nodeExecutable,
    );
    const backendBuildProvenance = installBackendProductionDependencies({
      checkoutRoot: worktree.checkoutRoot,
      commit: source.commit,
      temporaryRoot: worktree.temporaryRoot,
      nodeExecutable,
    });
    const buildProvenance = {
      ...(frontendBuildProvenance || {}),
      ...(backendBuildProvenance
        ? { backend: backendBuildProvenance }
        : {}),
    };
    files = collectSourceFiles(worktree.checkoutRoot);
    const tracked = new Set(trackedFiles(worktree.checkoutRoot));
    contentByPath = new Map(
      files.map((file) => [
        file,
        tracked.has(file) && !file.startsWith(PRODUCT_DIST_PREFIX)
          ? gitFileContent(worktree.checkoutRoot, source.commit, file)
          : readFileSync(join(worktree.checkoutRoot, file)),
      ]),
    );
    assertNoReleaseSecrets(files, contentByPath);
    manifest = buildReleaseManifest({
      source,
      createdAt: normalizedCreatedAt,
      files,
      contentByPath,
      rootDirectory,
      buildProvenance,
    });
  } catch (error) {
    packagingError = error;
    throw error;
  } finally {
    try {
      removeCommitWorktree(root, worktree);
    } catch (cleanupError) {
      if (!packagingError) throw cleanupError;
    }
  }
  const manifestContent = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const entries = [
    ...files.map((file) => ({
      path: `${rootDirectory}/${file}`,
      content: contentByPath.get(file),
    })),
    {
      path: `${rootDirectory}/release-manifest.json`,
      content: manifestContent,
    },
  ].sort((left, right) => compareUtf8Paths(left.path, right.path));

  mkdirSync(destination, { recursive: true });
  const finalArchiveName = safeArchiveName(
    archiveName,
    `${rootDirectory}.tar.gz`,
  );
  const archivePath = join(destination, finalArchiveName);
  const archive = createTarGzip(
    entries,
    Math.floor(timestamp.getTime() / 1000),
  );
  publishArchiveAtomically(archivePath, archive);
  return {
    status: "created",
    archivePath,
    archiveSha256: hashBuffer(archive),
    rootDirectory,
    packagedFiles: entries.length,
    manifest,
  };
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (name === "source-root") options.sourceRoot = value;
    else if (name === "output-dir") options.outputDir = value;
    else if (name === "archive-name") options.archiveName = value;
    else throw new Error(`Unknown argument: --${name}`);
  }
  return options;
}

async function main() {
  const result = await createReleasePackage(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
