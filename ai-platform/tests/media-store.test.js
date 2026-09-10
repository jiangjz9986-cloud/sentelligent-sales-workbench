import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createAiPlatformRuntime } from "../src/server.js";
import { createMediaStore } from "../src/media/store.js";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(image).digest("hex");
const media = { mediaType: "image/png", byteLength: image.length, sha256, pageCount: 1 };
const identity = { issuer: "backend", owner: "alice", actor: "alice" };

test("media stays encrypted, owner-bound and task-bound; terminal cleanup retains a tombstone", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "platform-media-")));
  const runtime = createAiPlatformRuntime({ config: { databasePath: ":memory:" }, autoStart: false });
  let now = Date.now();
  const store = createMediaStore({ db: runtime.db, directory: dir, encryptionKey: Buffer.alloc(32, 89).toString("base64url"), clock: () => now });
  try {
    const item = store.put({ owner: "alice", bytes: image, ...media });
    assert.equal(readFileSync(join(dir, item.id + ".bin")).includes(image), false);
    assert.throws(() => store.bind({ id: item.id, owner: "bob", taskId: "forged", descriptor: media }), (error) => error.code === "media_not_found");
    const task = runtime.taskService.createTask({
      identity, idempotencyKey: "media-test",
      request: { taskType: "invoice.recognize", feature: "invoice", channel: "web", input: { media } },
    });
    store.bind({ id: item.id, owner: "alice", taskId: task.taskId, descriptor: media });
    assert.deepEqual(store.discard({ id: item.id, owner: "alice" }), { deleted: false });
    assert.throws(() => store.read({ id: item.id, owner: "alice", taskId: task.taskId }), (error) => error.code === "media_task_not_running");
    runtime.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.taskId);
    assert.deepEqual(store.read({ id: item.id, owner: "alice", taskId: task.taskId }).bytes, image);
    assert.throws(() => store.read({ id: item.id, owner: "bob", taskId: task.taskId }), (error) => error.code === "media_not_found");
    runtime.db.prepare("UPDATE tasks SET status = 'succeeded' WHERE id = ?").run(task.taskId);
    assert.equal(store.sweep().removed, 1);
    assert.equal(readdirSync(dir).length, 0);
    assert.ok(runtime.db.prepare("SELECT deleted_at FROM platform_media_objects WHERE id = ?").get(item.id).deleted_at);
    const expired = store.put({ owner: "alice", bytes: image, ...media });
    now += 16 * 60_000;
    assert.throws(() => store.bind({ id: expired.id, owner: "alice", taskId: task.taskId, descriptor: media }), (error) => error.code === "media_expired");
    assert.equal(store.sweep().removed, 1);
    assert.throws(() => store.put({ owner: "alice", bytes: image, mediaType: "image/jpeg", sha256 }), (error) => error.code === "media_type_invalid");
    assert.throws(() => store.put({ owner: "alice", bytes: image, mediaType: "image/png", sha256: "a".repeat(64) }), (error) => error.code === "media_digest_mismatch");
    writeFileSync(join(dir, "media-00000000-0000-0000-0000-000000000000.bin"), "orphan");
    assert.equal(store.sweep().orphans, 1);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
