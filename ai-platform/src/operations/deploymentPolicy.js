import { AI_TASK_TYPES, sha256, stableJson } from "../../../shared/aiPlatformContract.mjs";
import { AiPlatformError } from "../errors.js";
import { normalizePriceCalendar } from "../budgets/priceCalendar.js";
import { readOperationalControl } from "./control.js";
import { withImmediateTransaction } from "../utils.js";

const ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/u;
const RATE_FIELDS = ["input_micro_per_1k", "output_micro_per_1k", "cached_input_micro_per_1k", "audio_micro_per_minute", "image_micro_per_page"];
const MOCK_PROVIDER_POLICY = Object.freeze({
  id: "provider-mock",
  kind: "mock",
  models: Object.freeze([{
    name: "mock-standard-v1",
    taskTypes: AI_TASK_TYPES,
    reasoning: "none",
    maxOutputTokens: 3200,
  }]),
});

export function registeredProviderPolicy(config, providerId) {
  if (providerId === MOCK_PROVIDER_POLICY.id) return MOCK_PROVIDER_POLICY;
  return config?.providerPolicies?.find((item) => item.id === providerId) ?? null;
}

function invalid(code = "invalid_deployment_policy", status = 422) {
  throw new AiPlatformError("deployment policy is invalid or conflicts with current state", { code, status });
}
function object(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function identifier(value) { if (typeof value !== "string" || !ID.test(value)) invalid(); }
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(); }

export function normalizeDeploymentPolicy(input, config) {
  object(input, ["id", "sourceCommit", "testEvidenceSha256", "currency", "dailyBudgetMicro", "dailyCallLimit", "models", "agents"]);
  identifier(input.id);
  if (!/^[0-9a-f]{40}$/u.test(input.sourceCommit) || !/^[0-9a-f]{64}$/u.test(input.testEvidenceSha256)
    || !["CNY", "USD"].includes(input.currency)) invalid();
  integer(input.dailyBudgetMicro, 1, 1_000_000_000);
  integer(input.dailyCallLimit, 1, 10_000);
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > 16
    || !Array.isArray(input.agents) || !input.agents.length || input.agents.length > 32) invalid();
  const ids = new Set();
  const models = input.models.map((model) => {
    object(model, ["id", "providerId", "name", "price"]);
    identifier(model.id); identifier(model.providerId);
    if (ids.has(model.id)) invalid();
    ids.add(model.id);
    const provider = registeredProviderPolicy(config, model.providerId);
    const registered = provider?.models.find((item) => item.name === model.name);
    if (!registered) invalid("provider_not_registered", 503);
    const price = model.price;
    object(price, ["id", "version", "effectiveFrom", "sourceUrl", "calendar", ...RATE_FIELDS]);
    identifier(price.id); identifier(price.version);
    if (new Date(price.effectiveFrom).toISOString() !== price.effectiveFrom) invalid();
    let url;
    try { url = new URL(price.sourceUrl); } catch { invalid(); }
    if (url.protocol !== "https:" || url.username || url.password || url.search) invalid();
    for (const key of RATE_FIELDS) integer(price[key], 0, 1_000_000_000);
    if (!RATE_FIELDS.some((key) => price[key] > 0) && provider.kind !== "mock") invalid();
    if (provider.kind === "asr" && (price.audio_micro_per_minute <= 0
      || ["input_micro_per_1k", "output_micro_per_1k", "cached_input_micro_per_1k", "image_micro_per_page"].some((key) => price[key] !== 0))) invalid("unsupported_asr_pricing");
    if (provider.kind === "vision" && (price.image_micro_per_page !== 0 || price.audio_micro_per_minute !== 0
      || price.input_micro_per_1k <= 0)) invalid("unsupported_vision_pricing");
    const calendar = normalizePriceCalendar(price.calendar, price);
    return { ...model, price: { ...price, calendar } };
  });
  const agentSlugs = new Set();
  const agents = input.agents.map((agent) => {
    object(agent, ["slug", "modelId", "version", "maxTokens", "maxInputTokens", "timeoutMs"]);
    identifier(agent.slug); identifier(agent.modelId);
    if (typeof agent.version !== "string" || agent.version.length > 100 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(agent.version)) invalid();
    if (!ids.has(agent.modelId) || agentSlugs.has(agent.slug)) invalid();
    agentSlugs.add(agent.slug);
    integer(agent.maxTokens, 1, 100_000); integer(agent.maxInputTokens, 1, 2_000_000); integer(agent.timeoutMs, 100, 600_000);
    return { ...agent };
  });
  return { ...input, models, agents };
}

