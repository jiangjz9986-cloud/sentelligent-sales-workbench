import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlistXml } from "../icost-shortcut/plist-xml.mjs";
import {
  BOOKKEEPING_CATALOG,
  BOOKKEEPING_SELECTION_OPTIONS,
  CREDENTIAL_OUTPUT_NAME,
  SHORTCUT_CREDENTIAL_FILE_NAME,
  SHORTCUT_CREDENTIAL_FILE_PATH,
  SHORTCUT_CREDENTIAL_SAVE_PATH,
  VERIFICATION_STATUS_OUTPUT_NAME,
  VERIFICATION_STATUS_TEXT_OUTPUT_NAME,
} from "./build-bookkeeping-shortcut.mjs";

const ICOST_ACTION = "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7";
const BOOKKEEPING_PATH = "/api/integrations/shortcut/bookkeeping";
const VERIFY_PATH = "/api/integrations/shortcut/verify";
const PAIR_PATH = "/api/integrations/shortcut/pair";
const ACTIONS = Object.freeze({
  openFile: "is.workflow.actions.documentpicker.open",
  saveFile: "is.workflow.actions.documentpicker.save",
  text: "is.workflow.actions.gettext",
  detectText: "is.workflow.actions.detect.text",
  setVariable: "is.workflow.actions.setvariable",
  request: "is.workflow.actions.downloadurl",
  dictionaryValue: "is.workflow.actions.getvalueforkey",
  conditional: "is.workflow.actions.conditional",
  screenshot: "is.workflow.actions.takescreenshot",
  crop: "is.workflow.actions.image.crop",
  ocr: "is.workflow.actions.extracttextfromimage",
  list: "is.workflow.actions.list",
  choose: "is.workflow.actions.choosefromlist",
  ask: "is.workflow.actions.ask",
  hash: "is.workflow.actions.hash",
  showResult: "is.workflow.actions.showresult",
});

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

const params = (entry) => entry?.WFWorkflowActionParameters ?? {};
const identifier = (entry) => entry?.WFWorkflowActionIdentifier;
const uuid = (entry) => params(entry).UUID;

function literal(value) {
  return value?.WFSerializationType === "WFTextTokenString"
    ? value.Value?.string
    : typeof value === "string" ? value : null;
}

function outputUuid(value) {
  return value?.WFSerializationType === "WFTextTokenAttachment"
    ? value.Value?.OutputUUID
    : null;
}

function textTokenContainsOutputUuid(value, expectedUuid) {
  const attachments = value?.Value?.attachmentsByRange;
  return value?.WFSerializationType === "WFTextTokenString"
    && Object.values(attachments ?? {}).some((entry) => entry?.OutputUUID === expectedUuid);
}

function dictionaryItems(field) {
  requireValue(field?.WFSerializationType === "WFDictionaryFieldValue", "HTTP 字典参数格式不正确");
  const items = field.Value?.WFDictionaryFieldValueItems;
  requireValue(Array.isArray(items), "HTTP 字典条目缺失");
  return items;
}

function dictionaryMap(field) {
  const map = new Map();
  for (const item of dictionaryItems(field)) {
    const key = literal(item.WFKey);
    requireValue(key && !map.has(key), "HTTP 字典键必须是唯一文本");
    map.set(key, item.WFValue);
  }
  return map;
}

function assertAuthorizationHeader(headerValue, credentialUuid) {
  requireValue(headerValue?.Value?.string === "Bearer ￼", "Authorization 必须使用设备凭据");
  requireValue(
    headerValue.Value.attachmentsByRange?.["{7, 1}"]?.OutputUUID === credentialUuid,
    "Authorization 必须绑定设备凭据变量",
  );
}

