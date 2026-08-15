import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const maxGitOutputBytes = 64 * 1024 * 1024;
const targetGitBatchBytes = 8 * 1024 * 1024;
const nonPublishableGitRefGlob = "refs/codex/turn-diffs/**";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const ignoredDirs = new Set([
  ".git",
  ".npm-cache",
  ".runtime",
  "dist",
  "node_modules",
  "qa",
]);

const ignoredFiles = new Set([
  "package-lock.json",
  "sales-workbench.sqlite",
  "health-check.sqlite",
]);

const textExts = new Set([
  ".cjs",
  ".conf",
  ".css",
  ".env",
  ".example",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsx",
  ".key",
  ".md",
  ".mjs",
  ".mts",
  ".pem",
  ".properties",
  ".ps1",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const extensionlessTextFiles = new Set([
  ".editorconfig",
  ".gitignore",
  ".npmrc",
  "caddyfile",
  "dockerfile",
  "makefile",
  "procfile",
]);

const credentialPatterns = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "GitHub token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/gi },
  {
    name: "Private key",
    re: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
  },
];

const sensitiveAssignmentPattern =
  /(?:^|[^A-Za-z0-9_-])([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|(\$\{\{[^\r\n]*?\}\})|(<[^>\r\n]+>)|`([^`$\r\n]*)`|([^\s,;#]+))/g;

const githubActionsContextPattern =
  /^\$\{\{\s*(?:github|secrets|vars|env|inputs|runner|job|steps|needs|strategy|matrix)\.[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*\s*\}\}$/;

const bareAssignmentExts = new Set([
  "",
  ".conf",
  ".env",
  ".ini",
  ".json",
  ".md",
  ".properties",
  ".ps1",
  ".sh",
  ".toml",
  ".txt",
  ".yaml",
  ".yml",
]);

const commentAwareSourceExts = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function isTextPath(filePath) {
  const fileName = basename(filePath).toLowerCase();
  if (extensionlessTextFiles.has(fileName) || fileName.startsWith(".env")) return true;
  return textExts.has(extname(filePath).toLowerCase());
}

function shouldRead(filePath) {
  return !ignoredFiles.has(basename(filePath)) && isTextPath(filePath);
}

function walk(dir, root, files = []) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const fullPath = join(dir, entry);
    const rel = relative(root, fullPath).replaceAll("\\", "/");
    if (rel === "backend/data" || rel.endsWith("/backend/data")) continue;
    const stats = statSync(fullPath);
    if (stats.isDirectory()) walk(fullPath, root, files);
    else if (stats.isFile() && shouldRead(fullPath)) files.push(fullPath);
  }
  return files;
}

function isIgnoredProjectPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some((part) => ignoredDirs.has(part))) return true;
  return normalized === "backend/data"
    || normalized.startsWith("backend/data/")
    || normalized.includes("/backend/data/");
}

function listGitVisibleFiles(root) {
  if (!isGitRepository(root)) return null;
  const output = runGit(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  return output
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => !isIgnoredProjectPath(relativePath))
    .map((relativePath) => join(root, ...relativePath.split("/")))
    .filter((filePath) => existsSync(filePath) && statSync(filePath).isFile() && shouldRead(filePath));
}

function listWorkingTreeFiles(root) {
  return listGitVisibleFiles(root) ?? walk(root, root);
}

function isTestSourcePath(filePath) {
  return /(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)|\.(?:spec|test)\.[^/]+$|(?:^|[-_.])qa(?:[-_.]|$)/i.test(
    filePath,
  );
}

function isExplicitTestFixtureValue(value, filePath) {
  if (!isTestSourcePath(filePath)) return false;
  return [
    /^(?:test|unit|development|warning|rotated|admin|qa)[-_](?:[a-z]+[-_]){0,3}(?:secret|password|token|key|plaintext)$/i,
    /^(?:csrf|stale)[-_][a-z][a-z0-9_-]*$/i,
    /^(?:machine|model)[-_](?:secret|key)$/i,
    /^(?:session|wx)[-_]token$/i,
    /^(?:wx|machine|visual|analysis|secret)[-_](?:[a-z]+[-_]){0,2}(?:token|csrf|secret|key)$/i,
    /^synthetic[-_]cursor[-_]retry[-_]context$/i,
    /^legacy[-_]plaintext$/i,
    /^(?:must[-_]not[-_]be[-_]used|too[-_]short|not[-_]a[-_]hash)$/i,
  ].some((pattern) => pattern.test(value));
}

const boundedPlaceholderStrongMarkers = new Set([
  "closure",
  "dummy",
  "fake",
  "fixture",
  "mock",
  "qa",
  "synthetic",
  "test",
  "tests",
  "unit",
  "vendor",
  "worker",
]);

const boundedPlaceholderSafeLeadWords = new Set([
  "dummy",
  "example",
  "fake",
  "fixture",
  "mock",
  "placeholder",
  "redacted",
  "sample",
  "synthetic",
  "test",
  "vendor",
]);

const boundedPlaceholderWords = new Set([
  ...boundedPlaceholderStrongMarkers,
  ...boundedPlaceholderSafeLeadWords,
  "a",
  "access",
  "account",
  "admin",
  "and",
  "at",
  "analysis",
  "api",
  "audit",
  "backend",
  "bytes",
  "be",
  "blocked",
  "client",
  "clear",
  "confirmation",
  "conflict",
  "context",
  "credential",
  "csrf",
  "current",
  "delivery",
  "dev",
  "direct",
  "env",
  "error",
  "example",
  "expired",
  "export",
  "extra",
  "failure",
  "file",
  "files",
  "for",
  "forwarded",
  "from",
  "hash",
  "here",
  "in",
  "independent",
  "is",
  "key",
  "least",
  "machine",
  "me",
  "message",
  "model",
  "must",
  "name",
  "new",
  "not",
  "old",
  "only",
  "other",
  "password",
  "plaintext",
  "private",
  "provider",
  "public",
  "restore",
  "restored",
  "real",
  "runtime",
  "scope",
  "secret",
  "sentinel",
  "session",
  "shared",
  "short",
  "single",
  "stale",
  "token",
  "thirty",
  "two",
  "upstream",
  "used",
  "value",
  "visual",
  "webhook",
  "weixin",
  "help",
]);

function boundedPlaceholderParts(value) {
  const normalized = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_ ]+/g, " ");
  if (value.length > 96 || normalized.trim() !== normalized || !normalized) {
    return null;
  }
  const parts = normalized.toLowerCase().split(" ");
  if (parts.length > 12) return null;
  return parts.every(
    (part) =>
      (/^[a-z]{1,20}$/.test(part) || /^\d{1,4}$/.test(part)) &&
      boundedPlaceholderWords.has(part),
  )
    ? parts
    : null;
}

function isBoundedPlaceholderLabel(value, filePath) {
  const parts = boundedPlaceholderParts(value);
  if (parts === null) return false;
  if (boundedPlaceholderSafeLeadWords.has(parts[0])) return true;
  if (parts.slice(0, 3).join("-") === "must-not-be") return true;
  return (
    isTestSourcePath(filePath) &&
    parts.some((part) => boundedPlaceholderStrongMarkers.has(part))
  );
}

function isExplicitPlaceholderValue(value) {
  return [
    /^(?:change[-_ ]?me|replace[-_ ]?me|placeholder|redacted|unset|tbd|todo)$/i,
    /^(?:example|fixture|dummy|fake|sample|mock|test)(?:[-_ ][a-z]+){0,5}$/i,
    /^(?:test|fixture)\d{1,4}$/i,
    /^[a-z]+[-_]from[-_]env(?:[-_][a-z]+){0,3}$/i,
    /^(?:set[-_]in|your[-_])(?:[-_][a-z]+){1,4}$/i,
  ].some((pattern) => pattern.test(value));
}

function isJavaScriptExpressionValue(value, { allowObjectOrArray = false } = {}) {
  if (/^[A-Za-z_$][A-Za-z0-9_$?.]*\(/.test(value)) return true;
  if (allowObjectOrArray && /^[{[]/.test(value)) return true;

  const identifier = "[A-Za-z_$][A-Za-z0-9_$]*";
  const dotMember = `(?:\\?\\.|\\.)${identifier}`;
  const bracketMember =
    String.raw`(?:\?\.)?\[(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+|"[^"\r\n]+"|'[^'\r\n]+')\]`;
  return new RegExp(`^${identifier}(?:${dotMember}|${bracketMember})+$`).test(
    value,
  );
}

function isJavaScriptConstantReference(value, filePath, assignmentKey) {
  return (
    /(?:^|\/)integrations\/icost-shortcut\/verify-shortcut\.mjs$/u.test(filePath) &&
    /^[A-Z][A-Z0-9_]*_ACTION$/u.test(assignmentKey) &&
    /^(?:is\.[A-Za-z0-9.]+|com\.[A-Za-z0-9.]+)$/u.test(value)
  );
}

function isPlaceholderValue(
  rawValue,
  filePath,
  assignmentKey = "",
  {
    allowJavaScriptExpression = true,
  } = {},
) {
  const value = String(rawValue ?? "").trim();
  if (isExplicitTestFixtureValue(value, filePath)) return true;
  if (!value) return true;
  if (githubActionsContextPattern.test(value)) return true;
  if (
    allowJavaScriptExpression &&
    isJavaScriptExpressionValue(value, {
      allowObjectOrArray: commentAwareSourceExts.has(extname(filePath).toLowerCase()),
    })
  ) return true;
  if (isJavaScriptConstantReference(value, filePath, assignmentKey)) return true;
  if (/^(?:[:@$][A-Za-z_][A-Za-z0-9_.-]*|%[A-Za-z_][A-Za-z0-9_]*%)$/.test(value)) {
    return true;
  }
  if (/^(?:\[[^\]]*(?:redacted|placeholder)[^\]]*\]|<[^>]+>|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{[^}]+\}\})$/i.test(value)) {
    return true;
  }
  return (
    isExplicitPlaceholderValue(value) ||
    isBoundedPlaceholderLabel(value, filePath) ||
    (/(?:test|fixture|synthetic)/i.test(assignmentKey) &&
      boundedPlaceholderParts(value) !== null)
  );
}

