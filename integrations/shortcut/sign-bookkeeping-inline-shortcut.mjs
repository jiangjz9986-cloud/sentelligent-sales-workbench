import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { signShortcut } from "../icost-shortcut/sign-shortcut.mjs";
import { INLINE_BOOKKEEPING_SHORTCUT_NAME } from "./build-bookkeeping-inline-shortcut.mjs";
import { verifyBookkeepingInlineShortcutFile } from "./verify-bookkeeping-inline-shortcut.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultInputPath = resolve(scriptDirectory, "shortcut-bookkeeping-inline.unsigned.shortcut");
const defaultOutputPath = resolve(scriptDirectory, `${INLINE_BOOKKEEPING_SHORTCUT_NAME}.shortcut`);

function parseCliArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(input|output|mode)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    const key = match[1];
    values[key === "input" ? "inputPath" : key === "output" ? "outputPath" : "mode"] =
      key === "mode" ? match[2] : resolve(match[2]);
  }
  return values;
}

export async function signBookkeepingInlineShortcut({
  inputPath = defaultInputPath,
  outputPath = defaultOutputPath,
  mode = "anyone",
} = {}) {
  return signShortcut({
    inputPath,
    outputPath,
    mode,
    verifyInput: verifyBookkeepingInlineShortcutFile,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  signBookkeepingInlineShortcut(parseCliArguments(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify({ ...report, displayName: INLINE_BOOKKEEPING_SHORTCUT_NAME }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
