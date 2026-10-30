import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const scriptPath = new URL("./deploy/ops-inspect.sh", import.meta.url);
const alertPath = fileURLToPath(new URL("./deploy/ops-alert.sh", import.meta.url));

function healthyStatus() {
  return {
    item: {
      schedulers: {
        hospitalTender: { enabled: true, lastStatus: "success", lastError: null },
        dailyDigest: { lastError: null },
      },
      weixinDelivery: { status: "ready" },
    },
  };
}

async function inspectionFixture() {
  const root = await mkdtemp(join(tmpdir(), "sentelligent-ops-inspect-"));
  const bin = join(root, "bin");
  const nodeDir = join(root, "runtime/node-v24/bin");
  const configPath = join(root, "fixture.json");
  const postPath = join(root, "posts.jsonl");
  const statePath = join(root, "tools/.ops-inspect-incidents/state.json");
  const spoolDir = join(root, "tools/ops-alert-spool");
  const backup = join(root, "backups/daily/fixture.sqlite");
  let config = {
    now: "2026-10-24T04:00:00.000Z",
    workerActive: true,
    statusCode: 200,
    statusBody: healthyStatus(),
    postCode: 200,
    outbox: "2026-10-23T00:00:00.000Z|2",
  };
  await mkdir(bin);
  await mkdir(nodeDir, { recursive: true });
  await mkdir(join(root, "tools"));
  await mkdir(dirname(backup), { recursive: true });
  await writeFile(backup, "synthetic backup");
  await utimes(backup, new Date(config.now), new Date(config.now));
  await writeFile(join(root, "backend.env"), "OPS_ALERT_TOKEN=synthetic-ops-token\n", { mode: 0o600 });
  const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.env.OPS_FIXTURE_CONFIG, 'utf8'));
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
if (command === 'systemctl') {
  if (args[0] === 'is-active') process.exit(config.workerActive ? 0 : 3);
  console.log('synthetic worker stopped');
} else if (command === 'node') {
  console.log(config.outbox);
} else if (command === 'date') {
  const date = new Date(config.now);
  const iso = date.toISOString();
  const format = args.at(-1);
  if (format === '+%s') console.log(Math.floor(date.getTime() / 1000));
  else if (format.includes('%Y-%m-%d')) console.log(iso);
  else {
    const compact = iso.replace(/[-:]/g, '').slice(0, 15);
    console.log(format.endsWith('%H') ? compact.slice(0, 11) : compact);
  }
} else if (command === 'stat') {
  console.log(Math.floor(fs.statSync(args.at(-1)).mtimeMs / 1000));
} else if (command === 'curl') {
  const post = args.indexOf('--data');
  if (post >= 0) {
    fs.appendFileSync(process.env.OPS_FIXTURE_POSTS, JSON.stringify(JSON.parse(args[post + 1])) + '\\n');
    process.stdout.write(String(config.postCode));
    process.exit(config.postExit || 0);
  }
  const body = typeof config.statusBody === 'string' ? config.statusBody : JSON.stringify(config.statusBody);
  const outputIndex = args.indexOf('-o');
  if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], body);
  else process.stdout.write(body);
  const formatIndex = args.indexOf('-w');
  if (formatIndex >= 0) process.stdout.write(args[formatIndex + 1].replace('%{http_code}', String(config.statusCode)));
  process.exit(config.statusExit || 0);
} else {
  throw new Error('unexpected fixture command: ' + command);
}
`;
  for (const command of ["systemctl", "curl", "date", "stat"]) {
    await writeFile(join(bin, command), mock, { mode: 0o700 });
  }
  await writeFile(join(nodeDir, "node"), mock, { mode: 0o700 });
  await writeFile(join(bin, "ops-alert"), `#!/usr/bin/env bash
if [[ "\${OPS_FIXTURE_KILL_INSPECTOR_AFTER_EMIT:-0}" == 1 && "\${1:-}" == --emit ]]; then
  bash "$OPS_FIXTURE_ALERT" "$@"
  kill -KILL "$PPID"
  exit 1
