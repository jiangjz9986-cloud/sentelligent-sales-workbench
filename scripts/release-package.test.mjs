import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

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

describe("portable release package", () => {
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
      workspace.write("assets/voice-wave.png", Buffer.from([1, 2, 3, 4]));
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
        ".git/config",
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
      ];
      for (const file of excludedFiles) workspace.write(file, `private fixture: ${file}\n`);

      const { createReleasePackage } = await loadReleaseModule();
      assert.equal(typeof createReleasePackage, "function");

      const result = await createReleasePackage({
        sourceRoot: workspace.root,
        outputDir: output.root,
        gitInfo: {
          branch: "codex/release-candidate",
          commit: "0123456789abcdef0123456789abcdef01234567",
          clean: true,
        },
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
      assert.ok(files.includes("assets/voice-wave.png"));
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
      assert.equal(manifest.source.branch, "codex/release-candidate");
      assert.equal(
        manifest.source.commit,
        "0123456789abcdef0123456789abcdef01234567",
      );
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
      ]) {
        assert.ok(
          manifest.requiredEnvNames.includes(name),
          `manifest should name ${name}`,
        );
      }
      assert.equal(manifest.rollback.strategy, "switch-release-pointer");
      assert.ok(manifest.rollback.instructions.length >= 4);
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

        const { createReleasePackage } = await loadReleaseModule();
        await assert.rejects(
          createReleasePackage({
            sourceRoot: workspace.root,
            outputDir: output.root,
            gitInfo: {
              branch: "codex/release-candidate",
              commit: "0123456789abcdef0123456789abcdef01234567",
              clean: true,
            },
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

  it(
    "builds and extracts the real project through Unicode source, output, and destination paths",
    { timeout: 180_000 },
    async () => {
      const acceptance = makeWorkspace("森特智行-发布验收-");
      const outputDir = join(acceptance.root, "发布包");
      const extractDir = join(acceptance.root, "解压结果");
      const frontendRoot = join(
        projectRoot,
        "outputs",
        "product-design-prototype",
      );
      const buildCommand = process.platform === "win32"
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

        const { createReleasePackage } = await loadReleaseModule();
        const result = await createReleasePackage({
          sourceRoot: projectRoot,
          outputDir,
          allowDirty: true,
          createdAt: "2026-07-19T08:00:00.000Z",
        });
        extractArchive(result.archivePath, extractDir);

        const packageRoot = join(extractDir, result.rootDirectory);
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
        acceptance.cleanup();
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
