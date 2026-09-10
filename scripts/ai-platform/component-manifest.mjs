import { hashBytes } from "./production-contract.mjs";

function indexHash(files) {
  return hashBytes(Object.entries(files)
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([path, digest]) => digest + "  " + path + "\n").join(""));
}

export function validateAiComponentManifest(manifest) {
  const component = manifest?.components?.aiPlatform;
  const provenance = manifest?.buildProvenance?.aiPlatform;
  const source = manifest?.sourceHashes?.files;
  if (!component || !source || component.sourceCommit !== manifest.source?.commit
    || component.protocol !== "ai-task-v1" || component.entrypoint !== "ai-platform/src/cli.js"
    || !source[component.entrypoint] || !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(component.version)) return false;
  const dependencies = component.dependencies;
  if (!dependencies?.files || Object.keys(dependencies.files).length === 0 || indexHash(dependencies.files) !== dependencies.treeSha256) return false;
  const actualDependencies = Object.fromEntries(Object.entries(source).filter(([path]) => path.startsWith("ai-platform/node_modules/")));
  if (indexHash(actualDependencies) !== dependencies.treeSha256) return false;
  const migrations = Object.fromEntries(Object.entries(source).filter(([path]) => path.startsWith("ai-platform/src/db/migrations/")));
  if (!component.migrations || Object.keys(migrations).length === 0 || indexHash(migrations) !== indexHash(component.migrations)) return false;
  const lockfile = provenance?.lockfile;
  return lockfile?.path === "ai-platform/package-lock.json" && lockfile.sha256 === source[lockfile.path]
    && lockfile.lockfileVersion === 3
    && provenance.install?.command === "npm ci" && provenance.install.ignoreScripts === true && provenance.install.omitDev === true
    && provenance.runtime?.platform === "linux" && provenance.runtime.architecture === "x64"
    && Number(String(provenance.runtime.node).replace(/^v/u, "").split(".")[0]) >= 24;
}
