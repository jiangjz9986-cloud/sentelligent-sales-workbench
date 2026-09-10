import { AiPlatformError } from "../errors.js";
import { iso, withImmediateTransaction } from "../utils.js";

export function readOperationalControl(db) {
  const row = db.prepare("SELECT paused, generation, updated_at FROM platform_control WHERE id = 1").get();
  if (!row) throw new AiPlatformError("platform control unavailable", { code: "control_unavailable", status: 503 });
  return { paused: row.paused === 1, generation: row.generation, updatedAt: row.updated_at };
}

export function updateOperationalControl(db, { paused, expectedGeneration, identity, clock } = {}) {
  if (typeof paused !== "boolean" || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new AiPlatformError("control generation and state are required", { code: "invalid_request", status: 400 });
  }
  const scopes = new Set(identity?.scopes ?? []);
  if (!scopes.has("ai:ops:write") && !scopes.has("ai:admin:*")) {
    throw new AiPlatformError("operation permission required", { code: "forbidden", status: 403 });
  }
  const issuer = identity?.issuer;
  const actor = identity?.actor;
  if ([issuer, actor].some((value) => typeof value !== "string" || !value || value.length > 400 || /[\u0000-\u001f\u007f]/u.test(value))) {
    throw new AiPlatformError("operation identity is invalid", { code: "invalid_auth", status: 401 });
  }
  return withImmediateTransaction(db, () => {
    const current = readOperationalControl(db);
    if (current.generation !== expectedGeneration) {
      throw new AiPlatformError("operation generation changed", { code: "control_conflict", status: 409 });
    }
    if (!paused && db.prepare("SELECT COUNT(*) n FROM tasks WHERE status = 'running'").get().n > 0) {
      throw new AiPlatformError("active attempts must settle before resume", { code: "drain_incomplete", status: 409 });
    }
    const at = iso(clock);
    const generation = current.generation + 1;
    if (!Number.isSafeInteger(generation)) throw new AiPlatformError("control generation exhausted", { code: "control_conflict", status: 409 });
    db.prepare("UPDATE platform_control SET paused = ?, generation = ?, updated_at = ? WHERE id = 1")
      .run(Number(paused), generation, at);
    db.prepare("INSERT INTO platform_control_events (generation, paused, issuer, actor, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .run(generation, Number(paused), issuer, actor, at);
    return readOperationalControl(db);
  });
}
