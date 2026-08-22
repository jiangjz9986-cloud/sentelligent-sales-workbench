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

export const CAPTURE_DEVICE_ENDPOINT =
  "https://82.156.210.199/api/integrations/shortcut/bookkeeping-capture";
export const CAPTURE_SHORTCUT_NAME = "智能截图记账（设备直连版V4）";
export const CAPTURE_DEVICE_MARKER = "__SHORTCUT_DEVICE__";
export const CAPTURE_FAILURE_MESSAGE =
  "截图提交失败：服务器未接受本次请求。请检查网络；未收到小小微信草稿前不要认为已经记账。";

const uuid = (suffix) => `7B73F100-2EA8-4A20-9C73-${BigInt(suffix).toString(16).padStart(12, "0")}`;
const literalToken = (string) => ({
  Value: { string },
  WFSerializationType: "WFTextTokenString",
});
const attachment = (outputUuid, outputName) => ({
  Value: { OutputUUID: outputUuid, OutputName: outputName, Type: "ActionOutput" },
  WFSerializationType: "WFTextTokenAttachment",
});
const textAttachment = (outputUuid, outputName) => ({
  Value: {
    attachmentsByRange: {
      "{0, 1}": { OutputUUID: outputUuid, OutputName: outputName, Type: "ActionOutput" },
    },
    string: "\uFFFC",
  },
  WFSerializationType: "WFTextTokenString",
});
const interpolatedText = (parts) => {
  let string = "";
  const attachmentsByRange = {};
  for (const part of parts) {
    if (typeof part === "string") {
      string += part;
      continue;
    }
    attachmentsByRange[`{${string.length}, 1}`] = {
      OutputUUID: part.outputUuid,
      OutputName: part.outputName,
      Type: "ActionOutput",
    };
    string += "\uFFFC";
  }
  return {
    Value: { attachmentsByRange, string },
    WFSerializationType: "WFTextTokenString",
  };
};
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
  if (value?.WFSerializationType === "WFTextTokenAttachment") {
    return value.Value?.OutputUUID ?? null;
  }
  if (value?.WFSerializationType !== "WFTextTokenString") return null;
  const attachments = value.Value?.attachmentsByRange;
  if (!attachments || typeof attachments !== "object" || Array.isArray(attachments)) return null;
  const values = Object.values(attachments);
  return values.length === 1 ? values[0]?.OutputUUID ?? null : null;
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
  const rawText = actions[3].WFWorkflowActionParameters?.rawText;
  requireValue(rawText?.WFSerializationType === "WFTextTokenString", "iCost OCR 原文不是文本字符串");
  requireValue(outputUuid(rawText) === actions[2].WFWorkflowActionParameters.UUID,
    "iCost OCR 原文未绑定 OCR 动作输出");
}

