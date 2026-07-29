import { resolve } from "node:path";

import { scanProjectSecrets } from "../../../scripts/project-secret-scan.mjs";

const workspaceRoot = resolve(process.cwd(), "../..");
const result = scanProjectSecrets({
  root: workspaceRoot,
  includeGitHistory: false,
});
const output = JSON.stringify(result, null, 2);

if (result.status === "failed") {
  console.error(output);
  process.exitCode = 1;
} else {
  console.log(output);
}
