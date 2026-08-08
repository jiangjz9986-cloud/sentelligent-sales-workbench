import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { buildReleaseManifest } from "./release-package.mjs";

const scriptPath = resolve("scripts", "production-cutover.sh");
const source = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : "";
const projectRoot = "/opt/sentelligent-sales-workbench";
const preflightCheckIds = [
  "release.identity",
  "node.version",
  "env.production",
  "env.authRequired",
  "env.authHash",
  "env.sessionSecret",
  "env.secureCookie",
  "env.cors",
  "env.solutionWrites",
  "env.aiModel",
  "env.icostWebhook",
  "env.icostIsolation",
  "env.invoiceExtraction",
  "database.environmentBinding",
  "database.quickCheck",
  "database.foreignKeys",
  "backup.identity",
  "backup.sha256",
  "backup.quickCheck",
  "backup.foreignKeys",
  "services.snapshot",
  "services.project",
  "services.commands",
  "services.unrelatedProtection",
];
const validArguments = [
  `--new-release=${projectRoot}/releases/release-candidate`,
  `--expected-commit=${"a".repeat(40)}`,
  "--database=/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite",
  `--backup-dir=${projectRoot}/backups/cutover-candidate`,
  `--evidence-dir=${projectRoot}/evidence/cutover-candidate`,
  `--weixin-session-dir=${projectRoot}/weixin-session`,
  `--node=${projectRoot}/runtime/node-v24/bin/node`,
  `--preflight-report=${projectRoot}/evidence/preflight-candidate.json`,
  `--preflight-report-sha256=${"b".repeat(64)}`,
];

function validPreflightReport({
  generatedAt = new Date().toISOString(),
  releasePath = `${projectRoot}/releases/release-candidate`,
  expectedCommit = "a".repeat(40),
  databasePath = "/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite",
} = {}) {
  return {
    schemaVersion: 2,
    product: "sentelligent-sales-workbench",
    generatedAt,
    status: "passed",
    scope: {
      releasePath,
      expectedCommit,
      databasePath,
      hostname: "sentelligent-production-01",
      machineIdSha256: "e".repeat(64),
    },
    summary: { total: 24, passed: 24, failed: 0 },
    checks: preflightCheckIds.map((id) => ({
      id,
      status: "passed",
      message: "verified",
    })),
  };
}

function findBash() {
  if (process.env.BASH_PATH) return process.env.BASH_PATH;
  if (process.platform !== "win32") return "bash";
  const bundled = join(
    process.env.USERPROFILE ?? "",
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "native",
    "git",
    "usr",
    "bin",
    "sh.exe",
  );
  return existsSync(bundled) ? bundled : "bash";
}

function toBashPath(filePath) {
  const normalized = resolve(filePath).replaceAll("\\", "/");
  if (process.platform !== "win32") return normalized;
  return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function runBash(args, options = {}) {
  return spawnSync(findBash(), args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      MSYS2_ARG_CONV_EXCL: "*",
      MSYS2_ENV_CONV_EXCL: "*",
      PATH: process.platform === "win32" ? "/usr/bin:/bin" : process.env.PATH,
      ...options.env,
    },
    input: options.input,
  });
}

function outputOf(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function makeFakeSha256Command(root, hash) {
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin, { recursive: true });
  const executable = join(fakeBin, "sha256sum");
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf "%s  %s\\n" "$FAKE_SHA" "$1"\n',
    "utf8",
  );
  chmodSync(executable, 0o755);
  return fakeBin;
}

