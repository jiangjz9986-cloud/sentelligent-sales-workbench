import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { gzipSync } from "node:zlib";

const defaultRoot = resolve(import.meta.dirname, "..");

export const REQUIRED_ENV_NAMES = Object.freeze([
  "NODE_ENV",
  "HOST",
  "PORT",
  "DATABASE_URL",
  "AUTH_REQUIRED",
  "AUTH_ACCOUNT",
  "AUTH_PASSWORD_HASH",
  "AUTH_SESSION_SECRET",
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
  /(?:^|[\r\n,{;])[ \t]*(?:(?:export[ \t]+)?(?:const|let|var)[ \t]+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|([^,"'\r\n\]#;]*))/g;

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
  "export",
  "extra",
  "failure",
  "from",
  "hash",
  "here",
  "in",
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
  "used",
  "value",
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
      const [, name, doubleQuoted, singleQuoted, unquoted] = match;
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
      const quoted = doubleQuoted !== undefined || singleQuoted !== undefined;
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
    windowsHide: true,
  });
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
  const branch = gitText(root, ["rev-parse", "--abbrev-ref", "HEAD"], "Git branch lookup");
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
    branch: branch === "HEAD" ? "detached" : branch,
    commit,
    clean,
  };
}

function normalizeGitInfo(gitInfo) {
  const branch = String(gitInfo?.branch ?? "").trim();
  const commit = String(gitInfo?.commit ?? "").trim().toLowerCase();
  if (!branch) throw new Error("Release manifest requires a branch");
  if (!/^[a-f0-9]{7,64}$/.test(commit)) {
    throw new Error("Release manifest requires a full hexadecimal commit");
  }
  return {
    branch,
    commit,
    clean: gitInfo?.clean === true,
  };
}

function walkFiles(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    const relativePath = normalizeRelativePath(relative(root, fullPath));
    if (shouldExcludeReleasePath(relativePath)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Release packages do not accept symbolic links: ${relativePath}`);
    }
    if (entry.isDirectory()) walkFiles(root, fullPath, files);
    else if (entry.isFile()) files.push(relativePath);
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

function collectSourceFiles(root) {
  const candidates = isGitWorkTree(root) ? trackedFiles(root) : walkFiles(root);
  const buildRoot = join(root, "outputs", "product-design-prototype", "dist");
  if (isGitWorkTree(root) && existsSync(buildRoot)) {
    candidates.push(...walkFiles(root, buildRoot));
  }

  const unique = new Set();
  for (const relativePath of candidates) {
    if (shouldExcludeReleasePath(relativePath)) continue;
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
}) {
  const buildFiles = files.filter((file) =>
    file.startsWith("outputs/product-design-prototype/dist/"),
  );
  const migrationFiles = files.filter((file) =>
    file.startsWith("backend/src/db/migrations/"),
  );
  const sourceFiles = files.filter(
    (file) => !file.startsWith("outputs/product-design-prototype/dist/"),
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

  return {
    schemaVersion: 2,
    product: "sentelligent-sales-workbench",
    createdAt,
    source,
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
      "dependencies, package caches, build folders, coverage, and non-product dist folders",
      "Git, Codex, agent, worktree, and runtime metadata",
      "private keys and certificates",
    ],
    rollback: {
      strategy: "switch-release-pointer",
      instructions: [
        "Verify the pre-deployment database backup SHA-256 and integrity report.",
        "Stop only the project-owned sentelligent-* services.",
        "Switch the project-owned current release pointer to the previous verified release.",
        "Start only the project-owned sentelligent-* services.",
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
    createdAt = new Date().toISOString(),
  } = options;
  const root = resolve(sourceRoot);
  const destination = resolve(outputDir);
  const source = normalizeGitInfo(detectGitInfo(root));

  const timestamp = new Date(createdAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error("createdAt must be an ISO date");
  const normalizedCreatedAt = timestamp.toISOString();
  const rootDirectory = `sentelligent-sales-workbench-${source.commit.slice(0, 12)}`;
  const files = collectSourceFiles(root);
  const contentByPath = new Map(
    files.map((file) => [file, readFileSync(join(root, file))]),
  );
  assertNoReleaseSecrets(files, contentByPath);
  const manifest = buildReleaseManifest({
    source,
    createdAt: normalizedCreatedAt,
    files,
    contentByPath,
    rootDirectory,
  });
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
  if (existsSync(archivePath)) {
    throw new Error(`Release archive already exists: ${archivePath}`);
  }

  const archive = createTarGzip(
    entries,
    Math.floor(timestamp.getTime() / 1000),
  );
  writeFileSync(archivePath, archive, { flag: "wx" });
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