fi
exec bash "$OPS_FIXTURE_ALERT" "$@"
`, { mode: 0o700 });
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`,
    LANG: "C",
    LC_ALL: "C",
    HOME: root,
    SENTELLIGENT_ROOT: root,
    OPS_ALERT_SCRIPT: join(bin, "ops-alert"),
    OPS_FIXTURE_ALERT: alertPath,
    OPS_ALERT_ENV_FILE: join(root, "backend.env"),
    OPS_ALERT_SPOOL_DIR: spoolDir,
    OPS_ALERT_MAX_SPOOL_FILES: "10",
    OPS_FIXTURE_CONFIG: configPath,
    OPS_FIXTURE_POSTS: postPath,
  };
  return {
    root, statePath, spoolDir, backup,
    async run(patch = {}, extraEnv = {}, expectedSignal = null) {
      config = { ...config, ...patch };
      await writeFile(configPath, JSON.stringify(config));
      const result = spawnSync("bash", [scriptPath.pathname], { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 20000 });
      if (expectedSignal) assert.equal(result.signal, expectedSignal, result.stderr);
      else assert.equal(result.status, 0, result.stderr || result.error?.message);
      return result;
    },
    async posts() {
      const text = await readFile(postPath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
    },
    async state() { return JSON.parse(await readFile(statePath, "utf8")); },
    async spool() {
      return Promise.all((await readdir(spoolDir).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(spoolDir, name), "utf8"))));
    },
    async close() { await rm(root, { recursive: true, force: true }); },
  };
}

function partialStatus() {
  const status = healthyStatus();
  status.item.schedulers.hospitalTender = {
    enabled: true,
    lastStatus: "partial",
    lastError: "部分公开来源失败",
    sourceHealth: { total: 4, healthy: 3, degraded: 0, error: 1 },
    affectedSourceIds: ["fixture-source"],
    affectedCustomerCount: 2,
  };
  return status;
}

