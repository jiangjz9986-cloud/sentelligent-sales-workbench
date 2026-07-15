import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../src/server.js";

const smokeDir = await mkdtemp(join(tmpdir(), "sent-zx-smoke-"));
const databaseUrl = join(smokeDir, "smoke.sqlite");

let server;

try {
  server = createServer({ databaseUrl, seed: true, authRequired: false });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await response.json();
  console.log(JSON.stringify({ statusCode: response.status, body }));
} finally {
  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(smokeDir, { recursive: true, force: true });
}
