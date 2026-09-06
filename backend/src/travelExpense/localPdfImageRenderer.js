import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_PAGES = 4;
const DEFAULT_MAX_PAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function rendererError(code) {
  return Object.assign(new Error("Local PDF page rendering failed"), { code });
}

function commandValue(value) {
  const command = String(value ?? "").trim();
  if (!command || command.length > 300 || /[\u0000-\u001f\u007f]/u.test(command)) {
    throw new TypeError("pdfImageCommand must be a bounded executable path or command name");
  }
  return command;
}

function positiveBoundedInteger(value, fallback, max, name) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > max) {
    throw new TypeError(`${name} must be an integer from 1 to ${max}`);
  }
  return candidate;
}

function defaultRunner({ command, args, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, rendererError("PDF_IMAGE_RENDER_TIMEOUT"));
    }, timeoutMs);
    child.once("error", (error) => {
      const code = error?.code === "ENOENT" ? "PDF_IMAGE_RENDER_UNAVAILABLE" : "PDF_IMAGE_RENDER_FAILED";
      finish(reject, rendererError(code));
    });
    child.once("close", (code) => {
      if (code !== 0) finish(reject, rendererError("PDF_IMAGE_RENDER_FAILED"));
      else finish(resolve);
    });
  });
}

function pageNumber(name) {
  const match = /^page-(\d+)\.jpg$/u.exec(name);
  return match ? Number(match[1]) : null;
}

export function createLocalPdfImageRenderer(options = {}) {
  const command = commandValue(options.command ?? "pdftoppm");
  const timeoutMs = positiveBoundedInteger(options.timeoutMs, 30_000, 300_000, "timeoutMs");
  const maxPages = positiveBoundedInteger(options.maxPages, DEFAULT_MAX_PAGES, 8, "maxPages");
  const maxPageBytes = positiveBoundedInteger(
    options.maxPageBytes,
    DEFAULT_MAX_PAGE_BYTES,
    16 * 1024 * 1024,
    "maxPageBytes",
  );
  const maxTotalBytes = positiveBoundedInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    32 * 1024 * 1024,
    "maxTotalBytes",
  );
  const runner = options.runner ?? defaultRunner;
  const tempRoot = options.tempRoot ?? tmpdir();

  return {
    async render(value) {
      const buffer = Buffer.isBuffer(value)
        ? Buffer.from(value)
        : value instanceof Uint8Array ? Buffer.from(value) : null;
      if (!buffer?.length) throw rendererError("PDF_IMAGE_RENDER_FAILED");
      const workspace = await mkdtemp(join(tempRoot, "sentelligent-pdf-vision-"));
      const inputPath = join(workspace, "document.pdf");
      const outputPrefix = join(workspace, "page");
      try {
        await writeFile(inputPath, buffer, { mode: 0o600 });
        await runner({
          command,
          args: [
            "-f", "1",
            "-l", String(maxPages),
            "-scale-to", "2048",
            "-jpeg",
            inputPath,
            outputPrefix,
          ],
          timeoutMs,
          inputPath,
          outputPrefix,
          workspace,
        });
        const names = (await readdir(workspace))
          .map((name) => ({ name, page: pageNumber(name) }))
          .filter(({ page }) => Number.isSafeInteger(page) && page >= 1 && page <= maxPages)
          .sort((left, right) => left.page - right.page);
        if (!names.length || names.length > maxPages) throw rendererError("PDF_IMAGE_RENDER_FAILED");
        let totalBytes = 0;
        const pages = [];
        for (const { name } of names) {
          const path = join(workspace, name);
          const metadata = await lstat(path);
          if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 4 || metadata.size > maxPageBytes) {
            throw rendererError("PDF_IMAGE_RENDER_OUTPUT_INVALID");
          }
          totalBytes += metadata.size;
          if (totalBytes > maxTotalBytes) throw rendererError("PDF_IMAGE_RENDER_OUTPUT_TOO_LARGE");
          const page = await readFile(path);
          if (page[0] !== 0xff || page[1] !== 0xd8 || page.at(-2) !== 0xff || page.at(-1) !== 0xd9) {
            throw rendererError("PDF_IMAGE_RENDER_OUTPUT_INVALID");
          }
          pages.push({ mediaType: "image/jpeg", buffer: page });
        }
        return pages;
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  };
}

export const DEFAULT_PDF_VISION_MAX_PAGES = DEFAULT_MAX_PAGES;