describe("ops inspection script", () => {
  it("ignores lifecycle-terminal outbox rows when advancing the failed watermark", async () => {
    const source = await readFile(scriptPath, "utf8");
    const query = source.split("\n").find((line) => line.includes("SELECT COALESCE(MAX(updated_at)"));
    assert.ok(query, "failed-watermark query must remain present");
    for (const code of [
      "WEIXIN_OUTBOX_STALE",
      "WEIXIN_OUTBOX_SUPERSEDED",
      "WEIXIN_OUTBOX_CANCELLED",
    ]) {
      assert.match(query, new RegExp(code, "u"));
    }
    assert.match(query, /COALESCE\(last_error_code,''\) NOT IN/u);
  });

  it("remains valid bash after the watermark query changes", () => {
    const result = spawnSync("bash", ["-n", scriptPath.pathname], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });

  it("opens one warning for a partial failure, persists its incident, and deduplicates across hour rolls and restarts", async () => {
    const fixture = await inspectionFixture();
    try {
      await fixture.run({ statusBody: partialStatus() });
      let posts = await fixture.posts();
      assert.equal(posts.length, 1);
      assert.equal(posts[0].severity, "warning");
      assert.match(posts[0].detail, /fixture-source/u);
      assert.match(posts[0].detail, /affectedCustomerCount=2/u);
      await fixture.run({ now: "2026-10-24T05:05:00.000Z" });
      posts = await fixture.posts();
      assert.equal(posts.length, 1, "the same incident must not create a new hourly notification");
      const state = await fixture.state();
      const incident = state.incidents["ops-inspect:scheduler-hospitalTender"];
      assert.equal(incident.firstFailureAt, "2026-10-24T04:00:00.000Z");
      assert.equal(incident.consecutiveFailures, 2);
      assert.equal(incident.severity, "warning");
      assert.equal((await stat(fixture.statePath)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(fixture.statePath))).mode & 0o777, 0o700);
    } finally { await fixture.close(); }
  });

  it("escalates persistent partial failure once, records recovery once, and starts a fresh later incident", async () => {
    const fixture = await inspectionFixture();
    try {
      await fixture.run({ statusBody: partialStatus() });
      await fixture.run({ now: "2026-10-24T04:05:00.000Z" });
      await fixture.run({ now: "2026-10-24T04:10:00.000Z" });
      await fixture.run({ now: "2026-10-24T05:10:00.000Z" });
      let posts = await fixture.posts();
      assert.deepEqual(posts.map((post) => post.severity), ["warning", "critical"]);
      assert.match(posts[1].detail, /consecutiveFailures=3/u);
      assert.notEqual(posts[0].eventId, posts[1].eventId);
      await fixture.run({ statusBody: healthyStatus(), now: "2026-10-24T05:15:00.000Z" });
      await fixture.run({ now: "2026-10-24T05:20:00.000Z" });
      posts = await fixture.posts();
      assert.equal(posts.length, 3);
      assert.match(posts[2].summary, /恢复/u);
      assert.match(posts[2].eventId, /:recovered$/u);
      assert.match(posts[2].detail, /consecutiveFailures=4/u);
      const closed = (await fixture.state()).incidents[posts[0].source];
      assert.equal(closed.recoveredAt, "2026-10-24T05:15:00.000Z");
      await fixture.run({ statusBody: partialStatus(), now: "2026-10-24T05:25:00.000Z" });
      posts = await fixture.posts();
      assert.equal(posts.length, 4);
      assert.equal(posts[3].severity, "warning");
      assert.notEqual(posts[3].eventId, posts[0].eventId);
    } finally { await fixture.close(); }
  });

  it("marks a failed scheduler or a complete source outage critical immediately", async () => {
    for (const completeSourceOutage of [false, true]) {
      const fixture = await inspectionFixture();
      try {
        const body = partialStatus();
        if (completeSourceOutage) {
          body.item.schedulers.hospitalTender.sourceHealth = { total: 4, healthy: 0, degraded: 0, error: 4 };
        } else {
          body.item.schedulers.hospitalTender.lastStatus = "failed";
          body.item.schedulers.hospitalTender.lastError = "synthetic collector unavailable";
        }
        await fixture.run({ statusBody: body });
        assert.deepEqual((await fixture.posts()).map((post) => post.severity), ["critical"]);
      } finally { await fixture.close(); }
    }
  });

  it("treats non-2xx, malformed JSON, missing item, and invalid status shapes as backend failures", async () => {
    for (const patch of [
      { statusCode: 503 },
      { statusCode: 401, statusBody: { error: { code: "UNAUTHORIZED" } } },
      { statusBody: "{broken" },
      { statusBody: {} },
      { statusBody: { item: null } },
      { statusBody: { item: {} } },
      { statusBody: { item: { schedulers: [], weixinDelivery: { status: "ready" } } } },
      { statusExit: 28 },
    ]) {
      const fixture = await inspectionFixture();
      try {
        await fixture.run(patch);
        const posts = await fixture.posts();
        assert.equal(posts.length, 1, JSON.stringify(patch));
        assert.equal(posts[0].source, "ops-inspect:backend");
        assert.equal(posts[0].severity, "critical");
      } finally { await fixture.close(); }
    }
  });

  it("does not recover child incidents while the backend observation is unavailable", async () => {
    const fixture = await inspectionFixture();
    try {
      await fixture.run({ statusBody: partialStatus() });
      await fixture.run({ statusCode: 503, statusBody: {} });
      const incident = (await fixture.state()).incidents["ops-inspect:scheduler-hospitalTender"];
      assert.equal(incident.recoveredAt, null);
      assert.equal(incident.consecutiveFailures, 1);
      assert.equal((await fixture.posts()).filter((post) => post.eventId.endsWith(":recovered")).length, 0);
    } finally { await fixture.close(); }
  });

  it("keeps an incident open while a new scheduler run clears lastError before finishing", async () => {
    const fixture = await inspectionFixture();
    try {
      await fixture.run({ statusBody: partialStatus() });
      for (const lastStatus of ["running", "waiting", "disabled", "idle"]) {
        const body = healthyStatus();
        body.item.schedulers.hospitalTender.lastStatus = lastStatus;
        await fixture.run({ statusBody: body });
      }
      assert.equal((await fixture.posts()).length, 1, "only a successful run proves scheduler recovery");
      const incident = (await fixture.state()).incidents["ops-inspect:scheduler-hospitalTender"];
      assert.equal(incident.recoveredAt, null);
      assert.equal(incident.consecutiveFailures, 1, "unfinished work is not another failed observation");
      await fixture.run({ statusBody: partialStatus() });
      assert.equal((await fixture.posts()).length, 1);
    } finally { await fixture.close(); }
  });

  it("retains stable warning and recovery events in spool across POST failure and process restarts", async () => {
    const fixture = await inspectionFixture();
    try {
      await fixture.run({ statusBody: partialStatus(), postCode: 503 });
      const initial = (await fixture.spool())[0];
      assert.ok(initial.eventId);
      await fixture.run({ now: "2026-10-24T05:00:00.000Z" });
      assert.equal((await fixture.spool()).length, 1, "a restart must not spool another warning");
      await fixture.run({ statusBody: healthyStatus(), now: "2026-10-24T05:05:00.000Z" });
      const spooled = await fixture.spool();
      assert.equal(spooled.length, 2, "recovery must be durable even while POST is unavailable");
      const recovery = spooled.find((post) => post.eventId.endsWith(":recovered"));
      assert.ok(recovery);
      await fixture.run({ postCode: 200 });
      assert.equal((await fixture.spool()).length, 0);
      const posts = await fixture.posts();
      assert.deepEqual(posts.filter((post) => post.eventId === initial.eventId).at(-1), initial);
      assert.deepEqual(posts.filter((post) => post.eventId === recovery.eventId).at(-1), recovery);
      assert.equal(new Set(posts.map((post) => post.eventId)).size, 2);
    } finally { await fixture.close(); }
  });

  it("keeps undeliverable events in local state when the spool is full and replays the frozen event after recovery", async () => {
    const fixture = await inspectionFixture();
    try {
      await fixture.run({ statusBody: partialStatus(), postCode: 503 }, { OPS_ALERT_MAX_SPOOL_FILES: "0" });
      const queued = (await fixture.state()).pending;
      assert.equal(queued.length, 1);
      await fixture.run({ postCode: 200, now: "2026-10-24T05:00:00.000Z" });
      assert.equal((await fixture.state()).pending.length, 0);
      assert.deepEqual((await fixture.posts()).at(-1), queued[0]);
    } finally { await fixture.close(); }
  });

  it("replays the identical event after POST acceptance followed by an inspector crash before acknowledgement", async () => {
    const fixture = await inspectionFixture();
    try {
      await fixture.run({ statusBody: partialStatus() }, { OPS_FIXTURE_KILL_INSPECTOR_AFTER_EMIT: "1" }, "SIGKILL");
      const posts = await fixture.posts();
      assert.equal(posts.length, 1);
      assert.deepEqual((await fixture.state()).pending, posts, "the frozen payload must precede the POST");
      await fixture.run({ now: "2026-10-24T05:00:00.000Z" });
      assert.deepEqual((await fixture.posts()).at(-1), posts[0]);
      assert.equal(new Set((await fixture.posts()).map((post) => post.eventId)).size, 1);
      assert.equal((await fixture.state()).pending.length, 0);
    } finally { await fixture.close(); }
  });

  it("spools an ambiguously accepted POST and retries its stable key after a restart", async () => {
    const fixture = await inspectionFixture();
    try {
      await fixture.run({ statusBody: partialStatus(), postExit: 28 });
      const initial = (await fixture.posts())[0];
      assert.deepEqual(await fixture.spool(), [initial]);
      await fixture.run({ postExit: 0, now: "2026-10-24T05:00:00.000Z" });
      assert.deepEqual((await fixture.posts()).at(-1), initial);
      assert.equal((await fixture.spool()).length, 0);
      assert.equal(new Set((await fixture.posts()).map((post) => post.eventId)).size, 1);
    } finally { await fixture.close(); }
  });

  it("initializes an empty outbox watermark and alerts on the first later failed row", async () => {
    const fixture = await inspectionFixture();
    try {
      await fixture.run({ outbox: "|0" });
      assert.equal((await fixture.posts()).length, 0);
      await fixture.run({ outbox: "2026-10-24T04:00:00.000Z|1", postCode: 503 }, { OPS_ALERT_MAX_SPOOL_FILES: "0" });
      const queued = (await fixture.state()).pending;
      assert.equal(queued.length, 1);
      assert.equal(queued[0].source, "ops-inspect:outbox-failed");
      await fixture.run({ postCode: 200 });
      assert.deepEqual((await fixture.posts()).at(-1), queued[0], "advancing the watermark must not lose a pending alert");
    } finally { await fixture.close(); }
  });

  it("preserves the legacy outbox watermark, worker checks, and 26-hour backup freshness", async () => {
    const fixture = await inspectionFixture();
    try {
      const legacy = join(fixture.root, "tools/.ops-inspect-state");
      await writeFile(legacy, "outbox_failed_mark=2026-10-23T00:00:00.000Z\n", { mode: 0o600 });
      await fixture.run();
      assert.equal((await fixture.posts()).length, 0, "historical outbox failures do not alert");
      await utimes(fixture.backup, new Date("2026-10-20T00:00:00.000Z"), new Date("2026-10-20T00:00:00.000Z"));
      await fixture.run({ outbox: "2026-10-24T04:00:00.000Z|3", workerActive: false });
      const posts = await fixture.posts();
      assert.deepEqual(new Set(posts.map((post) => post.source)), new Set([
        "ops-inspect:outbox-failed", "ops-inspect:weixin-worker", "ops-inspect:backup-freshness",
      ]));
      assert.match(await readFile(legacy, "utf8"), /outbox_failed_mark=2026-10-24T04:00:00.000Z/u);
      await fixture.run();
      assert.equal((await fixture.posts()).length, 3);
      await fixture.run({ outbox: "2026-10-24T04:05:00.000Z|4" });
      assert.equal((await fixture.posts()).length, 4, "a genuinely newer outbox failure still alerts even when older failed rows remain");
      assert.equal((await fixture.posts()).at(-1).source, "ops-inspect:outbox-failed");
    } finally { await fixture.close(); }
  });
});