function isSensitiveAssignmentKey(value) {
  const normalized = String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return ["apikey", "secret", "token", "password"].some((part) =>
    normalized.includes(part),
  );
}

function isCredentialLikeLiteral(value) {
  const normalized = value.trim();
  if (normalized.length < 8 || /\s/.test(normalized)) return false;
  const classes = [
    /[a-z]/.test(normalized),
    /[A-Z]/.test(normalized),
    /\d/.test(normalized),
    /[^A-Za-z0-9]/.test(normalized),
  ].filter(Boolean).length;
  return /[A-Za-z]/.test(normalized) && classes >= 2;
}

function maskSourceComments(text, filePath) {
  if (!commentAwareSourceExts.has(extname(filePath).toLowerCase())) return text;

  const source = String(text ?? "");
  const masked = [...source];
  let state = "normal";
  let quote = "";
  let regexAllowed = true;
  let word = "";
  let commentResumeRegexAllowed = true;

  const regexStartWords = new Set([
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ]);

  const maskCharacter = (index) => {
    if (masked[index] !== "\r" && masked[index] !== "\n") masked[index] = " ";
  };

  const flushWord = () => {
    if (!word) return;
    regexAllowed = regexStartWords.has(word);
    word = "";
  };

  const markPunctuation = (character) => {
    flushWord();
    if ("([{,:;!?&|=+*%^~<>-".includes(character)) {
      regexAllowed = true;
    } else if (")]}".includes(character)) {
      regexAllowed = character === ")";
    } else if (character === ".") {
      regexAllowed = false;
    } else {
      regexAllowed = false;
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] ?? "";

    if (state === "regex" || state === "regex-class") {
      if (character === "\r" || character === "\n") {
        state = "normal";
        regexAllowed = true;
      } else if (character === "\\") {
        index += 1;
      } else if (state === "regex" && character === "[") {
        state = "regex-class";
      } else if (state === "regex-class" && character === "]") {
        state = "regex";
      } else if (state === "regex" && character === "/") {
        state = "normal";
        regexAllowed = false;
      }
      continue;
    }

    if (state === "line-comment") {
      if (character === "\r" || character === "\n") {
        state = "normal";
        word = "";
        regexAllowed = true;
      } else {
        maskCharacter(index);
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        maskCharacter(index);
        maskCharacter(index + 1);
        index += 1;
        state = "normal";
        regexAllowed = commentResumeRegexAllowed;
      } else {
        maskCharacter(index);
      }
      continue;
    }

    if (state === "quoted") {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === quote) {
        state = "normal";
        quote = "";
        regexAllowed = false;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      flushWord();
      state = "quoted";
      quote = character;
      regexAllowed = false;
      continue;
    }

    if (/[A-Za-z0-9_$]/u.test(character)) {
      word += character;
      continue;
    }

    if (character === "\r" || character === "\n") {
      flushWord();
      regexAllowed = true;
      continue;
    }

    if (/\s/u.test(character)) {
      flushWord();
      continue;
    }

    if (character === "/" && next === "/") {
      flushWord();
      maskCharacter(index);
      maskCharacter(index + 1);
      index += 1;
      state = "line-comment";
      continue;
    }

    if (character === "/" && next === "*") {
      flushWord();
      commentResumeRegexAllowed = regexAllowed;
      maskCharacter(index);
      maskCharacter(index + 1);
      index += 1;
      state = "block-comment";
      continue;
    }

    if (character === "/" && regexAllowed) {
      state = "regex";
      regexAllowed = false;
      continue;
    }

    if (character === "/") {
      flushWord();
      regexAllowed = true;
      continue;
    }

    markPunctuation(character);
  }

  return masked.join("");
}

