import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectIcostUrlBridgeShortcutXml } from "./build-icost-url-bridge-shortcut.mjs";

export async function verifyIcostUrlBridgeShortcutFile(inputPath) {
  const resolvedPath = resolve(inputPath);
  const fileStat = await stat(resolvedPath);
  if ((fileStat.mode & 0o777) !== 0o600) throw new Error("unsigned bridge Shortcut 权限必须是 0600");
  const report = inspectIcostUrlBridgeShortcutXml(await readFile(resolvedPath, "utf8"));
  return { path: resolvedPath, ...report };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    process.stderr.write("Usage: node verify-icost-url-bridge-shortcut.mjs <unsigned.shortcut>\n");
    process.exitCode = 1;
  } else {
    verifyIcostUrlBridgeShortcutFile(inputPath)
      .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