function makeReleaseFixture(commit = "a".repeat(40)) {
  const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-release-"));
  const contents = new Map([
    ["backend/src/server.js", Buffer.from("export const server = true;\n")],
    ["backend/src/weixin/worker.js", Buffer.from("export const worker = true;\n")],
    [
      "backend/node_modules/production-only/index.js",
      Buffer.from("export const productionOnly = true;\n"),
    ],
    [
      "backend/src/db/migrations/0001_fixture.sql",
      Buffer.from("CREATE TABLE fixture (id TEXT PRIMARY KEY);\n"),
    ],
    [
      "outputs/product-design-prototype/scripts/static-server.mjs",
      Buffer.from("export const staticServer = true;\n"),
    ],
    [
      "outputs/product-design-prototype/dist/index.html",
      Buffer.from("<main>release fixture</main>\n"),
    ],
  ]);
  for (const [relativePath, content] of contents) {
    const filePath = join(root, ...relativePath.split("/"));
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content);
  }
  const manifest = buildReleaseManifest({
    source: { commit, clean: true },
    createdAt: "2026-07-29T08:00:00.000Z",
    files: [...contents.keys()],
    contentByPath: contents,
    rootDirectory: `sentelligent-sales-workbench-${commit.slice(0, 12)}`,
  });
  writeFileSync(
    join(root, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { root, manifest };
}

function makeMigrationReleaseFixture(root, { foreignKeyViolation = false } = {}) {
  const releaseRoot = join(root, "release");
  const migrationEntry = join(releaseRoot, "backend", "src", "db.js");
  mkdirSync(join(migrationEntry, ".."), { recursive: true });
  writeFileSync(
    join(releaseRoot, "backend", "package.json"),
    `${JSON.stringify({ type: "module" })}\n`,
    "utf8",
  );
  writeFileSync(
    migrationEntry,
    [
      'import { DatabaseSync } from "node:sqlite";',
      'if (!process.argv.includes("--migrate")) throw new Error("Expected --migrate");',
      'if (process.env.DATABASE_PATH) throw new Error("Production database path leaked into migration rehearsal");',
      'const database = new DatabaseSync(process.env.DATABASE_URL);',
      'try {',
      foreignKeyViolation
        ? '  database.exec("PRAGMA foreign_keys = OFF; CREATE TABLE candidate_parent (id INTEGER PRIMARY KEY); CREATE TABLE candidate_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES candidate_parent(id)); INSERT INTO candidate_child (id, parent_id) VALUES (1, 999);");'
        : '  database.exec("CREATE TABLE candidate_migration (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");',
      '} finally {',
      '  database.close();',
      '}',
      'console.log("Database migrated");',
      '',
    ].join("\n"),
    "utf8",
  );
  return releaseRoot;
}

function createMigrationSourceDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE existing_record (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL
      );
      INSERT INTO existing_record (id, label) VALUES (1, 'production-data');
    `);
  } finally {
    database.close();
  }
}

function databaseHasTable(databasePath, tableName) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Boolean(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName),
    );
  } finally {
    database.close();
  }
}

function sourceAndRun(command, options = {}) {
  return runBash(
    ["-c", `source "$1"\n${command}`, "production-cutover-test", toBashPath(scriptPath)],
    options,
  );
}

function shellArray(name) {
  const match = source.match(
    new RegExp(`readonly -a ${name}=\\((?<body>[\\s\\S]*?)\\n\\)`, "u"),
  );
  assert.ok(match, `${name} must be a readonly shell array`);
  return match.groups.body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^['"]|['"]$/g, ""));
}

describe("controlled production cutover", () => {
  it("has valid Bash syntax", () => {
    assert.ok(source, "production-cutover.sh must exist");
    const result = runBash(["-n", toBashPath(scriptPath)]);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, outputOf(result));
  });

  it("requires every deployment identity and state path as an explicit parameter", () => {
    const result = runBash([toBashPath(scriptPath), "--help"]);

    assert.equal(result.status, 0, outputOf(result));
    for (const option of [
      "--new-release",
      "--expected-commit",
      "--database",
      "--backup-dir",
      "--evidence-dir",
      "--weixin-session-dir",
      "--node",
      "--preflight-report",
      "--preflight-report-sha256",
    ]) {
      assert.match(result.stdout, new RegExp(`${option}(?:=|[ <])`));
    }
  });

  it("rejects unknown arguments and missing option values", () => {
    for (const args of [
      ["--unknown-option"],
      ["--unknown-option", "--help"],
      ["--new-release"],
      ["--expected-commit"],
      ["--preflight-report"],
      ["--preflight-report-sha256"],
    ]) {
      const result = runBash([toBashPath(scriptPath), ...args]);
      assert.notEqual(result.status, 0, `${args.join(" ")} must fail`);
      assert.match(outputOf(result), /unknown argument|requires a value/i);
    }
  });

  it("pins service mutations to exactly three project units and stop/restart", () => {
    assert.deepEqual(shellArray("PROJECT_SERVICES"), [
      "sentelligent-backend.service",
      "sentelligent-frontend.service",
      "sentelligent-weixin-agent.service",
    ]);
    assert.deepEqual(shellArray("SYSTEMCTL_MUTATING_ACTIONS"), ["stop", "restart"]);
    assert.match(source, /systemctl_mutate\(\)/);
    assert.match(source, /systemctl "\$action" "\$service"/);

    const directMutations = source.match(
      /systemctl\s+(?:start|stop|restart|reload|enable|disable|mask|unmask)\b/g,
    );
    assert.deepEqual(
      directMutations,
      null,
      `service mutations must pass through systemctl_mutate: ${directMutations}`,
    );
    assert.doesNotMatch(source, /^\s*(?:sudo\s+)?(?:pkill|killall|service)\s+/m);
  });

  it("rejects shared Caddy and unsupported actions before systemctl is called", () => {
    for (const command of [
      "systemctl_mutate restart sentelligent-caddy.service",
      "systemctl_mutate start sentelligent-backend.service",
    ]) {
      const result = sourceAndRun(command);
      assert.notEqual(result.status, 0, outputOf(result));
      assert.match(outputOf(result), /refusing systemctl mutation/i);
      assert.doesNotMatch(outputOf(result), /command not found/i);
    }
  });

  it("allows the wrapper to invoke one approved unit at a time", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-systemctl-"));
    const fakeBin = join(root, "bin");
    const logPath = join(root, "systemctl.log");
    try {
      mkdirSync(fakeBin, { recursive: true });
      const fakeSystemctl = join(fakeBin, "systemctl");
      writeFileSync(
        fakeSystemctl,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(toBashPath(logPath))}\n`,
        "utf8",
      );
      chmodSync(fakeSystemctl, 0o755);

      const result = sourceAndRun(
        "systemctl_mutate restart sentelligent-backend.service",
        {
          env: {
            PATH: `${toBashPath(fakeBin)}:/usr/bin:/bin`,
          },
        },
      );

      assert.equal(result.status, 0, outputOf(result));
      assert.equal(readFileSync(logPath, "utf8"), "restart sentelligent-backend.service\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects lexical and canonical release path escapes", () => {
    for (const unsafeRelease of [
      `${projectRoot}/releases/../outside`,
      `${projectRoot}/releases/nested/candidate`,
      `${projectRoot}/current`,
    ]) {
      const args = validArguments.map((argument) =>
        argument.startsWith("--new-release=")
          ? `--new-release=${unsafeRelease}`
          : argument,
      );
      const result = runBash([toBashPath(scriptPath), ...args]);
      assert.notEqual(result.status, 0, `${unsafeRelease} must fail`);
      assert.match(outputOf(result), /release path|direct child|releases root/i);
      assert.doesNotMatch(outputOf(result), /systemctl/i);
    }
  });

  it("rejects overlapping backup, evidence, and WeChat state paths", () => {
    const cases = [
      [
        projectRoot + "/backups/cutover",
        projectRoot + "/evidence/cutover",
        projectRoot + "/backups/cutover/weixin-session",
      ],
      [
        projectRoot + "/backups/cutover",
        projectRoot + "/evidence/cutover",
        projectRoot,
      ],
    ];

    for (const paths of cases) {
      const result = runBash([
        "-c",
        [
          'source "$1"',
          "BACKUP_DIR=$2",
          "EVIDENCE_DIR=$3",
          "WEIXIN_SESSION_DIR=$4",
          "validate_state_path_isolation",
        ].join("\n"),
        "production-cutover-test",
        toBashPath(scriptPath),
        ...paths,
      ]);

      assert.notEqual(result.status, 0, outputOf(result));
      assert.match(outputOf(result), /state paths overlap/i);
    }
  });

  it("fails when any protected service PID changes", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-protected-"));
    const beforePath = join(root, "before.tsv");
    const afterPath = join(root, "after.tsv");
    const stableRows = [
      "service\tsentelligent-caddy.service\tactive\tenabled\t431\t2026-07-29 01:00:00 UTC\tunit-sha",
      "caddyfile\t/etc/caddy/Caddyfile\tcaddy-sha",
      "listener\t443\ttcp LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*",
    ];
    try {
      writeFileSync(beforePath, `${stableRows.join("\n")}\n`, "utf8");
      writeFileSync(
        afterPath,
        `${stableRows[0].replace("\t431\t", "\t932\t")}\n${stableRows.slice(1).join("\n")}\n`,
        "utf8",
      );

      const directResult = runBash([
        "-c",
        'source "$1"\nassert_protected_unchanged "$2" "$3"',
        "production-cutover-test",
        toBashPath(scriptPath),
        toBashPath(beforePath),
        toBashPath(afterPath),
      ]);
      assert.notEqual(directResult.status, 0, outputOf(directResult));
      assert.match(outputOf(directResult), /protected state changed/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes protected listeners without transient socket queues", () => {
    const first = "tcp LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*";
    const second = "tcp LISTEN 7 4096 0.0.0.0:443 0.0.0.0:*";
    const outputs = [first, second].map((row) =>
      runBash([
        "-c",
        'source "$1"\nprintf "%s\\n" "$2" | normalize_listener_rows 443',
        "production-cutover-test",
        toBashPath(scriptPath),
        row,
      ]),
    );

    for (const result of outputs) {
      assert.equal(result.status, 0, outputOf(result));
    }
    assert.equal(outputs[0].stdout, "tcp|0.0.0.0:443\n");
    assert.equal(outputs[1].stdout, outputs[0].stdout);
  });

  it("binds frontend health to the expected immutable release dist", () => {
    const release = `${projectRoot}/releases/release-candidate`;
    const expectedDist = `${release}/outputs/product-design-prototype/dist`;
    const payloads = [
      [{ status: "ok", distPath: expectedDist }, 0],
      [
        {
          status: "ok",
          distPath: `${projectRoot}/releases/previous/outputs/product-design-prototype/dist`,
        },
        1,
      ],
    ];

    for (const [payload, expectedFailure] of payloads) {
      const result = runBash(
        [
          "-c",
          'source "$1"\nprintf "%s" "$3" | validate_frontend_health_payload "$2"',
          "production-cutover-test",
          toBashPath(scriptPath),
          release,
          JSON.stringify(payload),
        ],
        { env: { NODE_BIN: toBashPath(process.execPath) } },
      );
      if (expectedFailure === 0) {
        assert.equal(result.status, 0, outputOf(result));
      } else {
        assert.notEqual(result.status, 0, outputOf(result));
        assert.match(outputOf(result), /frontend health release mismatch/i);
      }
    }
  });

  it("rewrites exactly one old frontend DIST_PATH into the candidate release", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-frontend-env-"));
    const inputPath = join(root, "frontend.env");
    const outputPath = join(root, "frontend.next.env");
    const oldRelease = projectRoot + "/releases/previous";
    const newRelease = projectRoot + "/releases/candidate";
    try {
      writeFileSync(
        inputPath,
        [
          "HOST=127.0.0.1",
          "DIST_PATH=" + oldRelease + "/outputs/product-design-prototype/dist",
          "PORT=8088",
          "",
        ].join("\n"),
        "utf8",
      );
      const result = runBash([
        "-c",
        'source "$1"\ntransform_frontend_config "$2" "$3" "$4" "$5"',
        "production-cutover-test",
        toBashPath(scriptPath),
        toBashPath(inputPath),
        toBashPath(outputPath),
        oldRelease,
        newRelease,
      ]);

      assert.equal(result.status, 0, outputOf(result));
      const transformed = readFileSync(outputPath, "utf8");
      assert.match(
        transformed,
        new RegExp("DIST_PATH=" + newRelease + "/outputs/product-design-prototype/dist"),
      );
      assert.doesNotMatch(
        transformed,
        new RegExp("DIST_PATH=" + oldRelease + "/outputs/product-design-prototype/dist"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, duplicate, or unexpected frontend DIST_PATH values", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-frontend-invalid-"));
    const oldRelease = projectRoot + "/releases/previous";
    const newRelease = projectRoot + "/releases/candidate";
    const expected =
      "DIST_PATH=" + oldRelease + "/outputs/product-design-prototype/dist";
    try {
      for (const [name, content] of [
        ["missing", "PORT=8088\n"],
        ["duplicate", expected + "\n" + expected + "\n"],
        [
          "unexpected",
          "DIST_PATH=" + projectRoot + "/releases/other/dist\n",
        ],
      ]) {
        const inputPath = join(root, name + ".env");
        const outputPath = join(root, name + ".next.env");
        writeFileSync(inputPath, content, "utf8");
        const result = runBash([
          "-c",
          'source "$1"\ntransform_frontend_config "$2" "$3" "$4" "$5"',
          "production-cutover-test",
          toBashPath(scriptPath),
          toBashPath(inputPath),
          toBashPath(outputPath),
          oldRelease,
          newRelease,
        ]);

        assert.notEqual(result.status, 0, name + " must fail");
        assert.match(outputOf(result), /exactly one expected DIST_PATH/i);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies an extracted release manifest and rejects the wrong commit", () => {
    const fixture = makeReleaseFixture();
    try {
      for (const [commit, expectedFailure] of [
        [fixture.manifest.source.commit, 0],
        ["b".repeat(40), 1],
      ]) {
        const result = runBash(
          [
            "-c",
            'source "$1"\nNEW_RELEASE=$2\nEXPECTED_COMMIT=$3\nverify_release_manifest',
            "production-cutover-test",
            toBashPath(scriptPath),
            fixture.root.replaceAll("\\", "/"),
            commit,
          ],
          { env: { NODE_BIN: toBashPath(process.execPath) } },
        );

        if (expectedFailure === 0) {
          assert.equal(result.status, 0, outputOf(result));
        } else {
          assert.notEqual(result.status, 0, outputOf(result));
          assert.match(outputOf(result), /candidate release identity mismatch/i);
        }
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects candidate files outside the manifest inventory", () => {
    const fixture = makeReleaseFixture();
    try {
      const extraPath = join(fixture.root, "backend", "unverified-extra.js");
      writeFileSync(extraPath, "export const unverified = true;\n", "utf8");
      const result = runBash(
        [
          "-c",
          'source "$1"\nNEW_RELEASE=$2\nEXPECTED_COMMIT=$3\nverify_release_manifest',
          "production-cutover-test",
          toBashPath(scriptPath),
          fixture.root.replaceAll("\\", "/"),
          fixture.manifest.source.commit,
        ],
        { env: { NODE_BIN: toBashPath(process.execPath) } },
      );

      assert.notEqual(result.status, 0, outputOf(result));
      assert.match(outputOf(result), /inventory|file count/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts only a fresh exact 24/24 preflight report bound to this cutover", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-preflight-"));
    const reportPath = join(root, "preflight.json");
    const releasePath = `${projectRoot}/releases/release-candidate`;
    const currentReleasePath = `${projectRoot}/releases/current-release`;
    const expectedCommit = "a".repeat(40);
    const databasePath = "/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite";
    try {
      const runValidation = (report, expectedSha256 = null) => {
        writeFileSync(reportPath, `${JSON.stringify(report)}\n`, "utf8");
        chmodSync(reportPath, 0o600);
        const sha256 = expectedSha256 ?? createHash("sha256")
          .update(readFileSync(reportPath))
          .digest("hex");
        return sourceAndRun(
          [
            `PREFLIGHT_REPORT=${JSON.stringify(reportPath.replaceAll("\\", "/"))}`,
            `PREFLIGHT_REPORT_SHA256=${sha256}`,
            `NEW_RELEASE=${releasePath}`,
            `OLD_RELEASE=${currentReleasePath}`,
            `EXPECTED_COMMIT=${expectedCommit}`,
            `DATABASE_PATH=${databasePath}`,
            `NODE_BIN=${JSON.stringify(toBashPath(process.execPath))}`,
            "verify_preflight_report",
          ].join("\n"),
        );
      };

      const validResult = runValidation(validPreflightReport({
        releasePath: currentReleasePath,
        expectedCommit: "b".repeat(40),
      }));
      assert.equal(validResult.status, 0, outputOf(validResult));

      for (const [name, report, expectedPattern] of [
        [
          "stale",
          validPreflightReport({ generatedAt: "2026-08-01T00:00:00.000Z" }),
          /fresh|age/i,
        ],
        [
          "not 24\/24",
          {
            ...validPreflightReport(),
            status: "failed",
            summary: { total: 24, passed: 23, failed: 1 },
          },
          /24\/24|passed/i,
        ],
        [
          "wrong release",
          validPreflightReport({
            releasePath: `${projectRoot}/releases/other-candidate`,
            expectedCommit: "b".repeat(40),
          }),
          /scope|release/i,
        ],
        [
          "wrong commit",
          validPreflightReport({
            releasePath: currentReleasePath,
            expectedCommit: "not-a-commit",
          }),
          /scope|commit/i,
        ],
        [
          "wrong database",
          validPreflightReport({
            releasePath: currentReleasePath,
            expectedCommit: "b".repeat(40),
            databasePath: "/var/lib/sentelligent-sales-workbench/other.sqlite",
          }),
          /scope|database/i,
        ],
      ]) {
        const result = runValidation(report);
        assert.notEqual(result.status, 0, `${name} must fail`);
        assert.match(outputOf(result), expectedPattern, name);
      }

      const hashMismatch = runValidation(
        validPreflightReport(),
        "d".repeat(64),
      );
      assert.notEqual(hashMismatch.status, 0, "hash mismatch must fail");
      assert.match(outputOf(hashMismatch), /sha-256|hash/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks the preflight gate before frozen-release validation or service mutation", () => {
    const mainSource = source.slice(source.indexOf("main() {"));
    const gateIndex = mainSource.indexOf("verify_preflight_report");
    const freezeIndex = mainSource.indexOf("assert_candidate_release_frozen");
    const mutationIndex = mainSource.indexOf("stop_writers_and_lock_database");
    assert.ok(gateIndex >= 0, "main must verify the preflight report");
    assert.ok(freezeIndex > gateIndex, "preflight must pass before release freezing");
    assert.ok(mutationIndex > gateIndex, "preflight must pass before service mutation");
  });

  it("rehearses candidate migrations only on an isolated copy of a verified backup", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-migration-rehearsal-"));
    const databasePath = join(root, "production.sqlite");
    const runBackupDir = join(root, "backups");
    const systemctlLog = join(root, "systemctl.log");
    try {
      mkdirSync(runBackupDir, { recursive: true });
      const releaseRoot = makeMigrationReleaseFixture(root);
      createMigrationSourceDatabase(databasePath);
      const sourceBefore = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
      const fakeBin = join(root, "bin");
      mkdirSync(fakeBin, { recursive: true });
      const fakeSystemctl = join(fakeBin, "systemctl");
      writeFileSync(
        fakeSystemctl,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(toBashPath(systemctlLog))}\n`,
        "utf8",
      );
      chmodSync(fakeSystemctl, 0o755);
      const fakeChmod = join(fakeBin, "chmod");
      writeFileSync(fakeChmod, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(fakeChmod, 0o755);

      const directResult = runBash(
        [
          "-c",
          [
            'source "$1"',
            "NEW_RELEASE=$2",
            "export DATABASE_PATH=$3",
            "RUN_BACKUP_DIR=$4",
            "NODE_BIN=$5",
            "rehearse_candidate_migrations",
          ].join("\n"),
          "production-cutover-test",
          toBashPath(scriptPath),
          releaseRoot.replaceAll("\\", "/"),
          databasePath.replaceAll("\\", "/"),
          runBackupDir.replaceAll("\\", "/"),
          toBashPath(process.execPath),
        ],
        { env: { PATH: `${toBashPath(fakeBin)}:/usr/bin:/bin` } },
      );

      assert.equal(directResult.status, 0, outputOf(directResult));
      assert.equal(existsSync(systemctlLog), false, "migration rehearsal must not call systemctl");
      assert.equal(
        createHash("sha256").update(readFileSync(databasePath)).digest("hex"),
        sourceBefore,
        "migration rehearsal must not modify the production database",
      );
      assert.equal(databaseHasTable(databasePath, "candidate_migration"), false);

      const verifiedBackup = join(runBackupDir, "database-pre-cutover-verified.sqlite");
      const rehearsalDatabase = join(runBackupDir, "database-migration-rehearsal.sqlite");
      assert.equal(databaseHasTable(verifiedBackup, "candidate_migration"), false);
      assert.equal(databaseHasTable(rehearsalDatabase, "candidate_migration"), true);
      const rehearsal = new DatabaseSync(rehearsalDatabase, { readOnly: true });
      try {
        assert.deepEqual(
          rehearsal.prepare("PRAGMA quick_check").all().map((row) => ({ ...row })),
          [{ quick_check: "ok" }],
        );
        assert.deepEqual(rehearsal.prepare("PRAGMA foreign_key_check").all(), []);
      } finally {
        rehearsal.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks service mutation when the migrated rehearsal violates foreign keys", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-migration-invalid-"));
    const databasePath = join(root, "production.sqlite");
    const runBackupDir = join(root, "backups");
    const systemctlLog = join(root, "systemctl.log");
    try {
      mkdirSync(runBackupDir, { recursive: true });
      const releaseRoot = makeMigrationReleaseFixture(root, { foreignKeyViolation: true });
      createMigrationSourceDatabase(databasePath);
      const sourceBefore = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
      const fakeBin = join(root, "bin");
      mkdirSync(fakeBin, { recursive: true });
      const fakeSystemctl = join(fakeBin, "systemctl");
      writeFileSync(
        fakeSystemctl,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(toBashPath(systemctlLog))}\n`,
        "utf8",
      );
      chmodSync(fakeSystemctl, 0o755);
      const fakeChmod = join(fakeBin, "chmod");
      writeFileSync(fakeChmod, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(fakeChmod, 0o755);

      const result = runBash(
        [
          "-c",
          [
            'source "$1"',
            "NEW_RELEASE=$2",
            "export DATABASE_PATH=$3",
            "RUN_BACKUP_DIR=$4",
            "NODE_BIN=$5",
            "rehearse_candidate_migrations",
            "systemctl_mutate stop sentelligent-backend.service",
          ].join("\n"),
          "production-cutover-test",
          toBashPath(scriptPath),
          releaseRoot.replaceAll("\\", "/"),
          databasePath.replaceAll("\\", "/"),
          runBackupDir.replaceAll("\\", "/"),
          toBashPath(process.execPath),
        ],
        { env: { PATH: `${toBashPath(fakeBin)}:/usr/bin:/bin` } },
      );

      assert.notEqual(result.status, 0, outputOf(result));
      assert.match(outputOf(result), /foreign key|integrity verification/i);
      assert.equal(existsSync(systemctlLog), false, "failed rehearsal must stop before systemctl");
      assert.equal(
        createHash("sha256").update(readFileSync(databasePath)).digest("hex"),
        sourceBefore,
        "failed rehearsal must not modify the production database",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the candidate migration rehearsal before the first service mutation", () => {
    const mainStart = source.indexOf("\nmain() {");
    const invocationStart = source.indexOf('\nif [[ "${BASH_SOURCE[0]}"', mainStart);
    assert.ok(mainStart >= 0 && invocationStart > mainStart, "main function must be available");
    const mainBody = source.slice(mainStart, invocationStart);
    const verifyIndex = mainBody.indexOf("verify_release_manifest");
    const rehearsalIndex = mainBody.indexOf("rehearse_candidate_migrations");
    const stopIndex = mainBody.indexOf("stop_writers_and_lock_database");

    assert.ok(verifyIndex >= 0, "main must verify the release manifest");
    assert.ok(rehearsalIndex > verifyIndex, "rehearsal must use a verified candidate release");
    assert.ok(stopIndex > rehearsalIndex, "rehearsal must finish before service mutation");
  });

  it("does not remove a maintenance lock whose identity changed", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-lock-replaced-"));
    const lockPath = join(root, "database.maintenance-lock");
    const original = '{"runId":"original"}\n';
    const replacement = '{"runId":"replacement"}\n';
    const originalSha = createHash("sha256").update(original).digest("hex");
    const replacementSha = createHash("sha256").update(replacement).digest("hex");
    try {
      writeFileSync(lockPath, replacement, "utf8");
      const fakeBin = makeFakeSha256Command(root, replacementSha);
      const result = runBash([
        "-c",
        'source "$1"\nremove_owned_maintenance_lock "$2" "$3"',
        "production-cutover-test",
        toBashPath(scriptPath),
        toBashPath(lockPath),
        originalSha,
      ], { env: { PATH: `${toBashPath(fakeBin)}:/usr/bin:/bin`, FAKE_SHA: replacementSha } });

      assert.notEqual(result.status, 0, outputOf(result));
      assert.match(outputOf(result), /maintenance lock (?:identity|ownership) changed/i);
      assert.equal(readFileSync(lockPath, "utf8"), replacement);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes only the maintenance lock owned by the current run", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-lock-owned-"));
    const lockPath = join(root, "database.maintenance-lock");
    const content = '{"runId":"current"}\n';
    const expectedSha = createHash("sha256").update(content).digest("hex");
    try {
      writeFileSync(lockPath, content, "utf8");
      const fakeBin = makeFakeSha256Command(root, expectedSha);
      const result = runBash([
        "-c",
        'source "$1"\nremove_owned_maintenance_lock "$2" "$3"',
        "production-cutover-test",
        toBashPath(scriptPath),
        toBashPath(lockPath),
        expectedSha,
      ], { env: { PATH: `${toBashPath(fakeBin)}:/usr/bin:/bin`, FAKE_SHA: expectedSha } });

      assert.equal(result.status, 0, outputOf(result));
      assert.equal(existsSync(lockPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dereferences the cutover lock descriptor before checking hard-link count", () => {
    assert.match(
      source,
      /stat -L -c '%h' "\/proc\/\$\$\/fd\/\$CUTOVER_LOCK_FD"/,
    );
  });

  it("uses portable awk variable names for post-stop listener checks", () => {
    assert.doesNotMatch(source, /for \(index\s*=/);
    assert.match(source, /for \(field\s*= 1; field <= NF; field \+= 1\)/);
  });

  it("captures protected process, unit, Caddyfile, and listener identity", () => {
    assert.deepEqual(shellArray("PROTECTED_SERVICES"), [
      "sentelligent-caddy.service",
      "codex-account-vault-cloud.service",
      "qingyang-store.service",
      "codex-vault-mihomo.service",
    ]);
    assert.deepEqual(shellArray("PROTECTED_PORTS"), ["80", "443", "4876", "8797"]);
    assert.match(source, /MainPID/);
    assert.match(source, /ActiveEnterTimestamp/);
    assert.match(source, /FragmentPath/);
    assert.match(source, /\/etc\/caddy\/Caddyfile/);
    assert.match(source, /sha256sum/);
    assert.match(source, /ss -H -lntu/);
    assert.match(source, /assert_protected_unchanged "\$PROTECTED_BEFORE" "\$PROTECTED_AFTER"/);
  });

  it("requires an already-frozen candidate before hash verification and any service mutation", () => {
    assert.match(source, /assert_candidate_release_frozen\(\)/);
    assert.match(source, /find "\$NEW_RELEASE" -type l/);
    assert.match(source, /find "\$NEW_RELEASE" -type f -links \+1/);
    assert.match(source, /stat -c '%u:%g:%a:%h:%F'/);
    const freezeBody = source.slice(
      source.indexOf("assert_candidate_release_frozen()"),
      source.indexOf("stage_project_units()"),
    );
    assert.doesNotMatch(freezeBody, /\bchown\b|\bchmod\b/);
    const mainSource = source.slice(source.indexOf("main() {"));
    const verifyIndex = mainSource.indexOf("  verify_release_manifest");
    const freezeIndex = mainSource.indexOf("  assert_candidate_release_frozen");
    const rehearsalIndex = mainSource.indexOf("  rehearse_candidate_migrations");
    const mutationIndex = mainSource.indexOf("  stop_writers_and_lock_database");
    assert.ok(verifyIndex >= 0, "manifest verification call is missing");
    assert.ok(freezeIndex >= 0, "frozen-release validation call is missing");
    assert.ok(verifyIndex > freezeIndex, "hash verification must use an already-frozen release");
    assert.ok(rehearsalIndex > verifyIndex, "migration rehearsal must use the verified frozen release");
    assert.ok(mutationIndex > rehearsalIndex, "release freeze must precede mutation");
  });

  it("rejects hidden systemd execution surfaces before staging and after install", () => {
    assert.match(source, /assert_clean_systemd_execution_surface\(\)/);
    for (const property of [
      "ExecCondition",
      "ExecStartPre",
      "ExecStartPost",
      "ExecStop",
      "ExecReload",
      "DropInPaths",
      "Environment",
      "RootDirectory",
      "RootImage",
      "BindPaths",
      "BindReadOnlyPaths",
      "ReadWritePaths",
      "ReadOnlyPaths",
      "InaccessiblePaths",
      "ExecPaths",
      "NoExecPaths",
      "TemporaryFileSystem",
    ]) {
      assert.match(source, new RegExp(property));
    }
    const stageBody = source.slice(
      source.indexOf("stage_project_units()"),
      source.indexOf("stop_writers_and_lock_database()"),
    );
    assert.match(
      stageBody,
      /assert_clean_systemd_execution_surface "\$service"/,
    );
    const readyBody = source.slice(
      source.indexOf("assert_project_services_ready()"),
      source.indexOf("normalize_listener_rows()"),
    );
    assert.match(
      readyBody,
      /assert_clean_systemd_execution_surface "\$service"/,
    );
  });

  it("accepts the hardened production unit surface and isolates environment files", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-cutover-surface-"));
    const fakeBin = join(root, "bin");
    try {
      mkdirSync(fakeBin, { recursive: true });
      const fakeSystemctl = join(fakeBin, "systemctl");
      writeFileSync(
        fakeSystemctl,
        `#!/bin/sh
service="$2"
property="\${3#--property=}"
output_property="$property"
case "$property" in
  PrivateTmp) value=yes ;;
  PrivateDevices|DynamicUser) value=no ;;
  ProtectSystem|ProtectHome) value=no ;;
  Environment)
    if [ "$service" = "sentelligent-weixin-agent.service" ]; then value='HOME=/opt/sentelligent-sales-workbench/weixin-session'; else value=''; fi
    ;;
  EnvironmentFiles)
    output_property=EnvironmentFile
    case "$service" in
      sentelligent-backend.service|sentelligent-weixin-agent.service) value='/opt/sentelligent-sales-workbench/config/backend.env (ignore_errors=no)' ;;
      sentelligent-frontend.service) value='/opt/sentelligent-sales-workbench/config/frontend.env (ignore_errors=no)' ;;
      *) value='' ;;
    esac
    if [ "\${INJECT_EXTRA_ENV_FILE:-}" = "1" ]; then
      value="$value /tmp/unapproved.env (ignore_errors=no)"
    fi
    ;;
  *) value='' ;;
esac
printf '%s=%s\\n' "$output_property" "$value"
`,
        "utf8",
      );
      chmodSync(fakeSystemctl, 0o755);

      const result = sourceAndRun(
        "assert_clean_systemd_execution_surface sentelligent-frontend.service && assert_clean_systemd_execution_surface sentelligent-weixin-agent.service",
        { env: { PATH: `${toBashPath(fakeBin)}:/usr/bin:/bin` } },
      );

      assert.equal(result.status, 0, outputOf(result));

      for (const service of [
        "sentelligent-backend.service",
        "sentelligent-frontend.service",
      ]) {
        const injected = sourceAndRun(
          `assert_clean_systemd_execution_surface ${service}`,
          {
            env: {
              INJECT_EXTRA_ENV_FILE: "1",
              PATH: `${toBashPath(fakeBin)}:/usr/bin:/bin`,
            },
          },
        );
        assert.notEqual(
          injected.status,
          0,
          `${service} accepted an additional EnvironmentFile`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("implements fail-closed maintenance, offline backups, atomic current, and rollback", () => {
    for (const required of [
      /\.maintenance-lock/,
      /\.opening-/,
      /fuser "\$DATABASE_PATH"/,
      /PRAGMA wal_checkpoint\(TRUNCATE\)/,
      /PRAGMA quick_check/,
      /PRAGMA foreign_key_check/,
      /tar -czf "\$WEIXIN_BACKUP"/,
      /tar -tzf "\$WEIXIN_BACKUP"/,
      /systemd-analyze verify/,
      /mv -Tf "\$CURRENT_TEMPORARY" "\$CURRENT_LINK"/,
      /rollback_cutover\(\)/,
      /trap rollback_cutover ERR/,
      /chmod 0600/,
      /umask 077/,
    ]) {
      assert.match(source, required);
    }
    assert.match(source, /assert_project_services_ready/);
    assert.match(source, /systemctl is-enabled/);
    assert.match(source, /systemctl is-active/);
    assert.match(source, /flock -n/);
    assert.match(source, /FRONTEND_ENV_BACKUP/);
    assert.match(source, /STAGED_FRONTEND_ENV/);
    assert.match(source, /atomic_replace_file/);
    assert.match(
      source,
      /atomic_replace_file "\$FRONTEND_ENV_BACKUP" "\$FRONTEND_ENV" rollback/,
    );
    assert.match(source, /current_target="\$\(readlink -f "\$CURRENT_LINK"/);
    assert.match(
      source,
      /if \[\[ "\$current_target" != "\$OLD_RELEASE" \]\]/,
    );
  });

  it("contains no embedded release version, commit, host, or credential", () => {
    assert.doesNotMatch(source, /\bv\d+\.\d+\.\d+\b/);
    assert.doesNotMatch(source, /\b[0-9a-f]{40}\b/);
    assert.doesNotMatch(
      source,
      /https?:\/\/(?!127\.0\.0\.1(?:[:/]))\d{1,3}(?:\.\d{1,3}){3}/,
    );
    assert.doesNotMatch(source, /(?:password|secret|api[_-]?key)\s*=\s*['"][^'"]+['"]/i);
  });
});
