import assert from "node:assert/strict";
import { test } from "node:test";
import { openAiPlatformDatabase } from "../src/db/index.js";
import { loadAiPlatformConfig } from "../src/config.js";
import { normalizeDeploymentPolicy, applyDeploymentPolicy } from "../src/operations/deploymentPolicy.js";
import { updateOperationalControl } from "../src/operations/control.js";
import { sha256 } from "../../shared/aiPlatformContract.mjs";

const identity = { issuer: "deployment", actor: "operator", scopes: ["ai:ops:write"] };
const config = loadAiPlatformConfig({
  providerAllowedOrigins: ["https://api.deepseek.com"],
  providerPolicies: [{
    id: "provider-deepseek", baseUrl: "https://api.deepseek.com", credentialEnv: "AI_PROVIDER_DEEPSEEK_KEY",
    models: [{ name: "deepseek-v4-flash", taskTypes: ["quick-record.analyze"], maxOutputTokens: 3200 }],
  }],
}, {});
const policy = {
  id: "policy-test", sourceCommit: "a".repeat(40), testEvidenceSha256: "b".repeat(64),
  currency: "CNY", dailyBudgetMicro: 1000000, dailyCallLimit: 5,
  models: [{
    id: "model-deepseek", providerId: "provider-deepseek", name: "deepseek-v4-flash",
    price: {
      id: "price-deepseek-test", version: "test-v1", effectiveFrom: "2026-01-01T00:00:00.000Z",
      sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
      input_micro_per_1k: 3000, output_micro_per_1k: 9000, cached_input_micro_per_1k: 100,
      audio_micro_per_minute: 0, image_micro_per_page: 0,
    },
  }],
  agents: [{ slug: "quick-record", modelId: "model-deepseek", version: "1.1.0", maxTokens: 3200, maxInputTokens: 128000, timeoutMs: 120000 }],
};

test("policy publishes immutable model/price/Agent versions only with a paused fresh control generation", () => {
  const db = openAiPlatformDatabase(":memory:");
  try {
    const normalized = normalizeDeploymentPolicy(policy, config);
    const args = { db, config, policy, expectedDigest: sha256(normalized), expectedGeneration: 1, identity };
    assert.throws(() => applyDeploymentPolicy(args), (error) => error.code === "control_conflict");
    updateOperationalControl(db, { paused: true, expectedGeneration: 0, identity });
    const before = db.prepare("SELECT count(*) n FROM agent_versions").get().n;
    const result = applyDeploymentPolicy(args);
    assert.equal(result.generation, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM agent_versions").get().n, before + 1);
    const model = db.prepare("SELECT name FROM models WHERE id='model-deepseek'").get();
    assert.equal(model.name, "deepseek-v4-flash");
    const active = db.prepare("SELECT av.model_policy_json FROM agent_versions av JOIN agent_releases ar ON ar.agent_version_id=av.id WHERE ar.status='active' AND av.version='1.1.0'").get();
    assert.equal(JSON.parse(active.model_policy_json).externalAllowed, true);
    const budget = db.prepare("SELECT currency,amount_micro FROM budget_policies WHERE id='budget-global-daily'").get();
    assert.equal(budget.currency, "CNY");
    assert.equal(budget.amount_micro, policy.dailyBudgetMicro);
    assert.equal(applyDeploymentPolicy(args).replayed, true);
    assert.equal(db.prepare("SELECT count(*) n FROM deployment_policy_releases").get().n, 1);
    const changed = { ...policy, dailyBudgetMicro: 2000000 };
    assert.throws(() => applyDeploymentPolicy({ ...args, policy: changed, expectedDigest: sha256(normalizeDeploymentPolicy(changed, config)) }), (error) => error.code === "policy_id_conflict");
  } finally { db.close(); }
});

test("failed policy application rolls back model, price, budget and release writes together", () => {
  const db = openAiPlatformDatabase(":memory:");
  try {
    updateOperationalControl(db, { paused: true, expectedGeneration: 0, identity });
    const broken = { ...policy, agents: [{ ...policy.agents[0], slug: "unknown-agent" }] };
    assert.throws(() => applyDeploymentPolicy({
      db, config, policy: broken, identity, expectedGeneration: 1,
      expectedDigest: sha256(normalizeDeploymentPolicy(broken, config)),
    }), (error) => error.code === "agent_not_active");
    assert.equal(db.prepare("SELECT count(*) n FROM models WHERE id='model-deepseek'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM price_versions WHERE id='price-deepseek-test'").get().n, 0);
    assert.equal(db.prepare("SELECT currency FROM budget_policies WHERE id='budget-global-daily'").get().currency, "USD");
    assert.equal(db.prepare("SELECT count(*) n FROM deployment_policy_releases").get().n, 0);
  } finally { db.close(); }
});

test("P1 mock policy publishes without an external provider and keeps zero-cost capabilities", () => {
  const db = openAiPlatformDatabase(":memory:");
  const mockConfig = loadAiPlatformConfig({ providerAllowedOrigins: [] }, {});
  const mockPolicy = {
    id: "policy-mock-p1",
    sourceCommit: "c".repeat(40),
    testEvidenceSha256: "d".repeat(64),
    currency: "USD",
    dailyBudgetMicro: 1,
    dailyCallLimit: 1,
    models: [{
      id: "model-mock-standard-v1",
      providerId: "provider-mock",
      name: "mock-standard-v1",
      price: {
        id: "price-mock-p1",
        version: "mock-p1-v1",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        sourceUrl: "https://example.invalid/mock-pricing",
        input_micro_per_1k: 0,
        output_micro_per_1k: 0,
        cached_input_micro_per_1k: 0,
        audio_micro_per_minute: 0,
        image_micro_per_page: 0,
      },
    }],
    agents: [{
      slug: "quick-record",
      modelId: "model-mock-standard-v1",
      version: "1.1.1",
      maxTokens: 3200,
      maxInputTokens: 128000,
      timeoutMs: 120000,
    }],
  };
  const identity = { issuer: "deployment", actor: "operator", scopes: ["ai:ops:write"] };
  try {
    const normalized = normalizeDeploymentPolicy(mockPolicy, mockConfig);
    assert.equal(mockConfig.externalProvidersEnabled, false);
    assert.equal(mockConfig.providerPolicies.some((item) => item.id === "provider-mock"), false);
    updateOperationalControl(db, { paused: true, expectedGeneration: 0, identity });
    const result = applyDeploymentPolicy({
      db,
      config: mockConfig,
      policy: mockPolicy,
      expectedDigest: sha256(normalized),
      expectedGeneration: 1,
      identity,
    });
    assert.equal(result.replayed, false);
    const provider = db.prepare("SELECT kind FROM providers WHERE id='provider-mock'").get();
    assert.equal(provider.kind, "mock");
    const model = db.prepare("SELECT capabilities_json FROM models WHERE id='model-mock-standard-v1'").get();
    assert.deepEqual(JSON.parse(model.capabilities_json), {
      text: true,
      vision: true,
      audio: true,
      external: false,
    });
    const active = db.prepare(`
      SELECT av.model_policy_json
        FROM agent_versions av
        JOIN agent_releases ar ON ar.agent_version_id=av.id
       WHERE ar.status='active' AND av.agent_id=(SELECT id FROM agents WHERE slug='quick-record')
    `).get();
    assert.equal(JSON.parse(active.model_policy_json).externalAllowed, false);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM providers WHERE kind <> 'mock'").get().n, 0);
  } finally { db.close(); }
});
