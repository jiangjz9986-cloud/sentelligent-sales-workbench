import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("pwa manifest and ios meta", () => {
  it("adds maskable icons to the web manifest", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/sentelligent.webmanifest"), "utf8"));
    const maskable = manifest.icons.filter((icon) => icon.purpose === "maskable");
    assert.equal(maskable.length, 2);
    assert.deepEqual(maskable.map((icon) => icon.sizes).sort(), ["192x192", "512x512"]);
    for (const icon of maskable) {
      assert.equal(existsSync(resolve("public", icon.src)), true, `missing ${icon.src}`);
    }
  });

  it("keeps any-purpose icons alongside maskable assets", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/sentelligent.webmanifest"), "utf8"));
    const anyIcons = manifest.icons.filter((icon) => icon.purpose === "any");
    assert.equal(anyIcons.length, 2);
  });

  it("ships the ios standalone meta tags in index.html", () => {
    const html = readFileSync(resolve("index.html"), "utf8");
    assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(html, /name="apple-mobile-web-app-status-bar-style" content="default"/);
    assert.match(html, /name="apple-mobile-web-app-title" content="森特智行"/);
  });

  it("keeps the apple touch icon link", () => {
    const html = readFileSync(resolve("index.html"), "utf8");
    assert.match(html, /rel="apple-touch-icon"[^>]+href="\/sent-zhixing-favicon\.png"/);
  });
});
