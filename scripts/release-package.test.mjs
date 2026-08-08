import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

const projectRoot = resolve(import.meta.dirname, "..");

function makeWorkspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    write(relativePath, content) {
      const filePath = join(root, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
      return filePath;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function tarEntryMtimes(archivePath) {
  const tar = gunzipSync(readFileSync(archivePath));
  const mtimes = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim(),
      8,
    );
    const mtime = Number.parseInt(
      header.subarray(136, 148).toString("ascii").replaceAll("\0", "").trim(),
      8,
    );
    assert.ok(Number.isSafeInteger(size), "tar entry size must be valid octal");
    assert.ok(Number.isSafeInteger(mtime), "tar entry mtime must be valid octal");
    mtimes.push(mtime);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(mtimes.length > 0, "release archive must contain tar entries");
  return mtimes;
}

async function withSourceDateEpoch(value, callback) {
  const hadOriginal = Object.hasOwn(process.env, "SOURCE_DATE_EPOCH");
  const original = process.env.SOURCE_DATE_EPOCH;
  if (value === undefined) delete process.env.SOURCE_DATE_EPOCH;
  else process.env.SOURCE_DATE_EPOCH = value;
  try {
    return await callback();
  } finally {
    if (hadOriginal) process.env.SOURCE_DATE_EPOCH = original;
    else delete process.env.SOURCE_DATE_EPOCH;
  }
}

function withBom(text, encoding) {
  if (encoding === "utf8") {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  }
  const littleEndian = Buffer.from(text, "utf16le");
  if (encoding === "utf16le") {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]);
  }
  const bigEndian = Buffer.from(littleEndian);
  bigEndian.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]);
}

function stableTreeHash(files) {
  const index = Object.entries(files)
    .sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    )
    .map(([file, hash]) => `${hash}  ${file}\n`)
    .join("");
  return sha256(index);
}

async function loadReleaseModule() {
  try {
    return await import("./release-package.mjs");
  } catch (error) {
    assert.fail(`release-package.mjs must be implemented: ${error.message}`);
  }
}

function trackedNpmConfigs() {
  const result = spawnSync(
    "git",
    ["-c", "core.quotepath=false", "ls-files", "-z"],
    { cwd: projectRoot, encoding: "buffer" },
  );
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => basename(file).toLowerCase() === ".npmrc");
}

function extractArchive(archivePath, destination) {
  mkdirSync(destination, { recursive: true });
  const result = spawnSync(
    "tar",
    ["-xzf", archivePath, "-C", destination],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function listFiles(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) listFiles(root, fullPath, files);
    else files.push(fullPath.slice(root.length + 1).replaceAll("\\", "/"));
  }
  return files.sort();
}

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr || result.stdout,
  );
  return result.stdout.trim();
}

function commitWorkspace(workspace, branch = "codex/release-candidate") {
  runGit(workspace.root, ["init", "--initial-branch", branch]);
  runGit(workspace.root, ["config", "user.name", "Release Fixture"]);
  runGit(workspace.root, [
    "config",
    "user.email",
    "release-fixture@example.invalid",
  ]);
  runGit(workspace.root, ["add", "--all"]);
  runGit(workspace.root, ["commit", "-m", "test: initialize release fixture"]);
  return {
    branch: runGit(workspace.root, ["branch", "--show-current"]),
    commit: runGit(workspace.root, ["rev-parse", "HEAD"]),
  };
}

function writeMinimumReleaseFixture(workspace) {
  workspace.write("package.json", '{"name":"fixture","private":true}\n');
  workspace.write("backend/src/server.js", "export const ready = true;\n");
  workspace.write(
    "backend/src/db/migrations/0001_baseline.sql",
    "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
  );
  workspace.write(
    "outputs/product-design-prototype/dist/index.html",
    "<main>ready</main>\n",
  );
}

