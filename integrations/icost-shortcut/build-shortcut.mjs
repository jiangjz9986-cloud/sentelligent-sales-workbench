import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlistXml, serializePlistXml } from "./plist-xml.mjs";
import { inspectShortcutXml } from "./verify-shortcut.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultTemplatePath = resolve(scriptDirectory, "icost-dual-write.template.plist");
const defaultConfigPath = resolve(scriptDirectory, "icost-dual-write.shortcut.example.json");
const defaultOutputPath = resolve(scriptDirectory, "icost-dual-write.unsigned.shortcut");
const allowedConfigKeys = new Set(["sentelligentUrl", "qingyangUrl"]);

function parseCliArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(config|output|template)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    values[match[1]] = resolve(match[2]);
  }
  return values;
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Shortcut config must be a JSON object");
  }
  const unknown = Object.keys(config).find((key) => !allowedConfigKeys.has(key));
  if (unknown) throw new Error(`Shortcut config field is not allowed: ${unknown}`);
  for (const key of allowedConfigKeys) {
    if (typeof config[key] !== "string" || !config[key].trim()) {
      throw new Error(`Shortcut config field is required: ${key}`);
    }
  }
  return config;
}

function updateQuestionDefaults(plist, config) {
  const questions = plist.WFWorkflowImportQuestions;
  if (!Array.isArray(questions)) throw new Error("Shortcut template import questions are missing");
  for (const question of questions) {
    if (question.Text === "森特智行 iCost Webhook 完整 URL") {
      question.DefaultValue = config.sentelligentUrl;
    } else if (question.Text === "轻氧智能门店 iCost Webhook 完整 URL") {
      question.DefaultValue = config.qingyangUrl;
    }
  }
}

export async function buildShortcut({
  templatePath = defaultTemplatePath,
  configPath = defaultConfigPath,
  outputPath = defaultOutputPath,
} = {}) {
  const [templateXml, configText] = await Promise.all([
    readFile(templatePath, "utf8"),
    readFile(configPath, "utf8"),
  ]);
  const config = validateConfig(JSON.parse(configText));
  const plist = parsePlistXml(templateXml);
  updateQuestionDefaults(plist, config);
  const outputXml = serializePlistXml(plist);
  const report = inspectShortcutXml(outputXml);
  await writeFile(outputPath, outputXml, { encoding: "utf8", mode: 0o600 });
  return { outputPath, report };
}

async function runCli() {
  const options = parseCliArguments(process.argv.slice(2));
  const result = await buildShortcut({
    ...(options.template ? { templatePath: options.template } : {}),
    ...(options.config ? { configPath: options.config } : {}),
    ...(options.output ? { outputPath: options.output } : {}),
  });
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
