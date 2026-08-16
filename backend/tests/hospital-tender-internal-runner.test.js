import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  createInternalHospitalTenderRunner,
  InternalHospitalTenderRunError,
} from "../src/hospitalTender/internalRunner.js";

function validSnapshot() {
  return {
    schemaVersion: "hospital-tender-snapshot-v1",
    generatedAt: "2026-08-16T10:00:00.000Z",
    notices: [],
    sources: [],
    runs: [],
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

describe("internal hospital tender runner", () => {
  it("runs the bundled collector without forwarding credentials and validates its snapshot", async () => {
    let invocation;
    const runner = createInternalHospitalTenderRunner({
      collectorRoot: "/opt/sentelligent/vendor/hospital-tender-monitor",
      environment: {
        PATH: "/usr/bin",
        ["HOSPITAL_TENDER_" + "SYNC_TOKEN"]: "must-not-forward",
        ["SENTELLIGENT_HOSPITAL_TENDER_" + "SYNC_URL"]: "https://must-not-forward.example",
        ["PUSHPLUS_" + "TOKEN"]: "must-not-forward",
      },
      spawnImpl(command, args, options) {
        invocation = { command, args, options };
        const child = fakeChild();
        const output = args[args.indexOf("--output") + 1];
        void writeFile(output, `${JSON.stringify(validSnapshot())}\n`, "utf8").then(() => {
          queueMicrotask(() => child.emit("close", 0, null));
        });
        return child;
      },
    });

    const result = await runner.run();

    assert.deepEqual(result.payload, validSnapshot());
    assert.equal(invocation.command, "python3");
    assert.deepEqual(invocation.args.slice(0, 5), [
      "-m", "hospital_tender_monitor.cli", "--project-root", "/opt/sentelligent/vendor/hospital-tender-monitor", "run-and-export",
    ]);
    assert.equal(invocation.options.env.HOSPITAL_TENDER_MONITOR_DISABLE_NOTIFICATIONS, "1");
    assert.equal("HOSPITAL_TENDER_SYNC_TOKEN" in invocation.options.env, false);
    assert.equal("SENTELLIGENT_HOSPITAL_TENDER_SYNC_URL" in invocation.options.env, false);
    assert.equal("PUSHPLUS_TOKEN" in invocation.options.env, false);
  });

  it("fails closed when the collector exits unsuccessfully", async () => {
    const runner = createInternalHospitalTenderRunner({
      spawnImpl() {
        const child = fakeChild();
        queueMicrotask(() => child.emit("close", 1, null));
        return child;
      },
    });
    await assert.rejects(runner.run(), (error) => (
      error instanceof InternalHospitalTenderRunError
      && error.code === "HOSPITAL_TENDER_INTERNAL_RUN_FAILED"
    ));
  });

  it("rejects malformed snapshots even when the process succeeds", async () => {
    const runner = createInternalHospitalTenderRunner({
      spawnImpl(command, args) {
        const child = fakeChild();
        const output = args[args.indexOf("--output") + 1];
        void writeFile(output, JSON.stringify({ schemaVersion: "v2" }), "utf8").then(() => {
          queueMicrotask(() => child.emit("close", 0, null));
        });
        return child;
      },
    });
    await assert.rejects(runner.run(), /snapshot is invalid/);
  });
});
