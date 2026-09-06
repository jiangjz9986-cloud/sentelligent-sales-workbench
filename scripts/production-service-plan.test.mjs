import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  BACKEND_ENVIRONMENT_FILE,
  CADDY_CONFIG_PATH,
  CURRENT_RELEASE_PATH,
  FRONTEND_ENVIRONMENT_FILE,
  PROJECT_ROOT,
  PROJECT_SERVICES,
  PROTECTED_SERVICES,
  createProductionServicePlan,
  parseServicePlanArguments,
  runProductionServicePlanCli,
  writeServicePlanAtomic,
} from "./production-service-plan.mjs";
import {
  validatePlannedCommands,
  validateProjectServices,
  validateServiceSnapshot,
  validatesUnrelatedProtection,
} from "./production-preflight.mjs";

const RELEASE_ROOT =
  `${PROJECT_ROOT}/releases/v0.6.2-test_0123456789ab`;
const NODE_BIN = `${PROJECT_ROOT}/runtime/node-v24/bin/node`;
const HOSTNAME = "sentelligent-production-01";
const MACHINE_ID = "0123456789abcdef0123456789abcdef";
const FIXED_NOW = new Date("2026-08-22T02:00:00.000Z");
const REDACTION_MARKER = "must-not-escape-systemctl-memory";

const EMPTY_ARRAY_FIELDS = [
  "ExecCondition",
  "ExecStartPre",
  "ExecStartPost",
  "ExecStop",
  "DropInPaths",
  "BindPaths",
  "BindReadOnlyPaths",
  "ReadWritePaths",
  "ReadOnlyPaths",
  "InaccessiblePaths",
  "ExecPaths",
  "NoExecPaths",
  "TemporaryFileSystem",
];

const servicePid = {
  "sentelligent-backend.service": 3101,
  "sentelligent-frontend.service": 3102,
  "sentelligent-caddy.service": 3103,
  "sentelligent-weixin-agent.service": 3104,
  "qingyang-store.service": 4102,
};

const projectExecStart = {
  "sentelligent-backend.service":
    `${NODE_BIN} ${RELEASE_ROOT}/backend/src/server.js`,
  "sentelligent-frontend.service":
    `${NODE_BIN} ${RELEASE_ROOT}/outputs/product-design-prototype/scripts/static-server.mjs serve`,
  "sentelligent-caddy.service":
    "/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
  "sentelligent-weixin-agent.service":
    `${NODE_BIN} ${RELEASE_ROOT}/backend/src/weixin/worker.js start`,
};

const projectWorkingDirectory = {
  "sentelligent-backend.service": `${RELEASE_ROOT}/backend`,
  "sentelligent-frontend.service":
    `${RELEASE_ROOT}/outputs/product-design-prototype`,
  "sentelligent-caddy.service": "",
  "sentelligent-weixin-agent.service": `${RELEASE_ROOT}/backend`,
};

const projectUser = {
  "sentelligent-backend.service": "sentzx",
  "sentelligent-frontend.service": "sentzx",
  "sentelligent-caddy.service": "caddy",
  "sentelligent-weixin-agent.service": "sentzx",
};

