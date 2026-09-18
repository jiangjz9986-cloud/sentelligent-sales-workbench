import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, chmodSync, writeFileSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AI_PLATFORM_SOCKET_DIRECTORY_MODE,
  AI_PLATFORM_SOCKET_MODE,
  assertAiPlatformSocket,
  assertAiPlatformSocketDirectory,
  socketFetch,
} from "../../shared/aiPlatformSocketTransport.mjs";
import { createAiPlatformClient } from "../../backend/src/aiPlatform/client.js";

test("private HTTP follows the protected socket rather than the logical TCP address", { skip: process.platform === "win32" }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ai-socket-")));
  const path = join(root, "api.sock");
  chmodSync(root, AI_PLATFORM_SOCKET_DIRECTORY_MODE);
  const groupGid = lstatSync(root).gid;
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, body: Buffer.concat(chunks).toString() });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ item: { taskId: "socket-task", status: "queued" } }));
  });
  await new Promise((resolve) => server.listen(path, resolve));
  chmodSync(path, AI_PLATFORM_SOCKET_MODE);
  try {
    const directory = assertAiPlatformSocketDirectory(root, {
      ownerUid: process.getuid?.(),
      groupGid,
    });
    assert.equal(directory.mode & 0o777, AI_PLATFORM_SOCKET_DIRECTORY_MODE);
    const socket = assertAiPlatformSocket(path, {
      ownerUid: process.getuid?.(),
      groupGid,
    }).socket;
    assert.equal(socket.mode & 0o777, AI_PLATFORM_SOCKET_MODE);
    assert.equal(lstatSync(path).gid, directory.gid);
    const wrongGroupGid = groupGid === 0 ? 1 : 0;
    assert.throws(
      () => assertAiPlatformSocket(path, { ownerUid: process.getuid?.(), groupGid: wrongGroupGid }),
      /unsafe/,
    );
    const client = createAiPlatformClient({
      baseUrl: "http://127.0.0.1:1", token: "test-token", fetchImpl: socketFetch(path),
    });
    const task = await client.createTask({ request: { taskType: "quick-record.analyze", input: { text: "fixture" } }, idempotencyKey: "socket-request" });
    assert.equal(task.taskId, "socket-task");
    assert.equal(received[0].path, "/internal/ai/v1/tasks");
    assert.equal(JSON.parse(received[0].body).input.text, "fixture");
    writeFileSync(join(root, "not-a-socket"), "fixture");
    await assert.rejects(socketFetch(join(root, "not-a-socket"))("http://127.0.0.1/"), /unsafe/);
    chmodSync(path, 0o666);
    await assert.rejects(socketFetch(path)("http://127.0.0.1/"), /unsafe/);
    chmodSync(path, AI_PLATFORM_SOCKET_MODE);
    chmodSync(root, 0o777);
    await assert.rejects(socketFetch(path)("http://127.0.0.1/"), /unsafe/);
    chmodSync(root, AI_PLATFORM_SOCKET_DIRECTORY_MODE);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
