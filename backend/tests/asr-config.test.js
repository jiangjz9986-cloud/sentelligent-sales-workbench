import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

const missingEnvFile = join(tmpdir(), "sentelligent-v0104-asr-missing.env");

function productionConfig(overrides = {}) {
  const validPasswordHash = [
    "scrypt",
    "16384",
    "8",
    "1",
    Buffer.alloc(16, 31).toString("base64url"),
    Buffer.alloc(64, 32).toString("base64url"),
  ].join("$");
  return {
    envFile: missingEnvFile,
    NODE_ENV: "production",
    AUTH_REQUIRED: "true",
    AUTH_ACCOUNT: "asr-production-account",
    AUTH_PASSWORD_HASH: validPasswordHash,
    AUTH_SESSION_SECRET: Buffer.alloc(32, 33).toString("base64url"),
    SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 34).toString("base64url"),
    WEIXIN_AGENT_API_TOKEN: Buffer.alloc(32, 35).toString("base64url"),
    ASSISTANT_CONFIRMATION_SECRET: Buffer.alloc(32, 36).toString("base64url"),
    WEIXIN_AGENT_OWNER: "asr-production-account",
    AUTH_COOKIE_SECURE: "true",
    CORS_ALLOWED_ORIGINS: "https://sales.example.test",
    ASR_TEMP_ROOT: "/run/sentelligent-asr",
    ASR_FFPROBE_COMMAND: "/usr/bin/ffprobe",
    ASR_FFMPEG_COMMAND: "/usr/bin/ffmpeg",
    ...overrides,
  };
}

