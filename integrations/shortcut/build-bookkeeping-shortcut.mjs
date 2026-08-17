import { chmod, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serializePlistXml } from "../icost-shortcut/plist-xml.mjs";
import { inspectBookkeepingShortcutXml } from "./verify-bookkeeping-shortcut.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultOutputPath = resolve(scriptDirectory, "shortcut-bookkeeping.unsigned.shortcut");
const DEFAULT_ENDPOINT = "https://82.156.210.199/api/integrations/shortcut/bookkeeping";
const DEFAULT_VERIFY_ENDPOINT = "https://82.156.210.199/api/integrations/shortcut/verify";
export const SHORTCUT_TOKEN_PLACEHOLDER = "REPLACE_ME";
export const BOOKKEEPING_SHORTCUT_NAME = "自有截图记账（兼容版V4修复）";
export const BOOKKEEPING_SHORTCUT_NAME_PREFIX = "自有截图记账";
export const SHORTCUT_SELECTION_SEPARATOR = " · ";
// A generated output name is required here.  Without it, Shortcuts imports
// the action but cannot resolve the output token used by the following
// conditional action, leaving the condition in an invalid red state.
export const VERIFICATION_STATUS_OUTPUT_NAME = "Token验证状态";

export const BOOKKEEPING_CATALOG = Object.freeze({
  "出差报销": {
    收入: {},
    支出: {
      餐饮: ["早餐", "午餐", "晚餐"],
      住宿费: [],
      交通: ["火车", "路桥费", "打车", "代驾", "停车"],
      汽车维修: ["维修", "保养"],
      "招待/礼品": [],
    },
  },
  biubiu: {
    收入: { 营收: ["美团", "淘宝闪购", "京东", "收钱吧", "其他"], 退税: [], 其他收入: [] },
    支出: { 房租: [], 设备: [], 水电费: [], 进货采购: ["水果", "耗材"], 员工薪资: [], 交税: [], 运营: [] },
  },
});

export const BOOKKEEPING_SELECTION_OPTIONS = Object.freeze(
  Object.entries(BOOKKEEPING_CATALOG).flatMap(([ledgerName, entryTypes]) => (
    Object.entries(entryTypes).flatMap(([entryType, categories]) => (
      Object.entries(categories).flatMap(([category, subcategories]) => (
        (subcategories.length ? subcategories : ["无"]).map((subcategory) => (
          [ledgerName, entryType, category, subcategory].join(SHORTCUT_SELECTION_SEPARATOR)
        ))
      ))
    ))
  )),
);

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
  return `5F7B4C00-4F8B-4F2A-9C73-${tail}`;
};

