import assert from "node:assert/strict";
import { test } from "node:test";
import { billingSha256, createDeepSeekAggregateReconciliation, validateDeepSeekAggregateReconciliation } from "./p2-billing-aggregate.mjs";

function fixture() {
  const start = "2026-09-13T11:00:00+08:00";
  const end = "2026-09-13T12:00:00+08:00";
  const prefix = `account-fixture,${start},${end},deepseek-flash`;
  return {
    runId: "run-fixture", sourceCommit: "a".repeat(40),
    selection: { timeZone: "Asia/Shanghai", startTime: start, endTime: end, model: "deepseek-flash", accountSha256: billingSha256("account-fixture"), apiKeySha256: billingSha256("sk-fixture***1234") },
    costCsv: Buffer.from(`\ufeffuser_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency\r\n${prefix},Paid,0.0065400000000000,CNY\r\n`),
    amountCsv: Buffer.from(`\ufeffuser_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount\r\n${prefix},"test, name",sk-fixture***1234,input_cache_miss_tokens,0.000001,1820\r\n${prefix},"test, name",sk-fixture***1234,output_tokens,0.000004,1180\r\n${prefix},"test, name",sk-fixture***1234,request_count,,10\r\n`),
    samples: Array.from({ length: 10 }, (_, index) => ({
      requestId: `request-${index}`, providerRequestId: `response-${index}`, actualModel: "deepseek-flash", finishReason: "stop",
      requestedAt: `2026-09-13T03:15:${String(index * 2).padStart(2, "0")}.000Z`,
      settledAt: `2026-09-13T03:15:${String(index * 2 + 1).padStart(2, "0")}.000Z`,
      usage: { inputTokens: 182, cachedInputTokens: 0, outputTokens: 118, audioSeconds: 0, imagePages: 0 },
      cost: { micro: 654, currency: "CNY", status: "calculated" },
    })),
  };
}
function replace(input, key, from, to) { input[key] = Buffer.from(input[key].toString("utf8").replace(from, to)); }

test("hourly exports reconcile exact decimal spend and retain original CSV bytes without fabricating itemized bills", () => {
  const input = fixture();
  const result = createDeepSeekAggregateReconciliation(input);
  assert.equal(result.scope, "aggregate");
  assert.equal(result.amountMicro, 6540);
  assert.equal(result.usage.request_count, 10);
  assert.equal(result.perRequestBillingAvailable, false);
  assert.equal(result.providerRequestIdsSource, "completion-response");
  assert.equal(result.sources[0].sha256, billingSha256(input.costCsv));
  assert.equal(result.sources[1].sha256, billingSha256(input.amountCsv));
  assert.deepEqual(validateDeepSeekAggregateReconciliation(result, input), result);
  assert.equal(Object.hasOwn(result, "entries"), false);
});

