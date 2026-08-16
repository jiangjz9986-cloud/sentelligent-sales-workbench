import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";

let tempDir;
let server;
let baseUrl;
let runnerCalls;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-hospital-tender-internal-api-"));
  runnerCalls = 0;
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: true,
    nodeEnv: "development",
    authRequired: true,
    authAccount: "owner",
    authPassword: "password",
    ["authSession" + "Secret"]: "test-session-secret-0123456789012345",
    hospitalTenderInternalRunner: {
      async run() {
        runnerCalls += 1;
        return {
          source: "internal",
          payload: {
            schemaVersion: "hospital-tender-snapshot-v1",
            generatedAt: "2026-08-16T10:00:00.000Z",
            notices: [],
            sources: [],
            runs: [],
          },
        };
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  server = null;
  tempDir = null;
});

describe("internal hospital tender run API", () => {
  it("requires a logged-in user and CSRF, then ingests the local runner result", async () => {
    const denied = await request("/api/hospital-tenders/run", { method: "POST" });
    assert.equal(denied.response.status, 401);
    assert.equal(runnerCalls, 0);

    const login = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: "owner", password: "password" }),
    });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get("set-cookie").split(";", 1)[0];
    const session = await request("/api/auth/session", { headers: { Cookie: cookie } });
    assert.equal(session.response.status, 200);

    const missingCsrf = await request("/api/hospital-tenders/run", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(missingCsrf.response.status, 403);
    assert.equal(runnerCalls, 0);

    const run = await request("/api/hospital-tenders/run", {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": session.body.csrfToken },
    });
    assert.equal(run.response.status, 200);
    assert.equal(run.body.item.acceptedCount, 0);
    assert.equal(runnerCalls, 1);
  });
});
