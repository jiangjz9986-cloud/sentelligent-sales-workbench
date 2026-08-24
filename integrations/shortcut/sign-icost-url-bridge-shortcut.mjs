import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { signShortcut } from "../icost-shortcut/sign-shortcut.mjs";
import { ICOST_URL_BRIDGE_SHORTCUT_NAME } from "./build-icost-url-bridge-shortcut.mjs";
import { verifyIcostUrlBridgeShortcutFile } from "./verify-icost-url-bridge-shortcut.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const defaultInputPath = resolve(scriptDirectory, "icost-url-bridge.unsigned.shortcut");
const defaultOutputPath = resolve(
  projectRoot,
  `.runtime/shortcut/${ICOST_URL_BRIDGE_SHORTCUT_NAME}.shortcut`,
);

function parseCliArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(input|output|mode)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    const key = match[1] === "input" ? "inputPath" : match[1] === "output" ? "outputPath" : "mode";
    values[key] = key === "mode" ? match[2] : resolve(match[2]);
  }
  return values;
}

export async function signIcostUrlBridgeShortcut({
  inputPath = defaultInputPath,
  outputPath = defaultOutputPath,
  mode = "anyone",
  ...rest
} = {}) {
  let verifiedBridge;
  const report = await signShortcut({
    ...rest,
    inputPath,
    outputPath,
    mode,
    verifyInput: async (path) => {
      verifiedBridge = await verifyIcostUrlBridgeShortcutFile(path);
      if (verifiedBridge.deviceCredentialMode !== "bound") {
        throw new Error("最终签名只接受已绑定设备凭据的 bridge；placeholder 不允许签名");
      }
      return verifiedBridge;
    },
  });
  return {
    ...report,
    displayName: ICOST_URL_BRIDGE_SHORTCUT_NAME,
    bridgeActionCount: verifiedBridge.bridgeActionCount,
    iCostUrls: verifiedBridge.iCostUrls,
    iCostReadback: verifiedBridge.iCostReadback,
    iCostAtomicWithCapture: verifiedBridge.iCostAtomicWithCapture,
    deviceCredentialMode: verifiedBridge.deviceCredentialMode,
    requiresSignedPayloadReinspection: true,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  signIcostUrlBridgeShortcut(parseCliArguments(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