function shouldReportAssignment(match, filePath, { commentOnly = false } = {}) {
  if (!isSensitiveAssignmentKey(match[1])) return false;
  const quotedValue = match[2] ?? match[3] ?? match[6];
  const value = quotedValue ?? match[4] ?? match[5] ?? match[7] ?? "";
  if (quotedValue === undefined && !bareAssignmentExts.has(extname(filePath).toLowerCase())) {
    return false;
  }
  // Lowercase package paths in prose are not credentials. Mixed-case or
  // digit-bearing values remain visible in the recovery pass below.
  if (commentOnly && /[\\/]/u.test(value) && !/[A-Z0-9]/u.test(value)) {
    return false;
  }
  return (
    !isPlaceholderValue(value, filePath, match[1], {
      allowJavaScriptExpression: quotedValue === undefined,
    }) &&
    (isCredentialLikeLiteral(value) ||
      (!isTestSourcePath(filePath) && boundedPlaceholderParts(value) !== null))
  );
}

function scanText(text, metadata) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const assignmentLines = maskSourceComments(text, metadata.file).split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const pattern of credentialPatterns) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(line)) {
        findings.push({ ...metadata, line: index + 1, pattern: pattern.name });
      }
    }

    const assignmentLine = assignmentLines[index] ?? line;
    sensitiveAssignmentPattern.lastIndex = 0;
    for (const match of assignmentLine.matchAll(sensitiveAssignmentPattern)) {
      if (shouldReportAssignment(match, metadata.file)) {
        findings.push({ ...metadata, line: index + 1, pattern: "API key assignment" });
      }
    }

    // Comments are masked during normal parsing, but a narrow recovery pass
    // keeps real credentials in comments detectable without reinterpreting
    // ordinary prose as source code.
    if (assignmentLine !== line) {
      sensitiveAssignmentPattern.lastIndex = 0;
      for (const match of line.matchAll(sensitiveAssignmentPattern)) {
        const maskedFragment = assignmentLine.slice(
          match.index,
          match.index + match[0].length,
        );
        if (
          maskedFragment.length === match[0].length &&
          /^\s*$/u.test(maskedFragment) &&
          shouldReportAssignment(match, metadata.file, { commentOnly: true })
        ) {
          findings.push({ ...metadata, line: index + 1, pattern: "API key assignment" });
        }
      }
    }
  });

  return findings;
}

