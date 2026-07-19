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
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const requiredProjectServices = [
  "sentelligent-backend.service",
  "sentelligent-frontend.service",
  "sentelligent-caddy.service",
  "sentelligent-weixin-agent.service",
];

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

async function loadPreflightModule() {
  try {
    return await import("./production-preflight.mjs");
  } catch (error) {
    assert.fail(`production-preflight.mjs must be implemented: ${error.message}`);
  }
}

describe("production preflight", () => {
  it("passes a current pre-deployment legacy service snapshot without exposing auth values", async () => {
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

      assert.equal(report.status, "passed");
      assert.equal(report.summary.failed, 0);
      assert.ok(report.checks.length >= 14);
      assert.ok(report.checks.every((check) => check.status === "passed"));
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

    for (const [service, command] of [
      ["sentelligent-backend.service", `/usr/bin/node ${backendEntry}`],
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
        "sentelligent-weixin-agent.service",
        `/usr/bin/node ${releaseRoot}/backend/src/weixin/worker.js start`,
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
        "sentelligent-frontend.service",
        `/usr/bin/node ${frontendEntry}`,
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