describe("ASR configuration", () => {
  it("loads all twelve conservative defaults while keeping ASR disabled", () => {
    const config = loadConfig({ envFile: missingEnvFile, NODE_ENV: "test" });
    assert.deepEqual(
      {
        asrMode: config.asrMode,
        asrProvider: config.asrProvider,
        asrBaseUrl: config.asrBaseUrl,
        asrModel: config.asrModel,
        asrTimeoutMs: config.asrTimeoutMs,
        asrUploadMaxBytes: config.asrUploadMaxBytes,
        asrQuickMaxDurationMs: config.asrQuickMaxDurationMs,
        asrAssistantMaxDurationMs: config.asrAssistantMaxDurationMs,
        asrFfprobeCommand: config.asrFfprobeCommand,
        asrFfmpegCommand: config.asrFfmpegCommand,
        asrTempRoot: config.asrTempRoot,
        asrReuseModelCredential: config.asrReuseModelCredential,
      },
      {
        asrMode: "disabled",
        asrProvider: "openai-compatible",
        asrBaseUrl: "",
        asrModel: "",
        asrTimeoutMs: 45_000,
        asrUploadMaxBytes: 8_388_608,
        asrQuickMaxDurationMs: 120_000,
        asrAssistantMaxDurationMs: 60_000,
        asrFfprobeCommand: "/usr/bin/ffprobe",
        asrFfmpegCommand: "/usr/bin/ffmpeg",
        asrTempRoot: "/run/sentelligent-asr",
        asrReuseModelCredential: false,
      },
    );
    assert.equal(Object.hasOwn(config, "asrApiKey"), false);
  });

  it("parses explicit ASR values without confusing mode and provider", () => {
    const config = loadConfig({
      envFile: missingEnvFile,
      NODE_ENV: "test",
      ASR_MODE: "live",
      ASR_PROVIDER: "openai-compatible",
      ASR_BASE_URL: "https://asr.example.test/v1",
      ASR_MODEL: "whisper-1",
      ASR_TIMEOUT_MS: "44000",
      ASR_UPLOAD_MAX_BYTES: "4194304",
      ASR_QUICK_MAX_DURATION_MS: "110000",
      ASR_ASSISTANT_MAX_DURATION_MS: "55000",
      ASR_FFPROBE_COMMAND: "/opt/media/bin/ffprobe",
      ASR_FFMPEG_COMMAND: "/opt/media/bin/ffmpeg",
      ASR_TEMP_ROOT: "/tmp/asr-test-root",
      ASR_REUSE_MODEL_CREDENTIAL: "true",
    });
    assert.equal(config.asrMode, "live");
    assert.equal(config.asrProvider, "openai-compatible");
    assert.equal(config.asrBaseUrl, "https://asr.example.test/v1");
    assert.equal(config.asrModel, "whisper-1");
    assert.equal(config.asrTimeoutMs, 44_000);
    assert.equal(config.asrUploadMaxBytes, 4_194_304);
    assert.equal(config.asrQuickMaxDurationMs, 110_000);
    assert.equal(config.asrAssistantMaxDurationMs, 55_000);
    assert.equal(config.asrFfprobeCommand, "/opt/media/bin/ffprobe");
    assert.equal(config.asrFfmpegCommand, "/opt/media/bin/ffmpeg");
    assert.equal(config.asrTempRoot, "/tmp/asr-test-root");
    assert.equal(config.asrReuseModelCredential, true);
    assert.equal(Object.hasOwn(config, "asrApiKey"), false);
  });

  it("fails closed for unknown ASR mode or every non-frozen provider", () => {
    const base = { envFile: missingEnvFile, NODE_ENV: "test" };
    for (const value of ["", "enabled", "mock", "off", "LIVE", " live ", true]) {
      assert.throws(() => loadConfig({ ...base, ASR_MODE: value }), /ASR_MODE/);
    }
    for (const value of ["", "local-whisper", "whisper-cli", "openai", "OPENAI-COMPATIBLE", " openai-compatible ", true]) {
      assert.throws(() => loadConfig({ ...base, ASR_PROVIDER: value }), /ASR_PROVIDER/);
    }
  });

  it("rejects malformed or unsafe numeric, model, URL, command, and boolean settings", () => {
    const base = { envFile: missingEnvFile, NODE_ENV: "test" };
    for (const [field, values] of Object.entries({
      ASR_TIMEOUT_MS: [0, -1, 1.5, "1e3", "45001", true],
      ASR_UPLOAD_MAX_BYTES: [0, -1, 1.5, "1e3", "8388609", true],
      ASR_QUICK_MAX_DURATION_MS: [299, "120001", "NaN", true],
      ASR_ASSISTANT_MAX_DURATION_MS: [299, "60001", "NaN", true],
    })) {
      for (const value of values) {
        assert.throws(() => loadConfig({ ...base, [field]: value }), new RegExp(field));
      }
    }
    assert.throws(
      () => loadConfig({ ...base, ASR_QUICK_MAX_DURATION_MS: "60000", ASR_ASSISTANT_MAX_DURATION_MS: "60001" }),
      /ASR_ASSISTANT_MAX_DURATION_MS/,
    );
    for (const value of ["bad model", "model/with/slash", "\u0000model", "a".repeat(201)]) {
      assert.throws(() => loadConfig({ ...base, ASR_MODEL: value }), /ASR_MODEL/);
    }
    for (const value of [
      "not-a-url",
      "ftp://asr.example.test",
      "http://asr.example.test/v1",
      "http://127.0.0.1:9999/v1",
      "https://user:pass@asr.example.test",
      "https://asr.example.test/v1?token=x",
      "https://asr.example.test/v1#fragment",
    ]) {
      assert.throws(() => loadConfig({ ...base, ASR_BASE_URL: value }), /ASR_BASE_URL/);
    }
    for (const field of ["ASR_FFPROBE_COMMAND", "ASR_FFMPEG_COMMAND", "ASR_TEMP_ROOT"]) {
      for (const value of ["", "path\u0000suffix", "a".repeat(301)]) {
        assert.throws(() => loadConfig({ ...base, [field]: value }), new RegExp(field));
      }
    }
    assert.throws(() => loadConfig({ ...base, ASR_REUSE_MODEL_CREDENTIAL: "invalid" }), /ASR_REUSE_MODEL_CREDENTIAL/);
  });

  it("allows HTTP loopback only through explicit test dependency injection", () => {
    const loopback = {
      envFile: missingEnvFile,
      NODE_ENV: "test",
      ASR_BASE_URL: "http://127.0.0.1:9999/v1",
    };
    assert.throws(() => loadConfig(loopback), /ASR_BASE_URL.*https|https.*ASR_BASE_URL/);
    assert.equal(
      loadConfig(loopback, { allowAsrTestLoopbackHttp: true }).asrBaseUrl,
      "http://127.0.0.1:9999/v1",
    );
    assert.equal(
      loadConfig({ ...loopback, ASR_BASE_URL: "http://localhost:9999/v1" }, { allowAsrTestLoopbackHttp: true }).asrBaseUrl,
      "http://localhost:9999/v1",
    );
    assert.throws(
      () => loadConfig({ ...loopback, ASR_BASE_URL: "http://asr.example.test/v1" }, { allowAsrTestLoopbackHttp: true }),
      /ASR_BASE_URL.*https|https.*ASR_BASE_URL/,
    );
    assert.throws(
      () => loadConfig({ ...loopback, NODE_ENV: "development" }, { allowAsrTestLoopbackHttp: true }),
      /ASR_BASE_URL.*https|https.*ASR_BASE_URL/,
    );
    assert.throws(
      () => loadConfig(productionConfig({ ASR_BASE_URL: loopback.ASR_BASE_URL }), { allowAsrTestLoopbackHttp: true }),
      /ASR_BASE_URL.*https|https.*ASR_BASE_URL/,
    );
  });

  it("allows the production kill switch to remain disabled without pretending readiness", () => {
    const config = loadConfig(productionConfig());
    assert.equal(config.asrMode, "disabled");
    assert.equal(config.asrProvider, "openai-compatible");
    assert.equal(config.asrBaseUrl, "");
    assert.equal(config.asrModel, "");
  });

  it("requires complete independent live provider configuration in production", () => {
    const live = productionConfig({
      ASR_MODE: "live",
      ASR_BASE_URL: "https://asr.example.test/v1",
      ASR_MODEL: "whisper-1",
      ASR_REUSE_MODEL_CREDENTIAL: "false",
    });
    const config = loadConfig(live);
    assert.equal(config.asrMode, "live");
    assert.equal(config.asrBaseUrl, "https://asr.example.test/v1");
    assert.equal(config.asrModel, "whisper-1");

    assert.throws(() => loadConfig({ ...live, ASR_BASE_URL: "" }), /ASR_BASE_URL/);
    assert.throws(() => loadConfig({ ...live, ASR_MODEL: "" }), /ASR_MODEL/);
    assert.throws(() => loadConfig({ ...live, ASR_BASE_URL: "http://127.0.0.1:9999/v1" }), /ASR_BASE_URL.*https|https.*ASR_BASE_URL/);
    assert.throws(() => loadConfig({ ...live, ASR_REUSE_MODEL_CREDENTIAL: "true" }), /ASR_REUSE_MODEL_CREDENTIAL/);
  });

  it("pins production commands and temp root to absolute protected runtime locations", () => {
    for (const [field, value] of [
      ["ASR_FFPROBE_COMMAND", "ffprobe"],
      ["ASR_FFMPEG_COMMAND", "ffmpeg"],
      ["ASR_TEMP_ROOT", "relative/asr"],
      ["ASR_TEMP_ROOT", "/tmp/asr"],
    ]) {
      assert.throws(() => loadConfig(productionConfig({ [field]: value })), new RegExp(field));
    }
  });

  it("documents exactly the twelve ASR env keys with no secret placeholder", () => {
    const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const expected = [
      "ASR_MODE=disabled",
      "ASR_PROVIDER=openai-compatible",
      "ASR_BASE_URL=",
      "ASR_MODEL=",
      "ASR_TIMEOUT_MS=45000",
      "ASR_UPLOAD_MAX_BYTES=8388608",
      "ASR_QUICK_MAX_DURATION_MS=120000",
      "ASR_ASSISTANT_MAX_DURATION_MS=60000",
      "ASR_FFPROBE_COMMAND=/usr/bin/ffprobe",
      "ASR_FFMPEG_COMMAND=/usr/bin/ffmpeg",
      "ASR_TEMP_ROOT=/run/sentelligent-asr",
      "ASR_REUSE_MODEL_CREDENTIAL=false",
    ];
    for (const line of expected) assert.match(envExample, new RegExp(`^${line.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "m"));
    assert.doesNotMatch(envExample, /^ASR_API_KEY=/m);
  });

  it("keeps the contract and validation modules pure", () => {
    for (const relativePath of ["../src/asr/contracts.js", "../src/asr/audioValidation.js"]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      assert.doesNotMatch(source, /node:fs|node:child_process|\bfetch\s*\(|\bspawn\s*\(|\bexec(?:File)?\s*\(|\bDatabase\b|\bsqlite\b/i);
    }
  });
});