function runGit(root, args, { input, encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding,
    input,
    maxBuffer: maxGitOutputBytes,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr ?? "");
    throw new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function isGitRepository(root) {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status === 0 && result.stdout.trim() === "true";
}

function listHistoricalBlobs(root) {
  const listing = runGit(root, [
    "-c",
    "core.quotePath=false",
    "rev-list",
    `--exclude=${nonPublishableGitRefGlob}`,
    "--objects",
    "--all",
  ]);
  const pathsByObject = new Map();

  const recordPath = (object, file) => {
    if (!/^[0-9a-f]{40,64}$/.test(object) || !isTextPath(file)) return;
    const paths = pathsByObject.get(object) ?? new Set();
    paths.add(file);
    pathsByObject.set(object, paths);
  };

  for (const line of listing.split(/\r?\n/)) {
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    recordPath(line.slice(0, separator), line.slice(separator + 1));
  }

  const rawHistory = runGit(root, [
    "-c",
    "core.quotePath=false",
    "log",
    `--exclude=${nonPublishableGitRefGlob}`,
    "--all",
    "--format=",
    "--raw",
    "--root",
    "--no-abbrev",
    "--no-renames",
  ]);
  for (const line of rawHistory.split(/\r?\n/)) {
    const match = line.match(
      /^:\d{6} \d{6} ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [A-Z]\t(.+)$/,
    );
    if (!match) continue;
    const [, oldObject, newObject, file] = match;
    if (!/^0+$/.test(oldObject)) recordPath(oldObject, file);
    if (!/^0+$/.test(newObject)) recordPath(newObject, file);
  }

  const objectIds = [...pathsByObject.keys()];
  if (objectIds.length === 0) return [];

  const batchInput = `${objectIds.join("\n")}\n`;
  const metadata = runGit(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: batchInput },
  );

  return metadata
    .split(/\r?\n/)
    .map((line) => line.split(" "))
    .filter(([, type]) => type === "blob")
    .map(([object, , size]) => ({
      object,
      files: [...(pathsByObject.get(object) ?? [])],
      size: Number(size),
    }));
}

