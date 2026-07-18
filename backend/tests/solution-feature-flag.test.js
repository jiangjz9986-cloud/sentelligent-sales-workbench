import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let historicalSolution;
let modelCalls;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null,
  };
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

async function startServer(options = {}) {
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    aiAnalysisMode: "mock",
    modelApiKey: "",
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-solution-flag-"));
  databaseUrl = join(tempDir, "test.sqlite");
  modelCalls = 0;

  await startServer({
    seed: true,
    solutionWritesEnabled: true,
  });
  const created = await request("/api/solutions/draft", {
    method: "POST",
    body: JSON.stringify({
      owner: "历史方案测试",
      customerId: "rizhao",
      opportunityId: "op-rizhao-plan",
      artifactType: "solution_framework",
    }),
  });
  assert.equal(created.response.status, 201);
  historicalSolution = created.body.item;
  await stopServer();

  await startServer({
    aiAnalysisMode: "model",
    modelApiKey: "must-not-be-used",
    fetchImpl: async () => {
      modelCalls += 1;
      throw new Error("Disabled solution writes must not call the model");
    },
  });
});

afterEach(async () => {
  await stopServer();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("deferred solution assistant feature flag", () => {
  it("defaults writes to false and accepts only strict booleans", () => {
    const configOptions = {
      envFile: join(tempDir, "missing.env"),
      nodeEnv: "test",
      authRequired: false,
    };

    assert.equal(loadConfig(configOptions).solutionWritesEnabled, false);
    assert.equal(loadConfig({ ...configOptions, SOLUTION_WRITES_ENABLED: "true" }).solutionWritesEnabled, true);
    assert.equal(loadConfig({ ...configOptions, solutionWritesEnabled: false }).solutionWritesEnabled, false);
    assert.throws(
      () => loadConfig({ ...configOptions, SOLUTION_WRITES_ENABLED: "1" }),
      /SOLUTION_WRITES_ENABLED must be true or false/,
    );
  });

  it("keeps historical reads available while blocking generation and updates without side effects", async () => {
    const listBefore = await request("/api/solutions");
    const detailBefore = await request(`/api/solutions/${historicalSolution.id}`);
    const auditsBefore = await request("/api/audit-logs?limit=500");

    assert.equal(listBefore.response.status, 200);
    assert.ok(listBefore.body.items.some((item) => item.id === historicalSolution.id));
    assert.equal(detailBefore.response.status, 200);
    assert.deepEqual(detailBefore.body.item, historicalSolution);

    const blockedGeneration = await request("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "不得写入",
        customerId: "rizhao",
        opportunityId: "op-rizhao-plan",
        artifactType: "solution_framework",
      }),
    });
    const blockedUpdate = await request(`/api/solutions/${historicalSolution.id}`, {
      method: "PATCH",
      headers: { "If-Match": `"${historicalSolution.version}"` },
      body: JSON.stringify({
        title: "不得修改",
        content: "不得写入数据库",
        status: "saved",
      }),
    });

    assert.equal(blockedGeneration.response.status, 403);
    assert.equal(blockedGeneration.body.error.code, "FEATURE_DISABLED");
    assert.equal(blockedUpdate.response.status, 403);
    assert.equal(blockedUpdate.body.error.code, "FEATURE_DISABLED");
    assert.equal(modelCalls, 0);

    const listAfter = await request("/api/solutions");
    const detailAfter = await request(`/api/solutions/${historicalSolution.id}`);
    const auditsAfter = await request("/api/audit-logs?limit=500");
    assert.deepEqual(listAfter.body.items, listBefore.body.items);
    assert.deepEqual(detailAfter.body.item, detailBefore.body.item);
    assert.deepEqual(auditsAfter.body.items, auditsBefore.body.items);
  });
});
