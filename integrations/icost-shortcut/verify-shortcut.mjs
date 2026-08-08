import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlistXml } from "./plist-xml.mjs";

const SCREENSHOT_ACTION = "is.workflow.actions.takescreenshot";
const CROP_ACTION = "is.workflow.actions.image.crop";
const OCR_ACTION = "is.workflow.actions.extracttextfromimage";
const ICOST_ACTION = "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7";
const REQUEST_ACTION = "is.workflow.actions.downloadurl";
const CONDITION_ACTION = "is.workflow.actions.conditional";
const TOKEN_ACTION = "is.workflow.actions.gettext";
const EXPECTED_LEDGER_OPTIONS = ["出差报销", "biubiu", "仅记 iCost（不回传）"];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function actionIdentifier(action) {
  return action?.WFWorkflowActionIdentifier ?? "";
}

function actionParameters(action) {
  return action?.WFWorkflowActionParameters ?? {};
}

function dictionaryItems(field) {
  const items = field?.Value?.WFDictionaryFieldValueItems;
  return Array.isArray(items) ? items : [];
}

function dictionaryKey(item) {
  return item?.WFKey?.Value?.string;
}

function dictionaryStringValue(item) {
  return item?.WFValue?.Value?.string;
}

function conditionRanges(actions) {
  const groups = new Map();
  actions.forEach((action, index) => {
    if (actionIdentifier(action) !== CONDITION_ACTION) return;
    const parameters = actionParameters(action);
    const group = parameters.GroupingIdentifier;
    if (typeof group !== "string") return;
    const range = groups.get(group) ?? { start: null, otherwise: null, end: null, value: null };
    if (parameters.WFControlFlowMode === 0) {
      range.start = index;
      range.value = parameters.WFConditionalActionString;
    } else if (parameters.WFControlFlowMode === 1) {
      range.otherwise = index;
    } else if (parameters.WFControlFlowMode === 2) {
      range.end = index;
    }
    groups.set(group, range);
  });
  return [...groups.values()].filter((range) => (
    Number.isInteger(range.start) && Number.isInteger(range.end) && range.start < range.end
  ));
}

function positiveConditionsForIndex(ranges, index) {
  return ranges
    .filter((range) => (
      index > range.start
      && index < (Number.isInteger(range.otherwise) ? range.otherwise : range.end)
    ))
    .map((range) => range.value)
    .filter((value) => typeof value === "string");
}

function classifyQuestion(question) {
  const text = String(question?.Text ?? "");
  const system = text.includes("森特智行")
    ? "sentelligent"
    : text.includes("轻氧智能门店")
      ? "qingyang"
      : null;
  const kind = question?.ParameterKey === "WFURL"
    ? "url"
    : question?.ParameterKey === "WFTextActionText"
      ? "token"
      : null;
  return system && kind ? `${system}_${kind}` : null;
}

function requestReport(actions, ranges, questionByActionIndex, actionIndex) {
  const action = actions[actionIndex];
  const parameters = actionParameters(action);
  const payloadItems = dictionaryItems(parameters.WFJSONValues);
  const payloadKeys = payloadItems.map(dictionaryKey).filter(Boolean);
  const sourceItem = payloadItems.find((item) => dictionaryKey(item) === "source");
  const urlQuestion = questionByActionIndex.get(actionIndex)?.find((question) => (
    question.ParameterKey === "WFURL"
  ));
  requireValue(urlQuestion, `request action ${actionIndex} is missing its URL import question`);
  return {
    actionIndex,
    conditionValues: positiveConditionsForIndex(ranges, actionIndex),
    payloadKeys,
    source: dictionaryStringValue(sourceItem),
    url: urlQuestion.DefaultValue,
  };
}

function validateUrl(value, expectedPath, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  requireValue(url.protocol === "https:", `${label} URL must use HTTPS`);
  requireValue(url.pathname === expectedPath, `${label} URL must use ${expectedPath}`);
  requireValue(!url.username && !url.password, `${label} URL must not contain credentials`);
  return url.href;
}

