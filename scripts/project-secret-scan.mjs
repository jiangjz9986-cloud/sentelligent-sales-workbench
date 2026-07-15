import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

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
  ".css",
  ".env",
  ".example",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".txt",
]);

const secretPatterns = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "API key assignment", re: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][^'"]{8,}/i },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
];

function shouldRead(filePath) {
  const fileName = basename(filePath);
  if (ignoredFiles.has(fileName)) return false;
  const ext = extname(filePath).toLowerCase();
  return textExts.has(ext) || fileName.endsWith(".env.example");
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

export function scanProjectSecrets({ root = defaultRoot } = {}) {
  const workspaceRoot = resolve(root);
  const files = walk(workspaceRoot, workspaceRoot);
  const findings = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of secretPatterns) {
        if (pattern.re.test(line)) {
          findings.push({
            file: relative(workspaceRoot, file).replaceAll("\\", "/"),
            line: index + 1,
            pattern: pattern.name,
          });
        }
      }
    });
  }

  return {
    status: findings.length > 0 ? "failed" : "passed",
    scannedFiles: files.length,
    findings,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
  const result = scanProjectSecrets({
    root: rootArg ? rootArg.slice("--root=".length) : defaultRoot,
  });
  const output = JSON.stringify(result, null, 2);
  if (result.status === "failed") {
    console.error(output);
    process.exit(1);
  }
  console.log(output);
}
