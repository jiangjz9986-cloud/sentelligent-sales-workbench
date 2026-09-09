import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { AiPlatformError } from "../errors.js";
import { readOperationalControl } from "../operations/control.js";
import { withImmediateTransaction } from "../utils.js";
import { wavDurationSeconds } from "../../../shared/canonicalWav.mjs";

const MEDIA_ID = /^media-[0-9a-f-]{36}$/u;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf", "audio/wav"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);

function fail(code, status = 422) {
  throw new AiPlatformError("media object is unavailable or invalid", { code, status });
}
function ownerValue(value) {
  if (typeof value !== "string" || !value || value.length > 400 || /[\u0000-\u001f\u007f]/u.test(value)) fail("invalid_auth", 401);
  return value;
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function magicMatches(bytes, type) {
  const ascii = (start, end) => bytes.subarray(start, end).toString("ascii");
  if (type === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg") return bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (type === "application/pdf") return ascii(0, 5) === "%PDF-";
  return type === "audio/wav" && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
}

export function createMediaStore({ db, directory, encryptionKey, maxBytes = 16 * 1024 * 1024, capacityBytes = 64 * 1024 * 1024, ttlMs = 15 * 60_000, clock = () => Date.now() }) {
  const key = Buffer.from(String(encryptionKey ?? ""), "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encryptionKey) fail("media_key_unavailable", 503);
  if (typeof directory !== "string" || !directory.startsWith("/")) fail("media_path_invalid", 503);
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0
    || realpathSync(root) !== root) fail("media_path_invalid", 503);
  function pathFor(id) {
    if (typeof id !== "string" || !MEDIA_ID.test(id)) fail("media_not_found", 404);
    return join(root, id + ".bin");
  }
  function rowFor(id, owner) {
    pathFor(id);
    const row = db.prepare("SELECT * FROM platform_media_objects WHERE id = ? AND owner = ?").get(id, ownerValue(owner));
    if (!row || row.deleted_at) fail("media_not_found", 404);
    if (Date.parse(row.expires_at) <= Number(clock())) fail("media_expired", 410);
    return row;
  }
  function view(row) {
    return { id: row.id, mediaType: row.media_type, sha256: row.sha256, byteLength: row.byte_length, expiresAt: row.expires_at };
  }
  function put({ owner, bytes, mediaType, sha256 }) {
    ownerValue(owner);
    if (readOperationalControl(db).paused) fail("service_draining", 503);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) fail("media_size_invalid", 413);
    if (!TYPES.has(mediaType) || !magicMatches(bytes, mediaType)) fail("media_type_invalid");
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256) || digest(bytes) !== sha256) fail("media_digest_mismatch");
    let audioSeconds = null;
    if (mediaType === "audio/wav") {
      try { audioSeconds = wavDurationSeconds(bytes); } catch { fail("media_type_invalid"); }
    }
    const used = db.prepare("SELECT COALESCE(SUM(byte_length), 0) total FROM platform_media_objects WHERE deleted_at IS NULL").get().total;
    if (used + bytes.length > capacityBytes) fail("media_capacity_exceeded", 429);
    const id = "media-" + randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([id, owner, sha256, mediaType])));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const envelope = Buffer.concat([Buffer.from("AIM1"), iv, cipher.getAuthTag(), ciphertext]);
    const file = pathFor(id);
    writeFileSync(file, envelope, { mode: 0o600, flag: "wx" });
    const now = Number(clock());
    try {
      db.prepare("INSERT INTO platform_media_objects (id, owner, media_type, sha256, byte_length, audio_seconds, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, owner, mediaType, sha256, bytes.length, audioSeconds, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
    } catch (error) {
      unlinkSync(file);
      throw error;
    }
    return view(rowFor(id, owner));
  }
  function bind({ id, owner, taskId, descriptor }) {
    const row = rowFor(id, owner);
    if (row.task_id && row.task_id !== taskId) fail("media_already_bound", 409);
    if (!descriptor || row.sha256 !== descriptor.sha256 || row.byte_length !== descriptor.byteLength || row.media_type !== descriptor.mediaType) fail("media_descriptor_mismatch");
    if (row.audio_seconds !== null && row.audio_seconds !== Math.ceil(Number(descriptor.durationMs) / 1000)) fail("media_descriptor_mismatch");
    db.prepare("UPDATE platform_media_objects SET task_id = ? WHERE id = ?").run(taskId, id);
  }
  function read({ id, owner, taskId }) {
    const row = rowFor(id, owner);
    if (!taskId || row.task_id !== taskId) fail("media_not_found", 404);
    const task = db.prepare("SELECT status FROM tasks WHERE id = ? AND owner = ?").get(taskId, owner);
    if (!task || task.status !== "running") fail("media_task_not_running", 409);
    let descriptor;
    try {
      descriptor = openSync(pathFor(id), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== row.byte_length + 32 || (stat.mode & 0o077) !== 0) fail("media_integrity_failed", 503);
      const stored = readFileSync(descriptor);
      if (stored.subarray(0, 4).toString() !== "AIM1") fail("media_integrity_failed", 503);
      const decipher = createDecipheriv("aes-256-gcm", key, stored.subarray(4, 16));
      decipher.setAAD(Buffer.from(JSON.stringify([id, owner, row.sha256, row.media_type])));
      decipher.setAuthTag(stored.subarray(16, 32));
      const bytes = Buffer.concat([decipher.update(stored.subarray(32)), decipher.final()]);
      if (digest(bytes) !== row.sha256) fail("media_integrity_failed", 503);
      return { ...view(row), bytes };
    } catch {
      fail("media_integrity_failed", 503);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  function remove(row) {
    try { unlinkSync(pathFor(row.id)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    db.prepare("UPDATE platform_media_objects SET deleted_at = ? WHERE id = ?").run(new Date(Number(clock())).toISOString(), row.id);
  }
  function discard({ id, owner }) {
    const row = db.prepare("SELECT * FROM platform_media_objects WHERE id = ? AND owner = ?").get(id, ownerValue(owner));
    if (!row) fail("media_not_found", 404);
    if (row.deleted_at) return { deleted: true };
    if (row.task_id) {
      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(row.task_id);
      if (task && !TERMINAL.has(task.status)) return { deleted: false };
    }
    remove(row);
    return { deleted: true };
  }
  function sweep() {
    const expired = db.prepare(`
      SELECT m.* FROM platform_media_objects m LEFT JOIN tasks t ON t.id = m.task_id
       WHERE m.deleted_at IS NULL AND (m.expires_at <= ? OR t.status IN ('succeeded','failed','cancelled','expired'))
    `).all(new Date(Number(clock())).toISOString());
    for (const row of expired) remove(row);
    let orphans = 0;
    let workspaces = 0;
    for (const file of readdirSync(root)) {
      if (/^sentelligent-pdf-vision-[A-Za-z0-9]{6}$/u.test(file)) {
        const path = join(root, file);
        const info = lstatSync(path);
        if (info.isDirectory() && !info.isSymbolicLink() && Number(clock()) - info.mtimeMs > ttlMs) {
          rmSync(path, { recursive: true, force: false });
          workspaces++;
        }
        continue;
      }
      if (!/^media-[0-9a-f-]{36}\.bin$/u.test(file)) continue;
      const id = file.slice(0, -4);
      if (!db.prepare("SELECT 1 FROM platform_media_objects WHERE id = ? AND deleted_at IS NULL").get(id)) {
        unlinkSync(pathFor(id));
        orphans++;
      }
    }
    return { removed: expired.length, orphans, workspaces };
  }
  return {
    put: (input) => withImmediateTransaction(db, () => put(input)),
    bind,
    read,
    discard: (input) => withImmediateTransaction(db, () => discard(input)),
    sweep: () => withImmediateTransaction(db, sweep),
  };
}
