import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MEDIA_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

function toolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function commandValue(value, field) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field} must be a command name or absolute path`);
  }
  return value.trim();
}

function positiveTimeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  return value;
}

function languageValue(value) {
  const normalized = String(value ?? "chi_sim+eng").trim();
  if (!/^[A-Za-z0-9_.+-]{1,100}$/.test(normalized)) {
    throw new TypeError("ocrLanguages contains unsupported characters");
  }
  return normalized;
}

function requiredBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("document buffer is required");
}

function defaultRunner({ command, args, timeoutMs, failureCode }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const chunks = [];
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, toolError(`${failureCode}_TIMEOUT`, "Local document text extraction timed out"));
    }, timeoutMs);

    child.once("error", (error) => {
      const code = error?.code === "ENOENT" ? failureCode.replace(/_FAILED$/, "_UNAVAILABLE") : failureCode;
      finish(reject, toolError(code, "Local document text extraction failed"));
    });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_TEXT_BYTES) {
        child.kill();
        finish(reject, toolError("TEXT_OUTPUT_TOO_LARGE", "Extracted document text is too large"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish(reject, toolError(failureCode, "Local document text extraction failed"));
        return;
      }
      finish(resolve, Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function probeTool(command, args, spawnSyncImpl) {
  if (!command) return { configured: false, available: false };
  try {
    const result = spawnSyncImpl(command, args, {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 5000,
      stdio: "ignore",
    });
    return { configured: true, available: result?.status === 0 && !result?.error };
  } catch {
    return { configured: true, available: false };
  }
}

export function probeLocalDocumentTextTools(options = {}) {
  const ocrCommand = commandValue(options.ocrCommand, "ocrCommand");
  const pdfTextCommand = commandValue(options.pdfTextCommand, "pdfTextCommand");
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  return {
    ocr: probeTool(ocrCommand, ["--version"], spawnSyncImpl),
    pdfText: probeTool(pdfTextCommand, ["-v"], spawnSyncImpl),
  };
}

export function createLocalDocumentTextExtractor(options = {}) {
  const ocrCommand = commandValue(options.ocrCommand, "ocrCommand");
  const pdfTextCommand = commandValue(options.pdfTextCommand, "pdfTextCommand");
  const ocrLanguages = languageValue(options.ocrLanguages);
  const timeoutMs = positiveTimeout(options.timeoutMs ?? 30_000);
  const tempRoot = options.tempRoot ?? tmpdir();
  const runner = options.runner ?? defaultRunner;

  return {
    async extract(mediaType, value) {
      const buffer = requiredBuffer(value);
      const isImage = IMAGE_MEDIA_TYPES.has(mediaType);
      const isPdf = mediaType === "application/pdf";
      if (!isImage && !isPdf) {
        throw toolError("UNSUPPORTED_DOCUMENT_TYPE", "Unsupported document type for text extraction");
      }

      const command = isPdf ? pdfTextCommand : ocrCommand;
      if (!command) {
        throw toolError(
          isPdf ? "PDF_TEXT_UNAVAILABLE" : "OCR_UNAVAILABLE",
          "Local document text extraction is not configured",
        );
      }

      const workspace = await mkdtemp(join(tempRoot, "sentelligent-invoice-text-"));
      const inputPath = join(workspace, `document${MEDIA_EXTENSIONS[mediaType] ?? extname(mediaType)}`);
      try {
        await writeFile(inputPath, buffer, { mode: 0o600 });
        const args = isPdf
          ? ["-layout", inputPath, "-"]
          : [inputPath, "stdout", "-l", ocrLanguages, "--psm", "6"];
        const text = String(await runner({
          command,
          args,
          inputPath,
          timeoutMs,
          failureCode: isPdf ? "PDF_TEXT_FAILED" : "OCR_FAILED",
        })).trim();
        if (!text) throw toolError("TEXT_EMPTY", "No text was extracted from the document");
        return text;
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  };
}