export function applyDeploymentPolicy({ db, config, policy: input, expectedDigest, expectedGeneration, identity, clock = () => new Date() }) {
  const scopes = new Set(identity?.scopes ?? []);
  if (!scopes.has("ai:ops:write")) invalid("forbidden", 403);
  if ([identity.actor, identity.issuer].some((value) => typeof value !== "string" || !value || value.length > 400 || /[\u0000-\u001f\u007f]/u.test(value))) invalid("invalid_auth", 401);
  const policy = normalizeDeploymentPolicy(input, config);
  const digest = sha256(policy);
  if (digest !== expectedDigest) invalid("policy_digest_mismatch", 409);
  return withImmediateTransaction(db, () => {
    const replay = db.prepare("SELECT policy_digest FROM deployment_policy_releases WHERE id = ?").get(policy.id);
    if (replay) {
      if (replay.policy_digest !== digest) invalid("policy_id_conflict", 409);
      return { id: policy.id, digest, replayed: true };
    }
    const control = readOperationalControl(db);
    if (!control.paused || control.generation !== expectedGeneration) invalid("control_conflict", 409);
    if (db.prepare("SELECT count(*) n FROM tasks WHERE status IN ('queued', 'running')").get().n) invalid("drain_incomplete", 409);
    const at = clock().toISOString();
    for (const model of policy.models) {
      const registered = registeredProviderPolicy(config, model.providerId);
      const priorProvider = db.prepare("SELECT kind FROM providers WHERE id = ?").get(model.providerId);
      if (priorProvider && priorProvider.kind !== registered.kind) invalid("provider_id_conflict", 409);
      if (!priorProvider) db.prepare("INSERT INTO providers (id,name,kind,enabled,config_json,created_at,updated_at) VALUES (?,?,?,1,'{}',?,?)")
        .run(model.providerId, model.providerId, registered.kind, at, at);
      const existing = db.prepare("SELECT provider_id,name FROM models WHERE id = ?").get(model.id);
      if (existing && (existing.provider_id !== model.providerId || existing.name !== model.name)) invalid("model_id_conflict", 409);
      if (!existing) db.prepare("INSERT INTO models (id,provider_id,name,capabilities_json,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)")
        .run(model.id, model.providerId, model.name, JSON.stringify({ text: registered.kind === "openai_compatible" || registered.kind === "mock", vision: registered.kind === "vision" || registered.kind === "mock", audio: registered.kind === "asr" || registered.kind === "mock", external: registered.kind !== "mock" }), at, at);
      const price = model.price;
      if (db.prepare("SELECT 1 FROM price_versions WHERE id = ?").get(price.id)) invalid("price_id_conflict", 409);
      db.prepare(`INSERT INTO price_versions (id,model_id,version,currency,input_micro_per_1k,output_micro_per_1k,cached_input_micro_per_1k,audio_micro_per_minute,image_micro_per_page,function_fee_micro,effective_from,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`)
        .run(price.id, model.id, price.version, policy.currency, ...RATE_FIELDS.map((field) => price[field]), price.effectiveFrom, at);
      if (price.calendar) db.prepare("INSERT INTO price_calendars (price_version_id,policy_json) VALUES (?,?)").run(price.id, stableJson(price.calendar));
    }
    for (const binding of policy.agents) {
      const active = db.prepare(`SELECT av.*,a.lifecycle,ar.id release_id FROM agents a
        JOIN agent_releases ar ON ar.agent_id=a.id AND ar.status='active'
        JOIN agent_versions av ON av.id=ar.agent_version_id WHERE a.slug=?`).get(binding.slug);
      if (!active || active.lifecycle !== "active") invalid("agent_not_active", 409);
      const model = policy.models.find((item) => item.id === binding.modelId);
      const provider = registeredProviderPolicy(config, model.providerId);
      const registered = provider?.models.find((item) => item.name === model.name);
      const types = JSON.parse(active.task_types_json);
      if (types.some((type) => !AI_TASK_TYPES.includes(type) || !registered.taskTypes.includes(type))
        || binding.maxTokens > registered.maxOutputTokens) invalid("agent_capability_mismatch", 422);
      const versionId = binding.slug + "-" + policy.id;
      identifier(versionId);
      db.prepare(`INSERT INTO agent_versions (id,agent_id,version,task_types_json,system_prompt,instructions_json,tools_json,model_policy_json,input_schema_json,output_schema_json,standard_ids_json,limits_json,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        versionId, active.agent_id, binding.version, active.task_types_json, active.system_prompt, active.instructions_json,
        active.tools_json, JSON.stringify({ providerId: model.providerId, modelId: model.id, externalAllowed: provider.kind !== "mock" }),
        active.input_schema_json, active.output_schema_json, active.standard_ids_json,
        JSON.stringify({ ...JSON.parse(active.limits_json), maxTokens: binding.maxTokens, maxInputTokens: binding.maxInputTokens, timeoutMs: binding.timeoutMs, maxAttempts: 1 }),
        identity.actor, at,
      );
      db.prepare("UPDATE agent_releases SET status='retired' WHERE id=? AND status='active'").run(active.release_id);
      db.prepare("INSERT INTO agent_releases (id,agent_id,agent_version_id,status,test_run_id,published_by,published_at) VALUES (?,?,?,'active',?,?,?)")
        .run("release-" + versionId, active.agent_id, versionId, "sha256:" + policy.testEvidenceSha256, identity.actor, at);
      db.prepare("UPDATE agents SET updated_at=? WHERE id=?").run(at, active.agent_id);
    }
    const existingBudget = db.prepare("SELECT id FROM budget_policies WHERE id = 'budget-global-daily'").get();
    if (!existingBudget) invalid("budget_not_configured", 503);
    if (db.prepare(`SELECT COUNT(*) n FROM budget_reservations r JOIN budget_policies p ON p.id=r.policy_id
      WHERE p.currency <> ? AND r.status IN ('reserved','settled','unknown')`).get(policy.currency).n) invalid("budget_currency_mismatch", 409);
    db.prepare("UPDATE budget_policies SET currency=?,amount_micro=?,call_limit=?,enabled=1,updated_at=? WHERE id='budget-global-daily'")
      .run(policy.currency, policy.dailyBudgetMicro, policy.dailyCallLimit, at);
    db.prepare("INSERT INTO deployment_policy_releases (id,policy_digest,source_commit,prior_control_generation,policy_json,applied_at,applied_by) VALUES (?,?,?,?,?,?,?)")
      .run(policy.id, digest, policy.sourceCommit, expectedGeneration, stableJson(policy), at, identity.actor);
    const generation = control.generation + 1;
    if (!Number.isSafeInteger(generation)) invalid("control_conflict", 409);
    db.prepare("UPDATE platform_control SET generation=?,updated_at=? WHERE id=1").run(generation, at);
    db.prepare("INSERT INTO platform_control_events (generation,paused,issuer,actor,occurred_at) VALUES (?,1,?,?,?)")
      .run(generation, identity.issuer, identity.actor, at);
    return { id: policy.id, digest, replayed: false, sourceCommit: policy.sourceCommit, generation };
  });
}
