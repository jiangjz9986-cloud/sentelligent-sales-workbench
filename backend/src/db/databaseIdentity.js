import { createHmac } from "node:crypto";
import { realpathSync, statSync } from "node:fs";

import { resolveDatabasePath } from "./connection.js";

export const DATABASE_IDENTITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createDatabaseIdentity({ databaseUrl, secret } = {}) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new TypeError("Database identity secret must contain at least 32 characters");
  }

  const databasePath = resolveDatabasePath(databaseUrl);
  if (databasePath === ":memory:") {
    throw new TypeError("Database identity requires a file-backed database");
  }

  const realPath = realpathSync(databasePath);
  const stats = statSync(realPath);
  if (!stats.isFile()) throw new TypeError("Database identity requires a regular database file");

  const identityPayload = JSON.stringify({
    version: 1,
    realPath,
    device: String(stats.dev),
    inode: String(stats.ino),
  });
  return createHmac("sha256", secret)
    .update("sentelligent-database-identity:v1\0")
    .update(identityPayload)
    .digest("base64url");
}
