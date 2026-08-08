import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AssistantContractError,
  validateToolInvocation,
} from "../src/assistant/contracts.js";

describe("assistant tool contracts", () => {
  it("normalizes a safe tool invocation", () => {
    const result = validateToolInvocation({
      agentId: "customer",
      toolName: "customer.search",
      arguments: { query: "医院" },
    });
    assert.deepEqual(result, {
      agentId: "customer",
      toolName: "customer.search",
      arguments: { query: "医院" },
    });
  });

  it("rejects model-controlled identity, transport, query, and path fields", () => {
    for (const key of ["owner", "actor", "token", "url", "httpMethod", "sql", "filePath"]) {
      assert.throws(
        () => validateToolInvocation({ agentId: "customer", toolName: "customer.search", arguments: { query: "x", [key]: "unsafe" } }),
        AssistantContractError,
      );
    }
  });

  it("rejects path-like argument values and non-plain argument objects", () => {
    assert.throws(
      () => validateToolInvocation({ agentId: "invoice", toolName: "invoice.ingest", arguments: { document: "C:\\secret\\invoice.pdf" } }),
      /path|unsafe/i,
    );
    assert.throws(
      () => validateToolInvocation({ agentId: "customer", toolName: "customer.search", arguments: [] }),
      AssistantContractError,
    );
  });

  it("rejects prototype-pollution keys at any argument depth", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const argumentsValue = JSON.parse(`{"safe":{"${key}":{"polluted":true}}}`);
      assert.throws(
        () => validateToolInvocation({ agentId: "customer", toolName: "customer.search", arguments: argumentsValue }),
        (error) => error instanceof AssistantContractError && error.code === "forbidden_field",
      );
    }
  });
});
