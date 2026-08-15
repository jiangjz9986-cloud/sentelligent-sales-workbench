import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, it } from "node:test";

import { scanProjectSecrets } from "./project-secret-scan.mjs";

const sampleProviderKey = `sk-${"1234567890abcdef1234567890abcdef"}`;
const frontendScannerPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "outputs",
  "product-design-prototype",
  "scripts",
  "secret-scan.mjs",
);

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initializeRepository(workspace) {
  git(workspace.root, "init", "--initial-branch=main");
  git(workspace.root, "config", "user.name", "Secret Scan Test");
  git(workspace.root, "config", "user.email", "secret-scan@example.invalid");
}

function commitAll(workspace, message) {
  git(workspace.root, "add", "--all");
  git(workspace.root, "commit", "-m", message);
}

function githubContextLine(name, context) {
  const expression = ["${{", context, "}}"].join(" ");
  return [name, expression].join(': "') + '"';
}

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "sent-zx-secret-scan-"));
  return {
    root,
    write(relativePath, content) {
      const filePath = join(root, relativePath);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, content, "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("project secret scan", () => {
  it("keeps the frontend entrypoint aligned with runtime and test-fixture exclusions", () => {
    const workspace = makeWorkspace();
    try {
      const frontendRoot = join(workspace.root, "outputs", "product-design-prototype");
      workspace.write(
        ".runtime/playwright-browsers/WebInspectorUI.js",
        'const apiKey = "fixture-browser-key";\n',
      );
      workspace.write(
        "backend/tests/database-identity.test.js",
        'const secret = "unit-backend-session-private-secret";\n',
      );
      workspace.write("src/index.js", "console.log('clean');\n");
      mkdirSync(frontendRoot, { recursive: true });

      const result = spawnSync(process.execPath, [frontendScannerPath], {
        cwd: frontendRoot,
        encoding: "utf8",
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).status, "passed");
    } finally {
      workspace.cleanup();
    }
  });

  it("finds OpenAI-style provider keys in project text files", () => {
    const workspace = makeWorkspace();
    try {
      workspace.write("notes/requirements.txt", `model key ${sampleProviderKey}`);

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.deepEqual(result.findings.map((item) => item.file), ["notes/requirements.txt"]);
      assert.equal(result.findings[0].pattern, "OpenAI-style key");
    } finally {
      workspace.cleanup();
    }
  });

  it("finds OpenAI-style provider keys in TypeScript module declaration files", () => {
    const workspace = makeWorkspace();
    try {
      workspace.write(
        "src/runtime-config.mts",
        `export declare const apiKey: "${sampleProviderKey}";\n`,
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.ok(result.findings.some((item) =>
        item.file === "src/runtime-config.mts" && item.pattern === "OpenAI-style key",
      ));
    } finally {
      workspace.cleanup();
    }
  });

  it("ignores dependency and generated folders", () => {
    const workspace = makeWorkspace();
    try {
      workspace.write("node_modules/pkg/index.js", `const key = '${sampleProviderKey}';`);
      workspace.write("dist/app.js", `const key = '${sampleProviderKey}';`);
      workspace.write(".runtime/local.json", `{"token":"${sampleProviderKey}"}`);
      workspace.write("src/index.js", "console.log('clean');");

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "passed");
      assert.equal(result.findings.length, 0);
      assert.equal(result.scannedFiles, 1);
    } finally {
      workspace.cleanup();
    }
  });

  it("skips Git-ignored local secrets while scanning untracked project files", () => {
    const workspace = makeWorkspace();
    try {
      initializeRepository(workspace);
      workspace.write(".gitignore", ".env\n.worktrees/\n");
      workspace.write("src/tracked.js", "console.log('tracked');\n");
      commitAll(workspace, "clean baseline");

      workspace.write(".env", `MODEL_API_KEY="${sampleProviderKey}"\n`);
      workspace.write(
        ".worktrees/archived/backend/.env",
        `MODEL_API_KEY="${sampleProviderKey}"\n`,
      );
      workspace.write("src/untracked.js", "console.log('untracked');\n");

      const result = scanProjectSecrets({
        root: workspace.root,
        includeGitHistory: false,
      });

      assert.equal(result.status, "passed");
      assert.deepEqual(result.findings, []);
      assert.equal(result.scannedFiles, 3);
    } finally {
      workspace.cleanup();
    }
  });

  it("handles Git-visible listings larger than the child-process default without scanning ignored secrets", () => {
    const workspace = makeWorkspace();
    try {
      initializeRepository(workspace);
      workspace.write(".gitignore", ".env\n");
      workspace.write("README.md", "clean baseline\n");
      commitAll(workspace, "clean baseline");

      const cleanBlob = git(workspace.root, "rev-parse", "HEAD:README.md");
      const indexInfo = Array.from({ length: 6500 }, (_, index) => {
        const suffix = `${String(index).padStart(5, "0")}-${"x".repeat(150)}.js`;
        return `100644 ${cleanBlob}\tgenerated/${suffix}`;
      }).join("\n") + "\n";
      execFileSync("git", ["update-index", "--index-info"], {
        cwd: workspace.root,
        input: indexInfo,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      workspace.write(".env", `MODEL_API_KEY="${sampleProviderKey}"\n`);

      const result = scanProjectSecrets({
        root: workspace.root,
        includeGitHistory: false,
      });

      assert.equal(result.status, "passed");
      assert.deepEqual(result.findings, []);
      assert.equal(result.scannedFiles, 2);
    } finally {
      workspace.cleanup();
    }
  });

  it("passes when scanned project files contain only placeholders", () => {
    const workspace = makeWorkspace();
    try {
      workspace.write(
        "README.md",
        [
          "Use MODEL_API_KEY=[redacted-backend-env-only] in backend .env.",
          "AUTH_PASSWORD_HASH=<auth:hash output>",
          "login: { password: text(1000, true) }",
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "passed");
      assert.equal(result.scannedFiles, 1);
    } finally {
      workspace.cleanup();
    }
  });

  it("ignores runtime references and explicit fixture values", () => {
    const workspace = makeWorkspace();
    try {
      workspace.write(
        "src/config.js",
        [
          "const token = config?.weixinAgentApiToken;",
          'const secret = String(config?.authSessionSecret ?? "");',
          "const options = { apiKey: config.amapWebServiceKey };",
          "const query = `WHERE token_hash = :tokenHash`;",
          'const fixture = "AUTH_PASSWORD=secret-from-env-file";',
          "",
        ].join("\n"),
      );
      workspace.write(
        "integrations/icost-shortcut/verify-shortcut.mjs",
        [
          "const TOKEN_ACTION = ",
          JSON.stringify(["is", "workflow", "actions", "gettext"].join(".")),
          ";\n",
        ].join(""),
      );
      workspace.write(
        "scripts/integration-qa.mjs",
        'const config = { AUTH_SESSION_SECRET: "qa-session-secret" };\n',
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "passed");
      assert.deepEqual(result.findings, []);
    } finally {
      workspace.cleanup();
    }
  });

  it("ignores code expressions, documentation placeholders, and integration QA fixtures", () => {
    const workspace = makeWorkspace();
    try {
      workspace.write(
        "docs/validation-plan.md",
        [
          "login: { account: text(100, true), password: text(1000, true) },",
          "AUTH_PASSWORD_HASH=<auth:hash output>",
          "",
        ].join("\n"),
      );
      workspace.write(
        "scripts/integration-qa.mjs",
        'const env = { AUTH_SESSION_SECRET: "qa-session-secret" };\n',
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "passed");
      assert.deepEqual(result.findings, []);
    } finally {
      workspace.cleanup();
    }
  });

  it("does not treat quoted JSON or array literals as JavaScript expressions", () => {
    const workspace = makeWorkspace();
    const objectCredential = ["Obj", "735280", "!"].join("");
    const arrayCredential = ["Arr", "864291", "!"].join("");
    try {
      workspace.write(
        "src/config.js",
        [
          [
            "const authSecret = '",
            JSON.stringify({ token: objectCredential }),
            "';",
          ].join(""),
          [
            "const apiToken = '",
            JSON.stringify([arrayCredential]),
            "';",
          ].join(""),
          [
            "const escapedSecret = ",
            JSON.stringify(JSON.stringify({ token: objectCredential })),
            ";",
          ].join(""),
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.equal(
        result.findings.filter((item) => item.pattern === "API key assignment").length,
        3,
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("finds credential-like literal assignments in configuration files", () => {
    const workspace = makeWorkspace();
    const samplePassword = ["local", "735280"].join("");
    try {
      workspace.write("config/app.env", `AUTH_PASSWORD=${samplePassword}\n`);

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.equal(result.findings[0]?.pattern, "API key assignment");
    } finally {
      workspace.cleanup();
    }
  });

  it("does not let action identifiers or local paths hide sensitive literals", () => {
    const workspace = makeWorkspace();
    try {
      workspace.write(
        "config/app.env",
        [
          "AUTH_SECRET=com.Prod735280!",
          "AUTH_PASSWORD=/home/Prod735280!",
          "",
        ].join("\n"),
      );
      workspace.write(
        "src/config.js",
        [
          "const password = ",
          JSON.stringify(["/home/Prod", "735280!"].join("")),
          ";\n",
        ].join(""),
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.equal(result.findings.length, 3);
      assert.ok(result.findings.every((item) => item.pattern === "API key assignment"));
    } finally {
      workspace.cleanup();
    }
  });

  it("finds sensitive assignments inside comments while preserving strings", () => {
    const workspace = makeWorkspace();
    const sensitiveKey = ["AUTH", "PASSWORD"].join("_");
    const commentPath = ["/home/Prod", "735280!"].join("");
    const realSecret = ["Prod", "735280!"].join("");
    const urlSecret = ["https://example.invalid/", realSecret].join("");
    const commentProviderKey = ["sk", "C".repeat(24)].join("-");
    try {
      workspace.write(
        "src/comments.js",
        [
          [
            "const marker = 1; // trailing comment ",
            sensitiveKey,
            "=",
            JSON.stringify(commentPath),
          ].join(""),
          [
            "const blockMarker = 2; /* same-line block comment ",
            sensitiveKey,
            "=",
            JSON.stringify(commentPath),
            " */",
          ].join(""),
          [
            "const multiLineMarker = 3; /* comment begins here ",
            sensitiveKey,
            "=",
            JSON.stringify(commentPath),
          ].join(""),
          [
            sensitiveKey,
            "=",
            JSON.stringify(commentPath),
            " still in the block comment */",
          ].join(""),
          [
            "const actualSecret = ",
            JSON.stringify(realSecret),
            ";",
          ].join(""),
          [
            "const urlContainingSecret = ",
            JSON.stringify(urlSecret),
            ";",
          ].join(""),
          [
            "const slashContainingSecret = ",
            JSON.stringify(["value//", realSecret].join("")),
            ";",
          ].join(""),
          [
            "const blockMarkerContainingSecret = ",
            JSON.stringify(["value/*", realSecret, "*/"].join("")),
            ";",
          ].join(""),
          [
            "const escapedQuoteSecret = ",
            JSON.stringify(["value\\\"//", realSecret].join("")),
            ";",
          ].join(""),
          [
            "const highRiskComment = 4; // ",
            commentProviderKey,
          ].join(""),
          [
            "const highRiskString = ",
            JSON.stringify(commentProviderKey),
            ";",
          ].join(""),
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.deepEqual(
        result.findings.map((item) => [item.file, item.line, item.pattern]),
        [
          ["src/comments.js", 1, "API key assignment"],
          ["src/comments.js", 2, "API key assignment"],
          ["src/comments.js", 3, "API key assignment"],
          ["src/comments.js", 4, "API key assignment"],
          ["src/comments.js", 5, "API key assignment"],
          ["src/comments.js", 6, "API key assignment"],
          ["src/comments.js", 7, "API key assignment"],
          ["src/comments.js", 8, "API key assignment"],
          ["src/comments.js", 9, "API key assignment"],
          ["src/comments.js", 10, "OpenAI-style key"],
          ["src/comments.js", 11, "OpenAI-style key"],
        ],
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("does not treat bare configuration objects or arrays as JavaScript expressions", () => {
    const workspace = makeWorkspace();
    const objectCredential = ["Obj", "735280", "!"].join("");
    const arrayCredential = ["Arr", "864291", "!"].join("");
    try {
      workspace.write(
        "config/runtime.env",
        [
          ["AUTH_SECRET", `{token:${objectCredential}}`].join("="),
          ["API_TOKEN", `[${arrayCredential}]`].join("="),
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.deepEqual(
        result.findings.map((item) => [item.file, item.line, item.pattern]),
        [
          ["config/runtime.env", 1, "API key assignment"],
          ["config/runtime.env", 2, "API key assignment"],
        ],
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("ignores package-path examples in comments but finds a real backtick secret", () => {
    const workspace = makeWorkspace();
    const realSecret = ["Prod", "735280", "!"].join("");
    try {
      workspace.write(
        "src/comments.js",
        [
          [
            "// ",
            ["to", "ken"].join(""),
            ": `vendor/",
            ["weixin", "-agent-sdk"].join(""),
            "/dist/index.mjs`",
          ].join(""),
          ["// AUTH_TOKEN: ", "`", realSecret, "`"].join(""),
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.deepEqual(
        result.findings.map((item) => [item.file, item.line, item.pattern]),
        [["src/comments.js", 2, "API key assignment"]],
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("does not let regex literals hide a later sensitive assignment", () => {
    const workspace = makeWorkspace();
    const sensitiveKey = ["AUTH", "SECRET"].join("_");
    const realSecret = ["Prod", "regex", "735280!"].join("");
    try {
      workspace.write(
        "src/regex.js",
        [
          "const classMatcher = /[\\/*]/;",
          "const slashMatcher = /[\\/]/;",
          "const slashPairMatcher = /[//]/;",
          "const escapedMatcher = /\\/\\*literal\\*\\//;",
          "const flaggedMatcher = /token/giu;",
          ...Array.from({ length: 5 }, (_, index) =>
            ["const ", sensitiveKey, index, " = ", JSON.stringify(realSecret), ";"].join(""),
          ),
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.deepEqual(
        result.findings.map((item) => [item.file, item.line, item.pattern]),
        [
          ["src/regex.js", 6, "API key assignment"],
          ["src/regex.js", 7, "API key assignment"],
          ["src/regex.js", 8, "API key assignment"],
          ["src/regex.js", 9, "API key assignment"],
          ["src/regex.js", 10, "API key assignment"],
        ],
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("finds real npm and test-source credentials while allowing explicit fixtures", () => {
    const workspace = makeWorkspace();
    const npmToken = ["npm", "A".repeat(40)].join("_");
    const realPassword = ["Prod", "735280", "!"].join("");
    try {
      workspace.write(
        ".npmrc",
        ["//registry.npmjs.org/:_authToken", npmToken].join("=") + "\n",
      );
      workspace.write(
        "tests/auth.test.js",
        [
          ["const password", JSON.stringify(realPassword)].join(" = ") + ";",
          [
            "const fixturePassword",
            JSON.stringify("fixture-password-for-tests"),
          ].join(" = ") + ";",
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.ok(result.findings.some((item) => item.file === ".npmrc"));
      assert.ok(result.findings.some((item) => item.file === "tests/auth.test.js"));
      assert.equal(
        result.findings.filter((item) => item.file === "tests/auth.test.js").length,
        1,
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("allows bounded placeholder labels in the tree and history without hiding credentials", () => {
    const workspace = makeWorkspace();
    const randomTestCredential = ["Live", "Q7m2", "N9x", "!"].join("");
    const productionCredential = ["Prod", "S8v3", "M2q", "!"].join("");
    const providerCredential = ["sk", "A".repeat(24)].join("-");
    const fixtureValues = [
      ["closure", "machine", "scope", "token", "for", "synthetic", "tests"],
      [
        "closure",
        "confirmation",
        "secret",
        "for",
        "synthetic",
        "direct",
        "message",
        "delivery",
        "tests",
        "only",
      ],
      [
        "closure",
        "confirmation",
        "secret",
        "is",
        "independent",
        "and",
        "at",
        "least",
        "thirty",
        "two",
        "bytes",
      ],
      ["synthetic", "direct", "context", "value"],
      ["must", "not", "be", "a", "real", "secret"],
    ].map((parts) => parts.join("-"));
    try {
      initializeRepository(workspace);
      workspace.write(
        "tests/bounded-placeholders.test.js",
        [
          ...fixtureValues.map(
            (value, index) =>
              [`const fixtureToken${index}`, JSON.stringify(value)].join(" = ") + ";",
          ),
          "const options = { apiToken: workerOptions?.apiToken, secret: runtime.options.secret };",
          "",
        ].join("\n"),
      );
      workspace.write(
        "docs/vendor/upstream.mjs",
        [
          [
            "const apiToken",
            JSON.stringify(["vendor", "public", "placeholder", "token", "name"].join("-")),
          ].join(" = ") + ";",
          [
            "const localPath = ",
            JSON.stringify("~/workspace/local/config"),
            "; // local reference, pre per-account files.",
          ].join(""),
          [
            "const localPath = ",
            JSON.stringify(["credentials", "upstream", "local.config"].join("/")),
            "; // local reference, pre per-account files.",
          ].join(""),
          "",
        ].join("\n"),
      );
      workspace.write(
        "docs/design-plan.md",
        [
          "API_TOKEN=fixture1",
          "SENTELLIGENT_TEST_SECRET=confirmation",
          "",
        ].join("\n"),
      );
      commitAll(workspace, "bounded synthetic labels");
      workspace.write(
        "docs/design-plan.md",
        [
          "API_TOKEN=fixture1",
          "SENTELLIGENT_TEST_SECRET=confirmation",
          "",
        ].join("\n"),
      );
      workspace.write(
        "tests/bounded-placeholders.test.js",
        [
          ...fixtureValues.map(
            (value, index) =>
              [`const fixtureToken${index}`, JSON.stringify(value)].join(" = ") + ";",
          ),
          ["const password", JSON.stringify(randomTestCredential)].join(" = ") + ";",
          ["const apiKey", JSON.stringify(providerCredential)].join(" = ") + ";",
          "const options = { apiToken: workerOptions?.apiToken, secret: runtime.options.secret };",
          "",
        ].join("\n"),
      );
      workspace.write(
        "config/production.env",
        [
          ["AUTH_PASSWORD", productionCredential].join("="),
          "AUTH_SECRET=confirmation",
          "TEST_SECRET=LiveQ7m2N9x!",
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root });
      const findingSummary = result.findings.map((item) => [
        item.source,
        item.file,
        item.line,
        item.pattern,
      ]);

      assert.equal(result.status, "failed");
      assert.ok(result.scannedGitObjects > 0);
      assert.deepEqual(findingSummary, [
        ["working-tree", "config/production.env", 1, "API key assignment"],
        ["working-tree", "config/production.env", 2, "API key assignment"],
        ["working-tree", "config/production.env", 3, "API key assignment"],
        ["working-tree", "tests/bounded-placeholders.test.js", 6, "API key assignment"],
        ["working-tree", "tests/bounded-placeholders.test.js", 7, "OpenAI-style key"],
        ["working-tree", "tests/bounded-placeholders.test.js", 7, "API key assignment"],
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  it("reports bounded safe-lead assignments in production config while allowing test and docs fixtures", () => {
    const workspace = makeWorkspace();
    const boundedValues = {
      synthetic: ["synthetic", "direct", "context", "value"].join("-"),
      vendor: ["vendor", "public", "placeholder", "token", "name"].join("-"),
      fixture: ["fixture", "api", "token", "name"].join("-"),
    };
    try {
      workspace.write(
        "tests/bounded-labels.test.js",
        [
          ["const authSecret", JSON.stringify(boundedValues.synthetic)].join(" = ") + ";",
          ["const apiToken", JSON.stringify(boundedValues.vendor)].join(" = ") + ";",
          "",
        ].join("\n"),
      );
      workspace.write(
        "docs/secret-fixtures.md",
        [
          ["AUTH_SECRET", boundedValues.synthetic].join("="),
          ["API_TOKEN", boundedValues.fixture].join("="),
          "",
        ].join("\n"),
      );
      workspace.write(
        "config/production.env",
        [
          ["AUTH_SECRET", boundedValues.synthetic].join("="),
          ["API_TOKEN", boundedValues.vendor].join("="),
          ["TEST_SECRET", boundedValues.fixture].join("="),
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root, includeGitHistory: false });

      assert.equal(result.status, "failed");
      assert.deepEqual(
        result.findings.map((item) => [item.file, item.line, item.pattern]),
        [
          ["config/production.env", 1, "API key assignment"],
          ["config/production.env", 2, "API key assignment"],
          ["config/production.env", 3, "API key assignment"],
        ],
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("ignores synthetic cursor retry context only in historical test paths", () => {
    const workspace = makeWorkspace();
    const syntheticContext = ["synthetic", "cursor", "retry", "context"].join("-");
    try {
      initializeRepository(workspace);
      workspace.write(
        "backend/tests/weixin-vendor-adapter.test.js",
        `const payload = { context_token: ${JSON.stringify(syntheticContext)} };\n`,
      );
      workspace.write("config/production.env", `CONTEXT_TOKEN="${syntheticContext}"\n`);
      commitAll(workspace, "synthetic cursor retry fixture");
      git(workspace.root, "rm", "backend/tests/weixin-vendor-adapter.test.js", "config/production.env");
      git(workspace.root, "commit", "-m", "remove synthetic fixture");

      const result = scanProjectSecrets({ root: workspace.root });
      const historyFindings = result.findings.filter((item) => item.source === "git-history");

      assert.equal(result.status, "failed");
      assert.deepEqual(historyFindings.map((item) => item.file), ["config/production.env"]);
      assert.equal(historyFindings[0]?.pattern, "API key assignment");
    } finally {
      workspace.cleanup();
    }
  });

  it("allows bounded synthetic labels in test and documentation history while finding production values", () => {
    const workspace = makeWorkspace();
    const productionSecret = ["Prod", "735280", "!"].join("");
    try {
      initializeRepository(workspace);
      workspace.write(
        "backend/tests/weixin-closure.test.js",
        [
          ["const machineToken", JSON.stringify("machine-secret")].join(" = ") + ";",
          ["const confirmationSecret", JSON.stringify("closure-confirmation-secret-for-synthetic-direct-message-delivery-tests-only")].join(" = ") + ";",
          ["const contextToken", JSON.stringify("synthetic-direct-context-value")].join(" = ") + ";",
          ["const workerToken", JSON.stringify("worker-weixin-api-token")].join(" = ") + ";",
          "",
        ].join("\n"),
      );
      workspace.write(
        "docs/superpowers/plans/secret-fixtures.md",
        'SENTELLIGENT_TEST_SECRET: "synthetic-direct-context-value"\n',
      );
      commitAll(workspace, "bounded synthetic labels");
      git(workspace.root, "rm", "backend/tests/weixin-closure.test.js", "docs/superpowers/plans/secret-fixtures.md");
      git(workspace.root, "commit", "-m", "remove bounded labels");

      workspace.write("config/production.env", `AUTH_SECRET=${productionSecret}\n`);

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.deepEqual(
        result.findings.map((item) => [item.source, item.file, item.pattern]),
        [["working-tree", "config/production.env", "API key assignment"]],
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("reports bounded safe-lead assignments in history blobs and commit messages outside test/docs contexts", () => {
    const workspace = makeWorkspace();
    const boundedValues = {
      synthetic: ["synthetic", "direct", "context", "value"].join("-"),
      vendor: ["vendor", "public", "placeholder", "token", "name"].join("-"),
      fixture: ["fixture", "api", "token", "name"].join("-"),
    };
    try {
      initializeRepository(workspace);
      workspace.write(
        "tests/bounded-labels.test.js",
        [
          ["const authSecret", JSON.stringify(boundedValues.synthetic)].join(" = ") + ";",
          ["const apiToken", JSON.stringify(boundedValues.vendor)].join(" = ") + ";",
          "",
        ].join("\n"),
      );
      workspace.write(
        "docs/secret-fixtures.md",
        [
          ["AUTH_SECRET", boundedValues.synthetic].join("="),
          ["API_TOKEN", boundedValues.fixture].join("="),
          "",
        ].join("\n"),
      );
      workspace.write(
        "config/production.env",
        [
          ["AUTH_SECRET", boundedValues.synthetic].join("="),
          ["API_TOKEN", boundedValues.vendor].join("="),
          ["TEST_SECRET", boundedValues.fixture].join("="),
          "",
        ].join("\n"),
      );
      commitAll(
        workspace,
        [
          "bounded fixture labels",
          ["AUTH_SECRET", boundedValues.synthetic].join("="),
          ["API_TOKEN", boundedValues.vendor].join("="),
          "",
        ].join("\n"),
      );
      git(
        workspace.root,
        "rm",
        "tests/bounded-labels.test.js",
        "docs/secret-fixtures.md",
        "config/production.env",
      );
      git(workspace.root, "commit", "-m", "remove bounded fixtures");

      const result = scanProjectSecrets({ root: workspace.root });
      const historyBlobFindings = result.findings.filter((item) => item.source === "git-history");
      const historyMessageFindings = result.findings.filter(
        (item) => item.source === "git-history-message",
      );

      assert.equal(result.status, "failed");
      assert.deepEqual(
        historyBlobFindings.map((item) => [item.file, item.line, item.pattern]),
        [
          ["config/production.env", 1, "API key assignment"],
          ["config/production.env", 2, "API key assignment"],
          ["config/production.env", 3, "API key assignment"],
        ],
      );
      assert.equal(historyMessageFindings.length, 2);
      assert.ok(historyMessageFindings.every((item) => item.messageType === "commit"));
      assert.ok(
        result.findings.every(
          (item) => !item.file.startsWith("tests/") && !item.file.startsWith("docs/"),
        ),
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("ignores package paths in source comments while finding real comment and string credentials", () => {
    const workspace = makeWorkspace();
    const realSecret = ["Prod", "735280", "!"].join("");
    try {
      workspace.write(
        "src/comments.mjs",
        [
          ["// Legacy single-file ", ["to", "ken"].join(""), ": `vendor/", ["weixin", "-agent-sdk"].join(""), "/dist/index.mjs`"].join(""),
          `// AUTH_TOKEN: \`${realSecret}\``,
          `const password = ${JSON.stringify(realSecret)};`,
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root, includeGitHistory: false });

      assert.equal(result.status, "failed");
      assert.deepEqual(
        result.findings.map((item) => [item.line, item.pattern]),
        [[2, "API key assignment"], [3, "API key assignment"]],
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("finds plain template literals and production values containing fixture words", () => {
    const workspace = makeWorkspace();
    const tick = String.fromCharCode(96);
    const amapKey = ["a1b2c3d4", "e5f6g7h8"].join("");
    const templatePassword = ["Prod", "735280", "!"].join("");
    const adminPassword = ["Prod", "admin", "735280!"].join("-");
    const sessionSecret = ["prod", "session", "A7bc9d2!"].join("-");
    const weixinToken = ["wx", "A7bc9d2!"].join("-");
    try {
      workspace.write(
        "src/config.js",
        [
          ["const amapApiKey", tick + amapKey + tick].join(" = ") + ";",
          ["const password", tick + templatePassword + tick].join(" = ") + ";",
          "",
        ].join("\n"),
      );
      workspace.write(
        "config/production.env",
        [
          ["AUTH_PASSWORD", adminPassword].join("="),
          ["AUTH_SESSION_SECRET", sessionSecret].join("="),
          ["WEIXIN_AGENT_API_TOKEN", weixinToken].join("="),
          "",
        ].join("\n"),
      );

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.equal(
        result.findings.filter((item) => item.file === "src/config.js").length,
        2,
      );
      assert.equal(
        result.findings.filter((item) => item.file === "config/production.env").length,
        3,
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("finds credentials in the complete Git history, including non-current refs", () => {
    const workspace = makeWorkspace();
    try {
      initializeRepository(workspace);
      workspace.write("README.md", "clean main branch\n");
      commitAll(workspace, "clean baseline");

      git(workspace.root, "switch", "-c", "archived-secret");
      workspace.write("config/.env", `MODEL_API_KEY="${sampleProviderKey}"\n`);
      commitAll(workspace, "historical credential fixture");
      git(workspace.root, "switch", "main");

      const result = scanProjectSecrets({ root: workspace.root });
      const historyFinding = result.findings.find((item) => item.source === "git-history");

      assert.equal(result.status, "failed");
      assert.ok(result.scannedGitObjects > 0);
      assert.equal(historyFinding?.file, "config/.env");
      assert.equal(historyFinding?.pattern, "OpenAI-style key");
      assert.match(historyFinding?.object ?? "", /^[0-9a-f]{40,64}$/);
    } finally {
      workspace.cleanup();
    }
  });

  it("ignores Codex turn-diff refs that are not publishable repository history", () => {
    const workspace = makeWorkspace();
    try {
      initializeRepository(workspace);
      workspace.write("README.md", "clean main branch\n");
      commitAll(workspace, "clean baseline");

      git(workspace.root, "switch", "-c", "temporary-codex-snapshot");
      workspace.write("config/.env", `MODEL_API_KEY="${sampleProviderKey}"\n`);
      commitAll(workspace, `API_TOKEN=${sampleProviderKey}`);
      const snapshotCommit = git(workspace.root, "rev-parse", "HEAD");
      git(
        workspace.root,
        "update-ref",
        "refs/codex/turn-diffs/checkpoints/test/snapshot",
        snapshotCommit,
      );
      git(workspace.root, "switch", "main");
      git(workspace.root, "branch", "-D", "temporary-codex-snapshot");

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "passed");
      assert.deepEqual(result.findings, []);
    } finally {
      workspace.cleanup();
    }
  });

  it("does not let a test-path alias hide the same credential blob from a config path", () => {
    const workspace = makeWorkspace();
    const sharedPassword = ["Local", "735280"].join("");
    const sharedCredential = ["AUTH_PASSWORD", sharedPassword].join("=") + "\n";
    try {
      initializeRepository(workspace);
      workspace.write("a/tests/fixture.env", sharedCredential);
      workspace.write("z-config/app.env", sharedCredential);
      commitAll(workspace, "shared credential blob");
      git(workspace.root, "rm", "a/tests/fixture.env", "z-config/app.env");
      git(workspace.root, "commit", "-m", "remove credential files");

      const result = scanProjectSecrets({ root: workspace.root });
      const configFinding = result.findings.find(
        (item) => item.source === "git-history" && item.file === "z-config/app.env",
      );

      assert.equal(result.status, "failed");
      assert.equal(result.scannedGitObjects, 1, "one shared blob should be counted once");
      assert.equal(configFinding?.pattern, "API key assignment");
    } finally {
      workspace.cleanup();
    }
  });

  it("scans commit, annotated tag, and Git notes messages", () => {
    const workspace = makeWorkspace();
    const commitPassword = ["Commit", "735280", "!"].join("");
    const tagPassword = ["Tag", "735280", "!"].join("");
    const notePassword = ["Note", "735280", "!"].join("");
    try {
      initializeRepository(workspace);
      workspace.write("README.md", "clean source\n");
      git(
        workspace.root,
        "add",
        "--all",
      );
      git(
        workspace.root,
        "commit",
        "-m",
        ["AUTH_PASSWORD", commitPassword].join("="),
      );
      git(
        workspace.root,
        "tag",
        "-a",
        "message-audit",
        "-m",
        ["API_TOKEN", tagPassword].join("="),
      );
      git(
        workspace.root,
        "notes",
        "add",
        "-m",
        ["AUTH_SECRET", notePassword].join("="),
      );

      const result = scanProjectSecrets({ root: workspace.root });
      const messageSources = new Set(
        result.findings
          .filter((item) => item.source === "git-history-message")
          .map((item) => item.messageType),
      );

      assert.equal(result.status, "failed");
      assert.deepEqual(messageSources, new Set(["commit", "annotated-tag", "note"]));
      assert.ok(result.scannedGitMessages >= 3);
    } finally {
      workspace.cleanup();
    }
  });

  it("allows quoted GitHub Actions context placeholders in the tree and Git history", () => {
    const workspace = makeWorkspace();
    try {
      initializeRepository(workspace);
      workspace.write(
        ".github/workflows/release.yml",
        [
          "env:",
          githubContextLine("  TOKEN", "github.token"),
          githubContextLine("  API_KEY", "secrets.RELEASE_API_TOKEN"),
          "",
        ].join("\n"),
      );
      commitAll(workspace, "GitHub Actions placeholders");

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "passed");
      assert.ok(result.scannedGitObjects > 0);
      assert.deepEqual(result.findings, []);
    } finally {
      workspace.cleanup();
    }
  });
});