function convertedActions(sourceActions, endpoint, deviceToken) {
  assertLegacyPrefix(sourceActions);
  const ocrText = uuid(1);
  const currentDate = uuid(2);
  const timeId = uuid(3);
  const identifierText = uuid(4);
  const request = uuid(5);
  const responseError = uuid(6);
  const responseCode = uuid(7);
  const responseFields = uuid(8);
  const responseGuard = uuid(0x2000);
  // Preserve the exact text-token wrapper used by the legacy iCost App
  // Intent. The OCR action can otherwise arrive in a Shortcut JSON body as a
  // rich value instead of a string, which the server correctly rejects.
  const icostRawText = structuredClone(sourceActions[3].WFWorkflowActionParameters.rawText);
  return [
    ...structuredClone(sourceActions.slice(0, 3)),
    action("is.workflow.actions.gettext", {
      CustomOutputName: "OCR纯文本",
      WFTextActionText: icostRawText,
    }, ocrText),
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
    action("is.workflow.actions.gettext", {
      CustomOutputName: "截图记账ID纯文本",
      WFTextActionText: textAttachment(timeId, "截图记账ID"),
    }, identifierText),
    action(REQUEST_ACTION, {
      CustomOutputName: "已提交小小确认",
      WFHTTPMethod: "POST",
      WFHTTPBodyType: "JSON",
      WFURL: endpoint,
      WFHTTPHeaders: dictionaryField([
        ["Content-Type", "application/json"],
        ["Authorization", `Bearer ${deviceToken}`],
      ]),
      WFJSONValues: dictionaryField([
        ["text", textAttachment(ocrText, "OCR纯文本")],
        ["idempotency_key", textAttachment(identifierText, "截图记账ID纯文本")],
        ["source_id", textAttachment(identifierText, "截图记账ID纯文本")],
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
    action("is.workflow.actions.getvalueforkey", {
      CustomOutputName: "截图提交错误码",
      WFDictionaryKey: "code",
      WFInput: attachment(responseError, "截图提交错误"),
    }, responseCode),
    action("is.workflow.actions.getvalueforkey", {
      CustomOutputName: "截图提交错误字段",
      WFDictionaryKey: "fields",
      WFInput: attachment(responseError, "截图提交错误"),
    }, responseFields),
    controlAction("is.workflow.actions.showresult", {
      Text: interpolatedText([
        "截图提交失败（",
        { outputUuid: responseCode, outputName: "截图提交错误码" },
        "），字段：",
        { outputUuid: responseFields, outputName: "截图提交错误字段" },
        `。${CAPTURE_FAILURE_MESSAGE}`,
      ]),
    }),
    controlAction(CONDITIONAL_ACTION, {
      GroupingIdentifier: responseGuard,
      UUID: uuid(9),
      WFControlFlowMode: 2,
    }),
  ];
}

export function inspectConvertedIcostCaptureShortcutXml(xml) {
  const plist = parsePlistXml(xml);
  const actions = plist.WFWorkflowActions;
  requireValue(Array.isArray(actions) && actions.length === 14, "智能截图记账动作数量不正确");
  requireValue(actions.slice(0, 3).map((entry) => entry.WFWorkflowActionIdentifier).join("|")
    === [SCREENSHOT_ACTION, CROP_ACTION, OCR_ACTION].join("|"), "截屏、裁剪、OCR 前缀未保留");
  requireValue(!actions.some((entry) => entry.WFWorkflowActionIdentifier === ICOST_ACTION), "转换后不得保留 iCost 写入动作");
  const request = actions.find((entry) => entry.WFWorkflowActionIdentifier === REQUEST_ACTION);
  requireValue(request, "森特请求动作缺失");
  const parameters = request.WFWorkflowActionParameters;
  requireValue(parameters.WFURL === CAPTURE_DEVICE_ENDPOINT, "自动截图接口地址不正确");
  requireValue(parameters.WFHTTPMethod === "POST" && parameters.WFHTTPBodyType === "JSON", "自动截图必须使用 JSON POST");
  const headers = dictionaryMap(parameters.WFHTTPHeaders);
  requireValue(JSON.stringify([...headers.keys()]) === JSON.stringify(["Content-Type", "Authorization"]),
    "自动截图请求头不正确");
  requireValue(literal(headers.get("Content-Type")) === "application/json", "自动截图 Content-Type 不正确");
  const authorization = literal(headers.get("Authorization"));
  requireValue(typeof authorization === "string" && /^Bearer (?:__SHORTCUT_DEVICE__|[A-Za-z0-9_-]{43})$/u.test(authorization),
    "自动截图设备身份不正确");
  const body = dictionaryMap(parameters.WFJSONValues);
  requireValue(JSON.stringify([...body.keys()]) === JSON.stringify([
    "text", "idempotency_key", "source_id", "source",
  ]), "自动截图请求字段不正确");
  const ocrText = actions.find((entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "OCR纯文本");
  const identifierText = actions.find(
    (entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "截图记账ID纯文本",
  );
  requireValue(ocrText?.WFWorkflowActionIdentifier === "is.workflow.actions.gettext",
    "自动截图缺少 OCR 显式文本转换");
  requireValue(identifierText?.WFWorkflowActionIdentifier === "is.workflow.actions.gettext",
    "自动截图缺少时间 ID 显式文本转换");
  requireValue(outputUuid(ocrText.WFWorkflowActionParameters.WFTextActionText)
    === actions[2].WFWorkflowActionParameters.UUID, "OCR 文本转换未绑定原 OCR 输出");
  requireValue(outputUuid(body.get("text")) === ocrText.WFWorkflowActionParameters.UUID,
    "自动截图请求未绑定 OCR 纯文本输出");
  requireValue(outputUuid(body.get("idempotency_key")) === identifierText.WFWorkflowActionParameters.UUID,
    "自动截图幂等键未绑定纯文本输出");
  requireValue(outputUuid(body.get("source_id")) === identifierText.WFWorkflowActionParameters.UUID,
    "自动截图 source_id 未绑定纯文本输出");
  requireValue(body.get("text")?.WFSerializationType === "WFTextTokenString",
    "自动截图 OCR 输出必须强制转换为文本字符串");
  requireValue(body.get("idempotency_key")?.WFSerializationType === "WFTextTokenString",
    "自动截图幂等键必须强制转换为文本字符串");
  requireValue(body.get("source_id")?.WFSerializationType === "WFTextTokenString",
    "自动截图 source_id 必须强制转换为文本字符串");
  requireValue(literal(body.get("source")) === "shortcut", "自动截图 source 不正确");
  requireValue(actions.filter((entry) => entry.WFWorkflowActionIdentifier === "is.workflow.actions.showresult").length === 1,
    "自动截图只能在失败时显示一次提示");
  requireValue(actions.filter((entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "截图提交错误码").length === 1,
    "自动截图失败分支缺少安全错误码");
  requireValue(actions.filter((entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "截图提交错误字段").length === 1,
    "自动截图失败分支缺少安全错误字段");
  return {
    actionCount: actions.length,
    endpoint: parameters.WFURL,
    preservesCapturePrefix: true,
    preservesIcostOcrText: true,
    coercesOcrThroughTextAction: true,
    coercesIdentifiersThroughTextAction: true,
    removesIcostWrite: true,
    hasInlineCredentials: false,
    hasDeviceCredential: true,
    hasFailureNotice: true,
    hasSafeFailureDiagnostics: true,
    hasSuccessReceipt: false,
    payloadKeys: [...body.keys()],
  };
}

export async function convertIcostCaptureShortcut({
  inputPath,
  outputPath,
  endpoint = CAPTURE_DEVICE_ENDPOINT,
  deviceToken = CAPTURE_DEVICE_MARKER,
} = {}) {
  if (!inputPath || !outputPath) throw new Error("inputPath and outputPath are required");
  if (new URL(endpoint).href !== new URL(CAPTURE_DEVICE_ENDPOINT).href) {
    throw new Error("Only the canonical production capture endpoint is allowed");
  }
  if (deviceToken !== CAPTURE_DEVICE_MARKER && !/^[A-Za-z0-9_-]{43}$/u.test(deviceToken)) {
    throw new Error("deviceToken must be an account-bound Shortcut device credential");
  }
  const plist = parsePlistXml(await readFile(inputPath, "utf8"));
  plist.WFWorkflowActions = convertedActions(plist.WFWorkflowActions, endpoint, deviceToken);
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
