import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHospitalTenderNotifier } from "../src/hospitalTender/notifier.js";

const fixtureValue = ["fixture", "pushplus", "value"].join("-");

function providerResponse() {
  return new Response(JSON.stringify({ code: "200" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function notices(count) {
  return Array.from({ length: count }, (_, index) => ({
    title: `医院信息化采购公告 ${index + 1}`,
    sourceName: "公开采购平台",
    publishedAt: "2026-08-17T00:00:00.000Z",
    url: `https://example.com/notice/${index + 1}`,
  }));
}

describe("hospital tender PushPlus notifier", () => {
  it("sends only bounded aggregated summaries through the backend fixture", async () => {
    let request;
    const notifier = createHospitalTenderNotifier({
      token: fixtureValue,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return providerResponse();
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
    assert.equal(request.options.redirect, "error");
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

  it("splits an oversized aggregate into bounded requests without dropping notices", async () => {
    const requests = [];
    const notifier = createHospitalTenderNotifier({
      token: fixtureValue,
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return providerResponse();
      },
    });
    assert.equal(await notifier({ notices: notices(120) }), 120);
    assert.equal(requests.length, 2);
    assert.equal(requests.every((body) => body.content.length <= 20_000), true);
    assert.match(requests[0].title, /1\/2/u);
    assert.match(requests[1].title, /2\/2/u);
  });

  it("uses at-least-once chunk retries after a later chunk fails", async () => {
    const requests = [];
    let calls = 0;
    const notifier = createHospitalTenderNotifier({
      token: fixtureValue,
      fetchImpl: async (_url, options) => {
        calls += 1;
        requests.push(options.body);
        if (calls === 2) return new Response("provider-private", { status: 503 });
        return providerResponse();
      },
    });
    const batch = notices(120);
    await assert.rejects(() => notifier({ notices: batch }), /notification rejected/);
    assert.equal(await notifier({ notices: batch }), 120);
    assert.equal(calls, 4);
    assert.equal(requests[0], requests[2]);
  });

  it("rejects redirected responses and cancels an over-limit response stream", async () => {
    const redirectedBody = providerResponse().body;
    const redirected = createHospitalTenderNotifier({
      token: fixtureValue,
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, "error");
        return { ok: true, redirected: true, headers: new Headers(), body: redirectedBody };
      },
    });
    await assert.rejects(() => redirected({ notices: notices(1) }), /notification rejected/);

    let cancelled = false;
    const chunk = new Uint8Array(20 * 1024).fill(0x61);
    const stream = new ReadableStream({
      start(controller) {
        for (let index = 0; index < 4; index += 1) controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const oversized = createHospitalTenderNotifier({
      token: fixtureValue,
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    await assert.rejects(() => oversized({ notices: notices(1) }), /notification response invalid/);
    assert.equal(cancelled, true);
  });
});
