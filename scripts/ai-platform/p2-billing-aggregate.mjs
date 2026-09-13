import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parseCsvBytes } from "../../backend/src/customerImport/csvParser.js";

const MAX_BYTES = 4 * 1024 * 1024;
const SCALE = 10n ** 16n;
const MICRO_SCALE = SCALE / 1_000_000n;
const DIGEST = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const COST_COLUMNS = "user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency".split(",");
const AMOUNT_COLUMNS = "user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount".split(",");
const METRICS = ["request_count", "input_cache_miss_tokens", "input_cache_hit_tokens", "output_tokens"];

function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }
export function billingSha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("P2_AGGREGATE_USAGE_INVALID");
  return value;
}
function exactDecimal(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,16})?$/u.test(value)) {
    fail("P2_AGGREGATE_AMOUNT_INVALID");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(16, "0"));
}
function csvRows(bytes, expected) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) fail("P2_AGGREGATE_CSV_INVALID");
  let rows;
  try { rows = parseCsvBytes(bytes); } catch { fail("P2_AGGREGATE_CSV_INVALID"); }
  const [header, ...data] = rows;
  if (!isDeepStrictEqual(header.values, expected) || data.some((row) => row.values.length !== expected.length)) {
    fail("P2_AGGREGATE_CSV_SCHEMA_INVALID");
  }
  return data.map(({ rowNumber, values }) => ({
    ...Object.fromEntries(expected.map((key, index) => [key, values[index]])), rowNumber,
  }));
}
function hour(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+08:00$/u.test(value)) fail("P2_AGGREGATE_WINDOW_INVALID");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms + 8 * 3_600_000).toISOString().replace(".000Z", "+08:00") !== value) {
    fail("P2_AGGREGATE_WINDOW_INVALID");
  }
  return ms;
}
function canonicalTime(value) {
  const ms = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail("P2_AGGREGATE_SAMPLE_WINDOW_INVALID");
  return ms;
}
function sourceArtifact(kind, bytes) {
  return { kind, sha256: billingSha256(bytes), byteLength: bytes.length, contentBase64: bytes.toString("base64") };
}
function artifactBytes(artifact, kind) {
  if (artifact?.kind !== kind || !DIGEST.test(artifact.sha256 ?? "") || typeof artifact.contentBase64 !== "string"
    || artifact.contentBase64.length > Math.ceil(MAX_BYTES / 3) * 4) fail("P2_AGGREGATE_SOURCE_INVALID");
  const bytes = Buffer.from(artifact.contentBase64, "base64");
  if (bytes.toString("base64") !== artifact.contentBase64 || bytes.length !== artifact.byteLength
    || billingSha256(bytes) !== artifact.sha256) fail("P2_AGGREGATE_SOURCE_INVALID");
  return bytes;
}

