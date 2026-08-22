import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlistXml, serializePlistXml } from "../icost-shortcut/plist-xml.mjs";

const ICOST_ACTION = "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7";
const SCREENSHOT_ACTION = "is.workflow.actions.takescreenshot";
const CROP_ACTION = "is.workflow.actions.image.crop";
const OCR_ACTION = "is.workflow.actions.extracttextfromimage";
const REQUEST_ACTION = "is.workflow.actions.downloadurl";
const CONDITIONAL_ACTION = "is.workflow.actions.conditional";

export const CAPTURE_INLINE_ENDPOINT =
  "https://82.156.210.199/api/integrations/shortcut/bookkeeping-capture-inline";
export const CAPTURE_SHORTCUT_NAME = "智能截图记账（小小确认版）";
export const CAPTURE_ACCOUNT_PLACEHOLDER = "请在此填写森特账号";
export const CAPTURE_PASSWORD_PLACEHOLDER = "请在此填写森特密码";
export const CAPTURE_FAILURE_MESSAGE =
  "截图提交失败：服务器未接受本次请求。请检查账号密码和网络；未收到小小微信草稿前不要认为已经记账。";

const uuid = (suffix) => `7B73F100-2EA8-4A20-9C73-${BigInt(suffix).toString(16).padStart(12, "0")}`;
const literalToken = (string) => ({
  Value: { string },
  WFSerializationType: "WFTextTokenString",
});
const attachment = (outputUuid, outputName) => ({
  Value: { OutputUUID: outputUuid, OutputName: outputName, Type: "ActionOutput" },
  WFSerializationType: "WFTextTokenAttachment",
});
const dictionaryField = (entries) => ({
  Value: {
    WFDictionaryFieldValueItems: entries.map(([key, value]) => ({
      WFKey: literalToken(key),
      WFValue: typeof value === "string" ? literalToken(value) : value,
    })),
  },
  WFSerializationType: "WFDictionaryFieldValue",
});
const action = (identifier, parameters, id) => ({
  WFWorkflowActionIdentifier: identifier,
  WFWorkflowActionParameters: { UUID: id, ...parameters },
});
const controlAction = (identifier, parameters) => ({
  WFWorkflowActionIdentifier: identifier,
  WFWorkflowActionParameters: parameters,
});

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function literal(value) {
  return value?.WFSerializationType === "WFTextTokenString" ? value.Value?.string : null;
}

function outputUuid(value) {
  return value?.WFSerializationType === "WFTextTokenAttachment" ? value.Value?.OutputUUID : null;
}

function dictionaryMap(field) {
  const items = field?.Value?.WFDictionaryFieldValueItems;
  requireValue(field?.WFSerializationType === "WFDictionaryFieldValue" && Array.isArray(items), "请求字典无效");
  return new Map(items.map((item) => [literal(item.WFKey), item.WFValue]));
}

function assertLegacyPrefix(actions) {
  requireValue(actions.length === 4, "参考快捷指令必须恰好包含截屏、裁剪、OCR 和 iCost 四个动作");
  requireValue(actions[0]?.WFWorkflowActionIdentifier === SCREENSHOT_ACTION, "参考快捷指令首个动作不是截屏");
  requireValue(actions[1]?.WFWorkflowActionIdentifier === CROP_ACTION, "参考快捷指令第二个动作不是裁剪");
  requireValue(actions[2]?.WFWorkflowActionIdentifier === OCR_ACTION, "参考快捷指令第三个动作不是 OCR");
  requireValue(actions[3]?.WFWorkflowActionIdentifier === ICOST_ACTION, "参考快捷指令末尾不是 iCost V7 动作");
  requireValue(actions[2].WFWorkflowActionParameters?.UUID, "OCR 动作缺少 UUID");
}

