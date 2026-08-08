import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createLocalDocumentTextExtractor,
  probeLocalDocumentTextTools,
} from "../src/travelExpense/localDocumentTextExtractor.js";

describe("local invoice document text extractor", () => {
  it("uses fixed image and PDF arguments, returns text, and removes temporary originals", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sentelligent-document-extractor-test-"));
    const calls = [];
    const runner = async ({ command, args, inputPath, timeoutMs }) => {
      await access(inputPath);
      calls.push({ command, args, inputPath, timeoutMs });
      return command === "safe-tesseract" ? "  发票号码 123456  \n" : "  PDF 发票文本  \n";
    };
    const extractor = createLocalDocumentTextExtractor({
      ocrCommand: "safe-tesseract",
      pdfTextCommand: "safe-pdftotext",
      ocrLanguages: "chi_sim+eng",
      timeoutMs: 4321,
      tempRoot,
      runner,
    });

    try {
      assert.equal(await extractor.extract("image/png", Buffer.from("image-original")), "发票号码 123456");
      assert.equal(await extractor.extract("application/pdf", Buffer.from("pdf-original")), "PDF 发票文本");
      assert.equal(calls.length, 2);
      assert.equal(calls[0].command, "safe-tesseract");
      assert.deepEqual(calls[0].args.slice(1), ["stdout", "-l", "chi_sim+eng", "--psm", "6"]);
      assert.equal(calls[0].timeoutMs, 4321);
      assert.equal(calls[1].command, "safe-pdftotext");
      assert.deepEqual(calls[1].args.slice(0, 1), ["-layout"]);
      assert.equal(calls[1].args.at(-1), "-");
      for (const call of calls) {
        await assert.rejects(access(call.inputPath));
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed with stable codes when a required local tool is not configured", async () => {
    const extractor = createLocalDocumentTextExtractor({
      ocrCommand: "",
      pdfTextCommand: "",
    });

    await assert.rejects(
      extractor.extract("image/jpeg", Buffer.from("image")),
      (error) => error?.code === "OCR_UNAVAILABLE",
    );
    await assert.rejects(
      extractor.extract("application/pdf", Buffer.from("pdf")),
      (error) => error?.code === "PDF_TEXT_UNAVAILABLE",
    );
  });

  it("reports configured and executable tool availability without exposing command output", () => {
    const calls = [];
    const result = probeLocalDocumentTextTools({
      ocrCommand: "safe-tesseract",
      pdfTextCommand: "missing-pdftotext",
      spawnSyncImpl(command, args) {
        calls.push({ command, args });
        return command === "safe-tesseract"
          ? { status: 0, error: null, stdout: "secret-version-output", stderr: "" }
          : { status: null, error: Object.assign(new Error("not found"), { code: "ENOENT" }), stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(result, {
      ocr: { configured: true, available: true },
      pdfText: { configured: true, available: false },
    });
    assert.deepEqual(calls, [
      { command: "safe-tesseract", args: ["--version"] },
      { command: "missing-pdftotext", args: ["-v"] },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /secret-version-output|not found/);
  });
});
