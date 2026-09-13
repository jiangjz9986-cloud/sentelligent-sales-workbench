import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const alertScript = fileURLToPath(new URL("./deploy/ops-alert.sh", import.meta.url));
const inspectScript = fileURLToPath(new URL("./deploy/ops-inspect.sh", import.meta.url));

function runScript(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [alertScript, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function startReceiver() {
  const requests = [];
  let statusCode = 503;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.statusCode = statusCode;
    response.end(JSON.stringify({ ok: statusCode >= 200 && statusCode < 300 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    setStatus(value) { statusCode = value; },
    endpoint: `http://127.0.0.1:${server.address().port}/api/integrations/ops-alerts`,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

describe("ops alert deferred delivery", () => {
  it("spools while Backend is unavailable and drains through the same Clawbot endpoint after recovery", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-ops-alert-script-"));
    const receiver = await startReceiver();
    try {
      const envFile = join(tempDir, "backend.env");
      const spoolDir = join(tempDir, "spool");
      await writeFile(envFile, "OPS_ALERT_TOKEN=fixture-ops-token\n", { mode: 0o600 });
      const env = {
        OPS_ALERT_ENV_FILE: envFile,
        OPS_ALERT_SPOOL_DIR: spoolDir,
        OPS_ALERT_ENDPOINT: receiver.endpoint,
        OPS_ALERT_MAX_SPOOL_FILES: "10",
        OPS_ALERT_EVENT_ID: "ops-inspect:backend:fixture-event",
        OPS_ALERT_OCCURRED_AT: "2026-09-13T04:00:00.000Z",
      };

      const deferred = await runScript([
        "--emit",
        "ops-inspect:backend",
        "critical",
        "后端暂时不可达",
        "保留告警并等待恢复",
      ], env);
      assert.equal(deferred.code, 0, deferred.stderr);
      assert.match(deferred.stderr, /payload spooled/u);
      assert.equal(receiver.requests.length, 1);
      assert.equal(receiver.requests[0].authorization, "Bearer fixture-ops-token");

      const filesAfterSpool = (await readdir(spoolDir)).filter((name) => name.endsWith(".json"));
      assert.equal(filesAfterSpool.length, 1);
      const spoolPath = join(spoolDir, filesAfterSpool[0]);
      assert.equal((await stat(spoolPath)).mode & 0o777, 0o600);
      const spooledPayload = JSON.parse(await readFile(spoolPath, "utf8"));
      assert.deepEqual(spooledPayload, {
        source: "ops-inspect:backend",
        severity: "critical",
        summary: "后端暂时不可达",
        detail: "保留告警并等待恢复",
        eventId: "ops-inspect:backend:fixture-event",
        occurredAt: "2026-09-13T04:00:00.000Z",
      });

      const stillUnavailable = await runScript(["--drain"], env);
      assert.notEqual(stillUnavailable.code, 0);
      assert.equal((await readdir(spoolDir)).filter((name) => name.endsWith(".json")).length, 1);

      receiver.setStatus(200);
      const drained = await runScript(["--drain"], env);
      assert.equal(drained.code, 0, drained.stderr);
      assert.match(drained.stderr, /spool drained: 1/u);
      assert.equal((await readdir(spoolDir)).filter((name) => name.endsWith(".json")).length, 0);
      assert.equal(receiver.requests.length, 3, "initial post, failed drain, and successful drain are all observable");
      assert.deepEqual(JSON.parse(receiver.requests.at(-1).body), spooledPayload);
    } finally {
      await receiver.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the operations path single-channel and delegates inspections to the shared spooler", async () => {
    const source = await readFile(alertScript, "utf8");
    const inspectSource = await readFile(inspectScript, "utf8");
    assert.doesNotMatch(source, /pushplus/iu);
    assert.doesNotMatch(inspectSource, /pushplus/iu);
    assert.match(inspectSource, /OPS_ALERT_SCRIPT=/u);
    assert.match(inspectSource, /--drain/u);
    assert.match(inspectSource, /--emit/u);
  });
});
