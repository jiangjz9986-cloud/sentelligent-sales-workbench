import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { buildReleaseManifest } from "./release-package.mjs";

const requiredProjectServices = [
  "sentelligent-backend.service",
  "sentelligent-frontend.service",
  "sentelligent-caddy.service",
  "sentelligent-weixin-agent.service",
];
const expectedReleaseCommit = "0123456789abcdef0123456789abcdef01234567";
const immutableReleaseRoot =
  `/opt/sentelligent-sales-workbench/releases/2026-07-29_${expectedReleaseCommit.slice(0, 7)}`;
const projectNodeExecutable =
  "/opt/sentelligent-sales-workbench/runtime/node-v24/bin/node";

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "sentelligent-preflight-"));
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

function makeDatabase(filePath, { foreignKeyViolation = false } = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parents(id)
      );
      INSERT INTO parents (id) VALUES (1);
      INSERT INTO children (id, parent_id) VALUES (
        1,
        ${foreignKeyViolation ? 999 : 1}
      );
    `);
  } finally {
    db.close();
  }
}

function fileSha256(filePath) {
  return createHash("sha256")
    .update(readFileSync(filePath))
    .digest("hex");
}

function validEnvironment(origin) {
  const passwordHash = [
    "scrypt",
    "16384",
    "8",
    "1",
    Buffer.alloc(16, 1).toString("base64url"),
    Buffer.alloc(64, 2).toString("base64url"),
  ].join("$");
  const sessionValue = Buffer.alloc(32, 3).toString("base64url");

  return {
    source: [
      "NODE_ENV=production",
      "AUTH_REQUIRED=true",
      "AUTH_ACCOUNT=fixture-owner",
      `AUTH_PASSWORD_HASH=${passwordHash}`,
      `AUTH_SESSION_SECRET=${sessionValue}`,
      "AUTH_COOKIE_SECURE=true",
      `CORS_ALLOWED_ORIGINS=${origin}`,
      "SOLUTION_WRITES_ENABLED=false",
      "",
    ].join("\n"),
    passwordHash,
    sessionValue,
  };
}

function validLegacyServiceSnapshot() {
  const projectRoot = "/opt/sentelligent-sales-workbench";
  const execStartByService = {
    "sentelligent-backend.service":
      `/usr/bin/node ${projectRoot}/backend/src/server.js`,
    "sentelligent-frontend.service":
      `/usr/bin/node ${projectRoot}/outputs/product-design-prototype/scripts/static-server.mjs serve`,
    "sentelligent-caddy.service":
      "/usr/bin/caddy run --config /etc/caddy/Caddyfile",
    "sentelligent-weixin-agent.service":
      `/usr/bin/node ${projectRoot}/backend/src/weixin/worker.js start`,
  };
  return {
    snapshotGeneratedAt: new Date().toISOString(),
    hostname: "sentelligent-production-01",
    projectPaths: [
      { path: projectRoot, approved: true },
      { path: `${projectRoot}/current`, approved: true },
      { path: `${projectRoot}/releases/2026-07-19`, approved: true },
      { path: "/etc/caddy/Caddyfile", approved: true },
    ],
    projectServices: requiredProjectServices.map((name) => ({
      name,
      enabled: true,
      active: true,
      FragmentPath: `/etc/systemd/system/${name}`,
      ExecStart: execStartByService[name],
      User: "sentelligent",
      WorkingDirectory: projectRoot,
    })),
    unrelatedServices: [
      {
        name: "account-vault.service",
        protectionId: "account-vault",
        protected: true,
        active: true,
      },
      {
        name: "qingyang.service",
        protectionId: "qingyang",
        protected: true,
        active: true,
      },
      {
        name: "proxy.service",
        protectionId: "proxy",
        protected: true,
        active: true,
      },
    ],
    protectedObjects: ["account-vault", "qingyang", "proxy"],
    listeners: [
      { port: 4876, owner: "account-vault", protected: true },
      { port: 8797, owner: "qingyang", protected: true },
    ],
    plannedActions: requiredProjectServices.map((service) => ({
      action: "restart",
      service,
    })),
    plannedCommands: requiredProjectServices.map(
      (service) => `systemctl restart ${service}`,
    ),
  };
}

function validCentos7ServiceSnapshot() {
  const projectRoot = "/opt/sentelligent-sales-workbench";
  const plan = validLegacyServiceSnapshot();
  const serviceByName = new Map(
    plan.projectServices.map((service) => [service.name, service]),
  );

  Object.assign(serviceByName.get("sentelligent-backend.service"), {
    ExecStart: `/usr/local/bin/node ${projectRoot}/backend/src/server.js`,
    User: "sentzx",
    WorkingDirectory: `${projectRoot}/backend`,
  });
  Object.assign(serviceByName.get("sentelligent-frontend.service"), {
    ExecStart: [
      "/usr/local/bin/node",
      `${projectRoot}/frontend/scripts/static-server.mjs`,
      "serve",
      "--host=0.0.0.0",
      "--port=8088",
      `--dist-path=${projectRoot}/frontend/dist`,
      "--api-base-url=https://82.156.210.199",
    ].join(" "),
    User: "sentzx",
    WorkingDirectory: `${projectRoot}/frontend`,
  });
  Object.assign(serviceByName.get("sentelligent-caddy.service"), {
    ExecStart:
      "/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
    User: "caddy",
    WorkingDirectory: "",
  });
  Object.assign(serviceByName.get("sentelligent-weixin-agent.service"), {
    ExecStart: `/usr/local/bin/node ${projectRoot}/backend/src/weixin/worker.js start`,
    User: "sentzx",
    WorkingDirectory: `${projectRoot}/backend`,
  });
  plan.plannedActions = plan.plannedActions.filter(
    ({ service }) => service !== "sentelligent-caddy.service",
  );
  plan.plannedCommands = plan.plannedCommands.filter(
    (command) => !command.endsWith(" sentelligent-caddy.service"),
  );
  return plan;
}

function makeReleaseFixture({ commit = expectedReleaseCommit } = {}) {
  const workspace = makeWorkspace();
  const releaseDirectoryPath = join(workspace.root, "release");
  const contents = new Map([
    ["README.md", Buffer.from("# Release fixture\n", "utf8")],
    [
      "backend/src/server.js",
      Buffer.from("export const serverReady = true;\n", "utf8"),
    ],
    [
      "backend/src/weixin/worker.js",
      Buffer.from("export const workerReady = true;\n", "utf8"),
    ],
    [
      "backend/src/db/migrations/0001_baseline.sql",
      Buffer.from("CREATE TABLE fixture (id TEXT PRIMARY KEY);\n", "utf8"),
    ],
    [
      "outputs/product-design-prototype/scripts/static-server.mjs",
      Buffer.from("export const staticServerReady = true;\n", "utf8"),
    ],
    [
      "outputs/product-design-prototype/dist/index.html",
      Buffer.from("<main>release fixture</main>\n", "utf8"),
    ],
  ]);
  const files = [...contents.keys()];
  for (const [relativePath, content] of contents) {
    workspace.write(`release/${relativePath}`, content);
  }
  const manifest = buildReleaseManifest({
    source: { commit, clean: true },
    createdAt: "2026-07-29T08:00:00.000Z",
    files,
    contentByPath: contents,
    rootDirectory: `sentelligent-sales-workbench-${commit.slice(0, 12)}`,
  });
  workspace.write(
    "release/release-manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    manifest,
    manifestPath: `${immutableReleaseRoot}/release-manifest.json`,
    releaseDirectoryPath,
    filePath(relativePath) {
      return join(releaseDirectoryPath, ...relativePath.split("/"));
    },
    cleanup: workspace.cleanup,
  };
}

function validImmutableReleaseSnapshot(
  releaseRoot = immutableReleaseRoot,
) {
  const plan = validLegacyServiceSnapshot();
  const serviceByName = new Map(
    plan.projectServices.map((service) => [service.name, service]),
  );
  Object.assign(serviceByName.get("sentelligent-backend.service"), {
    ExecStart: `${projectNodeExecutable} ${releaseRoot}/backend/src/server.js`,
    WorkingDirectory: `${releaseRoot}/backend`,
  });
  Object.assign(serviceByName.get("sentelligent-frontend.service"), {
    ExecStart:
      `${projectNodeExecutable} ${releaseRoot}/outputs/product-design-prototype/scripts/static-server.mjs serve`,
    WorkingDirectory: `${releaseRoot}/outputs/product-design-prototype`,
  });
  Object.assign(serviceByName.get("sentelligent-weixin-agent.service"), {
    ExecStart: `${projectNodeExecutable} ${releaseRoot}/backend/src/weixin/worker.js start`,
    WorkingDirectory: `${releaseRoot}/backend`,
  });
  plan.projectPaths = [
    ...plan.projectPaths.filter(
      ({ path }) => !path.startsWith(
        "/opt/sentelligent-sales-workbench/releases/",
      ),
    ),
    { path: releaseRoot, approved: true },
  ];
  return plan;
}

async function loadPreflightModule() {
  try {
    return await import("./production-preflight.mjs");
  } catch (error) {
    assert.fail(`production-preflight.mjs must be implemented: ${error.message}`);
  }
}

describe("production preflight", () => {
  it("keeps all 18 legacy core checks compatible while failing a release without identity evidence", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const environment = validEnvironment(origin);
      const envFile = workspace.write("production.env", environment.source);
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(validLegacyServiceSnapshot(), null, 2),
      );
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);
      const writer = new DatabaseSync(databasePath);
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer.exec("INSERT INTO parents (id) VALUES (2)");
      assert.ok(existsSync(`${databasePath}-wal`));

      let report;
      try {
        const { runProductionPreflight } = await loadPreflightModule();
        assert.equal(typeof runProductionPreflight, "function");
        report = await runProductionPreflight({
          envFile,
          databasePath,
          backupPath,
          expectedBackupSha256: fileSha256(backupPath),
          expectedOrigins: [origin],
          servicePlanPath,
          nodeVersion: "24.14.1",
        });
      } finally {
        writer.close();
      }

      assert.equal(report.status, "failed");
      assert.equal(report.summary.total, 19);
      assert.equal(report.summary.passed, 18);
      assert.equal(report.summary.failed, 1);
      assert.equal(
        report.checks.find((check) => check.id === "release.identity")?.status,
        "failed",
      );
      assert.ok(
        report.checks
          .filter((check) => check.id !== "release.identity")
          .every((check) => check.status === "passed"),
      );
      for (const id of [
        "node.version",
        "env.production",
        "env.authHash",
        "env.sessionSecret",
        "env.secureCookie",
        "env.cors",
        "env.solutionWrites",
        "database.quickCheck",
        "database.foreignKeys",
        "backup.sha256",
        "backup.identity",
        "backup.quickCheck",
        "backup.foreignKeys",
        "services.project",
        "services.snapshot",
        "services.commands",
        "services.unrelatedProtection",
      ]) {
        assert.ok(report.checks.some((check) => check.id === id), `missing ${id}`);
      }

      const serialized = JSON.stringify(report);
      assert.ok(!serialized.includes(environment.passwordHash));
      assert.ok(!serialized.includes(environment.sessionValue));
    } finally {
      workspace.cleanup();
    }
  });

  it("accepts the exact current CentOS 7 service snapshot without targeting shared Caddy", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://82.156.210.199";
      const environment = validEnvironment(origin);
      const envFile = workspace.write("production.env", environment.source);
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(validCentos7ServiceSnapshot(), null, 2),
      );
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);

      const { runProductionPreflight } = await loadPreflightModule();
      const report = await runProductionPreflight({
        envFile,
        databasePath,
        backupPath,
        expectedBackupSha256: fileSha256(backupPath),
        expectedOrigins: [origin],
        servicePlanPath,
        nodeVersion: "24.18.0",
      });

      assert.equal(report.status, "failed");
      assert.deepEqual(
        report.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.id),
        ["release.identity"],
      );
      assert.equal(
        report.checks.find((check) => check.id === "services.project")?.status,
        "passed",
      );
      assert.equal(
        report.checks.find((check) => check.id === "services.commands")?.status,
        "passed",
      );

      for (const [name, execStart] of [
        [
          "exact",
          "/usr/local/bin/caddy run --config /etc/caddy/Caddyfile",
        ],
        [
          "whitespace-variant",
          "/usr/local/bin/caddy  run --config /etc/caddy/Caddyfile",
        ],
        [
          "portable-binary-variant",
          "/usr/bin/caddy run --config /etc/caddy/Caddyfile",
        ],
      ]) {
        const unsafeSharedCaddyPlan = validCentos7ServiceSnapshot();
        unsafeSharedCaddyPlan.projectServices.find(
          (service) => service.name === "sentelligent-caddy.service",
        ).ExecStart = execStart;
        unsafeSharedCaddyPlan.plannedActions.push({
          action: "restart",
          service: "sentelligent-caddy.service",
        });
        unsafeSharedCaddyPlan.plannedCommands.push(
          "systemctl restart sentelligent-caddy.service",
        );
        const unsafeSharedCaddyPlanPath = workspace.write(
          `unsafe-shared-caddy-${name}-plan.json`,
          JSON.stringify(unsafeSharedCaddyPlan, null, 2),
        );
        const unsafeSharedCaddyReport = await runProductionPreflight({
          envFile,
          databasePath,
          backupPath,
          expectedBackupSha256: fileSha256(backupPath),
          expectedOrigins: [origin],
          servicePlanPath: unsafeSharedCaddyPlanPath,
          nodeVersion: "24.18.0",
        });
        assert.equal(unsafeSharedCaddyReport.status, "failed");
        assert.equal(
          unsafeSharedCaddyReport.checks.find(
            (check) => check.id === "services.commands",
          )?.status,
          "failed",
        );
      }
    } finally {
      workspace.cleanup();
    }
  });

  it("binds a parseable manifest and exact 40-character commit to one immutable release", async () => {
    const fixture = makeReleaseFixture();
    try {
      const { validateReleaseIdentity } = await loadPreflightModule();
      assert.equal(typeof validateReleaseIdentity, "function");
      const servicePlan = validImmutableReleaseSnapshot();

      const result = validateReleaseIdentity({
        manifest: fixture.manifest,
        manifestPath: fixture.manifestPath,
        releaseDirectoryPath: fixture.releaseDirectoryPath,
        expectedCommit: expectedReleaseCommit,
        servicePlan,
      });

      assert.equal(result.valid, true, result.message);
      assert.deepEqual(result.details, {
        commit: expectedReleaseCommit,
        releasePath: immutableReleaseRoot,
      });

      const caddy = servicePlan.projectServices.find(
        (service) => service.name === "sentelligent-caddy.service",
      );
      caddy.ExecStart =
        "/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile";
      caddy.WorkingDirectory = "/srv/shared-caddy";
      assert.equal(
        validateReleaseIdentity({
          manifest: fixture.manifest,
          manifestPath: fixture.manifestPath,
          releaseDirectoryPath: fixture.releaseDirectoryPath,
          expectedCommit: expectedReleaseCommit,
          servicePlan,
        }).valid,
        true,
        "shared Caddy must not participate in immutable release path binding",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a fake manifest that contains only source.commit", async () => {
    const fixture = makeReleaseFixture();
    try {
      const { validateReleaseIdentity } = await loadPreflightModule();
      const result = validateReleaseIdentity({
        manifest: { source: { commit: expectedReleaseCommit } },
        manifestPath: fixture.manifestPath,
        releaseDirectoryPath: fixture.releaseDirectoryPath,
        expectedCommit: expectedReleaseCommit,
        servicePlan: validImmutableReleaseSnapshot(),
      });

      assert.equal(result.valid, false, result.message);
    } finally {
      fixture.cleanup();
    }
  });

  for (const [field, invalidValue] of [
    ["schemaVersion", 1],
    ["product", "another-product"],
  ]) {
    it(`rejects a release manifest with an invalid ${field}`, async () => {
      const fixture = makeReleaseFixture();
      try {
        const { validateReleaseIdentity } = await loadPreflightModule();
        const manifest = structuredClone(fixture.manifest);
        manifest[field] = invalidValue;
        const result = validateReleaseIdentity({
          manifest,
          manifestPath: fixture.manifestPath,
          releaseDirectoryPath: fixture.releaseDirectoryPath,
          expectedCommit: expectedReleaseCommit,
          servicePlan: validImmutableReleaseSnapshot(),
        });

        assert.equal(result.valid, false, result.message);
      } finally {
        fixture.cleanup();
      }
    });
  }

  for (const [category, relativePath] of [
    ["dist", "outputs/product-design-prototype/dist/index.html"],
    ["source", "backend/src/server.js"],
    ["migration", "backend/src/db/migrations/0001_baseline.sql"],
  ]) {
    for (const operation of ["tampered", "missing"]) {
      it(`rejects a ${operation} ${category} file in the release directory`, async () => {
        const fixture = makeReleaseFixture();
        try {
          const { validateReleaseIdentity } = await loadPreflightModule();
          const targetPath = fixture.filePath(relativePath);
          if (operation === "tampered") {
            writeFileSync(targetPath, "tampered release content\n");
          } else {
            rmSync(targetPath);
          }
          const result = validateReleaseIdentity({
            manifest: fixture.manifest,
            manifestPath: fixture.manifestPath,
            releaseDirectoryPath: fixture.releaseDirectoryPath,
            expectedCommit: expectedReleaseCommit,
            servicePlan: validImmutableReleaseSnapshot(),
          });

          assert.equal(result.valid, false, result.message);
        } finally {
          fixture.cleanup();
        }
      });
    }
  }

  it("requires every application service WorkingDirectory to exactly match the same immutable release", async () => {
    const fixture = makeReleaseFixture();
    try {
      const { validateReleaseIdentity } = await loadPreflightModule();
      const cases = [
        ["sentelligent-backend.service", immutableReleaseRoot],
        [
          "sentelligent-frontend.service",
          `${immutableReleaseRoot}/outputs`,
        ],
        [
          "sentelligent-weixin-agent.service",
          "/opt/sentelligent-sales-workbench/releases/2026-07-28_old/backend",
        ],
      ];

      for (const [serviceName, workingDirectory] of cases) {
        const servicePlan = validImmutableReleaseSnapshot();
        servicePlan.projectServices.find(
          (service) => service.name === serviceName,
        ).WorkingDirectory = workingDirectory;

        assert.equal(
          validateReleaseIdentity({
            manifest: fixture.manifest,
            manifestPath: fixture.manifestPath,
            releaseDirectoryPath: fixture.releaseDirectoryPath,
            expectedCommit: expectedReleaseCommit,
            servicePlan,
          }).valid,
          false,
          `${serviceName} must reject WorkingDirectory=${workingDirectory}`,
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("requires the project Node 24 executable for every immutable application service", async () => {
    const fixture = makeReleaseFixture();
    try {
      const { validateReleaseIdentity } = await loadPreflightModule();
      const applicationServices = [
        "sentelligent-backend.service",
        "sentelligent-frontend.service",
        "sentelligent-weixin-agent.service",
      ];

      for (const serviceName of applicationServices) {
        for (const executable of ["/usr/bin/node", "/usr/local/bin/node"]) {
          const servicePlan = validImmutableReleaseSnapshot();
          const service = servicePlan.projectServices.find(
            (candidate) => candidate.name === serviceName,
          );
          service.ExecStart = service.ExecStart.replace(
            projectNodeExecutable,
            executable,
          );

          assert.equal(
            validateReleaseIdentity({
              manifest: fixture.manifest,
              manifestPath: fixture.manifestPath,
              releaseDirectoryPath: fixture.releaseDirectoryPath,
              expectedCommit: expectedReleaseCommit,
              servicePlan,
            }).valid,
            false,
            `${serviceName} must reject ${executable}`,
          );
        }
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects malformed identity evidence, current paths, old releases, and mixed releases", async () => {
    const fixture = makeReleaseFixture();
    try {
      const { validateReleaseIdentity } = await loadPreflightModule();
      assert.equal(typeof validateReleaseIdentity, "function");
      const validInput = {
        manifest: fixture.manifest,
        manifestPath: fixture.manifestPath,
        releaseDirectoryPath: fixture.releaseDirectoryPath,
        expectedCommit: expectedReleaseCommit,
        servicePlan: validImmutableReleaseSnapshot(),
      };

      for (const [name, mutate] of [
        ["short expected commit", (input) => {
          input.expectedCommit = expectedReleaseCommit.slice(0, 12);
        }],
        ["uppercase expected commit", (input) => {
          input.expectedCommit = expectedReleaseCommit.toUpperCase();
        }],
        ["manifest commit mismatch", (input) => {
          input.manifest.source.commit = "f".repeat(40);
        }],
        ["manifest outside immutable release", (input) => {
          input.manifestPath =
            "/opt/sentelligent-sales-workbench/current/release-manifest.json";
        }],
        ["unsafe release id", (input) => {
          input.manifestPath =
            "/opt/sentelligent-sales-workbench/releases/../release-manifest.json";
        }],
        ["current backend", (input) => {
          input.servicePlan.projectServices.find(
            (service) => service.name === "sentelligent-backend.service",
          ).ExecStart =
            "/usr/bin/node /opt/sentelligent-sales-workbench/current/backend/src/server.js";
        }],
        ["old frontend release", (input) => {
          input.servicePlan.projectServices.find(
            (service) => service.name === "sentelligent-frontend.service",
          ).ExecStart =
            "/usr/bin/node /opt/sentelligent-sales-workbench/releases/2026-07-28_old/outputs/product-design-prototype/scripts/static-server.mjs serve";
        }],
        ["mixed WeChat release", (input) => {
          input.servicePlan.projectServices.find(
            (service) => service.name === "sentelligent-weixin-agent.service",
          ).ExecStart =
            "/usr/bin/node /opt/sentelligent-sales-workbench/releases/2026-07-29_other/backend/src/weixin/worker.js start";
        }],
      ]) {
        const input = structuredClone(validInput);
        mutate(input);
        assert.equal(
          validateReleaseIdentity(input).valid,
          false,
          `${name} must fail release.identity`,
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("fails release.identity when the manifest cannot be parsed", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const environment = validEnvironment(origin);
      const envFile = workspace.write("production.env", environment.source);
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(validImmutableReleaseSnapshot(), null, 2),
      );
      const releaseManifestPath = workspace.write(
        "release-manifest.json",
        "{not-json",
      );
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);
      const { runProductionPreflight } = await loadPreflightModule();

      const report = await runProductionPreflight({
        envFile,
        databasePath,
        backupPath,
        expectedBackupSha256: fileSha256(backupPath),
        expectedOrigins: [origin],
        servicePlanPath,
        releaseManifestPath,
        expectedCommit: expectedReleaseCommit,
        nodeVersion: "24.14.1",
      });

      assert.equal(report.status, "failed");
      assert.equal(
        report.checks.find((check) => check.id === "release.identity")?.status,
        "failed",
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("requires release manifest and expected commit CLI options", () => {
    const scriptPath = fileURLToPath(
      new URL("./production-preflight.mjs", import.meta.url),
    );
    const commonArguments = [
      scriptPath,
      "--env-file=production.env",
      "--database=production.sqlite",
      "--backup=production-backup.sqlite",
      `--backup-sha256=${"0".repeat(64)}`,
      "--expected-origin=https://sales.example.test",
      "--service-plan=service-plan.json",
    ];

    for (const [name, argumentsToAdd, expectedMessage] of [
      [
        "both options",
        [],
        "Missing required preflight option: releaseManifestPath",
      ],
      [
        "expected commit",
        ["--release-manifest=release-manifest.json"],
        "Missing required preflight option: expectedCommit",
      ],
    ]) {
      const result = spawnSync(process.execPath, [
        "--",
        ...commonArguments,
        ...argumentsToAdd,
      ], { encoding: "utf8" });
      assert.notEqual(result.status, 0, `${name} must fail closed`);
      assert.match(result.stderr, new RegExp(expectedMessage));
    }
  });

  it("fails closed for Node 22, unsafe auth/CORS, bad data, a hash mismatch, and broad service actions", async () => {
    const workspace = makeWorkspace();
    try {
      const envFile = workspace.write(
        "unsafe.env",
        [
          "NODE_ENV=development",
          "AUTH_REQUIRED=false",
          "AUTH_ACCOUNT=",
          "AUTH_PASSWORD=plaintext-fixture",
          "AUTH_PASSWORD_HASH=not-a-scrypt-hash",
          "AUTH_SESSION_SECRET=short",
          "AUTH_COOKIE_SECURE=false",
          "CORS_ALLOWED_ORIGINS=*",
          "SOLUTION_WRITES_ENABLED=true",
          "",
        ].join("\n"),
      );
      const databasePath = join(workspace.root, "invalid.sqlite");
      const backupPath = join(workspace.root, "backups", "invalid.sqlite");
      makeDatabase(databasePath, { foreignKeyViolation: true });
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);

      const servicePlan = validLegacyServiceSnapshot();
      servicePlan.projectServices = servicePlan.projectServices.slice(0, 2);
      servicePlan.unrelatedServices[0].protected = false;
      servicePlan.plannedActions.push({
        action: "restart",
        service: "account-vault.service",
      });
      servicePlan.plannedCommands.push("pkill node");
      const servicePlanPath = workspace.write(
        "unsafe-service-plan.json",
        JSON.stringify(servicePlan, null, 2),
      );

      const { runProductionPreflight } = await loadPreflightModule();
      const report = await runProductionPreflight({
        envFile,
        databasePath,
        backupPath,
        expectedBackupSha256: "0".repeat(64),
        expectedOrigins: ["https://sales.example.test"],
        servicePlanPath,
        nodeVersion: "22.21.1",
      });

      assert.equal(report.status, "failed");
      assert.ok(report.summary.failed >= 10);
      const failedIds = new Set(
        report.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.id),
      );
      for (const id of [
        "node.version",
        "env.production",
        "env.authHash",
        "env.sessionSecret",
        "env.secureCookie",
        "env.cors",
        "env.solutionWrites",
        "database.foreignKeys",
        "backup.sha256",
        "backup.foreignKeys",
        "services.project",
        "services.unrelatedProtection",
      ]) {
        assert.ok(failedIds.has(id), `${id} should fail`);
      }
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects a systemctl command that hides an unrelated service behind a project target", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const environment = validEnvironment(origin);
      const envFile = workspace.write("production.env", environment.source);
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);

      const servicePlan = validLegacyServiceSnapshot();
      servicePlan.plannedCommands = [
        "systemctl restart sentelligent-backend.service account-vault.service",
      ];
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(servicePlan, null, 2),
      );
      const { runProductionPreflight } = await loadPreflightModule();

      const report = await runProductionPreflight({
        envFile,
        databasePath,
        backupPath,
        expectedBackupSha256: fileSha256(backupPath),
        expectedOrigins: [origin],
        servicePlanPath,
        nodeVersion: "24.14.1",
      });

      assert.equal(report.status, "failed");
      assert.equal(
        report.checks.find(
          (check) => check.id === "services.commands",
        )?.status,
        "failed",
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects the primary database itself and a hard link as backup evidence", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const environment = validEnvironment(origin);
      const envFile = workspace.write("production.env", environment.source);
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(validLegacyServiceSnapshot(), null, 2),
      );
      makeDatabase(databasePath);
      const { runProductionPreflight } = await loadPreflightModule();

      for (const backupPath of [
        databasePath,
        join(workspace.root, "backups", "hard-link.sqlite"),
      ]) {
        if (backupPath !== databasePath) {
          mkdirSync(dirname(backupPath), { recursive: true });
          linkSync(databasePath, backupPath);
        }
        const report = await runProductionPreflight({
          envFile,
          databasePath,
          backupPath,
          expectedBackupSha256: fileSha256(backupPath),
          expectedOrigins: [origin],
          servicePlanPath,
          nodeVersion: "24.14.1",
        });
        assert.equal(report.status, "failed");
        assert.equal(
          report.checks.find((check) => check.id === "backup.identity")
            ?.status,
          "failed",
        );
      }
    } finally {
      workspace.cleanup();
    }
  });

  it("requires backups to be free of SQLite sidecars while allowing the live primary WAL", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const environment = validEnvironment(origin);
      const envFile = workspace.write("production.env", environment.source);
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(validLegacyServiceSnapshot(), null, 2),
      );
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);
      writeFileSync(`${backupPath}-wal`, "unexpected sidecar");

      const { runProductionPreflight } = await loadPreflightModule();
      const report = await runProductionPreflight({
        envFile,
        databasePath,
        backupPath,
        expectedBackupSha256: fileSha256(backupPath),
        expectedOrigins: [origin],
        servicePlanPath,
        nodeVersion: "24.14.1",
      });
      assert.equal(
        report.checks.find((check) => check.id === "backup.quickCheck")
          ?.status,
        "failed",
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("uses an exact systemctl allowlist and rejects command bypasses", async () => {
    const { validatePlannedCommands } = await loadPreflightModule();
    assert.equal(typeof validatePlannedCommands, "function");
    const service = "sentelligent-backend.service";

    for (const action of [
      "start",
      "stop",
      "restart",
      "enable",
      "status",
      "is-active",
      "is-enabled",
    ]) {
      assert.equal(
        validatePlannedCommands({
          plannedActions: [{ action, service }],
          plannedCommands: [`systemctl ${action} ${service}`],
        }),
        true,
        `${action} should be allowed for one project service`,
      );
    }

    for (const command of [
      `service ${service} restart`,
      `systemctl --user restart ${service}`,
      `systemctl restart ${service} sentelligent-frontend.service`,
      `systemctl restart ${service} && systemctl restart nginx.service`,
      `systemctl restart ${service}; true`,
      `systemctl restart ${service} | cat`,
      `sudo systemctl restart ${service}`,
      `systemctl disable ${service}`,
      "pkill node",
      "killall node",
      "docker compose down",
    ]) {
      assert.equal(
        validatePlannedCommands({
          plannedActions: [{ action: "restart", service }],
          plannedCommands: [command],
        }),
        false,
        `${command} must be rejected`,
      );
    }

    const shadowService = "sentelligent-shadow.service";
    assert.equal(
      validatePlannedCommands({
        projectServices: [
          ...requiredProjectServices.map((name) => ({ name })),
          { name: shadowService },
        ],
        plannedActions: [{ action: "restart", service: shadowService }],
        plannedCommands: [`systemctl restart ${shadowService}`],
      }),
      false,
      "a caller-added sentelligent service must not expand the command allowlist",
    );
  });

  it("accepts exact legacy pre-deployment and current/release post-deployment ExecStart snapshots while rejecting path lures", async () => {
    const { validateProjectServiceExecStart } = await loadPreflightModule();
    assert.equal(typeof validateProjectServiceExecStart, "function");
    const currentRoot = "/opt/sentelligent-sales-workbench/current";
    const releaseRoot =
      "/opt/sentelligent-sales-workbench/releases/2026-07-19_338fbf1";
    const backendEntry = `${currentRoot}/backend/src/server.js`;
    const frontendEntry =
      `${currentRoot}/outputs/product-design-prototype/scripts/static-server.mjs`;
    const weixinEntry = `${currentRoot}/backend/src/weixin/worker.js`;
    const projectNode =
      "/opt/sentelligent-sales-workbench/runtime/node-v24/bin/node";

    for (const [service, command] of [
      ["sentelligent-backend.service", `/usr/bin/node ${backendEntry}`],
      ["sentelligent-backend.service", `${projectNode} ${backendEntry}`],
      [
        "sentelligent-backend.service",
        "/usr/bin/node /opt/sentelligent-sales-workbench/backend/src/server.js",
      ],
      [
        "sentelligent-frontend.service",
        `/usr/bin/node ${releaseRoot}/outputs/product-design-prototype/scripts/static-server.mjs serve`,
      ],
      [
        "sentelligent-frontend.service",
        "/usr/bin/node /opt/sentelligent-sales-workbench/outputs/product-design-prototype/scripts/static-server.mjs serve",
      ],
      [
        "sentelligent-caddy.service",
        "/usr/bin/caddy run --config /etc/caddy/Caddyfile",
      ],
      [
        "sentelligent-caddy.service",
        "/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
      ],
      [
        "sentelligent-weixin-agent.service",
        `/usr/bin/node ${releaseRoot}/backend/src/weixin/worker.js start`,
      ],
      [
        "sentelligent-weixin-agent.service",
        `${projectNode} ${releaseRoot}/backend/src/weixin/worker.js start`,
      ],
      [
        "sentelligent-weixin-agent.service",
        "/usr/bin/node /opt/sentelligent-sales-workbench/backend/src/weixin/worker.js start",
      ],
    ]) {
      assert.equal(
        validateProjectServiceExecStart(service, command),
        true,
        `${service} should accept its fixed direct entry command`,
      );
    }

    for (const [service, command] of [
      [
        "sentelligent-backend.service",
        `/bin/sh -c /usr/bin/node ${backendEntry}`,
      ],
      [
        "sentelligent-backend.service",
        `/bin/bash /tmp/external-start.sh ${backendEntry}`,
      ],
      [
        "sentelligent-backend.service",
        `/usr/bin/node /tmp/external-start.mjs ${backendEntry}`,
      ],
      [
        "sentelligent-backend.service",
        `/usr/bin/node ${backendEntry} --inspect`,
      ],
      [
        "sentelligent-backend.service",
        "/usr/bin/node /opt/sentelligent-sales-workbench-backup/backend/src/server.js",
      ],
      [
        "sentelligent-backend.service",
        "/usr/bin/node /opt/sentelligent-sales-workbench/backend/src/server.js/child",
      ],
      [
        "sentelligent-backend.service",
        `/opt/sentelligent-sales-workbench/runtime/node-v24-copy/bin/node ${backendEntry}`,
      ],
      [
        "sentelligent-backend.service",
        `/usr/local/bin/node ${backendEntry}`,
      ],
      [
        "sentelligent-frontend.service",
        `/usr/bin/node ${frontendEntry}`,
      ],
      [
        "sentelligent-frontend.service",
        `/usr/local/bin/node ${frontendEntry} serve`,
      ],
      [
        "sentelligent-frontend.service",
        `/usr/bin/node ${frontendEntry} serve; /bin/true`,
      ],
      [
        "sentelligent-frontend.service",
        `powershell -File C:\\outside.ps1 ${frontendEntry}`,
      ],
      [
        "sentelligent-caddy.service",
        "/bin/bash -c /usr/bin/caddy run --config /etc/caddy/Caddyfile",
      ],
      [
        "sentelligent-caddy.service",
        "/usr/bin/caddy run --config /etc/caddy/Caddyfile --watch",
      ],
      [
        "sentelligent-caddy.service",
        "/usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter json",
      ],
      [
        "sentelligent-caddy.service",
        "/usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile --watch",
      ],
      [
        "sentelligent-caddy.service",
        "/usr/bin/caddy run --config /tmp/Caddyfile /etc/caddy/Caddyfile",
      ],
      [
        "sentelligent-weixin-agent.service",
        `/usr/bin/node ${weixinEntry} login-start`,
      ],
      [
        "sentelligent-weixin-agent.service",
        `systemctl start sentelligent-weixin-agent.service ${weixinEntry}`,
      ],
      [
        "sentelligent-weixin-agent.service",
        `cmd /c node ${weixinEntry} start`,
      ],
      [
        "sentelligent-weixin-agent.service",
        `/usr/bin/node ${weixinEntry} start && /bin/true`,
      ],
      [
        "sentelligent-weixin-agent.service",
        `/usr/local/bin/node ${releaseRoot}/backend/src/weixin/worker.js start`,
      ],
    ]) {
      assert.equal(
        validateProjectServiceExecStart(service, command),
        false,
        `${service} must reject ${command}`,
      );
    }
  });

  it("rejects expanded service ownership, caller paths, Caddy paths, and users", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const environment = validEnvironment(origin);
      const envFile = workspace.write("production.env", environment.source);
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);
      const { runProductionPreflight } = await loadPreflightModule();

      const cases = [
        {
          name: "extra-project-service",
          failedChecks: ["services.project"],
          mutate(plan) {
            plan.projectServices.push({
              name: "sentelligent-shadow.service",
              enabled: true,
              active: true,
              FragmentPath: "/etc/systemd/system/sentelligent-shadow.service",
              ExecStart:
                "/usr/bin/node /opt/sentelligent-sales-workbench/backend/src/server.js",
              User: "sentelligent",
              WorkingDirectory: "/opt/sentelligent-sales-workbench",
            });
          },
        },
        {
          name: "caller-expanded-project-path",
          failedChecks: ["services.snapshot", "services.project"],
          mutate(plan) {
            plan.projectPaths.push({
              path: "/opt/sentelligent-sales-workbench/caller-added",
              approved: true,
            });
          },
        },
        {
          name: "caller-expanded-caddy-path",
          failedChecks: ["services.snapshot", "services.project"],
          mutate(plan) {
            const caddyPathIndex = plan.projectPaths.findIndex(
              (entry) => entry.path === "/etc/caddy/Caddyfile",
            );
            plan.projectPaths[caddyPathIndex] = {
              path: "/etc/caddy/sites-enabled/sentelligent.caddy",
              approved: true,
            };
            const caddy = plan.projectServices.find(
              (service) => service.name === "sentelligent-caddy.service",
            );
            caddy.ExecStart =
              "/usr/bin/caddy run --config /etc/caddy/sites-enabled/sentelligent.caddy";
          },
        },
        {
          name: "unapproved-service-user",
          failedChecks: ["services.project"],
          mutate(plan) {
            plan.projectServices[0].User = "nobody";
          },
        },
        {
          name: "malformed-caddy-working-directory",
          failedChecks: ["services.project"],
          mutate(plan) {
            plan.projectServices.find(
              (service) => service.name === "sentelligent-caddy.service",
            ).WorkingDirectory = {};
          },
        },
      ];

      for (const testCase of cases) {
        const plan = validLegacyServiceSnapshot();
        testCase.mutate(plan);
        const servicePlanPath = workspace.write(
          `${testCase.name}.json`,
          JSON.stringify(plan, null, 2),
        );
        const report = await runProductionPreflight({
          envFile,
          databasePath,
          backupPath,
          expectedBackupSha256: fileSha256(backupPath),
          expectedOrigins: [origin],
          servicePlanPath,
          nodeVersion: "24.14.1",
        });
        for (const checkId of testCase.failedChecks) {
          assert.equal(
            report.checks.find((check) => check.id === checkId)?.status,
            "failed",
            `${testCase.name} must fail ${checkId}`,
          );
        }
      }
    } finally {
      workspace.cleanup();
    }
  });

  it("fails closed when database file identity metadata is unavailable", async () => {
    const { compareDatabaseIdentity } = await loadPreflightModule();
    assert.equal(typeof compareDatabaseIdentity, "function");

    for (const fileSystem of [
      {
        realpath: (filePath) => `/resolved/${filePath}`,
        stat: () => ({ dev: 0n, ino: 0n }),
      },
      {
        realpath: (filePath) => `/resolved/${filePath}`,
        stat: () => {
          throw new Error("identity unavailable");
        },
      },
    ]) {
      assert.deepEqual(
        compareDatabaseIdentity("primary.sqlite", "backup.sqlite", fileSystem),
        { distinct: false, verifiedBy: "unavailable" },
      );
    }
  });

  it("rejects a protected unrelated service that is not active", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const environment = validEnvironment(origin);
      const envFile = workspace.write("production.env", environment.source);
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);
      const plan = validLegacyServiceSnapshot();
      plan.unrelatedServices.find(
        (service) => service.protectionId === "account-vault",
      ).active = false;
      const servicePlanPath = workspace.write(
        "inactive-protected-service-plan.json",
        JSON.stringify(plan, null, 2),
      );
      const { runProductionPreflight } = await loadPreflightModule();

      const report = await runProductionPreflight({
        envFile,
        databasePath,
        backupPath,
        expectedBackupSha256: fileSha256(backupPath),
        expectedOrigins: [origin],
        servicePlanPath,
        nodeVersion: "24.14.1",
      });

      assert.equal(
        report.checks.find(
          (check) => check.id === "services.unrelatedProtection",
        )?.status,
        "failed",
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects incomplete service ownership and generic protection snapshots", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const environment = validEnvironment(origin);
      const envFile = workspace.write("production.env", environment.source);
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);
      const plan = validLegacyServiceSnapshot();
      delete plan.snapshotGeneratedAt;
      plan.hostname = "";
      plan.projectServices[0].ExecStart = "/usr/bin/node /opt/other/server.js";
      plan.projectServices[1].FragmentPath = "/tmp/frontend.service";
      plan.projectServices[2].User = "";
      plan.projectServices[3].WorkingDirectory = "/opt/other";
      plan.protectedObjects = ["anything"];
      plan.listeners = [{ port: 1234, owner: "anything", protected: true }];
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(plan, null, 2),
      );
      const { runProductionPreflight } = await loadPreflightModule();

      const report = await runProductionPreflight({
        envFile,
        databasePath,
        backupPath,
        expectedBackupSha256: fileSha256(backupPath),
        expectedOrigins: [origin],
        servicePlanPath,
        nodeVersion: "24.14.1",
      });
      const failed = new Set(
        report.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.id),
      );
      assert.ok(failed.has("services.snapshot"));
      assert.ok(failed.has("services.project"));
      assert.ok(failed.has("services.unrelatedProtection"));
    } finally {
      workspace.cleanup();
    }
  });
});
