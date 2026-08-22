import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlistXml } from "../icost-shortcut/plist-xml.mjs";
import {
  BOOKKEEPING_CATALOG,
  BOOKKEEPING_CATEGORY_OPTIONS,
  BOOKKEEPING_ENTRY_TYPE_OPTIONS,
  BOOKKEEPING_SELECTION_OPTIONS,
  BOOKKEEPING_SUBCATEGORY_OPTIONS,
} from "./build-bookkeeping-shortcut.mjs";
import {
  INLINE_ACCOUNT_OUTPUT_NAME,
  INLINE_ACCOUNT_PLACEHOLDER,
  INLINE_BOOKKEEPING_ENDPOINT,
  INLINE_FAILURE_MESSAGE,
  INLINE_PASSWORD_OUTPUT_NAME,
  INLINE_PASSWORD_PLACEHOLDER,
} from "./build-bookkeeping-inline-shortcut.mjs";

const ICOST_ACTION = "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7";
const ACTIONS = Object.freeze({
  text: "is.workflow.actions.gettext",
  screenshot: "is.workflow.actions.takescreenshot",
  crop: "is.workflow.actions.image.crop",
  ocr: "is.workflow.actions.extracttextfromimage",
  list: "is.workflow.actions.list",
  choose: "is.workflow.actions.choosefromlist",
  ask: "is.workflow.actions.ask",
  date: "is.workflow.actions.date",
  formatDate: "is.workflow.actions.format.date",
  request: "is.workflow.actions.downloadurl",
  dictionaryValue: "is.workflow.actions.getvalueforkey",
  conditional: "is.workflow.actions.conditional",
  showResult: "is.workflow.actions.showresult",
  hash: "is.workflow.actions.hash",
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
    requireValue(key && !map.has(key), "HTTP 字典键必须唯一");
    map.set(key, item.WFValue);
  }
  return map;
}

function textTokenHas(value, expected) {
  return literal(value) === expected;
}

function textTokenContainsOutput(value, expectedUuid) {
  return value?.WFSerializationType === "WFTextTokenString"
    && Object.values(value.Value?.attachmentsByRange ?? {})
      .some((entry) => entry?.OutputUUID === expectedUuid);
}

function textTokenContainsOutputs(value, expectedUuids) {
  if (value?.WFSerializationType !== "WFTextTokenString") return false;
  const outputs = new Set(
    Object.values(value.Value?.attachmentsByRange ?? {})
      .map((entry) => entry?.OutputUUID)
      .filter(Boolean),
  );
  return expectedUuids.every((expectedUuid) => outputs.has(expectedUuid));
}

function assertMetadata(plist) {
  requireValue(Array.isArray(plist.WFQuickActionSurfaces), "缺少 Apple 标准 Quick Action 元数据");
  requireValue(plist.WFWorkflowHasShortcutInputVariables === false, "快捷指令输入变量元数据不正确");
  requireValue(Array.isArray(plist.WFWorkflowInputContentItemClasses), "缺少快捷指令输入类型元数据");
  requireValue(plist.WFWorkflowInputContentItemClasses.includes("WFStringContentItem"), "缺少文本输入类型元数据");
  requireValue(plist.WFWorkflowInputContentItemClasses.includes("WFImageContentItem"), "缺少图像输入类型元数据");
  requireValue(Array.isArray(plist.WFWorkflowTypes) && plist.WFWorkflowTypes.includes("WFWorkflowTypeShowInSearch"), "缺少工作流类型元数据");
  requireValue(!Object.hasOwn(plist, "WFWorkflowImportQuestions"), "手动常量版不得写入导入问题");
}

function findByOutputName(actions, outputName) {
  const matches = actions.filter((entry) => params(entry).CustomOutputName === outputName);
  requireValue(matches.length === 1, `${outputName} 动作必须唯一`);
  return matches[0];
}

function indexOfAction(actions, target) {
  const index = actions.indexOf(target);
  requireValue(index >= 0, "快捷指令动作索引缺失");
  return index;
}