function historicalBlobBatches(blobs) {
  const batches = [];
  let batch = [];
  let batchBytes = 0;

  for (const blob of blobs) {
    if (!Number.isSafeInteger(blob.size) || blob.size < 0) {
      throw new Error(`Git blob has an invalid size: ${blob.object}`);
    }
    if (blob.size >= maxGitOutputBytes) {
      throw new Error(`Git text blob exceeds the scanner safety limit: ${blob.object}`);
    }
    if (batch.length > 0 && batchBytes + blob.size > targetGitBatchBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(blob);
    batchBytes += blob.size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function readHistoricalBlobBatch(root, blobs) {
  if (blobs.length === 0) return new Map();
  const objectIds = blobs.map(({ object }) => object);
  const output = runGit(root, ["cat-file", "--batch"], {
    input: `${objectIds.join("\n")}\n`,
    encoding: null,
  });
  const contentByObject = new Map();
  let offset = 0;

  for (const requestedObject of objectIds) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`git cat-file returned no header for ${requestedObject}`);
    const [object, type, rawSize] = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    const size = Number(rawSize);
    if (type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`git cat-file returned invalid metadata for ${requestedObject}`);
    }

    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd > output.length) {
      throw new Error(`git cat-file returned truncated content for ${requestedObject}`);
    }
    contentByObject.set(object, output.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }

  return contentByObject;
}

function decodeGitText(content) {
  if (!content || content.includes(0)) return null;
  try {
    return utf8Decoder.decode(content);
  } catch {
    return null;
  }
}

