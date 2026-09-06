import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASR_CONFIG_DEFAULTS,
  ASR_LIMITS,
  ASR_PURPOSES,
  ASR_SUPPORTED_MEDIA_TYPES,
  AsrContractError,
  canonicalizeAsrMediaType,
  normalizeAsrTranscript,
  parseAsrContentEncoding,
  parseAsrContentLength,
  parseAsrDurationHeader,
  parseAsrIdempotencyKey,
  parseAsrLanguage,
  parseAsrPurpose,
  parseAsrQuery,
  parseAsrRequestHeaders,
} from "../src/asr/contracts.js";
import {
  assertAudioByteLength,
  assertAudioDuration,
  assertAudioMagic,
  detectAudioMediaType,
  validateAudioProbe,
} from "../src/asr/audioValidation.js";

function expectContractError(action, code, status) {
  assert.throws(
    action,
    (error) => {
      assert.ok(error instanceof AsrContractError);
      assert.equal(error.code, code);
      if (status !== undefined) assert.equal(error.status, status);
      return true;
    },
  );
}

function expectTypeError(action, name) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, new RegExp(name));
    assert.equal(Object.hasOwn(error, "code"), false);
    return true;
  });
}

function bytes(...values) {
  return Uint8Array.from(values);
}

function ascii(value) {
  return Uint8Array.from(Buffer.from(value, "ascii"));
}

function mp4Ftyp({ size = 24, prefixBytes = 0 } = {}) {
  const value = Buffer.alloc(prefixBytes + 24);
  const offset = prefixBytes;
  value.writeUInt32BE(size, offset);
  value.write("ftyp", offset + 4, "ascii");
  value.write("isom", offset + 8, "ascii");
  value.writeUInt32BE(0, offset + 12);
  value.write("isom", offset + 16, "ascii");
  value.write("mp42", offset + 20, "ascii");
  return value;
}

