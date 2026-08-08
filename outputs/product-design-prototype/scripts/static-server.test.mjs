import assert from "node:assert/strict";
import { posix } from "node:path";
import { describe, it } from "node:test";

import {
  contentTypeFor,
  createStaticServerConfig,
  injectRuntimeConfig,
  resolveRequestPath,
  securityHeadersFor,
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

  it("rejects API origins with invalid syntax, schemes, credentials, query, or fragments", () => {
    for (const apiBaseUrl of [
      "",
      "backend.internal/api",
      "ftp://backend.internal/api",
      "https://user:password@backend.internal/api",
      "https://backend.internal/api?tenant=1",
      "https://backend.internal/api#fragment",
    ]) {
      assert.throws(
        () => createStaticServerConfig({ apiBaseUrl }),
        /api base url/i,
      );
    }
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

  it("sets production browser security headers without blocking voice or AMap", () => {
    const headers = securityHeadersFor({ apiBaseUrl: "https://82.156.210.199/" });

    assert.match(headers["Content-Security-Policy"], /default-src 'self'/);
    assert.match(headers["Content-Security-Policy"], /script-src[^;]*'unsafe-inline'[^;]*webapi\.amap\.com/);
    assert.match(headers["Content-Security-Policy"], /img-src[^;]*https:\/\/82\.156\.210\.199/);
    assert.match(headers["Content-Security-Policy"], /connect-src[^;]*https:\/\/82\.156\.210\.199[^;]*amap\.com/);
    assert.match(headers["Content-Security-Policy"], /media-src 'self' blob:/);
    assert.doesNotMatch(headers["Content-Security-Policy"], /frame-src/);
    assert.match(headers["Content-Security-Policy"], /object-src 'none'/);
    assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/);
    assert.equal(headers["Strict-Transport-Security"], "max-age=31536000; includeSubDomains");
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["X-Frame-Options"], "DENY");
    assert.match(headers["Permissions-Policy"], /microphone=\(self\)/);
  });
});
