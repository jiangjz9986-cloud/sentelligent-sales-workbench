import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequestBinding } from "../../shared/aiPlatformRequestAuth.mjs";
import { createAiPlatformServiceToken } from "../../backend/src/aiPlatform/runtime.js";
import { createAiPlatformClient } from "../../backend/src/aiPlatform/client.js";
import { createServer } from "../src/server.js";
import { loadAiPlatformConfig } from "../src/config.js";
import { createServiceToken, verifyServiceToken } from "../src/auth/internalAuth.js";

const SECRET = Buffer.alloc(32, 91).toString("base64url");
const ISSUER = "signed-backend";
const PATH = "/internal/ai/v1/tasks";
const request = { taskType: "quick-record.analyze", feature: "quick-record", channel: "web", input: { text: "fixture" } };
const BODY = JSON.stringify(request);

async function start(databasePath = ":memory:") {
  const server = createServer({
    config: { nodeEnv: "production", authSecret: SECRET, trustedIssuer: ISSUER, databasePath, taskAdmissionEnabled: true },
    autoStart: false, logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function signed(binding, options = {}) {
  return createServiceToken({
    secret: SECRET, issuer: ISSUER, subject: "backend", actor: "alice", owner: "alice",
    scopes: ["ai:task:create", "ai:task:read"], requestBinding: binding, ...options,
  });
}

test("production binds body, URL, method and idempotency header before accepting a task", async () => {
  const { server, url } = await start();
  try {
    const binding = createRequestBinding({ method: "POST", path: PATH, body: BODY, idempotencyKey: "signed-create" });
    for (const changed of [
      { body: JSON.stringify({ ...request, input: { text: "changed" } }) },
      { path: PATH + "?changed=true" },
      { method: "PATCH" },
      { key: "different-idempotency" },
      { credential: signed(binding, { issuer: "other-backend" }) },
      { credential: signed(binding, { now: () => Date.now() - 1_000_000 }) },
      { credential: signed(null) },
    ]) {
      const response = await fetch(url + (changed.path ?? PATH), {
        method: changed.method ?? "POST", body: changed.body ?? BODY,
        headers: { Authorization: `Bearer ${changed.credential ?? signed(binding)}`, "Content-Type": "application/json", "Idempotency-Key": changed.key ?? "signed-create" },
      });
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    }
    assert.equal(server.aiPlatform.db.prepare("SELECT count(*) n FROM tasks").get().n, 0);
    const bearer = signed(binding);
    const options = { method: "POST", body: BODY, headers: { Authorization: `Bearer ${bearer}`, "Idempotency-Key": "signed-create" } };
    const accepted = await fetch(url + PATH, options);
    assert.equal(accepted.status, 202);
    await accepted.arrayBuffer();
    const replay = await fetch(url + PATH, options);
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error.code, "replayed_auth");
    assert.equal(server.aiPlatform.db.prepare("SELECT count(*) n FROM tasks").get().n, 1);
    const dev = await fetch(url + "/internal/ai/v1/admin/overview", { headers: { "X-AI-Platform-Dev-Auth": "1" } });
    assert.equal(dev.status, 401);
    await dev.arrayBuffer();
  } finally {
    await server.closeAiPlatform();
  }
});

test("request nonce rejection survives restart while a freshly signed business retry remains idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-auth-restart-"));
  let instance = await start(join(dir, "platform.sqlite"));
  const binding = createRequestBinding({ method: "POST", path: PATH, body: BODY, idempotencyKey: "restart" });
  const bearer = signed(binding);
  const send = (credential) => fetch(instance.url + PATH, { method: "POST", body: BODY, headers: { Authorization: `Bearer ${credential}`, "Idempotency-Key": "restart" } });
  try {
    assert.equal((await (await send(bearer)).json()).item.replayed, false);
    await instance.server.closeAiPlatform();
    instance = await start(join(dir, "platform.sqlite"));
    const replay = await send(bearer);
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error.code, "replayed_auth");
    const retry = await send(signed(binding));
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).item.replayed, true);
    assert.equal(instance.server.aiPlatform.db.prepare("SELECT count(*) n FROM tasks").get().n, 1);
  } finally {
    await instance.server.closeAiPlatform();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("business client signs each exact serialized request and polling request independently", async () => {
  const { server, url } = await start();
  try {
    const seen = [];
    const api = createAiPlatformClient({
      baseUrl: url,
      tokenProvider: ({ requestBinding }) => {
        const bearer = createAiPlatformServiceToken({
          secret: SECRET, issuer: ISSUER, owner: "alice", actor: "alice", requestBinding,
        });
        seen.push(verifyServiceToken(bearer, { secret: SECRET, expectedRequest: requestBinding }).jti);
        return bearer;
      },
    });
    const task = await api.createTask({ request, idempotencyKey: "client-signature" });
    assert.equal(task.status, "queued");
    assert.equal((await api.getTask(task.taskId)).status, "queued");
    assert.equal((await api.getTask(task.taskId)).status, "queued");
    assert.equal(new Set(seen).size, 3);
  } finally {
    await server.closeAiPlatform();
  }
});

test("production cannot disable request binding and timestamp skew remains bounded", () => {
  assert.throws(() => loadAiPlatformConfig({ nodeEnv: "production", authSecret: SECRET, requestBindingRequired: false }, {}), /request binding/);
  const now = 1_800_000_000_000;
  const binding = createRequestBinding({ method: "GET", path: PATH });
  const bearer = signed(binding, { now: () => now, ttlSeconds: 30 });
  const verify = (offset) => verifyServiceToken(bearer, { secret: SECRET, expectedIssuer: ISSUER, expectedRequest: binding, now: () => now + offset });
  assert.equal(verify(-15_000).owner, "alice");
  assert.throws(() => verify(-16_000), (error) => error.code === "expired_auth");
  assert.throws(() => verify(46_000), (error) => error.code === "expired_auth");
});
