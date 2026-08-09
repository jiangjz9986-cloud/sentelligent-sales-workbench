import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function validEnvironment(origin, databaseUrl) {
  assert.equal(typeof databaseUrl, "string");
  assert.ok(databaseUrl.length > 0);
  const passwordHash = [
    "scrypt",
    "16384",
    "8",
    "1",
    Buffer.alloc(16, 1).toString("base64url"),
    Buffer.alloc(64, 2).toString("base64url"),
  ].join("$");
  const sessionValue = Buffer.alloc(32, 3).toString("base64url");
  const modelApiKey = createHash("sha256")
    .update("fixture-model-api-key")
    .digest("hex");
  const weixinAgentApiToken = Buffer.alloc(32, 4).toString("base64url");
  const assistantConfirmationSecret = Buffer.alloc(32, 5).toString("base64url");
  const icostWebhookToken = createHash("sha256")
    .update("fixture-icost-webhook-token")
    .digest("hex");
  const icostWebhookOwner = "fixture-owner";
  const invoiceOcrCommand = "/opt/sentelligent-tools/tesseract-fixture";
  const invoicePdfTextCommand = "/opt/sentelligent-tools/pdftotext-fixture";
  const invoiceOcrLanguages = "chi_sim+eng";

  return {
    source: [
      "NODE_ENV=production",
      `DATABASE_URL=${databaseUrl}`,
      "AUTH_REQUIRED=true",
      `AUTH_ACCOUNT=${icostWebhookOwner}`,
      `AUTH_PASSWORD_HASH=${passwordHash}`,
      `AUTH_SESSION_SECRET=${sessionValue}`,
      "AUTH_COOKIE_SECURE=true",
      `CORS_ALLOWED_ORIGINS=${origin}`,
      "SOLUTION_WRITES_ENABLED=false",
      "AI_ANALYSIS_MODE=model",
      "MODEL_PROVIDER=deepseek",
      `MODEL_API_KEY=${modelApiKey}`,
      "MODEL_BASE_URL=https://api.deepseek.com",
      "MODEL_NAME=deepseek-v4-flash",
      "MODEL_TIMEOUT_MS=120000",
      `WEIXIN_AGENT_API_TOKEN=${weixinAgentApiToken}`,
      `ASSISTANT_CONFIRMATION_SECRET=${assistantConfirmationSecret}`,
      `ICOST_WEBHOOK_TOKEN=${icostWebhookToken}`,
      `ICOST_WEBHOOK_OWNER=${icostWebhookOwner}`,
      "ICOST_WEBHOOK_RATE_LIMIT=37",
      "ICOST_WEBHOOK_WINDOW_MS=271828",
      `INVOICE_OCR_COMMAND=${invoiceOcrCommand}`,
      `INVOICE_PDF_TEXT_COMMAND=${invoicePdfTextCommand}`,
      `INVOICE_OCR_LANGUAGES=${invoiceOcrLanguages}`,
      "INVOICE_TEXT_EXTRACTION_TIMEOUT_MS=45679",
      "",
    ].join("\n"),
    passwordHash,
    sessionValue,
    modelApiKey,
    weixinAgentApiToken,
    assistantConfirmationSecret,
    icostWebhookToken,
    icostWebhookOwner,
    invoiceOcrCommand,
    invoicePdfTextCommand,
    invoiceOcrLanguages,
  };
}

function hardenReleaseFixturePermissions(root) {
  if (process.platform === "win32") return;
  const visit = (directoryPath) => {
    chmodSync(directoryPath, 0o755);
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) chmodSync(entryPath, 0o644);
    }
  };
  visit(root);
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
    machineId: "0123456789abcdef0123456789abcdef",
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
      Group: "",
      SupplementaryGroups: [],
      DynamicUser: false,
      WorkingDirectory: projectRoot,
      ExecCondition: [],
      ExecStartPre: [],
      ExecStartPost: [],
      ExecStop: [],
      ExecReload:
        name === "sentelligent-caddy.service"
          ? [
              "/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force",
            ]
          : [],
      DropInPaths: [],
      Environment:
        name === "sentelligent-weixin-agent.service"
          ? [`HOME=${projectRoot}/weixin-session`]
          : name === "sentelligent-caddy.service"
            ? [
                "HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/etc/caddy",
              ]
            : [],
      EnvironmentFile:
        name === "sentelligent-frontend.service"
          ? `${projectRoot}/config/frontend.env`
          : name === "sentelligent-backend.service" ||
              name === "sentelligent-weixin-agent.service"
            ? `${projectRoot}/config/backend.env`
            : "",
      EnvironmentFiles:
        name === "sentelligent-frontend.service"
          ? [`${projectRoot}/config/frontend.env`]
          : name === "sentelligent-backend.service" ||
              name === "sentelligent-weixin-agent.service"
            ? [`${projectRoot}/config/backend.env`]
            : [],
      RootDirectory: "",
      RootImage: "",
      BindPaths: [],
      BindReadOnlyPaths: [],
      ReadWritePaths: [],
      ReadOnlyPaths: [],
      InaccessiblePaths: [],
      ExecPaths: [],
      NoExecPaths: [],
      TemporaryFileSystem: [],
      ProtectSystem: "no",
      ProtectHome: "no",
      PrivateTmp: name === "sentelligent-caddy.service" ? false : true,
      PrivateDevices: false,
    })),
    unrelatedServices: [
      {
        name: "codex-account-vault-cloud.service",
        protectionId: "account-vault",
        protected: true,
        active: true,
        enabled: true,
        mainPid: 4101,
        activeEnterTimestamp: "2026-08-07T00:00:01.000Z",
        FragmentPath: "/etc/systemd/system/codex-account-vault-cloud.service",
        UnitFileSha256: "1".repeat(64),
      },
      {
        name: "qingyang-store.service",
        protectionId: "qingyang",
        protected: true,
        active: true,
        enabled: true,
        mainPid: 4102,
        activeEnterTimestamp: "2026-08-07T00:00:02.000Z",
        FragmentPath: "/etc/systemd/system/qingyang-store.service",
        UnitFileSha256: "2".repeat(64),
      },
      {
        name: "codex-vault-mihomo.service",
        protectionId: "proxy",
        protected: true,
        active: true,
        enabled: true,
        mainPid: 4103,
        activeEnterTimestamp: "2026-08-07T00:00:03.000Z",
        FragmentPath: "/etc/systemd/system/codex-vault-mihomo.service",
        UnitFileSha256: "3".repeat(64),
      },
    ],
    protectedObjects: ["account-vault", "qingyang", "proxy"],
    listeners: [
      {
        port: 4876,
        owner: "account-vault",
        service: "codex-account-vault-cloud.service",
        mainPid: 4101,
        protected: true,
      },
      {
        port: 8797,
        owner: "qingyang",
        service: "qingyang-store.service",
        mainPid: 4102,
        protected: true,
      },
    ],
    plannedActions: requiredProjectServices
      .filter((service) => service !== "sentelligent-caddy.service")
      .map((service) => ({
      action: "restart",
      service,
    })),
    plannedCommands: requiredProjectServices
      .filter((service) => service !== "sentelligent-caddy.service")
      .map((service) => `systemctl restart ${service}`),
  };
}

