import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlistXml, serializePlistXml } from "../icost-shortcut/plist-xml.mjs";

const ICOST_ACTION = "com.gostraight.smallAccountBook.ICAISnapshotShortcutV7";
const SCREENSHOT_ACTION = "is.workflow.actions.takescreenshot";
const CROP_ACTION = "is.workflow.actions.image.crop";
const OCR_ACTION = "is.workflow.actions.extracttextfromimage";
const TEXT_ACTION = "is.workflow.actions.gettext";
const LIST_ACTION = "is.workflow.actions.list";
const CHOOSE_ACTION = "is.workflow.actions.choosefromlist";
const ASK_ACTION = "is.workflow.actions.ask";
const REQUEST_ACTION = "is.workflow.actions.downloadurl";
const DICTIONARY_VALUE_ACTION = "is.workflow.actions.getvalueforkey";
const CONDITIONAL_ACTION = "is.workflow.actions.conditional";
const SHOW_RESULT_ACTION = "is.workflow.actions.showresult";

export const CAPTURE_DEVICE_ENDPOINT = "https://82.156.210.199/api/integrations/shortcut/bookkeeping-capture";
export const CAPTURE_PREVIEW_ENDPOINT = "https://82.156.210.199/api/integrations/shortcut/bookkeeping-capture-preview";
export const CAPTURE_SHORTCUT_NAME = "智能截图记账（三级菜单待确认版V6）";
export const CAPTURE_DEVICE_MARKER = "__SHORTCUT_DEVICE__";
export const CAPTURE_FAILURE_MESSAGE = "截图提交失败：服务器未接受本次请求。请检查网络；未收到小小微信草稿前不要认为已经记账。";
export const CAPTURE_CANCEL_MESSAGE = "已取消，不会上传这笔记账。";

const uuid = (suffix) => `7B73F100-2EA8-4A20-9C73-${BigInt(suffix).toString(16).padStart(12, "0")}`;
const literalToken = (string) => ({ Value: { string }, WFSerializationType: "WFTextTokenString" });
const attachment = (outputUuid, outputName) => ({ Value: { OutputUUID: outputUuid, OutputName: outputName, Type: "ActionOutput" }, WFSerializationType: "WFTextTokenAttachment" });
const interpolatedText = (parts) => {
  let string = "";
  const attachmentsByRange = {};
  for (const part of parts) {
    if (typeof part === "string") string += part;
    else {
      attachmentsByRange[`{${string.length}, 1}`] = { OutputUUID: part.outputUuid, OutputName: part.outputName, Type: "ActionOutput" };
      string += "\uFFFC";
    }
  }
  return { Value: { attachmentsByRange, string }, WFSerializationType: "WFTextTokenString" };
};
const dictionaryField = (entries) => ({ Value: { WFDictionaryFieldValueItems: entries.map(([key, value]) => ({ WFKey: literalToken(key), WFValue: typeof value === "string" ? literalToken(value) : value })) }, WFSerializationType: "WFDictionaryFieldValue" });
const action = (identifier, parameters, id) => ({ WFWorkflowActionIdentifier: identifier, WFWorkflowActionParameters: { UUID: id, ...parameters } });
const controlAction = (identifier, parameters) => ({ WFWorkflowActionIdentifier: identifier, WFWorkflowActionParameters: parameters });

function requireValue(condition, message) { if (!condition) throw new Error(message); }
function literal(value) { return value?.WFSerializationType === "WFTextTokenString" ? value.Value?.string : null; }
function outputUuid(value) {
  if (value?.WFSerializationType === "WFTextTokenAttachment") return value.Value?.OutputUUID ?? null;
  if (value?.WFSerializationType !== "WFTextTokenString") return null;
  const values = Object.values(value.Value?.attachmentsByRange ?? {});
  return values.length === 1 ? values[0]?.OutputUUID ?? null : null;
}
function outputUuids(value) {
  if (value?.WFSerializationType !== "WFTextTokenString") return [];
  return Object.values(value.Value?.attachmentsByRange ?? {}).map((item) => item?.OutputUUID).filter(Boolean);
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
  requireValue(outputUuid(rawText) === actions[2].WFWorkflowActionParameters.UUID, "iCost OCR 原文未绑定 OCR 动作输出");
}

