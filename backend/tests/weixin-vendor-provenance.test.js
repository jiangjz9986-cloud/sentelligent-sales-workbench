import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, "..");
const vendorRoot = resolve(backendRoot, "vendor", "weixin-agent-sdk");

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("vendored Weixin package version and controlled files match provenance and lockfile", () => {
  const packageJson = json(resolve(vendorRoot, "package.json"));
  const lock = json(resolve(backendRoot, "package-lock.json"));
  const provenance = readFileSync(resolve(vendorRoot, "PROVENANCE.md"), "utf8");

  assert.equal(lock.packages[""].dependencies["weixin-agent-sdk"], "file:vendor/weixin-agent-sdk");
  assert.deepEqual(lock.packages["node_modules/weixin-agent-sdk"], {
    resolved: "vendor/weixin-agent-sdk",
    link: true,
  });
  assert.equal(lock.packages["vendor/weixin-agent-sdk"].version, packageJson.version);
  assert.match(provenance, new RegExp(`^Fork version: ${packageJson.version.replaceAll(".", "\\.")}$`, "mu"));
  assert.match(
    provenance,
    /^Allowed modified files: dist\/index\.mjs, dist\/index\.d\.mts, package\.json, PROVENANCE\.md$/mu,
  );
  assert.equal(packageJson.main, "dist/index.mjs");
  assert.equal(packageJson.types, "dist/index.d.mts");
  assert.deepEqual(packageJson.exports, {
    ".": {
      types: "./dist/index.d.mts",
      default: "./dist/index.mjs",
    },
  });
  assert.deepEqual(packageJson.files, ["dist", "LICENSE", "PROVENANCE.md"]);
});
