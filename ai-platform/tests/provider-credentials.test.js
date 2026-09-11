import assert from "node:assert/strict";
import { test } from "node:test";
import { openAiPlatformDatabase } from "../src/db/index.js";
import { createProviderCredentials } from "../src/providers/credentials.js";
import { createOpenAiCompatibleProvider, normalizeProviderPolicies } from "../src/providers/openAiCompatible.js";

test("credential replacement and clear affect each request, remain encrypted and suppress environment fallback after restart", async () => {
  const db = openAiPlatformDatabase(":memory:");
  const policy = normalizeProviderPolicies([{
    id: "provider-deepseek", baseUrl: "https://api.deepseek.com", credentialEnv: "AI_PROVIDER_DEEPSEEK_KEY",
    models: [{ name: "deepseek-v4-flash", taskTypes: ["quick-record.analyze"], maxOutputTokens: 3200 }],
  }], { allowedOrigins: ["https://api.deepseek.com"] })[0];
  const env = { AI_PROVIDER_DEEPSEEK_KEY: "synthetic-initial-credential" };
  const encryptionKey = Buffer.alloc(32, 99).toString("base64url");
  let vault = createProviderCredentials({ db, encryptionKey, policies: [policy], env });
  const calls = [];
  const provider = createOpenAiCompatibleProvider(policy, {
    env, credentialResolver: (id) => vault.resolve(id),
    fetchImpl: async (_url, options) => {
      calls.push(options.headers.Authorization);
      return Response.json({
        model: "deepseek-v4-flash", choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  const task = {
    task: { id: "task-key-rotation", taskType: "quick-record.analyze", input: { protocol: "chat.completions.v1", request: { max_tokens: 3200, messages: [{ role: "user", content: "fixture" }] } } },
    model: { name: "deepseek-v4-flash", providerId: policy.id }, agent: { limits: { maxTokens: 3200 } },
  };
  try {
    await provider.execute(task);
    assert.equal(calls[0], "Bearer " + env.AI_PROVIDER_DEEPSEEK_KEY);
    const changed = vault.update({ id: policy.credentialEnv, value: "synthetic-replacement-credential", expectedRevision: 0, actor: "admin" });
    assert.equal(changed.revision, 1);
    await provider.execute(task);
    assert.equal(calls[1], "Bearer " + "synthetic-replacement-credential");
    assert.equal(db.prepare("SELECT ciphertext FROM provider_credentials").get().ciphertext.includes("synthetic"), false);
    assert.throws(() => vault.update({ id: policy.credentialEnv, clear: true, expectedRevision: 0, actor: "admin" }), (error) => error.code === "credential_conflict");
    const cleared = vault.update({ id: policy.credentialEnv, clear: true, expectedRevision: 1, actor: "admin" });
    assert.equal(cleared.configured, false);
    vault = createProviderCredentials({ db, encryptionKey, policies: [policy], env });
    await assert.rejects(provider.execute(task), (error) => error.providerStarted === false);
    assert.equal(provider.supports({ modelName: "deepseek-v4-flash", taskType: "quick-record.analyze" }), false);
    assert.equal(calls.length, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM provider_credential_audit").get().n, 2);
    assert.equal(JSON.stringify(vault.metadata(policy.credentialEnv)).includes("synthetic-replacement"), false);
  } finally { db.close(); }
});

test("credential operation ids are idempotent and cannot be reused for another desired value", () => {
  const db = openAiPlatformDatabase(":memory:");
  const policy = normalizeProviderPolicies([{
    id: "provider-deepseek", baseUrl: "https://api.deepseek.com", credentialEnv: "AI_PROVIDER_DEEPSEEK_KEY",
    models: [{ name: "deepseek-v4-flash", taskTypes: ["quick-record.analyze"], maxOutputTokens: 3200 }],
  }], { allowedOrigins: ["https://api.deepseek.com"] })[0];
  const encryptionKey = Buffer.alloc(32, 100).toString("base64url");
  const vault = createProviderCredentials({
    db,
    encryptionKey,
    policies: [policy],
    env: { AI_PROVIDER_DEEPSEEK_KEY: "synthetic-environment-credential" },
  });
  try {
    const first = vault.update({
      id: policy.credentialEnv,
      value: "synthetic-operation-credential",
      expectedRevision: 0,
      actor: "admin",
      operationId: "credential-operation-replay",
    });
    const replay = vault.update({
      id: policy.credentialEnv,
      value: "synthetic-operation-credential",
      expectedRevision: 0,
      actor: "admin",
      operationId: "credential-operation-replay",
    });
    assert.deepEqual(replay, first);
    assert.equal(db.prepare("SELECT revision FROM provider_credentials WHERE credential_id=?").get(policy.credentialEnv).revision, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provider_credential_audit").get().count, 1);

    assert.throws(() => vault.update({
      id: policy.credentialEnv,
      value: "synthetic-different-operation-value",
      expectedRevision: 0,
      actor: "admin",
      operationId: "credential-operation-replay",
    }), (error) => error.code === "credential_operation_conflict");

    const operation = vault.readOperation("credential-operation-replay");
    assert.equal(operation.status, "applied");
    assert.equal(operation.resultingRevision, 1);
    assert.equal(operation.item.revision, 1);
    assert.equal(operation.item.configured, true);
    assert.doesNotMatch(JSON.stringify(operation), /synthetic-operation-credential/u);
  } finally {
    db.close();
  }
});