function structuredCommand(command) {
  const executable = command.split(" ")[0];
  return `{ path=${executable} ; argv[]=${command} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
}

function serializeProperties(properties) {
  return `${Object.entries(properties)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

function projectServiceShow(serviceName) {
  const caddy = serviceName === "sentelligent-caddy.service";
  const weixin = serviceName === "sentelligent-weixin-agent.service";
  const environmentFile = caddy
    ? ""
    : serviceName === "sentelligent-frontend.service"
      ? FRONTEND_ENVIRONMENT_FILE
      : BACKEND_ENVIRONMENT_FILE;
  const properties = {
    Id: serviceName,
    FragmentPath: `/etc/systemd/system/${serviceName}`,
    ExecStart: structuredCommand(projectExecStart[serviceName]),
    ExecReload: caddy
      ? structuredCommand(
          "/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force",
        )
      : "",
    User: projectUser[serviceName],
    Group: "",
    SupplementaryGroups: "",
    DynamicUser: "no",
    WorkingDirectory: projectWorkingDirectory[serviceName],
    Environment: caddy
      ? "HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/etc/caddy"
      : weixin
        ? `HOME=${PROJECT_ROOT}/weixin-session`
        : "",
    EnvironmentFiles: environmentFile
      ? `${environmentFile} (ignore_errors=no)`
      : "",
    RootDirectory: "",
    RootImage: "",
    ProtectSystem: "no",
    ProtectHome: "no",
    PrivateTmp: caddy ? "no" : "yes",
    PrivateDevices: "no",
    MainPID: String(servicePid[serviceName]),
    ActiveEnterTimestamp: "Sat 2026-08-22 01:00:00 UTC",
    ...Object.fromEntries(EMPTY_ARRAY_FIELDS.map((field) => [field, ""])),
    OpaqueCredentialEvidence: REDACTION_MARKER,
  };
  return serializeProperties(properties);
}

function protectedServiceShow(serviceName) {
  return serializeProperties({
    Id: serviceName,
    FragmentPath: `/etc/systemd/system/${serviceName}`,
    MainPID: String(servicePid[serviceName]),
    ActiveEnterTimestamp: "2026-08-22T01:00:00.000Z",
    Environment: `IGNORED_VALUE=${REDACTION_MARKER}`,
  });
}

function listenerSnapshot({ qingyangPid = 4102 } = {}) {
  return [
    `LISTEN 0 128 127.0.0.1:8797 0.0.0.0:* users:(("node",pid=${qingyangPid},fd=21))`,
  ].join("\n");
}

function hashForPath(path) {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

function makeFixture({
  mutateShow,
  qingyangPid = 4102,
  mutateRunner,
} = {}) {
  const calls = [];
  const showCounts = new Map();
  const runner = (command, args) => {
    calls.push([command, [...args]]);
    let result;
    if (command === "systemctl" && args[0] === "is-active") result = "active\n";
    else if (command === "systemctl" && args[0] === "is-enabled") result = "enabled\n";
    else if (command === "systemctl" && args[0] === "show") {
      const serviceName = args[1];
      const count = (showCounts.get(serviceName) ?? 0) + 1;
      showCounts.set(serviceName, count);
      result = PROJECT_SERVICES.includes(serviceName)
        ? projectServiceShow(serviceName)
        : protectedServiceShow(serviceName);
      if (mutateShow) result = mutateShow({ serviceName, result, count });
    } else if (command === "ss" && args.join(" ") === "-H -ltnp") {
      result = listenerSnapshot({ qingyangPid });
    } else {
      throw new Error(`unexpected fixture command: ${command}`);
    }
    return mutateRunner
      ? mutateRunner({ command, args, result, calls, showCounts })
      : result;
  };

  return {
    calls,
    options: {
      runner,
      hostnameReader: () => HOSTNAME,
      machineIdReader: () => MACHINE_ID,
      hashFile: hashForPath,
      currentReleaseResolver: () => RELEASE_ROOT,
      now: () => new Date(FIXED_NOW),
    },
  };
}

function assertCompatiblePlan(plan) {
  const host = { hostname: HOSTNAME, machineId: MACHINE_ID };
  assert.equal(validateServiceSnapshot(plan, FIXED_NOW.toISOString(), host, host), true);
  assert.equal(validateProjectServices(plan), true);
  assert.equal(validatePlannedCommands(plan), true);
  assert.equal(validatesUnrelatedProtection(plan), true);
}

describe("production service-plan generator", () => {
  it("collects a stable allowlisted snapshot that passes the preflight validators", () => {
    const fixture = makeFixture();
    const evidenceOrder = [];
    const originalRunner = fixture.options.runner;
    fixture.options.runner = (command, args) => {
      if (command === "ss") evidenceOrder.push("snapshot");
      return originalRunner(command, args);
    };
    fixture.options.hashFile = (path) => {
      if (path === CADDY_CONFIG_PATH) evidenceOrder.push("hashes");
      return hashForPath(path);
    };
    const plan = createProductionServicePlan(fixture.options);

    assertCompatiblePlan(plan);
    assert.equal(plan.projectServices.length, 4);
    assert.equal(plan.unrelatedServices.length, 1);
    assert.equal(plan.listeners.length, 1);
    assert.deepEqual(plan.plannedCommands, [
      "systemctl restart sentelligent-backend.service",
      "systemctl restart sentelligent-frontend.service",
      "systemctl restart sentelligent-weixin-agent.service",
      "systemctl status sentelligent-caddy.service",
    ]);
    assert.deepEqual(plan.projectPaths, [
      { path: PROJECT_ROOT, approved: true },
      { path: CURRENT_RELEASE_PATH, approved: true },
      { path: RELEASE_ROOT, approved: true },
      { path: CADDY_CONFIG_PATH, approved: true },
    ]);
    assert.equal(
      plan.projectServices.find(
        ({ name }) => name === "sentelligent-backend.service",
      ).EnvironmentFileSha256,
      hashForPath(BACKEND_ENVIRONMENT_FILE),
    );
    assert.equal(plan.fileEvidence.caddyConfig.sha256, hashForPath(CADDY_CONFIG_PATH));
    assert.equal(JSON.stringify(plan).includes(REDACTION_MARKER), false);

    const showCalls = fixture.calls.filter(
      ([command, args]) => command === "systemctl" && args[0] === "show",
    );
    assert.equal(showCalls.length, 10);
    assert.ok(showCalls.every(([, args]) => args.length === 2));
    assert.equal(
      fixture.calls.filter(([command]) => command === "ss").length,
      2,
    );
    assert.deepEqual(evidenceOrder, ["snapshot", "hashes", "snapshot", "hashes"]);
  });

  it("fails closed and redacts an unexpected project Environment value", () => {
    const fixture = makeFixture({
      mutateShow: ({ serviceName, result }) =>
        serviceName === "sentelligent-backend.service"
          ? result.replace(
              "Environment=\n",
              `Environment=MODEL_API_KEY=${REDACTION_MARKER}\n`,
            )
          : result,
    });
    let observed;
    try {
      createProductionServicePlan(fixture.options);
    } catch (error) {
      observed = error;
    }
    assert.ok(observed instanceof Error);
    assert.match(observed.message, /environment surface/);
    assert.equal(observed.message.includes(REDACTION_MARKER), false);
  });

  it("fails closed on duplicate allowlisted systemd properties", () => {
    const fixture = makeFixture({
      mutateShow: ({ serviceName, result }) =>
        serviceName === "sentelligent-frontend.service"
          ? `${result}ExecStart=${REDACTION_MARKER}\n`
          : result,
    });
    let observed;
    try {
      createProductionServicePlan(fixture.options);
    } catch (error) {
      observed = error;
    }
    assert.ok(observed instanceof Error);
    assert.match(observed.message, /ExecStart/);
    assert.equal(observed.message.includes(REDACTION_MARKER), false);
  });

  it("fails closed when a mandatory systemd property is missing", () => {
    const fixture = makeFixture({
      mutateShow: ({ serviceName, result }) =>
        serviceName === "sentelligent-weixin-agent.service"
          ? result.replace(/^FragmentPath=.*\n/m, "")
          : result,
    });
    assert.throws(
      () => createProductionServicePlan(fixture.options),
      /unit path/,
    );
  });

  it("accepts the CentOS 7 Caddy snapshot when the empty EnvironmentFile property is omitted", () => {
    const fixture = makeFixture({
      mutateShow: ({ serviceName, result }) =>
        serviceName === "sentelligent-caddy.service"
          ? result.replace(/^EnvironmentFiles=\n/m, "")
          : result,
    });
    const plan = createProductionServicePlan(fixture.options);
    const caddy = plan.projectServices.find(
      ({ name }) => name === "sentelligent-caddy.service",
    );

    assertCompatiblePlan(plan);
    assert.equal(caddy.EnvironmentFile, "");
    assert.deepEqual(caddy.EnvironmentFiles, []);
  });

  it("still rejects non-empty or duplicate Caddy EnvironmentFile properties", () => {
    for (const mutate of [
      (result) => result.replace(
        /^EnvironmentFiles=\n/m,
        "EnvironmentFile=/tmp/unexpected.env (ignore_errors=no)\n",
      ),
      (result) => `${result}EnvironmentFile=\n`,
    ]) {
      const fixture = makeFixture({
        mutateShow: ({ serviceName, result }) =>
          serviceName === "sentelligent-caddy.service"
            ? mutate(result)
            : result,
      });
      assert.throws(
        () => createProductionServicePlan(fixture.options),
        /environment-file surface/,
      );
    }
  });

  it("accepts CentOS 7 snapshots that omit expected-empty project service properties", () => {
    const fixture = makeFixture({
      mutateShow: ({ serviceName, result }) => {
        if (!PROJECT_SERVICES.includes(serviceName)) return result;
        let adjusted = result.replace(/^SupplementaryGroups=\n/m, "");
        if (
          serviceName === "sentelligent-backend.service" ||
          serviceName === "sentelligent-frontend.service"
        ) {
          adjusted = adjusted.replace(/^Environment=\n/m, "");
        }
        if (serviceName === "sentelligent-caddy.service") {
          adjusted = adjusted.replace(/^WorkingDirectory=\n/m, "");
        }
        return adjusted;
      },
    });
    const plan = createProductionServicePlan(fixture.options);

    assertCompatiblePlan(plan);
    for (const service of plan.projectServices) {
      assert.deepEqual(service.SupplementaryGroups, []);
    }
    for (const serviceName of [
      "sentelligent-backend.service",
      "sentelligent-frontend.service",
    ]) {
      assert.deepEqual(
        plan.projectServices.find(({ name }) => name === serviceName).Environment,
        [],
      );
    }
    assert.equal(
      plan.projectServices.find(
        ({ name }) => name === "sentelligent-caddy.service",
      ).WorkingDirectory,
      "",
    );
  });

  it("still rejects non-empty or duplicate expected-empty project service properties", () => {
    const cases = [
      {
        serviceName: "sentelligent-backend.service",
        pattern: /^SupplementaryGroups=\n/m,
        replacement: "SupplementaryGroups=unexpected-group\n",
        duplicate: "SupplementaryGroups=\n",
        error: /SupplementaryGroups/,
      },
      {
        serviceName: "sentelligent-frontend.service",
        pattern: /^Environment=\n/m,
        replacement: "Environment=UNEXPECTED=value\n",
        duplicate: "Environment=\n",
        error: /environment surface/,
      },
      {
        serviceName: "sentelligent-caddy.service",
        pattern: /^WorkingDirectory=\n/m,
        replacement: "WorkingDirectory=/tmp/unexpected\n",
        duplicate: "WorkingDirectory=\n",
        error: /WorkingDirectory/,
      },
    ];

    for (const testCase of cases) {
      for (const mutate of [
        (result) => result.replace(testCase.pattern, testCase.replacement),
        (result) => `${result}${testCase.duplicate}`,
      ]) {
        const fixture = makeFixture({
          mutateShow: ({ serviceName, result }) =>
            serviceName === testCase.serviceName ? mutate(result) : result,
        });
        assert.throws(
          () => createProductionServicePlan(fixture.options),
          testCase.error,
        );
      }
    }
  });

  it("does not propagate command-runner diagnostics into an error", () => {
    const fixture = makeFixture({
      mutateRunner: ({ command, args, result }) => {
        if (
          command === "systemctl" &&
          args[0] === "show" &&
          args[1] === "sentelligent-caddy.service"
        ) {
          throw new Error(`provider failure ${REDACTION_MARKER}`);
        }
        return result;
      },
    });
    let observed;
    try {
      createProductionServicePlan(fixture.options);
    } catch (error) {
      observed = error;
    }
    assert.ok(observed instanceof Error);
    assert.equal(observed.message.includes(REDACTION_MARKER), false);
  });

  it("rejects a protected listener whose PID is not the protected service PID", () => {
    const fixture = makeFixture({ qingyangPid: 9999 });
    assert.throws(
      () => createProductionServicePlan(fixture.options),
      /listener 8797 owner/,
    );
  });

  it("rejects service state that changes between the two collection passes", () => {
    const fixture = makeFixture({
      mutateShow: ({ serviceName, result, count }) =>
        serviceName === "sentelligent-backend.service" && count === 2
          ? result.replace("MainPID=3101", "MainPID=3199")
          : result,
    });
    assert.throws(
      () => createProductionServicePlan(fixture.options),
      /Service state changed/,
    );
  });

  it("rejects file evidence that changes between hash passes", () => {
    const fixture = makeFixture();
    const counts = new Map();
    fixture.options.hashFile = (path) => {
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      if (path === CADDY_CONFIG_PATH && count === 2) return "f".repeat(64);
      return hashForPath(path);
    };
    assert.throws(
      () => createProductionServicePlan(fixture.options),
      /file evidence changed/,
    );
  });

  it("writes an exclusive atomic 0600 JSON file and refuses replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "sentelligent-service-plan-"));
    try {
      const fixture = makeFixture();
      const plan = createProductionServicePlan(fixture.options);
      const output = join(root, "nested", "service-plan.json");
      assert.equal(
        writeServicePlanAtomic(output, plan, { allowedOutputRoot: root }),
        output,
      );
      assert.equal(lstatSync(output).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), plan);
      assert.deepEqual(readdirSync(join(root, "nested")), ["service-plan.json"]);
      assert.throws(
        () => writeServicePlanAtomic(output, plan, { allowedOutputRoot: root }),
        /already exists/,
      );
      assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), plan);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an output parent that escapes through a symbolic link", () => {
    const root = mkdtempSync(join(tmpdir(), "sentelligent-service-plan-root-"));
    const outside = mkdtempSync(join(tmpdir(), "sentelligent-service-plan-outside-"));
    try {
      symlinkSync(outside, join(root, "escape"));
      assert.throws(
        () => writeServicePlanAtomic(
          join(root, "escape", "service-plan.json"),
          { safe: true },
          { allowedOutputRoot: root },
        ),
        /cannot contain symbolic links/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("supports injected CLI generation and exposes only a bounded summary", () => {
    const root = mkdtempSync(join(tmpdir(), "sentelligent-service-plan-cli-"));
    try {
      const fixture = makeFixture();
      const plan = createProductionServicePlan(fixture.options);
      const output = join(root, "service-plan.json");
      let writerOptions;
      const result = runProductionServicePlanCli(
        [`--output=${output}`],
        {
          createPlan: () => plan,
          writePlan: (path, value, options) => {
            assert.equal(value, plan);
            writerOptions = options;
            return writeServicePlanAtomic(path, value, options);
          },
          allowedOutputRoot: root,
        },
      );
      assert.deepEqual(result, {
        status: "created",
        outputPath: output,
        projectServices: 4,
        protectedServices: 1,
        protectedListeners: 1,
      });
      assert.deepEqual(writerOptions, { allowedOutputRoot: root });
      assert.equal(JSON.stringify(result).includes(MACHINE_ID), false);
      assert.equal(JSON.stringify(result).includes(REDACTION_MARKER), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, duplicate, and unknown CLI arguments without echoing them", () => {
    assert.throws(() => parseServicePlanArguments([]), /--output/);
    assert.throws(
      () => parseServicePlanArguments(["--output=/tmp/a", "--output=/tmp/b"]),
      /only once/,
    );
    const unknown = `--password=${REDACTION_MARKER}`;
    let observed;
    try {
      parseServicePlanArguments([unknown]);
    } catch (error) {
      observed = error;
    }
    assert.ok(observed instanceof Error);
    assert.equal(observed.message.includes(REDACTION_MARKER), false);
  });

  it("registers the production service-plan package command", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.equal(
      packageJson.scripts?.["service-plan:production"],
      "node scripts/production-service-plan.mjs",
    );
  });
});
