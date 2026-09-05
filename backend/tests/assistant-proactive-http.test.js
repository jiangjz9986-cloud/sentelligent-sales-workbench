import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";

let tempDir;
let server;
let baseUrl;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-proactive-http-"));
  server = createServer({
    databaseUrl: join(tempDir, "assistant.sqlite"),
    seed: true,
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("proactive assistant HTTP surface", () => {
  it("returns a deterministic owner-scoped read-only snapshot and embeds it in dashboard summary", async () => {
    const first = await request("/api/assistant/proactive");
    assert.equal(first.response.status, 200);
    assert.equal(first.body.item.schemaVersion, "proactive-assistant-v1");
    assert.equal(first.body.item.modelVersion, "rules/proactive-v1");
    assert.ok(Array.isArray(first.body.item.items));
    assert.ok(first.body.item.items.every((item) => item.writebackAllowed === false));

    const second = await request("/api/assistant/proactive");
    assert.deepEqual(
      first.body.item.items.map((item) => item.id),
      second.body.item.items.map((item) => item.id),
    );

    const summary = await request("/api/dashboard/summary");
    assert.equal(summary.response.status, 200);
    assert.equal(summary.body.item.proactiveAssistant.schemaVersion, "proactive-assistant-v1");
    assert.deepEqual(
      summary.body.item.proactiveAssistant.items.map((item) => item.id),
      first.body.item.items.map((item) => item.id),
    );
  });

  it("rejects an invalid limit without running a write", async () => {
    const response = await request("/api/assistant/proactive?limit=0");
    assert.equal(response.response.status, 422);
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
  });
});
