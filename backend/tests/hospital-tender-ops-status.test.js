import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hospitalTenderSourceStatus } from "../src/hospitalTender/opsStatus.js";

const sourceId = (url) => `customer-url-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;

test("ops source counts exclude disabled sources and count affected customers once", () => {
  const url = "https://public.example.test/list";
  const other = "https://hospital.example.test/notices";
  assert.deepEqual(hospitalTenderSourceStatus({
    sources: [
      { sourceId: sourceId(url), status: "error" },
      { sourceId: sourceId(other), status: "degraded" },
      { sourceId: "healthy", status: "healthy" },
      { sourceId: "disabled", status: "disabled" },
    ],
    customers: [
      { id: "a", tenderSources: [{ url }, { url: other }] },
      { id: "b", tenderSources: [{ url }] },
      { id: "c", tenderSources: [] },
    ],
  }), {
    sourceHealth: { total: 3, healthy: 1, degraded: 1, error: 1 },
    affectedSourceIds: [sourceId(url), sourceId(other)].sort(),
    affectedCustomerCount: 2,
  });
});

test("unmapped built-in source coverage remains unknown instead of inventing an affected count", () => {
  assert.deepEqual(hospitalTenderSourceStatus({ sources: [{ sourceId: "regional-built-in", status: "error" }] }), {
    sourceHealth: { total: 1, healthy: 0, degraded: 0, error: 1 },
    affectedSourceIds: ["regional-built-in"], affectedCustomerCount: null,
  });
  assert.deepEqual(hospitalTenderSourceStatus(), {
    sourceHealth: { total: 0, healthy: 0, degraded: 0, error: 0 },
    affectedSourceIds: [], affectedCustomerCount: 0,
  });
});
