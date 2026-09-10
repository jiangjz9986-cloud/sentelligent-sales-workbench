import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizeRolloutPhase, validateTransitionManifest, controlledPath } from "./production-contract.mjs";
import { privateFile, writeExclusive } from "./production-io.mjs";
import { createProductionHostAdapter, preparePlatformService, runAiProductionPreflight } from "./production-host.mjs";
import { runProductionRollback, runProductionTransition } from "./transition-runner.mjs";

const COMMANDS = new Set(["inspect", "prepare", "preflight", "cutover", "set-phase", "observe", "rollback"]);

function parseOptions(args) {
  const options = {};
  for (const arg of args) {
    const match = arg.match(/^--([a-z0-9-]+)=(.+)$/u);
    if (!match || Object.hasOwn(options, match[1])) throw new Error("invalid command options");
    options[match[1]] = match[2];
  }
  return options;
}

function validateOptions(command, options) {
  const allowed = new Set(["manifest"]);
  if (["preflight", "cutover"].includes(command)) { allowed.add("report"); allowed.add("report-sha256"); }
  if (["set-phase", "observe", "rollback"].includes(command)) allowed.add("report");
  if (command === "set-phase") allowed.add("phase");
  if (command === "observe") allowed.add("duration-seconds");
  if (command === "rollback") allowed.add("transition-id");
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new Error("invalid command options");
}

function writeReport(path, value) {
  const digest = writeExclusive(path, JSON.stringify(value, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ report: path, sha256: digest, status: value.status }) + "\n");
  return digest;
}

function boundedSeconds(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 7 * 24 * 60 * 60) throw new Error("invalid observation duration");
  return parsed;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || !command) {
    process.stdout.write("Usage: production-transition.mjs inspect|prepare|preflight|cutover|set-phase|observe|rollback --manifest=<file> [options]\n");
    return;
  }
  const options = parseOptions(args);
  if (!options.manifest || !COMMANDS.has(command)) throw new Error("invalid command");
  validateOptions(command, options);
  const manifest = validateTransitionManifest(JSON.parse(privateFile(options.manifest).content.toString()));
  if (options.report) controlledPath(options.report, manifest.evidenceDir, "report");
  let result;
  if (command === "prepare") result = await preparePlatformService(manifest);
  else if (command === "preflight") {
    if (!options.report) throw new Error("preflight requires --report");
    result = await runAiProductionPreflight(manifest);
    writeReport(options.report, result);
    process.exitCode = result.status === "passed" ? 0 : 1;
    return;
  } else if (command === "cutover") {
    const adapter = createProductionHostAdapter(manifest, { proofPath: options.report, proofSha256: options["report-sha256"] });
    if (!options.report || !options["report-sha256"]) throw new Error("cutover requires an exact AI preflight report");
    result = await runProductionTransition(manifest, adapter, {
      onEvent: (event) => process.stdout.write(JSON.stringify(event) + "\n"),
    });
    writeReport(manifest.evidenceDir + "/ai-transition-report.json", result);
    process.exitCode = result.status === "passed" ? 0 : 1;
    return;
  } else if (command === "inspect") {
    const adapter = createProductionHostAdapter(manifest);
    result = adapter.inspect(manifest, "old");
  } else if (command === "set-phase") {
    if (!options.phase || !["P3", "P4", "P5", "P6"].includes(options.phase)) throw new Error("set-phase requires P3, P4, P5, or P6");
    normalizeRolloutPhase(options.phase);
    const adapter = createProductionHostAdapter(manifest);
    result = await adapter.setPhase(manifest, options.phase);
    const path = options.report ?? join(manifest.evidenceDir, `phase-${options.phase}-${Date.now()}.json`);
    controlledPath(path, manifest.evidenceDir, "phase report");
    writeReport(path, result);
    process.exitCode = result.status === "passed" ? 0 : 1;
    return;
  } else if (command === "observe") {
    const durationSeconds = boundedSeconds(options["duration-seconds"]);
    const adapter = createProductionHostAdapter(manifest);
    result = await adapter.observe(manifest, { durationSeconds });
    const path = options.report ?? join(manifest.evidenceDir, `observation-${Date.now()}.json`);
    controlledPath(path, manifest.evidenceDir, "observation report");
    writeReport(path, result);
    process.exitCode = result.status === "passed" ? 0 : 1;
    return;
  } else if (command === "rollback") {
    if (options["transition-id"] !== manifest.id) throw new Error("rollback requires the manifest transition id");
    const adapter = createProductionHostAdapter(manifest);
    result = await runProductionRollback(manifest, adapter, {
      onEvent: (event) => process.stdout.write(JSON.stringify(event) + "\n"),
    });
    const path = options.report ?? join(manifest.evidenceDir, "ai-rollback-report.json");
    controlledPath(path, manifest.evidenceDir, "rollback report");
    writeReport(path, result);
    process.exitCode = result.status === "passed" ? 0 : 1;
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: "failed", code: /^[A-Za-z0-9_.:-]{1,100}$/u.test(error?.code ?? "") ? error.code : "PRODUCTION_TRANSITION_FAILED" }) + "\n");
  process.exitCode = 1;
});
