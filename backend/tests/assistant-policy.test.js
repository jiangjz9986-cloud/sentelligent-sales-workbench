import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DENY_LIST,
  RISK_LEVELS,
  evaluatePolicy,
  getToolPolicy,
} from "../src/assistant/policy.js";

describe("assistant execution policy", () => {
  it("classifies read, preview, ordinary write, and financial tools", () => {
    assert.equal(getToolPolicy("customer.search").risk, RISK_LEVELS.R0);
    assert.equal(getToolPolicy("reimbursement-report.preview").risk, RISK_LEVELS.R1);
    assert.equal(getToolPolicy("visit-capture.confirm").risk, RISK_LEVELS.R2);
    assert.equal(getToolPolicy("invoice.ingest").risk, RISK_LEVELS.R1);
    assert.equal(getToolPolicy("invoice.ingest").confirmation, "none");
    assert.equal(getToolPolicy("visit-capture.confirm").confirmation, "simple");
    assert.equal(getToolPolicy("travel-expense.create").risk, RISK_LEVELS.R3);
    assert.equal(getToolPolicy("travel-expense.create").confirmation, "explicit_code");
  });

  it("denies transport, shell, and database tools", () => {
    for (const name of ["http.request", "sql.query", "shell.exec"]) {
      assert.equal(DENY_LIST.has(name), true);
      assert.equal(evaluatePolicy({ toolName: name }).allowed, false);
    }
  });

  it("requires confirmation for writes while preserving immediate inbox capture", () => {
    assert.deepEqual(evaluatePolicy({ toolName: "customer.search" }), {
      allowed: true,
      risk: "R0",
      confirmation: "none",
      requiresConfirmation: false,
      reason: "read_only",
    });
    assert.equal(evaluatePolicy({ toolName: "visit-capture.confirm" }).requiresConfirmation, true);
    assert.equal(evaluatePolicy({ toolName: "visit-capture.confirm" }).confirmation, "simple");
    assert.equal(evaluatePolicy({ toolName: "payment-proof.ingest" }).allowed, true);
    assert.equal(evaluatePolicy({ toolName: "payment-proof.ingest" }).requiresConfirmation, false);
    assert.equal(evaluatePolicy({ toolName: "invoice.ingest" }).requiresConfirmation, false);
    assert.equal(evaluatePolicy({ toolName: "visit-capture.confirm", confirmed: true }).requiresConfirmation, false);
    assert.equal(evaluatePolicy({ toolName: "travel-expense.create" }).requiresConfirmation, true);
  });

  it("fails closed for every unregistered tool", () => {
    assert.equal(evaluatePolicy({ toolName: "unknown.mutate" }).allowed, false);
    assert.equal(evaluatePolicy({ toolName: "unknown.mutate" }).reason, "unregistered_tool");
  });
});
