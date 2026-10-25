import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db.js";
import { createHospitalTenderPushplusDeliveryRepository } from "../src/hospitalTender/pushplusDeliveryRepository.js";
import { createHospitalTenderPushplusNotifier } from "../src/hospitalTender/pushplusNotifier.js";

for (const [label, json] of [
  ["truncated body", async () => { throw new SyntaxError("synthetic truncated body"); }],
  ["body timeout", async () => { throw new Error("synthetic body timeout"); }],
  ["missing receipt", async () => ({ code: 200 })],
  ["unrecognized response", async () => ({ message: "unknown" })],
]) {
  test(`PushPlus ${label} remains uncertain and is not blindly posted twice`, async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    let calls = 0;
    const repository = createHospitalTenderPushplusDeliveryRepository(db);
    const notifier = createHospitalTenderPushplusNotifier({
      token: "synthetic-token", deliveryRepository: repository,
      fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json }; },
    });
    const input = { cycleNumber: 1, notices: [{ title: "测试公告", url: "https://example.test/notice" }] };
    try {
      assert.equal(await notifier.notify(input), 1);
      assert.equal(await notifier.notify(input), 1);
      assert.equal(calls, 1);
      assert.equal(repository.statusCounts().uncertain, 1);
      assert.equal(repository.statusCounts().failed, 0);
    } finally { db.close(); }
  });
}

test("concurrent PushPlus calls cannot claim the same delivery twice", async () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const repository = createHospitalTenderPushplusDeliveryRepository(db);
  const notifier = createHospitalTenderPushplusNotifier({
    token: "synthetic-token", deliveryRepository: repository,
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return { ok: true, status: 200, json: async () => ({ code: 200, data: "synthetic-receipt" }) };
    },
  });
  const input = { cycleNumber: 1, notices: [{ title: "测试公告", url: "https://example.test/notice" }] };
  const first = notifier.notify(input);
  try {
    await assert.rejects(notifier.notify(input), /PUSHPLUS_DELIVERY_STATE_CONFLICT/u);
    assert.equal(calls, 1);
    release();
    assert.equal(await first, 1);
    assert.equal(await notifier.notify(input), 1);
    assert.equal(repository.statusCounts().accepted, 1);
    assert.equal(calls, 1);
  } finally { release(); await first; db.close(); }
});
