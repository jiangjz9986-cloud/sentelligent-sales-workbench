import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_AUDIO_BYTES,
  PURPOSE_LIMITS,
  getRecordingCapability,
  getTranscriptionPurposeLimits,
  normalizeRecorderMimeType,
  selectRecordingMimeType,
} from "./recordingCapabilities.js";

function recorderWithSupport(supported) {
  return class FakeMediaRecorder {
    static isTypeSupported(value) {
      return supported.includes(value);
    }
  };
}

describe("recording capabilities", () => {
  it("prefers Chromium Opus WebM before every other supported type", () => {
    const Recorder = recorderWithSupport([
      "audio/mp4",
      "audio/ogg;codecs=opus",
      "audio/webm;codecs=opus",
    ]);
    assert.equal(selectRecordingMimeType(Recorder), "audio/webm;codecs=opus");
  });

  it("selects Safari AAC MP4 when WebM is unavailable", () => {
    const Recorder = recorderWithSupport(["audio/mp4;codecs=mp4a.40.2", "audio/mp4"]);
    assert.equal(selectRecordingMimeType(Recorder), "audio/mp4;codecs=mp4a.40.2");
  });

  it("falls back to generic MP4, then Opus Ogg", () => {
    assert.equal(selectRecordingMimeType(recorderWithSupport(["audio/mp4"])), "audio/mp4");
    assert.equal(
      selectRecordingMimeType(recorderWithSupport(["audio/ogg;codecs=opus"])),
      "audio/ogg;codecs=opus",
    );
  });

  it("uses the browser default when MediaRecorder exists but no candidate is reported", () => {
    assert.equal(selectRecordingMimeType(recorderWithSupport([])), "");
  });

  it("reports unsupported when MediaRecorder is absent or malformed", () => {
    assert.equal(selectRecordingMimeType(undefined), null);
    assert.equal(selectRecordingMimeType({}), null);
  });

  it("normalizes supported recorder media types without inventing a format", () => {
    assert.equal(
      normalizeRecorderMimeType(" AUDIO/WEBM ; CODECS=OPUS "),
      "audio/webm;codecs=opus",
    );
    assert.equal(normalizeRecorderMimeType("audio/mp4; codecs=mp4a.40.2"), "audio/mp4;codecs=mp4a.40.2");
    assert.equal(normalizeRecorderMimeType("audio/wav"), "audio/wav");
    assert.equal(normalizeRecorderMimeType("video/webm"), null);
    assert.equal(normalizeRecorderMimeType(""), null);
  });

  it("requires both getUserMedia and MediaRecorder for server capture readiness", () => {
    const Recorder = recorderWithSupport(["audio/webm;codecs=opus"]);
    assert.deepEqual(
      getRecordingCapability({ getUserMedia() {} }, Recorder),
      { supported: true, mimeType: "audio/webm;codecs=opus", usesBrowserDefault: false },
    );
    assert.deepEqual(
      getRecordingCapability({}, Recorder),
      { supported: false, mimeType: null, usesBrowserDefault: false, reason: "get_user_media_unavailable" },
    );
    assert.deepEqual(
      getRecordingCapability({ getUserMedia() {} }, undefined),
      { supported: false, mimeType: null, usesBrowserDefault: false, reason: "media_recorder_unavailable" },
    );
  });

  it("publishes frozen purpose, duration, and byte limits", () => {
    assert.equal(MAX_AUDIO_BYTES, 8 * 1024 * 1024);
    assert.deepEqual(PURPOSE_LIMITS.quick_record, {
      maxDurationMs: 120_000,
      maxTranscriptCharacters: 10_000,
    });
    assert.deepEqual(PURPOSE_LIMITS.assistant_chat, {
      maxDurationMs: 60_000,
      maxTranscriptCharacters: 2_000,
    });
    assert.strictEqual(getTranscriptionPurposeLimits("quick_record"), PURPOSE_LIMITS.quick_record);
    assert.throws(
      () => getTranscriptionPurposeLimits("unknown"),
      /quick_record or assistant_chat/,
    );
  });
});
