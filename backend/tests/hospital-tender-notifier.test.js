import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHospitalTenderNotifier } from "../src/hospitalTender/notifier.js";

const fixtureValue = ["fixture", "pushplus", "value"].join("-");

describe("hospital tender PushPlus notifier", () => {
  it("sends only bounded aggregated summaries through the backend fixture", async () => {
    let request;
    const notifier = createHospitalTenderNotifier({
      token: fixtureValue,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, text: async () => JSON.stringify({ code: "200" }) };
      },
    });
    const count = await notifier({
      cycleNumber: 2,
      batchCustomerIds: ["customer-01", "customer-02"],
      notices: [{
        title: "医院信息化采购公告",
        sourceName: "公开采购平台",
        publishedAt: "2026-08-17T00:00:00.000Z",
        url: "https://example.com/notice",
        contentText: "must-not-be-sent",
      }],
    });
    assert.equal(count, 1);
    assert.equal(request.url, "https://www.pushplus.plus/send");
    const body = JSON.parse(request.options.body);
    assert.equal(body.token, fixtureValue);
    assert.match(body.content, /医院信息化采购公告/);
    assert.doesNotMatch(body.content, /must-not-be-sent/);
    assert.equal(typeof request.options.signal?.aborted, "boolean");
  });

  it("fails safely for provider rejection and timeout without exposing details", async () => {
    const rejected = createHospitalTenderNotifier({
      token: fixtureValue,
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => "provider-private" }),
    });
    await assert.rejects(
      () => rejected({ notices: [{ title: "公告" }] }),
      (error) => error.message === "notification rejected",
    );

    let signal;
    const stalled = createHospitalTenderNotifier({
      token: fixtureValue,
      timeoutMs: 5,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        signal = options.signal;
        signal.addEventListener("abort", () => reject(new DOMException("private", "AbortError")), { once: true });
      }),
    });
    await assert.rejects(
      () => stalled({ notices: [{ title: "公告" }] }),
      (error) => error.message === "notification unavailable",
    );
    assert.equal(signal.aborted, true);
  });

  it("does not instantiate without a server token", () => {
    assert.equal(createHospitalTenderNotifier({ token: "" }), null);
  });

  it("fails closed before sending when the bounded aggregate cannot contain every notice", async () => {
    let calls = 0;
    const notifier = createHospitalTenderNotifier({
      token: fixtureValue,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, text: async () => JSON.stringify({ code: "200" }) };
      },
    });
    const notices = Array.from({ length: 100 }, (_, index) => ({
      title: `${index}-${"信息化采购公告".repeat(40)}`,
      sourceName: "公开来源",
      publishedAt: "2026-08-17T00:00:00.000Z",
      url: "https://example.com/notice",
    }));
    await assert.rejects(() => notifier({ notices }), /notification content too large/);
    assert.equal(calls, 0);
  });
});