export function inspectBookkeepingInlineShortcutXml(xml) {
  const plist = parsePlistXml(xml);
  const actions = plist.WFWorkflowActions;
  requireValue(Array.isArray(actions), "快捷指令动作缺失");
  requireValue(!xml.includes(ICOST_ACTION), "自有快捷指令不得包含 iCost App 动作");
  requireValue(!xml.includes("六位") && !xml.includes("确认码"), "快捷记账不得包含六位确认码文案");
  requireValue(!xml.includes("森特智行快捷指令凭据"), "手动常量版不得依赖凭据文件");
  requireValue(!xml.includes("出差报销"), "快捷指令可见分类列表不得包含内部账本名称");
  assertMetadata(plist);

  requireValue(actions.length === 58, "三级菜单快捷指令动作数量不正确");
  requireValue(actions[0] && actions[1], "账号密码常量动作缺失");
  requireValue(identifier(actions[0]) === ACTIONS.text && identifier(actions[1]) === ACTIONS.text, "账号密码常量必须位于最顶部");
  requireValue(!actions.some((entry) => identifier(entry) === ACTIONS.hash), "快捷指令不得复用内容哈希");
  requireValue(actions.filter((entry) => identifier(entry) === ACTIONS.showResult).length === 1, "快捷指令只能在提交失败时显示一次提示");
  requireValue(actions.filter((entry) => identifier(entry) === ACTIONS.request).length === 1, "记账请求动作必须唯一");
  requireValue(actions.filter((entry) => identifier(entry) === ACTIONS.date).length === 1, "当前时间动作必须唯一");
  requireValue(actions.filter((entry) => identifier(entry) === ACTIONS.formatDate).length === 1, "时间 ID 格式化动作必须唯一");

  const uuidActions = actions.filter((entry) => {
    const mode = params(entry).WFControlFlowMode;
    return identifier(entry) !== ACTIONS.showResult
      && (identifier(entry) !== ACTIONS.conditional || ![0, 1, 2].includes(mode));
  });
  requireValue(uuidActions.every((entry) => uuid(entry)), "可输出动作必须有 UUID");
  requireValue(new Set(uuidActions.map(uuid)).size === uuidActions.length, "动作 UUID 不得重复");
  for (const entry of actions.filter((candidate) => !uuidActions.includes(candidate))) {
    requireValue(!uuid(entry), "条件起点和否则标记不得写 UUID");
  }

  const accountAction = actions[0];
  const passwordAction = actions[1];
  const account = params(accountAction);
  const password = params(passwordAction);
  requireValue(account.CustomOutputName === INLINE_ACCOUNT_OUTPUT_NAME, "账号常量输出名不正确");
  requireValue(password.CustomOutputName === INLINE_PASSWORD_OUTPUT_NAME, "密码常量输出名不正确");
  requireValue(textTokenHas(account.WFTextActionText, INLINE_ACCOUNT_PLACEHOLDER), "账号常量占位文本不正确");
  requireValue(textTokenHas(password.WFTextActionText, INLINE_PASSWORD_PLACEHOLDER), "密码常量占位文本不正确");

  const screenshot = actions.find((entry) => identifier(entry) === ACTIONS.screenshot);
  const crop = actions.find((entry) => identifier(entry) === ACTIONS.crop);
  const ocr = actions.find((entry) => identifier(entry) === ACTIONS.ocr);
  requireValue(screenshot && crop && ocr, "截屏、裁剪或 OCR 动作缺失");
  requireValue(outputUuid(params(crop).WFInput) === uuid(screenshot), "裁剪未绑定截屏输出");
  requireValue(outputUuid(params(ocr).WFImage) === uuid(crop), "OCR 未绑定裁剪输出");

  const entryOptions = findByOutputName(actions, "记账第一层（收支）");
  const entrySelection = findByOutputName(actions, "本次收支类型");
  const expenseCategories = findByOutputName(actions, "支出类别");
  const expenseCategorySelection = findByOutputName(actions, "本次支出类别");
  const incomeCategories = findByOutputName(actions, "收入类别");
  const incomeCategorySelection = findByOutputName(actions, "本次收入类别");
  const categoryResult = findByOutputName(actions, "本次费用类别");
  const mealOptions = findByOutputName(actions, "餐饮子类别");
  const mealSelection = findByOutputName(actions, "本次餐饮子类别");
  const transportOptions = findByOutputName(actions, "交通子类别");
  const transportSelection = findByOutputName(actions, "本次交通子类别");
  const travelOptions = findByOutputName(actions, "出差收入子类别");
  const travelSelection = findByOutputName(actions, "本次出差收入子类别");
  const subcategoryResult = findByOutputName(actions, "本次费用子类别");
  const note = findByOutputName(actions, "备注");
  const currentDate = findByOutputName(actions, "本次记账时间");
  const timeId = findByOutputName(actions, "时间记账ID");
  const selectionPath = findByOutputName(actions, "三级记账路径");
  const requestAction = findByOutputName(actions, "已提交微信确认");
  const responseError = findByOutputName(actions, "记账提交错误");

  requireValue(JSON.stringify(params(entryOptions).WFItems) === JSON.stringify(BOOKKEEPING_ENTRY_TYPE_OPTIONS), "第一层收支列表不一致");
  requireValue(JSON.stringify(params(entryOptions).WFItems) === JSON.stringify(["收入", "支出"]), "第一层必须先收入后支出");
  requireValue(outputUuid(params(entrySelection).WFInput) === uuid(entryOptions), "第一层选择未绑定列表输出");
  requireValue(params(entrySelection).WFChooseFromListActionPrompt === "第一层：选择收支类型", "第一层选择提示不正确");
  requireValue(JSON.stringify(params(expenseCategories).WFItems) === JSON.stringify(BOOKKEEPING_CATEGORY_OPTIONS.支出), "支出二级菜单不一致");
  requireValue(JSON.stringify(params(incomeCategories).WFItems) === JSON.stringify(BOOKKEEPING_CATEGORY_OPTIONS.收入), "收入二级菜单不一致");
  requireValue(outputUuid(params(expenseCategorySelection).WFInput) === uuid(expenseCategories), "支出二级选择未绑定列表");
  requireValue(outputUuid(params(incomeCategorySelection).WFInput) === uuid(incomeCategories), "收入二级选择未绑定列表");
  requireValue(JSON.stringify(params(mealOptions).WFItems) === JSON.stringify(BOOKKEEPING_SUBCATEGORY_OPTIONS.餐饮), "餐饮三级菜单不一致");
  requireValue(JSON.stringify(params(transportOptions).WFItems) === JSON.stringify(BOOKKEEPING_SUBCATEGORY_OPTIONS.交通), "交通三级菜单不一致");
  requireValue(JSON.stringify(params(travelOptions).WFItems) === JSON.stringify(BOOKKEEPING_SUBCATEGORY_OPTIONS.出差), "出差收入三级菜单不一致");
  requireValue(outputUuid(params(mealSelection).WFInput) === uuid(mealOptions), "餐饮三级选择未绑定列表");
  requireValue(outputUuid(params(transportSelection).WFInput) === uuid(transportOptions), "交通三级选择未绑定列表");
  requireValue(outputUuid(params(travelSelection).WFInput) === uuid(travelOptions), "出差收入三级选择未绑定列表");

  const equalityConditions = actions
    .filter((entry) => identifier(entry) === ACTIONS.conditional && params(entry).WFCondition === 4)
    .map((entry) => params(entry).WFConditionalActionString);
  requireValue(JSON.stringify(equalityConditions) === JSON.stringify(["支出", "餐饮", "交通", "出差"]), "三级菜单分支条件不正确");
  const responseErrorGuard = actions.find(
    (entry) => identifier(entry) === ACTIONS.conditional
      && params(entry).WFCondition === 100
      && params(entry).WFControlFlowMode === 0
      && outputUuid(params(entry).WFInput?.Variable) === uuid(responseError),
  );
  requireValue(responseErrorGuard, "提交失败提示门禁缺失");
  const cancellationGuards = actions.filter(
    (entry) => identifier(entry) === ACTIONS.conditional
      && params(entry).WFCondition === 100
      && params(entry).WFControlFlowMode === 0,
  ).filter((entry) => entry !== responseErrorGuard);
  requireValue(cancellationGuards.length === 3, "三级菜单必须分别保护收支、类别和子类别取消操作");
  requireValue(params(note).WFAskActionPrompt === "备注（可选，直接点完成跳过）", "备注提示不正确");
  requireValue(identifier(currentDate) === ACTIONS.date && params(currentDate).WFDateActionMode === "Current Date", "当前时间动作不正确");
  requireValue(identifier(timeId) === ACTIONS.formatDate
    && params(timeId).WFDateFormatStyle === "Custom"
    && params(timeId).WFDateFormat === "yyyyMMddHHmmss"
    && outputUuid(params(timeId).WFDate) === uuid(currentDate), "时间记账 ID 必须使用 yyyyMMddHHmmss");
  requireValue(textTokenContainsOutputs(params(selectionPath).WFTextActionText, [
    uuid(entrySelection), uuid(categoryResult), uuid(subcategoryResult),
  ]), "三级记账路径未绑定全部三级菜单输出");

  const request = params(requestAction);
  requireValue(request.WFHTTPMethod === "POST" && request.WFHTTPBodyType === "JSON", "记账请求必须使用 JSON POST");
  const endpoint = new URL(request.WFURL);
  requireValue(endpoint.href === new URL(INLINE_BOOKKEEPING_ENDPOINT).href, "手动常量版接口地址不正确");
  const headers = dictionaryMap(request.WFHTTPHeaders);
  requireValue(headers.size === 1 && literal(headers.get("Content-Type")) === "application/json", "手动常量版请求头不正确");
  const body = dictionaryMap(request.WFJSONValues);
  requireValue(JSON.stringify([...body.keys()]) === JSON.stringify([
    "account", "password", "text", "selection_path", "note", "idempotency_key", "source_id", "source",
  ]), "手动常量版请求字段不正确");
  requireValue(outputUuid(body.get("account")) === uuid(accountAction), "请求未绑定账号常量");
  requireValue(outputUuid(body.get("password")) === uuid(passwordAction), "请求未绑定密码常量");
  requireValue(outputUuid(body.get("text")) === uuid(ocr), "请求未绑定 OCR 输出");
  requireValue(outputUuid(body.get("selection_path")) === uuid(selectionPath), "请求未绑定三级记账路径");
  requireValue(outputUuid(body.get("note")) === uuid(note), "请求未绑定备注输出");
  requireValue(outputUuid(body.get("idempotency_key")) === uuid(timeId), "请求未用时间生成幂等键");
  requireValue(outputUuid(body.get("source_id")) === uuid(timeId), "请求 source_id 未绑定同一时间 ID");
  requireValue(literal(body.get("source")) === "shortcut", "source 必须是 shortcut");
  const requestIndex = indexOfAction(actions, requestAction);
  requireValue(identifier(responseError) === ACTIONS.dictionaryValue, "提交失败响应必须读取 error 字段");
  requireValue(params(responseError).WFDictionaryKey === "error", "提交失败响应字段不正确");
  requireValue(outputUuid(params(responseError).WFInput) === uuid(requestAction), "提交失败响应未绑定记账请求");
  const responseErrorIndex = indexOfAction(actions, responseError);
  const responseErrorGuardIndex = indexOfAction(actions, responseErrorGuard);
  const responseErrorGroup = params(responseErrorGuard).GroupingIdentifier;
  const responseErrorNotice = actions.find(
    (entry) => identifier(entry) === ACTIONS.showResult,
  );
  const responseErrorEnd = actions.find(
    (entry) => identifier(entry) === ACTIONS.conditional
      && params(entry).GroupingIdentifier === responseErrorGroup
      && params(entry).WFControlFlowMode === 2,
  );
  requireValue(responseErrorNotice && responseErrorEnd, "提交失败提示分支不完整");
  requireValue(literal(params(responseErrorNotice).Text) === INLINE_FAILURE_MESSAGE, "提交失败提示文案不正确");
  requireValue(requestIndex < responseErrorIndex
    && responseErrorIndex < responseErrorGuardIndex
    && responseErrorGuardIndex < indexOfAction(actions, responseErrorNotice)
    && indexOfAction(actions, responseErrorNotice) < indexOfAction(actions, responseErrorEnd), "提交失败提示动作顺序不正确");
  requireValue(!actions.some(
    (entry) => identifier(entry) === ACTIONS.conditional
      && params(entry).GroupingIdentifier === responseErrorGroup
      && params(entry).WFControlFlowMode === 1,
  ), "成功分支必须保持静默，不得加入接口回执");
  for (const guard of cancellationGuards) {
    const group = params(guard).GroupingIdentifier;
    const otherwise = actions.findIndex((entry) => params(entry).GroupingIdentifier === group && params(entry).WFControlFlowMode === 1);
    requireValue(indexOfAction(actions, guard) < requestIndex && requestIndex < otherwise, "记账请求必须位于全部非空选择分支内");
  }

  return {
    actionCount: actions.length,
    endpoint: request.WFURL,
    hasInlineCredentials: true,
    hasPairing: false,
    hasTokenVerification: false,
    hasCancellationGate: true,
    hasShortcutReceipt: false,
    hasFailureNotice: true,
    usesTimeId: true,
    menuDepth: 3,
    ledgerOptions: Object.keys(BOOKKEEPING_CATALOG),
    selectionOptionCount: BOOKKEEPING_SELECTION_OPTIONS.length,
    payloadKeys: [...body.keys()],
    importQuestionKinds: [],
    canonicalMetadata: true,
  };
}

export async function verifyBookkeepingInlineShortcutFile(filePath) {
  return inspectBookkeepingInlineShortcutXml(await readFile(filePath, "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("Usage: node verify-bookkeeping-inline-shortcut.mjs <unsigned.shortcut>");
  verifyBookkeepingInlineShortcutFile(resolve(filePath))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
