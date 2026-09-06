import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const distAssets = resolve("dist/assets");
const distIndex = resolve("dist/index.html");

function assetFiles() {
  return readdirSync(distAssets).filter((name) => !name.startsWith("."));
}

describe("bundle budget", () => {
  it("keeps the main chunk under 500KB", () => {
    const mainChunk = assetFiles().find((name) => /^index-.*\.js$/.test(name));
    assert.ok(mainChunk, "expected a main index chunk in dist/assets");
    const bytes = statSync(resolve(distAssets, mainChunk)).size;
    assert.ok(bytes < 500_000, `main chunk ${mainChunk} is ${bytes} bytes (limit 500000)`);
  });

  it("emits at least fifteen lazy page chunks", () => {
    const pageChunks = assetFiles().filter((name) =>
      /\.js$/.test(name)
      && !/^index-/.test(name)
      && !/^pdf-/.test(name)
      && !/worker/.test(name),
    );
    assert.ok(pageChunks.length >= 15, `expected >=15 page chunks, got ${pageChunks.length}`);
  });

  it("keeps pdf preview assets in separate chunks", () => {
    const names = assetFiles();
    assert.ok(names.some((name) => /^pdf-.*\.js$/.test(name)), "expected pdf chunk");
    assert.ok(names.some((name) => name.includes("worker")), "expected pdf worker chunk");
  });

  it("does not inflate the global stylesheet", () => {
    const css = assetFiles().find((name) => /^index-.*\.css$/.test(name));
    assert.ok(css, "expected index css bundle");
    const bytes = statSync(resolve(distAssets, css)).size;
    assert.ok(bytes < 210_000, `css bundle is ${bytes} bytes (limit 210000)`);
  });

  it("injects the main module entry in index.html", () => {
    const html = readFileSync(distIndex, "utf8");
    assert.match(html, /type="module"/);
  });
});