export function convertedActions(sourceActions, previewEndpoint, captureEndpoint, deviceToken) {
  assertLegacyPrefix(sourceActions);
  let nextId = 10;
  const id = () => uuid(nextId++);
  const ocrText = id();
  const previewRequest = id();
  const previewError = id();
  const previewErrorCode = id();
  const previewErrorFields = id();
  const amountCents = id();
  const amountText = id();
  const summaryText = id();
  const capturedAt = id();
  const entryOptions = id();
  const entrySelection = id();
  const expenseOptions = id();
  const expenseSelection = id();
  const incomeOptions = id();
  const incomeSelection = id();
  const category = id();
  const categoryResult = id();
  const mealOptions = id();
  const mealSelection = id();
  const mealVariable = id();
  const transportOptions = id();
  const transportSelection = id();
  const transportVariable = id();
  const maintenanceOptions = id();
  const maintenanceSelection = id();
  const maintenanceVariable = id();
  const travelOptions = id();
  const travelSelection = id();
  const travelVariable = id();
  const noSubcategory = id();
  const subcategory = id();
  const note = id();
  const selectionPath = id();
  const confirmOptions = id();
  const confirmSelection = id();
  const finalRequest = id();
  const finalError = id();
  const finalErrorCode = id();
  const finalErrorFields = id();
  const cancelled = id();
  const previewGuard = uuid(0x2000);
  const entryGuard = uuid(0x2001);
  const categoryBranch = uuid(0x2002);
  const categoryGuard = uuid(0x2003);
  const mealBranch = uuid(0x2004);
  const transportBranch = uuid(0x2005);
  const maintenanceBranch = uuid(0x2006);
  const travelBranch = uuid(0x2007);
  const subcategoryGuard = uuid(0x2008);
  const confirmGuard = uuid(0x2009);
  const finalErrorGuard = uuid(0x200a);
  const categoryVariable = "shortcut_category_v6";
  const subcategoryVariable = "shortcut_subcategory_v6";
  const conditionalInput = (outputUuid, outputName) => ({ Type: "Variable", Variable: attachment(outputUuid, outputName) });
  const icostRawText = structuredClone(sourceActions[3].WFWorkflowActionParameters.rawText);
  const actions = [
    ...structuredClone(sourceActions.slice(0, 3)),
    action(TEXT_ACTION, { CustomOutputName: "OCR纯文本", WFTextActionText: icostRawText }, ocrText),
    action(REQUEST_ACTION, { CustomOutputName: "金额预览响应", WFHTTPMethod: "POST", WFHTTPBodyType: "JSON", WFURL: previewEndpoint, WFHTTPHeaders: dictionaryField([["Content-Type", "application/json"], ["Authorization", `Bearer ${deviceToken}`]]), WFJSONValues: dictionaryField([["text", attachment(ocrText, "OCR纯文本")], ["source", "shortcut"]]) }, previewRequest),
    action(DICTIONARY_VALUE_ACTION, { CustomOutputName: "预览错误", WFDictionaryKey: "error", WFInput: attachment(previewRequest, "金额预览响应") }, previewError),
    action(DICTIONARY_VALUE_ACTION, { CustomOutputName: "预览错误码", WFDictionaryKey: "code", WFInput: attachment(previewError, "预览错误") }, previewErrorCode),
    action(DICTIONARY_VALUE_ACTION, { CustomOutputName: "预览错误字段", WFDictionaryKey: "fields", WFInput: attachment(previewError, "预览错误") }, previewErrorFields),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: previewGuard, WFCondition: 100, WFControlFlowMode: 0, WFInput: conditionalInput(previewError, "预览错误") }),
    controlAction(SHOW_RESULT_ACTION, { Text: interpolatedText(["截图预览失败（", { outputUuid: previewErrorCode, outputName: "预览错误码" }, "），字段：", { outputUuid: previewErrorFields, outputName: "预览错误字段" }, `。${CAPTURE_FAILURE_MESSAGE}`]) }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: previewGuard, WFControlFlowMode: 1 }),
    action(DICTIONARY_VALUE_ACTION, { CustomOutputName: "金额分", WFDictionaryKey: "amount_cents", WFInput: attachment(previewRequest, "金额预览响应") }, amountCents),
    action(DICTIONARY_VALUE_ACTION, { CustomOutputName: "金额", WFDictionaryKey: "amount_text", WFInput: attachment(previewRequest, "金额预览响应") }, amountText),
    action(DICTIONARY_VALUE_ACTION, { CustomOutputName: "金额摘要", WFDictionaryKey: "summary_text", WFInput: attachment(previewRequest, "金额预览响应") }, summaryText),
    action(DICTIONARY_VALUE_ACTION, { CustomOutputName: "截图时间", WFDictionaryKey: "captured_at", WFInput: attachment(previewRequest, "金额预览响应") }, capturedAt),
    action(LIST_ACTION, { CustomOutputName: "第一层收支", WFItems: ["支出", "收入"] }, entryOptions),
    action(CHOOSE_ACTION, { CustomOutputName: "已选收支", WFChooseFromListActionPrompt: "第一层：选择支出或收入", WFInput: attachment(entryOptions, "第一层收支") }, entrySelection),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: entryGuard, WFCondition: 100, WFControlFlowMode: 0, WFInput: conditionalInput(entrySelection, "已选收支") }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: categoryBranch, WFCondition: 4, WFConditionalActionString: "支出", WFControlFlowMode: 0, WFInput: conditionalInput(entrySelection, "已选收支") }),
    action(LIST_ACTION, { CustomOutputName: "支出类别", WFItems: ["餐饮", "住宿费", "交通", "汽车维保", "招待/礼品"] }, expenseOptions),
    action(CHOOSE_ACTION, { CustomOutputName: "已选支出类别", WFChooseFromListActionPrompt: "第二层：选择支出类别", WFInput: attachment(expenseOptions, "支出类别") }, expenseSelection),
    action("is.workflow.actions.setvariable", { CustomOutputName: "记录支出类别", WFVariableName: categoryVariable, WFInput: attachment(expenseSelection, "已选支出类别") }, category),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: categoryBranch, WFControlFlowMode: 1 }),
    action(LIST_ACTION, { CustomOutputName: "收入类别", WFItems: ["工资", "奖金", "出差"] }, incomeOptions),
    action(CHOOSE_ACTION, { CustomOutputName: "已选收入类别", WFChooseFromListActionPrompt: "第二层：选择收入类别", WFInput: attachment(incomeOptions, "收入类别") }, incomeSelection),
    action("is.workflow.actions.setvariable", { CustomOutputName: "记录收入类别", WFVariableName: categoryVariable, WFInput: attachment(incomeSelection, "已选收入类别") }, id()),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: categoryBranch, WFControlFlowMode: 2 }),
    action("is.workflow.actions.getvariable", { CustomOutputName: "最终类别", WFVariableName: categoryVariable }, categoryResult),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: categoryGuard, WFCondition: 100, WFControlFlowMode: 0, WFInput: conditionalInput(categoryResult, "最终类别") }),
    ...subcategoryBranch({ group: mealBranch, categoryName: "餐饮", options: ["早餐", "午餐", "晚餐"], listName: "餐饮子类", chooseName: "已选餐饮子类", listId: mealOptions, chooseId: mealSelection, variable: subcategoryVariable, setId: mealVariable, categoryOutput: categoryResult }),
    ...subcategoryBranch({ group: transportBranch, categoryName: "交通", options: ["火车", "路桥费", "打车", "代驾", "停车"], listName: "交通子类", chooseName: "已选交通子类", listId: transportOptions, chooseId: transportSelection, variable: subcategoryVariable, setId: transportVariable, categoryOutput: categoryResult }),
    ...subcategoryBranch({ group: maintenanceBranch, categoryName: "汽车维保", options: ["维修", "保养"], listName: "汽车维保子类", chooseName: "已选汽车维保子类", listId: maintenanceOptions, chooseId: maintenanceSelection, variable: subcategoryVariable, setId: maintenanceVariable, categoryOutput: categoryResult }),
    ...subcategoryBranch({ group: travelBranch, categoryName: "出差", options: ["报销", "借款"], listName: "出差子类", chooseName: "已选出差子类", listId: travelOptions, chooseId: travelSelection, variable: subcategoryVariable, setId: travelVariable, categoryOutput: categoryResult }),
    action(TEXT_ACTION, { CustomOutputName: "无子类", WFTextActionText: literalToken("无") }, noSubcategory),
    action("is.workflow.actions.setvariable", { CustomOutputName: "记录无子类", WFVariableName: subcategoryVariable, WFInput: attachment(noSubcategory, "无子类") }, id()),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: travelBranch, WFControlFlowMode: 2 }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: maintenanceBranch, WFControlFlowMode: 2 }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: transportBranch, WFControlFlowMode: 2 }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: mealBranch, WFControlFlowMode: 2 }),
    action("is.workflow.actions.getvariable", { CustomOutputName: "最终子类", WFVariableName: subcategoryVariable }, subcategory),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: subcategoryGuard, WFCondition: 100, WFControlFlowMode: 0, WFInput: conditionalInput(subcategory, "最终子类") }),
    action(ASK_ACTION, { CustomOutputName: "备注（可选）", WFAskActionPrompt: "最后一步：备注（可选，点完成可跳过）", WFInputType: 0 }, note),
    action(TEXT_ACTION, { CustomOutputName: "三级选择路径", WFTextActionText: interpolatedText([{ outputUuid: entrySelection, outputName: "已选收支" }, " · ", { outputUuid: categoryResult, outputName: "最终类别" }, " · ", { outputUuid: subcategory, outputName: "最终子类" }]) }, selectionPath),
    action(LIST_ACTION, { CustomOutputName: "最后确认选项", WFItems: ["✅ 确定记录", "❌ 取消记录"] }, confirmOptions),
    action(CHOOSE_ACTION, { CustomOutputName: "本机最终确认", WFChooseFromListActionPrompt: interpolatedText(["请确认信息（可点取消）\n类型：", { outputUuid: entrySelection, outputName: "已选收支" }, "\n金额：", { outputUuid: amountText, outputName: "金额" }, " 元\n分类：", { outputUuid: categoryResult, outputName: "最终类别" }, " / ", { outputUuid: subcategory, outputName: "最终子类" }, "\n备注：", { outputUuid: note, outputName: "备注（可选）" }, "\n时间：", { outputUuid: capturedAt, outputName: "截图时间" }]), WFInput: attachment(confirmOptions, "最后确认选项") }, confirmSelection),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: confirmGuard, WFCondition: 4, WFConditionalActionString: "✅ 确定记录", WFControlFlowMode: 0, WFInput: conditionalInput(confirmSelection, "本机最终确认") }),
    action(REQUEST_ACTION, { CustomOutputName: "已提交小小待确认", WFHTTPMethod: "POST", WFHTTPBodyType: "JSON", WFURL: captureEndpoint, WFHTTPHeaders: dictionaryField([["Content-Type", "application/json"], ["Authorization", `Bearer ${deviceToken}`]]), WFJSONValues: dictionaryField([["text", attachment(summaryText, "金额摘要")], ["selection_path", attachment(selectionPath, "三级选择路径")], ["amount_cents", attachment(amountCents, "金额分")], ["note", attachment(note, "备注（可选）")], ["captured_at", attachment(capturedAt, "截图时间")], ["source", "shortcut"]]) }, finalRequest),
    action(DICTIONARY_VALUE_ACTION, { CustomOutputName: "最终提交错误", WFDictionaryKey: "error", WFInput: attachment(finalRequest, "已提交小小待确认") }, finalError),
    action(DICTIONARY_VALUE_ACTION, { CustomOutputName: "最终提交错误码", WFDictionaryKey: "code", WFInput: attachment(finalError, "最终提交错误") }, finalErrorCode),
    action(DICTIONARY_VALUE_ACTION, { CustomOutputName: "最终提交错误字段", WFDictionaryKey: "fields", WFInput: attachment(finalError, "最终提交错误") }, finalErrorFields),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: finalErrorGuard, WFCondition: 100, WFControlFlowMode: 0, WFInput: conditionalInput(finalError, "最终提交错误") }),
    controlAction(SHOW_RESULT_ACTION, { Text: interpolatedText(["截图提交失败（", { outputUuid: finalErrorCode, outputName: "最终提交错误码" }, "），字段：", { outputUuid: finalErrorFields, outputName: "最终提交错误字段" }, `。${CAPTURE_FAILURE_MESSAGE}`]) }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: finalErrorGuard, WFControlFlowMode: 2 }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: confirmGuard, WFControlFlowMode: 1 }),
    controlAction(SHOW_RESULT_ACTION, { Text: literalToken(CAPTURE_CANCEL_MESSAGE) }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: confirmGuard, WFControlFlowMode: 2 }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: subcategoryGuard, WFControlFlowMode: 1 }),
    controlAction(SHOW_RESULT_ACTION, { Text: literalToken("已取消三级分类，不会上传。") }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: subcategoryGuard, WFControlFlowMode: 2 }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: categoryGuard, WFControlFlowMode: 1 }),
    controlAction(SHOW_RESULT_ACTION, { Text: literalToken("已取消类别选择，不会上传。") }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: categoryGuard, WFControlFlowMode: 2 }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: entryGuard, WFControlFlowMode: 1 }),
    controlAction(SHOW_RESULT_ACTION, { Text: literalToken("已取消收支选择，不会上传。") }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: entryGuard, WFControlFlowMode: 2 }),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: previewGuard, WFControlFlowMode: 2 }),
  ];
  return actions;
}