export function inspectShortcutXml(xml) {
  const plist = parsePlistXml(xml);
  const actions = plist?.WFWorkflowActions;
  const questions = plist?.WFWorkflowImportQuestions;
  requireValue(Array.isArray(actions), "Shortcut actions are missing");
  requireValue(Array.isArray(questions), "Shortcut import questions are missing");

  const actionUuidOwners = new Map();
  actions.forEach((action, index) => {
    const uuid = actionParameters(action).UUID;
    if (typeof uuid !== "string" || !uuid) return;
    const existingIndex = actionUuidOwners.get(uuid);
    requireValue(
      existingIndex === undefined,
      `duplicate action UUID ${uuid} at actions ${existingIndex} and ${index}`,
    );
    actionUuidOwners.set(uuid, index);
  });

  const leadingActionIdentifiers = actions.slice(0, 3).map(actionIdentifier);
  requireValue(
    JSON.stringify(leadingActionIdentifiers) === JSON.stringify([
      SCREENSHOT_ACTION,
      CROP_ACTION,
      OCR_ACTION,
    ]),
    "the original screenshot, crop and OCR actions were not preserved",
  );

  const icostActionIndex = actions.findIndex((action) => actionIdentifier(action) === ICOST_ACTION);
  requireValue(icostActionIndex >= 0, "the original iCost action is missing");
  const icostParameters = actionParameters(actions[icostActionIndex]);
  const screenshotUuid = actionParameters(actions[0]).UUID;
  const ocrUuid = actionParameters(actions[2]).UUID;
  requireValue(
    icostParameters.content?.Value?.OutputUUID === screenshotUuid,
    "the iCost screenshot input was not preserved",
  );
  requireValue(
    icostParameters.rawText?.Value?.attachmentsByRange?.["{0, 1}"]?.OutputUUID === ocrUuid,
    "the iCost OCR text input was not preserved",
  );

  const listAction = actions.find((action) => {
    const values = actionParameters(action).WFItems?.map((item) => item.WFValue);
    return Array.isArray(values) && values.includes("出差报销") && values.includes("biubiu");
  });
  const ledgerOptions = actionParameters(listAction).WFItems?.map((item) => item.WFValue) ?? [];
  requireValue(
    JSON.stringify(ledgerOptions) === JSON.stringify(EXPECTED_LEDGER_OPTIONS),
    "unknown ledger fallback / 未知账本安全回退项不正确",
  );

  const questionKinds = questions.map(classifyQuestion);
  requireValue(questionKinds.every(Boolean), "Shortcut contains an unrecognized import question");
  requireValue(new Set(questionKinds).size === 4, "Shortcut import questions must be independent");
  requireValue(
    JSON.stringify(questionKinds) === JSON.stringify([
      "sentelligent_url",
      "sentelligent_token",
      "qingyang_url",
      "qingyang_token",
    ]),
    "Shortcut import questions are not in the required order",
  );

  const questionByActionIndex = new Map();
  for (const question of questions) {
    requireValue(Number.isSafeInteger(question.ActionIndex), "import question ActionIndex is missing");
    const list = questionByActionIndex.get(question.ActionIndex) ?? [];
    list.push(question);
    questionByActionIndex.set(question.ActionIndex, list);
  }
  for (const question of questions.filter((item) => item.ParameterKey === "WFTextActionText")) {
    requireValue(
      actionIdentifier(actions[question.ActionIndex]) === TOKEN_ACTION,
      "token import question must target its own text action",
    );
    requireValue(
      !/^(?:sk-|Bearer\s+)[A-Za-z0-9_-]{12,}$/u.test(String(question.DefaultValue ?? "")),
      "token import question must not contain a real credential",
    );
  }

  const requestIndexes = actions
    .map((action, index) => (actionIdentifier(action) === REQUEST_ACTION ? index : -1))
    .filter((index) => index >= 0);
  requireValue(requestIndexes.length === 2, "Shortcut must contain exactly two business webhook requests");
  requireValue(requestIndexes.every((index) => index > icostActionIndex), "webhook request appears before iCost");

  const ranges = conditionRanges(actions);
  const requests = requestIndexes.map((index) => (
    requestReport(actions, ranges, questionByActionIndex, index)
  ));
  const sentelligentRequest = requests.find((item) => item.conditionValues.includes("出差报销"));
  const qingyangRequest = requests.find((item) => item.conditionValues.includes("biubiu"));
  requireValue(sentelligentRequest, "森特智行 request is not guarded by the exact ledger");
  requireValue(qingyangRequest, "轻氧 request is not guarded by the exact ledger");
  requireValue(
    JSON.stringify(sentelligentRequest.conditionValues) === JSON.stringify(["出差报销"]),
    "森特智行 request has an unsafe condition",
  );
  requireValue(
    JSON.stringify(qingyangRequest.conditionValues) === JSON.stringify(["biubiu"]),
    "轻氧 request has an unsafe condition",
  );

  sentelligentRequest.url = validateUrl(
    sentelligentRequest.url,
    "/api/integrations/icost/expenses",
    "森特智行",
  );
  qingyangRequest.url = validateUrl(
    qingyangRequest.url,
    "/qingyang/api/integrations/icost/bookkeeping",
    "轻氧",
  );
  requireValue(sentelligentRequest.url !== qingyangRequest.url, "business webhook URLs must be independent");

  const requiredPayloadKeys = [
    "text",
    "ledger_name",
    "idempotency_key",
    "source",
    "captured_at",
    "source_id",
  ].sort();
  for (const request of [sentelligentRequest, qingyangRequest]) {
    requireValue(
      JSON.stringify([...request.payloadKeys].sort()) === JSON.stringify(requiredPayloadKeys),
      "webhook payload fields do not match the text-only contract",
    );
    requireValue(request.source === "icost-shortcut", "webhook source must be icost-shortcut");
  }

  const routedLedgers = new Set([
    ...sentelligentRequest.conditionValues,
    ...qingyangRequest.conditionValues,
  ]);
  const unroutedLedgerValues = ledgerOptions.filter((ledger) => !routedLedgers.has(ledger));
  requireValue(
    JSON.stringify(unroutedLedgerValues) === JSON.stringify(["仅记 iCost（不回传）"]),
    "unknown ledger fallback / 未知账本不得发送到任一系统",
  );

  return {
    actionCount: actions.length,
    leadingActionIdentifiers,
    icostActionIdentifier: ICOST_ACTION,
    icostActionIndex,
    ledgerOptions,
    sentelligentRequest,
    qingyangRequest,
    unroutedLedgerValues,
    importQuestionKinds: questionKinds,
  };
}

export async function verifyShortcutFile(filePath) {
  return inspectShortcutXml(await readFile(filePath, "utf8"));
}

async function runCli() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("Usage: node verify-shortcut.mjs <unsigned.shortcut>");
  const report = await verifyShortcutFile(resolve(filePath));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
