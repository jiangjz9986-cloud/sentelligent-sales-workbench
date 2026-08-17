import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";

let baseUrl;
let dir;
let server;
const machineCredential = ["scheduler", "machine", "fixture"].join("-");

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function login() {
  const response = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: "owner", password: "password" }),
  });
  return {
    cookie: response.response.headers.get("set-cookie").split(";", 1)[0],
    csrfToken: response.body.csrfToken,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentelligent-hospital-tender-scheduler-api-"));
  server = createServer({
    databaseUrl: join(dir, "test.sqlite"),
    seed: true,
    nodeEnv: "development",
    authRequired: true,
    authAccount: "owner",
    authPassword: "password",
    ["authSession" + "Secret"]: "test-session-secret-0123456789012345",
    hospitalTenderAutoRun: false,
    ["hospitalTender" + "SyncToken"]: machineCredential,
    hospitalTenderSchedulerClock: () => new Date("2026-08-17T00:00:00.000Z"),
    hospitalTenderInternalRunner: {
      async run() {
        return {
          source: "test",
          payload: {
            schemaVersion: "hospital-tender-snapshot-v1",
            generatedAt: "2026-08-17T00:00:00.000Z",
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
  if (dir) await rm(dir, { recursive: true, force: true });
  server = null;
  dir = null;
});

describe("hospital tender scheduler API", () => {
  it("keeps status and controls behind user auth and exposes durable progress", async () => {
    const denied = await request("/api/hospital-tenders/scheduler/status");
    assert.equal(denied.response.status, 401);

    const session = await login();
    const headers = {
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      "Content-Type": "application/json",
    };
    const initial = await request("/api/hospital-tenders/scheduler/status", { headers: { Cookie: session.cookie } });
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.item.intervalMinutes, 60);
    assert.equal(initial.body.item.batchSize, 10);
    assert.equal(Array.isArray(initial.body.runs), true);

    const updated = await request("/api/hospital-tenders/scheduler", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ enabled: true, intervalMinutes: 120, batchSize: 1 }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.item.intervalMinutes, 120);
    assert.equal(updated.body.item.batchSize, 1);

    const unknownField = await request("/api/hospital-tenders/scheduler", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ enabled: true, unexpected: true }),
    });
    assert.equal(unknownField.response.status, 422);

    const run = await request("/api/hospital-tenders/scheduler/run-next", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(run.response.status, 200);
    assert.equal(run.body.item.status, "success");
    assert.equal(run.body.item.state.lastBatchCount, 1);
    assert.equal(run.body.item.state.cycleProcessedCount, 1);

    const status = await request("/api/hospital-tenders/scheduler", { headers: { Cookie: session.cookie } });
    assert.equal(status.response.status, 200);
    assert.equal(status.body.item.cycleNumber, 1);
    assert.equal(status.body.item.cursorCustomerId !== null, true);
    assert.equal(status.body.runs.length, 1);
    assert.equal(status.body.lock.owner, null);
  });

  it("stops the in-process scheduler when the server closes", async () => {
    server.hospitalTenderScheduler.start();
    assert.equal(server.hospitalTenderScheduler.isStarted(), true);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(server.hospitalTenderScheduler.isStarted(), false);
    server = null;
  });

  it("does not overlap the legacy manual collector with a scheduler lease", async () => {
    const session = await login();
    assert.equal(
      server.hospitalTenderSchedulerRepository.tryAcquireLock(
        "scheduler-test-owner",
        "2026-08-17T01:00:00.000Z",
      ),
      true,
    );
    const response = await request("/api/hospital-tenders/run", {
      method: "POST",
      headers: {
        Cookie: session.cookie,
        "X-CSRF-Token": session.csrfToken,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.response.status, 409);
    assert.equal(response.body.error.code, "HOSPITAL_TENDER_RUN_IN_PROGRESS");
  });

  it("keeps scheduler state and controls outside the collector machine scope", async () => {
    const response = await request("/api/hospital-tenders/scheduler", {
      headers: { Authorization: ["Bearer", machineCredential].join(" ") },
    });
    assert.equal(response.response.status, 403);
    assert.equal(response.body.error.code, "MACHINE_SCOPE_DENIED");
  });
});
