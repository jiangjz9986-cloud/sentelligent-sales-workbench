import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The sales workbench pages live in pages.jsx (barrel) plus per-domain files
// under pages/; source-level guard tests must cover all of them together.
export function salesWorkbenchPageFiles(root = process.cwd()) {
  const files = ["src/features/salesWorkbench/pages.jsx"];
  const dir = resolve(root, "src/features/salesWorkbench/pages");
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.endsWith(".jsx")) {
        files.push(`src/features/salesWorkbench/pages/${entry}`);
      }
    }
  }
  return files;
}

export function readSalesWorkbenchPagesSource(root = process.cwd()) {
  return salesWorkbenchPageFiles(root)
    .map((file) => readFileSync(resolve(root, file), "utf8"))
    .join("\n");
}