function assertCanonicalMetadata(plist) {
  requireValue(Array.isArray(plist.WFQuickActionSurfaces), "缺少 Apple 标准 Quick Action 元数据");
  requireValue(plist.WFWorkflowHasShortcutInputVariables === false, "快捷指令输入变量元数据不正确");
  requireValue(
    Array.isArray(plist.WFWorkflowInputContentItemClasses)
      && plist.WFWorkflowInputContentItemClasses.includes("WFStringContentItem")
      && plist.WFWorkflowInputContentItemClasses.includes("WFImageContentItem"),
    "缺少 Apple 标准输入类型元数据",
  );
  requireValue(
    Array.isArray(plist.WFWorkflowTypes) && plist.WFWorkflowTypes.includes("WFWorkflowTypeShowInSearch"),
    "缺少 Apple 标准工作流类型元数据",
  );
  requireValue(!Object.hasOwn(plist, "WFWorkflowName"), "兼容版不得写入非基线 WFWorkflowName");
  requireValue(!Object.hasOwn(plist, "WFWorkflowDescription"), "兼容版不得写入非基线 WFWorkflowDescription");
  requireValue(!Object.hasOwn(plist, "WFWorkflowImportQuestions"), "账号配对版不得写入导入问题");
}

function assertActionShape(actions) {
  const expected = [
    ACTIONS.openFile,
    ACTIONS.conditional,
    ACTIONS.detectText,
    ACTIONS.setVariable,
    ACTIONS.conditional,
    ACTIONS.ask,
    ACTIONS.ask,
    ACTIONS.request,
    ACTIONS.dictionaryValue,
    ACTIONS.dictionaryValue,
    ACTIONS.setVariable,
    ACTIONS.saveFile,
    ACTIONS.showResult,
    ACTIONS.conditional,
    ACTIONS.request,
    ACTIONS.dictionaryValue,
    ACTIONS.text,
    ACTIONS.conditional,
    ACTIONS.screenshot,
    ACTIONS.crop,
    ACTIONS.ocr,
    ACTIONS.list,
    ACTIONS.choose,
    ACTIONS.conditional,
    ACTIONS.ask,
    ACTIONS.text,
    ACTIONS.hash,
    ACTIONS.request,
    ACTIONS.showResult,
    ACTIONS.conditional,
    ACTIONS.showResult,
    ACTIONS.conditional,
    ACTIONS.conditional,
    ACTIONS.showResult,
    ACTIONS.conditional,
  ];
  requireValue(
    JSON.stringify(actions.map(identifier)) === JSON.stringify(expected),
    "快捷指令必须保持账号配对和服务端微信自然语言确认流程",
  );

  const expectedUuidActions = actions.filter(
    (_, index) => ![1, 4, 12, 17, 23, 28, 29, 30, 32, 33].includes(index),
  );
  requireValue(expectedUuidActions.every((entry) => uuid(entry)), "可输出动作和条件结束标记必须有 UUID");
  const ids = expectedUuidActions.map(uuid);
  requireValue(new Set(ids).size === ids.length, "动作 UUID 不得重复");
  for (const index of [1, 4, 17, 23, 29, 32]) {
    requireValue(!uuid(actions[index]), "条件起点和否则分支不得写入 UUID");
  }
  for (const index of [12, 28, 30, 33]) {
    requireValue(!uuid(actions[index]), "显示结果动作应保持 Apple 基线格式");
  }

  const credentialGroup = params(actions[1]).GroupingIdentifier;
  requireValue(credentialGroup && params(actions[1]).WFControlFlowMode === 0, "设备凭据条件起点不正确");
  requireValue(params(actions[4]).GroupingIdentifier === credentialGroup && params(actions[4]).WFControlFlowMode === 1, "设备凭据否则分支不匹配");
  requireValue(params(actions[13]).GroupingIdentifier === credentialGroup && params(actions[13]).WFControlFlowMode === 2, "设备凭据条件结束标记不匹配");

  const verificationGroup = params(actions[17]).GroupingIdentifier;
  requireValue(verificationGroup && params(actions[17]).WFControlFlowMode === 0, "验证条件起点不正确");
  requireValue(params(actions[32]).GroupingIdentifier === verificationGroup && params(actions[32]).WFControlFlowMode === 1, "验证否则分支不匹配");
  requireValue(params(actions[34]).GroupingIdentifier === verificationGroup && params(actions[34]).WFControlFlowMode === 2, "验证条件结束标记不匹配");

  const selectionGroup = params(actions[23]).GroupingIdentifier;
  requireValue(selectionGroup && params(actions[23]).WFCondition === 100, "取消门禁条件起点不正确");
  requireValue(params(actions[29]).GroupingIdentifier === selectionGroup && params(actions[29]).WFControlFlowMode === 1, "取消门禁否则分支不匹配");
  requireValue(params(actions[31]).GroupingIdentifier === selectionGroup && params(actions[31]).WFControlFlowMode === 2, "取消门禁条件未正确结束");
}

