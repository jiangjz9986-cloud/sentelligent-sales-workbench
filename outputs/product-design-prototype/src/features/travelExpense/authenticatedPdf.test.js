import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const moduleUrl = new URL("./authenticatedPdf.js", import.meta.url);
const componentUrl = new URL("./AuthenticatedPdfFrame.jsx", import.meta.url);

async function loadAuthenticatedPdfModule() {
  if (!existsSync(fileURLToPath(moduleUrl))) return {};
  return import(moduleUrl.href);
}

describe("authenticated PDF loading", () => {
  it("loads a protected PDF Blob through the caller-owned authenticated request", async () => {
    const pdf = await loadAuthenticatedPdfModule();
    assert.equal(typeof pdf.loadAuthenticatedPdfBlob, "function");

    const responseBlob = new Blob(["pdf-bytes"], { type: "application/pdf" });
    const controller = new AbortController();
    let receivedSignal;
    const blob = await pdf.loadAuthenticatedPdfBlob(
      async ({ signal }) => {
        receivedSignal = signal;
        return {
          ok: true,
          status: 200,
          redirected: false,
          headers: new Headers({ "Content-Type": "application/pdf" }),
          blob: async () => responseBlob,
        };
      },
      { signal: controller.signal },
    );

    assert.equal(receivedSignal, controller.signal);
    assert.equal(blob, responseBlob);
  });

  it("rejects a redirected PDF response before returning document bytes", async () => {
    const pdf = await loadAuthenticatedPdfModule();

    await assert.rejects(
      pdf.loadAuthenticatedPdfBlob(
        async () => ({
          ok: true,
          status: 200,
          redirected: true,
          headers: new Headers({ "Content-Type": "application/pdf" }),
          blob: async () => new Blob(["pdf"], { type: "application/pdf" }),
        }),
      ),
      /redirect/i,
    );
  });

  it("rejects a non-PDF 200 response before returning executable HTML bytes", async () => {
    const pdf = await loadAuthenticatedPdfModule();

    await assert.rejects(
      pdf.loadAuthenticatedPdfBlob(
        async () => ({
          ok: true,
          status: 200,
          redirected: false,
          headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }),
          blob: async () => new Blob(["<script>parent.compromised = true</script>"], { type: "text/html" }),
        }),
      ),
      /content-type|PDF/i,
    );
  });

  it("rejects non-success responses without reading a Blob", async () => {
    const pdf = await loadAuthenticatedPdfModule();
    assert.equal(typeof pdf.loadAuthenticatedPdfBlob, "function");
    let blobRead = false;

    await assert.rejects(
      pdf.loadAuthenticatedPdfBlob(
        async () => ({
          ok: false,
          status: 404,
          async blob() {
            blobRead = true;
            return new Blob();
          },
        }),
      ),
      /404/,
    );
    assert.equal(blobRead, false);
  });

  it("aborts stale work and exposes PDF.js canvas readiness", () => {
    const componentPath = fileURLToPath(componentUrl);
    const source = existsSync(componentPath) ? readFileSync(componentPath, "utf8") : "";

    assert.match(source, /new AbortController\(\)/);
    assert.match(source, /loadAuthenticatedPdfBlob/);
    assert.match(source, /getDocument/);
    assert.match(source, /renderTask\.promise/);
    assert.match(source, /renderTask\?\.cancel\(\)/);
    assert.match(source, /loadingTask\?\.destroy\(\)/);
    assert.match(source, /controller\.abort\(\)/);
    assert.match(source, /data-authenticated-pdf-state=\{state\.status\}/);
    assert.match(source, /<canvas/);
    assert.doesNotMatch(source, /<iframe/);
  });
});