describe("ASR request and transcript contracts", () => {
  it("freezes the v0.10.4 thresholds and the only provider defaults", () => {
    assert.deepEqual(ASR_PURPOSES, {
      quick_record: { maxDurationMs: 120_000, maxTranscriptLength: 10_000 },
      assistant_chat: { maxDurationMs: 60_000, maxTranscriptLength: 2_000 },
    });
    assert.deepEqual(ASR_SUPPORTED_MEDIA_TYPES, [
      "audio/webm",
      "audio/ogg",
      "audio/mp4",
      "audio/wav",
    ]);
    assert.equal(ASR_LIMITS.uploadMaxBytes, 8_388_608);
    assert.equal(ASR_LIMITS.minDurationMs, 300);
    assert.equal(ASR_LIMITS.magicMaxBytes, 64);
    assert.equal(ASR_LIMITS.mp4FtypSearchBytes, 32);
    assert.equal(ASR_LIMITS.idempotencyTtlMs, 300_000);
    assert.equal(ASR_LIMITS.idempotencyCompletedCapacity, 256);
    assert.equal(ASR_CONFIG_DEFAULTS.mode, "disabled");
    assert.equal(ASR_CONFIG_DEFAULTS.provider, "openai-compatible");
    assert.equal(ASR_CONFIG_DEFAULTS.language, "zh-CN");
    assert.ok(Object.isFrozen(ASR_PURPOSES));
    assert.ok(Object.isFrozen(ASR_LIMITS));
  });

  it("accepts only the two exact purpose query values and rejects ambiguous query state", () => {
    assert.equal(parseAsrPurpose("quick_record"), "quick_record");
    assert.equal(parseAsrPurpose("assistant_chat"), "assistant_chat");
    for (const value of [undefined, null, "", "quick-record", "QUICK_RECORD", " quick_record "]) {
      expectTypeError(() => parseAsrPurpose(value), "purpose");
    }

    assert.deepEqual(parseAsrQuery(new URLSearchParams("purpose=quick_record")), {
      purpose: "quick_record",
    });
    assert.deepEqual(
      parseAsrQuery(new URLSearchParams("purpose=quick_record&ignored=not-metadata")),
      { purpose: "quick_record" },
    );
    for (const query of [
      new URLSearchParams(),
      new URLSearchParams("purpose=quick_record&purpose=assistant_chat"),
    ]) {
      expectTypeError(() => parseAsrQuery(query), "query");
    }
  });

  it("canonicalizes only the four MIME types while ignoring MIME parameters", () => {
    assert.equal(canonicalizeAsrMediaType("audio/webm;codecs=opus"), "audio/webm");
    assert.equal(canonicalizeAsrMediaType(" audio/ogg ; codecs=opus "), "audio/ogg");
    assert.equal(canonicalizeAsrMediaType("audio/mp4"), "audio/mp4");
    assert.equal(canonicalizeAsrMediaType("audio/wav; charset=binary"), "audio/wav");
    for (const value of [undefined, "", "application/octet-stream", "multipart/form-data; boundary=x", ["audio/wav"]]) {
      expectContractError(
        () => canonicalizeAsrMediaType(value),
        "AUDIO_MEDIA_TYPE_UNSUPPORTED",
        415,
      );
    }
  });

  it("allows only absent or identity Content-Encoding", () => {
    assert.equal(parseAsrContentEncoding(undefined), "identity");
    assert.equal(parseAsrContentEncoding(null), "identity");
    assert.equal(parseAsrContentEncoding("identity"), "identity");
    for (const value of ["", "Identity", " identity ", "gzip", "br", "deflate", "identity,gzip", ["identity"]]) {
      expectTypeError(() => parseAsrContentEncoding(value), "Content-Encoding");
    }
  });

  it("parses an optional positive decimal Content-Length through exactly 8 MiB", () => {
    assert.equal(parseAsrContentLength(undefined), null);
    assert.equal(parseAsrContentLength(null), null);
    assert.equal(parseAsrContentLength(" 1 "), 1);
    assert.equal(parseAsrContentLength("8388608"), 8_388_608);
    for (const value of ["", "0", "-1", "+1", "01", "1.0", "1e3", "NaN", true, ["1"]]) {
      expectTypeError(() => parseAsrContentLength(value), "Content-Length");
    }
    expectContractError(() => parseAsrContentLength("8388609"), "AUDIO_TOO_LARGE", 413);
  });

  it("trims and validates Idempotency-Key at the inclusive 16/128 boundaries", () => {
    const minimum = "a".repeat(16);
    const maximum = `a${"._:-Z0".repeat(22).slice(0, 127)}`;
    assert.equal(maximum.length, 128);
    assert.equal(parseAsrIdempotencyKey(`  ${minimum}  `), minimum);
    assert.equal(parseAsrIdempotencyKey(maximum), maximum);
    assert.equal(parseAsrIdempotencyKey("asr:12345678-1234-1234-1234-123456789abc"), "asr:12345678-1234-1234-1234-123456789abc");
    for (const value of [
      undefined,
      "a".repeat(15),
      `-${"a".repeat(15)}`,
      "a".repeat(129),
      `a${"b".repeat(14)} `,
      `a${"b".repeat(14)}\u0000`,
      `中${"a".repeat(15)}`,
      [minimum],
    ]) {
      expectContractError(() => parseAsrIdempotencyKey(value), "INVALID_IDEMPOTENCY_KEY", 400);
    }
  });

  it("parses the client duration hint as a positive safe decimal integer without trusting it as a limit", () => {
    assert.equal(parseAsrDurationHeader(undefined), null);
    assert.equal(parseAsrDurationHeader(null), null);
    assert.equal(parseAsrDurationHeader("1"), 1);
    assert.equal(parseAsrDurationHeader(" 12340 "), 12_340);
    assert.equal(parseAsrDurationHeader(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
    for (const value of ["", "0", "-1", "+1", "01", "1.5", "1e3", "Infinity", true]) {
      expectTypeError(() => parseAsrDurationHeader(value), "X-Audio-Duration-Ms");
    }
  });

  it("defaults language to zh-CN and rejects every other value", () => {
    assert.equal(parseAsrLanguage(undefined), "zh-CN");
    assert.equal(parseAsrLanguage(null), "zh-CN");
    assert.equal(parseAsrLanguage("zh-CN"), "zh-CN");
    for (const value of ["", " zh-CN ", "zh", "zh-cn", "en-US", "zh-CN,en-US", ["zh-CN"]]) {
      expectTypeError(() => parseAsrLanguage(value), "X-ASR-Language");
    }
  });

  it("parses the complete controlled header contract without accepting caller metadata", () => {
    assert.deepEqual(
      parseAsrRequestHeaders({
        "Content-Type": "audio/webm;codecs=opus",
        "Content-Encoding": "identity",
        "Content-Length": "4096",
        "Idempotency-Key": "asr:12345678-1234-1234-1234-123456789abc",
        "X-Audio-Duration-Ms": "12340",
        "X-ASR-Language": "zh-CN",
      }),
      {
        mediaType: "audio/webm",
        contentEncoding: "identity",
        contentLength: 4_096,
        idempotencyKey: "asr:12345678-1234-1234-1234-123456789abc",
        clientDurationMs: 12_340,
        language: "zh-CN",
      },
    );
  });

  it("accepts Headers objects while leaving absent optional transport hints as null/default", () => {
    const parsed = parseAsrRequestHeaders(new Headers({
      "Content-Type": "audio/wav",
      "Idempotency-Key": "asr:12345678-1234-1234-1234-123456789abc",
    }));
    assert.deepEqual(parsed, {
      mediaType: "audio/wav",
      contentEncoding: "identity",
      contentLength: null,
      idempotencyKey: "asr:12345678-1234-1234-1234-123456789abc",
      clientDurationMs: null,
      language: "zh-CN",
    });
  });

  it("normalizes provider transcript using CRLF, NFC, trim, and exact purpose limits", () => {
    assert.equal(normalizeAsrTranscript("  e\u0301\r\n第二行\t尾部  ", "quick_record"), "é\n第二行\t尾部");
    assert.equal(normalizeAsrTranscript("\n\t可保留\t\n", "assistant_chat"), "可保留");
    assert.equal(normalizeAsrTranscript("汉".repeat(10_000), "quick_record").length, 10_000);
    assert.equal(normalizeAsrTranscript("汉".repeat(2_000), "assistant_chat").length, 2_000);

    for (const value of ["", " \r\n\t "]) {
      expectContractError(() => normalizeAsrTranscript(value, "quick_record"), "ASR_TRANSCRIPT_EMPTY", 422);
    }
    for (const value of ["text\u0000", "text\u0001", "text\u000b", "text\rtext"]) {
      expectContractError(() => normalizeAsrTranscript(value, "quick_record"), "ASR_PROVIDER_BAD_RESPONSE", 502);
    }
    expectContractError(() => normalizeAsrTranscript(null, "quick_record"), "ASR_PROVIDER_BAD_RESPONSE", 502);
    expectContractError(
      () => normalizeAsrTranscript("汉".repeat(10_001), "quick_record"),
      "ASR_TRANSCRIPT_TOO_LONG",
      422,
    );
    expectContractError(
      () => normalizeAsrTranscript("汉".repeat(2_001), "assistant_chat"),
      "ASR_TRANSCRIPT_TOO_LONG",
      422,
    );
  });

  it("normalizes before counting and never truncates a boundary transcript", () => {
    assert.equal(
      normalizeAsrTranscript(`  ${"a".repeat(10_000)}  `, "quick_record"),
      "a".repeat(10_000),
    );
    assert.equal(
      normalizeAsrTranscript("e\u0301".repeat(2_000), "assistant_chat"),
      "é".repeat(2_000),
    );
  });

  it("rejects every C0 control except LF/TAB without extending the rule to DEL or C1", () => {
    const rejected = [];
    for (let codePoint = 0; codePoint <= 0x1f; codePoint += 1) {
      if (codePoint === 0x09 || codePoint === 0x0a) continue;
      rejected.push(String.fromCharCode(codePoint));
    }
    for (const control of rejected) {
      expectContractError(
        () => normalizeAsrTranscript(`a${control}b`, "quick_record"),
        "ASR_PROVIDER_BAD_RESPONSE",
        502,
      );
    }
    assert.equal(normalizeAsrTranscript("a\u007fb\u0080c\u009fd", "quick_record"), "a\u007fb\u0080c\u009fd");
  });
});

describe("ASR audio byte, magic, duration, and probe validation", () => {
  const samples = {
    "audio/webm": bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01),
    "audio/ogg": ascii("OggS\u0000extra"),
    "audio/mp4": mp4Ftyp(),
    "audio/wav": ascii("RIFF\u0010\u0000\u0000\u0000WAVEdata"),
  };

  it("accepts and detects all four exact MIME/magic combinations", () => {
    for (const [mediaType, sample] of Object.entries(samples)) {
      assert.equal(assertAudioMagic(mediaType, sample), mediaType);
      assert.equal(detectAudioMediaType(sample), mediaType);
    }
  });

  it("rejects every MIME/magic mismatch without guessing a fallback", () => {
    for (const [mediaType, sample] of Object.entries(samples)) {
      for (const otherMediaType of ASR_SUPPORTED_MEDIA_TYPES) {
        if (otherMediaType === mediaType) continue;
        expectContractError(
          () => assertAudioMagic(otherMediaType, sample),
          "AUDIO_SIGNATURE_MISMATCH",
          415,
        );
      }
    }
  });

  it("rejects short or malformed magic and an ftyp box outside the first 32 bytes", () => {
    for (const sample of [new Uint8Array(), ascii("RIFF"), ascii("Ogg"), bytes(0x1a, 0x45, 0xdf)]) {
      assert.equal(detectAudioMediaType(sample), null);
    }
    assert.equal(detectAudioMediaType(mp4Ftyp({ size: 8 })), null);
    assert.equal(detectAudioMediaType(mp4Ftyp({ prefixBytes: 32 })), null);
    expectContractError(
      () => assertAudioMagic("audio/mp4", mp4Ftyp({ prefixBytes: 32 })),
      "AUDIO_SIGNATURE_MISMATCH",
      415,
    );
  });

  it("accepts a valid ftyp box after a complete leading box while its type stays in the first 32 bytes", () => {
    const sample = Buffer.alloc(16 + 24);
    sample.writeUInt32BE(16, 0);
    sample.write("free", 4, "ascii");
    mp4Ftyp().copy(sample, 16);
    assert.equal(detectAudioMediaType(sample), "audio/mp4");
    assert.equal(assertAudioMagic("audio/mp4", sample), "audio/mp4");
  });

  it("enforces empty, one-byte, 8 MiB, and 8 MiB+1 body boundaries", () => {
    expectContractError(() => assertAudioByteLength(0), "AUDIO_BODY_REQUIRED", 400);
    assert.equal(assertAudioByteLength(1), 1);
    assert.equal(assertAudioByteLength(8_388_608), 8_388_608);
    expectContractError(() => assertAudioByteLength(8_388_609), "AUDIO_TOO_LARGE", 413);
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      expectContractError(() => assertAudioByteLength(value), "AUDIO_INVALID", 422);
    }
  });

  it("enforces the inclusive 300ms and purpose-specific authoritative duration boundaries", () => {
    expectContractError(() => assertAudioDuration(299, "assistant_chat"), "AUDIO_TOO_SHORT", 422);
    assert.equal(assertAudioDuration(300, "assistant_chat"), 300);
    assert.equal(assertAudioDuration(60_000, "assistant_chat"), 60_000);
    expectContractError(() => assertAudioDuration(60_001, "assistant_chat"), "AUDIO_TOO_LONG", 422);
    assert.equal(assertAudioDuration(120_000, "quick_record"), 120_000);
    expectContractError(() => assertAudioDuration(120_001, "quick_record"), "AUDIO_TOO_LONG", 422);
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "300"]) {
      expectContractError(() => assertAudioDuration(value, "quick_record"), "AUDIO_INVALID", 422);
    }
  });

  it("enforces a valid lowered effective duration without weakening the hard purpose ceiling", () => {
    assert.equal(assertAudioDuration(30_000, "assistant_chat", 30_000), 30_000);
    expectContractError(
      () => assertAudioDuration(30_001, "assistant_chat", 30_000),
      "AUDIO_TOO_LONG",
      422,
    );
    assert.equal(assertAudioDuration(90_000, "quick_record", 90_000), 90_000);
    expectContractError(
      () => assertAudioDuration(90_001, "quick_record", 90_000),
      "AUDIO_TOO_LONG",
      422,
    );
    for (const value of [299, 60_001, 1.5, Number.NaN, "60000"]) {
      expectTypeError(
        () => assertAudioDuration(300, "assistant_chat", value),
        "effectiveMaxDurationMs",
      );
    }
  });

  it("does not round a fractional probe duration across a hard boundary", () => {
    const assistantProbe = {
      format: { duration: "60.000001", format_name: "ogg" },
      streams: [{ index: 0, codec_type: "audio", codec_name: "opus", channels: 1, sample_rate: "8000" }],
    };
    expectContractError(
      () => validateAudioProbe(assistantProbe, { mediaType: "audio/ogg", purpose: "assistant_chat" }),
      "AUDIO_TOO_LONG",
      422,
    );
  });

  it("passes the lowered effective duration through probe validation", () => {
    const probe = {
      format: { duration: "30.001", format_name: "ogg" },
      streams: [{ index: 0, codec_type: "audio", codec_name: "opus", channels: 1, sample_rate: "8000" }],
    };
    expectContractError(
      () => validateAudioProbe(probe, {
        mediaType: "audio/ogg",
        purpose: "assistant_chat",
        effectiveMaxDurationMs: 30_000,
      }),
      "AUDIO_TOO_LONG",
      422,
    );
    probe.format.duration = "30";
    assert.equal(
      validateAudioProbe(probe, {
        mediaType: "audio/ogg",
        purpose: "assistant_chat",
        effectiveMaxDurationMs: 30_000,
      }).durationMs,
      30_000,
    );
  });

  it("accepts exactly one bounded audio stream, no video, and compatible container metadata", () => {
    const validated = validateAudioProbe(
      {
        format: { duration: "12.34", format_name: "matroska,webm" },
        streams: [
          { index: 0, codec_type: "audio", codec_name: "opus", channels: 2, sample_rate: "48000" },
        ],
      },
      { mediaType: "audio/webm", purpose: "quick_record" },
    );
    assert.deepEqual(validated, {
      durationMs: 12_340,
      formatNames: ["matroska", "webm"],
      audioStream: {
        index: 0,
        codecName: "opus",
        channels: 2,
        sampleRate: 48_000,
      },
    });
  });

  it("accepts inclusive channel and sample-rate probe boundaries", () => {
    for (const [channels, sampleRate] of [[1, "8000"], [2, "96000"]]) {
      const validated = validateAudioProbe(
        {
          format: { duration: "0.3", format_name: "wav" },
          streams: [{ index: 0, codec_type: "audio", codec_name: "pcm_s16le", channels, sample_rate: sampleRate }],
        },
        { mediaType: "audio/wav", purpose: "assistant_chat" },
      );
      assert.equal(validated.audioStream.channels, channels);
      assert.equal(validated.audioStream.sampleRate, Number(sampleRate));
    }
  });

  it("rejects invalid stream counts, video, channel/sample-rate bounds, format, and duration", () => {
    const valid = {
      format: { duration: "1", format_name: "ogg" },
      streams: [{ index: 0, codec_type: "audio", codec_name: "opus", channels: 1, sample_rate: "48000" }],
    };
    const invalid = [
      { ...valid, streams: [] },
      { ...valid, streams: [...valid.streams, { ...valid.streams[0], index: 1 }] },
      { ...valid, streams: [...valid.streams, { index: 1, codec_type: "video", codec_name: "h264" }] },
      { ...valid, streams: [{ ...valid.streams[0], channels: 0 }] },
      { ...valid, streams: [{ ...valid.streams[0], channels: 3 }] },
      { ...valid, streams: [{ ...valid.streams[0], sample_rate: "7999" }] },
      { ...valid, streams: [{ ...valid.streams[0], sample_rate: "96001" }] },
      { ...valid, format: { ...valid.format, duration: "NaN" } },
    ];
    for (const probe of invalid) {
      expectContractError(
        () => validateAudioProbe(probe, { mediaType: "audio/ogg", purpose: "quick_record" }),
        "AUDIO_INVALID",
        422,
      );
    }
    expectContractError(
      () => validateAudioProbe(valid, { mediaType: "audio/wav", purpose: "quick_record" }),
      "AUDIO_INVALID",
      422,
    );
  });
});
