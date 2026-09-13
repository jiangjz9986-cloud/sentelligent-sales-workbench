import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { normalizeDeploymentPolicy as normalizeRuntimeDeploymentPolicy } from "../../ai-platform/src/operations/deploymentPolicy.js";
import { createOpenAiCompatibleProvider, normalizeProviderPolicies } from "../../ai-platform/src/providers/openAiCompatible.js";
import { AI_TARGET_MODEL, sha256 } from "../../shared/aiPlatformContract.mjs";
import {
  P2_ACCEPTANCE_LIVE_CONFIRMATION,
  P2_ACCEPTANCE_SAMPLE_MAX_OUTPUT_TOKENS,
  P2_ACCEPTANCE_TASK_TYPE,
  createP2AcceptanceSamples,
  parseP2AcceptanceArguments,
  runP2Acceptance,
} from "./p2-acceptance.mjs";
import { providerPolicyDigest } from "./production-contract.mjs";

const SOURCE_COMMIT = "c".repeat(40);
const PROVIDER_ID = "provider-live-fixture";
const MODEL_ID = "model-live-fixture";
const PROVIDER_REQUEST_PREFIX = "vendor-request-";

const providerPolicies = [{
  id: PROVIDER_ID,
  kind: "openai_compatible",
  baseUrl: "https://provider.example.test",
  credentialEnv: "AI_PROVIDER_LIVE_FIXTURE_KEY",
  models: [{ name: "live-fixture-v1", taskTypes: [P2_ACCEPTANCE_TASK_TYPE], reasoning: "none", maxOutputTokens: 3200 }],
}];

const deploymentPolicy = {
  id: "p2-policy-fixture",
  sourceCommit: SOURCE_COMMIT,
  testEvidenceSha256: "1".repeat(64),
  currency: "USD",
  dailyBudgetMicro: 1_000_000,
  dailyCallLimit: 100,
  models: [{
    id: MODEL_ID,
    providerId: PROVIDER_ID,
    name: "live-fixture-v1",
    price: {
      id: "price-live-fixture-v1",
      version: "fixture-v1",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      sourceUrl: "https://provider.example.test/pricing",
      input_micro_per_1k: 100,
      output_micro_per_1k: 200,
      cached_input_micro_per_1k: 0,
      audio_micro_per_minute: 0,
      image_micro_per_page: 0,
    },
  }],
  agents: [{
    slug: "quick-record",
    modelId: MODEL_ID,
    version: "1.0.0",
    maxTokens: 3200,
    maxInputTokens: 4096,
    timeoutMs: 30_000,
  }],
};