function convertedActions(sourceActions, endpoint) {
  assertLegacyPrefix(sourceActions);
  const account = uuid(1);
  const password = uuid(2);
  const currentDate = uuid(3);
  const timeId = uuid(4);
  const request = uuid(5);
  const responseError = uuid(6);
  const responseGuard = uuid(0x2000);
  const ocr = sourceActions[2].WFWorkflowActionParameters.UUID;
  return [
    ...structuredClone(sourceActions.slice(0, 3)),
    action("is.workflow.actions.gettext", {
      CustomOutputName: "森特账号常量（请编辑）",
      WFTextActionText: literalToken(CAPTURE_ACCOUNT_PLACEHOLDER),
    }, account),
    action("is.workflow.actions.gettext", {
      CustomOutputName: "森特密码常量（请编辑）",
      WFTextActionText: literalToken(CAPTURE_PASSWORD_PLACEHOLDER),
    }, password),
    action("is.workflow.actions.date", {
      CustomOutputName: "本次截图时间",
      WFDateActionMode: "Current Date",
    }, currentDate),
    action("is.workflow.actions.format.date", {
      CustomOutputName: "截图记账ID",
      WFDate: attachment(currentDate, "本次截图时间"),
      WFDateFormatStyle: "Custom",
      WFDateFormat: "yyyyMMddHHmmssSSS",
      WFTimeFormatStyle: "None",
    }, timeId),
    action(REQUEST_ACTION, {
      CustomOutputName: "已提交小小确认",
      WFHTTPMethod: "POST",
      WFHTTPBodyType: "JSON",
      WFURL: endpoint,
      WFHTTPHeaders: dictionaryField([["Content-Type", "application/json"]]),
      WFJSONValues: dictionaryField([
        ["account", attachment(account, "森特账号常量（请编辑）")],
        ["password", attachment(password, "森特密码常量（请编辑）")],
        ["text", attachment(ocr, "图像中的文本")],
        ["idempotency_key", attachment(timeId, "截图记账ID")],
        ["source_id", attachment(timeId, "截图记账ID")],
        ["source", "shortcut"],
      ]),
    }, request),
    action("is.workflow.actions.getvalueforkey", {
      CustomOutputName: "截图提交错误",
      WFDictionaryKey: "error",
      WFInput: attachment(request, "已提交小小确认"),
    }, responseError),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: responseGuard,
      WFCondition: 100,
      WFControlFlowMode: 0,
      WFInput: { Type: "Variable", Variable: attachment(responseError, "截图提交错误") },
    }),
    controlAction("is.workflow.actions.showresult", {
      Text: literalToken(CAPTURE_FAILURE_MESSAGE),
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: responseGuard,
      UUID: uuid(7),
      WFControlFlowMode: 2,
    }),
  ];
}

export function inspectConvertedIcostCaptureShortcutXml(xml) {
  const plist = parsePlistXml(xml);
  const actions = plist.WFWorkflowActions;
  requireValue(Array.isArray(actions) && actions.length === 12, "智能截图记账动作数量不正确");
  requireValue(actions.slice(0, 3).map((entry) => entry.WFWorkflowActionIdentifier).join("|")
    === [SCREENSHOT_ACTION, CROP_ACTION, OCR_ACTION].join("|"), "截屏、裁剪、OCR 前缀未保留");
  requireValue(!actions.some((entry) => entry.WFWorkflowActionIdentifier === ICOST_ACTION), "转换后不得保留 iCost 写入动作");
  const request = actions.find((entry) => entry.WFWorkflowActionIdentifier === REQUEST_ACTION);
  requireValue(request, "森特请求动作缺失");
  const parameters = request.WFWorkflowActionParameters;
  requireValue(parameters.WFURL === CAPTURE_INLINE_ENDPOINT, "自动截图接口地址不正确");
  requireValue(parameters.WFHTTPMethod === "POST" && parameters.WFHTTPBodyType === "JSON", "自动截图必须使用 JSON POST");
  const body = dictionaryMap(parameters.WFJSONValues);
  requireValue(JSON.stringify([...body.keys()]) === JSON.stringify([
    "account", "password", "text", "idempotency_key", "source_id", "source",
  ]), "自动截图请求字段不正确");
  requireValue(outputUuid(body.get("text")) === actions[2].WFWorkflowActionParameters.UUID, "自动截图未绑定原 OCR 输出");
  requireValue(literal(body.get("source")) === "shortcut", "自动截图 source 不正确");
  requireValue(actions.filter((entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.showresult").length === 1,
    "自动截图只能在失败时显示一次提示");
  return {
    actionCount: actions.length,
    endpoint: parameters.WFURL,
    preservesCapturePrefix: true,
    removesIcostWrite: true,
    hasInlineCredentials: true,
    hasFailureNotice: true,
    hasSuccessReceipt: false,
    payloadKeys: [...body.keys()],
  };
}

export async function convertIcostCaptureShortcut({
  inputPath,
  outputPath,
  endpoint = CAPTURE_INLINE_ENDPOINT,
} = {}) {
  if (!inputPath || !outputPath) throw new Error("inputPath and outputPath are required");
  if (new URL(endpoint).href !== new URL(CAPTURE_INLINE_ENDPOINT).href) {
    throw new Error("Only the canonical production capture endpoint is allowed");
  }
  const plist = parsePlistXml(await readFile(inputPath, "utf8"));
  plist.WFWorkflowActions = convertedActions(plist.WFWorkflowActions, endpoint);
  const xml = serializePlistXml(plist);
  const report = inspectConvertedIcostCaptureShortcutXml(xml);
  await writeFile(outputPath, xml, { encoding: "utf8", mode: 0o600 });
  await chmod(outputPath, 0o600);
  return { outputPath, report };
}

function parseCliArguments(argv) {
  const result = {};
  for (const argument of argv) {
    const match = /^--(input|output|endpoint)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    const key = match[1] === "input" ? "inputPath" : match[1] === "output" ? "outputPath" : "endpoint";
    result[key] = key === "endpoint" ? match[2] : resolve(match[2]);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  convertIcostCaptureShortcut(parseCliArguments(process.argv.slice(2)))
    .then(({ outputPath, report }) => process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
