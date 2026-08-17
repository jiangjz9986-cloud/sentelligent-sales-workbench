import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { signShortcut } from "../icost-shortcut/sign-shortcut.mjs";
import { BOOKKEEPING_SHORTCUT_NAME } from "./build-bookkeeping-shortcut.mjs";
import { verifyBookkeepingShortcutFile } from "./verify-bookkeeping-shortcut.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const defaultInputPath = resolve(scriptDirectory, "shortcut-bookkeeping.unsigned.shortcut");
const defaultOutputPath = resolve(
  projectRoot,
  `.runtime/shortcut/${BOOKKEEPING_SHORTCUT_NAME}.shortcut`,
);

function parseCliArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(input|output|mode)=(.+)$/u.exec(argument);
    if (!match) throw new Error("Unknown argument: " + argument);
    const key = match[1] === "input" ? "inputPath" : match[1] === "output" ? "outputPath" : "mode";
    values[key] = match[1] === "mode" ? match[2] : resolve(match[2]);
  }
  return values;
}

export async function signBookkeepingShortcut({
  inputPath = defaultInputPath,
  outputPath = defaultOutputPath,
  mode = "anyone",
  ...rest
} = {}) {
  const report = await signShortcut({
    ...rest,
    inputPath,
    outputPath,
    mode,
    verifyInput: verifyBookkeepingShortcutFile,
  });
  return {
    ...report,
    displayName: BOOKKEEPING_SHORTCUT_NAME,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = parseCliArguments(process.argv.slice(2));
  signBookkeepingShortcut(options)
    .then((report) => process.stdout.write(JSON.stringify(report, null, 2) + "\n"))
    .catch((error) => {
      process.stderr.write(error.message + "\n");
      process.exitCode = 1;
    });
}
