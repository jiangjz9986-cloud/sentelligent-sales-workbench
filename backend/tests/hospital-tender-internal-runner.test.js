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
        HTTPS_PROXY: "http://host-proxy.invalid:8080",
        ALL_PROXY: "socks5://host-proxy.invalid:1080",
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

    const result = await runner.run({
      customerHospitals: [{
        id: "customer-1",
        name: "示例医院",
        city: "东营",
        region: "东营",
        status: "direct",
        source_ids: [],
        aliases: ["PACS"],
      }],
    });

    assert.deepEqual(result.payload, validSnapshot());
    assert.equal(invocation.command, "python3");
    assert.deepEqual(invocation.args.slice(0, 5), [
      "-m", "hospital_tender_monitor.cli", "--project-root", "/opt/sentelligent/vendor/hospital-tender-monitor", "run-and-export",
    ]);
    assert.equal(invocation.options.env.HOSPITAL_TENDER_MONITOR_DISABLE_NOTIFICATIONS, "1");
    assert.equal(invocation.options.env.NO_PROXY, "*");
    assert.equal(invocation.options.env.no_proxy, "*");
    assert.equal("HTTPS_PROXY" in invocation.options.env, false);
    assert.equal("ALL_PROXY" in invocation.options.env, false);
    assert.equal("HOSPITAL_TENDER_SYNC_TOKEN" in invocation.options.env, false);
    assert.equal("SENTELLIGENT_HOSPITAL_TENDER_SYNC_URL" in invocation.options.env, false);
    assert.equal("PUSHPLUS_TOKEN" in invocation.options.env, false);
    assert.match(invocation.options.env.HOSPITAL_TENDER_MONITOR_CUSTOMER_HOSPITALS_PATH, /customer_hospitals\.json$/u);
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
      && error.stage === "collector_exit"
      && error.message === "Internal hospital tender collector exited unsuccessfully"
    ));
  });

  it("classifies schema-invalid snapshots without exposing their contents", async () => {
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
    await assert.rejects(runner.run(), (error) => (
      error instanceof InternalHospitalTenderRunError
      && error.stage === "snapshot_normalize"
      && error.message === "Internal hospital tender snapshot validation failed"
      && !error.message.includes("v2")
    ));
  });

  it("distinguishes unreadable and malformed snapshot output", async () => {
    const unreadable = createInternalHospitalTenderRunner({
      spawnImpl() {
        const child = fakeChild();
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
    });
    await assert.rejects(unreadable.run(), (error) => (
      error instanceof InternalHospitalTenderRunError
      && error.stage === "snapshot_read"
      && error.message === "Internal hospital tender snapshot could not be read"
    ));

    const malformed = createInternalHospitalTenderRunner({
      spawnImpl(_command, args) {
        const child = fakeChild();
        const output = args[args.indexOf("--output") + 1];
        void writeFile(output, "{not-json", "utf8").then(() => {
          queueMicrotask(() => child.emit("close", 0, null));
        });
        return child;
      },
    });
    await assert.rejects(malformed.run(), (error) => (
      error instanceof InternalHospitalTenderRunError
      && error.stage === "snapshot_parse"
      && error.message === "Internal hospital tender snapshot is not valid JSON"
      && !error.message.includes("not-json")
    ));
  });

  it("fails within the configured timeout when the child never exits", async () => {
    let killed = [];
    const runner = createInternalHospitalTenderRunner({
      timeoutMs: 15,
      spawnImpl() {
        const child = fakeChild();
        child.kill = (signal) => { killed.push(signal); };
        return child;
      },
    });
    const startedAt = Date.now();
    await assert.rejects(runner.run(), (error) => (
      error instanceof InternalHospitalTenderRunError
      && error.stage === "collector_timeout"
      && /timed out/u.test(error.message)
    ));
    assert.ok(Date.now() - startedAt < 500);
    assert.deepEqual(killed, ["SIGTERM", "SIGKILL"]);
  });

  it("accepts a bounded registry larger than one matching batch", async () => {
    let customerRegistryPath;
    const runner = createInternalHospitalTenderRunner({
      spawnImpl(_command, args, options) {
        customerRegistryPath = options.env.HOSPITAL_TENDER_MONITOR_CUSTOMER_HOSPITALS_PATH;
        const child = fakeChild();
        const output = args[args.indexOf("--output") + 1];
        void writeFile(output, `${JSON.stringify(validSnapshot())}\n`, "utf8").then(() => {
          queueMicrotask(() => child.emit("close", 0, null));
        });
        return child;
      },
    });
    const registry = Array.from({ length: 201 }, (_, index) => ({
      id: `customer-${index + 1}`,
      name: `医院 ${index + 1}`,
      city: "东营",
      region: "东营",
      status: "direct",
      source_ids: [],
      aliases: [],
    }));
    await runner.run({ customerHospitals: registry });
    assert.match(customerRegistryPath, /customer_hospitals\.json$/u);
  });
});