// The cost export groups all keys for an account/model/hour. Selecting only one
// key before counting would silently attribute somebody else's spend to a run.
export function createDeepSeekAggregateReconciliation({ costCsv, amountCsv, selection, samples, runId, sourceCommit } = {}) {
  if (!selection || selection.timeZone !== "Asia/Shanghai" || selection.model !== "deepseek-flash"
    || !DIGEST.test(selection.accountSha256 ?? "") || !DIGEST.test(selection.apiKeySha256 ?? "")
    || !ID.test(runId ?? "") || !/^[0-9a-f]{40}$/u.test(sourceCommit ?? "")) fail("P2_AGGREGATE_SELECTION_INVALID");
  const startMs = hour(selection.startTime);
  const endMs = hour(selection.endTime);
  if (endMs - startMs !== 3_600_000) fail("P2_AGGREGATE_WINDOW_INVALID");
  const costs = csvRows(costCsv, COST_COLUMNS);
  const amounts = csvRows(amountCsv, AMOUNT_COLUMNS);
  const select = (rows) => rows.filter((row) => {
    const start = hour(row.start_time_iso);
    const end = hour(row.end_time_iso);
    if (end - start !== 3_600_000) fail("P2_AGGREGATE_WINDOW_INVALID");
    if (row.model !== selection.model || billingSha256(row.user_id) !== selection.accountSha256 || end <= startMs || start >= endMs) return false;
    if (row.start_time_iso !== selection.startTime || row.end_time_iso !== selection.endTime) fail("P2_AGGREGATE_WINDOW_AMBIGUOUS");
    return true;
  });
  const costRows = select(costs);
  const amountRows = select(amounts);
  if (costRows.length !== 1 || !amountRows.length) fail("P2_AGGREGATE_COHORT_AMBIGUOUS");
  const costRow = costRows[0];
  if (costRow.currency !== "CNY" || costRow.wallet_type !== "Paid") fail("P2_AGGREGATE_CHARGE_UNKNOWN");
  if (amountRows.some((row) => billingSha256(row.api_key) !== selection.apiKeySha256)
    || new Set(amountRows.map((row) => row.api_key_name)).size !== 1) fail("P2_AGGREGATE_OTHER_CALLS");
  if (amountRows.some((row) => !/^sk-[A-Za-z0-9]+\*+[A-Za-z0-9]+$/u.test(row.api_key))) fail("P2_AGGREGATE_KEY_NOT_MASKED");
  const usage = Object.fromEntries(METRICS.map((metric) => [metric, 0]));
  const seen = new Set();
  let calculated = 0n;
  for (const row of amountRows) {
    if (!METRICS.includes(row.type) || seen.has(row.type)) fail("P2_AGGREGATE_CHARGE_UNKNOWN");
    seen.add(row.type);
    if (!/^(0|[1-9][0-9]*)$/u.test(row.amount)) fail("P2_AGGREGATE_USAGE_INVALID");
    usage[row.type] = integer(Number(row.amount));
    if (row.type === "request_count") {
      if (row.price !== "") fail("P2_AGGREGATE_CHARGE_UNKNOWN");
    } else {
      calculated += exactDecimal(row.price) * BigInt(usage[row.type]);
    }
  }
  if (!["request_count", "input_cache_miss_tokens", "output_tokens"].every((metric) => seen.has(metric))) {
    fail("P2_AGGREGATE_USAGE_MISSING");
  }
  const billed = exactDecimal(costRow.cost);
  if (calculated !== billed || billed % MICRO_SCALE !== 0n || billed / MICRO_SCALE > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("P2_AGGREGATE_COST_MISMATCH");
  }
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > 100 || usage.request_count !== samples.length) {
    fail("P2_AGGREGATE_OTHER_CALLS");
  }
  const localUsage = { request_count: samples.length, input_cache_miss_tokens: 0, input_cache_hit_tokens: 0, output_tokens: 0 };
  let localCost = 0n;
  const ids = new Set();
  const requests = new Set();
  const bindings = samples.map((sample) => {
    if (!ID.test(sample?.providerRequestId ?? "") || !ID.test(sample.requestId ?? "") || ids.has(sample.providerRequestId)
      || requests.has(sample.requestId) || sample.actualModel !== selection.model || sample.finishReason !== "stop"
      || sample.cost?.currency !== "CNY" || sample.cost.status !== "calculated") fail("P2_AGGREGATE_SAMPLE_INVALID");
    ids.add(sample.providerRequestId);
    requests.add(sample.requestId);
    const requestedAt = canonicalTime(sample.requestedAt);
    const settledAt = canonicalTime(sample.settledAt);
    if (requestedAt < startMs || settledAt >= endMs || settledAt < requestedAt) fail("P2_AGGREGATE_SAMPLE_WINDOW_INVALID");
    if (!sample.usage || Object.entries(sample.usage).some(([key, value]) => !["inputTokens", "cachedInputTokens", "outputTokens"].includes(key) && value !== 0)) {
      fail("P2_AGGREGATE_CHARGE_UNKNOWN");
    }
    const input = integer(sample.usage.inputTokens);
    const hit = integer(sample.usage.cachedInputTokens);
    const output = integer(sample.usage.outputTokens);
    if (hit > input) fail("P2_AGGREGATE_USAGE_INVALID");
    localUsage.input_cache_miss_tokens = integer(localUsage.input_cache_miss_tokens + input - hit);
    localUsage.input_cache_hit_tokens = integer(localUsage.input_cache_hit_tokens + hit);
    localUsage.output_tokens = integer(localUsage.output_tokens + output);
    localCost += BigInt(integer(sample.cost.micro));
    return {
      requestId: sample.requestId, providerRequestId: sample.providerRequestId,
      requestedAt: sample.requestedAt, settledAt: sample.settledAt,
      actualModel: sample.actualModel, finishReason: sample.finishReason,
      usage: sample.usage, cost: sample.cost,
    };
  }).sort((left, right) => left.providerRequestId.localeCompare(right.providerRequestId));
  if (!isDeepStrictEqual(localUsage, usage)) fail("P2_AGGREGATE_USAGE_MISMATCH");
  if (localCost * MICRO_SCALE !== billed) fail("P2_AGGREGATE_COST_MISMATCH");
  const evidence = {
    schemaVersion: 1, scope: "aggregate", status: "reconciled", provider: "deepseek",
    providerRequestIdsSource: "completion-response", perRequestBillingAvailable: false,
    runId, sourceCommit,
    selection: {
      timeZone: selection.timeZone, startTime: selection.startTime, endTime: selection.endTime,
      model: selection.model, accountSha256: selection.accountSha256, apiKeySha256: selection.apiKeySha256,
    },
    currency: "CNY", amountMicro: Number(localCost), usage,
    isolation: { scope: "account-model-hour-all-keys", apiKeyCount: 1, exportRequestCount: usage.request_count, sampleCount: samples.length },
    rowNumbers: { cost: costRows.map((row) => row.rowNumber), amount: amountRows.map((row) => row.rowNumber) },
    sources: [sourceArtifact("cost", costCsv), sourceArtifact("amount", amountCsv)],
    samplesDigest: billingSha256(JSON.stringify(bindings)),
  };
  return { ...evidence, digest: billingSha256(JSON.stringify(evidence)) };
}

export function validateDeepSeekAggregateReconciliation(value, { samples, runId, sourceCommit } = {}) {
  if (!value || value.scope !== "aggregate" || !Array.isArray(value.sources) || value.sources.length !== 2) {
    fail("P2_AGGREGATE_INVALID");
  }
  const rebuilt = createDeepSeekAggregateReconciliation({
    costCsv: artifactBytes(value.sources[0], "cost"), amountCsv: artifactBytes(value.sources[1], "amount"),
    selection: value.selection, samples, runId, sourceCommit,
  });
  if (!isDeepStrictEqual(value, rebuilt)) fail("P2_AGGREGATE_BINDING_MISMATCH");
  return rebuilt;
}

export function readAggregateBillingInput(input) {
  const read = (path) => {
    if (typeof path !== "string" || !statSync(path).isFile() || statSync(path).size > MAX_BYTES) fail("P2_AGGREGATE_SOURCE_INVALID");
    return readFileSync(path);
  };
  return { costCsv: read(input.costCsvPath), amountCsv: read(input.amountCsvPath), selection: input.selection };
}
