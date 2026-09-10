import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hasAiPlatformTextRuntime,
  runAiPlatformTextCompletion,
  textModelAvailability,
} from "./textAdapter.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function completionBody(content) {
  return {
    choices: [{ message: { role: "assistant", content } }],
  };
}

function completionRuntime({ response, method = "complete", calls = [] } = {}) {
  return {
    enabled: () => true,
    configured: () => true,
    createCompletionClient(metadata) {
      const call = { metadata };
      calls.push(call);
      return {
        [method]: async (request, options) => {
          call.request = request;
          call.options = options;
          return typeof response === "function" ? response({ request, options, metadata }) : response;
        },
      };
    },
  };
}

const baseOptions = {
  taskType: "quick-record.analyze",
  feature: "quick_record_analysis",
  channel: "web",
  owner: "owner-a",
  actor: "actor-a",
  subject: { type: "quick_record", id: "record-a" },
  messages: [{ role: "user", content: "客户需要升级方案" }],
  maxTokens: 3200,
};

describe("AI platform text adapter", () => {
  it("prefers config.aiPlatformRuntime and passes complete metadata while preserving the chat request", async () => {
    const calls = [];
    let fetchCalls = 0;
    const result = await runAiPlatformTextCompletion({
      ...baseOptions,
      config: {
        aiAnalysisMode: "model",
        modelName: "must-not-override-platform-target",
        aiPlatformRuntime: completionRuntime({
          calls,
          response: jsonResponse(completionBody("{\"ok\":true}")),
        }),
      },
      options: {
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("text adapter must not call provider fetch directly");
        },
      },
    });

    assert.equal(result, "{\"ok\":true}");
    assert.equal(fetchCalls, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].metadata, {
      taskType: "quick-record.analyze",
      feature: "quick_record_analysis",
      channel: "web",
      owner: "owner-a",
      actor: "actor-a",
      subject: { type: "quick_record", id: "record-a" },
      idempotencyKey: calls[0].metadata.idempotencyKey,
    });
    assert.match(calls[0].metadata.idempotencyKey, /^text:quick_record_analysis:[a-f0-9]{48}$/u);
    assert.equal(calls[0].request.messages[0].content, "客户需要升级方案");
    assert.deepEqual(calls[0].request.response_format, { type: "json_object" });
    assert.equal(calls[0].request.max_tokens, 3200);
    assert.equal(calls[0].request.stream, false);
    assert.equal(calls[0].request.model, "gpt-5.6-luna");
  });

  it("supports a completion client exposing the in-progress runTask name", async () => {
    const calls = [];
    const result = await runAiPlatformTextCompletion({
      ...baseOptions,
      config: {
        aiAnalysisMode: "model",
        aiPlatformRuntime: completionRuntime({
          method: "runTask",
          calls,
          response: jsonResponse(completionBody("runtime-runTask")),
        }),
      },
    });

    assert.equal(result, "runtime-runTask");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.response_format.type, "json_object");
    assert.equal(calls[0].options.metadata.owner, "owner-a");
    assert.equal(calls[0].options.metadata.taskType, "quick-record.analyze");
  });

  it("supports runtime.runTask and nested task-client results without exposing the platform envelope", async () => {
    const runtimeResult = {
      task: { taskId: "task-1", status: "succeeded" },
      result: {
        schemaVersion: "ai-task-result-v1",
        metadata: {
          completionResponse: completionBody("nested-runtime-result"),
        },
      },
    };
    const result = await runAiPlatformTextCompletion({
      ...baseOptions,
      config: {
        aiAnalysisMode: "model",
        aiPlatformRuntime: {
          runTask: async (request) => {
            assert.equal(request.taskType, "quick-record.analyze");
            assert.equal(request.input.protocol, "chat.completions.v1");
            assert.equal(request.input.model, "gpt-5.6-luna");
            assert.equal(request.input.reasoningEffort, "max");
            assert.equal(request.input.request.model, "gpt-5.6-luna");
            assert.equal(request.input.request.reasoningEffort, "max");
            assert.equal(request.request.messages[0].content, "客户需要升级方案");
            return runtimeResult;
          },
        },
      },
    });

    assert.equal(result, "nested-runtime-result");
  });

  it("ignores caller model and reasoning overrides on every platform completion path", async () => {
    const calls = [];
    const result = await runAiPlatformTextCompletion({
      ...baseOptions,
      config: {
        aiAnalysisMode: "model",
        aiPlatformTargetModel: "gpt-5.6-luna",
        aiPlatformRuntime: completionRuntime({
          calls,
          response: jsonResponse(completionBody("fixed-target")),
        }),
      },
      options: {
        model: "forged-model",
        reasoningEffort: "low",
      },
    });

    assert.equal(result, "fixed-target");
    assert.equal(calls[0].request.model, "gpt-5.6-luna");
    assert.equal(calls[0].request.reasoningEffort, undefined);
  });

  it("unwraps the raw ai-platform client result shape", async () => {
    const result = await runAiPlatformTextCompletion({
      ...baseOptions,
      config: {
        aiAnalysisMode: "model",
        aiPlatformClient: {
          runTask: async ({ request, idempotencyKey }) => {
            assert.equal(request.schemaVersion, "ai-task-v1");
            assert.equal(request.taskType, "quick-record.analyze");
            assert.equal(request.input.protocol, "chat.completions.v1");
            assert.match(idempotencyKey, /^text:quick_record_analysis:/u);
            return {
              task: { taskId: "task-2", status: "succeeded" },
              result: {
                result: {
                  schemaVersion: "ai-task-result-v1",
                  metadata: { completionResponse: completionBody("nested-client-result") },
                },
              },
            };
          },
        },
      },
    });

    assert.equal(result, "nested-client-result");
  });

  it("rejects local-simulated generic task results instead of exposing facts or summaries", async () => {
    await assert.rejects(
      runAiPlatformTextCompletion({
        ...baseOptions,
        config: {
          aiAnalysisMode: "model",
          aiPlatformRuntime: completionRuntime({
            response: jsonResponse({
              schemaVersion: "ai-task-result-v1",
              status: "success",
              source: "mock",
              facts: [{ key: "input_summary", value: "客户原始文本不应返回" }],
              suggestions: ["通用 mock 摘要不应返回"],
            }),
          }),
        },
      }),
      (error) => {
        assert.equal(error.code, "INVALID_RESULT");
        assert.match(error.message, /不兼容|incompatible/u);
        assert.doesNotMatch(error.message, /input_summary|通用 mock|客户原始文本/u);
        return true;
      },
    );
  });

  it("labels local-simulated text tasks as unavailable when the platform has no completion payload", async () => {
    await assert.rejects(
      runAiPlatformTextCompletion({
        ...baseOptions,
        config: {
          aiAnalysisMode: "model",
          aiPlatformRuntime: completionRuntime({
            response: jsonResponse({
              schemaVersion: "ai-task-result-v1",
              status: "success",
              source: "mock",
              metadata: { executionMode: "local-simulated" },
            }),
          }),
        },
      }),
      (error) => error?.code === "LOCAL_SIMULATION_ONLY" && error?.status === 503,
    );
  });

  it("generates a stable idempotency key without embedding the input text", async () => {
    const firstCalls = [];
    const secondCalls = [];
    const makeConfig = (calls) => ({
      aiAnalysisMode: "model",
      aiPlatformRuntime: completionRuntime({
        calls,
        response: jsonResponse(completionBody("ok")),
      }),
    });
    await runAiPlatformTextCompletion({ ...baseOptions, config: makeConfig(firstCalls) });
    await runAiPlatformTextCompletion({ ...baseOptions, config: makeConfig(secondCalls) });

    assert.equal(firstCalls[0].metadata.idempotencyKey, secondCalls[0].metadata.idempotencyKey);
    assert.doesNotMatch(firstCalls[0].metadata.idempotencyKey, /客户需要升级方案/u);
  });

  it("keeps the legacy provider path available when the platform mode is disabled", async () => {
    const requests = [];
    const config = {
      aiAnalysisMode: "model",
      aiPlatformMode: "disabled",
      modelApiKeyProvider: () => "test-model-key",
      modelBaseUrl: "https://provider.example.invalid",
      modelName: "legacy-model",
      aiPlatformTargetModel: "gpt-5.6-luna",
    };

    const result = await runAiPlatformTextCompletion({
      ...baseOptions,
      config,
      options: {
        aiPlatformRuntime: {
          enabled: () => true,
          configured: () => true,
          createCompletionClient: async () => {
            throw new Error("disabled mode must not use the platform");
          },
        },
        fetchImpl: async (url, options) => {
          requests.push({ url, options });
          return jsonResponse(completionBody("legacy-provider"));
        },
      },
    });

    assert.equal(result, "legacy-provider");
    assert.equal(hasAiPlatformTextRuntime(config, {
      aiPlatformRuntime: {
        enabled: () => true,
        configured: () => true,
        createCompletionClient: () => { throw new Error("disabled mode must not use the platform"); },
      },
    }), false);
    assert.equal(textModelAvailability(config, {}), "available");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://provider.example.invalid/chat/completions");
    assert.equal(requests[0].options.headers.Authorization, "Bearer test-model-key");
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.model, "legacy-model");
    assert.equal(body.messages[0].content, "客户需要升级方案");
    assert.deepEqual(body.response_format, { type: "json_object" });
  });

  it("preserves bounded DeepSeek thinking controls on the legacy fallback path", async () => {
    const requests = [];
    const result = await runAiPlatformTextCompletion({
      ...baseOptions,
      config: {
        aiAnalysisMode: "model",
        aiPlatformMode: "disabled",
        modelApiKey: "test-model-key",
        modelBaseUrl: "https://provider.example.invalid",
        modelName: "legacy-model",
      },
      thinking: { type: "disabled" },
      options: {
        fetchImpl: async (url, options) => {
          requests.push({ url, options });
          return jsonResponse(completionBody("legacy-thinking-control"));
        },
      },
    });

    assert.equal(result, "legacy-thinking-control");
    assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.thinking, { type: "disabled" });
  });

  it("uses the legacy provider only when optional platform mode is not configured", async () => {
    let platformCalls = 0;
    let providerCalls = 0;
    const config = {
      aiAnalysisMode: "model",
      aiPlatformMode: "optional",
      aiPlatformRuntime: {
        enabled: () => true,
        configured: () => false,
        createCompletionClient: async () => {
          platformCalls += 1;
          throw new Error("unconfigured optional platform must not be called");
        },
      },
      modelApiKey: "test-model-key",
      modelBaseUrl: "https://provider.example.invalid",
      modelName: "legacy-model",
    };

    const result = await runAiPlatformTextCompletion({
      ...baseOptions,
      config,
      options: {
        fetchImpl: async () => {
          providerCalls += 1;
          return jsonResponse(completionBody("optional-legacy"));
        },
      },
    });

    assert.equal(result, "optional-legacy");
    assert.equal(platformCalls, 0);
    assert.equal(providerCalls, 1);
    assert.equal(textModelAvailability(config, {}), "available");
  });

  it("prefers a configured optional platform over the legacy provider", async () => {
    let providerCalls = 0;
    const calls = [];
    const config = {
      aiAnalysisMode: "model",
      aiPlatformMode: "optional",
      modelApiKey: "test-model-key",
      modelBaseUrl: "https://provider.example.invalid",
      aiPlatformRuntime: completionRuntime({
        calls,
        response: jsonResponse(completionBody("optional-platform")),
      }),
    };

    const result = await runAiPlatformTextCompletion({
      ...baseOptions,
      config,
      options: {
        fetchImpl: async () => {
          providerCalls += 1;
          throw new Error("configured optional platform must not use legacy provider");
        },
      },
    });

    assert.equal(result, "optional-platform");
    assert.equal(providerCalls, 0);
    assert.equal(calls.length, 1);
    assert.equal(textModelAvailability(config, {}), "available");
  });

  it("blocks the legacy provider when required platform mode is unavailable", async () => {
    let fetchCalls = 0;
    const config = {
      aiAnalysisMode: "model",
      aiPlatformMode: "required",
      modelApiKey: "test-model-key",
      modelBaseUrl: "https://provider.example.invalid",
    };

    assert.equal(hasAiPlatformTextRuntime(config, { fetchImpl: async () => {} }), false);
    assert.equal(textModelAvailability(config, {}), "unavailable");
    await assert.rejects(
      runAiPlatformTextCompletion({
        ...baseOptions,
        config,
        options: {
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("must not call provider");
          },
        },
      }),
      (error) => error.code === "AI_PLATFORM_NOT_CONFIGURED",
    );
    assert.equal(fetchCalls, 0);
  });
});
