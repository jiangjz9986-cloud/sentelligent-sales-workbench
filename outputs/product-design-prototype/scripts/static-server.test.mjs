import assert from "node:assert/strict";
import { posix } from "node:path";
import { describe, it } from "node:test";

import {
  contentTypeFor,
  createStaticServerConfig,
  injectRuntimeConfig,
  resolveRequestPath,
} from "./static-server.mjs";

describe("production static server", () => {
  it("uses WSL runtime directories for frontend state and logs", () => {
    const config = createStaticServerConfig({
      runtimeRoot: "/tmp/sent-zx-fullstack",
      port: 8088,
      host: "127.0.0.1",
      apiBaseUrl: "http://127.0.0.1:8897",
      distPath: "/mnt/c/workspace/dist",
    });

    assert.equal(config.runtimeRoot, "/tmp/sent-zx-fullstack");
    assert.equal(config.statePath, posix.join("/tmp/sent-zx-fullstack", "runtime", "frontend-static.json"));
    assert.equal(config.logPath, posix.join("/tmp/sent-zx-fullstack", "logs", "frontend-static.log"));
    assert.equal(config.port, 8088);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.apiBaseUrl, "http://127.0.0.1:8897");
  });

  it("resolves static asset requests without directory traversal", () => {
    const distPath = "/mnt/c/workspace/dist";

    assert.equal(resolveRequestPath(distPath, "/"), posix.join(distPath, "index.html"));
    assert.equal(resolveRequestPath(distPath, "/assets/index.js"), posix.join(distPath, "assets", "index.js"));
    assert.equal(resolveRequestPath(distPath, "/../secret.txt"), null);
  });

  it("maps common web assets to stable content types", () => {
    assert.equal(contentTypeFor("index.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeFor("app.js"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeFor("style.css"), "text/css; charset=utf-8");
    assert.equal(contentTypeFor("logo.png"), "image/png");
  });

  it("injects the browser runtime API base into the production index", () => {
    const html = "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>";
    const injected = injectRuntimeConfig(html, { apiBaseUrl: "https://82.156.210.199/" });

    assert.match(injected, /window\.__SENTELLIGENT_API_BASE_URL__ = "https:\/\/82\.156\.210\.199"/);
    assert.match(injected, /<head><script>/);
  });
});