function scanGitHistoryMessages(root) {
  const messages = [];
  const recordMessage = ({ messageType, object, text, ref = null }) => {
    if (!text) return;
    messages.push({ messageType, object, text, ref });
  };

  const commitLog = runGit(root, [
    "log",
    `--exclude=${nonPublishableGitRefGlob}`,
    "--all",
    "--format=%H%x1f%B%x1e",
  ]);
  for (const rawRecord of commitLog.split("\x1e")) {
    const record = rawRecord.replace(/^\s+/, "");
    const separator = record.indexOf("\x1f");
    if (separator < 0) continue;
    const object = record.slice(0, separator).trim();
    if (!/^[0-9a-f]{40,64}$/.test(object)) continue;
    recordMessage({
      messageType: "commit",
      object,
      text: record.slice(separator + 1).trim(),
    });
  }

  const tagFields = runGit(root, [
    "for-each-ref",
    "--format=%(objecttype)%00%(objectname)%00%(contents)%00",
    "refs/tags",
  ]).split("\0");
  for (let index = 0; index + 2 < tagFields.length; index += 3) {
    const type = tagFields[index].trim();
    const object = tagFields[index + 1].trim();
    if (type !== "tag" || !/^[0-9a-f]{40,64}$/.test(object)) continue;
    recordMessage({
      messageType: "annotated-tag",
      object,
      text: tagFields[index + 2].trim(),
    });
  }

  const noteRefs = runGit(root, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/notes",
  ]).split(/\r?\n/).filter(Boolean);
  for (const ref of noteRefs) {
    const noteList = runGit(root, ["notes", `--ref=${ref}`, "list"]);
    for (const line of noteList.split(/\r?\n/)) {
      const [noteObject, targetObject] = line.trim().split(/\s+/, 2);
      if (!/^[0-9a-f]{40,64}$/.test(noteObject ?? "")) continue;
      recordMessage({
        messageType: "note",
        object: noteObject,
        ref,
        text: runGit(root, ["cat-file", "blob", noteObject]).trim(),
        targetObject,
      });
    }
  }

  const findings = [];
  for (const message of messages) {
    findings.push(
      ...scanText(message.text, {
        source: "git-history-message",
        messageType: message.messageType,
        file: `git/${message.messageType}/${message.object}.txt`,
        object: message.object,
        ...(message.ref ? { ref: message.ref } : {}),
      }),
    );
  }
  return { findings, scannedGitMessages: messages.length };
}

function scanGitHistory(root) {
  if (!isGitRepository(root)) {
    return {
      findings: [],
      scannedGitObjects: 0,
      scannedGitMessages: 0,
      gitHistoryComplete: null,
    };
  }

  const shallow = runGit(root, ["rev-parse", "--is-shallow-repository"]).trim();
  if (shallow !== "false") {
    throw new Error("Git history scan requires a complete, non-shallow checkout");
  }

  const blobs = listHistoricalBlobs(root);
  const findings = [];
  const scannedObjects = new Set();

  for (const batch of historicalBlobBatches(blobs)) {
    const contentByObject = readHistoricalBlobBatch(root, batch);
    for (const { object, files } of batch) {
      const text = decodeGitText(contentByObject.get(object));
      if (text === null) continue;
      scannedObjects.add(object);
      for (const file of files) {
        findings.push(
          ...scanText(text, {
            source: "git-history",
            file,
            object,
          }),
        );
      }
    }
  }

  const messages = scanGitHistoryMessages(root);
  findings.push(...messages.findings);

  return {
    findings,
    scannedGitObjects: scannedObjects.size,
    scannedGitMessages: messages.scannedGitMessages,
    gitHistoryComplete: true,
  };
}

export function scanProjectSecrets({ root = defaultRoot, includeGitHistory = true } = {}) {
  const workspaceRoot = resolve(root);
  const files = listWorkingTreeFiles(workspaceRoot);
  const findings = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    findings.push(
      ...scanText(text, {
        source: "working-tree",
        file: relative(workspaceRoot, file).replaceAll("\\", "/"),
      }),
    );
  }

  const history = includeGitHistory
    ? scanGitHistory(workspaceRoot)
    : {
        findings: [],
        scannedGitObjects: 0,
        scannedGitMessages: 0,
        gitHistoryComplete: null,
      };
  findings.push(...history.findings);

  return {
    status: findings.length > 0 ? "failed" : "passed",
    scannedFiles: files.length,
    scannedGitObjects: history.scannedGitObjects,
    scannedGitMessages: history.scannedGitMessages,
    gitHistoryComplete: history.gitHistoryComplete,
    findings,
  };
}

function parseArguments(argv) {
  let root = defaultRoot;
  let includeGitHistory = true;

  for (const argument of argv) {
    if (argument.startsWith("--root=")) root = argument.slice("--root=".length);
    else if (argument === "--history") includeGitHistory = true;
    else if (argument === "--no-history") includeGitHistory = false;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { root, includeGitHistory };
}

function main() {
  const result = scanProjectSecrets(parseArguments(process.argv.slice(2)));
  const output = JSON.stringify(result, null, 2);
  if (result.status === "failed") {
    console.error(output);
    process.exitCode = 1;
    return;
  }
  console.log(output);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