function fakeHarness({ mode = "external-provider", proactive = false, interruptSample = null, initialLiveReady = mode === "external-provider" } = {}) {
  let now = Date.parse("2026-09-11T00:00:00.000Z");
  let created = 0;
  let liveReady = initialLiveReady;
  const canaryCalls = new Map();
  const calls = [];
  const client = {
    async health() {
      calls.push("health");
      return {
        status: mode === "external-provider" ? "ok" : "paused",
        executionMode: mode,
        externalProvidersEnabled: mode === "external-provider",
        proactiveScheduleOwner: "backend",
        targetModel: "deepseek-flash",
        targetReasoningEffort: "max",
        executor: { paused: mode !== "external-provider", admissionOpen: mode === "external-provider" },
        providers: [{ id: PROVIDER_ID, kind: "openai_compatible" }],
        tasks: { [P2_ACCEPTANCE_TASK_TYPE]: { ready: liveReady, probeReady: mode === "external-provider", liveReady, provider: PROVIDER_ID } },
      };
    },
    async operations() {
      calls.push("operations");
      return { paused: false, executor: { admissionOpen: true }, queue: { running: 0, queued: 0 } };
    },
    async proactiveSchedules() {
      calls.push("proactiveSchedules");
      return { items: proactive ? [{ enabled: true }] : [] };
    },
    async proactiveTasks() {
      calls.push("proactiveTasks");
      return { items: [] };
    },
    async providerCanary(runId, sampleIndex) {
      calls.push("providerCanary");
      assert.equal(runId, "run-fixture");
      assert.ok(Number.isSafeInteger(sampleIndex));
      const key = `${runId}:${sampleIndex}`;
      const count = (canaryCalls.get(key) ?? 0) + 1;
      canaryCalls.set(key, count);
      if (count === 1) created += 1;
      if (count > 1) liveReady = true;
      if (count === 1 && sampleIndex === interruptSample) {
        throw Object.assign(new Error("simulated transport interruption"), { code: "P2_TRANSPORT_INTERRUPTED" });
      }
      return {
        taskId: `task-${sampleIndex}`,
        ready: count > 1,
        ...(count > 1 ? { evidence: { runId, sampleIndex, settledStatus: "settled" } } : {}),
      };
    },
    async readTask(taskId) {
      calls.push("readTask");
      return { id: taskId, status: "succeeded" };
    },
    async taskDetail(taskId) {
      calls.push("taskDetail");
      const index = Number(taskId.slice("task-".length));
      const providerRequestId = PROVIDER_REQUEST_PREFIX + index;
      return {
        task: {
          id: taskId,
          requestId: `request-${index}`,
          owner: "p2-acceptance",
          feature: "p2-acceptance",
          taskType: P2_ACCEPTANCE_TASK_TYPE,
          channel: "system",
          subject: { type: "p2_acceptance", id: "run-fixture" },
          status: "succeeded",
          output: { metadata: { actualModel: "live-fixture-v1", finishReason: "stop" } },
        },
        attempts: [{
          status: "succeeded",
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          externalRequestId: providerRequestId,
          priceVersionId: "price-live-fixture-v1",
          usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0, audioSeconds: 0, imagePages: 0 },
          costMicro: 14,
          costStatus: "calculated",
        }],
        usageLedger: [{
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          priceVersionId: "price-live-fixture-v1",
          usage: { inputTokens: 10, outputTokens: 20 },
          costMicro: 14,
          costStatus: "calculated",
          currency: "USD",
        }],
      };
    },
  };
  const billing = {
    entries: Array.from({ length: 10 }, (_item, index) => ({
      providerRequestId: PROVIDER_REQUEST_PREFIX + (index + 1),
      reference: `billing-${index + 1}`,
      amountMicro: 14,
      currency: "USD",
      status: "reconciled",
    })),
  };
  return {
    client,
    billing,
    calls,
    created: () => created,
    canaryCalls: (sampleIndex) => canaryCalls.get(`run-fixture:${sampleIndex}`) ?? 0,
    clock: () => new Date(now),
    sleep: async (milliseconds) => { now += milliseconds; },
  };
}

function baseRun(harness, overrides = {}) {
  return runP2Acceptance({
    sourceCommit: SOURCE_COMMIT,
    deploymentPolicy,
    providerPolicies,
    billing: harness.billing,
    client: harness.client,
    runId: "run-fixture",
    owner: "p2-acceptance",
    liveConfirmation: P2_ACCEPTANCE_LIVE_CONFIRMATION,
    sampleCount: 10,
    taskTimeoutSeconds: 1,
    pollIntervalSeconds: 1,
    observationSeconds: 7_200,
    observationIntervalSeconds: 3_600,
    clock: harness.clock,
    sleep: harness.sleep,
    ...overrides,
  });
}

