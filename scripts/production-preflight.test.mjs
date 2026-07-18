import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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

function validServicePlan() {
  return {
    projectServices: requiredProjectServices.map((name) => ({
      name,
      enabled: true,
      active: true,
    })),
    unrelatedServices: [
      { name: "account-vault.service", protected: true, active: true },
      { name: "qingyang.service", protected: true, active: true },
      { name: "proxy.service", protected: true, active: true },
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
  it("passes a complete offline production snapshot without exposing auth values", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const environment = validEnvironment(origin);
      const envFile = workspace.write("production.env", environment.source);
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(validServicePlan(), null, 2),
      );
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);

      const { runProductionPreflight } = await loadPreflightModule();
      assert.equal(typeof runProductionPreflight, "function");

      const report = await runProductionPreflight({
        envFile,
        databasePath,
        backupPath,
        expectedBackupSha256: fileSha256(backupPath),
        expectedOrigins: [origin],
        servicePlanPath,
        nodeVersion: "24.14.1",
      });

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
        "backup.quickCheck",
        "backup.foreignKeys",
        "services.project",
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

      const servicePlan = validServicePlan();
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

      const servicePlan = validServicePlan();
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
          (check) => check.id === "services.unrelatedProtection",
        )?.status,
        "failed",
      );
    } finally {
      workspace.cleanup();
    }
  });
});