function runReleaseCli(args) {
  return spawnSync(
    process.execPath,
    [join(projectRoot, "scripts", "release-package.mjs"), ...args],
    {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

function copyTrackedProject(sourceRoot, destinationRoot) {
  const tracked = spawnSync(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    {
      cwd: sourceRoot,
      encoding: "buffer",
      windowsHide: true,
    },
  );
  assert.equal(
    tracked.status,
    0,
    tracked.error?.message || tracked.stderr.toString("utf8"),
  );
  for (const relativePath of tracked.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const sourcePath = join(sourceRoot, relativePath);
    if (!existsSync(sourcePath)) continue;
    const destinationPath = join(destinationRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
  }

  const productDist = join(
    "outputs",
    "product-design-prototype",
    "dist",
  );
  copyDirectoryFiles(
    join(sourceRoot, productDist),
    join(destinationRoot, productDist),
  );

}

async function withEnvironmentVariable(name, value, callback) {
  const hadOriginal = Object.hasOwn(process.env, name);
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await callback();
  } finally {
    if (hadOriginal) process.env[name] = original;
    else delete process.env[name];
  }
}

function copyDirectoryFiles(sourceRoot, destinationRoot, current = sourceRoot) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const sourcePath = join(current, entry.name);
    const relativePath = sourcePath.slice(sourceRoot.length + 1);
    const destinationPath = join(destinationRoot, relativePath);
    if (entry.isDirectory()) {
      copyDirectoryFiles(sourceRoot, destinationRoot, sourcePath);
    } else if (entry.isFile()) {
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    } else {
      assert.fail(`real release fixture cannot copy non-file entry: ${sourcePath}`);
    }
  }
}

describe("portable release package", () => {
  it("excludes business media while preserving explicit runtime assets", async () => {
    const { shouldExcludeReleasePath } = await loadReleaseModule();

    for (const file of [
      "receipts/payment-proof.png",
      "invoices/2026-06-17.pdf",
      "design-references/travel-expense/internal-screen.png",
      "design-options/reimbursement-option.png",
      "handoff/expense-list.xlsx",
    ]) {
      assert.equal(shouldExcludeReleasePath(file), true, `${file} must be excluded`);
    }

    for (const file of [
      "outputs/product-design-prototype/public/sente-logo.png",
      "outputs/product-design-prototype/dist/assets/sente-logo.png",
      "outputs/logo/sent-zhixing-transparent-logo.png",
      "森特透明底LOGO 800 800.png",
      "integrations/icost-shortcut/icost-dual-write.unsigned.shortcut",
    ]) {
      assert.equal(shouldExcludeReleasePath(file), false, `${file} must be preserved`);
    }
  });

  it("keeps every tracked npm cache setting portable", () => {
    const configFiles = trackedNpmConfigs();
    assert.ok(configFiles.length > 0, "at least one tracked .npmrc should be checked");

    for (const relativePath of configFiles) {
      const source = readFileSync(join(projectRoot, relativePath), "utf8");
      const assignment = source.match(/^\s*cache\s*=\s*(.+?)\s*$/im);
      if (!assignment) continue;
      const cachePath = assignment[1].replace(/^['"]|['"]$/g, "");
      assert.doesNotMatch(
        cachePath,
        /^(?:[A-Za-z]:[\\/]|\\\\|\/)/,
        `${relativePath} must not use an absolute cache path`,
      );
      assert.doesNotMatch(
        cachePath,
        /(?:^|[\\/])(?:Users|home)[\\/][^\\/]+/i,
        `${relativePath} must not embed a user profile`,
      );
    }
  });

  it("rejects a dirty release source through the API", async () => {
    const workspace = makeWorkspace("sentelligent-dirty-api-");
    const output = makeWorkspace("sentelligent-dirty-api-output-");
    try {
      writeMinimumReleaseFixture(workspace);
      commitWorkspace(workspace);
      workspace.write("README.md", "uncommitted release change\n");

      const { createReleasePackage } = await loadReleaseModule();
      await assert.rejects(
        createReleasePackage({
          sourceRoot: workspace.root,
          outputDir: output.root,
        }),
        /dirty|clean/i,
      );
      assert.deepEqual(listFiles(output.root), []);
    } finally {
      workspace.cleanup();
      output.cleanup();
    }
  });

  it("rejects API dirty and Git metadata bypass options", async () => {
    for (const [index, bypass] of [
      ["allowDirty", { allowDirty: true }],
      [
        "gitInfo",
        {
          gitInfo: {
            branch: "forged/release",
            commit: "0123456789abcdef0123456789abcdef01234567",
            clean: true,
          },
        },
      ],
    ]) {
      const workspace = makeWorkspace(`sentelligent-api-bypass-${index}-`);
      const output = makeWorkspace(`sentelligent-api-bypass-output-${index}-`);
      try {
        writeMinimumReleaseFixture(workspace);
        commitWorkspace(workspace);
        if (index === "allowDirty") {
          workspace.write("README.md", "dirty bypass attempt\n");
        }

        const { createReleasePackage } = await loadReleaseModule();
        await assert.rejects(
          createReleasePackage({
            sourceRoot: workspace.root,
            outputDir: output.root,
            ...bypass,
          }),
          new RegExp(`${index}.*(?:unsupported|not allowed)|(?:unsupported|not allowed).*${index}`, "i"),
        );
        assert.deepEqual(listFiles(output.root), []);
      } finally {
        workspace.cleanup();
        output.cleanup();
      }
    }
  });

  it("rejects dirty CLI sources and does not accept --allow-dirty", () => {
    const dirtyWorkspace = makeWorkspace("sentelligent-dirty-cli-");
    const dirtyOutput = makeWorkspace("sentelligent-dirty-cli-output-");
    const cleanWorkspace = makeWorkspace("sentelligent-clean-cli-");
    const cleanOutput = makeWorkspace("sentelligent-clean-cli-output-");
    try {
      writeMinimumReleaseFixture(dirtyWorkspace);
      commitWorkspace(dirtyWorkspace);
      dirtyWorkspace.write("README.md", "dirty CLI attempt\n");

      const dirtyResult = runReleaseCli([
        `--source-root=${dirtyWorkspace.root}`,
        `--output-dir=${dirtyOutput.root}`,
      ]);
      assert.notEqual(dirtyResult.status, 0);
      assert.match(dirtyResult.stderr, /dirty|clean/i);
      assert.deepEqual(listFiles(dirtyOutput.root), []);

      writeMinimumReleaseFixture(cleanWorkspace);
      commitWorkspace(cleanWorkspace);
      const bypassResult = runReleaseCli([
        `--source-root=${cleanWorkspace.root}`,
        `--output-dir=${cleanOutput.root}`,
        "--allow-dirty",
      ]);
      assert.notEqual(bypassResult.status, 0);
      assert.match(bypassResult.stderr, /unknown argument.*allow-dirty/i);
      assert.deepEqual(listFiles(cleanOutput.root), []);
    } finally {
      dirtyWorkspace.cleanup();
      dirtyOutput.cleanup();
      cleanWorkspace.cleanup();
      cleanOutput.cleanup();
    }
  });

  it("rebuilds ignored frontend dist from the exact commit instead of packaging stale worktree bytes", async () => {
    const workspace = makeWorkspace("sentelligent-stale-dist-");
    const output = makeWorkspace("sentelligent-stale-dist-output-");
    const extracted = makeWorkspace("sentelligent-stale-dist-extracted-");
    const committedBuild = "<main>fresh build from exact commit</main>\n";
    const staleBuild = "<main>stale ignored worktree build</main>\n";
    try {
      workspace.write(
        ".gitignore",
        "outputs/product-design-prototype/dist/\n",
      );
      workspace.write("package.json", '{"name":"fixture","private":true}\n');
      workspace.write("backend/src/server.js", "export const ready = true;\n");
      workspace.write(
        "backend/src/db/migrations/0001_baseline.sql",
        "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
      );
      workspace.write(
        "outputs/product-design-prototype/package.json",
        `${JSON.stringify({
          name: "frontend-fixture",
          private: true,
          type: "module",
          scripts: { build: "node build.mjs" },
        }, null, 2)}\n`,
      );
      workspace.write(
        "outputs/product-design-prototype/build.mjs",
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });',
          `writeFileSync(new URL("./dist/index.html", import.meta.url), ${JSON.stringify(committedBuild)});`,
          "",
        ].join("\n"),
      );
      const source = commitWorkspace(workspace);

      workspace.write(
        "outputs/product-design-prototype/dist/index.html",
        staleBuild,
      );
      assert.equal(
        runGit(workspace.root, ["status", "--porcelain=v1", "--untracked-files=all"]),
        "",
        "the stale ignored dist must not make the release source appear dirty",
      );

      const { createReleasePackage } = await loadReleaseModule();
      const result = await createReleasePackage({
        sourceRoot: workspace.root,
        outputDir: output.root,
        createdAt: "2026-07-19T08:00:00.000Z",
      });
      extractArchive(result.archivePath, extracted.root);

      const packagedBuildPath = join(
        extracted.root,
        result.rootDirectory,
        "outputs",
        "product-design-prototype",
        "dist",
        "index.html",
      );
      assert.equal(readFileSync(packagedBuildPath, "utf8"), committedBuild);
      assert.equal(
        result.manifest.buildHashes.files[
          "outputs/product-design-prototype/dist/index.html"
        ],
        sha256(committedBuild),
      );
      assert.equal(result.manifest.source.commit, source.commit);
    } finally {
      workspace.cleanup();
      output.cleanup();
      extracted.cleanup();
    }
  });

  it("rejects a generated dist root that links outside the exact commit checkout", async () => {
    const workspace = makeWorkspace("sentelligent-dist-link-");
    const externalDist = makeWorkspace("sentelligent-external-dist-");
    const output = makeWorkspace("sentelligent-dist-link-output-");
    try {
      externalDist.write(
        "outside.bin",
        Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]),
      );
      workspace.write(
        ".gitignore",
        "outputs/product-design-prototype/dist/\n",
      );
      workspace.write("package.json", '{"name":"fixture","private":true}\n');
      workspace.write("backend/src/server.js", "export const ready = true;\n");
      workspace.write(
        "backend/src/db/migrations/0001_baseline.sql",
        "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
      );
      workspace.write(
        "outputs/product-design-prototype/package.json",
        `${JSON.stringify({
          name: "frontend-fixture",
          private: true,
          type: "module",
          scripts: { build: "node build.mjs" },
        }, null, 2)}\n`,
      );
      workspace.write(
        "outputs/product-design-prototype/build.mjs",
        [
          'import { rmSync, symlinkSync } from "node:fs";',
          'import { fileURLToPath } from "node:url";',
          'const distPath = fileURLToPath(new URL("./dist", import.meta.url));',
          'rmSync(distPath, { recursive: true, force: true });',
          `symlinkSync(${JSON.stringify(externalDist.root)}, distPath, process.platform === "win32" ? "junction" : "dir");`,
          "",
        ].join("\n"),
      );
      commitWorkspace(workspace);

      const { createReleasePackage } = await loadReleaseModule();
      await assert.rejects(
        createReleasePackage({
          sourceRoot: workspace.root,
          outputDir: output.root,
          createdAt: "2026-07-19T08:00:00.000Z",
        }),
        /symbolic|junction|link|outside|escape|boundary/i,
      );
      assert.deepEqual(listFiles(output.root), []);
    } finally {
      workspace.cleanup();
      externalDist.cleanup();
      output.cleanup();
    }
  });

  it("never consumes ignored source node_modules while rebuilding an exact commit", async () => {
    const workspace = makeWorkspace("sentelligent-ignored-dependencies-");
    const output = makeWorkspace("sentelligent-ignored-dependencies-output-");
    try {
      workspace.write(
        ".gitignore",
        [
          "outputs/product-design-prototype/dist/",
          "outputs/product-design-prototype/node_modules/",
          "",
        ].join("\n"),
      );
      workspace.write("package.json", '{"name":"fixture","private":true}\n');
      workspace.write("backend/src/server.js", "export const ready = true;\n");
      workspace.write(
        "backend/src/db/migrations/0001_baseline.sql",
        "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
      );
      workspace.write(
        "outputs/product-design-prototype/package.json",
        `${JSON.stringify({
          name: "frontend-fixture",
          private: true,
          type: "module",
          scripts: { build: "node build.mjs" },
        }, null, 2)}\n`,
      );
      workspace.write(
        "outputs/product-design-prototype/build.mjs",
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { buildValue } from "./node_modules/build-helper.mjs";',
          'mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });',
          'writeFileSync(new URL("./dist/index.html", import.meta.url), buildValue);',
          "",
        ].join("\n"),
      );
      commitWorkspace(workspace);
      workspace.write(
        "outputs/product-design-prototype/node_modules/build-helper.mjs",
        'export const buildValue = "ignored dependency controlled the release\\n";\n',
      );
      assert.equal(
        runGit(workspace.root, ["status", "--porcelain=v1", "--untracked-files=all"]),
        "",
      );

      const { createReleasePackage } = await loadReleaseModule();
      await assert.rejects(
        createReleasePackage({
          sourceRoot: workspace.root,
          outputDir: output.root,
          createdAt: "2026-07-19T08:00:00.000Z",
        }),
        /build|module|dependency/i,
      );
      assert.deepEqual(listFiles(output.root), []);
    } finally {
      workspace.cleanup();
      output.cleanup();
    }
  });

  it("uses an allowlisted frontend build environment that cannot leak caller secrets", async () => {
    const workspace = makeWorkspace("sentelligent-build-environment-");
    const output = makeWorkspace("sentelligent-build-environment-output-");
    const extracted = makeWorkspace("sentelligent-build-environment-extracted-");
    const variableName = "SENTELLIGENT_RELEASE_TEST_BINARY_SECRET";
    const secret = `environment-only-${sha256("release-build-environment-secret")}`;
    try {
      workspace.write(
        ".gitignore",
        "outputs/product-design-prototype/dist/\n",
      );
      workspace.write("package.json", '{"name":"fixture","private":true}\n');
      workspace.write("backend/src/server.js", "export const ready = true;\n");
      workspace.write(
        "backend/src/db/migrations/0001_baseline.sql",
        "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
      );
      workspace.write(
        "outputs/product-design-prototype/package.json",
        `${JSON.stringify({
          name: "frontend-fixture",
          private: true,
          type: "module",
          scripts: { build: "node build.mjs" },
        }, null, 2)}\n`,
      );
      workspace.write(
        "outputs/product-design-prototype/build.mjs",
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          `const value = process.env.${variableName} ?? "not-present";`,
          'mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });',
          'writeFileSync(new URL("./dist/environment.bin", import.meta.url), Buffer.concat([Buffer.from([0]), Buffer.from(value)]));',
          "",
        ].join("\n"),
      );
      commitWorkspace(workspace);

      await withEnvironmentVariable(variableName, secret, async () => {
        const { createReleasePackage } = await loadReleaseModule();
        const result = await createReleasePackage({
          sourceRoot: workspace.root,
          outputDir: output.root,
          createdAt: "2026-07-19T08:00:00.000Z",
        });
        extractArchive(result.archivePath, extracted.root);
        const packagedBinary = readFileSync(join(
          extracted.root,
          result.rootDirectory,
          "outputs",
          "product-design-prototype",
          "dist",
          "environment.bin",
        ));
        assert.equal(packagedBinary.includes(Buffer.from(secret)), false);
        assert.equal(packagedBinary.includes(Buffer.from("not-present")), true);
      });
    } finally {
      workspace.cleanup();
      output.cleanup();
      extracted.cleanup();
    }
  });

  it("bypasses caller npm wrappers and invokes a controlled build entry directly", async () => {
    const workspace = makeWorkspace("sentelligent-direct-build-entry-");
    const output = makeWorkspace("sentelligent-direct-build-entry-output-");
    const extracted = makeWorkspace("sentelligent-direct-build-entry-extracted-");
    try {
      workspace.write(
        ".gitignore",
        "outputs/product-design-prototype/dist/\n",
      );
      workspace.write("package.json", '{"name":"fixture","private":true}\n');
      workspace.write("backend/src/server.js", "export const ready = true;\n");
      workspace.write(
        "backend/src/db/migrations/0001_baseline.sql",
        "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
      );
      workspace.write(
        "outputs/product-design-prototype/package.json",
        `${JSON.stringify({
          name: "frontend-fixture",
          private: true,
          type: "module",
          scripts: { build: "node build.mjs" },
        }, null, 2)}\n`,
      );
      workspace.write(
        "outputs/product-design-prototype/build.mjs",
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });',
          'writeFileSync(new URL("./dist/environment.json", import.meta.url), `${JSON.stringify(Object.keys(process.env).sort())}\\n`);',
          "",
        ].join("\n"),
      );
      workspace.write(
        "fake-npm/package.json",
        '{"name":"npm","version":"10.9.7","private":true}\n',
      );
      const fakeNpmCli = workspace.write(
        "fake-npm/bin/npm-cli.js",
        [
          'import { spawnSync } from "node:child_process";',
          'const result = spawnSync(process.execPath, ["build.mjs"], {',
          '  cwd: process.cwd(),',
          '  env: { ...process.env, NPM_WRAPPER_INJECTED: "yes" },',
          '  stdio: "inherit",',
          '});',
          'process.exit(result.status ?? 1);',
          "",
        ].join("\n"),
      );
      commitWorkspace(workspace);

      await withEnvironmentVariable("npm_execpath", fakeNpmCli, async () => {
        const { createReleasePackage } = await loadReleaseModule();
        const result = await createReleasePackage({
          sourceRoot: workspace.root,
          outputDir: output.root,
          createdAt: "2026-07-19T08:00:00.000Z",
        });
        extractArchive(result.archivePath, extracted.root);
        const environmentNames = JSON.parse(readFileSync(join(
          extracted.root,
          result.rootDirectory,
          "outputs",
          "product-design-prototype",
          "dist",
          "environment.json",
        ), "utf8"));
        assert.equal(environmentNames.includes("NPM_WRAPPER_INJECTED"), false);
        assert.deepEqual(
          environmentNames,
          result.manifest.buildProvenance.frontend.environment.allowedNames,
        );
      });
    } finally {
      workspace.cleanup();
      output.cleanup();
      extracted.cleanup();
    }
  });

  it("installs declared dependencies from the committed lockfile and records build provenance", async () => {
    const workspace = makeWorkspace("sentelligent-locked-dependencies-");
    const output = makeWorkspace("sentelligent-locked-dependencies-output-");
    const extracted = makeWorkspace("sentelligent-locked-dependencies-extracted-");
    const committedBuild = "committed lockfile dependency built the release\n";
    const ignoredBuild = "ignored source dependency changed the release\n";
    try {
      workspace.write(
        ".gitignore",
        [
          "outputs/product-design-prototype/dist/",
          "outputs/product-design-prototype/node_modules/",
          "",
        ].join("\n"),
      );
      workspace.write("package.json", '{"name":"fixture","private":true}\n');
      workspace.write("backend/src/server.js", "export const ready = true;\n");
      workspace.write(
        "backend/src/db/migrations/0001_baseline.sql",
        "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
      );
      workspace.write(
        "release-fixtures/release-build-helper/package.json",
        `${JSON.stringify({
          name: "release-build-helper",
          version: "1.0.0",
          private: true,
          type: "module",
          exports: "./index.mjs",
        }, null, 2)}\n`,
      );
      workspace.write(
        "release-fixtures/release-build-helper/index.mjs",
        `export const buildValue = ${JSON.stringify(committedBuild)};\n`,
      );
      const frontendPackage = {
        name: "frontend-fixture",
        private: true,
        type: "module",
        scripts: { build: "node build.mjs" },
        dependencies: {
          "release-build-helper": "file:../../release-fixtures/release-build-helper",
        },
      };
      workspace.write(
        "outputs/product-design-prototype/package.json",
        `${JSON.stringify(frontendPackage, null, 2)}\n`,
      );
      const lockfile = {
        name: "frontend-fixture",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "frontend-fixture",
            dependencies: frontendPackage.dependencies,
          },
          "../../release-fixtures/release-build-helper": {
            name: "release-build-helper",
            version: "1.0.0",
          },
          "node_modules/release-build-helper": {
            resolved: "../../release-fixtures/release-build-helper",
            link: true,
          },
        },
      };
      const lockfileContent = `${JSON.stringify(lockfile, null, 2)}\n`;
      workspace.write(
        "outputs/product-design-prototype/package-lock.json",
        lockfileContent,
      );
      workspace.write(
        "outputs/product-design-prototype/build.mjs",
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { buildValue } from "release-build-helper";',
          'mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });',
          'writeFileSync(new URL("./dist/index.html", import.meta.url), buildValue);',
          "",
        ].join("\n"),
      );
      commitWorkspace(workspace);

      workspace.write(
        "outputs/product-design-prototype/node_modules/release-build-helper/package.json",
        `${JSON.stringify({
          name: "release-build-helper",
          version: "9.9.9",
          type: "module",
          exports: "./index.mjs",
        }, null, 2)}\n`,
      );
      workspace.write(
        "outputs/product-design-prototype/node_modules/release-build-helper/index.mjs",
        `export const buildValue = ${JSON.stringify(ignoredBuild)};\n`,
      );
      assert.equal(
        runGit(workspace.root, ["status", "--porcelain=v1", "--untracked-files=all"]),
        "",
      );

      const { createReleasePackage } = await loadReleaseModule();
      const result = await createReleasePackage({
        sourceRoot: workspace.root,
        outputDir: output.root,
        createdAt: "2026-07-19T08:00:00.000Z",
      });
      extractArchive(result.archivePath, extracted.root);
      const packagedBuild = readFileSync(join(
        extracted.root,
        result.rootDirectory,
        "outputs",
        "product-design-prototype",
        "dist",
        "index.html",
      ), "utf8");
      assert.equal(packagedBuild, committedBuild);
      assert.notEqual(packagedBuild, ignoredBuild);
      assert.deepEqual(result.manifest.buildProvenance.frontend.lockfile, {
        path: "outputs/product-design-prototype/package-lock.json",
        sha256: sha256(lockfileContent),
        lockfileVersion: 3,
      });
      assert.equal(
        result.manifest.buildProvenance.frontend.runtime.node,
        process.version,
      );
      assert.match(
        result.manifest.buildProvenance.frontend.runtime.npm,
        /^\d+\.\d+\.\d+(?:[-+].+)?$/,
      );
      assert.deepEqual(result.manifest.buildProvenance.frontend.install, {
        command: "npm ci",
        ignoreScripts: true,
        includeDev: true,
      });
      assert.equal(
        result.manifest.buildProvenance.frontend.environment.identity,
        "sentelligent-release-frontend-v1",
      );
      assert.ok(
        result.manifest.buildProvenance.frontend.environment.allowedNames.includes(
          "NODE_ENV",
        ),
      );
    } finally {
      workspace.cleanup();
      output.cleanup();
      extracted.cleanup();
    }
  });

  it("rejects ignored local-dependency bytes injected by a shared post-checkout hook", async () => {
    const workspace = makeWorkspace("sentelligent-hook-local-dependency-");
    const output = makeWorkspace("sentelligent-hook-local-dependency-output-");
    try {
      workspace.write(
        ".gitignore",
        [
          "outputs/product-design-prototype/dist/",
          "outputs/product-design-prototype/node_modules/",
          "release-fixtures/release-build-helper/dist/",
          "",
        ].join("\n"),
      );
      workspace.write("package.json", '{"name":"fixture","private":true}\n');
      workspace.write("backend/src/server.js", "export const ready = true;\n");
      workspace.write(
        "backend/src/db/migrations/0001_baseline.sql",
        "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
      );
      workspace.write(
        "release-fixtures/release-build-helper/package.json",
        `${JSON.stringify({
          name: "release-build-helper",
          version: "1.0.0",
          private: true,
          type: "module",
          exports: "./dist/index.mjs",
        }, null, 2)}\n`,
      );
      const frontendPackage = {
        name: "frontend-fixture",
        private: true,
        type: "module",
        scripts: { build: "node build.mjs" },
        dependencies: {
          "release-build-helper": "file:../../release-fixtures/release-build-helper",
        },
      };
      workspace.write(
        "outputs/product-design-prototype/package.json",
        `${JSON.stringify(frontendPackage, null, 2)}\n`,
      );
      workspace.write(
        "outputs/product-design-prototype/package-lock.json",
        `${JSON.stringify({
          name: "frontend-fixture",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "frontend-fixture",
              dependencies: frontendPackage.dependencies,
            },
            "../../release-fixtures/release-build-helper": {
              name: "release-build-helper",
              version: "1.0.0",
            },
            "node_modules/release-build-helper": {
              resolved: "../../release-fixtures/release-build-helper",
              link: true,
            },
          },
        }, null, 2)}\n`,
      );
      workspace.write(
        "outputs/product-design-prototype/.npmrc",
        "offline=true\nregistry=https://registry.invalid/\n",
      );
      workspace.write(
        "outputs/product-design-prototype/build.mjs",
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { buildValue } from "release-build-helper";',
          'mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });',
          'writeFileSync(new URL("./dist/index.html", import.meta.url), buildValue);',
          "",
        ].join("\n"),
      );
      commitWorkspace(workspace);

      const hookPath = workspace.write(
        ".git/hooks/post-checkout",
        [
          "#!/bin/sh",
          'mkdir -p "$PWD/release-fixtures/release-build-helper/dist"',
          "cat > \"$PWD/release-fixtures/release-build-helper/dist/index.mjs\" <<'EOF'",
          'export const buildValue = "hook-controlled release\\n";',
          "EOF",
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(hookPath, 0o755);

      const { createReleasePackage } = await loadReleaseModule();
      await assert.rejects(
        createReleasePackage({
          sourceRoot: workspace.root,
          outputDir: output.root,
          createdAt: "2026-08-07T00:00:00.000Z",
        }),
        /exact release commit|local dependency|tracked|build|module/i,
      );
      assert.deepEqual(listFiles(output.root), []);
    } finally {
      workspace.cleanup();
      output.cleanup();
    }
  });

  it("isolates user and global npm configuration while including locked dev dependencies", async () => {
    const workspace = makeWorkspace("sentelligent-isolated-npm-config-");
    const output = makeWorkspace("sentelligent-isolated-npm-config-output-");
    try {
      workspace.write(
        ".gitignore",
        "outputs/product-design-prototype/dist/\n",
      );
      workspace.write("package.json", '{"name":"fixture","private":true}\n');
      workspace.write("backend/src/server.js", "export const ready = true;\n");
      workspace.write(
        "backend/src/db/migrations/0001_baseline.sql",
        "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
      );
      workspace.write(
        "outputs/product-design-prototype/package.json",
        `${JSON.stringify({
          name: "frontend-fixture",
          private: true,
          type: "module",
          scripts: { build: "node build.mjs" },
          devDependencies: { "fixture-only": "1.0.0" },
        }, null, 2)}\n`,
      );
      workspace.write(
        "outputs/product-design-prototype/package-lock.json",
        `${JSON.stringify({
          name: "frontend-fixture",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "frontend-fixture",
              devDependencies: { "fixture-only": "1.0.0" },
            },
            "node_modules/fixture-only": {
              version: "1.0.0",
              resolved: "https://registry.invalid/fixture-only-1.0.0.tgz",
              integrity: "sha512-Zml4dHVyZS1sb2NrZWRkZXBlbmRlbmN5",
              dev: true,
            },
          },
        }, null, 2)}\n`,
      );
      workspace.write(
        "outputs/product-design-prototype/build.mjs",
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });',
          'writeFileSync(new URL("./dist/index.html", import.meta.url), "isolated npm config\\n");',
          "",
        ].join("\n"),
      );
      workspace.write(
        "fake-npm/package.json",
        '{"name":"npm","version":"10.9.7","private":true}\n',
      );
      const fakeNpmCli = workspace.write(
        "fake-npm/bin/npm-cli.js",
        [
          'import { readFileSync } from "node:fs";',
          'const args = process.argv.slice(2);',
          'if (args[0] === "--version") { console.log("10.9.7"); process.exit(0); }',
          'if (args[0] !== "ci") process.exit(20);',
          'for (const flag of ["--ignore-scripts", "--include=dev", "--userconfig", "--globalconfig"]) {',
          '  if (!args.includes(flag)) process.exit(21);',
          '}',
          'for (const flag of ["--userconfig", "--globalconfig"]) {',
          '  const path = args[args.indexOf(flag) + 1];',
          '  if (!path || readFileSync(path, "utf8") !== "") process.exit(22);',
          '}',
          'process.exit(0);',
          "",
        ].join("\n"),
      );
      commitWorkspace(workspace);

      await withEnvironmentVariable(
        "SENTELLIGENT_RELEASE_NPM_CLI",
        fakeNpmCli,
        async () => {
          const { createReleasePackage } = await loadReleaseModule();
          const result = await createReleasePackage({
            sourceRoot: workspace.root,
            outputDir: output.root,
            createdAt: "2026-07-19T08:00:00.000Z",
          });
          assert.deepEqual(result.manifest.buildProvenance.frontend.install, {
            command: "npm ci",
            ignoreScripts: true,
            includeDev: true,
          });
        },
      );
    } finally {
      workspace.cleanup();
      output.cleanup();
    }
  });

  it("rejects committed local dependency specifications that escape the exact checkout", async () => {
    const checkout = makeWorkspace("sentelligent-local-dependency-checkout-");
    const external = makeWorkspace("sentelligent-local-dependency-external-");
    try {
      const frontendRoot = join(
        checkout.root,
        "outputs",
        "product-design-prototype",
      );
      mkdirSync(frontendRoot, { recursive: true });
      external.write(
        "package.json",
        '{"name":"external-build-input","version":"1.0.0"}\n',
      );
      const packageJson = {
        name: "frontend-fixture",
        dependencies: {
          "external-build-input": `file:${external.root.replaceAll("\\", "/")}`,
        },
      };
      const lockfile = {
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: packageJson.dependencies,
          },
          "node_modules/external-build-input": {
            resolved: `file:${external.root.replaceAll("\\", "/")}`,
            link: true,
          },
        },
      };

      const { validateFrontendDependencyInputs } = await loadReleaseModule();
      assert.equal(typeof validateFrontendDependencyInputs, "function");
      assert.throws(
        () => validateFrontendDependencyInputs({
          checkoutRoot: checkout.root,
          frontendRoot,
          packageJson,
          lockfile,
          tracked: new Set(),
        }),
        /outside|escape|exact checkout|commit/i,
      );
    } finally {
      checkout.cleanup();
      external.cleanup();
    }
  });

  it("rejects ignored bytes inside a local dependency even when release filters exclude them", async () => {
    const checkout = makeWorkspace("sentelligent-local-dependency-ignored-bytes-");
    try {
      const frontendRoot = join(
        checkout.root,
        "outputs",
        "product-design-prototype",
      );
      checkout.write(
        "release-fixtures/release-build-helper/package.json",
        '{"name":"release-build-helper","version":"1.0.0"}\n',
      );
      checkout.write(
        "release-fixtures/release-build-helper/dist/index.mjs",
        'export const buildValue = "ignored bytes";\n',
      );
      mkdirSync(frontendRoot, { recursive: true });
      const packageJson = {
        name: "frontend-fixture",
        dependencies: {
          "release-build-helper": "file:../../release-fixtures/release-build-helper",
        },
      };
      const lockfile = {
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: packageJson.dependencies,
          },
          "../../release-fixtures/release-build-helper": {
            name: "release-build-helper",
            version: "1.0.0",
          },
          "node_modules/release-build-helper": {
            resolved: "../../release-fixtures/release-build-helper",
            link: true,
          },
        },
      };
      const trackedPackagePath = "release-fixtures/release-build-helper/package.json";

      const { validateFrontendDependencyInputs } = await loadReleaseModule();
      assert.throws(
        () => validateFrontendDependencyInputs({
          checkoutRoot: checkout.root,
          frontendRoot,
          packageJson,
          lockfile,
          tracked: new Set([trackedPackagePath]),
        }),
        /outside the exact release commit|tracked|ignored|local dependency/i,
      );
    } finally {
      checkout.cleanup();
    }
  });

  it(
    "resolves a Windows PATH npm wrapper to its verified npm-cli.js",
    { skip: process.platform !== "win32" },
    async () => {
      const workspace = makeWorkspace("sentelligent-windows-path-npm-");
      const output = makeWorkspace("sentelligent-windows-path-npm-output-");
      try {
        workspace.write(
          ".gitignore",
          "outputs/product-design-prototype/dist/\n",
        );
        workspace.write("package.json", '{"name":"fixture","private":true}\n');
        workspace.write("backend/src/server.js", "export const ready = true;\n");
        workspace.write(
          "backend/src/db/migrations/0001_baseline.sql",
          "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
        );
        workspace.write(
          "outputs/product-design-prototype/package.json",
          `${JSON.stringify({
            name: "frontend-fixture",
            private: true,
            type: "module",
            scripts: { build: "node build.mjs" },
            devDependencies: { "fixture-only": "1.0.0" },
          }, null, 2)}\n`,
        );
        workspace.write(
          "outputs/product-design-prototype/package-lock.json",
          `${JSON.stringify({
            name: "frontend-fixture",
            lockfileVersion: 3,
            requires: true,
            packages: {
              "": {
                name: "frontend-fixture",
                devDependencies: { "fixture-only": "1.0.0" },
              },
              "node_modules/fixture-only": {
                version: "1.0.0",
                resolved: "https://registry.invalid/fixture-only-1.0.0.tgz",
                integrity: "sha512-Zml4dHVyZS1sb2NrZWRkZXBlbmRlbmN5",
                dev: true,
              },
            },
          }, null, 2)}\n`,
        );
        workspace.write(
          "outputs/product-design-prototype/build.mjs",
          [
            'import { mkdirSync, writeFileSync } from "node:fs";',
            'mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });',
            'writeFileSync(new URL("./dist/index.html", import.meta.url), "windows PATH npm\\n");',
            "",
          ].join("\n"),
        );
        commitWorkspace(workspace);

        const fakeNodeRoot = makeWorkspace("sentelligent-fake-node-root-");
        const fakeRuntimeRoot = makeWorkspace("sentelligent-fake-runtime-root-");
        try {
          fakeNodeRoot.write("npm.cmd", "@echo off\r\nexit /b 99\r\n");
          fakeNodeRoot.write(
            "node_modules/npm/package.json",
            '{"name":"npm","version":"10.9.7","private":true}\n',
          );
          fakeNodeRoot.write(
            "node_modules/npm/bin/npm-cli.js",
            [
              'const args = process.argv.slice(2);',
              'if (args[0] === "--version") { console.log("10.9.7"); process.exit(0); }',
              'if (args[0] !== "ci") process.exit(20);',
              'process.exit(0);',
              "",
            ].join("\n"),
          );
          const pathName = Object.keys(process.env).find(
            (name) => name.toLowerCase() === "path",
          ) ?? "PATH";
          const originalPath = process.env[pathName] ?? "";
          const fakeNodePath = join(fakeRuntimeRoot.root, basename(process.execPath));
          copyFileSync(process.execPath, fakeNodePath);
          await withEnvironmentVariable(
            "SENTELLIGENT_RELEASE_NPM_CLI",
            undefined,
            () => withEnvironmentVariable(
              "npm_execpath",
              undefined,
              () => withEnvironmentVariable(
                pathName,
                `${fakeNodeRoot.root}${delimiter}${originalPath}`,
                async () => {
                  const { createReleasePackage } = await loadReleaseModule();
                  const result = await createReleasePackage({
                    sourceRoot: workspace.root,
                    outputDir: output.root,
                    createdAt: "2026-07-19T08:00:00.000Z",
                    runtime: { nodeExecutable: fakeNodePath },
                  });
                  assert.equal(
                    result.manifest.buildProvenance.frontend.runtime.npm,
                    "10.9.7",
                  );
                  assert.equal(
                    result.manifest.buildProvenance.frontend.runtime.npmResolutionSource,
                    "PATH",
                  );
                },
              ),
            ),
          );
        } finally {
          fakeNodeRoot.cleanup();
          fakeRuntimeRoot.cleanup();
        }
      } finally {
        workspace.cleanup();
        output.cleanup();
      }
    },
  );

  it("cleans a Git worktree registration when exact-commit byte verification fails", async () => {
    const workspace = makeWorkspace("sentelligent-failed-worktree-");
    const output = makeWorkspace("sentelligent-failed-worktree-output-");
    try {
      writeMinimumReleaseFixture(workspace);
      commitWorkspace(workspace);
      workspace.write(".gitattributes", "checkout-mismatch.txt text eol=crlf\n");
      workspace.write("checkout-mismatch.txt", "line-one\nline-two\n");
      runGit(workspace.root, ["add", ".gitattributes", "checkout-mismatch.txt"]);
      runGit(workspace.root, ["commit", "-m", "add checkout mismatch fixture"]);

      const { createReleasePackage } = await loadReleaseModule();
      await assert.rejects(
        createReleasePackage({
          sourceRoot: workspace.root,
          outputDir: output.root,
          createdAt: "2026-07-19T08:00:00.000Z",
        }),
        /Exact release commit checkout bytes differ from the Git blob: checkout-mismatch\.txt/i,
      );

      const inventory = runGit(workspace.root, ["worktree", "list", "--porcelain"]);
      assert.equal(
        inventory.split(/\r?\n/u).filter((line) => line.startsWith("worktree ")).length,
        1,
        inventory,
      );
      const prune = spawnSync("git", ["worktree", "prune", "--dry-run", "--verbose"], {
        cwd: workspace.root,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(prune.status, 0, prune.stderr || prune.stdout);
      assert.equal(prune.stdout.trim(), "");
      assert.deepEqual(listFiles(output.root), []);
    } finally {
      spawnSync("git", ["worktree", "prune"], {
        cwd: workspace.root,
        encoding: "utf8",
        windowsHide: true,
      });
      workspace.cleanup();
      output.cleanup();
    }
  });

  it("rejects active smudge filters before detached release materialization", async () => {
    const workspace = makeWorkspace("sentelligent-smudge-filter-");
    const output = makeWorkspace("sentelligent-smudge-filter-output-");
    try {
      writeMinimumReleaseFixture(workspace);
      workspace.write(".gitattributes", "filter-target.txt filter=release-smudge\n");
      workspace.write("filter-target.txt", "tracked release bytes\n");
      commitWorkspace(workspace);

      const markerPath = join(workspace.root, ".git", "smudge-filter-ran");
      const markerForGit = markerPath.replaceAll("\\", "/");
      runGit(workspace.root, [
        "config",
        "filter.release-smudge.smudge",
        `cat > "${markerForGit}" && cat "${markerForGit}"`,
      ]);
      runGit(workspace.root, [
        "config",
        "filter.release-smudge.required",
        "true",
      ]);

      const { createReleasePackage } = await loadReleaseModule();
      await assert.rejects(
        createReleasePackage({
          sourceRoot: workspace.root,
          outputDir: output.root,
          createdAt: "2026-08-07T00:00:00.000Z",
        }),
        /filter|checkout materialization/i,
      );
      assert.equal(
        existsSync(markerPath),
        false,
        "release validation must reject the filter before Git executes it",
      );
      assert.deepEqual(listFiles(output.root), []);
    } finally {
      workspace.cleanup();
      output.cleanup();
    }
  });

  it("publishes an archive atomically and removes a partial temporary file after failure", async () => {
    const output = makeWorkspace("sentelligent-atomic-archive-output-");
    const archivePath = join(output.root, "release.tar.gz");
    const archive = Buffer.from("complete release archive bytes", "utf8");
    try {
      const { publishArchiveAtomically } = await loadReleaseModule();
      assert.equal(typeof publishArchiveAtomically, "function");
      assert.throws(
        () => publishArchiveAtomically(archivePath, archive, {
          openSync,
          writeFileSync(fileDescriptor, content) {
            writeFileSync(fileDescriptor, content.subarray(0, 7));
            throw new Error("simulated interrupted archive write");
          },
          fsyncSync,
          closeSync,
          linkSync,
          unlinkSync,
        }),
        /simulated interrupted archive write/i,
      );
      assert.equal(existsSync(archivePath), false);
      assert.deepEqual(listFiles(output.root), []);
    } finally {
      output.cleanup();
    }
  });

  it("never overwrites an existing final archive during atomic publication", async () => {
    const output = makeWorkspace("sentelligent-existing-archive-output-");
    const archivePath = output.write("release.tar.gz", "existing verified archive\n");
    const original = readFileSync(archivePath);
    try {
      const { publishArchiveAtomically } = await loadReleaseModule();
      assert.equal(typeof publishArchiveAtomically, "function");
      assert.throws(
        () => publishArchiveAtomically(
          archivePath,
          Buffer.from("replacement archive must not win", "utf8"),
        ),
        /already exists|exist/i,
      );
      assert.deepEqual(readFileSync(archivePath), original);
      assert.deepEqual(listFiles(output.root), ["release.tar.gz"]);
    } finally {
      output.cleanup();
    }
  });

  it("uses SOURCE_DATE_EPOCH for reproducible default manifests and tar mtimes", async () => {
    const workspace = makeWorkspace("sentelligent-source-date-epoch-");
    const output = makeWorkspace("sentelligent-source-date-epoch-output-");
    const epochSeconds = 1_700_000_000;
    try {
      writeMinimumReleaseFixture(workspace);
      commitWorkspace(workspace);

      await withSourceDateEpoch(String(epochSeconds), async () => {
        const { createReleasePackage } = await loadReleaseModule();
        const options = {
          sourceRoot: workspace.root,
          outputDir: output.root,
        };
        const first = await createReleasePackage(options);
        const firstArchive = readFileSync(first.archivePath);
        const firstMtimes = tarEntryMtimes(first.archivePath);
        rmSync(first.archivePath);

        const second = await createReleasePackage(options);
        const expectedCreatedAt = new Date(epochSeconds * 1000).toISOString();

        assert.equal(first.manifest.createdAt, expectedCreatedAt);
        assert.equal(second.manifest.createdAt, expectedCreatedAt);
        assert.ok(firstMtimes.every((mtime) => mtime === epochSeconds));
        assert.ok(
          tarEntryMtimes(second.archivePath).every(
            (mtime) => mtime === epochSeconds,
          ),
        );
        assert.equal(first.archiveSha256, second.archiveSha256);
        assert.deepEqual(firstArchive, readFileSync(second.archivePath));
      });
    } finally {
      workspace.cleanup();
      output.cleanup();
    }
  });

  it("creates byte-identical packages from a named branch and detached HEAD", async () => {
    const workspace = makeWorkspace("sentelligent-checkout-state-");
    const branchOutput = makeWorkspace("sentelligent-branch-output-");
    const detachedOutput = makeWorkspace("sentelligent-detached-output-");
    const epochSeconds = 1_700_000_000;
    try {
      writeMinimumReleaseFixture(workspace);
      const source = commitWorkspace(workspace);

      await withSourceDateEpoch(String(epochSeconds), async () => {
        const { createReleasePackage } = await loadReleaseModule();
        const branchPackage = await createReleasePackage({
          sourceRoot: workspace.root,
          outputDir: branchOutput.root,
        });

        runGit(workspace.root, ["checkout", "--detach", source.commit]);
        const detachedPackage = await createReleasePackage({
          sourceRoot: workspace.root,
          outputDir: detachedOutput.root,
        });

        const manifestBytes = (manifest) =>
          Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        assert.deepEqual(
          manifestBytes(branchPackage.manifest),
          manifestBytes(detachedPackage.manifest),
        );
        assert.deepEqual(branchPackage.manifest.source, {
          commit: source.commit,
          clean: true,
        });
        assert.equal(branchPackage.archiveSha256, detachedPackage.archiveSha256);
        assert.deepEqual(
          readFileSync(branchPackage.archivePath),
          readFileSync(detachedPackage.archivePath),
        );
      });
    } finally {
      workspace.cleanup();
      branchOutput.cleanup();
      detachedOutput.cleanup();
    }
  });

  it("falls back to the HEAD commit time when SOURCE_DATE_EPOCH is absent", async () => {
    const workspace = makeWorkspace("sentelligent-head-time-");
    const output = makeWorkspace("sentelligent-head-time-output-");
    try {
      writeMinimumReleaseFixture(workspace);
      commitWorkspace(workspace);
      const headEpochSeconds = Number(
        runGit(workspace.root, ["show", "-s", "--format=%ct", "HEAD"]),
      );

      await withSourceDateEpoch(undefined, async () => {
        const { createReleasePackage } = await loadReleaseModule();
        const options = {
          sourceRoot: workspace.root,
          outputDir: output.root,
        };
        const first = await createReleasePackage(options);
        const firstArchive = readFileSync(first.archivePath);
        rmSync(first.archivePath);
        const second = await createReleasePackage(options);

        assert.equal(
          first.manifest.createdAt,
          new Date(headEpochSeconds * 1000).toISOString(),
        );
        assert.equal(first.manifest.createdAt, second.manifest.createdAt);
        assert.ok(
          tarEntryMtimes(second.archivePath).every(
            (mtime) => mtime === headEpochSeconds,
          ),
        );
        assert.equal(first.archiveSha256, second.archiveSha256);
        assert.deepEqual(firstArchive, readFileSync(second.archivePath));
      });
    } finally {
      workspace.cleanup();
      output.cleanup();
    }
  });

  it("resolves the captured release commit time even when HEAD points at a newer commit", async () => {
    const workspace = makeWorkspace("sentelligent-captured-commit-time-");
    try {
      writeMinimumReleaseFixture(workspace);
      const captured = commitWorkspace(workspace);
      const capturedEpochSeconds = Number(
        runGit(workspace.root, ["show", "-s", "--format=%ct", captured.commit]),
      );
      workspace.write("README.md", "newer HEAD must not change release time\n");
      runGit(workspace.root, ["add", "README.md"]);
      const newerTimestamp = new Date((capturedEpochSeconds + 3_600) * 1000).toISOString();
      const newerCommit = spawnSync(
        "git",
        ["commit", "-m", "test: move head after capturing release commit"],
        {
          cwd: workspace.root,
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: newerTimestamp,
            GIT_COMMITTER_DATE: newerTimestamp,
          },
        },
      );
      assert.equal(
        newerCommit.status,
        0,
        newerCommit.error?.message || newerCommit.stderr || newerCommit.stdout,
      );
      assert.notEqual(runGit(workspace.root, ["rev-parse", "HEAD"]), captured.commit);

      await withSourceDateEpoch(undefined, async () => {
        const { resolveReleaseTimestamp } = await loadReleaseModule();
        assert.equal(typeof resolveReleaseTimestamp, "function");
        const timestamp = resolveReleaseTimestamp(
          workspace.root,
          captured.commit,
        );
        assert.equal(
          timestamp.toISOString(),
          new Date(capturedEpochSeconds * 1000).toISOString(),
        );
      });
    } finally {
      workspace.cleanup();
    }
  });

  it("documents rollback by repinning exactly the three project systemd units", async () => {
    const { buildReleaseManifest } = await loadReleaseModule();
    const files = [
      "README.md",
      "backend/src/db/migrations/0001_baseline.sql",
      "outputs/product-design-prototype/dist/index.html",
    ];
    const contentByPath = new Map(
      files.map((file) => [file, Buffer.from(`${file}\n`, "utf8")]),
    );
    const manifest = buildReleaseManifest({
      source: {
        commit: "0123456789abcdef0123456789abcdef01234567",
        clean: true,
      },
      createdAt: "2026-07-19T08:00:00.000Z",
      files,
      contentByPath,
      rootDirectory: "sentelligent-sales-workbench-0123456789ab",
    });

    assert.equal(
      manifest.rollback.strategy,
      "repin-systemd-units-to-immutable-release",
    );
    assert.deepEqual(manifest.rollback.serviceUnits, [
      "sentelligent-backend.service",
      "sentelligent-frontend.service",
      "sentelligent-weixin-agent.service",
    ]);
    const rollbackText = [
      manifest.rollback.releasePathPolicy,
      ...manifest.rollback.instructions,
    ].join(" ");
    assert.match(rollbackText, /immutable release.*real path/i);
    assert.match(rollbackText, /current.*(?:informational|must not)/i);
    assert.doesNotMatch(rollbackText, /switch.*current.*pointer/i);
    assert.doesNotMatch(rollbackText, /sentelligent-\*/i);
    assert.match(rollbackText, /systemctl daemon-reload/i);
    assert.match(rollbackText, /restart only/i);
    for (const unit of manifest.rollback.serviceUnits) {
      assert.match(rollbackText, new RegExp(unit.replaceAll(".", "\\.")));
    }
    assert.match(rollbackText, /do not restart.*Caddy.*unrelated services/i);
  });

  it("creates an extractable archive without secrets, runtime data, dependencies, or Codex metadata", async () => {
    const workspace = makeWorkspace("sentelligent-release-source-");
    const output = makeWorkspace("sentelligent-release-output-");
    const extracted = makeWorkspace("sentelligent-release-extracted-");

    try {
      const appBuild = "console.log('release build');\n";
      const appStyles = "body { color: #111; }\n";
      const baselineMigration = "CREATE TABLE customers (id TEXT PRIMARY KEY);\n";
      const integrityMigration = "export const version = 2;\n";

      workspace.write("package.json", '{"name":"fixture","private":true}\n');
      workspace.write("README.md", "# Fixture\n");
      workspace.write(
        "outputs/product-design-prototype/docs/02-开发实施方案.md",
        "# 开发实施方案\n",
      );
      workspace.write(
        ".env.example",
        [
          "AUTH_PASSWORD_HASH=",
          "AUTH_SESSION_SECRET=<set-in-production>",
          "MODEL_API_KEY=${MODEL_API_KEY}",
          `${["API", "KEY"].join("_")}="<set-in-production>"`,
          "WEIXIN_AGENT_API_TOKEN=your-token-here",
          "",
        ].join("\n"),
      );
      workspace.write("backend/src/server.js", "export const ready = true;\n");
      workspace.write("src/auth/token.js", "export const tokenName = 'csrf';\n");
      workspace.write("src/audio/player.js", "export const play = () => {};\n");
      workspace.write("src/sessionManager.js", "export const restore = () => {};\n");
      workspace.write(
        "outputs/product-design-prototype/public/voice-wave.png",
        Buffer.from([1, 2, 3, 4]),
      );
      workspace.write("backend/src/db/migrations/0001_baseline.sql", baselineMigration);
      workspace.write(
        "backend/src/db/migrations/0002_write_integrity.mjs",
        integrityMigration,
      );
      workspace.write("outputs/product-design-prototype/dist/index.html", "<main>ready</main>\n");
      workspace.write(
        "outputs/product-design-prototype/dist/assets/app.js",
        appBuild,
      );
      workspace.write(
        "outputs/product-design-prototype/dist/assets/app.css",
        appStyles,
      );

      const excludedFiles = [
        ".env",
        ".env.production",
        "production.env",
        "config.env.local",
        "backend/.env",
        "backend/data/sales-workbench.sqlite",
        "backend/data/sales-workbench.sqlite-wal",
        "backend/data/sales-workbench.sqlite.bak",
        "backend/data/sales-workbench.db.backup",
        "backend/data/sales-workbench.sqlite3.copy",
        "backend/data/sales-workbench.db.old",
        "logs/backend.log",
        "backend.log.1",
        "backend.log.2026-07-19.gz",
        "backend.pid.2",
        "build/server.js",
        "coverage/lcov.info",
        "other/dist/app.js",
        "voice-recordings/call.webm",
        "voice-assets/call.wav",
        "runtime-audio/meeting.m4a",
        "audio-sessions/live.webm",
        "weixin-session/credentials.json",
        "sessions/browser.json",
        "node_modules/example/index.js",
        "outputs/product-design-prototype/node_modules/example/index.js",
        ".git/private-fixture",
        ".codex/state.json",
        ".runtime/handoff/private.txt",
        ".npm-cache/cache.bin",
        "server-private.pem",
        "id_rsa",
        "id_ed25519",
        "credentials.json",
        "secrets.json",
        "service-account.json",
        "private-secret.txt",
        "deployment.secret",
        "release-keystore.jks",
        "client.ppk",
        "receipts/payment-proof.png",
        "invoices/2026-06-17.pdf",
        "design-references/travel-expense/internal-screen.png",
        "handoff/expense-list.xlsx",
      ];
      for (const file of excludedFiles) workspace.write(file, `private fixture: ${file}\n`);

      const source = commitWorkspace(workspace);

      const { createReleasePackage } = await loadReleaseModule();
      assert.equal(typeof createReleasePackage, "function");

      const result = await createReleasePackage({
        sourceRoot: workspace.root,
        outputDir: output.root,
        createdAt: "2026-07-19T08:00:00.000Z",
      });

      assert.ok(existsSync(result.archivePath), "release archive should exist");
      assert.match(result.archiveSha256, /^[a-f0-9]{64}$/);
      extractArchive(result.archivePath, extracted.root);

      const packageRoot = join(extracted.root, result.rootDirectory);
      const files = listFiles(packageRoot);
      assert.ok(files.includes("package.json"));
      assert.ok(files.includes(".env.example"));
      assert.ok(files.includes("src/auth/token.js"));
      assert.ok(files.includes("src/audio/player.js"));
      assert.ok(files.includes("src/sessionManager.js"));
      assert.ok(
        files.includes("outputs/product-design-prototype/public/voice-wave.png"),
      );
      assert.ok(
        files.includes(
          "outputs/product-design-prototype/docs/02-开发实施方案.md",
        ),
      );
      assert.ok(files.includes("outputs/product-design-prototype/dist/assets/app.js"));
      assert.ok(files.includes("release-manifest.json"));

      for (const file of excludedFiles) {
        assert.ok(!files.includes(file), `${file} must not be included`);
      }
      assert.ok(!files.some((file) => file.includes("/node_modules/")));
      assert.ok(!files.some((file) => /(?:^|\/)\.(?:git|codex|runtime)(?:\/|$)/.test(file)));

      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "release-manifest.json"), "utf8"),
      );
      assert.deepEqual(manifest.source, {
        commit: source.commit,
        clean: true,
      });
      assert.equal(
        manifest.buildHashes.files[
          "outputs/product-design-prototype/dist/assets/app.js"
        ],
        sha256(appBuild),
      );
      assert.equal(
        manifest.buildHashes.files[
          "outputs/product-design-prototype/dist/assets/app.css"
        ],
        sha256(appStyles),
      );
      assert.equal(
        manifest.migrationChecksums.files[
          "backend/src/db/migrations/0001_baseline.sql"
        ],
        sha256(baselineMigration),
      );
      assert.equal(
        manifest.migrationChecksums.files[
          "backend/src/db/migrations/0002_write_integrity.mjs"
        ],
        sha256(integrityMigration),
      );

      const sourceFiles = files.filter(
        (file) =>
          file !== "release-manifest.json" &&
          !file.startsWith("outputs/product-design-prototype/dist/"),
      );
      const expectedSourceHashes = Object.fromEntries(
        sourceFiles.map((file) => [
          file,
          sha256(readFileSync(join(packageRoot, file))),
        ]),
      );
      assert.deepEqual(manifest.sourceHashes.files, expectedSourceHashes);
      assert.equal(
        manifest.sourceHashes.treeSha256,
        stableTreeHash(expectedSourceHashes),
      );
      assert.ok(!("release-manifest.json" in manifest.sourceHashes.files));
      assert.ok(
        !Object.keys(manifest.sourceHashes.files).some((file) =>
          file.startsWith("outputs/product-design-prototype/dist/"),
        ),
      );

      for (const name of [
        "NODE_ENV",
        "DATABASE_URL",
        "AUTH_PASSWORD_HASH",
        "AUTH_SESSION_SECRET",
        "AUTH_COOKIE_SECURE",
        "CORS_ALLOWED_ORIGINS",
        "SOLUTION_WRITES_ENABLED",
        "MODEL_API_KEY",
        "WEIXIN_AGENT_API_TOKEN",
        "ICOST_WEBHOOK_TOKEN",
        "ICOST_WEBHOOK_OWNER",
        "ICOST_WEBHOOK_RATE_LIMIT",
        "ICOST_WEBHOOK_WINDOW_MS",
        "INVOICE_OCR_COMMAND",
        "INVOICE_PDF_TEXT_COMMAND",
        "INVOICE_OCR_LANGUAGES",
        "INVOICE_TEXT_EXTRACTION_TIMEOUT_MS",
      ]) {
        assert.ok(
          manifest.requiredEnvNames.includes(name),
          `manifest should name ${name}`,
        );
      }
      assert.equal(
        manifest.rollback.strategy,
        "repin-systemd-units-to-immutable-release",
      );
      assert.deepEqual(manifest.rollback.serviceUnits, [
        "sentelligent-backend.service",
        "sentelligent-frontend.service",
        "sentelligent-weixin-agent.service",
      ]);
      assert.match(manifest.rollback.databasePolicy, /forward/i);
      assert.doesNotMatch(
        JSON.stringify(manifest),
        /AUTH_SESSION_SECRET\s*[:=]\s*[^",}\s]+/,
        "manifest must contain environment names only",
      );
    } finally {
      workspace.cleanup();
      output.cleanup();
      extracted.cleanup();
    }
  });

  it("packages the exact installed backend production dependency tree", async () => {
    const workspace = makeWorkspace("sentelligent-production-dependencies-");
    const output = makeWorkspace("sentelligent-production-dependencies-output-");
    const extracted = makeWorkspace("sentelligent-production-dependencies-extracted-");
    try {
      writeMinimumReleaseFixture(workspace);
      workspace.write(
        "backend/package.json",
        `${JSON.stringify({
          name: "backend-fixture",
          private: true,
          type: "module",
          dependencies: { "production-only": "1.0.0" },
        }, null, 2)}\n`,
      );
      workspace.write(
        "backend/package-lock.json",
        `${JSON.stringify({
          name: "backend-fixture",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "backend-fixture",
              dependencies: { "production-only": "1.0.0" },
            },
            "node_modules/production-only": {
              version: "1.0.0",
              resolved: "https://registry.invalid/production-only-1.0.0.tgz",
              integrity: "sha512-cHJvZHVjdGlvbi1vbmx5",
            },
          },
        }, null, 2)}\n`,
      );
      workspace.write(
        "fake-npm/package.json",
        '{"name":"npm","version":"10.9.7","private":true}\n',
      );
      const fakeNpmCli = workspace.write(
        "fake-npm/bin/npm-cli.js",
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { join } from "node:path";',
          'const args = process.argv.slice(2);',
          'if (args[0] === "--version") { console.log("10.9.7"); process.exit(0); }',
          'if (args[0] !== "ci" || !args.includes("--ignore-scripts") || !args.includes("--omit=dev")) process.exit(30);',
          'const packageRoot = join(process.cwd(), "node_modules", "production-only");',
          'mkdirSync(packageRoot, { recursive: true });',
          'writeFileSync(join(packageRoot, "package.json"), "{\\"name\\":\\"production-only\\",\\"version\\":\\"1.0.0\\"}\\n");',
          'writeFileSync(join(packageRoot, "index.js"), "export const productionOnly = true;\\n");',
          '',
        ].join("\n"),
      );
      commitWorkspace(workspace);

      await withEnvironmentVariable(
        "SENTELLIGENT_RELEASE_NPM_CLI",
        fakeNpmCli,
        async () => {
          const { createReleasePackage } = await loadReleaseModule();
          const result = await createReleasePackage({
            sourceRoot: workspace.root,
            outputDir: output.root,
            createdAt: "2026-08-07T00:00:00.000Z",
          });
          extractArchive(result.archivePath, extracted.root);
          const packageRoot = join(extracted.root, result.rootDirectory);
          const dependencyPath =
            "backend/node_modules/production-only/index.js";
          assert.equal(
            readFileSync(join(packageRoot, dependencyPath), "utf8"),
            "export const productionOnly = true;\n",
          );
          assert.equal(
            result.manifest.productionDependencyHashes.files[dependencyPath],
            sha256("export const productionOnly = true;\n"),
          );
          assert.ok(
            !Object.hasOwn(result.manifest.sourceHashes.files, dependencyPath),
          );
          assert.deepEqual(
            result.manifest.buildProvenance.backend.install,
            {
              command: "npm ci",
              ignoreScripts: true,
              omitDev: true,
            },
          );
        },
      );
    } finally {
      workspace.cleanup();
      output.cleanup();
      extracted.cleanup();
    }
  });

  it("rejects real keys, tokens, passwords, and private keys in included templates", async () => {
    const sensitiveFixtures = [
      {
        path: "backend/.env.example",
        value: ["s", "k"].join("") + `-${sha256("provider-key-fixture")}`,
        content(value) {
          return `MODEL_API_KEY=${value}\n`;
        },
      },
      {
        path: "config/credentials.sample.json",
        value: `token_${sha256("access-token-fixture")}`,
        content(value) {
          return `${JSON.stringify({ accessToken: value }, null, 2)}\n`;
        },
      },
      {
        path: "config/auth-template.yaml",
        value: sha256("password-fixture"),
        content(value) {
          return `password: ${value}\n`;
        },
      },
      {
        path: "backend/src/runtime-config.js",
        value: ["Prod", "735280", "!"].join(""),
        content(value) {
          const tick = String.fromCharCode(96);
          return ["const password", tick + value + tick].join(" = ") + ";\n";
        },
      },
      {
        path: "config/private-key.example.txt",
        value: [
          ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
          sha256("private-key-fixture"),
          ["-----END", "PRIVATE KEY-----"].join(" "),
        ].join("\n"),
        content(value) {
          return `${value}\n`;
        },
      },
    ];

    for (const [index, fixture] of sensitiveFixtures.entries()) {
      const workspace = makeWorkspace(`sentelligent-secret-source-${index}-`);
      const output = makeWorkspace(`sentelligent-secret-output-${index}-`);
      try {
        workspace.write("package.json", '{"name":"fixture","private":true}\n');
        workspace.write("backend/src/server.js", "export const ready = true;\n");
        workspace.write(
          "backend/src/db/migrations/0001_baseline.sql",
          "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
        );
        workspace.write(
          "outputs/product-design-prototype/dist/index.html",
          "<main>ready</main>\n",
        );
        workspace.write(fixture.path, fixture.content(fixture.value));
        commitWorkspace(workspace);

        const { createReleasePackage } = await loadReleaseModule();
        await assert.rejects(
          createReleasePackage({
            sourceRoot: workspace.root,
            outputDir: output.root,
            createdAt: "2026-07-19T08:00:00.000Z",
          }),
          (error) => {
            assert.match(error.message, /secret/i);
            assert.ok(!error.message.includes(fixture.value));
            return true;
          },
        );
        assert.deepEqual(listFiles(output.root), []);
      } finally {
        workspace.cleanup();
        output.cleanup();
      }
    }
  });

  it("allows explicit low-entropy credential labels only inside test source", async () => {
    const workspace = makeWorkspace("sentelligent-test-placeholder-");
    const output = makeWorkspace("sentelligent-test-placeholder-output-");
    try {
      writeMinimumReleaseFixture(workspace);
      workspace.write(
        "backend/tests/machine-auth.test.js",
        [
          'const config = { weixinAgentApiToken: "machine-secret" };',
          'const loginPassword = "fixture-password-for-tests";',
          'const icostWebhookToken = "qa-icost-webhook-token";',
          'const modelApiKey = "test-expense-analysis-key";',
          'const providerSecret = "test-provider-error-secret";',
          "",
        ].join("\n"),
      );
      commitWorkspace(workspace);

      const { createReleasePackage } = await loadReleaseModule();
      const result = await createReleasePackage({
        sourceRoot: workspace.root,
        outputDir: output.root,
        createdAt: "2026-07-19T08:00:00.000Z",
      });
      assert.ok(existsSync(result.archivePath));
    } finally {
      workspace.cleanup();
      output.cleanup();
    }
  });

  it("allows GitHub Actions context references without treating them as credential values", async () => {
    const workspace = makeWorkspace("sentelligent-github-context-");
    const output = makeWorkspace("sentelligent-github-context-output-");
    try {
      writeMinimumReleaseFixture(workspace);
      workspace.write(
        ".github/workflows/release.yml",
        [
          "name: Release",
          "env:",
          "  GH_TOKEN: ${{ github.token }}",
          "  API_TOKEN: ${{ secrets.RELEASE_API_TOKEN }}",
          "",
        ].join("\n"),
      );
      commitWorkspace(workspace);

      const { createReleasePackage } = await loadReleaseModule();
      const result = await createReleasePackage({
        sourceRoot: workspace.root,
        outputDir: output.root,
        createdAt: "2026-07-19T08:00:00.000Z",
      });
      assert.ok(existsSync(result.archivePath));
    } finally {
      workspace.cleanup();
      output.cleanup();
    }
  });

  it("rejects sensitive assignments in ordinary YAML, JSON, and BOM text encodings", async () => {
    const sensitiveFixtures = [
      {
        path: "config/runtime-placeholder.yaml",
        value: "machine-secret",
        content(value) {
          return `clientSecret: ${value}\n`;
        },
      },
      {
        path: "config/runtime-prefixed-random.yaml",
        value: `test_${sha256("prefixed-random-access-token")}`,
        content(value) {
          return `accessToken: ${value}\n`;
        },
      },
      {
        path: "config/runtime-weak-password.yaml",
        value: "secret",
        assertValueHidden: false,
        content(value) {
          return `password: ${value}\n`;
        },
      },
      {
        path: "src/runtime-config.js",
        value: sha256("ordinary-javascript-client-secret"),
        content(value) {
          return `export const clientSecret = "${value}";\n`;
        },
      },
      {
        path: "config/runtime.yaml",
        value: sha256("ordinary-yaml-client-secret"),
        content(value) {
          return `client_secret: ${value}\n`;
        },
      },
      {
        path: "config/runtime.json",
        value: `token_${sha256("ordinary-json-access-token")}`,
        content(value) {
          return `${JSON.stringify({ accessToken: value }, null, 2)}\n`;
        },
      },
      {
        path: "config/runtime-config.yaml",
        value: sha256("utf8-bom-api-key"),
        content(value) {
          return withBom(`api-key: ${value}\n`, "utf8");
        },
      },
      {
        path: "backend/.env.example",
        value: sha256("utf16le-model-key"),
        content(value) {
          return withBom(`MODEL_API_KEY=${value}\n`, "utf16le");
        },
      },
      {
        path: "config/credentials.env.example",
        value: sha256("utf16be-password"),
        content(value) {
          return withBom(`password=${value}\n`, "utf16be");
        },
      },
    ];

    for (const [index, fixture] of sensitiveFixtures.entries()) {
      const workspace = makeWorkspace(`sentelligent-text-secret-${index}-`);
      const output = makeWorkspace(`sentelligent-text-output-${index}-`);
      try {
        workspace.write("package.json", '{"name":"fixture","private":true}\n');
        workspace.write("backend/src/server.js", "export const ready = true;\n");
        workspace.write(
          "backend/src/db/migrations/0001_baseline.sql",
          "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
        );
        workspace.write(
          "outputs/product-design-prototype/dist/index.html",
          "<main>ready</main>\n",
        );
        workspace.write(fixture.path, fixture.content(fixture.value));
        commitWorkspace(workspace);

        const { createReleasePackage } = await loadReleaseModule();
        await assert.rejects(
          createReleasePackage({
            sourceRoot: workspace.root,
            outputDir: output.root,
            createdAt: "2026-07-19T08:00:00.000Z",
          }),
          (error) => {
            assert.match(error.message, /secret/i);
            if (fixture.assertValueHidden !== false) {
              assert.ok(!error.message.includes(fixture.value));
            }
            return true;
          },
        );
        assert.deepEqual(listFiles(output.root), []);
      } finally {
        workspace.cleanup();
        output.cleanup();
      }
    }
  });

  it("fails closed when explicit text configuration cannot be decoded safely", async () => {
    const malformedFixtures = [
      Buffer.from([0xc3, 0x28]),
      Buffer.from("clientSecret=not-a-secret\0trailing", "utf8"),
    ];

    for (const [index, content] of malformedFixtures.entries()) {
      const workspace = makeWorkspace(`sentelligent-bad-text-${index}-`);
      const output = makeWorkspace(`sentelligent-bad-text-output-${index}-`);
      try {
        workspace.write("package.json", '{"name":"fixture","private":true}\n');
        workspace.write("backend/src/server.js", "export const ready = true;\n");
        workspace.write(
          "backend/src/db/migrations/0001_baseline.sql",
          "CREATE TABLE customers (id TEXT PRIMARY KEY);\n",
        );
        workspace.write(
          "outputs/product-design-prototype/dist/index.html",
          "<main>ready</main>\n",
        );
        workspace.write(`config/runtime-${index}.yaml`, content);
        commitWorkspace(workspace);

        const { createReleasePackage } = await loadReleaseModule();
        await assert.rejects(
          createReleasePackage({
            sourceRoot: workspace.root,
            outputDir: output.root,
            createdAt: "2026-07-19T08:00:00.000Z",
          }),
          (error) => {
            assert.match(error.message, /secret|decode|text/i);
            assert.ok(!error.message.includes("not-a-secret"));
            return true;
          },
        );
        assert.deepEqual(listFiles(output.root), []);
      } finally {
        workspace.cleanup();
        output.cleanup();
      }
    }
  });

  it(
    "builds and extracts the real project through Unicode source, output, and destination paths",
    { timeout: 180_000 },
    async () => {
      const source = makeWorkspace("森特智行-源代码-");
      const output = makeWorkspace("森特智行-发布包-");
      const extracted = makeWorkspace("森特智行-解压结果-");
      const frontendRoot = join(
        projectRoot,
        "outputs",
        "product-design-prototype",
      );
      const viteEntry = join(frontendRoot, "node_modules", "vite", "bin", "vite.js");
      const buildCommand = existsSync(viteEntry)
        ? { command: process.execPath, args: [viteEntry, "build"] }
        : process.platform === "win32"
          ? {
              command: process.env.ComSpec ?? "cmd.exe",
              args: ["/d", "/s", "/c", "npm.cmd", "run", "build"],
            }
          : { command: "npm", args: ["run", "build"] };

      try {
        const build = spawnSync(buildCommand.command, buildCommand.args, {
          cwd: frontendRoot,
          encoding: "utf8",
          timeout: 120_000,
        });
        assert.equal(
          build.status,
          0,
          build.error?.message || build.stderr || build.stdout,
        );

        copyTrackedProject(projectRoot, source.root);
        commitWorkspace(source);

        const { createReleasePackage } = await loadReleaseModule();
        const result = await createReleasePackage({
          sourceRoot: source.root,
          outputDir: output.root,
          createdAt: "2026-07-19T08:00:00.000Z",
        });
        extractArchive(result.archivePath, extracted.root);

        const packageRoot = join(extracted.root, result.rootDirectory);
        const manifest = JSON.parse(
          readFileSync(join(packageRoot, "release-manifest.json"), "utf8"),
        );
        assert.ok(
          existsSync(join(packageRoot, "docs", "正式交付验收手册.md")),
        );
        assert.ok(
          existsSync(
            join(
              packageRoot,
              "outputs",
              "product-design-prototype",
              "dist",
              "index.html",
            ),
          ),
        );
        assert.ok(Object.keys(manifest.buildHashes.files).length > 0);
        assert.ok(Object.keys(manifest.sourceHashes.files).length > 0);
        assert.match(manifest.sourceHashes.treeSha256, /^[a-f0-9]{64}$/);
      } finally {
        source.cleanup();
        output.cleanup();
        extracted.cleanup();
      }
    },
  );

  it("exposes dedicated package and production preflight commands", () => {
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf8"),
    );

    assert.equal(
      packageJson.scripts?.["release:package"],
      "node scripts/release-package.mjs",
    );
    assert.equal(
      packageJson.scripts?.["preflight:production"],
      "node scripts/production-preflight.mjs",
    );
    assert.equal(
      packageJson.scripts?.["test:release"],
      "node --test scripts/release-package.test.mjs scripts/production-preflight.test.mjs",
    );
  });
});
