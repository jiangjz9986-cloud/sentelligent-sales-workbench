import { chmod, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serializePlistXml } from "../icost-shortcut/plist-xml.mjs";
import {
  BOOKKEEPING_CATALOG,
  BOOKKEEPING_CATEGORY_OPTIONS,
  BOOKKEEPING_ENTRY_TYPE_OPTIONS,
  BOOKKEEPING_SUBCATEGORY_OPTIONS,
} from "./build-bookkeeping-shortcut.mjs";
import { inspectBookkeepingInlineShortcutXml } from "./verify-bookkeeping-inline-shortcut.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultOutputPath = resolve(scriptDirectory, "shortcut-bookkeeping-inline.unsigned.shortcut");

export const INLINE_BOOKKEEPING_ENDPOINT =
  "https://82.156.210.199/api/integrations/shortcut/bookkeeping-inline";
export const INLINE_BOOKKEEPING_SHORTCUT_NAME = "自有截图记账（三级菜单微信确认版V9）";
export const INLINE_ACCOUNT_OUTPUT_NAME = "森特账号常量（请编辑）";
export const INLINE_PASSWORD_OUTPUT_NAME = "森特密码常量（请编辑）";
export const INLINE_ACCOUNT_PLACEHOLDER = "请在此填写森特账号";
export const INLINE_PASSWORD_PLACEHOLDER = "请在此填写森特密码";
export const INLINE_FAILURE_MESSAGE =
  "记账提交失败：服务器未接受本次请求。请检查账号密码、网络或稍后重试；未收到小小确认前不要认为已记账。";

const STANDARD_INPUT_CONTENT_CLASSES = Object.freeze([
  "WFAppContentItem",
  "WFAppStoreAppContentItem",
  "WFArticleContentItem",
  "WFContactContentItem",
  "WFDateContentItem",
  "WFEmailAddressContentItem",
  "WFFolderContentItem",
  "WFGenericFileContentItem",
  "WFImageContentItem",
  "WFiTunesProductContentItem",
  "WFLocationContentItem",
  "WFDCMapsLinkContentItem",
  "WFAVAssetContentItem",
  "WFPDFContentItem",
  "WFPhoneNumberContentItem",
  "WFRichTextContentItem",
  "WFSafariWebPageContentItem",
  "WFStringContentItem",
  "WFURLContentItem",
]);

const uuid = (suffix) => {
  const tail = BigInt(suffix).toString(16).padStart(12, "0");
  return `4A82B300-1F2D-4F07-9C73-${tail}`;
};

function createIdAllocator() {
  let actionId = 1;
  let groupingId = 0x2000;
  return {
    action: () => uuid(actionId++),
    grouping: () => uuid(groupingId++),
  };
}

const action = (identifier, parameters, id) => ({
  WFWorkflowActionIdentifier: identifier,
  WFWorkflowActionParameters: { UUID: id, ...parameters },
});

const controlAction = (identifier, parameters) => ({
  WFWorkflowActionIdentifier: identifier,
  WFWorkflowActionParameters: parameters,
});

const attachment = (outputUuid, outputName = "快捷指令输出") => ({
  Value: { OutputUUID: outputUuid, OutputName: outputName, Type: "ActionOutput" },
  WFSerializationType: "WFTextTokenAttachment",
});

const propertyAttachment = (outputUuid, outputName, propertyName) => ({
  Value: {
    OutputUUID: outputUuid,
    OutputName: outputName,
    Type: "ActionOutput",
    Aggrandizements: [{ PropertyName: propertyName, Type: "WFPropertyVariableAggrandizement" }],
  },
  WFSerializationType: "WFTextTokenAttachment",
});

const literalToken = (string) => ({
  Value: { string },
  WFSerializationType: "WFTextTokenString",
});

function textWithAttachments(attachments, separator = "|") {
  const ranges = {};
  let offset = 0;
  const tokens = attachments.map((value) => {
    ranges[`{${offset}, 1}`] = value;
    offset += 1 + separator.length;
    return "￼";
  });
  return {
    Value: { string: tokens.join(separator), attachmentsByRange: ranges },
    WFSerializationType: "WFTextTokenString",
  };
}

function dictionaryField(entries) {
  return {
    Value: {
      WFDictionaryFieldValueItems: entries.map(([key, value]) => ({
        WFKey: literalToken(key),
        WFValue: typeof value === "string" ? literalToken(value) : value,
      })),
    },
    WFSerializationType: "WFDictionaryFieldValue",
  };
}

function conditionalInput(outputUuid, outputName) {
  return { Type: "Variable", Variable: attachment(outputUuid, outputName) };
}

function setVariableParameters(variableName, input) {
  return {
    CustomOutputName: variableName,
    WFVariableName: variableName,
    WFInput: input,
  };
}

