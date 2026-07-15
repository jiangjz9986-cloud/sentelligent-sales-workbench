import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";
import { createWeixinLoginBinding, terminalQrToSvg } from "../src/weixin/loginBinding.js";

let tempDir;
let server;
let baseUrl;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer wx-admin-token",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function fakeLoginProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4312;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", 143);
  };
  setTimeout(() => {
    child.stdout.emit(
      "data",
      Buffer.from(
        [
          "使用微信扫描以下二维码：",
          "█▀█",
          "▄█▄",
          "等待扫码...",
        ].join("\n"),
      ),
    );
  }, 5);
  return child;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-weixin-binding-"));
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: true,
    authAccount: "admin",
    authPassword: "admin-password",
    authSessionSecret: "admin-session-secret",
    weixinAgentApiToken: "wx-admin-token",
    weixinAgentSessionHome: join(tempDir, "weixin-session"),
    spawnWeixinLoginProcess: fakeLoginProcess,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("weixin binding", () => {
  it("converts terminal block QR output to an embeddable svg", () => {
    const svg = terminalQrToSvg(["█▀█", "▄█▄"].join("\n"), { scale: 4, quiet: 1 });
    assert.match(svg, /^<svg /);
    assert.match(svg, /aria-label="微信绑定二维码"/);
    assert.match(svg, /<rect /);
  });

  it("starts a login process and exposes the generated QR through the API", async () => {
    const started = await request("/api/integrations/weixin-agent/login", { method: "POST" });
    assert.equal(started.response.status, 201);
    assert.equal(started.body.item.status, "starting");
    assert.equal(started.body.item.pid, 4312);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = await request("/api/integrations/weixin-agent/login");
    assert.equal(status.response.status, 200);
    assert.equal(status.body.item.status, "waiting_scan");
    assert.match(status.body.item.qrSvg, /^<svg /);
    assert.match(status.body.item.message, /二维码/);
  });

  it("keeps the binding process running after login succeeds", () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 7310;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.emit("exit", 143);
    };
    const binding = createWeixinLoginBinding({
      config: { weixinAgentSessionHome: join(tempDir, "weixin-session") },
      spawnLoginProcess: () => child,
      now: () => new Date("2026-06-09T10:00:00.000Z"),
    });

    const started = binding.start();
    child.stdout.emit("data", Buffer.from("█▀█\n▄█▄\nWeChat login completed.\nWeChat worker started.\n"));
    const status = binding.current();
    const stopped = binding.stop();

    assert.equal(started.status, "starting");
    assert.equal(status.status, "logged_in");
    assert.equal(status.finishedAt, null);
    assert.match(status.message, /机器人正在运行/);
    assert.equal(stopped.status, "idle");
  });
});
