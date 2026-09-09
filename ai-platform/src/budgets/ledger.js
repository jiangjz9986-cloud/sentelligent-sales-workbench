import { AiPlatformError } from "../errors.js";
import { id, periodKey, stringify } from "../utils.js";

function policyRows(db, { owner, feature, agentId }) {
  return db.prepare(`
    SELECT * FROM budget_policies
     WHERE enabled = 1
       AND (
         scope_type = 'global'
         OR (scope_type = 'owner' AND scope_key = $owner)
         OR (scope_type = 'feature' AND scope_key = $feature)
         OR (scope_type = 'agent' AND scope_key = $agentId)
       )
     ORDER BY CASE scope_type WHEN 'global' THEN 0 WHEN 'owner' THEN 1 WHEN 'feature' THEN 2 ELSE 3 END,
              period
  `).all({ $owner: owner, $feature: feature, $agentId: agentId });
}

function usedForPolicy(db, policyId, period) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_micro ELSE actual_micro END), 0) AS cost_micro,
      COALESCE(SUM(CASE WHEN status IN ('reserved', 'settled', 'unknown') THEN 1 ELSE 0 END), 0) AS call_count
      FROM budget_reservations
     WHERE policy_id = $policyId AND period_key = $period
       AND status IN ('reserved', 'settled', 'unknown')
  `).get({ $policyId: policyId, $period: period });
  return { costMicro: Number(row?.cost_micro ?? 0), callCount: Number(row?.call_count ?? 0) };
}

export function estimateUsage({ input, maxTokens = 1_000 } = {}) {
  const inputBytes = Buffer.byteLength(stringify(input, "{}"), "utf8");
  const media = input?.media ?? input?.input?.media ?? {};
  return {
    inputTokens: Math.max(1, inputBytes),
    outputTokens: Math.max(1, Math.min(Number(maxTokens) || 1_000, 100_000)),
    cachedInputTokens: 0,
    audioSeconds: Number.isSafeInteger(media.durationMs) ? Math.max(0, Math.ceil(media.durationMs / 1_000)) : 0,
    imagePages: Number.isSafeInteger(media.pageCount) ? Math.max(0, media.pageCount) : 0,
  };
}

export function calculateCostMicro(usage, price) {
  if (!price) return { costMicro: 0, costStatus: "unknown" };
  const input = Number(usage?.inputTokens ?? 0);
  const output = Number(usage?.outputTokens ?? 0);
  const cached = Number(usage?.cachedInputTokens ?? 0);
  const audio = Number(usage?.audioSeconds ?? 0);
  const pages = Number(usage?.imagePages ?? 0);
  const scaled = (value, rate, divisor) => {
    const unitRate = Number(rate ?? 0);
    if (![value, unitRate].every((number) => Number.isSafeInteger(number) && number >= 0)) {
      throw new AiPlatformError("invalid usage or price", { code: "invalid_cost", status: 503 });
    }
    const result = (BigInt(value) * BigInt(unitRate) + BigInt(divisor - 1)) / BigInt(divisor);
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new AiPlatformError("cost exceeds integer bounds", { code: "invalid_cost", status: 503 });
    return Number(result);
  };
  const perThousand = (value, rate) => scaled(value, rate, 1_000);
  const costMicro = perThousand(input, price.input_micro_per_1k)
    + perThousand(output, price.output_micro_per_1k)
    + perThousand(cached, price.cached_input_micro_per_1k)
    + scaled(audio, price.audio_micro_per_minute, 60)
    + scaled(pages, price.image_micro_per_page, 1);
  if (!Number.isSafeInteger(costMicro)) throw new AiPlatformError("cost exceeds integer bounds", { code: "invalid_cost", status: 503 });
  return { costMicro, costStatus: "calculated" };
}

export function reserveBudget(db, {
  taskId,
  owner,
  feature,
  agentId,
  estimatedCostMicro = 0,
  currency = null,
  requirePolicy = false,
  at = new Date(),
  timeZone = "Asia/Shanghai",
  reservationIdFactory = () => id("reservation"),
} = {}) {
  const policies = policyRows(db, { owner, feature, agentId });
  if (!Number.isSafeInteger(estimatedCostMicro) || estimatedCostMicro < 0) {
    throw new AiPlatformError("invalid budget reservation", { code: "invalid_cost", status: 503 });
  }
  if (requirePolicy && !policies.some((policy) => policy.scope_type === "global" && Number(policy.amount_micro) > 0)) {
    throw new AiPlatformError("a finite global budget is required", { code: "budget_not_configured", status: 503 });
  }
  if (currency && policies.some((policy) => policy.currency !== currency)) {
    throw new AiPlatformError("budget and price currencies differ", { code: "budget_currency_mismatch", status: 503 });
  }
  const reservations = [];
  for (const policy of policies) {
    const period = periodKey(at, policy.period, timeZone);
    const used = usedForPolicy(db, policy.id, period);
    if (Number(policy.amount_micro) > 0 && used.costMicro + estimatedCostMicro > Number(policy.amount_micro)) {
      throw new AiPlatformError("budget exceeded", {
        code: "budget_exceeded",
        status: 429,
        details: { policyId: policy.id, period, kind: "amount" },
      });
    }
    if (Number(policy.call_limit) > 0 && used.callCount + 1 > Number(policy.call_limit)) {
      throw new AiPlatformError("call budget exceeded", {
        code: "budget_exceeded",
        status: 429,
        details: { policyId: policy.id, period, kind: "calls" },
      });
    }
    const reservationId = reservationIdFactory();
    db.prepare(`
      INSERT INTO budget_reservations (
        id, task_id, policy_id, period_key, reserved_micro, actual_micro, status, created_at
      ) VALUES ($id, $taskId, $policyId, $periodKey, $reservedMicro, 0, 'reserved', $createdAt)
    `).run({
      $id: reservationId,
      $taskId: taskId,
      $policyId: policy.id,
      $periodKey: period,
      $reservedMicro: Math.max(0, Math.floor(estimatedCostMicro)),
      $createdAt: at.toISOString(),
    });
    reservations.push({ id: reservationId, policyId: policy.id, periodKey: period, reservedMicro: Math.max(0, Math.floor(estimatedCostMicro)) });
  }
  return reservations;
}

export function attachReservationsToAttempt(db, taskId, attemptId) {
  db.prepare(`UPDATE budget_reservations SET attempt_id = $attemptId WHERE task_id = $taskId AND attempt_id IS NULL AND status = 'reserved'`)
    .run({ $taskId: taskId, $attemptId: attemptId });
}

export function settleBudget(db, { taskId, actualCostMicro, unknown = false, at = new Date() } = {}) {
  const status = unknown ? "unknown" : "settled";
  db.prepare(`
    UPDATE budget_reservations
       SET actual_micro = $actualMicro, status = $status, settled_at = $settledAt
     WHERE task_id = $taskId AND status = 'reserved'
  `).run({
    $taskId: taskId,
    $actualMicro: Math.max(0, Math.floor(actualCostMicro ?? 0)),
    $status: status,
    $settledAt: at.toISOString(),
  });
}

export function releaseBudget(db, { taskId, at = new Date() } = {}) {
  db.prepare(`
    UPDATE budget_reservations SET status = 'released', settled_at = $settledAt
     WHERE task_id = $taskId AND status = 'reserved'
  `).run({ $taskId: taskId, $settledAt: at.toISOString() });
}

export function budgetOverview(db, { owner = null, from = null, to = null } = {}) {
  const clauses = [];
  const params = {};
  if (owner) { clauses.push("owner = $owner"); params.$owner = owner; }
  if (from) { clauses.push("occurred_at >= $from"); params.$from = from; }
  if (to) { clauses.push("occurred_at < $to"); params.$to = to; }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totals = db.prepare(`
    SELECT COUNT(*) AS calls,
           COALESCE(SUM(cost_micro), 0) AS cost_micro,
           COALESCE(SUM(function_fee_micro), 0) AS function_fee_micro,
           SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_costs,
           SUM(CASE WHEN cost_status = 'estimated' THEN 1 ELSE 0 END) AS estimated_costs
      FROM usage_ledger ${where}
  `).get(params);
  const byFeature = db.prepare(`
    SELECT feature, COUNT(*) AS calls, COALESCE(SUM(cost_micro), 0) AS cost_micro,
           COALESCE(SUM(function_fee_micro), 0) AS function_fee_micro
      FROM usage_ledger ${where}
     GROUP BY feature ORDER BY cost_micro DESC, feature ASC
  `).all(params);
  const byModel = db.prepare(`
    SELECT provider_id, model_id, COUNT(*) AS calls, COALESCE(SUM(cost_micro), 0) AS cost_micro
      FROM usage_ledger ${where}
     GROUP BY provider_id, model_id ORDER BY cost_micro DESC, model_id ASC
  `).all(params);
  return {
    calls: Number(totals?.calls ?? 0),
    costMicro: Number(totals?.cost_micro ?? 0),
    functionFeeMicro: Number(totals?.function_fee_micro ?? 0),
    unknownCosts: Number(totals?.unknown_costs ?? 0),
    estimatedCosts: Number(totals?.estimated_costs ?? 0),
    byFeature: byFeature.map((row) => ({ feature: row.feature, calls: Number(row.calls), costMicro: Number(row.cost_micro), functionFeeMicro: Number(row.function_fee_micro) })),
    byModel: byModel.map((row) => ({ providerId: row.provider_id, modelId: row.model_id, calls: Number(row.calls), costMicro: Number(row.cost_micro) })),
  };
}