function assertCredentialFlow(actions) {
  const file = params(actions[0]);
  requireValue(file.WFGetFilePath === SHORTCUT_CREDENTIAL_FILE_NAME, "设备凭据读取路径不正确");
  requireValue(file.WFFileErrorIfNotFound === false, "设备凭据不存在时不得中断首次配对");
  requireValue(!Object.hasOwn(file, "WFFileStorageService") && !Object.hasOwn(file, "WFShowFilePicker"), "设备凭据读取不得使用旧版文件选择参数");
  requireValue(params(actions[1]).WFCondition === 100, "设备凭据条件必须检查文件是否存在");
  requireValue(outputUuid(params(actions[2]).WFInput) === uuid(actions[0]), "设备凭据文本转换未绑定文件输出");
  requireValue(params(actions[2]).CustomOutputName === CREDENTIAL_OUTPUT_NAME, "设备凭据文本输出名不正确");
  requireValue(params(actions[3]).WFVariableName === CREDENTIAL_OUTPUT_NAME, "首次运行前设备凭据变量名不正确");
  requireValue(outputUuid(params(actions[3]).WFInput) === uuid(actions[2]), "设备凭据变量未绑定读取结果");
  requireValue(params(actions[5]).WFAskActionPrompt === "首次使用请输入森特账号", "首次配对账号提示不正确");
  requireValue(params(actions[6]).WFAskActionPrompt.includes("森特密码"), "首次配对密码提示不正确");

  const pair = params(actions[7]);
  requireValue(pair.WFHTTPMethod === "POST" && pair.WFHTTPBodyType === "JSON", "设备配对必须使用 JSON POST");
  const pairUrl = new URL(pair.WFURL);
  requireValue(pairUrl.protocol === "https:" && pairUrl.pathname === PAIR_PATH, `设备配对必须使用 ${PAIR_PATH}`);
  const pairHeaders = dictionaryMap(pair.WFHTTPHeaders);
  requireValue(pairHeaders.size === 1 && literal(pairHeaders.get("Content-Type")) === "application/json", "设备配对请求头不正确");
  const pairBody = dictionaryMap(pair.WFJSONValues);
  requireValue(JSON.stringify([...pairBody.keys()]) === JSON.stringify(["account", "password", "label"]), "设备配对字段不正确");
  requireValue(outputUuid(pairBody.get("account")) === uuid(actions[5]), "配对账号未绑定输入动作");
  requireValue(outputUuid(pairBody.get("password")) === uuid(actions[6]), "配对密码未绑定输入动作");
  requireValue(literal(pairBody.get("label")) === "iPhone 森特截图记账", "配对设备标签不正确");
  requireValue(params(actions[8]).WFDictionaryKey === "device" && outputUuid(params(actions[8]).WFInput) === uuid(actions[7]), "配对响应未读取 device");
  requireValue(params(actions[9]).WFDictionaryKey === "token" && outputUuid(params(actions[9]).WFInput) === uuid(actions[8]), "配对响应未读取设备 token");
  requireValue(params(actions[10]).WFVariableName === CREDENTIAL_OUTPUT_NAME && outputUuid(params(actions[10]).WFInput) === uuid(actions[9]), "配对 token 未保存到设备凭据变量");
  const save = params(actions[11]);
  requireValue(save.WFAskWhereToSave === false && save.WFFileDestinationPath === SHORTCUT_CREDENTIAL_SAVE_PATH && save.WFSaveFileOverwrite === true, "设备凭据保存参数不正确");
  requireValue(outputUuid(save.WFInput) === uuid(actions[9]), "保存动作未绑定配对 token");
  requireValue(literal(params(actions[12]).Text).includes("首次配对"), "首次配对回执不正确");
}

