import { loadConfig } from "../src/config.js";
import { resolveDatabasePath } from "../src/db.js";
import { inspectDatabase } from "../src/db/integrity.js";

const databasePath = resolveDatabasePath(loadConfig().databaseUrl);
const report = inspectDatabase(databasePath);
process.stdout.write(JSON.stringify({ databasePath, ...report }, null, 2) + "\n");

if (
  report.error ||
  report.quickCheck !== "ok" ||
  !Array.isArray(report.foreignKeyViolations) ||
  report.foreignKeyViolations.length > 0 ||
  report.missingTables.length > 0
) {
  process.exitCode = 1;
}