function createIdAllocator() {
  let actionId = 1;
  let groupingId = 0x1000;
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
  const tokens = attachments.map((attachmentValue) => {
    ranges[`{${offset}, 1}`] = attachmentValue;
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

function actionOutputText(outputUuid, outputName) {
  return textWithAttachments([{ OutputUUID: outputUuid, OutputName: outputName, Type: "ActionOutput" }], "");
}

function conditionalInput(outputUuid, outputName) {
  return {
    Type: "Variable",
    Variable: attachment(outputUuid, outputName),
  };
}

function buildPlist({ endpoint = DEFAULT_ENDPOINT, verifyEndpoint = DEFAULT_VERIFY_ENDPOINT } = {}) {
  const allocator = createIdAllocator();
  const token = allocator.action();
  const verification = allocator.action();
  const verificationStatus = allocator.action();
  const verificationGroup = allocator.grouping();
  const screenshot = allocator.action();
  const crop = allocator.action();
  const ocr = allocator.action();
  const options = allocator.action();
  const selection = allocator.action();
      const selectionGroup = allocator.grouping();
  const note = allocator.action();
      const idText = allocator.action();
  const hash = allocator.action();
  const request = allocator.action();

  const actions = [
    action("is.workflow.actions.gettext", {
      CustomOutputName: "系统配置页生成的快捷指令 Token",
      WFTextActionText: SHORTCUT_TOKEN_PLACEHOLDER,
    }, token),
    action("is.workflow.actions.downloadurl", {
      CustomOutputName: "Token验证响应",
      WFHTTPMethod: "GET",
      WFURL: verifyEndpoint,
      WFHTTPHeaders: dictionaryField([
        ["Authorization", {
          Value: { string: "Bearer ￼", attachmentsByRange: { "{7, 1}": { OutputUUID: token, Type: "ActionOutput" } } },
          WFSerializationType: "WFTextTokenString",
        }],
        ["X-Shortcut-Verification-Mode", "explain"],
      ]),
    }, verification),
    action("is.workflow.actions.getvalueforkey", {
      CustomOutputName: VERIFICATION_STATUS_OUTPUT_NAME,
      WFDictionaryKey: "status",
      WFInput: attachment(verification, "Token验证响应"),
    }, verificationStatus),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: verificationGroup,
      WFCondition: 4,
      WFConditionalActionString: "ok",
      WFControlFlowMode: 0,
      WFInput: conditionalInput(verificationStatus, VERIFICATION_STATUS_OUTPUT_NAME),
    }),
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
      CustomOutputName: "合法记账分类",
      WFItems: [...BOOKKEEPING_SELECTION_OPTIONS],
    }, options),
    action("is.workflow.actions.choosefromlist", {
      CustomOutputName: "本次记账分类",
      WFChooseFromListActionPrompt: "选择账本 · 收支 · 分类 · 子分类",
      WFInput: attachment(options, "合法记账分类"),
    }, selection),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: selectionGroup,
      WFCondition: 100,
      WFControlFlowMode: 0,
      WFInput: conditionalInput(selection, "本次记账分类"),
    }),
    action("is.workflow.actions.ask", {
      CustomOutputName: "备注",
      WFAskActionPrompt: "备注（可选，直接点完成跳过）",
      WFInputType: 0,
    }, note),
    action("is.workflow.actions.gettext", {
      CustomOutputName: "幂等键原文",
      WFTextActionText: textWithAttachments([
        { OutputUUID: ocr, Type: "ActionOutput" },
        { OutputUUID: selection, Type: "ActionOutput" },
        { OutputUUID: note, Type: "ActionOutput" },
      ]),
    }, idText),
    action("is.workflow.actions.hash", {
      CustomOutputName: "SHA-256",
      WFHashType: "SHA256",
      WFInput: attachment(idText, "幂等键原文"),
    }, hash),
    action("is.workflow.actions.downloadurl", {
      CustomOutputName: "记账结果",
      WFHTTPMethod: "POST",
      WFHTTPBodyType: "JSON",
      WFURL: endpoint,
      WFHTTPHeaders: dictionaryField([
        ["Authorization", {
          Value: { string: "Bearer ￼", attachmentsByRange: { "{7, 1}": { OutputUUID: token, Type: "ActionOutput" } } },
          WFSerializationType: "WFTextTokenString",
        }],
      ]),
      WFJSONValues: dictionaryField([
        ["text", attachment(ocr, "图像中的文本")],
        ["selection_path", attachment(selection, "本次记账分类")],
        ["note", attachment(note, "备注")],
        ["idempotency_key", attachment(hash, "SHA-256")],
        ["source", "shortcut"],
      ]),
    }, request),
    controlAction("is.workflow.actions.showresult", {
      Text: actionOutputText(request, "记账结果"),
    }),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: selectionGroup,
      WFControlFlowMode: 1,
    }),
    controlAction("is.workflow.actions.showresult", {
      Text: literalToken("已取消，不会上传任何记账数据"),
    }),
    action("is.workflow.actions.conditional", {
      GroupingIdentifier: selectionGroup,
      WFControlFlowMode: 2,
    }, allocator.action()),
    controlAction("is.workflow.actions.conditional", {
      GroupingIdentifier: verificationGroup,
      WFControlFlowMode: 1,
    }),
    controlAction("is.workflow.actions.showresult", {
      Text: actionOutputText(verification, "Token验证响应"),
    }),
    action("is.workflow.actions.conditional", {
      GroupingIdentifier: verificationGroup,
      WFControlFlowMode: 2,
    }, allocator.action()),
  ];

  return {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: "4033.0.3.5",
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowIcon: { WFWorkflowIconStartColor: -20702977, WFWorkflowIconGlyphNumber: 61523 },
    WFWorkflowImportQuestions: [
      {
        ActionIndex: 0,
        Category: "Parameter",
        DefaultValue: SHORTCUT_TOKEN_PLACEHOLDER,
        ParameterKey: "WFTextActionText",
        Text: "系统配置页生成的快捷指令 Token",
      },
    ],
    WFWorkflowInputContentItemClasses: [...STANDARD_INPUT_CONTENT_CLASSES],
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: ["Watch", "WFWorkflowTypeShowInSearch"],
  };
}

export async function buildBookkeepingShortcut({
  endpoint = DEFAULT_ENDPOINT,
  verifyEndpoint = DEFAULT_VERIFY_ENDPOINT,
  outputPath = defaultOutputPath,
} = {}) {
  const plist = buildPlist({ endpoint, verifyEndpoint });
  const xml = serializePlistXml(plist);
  const report = inspectBookkeepingShortcutXml(xml);
  await writeFile(outputPath, xml, { encoding: "utf8", mode: 0o600 });
  await chmod(outputPath, 0o600);
  return { outputPath, report };
}

function parseCliArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(endpoint|verify-endpoint|output)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    if (match[1] === "output") values.outputPath = resolve(match[2]);
    else if (match[1] === "verify-endpoint") values.verifyEndpoint = match[2];
    else values.endpoint = match[2];
  }
  return values;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cliOptions = parseCliArguments(process.argv.slice(2));
  buildBookkeepingShortcut(cliOptions)
    .then(({ outputPath, report }) => process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
