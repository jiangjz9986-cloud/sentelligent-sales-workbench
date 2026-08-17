import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { verifyShortcutFile } from "./verify-shortcut.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const defaultInputPath = resolve(scriptDirectory, "icost-dual-write.unsigned.shortcut");
const defaultOutputPath = resolve(
  projectRoot,
  ".runtime/icost-shortcut/iCost-截图记账双系统分流.shortcut",
);
const defaultShortcutsBinary = "/usr/bin/shortcuts";
const allowedModes = new Set(["anyone", "people-who-know-me"]);
const SIGNED_SHORTCUT_MAGIC = Buffer.from("AEA1", "ascii");

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function parseCliArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(input|output|mode)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    values[match[1]] = match[1] === "mode" ? match[2] : resolve(match[2]);
  }
  return values;
}

async function runShortcutsSigner(binary, argumentsList) {
  await execFileAsync(binary, argumentsList, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function inspectSignedArtifact(bytes) {
  requireValue(bytes.length > SIGNED_SHORTCUT_MAGIC.length, "Apple signer produced an empty artifact");
  requireValue(
    bytes.subarray(0, SIGNED_SHORTCUT_MAGIC.length).equals(SIGNED_SHORTCUT_MAGIC),
    "Apple signer output is not a signed Shortcut archive",
  );
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function signShortcut({
  inputPath = defaultInputPath,
  outputPath = defaultOutputPath,
  mode = "anyone",
  platform = process.platform,
  shortcutsBinary = defaultShortcutsBinary,
  runSigner = runShortcutsSigner,
  verifyInput = verifyShortcutFile,
} = {}) {
  const resolvedInputPath = resolve(inputPath);
  const resolvedOutputPath = resolve(outputPath);
  requireValue(platform === "darwin", "Apple Shortcuts signing requires a trusted macOS device");
  requireValue(allowedModes.has(mode), `Unsupported signing mode: ${mode}`);
  requireValue(
    resolvedInputPath !== resolvedOutputPath,
    "Signed Shortcut output must not overwrite the unsigned source artifact",
  );

  const shortcutReport = await verifyInput(resolvedInputPath);
  const outputDirectory = dirname(resolvedOutputPath);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

  const temporaryOutputPath = resolve(
    outputDirectory,
    `.signing-${process.pid}-${randomUUID()}.shortcut`,
  );
  try {
    await runSigner(shortcutsBinary, [
      "sign",
      "--mode",
      mode,
      "--input",
      resolvedInputPath,
      "--output",
      temporaryOutputPath,
    ]);
    const signedBytes = await readFile(temporaryOutputPath);
    const artifact = inspectSignedArtifact(signedBytes);
    await chmod(temporaryOutputPath, 0o600);
    await rename(temporaryOutputPath, resolvedOutputPath);
    const outputStat = await stat(resolvedOutputPath);
    requireValue(
      (outputStat.mode & 0o777) === 0o600,
      "Signed Shortcut artifact permissions must be 0600",
    );

    return {
      inputPath: resolvedInputPath,
      outputPath: resolvedOutputPath,
      mode,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      actionCount: shortcutReport.actionCount,
      ledgerOptions: shortcutReport.ledgerOptions,
    };
  } catch (error) {
    await unlink(temporaryOutputPath).catch(() => {});
    throw error;
  }
}

async function runCli() {
  const options = parseCliArguments(process.argv.slice(2));
  const result = await signShortcut({
    ...(options.input ? { inputPath: options.input } : {}),
    ...(options.output ? { outputPath: options.output } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
