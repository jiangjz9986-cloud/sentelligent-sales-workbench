import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { signShortcut } from "../icost-shortcut/sign-shortcut.mjs";
import {
  CAPTURE_SHORTCUT_NAME,
  verifyConvertedIcostCaptureShortcutFile,
} from "./convert-icost-capture-shortcut.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultInputPath = resolve(scriptDirectory, `${CAPTURE_SHORTCUT_NAME}.unsigned.shortcut`);
const defaultOutputPath = resolve(scriptDirectory, `${CAPTURE_SHORTCUT_NAME}.shortcut`);

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

export async function signIcostCaptureShortcut({
  inputPath = defaultInputPath,
  outputPath = defaultOutputPath,
  mode = "anyone",
} = {}) {
  const report = await signShortcut({
    inputPath,
    outputPath,
    mode,
    verifyInput: verifyConvertedIcostCaptureShortcutFile,
  });
  return { ...report, displayName: CAPTURE_SHORTCUT_NAME };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  signIcostCaptureShortcut(parseCliArguments(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
