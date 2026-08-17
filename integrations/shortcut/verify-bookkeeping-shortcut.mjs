import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlistXml } from "../icost-shortcut/plist-xml.mjs";
import {
  BOOKKEEPING_CATALOG,
  BOOKKEEPING_SELECTION_OPTIONS,
  SHORTCUT_TOKEN_PLACEHOLDER,
  VERIFICATION_STATUS_OUTPUT_NAME,
} from "./build-bookkeeping-shortcut.mjs";

const ICOST_ACTION = "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7";
const BOOKKEEPING_PATH = "/api/integrations/shortcut/bookkeeping";
const VERIFY_PATH = "/api/integrations/shortcut/verify";
const ACTIONS = Object.freeze({
  text: "is.workflow.actions.gettext",
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

function assertAuthorizationHeader(headerValue, tokenUuid) {
  requireValue(headerValue?.Value?.string === "Bearer ￼", "Authorization 必须使用 Bearer Token");
  requireValue(
    headerValue.Value.attachmentsByRange?.["{7, 1}"]?.OutputUUID === tokenUuid,
    "Authorization 必须绑定 Token 文本动作",
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
}

function assertActionShape(actions) {
  const expected = [
    ACTIONS.text,
    ACTIONS.request,
    ACTIONS.dictionaryValue,
    ACTIONS.conditional,
    ACTIONS.screenshot,
    ACTIONS.crop,
    ACTIONS.ocr,
    ACTIONS.list,
    ACTIONS.choose,
    ACTIONS.ask,
    ACTIONS.text,
    ACTIONS.hash,
    ACTIONS.request,
    ACTIONS.showResult,
    ACTIONS.conditional,
    ACTIONS.showResult,
    ACTIONS.conditional,
  ];
  requireValue(
    JSON.stringify(actions.map(identifier)) === JSON.stringify(expected),
    "快捷指令必须保持 17 动作兼容流程",
  );

  const controlGroup = params(actions[3]).GroupingIdentifier;
  requireValue(controlGroup && params(actions[3]).WFControlFlowMode === 0, "Token 验证条件起点不正确");
  requireValue(params(actions[14]).GroupingIdentifier === controlGroup, "Token 验证否则分支不匹配");
  requireValue(params(actions[14]).WFControlFlowMode === 1, "Token 验证否则分支模式不正确");
  requireValue(params(actions[16]).GroupingIdentifier === controlGroup, "Token 验证条件结束标记不匹配");
  requireValue(params(actions[16]).WFControlFlowMode === 2, "Token 验证条件未正确结束");
  requireValue(!uuid(actions[3]) && !uuid(actions[14]), "Apple 条件起点和否则分支不得写入 UUID");
  requireValue(uuid(actions[16]), "Apple 条件结束标记必须有 UUID");
  requireValue(!uuid(actions[13]) && !uuid(actions[15]), "显示结果动作应保持 Apple 基线格式");

  const expectedUuidActions = actions.filter((_, index) => ![3, 13, 14, 15].includes(index));
  requireValue(expectedUuidActions.every((entry) => uuid(entry)), "可输出动作和条件结束标记必须有 UUID");
  const ids = expectedUuidActions.map(uuid);
  requireValue(new Set(ids).size === ids.length, "动作 UUID 不得重复");
}

export function inspectBookkeepingShortcutXml(xml) {
  const plist = parsePlistXml(xml);
  const actions = plist.WFWorkflowActions;
  requireValue(Array.isArray(actions), "快捷指令动作缺失");
  requireValue(!xml.includes(ICOST_ACTION), "自有快捷指令不得包含 iCost App 动作");
  requireValue(!xml.includes("is.workflow.actions.choosefrommenu"), "兼容版不得静态展开嵌套菜单");
  requireValue(!xml.includes("is.workflow.actions.setvariable"), "兼容版不得使用非标准设定变量动作");
  assertCanonicalMetadata(plist);
  assertActionShape(actions);

  const tokenAction = actions[0];
  requireValue(params(tokenAction).WFTextActionText === SHORTCUT_TOKEN_PLACEHOLDER, "Token 必须保留导入占位符");
  const tokenUuid = uuid(tokenAction);

  const verifyRequest = actions[1];
  requireValue(params(verifyRequest).WFHTTPMethod === "GET", "Token 验证必须使用 GET");
  const verifyUrl = new URL(params(verifyRequest).WFURL);
  requireValue(verifyUrl.protocol === "https:" && verifyUrl.pathname === VERIFY_PATH, `Token 验证必须使用 ${VERIFY_PATH}`);
  const verifyHeaders = dictionaryMap(params(verifyRequest).WFHTTPHeaders);
  requireValue(
    verifyHeaders.size === 2
      && verifyHeaders.has("Authorization")
      && literal(verifyHeaders.get("X-Shortcut-Verification-Mode")) === "explain",
    "Token 验证请求头不完整",
  );
  assertAuthorizationHeader(verifyHeaders.get("Authorization"), tokenUuid);

  requireValue(params(actions[2]).WFDictionaryKey === "status", "Token 验证必须读取 status 字段");
  requireValue(
    params(actions[2]).CustomOutputName === VERIFICATION_STATUS_OUTPUT_NAME,
    "Token 验证状态必须保留可引用的输出名称",
  );
  requireValue(outputUuid(params(actions[2]).WFInput) === uuid(verifyRequest), "Token 验证状态未绑定验证响应");
  requireValue(params(actions[3]).WFCondition === 4, "Token 验证条件必须使用文本等于");
  requireValue(params(actions[3]).WFConditionalActionString === "ok", "Token 验证成功值必须为 ok");
  requireValue(
    params(actions[3]).WFInput?.Variable?.Value?.OutputName === VERIFICATION_STATUS_OUTPUT_NAME,
    "Token 验证条件必须引用可解析的状态输出",
  );

  requireValue(outputUuid(params(actions[5]).WFInput) === uuid(actions[4]), "裁剪必须使用截屏输出");
  requireValue(outputUuid(params(actions[6]).WFImage) === uuid(actions[5]), "OCR 必须使用裁剪输出");

  const options = params(actions[7]).WFItems;
  requireValue(Array.isArray(options), "合法分类列表缺失");
  requireValue(JSON.stringify(options) === JSON.stringify(BOOKKEEPING_SELECTION_OPTIONS), "合法分类列表与账本目录不一致");
  requireValue(outputUuid(params(actions[8]).WFInput) === uuid(actions[7]), "分类选择未绑定合法分类列表");
  requireValue(params(actions[8]).WFChooseFromListActionPrompt === "选择账本 · 收支 · 分类 · 子分类", "分类选择提示不正确");

  requireValue(params(actions[9]).WFAskActionPrompt === "备注（可选，直接点完成跳过）", "备注必须明确为可选");
  requireValue(params(actions[11]).WFHashType === "SHA256", "幂等键必须使用 SHA-256");
  requireValue(outputUuid(params(actions[11]).WFInput) === uuid(actions[10]), "SHA-256 未绑定幂等键原文");
  const idAttachments = params(actions[10]).WFTextActionText?.Value?.attachmentsByRange ?? {};
  for (const expectedUuid of [uuid(actions[6]), uuid(actions[8]), uuid(actions[9])]) {
    requireValue(Object.values(idAttachments).some((entry) => entry?.OutputUUID === expectedUuid), "幂等键原文缺少 OCR、分类或备注");
  }

  const writeRequest = actions[12];
  const writeParams = params(writeRequest);
  requireValue(writeParams.WFHTTPMethod === "POST", "记账请求必须使用 POST");
  requireValue(writeParams.WFHTTPBodyType === "JSON", "记账请求必须使用 JSON");
  const writeUrl = new URL(writeParams.WFURL);
  requireValue(writeUrl.protocol === "https:" && writeUrl.pathname === BOOKKEEPING_PATH, `记账请求必须使用 ${BOOKKEEPING_PATH}`);
  const writeHeaders = dictionaryMap(writeParams.WFHTTPHeaders);
  requireValue(writeHeaders.size === 1 && writeHeaders.has("Authorization"), "记账请求必须只使用 Authorization 鉴权");
  assertAuthorizationHeader(writeHeaders.get("Authorization"), tokenUuid);

  const body = dictionaryMap(writeParams.WFJSONValues);
  const expectedKeys = ["text", "selection_path", "note", "idempotency_key", "source"];
  requireValue(JSON.stringify([...body.keys()]) === JSON.stringify(expectedKeys), "记账请求字段必须符合兼容版契约");
  requireValue(outputUuid(body.get("text")) === uuid(actions[6]), "text 必须引用 OCR 输出");
  requireValue(outputUuid(body.get("selection_path")) === uuid(actions[8]), "selection_path 必须引用分类选择输出");
  requireValue(outputUuid(body.get("note")) === uuid(actions[9]), "note 必须引用备注输出");
  requireValue(outputUuid(body.get("idempotency_key")) === uuid(actions[11]), "idempotency_key 必须引用 SHA-256");
  requireValue(literal(body.get("source")) === "shortcut", "source 必须是 shortcut");

  const importQuestions = plist.WFWorkflowImportQuestions;
  requireValue(Array.isArray(importQuestions) && importQuestions.length === 1, "兼容版只能保留一个 Token 导入问题");
  const tokenQuestion = importQuestions[0];
  requireValue(
    tokenQuestion.ActionIndex === 0
      && tokenQuestion.ParameterKey === "WFTextActionText"
      && tokenQuestion.DefaultValue === SHORTCUT_TOKEN_PLACEHOLDER,
    "Token 导入问题不正确",
  );

  return {
    actionCount: actions.length,
    endpoint: writeParams.WFURL,
    verifyEndpoint: params(verifyRequest).WFURL,
    hasIcostAction: false,
    hasTokenVerification: true,
    ledgerOptions: Object.keys(BOOKKEEPING_CATALOG),
    selectionOptionCount: BOOKKEEPING_SELECTION_OPTIONS.length,
    menuCount: 0,
    payloadKeys: [...body.keys()],
    importQuestionKinds: ["token"],
    canonicalMetadata: true,
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
