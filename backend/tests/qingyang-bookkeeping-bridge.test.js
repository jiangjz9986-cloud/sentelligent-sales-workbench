import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createQingyangBookkeepingBridge } from "../src/integrations/qingyangBookkeepingBridge.js";

const url = "http://127.0.0.1:8797/api/integrations/sentelligent/bookkeeping";
const token = ["test", "qingyang", "bridge", "private"].join("-");

function input(overrides = {}) {
  return {
    owner: "account-a",
    text: "美团到账 128.50元",
    capturedAt: "2026-08-17T20:30:00+08:00",
    idempotencyKey: "shortcut-key-1",
    entryType: "income",
    category: "营收",
    subcategory: "美团",
    note: "晚班",
    ...overrides,
  };
}

describe("Qingyang bookkeeping bridge", () => {
  it("uses the exact loopback endpoint, isolated header, and namespaced idempotency key", async () => {
    const calls = [];
    const bridge = createQingyangBookkeepingBridge({
      url,
      token,
      timeoutMs: 5_000,
      fetchImpl: async (requestUrl, options) => {
        calls.push({ requestUrl, options });
        return new Response(JSON.stringify({
          id: 41,
          doc_no: "BK-000041",
          status: "pending",
          replayed: false,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      },
    });

    const result = await bridge.forward(input());

    assert.equal(bridge.isConfigured(), true);
    assert.deepEqual(result, {
      id: "41",
      reference: "BK-000041",
      status: "pending",
      replayed: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].requestUrl, url);
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.redirect, "manual");
    assert.equal(calls[0].options.headers["X-Qingyang-Sentelligent-Bridge-Token"], token);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.source, "sentelligent-shortcut");
    assert.equal(body.ledger_name, "biubiu");
    assert.equal(body.entry_type, "income");
    assert.equal(body.category, "营收");
    assert.equal(body.subcategory, "美团");
    assert.equal(body.note, "晚班");
    assert.match(body.idempotency_key, /^sentelligent-shortcut:[a-f0-9]{64}$/u);
    assert.equal(calls[0].options.headers["Idempotency-Key"], body.idempotency_key);
  });

  it("fails closed when disabled, redirected, unauthorized, malformed, or unavailable", async () => {
    const disabled = createQingyangBookkeepingBridge({ url: "", token: "" });
    assert.equal(disabled.isConfigured(), false);
    await assert.rejects(disabled.forward(input()), (error) => (
      error?.status === 503 && error?.code === "QINGYANG_BRIDGE_UNAVAILABLE"
    ));

    for (const response of [
      new Response("", { status: 302, headers: { Location: "http://127.0.0.1:8798/" } }),
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      new Response("not-json", { status: 202 }),
    ]) {
      const bridge = createQingyangBookkeepingBridge({
        url,
        token,
        fetchImpl: async () => response,
      });
      await assert.rejects(bridge.forward(input()), (error) => (
        error?.status === 503 && error?.code === "QINGYANG_BRIDGE_UNAVAILABLE"
      ));
    }

    const unavailable = createQingyangBookkeepingBridge({
      url,
      token,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    await assert.rejects(unavailable.forward(input()), (error) => (
      error?.status === 503 && error?.code === "QINGYANG_BRIDGE_UNAVAILABLE"
    ));
  });

  it("rejects unsafe configuration before any request", () => {
    assert.throws(
      () => createQingyangBookkeepingBridge({
        url: "https://82.156.210.199/qingyang/api/integrations/sentelligent/bookkeeping",
        token,
      }),
      /loopback|exact/u,
    );
  });
});
