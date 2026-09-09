import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/server.js";
import { createAiPlatformRuntime } from "../../backend/src/aiPlatform/runtime.js";
import { runAiPlatformMediaTask } from "../../backend/src/aiPlatform/structuredAdapter.js";

const AUTH = Buffer.alloc(32, 96).toString("base64url");
const IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
function audio() {
  const bytes = Buffer.alloc(32044);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(32000, 40);
  return bytes;
}

test("signed binary upload drives vision and ASR over HTTP with owner binding, replay safety and cleanup", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ai-media-http-")));
  const supplied = [];
  const supplier = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    supplied.push({ path: request.url, bytes: raw, headers: request.headers });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/audio/transcriptions") {
      response.end(JSON.stringify({ text: "fixture transcript", duration: 1 }));
    } else {
      response.end(JSON.stringify({
        id: "vision-response-1", model: "vision-test",
        usage: { prompt_tokens: 120, completion_tokens: 25 },
        choices: [{ finish_reason: "stop", message: { content: '{"totalCents":1200,"invoiceNumber":"fixture"}' } }],
      }));
    }
  });
  await listen(supplier);
  const supplierUrl = `http://127.0.0.1:${supplier.address().port}`;
  const policies = [
    { id: "provider-vision-test", kind: "vision", baseUrl: supplierUrl, credentialEnv: "AI_PROVIDER_VISION_TEST_KEY", models: [{ name: "vision-test", taskTypes: ["invoice.recognize"], maxOutputTokens: 1000 }] },
    { id: "provider-asr-test", kind: "asr", baseUrl: supplierUrl, credentialEnv: "AI_PROVIDER_ASR_TEST_KEY", models: [{ name: "asr-test", taskTypes: ["asr.transcribe"], maxOutputTokens: 1000 }] },
  ];
  const platform = createServer({
    config: {
      nodeEnv: "test", databasePath: ":memory:", authSecret: AUTH, requestBindingRequired: true,
      executionMode: "external-provider", externalProvidersEnabled: true, providerPolicies: policies, allowProviderTestLoopback: true,
      mediaDirectory: join(dir, "media"), mediaEncryptionKey: Buffer.alloc(32, 97).toString("base64url"),
      taskPollMs: 10,
    },
    env: { AI_PROVIDER_VISION_TEST_KEY: "synthetic-vision-credential", AI_PROVIDER_ASR_TEST_KEY: "synthetic-asr-credential" },
    autoStart: false, logger: { error() {} },
  });
  const db = platform.aiPlatform.db;
  for (const policy of policies) {
    const model = policy.models[0];
    db.prepare("INSERT INTO providers VALUES (?, ?, ?, 1, '{}', ?, ?)").run(policy.id, "Fixture", policy.kind, "2026-01-01", "2026-01-01");
    db.prepare("INSERT INTO models VALUES (?, ?, ?, '{}', 1, ?, ?)").run(model.name, policy.id, model.name, "2026-01-01", "2026-01-01");
    const slug = policy.kind === "vision" ? "invoice" : "asr";
    const selected = db.prepare("SELECT id FROM agents WHERE slug = ?").get(slug);
    assert.ok(selected, slug);
    db.prepare("UPDATE agent_versions SET model_policy_json = ?, limits_json = ? WHERE agent_id = ?").run(
      JSON.stringify({ providerId: policy.id, modelId: model.name, externalAllowed: true }),
      JSON.stringify({ maxTokens: 1000, maxInputTokens: 128000, timeoutMs: 1000, maxAttempts: 1 }),
      selected.id,
    );
    db.prepare("INSERT INTO price_versions SELECT ?, ?, 'fixture-v1', 'USD', 1000, 1000, 0, 60, 0, 0, effective_from, effective_to, created_at FROM price_versions WHERE id = 'price-mock-zero-v1'").run("price-" + model.name, model.name);
  }
  platform.aiPlatform.taskService.start();
  await listen(platform);
  const runtimeConfig = {
    aiPlatformMode: "required", aiPlatformExecutionMode: "external-provider", aiPlatformAuthSecret: AUTH,
    aiPlatformBaseUrl: `http://127.0.0.1:${platform.address().port}`, aiPlatformMaxWaitMs: 3000, aiPlatformPollMs: 10,
  };
  const backend = createAiPlatformRuntime({ config: runtimeConfig });
  const config = { ...runtimeConfig, aiPlatformRuntime: backend };
  try {
    const media = { mediaType: "image/png", byteLength: IMAGE.length, sha256: digest(IMAGE), pageCount: 1 };
    const input = { taskType: "invoice.recognize", feature: "invoice", channel: "web", owner: "alice", actor: "alice", media, bytes: IMAGE, config };
    const result = await runAiPlatformMediaTask(input);
    assert.equal(result.totalCents, 1200);
    assert.equal(supplied.length, 1);
    const completion = JSON.parse(supplied[0].bytes.toString());
    assert.equal(completion.messages[1].content[1].image_url.url, "data:image/png;base64," + IMAGE.toString("base64"));
    assert.equal(readdirSync(join(dir, "media")).length, 0);
    const replay = await runAiPlatformMediaTask(input);
    assert.equal(replay.totalCents, 1200);
    assert.equal(supplied.length, 1);
    const wav = audio();
    const descriptor = { mediaType: "audio/wav", byteLength: wav.length, sha256: digest(wav), durationMs: 1000, purpose: "assistant_chat", language: "zh-CN" };
    const uploaded = await backend.uploadMedia({ bytes: wav, media: descriptor, owner: "alice" });
    await assert.rejects(backend.runTask({
      taskType: "asr.transcribe", feature: "asr", channel: "web", owner: "bob", input: { media: descriptor, mediaRef: uploaded.id },
    }), (error) => error.code === "media_not_found");
    const transcript = await backend.runTask({
      taskType: "asr.transcribe", feature: "asr", channel: "web", owner: "alice", input: { media: descriptor, mediaRef: uploaded.id },
    });
    assert.equal(transcript.result.metadata.transcript, "fixture transcript");
    assert.equal(supplied[1].path, "/audio/transcriptions");
    assert.match(supplied[1].headers["content-type"], /multipart\/form-data; boundary=/);
    assert.equal(supplied[1].bytes.includes(wav), true);
    assert.equal(readdirSync(join(dir, "media")).length, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM tasks").get().n, 2);
    const records = JSON.stringify(db.prepare("SELECT input_json,output_json FROM tasks").all());
    assert.equal(records.includes(IMAGE.toString("base64")), false);
    assert.equal(records.includes(dir), false);
    assert.equal(db.prepare("SELECT cost_status FROM usage_ledger WHERE task_type = 'asr.transcribe'").get().cost_status, "calculated");
  } finally {
    await platform.closeAiPlatform();
    await new Promise((resolve) => supplier.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