function getVariableParameters(variableName, outputName = variableName) {
  return {
    CustomOutputName: outputName,
    WFVariableName: variableName,
  };
}

function buildPlist({ endpoint = INLINE_BOOKKEEPING_ENDPOINT } = {}) {
  const allocator = createIdAllocator();
  const account = allocator.action();
  const password = allocator.action();
  const screenshot = allocator.action();
  const crop = allocator.action();
  const ocr = allocator.action();
  const entryOptions = allocator.action();
  const entrySelection = allocator.action();
  const expenseCategoryOptions = allocator.action();
  const expenseCategorySelection = allocator.action();
  const expenseCategoryVariable = allocator.action();
  const incomeCategoryOptions = allocator.action();
  const incomeCategorySelection = allocator.action();
  const incomeCategoryVariable = allocator.action();
  const categoryResult = allocator.action();
  const mealOptions = allocator.action();
  const mealSelection = allocator.action();
  const mealVariable = allocator.action();
  const transportOptions = allocator.action();
  const transportSelection = allocator.action();
  const transportVariable = allocator.action();
  const travelOptions = allocator.action();
  const travelSelection = allocator.action();
  const travelVariable = allocator.action();
  const noSubcategory = allocator.action();
  const subcategoryResult = allocator.action();
  const selectedSubcategory = allocator.action();
  const selectedCategory = allocator.action();
  const selectedSubcategoryVariable = "shortcut_subcategory";
  const selectedCategoryVariable = "shortcut_category";
  const note = allocator.action();
  const currentDate = allocator.action();
  const timeId = allocator.action();
  const selectionPath = allocator.action();
  const request = allocator.action();
  const responseError = allocator.action();
  const cancelledSubcategory = allocator.action();
  const cancelledCategory = allocator.action();
  const cancelledEntry = allocator.action();

  const entryGuard = allocator.grouping();
  const categoryBranch = allocator.grouping();
  const categoryGuard = allocator.grouping();
  const mealBranch = allocator.grouping();
  const transportBranch = allocator.grouping();
  const travelBranch = allocator.grouping();
  const subcategoryGuard = allocator.grouping();
  const responseErrorGuard = allocator.grouping();

  const actions = [
    action("is.workflow.actions.gettext", {
      CustomOutputName: INLINE_ACCOUNT_OUTPUT_NAME,
      WFTextActionText: literalToken(INLINE_ACCOUNT_PLACEHOLDER),
    }, account),
    action("is.workflow.actions.gettext", {
      CustomOutputName: INLINE_PASSWORD_OUTPUT_NAME,
      WFTextActionText: literalToken(INLINE_PASSWORD_PLACEHOLDER),
    }, password),
    action("is.workflow.actions.takescreenshot", {}, screenshot),
    action("is.workflow.actions.image.crop", {
      WFInput: attachment(screenshot, "截屏"),
      WFImageCropPosition: "Custom",
      WFImageCropY: "120",
      WFImageCropWidth: propertyAttachment(screenshot, "截屏", "Width"),
      WFImageCropHeight: propertyAttachment(screenshot, "截屏", "Height"),
    }, crop),
    action("is.workflow.actions.extracttextfromimage", {
      WFImage: attachment(crop, "裁剪后的图像"),
    }, ocr),
    action("is.workflow.actions.list", {
      CustomOutputName: "记账第一层（收支）",
      WFItems: [...BOOKKEEPING_ENTRY_TYPE_OPTIONS],
    }, entryOptions),
    action("is.workflow.actions.choosefromlist", {
      CustomOutputName: "本次收支类型",
      WFChooseFromListActionPrompt: "第一层：选择收支类型",
      WFInput: attachment(entryOptions, "记账第一层（收支）"),
    }, entrySelection),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: entryGuard,
      WFCondition: 100,
      WFControlFlowMode: 0,
      WFInput: conditionalInput(entrySelection, "本次收支类型"),
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: categoryBranch,
      WFCondition: 4,
      WFConditionalActionString: "支出",
      WFControlFlowMode: 0,
      WFInput: conditionalInput(entrySelection, "本次收支类型"),
    }),
    action("is.workflow.actions.list", {
      CustomOutputName: "支出类别",
      WFItems: [...BOOKKEEPING_CATEGORY_OPTIONS.支出],
    }, expenseCategoryOptions),
    action("is.workflow.actions.choosefromlist", {
      CustomOutputName: "本次支出类别",
      WFChooseFromListActionPrompt: "第二层：选择支出类别",
      WFInput: attachment(expenseCategoryOptions, "支出类别"),
    }, expenseCategorySelection),
    action("is.workflow.actions.setvariable", setVariableParameters(
      selectedCategoryVariable,
      attachment(expenseCategorySelection, "本次支出类别"),
    ), expenseCategoryVariable),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: categoryBranch,
      WFControlFlowMode: 1,
    }),
    action("is.workflow.actions.list", {
      CustomOutputName: "收入类别",
      WFItems: [...BOOKKEEPING_CATEGORY_OPTIONS.收入],
    }, incomeCategoryOptions),
    action("is.workflow.actions.choosefromlist", {
      CustomOutputName: "本次收入类别",
      WFChooseFromListActionPrompt: "第二层：选择收入类别",
      WFInput: attachment(incomeCategoryOptions, "收入类别"),
    }, incomeCategorySelection),
    action("is.workflow.actions.setvariable", setVariableParameters(
      selectedCategoryVariable,
      attachment(incomeCategorySelection, "本次收入类别"),
    ), incomeCategoryVariable),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: categoryBranch,
      WFControlFlowMode: 2,
    }),
    action("is.workflow.actions.getvariable", getVariableParameters(selectedCategoryVariable, "本次费用类别"), categoryResult),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: categoryGuard,
      WFCondition: 100,
      WFControlFlowMode: 0,
      WFInput: conditionalInput(categoryResult, "本次费用类别"),
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: mealBranch,
      WFCondition: 4,
      WFConditionalActionString: "餐饮",
      WFControlFlowMode: 0,
      WFInput: conditionalInput(categoryResult, "本次费用类别"),
    }),
    action("is.workflow.actions.list", {
      CustomOutputName: "餐饮子类别",
      WFItems: [...BOOKKEEPING_SUBCATEGORY_OPTIONS.餐饮],
    }, mealOptions),
    action("is.workflow.actions.choosefromlist", {
      CustomOutputName: "本次餐饮子类别",
      WFChooseFromListActionPrompt: "第三层：选择餐饮类别",
      WFInput: attachment(mealOptions, "餐饮子类别"),
    }, mealSelection),
    action("is.workflow.actions.setvariable", setVariableParameters(
      selectedSubcategoryVariable,
      attachment(mealSelection, "本次餐饮子类别"),
    ), mealVariable),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: mealBranch,
      WFControlFlowMode: 1,
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: transportBranch,
      WFCondition: 4,
      WFConditionalActionString: "交通",
      WFControlFlowMode: 0,
      WFInput: conditionalInput(categoryResult, "本次费用类别"),
    }),
    action("is.workflow.actions.list", {
      CustomOutputName: "交通子类别",
      WFItems: [...BOOKKEEPING_SUBCATEGORY_OPTIONS.交通],
    }, transportOptions),
    action("is.workflow.actions.choosefromlist", {
      CustomOutputName: "本次交通子类别",
      WFChooseFromListActionPrompt: "第三层：选择交通类别",
      WFInput: attachment(transportOptions, "交通子类别"),
    }, transportSelection),
    action("is.workflow.actions.setvariable", setVariableParameters(
      selectedSubcategoryVariable,
      attachment(transportSelection, "本次交通子类别"),
    ), transportVariable),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: transportBranch,
      WFControlFlowMode: 1,
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: travelBranch,
      WFCondition: 4,
      WFConditionalActionString: "出差",
      WFControlFlowMode: 0,
      WFInput: conditionalInput(categoryResult, "本次费用类别"),
    }),
    action("is.workflow.actions.list", {
      CustomOutputName: "出差收入子类别",
      WFItems: [...BOOKKEEPING_SUBCATEGORY_OPTIONS.出差],
    }, travelOptions),
    action("is.workflow.actions.choosefromlist", {
      CustomOutputName: "本次出差收入子类别",
      WFChooseFromListActionPrompt: "第三层：选择出差收入类别",
      WFInput: attachment(travelOptions, "出差收入子类别"),
    }, travelSelection),
    action("is.workflow.actions.setvariable", setVariableParameters(
      selectedSubcategoryVariable,
      attachment(travelSelection, "本次出差收入子类别"),
    ), travelVariable),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: travelBranch,
      WFControlFlowMode: 1,
    }),
    action("is.workflow.actions.gettext", {
      CustomOutputName: "无子类别",
      WFTextActionText: literalToken("无"),
    }, noSubcategory),
    action("is.workflow.actions.setvariable", setVariableParameters(
      selectedSubcategoryVariable,
      attachment(noSubcategory, "无子类别"),
    ), selectedSubcategory),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: travelBranch,
      WFControlFlowMode: 2,
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: transportBranch,
      WFControlFlowMode: 2,
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: mealBranch,
      WFControlFlowMode: 2,
    }),
    action("is.workflow.actions.getvariable", getVariableParameters(selectedSubcategoryVariable, "本次费用子类别"), subcategoryResult),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: subcategoryGuard,
      WFCondition: 100,
      WFControlFlowMode: 0,
      WFInput: conditionalInput(subcategoryResult, "本次费用子类别"),
    }),
    action("is.workflow.actions.ask", {
      CustomOutputName: "备注",
      WFAskActionPrompt: "备注（可选，直接点完成跳过）",
      WFInputType: 0,
    }, note),
    action("is.workflow.actions.date", {
      CustomOutputName: "本次记账时间",
      WFDateActionMode: "Current Date",
    }, currentDate),
    action("is.workflow.actions.format.date", {
      CustomOutputName: "时间记账ID",
      WFDate: attachment(currentDate, "本次记账时间"),
      WFDateFormatStyle: "Custom",
      WFDateFormat: "yyyyMMddHHmmss",
      WFTimeFormatStyle: "None",
    }, timeId),
    action("is.workflow.actions.gettext", {
      CustomOutputName: "三级记账路径",
      WFTextActionText: textWithAttachments([
        { OutputUUID: entrySelection, OutputName: "本次收支类型", Type: "ActionOutput" },
        { OutputUUID: categoryResult, OutputName: "本次费用类别", Type: "ActionOutput" },
        { OutputUUID: subcategoryResult, OutputName: "本次费用子类别", Type: "ActionOutput" },
      ], " · "),
    }, selectionPath),
    action("is.workflow.actions.downloadurl", {
      CustomOutputName: "已提交微信确认",
      WFHTTPMethod: "POST",
      WFHTTPBodyType: "JSON",
      WFURL: endpoint,
      WFHTTPHeaders: dictionaryField([
        ["Content-Type", "application/json"],
      ]),
      WFJSONValues: dictionaryField([
        ["account", attachment(account, INLINE_ACCOUNT_OUTPUT_NAME)],
        ["password", attachment(password, INLINE_PASSWORD_OUTPUT_NAME)],
        ["text", attachment(ocr, "图像中的文本")],
        ["selection_path", attachment(selectionPath, "三级记账路径")],
        ["note", attachment(note, "备注")],
        ["idempotency_key", attachment(timeId, "时间记账ID")],
        ["source_id", attachment(timeId, "时间记账ID")],
        ["source", "shortcut"],
      ]),
    }, request),
    action("is.workflow.actions.getvalueforkey", {
      CustomOutputName: "记账提交错误",
      WFDictionaryKey: "error",
      WFInput: attachment(request, "已提交微信确认"),
    }, responseError),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: responseErrorGuard,
      WFCondition: 100,
      WFControlFlowMode: 0,
      WFInput: conditionalInput(responseError, "记账提交错误"),
    }),
    controlAction("is.workflow.actions.showresult", {
      Text: literalToken(INLINE_FAILURE_MESSAGE),
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: responseErrorGuard,
      WFControlFlowMode: 2,
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: subcategoryGuard,
      WFControlFlowMode: 1,
    }),
    action("is.workflow.actions.gettext", {
      CustomOutputName: "已取消三级分类",
      WFTextActionText: literalToken("已取消，不上传"),
    }, cancelledSubcategory),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: subcategoryGuard,
      WFControlFlowMode: 2,
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: categoryGuard,
      WFControlFlowMode: 1,
    }),
    action("is.workflow.actions.gettext", {
      CustomOutputName: "已取消费用类别",
      WFTextActionText: literalToken("已取消，不上传"),
    }, cancelledCategory),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: categoryGuard,
      WFControlFlowMode: 2,
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: entryGuard,
      WFControlFlowMode: 1,
    }),
    action("is.workflow.actions.gettext", {
      CustomOutputName: "已取消收支类型",
      WFTextActionText: literalToken("已取消，不上传"),
    }, cancelledEntry),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: entryGuard,
      WFControlFlowMode: 2,
    }),
  ];

  return {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: "4711",
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowIcon: { WFWorkflowIconStartColor: -20702977, WFWorkflowIconGlyphNumber: 61523 },
    WFWorkflowInputContentItemClasses: [...STANDARD_INPUT_CONTENT_CLASSES],
    WFWorkflowMinimumClientVersion: 1106,
    WFWorkflowMinimumClientVersionString: "1106",
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: ["Watch", "WFWorkflowTypeShowInSearch"],
  };
}

export async function buildBookkeepingInlineShortcut({
  endpoint = INLINE_BOOKKEEPING_ENDPOINT,
  outputPath = defaultOutputPath,
} = {}) {
  const xml = serializePlistXml(buildPlist({ endpoint }));
  const report = inspectBookkeepingInlineShortcutXml(xml);
  await writeFile(outputPath, xml, { encoding: "utf8", mode: 0o600 });
  await chmod(outputPath, 0o600);
  return { outputPath, report };
}

function parseCliArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(endpoint|output)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    if (match[1] === "output") values.outputPath = resolve(match[2]);
    else values.endpoint = match[2];
  }
  return values;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  buildBookkeepingInlineShortcut(parseCliArguments(process.argv.slice(2)))
    .then(({ outputPath, report }) => process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
