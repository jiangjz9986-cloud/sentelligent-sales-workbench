import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appHookFiles = [
  "src/App.jsx",
  "src/app/SalesWorkbenchShell.jsx",
  "src/app/useWorkbenchNavigation.jsx",
  "src/app/useWorkbenchData.jsx",
  "src/app/useWorkbenchHandlers.jsx",
  "src/app/useQuickRecordSession.jsx",
  "src/app/useWeeklySession.jsx",
];

export function appSourceFiles(root = process.cwd()) {
  return appHookFiles;
}

export function readAppSource(root = process.cwd()) {
  return appSourceFiles(root)
    .map((file) => readFileSync(resolve(root, file), "utf8"))
    .join("\n");
}