function temporaryCheckpoint() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "p2-acceptance-checkpoint-")));
  return {
    directory,
    path: join(directory, "p2-checkpoint.json"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("argument parser requires explicit live confirmation and rejects secret-bearing flags", () => {
  assert.throws(() => parseP2AcceptanceArguments([
    "--source-commit=" + SOURCE_COMMIT,
    "--policy=/tmp/policy.json",
    "--provider-policies=/tmp/providers.json",
    "--billing=/tmp/billing.json",
    "--report=/tmp/p2.json",
    "--confirm=wrong",
  ]), (error) => error.code === "P2_LIVE_CONFIRMATION_REQUIRED");
  assert.throws(() => parseP2AcceptanceArguments(["--password=never" ]), (error) => error.code === "P2_ACCEPTANCE_SECRET_ARGUMENT_FORBIDDEN");
});

test("local simulation is rejected before any acceptance task is created", async () => {
  const harness = fakeHarness({ mode: "local-simulated" });
  await assert.rejects(baseRun(harness), (error) => error.code === "P2_RUNTIME_NOT_READY");
  assert.equal(harness.created(), 0);
  assert.equal(harness.calls.includes("createTask"), false);
});

test("an enabled proactive schedule is rejected before any acceptance task is created", async () => {
  const harness = fakeHarness({ proactive: true });
  await assert.rejects(baseRun(harness), (error) => error.code === "P2_PROACTIVE_SCHEDULE_ENABLED");
  assert.equal(harness.created(), 0);
});

test("generated P2 samples prepare as bounded deepseek-flash JSON chat completions", async () => {
  const samples = createP2AcceptanceSamples("run-provider-fixture");
  const sample = samples[0];
  assert.equal(sample.id, "sample-001");
  assert.equal(sample.input.protocol, "chat.completions.v1");
  assert.equal(sample.input.model, AI_TARGET_MODEL);
  assert.equal(sample.input.request.model, AI_TARGET_MODEL);
  assert.equal(sample.input.request.max_tokens, P2_ACCEPTANCE_SAMPLE_MAX_OUTPUT_TOKENS);
  assert.deepEqual(JSON.parse(sample.input.request.messages[0].content), {
    sampleId: "sample-001",
    runId: "run-provider-fixture",
    text: "Synthetic P2 acceptance sample 1.",
    output: "json-only",
  });

  const [policy] = normalizeProviderPolicies([{
    id: "provider-deepseek-fixture",
    kind: "openai_compatible",
    baseUrl: "https://provider.example.test",
    credentialEnv: "AI_PROVIDER_DEEPSEEK_FIXTURE_KEY",
    models: [{
      name: AI_TARGET_MODEL,
      taskTypes: [P2_ACCEPTANCE_TASK_TYPE],
      reasoning: "deepseek-thinking",
      maxOutputTokens: 3_200,
    }],
  }], { allowedOrigins: ["https://provider.example.test"] });
  let fetchCalls = 0;
  const provider = createOpenAiCompatibleProvider(policy, {
    env: { [policy.credentialEnv]: "synthetic-p2-provider-credential" },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("provider requests are forbidden in this test");
    },
  });

  const prepared = await provider.prepare({
    task: { id: "task-provider-fixture", taskType: P2_ACCEPTANCE_TASK_TYPE, input: sample.input },
    model: { providerId: policy.id, name: AI_TARGET_MODEL },
    agent: { versionId: "quick-record-fixture-v1", limits: { maxTokens: 3_200 } },
    limits: { maxTokens: 3_200 },
  });
  const body = JSON.parse(prepared.body);
  assert.equal(fetchCalls, 0);
  assert.equal(prepared.selected.name, AI_TARGET_MODEL);
  assert.equal(body.model, AI_TARGET_MODEL);
  assert.equal(body.max_tokens, P2_ACCEPTANCE_SAMPLE_MAX_OUTPUT_TOKENS);
  assert.deepEqual(body.messages, sample.input.request.messages);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.1);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("live acceptance uses only the controlled task path and produces a contract-valid two-hour report", async () => {
  const harness = fakeHarness();
  const report = await baseRun(harness);
  assert.equal(report.status, "passed");
  assert.equal(report.samples.length, 10);
  assert.equal(report.samples[0].actualModel, "live-fixture-v1");
  assert.equal(report.observation.durationSeconds, 7_200);
  assert.deepEqual(report.sideEffects, {
    businessDatabaseAccessed: false,
    notificationsInvoked: false,
    proactiveSchedulesChanged: false,
  });
  assert.equal(harness.created(), 10);
  assert.equal(harness.calls.includes("providerCanary"), true);
  assert.equal(harness.calls.filter((item) => item === "providerCanary").length, 20);
  assert.equal(harness.calls.filter((item) => item === "taskDetail").length, 10);

  const normalizedProviders = normalizeProviderPolicies(providerPolicies, {
    allowedOrigins: ["https://provider.example.test"],
  });
  const normalizedPolicy = normalizeRuntimeDeploymentPolicy(deploymentPolicy, {
    providerPolicies: normalizedProviders,
  });
  assert.equal(report.policyDigest, sha256(normalizedPolicy));
  assert.equal(report.providerPolicyDigest, providerPolicyDigest(normalizedProviders));
});

test("first live canary may bootstrap live readiness from probe readiness", async () => {
  const harness = fakeHarness({ initialLiveReady: false });
  const report = await baseRun(harness);
  assert.equal(report.status, "passed");
  assert.equal(harness.created(), 10);
});

test("missing billing reconciliation leaves a resumable checkpoint after controlled sampling", async () => {
  const checkpoint = temporaryCheckpoint();
  const harness = fakeHarness();
  try {
    await assert.rejects(
      baseRun(harness, { billing: null, billingLoader: null, checkpointPath: checkpoint.path }),
      (error) => error.code === "P2_BILLING_RECONCILIATION_MISSING",
    );
    const pending = JSON.parse(readFileSync(checkpoint.path, "utf8"));
    assert.equal(pending.phase, "failed");
    assert.equal(pending.failure.resumePhase, "reconciling");
    assert.ok(pending.samples.every((sample) => sample.status === "settled"));
    assert.equal(harness.created(), 10);
  } finally {
    checkpoint.cleanup();
  }
});

test("provider and deployment policy inputs use the production validators", async () => {
  const providerHarness = fakeHarness();
  const invalidProviderPolicies = [{ ...providerPolicies[0], unexpected: true }];
  await assert.rejects(baseRun(providerHarness, { providerPolicies: invalidProviderPolicies }), (error) => (
    error.code === "P2_ACCEPTANCE_PROVIDER_POLICY_INVALID"
  ));
  assert.equal(providerHarness.created(), 0);

  const policyHarness = fakeHarness();
  const invalidDeploymentPolicy = {
    ...deploymentPolicy,
    models: [{
      ...deploymentPolicy.models[0],
      price: {
        ...deploymentPolicy.models[0].price,
        calendar: { schemaVersion: "invalid" },
      },
    }],
  };
  await assert.rejects(baseRun(policyHarness, { deploymentPolicy: invalidDeploymentPolicy }), (error) => (
    error.code === "P2_ACCEPTANCE_DEPLOYMENT_POLICY_INVALID"
  ));
  assert.equal(policyHarness.created(), 0);
});

test("checkpoint resume replays the fixed canary key without recreating a lost-response task", async () => {
  const checkpoint = temporaryCheckpoint();
  const harness = fakeHarness({ interruptSample: 3 });
  try {
    await assert.rejects(
      baseRun(harness, { checkpointPath: checkpoint.path }),
      (error) => error.code === "P2_TRANSPORT_INTERRUPTED",
    );
    const interrupted = JSON.parse(readFileSync(checkpoint.path, "utf8"));
    assert.equal(interrupted.phase, "failed");
    assert.equal(interrupted.failure.resumePhase, "collecting");
    assert.deepEqual(interrupted.samples.slice(0, 2).map((sample) => sample.status), ["settled", "settled"]);
    assert.equal(interrupted.samples[2].status, "pending");

    const report = await baseRun(harness, { checkpointPath: checkpoint.path });
    assert.equal(report.status, "passed");
    assert.equal(harness.created(), 10);
    assert.equal(harness.canaryCalls(1), 2);
    assert.equal(harness.canaryCalls(2), 2);
    assert.equal(harness.canaryCalls(3), 3);
    assert.equal(harness.canaryCalls(4), 2);
  } finally {
    checkpoint.cleanup();
  }
});

test("billing reconciliation can resume without another provider call", async () => {
  const checkpoint = temporaryCheckpoint();
  const harness = fakeHarness();
  let billingReady = false;
  const billingLoader = () => billingReady ? harness.billing : { entries: [] };
  try {
    await assert.rejects(
      baseRun(harness, { checkpointPath: checkpoint.path, billingLoader }),
      (error) => error.code === "P2_BILLING_RECONCILIATION_MISSING",
    );
    const beforeResume = JSON.parse(readFileSync(checkpoint.path, "utf8"));
    assert.equal(beforeResume.phase, "failed");
    assert.equal(beforeResume.failure.resumePhase, "reconciling");
    assert.ok(beforeResume.samples.every((sample) => sample.status === "settled"));
    const callsBefore = harness.calls.filter((call) => call === "providerCanary").length;
    assert.equal(harness.created(), 10);

    // Simulate a checkpoint written by the previous schema. The completed
    // task detail remains available, so resume must backfill identity without
    // creating another provider task.
    for (const sample of beforeResume.samples) delete sample.evidence.actualModel;
    writeFileSync(checkpoint.path, JSON.stringify(beforeResume, null, 2) + "\n");

    billingReady = true;
    const report = await baseRun(harness, { checkpointPath: checkpoint.path, billingLoader });
    assert.equal(report.status, "passed");
    assert.equal(harness.created(), 10);
    assert.equal(harness.calls.filter((call) => call === "providerCanary").length, callsBefore);
  } finally {
    checkpoint.cleanup();
  }
});

test("observation checkpoint resumes from persisted checks after interruption", async () => {
  const checkpoint = temporaryCheckpoint();
  const harness = fakeHarness();
  let interrupted = false;
  try {
    await assert.rejects(
      baseRun(harness, {
        checkpointPath: checkpoint.path,
        sleep: async (milliseconds) => {
          if (!interrupted) {
            interrupted = true;
            throw Object.assign(new Error("simulated observation interruption"), { code: "P2_OBSERVATION_INTERRUPTED" });
          }
          await harness.sleep(milliseconds);
        },
      }),
      (error) => error.code === "P2_OBSERVATION_INTERRUPTED",
    );
    const interruptedCheckpoint = JSON.parse(readFileSync(checkpoint.path, "utf8"));
    assert.equal(interruptedCheckpoint.phase, "failed");
    assert.equal(interruptedCheckpoint.failure.resumePhase, "observing");
    assert.equal(interruptedCheckpoint.observation.checks.length, 1);
    const callsBefore = harness.calls.filter((call) => call === "providerCanary").length;

    const report = await baseRun(harness, { checkpointPath: checkpoint.path });
    assert.equal(report.status, "passed");
    assert.equal(report.runtime.observationChecks, 4);
    assert.equal(harness.calls.filter((call) => call === "providerCanary").length, callsBefore);
  } finally {
    checkpoint.cleanup();
  }
});

test("completed checkpoint reuses a validated report and rejects a different run binding", async () => {
  const checkpoint = temporaryCheckpoint();
  const harness = fakeHarness();
  try {
    const first = await baseRun(harness, { checkpointPath: checkpoint.path });
    const callsAfterFirstRun = harness.calls.filter((call) => call === "providerCanary").length;
    const second = await baseRun(harness, { checkpointPath: checkpoint.path });
    assert.deepEqual(second, first);
    assert.equal(harness.calls.filter((call) => call === "providerCanary").length, callsAfterFirstRun);
    await assert.rejects(
      baseRun(harness, { checkpointPath: checkpoint.path, runId: "different-run" }),
      (error) => error.code === "P2_CHECKPOINT_MISMATCH",
    );
  } finally {
    checkpoint.cleanup();
  }
});

test("corrupt checkpoint fails closed before any acceptance task is created", async () => {
  const checkpoint = temporaryCheckpoint();
  const harness = fakeHarness();
  try {
    writeFileSync(checkpoint.path, "{\"schemaVersion\":0}\n");
    await assert.rejects(
      baseRun(harness, { checkpointPath: checkpoint.path }),
      (error) => error.code === "P2_CHECKPOINT_INVALID",
    );
    assert.equal(harness.created(), 0);
  } finally {
    checkpoint.cleanup();
  }
});