const invalidCases = [
  ["another request in the same hourly key", (v) => replace(v, "amountCsv", "request_count,,10", "request_count,,11"), "P2_AGGREGATE_OTHER_CALLS"],
  ["another key in the same account hour", (v) => replace(v, "amountCsv", "sk-fixture***1234,output", "sk-other***9999,output"), "P2_AGGREGATE_OTHER_CALLS"],
  ["unknown billing metric", (v) => replace(v, "amountCsv", "output_tokens", "request_fee"), "P2_AGGREGATE_CHARGE_UNKNOWN"],
  ["request fee", (v) => replace(v, "amountCsv", "request_count,,10", "request_count,0.000001,10"), "P2_AGGREGATE_CHARGE_UNKNOWN"],
  ["unsupported wallet", (v) => replace(v, "costCsv", ",Paid,", ",Unknown,"), "P2_AGGREGATE_CHARGE_UNKNOWN"],
  ["different currency", (v) => replace(v, "costCsv", ",CNY", ",USD"), "P2_AGGREGATE_CHARGE_UNKNOWN"],
  ["sub-micro discrepancy", (v) => replace(v, "costCsv", "0.0065400000000000", "0.0065400000000001"), "P2_AGGREGATE_COST_MISMATCH"],
  ["token mismatch", (v) => { v.samples[0].usage.inputTokens += 1; }, "P2_AGGREGATE_USAGE_MISMATCH"],
  ["local money mismatch", (v) => { v.samples[0].cost.micro += 1; }, "P2_AGGREGATE_COST_MISMATCH"],
  ["unknown local charging dimension", (v) => { v.samples[0].usage.imagePages = 1; }, "P2_AGGREGATE_CHARGE_UNKNOWN"],
  ["unknown cached-token count", (v) => { delete v.samples[0].usage.cachedInputTokens; }, "P2_AGGREGATE_USAGE_INVALID"],
  ["duplicate provider ID", (v) => { v.samples[1].providerRequestId = v.samples[0].providerRequestId; }, "P2_AGGREGATE_SAMPLE_INVALID"],
  ["missing actual model", (v) => { delete v.samples[0].actualModel; }, "P2_AGGREGATE_SAMPLE_INVALID"],
  ["different actual model", (v) => { v.samples[0].actualModel = "deepseek-other"; }, "P2_AGGREGATE_SAMPLE_INVALID"],
  ["request outside billing hour", (v) => { v.samples[0].requestedAt = "2026-09-13T02:59:59.000Z"; }, "P2_AGGREGATE_SAMPLE_WINDOW_INVALID"],
  ["settlement on exclusive upper bound", (v) => { v.samples[0].settledAt = "2026-09-13T04:00:00.000Z"; }, "P2_AGGREGATE_SAMPLE_WINDOW_INVALID"],
  ["unspecified timezone", (v) => { delete v.selection.timeZone; }, "P2_AGGREGATE_SELECTION_INVALID"],
  ["UTC timestamp substituted for original export offset", (v) => { v.selection.startTime = "2026-09-13T03:00:00Z"; }, "P2_AGGREGATE_WINDOW_INVALID"],
  ["duplicate cost line", (v) => { v.costCsv = Buffer.concat([v.costCsv, Buffer.from(v.costCsv.toString().split("\r\n")[1] + "\r\n")]); }, "P2_AGGREGATE_COHORT_AMBIGUOUS"],
  ["duplicate usage line", (v) => { v.amountCsv = Buffer.concat([v.amountCsv, Buffer.from(v.amountCsv.toString().split("\r\n")[1] + "\r\n")]); }, "P2_AGGREGATE_CHARGE_UNKNOWN"],
  ["invalid UTF-8", (v) => { v.costCsv = Buffer.from([0xff]); }, "P2_AGGREGATE_CSV_INVALID"],
];
for (const [name, mutate, code] of invalidCases) {
  test(`aggregate reconciliation fails closed: ${name}`, () => {
    const input = fixture(); mutate(input);
    assert.throws(() => createDeepSeekAggregateReconciliation(input), (error) => error.code === code);
  });
}

test("certificate verification recomputes raw sources, sample binding and totals", () => {
  const input = fixture();
  const original = createDeepSeekAggregateReconciliation(input);
  const changed = structuredClone(original);
  changed.sources[0].contentBase64 = Buffer.from("edited").toString("base64");
  assert.throws(() => validateDeepSeekAggregateReconciliation(changed, input), { code: "P2_AGGREGATE_SOURCE_INVALID" });
  const changedTotal = { ...original, amountMicro: 0 };
  assert.throws(() => validateDeepSeekAggregateReconciliation(changedTotal, input), { code: "P2_AGGREGATE_BINDING_MISMATCH" });
  const changedSamples = structuredClone(input);
  changedSamples.samples[0].providerRequestId = "different-response";
  assert.throws(() => validateDeepSeekAggregateReconciliation(original, changedSamples), { code: "P2_AGGREGATE_BINDING_MISMATCH" });
  assert.throws(() => validateDeepSeekAggregateReconciliation(original, { ...input, sourceCommit: "b".repeat(40) }), { code: "P2_AGGREGATE_BINDING_MISMATCH" });
});