function assertCredentialVariableReference(headerValue) {
  requireValue(headerValue?.Value?.string === "Bearer ￼", "Authorization 必须使用设备凭据");
  const reference = headerValue.Value.attachmentsByRange?.["{7, 1}"];
  requireValue(
    reference?.Type === "Variable" && reference.VariableName === CREDENTIAL_OUTPUT_NAME,
    "Authorization 必须绑定设备凭据变量",
  );
}

export function inspectBookkeepingShortcutXml(xml) {
  const plist = parsePlistXml(xml);
  const actions = plist.WFWorkflowActions;
  requireValue(Array.isArray(actions), "快捷指令动作缺失");
  requireValue(!xml.includes(ICOST_ACTION), "自有快捷指令不得包含 iCost App 动作");
  requireValue(!xml.includes("is.workflow.actions.choosefrommenu"), "兼容版不得静态展开嵌套菜单");
  requireValue(!xml.includes("REPLACE_ME"), "账号配对版不得包含 Token 占位符");
  requireValue(!xml.includes("六位") && !xml.includes("确认码"), "快捷记账不得包含六位确认码文案");
  assertCanonicalMetadata(plist);
  assertActionShape(actions);
  assertCredentialFlow(actions);

  const verifyRequest = actions[14];
  requireValue(params(verifyRequest).WFHTTPMethod === "GET", "快捷指令验证必须使用 GET");
  const verifyUrl = new URL(params(verifyRequest).WFURL);
  requireValue(verifyUrl.protocol === "https:" && verifyUrl.pathname === VERIFY_PATH, `快捷指令验证必须使用 ${VERIFY_PATH}`);
  const verifyHeaders = dictionaryMap(params(verifyRequest).WFHTTPHeaders);
  requireValue(verifyHeaders.size === 2 && verifyHeaders.has("Authorization") && literal(verifyHeaders.get("X-Shortcut-Verification-Mode")) === "explain", "快捷指令验证请求头不完整");
  assertCredentialVariableReference(verifyHeaders.get("Authorization"));
  requireValue(params(actions[15]).WFDictionaryKey === "status", "验证必须读取 status 字段");
  requireValue(params(actions[15]).CustomOutputName === VERIFICATION_STATUS_OUTPUT_NAME, "验证状态输出名不正确");
  requireValue(outputUuid(params(actions[15]).WFInput) === uuid(verifyRequest), "验证状态未绑定验证响应");
  requireValue(params(actions[16]).CustomOutputName === VERIFICATION_STATUS_TEXT_OUTPUT_NAME, "验证状态文本输出名不正确");
  requireValue(textTokenContainsOutputUuid(params(actions[16]).WFTextActionText, uuid(actions[15])), "验证状态文本未绑定 status 输出");
  requireValue(params(actions[17]).WFCondition === 4 && params(actions[17]).WFConditionalActionString === "ok", "验证成功条件不正确");
  requireValue(params(actions[17]).WFInput?.Variable?.Value?.OutputName === VERIFICATION_STATUS_TEXT_OUTPUT_NAME, "验证条件未引用状态文本输出");

  requireValue(outputUuid(params(actions[19]).WFInput) === uuid(actions[18]), "裁剪必须使用截屏输出");
  requireValue(outputUuid(params(actions[20]).WFImage) === uuid(actions[19]), "OCR 必须使用裁剪输出");
  const options = params(actions[21]).WFItems;
  requireValue(Array.isArray(options), "合法分类列表缺失");
  requireValue(JSON.stringify(options) === JSON.stringify(BOOKKEEPING_SELECTION_OPTIONS), "合法分类列表与账本目录不一致");
  requireValue(outputUuid(params(actions[22]).WFInput) === uuid(actions[21]), "分类选择未绑定合法分类列表");
  requireValue(params(actions[22]).WFChooseFromListActionPrompt === "选择账本 · 收支 · 分类 · 子分类", "分类选择提示不正确");
  requireValue(params(actions[23]).WFCondition === 100 && params(actions[23]).WFInput?.Variable?.Value?.OutputUUID === uuid(actions[22]), "取消门禁必须绑定分类选择输出");
  requireValue(params(actions[24]).WFAskActionPrompt === "备注（可选，直接点完成跳过）", "备注必须明确为可选");
  requireValue(params(actions[26]).WFHashType === "SHA256" && outputUuid(params(actions[26]).WFInput) === uuid(actions[25]), "幂等键必须使用 SHA-256");
  const idAttachments = params(actions[25]).WFTextActionText?.Value?.attachmentsByRange ?? {};
  for (const expectedUuid of [uuid(actions[20]), uuid(actions[22]), uuid(actions[24])]) {
    requireValue(Object.values(idAttachments).some((entry) => entry?.OutputUUID === expectedUuid), "幂等键原文缺少 OCR、分类或备注");
  }
  requireValue(!Object.values(idAttachments).some((entry) => entry?.Type === "CurrentDate"), "幂等键不得依赖 CurrentDate");

  const writeRequest = actions[27];
  const writeParams = params(writeRequest);
  requireValue(writeParams.WFHTTPMethod === "POST" && writeParams.WFHTTPBodyType === "JSON", "记账请求必须使用 JSON POST");
  const writeUrl = new URL(writeParams.WFURL);
  requireValue(writeUrl.protocol === "https:" && writeUrl.pathname === BOOKKEEPING_PATH, `记账请求必须使用 ${BOOKKEEPING_PATH}`);
  const writeHeaders = dictionaryMap(writeParams.WFHTTPHeaders);
  requireValue(writeHeaders.size === 1 && writeHeaders.has("Authorization"), "记账请求必须使用设备凭据鉴权");
  assertCredentialVariableReference(writeHeaders.get("Authorization"));
  const body = dictionaryMap(writeParams.WFJSONValues);
  const expectedKeys = ["text", "selection_path", "note", "idempotency_key", "source"];
  requireValue(JSON.stringify([...body.keys()]) === JSON.stringify(expectedKeys), "记账请求字段必须符合兼容版契约");
  requireValue(outputUuid(body.get("text")) === uuid(actions[20]), "text 必须引用 OCR 输出");
  requireValue(outputUuid(body.get("selection_path")) === uuid(actions[22]), "selection_path 必须引用分类选择输出");
  requireValue(outputUuid(body.get("note")) === uuid(actions[24]), "note 必须引用备注输出");
  requireValue(outputUuid(body.get("idempotency_key")) === uuid(actions[26]), "idempotency_key 必须引用 SHA-256");
  requireValue(literal(body.get("source")) === "shortcut", "source 必须是 shortcut");
  requireValue(literal(params(actions[30]).Text) === "已取消，不会上传任何记账数据", "取消分支必须明确不上传");

  return {
    actionCount: actions.length,
    endpoint: writeParams.WFURL,
    verifyEndpoint: params(verifyRequest).WFURL,
    pairEndpoint: params(actions[7]).WFURL,
    hasIcostAction: false,
    hasTokenVerification: true,
    hasCredentialPairing: true,
    hasCredentialPersistence: true,
    hasCancellationGate: true,
    ledgerOptions: Object.keys(BOOKKEEPING_CATALOG),
    selectionOptionCount: BOOKKEEPING_SELECTION_OPTIONS.length,
    menuCount: 0,
    payloadKeys: [...body.keys()],
    importQuestionKinds: [],
    canonicalMetadata: true,
    credentialPath: SHORTCUT_CREDENTIAL_FILE_PATH,
  };
}

export async function verifyBookkeepingShortcutFile(filePath) {
  return inspectBookkeepingShortcutXml(await readFile(filePath, "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("Usage: node verify-bookkeeping-shortcut.mjs <unsigned.shortcut>");
  verifyBookkeepingShortcutFile(resolve(filePath))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
