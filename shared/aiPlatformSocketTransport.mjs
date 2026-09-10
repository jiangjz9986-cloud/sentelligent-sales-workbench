import { request as httpRequest } from "node:http";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { Readable } from "node:stream";

export const PRODUCTION_AI_SOCKET = "/run/sentelligent-ai-platform/api.sock";

export function socketFetch(socketPath) {
  if (typeof socketPath !== "string" || !isAbsolute(socketPath) || socketPath.length > 100) throw new TypeError("invalid AI socket path");
  return async (address, options = {}) => {
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new TypeError("AI socket transport requires a loopback logical origin");
    const parent = dirname(socketPath);
    const directory = lstatSync(parent);
    const socket = lstatSync(socketPath);
    if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(parent) !== parent
      || (directory.mode & 0o022) !== 0 || !socket.isSocket() || socket.isSymbolicLink()
      || socket.uid !== directory.uid) throw new Error("AI socket identity is unsafe");
    if (options.body !== undefined && typeof options.body !== "string" && !Buffer.isBuffer(options.body)) throw new TypeError("AI socket request body must be bytes or text");
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("request aborted");
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        socketPath, method: options.method ?? "GET",
        path: url.pathname + url.search, headers: options.headers,
      });
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      const abort = () => req.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new Error("request aborted"));
      options.signal?.addEventListener("abort", abort, { once: true });
      req.once("error", (error) => { cleanup(); reject(error); });
      req.once("response", (response) => {
        response.once("close", cleanup);
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const empty = options.method === "HEAD" || [204, 205, 304].includes(response.statusCode);
        if (empty) response.resume();
        resolve(new Response(empty ? null : Readable.toWeb(response), {
          status: response.statusCode, headers,
        }));
      });
      if (options.signal?.aborted) abort();
      req.end(options.body);
    });
  };
}

export function platformFetch(config, fallback = fetch) {
  return config.aiPlatformSocketPath ? socketFetch(config.aiPlatformSocketPath) : fallback;
}
