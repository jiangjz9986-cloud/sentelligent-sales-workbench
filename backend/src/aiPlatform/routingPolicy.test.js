import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAiRoutingPolicy, usesPlatformForTask, routingPolicyStatus } from "./routingPolicy.js";
import { runAiPlatformTextCompletion } from "./textAdapter.js";

const policy = normalizeAiRoutingPolicy({ version: "rollout-1", phase: "canary", owners: ["alice"], taskTypes: ["quick-record.analyze"] });

test("canary matches both owner and task and does not expose owner lists in public status", () => {
  const config = { aiPlatformMode: "required", aiPlatformRoutingPolicy: policy };
  assert.equal(usesPlatformForTask(config, { owner: "alice", taskType: "quick-record.analyze" }), true);
  assert.equal(usesPlatformForTask(config, { owner: "bob", taskType: "quick-record.analyze" }), false);
  assert.equal(usesPlatformForTask(config, { owner: "alice", taskType: "weekly.generate" }), false);
  assert.equal(usesPlatformForTask(config, { owner: undefined, taskType: "quick-record.analyze" }), false);
  assert.equal(JSON.stringify(routingPolicyStatus(config)).includes("alice"), false);
  assert.match(routingPolicyStatus(config).digest, /^[0-9a-f]{64}$/);
  for (const input of [
    { ...policy, owners: [] }, { ...policy, taskTypes: ["asr.transcribe"] },
    { ...policy, phase: "all" }, { ...policy, taskTypes: ["forged.type"] },
    { ...policy, phase: "legacy" }, { ...policy, owners: ["alice\n"] },
  ]) assert.throws(() => normalizeAiRoutingPolicy(input), /ROUTING_POLICY/);
});

test("selected traffic has one platform path and excluded traffic has one explicit legacy path", async () => {
  let platformCalls = 0;
  let legacyCalls = 0;
  let fail = false;
  const runtime = {
    configured: () => true, enabled: () => true,
    createCompletionClient() {
      return { async complete() {
        platformCalls++;
        if (fail) throw new Error("platform unavailable");
        return { choices: [{ message: { content: '{"route":"platform"}' } }] };
      } };
    },
  };
  const config = {
    aiAnalysisMode: "model", aiPlatformMode: "required", aiPlatformRoutingPolicy: policy,
    aiPlatformRuntime: runtime, modelName: "deepseek-v4-flash",
  };
  Object.defineProperty(config, "modelApiKey", { value: "synthetic-legacy-credential" });
  const options = { fetchImpl: async () => {
    legacyCalls++;
    return Response.json({ choices: [{ message: { content: '{"route":"legacy"}' } }] });
  } };
  const input = { config, options, taskType: "quick-record.analyze", feature: "quick_record", channel: "web", owner: "alice", messages: [{ role: "user", content: "fixture" }] };
  assert.equal(await runAiPlatformTextCompletion(input), '{"route":"platform"}');
  assert.equal(await runAiPlatformTextCompletion({ ...input, owner: "bob" }), '{"route":"legacy"}');
  assert.equal(await runAiPlatformTextCompletion({ ...input, taskType: "weekly.generate" }), '{"route":"legacy"}');
  fail = true;
  await assert.rejects(runAiPlatformTextCompletion(input));
  assert.equal(platformCalls, 2);
  assert.equal(legacyCalls, 2);
});
