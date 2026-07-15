import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

const workspaceRoot = resolve(process.cwd(), "../..");
const ignoredDirs = new Set([
  ".git",
  ".npm-cache",
  "dist",
  "node_modules",
  "qa",
]);
const ignoredFiles = new Set([
  "项目需求书.txt",
  "package-lock.json",
  "sales-workbench.sqlite",
  "health-check.sqlite",
]);
const textExts = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".txt",
  ".example",
]);
const patterns = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "API key assignment", re: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][^'"]{8,}/i },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
];

function shouldRead(filePath) {
  const fileName = basename(filePath);
  if (ignoredFiles.has(fileName)) return false;
  const ext = extname(filePath);
  return textExts.has(ext) || fileName.endsWith(".env.example");
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const fullPath = join(dir, entry);
    const rel = relative(workspaceRoot, fullPath).replaceAll("\\", "/");
    if (rel === "backend/data" || rel.endsWith("/backend/data")) continue;
    const stats = statSync(fullPath);
    if (stats.isDirectory()) walk(fullPath, files);
    else if (stats.isFile() && shouldRead(fullPath)) files.push(fullPath);
  }
  return files;
}

const findings = [];
for (const file of walk(workspaceRoot)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      if (pattern.re.test(line)) {
        findings.push({
          file: relative(workspaceRoot, file),
          line: index + 1,
          pattern: pattern.name,
        });
      }
    }
  });
}

if (findings.length > 0) {
  console.error(JSON.stringify({ status: "failed", findings }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "passed", scannedFiles: walk(workspaceRoot).length }, null, 2));