function subcategoryBranch({ group, categoryName, options, listName, chooseName, listId, chooseId, variable, setId, categoryOutput }) {
  return [
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: group, WFCondition: 4, WFConditionalActionString: categoryName, WFControlFlowMode: 0, WFInput: { Type: "Variable", Variable: attachment(categoryOutput, "最终类别") } }),
    action(LIST_ACTION, { CustomOutputName: listName, WFItems: options }, listId),
    action(CHOOSE_ACTION, { CustomOutputName: chooseName, WFChooseFromListActionPrompt: `第三层：选择${categoryName}子类`, WFInput: attachment(listId, listName) }, chooseId),
    action("is.workflow.actions.setvariable", { CustomOutputName: `记录${categoryName}子类`, WFVariableName: variable, WFInput: attachment(chooseId, chooseName) }, setId),
    controlAction(CONDITIONAL_ACTION, { GroupingIdentifier: group, WFControlFlowMode: 1 }),
  ];
}

export function inspectConvertedIcostCaptureShortcutXml(xml) {
  const plist = parsePlistXml(xml);
  const actions = plist.WFWorkflowActions;
  requireValue(Array.isArray(actions) && actions.length > 0, "快捷指令动作缺失");
  requireValue(actions.slice(0, 3).map((entry) => entry.WFWorkflowActionIdentifier).join("|") === [SCREENSHOT_ACTION, CROP_ACTION, OCR_ACTION].join("|"), "截屏、裁剪、OCR 前缀未保留");
  requireValue(!actions.some((entry) => entry.WFWorkflowActionIdentifier === ICOST_ACTION), "转换后不得保留 iCost 写入动作");
  requireValue(!xml.includes("森特账号") && !xml.includes("森特密码") && !xml.includes("bookkeeping-capture-inline"), "快捷指令不得包含账号密码验证");
  const requests = actions.filter((entry) => entry.WFWorkflowActionIdentifier === REQUEST_ACTION);
  requireValue(requests.length === 2, "必须分别包含金额预览和最终提交两个请求");
  const preview = requests.find((entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "金额预览响应");
  const final = requests.find((entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "已提交小小待确认");
  requireValue(preview && final, "预览或最终提交请求缺失");
  requireValue(preview.WFWorkflowActionParameters.WFURL === CAPTURE_PREVIEW_ENDPOINT, "金额预览接口地址不正确");
  requireValue(final.WFWorkflowActionParameters.WFURL === CAPTURE_DEVICE_ENDPOINT, "最终提交接口地址不正确");
  for (const request of requests) {
    const parameters = request.WFWorkflowActionParameters;
    requireValue(parameters.WFHTTPMethod === "POST" && parameters.WFHTTPBodyType === "JSON", "请求必须使用 JSON POST");
    const headers = dictionaryMap(parameters.WFHTTPHeaders);
    requireValue(literal(headers.get("Content-Type")) === "application/json", "请求 Content-Type 不正确");
    requireValue(/^Bearer (?:__SHORTCUT_DEVICE__|[A-Za-z0-9_-]{43})$/u.test(literal(headers.get("Authorization")) ?? ""), "设备身份不正确");
  }
  const previewBody = dictionaryMap(preview.WFWorkflowActionParameters.WFJSONValues);
  requireValue(JSON.stringify([...previewBody.keys()]) === JSON.stringify(["text", "source"]), "预览请求字段不正确");
  const finalBody = dictionaryMap(final.WFWorkflowActionParameters.WFJSONValues);
  requireValue(JSON.stringify([...finalBody.keys()]) === JSON.stringify(["text", "selection_path", "amount_cents", "note", "captured_at", "source"]), "最终请求字段不正确");
  const lists = new Map(actions.filter((entry) => entry.WFWorkflowActionIdentifier === LIST_ACTION).map((entry) => [entry.WFWorkflowActionParameters.CustomOutputName, entry]));
  const expectedLists = {
    "第一层收支": ["支出", "收入"], "支出类别": ["餐饮", "住宿费", "交通", "汽车维保", "招待/礼品"], "收入类别": ["工资", "奖金", "出差"],
    "餐饮子类": ["早餐", "午餐", "晚餐"], "交通子类": ["火车", "路桥费", "打车", "代驾", "停车"], "汽车维保子类": ["维修", "保养"], "出差子类": ["报销", "借款"], "最后确认选项": ["✅ 确定记录", "❌ 取消记录"],
  };
  for (const [name, values] of Object.entries(expectedLists)) requireValue(JSON.stringify(lists.get(name)?.WFWorkflowActionParameters.WFItems) === JSON.stringify(values), `${name}列表不正确`);
  requireValue(actions.filter((entry) => entry.WFWorkflowActionIdentifier === CHOOSE_ACTION).length === 8, "必须包含三层菜单和最后确认选择");
  const finalChoose = actions.find((entry) => entry.WFWorkflowActionParameters?.CustomOutputName === "本机最终确认");
  requireValue(finalChoose && outputUuids(finalChoose.WFWorkflowActionParameters.WFChooseFromListActionPrompt).length >= 5, "最终确认卡必须显示金额、分类、备注和时间");
  requireValue(actions.some((entry) => entry.WFWorkflowActionIdentifier === ASK_ACTION && entry.WFWorkflowActionParameters?.WFAskActionPrompt === "最后一步：备注（可选，点完成可跳过）"), "备注输入必须是最后确认前的可选步骤");
  requireValue(outputUuid(finalBody.get("text")) && outputUuid(finalBody.get("text")) !== outputUuid(previewBody.get("text")), "最终提交不得再次上传整段 OCR 原文");
  return { actionCount: actions.length, endpoint: final.WFWorkflowActionParameters.WFURL, previewEndpoint: preview.WFWorkflowActionParameters.WFURL, preservesCapturePrefix: true, preservesIcostOcrText: true, coercesOcrThroughTextAction: true, usesServerDerivedIdempotency: true, removesIcostWrite: true, hasInlineCredentials: false, hasDeviceCredential: true, hasFailureNotice: true, hasThreeLevelMenus: true, hasOptionalNote: true, hasLocalFinalConfirmation: true, finalSubmissionUsesSummaryOnly: true, hasSuccessReceipt: false, payloadKeys: [...finalBody.keys()] };
}

export async function convertIcostCaptureShortcut({ inputPath, outputPath, endpoint = CAPTURE_DEVICE_ENDPOINT, deviceToken = CAPTURE_DEVICE_MARKER } = {}) {
  if (!inputPath || !outputPath) throw new Error("inputPath and outputPath are required");
  if (new URL(endpoint).href !== new URL(CAPTURE_DEVICE_ENDPOINT).href) throw new Error("Only the canonical production capture endpoint is allowed");
  if (deviceToken !== CAPTURE_DEVICE_MARKER && !/^[A-Za-z0-9_-]{43}$/u.test(deviceToken)) throw new Error("deviceToken must be an account-bound Shortcut device credential");
  const plist = parsePlistXml(await readFile(inputPath, "utf8"));
  plist.WFWorkflowActions = convertedActions(plist.WFWorkflowActions, CAPTURE_PREVIEW_ENDPOINT, endpoint, deviceToken);
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
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