function bindBackendEnvironment(plan, envFile) {
  const hash = fileSha256(envFile);
  for (const serviceName of [
    "sentelligent-backend.service",
    "sentelligent-weixin-agent.service",
  ]) {
    const service = plan.projectServices.find(({ name }) => name === serviceName);
    service.EnvironmentFile = envFile;
    service.EnvironmentFileSha256 = hash;
    service.EnvironmentFiles = [envFile];
  }
  return plan;
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
  const frontendLockfile = Buffer.from(
    `${JSON.stringify({
      name: "release-fixture-frontend",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "release-fixture-frontend" } },
    }, null, 2)}\n`,
    "utf8",
  );
  const backendLockfile = Buffer.from(
    `${JSON.stringify({
      name: "release-fixture-backend",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "release-fixture-backend",
          dependencies: { "production-only": "1.0.0" },
        },
        "node_modules/production-only": {
          version: "1.0.0",
          resolved: "https://registry.invalid/production-only-1.0.0.tgz",
          integrity: "sha512-cHJvZHVjdGlvbi1vbmx5",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
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
    ["backend/package-lock.json", backendLockfile],
    [
      "backend/node_modules/production-only/package.json",
      Buffer.from(
        '{"name":"production-only","version":"1.0.0"}\n',
        "utf8",
      ),
    ],
    [
      "backend/node_modules/production-only/index.js",
      Buffer.from("export const productionOnly = true;\n", "utf8"),
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
      "outputs/product-design-prototype/package-lock.json",
      frontendLockfile,
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
    buildProvenance: {
      frontend: {
        lockfile: {
          path: "outputs/product-design-prototype/package-lock.json",
          sha256: createHash("sha256").update(frontendLockfile).digest("hex"),
          lockfileVersion: 3,
        },
        runtime: {
          node: "v24.14.1",
          npm: "10.9.7",
          npmResolutionSource: "npm_execpath",
          platform: "linux",
          architecture: "x64",
        },
        install: {
          command: "npm ci",
          ignoreScripts: true,
          includeDev: true,
        },
        environment: {
          identity: "sentelligent-release-frontend-v1",
          allowedNames: [
            "NODE_ENV",
            "PATH",
            "SENTELLIGENT_RELEASE_BUILD_ENV",
          ],
        },
      },
      backend: {
        lockfile: {
          path: "backend/package-lock.json",
          sha256: createHash("sha256").update(backendLockfile).digest("hex"),
          lockfileVersion: 3,
        },
        runtime: {
          node: "v24.14.1",
          npm: "10.9.7",
          npmResolutionSource: "npm_execpath",
          platform: "linux",
          architecture: "x64",
        },
        install: {
          command: "npm ci",
          ignoreScripts: true,
          omitDev: true,
        },
      },
    },
  });
  workspace.write(
    "release/release-manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  hardenReleaseFixturePermissions(releaseDirectoryPath);
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

function makeLegacyReleaseFixture() {
  const fixture = makeReleaseFixture();
  const manifest = structuredClone(fixture.manifest);
  const packagedDependencyFiles = Object.keys(
    manifest.productionDependencyHashes?.files ?? {},
  );
  for (const dependencyFile of packagedDependencyFiles) {
    rmSync(fixture.filePath(dependencyFile), { force: true });
  }
  manifest.schemaVersion = 2;
  manifest.archive.packagedFiles -= packagedDependencyFiles.length;
  delete manifest.buildProvenance;
  delete manifest.productionDependencyHashes;
  writeFileSync(
    fixture.filePath("release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  hardenReleaseFixturePermissions(fixture.releaseDirectoryPath);
  return { ...fixture, manifest };
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
    const module = await import("./production-preflight.mjs");
    return {
      ...module,
      validateReleaseIdentity(options) {
        return module.validateReleaseIdentity({
          ...options,
          enforcePosix: options?.enforcePosix ?? false,
        });
      },
      runProductionPreflight(options) {
        const servicePlan = JSON.parse(
          readFileSync(options.servicePlanPath, "utf8"),
        );
        const fixtureHostIdentity = {
          hostname: servicePlan.hostname,
          machineId: servicePlan.machineId,
        };
        return module.runProductionPreflight({
          ...options,
          expectedHostIdentity:
            options?.expectedHostIdentity ?? fixtureHostIdentity,
          hostIdentityInspector:
            options?.hostIdentityInspector ?? (() => fixtureHostIdentity),
          invoiceToolInspector: options?.invoiceToolInspector ?? ((request) => {
            const ocrValid =
              request?.ocr?.command ===
                "/opt/sentelligent-tools/tesseract-fixture" &&
              Array.isArray(request?.ocr?.requiredLanguages) &&
              request.ocr.requiredLanguages.every((language) =>
                ["chi_sim", "eng"].includes(language),
              );
            const pdfValid =
              request?.pdfText?.command ===
              "/opt/sentelligent-tools/pdftotext-fixture";
            const userValid = ["root", "sentelligent", "sentzx"].includes(
              request?.backendService?.user,
            );
            return {
              serviceIdentityResolved: userValid,
              ocr: {
                regularFile: ocrValid,
                executableByServiceUser: ocrValid && userValid,
                identity: ocrValid ? "tesseract" : "unknown",
                requiredLanguagesAvailable: ocrValid,
              },
              pdfText: {
                regularFile: pdfValid,
                executableByServiceUser: pdfValid && userValid,
                identity: pdfValid ? "poppler-pdftotext" : "unknown",
              },
            };
          }),
        });
      },
    };
  } catch (error) {
    assert.fail(`production-preflight.mjs must be implemented: ${error.message}`);
  }
}

describe("production preflight", () => {
  it("accepts the hardened project unit execution surface without backend-env leakage", async () => {
    const { validateSystemdExecutionSurface } = await loadPreflightModule();
    const plan = validLegacyServiceSnapshot();
    const backend = plan.projectServices.find(
      ({ name }) => name === "sentelligent-backend.service",
    );
    const frontend = plan.projectServices.find(
      ({ name }) => name === "sentelligent-frontend.service",
    );
    const weixin = plan.projectServices.find(
      ({ name }) => name === "sentelligent-weixin-agent.service",
    );
    for (const service of [backend, frontend, weixin]) service.PrivateTmp = true;
    frontend.EnvironmentFile = "/opt/sentelligent-sales-workbench/config/frontend.env";
    frontend.EnvironmentFiles = [frontend.EnvironmentFile];
    backend.EnvironmentFile = "/opt/sentelligent-sales-workbench/config/backend.env";
    backend.EnvironmentFiles = [backend.EnvironmentFile];
    weixin.EnvironmentFile = backend.EnvironmentFile;
    weixin.EnvironmentFiles = [backend.EnvironmentFile];
    weixin.Environment = [
      "HOME=/opt/sentelligent-sales-workbench/weixin-session",
    ];

    assert.equal(validateSystemdExecutionSurface(backend), true);
    assert.equal(validateSystemdExecutionSurface(frontend), true);
    assert.equal(validateSystemdExecutionSurface(weixin), true);
  });

  it("accepts an explicitly pinned service primary group when probing invoice tools", async () => {
    const { inspectInvoiceExtractionTools } = await loadPreflightModule();
    const result = inspectInvoiceExtractionTools(
      {
        backendService: {
          user: "sentzx",
          group: "sentzx",
          supplementaryGroups: [],
          dynamicUser: false,
        },
        ocr: { command: "/usr/bin/tesseract", requiredLanguages: ["chi_sim", "eng"] },
        pdfText: { command: "/usr/bin/pdftotext" },
      },
      {
        inspectSecureExecutable: (path) => ({
          regularFile: true,
          secureOwnership: true,
          resolvedPath: path,
        }),
        runAsServiceUser: ({ command, args }) => {
          if (command === "/usr/bin/test") return { status: 0, stdout: "", stderr: "" };
          if (command === "/usr/bin/tesseract" && args?.[0] === "--version") {
            return { status: 0, stdout: "tesseract 3.04.00", stderr: "" };
          }
          if (command === "/usr/bin/tesseract" && args?.[0] === "--list-langs") {
            return { status: 0, stdout: "", stderr: "List of available languages (2):\neng\nchi_sim\n" };
          }
          if (command === "/usr/bin/pdftotext") {
            return { status: 0, stdout: "", stderr: "pdftotext version 0.26.5" };
          }
          return { status: 1, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(result.serviceIdentityResolved, true);
    assert.equal(result.ocr.requiredLanguagesAvailable, true);
    assert.equal(result.pdfText.identity, "poppler-pdftotext");
  });

  it("keeps all core checks compatible while failing a release without identity evidence", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(bindBackendEnvironment(validLegacyServiceSnapshot(), envFile), null, 2),
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
      assert.equal(report.summary.total, 25);
      assert.equal(report.summary.passed, 24);
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
        "env.assistantSecrets",
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
      for (const value of [
        environment.passwordHash,
        environment.sessionValue,
        environment.modelApiKey,
        environment.weixinAgentApiToken,
        environment.icostWebhookToken,
        environment.icostWebhookOwner,
        environment.invoiceOcrCommand,
        environment.invoicePdfTextCommand,
        environment.invoiceOcrLanguages,
      ]) {
        assert.ok(!serialized.includes(value), "preflight report must not expose environment values");
      }
    } finally {
      workspace.cleanup();
    }
  });

  it("fails closed when DATABASE_URL or service EnvironmentFile evidence targets another production state", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const otherDatabasePath = join(workspace.root, "other.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      makeDatabase(databasePath);
      makeDatabase(otherDatabasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);
      const environment = validEnvironment(origin, databasePath);
      const { runProductionPreflight } = await loadPreflightModule();

      const cases = [
        {
          name: "missing-database-url",
          source: environment.source.replace(/^DATABASE_URL=.*\n/m, ""),
          mutatePlan() {},
        },
        {
          name: "different-database-url",
          source: environment.source.replace(
            /^DATABASE_URL=.*$/m,
            `DATABASE_URL=${otherDatabasePath}`,
          ),
          mutatePlan() {},
        },
        {
          name: "different-environment-path",
          source: environment.source,
          mutatePlan(plan, envFile) {
            const otherEnvFile = workspace.write("other-production.env", readFileSync(envFile));
            for (const serviceName of [
              "sentelligent-backend.service",
              "sentelligent-weixin-agent.service",
            ]) {
              plan.projectServices.find(({ name }) => name === serviceName).EnvironmentFile = otherEnvFile;
            }
          },
        },
        {
          name: "different-environment-hash",
          source: environment.source,
          mutatePlan(plan) {
            plan.projectServices.find(
              ({ name }) => name === "sentelligent-backend.service",
            ).EnvironmentFileSha256 = "0".repeat(64);
          },
        },
      ];

      for (const testCase of cases) {
        const envFile = workspace.write(`${testCase.name}.env`, testCase.source);
        const plan = bindBackendEnvironment(validLegacyServiceSnapshot(), envFile);
        testCase.mutatePlan(plan, envFile);
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
        assert.equal(
          report.checks.find(({ id }) => id === "database.environmentBinding")?.status,
          "failed",
          testCase.name,
        );
        assert.equal(
          report.checks.find(({ id }) => id === "database.quickCheck")?.status,
          "passed",
          `${testCase.name} must still inspect the requested database`,
        );
      }
    } finally {
      workspace.cleanup();
    }
  });

  it("fails closed for missing, malformed, cross-owner, or reused iCost and invoice extraction settings", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);

      const cases = [
        ["short iCost token", "ICOST_WEBHOOK_TOKEN", "short", "env.icostWebhook"],
        ["cross-owner binding", "ICOST_WEBHOOK_OWNER", "another-owner", "env.icostWebhook"],
        ["zero iCost rate limit", "ICOST_WEBHOOK_RATE_LIMIT", "0", "env.icostWebhook"],
        ["fractional iCost window", "ICOST_WEBHOOK_WINDOW_MS", "1.5", "env.icostWebhook"],
        ["reused model token", "ICOST_WEBHOOK_TOKEN", environment.modelApiKey, "env.icostIsolation"],
        ["reused WeChat token", "ICOST_WEBHOOK_TOKEN", environment.weixinAgentApiToken, "env.icostIsolation"],
        ["missing OCR command", "INVOICE_OCR_COMMAND", "", "env.invoiceExtraction"],
        ["relative OCR path", "INVOICE_OCR_COMMAND", "../tesseract", "env.invoiceExtraction"],
        ["nonexistent OCR executable", "INVOICE_OCR_COMMAND", "/opt/sentelligent-tools/missing-tesseract", "env.invoiceExtraction"],
        ["PDF command with arguments", "INVOICE_PDF_TEXT_COMMAND", "/usr/bin/pdftotext --version", "env.invoiceExtraction"],
        ["invalid OCR languages", "INVOICE_OCR_LANGUAGES", "chi sim", "env.invoiceExtraction"],
        ["zero extraction timeout", "INVOICE_TEXT_EXTRACTION_TIMEOUT_MS", "0", "env.invoiceExtraction"],
      ];

      const { runProductionPreflight } = await loadPreflightModule();
      for (const [name, variable, value, failedCheck] of cases) {
        const source = environment.source.replace(
          new RegExp(`^${variable}=.*$`, "m"),
          `${variable}=${value}`,
        );
        const envFile = workspace.write(`unsafe-${variable}-${name}.env`, source);
        const servicePlanPath = workspace.write(
          `service-plan-${variable}-${name}.json`,
          JSON.stringify(bindBackendEnvironment(validLegacyServiceSnapshot(), envFile), null, 2),
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
        assert.equal(
          report.checks.find((check) => check.id === failedCheck)?.status,
          "failed",
          name,
        );
        assert.ok(
          !JSON.stringify(report).includes(environment.icostWebhookToken),
          `${name} must not expose the valid iCost token`,
        );
      }
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects legacy boolean-only invoice tool evidence for the backend service user", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(
          bindBackendEnvironment(validLegacyServiceSnapshot(), envFile),
          null,
          2,
        ),
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
        nodeVersion: "24.14.1",
        invoiceToolInspector: () => true,
      });
      assert.equal(
        report.checks.find(({ id }) => id === "env.invoiceExtraction")?.status,
        "failed",
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("accepts structured invoice capabilities bound to the backend service user", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(
          bindBackendEnvironment(validLegacyServiceSnapshot(), envFile),
          null,
          2,
        ),
      );
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);

      let inspectionRequest;
      const { runProductionPreflight } = await loadPreflightModule();
      const report = await runProductionPreflight({
        envFile,
        databasePath,
        backupPath,
        expectedBackupSha256: fileSha256(backupPath),
        expectedOrigins: [origin],
        servicePlanPath,
        nodeVersion: "24.14.1",
        invoiceToolInspector(request) {
          inspectionRequest = request;
          return {
            serviceIdentityResolved: true,
            ocr: {
              regularFile: true,
              executableByServiceUser: true,
              identity: "tesseract",
              requiredLanguagesAvailable: true,
            },
            pdfText: {
              regularFile: true,
              executableByServiceUser: true,
              identity: "poppler-pdftotext",
            },
          };
        },
      });
      assert.equal(
        report.checks.find(({ id }) => id === "env.invoiceExtraction")?.status,
        "passed",
      );
      assert.equal(inspectionRequest.backendService.user, "sentelligent");
      assert.deepEqual(inspectionRequest.ocr.requiredLanguages, ["chi_sim", "eng"]);
      assert.equal(inspectionRequest.ocr.command, environment.invoiceOcrCommand);
      assert.equal(
        inspectionRequest.pdfText.command,
        environment.invoicePdfTextCommand,
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("fails closed when the backend service identity snapshot omits group semantics", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const servicePlan = bindBackendEnvironment(
        validLegacyServiceSnapshot(),
        envFile,
      );
      const backend = servicePlan.projectServices.find(
        ({ name }) => name === "sentelligent-backend.service",
      );
      delete backend.Group;
      delete backend.SupplementaryGroups;
      delete backend.DynamicUser;
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(servicePlan, null, 2),
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
        nodeVersion: "24.14.1",
      });
      assert.equal(
        report.checks.find(({ id }) => id === "env.invoiceExtraction")?.status,
        "failed",
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("inspects exact invoice tool capabilities as the backend service user", async () => {
    const calls = [];
    const { inspectInvoiceExtractionTools } = await loadPreflightModule();
    assert.equal(typeof inspectInvoiceExtractionTools, "function");
    const evidence = inspectInvoiceExtractionTools(
      {
        backendService: {
          user: "sentelligent",
          group: "",
          supplementaryGroups: [],
          dynamicUser: false,
        },
        ocr: {
          command: "/usr/bin/tesseract",
          requiredLanguages: ["chi_sim", "eng"],
        },
        pdfText: {
          command: "/usr/bin/pdftotext",
        },
      },
      {
        inspectSecureExecutable(command) {
          return {
            regularFile: true,
            secureOwnership: true,
            resolvedPath: command,
          };
        },
        runAsServiceUser(call) {
          calls.push(call);
          if (call.command === "/usr/bin/test") {
            return { status: 0, stdout: "", stderr: "" };
          }
          if (call.command === "/usr/bin/tesseract" && call.args[0] === "--version") {
            return { status: 0, stdout: "tesseract 5.3.0\n", stderr: "" };
          }
          if (call.command === "/usr/bin/tesseract" && call.args[0] === "--list-langs") {
            return {
              status: 0,
              stdout: "List of available languages (2):\nchi_sim\neng\n",
              stderr: "",
            };
          }
          if (call.command === "/usr/bin/pdftotext" && call.args[0] === "-v") {
            return {
              status: 0,
              stdout: "",
              stderr: "pdftotext version 24.02.0\n",
            };
          }
          return { status: 1, stdout: "", stderr: "unexpected probe" };
        },
      },
    );

    assert.deepEqual(evidence, {
      serviceIdentityResolved: true,
      ocr: {
        regularFile: true,
        executableByServiceUser: true,
        identity: "tesseract",
        requiredLanguagesAvailable: true,
      },
      pdfText: {
        regularFile: true,
        executableByServiceUser: true,
        identity: "poppler-pdftotext",
      },
    });
    assert.ok(calls.length >= 5);
    assert.ok(calls.every(({ user }) => user === "sentelligent"));
    assert.ok(
      calls.some(
        ({ command, args }) =>
          command === "/usr/bin/test" &&
          args[0] === "-x" &&
          args[1] === "/usr/bin/tesseract",
      ),
    );
  });

  it("runs bounded invoice probes with runuser and a secret-free environment", async () => {
    const marker = "must-not-reach-invoice-tool";
    const sensitiveName = ["MODEL", "API", "KEY"].join("_");
    const originalValue = process.env[sensitiveName];
    process.env[sensitiveName] = marker;
    try {
      let captured;
      const { runToolAsServiceUser } = await loadPreflightModule();
      assert.equal(typeof runToolAsServiceUser, "function");
      const result = runToolAsServiceUser(
        {
          user: "sentelligent",
          command: "/usr/bin/tesseract",
          args: ["--version"],
        },
        {
          platform: "linux",
          currentUid: 0,
          resolveRunuser: () => "/usr/sbin/runuser",
          spawn(command, args, options) {
            captured = { command, args, options };
            return {
              status: 0,
              stdout: "tesseract 5.3.0\n",
              stderr: "",
            };
          },
        },
      );
      assert.equal(result.status, 0);
      assert.equal(captured.command, "/usr/sbin/runuser");
      assert.deepEqual(captured.args, [
        "-u",
        "sentelligent",
        "--",
        "/usr/bin/tesseract",
        "--version",
      ]);
      assert.equal(captured.options.shell, false);
      assert.equal(captured.options.timeout, 5_000);
      assert.equal(captured.options.killSignal, "SIGKILL");
      assert.equal(captured.options.maxBuffer, 64 * 1024);
      assert.equal(captured.options.cwd, "/");
      assert.deepEqual(captured.options.env, {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
      });
      assert.equal(JSON.stringify(captured).includes(marker), false);
    } finally {
      if (originalValue === undefined) delete process.env[sensitiveName];
      else process.env[sensitiveName] = originalValue;
    }
  });

  it("fails closed for root-only access, generic tools, and missing OCR languages", async () => {
    const { inspectInvoiceExtractionTools } = await loadPreflightModule();
    const request = {
      backendService: {
        user: "sentelligent",
        group: "",
        supplementaryGroups: [],
        dynamicUser: false,
      },
      ocr: {
        command: "/usr/bin/tesseract",
        requiredLanguages: ["chi_sim", "eng"],
      },
      pdfText: {
        command: "/usr/bin/pdftotext",
      },
    };
    const inspectSecureExecutable = (command) => ({
      regularFile: true,
      secureOwnership: true,
      resolvedPath: command,
    });
    const exactProbe = ({ command, args }) => {
      if (command === "/usr/bin/test") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "/usr/bin/tesseract" && args[0] === "--version") {
        return { status: 0, stdout: "tesseract 5.3.0\n", stderr: "" };
      }
      if (command === "/usr/bin/tesseract" && args[0] === "--list-langs") {
        return { status: 0, stdout: "chi_sim\neng\n", stderr: "" };
      }
      if (command === "/usr/bin/pdftotext" && args[0] === "-v") {
        return { status: 0, stdout: "", stderr: "pdftotext version 24.02.0\n" };
      }
      return { status: 1, stdout: "", stderr: "" };
    };

    const rootOnly = inspectInvoiceExtractionTools(request, {
      inspectSecureExecutable,
      runAsServiceUser(call) {
        if (
          call.command === "/usr/bin/test" &&
          call.args[1] === "/usr/bin/tesseract"
        ) {
          return { status: 1, stdout: "", stderr: "permission denied" };
        }
        return exactProbe(call);
      },
    });
    assert.equal(rootOnly.ocr.executableByServiceUser, false);

    const generic = inspectInvoiceExtractionTools(request, {
      inspectSecureExecutable,
      runAsServiceUser(call) {
        if (call.command === "/usr/bin/test") return exactProbe(call);
        return { status: 0, stdout: "fixture tool 1.0\n", stderr: "" };
      },
    });
    assert.equal(generic.ocr.identity, "unknown");
    assert.equal(generic.pdfText.identity, "unknown");

    const missingLanguage = inspectInvoiceExtractionTools(request, {
      inspectSecureExecutable,
      runAsServiceUser(call) {
        if (
          call.command === "/usr/bin/tesseract" &&
          call.args[0] === "--list-langs"
        ) {
          return { status: 0, stdout: "eng\n", stderr: "" };
        }
        return exactProbe(call);
      },
    });
    assert.equal(missingLanguage.ocr.requiredLanguagesAvailable, false);
  });

  it("fails closed unless production expense automation uses the approved model configuration and an isolated key", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);

      const cases = [
        ["mock analysis mode", "AI_ANALYSIS_MODE", "mock"],
        ["unexpected provider", "MODEL_PROVIDER", "another-provider"],
        ["unexpected model", "MODEL_NAME", "deepseek-chat"],
        ["unexpected model endpoint", "MODEL_BASE_URL", "https://example.test"],
        ["insecure model endpoint", "MODEL_BASE_URL", "http://api.deepseek.com"],
        ["zero model timeout", "MODEL_TIMEOUT_MS", "0"],
        ["missing model key", "MODEL_API_KEY", ""],
        ["model key reused from session", "MODEL_API_KEY", environment.sessionValue],
        ["model key reused from WeChat", "MODEL_API_KEY", environment.weixinAgentApiToken],
        ["model key reused from iCost", "MODEL_API_KEY", environment.icostWebhookToken],
      ];

      const { runProductionPreflight } = await loadPreflightModule();
      for (const [name, variable, value] of cases) {
        const source = environment.source.replace(
          new RegExp(`^${variable}=.*$`, "m"),
          `${variable}=${value}`,
        );
        const envFile = workspace.write(`unsafe-model-${name}.env`, source);
        const servicePlanPath = workspace.write(
          `service-plan-model-${name}.json`,
          JSON.stringify(bindBackendEnvironment(validLegacyServiceSnapshot(), envFile), null, 2),
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
        assert.equal(
          report.checks.find((check) => check.id === "env.aiModel")?.status,
          "failed",
          name,
        );
        assert.ok(
          !JSON.stringify(report).includes(environment.modelApiKey),
          `${name} must not expose the valid model key`,
        );
      }
    } finally {
      workspace.cleanup();
    }
  });

  it("accepts the exact current CentOS 7 service snapshot without targeting shared Caddy", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://82.156.210.199";
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(bindBackendEnvironment(validCentos7ServiceSnapshot(), envFile), null, 2),
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

  it("allows a legacy schema-2 manifest only for the pre-cutover current release", async () => {
    const fixture = makeLegacyReleaseFixture();
    try {
      const { validateReleaseIdentity } = await loadPreflightModule();
      const result = validateReleaseIdentity({
        manifest: fixture.manifest,
        manifestPath: fixture.manifestPath,
        releaseDirectoryPath: fixture.releaseDirectoryPath,
        expectedCommit: expectedReleaseCommit,
        servicePlan: validImmutableReleaseSnapshot(),
        enforcePosix: false,
        allowLegacyCurrent: true,
        currentReleasePath: immutableReleaseRoot,
      });
      assert.equal(result.valid, true, result.message);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects deployment-installed dependencies outside a legacy schema-2 archive inventory", async () => {
    const fixture = makeLegacyReleaseFixture();
    try {
      const installedDependencyPath = fixture.filePath(
        "backend/node_modules/post-install-only/index.js",
      );
      mkdirSync(dirname(installedDependencyPath), { recursive: true });
      writeFileSync(
        installedDependencyPath,
        "export const installedAfterPackaging = true;\n",
      );
      hardenReleaseFixturePermissions(fixture.releaseDirectoryPath);

      const { validateReleaseIdentity } = await loadPreflightModule();
      const result = validateReleaseIdentity({
        manifest: fixture.manifest,
        manifestPath: fixture.manifestPath,
        releaseDirectoryPath: fixture.releaseDirectoryPath,
        expectedCommit: expectedReleaseCommit,
        servicePlan: validImmutableReleaseSnapshot(),
        enforcePosix: false,
        allowLegacyCurrent: true,
        currentReleasePath: immutableReleaseRoot,
      });
      assert.equal(result.valid, false);
      assert.match(result.message, /file count|inventory/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects unhashed dependency files counted as part of a legacy schema-2 archive", async () => {
    const fixture = makeLegacyReleaseFixture();
    try {
      const unverifiedDependencyPath = fixture.filePath(
        "backend/node_modules/unverified/index.js",
      );
      mkdirSync(dirname(unverifiedDependencyPath), { recursive: true });
      writeFileSync(
        unverifiedDependencyPath,
        "export const unverifiedArchiveEntry = true;\n",
      );
      fixture.manifest.archive.packagedFiles += 1;
      hardenReleaseFixturePermissions(fixture.releaseDirectoryPath);

      const { validateReleaseIdentity } = await loadPreflightModule();
      const result = validateReleaseIdentity({
        manifest: fixture.manifest,
        manifestPath: fixture.manifestPath,
        releaseDirectoryPath: fixture.releaseDirectoryPath,
        expectedCommit: expectedReleaseCommit,
        servicePlan: validImmutableReleaseSnapshot(),
        enforcePosix: false,
        allowLegacyCurrent: true,
        currentReleasePath: immutableReleaseRoot,
      });
      assert.equal(result.valid, false);
      assert.match(result.message, /inventory|hash/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("never relaxes root ownership for a legacy current release", () => {
    const preflightSource = readFileSync(
      fileURLToPath(new URL("./production-preflight.mjs", import.meta.url)),
      "utf8",
    );
    const legacyVerifier = preflightSource.slice(
      preflightSource.indexOf("function verifyLegacyReleaseContents"),
      preflightSource.indexOf("export function validateReleaseIdentity"),
    );
    assert.ok(legacyVerifier.length > 0);
    assert.doesNotMatch(legacyVerifier, /allowLegacyOwnership/);
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

  it("rejects a release manifest without exact frontend build provenance", async () => {
    const fixture = makeReleaseFixture();
    try {
      const { validateReleaseIdentity } = await loadPreflightModule();
      const manifest = structuredClone(fixture.manifest);
      delete manifest.buildProvenance;
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

  it("rejects a release manifest that omits a required production integration setting", async () => {
    const fixture = makeReleaseFixture();
    try {
      const { validateReleaseIdentity } = await loadPreflightModule();
      const manifest = structuredClone(fixture.manifest);
      manifest.requiredEnvNames = manifest.requiredEnvNames.filter(
        (name) => name !== "ICOST_WEBHOOK_TOKEN",
      );
      const result = validateReleaseIdentity({
        manifest,
        manifestPath: fixture.manifestPath,
        releaseDirectoryPath: fixture.releaseDirectoryPath,
        expectedCommit: expectedReleaseCommit,
        servicePlan: validImmutableReleaseSnapshot(),
      });

      assert.equal(result.valid, false, result.message);
      assert.match(result.message, /required environment/i);
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
    ["production dependency", "backend/node_modules/production-only/index.js"],
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

  it("rejects an arbitrary addition to the backend production dependency tree", async () => {
    const fixture = makeReleaseFixture();
    try {
      fixture.filePath("backend/node_modules/injected/index.js");
      writeFileSync(
        fixture.filePath("backend/node_modules/production-only/injected.js"),
        "export const injected = true;\n",
      );
      const { validateReleaseIdentity } = await loadPreflightModule();
      const result = validateReleaseIdentity({
        manifest: fixture.manifest,
        manifestPath: fixture.manifestPath,
        releaseDirectoryPath: fixture.releaseDirectoryPath,
        expectedCommit: expectedReleaseCommit,
        servicePlan: validImmutableReleaseSnapshot(),
      });

      assert.equal(result.valid, false, result.message);
      assert.match(result.message, /dependency|inventory|release/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a manifest-matching release file that is hard linked outside the release", async () => {
    const fixture = makeReleaseFixture();
    try {
      const relativePath =
        "backend/node_modules/production-only/index.js";
      const targetPath = fixture.filePath(relativePath);
      const externalPath = join(dirname(fixture.releaseDirectoryPath), "linked-dependency.js");
      writeFileSync(externalPath, readFileSync(targetPath));
      rmSync(targetPath);
      linkSync(externalPath, targetPath);

      const { validateReleaseIdentity } = await loadPreflightModule();
      const result = validateReleaseIdentity({
        manifest: fixture.manifest,
        manifestPath: fixture.manifestPath,
        releaseDirectoryPath: fixture.releaseDirectoryPath,
        expectedCommit: expectedReleaseCommit,
        servicePlan: validImmutableReleaseSnapshot(),
      });
      assert.equal(result.valid, false, result.message);
      assert.match(result.message, /regular|hard link|release directory/i);
    } finally {
      fixture.cleanup();
    }
  });

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
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(bindBackendEnvironment(validImmutableReleaseSnapshot(), envFile), null, 2),
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

  it("requires release and explicit host identity CLI options", () => {
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
      [
        "expected hostname",
        [
          "--release-manifest=release-manifest.json",
          `--expected-commit=${expectedReleaseCommit}`,
        ],
        "Missing required preflight option: expectedHostname",
      ],
      [
        "expected machine id",
        [
          "--release-manifest=release-manifest.json",
          `--expected-commit=${expectedReleaseCommit}`,
          "--expected-hostname=sentelligent-production-01",
        ],
        "Missing required preflight option: expectedMachineId",
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
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);

      const servicePlan = bindBackendEnvironment(validLegacyServiceSnapshot(), envFile);
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
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(bindBackendEnvironment(validLegacyServiceSnapshot(), envFile), null, 2),
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
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      const servicePlanPath = workspace.write(
        "service-plan.json",
        JSON.stringify(bindBackendEnvironment(validLegacyServiceSnapshot(), envFile), null, 2),
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

    const caddyService = "sentelligent-caddy.service";
    for (const action of ["enable", "restart", "start", "stop"]) {
      for (const projectOwned of [false, true]) {
        assert.equal(
          validatePlannedCommands({
            projectServices: projectOwned
              ? [{
                  name: caddyService,
                  User: "sentelligent",
                  WorkingDirectory: "/opt/sentelligent-sales-workbench",
                  ExecStart: "/usr/bin/caddy run --config /etc/caddy/Caddyfile",
                }]
              : [],
            plannedActions: [{ action, service: caddyService }],
            plannedCommands: [`systemctl ${action} ${caddyService}`],
          }),
          false,
          `shared Caddy ${action} must remain read-only for every profile`,
        );
      }
    }
    for (const action of ["status", "is-active", "is-enabled"]) {
      assert.equal(
        validatePlannedCommands({
          plannedActions: [{ action, service: caddyService }],
          plannedCommands: [`systemctl ${action} ${caddyService}`],
        }),
        true,
        `shared Caddy ${action} should remain available for read-only verification`,
      );
    }
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
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
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
        const plan = bindBackendEnvironment(validLegacyServiceSnapshot(), envFile);
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

  it("reads security-sensitive files once and rejects hard links or identity changes", async () => {
    const workspace = makeWorkspace();
    try {
      const sourcePath = workspace.write("stable.env", "NODE_ENV=production\n");
      const hardLinkPath = join(workspace.root, "stable-hardlink.env");
      linkSync(sourcePath, hardLinkPath);
      const { readStableRegularFile } = await loadPreflightModule();
      assert.equal(typeof readStableRegularFile, "function");
      assert.throws(
        () => readStableRegularFile(sourcePath),
        /hard link|link count|single link/i,
      );

      rmSync(hardLinkPath);
      let fstatCalls = 0;
      assert.throws(
        () =>
          readStableRegularFile(sourcePath, {
            fileSystem: {
              fstat(fileDescriptor, options) {
                const metadata = fstatSync(fileDescriptor, options);
                fstatCalls += 1;
                if (fstatCalls === 2) {
                  return {
                    ...metadata,
                    size: metadata.size + 1n,
                  };
                }
                return metadata;
              },
            },
          }),
        /changed|identity|stable/i,
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("requires immutable release files to be root-owned, single-link, and runtime-read-only", async () => {
    const { validateImmutableReleaseEntryMetadata } =
      await loadPreflightModule();
    assert.equal(typeof validateImmutableReleaseEntryMetadata, "function");
    const fileMetadata = {
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: 0n,
      gid: 0n,
      mode: 0o100644n,
      nlink: 1n,
    };
    assert.equal(
      validateImmutableReleaseEntryMetadata(fileMetadata, {
        directory: false,
        enforcePosix: true,
      }),
      true,
    );
    for (const metadata of [
      { ...fileMetadata, uid: 1000n },
      { ...fileMetadata, gid: 1000n },
      { ...fileMetadata, mode: 0o100664n },
      { ...fileMetadata, nlink: 2n },
    ]) {
      assert.equal(
        validateImmutableReleaseEntryMetadata(metadata, {
          directory: false,
          enforcePosix: true,
        }),
        false,
      );
    }
  });

  it("rejects a valid SQLite primary that has another hard link", async () => {
    const workspace = makeWorkspace();
    try {
      const databasePath = join(workspace.root, "primary.sqlite");
      const hardLinkPath = join(workspace.root, "primary-alias.sqlite");
      makeDatabase(databasePath);
      linkSync(databasePath, hardLinkPath);
      const { inspectSqlite } = await loadPreflightModule();
      assert.equal(typeof inspectSqlite, "function");
      const inspection = await inspectSqlite(databasePath);
      assert.notEqual(inspection.quickCheck, "ok");
      assert.match(inspection.error, /hard link|link count|single link/i);
    } finally {
      workspace.cleanup();
    }
  });

  it("rejects a protected unrelated service that is not active", async () => {
    const workspace = makeWorkspace();
    try {
      const origin = "https://sales.example.test";
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);
      const plan = bindBackendEnvironment(validLegacyServiceSnapshot(), envFile);
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
      const databasePath = join(workspace.root, "sales-workbench.sqlite");
      const environment = validEnvironment(origin, databasePath);
      const envFile = workspace.write("production.env", environment.source);
      const backupPath = join(workspace.root, "backups", "sales-workbench.sqlite");
      makeDatabase(databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(databasePath, backupPath);
      const plan = bindBackendEnvironment(validLegacyServiceSnapshot(), envFile);
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

  it("rejects hidden systemd commands, drop-ins, environments, and path directives", async () => {
    const { validateProjectServices } = await loadPreflightModule();
    assert.equal(typeof validateProjectServices, "function");
    const validPlan = validImmutableReleaseSnapshot();
    assert.equal(validateProjectServices(validPlan), true);

    const cases = [
      ["ExecStartPost", ["/bin/sh -c injected"]],
      ["DropInPaths", ["/etc/systemd/system/service.d/override.conf"]],
      ["Environment", ["NODE_OPTIONS=--import=/tmp/injected.mjs"]],
      ["ReadWritePaths", ["/opt/sentelligent-sales-workbench/releases"]],
      ["RootDirectory", "/tmp/alternate-root"],
      ["PrivateDevices", true],
    ];
    for (const [field, value] of cases) {
      const plan = validImmutableReleaseSnapshot();
      plan.projectServices.find(
        ({ name }) => name === "sentelligent-backend.service",
      )[field] = value;
      assert.equal(
        validateProjectServices(plan),
        false,
        `${field} must be part of the exact systemd execution surface`,
      );
    }

    const frontendPlan = validImmutableReleaseSnapshot();
    frontendPlan.projectServices.find(
      ({ name }) => name === "sentelligent-frontend.service",
    ).EnvironmentFiles = ["/opt/sentelligent-sales-workbench/config/backend.env"];
    assert.equal(validateProjectServices(frontendPlan), false);

    const redirectedFrontendPlan = validImmutableReleaseSnapshot();
    const redirectedFrontend = redirectedFrontendPlan.projectServices.find(
      ({ name }) => name === "sentelligent-frontend.service",
    );
    redirectedFrontend.EnvironmentFile = "/tmp/config/frontend.env";
    redirectedFrontend.EnvironmentFiles = [redirectedFrontend.EnvironmentFile];
    assert.equal(validateProjectServices(redirectedFrontendPlan), false);
  });

  it("binds snapshots to the explicit host and exact protected service identities", async () => {
    const { validateServiceSnapshot, validatesUnrelatedProtection } =
      await loadPreflightModule();
    assert.equal(typeof validateServiceSnapshot, "function");
    assert.equal(typeof validatesUnrelatedProtection, "function");
    const plan = validImmutableReleaseSnapshot();
    const hostIdentity = {
      hostname: plan.hostname,
      machineId: plan.machineId,
    };
    assert.equal(
      validateServiceSnapshot(
        plan,
        new Date().toISOString(),
        hostIdentity,
        hostIdentity,
      ),
      true,
    );
    assert.equal(validatesUnrelatedProtection(plan), true);

    const wrongHost = structuredClone(plan);
    wrongHost.machineId = "f".repeat(32);
    assert.equal(
      validateServiceSnapshot(
        wrongHost,
        new Date().toISOString(),
        hostIdentity,
        hostIdentity,
      ),
      false,
    );

    for (const mutate of [
      (candidate) => {
        candidate.unrelatedServices[0].name = "account-vault.service";
      },
      (candidate) => {
        candidate.unrelatedServices[1].UnitFileSha256 = "";
      },
      (candidate) => {
        candidate.listeners[0].service = "qingyang-store.service";
      },
      (candidate) => {
        candidate.listeners[1].mainPid += 1;
      },
    ]) {
      const candidate = structuredClone(plan);
      mutate(candidate);
      assert.equal(validatesUnrelatedProtection(candidate), false);
    }
  });
});
