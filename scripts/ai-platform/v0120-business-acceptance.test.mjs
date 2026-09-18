import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACCEPTANCE_STAGES,
  buildReport,
  parseArguments,
} from "./v0120-business-acceptance.mjs";

describe("v0.12.0 business acceptance runner", () => {
  it("keeps the four business contracts in fixed, local-only stages", () => {
    assert.deepEqual(
      ACCEPTANCE_STAGES.map((stage) => stage.id),
      ["customer-import", "hospital-tender-bridge", "action-risk-writeback", "contract-wiring"],
    );
    assert.ok(ACCEPTANCE_STAGES.every((stage) => stage.files.every((file) => file.endsWith(".test.js"))));
  });

  it("accepts only an explicit report path and help option", () => {
    assert.equal(parseArguments([]).help, false);
    assert.equal(parseArguments(["--help"]).help, true);
    assert.match(parseArguments(["--report=./tmp/report.json"]).reportPath, /tmp\/report\.json$/u);
    assert.throws(() => parseArguments(["--production"]), /Unsupported argument/u);
  });

  it("marks production, provider, notification, and iPhone boundaries explicitly", () => {
    const report = buildReport({
      commit: "a".repeat(40),
      startedAt: "2026-09-13T00:00:00.000Z",
      finishedAt: "2026-09-13T00:01:00.000Z",
      stages: ACCEPTANCE_STAGES.map((stage) => ({ id: stage.id, status: "passed" })),
    });
    assert.equal(report.status, "passed");
    assert.deepEqual(report.boundaries, {
      productionNetwork: false,
      externalProviderCalls: false,
      realNotifications: false,
      iphoneDeviceAcceptance: false,
    });
  });
});
